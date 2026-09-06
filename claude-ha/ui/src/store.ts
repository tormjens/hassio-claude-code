/**
 * Reactive client state plus the WebSocket connection to the add-on server.
 *
 * All URLs are relative to the page so the app works under the Home Assistant
 * ingress prefix (/api/hassio_ingress/<token>/) as well as in local dev.
 */
import { reactive, computed } from 'vue';
import { toast } from 'vue-sonner';
import type {
  ClientMessage,
  GitStatus,
  PermissionDecision,
  PermissionModeUi,
  PermissionRequest,
  QuestionRequest,
  ServerMessage,
  SessionStatus,
  SessionSummary,
  Settings,
  TranscriptItem,
} from '../../server/src/protocol';

export type ConnectionState = 'connecting' | 'open' | 'closed';

interface SessionView {
  items: TranscriptItem[];
  status: SessionStatus;
  pending: PermissionRequest[];
  questions: QuestionRequest[];
  loaded: boolean;
}

interface State {
  connection: ConnectionState;
  sessions: SessionSummary[];
  settings: Settings | null;
  git: GitStatus | null;
  currentId: string | null;
  views: Record<string, SessionView>;
  errors: Array<{ id: number; message: string; ts: number }>;
  sidebarOpen: boolean;
}

export const state = reactive<State>({
  connection: 'connecting',
  sessions: [],
  settings: null,
  git: null,
  currentId: null,
  views: {},
  errors: [],
  sidebarOpen: window.innerWidth > 900,
});

export const currentSession = computed(() => state.sessions.find((s) => s.id === state.currentId) ?? null);
export const currentView = computed<SessionView | null>(() => (state.currentId ? state.views[state.currentId] ?? null : null));

let ws: WebSocket | null = null;
let retry = 0;
let errorSeq = 0;
let pendingNewSession = false;

function wsUrl(): string {
  const u = new URL('ws', window.location.href);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}

function view(id: string): SessionView {
  return (state.views[id] ??= { items: [], status: 'idle', pending: [], questions: [], loaded: false });
}

function findItem(v: SessionView, id: string): TranscriptItem | undefined {
  for (let i = v.items.length - 1; i >= 0; i--) if (v.items[i].id === id) return v.items[i];
  return undefined;
}

export function pushError(message: string): void {
  const id = ++errorSeq;
  state.errors.push({ id, message, ts: Date.now() });
  setTimeout(() => dismissError(id), 8000);
  try {
    toast.error(message);
  } catch {
    // toast host not mounted yet
  }
}

export function dismissError(id: number): void {
  const i = state.errors.findIndex((e) => e.id === id);
  if (i >= 0) state.errors.splice(i, 1);
}

function handle(msg: ServerMessage): void {
  switch (msg.type) {
    case 'hello':
      state.sessions = msg.sessions;
      state.settings = msg.settings;
      state.git = msg.git;
      if (state.currentId && msg.sessions.some((s) => s.id === state.currentId)) {
        send({ type: 'subscribe', sessionId: state.currentId });
      } else if (!state.currentId && msg.sessions.length && !pendingNewSession) {
        selectSession(msg.sessions[0].id);
      }
      break;
    case 'sessions':
      state.sessions = msg.sessions;
      if (state.currentId && !msg.sessions.some((s) => s.id === state.currentId)) {
        state.currentId = msg.sessions[0]?.id ?? null;
        if (state.currentId) send({ type: 'subscribe', sessionId: state.currentId });
      }
      break;
    case 'session': {
      const i = state.sessions.findIndex((s) => s.id === msg.session.id);
      if (i >= 0) state.sessions[i] = msg.session;
      else state.sessions.unshift(msg.session);
      break;
    }
    case 'history': {
      const v = view(msg.sessionId);
      v.items = msg.items;
      v.status = msg.status;
      v.pending = msg.pending;
      v.questions = msg.questions;
      v.loaded = true;
      if (pendingNewSession) {
        pendingNewSession = false;
        state.currentId = msg.sessionId;
      }
      break;
    }
    case 'item': {
      const v = view(msg.sessionId);
      const existing = findItem(v, msg.item.id);
      if (existing) Object.assign(existing, msg.item);
      else v.items.push(msg.item);
      break;
    }
    case 'item_update': {
      const v = view(msg.sessionId);
      const existing = findItem(v, msg.item.id);
      if (existing) {
        // Replace wholesale so removed keys (inputPartial) disappear too.
        const idx = v.items.indexOf(existing);
        v.items[idx] = msg.item;
      } else v.items.push(msg.item);
      break;
    }
    case 'text_delta':
    case 'thinking_delta': {
      const item = findItem(view(msg.sessionId), msg.itemId);
      if (item && (item.kind === 'assistant_text' || item.kind === 'thinking')) item.text += msg.delta;
      break;
    }
    case 'input_delta': {
      const item = findItem(view(msg.sessionId), msg.itemId);
      if (item && item.kind === 'tool_use') item.inputPartial = (item.inputPartial ?? '') + msg.delta;
      break;
    }
    case 'status':
      view(msg.sessionId).status = msg.status;
      break;
    case 'permission_request': {
      const v = view(msg.sessionId);
      if (!v.pending.some((p) => p.requestId === msg.request.requestId)) v.pending.push(msg.request);
      break;
    }
    case 'permission_resolved': {
      const v = view(msg.sessionId);
      v.pending = v.pending.filter((p) => p.requestId !== msg.requestId);
      break;
    }
    case 'question_request': {
      const v = view(msg.sessionId);
      if (!v.questions.some((q) => q.requestId === msg.request.requestId)) v.questions.push(msg.request);
      break;
    }
    case 'question_resolved': {
      const v = view(msg.sessionId);
      v.questions = v.questions.filter((q) => q.requestId !== msg.requestId);
      break;
    }
    case 'git':
      state.git = msg.git;
      break;
    case 'models':
      if (state.settings) state.settings.models = msg.models;
      break;
    case 'error':
      pushError(msg.message);
      break;
  }
}

