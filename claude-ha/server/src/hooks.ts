/**
 * Agent SDK hooks: the safety net around every tool call.
 *
 *  - PreToolUse  secrets guard      deny any tool that would read or write secrets.yaml
 *                                    or Home Assistant's auth store
 *  - PreToolUse  config check       run the HA config check before ha_reload / ha_restart_core,
 *                                    block the call and return the errors if it fails
 *  - PreToolUse  git checkpoint     commit /config before the first file edit of a session
 *  - PostToolUse / failure / denied audit log
 *
 * Hooks run before permission rules, so a deny here applies in every permission mode.
 */
import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
  PermissionDeniedHookInput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import path from 'node:path';
import type { AuditLog } from './audit.js';
import type { Logger } from './config.js';
import type { GitRepo } from './git.js';
import type { HaClient } from './ha-client.js';
import { qualified } from './ha-tools.js';
import type { SessionContext } from './agent.js';
import type { SessionStore } from './store.js';

/** Files (relative to the config dir) the model must never read or write. */
export const PROTECTED_FILES = [
  'secrets.yaml',
  '.storage/auth',
  '.storage/auth_provider.homeassistant',
  '.storage/onboarding',
  '.storage/cloud',
  '.storage/hassio',
];

const PROTECTED_PATTERN = /(^|[\\/\s"'`=:])(secrets\.ya?ml|\.storage[\\/]auth(_provider\.homeassistant)?|\.storage[\\/](onboarding|cloud|hassio))(\b|$)/i;

const FILE_TOOLS = 'Read|Edit|Write|MultiEdit|NotebookEdit|Grep|Glob|Bash';
const EDIT_TOOLS = 'Edit|Write|MultiEdit|NotebookEdit';

export interface HookDeps {
  ha: HaClient;
  git: GitRepo;
  audit: AuditLog;
  store: SessionStore;
  log: Logger;
  configDir: string;
  /** The add-on's private data dir (/data). Holds credentials, sessions, audit log. */
  dataDir: string;
}

function deny(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: 'deny' as const,
      permissionDecisionReason: reason,
    },
  };
}

/** Collect every string in a tool input that could be a path or a command. */
function stringsOf(input: unknown, depth = 0): string[] {
  if (depth > 3) return [];
  if (typeof input === 'string') return [input];
  if (Array.isArray(input)) return input.flatMap((v) => stringsOf(v, depth + 1));
  if (input && typeof input === 'object') {
    return Object.values(input as Record<string, unknown>).flatMap((v) => stringsOf(v, depth + 1));
  }
  return [];
}

export function isProtectedPath(configDir: string, candidate: string): boolean {
  const abs = path.isAbsolute(candidate) ? candidate : path.join(configDir, candidate);
  const rel = path.relative(configDir, path.normalize(abs));
  return PROTECTED_FILES.some((p) => rel === p || rel.split(path.sep).join('/') === p);
}

/** Exported for tests: does this tool input touch a protected file? */
export function touchesProtectedFile(configDir: string, toolName: string, input: unknown): string | undefined {
  const obj = (input ?? {}) as Record<string, unknown>;
  const pathKeys = ['file_path', 'path', 'notebook_path'];
  for (const key of pathKeys) {
    const v = obj[key];
    if (typeof v === 'string' && isProtectedPath(configDir, v)) return v;
  }
  if (toolName === 'Bash' || toolName === 'Grep' || toolName === 'Glob') {
    for (const s of stringsOf(input)) {
      if (PROTECTED_PATTERN.test(s)) return s;
    }
  }
  return undefined;
}

/**
 * The add-on's own /data directory holds the user's credentials (options.json,
 * the cached OAuth token) plus the session store and audit log, and the
 * container environment holds credential tokens. None of that is the model's
 * business, so block any tool that would reach into /data or dump those tokens.
 * This is defence in depth: SUPERVISOR_TOKEN is also stripped from the model's
 * subprocess environment (see agent.ts), and credential names are matched here
 * so a Bash `printenv`/`cat` cannot exfiltrate them.
 */
const CREDENTIAL_PATTERN =
  /(SUPERVISOR_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|\.credentials\.json|options\.json)/i;

