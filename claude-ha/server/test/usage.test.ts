import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyRateLimitInfo,
  parseRateLimitHeaders,
  probeRateLimitHeaders,
  UsageTracker,
} from '../src/usage.ts';
import type { UsageLimits } from '../src/protocol.ts';

const silentLog = { debug() {}, info() {}, warning() {}, error() {} } as never;

describe('applyRateLimitInfo', () => {
  test('creates a window from an event, converting the fraction and epoch seconds', () => {
    const u = applyRateLimitInfo(null, { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.83, resetsAt: 1_800_000_000 });
    assert.equal(u.available, true);
    assert.equal(u.status, 'allowed_warning');
    assert.equal(u.windows.length, 1);
    assert.equal(u.windows[0].utilization, 83);
    assert.equal(u.windows[0].resetsAt, new Date(1_800_000_000_000).toISOString());
  });

  test('updates an existing window and keeps the others', () => {
    let base = applyRateLimitInfo(null, { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.1 });
    base = applyRateLimitInfo(base, { status: 'allowed', rateLimitType: 'seven_day', utilization: 0.2 });
    const u = applyRateLimitInfo(base, { status: 'allowed', rateLimitType: 'seven_day', utilization: 0.25 });
    assert.deepEqual(u.windows.map((w) => w.utilization), [10, 25]);
    assert.equal(base.windows[1].utilization, 20, 'input is not mutated');
  });
});

describe('UsageTracker', () => {
  function tracker() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
    const changes: Array<UsageLimits | null> = [];
    const t = new UsageTracker({ file: path.join(dir, 'usage.json'), log: silentLog, onChange: (u) => changes.push(u) });
    return { t, changes, dir };
  }

  test('applies several header infos in one update and persists the snapshot', () => {
    const { t, changes, dir } = tracker();
    assert.equal(t.hasWindows, false);
    t.noteRateLimits([
      { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.1 },
      { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.8 },
    ]);
    assert.equal(changes.length, 1);
    assert.equal(t.hasWindows, true);
    assert.equal(t.current?.status, 'allowed_warning');
    const reloaded = new UsageTracker({ file: path.join(dir, 'usage.json'), log: silentLog, onChange() {} });
    assert.deepEqual(reloaded.current?.windows.map((w) => w.utilization), [10, 80]);
  });

  test('ignores an empty list', () => {
    const { t, changes } = tracker();
    t.noteRateLimits([]);
    assert.equal(changes.length, 0);
  });
});

const rlHeaders = {
  'anthropic-ratelimit-unified-status': 'allowed_warning',
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  'anthropic-ratelimit-unified-5h-utilization': '0.82',
  'anthropic-ratelimit-unified-5h-reset': '1800000000',
  'anthropic-ratelimit-unified-7d-utilization': '0.3',
  'anthropic-ratelimit-unified-7d-reset': '1800300000',
};

describe('parseRateLimitHeaders', () => {
  test('reads both windows, with the overall status on the representative one, applied last', () => {
    const infos = parseRateLimitHeaders(new Headers(rlHeaders));
    assert.deepEqual(
      infos.map((i) => [i.rateLimitType, i.status, i.utilization, i.resetsAt]),
      [
        ['seven_day', 'allowed', 0.3, 1800300000],
        ['five_hour', 'allowed_warning', 0.82, 1800000000],
      ],
    );
    const u = infos.reduce<UsageLimits | null>((acc, i) => applyRateLimitInfo(acc, i), null)!;
    assert.deepEqual(u.windows.map((w) => [w.key, w.utilization]), [
      ['five_hour', 82],
      ['seven_day', 30],
    ]);
    assert.equal(u.status, 'allowed_warning');
  });

  test('is empty without rate-limit headers', () => {
    assert.deepEqual(parseRateLimitHeaders(new Headers({ 'content-type': 'application/json' })), []);
  });
});

describe('probeRateLimitHeaders', () => {
  function fakeFetch(responses: Array<{ status: number; headers?: Record<string, string> }>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const r = responses.shift()!;
      return new Response('{}', { status: r.status, headers: r.headers });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  test('sends a one-token request with the OAuth token and reads the headers', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, headers: rlHeaders }]);
    const infos = await probeRateLimitHeaders({ baseUrl: 'https://gw.example/', oauthToken: 'tok', fetchImpl: impl });
    assert.equal(infos.length, 2);
    assert.equal(calls[0].url, 'https://gw.example/v1/messages');
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.authorization, 'Bearer tok');
    assert.equal(headers['anthropic-beta'], 'oauth-2025-04-20');
    assert.equal(JSON.parse(String(calls[0].init.body)).max_tokens, 1);
  });

  test('a 429 still yields the windows', async () => {
    const { impl } = fakeFetch([{ status: 429, headers: { ...rlHeaders, 'anthropic-ratelimit-unified-status': 'rejected' } }]);
    const infos = await probeRateLimitHeaders({ oauthToken: 'tok', fetchImpl: impl });
    assert.equal(infos.at(-1)?.status, 'rejected');
  });

  test('tries the next model when one is not available', async () => {
    const { impl, calls } = fakeFetch([{ status: 404 }, { status: 200, headers: rlHeaders }]);
    const infos = await probeRateLimitHeaders({ oauthToken: 'tok', fetchImpl: impl, models: ['a', 'b'] });
    assert.equal(infos.length, 2);
    assert.deepEqual(calls.map((c) => JSON.parse(String(c.init.body)).model), ['a', 'b']);
  });

  test('a rejected token fails straight away with a clear message', async () => {
    const { impl, calls } = fakeFetch([{ status: 401 }, { status: 200, headers: rlHeaders }]);
    await assert.rejects(probeRateLimitHeaders({ oauthToken: 'bad', fetchImpl: impl }), /rejected \(HTTP 401\)/);
    assert.equal(calls.length, 1);
  });
});
