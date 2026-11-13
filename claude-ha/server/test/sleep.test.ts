import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { SessionRuntime, type AgentDeps } from '../src/agent.ts';
import type { StoredSession } from '../src/store.ts';
import { loadConfig } from '../src/config.ts';

describe('idle_sleep_minutes option', () => {
  test('defaults to 10, accepts 0, caps at a day, and falls back on garbage', () => {
    const saved = process.env.CLAUDE_HA_IDLE_SLEEP_MINUTES;
    const read = (v: string | undefined) => {
      if (v === undefined) delete process.env.CLAUDE_HA_IDLE_SLEEP_MINUTES;
      else process.env.CLAUDE_HA_IDLE_SLEEP_MINUTES = v;
      return loadConfig().idleSleepMinutes;
    };
    try {
      assert.equal(read(undefined), 10);
      assert.equal(read('0'), 0);
      assert.equal(read('soon'), 10);
      // Past 2^31-1 ms setTimeout fires after 1 ms, so a huge value must not reach it.
      assert.equal(read('99999'), 1440);
    } finally {
      read(saved);
    }
  });
});

/**
 * Stands in for the SDK's Query: an async iterator the test feeds. By default
 * close() ends it, as killing the process does; `slowExit` keeps it open until
 * exit() so a test can act while the old process is still going away.
 */
class FakeQuery {
  closed = false;
  private items: SDKMessage[] = [];
  private waiter: ((r: IteratorResult<SDKMessage>) => void) | undefined;
  private ended = false;

  constructor(readonly options: Options, private readonly slowExit = false) {}

  push(message: Partial<SDKMessage> & { type: string }): void {
    const m = message as SDKMessage;
    if (this.waiter) this.waiter({ value: m, done: false });
    else this.items.push(m);
    this.waiter = undefined;
  }

  exit(): void {
    this.ended = true;
    this.waiter?.({ value: undefined, done: true });
    this.waiter = undefined;
  }

  close(): void {
    this.closed = true;
    if (!this.slowExit) this.exit();
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiter = resolve));
      },
    };
  }
}

const RESULT = { type: 'result', subtype: 'success', is_error: false, duration_ms: 1, num_turns: 1, total_cost_usd: 0 } as const;
const MINUTE = 60_000;

/** Lets the runtime's for-await loop take whatever was pushed. */
const settle = () => new Promise<void>((r) => setImmediate(r));

function setup(idleSleepMinutes: number, opts: { slowExit?: boolean } = {}) {
  const session = {
    id: 's1',
    title: 'New chat',
    createdAt: 0,
    updatedAt: 0,
    permissionMode: 'ask',
    totalCostUsd: 0,
    items: [],
    alwaysAllowedTools: [],
  } as StoredSession;
  const queries: FakeQuery[] = [];
  const silent = { debug() {}, info() {}, warning() {}, error() {} };
  const deps = {
    config: { idleSleepMinutes, configDir: '/tmp', model: '', version: 'test' },
    store: {
      appendItem: (_id: string, item: never) => session.items.push(item),
      touch() {},
      summary: () => ({}),
    },
    log: silent,
    audit: { write() {} },
    mcpServersFactory: () => ({}),
    readOnlyTools: new Set<string>(),
    hooksFactory: () => ({}),
    systemPromptAppend: '',
    credentialEnv: { set: {}, unset: [] },
    query: ({ options }: { options: Options }) => {
      const q = new FakeQuery(options, opts.slowExit);
      queries.push(q);
      return q;
    },
  } as unknown as AgentDeps;
  return { rt: new SessionRuntime(session, deps), queries };
}

/** Send a message and let Claude answer it, leaving the session idle. */
async function turn(rt: SessionRuntime, queries: FakeQuery[], text: string): Promise<FakeQuery> {
  await rt.send(text);
  const q = queries.at(-1)!;
  q.push(RESULT);
  await settle();
  assert.equal(rt.status, 'idle');
  return q;
}

describe('idle sessions stop their Claude Code process', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
  afterEach(() => mock.timers.reset());

  test('an idle session closes its process at the timeout, not before', async () => {
    const { rt, queries } = setup(10);
    const q = await turn(rt, queries, 'hello');
    mock.timers.tick(10 * MINUTE - 1);
    assert.equal(q.closed, false);
    mock.timers.tick(1);
    assert.equal(q.closed, true);
  });

  test('the next message resumes the same conversation in a new process', async () => {
    const { rt, queries } = setup(10);
    await rt.send('hello');
    queries[0].push({ type: 'system', subtype: 'init', session_id: 'sdk-1', model: 'm', mcp_servers: [] } as never);
    queries[0].push(RESULT);
    await settle();
    mock.timers.tick(10 * MINUTE);
    await settle();
    await rt.send('again');
    assert.equal(queries.length, 2);
    assert.equal(queries[1].options.resume, 'sdk-1');
  });

  test('0 minutes never stops it', async () => {
    const { rt, queries } = setup(0);
    const q = await turn(rt, queries, 'hello');
    mock.timers.tick(10_000 * MINUTE);
    assert.equal(q.closed, false);
  });

  test('going busy before the timeout restarts the wait', async () => {
    const { rt, queries } = setup(10);
    const q = await turn(rt, queries, 'one');
    mock.timers.tick(5 * MINUTE);
    await rt.send('two');
    assert.equal(rt.status, 'running');
    mock.timers.tick(10 * MINUTE);
    assert.equal(q.closed, false);
    q.push(RESULT);
    await settle();
    mock.timers.tick(10 * MINUTE);
    assert.equal(q.closed, true);
  });

  test('a message sent while the old process exits keeps its turn running', async () => {
    const { rt, queries } = setup(10, { slowExit: true });
    const old = await turn(rt, queries, 'one');
    mock.timers.tick(10 * MINUTE);
    assert.equal(old.closed, true);
    // The old process has not exited yet when the next message arrives.
    await rt.send('two');
    const fresh = queries[1];
    assert.ok(fresh);
    old.exit();
    await settle();
    assert.equal(rt.status, 'running', 'the old query ending must not mark the new turn idle');
    // A result that consumed nothing leaves 'two' queued, so the session stays busy.
    fresh.push({ ...RESULT, user_message_uuids: [] } as never);
    await settle();
    assert.equal(rt.status, 'running', 'the old query ending must not drop the queued message');
  });
});
