/**
 * Plan usage limits: how much of the Claude subscription's 5-hour session and
 * weekly limits is used, and when each resets.
 *
 * The numbers come from the `anthropic-ratelimit-unified-*` headers on model
 * responses. The CLI forwards them as `rate_limit_event`s during a chat, which
 * costs nothing extra; the refresh button sends a one-token request and reads
 * the same headers. (The SDK's experimental get_usage call is not used: it
 * needs the user:profile scope, which `claude setup-token` tokens do not have,
 * and it took 30 seconds to say so.)
 *
 * The latest snapshot is kept on disk so the sidebar is populated straight
 * after a restart. API keys and gateways get no such headers, so the UI hides
 * the meter for them.
 */
import fs from 'node:fs';
import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from './config.js';
import type { UsageLimits } from './protocol.js';

const NAMED_WINDOWS: Array<{ key: string; label: string }> = [
  { key: 'five_hour', label: 'Current session' },
  { key: 'seven_day', label: 'Weekly · all models' },
  { key: 'seven_day_opus', label: 'Weekly · Opus' },
  { key: 'seven_day_sonnet', label: 'Weekly · Sonnet' },
  { key: 'seven_day_oauth_apps', label: 'Weekly · apps' },
  { key: 'seven_day_overage_included', label: 'Weekly · included models' },
];

function clampPercent(n: number | null | undefined): number | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, n));
}

/**
 * Fold a live rate-limit event into the snapshot. The CLI reads these from the
 * response headers of every model request, so they work even for tokens that
 * cannot call the usage endpoint (the `claude setup-token` kind).
 */
export function applyRateLimitInfo(usage: UsageLimits | null, info: SDKRateLimitInfo, now = Date.now()): UsageLimits {
  const next: UsageLimits = usage
    ? { ...usage, windows: usage.windows.map((w) => ({ ...w })) }
    : { available: true, subscriptionType: null, windows: [], updatedAt: now };
  next.available = true;
  next.status = info.status;
  next.limitType = info.rateLimitType;
  const named = NAMED_WINDOWS.find((n) => n.key === info.rateLimitType);
  if (!named) return next;
  let w = next.windows.find((x) => x.key === named.key);
  if (!w) {
    w = { key: named.key, label: named.label, utilization: null, resetsAt: null };
    next.windows.push(w);
    next.windows.sort((a, b) => windowOrder(a.key) - windowOrder(b.key));
  }
  // Unlike get_usage, the event's utilization is a fraction (0-1) and
  // resetsAt is in epoch seconds.
  if (typeof info.utilization === 'number') w.utilization = clampPercent(info.utilization * 100);
  if (typeof info.resetsAt === 'number') w.resetsAt = new Date(info.resetsAt * 1000).toISOString();
  next.updatedAt = now;
  return next;
}

const HEADER_WINDOWS = [
  { prefix: '5h', key: 'five_hour' },
  { prefix: '7d', key: 'seven_day' },
] as const;

/**
 * Read the plan's rate-limit windows from the `anthropic-ratelimit-unified-*`
 * headers of a Messages API response, as rate-limit infos (fractions, epoch
 * seconds). Empty when the response carried none (API keys, gateways).
 */
export function parseRateLimitHeaders(headers: Headers): SDKRateLimitInfo[] {
  const status = headers.get('anthropic-ratelimit-unified-status');
  const claim = headers.get('anthropic-ratelimit-unified-representative-claim');
  const infos: SDKRateLimitInfo[] = [];
  for (const { prefix, key } of HEADER_WINDOWS) {
    const util = Number.parseFloat(headers.get(`anthropic-ratelimit-unified-${prefix}-utilization`) ?? '');
    const reset = Number.parseFloat(headers.get(`anthropic-ratelimit-unified-${prefix}-reset`) ?? '');
    if (!Number.isFinite(util) && !Number.isFinite(reset)) continue;
    infos.push({
      status: 'allowed',
      rateLimitType: key,
      ...(Number.isFinite(util) && { utilization: util }),
      ...(Number.isFinite(reset) && { resetsAt: reset }),
    });
  }
  // The overall status describes the representative (currently limiting)
  // window; apply it last so it is the one the snapshot keeps.
  if (status === 'allowed' || status === 'allowed_warning' || status === 'rejected') {
    const i = infos.findIndex((x) => x.rateLimitType === claim);
    const target = i >= 0 ? infos.splice(i, 1)[0] : infos.pop();
    if (target) infos.push({ ...target, status });
  }
  return infos;
}

export interface ProbeOptions {
  /** API base URL; defaults to https://api.anthropic.com. */
  baseUrl?: string;
  /** Subscription OAuth token (`claude setup-token`). */
  oauthToken: string;
  /** Models to try, cheapest first, until one answers with rate-limit headers. */
  models?: string[];
  fetchImpl?: typeof fetch;
}

/**
 * Learn the plan's usage from response headers by sending the smallest
 * possible request (one output token), like Claude Code's own quota check.
 * Used when the token cannot read the usage endpoint: `claude setup-token`
 * tokens only carry the user:inference scope.
 */
export async function probeRateLimitHeaders(opts: ProbeOptions): Promise<SDKRateLimitInfo[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${(opts.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '')}/v1/messages`;
  let lastError = '';
  for (const model of opts.models ?? ['claude-haiku-5-5', 'claude-haiku-4-5']) {
    const res = await doFetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.oauthToken}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'quota' }] }),
      signal: AbortSignal.timeout(20_000),
    });
    // A 429 still carries the headers, and is exactly when they matter.
    const infos = parseRateLimitHeaders(res.headers);
    await res.body?.cancel().catch(() => undefined);
    if (infos.length) return infos;
    if (res.status === 401 || res.status === 403) throw new Error(`the token was rejected (HTTP ${res.status})`);
    lastError = `HTTP ${res.status}`;
  }
  throw new Error(`no usage information in the response (${lastError})`);
}

function windowOrder(key: string): number {
  const i = NAMED_WINDOWS.findIndex((n) => n.key === key);
  return i < 0 ? NAMED_WINDOWS.length : i;
}

export interface UsageTrackerOptions {
  /** File the last snapshot is cached in. */
  file: string;
  log: Logger;
  /** Called whenever the snapshot changes. */
  onChange: (usage: UsageLimits | null) => void;
}

export class UsageTracker {
  current: UsageLimits | null = null;

  constructor(private readonly opts: UsageTrackerOptions) {
    try {
      this.current = JSON.parse(fs.readFileSync(opts.file, 'utf8')) as UsageLimits;
    } catch {
      this.current = null;
    }
  }

  noteRateLimit(info: SDKRateLimitInfo): void {
    this.set(applyRateLimitInfo(this.current, info));
  }

  /** Apply several infos at once (from response headers) with one update. */
  noteRateLimits(infos: SDKRateLimitInfo[]): void {
    if (!infos.length) return;
    this.set(infos.reduce<UsageLimits | null>((u, info) => applyRateLimitInfo(u, info), this.current) as UsageLimits);
  }

  /** True when there is something to show. */
  get hasWindows(): boolean {
    return Boolean(this.current?.available && this.current.windows.length);
  }

  private set(next: UsageLimits): void {
    this.current = next;
    try {
      fs.writeFileSync(this.opts.file, JSON.stringify(next, null, 2));
    } catch (err) {
      this.opts.log.debug(`could not persist usage.json: ${String(err)}`);
    }
    this.opts.onChange(next);
  }
}
