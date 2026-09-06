/**
 * Entry point: HTTP server (static UI + small JSON API) and the WebSocket
 * endpoint the chat UI talks to. Everything runs in this one process.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { loadConfig, createLogger } from './config.js';
import { createStaticHandler, ingressPath, isTrustedPeer, sendJson, sendText } from './http.js';
import { SessionStore } from './store.js';
import { AuditLog } from './audit.js';
import { GitRepo } from './git.js';
import { HaClient } from './ha-client.js';
import { createHaTools, HA_SERVER_NAME, READ_ONLY_TOOLS } from './ha-tools.js';
import { createHooksFactory } from './hooks.js';
import { SessionManager } from './agent.js';
import { buildSystemPromptAppend } from './system-prompt.js';
import { buildCredentialEnv, credentialsConfigured } from './auth.js';
import type { AuthStatus, ClientMessage, ModelOption, ServerMessage, Settings } from './protocol.js';
import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk';

const config = loadConfig();
const log = createLogger(config.logLevel);
const insideAddon = fs.existsSync('/data/options.json');
const allowAnyPeer = process.env.CLAUDE_HA_ALLOW_ANY_PEER === '1' || !insideAddon;

fs.mkdirSync(config.dataDir, { recursive: true });
const store = new SessionStore(config.dataDir);
const audit = new AuditLog(config.dataDir);
const git = new GitRepo(config.configDir);
const ha = new HaClient({ baseUrl: config.supervisorUrl, token: config.supervisorToken });

let haVersion: string | undefined;
let gitEnabled = false;
try {
  gitEnabled = await git.isRepo();
} catch {
  gitEnabled = false;
}
if (ha.configured) {
  try {
    const info = await ha.coreInfo();
    haVersion = typeof info.version === 'string' ? info.version : undefined;
    log.info(`Home Assistant Core ${haVersion ?? '(unknown version)'} reachable via Supervisor`);
  } catch (err) {
    log.warning(`Supervisor API not reachable yet: ${(err as Error).message}`);
  }
} else {
  log.warning('SUPERVISOR_TOKEN is not set: Home Assistant tools will fail until the add-on runs under the Supervisor');
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

const authConfig = {
  method: config.authMethod,
  oauthToken: config.oauthToken,
  anthropicApiKey: config.anthropicApiKey,
  anthropicBaseUrl: config.anthropicBaseUrl,
};
const credentialEnv = buildCredentialEnv(authConfig);

// ---------------------------------------------------------------------------
// Available models (learned from the SDK's session-init message, cached on disk
// so the selector is populated immediately after a restart).
// ---------------------------------------------------------------------------
const modelsPath = path.join(config.dataDir, 'models.json');
let availableModels: ModelOption[] = [];
try {
  availableModels = JSON.parse(fs.readFileSync(modelsPath, 'utf8')) as ModelOption[];
} catch {
  availableModels = [];
}

function onModels(models: ModelInfo[]): void {
  const next: ModelOption[] = models.map((m) => ({
    value: m.value,
    label: m.displayName,
    description: m.description,
  }));
  if (JSON.stringify(next) === JSON.stringify(availableModels)) return;
  availableModels = next;
  try {
    fs.writeFileSync(modelsPath, JSON.stringify(next, null, 2));
  } catch (err) {
    log.debug(`could not persist models.json: ${String(err)}`);
  }
  log.info(`learned ${next.length} available models`);
  broadcast({ type: 'models', models: next });
}

function authStatus(): AuthStatus {
  return { method: config.authMethod, configured: credentialsConfigured(authConfig) };
}

const sessions = new SessionManager({
  config,
  store,
  log,
  audit,
  mcpServersFactory: () => ({ [HA_SERVER_NAME]: createHaTools({ ha, configDir: config.configDir }) }),
  readOnlyTools: READ_ONLY_TOOLS,
  hooksFactory: createHooksFactory({ ha, git, audit, store, log, configDir: config.configDir }),
  systemPromptAppend: buildSystemPromptAppend(config, { haVersion, gitEnabled }),
  credentialEnv,
  onModels,
});

/** True when the selected method has enough configuration to attempt a request. */
function hasCredentials(): boolean {
  return credentialsConfigured(authConfig);
}

