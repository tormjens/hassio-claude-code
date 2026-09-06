/**
 * Persistence for chat sessions and their transcripts under /data.
 *
 * Layout:
 *   /data/sessions/<id>.json     one file per session: metadata + transcript items
 *   /data/audit.log              JSON lines, written by audit.ts
 *
 * Writes are debounced per session so a fast-streaming turn does not hammer the
 * SD card most Home Assistant boxes run on.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PermissionModeUi, SessionSummary, TranscriptItem } from './protocol.js';

export interface StoredSession extends SessionSummary {
  items: TranscriptItem[];
  /** Tool names the user chose "always allow" for during this session. */
  alwaysAllowedTools: string[];
}

const FLUSH_DELAY_MS = 400;

export class SessionStore {
  private readonly dir: string;
  private readonly cache = new Map<string, StoredSession>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'sessions');
    fs.mkdirSync(this.dir, { recursive: true });
    this.loadAll();
  }

  private fileFor(id: string): string {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error(`Invalid session id: ${id}`);
    return path.join(this.dir, `${id}.json`);
  }

  private loadAll(): void {
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = fs.readFileSync(path.join(this.dir, name), 'utf8');
        const session = JSON.parse(raw) as StoredSession;
        if (session && typeof session.id === 'string') {
          session.items ??= [];
          session.alwaysAllowedTools ??= [];
          session.totalCostUsd ??= 0;
          this.cache.set(session.id, session);
        }
      } catch (err) {
        process.stderr.write(`claude-ha: could not read session file ${name}: ${String(err)}\n`);
      }
    }
  }

  list(): SessionSummary[] {
    return [...this.cache.values()]
      .map((s) => this.summary(s))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  summary(s: StoredSession): SessionSummary {
    const { items: _items, alwaysAllowedTools: _a, ...summary } = s;
    return summary;
  }

  get(id: string): StoredSession | undefined {
    return this.cache.get(id);
  }

  create(permissionMode: PermissionModeUi = 'ask'): StoredSession {
    const now = Date.now();
    const session: StoredSession = {
      id: randomUUID(),
      title: 'New chat',
      createdAt: now,
      updatedAt: now,
      permissionMode,
      totalCostUsd: 0,
      items: [],
      alwaysAllowedTools: [],
    };
    this.cache.set(session.id, session);
    this.scheduleFlush(session.id);
    return session;
  }

  /** Mark a session dirty and schedule a write. */
  touch(id: string): void {
    const s = this.cache.get(id);
    if (!s) return;
    s.updatedAt = Date.now();
    this.scheduleFlush(id);
  }

  appendItem(id: string, item: TranscriptItem): void {
    const s = this.cache.get(id);
    if (!s) return;
    s.items.push(item);
    if (item.kind === 'user' && s.title === 'New chat') {
      s.title = item.text.replace(/\s+/g, ' ').trim().slice(0, 60) || 'New chat';
    }
    this.touch(id);
  }

  async delete(id: string): Promise<void> {
    this.cache.delete(id);
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
    await fsp.rm(this.fileFor(id), { force: true });
  }

  private scheduleFlush(id: string): void {
    const existing = this.timers.get(id);
    if (existing) return;
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        void this.flush(id);
      }, FLUSH_DELAY_MS),
    );
  }

  async flush(id: string): Promise<void> {
    const s = this.cache.get(id);
    if (!s) return;
    const file = this.fileFor(id);
    const tmp = `${file}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify(s), 'utf8');
      await fsp.rename(tmp, file);
    } catch (err) {
      process.stderr.write(`claude-ha: could not write session ${id}: ${String(err)}\n`);
    }
  }

  async flushAll(): Promise<void> {
    for (const [id, t] of this.timers) {
      clearTimeout(t);
      this.timers.delete(id);
    }
    await Promise.all([...this.cache.keys()].map((id) => this.flush(id)));
  }
}
