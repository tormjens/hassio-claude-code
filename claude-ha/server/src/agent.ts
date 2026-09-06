/**
 * Agent SDK session management.
 *
 * One `SessionRuntime` per chat session. It owns a long-lived `query()` in
 * streaming-input mode: user messages are pushed into an async queue that the
 * SDK consumes, and every SDK message is translated into the compact protocol
 * the browser understands (see protocol.ts) and persisted to the store.
 *
 * Permission prompts (`canUseTool`) are forwarded to the browser and resolved
 * when the user clicks Approve / Deny / Always allow.
 */
import {
  query,
  type CanUseTool,
  type HookCallbackMatcher,
  type HookEvent,
  type McpServerConfig,
  type ModelInfo,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import type { AppConfig, Logger } from './config.js';
import { applyCredentialEnv, type CredentialEnv } from './auth.js';
import type { AuditLog } from './audit.js';
import type { SessionStore, StoredSession } from './store.js';
import type {
  QuestionItem,
  QuestionRequest,
  AssistantTextItem,
  PermissionDecision,
  PermissionModeUi,
  PermissionRequest,
  ServerMessage,
  SessionStatus,
  ThinkingItem,
  ToolUseItem,
  TranscriptItem,
} from './protocol.js';

export type HooksFactory = (ctx: SessionContext) => Partial<Record<HookEvent, HookCallbackMatcher[]>>;

/** What hooks and tools need to know about the chat session they run in. */
export interface SessionContext {
  sessionId: string;
  session: StoredSession;
  emit: (msg: ServerMessage) => void;
  /** Add a system note to the transcript. */
  note: (level: 'info' | 'warning' | 'error', text: string) => void;
}

export interface AgentDeps {
  config: AppConfig;
  store: SessionStore;
  log: Logger;
  audit: AuditLog;
  mcpServers: Record<string, McpServerConfig>;
  /** Fully-qualified names (mcp__ha__ha_get_states) of read-only tools. */
  readOnlyTools: Set<string>;
  hooksFactory: HooksFactory;
  systemPromptAppend: string;
  /** Credential variables for the Claude Code subprocess (OAuth token or API key). */
  credentialEnv: CredentialEnv;
  /** Called when the SDK reports the available models (from the init message). */
  onModels?: (models: ModelInfo[]) => void;
}

const ASK_USER_QUESTION = 'AskUserQuestion';
function isAskUserQuestion(toolName: string): boolean {
  return toolName === ASK_USER_QUESTION || toolName.endsWith(`__${ASK_USER_QUESTION}`);
}

/** Coerce the AskUserQuestion tool input into a clean question list. */
function normalizeQuestions(input: Record<string, unknown>): QuestionItem[] {
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) return [];
  const out: QuestionItem[] = [];
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue;
    const question = String((q as { question?: unknown }).question ?? '');
    const header = String((q as { header?: unknown }).header ?? '');
    const multiSelect = Boolean((q as { multiSelect?: unknown }).multiSelect);
    const opts = (q as { options?: unknown }).options;
    const options = Array.isArray(opts)
      ? opts
          .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
          .map((o) => ({ label: String(o.label ?? ''), description: o.description ? String(o.description) : undefined }))
          .filter((o) => o.label)
      : [];
    if (question && options.length) out.push({ header, question, multiSelect, options });
  }
  return out;
}

/** Turn the user's picks into a tool-result message the model can act on. */
function formatAnswers(questions: QuestionItem[], answers: string[][]): string {
  const lines = questions.map((q, i) => {
    const picks = answers[i] ?? [];
    const value = picks.length ? picks.join(', ') : '(no answer)';
    return questions.length > 1 ? `- ${q.header || q.question}: ${value}` : value;
  });
  const body = lines.join('\n');
  return questions.length > 1 ? `The user answered your questions:\n${body}` : `The user answered: ${body}`;
}