function settings(): Settings {
  return {
    model: config.model,
    baseUrl: config.anthropicBaseUrl,
    autoApproveReadOnly: config.autoApproveReadOnly,
    hasApiKey: hasCredentials(),
    auth: authStatus(),
    models: availableModels,
    defaultModel: config.model,
    logLevel: config.logLevel,
    configDir: config.configDir,
    version: config.version,
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const serveStatic = createStaticHandler(config.publicDir);

const server = http.createServer(async (req, res) => {
  try {
    if (!isTrustedPeer(req, allowAnyPeer)) {
      sendText(res, 403, 'Forbidden: only Home Assistant ingress may access this add-on');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        version: config.version,
        ingressPath: ingressPath(req),
        configDir: config.configDir,
        hasApiKey: hasCredentials(),
        auth: authStatus(),
        supervisor: ha.configured,
      });
      return;
    }
    if (url.pathname === '/api/audit') {
      const n = Number(url.searchParams.get('n') ?? 200);
      sendJson(res, 200, audit.tail(Number.isFinite(n) ? n : 200));
      return;
    }
    if (url.pathname === '/api/sessions' && req.method === 'GET') {
      sendJson(res, 200, store.list());
      return;
    }
    const diffMatch = /^\/api\/sessions\/([a-zA-Z0-9-]+)\/diff$/.exec(url.pathname);
    if (diffMatch) {
      const s = store.get(diffMatch[1]);
      if (!s?.checkpointCommit) {
        sendText(res, 404, 'No checkpoint for this session');
        return;
      }
      sendText(res, 200, await git.diffSince(s.checkpointCommit));
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'Method not allowed');
      return;
    }
    await serveStatic(req, res, url.pathname);
  } catch (err) {
    log.error('request failed', err);
    if (!res.headersSent) sendText(res, 500, 'Internal error');
    else res.end();
  }
});

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (!isTrustedPeer(req, allowAnyPeer)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

/** Everyone connected sees session list changes and git status. */
function broadcast(msg: ServerMessage): void {
  for (const client of wss.clients) send(client, msg);
}

async function gitStatus() {
  return git.status();
}

wss.on('connection', async (ws) => {
  const subscriptions = new Map<string, () => void>();

  send(ws, { type: 'hello', sessions: store.list(), settings: settings(), git: await gitStatus() });

  const subscribe = (sessionId: string) => {
    if (subscriptions.has(sessionId)) return;
    const rt = sessions.get(sessionId);
    if (!rt) {
      send(ws, { type: 'error', sessionId, message: 'Unknown session' });
      return;
    }
    const unsub = rt.subscribe((msg) => {
      send(ws, msg);
      if (msg.type === 'session') broadcast({ type: 'sessions', sessions: store.list() });
    });
    subscriptions.set(sessionId, unsub);
    const stored = store.get(sessionId);
    send(ws, {
      type: 'history',
      sessionId,
      items: stored?.items ?? [],
      status: rt.status,
      pending: rt.pendingPermissions(),
      questions: rt.pendingQuestions(),
    });
  };

  ws.on('message', async (data) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString()) as ClientMessage;
    } catch {
      send(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }
    try {
      switch (msg.type) {
        case 'list_sessions':
          send(ws, { type: 'sessions', sessions: store.list() });
          break;
        case 'new_session': {
          const rt = sessions.create(msg.permissionMode ?? 'ask');
          broadcast({ type: 'sessions', sessions: store.list() });
          subscribe(rt.id);
          break;
        }
        case 'subscribe':
          subscribe(msg.sessionId);
          break;
        case 'unsubscribe':
          subscriptions.get(msg.sessionId)?.();
          subscriptions.delete(msg.sessionId);
          break;
        case 'send': {
          if (!hasCredentials()) {
            send(ws, {
              type: 'error',
              sessionId: msg.sessionId,
              message:
                config.authMethod === 'oauth'
                  ? 'Not signed in. Run `claude setup-token` and set the token in the add-on options (Authentication), then restart the add-on.'
                  : 'No Anthropic API key configured. Add it in the add-on options and restart the add-on.',
            });
            break;
          }
          const rt = sessions.get(msg.sessionId);
          if (!rt) throw new Error('Unknown session');
          subscribe(msg.sessionId);
          await rt.send(msg.text);
          break;
        }
        case 'interrupt':
          await sessions.get(msg.sessionId)?.interrupt();
          break;
        case 'set_permission_mode':
          await sessions.get(msg.sessionId)?.setPermissionMode(msg.mode);
          break;
        case 'set_model':
          await sessions.get(msg.sessionId)?.setModel(msg.model);
          break;
        case 'question_response': {
          const rt = sessions.get(msg.sessionId);
          if (!rt?.resolveQuestion(msg.requestId, msg.answers)) {
            send(ws, { type: 'error', sessionId: msg.sessionId, message: 'That question is no longer waiting for an answer.' });
          }
          break;
        }
        case 'permission_response': {
          const rt = sessions.get(msg.sessionId);
          if (!rt?.resolvePermission(msg.requestId, msg.decision)) {
            send(ws, { type: 'error', sessionId: msg.sessionId, message: 'That permission request is no longer pending.' });
          }
          break;
        }
        case 'rename_session': {
          const s = store.get(msg.sessionId);
          if (s) {
            s.title = msg.title.trim().slice(0, 80) || s.title;
            store.touch(s.id);
            broadcast({ type: 'sessions', sessions: store.list() });
          }
          break;
        }
        case 'delete_session':
          subscriptions.get(msg.sessionId)?.();
          subscriptions.delete(msg.sessionId);
          await sessions.delete(msg.sessionId);
          broadcast({ type: 'sessions', sessions: store.list() });
          break;
        case 'git_init':
          await git.init();
          gitEnabled = true;
          broadcast({ type: 'git', git: await gitStatus() });
          break;
        case 'revert_session': {
          const s = store.get(msg.sessionId);
          if (!s?.checkpointCommit) throw new Error('This session has no checkpoint to revert to.');
          const rt = sessions.get(msg.sessionId);
          const result = await git.revertTo(s.checkpointCommit, `session ${s.id.slice(0, 8)}`);
          s.reverted = true;
          store.touch(s.id);
          rt?.context().note(
            'info',
            result.changed
              ? `Reverted this session's file changes (commit ${result.commit?.slice(0, 7)}). Run a config check and reload if needed.`
              : 'Nothing to revert: the configuration matches the checkpoint.',
          );
          rt?.context().emit({ type: 'session', session: store.summary(s) });
          broadcast({ type: 'git', git: await gitStatus() });
          break;
        }
        default:
          send(ws, { type: 'error', message: `Unknown message type ${(msg as { type: string }).type}` });
      }
    } catch (err) {
      log.warning(`ws ${msg.type} failed`, err);
      send(ws, { type: 'error', sessionId: 'sessionId' in msg ? msg.sessionId : undefined, message: (err as Error).message });
    }
  });

  ws.on('close', () => {
    for (const unsub of subscriptions.values()) unsub();
    subscriptions.clear();
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

server.listen(config.port, '0.0.0.0', () => {
  log.info(`Claude for Home Assistant ${config.version} listening on :${config.port}`);
  log.info(`config dir: ${config.configDir}, data dir: ${config.dataDir}, ui: ${config.publicDir}`);
  if (config.authMethod === 'oauth') {
    log.info('auth: subscription OAuth token');
    if (!config.oauthToken && !config.anthropicBaseUrl) {
      log.warning(
        'no OAuth token configured yet: run `claude setup-token` and paste the result into the add-on options',
      );
    }
  } else {
    log.info('auth: static API key (legacy)');
    if (!config.anthropicApiKey && !config.anthropicBaseUrl) log.warning('ANTHROPIC_API_KEY is not set');
  }
  if (config.model) log.info(`model: ${config.model}`);
  if (config.anthropicBaseUrl) log.info(`base url: ${config.anthropicBaseUrl}`);
});

let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`received ${sig}, shutting down`);
    setTimeout(() => process.exit(0), 5000).unref();
    await sessions.closeAll().catch(() => undefined);
    await store.flushAll().catch(() => undefined);
    server.close(() => process.exit(0));
  });
}
