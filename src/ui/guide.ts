// One shot guidance claim across windows. Every window runs its own
// extension host, so on install all of them activate at once; the claim
// files elect a single window to show each one-shot dialog while the
// others work silently. A claim older than the stale window is reclaimed.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LOCK_STALE_MS } from '../engine/paths';

export type GuideStage = 'one' | 'two';

function claimPath(storageDir: string, stage: GuideStage): string {
  return path.join(storageDir, `vir-guide-${stage}.lock`);
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

export function claimGuide(storageDir: string, owner: string, stage: GuideStage): boolean {
  fs.mkdirSync(storageDir, { recursive: true });
  const p = claimPath(storageDir, stage);
  if (tryCreate(p, owner)) {
    return true;
  }
  const judgedMtime = fs.statSync(p).mtimeMs;
  if (Date.now() - judgedMtime < LOCK_STALE_MS) {
    return false;
  }
  // Re-stat right before the delete: a claim another window recreated
  // after the staleness judgment carries a new mtime and survives; one
  // already removed does not crash us; the exclusive create settles the
  // race with a second reclaimer.
  if (fs.statSync(p).mtimeMs !== judgedMtime) {
    return false;
  }
  try {
    fs.unlinkSync(p);
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT') {
      throw e;
    }
  }
  return tryCreate(p, owner);
}