const UI_TO_SDK_MODE: Record<PermissionModeUi, PermissionMode> = {
  ask: 'default',
  acceptEdits: 'acceptEdits',
  plan: 'plan',
};

/** Minimal pushable async iterable used as the SDK's streaming prompt. */
class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length > 0) return Promise.resolve({ value: this.items.shift() as T, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}

interface PendingPermission {
  request: PermissionRequest;
  resolve: (result: PermissionResult) => void;
}

export class SessionRuntime {
  private modelsQueried = false;
  readonly id: string;
  status: SessionStatus = 'idle';
  private q: Query | undefined;
  private input: AsyncQueue<SDKUserMessage> | undefined;
  private abort: AbortController | undefined;
  private readonly listeners = new Set<(msg: ServerMessage) => void>();
  private readonly pending = new Map<string, PendingPermission>();
  /** content block index -> transcript item id, for the current assistant message. */
  private blockItems = new Map<number, string>();
  private readonly toolItems = new Map<string, ToolUseItem>();
  private readonly questionResolvers = new Map<
    string,
    { request: QuestionRequest; resolve: (r: PermissionResult) => void }
  >();
  private consuming: Promise<void> | undefined;

  constructor(
    private readonly session: StoredSession,
    private readonly deps: AgentDeps,
  ) {
    this.id = session.id;
    for (const item of session.items) {
      if (item.kind === 'tool_use') this.toolItems.set(item.id, item);
    }
  }

  // ---------------------------------------------------------------------------
  // Pub/sub
  // ---------------------------------------------------------------------------

  subscribe(fn: (msg: ServerMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(msg: ServerMessage): void {
    for (const fn of this.listeners) {
      try {
        fn(msg);
      } catch (err) {
        this.deps.log.warning('listener failed', err);
      }
    }
  }

  pendingPermissions(): PermissionRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  pendingQuestions(): QuestionRequest[] {
    return [...this.questionResolvers.values()].map((p) => p.request);
  }

  /**
   * AskUserQuestion is not a permission: present the questions to the user and
   * return their answer through the tool result. The SDK exposes AskUserQuestion
   * via canUseTool, and the only host->model channel here is the permission
   * result's `message`, so the answer is delivered as a (non-interrupting) deny
   * message the model reads and acts on.
   */
  private askQuestion(
    toolName: string,
    input: Record<string, unknown>,
    opts: { requestId?: string; toolUseID: string; signal: AbortSignal },
  ): Promise<PermissionResult> {
    const questions = normalizeQuestions(input);
    // If we cannot parse questions, fall back to auto-allowing so we never hang.
    if (!questions.length) return Promise.resolve({ behavior: 'allow', updatedInput: input });
    const requestId = opts.requestId || randomUUID();
    const request: QuestionRequest = { requestId, toolUseId: opts.toolUseID, questions, ts: Date.now() };
    return new Promise<PermissionResult>((resolve) => {
      this.questionResolvers.set(requestId, { request, resolve });
      this.setStatus('waiting_permission');
      this.emit({ type: 'question_request', sessionId: this.id, request });
      opts.signal.addEventListener(
        'abort',
        () => {
          if (this.questionResolvers.delete(requestId)) {
            resolve({ behavior: 'deny', message: 'The question was cancelled.' });
            this.emit({ type: 'question_resolved', sessionId: this.id, requestId });
            this.refreshWaitingStatus();
          }
        },
        { once: true },
      );
    });
  }

  resolveQuestion(requestId: string, answers: string[][]): boolean {
    const p = this.questionResolvers.get(requestId);
    if (!p) return false;
    this.questionResolvers.delete(requestId);
    const message = formatAnswers(p.request.questions, answers);
    p.resolve({ behavior: 'deny', message });
    this.emit({ type: 'question_resolved', sessionId: this.id, requestId });
    this.refreshWaitingStatus();
    return true;
  }

  private refreshWaitingStatus(): void {
    if (this.pending.size === 0 && this.questionResolvers.size === 0 && this.status === 'waiting_permission') {
      this.setStatus('running');
    }
  }

  private setStatus(status: SessionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit({ type: 'status', sessionId: this.id, status });
  }

  private appendItem(item: TranscriptItem): void {
    this.deps.store.appendItem(this.id, item);
    this.emit({ type: 'item', sessionId: this.id, item });
  }

  private updateItem(item: TranscriptItem): void {
    this.deps.store.touch(this.id);
    this.emit({ type: 'item_update', sessionId: this.id, item });
  }

  private note(level: 'info' | 'warning' | 'error', text: string): void {
    this.appendItem({ kind: 'system', id: randomUUID(), ts: Date.now(), level, text });
  }

  private emitSession(): void {
    this.deps.store.touch(this.id);
    this.emit({ type: 'session', session: this.deps.store.summary(this.session) });
  }

  context(): SessionContext {
    return {
      sessionId: this.id,
      session: this.session,
      emit: (m) => this.emit(m),
      note: (level, text) => this.note(level, text),
    };
  }

  // ---------------------------------------------------------------------------
  // Public actions
  // ---------------------------------------------------------------------------

  async send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.appendItem({ kind: 'user', id: randomUUID(), ts: Date.now(), text: trimmed });
    this.emitSession();
    this.ensureQuery();
    this.setStatus('running');
    this.input?.push({
      type: 'user',
      message: { role: 'user', content: trimmed },
      parent_tool_use_id: null,
      session_id: this.session.sdkSessionId ?? '',
    });
  }

  async interrupt(): Promise<void> {
    // Deny anything waiting for the user first so the SDK is not stuck on it.
    for (const [id, p] of this.pending) {
      p.resolve({ behavior: 'deny', message: 'Interrupted by the user.', interrupt: true });
      this.pending.delete(id);
      this.emit({ type: 'permission_resolved', sessionId: this.id, requestId: id });
    }
    for (const [id, p] of this.questionResolvers) {
      p.resolve({ behavior: 'deny', message: 'Interrupted by the user.', interrupt: true });
      this.questionResolvers.delete(id);
      this.emit({ type: 'question_resolved', sessionId: this.id, requestId: id });
    }
    if (this.q && this.status !== 'idle') {
      try {
        await this.q.interrupt();
      } catch (err) {
        this.deps.log.warning(`interrupt failed for ${this.id}`, err);
      }
    }
  }

  async setPermissionMode(mode: PermissionModeUi): Promise<void> {
    this.session.permissionMode = mode;
    this.emitSession();
    if (this.q) {
      try {
        await this.q.setPermissionMode(UI_TO_SDK_MODE[mode]);
      } catch (err) {
        this.deps.log.warning(`setPermissionMode failed for ${this.id}`, err);
      }
    }
  }

  async setModel(model?: string): Promise<void> {
    this.session.model = model || undefined;
    this.emitSession();
    if (this.q) {
      try {
        await this.q.setModel(model || undefined);
      } catch (err) {
        this.deps.log.warning(`setModel failed for ${this.id}`, err);
      }
    }
  }

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    const { request } = p;
    const tool = this.toolItems.get(request.toolUseId);
    if (decision === 'deny') {
      p.resolve({ behavior: 'deny', message: 'The user denied this action in the Claude for Home Assistant UI.' });
      if (tool) {
        tool.status = 'denied';
        tool.denyReason = 'Denied by user';
        this.updateItem(tool);
      }
      this.deps.audit.write({ sessionId: this.id, toolUseId: request.toolUseId, tool: request.toolName, args: request.input, outcome: 'denied' });
    } else {
      let updatedPermissions: PermissionUpdate[] | undefined;
      if (decision === 'allow_always') {
        if (!this.session.alwaysAllowedTools.includes(request.toolName)) {
          this.session.alwaysAllowedTools.push(request.toolName);
        }
        updatedPermissions = [
          { type: 'addRules', rules: [{ toolName: request.toolName }], behavior: 'allow', destination: 'session' },
        ];
      }
      p.resolve({ behavior: 'allow', updatedInput: request.input, updatedPermissions });
      if (tool && tool.status === 'pending') {
        tool.status = 'running';
        this.updateItem(tool);
      }
    }
    this.emit({ type: 'permission_resolved', sessionId: this.id, requestId });
    if (this.pending.size === 0 && this.status === 'waiting_permission') this.setStatus('running');
    return true;
  }

  /** Stop the SDK process. The session can be resumed later via its sdkSessionId. */
  async close(): Promise<void> {
    for (const [id, p] of this.pending) {
      p.resolve({ behavior: 'deny', message: 'Session closed.' });
      this.pending.delete(id);
    }
    for (const [id, p] of this.questionResolvers) {
      p.resolve({ behavior: 'deny', message: 'Session closed.' });
      this.questionResolvers.delete(id);
    }
    this.input?.close();
    this.abort?.abort();
    try {
      this.q?.close();
    } catch {
      // ignore
    }
    this.q = undefined;
    this.input = undefined;
    if (this.consuming) await this.consuming.catch(() => undefined);
    this.setStatus('idle');
  }

  // ---------------------------------------------------------------------------
  // Query lifecycle
  // ---------------------------------------------------------------------------

  private buildEnv(): Record<string, string | undefined> {
    const { config } = this.deps;
    // Applies the selected auth method: sets CLAUDE_CODE_OAUTH_TOKEN (or the
    // API key) and strips the variables that would outrank it in the CLI's
    // credential chain even when empty. See auth.ts.
    const env = applyCredentialEnv(process.env, this.deps.credentialEnv);
    env.CLAUDE_AGENT_SDK_CLIENT_APP ??= `claude-ha/${config.version}`;
    return env;
  }

  private ensureQuery(): void {
    if (this.q) return;
    const { config, log } = this.deps;
    this.input = new AsyncQueue<SDKUserMessage>();
    this.abort = new AbortController();
    this.blockItems.clear();

    const options: Options = {
      cwd: config.configDir,
      model: this.session.model || config.model || undefined,
      permissionMode: UI_TO_SDK_MODE[this.session.permissionMode],
      canUseTool: this.canUseTool,
      includePartialMessages: true,
      mcpServers: this.deps.mcpServers,
      strictMcpConfig: true,
      hooks: this.deps.hooksFactory(this.context()),
      resume: this.session.sdkSessionId,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: this.deps.systemPromptAppend },
      settingSources: ['project'],
      env: this.buildEnv(),
      abortController: this.abort,
      stderr: (data) => log.debug(`[claude ${this.id.slice(0, 8)}] ${data.trimEnd()}`),
    };

    const q = query({ prompt: this.input, options });
    this.q = q;
    this.consuming = this.consume(q);
  }

  private async consume(q: Query): Promise<void> {
    try {
      for await (const message of q) {
        this.handleMessage(message);
      }
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (!/aborted by user/i.test(msg)) {
        this.deps.log.error(`session ${this.id} query failed`, err);
        this.note('error', `Claude stopped unexpectedly: ${msg}`);
      }
    } finally {
      if (this.q === q) {
        this.q = undefined;
        this.input = undefined;
      }
      this.finishOpenItems();
      this.setStatus('idle');
    }
  }

  /** Mark anything still streaming as finished (process ended mid-turn). */
  private finishOpenItems(): void {
    for (const item of this.session.items) {
      if ((item.kind === 'assistant_text' || item.kind === 'thinking') && item.partial) {
        item.partial = false;
        this.updateItem(item);
      }
      if (item.kind === 'tool_use' && (item.status === 'streaming' || item.status === 'running' || item.status === 'pending')) {
        item.status = 'error';
        item.result ??= 'Tool call did not complete.';
        item.isError = true;
        this.updateItem(item);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Permission prompt
  // ---------------------------------------------------------------------------

  private readonly canUseTool: CanUseTool = async (toolName, input, opts) => {
    if (isAskUserQuestion(toolName)) {
      return this.askQuestion(toolName, input, opts);
    }
    if (this.session.alwaysAllowedTools.includes(toolName)) {
      return { behavior: 'allow', updatedInput: input };
    }
    if (this.deps.config.autoApproveReadOnly && this.deps.readOnlyTools.has(toolName)) {
      return { behavior: 'allow', updatedInput: input };
    }
    const requestId = opts.requestId || randomUUID();
    const request: PermissionRequest = {
      requestId,
      toolUseId: opts.toolUseID,
      toolName,
      input,
      title: opts.title,
      description: opts.description ?? opts.displayName,
      decisionReason: opts.decisionReason,
      canAlwaysAllow: true,
      ts: Date.now(),
    };
    const tool = this.toolItems.get(opts.toolUseID);
    if (tool && tool.status === 'streaming') {
      tool.status = 'pending';
      this.updateItem(tool);
    }
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(requestId, { request, resolve });
      this.setStatus('waiting_permission');
      this.emit({ type: 'permission_request', sessionId: this.id, request });
      opts.signal.addEventListener(
        'abort',
        () => {
          if (this.pending.delete(requestId)) {
            resolve({ behavior: 'deny', message: 'Request cancelled.' });
            this.emit({ type: 'permission_resolved', sessionId: this.id, requestId });
            if (this.pending.size === 0 && this.status === 'waiting_permission') this.setStatus('running');
          }
        },
        { once: true },
      );
    });
  };

  // ---------------------------------------------------------------------------
  // SDK message translation
  // ---------------------------------------------------------------------------

  private handleMessage(message: SDKMessage): void {
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') {
          if (this.session.sdkSessionId !== message.session_id) {
            this.session.sdkSessionId = message.session_id;
            this.emitSession();
          }
          this.deps.log.info(
            `session ${this.id.slice(0, 8)} ready: model=${message.model} sdk=${message.session_id} mcp=${message.mcp_servers
              .map((s) => `${s.name}:${s.status}`)
              .join(',')}`,
          );
          const failed = message.mcp_servers.filter((s) => s.status === 'failed');
          if (failed.length) this.note('warning', `MCP servers failed to start: ${failed.map((s) => s.name).join(', ')}`);
          // The init message does not carry the model list; ask the SDK once.
          if (this.deps.onModels && !this.modelsQueried) {
            this.modelsQueried = true;
            void this.q
              ?.supportedModels()
              .then((models) => {
                if (models?.length) this.deps.onModels?.(models);
              })
              .catch((err) => this.deps.log.debug(`supportedModels failed: ${String(err)}`));
          }
        } else if (message.subtype === 'compact_boundary') {
          this.note('info', 'Conversation context was compacted to stay within the model limit.');
        }
        break;
      case 'stream_event':
        if (message.parent_tool_use_id === null) this.handleStreamEvent(message.event);
        break;
      case 'assistant':
        if (message.parent_tool_use_id === null) this.handleAssistant(message);
        break;
      case 'user':
        this.handleUser(message);
        break;
      case 'result':
        this.handleResult(message);
        break;
      default:
        break;
    }
  }

  private handleStreamEvent(raw: unknown): void {
    const event = raw as { type: string } & Record<string, unknown>;
    switch (event.type) {
      case 'message_start':
        this.blockItems.clear();
        break;
      case 'content_block_start': {
        const index = event.index as number;
        const block = event.content_block as { type: string; id?: string; name?: string; text?: string };
        const ts = Date.now();
        if (block.type === 'text') {
          const item: AssistantTextItem = { kind: 'assistant_text', id: randomUUID(), ts, text: block.text ?? '', partial: true };
          this.blockItems.set(index, item.id);
          this.appendItem(item);
        } else if (block.type === 'thinking') {
          const item: ThinkingItem = { kind: 'thinking', id: randomUUID(), ts, text: '', partial: true };
          this.blockItems.set(index, item.id);
          this.appendItem(item);
        } else if (block.type === 'tool_use' && block.id && block.name) {
          const item: ToolUseItem = {
            kind: 'tool_use',
            id: block.id,
            ts,
            name: block.name,
            input: {},
            inputPartial: '',
            status: 'streaming',
            hidden: isAskUserQuestion(block.name),
          };
          this.blockItems.set(index, item.id);
          this.toolItems.set(item.id, item);
          this.appendItem(item);
        }
        break;
      }
      case 'content_block_delta': {
        const index = event.index as number;
        const itemId = this.blockItems.get(index);
        if (!itemId) return;
        const delta = event.delta as { type: string; text?: string; thinking?: string; partial_json?: string };
        const item = this.findItem(itemId);
        if (!item) return;
        if (delta.type === 'text_delta' && item.kind === 'assistant_text' && delta.text) {
          item.text += delta.text;
          this.deps.store.touch(this.id);
          this.emit({ type: 'text_delta', sessionId: this.id, itemId, delta: delta.text });
        } else if (delta.type === 'thinking_delta' && item.kind === 'thinking' && delta.thinking) {
          item.text += delta.thinking;
          this.emit({ type: 'thinking_delta', sessionId: this.id, itemId, delta: delta.thinking });
        } else if (delta.type === 'input_json_delta' && item.kind === 'tool_use' && delta.partial_json) {
          item.inputPartial = (item.inputPartial ?? '') + delta.partial_json;
          this.emit({ type: 'input_delta', sessionId: this.id, itemId, delta: delta.partial_json });
        }
        break;
      }
      case 'content_block_stop': {
        const index = event.index as number;
        const itemId = this.blockItems.get(index);
        if (!itemId) return;
        const item = this.findItem(itemId);
        if (!item) return;
        if (item.kind === 'assistant_text' || item.kind === 'thinking') {
          item.partial = false;
          this.updateItem(item);
        } else if (item.kind === 'tool_use') {
          if (item.inputPartial) {
            try {
              item.input = JSON.parse(item.inputPartial);
            } catch {
              item.input = { _raw: item.inputPartial };
            }
          }
          delete item.inputPartial;
          if (item.status === 'streaming') item.status = 'running';
          this.updateItem(item);
        }
        break;
      }
      default:
        break;
    }
  }

  /** The complete assistant message: reconcile against what streaming produced. */
  private handleAssistant(message: Extract<SDKMessage, { type: 'assistant' }>): void {
    const content = message.message.content ?? [];
    for (const block of content) {
      if (block.type === 'tool_use') {
        let item = this.toolItems.get(block.id);
        if (!item) {
          item = { kind: 'tool_use', id: block.id, ts: Date.now(), name: block.name, input: block.input, status: 'running' };
          this.toolItems.set(item.id, item);
          this.appendItem(item);
        } else {
          item.input = block.input;
          delete item.inputPartial;
          if (item.status === 'streaming') item.status = 'running';
          this.updateItem(item);
        }
      } else if (block.type === 'text' && block.text) {
        // If partial streaming was lost for some reason, make sure the text exists.
        const existing = this.session.items.find(
          (i) => i.kind === 'assistant_text' && i.text === block.text,
        );
        if (!existing) {
          const last = [...this.session.items].reverse().find((i) => i.kind === 'assistant_text' && i.partial);
          if (last && last.kind === 'assistant_text') {
            last.text = block.text;
            last.partial = false;
            this.updateItem(last);
          } else if (!this.session.items.some((i) => i.kind === 'assistant_text' && block.text.startsWith(i.text) && i.text.length > 0)) {
            this.appendItem({ kind: 'assistant_text', id: randomUUID(), ts: Date.now(), text: block.text });
          }
        }
      }
    }
    if (message.error) {
      this.note('error', describeAssistantError(message.error));
    }
  }

  /** Tool results come back as user messages with tool_result blocks. */
  private handleUser(message: Extract<SDKMessage, { type: 'user' }>): void {
    const content = message.message.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      const item = this.toolItems.get(block.tool_use_id);
      if (!item) continue;
      const text = toolResultText(block.content);
      if (item.status === 'denied') {
        item.result = text;
      } else {
        item.isError = Boolean(block.is_error);
        item.status = item.isError ? 'error' : 'done';
        item.result = text;
        if (item.isError && /denied|blocked|not allowed/i.test(text)) {
          item.status = 'denied';
          item.denyReason = text.split('\n')[0].slice(0, 200);
        }
      }
      this.updateItem(item);
    }
  }

  private handleResult(message: Extract<SDKMessage, { type: 'result' }>): void {
    this.session.totalCostUsd += message.total_cost_usd ?? 0;
    this.finishOpenItems();
    this.appendItem({
      kind: 'result',
      id: randomUUID(),
      ts: Date.now(),
      subtype: message.subtype,
      isError: message.is_error,
      durationMs: message.duration_ms,
      costUsd: message.total_cost_usd ?? 0,
      numTurns: message.num_turns,
      errors: message.subtype === 'success' ? undefined : message.errors,
    });
    if (message.subtype !== 'success' && message.errors?.length) {
      this.note('error', message.errors.join('\n'));
    }
    this.emitSession();
    if (this.pending.size === 0) this.setStatus('idle');
  }

  private findItem(id: string): TranscriptItem | undefined {
    for (let i = this.session.items.length - 1; i >= 0; i--) {
      if (this.session.items[i].id === id) return this.session.items[i];
    }
    return undefined;
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: { type?: string; text?: string }) => (c.type === 'text' ? c.text ?? '' : `[${c.type ?? 'content'}]`))
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content, null, 2);
}

