/**
 * Plan usage limits (the data behind Claude Code's `/usage` screen).
 *
 * The Agent SDK exposes the claude.ai plan's rate-limit windows through an
 * experimental control request on a live `Query`. This module turns that reply
 * into the compact `UsageLimits` shape the UI renders, keeps the latest copy on
 * disk so the sidebar is populated straight after a restart, and throttles
 * refreshes so a busy session does not hit the usage endpoint after every turn.
 *
 * Only subscription (OAuth) logins have plan limits. For an API key the SDK
 * answers `rate_limits_available: false` and the UI hides the meter.
 */
import fs from 'node:fs';
import type { Query, SDKControlGetUsageResponse, SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from './config.js';
import type { UsageLimits, UsageWindow } from './protocol.js';

/** Anything that can answer the SDK's get_usage control request. */
export type UsageSource = Pick<Query, 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET'>;

type Window = { utilization: number | null; resets_at: string | null } | null | undefined;

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

/** Translate the SDK's get_usage reply into the wire shape. */
export function normalizeUsage(resp: SDKControlGetUsageResponse, now = Date.now()): UsageLimits {
  const limits = resp.rate_limits;
  const windows: UsageWindow[] = [];
  if (limits) {
    const named = limits as unknown as Record<string, Window>;
    for (const { key, label } of NAMED_WINDOWS) {
      const w = named[key];
      if (!w) continue;
      windows.push({ key, label, utilization: clampPercent(w.utilization), resetsAt: w.resets_at ?? null });
    }
    for (const m of limits.model_scoped ?? []) {
      const label = `Weekly · ${m.display_name}`;
      // The per-model rows may repeat a named window (Opus, Sonnet); keep one.
      if (windows.some((w) => w.label === label)) continue;
      windows.push({
        key: `model:${m.display_name}`,
        label,
        utilization: clampPercent(m.utilization),
        resetsAt: m.resets_at ?? null,
      });
    }
  }
  const extra = limits?.extra_usage;
  return {
    available: Boolean(resp.rate_limits_available && limits),
    subscriptionType: resp.subscription_type ?? null,
    windows,
    extraUsage: extra
      ? {
          enabled: extra.is_enabled,
          utilization: clampPercent(extra.utilization),
          usedCredits: extra.used_credits,
          monthlyLimit: extra.monthly_limit,
          currency: extra.currency ?? null,
        }
      : undefined,
    updatedAt: now,
  };
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
  /** Minimum time between automatic refreshes. */
  minIntervalMs?: number;
}

export class UsageTracker {
  current: UsageLimits | null = null;
  private lastFetch = 0;
  private inflight: Promise<void> | undefined;
  private readonly minIntervalMs: number;

  constructor(private readonly opts: UsageTrackerOptions) {
    this.minIntervalMs = opts.minIntervalMs ?? 60_000;
    try {
      this.current = JSON.parse(fs.readFileSync(opts.file, 'utf8')) as UsageLimits;
    } catch {
      this.current = null;
    }
  }

  /**
   * Ask `source` for fresh numbers. Automatic refreshes (after a turn) are
   * throttled; `force` (the refresh button, a rate-limit event) is not.
   */
  refresh(source: UsageSource, force = false): Promise<void> {
    if (this.inflight) return this.inflight;
    if (!force && Date.now() - this.lastFetch < this.minIntervalMs) return Promise.resolve();
    this.lastFetch = Date.now();
    this.inflight = source
      .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })
      .then((resp) => {
        const next = normalizeUsage(resp);
        // A token without the profile scope cannot read the usage endpoint;
        // keep what the rate-limit events taught us instead of blanking it.
        if (!next.available && this.current?.windows.length) {
          this.opts.onChange(this.current);
          return;
        }
        // Keep the live throttling status from the last rate-limit event.
        if (this.current?.status) {
          next.status = this.current.status;
          next.limitType = this.current.limitType;
        }
        this.set(next);
      })
      .catch((err) => this.opts.log.debug(`usage request failed: ${String(err)}`))
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }

  noteRateLimit(info: SDKRateLimitInfo): void {
    this.set(applyRateLimitInfo(this.current, info));
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
