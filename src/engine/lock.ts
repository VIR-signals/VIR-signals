// Cross window write lock. One lock file per storage area, created atomically,
// holding the window identity and a timestamp. A lock older than the stale
// window is reclaimed: the holder window died without releasing.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LOCK_NAME, LOCK_STALE_MS } from './paths';
import { VirMessage, msg } from './msg';

interface LockContent {
  readonly owner: string;
  readonly at: number;
}

export type LockResult = { ok: true } | { ok: false; error: VirMessage };

function lockPath(dir: string): string {
  return path.join(dir, LOCK_NAME);
}

function readLock(p: string): LockContent | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as { owner?: unknown; at?: unknown };
    if (typeof raw.owner !== 'string' || typeof raw.at !== 'number') {
      return undefined;
    }
    return { owner: raw.owner, at: raw.at };
  } catch {
    return undefined;
  }
}

function tryCreate(p: string, owner: string): boolean {
  try {
    const fd = fs.openSync(p, 'wx');
    fs.writeSync(fd, JSON.stringify({ owner, at: Date.now() }));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if ((e as { code?: string }).code === 'EEXIST') {
      return false;
    }
    throw e;
  }
}

export function acquireLock(dir: string, owner: string): LockResult {
  fs.mkdirSync(dir, { recursive: true });
  const p = lockPath(dir);
  if (tryCreate(p, owner)) {
    return { ok: true };
  }
  const held = readLock(p);
  const ageMs = Date.now() - (held ? held.at : fs.statSync(p).mtimeMs);
  if (ageMs >= LOCK_STALE_MS) {
    fs.unlinkSync(p);
    if (tryCreate(p, owner)) {
      return { ok: true };
    }
  }
  const stillHeld = readLock(p);
  return {
    ok: false,
    error: msg('lock.busy', stillHeld ? stillHeld.owner : '', Math.round(ageMs / 1000)),
  };
}

// Only the owner releases: another window holding the lock is not ours to drop.
export function releaseLock(dir: string, owner: string): void {
  const p = lockPath(dir);
  const held = readLock(p);
  if (held && held.owner === owner) {
    fs.unlinkSync(p);
  }
}
