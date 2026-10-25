// Mechanism five: lay every official file back from the verified backup,
// check each hash against the backup record, then clear the applied state
// and the on site marker. The backup itself stays for the next replacement.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { VirMessage, msg } from './msg';
import { Located, Fingerprint } from './locate';
import { acquireLock, releaseLock } from './lock';
import { backupDirFor, markerPath, verifyBackup } from './backup';
import { replaceFileViaTmp, sha256File } from './fsutil';
import { loadState, saveState } from './ledger';
import { resolvePendingTx } from './replace';

export type RestoreOutcome =
  | { ok: true; fileCount: number; fingerprint: Fingerprint }
  | { ok: false; error: VirMessage };

export function restoreOfficial(
  located: Located,
  storageDir: string,
  owner: string
): RestoreOutcome {
  const lock = acquireLock(storageDir, owner);
  if (!lock.ok) {
    return { ok: false, error: lock.error };
  }
  try {
    const resolved = resolvePendingTx(located.mediaDir);
    if (!resolved.ok) {
      return { ok: false, error: resolved.error };
    }
    const bdir = backupDirFor(storageDir, located.fingerprint);
    const vb = verifyBackup(bdir);
    if (!vb.ok) {
      return { ok: false, error: msg('restore.noBackup', vb.error.key) };
    }
    const manifest = vb.manifest;
    for (const name of Object.keys(manifest.files)) {
      replaceFileViaTmp(path.join(bdir, name), path.join(located.mediaDir, name));
    }
    for (const name of Object.keys(manifest.files)) {
      if (sha256File(path.join(located.mediaDir, name)) !== manifest.files[name]) {
        return { ok: false, error: msg('restore.verifyFailed', name) };
      }
    }
    fs.rmSync(markerPath(located.mediaDir), { force: true });
    const state = loadState(storageDir);
    state.applied = null;
    saveState(storageDir, state);
    return { ok: true, fileCount: Object.keys(manifest.files).length, fingerprint: manifest.fingerprint };
  } finally {
    releaseLock(storageDir, owner);
  }
}