function describeAssistantError(error: string): string {
  switch (error) {
    case 'authentication_failed':
      return 'Authentication with Anthropic failed. Check the API key in the add-on configuration.';
    case 'billing_error':
      return 'Anthropic reported a billing problem for this API key.';
    case 'rate_limit':
      return 'Rate limited by the Anthropic API. Wait a moment and try again.';
    case 'overloaded':
      return 'The Anthropic API is overloaded. Try again shortly.';
    case 'model_not_found':
      return 'The configured model was not found. Check the model option in the add-on configuration.';
    case 'max_output_tokens':
      return 'The response hit the maximum output length.';
    default:
      return `The model request failed (${error}).`;
  }
}

/**
 * Holds every live runtime and lazily creates them from the store.
 */
export class SessionManager {
  private readonly runtimes = new Map<string, SessionRuntime>();

  constructor(private readonly deps: AgentDeps) {}

  get(id: string): SessionRuntime | undefined {
    if (this.runtimes.has(id)) return this.runtimes.get(id);
    const stored = this.deps.store.get(id);
    if (!stored) return undefined;
    const rt = new SessionRuntime(stored, this.deps);
    this.runtimes.set(id, rt);
    return rt;
  }

  create(permissionMode: PermissionModeUi = 'ask'): SessionRuntime {
    const stored = this.deps.store.create(permissionMode);
    const rt = new SessionRuntime(stored, this.deps);
    this.runtimes.set(stored.id, rt);
    return rt;
  }

  async delete(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    const sdkSessionId = this.deps.store.get(id)?.sdkSessionId;
    if (rt) {
      await rt.close();
      this.runtimes.delete(id);
    }
    await this.deps.store.delete(id);
    if (sdkSessionId) {
      try {
        const { deleteSession } = await import('@anthropic-ai/claude-agent-sdk');
        await deleteSession(sdkSessionId, { dir: this.deps.config.configDir });
      } catch (err) {
        this.deps.log.debug(`could not delete SDK transcript ${sdkSessionId}: ${String(err)}`);
      }
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map((rt) => rt.close()));
  }
}
