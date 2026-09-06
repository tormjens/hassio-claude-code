/**
 * Minimal git wrapper for the Home Assistant config directory.
 *
 * Used for:
 *  - detecting whether /config is a repository (the UI offers to init it)
 *  - creating a checkpoint commit before the first file edit of a session
 *  - reverting everything a session changed
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { GitStatus } from './protocol.js';

const GIT_IDENTITY = [
  '-c',
  'user.name=Claude for Home Assistant',
  '-c',
  'user.email=claude-ha@addon.local',
  '-c',
  'safe.directory=*',
  '-c',
  'core.hooksPath=/dev/null',
];

export const DEFAULT_GITIGNORE = `# Added by the Claude for Home Assistant add-on
# Secrets and credentials
secrets.yaml
*.pem
*.key
*.crt
.cloud/
.storage/auth
.storage/auth_provider.homeassistant
.storage/onboarding
.storage/cloud
.storage/hassio
# Databases, logs and caches
*.db
*.db-shm
*.db-wal
*.db-journal
*.log
*.log.*
*.log.fault
home-assistant_v2.db*
.HA_VERSION
.uuid
.ha_run
__pycache__/
*.pyc
tts/
image/
www/community/
deps/
.cache/
.storage/*.db
# Editor and OS noise
.DS_Store
Thumbs.db
*.swp
`;

export class GitRepo {
  constructor(private readonly dir: string) {}

  run(args: string[], timeoutMs = 30_000): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        [...GIT_IDENTITY, ...args],
        { cwd: this.dir, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
        (err, stdout, stderr) => {
          if (err) {
            const e = new Error(`git ${args[0]} failed: ${stderr.trim() || err.message}`);
            reject(e);
            return;
          }
          resolve(stdout);
        },
      );
    });
  }

  async isRepo(): Promise<boolean> {
    try {
      const out = await this.run(['rev-parse', '--is-inside-work-tree']);
      return out.trim() === 'true';
    } catch {
      return false;
    }
  }

  async status(): Promise<GitStatus> {
    try {
      if (!(await this.isRepo())) return { isRepo: false };
      const porcelain = await this.run(['status', '--porcelain']);
      let head: string | undefined;
      try {
        head = (await this.run(['rev-parse', '--short', 'HEAD'])).trim();
      } catch {
        head = undefined; // no commits yet
      }
      return { isRepo: true, dirty: porcelain.trim().length > 0, head };
    } catch (err) {
      return { isRepo: false, error: (err as Error).message };
    }
  }

  /** Initialise the repository, add a .gitignore and make the first commit. */
  async init(): Promise<void> {
    if (!(await this.isRepo())) {
      await this.run(['init', '-q', '-b', 'main']);
    }
    const ignorePath = path.join(this.dir, '.gitignore');
    try {
      await fs.access(ignorePath);
      const existing = await fs.readFile(ignorePath, 'utf8');
      if (!existing.includes('secrets.yaml')) {
        await fs.appendFile(ignorePath, `\n${DEFAULT_GITIGNORE}`);
      }
    } catch {
      await fs.writeFile(ignorePath, DEFAULT_GITIGNORE, 'utf8');
    }
    await this.run(['add', '-A']);
    await this.commitIfChanged('Initial snapshot by Claude for Home Assistant');
  }

  /** Commit the working tree if anything changed. Returns the commit hash or the current HEAD. */
  async commitIfChanged(message: string): Promise<string | undefined> {
    await this.run(['add', '-A']);
    const staged = await this.run(['diff', '--cached', '--name-only']);
    let hasHead = true;
    try {
      await this.run(['rev-parse', '--verify', 'HEAD']);
    } catch {
      hasHead = false;
    }
    if (staged.trim().length > 0 || !hasHead) {
      await this.run(['commit', '-q', '--allow-empty', '-m', message]);
    }
    return (await this.run(['rev-parse', 'HEAD'])).trim();
  }

  /**
   * Revert every change made after `checkpoint` (a commit hash) as a new
   * commit, preserving history so nothing is ever lost.
   */
  async revertTo(checkpoint: string, label: string): Promise<{ changed: boolean; commit?: string }> {
    // Snapshot whatever is uncommitted so it becomes part of the reverted range.
    await this.commitIfChanged(`claude-ha: snapshot before reverting ${label}`);
    const diff = await this.run(['diff', '--name-only', checkpoint, 'HEAD']);
    if (diff.trim().length === 0) return { changed: false };
    await this.run(['revert', '--no-commit', `${checkpoint}..HEAD`]);
    await this.run(['commit', '-q', '-m', `claude-ha: revert ${label}`]);
    const commit = (await this.run(['rev-parse', 'HEAD'])).trim();
    return { changed: true, commit };
  }

  async diffSince(checkpoint: string): Promise<string> {
    await this.run(['add', '-A', '--intent-to-add']).catch(() => undefined);
    return this.run(['diff', checkpoint]);
  }
}