function withinDir(dir: string, candidate: string): boolean {
  const abs = path.isAbsolute(candidate) ? path.normalize(candidate) : path.normalize(path.join(dir, candidate));
  const rel = path.relative(path.normalize(dir), abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Exported for tests: does this tool input reach the add-on's private data or credentials? */
export function touchesAddonData(dataDir: string, toolName: string, input: unknown): string | undefined {
  const obj = (input ?? {}) as Record<string, unknown>;
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const v = obj[key];
    if (typeof v === 'string' && withinDir(dataDir, v)) return v;
  }
  if (toolName === 'Bash' || toolName === 'Grep' || toolName === 'Glob') {
    const normData = dataDir.replace(/\\/g, '/');
    for (const raw of stringsOf(input)) {
      const s = raw.replace(/\\/g, '/');
      if (CREDENTIAL_PATTERN.test(s)) return raw;
      if (s === normData || s.includes(`${normData}/`)) return raw;
    }
  }
  return undefined;
}

export function createHooksFactory(deps: HookDeps): (ctx: SessionContext) => Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const { ha, git, audit, store, log, configDir, dataDir } = deps;

  return (ctx: SessionContext) => {
    const secretsGuard: HookCallback = async (input) => {
      const pre = input as PreToolUseHookInput;
      const dataHit = touchesAddonData(dataDir, pre.tool_name, pre.tool_input);
      if (dataHit) {
        audit.write({
          sessionId: ctx.sessionId,
          toolUseId: pre.tool_use_id,
          tool: pre.tool_name,
          args: pre.tool_input,
          outcome: 'blocked',
          detail: `add-on data/credentials: ${dataHit}`,
        });
        return deny(
          `Access to ${dataHit} is blocked: this is the Claude for Home Assistant add-on's private data ` +
            '(credentials, session store, audit log) and its access tokens. Work within the Home Assistant ' +
            'configuration directory instead.',
        );
      }
      const hit = touchesProtectedFile(configDir, pre.tool_name, pre.tool_input);
      if (!hit) return {};
      audit.write({
        sessionId: ctx.sessionId,
        toolUseId: pre.tool_use_id,
        tool: pre.tool_name,
        args: pre.tool_input,
        outcome: 'blocked',
        detail: `protected file: ${hit}`,
      });
      return deny(
        `Access to ${hit} is blocked by the Claude for Home Assistant add-on: it contains credentials. ` +
          'Use the ha_list_secret_keys tool to see which !secret keys exist, and ask the user to add or change secrets themselves.',
      );
    };

    const configCheckGuard: HookCallback = async (input) => {
      const pre = input as PreToolUseHookInput;
      log.info(`session ${ctx.sessionId.slice(0, 8)}: running config check before ${pre.tool_name}`);
      try {
        const result = await ha.checkConfig();
        if (result.valid) {
          const warn = result.warnings.length ? ` Warnings: ${result.warnings.join(' | ')}` : '';
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              additionalContext: `Configuration check passed (${result.source}).${warn}`,
            },
          };
        }
        audit.write({
          sessionId: ctx.sessionId,
          toolUseId: pre.tool_use_id,
          tool: pre.tool_name,
          args: pre.tool_input,
          outcome: 'blocked',
          detail: `config check failed: ${result.errors.join(' | ')}`,
        });
        ctx.note('warning', `Blocked ${pre.tool_name.replace(/^mcp__ha__/, '')}: the configuration check failed.`);
        return deny(
          `Blocked: the Home Assistant configuration check failed, so ${pre.tool_name.replace(/^mcp__ha__/, '')} was not executed. ` +
            `Fix these errors first:\n${result.errors.join('\n')}` +
            (result.raw ? `\n\nFull output:\n${result.raw}` : ''),
        );
      } catch (err) {
        const msg = (err as Error).message;
        audit.write({
          sessionId: ctx.sessionId,
          toolUseId: pre.tool_use_id,
          tool: pre.tool_name,
          args: pre.tool_input,
          outcome: 'blocked',
          detail: `config check unavailable: ${msg}`,
        });
        return deny(`Blocked: could not run the configuration check (${msg}). Resolve that before reloading or restarting.`);
      }
    };

    const checkpoint: HookCallback = async () => {
      const session = ctx.session;
      if (session.checkpointCommit) return {};
      try {
        if (!(await git.isRepo())) return {};
        const commit = await git.commitIfChanged(`claude-ha: checkpoint before session ${session.id.slice(0, 8)} (${session.title})`);
        if (commit) {
          session.checkpointCommit = commit;
          store.touch(session.id);
          ctx.emit({ type: 'session', session: store.summary(session) });
          ctx.note('info', `Created git checkpoint ${commit.slice(0, 7)} before the first edit. You can revert this session's changes from the menu.`);
        }
      } catch (err) {
        log.warning(`checkpoint failed for ${session.id}`, err);
        ctx.note('warning', `Could not create a git checkpoint: ${(err as Error).message}`);
      }
      return {};
    };

    const auditOk: HookCallback = async (input) => {
      const post = input as PostToolUseHookInput;
      const resp = post.tool_response as { isError?: boolean; is_error?: boolean } | undefined;
      const isError = Boolean(resp && typeof resp === 'object' && (resp.isError || resp.is_error));
      audit.write({
        sessionId: ctx.sessionId,
        toolUseId: post.tool_use_id,
        tool: post.tool_name,
        args: post.tool_input,
        outcome: isError ? 'error' : 'ok',
        durationMs: post.duration_ms,
      });
      return {};
    };

    const auditFailure: HookCallback = async (input) => {
      const post = input as PostToolUseFailureHookInput;
      audit.write({
        sessionId: ctx.sessionId,
        toolUseId: post.tool_use_id,
        tool: post.tool_name,
        args: post.tool_input,
        outcome: 'error',
        detail: String((post as unknown as { error?: unknown }).error ?? ''),
      });
      return {};
    };

    const auditDenied: HookCallback = async (input) => {
      const denied = input as PermissionDeniedHookInput;
      audit.write({
        sessionId: ctx.sessionId,
        toolUseId: denied.tool_use_id,
        tool: denied.tool_name,
        args: denied.tool_input,
        outcome: 'denied',
        detail: denied.reason,
      });
      return {};
    };

    return {
      PreToolUse: [
        { matcher: FILE_TOOLS, hooks: [secretsGuard], timeout: 10 },
        {
          matcher: `${qualified('ha_reload')}|${qualified('ha_restart_core')}`,
          hooks: [configCheckGuard],
          timeout: 300,
        },
        { matcher: EDIT_TOOLS, hooks: [checkpoint], timeout: 60 },
      ],
      PostToolUse: [{ hooks: [auditOk], timeout: 10 }],
      PostToolUseFailure: [{ hooks: [auditFailure], timeout: 10 }],
      PermissionDenied: [{ hooks: [auditDenied], timeout: 10 }],
    };
  };
}

/** Narrow helper for tests. */
export function isHookInput(x: unknown): x is HookInput {
  return Boolean(x && typeof x === 'object' && 'hook_event_name' in (x as Record<string, unknown>));
}
