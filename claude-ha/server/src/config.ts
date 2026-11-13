/**
 * Runtime configuration.
 *
 * Inside the add-on the s6 run script reads /data/options.json with bashio and
 * exports everything as environment variables, so this module only reads env.
 * Running outside Home Assistant (local development) works with sensible defaults.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { AuthMethod } from './auth.js';
export type { AuthMethod };

export interface AppConfig {
  port: number;
  /** Directory the agent operates in. /config on Home Assistant OS. */
  configDir: string;
  /** Persistent add-on data directory. /data on Home Assistant OS. */
  dataDir: string;
  /** Directory the built Vue app is served from. */
  publicDir: string;
  /**
   * How the Claude Code subprocess authenticates. `oauth` uses a subscription
   * OAuth token (default); `api_key` is the legacy static key.
   */
  authMethod: AuthMethod;
  /** Subscription OAuth token from `claude setup-token`. */
  oauthToken: string;
  /** Only used when authMethod is `api_key`. */
  anthropicApiKey: string;
  anthropicBaseUrl: string;
  model: string;
  logLevel: 'debug' | 'info' | 'warning' | 'error';
  supervisorToken: string;
  supervisorUrl: string;
  autoApproveReadOnly: boolean;
  /** Accept a message while a turn is running; the CLI queues it. */
  sendWhileWorking: boolean;
  /** Stop a session's Claude Code process after this many idle minutes; 0 never does. */
  idleSleepMinutes: number;
  /** Extra directory the agent may access read-only (ssl certificates). */
  version: string;
}

/**
 * The add-on version from config.yaml, which the run script exports. The
 * package.json fallback is only right in local development, where there is no
 * Supervisor to ask.
 */
function readVersion(): string {
  const fromAddon = process.env.CLAUDE_HA_VERSION?.trim();
  if (fromAddon && fromAddon !== 'null') return fromAddon;
  try {
    const pkg = JSON.parse(
      fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * The schema caps the option at a day, and this repeats the cap for a value
 * that reached the env some other way: setTimeout treats anything past 2^31-1
 * ms (about 24.8 days) as 1 ms, so "practically never" would mean "at once".
 */
const MAX_IDLE_SLEEP_MINUTES = 1440;

function envMinutes(name: string, fallback: number, max: number): number {
  const v = Number(process.env[name] || fallback);
  return Number.isFinite(v) && v >= 0 ? Math.min(v, max) : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export function loadConfig(): AppConfig {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const dataDir = process.env.CLAUDE_HA_DATA_DIR ?? '/data';
  const configDir = process.env.CLAUDE_HA_CONFIG_DIR ?? '/config';
  const logLevelRaw = (process.env.CLAUDE_HA_LOG_LEVEL ?? 'info').toLowerCase();
  const logLevel = (['debug', 'info', 'warning', 'error'].includes(logLevelRaw)
    ? logLevelRaw
    : 'info') as AppConfig['logLevel'];

  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '';
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY ?? '';
  const authMethodRaw = (process.env.CLAUDE_HA_AUTH_METHOD ?? '').toLowerCase();
  // OAuth is the default. Without an explicit choice, an API key alone
  // (typical for local development) still selects the legacy path.
  const authMethod: AuthMethod =
    authMethodRaw === 'api_key' || authMethodRaw === 'oauth'
      ? authMethodRaw
      : !oauthToken && anthropicApiKey
        ? 'api_key'
        : 'oauth';

  return {
    port: Number(process.env.CLAUDE_HA_PORT ?? 8099),
    authMethod,
    oauthToken,
    configDir,
    dataDir,
    publicDir: process.env.CLAUDE_HA_PUBLIC_DIR ?? path.resolve(here, '..', 'public'),
    anthropicApiKey,
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL ?? '',
    model: process.env.CLAUDE_HA_MODEL ?? '',
    logLevel,
    supervisorToken: process.env.SUPERVISOR_TOKEN ?? '',
    supervisorUrl: process.env.SUPERVISOR_URL ?? 'http://supervisor',
    autoApproveReadOnly: envBool('CLAUDE_HA_AUTO_APPROVE_READONLY', true),
    sendWhileWorking: envBool('CLAUDE_HA_SEND_WHILE_WORKING', true),
    idleSleepMinutes: envMinutes('CLAUDE_HA_IDLE_SLEEP_MINUTES', 10, MAX_IDLE_SLEEP_MINUTES),
    version: readVersion(),
  };
}

const LEVELS = { debug: 10, info: 20, warning: 30, error: 40 } as const;

export function createLogger(level: AppConfig['logLevel']) {
  const min = LEVELS[level];
  const emit = (lvl: keyof typeof LEVELS, args: unknown[]) => {
    if (LEVELS[lvl] < min) return;
    const ts = new Date().toISOString();
    const line = args
      .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack ?? a.message : JSON.stringify(a)))
      .join(' ');
    const out = lvl === 'error' || lvl === 'warning' ? process.stderr : process.stdout;
    out.write(`[${ts}] ${lvl.toUpperCase().padEnd(7)} ${line}\n`);
  };
  return {
    debug: (...a: unknown[]) => emit('debug', a),
    info: (...a: unknown[]) => emit('info', a),
    warning: (...a: unknown[]) => emit('warning', a),
    error: (...a: unknown[]) => emit('error', a),
  };
}

export type Logger = ReturnType<typeof createLogger>;
