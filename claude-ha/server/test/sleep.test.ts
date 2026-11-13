import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import { SessionRuntime, type AgentDeps } from '../src/agent.ts';
import type { StoredSession } from '../src/store.ts';
import { loadConfig } from '../src/config.ts';

describe('idle_sleep_minutes option', () => {
  test('defaults to 10, accepts 0, and falls back on garbage', () => {
    const saved = process.env.CLAUDE_HA_IDLE_SLEEP_MINUTES;
    try {
      delete process.env.CLAUDE_HA_IDLE_SLEEP_MINUTES;
      assert.equal(loadConfig().idleSleepMinutes, 10);
      process.env.CLAUDE_HA_IDLE_SLEEP_MINUTES = '0';
      assert.equal(loadConfig().idleSleepMinutes, 0);
      process.env.CLAUDE_HA_IDLE_SLEEP_MINUTES = 'soon';
      assert.equal(loadConfig().idleSleepMinutes, 10);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_HA_IDLE_SLEEP_MINUTES;
      else process.env.CLAUDE_HA_IDLE_SLEEP_MINUTES = saved;
    }
  });
});

// Reaches past `private` to stand in for the SDK process; what is under test is
// when the runtime decides to stop it, not the SDK.
interface Internals {
  q: { close(): void } | undefined;
  consuming: Promise<void> | undefined;
  setStatus(status: string): void;
}

function runtime(sleepMs: number) {
  const silent = { debug() {}, info() {}, warning() {}, error() {} };
  const deps = { log: silent, config: { idleSleepMinutes: sleepMs / 60_000 } } as unknown as AgentDeps;
  const rt = new SessionRuntime({ id: 's1', items: [] } as unknown as StoredSession, deps);
  const inner = rt as unknown as Internals;
  let closed = 0;
  inner.q = { close: () => void closed++ };
  return { rt, inner, closed: () => closed };
}

describe('idle sessions stop their Claude Code process', () => {
  test('a session idle past the timeout closes its process', async () => {
    const { inner, closed } = runtime(20);
    inner.setStatus('running');
    inner.setStatus('idle');
    await wait(60);
    assert.equal(closed(), 1);
    assert.equal(inner.q, undefined);
  });

  test('0 minutes never stops it', async () => {
    const { inner, closed } = runtime(0);
    inner.setStatus('running');
    inner.setStatus('idle');
    await wait(30);
    assert.equal(closed(), 0);
  });

  test('going busy before the timeout keeps the process', async () => {
    const { inner, closed } = runtime(40);
    inner.setStatus('running');
    inner.setStatus('idle');
    await wait(10);
    inner.setStatus('running');
    await wait(80);
    assert.equal(closed(), 0);
  });

  test('a turn started while the old process exits is not marked idle', async () => {
    const { rt, inner } = runtime(10_000);
    let finish!: () => void;
    inner.consuming = new Promise<void>((r) => (finish = r));
    const closing = rt.close();
    // A message arrives mid-close and starts a fresh process.
    inner.q = { close() {} };
    inner.setStatus('running');
    finish();
    await closing;
    assert.equal(rt.status, 'running');
  });
});
