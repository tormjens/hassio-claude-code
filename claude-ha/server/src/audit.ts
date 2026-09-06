/**
 * Append-only audit log of every tool call at /data/audit.log (JSON lines).
 *
 * Arguments are redacted before writing: keys that look like secrets are
 * replaced, long strings are truncated, and file contents are never logged in
 * full. The goal is an answerable "what did Claude do to my config last night",
 * not a second transcript.
 */
import fs from 'node:fs';
import path from 'node:path';

const SECRET_KEY = /(token|password|passwd|secret|api[_-]?key|authorization|credential|cookie)/i;
const MAX_STRING = 400;
const MAX_DEPTH = 6;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[depth]';
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… [${value.length} chars]` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) && typeof v === 'string' ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface AuditEntry {
  ts: string;
  sessionId: string;
  toolUseId?: string;
  tool: string;
  args: unknown;
  outcome: 'ok' | 'error' | 'denied' | 'blocked';
  detail?: string;
  durationMs?: number;
}

export class AuditLog {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'audit.log');
  }

  write(entry: Omit<AuditEntry, 'ts'>): void {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...entry,
      args: redact(entry.args),
      detail: entry.detail ? (redact(entry.detail) as string) : undefined,
    });
    fs.appendFile(this.file, `${line}\n`, (err) => {
      if (err) process.stderr.write(`claude-ha: audit log write failed: ${err.message}\n`);
    });
  }

  /** Read the last `n` entries (used by the settings panel). */
  tail(n = 200): AuditEntry[] {
    try {
      const lines = fs.readFileSync(this.file, 'utf8').trimEnd().split('\n');
      return lines
        .slice(-n)
        .map((l) => {
          try {
            return JSON.parse(l) as AuditEntry;
          } catch {
            return undefined;
          }
        })
        .filter((e): e is AuditEntry => Boolean(e));
    } catch {
      return [];
    }
  }
}
