/**
 * Wire protocol shared between the Node backend and the Vue frontend.
 *
 * Everything the browser ever sees is one of these shapes. The transcript that is
 * persisted under /data uses the same `TranscriptItem` types so a reloaded
 * session renders identically to a live one.
 */

export type PermissionModeUi = 'ask' | 'acceptEdits' | 'plan';

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  permissionMode: PermissionModeUi;
  /** Per-session model override. Undefined means the add-on's default model. */
  model?: string;
  /** Agent SDK session id, present once the first turn has started. */
  sdkSessionId?: string;
  /** Git commit created before the first file edit of this session. */
  checkpointCommit?: string;
  /** True once the session has been reverted to its checkpoint. */
  reverted?: boolean;
  totalCostUsd: number;
}

export type SessionStatus = 'idle' | 'running' | 'waiting_permission' | 'error';

export interface UserItem {
  kind: 'user';
  id: string;
  ts: number;
  text: string;
}

export interface AssistantTextItem {
  kind: 'assistant_text';
  id: string;
  ts: number;
  text: string;
  /** Still streaming. */
  partial?: boolean;
}

export interface ThinkingItem {
  kind: 'thinking';
  id: string;
  ts: number;
  text: string;
  partial?: boolean;
}

export interface ToolUseItem {
  kind: 'tool_use';
  id: string; // tool_use_id from the API
  ts: number;
  name: string;
  /** Raw JSON string while streaming, parsed object once complete. */
  input: unknown;
  inputPartial?: string;
  status: 'streaming' | 'pending' | 'running' | 'done' | 'error' | 'denied';
  result?: string;
  isError?: boolean;
  /** Set when the tool was denied by a hook or by the user. */
  denyReason?: string;
  /** Hidden from the transcript (e.g. AskUserQuestion, rendered as a question card). */
  hidden?: boolean;
}

export interface ResultItem {
  kind: 'result';
  id: string;
  ts: number;
  subtype: string;
  isError: boolean;
  durationMs: number;
  costUsd: number;
  numTurns: number;
  errors?: string[];
}

export interface SystemItem {
  kind: 'system';
  id: string;
  ts: number;
  level: 'info' | 'warning' | 'error';
  text: string;
}

export type TranscriptItem =
  | UserItem
  | AssistantTextItem
  | ThinkingItem
  | ToolUseItem
  | ResultItem
  | SystemItem;

export interface PermissionRequest {
  requestId: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  description?: string;
  decisionReason?: string;
  /** True if the server can offer "always allow" for this tool. */
  canAlwaysAllow: boolean;
  ts: number;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionItem {
  header: string;
  question: string;
  multiSelect?: boolean;
  options: QuestionOption[];
}

/** A pending AskUserQuestion the user must answer. */
export interface QuestionRequest {
  requestId: string;
  toolUseId: string;
  questions: QuestionItem[];
  ts: number;
}

export interface GitStatus {
  isRepo: boolean;
  dirty?: boolean;
  head?: string;
  error?: string;
}

export interface ModelOption {
  /** Model id or alias to pass to the SDK. */
  value: string;
  /** Human-readable name. */
  label: string;
  /** Short capability description. */
  description?: string;
}

export interface AuthStatus {
  method: 'oauth' | 'api_key';
  /** Enough configuration is present to attempt a request. */
  configured: boolean;
}

export interface Settings {
  model: string;
  baseUrl: string;
  autoApproveReadOnly: boolean;
  /** Legacy name: true when any credential source is configured. */
  hasApiKey: boolean;
  auth: AuthStatus;
  /** Models available to the current account (learned from the SDK). */
  models: ModelOption[];
  /** The add-on's configured default model ('' means the SDK default). */
  defaultModel: string;
  logLevel: string;
  configDir: string;
  version: string;
}

/** Server to client messages. */
export type ServerMessage =
  | { type: 'hello'; sessions: SessionSummary[]; settings: Settings; git: GitStatus }
  | { type: 'sessions'; sessions: SessionSummary[] }
  | { type: 'session'; session: SessionSummary }
  | {
      type: 'history';
      sessionId: string;
      items: TranscriptItem[];
      status: SessionStatus;
      pending: PermissionRequest[];
      questions: QuestionRequest[];
    }
  | { type: 'item'; sessionId: string; item: TranscriptItem }
  | { type: 'item_update'; sessionId: string; item: TranscriptItem }
  | { type: 'text_delta'; sessionId: string; itemId: string; delta: string }
  | { type: 'thinking_delta'; sessionId: string; itemId: string; delta: string }
  | { type: 'input_delta'; sessionId: string; itemId: string; delta: string }
  | { type: 'status'; sessionId: string; status: SessionStatus }
  | { type: 'permission_request'; sessionId: string; request: PermissionRequest }
  | { type: 'permission_resolved'; sessionId: string; requestId: string }
  | { type: 'question_request'; sessionId: string; request: QuestionRequest }
  | { type: 'question_resolved'; sessionId: string; requestId: string }
  | { type: 'git'; git: GitStatus }
  | { type: 'models'; models: ModelOption[] }
  | { type: 'error'; sessionId?: string; message: string };

export type PermissionDecision = 'allow' | 'deny' | 'allow_always';

/** Client to server messages. */
export type ClientMessage =
  | { type: 'subscribe'; sessionId: string }
  | { type: 'unsubscribe'; sessionId: string }
  | { type: 'new_session'; permissionMode?: PermissionModeUi }
  | { type: 'send'; sessionId: string; text: string }
  | { type: 'interrupt'; sessionId: string }
  | { type: 'set_permission_mode'; sessionId: string; mode: PermissionModeUi }
  | { type: 'set_model'; sessionId: string; model?: string }
  | { type: 'permission_response'; sessionId: string; requestId: string; decision: PermissionDecision }
  | { type: 'question_response'; sessionId: string; requestId: string; answers: string[][] }
  | { type: 'delete_session'; sessionId: string }
  | { type: 'rename_session'; sessionId: string; title: string }
  | { type: 'git_init' }
  | { type: 'revert_session'; sessionId: string }
  | { type: 'list_sessions' };
