/**
 * Runtime configuration.
 *
 * Inside the add-on the s6 run script reads /data/options.json with bashio and
 * exports everything as environment variables, so this module only reads env.
 * Running outside Home Assistant (local development) works with sensible defaults.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface AppConfig {
  port: number;
  /** Directory the agent operates in. /config on Home Assistant OS. */
  configDir: string;
  /** Persistent add-on data directory. /data on Home Assistant OS. */
  dataDir: string;
  /** Directory the built Vue app is served from. */
  publicDir: string;
  anthropicApiKey: string;
  anthropicBaseUrl: string;
  model: string;
  logLevel: 'debug' | 'info' | 'warning' | 'error';
  supervisorToken: string;
  supervisorUrl: string;
  autoApproveReadOnly: boolean;
  /** Extra directory the agent may access read-only (ssl certificates). */
  version: string;
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
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

  return {
    port: Number(process.env.CLAUDE_HA_PORT ?? 8099),
    configDir,
    dataDir,
    publicDir: process.env.CLAUDE_HA_PUBLIC_DIR ?? path.resolve(here, '..', 'public'),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL ?? '',
    model: process.env.CLAUDE_HA_MODEL ?? '',
    logLevel,
    supervisorToken: process.env.SUPERVISOR_TOKEN ?? '',
    supervisorUrl: process.env.SUPERVISOR_URL ?? 'http://supervisor',
    autoApproveReadOnly: envBool('CLAUDE_HA_AUTO_APPROVE_READONLY', true),
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