export function connect(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  state.connection = 'connecting';
  ws = new WebSocket(wsUrl());
  ws.onopen = () => {
    state.connection = 'open';
    retry = 0;
  };
  ws.onmessage = (ev) => {
    try {
      handle(JSON.parse(ev.data as string) as ServerMessage);
    } catch (err) {
      console.error('bad server message', err);
    }
  };
  ws.onclose = () => {
    state.connection = 'closed';
    ws = null;
    const delay = Math.min(15000, 500 * 2 ** retry++);
    setTimeout(connect, delay);
  };
  ws.onerror = () => ws?.close();
}

export function send(msg: ClientMessage): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    pushError('Not connected to the add-on. Reconnecting…');
    return;
  }
  ws.send(JSON.stringify(msg));
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export function selectSession(id: string): void {
  if (state.currentId && state.currentId !== id) send({ type: 'unsubscribe', sessionId: state.currentId });
  state.currentId = id;
  if (!view(id).loaded) send({ type: 'subscribe', sessionId: id });
  else send({ type: 'subscribe', sessionId: id });
  if (window.innerWidth <= 900) state.sidebarOpen = false;
}

export function newSession(mode?: PermissionModeUi): void {
  pendingNewSession = true;
  if (state.currentId) send({ type: 'unsubscribe', sessionId: state.currentId });
  send({ type: 'new_session', permissionMode: mode ?? currentSession.value?.permissionMode ?? 'ask' });
  if (window.innerWidth <= 900) state.sidebarOpen = false;
}

export function sendMessage(text: string): void {
  if (!state.currentId) {
    pendingNewSession = true;
    send({ type: 'new_session' });
    // The history message will set currentId; queue the text after it.
    const stop = setInterval(() => {
      if (state.currentId) {
        clearInterval(stop);
        send({ type: 'send', sessionId: state.currentId, text });
      }
    }, 50);
    setTimeout(() => clearInterval(stop), 5000);
    return;
  }
  send({ type: 'send', sessionId: state.currentId, text });
}

export function interrupt(): void {
  if (state.currentId) send({ type: 'interrupt', sessionId: state.currentId });
}

export function setPermissionMode(mode: PermissionModeUi): void {
  if (state.currentId) send({ type: 'set_permission_mode', sessionId: state.currentId, mode });
}

export function setModel(model: string | undefined): void {
  if (state.currentId) send({ type: 'set_model', sessionId: state.currentId, model });
}

export function respondPermission(requestId: string, decision: PermissionDecision): void {
  if (state.currentId) send({ type: 'permission_response', sessionId: state.currentId, requestId, decision });
}

export function answerQuestion(requestId: string, answers: string[][]): void {
  if (state.currentId) send({ type: 'question_response', sessionId: state.currentId, requestId, answers });
}

export function deleteSession(id: string): void {
  send({ type: 'delete_session', sessionId: id });
  delete state.views[id];
}

export function renameSession(id: string, title: string): void {
  send({ type: 'rename_session', sessionId: id, title });
}

export function gitInit(): void {
  send({ type: 'git_init' });
}

export function revertSession(id: string): void {
  send({ type: 'revert_session', sessionId: id });
}

