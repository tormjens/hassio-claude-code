import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import { applyRateLimitInfo, normalizeUsage, UsageTracker, type UsageSource } from '../src/usage.ts';
import type { UsageLimits } from '../src/protocol.ts';

const session = {
  total_cost_usd: 0,
  total_api_duration_ms: 0,
  total_duration_ms: 0,
  total_lines_added: 0,
  total_lines_removed: 0,
  model_usage: {},
};

function reply(rateLimits: SDKControlGetUsageResponse['rate_limits']): SDKControlGetUsageResponse {
  return { session, subscription_type: 'max', rate_limits_available: rateLimits !== null, rate_limits: rateLimits, behaviors: null };
}

const silentLog = { debug() {}, info() {}, warning() {}, error() {} } as never;

describe('normalizeUsage', () => {
  test('lists the windows the plan reports, in a fixed order, skipping null ones', () => {
    const u = normalizeUsage(
      reply({
        seven_day: { utilization: 41.5, resets_at: '2026-10-20T00:00:00Z' },
        five_hour: { utilization: 12, resets_at: '2026-10-14T15:00:00Z' },
        seven_day_opus: null,
        model_scoped: [{ display_name: 'Fable', utilization: 140, resets_at: null }],
      }),
      1,
    );
    assert.equal(u.available, true);
    assert.equal(u.subscriptionType, 'max');
    assert.deepEqual(
      u.windows.map((w) => [w.key, w.utilization]),
      [
        ['five_hour', 12],
        ['seven_day', 41.5],
        ['model:Fable', 100],
      ],
    );
  });

  test('is unavailable for logins without plan limits', () => {
    const u = normalizeUsage(reply(null));
    assert.equal(u.available, false);
    assert.deepEqual(u.windows, []);
  });
});

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
    const base = normalizeUsage(
      reply({
        five_hour: { utilization: 10, resets_at: null },
        seven_day: { utilization: 20, resets_at: null },
      }),
    );
    const u = applyRateLimitInfo(base, { status: 'allowed', rateLimitType: 'seven_day', utilization: 0.25 });
    assert.deepEqual(u.windows.map((w) => w.utilization), [10, 25]);
    assert.equal(base.windows[1].utilization, 20, 'input is not mutated');
  });
});

describe('UsageTracker', () => {
  function tracker(minIntervalMs = 60_000) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
    const changes: Array<UsageLimits | null> = [];
    const t = new UsageTracker({ file: path.join(dir, 'usage.json'), log: silentLog, onChange: (u) => changes.push(u), minIntervalMs });
    return { t, changes, dir };
  }
  function source(resp: SDKControlGetUsageResponse): UsageSource & { calls: number } {
    const s = {
      calls: 0,
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
        s.calls++;
        return resp;
      },
    };
    return s;
  }

  test('throttles automatic refreshes but not forced ones, and persists the snapshot', async () => {
    const { t, changes, dir } = tracker();
    const src = source(reply({ five_hour: { utilization: 5, resets_at: null } }));
    await t.refresh(src);
    await t.refresh(src);
    assert.equal(src.calls, 1);
    await t.refresh(src, true);
    assert.equal(src.calls, 2);
    assert.equal(changes.length, 2);
    const reloaded = new UsageTracker({ file: path.join(dir, 'usage.json'), log: silentLog, onChange() {} });
    assert.equal(reloaded.current?.windows[0].utilization, 5);
  });

  test('an unavailable reply does not wipe windows learned from rate-limit events', async () => {
    const { t } = tracker();
    t.noteRateLimit({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.5 });
    await t.refresh(source(reply(null)), true);
    assert.equal(t.current?.windows[0].utilization, 50);
  });
});
