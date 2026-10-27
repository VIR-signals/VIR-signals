// Uninstall restore: runs without the extension host, straight from the
// snapshot folder next to the compiled hook, with the global storage backup
// as the second source when the snapshot is gone (an extension folder swap
// destroys the snapshot, while storage only dies after this hook). Exit
// semantics per the contract: 0 restored and verified, 1 no usable source
// with the site untouched, 2 the restore ran but verification failed or the
// outcome is uncertain.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SNAPSHOT_MANIFEST_NAME } from './paths';
import { mediaDirUnder, BACKUP_DIR_NAME } from './paths';
import { SnapshotMeta, markerPath, readMarker, snapshotDirFor, loadBackupManifest, BackupManifest } from './backup';
import { resolveVersionDir } from './locate';
import { listFiles, readJsonSync, replaceFileViaTmp, sha256File } from './fsutil';

export type UninstallOutcome =
  | { code: 0 }
  | { code: 1; why: string }
  | { code: 2; why: string };

interface RestoreMeta {
  mediaDir: string;
  installRoot: string;
  commit: string;
  files: Record<string, string>;
}

// The stored media dir can go stale when the editor updated since the
// source was written; re-resolve through the install root then.
function resolveCurrentMediaDir(meta: RestoreMeta): string | undefined {
  if (fs.existsSync(meta.mediaDir) && fs.statSync(meta.mediaDir).isDirectory()) {
    return meta.mediaDir;
  }
  const versionDir = resolveVersionDir(meta.installRoot, meta.commit.slice(0, 10));
  if (versionDir === undefined) {
    return undefined;
  }
  const mediaDir = mediaDirUnder(path.join(meta.installRoot, versionDir, 'resources', 'app'));
  return fs.existsSync(mediaDir) ? mediaDir : undefined;
}

function restoreFromSource(srcDir: string, meta: RestoreMeta, whyPrefix: string): UninstallOutcome {
  const names = listFiles(srcDir).filter(
    (n) => n !== SNAPSHOT_MANIFEST_NAME && n !== 'backup.json'
  );
  for (const name of Object.keys(meta.files)) {
    if (!names.includes(name)) {
      return { code: 1, why: `${whyPrefix}.fileMissing` };
    }
  }

  const mediaDir = resolveCurrentMediaDir(meta);
  if (mediaDir === undefined) {
    return { code: 1, why: `${whyPrefix}.siteGone` };
  }
  try {
    for (const name of Object.keys(meta.files)) {
      replaceFileViaTmp(path.join(srcDir, name), path.join(mediaDir, name));
    }
    for (const name of Object.keys(meta.files)) {
      if (sha256File(path.join(mediaDir, name)) !== meta.files[name]) {
        return { code: 2, why: `${whyPrefix}.verifyFailed` };
      }
    }
    if (readMarker(mediaDir) !== undefined) {
      fs.rmSync(markerPath(mediaDir), { force: true });
    }
  } catch (e) {
    return { code: 2, why: (e as Error).message };
  }
  return { code: 0 };
}

export function restoreFromSnapshot(extensionDir: string): UninstallOutcome {
  const snapDir = snapshotDirFor(extensionDir);
  const metaPath = path.join(snapDir, SNAPSHOT_MANIFEST_NAME);
  if (!fs.existsSync(metaPath)) {
    return { code: 1, why: 'snapshot.missing' };
  }
  let meta: SnapshotMeta;
  try {
    meta = readJsonSync<SnapshotMeta>(metaPath);
    if (
      meta.schemaVersion !== 1 ||
      typeof meta.mediaDir !== 'string' ||
      Object.keys(meta.files ?? {}).length === 0
    ) {
      return { code: 1, why: 'snapshot.bad' };
    }
  } catch {
    return { code: 1, why: 'snapshot.bad' };
  }
  return restoreFromSource(
    snapDir,
    {
      mediaDir: meta.mediaDir,
      installRoot: meta.installRoot,
      commit: meta.fingerprint.commit,
      files: meta.files,
    },
    'snapshot'
  );
}

// Second source: the backup under the extension storage root. Newest
// manifest first; an uncertain outcome (code 2) is never papered over by
// trying another candidate.
export function restoreFromBackupRoot(storageRoot: string): UninstallOutcome {
  const backupRoot = path.join(storageRoot, BACKUP_DIR_NAME);
  if (!fs.existsSync(backupRoot) || !fs.statSync(backupRoot).isDirectory()) {
    return { code: 1, why: 'backup.missing' };
  }
  const candidates: Array<{ dir: string; man: BackupManifest }> = [];
  for (const entry of fs.readdirSync(backupRoot)) {
    const dir = path.join(backupRoot, entry);
    if (!fs.statSync(dir).isDirectory()) {
      continue;
    }
    try {
      const man = loadBackupManifest(dir);
      if (Object.keys(man.files ?? {}).length > 0) {
        candidates.push({ dir, man });
      }
    } catch {
      continue;
    }
  }
  if (candidates.length === 0) {
    return { code: 1, why: 'backup.bad' };
  }
  candidates.sort((a, b) => (a.man.createdAt < b.man.createdAt ? 1 : -1));
  let lastTried: UninstallOutcome = { code: 1, why: 'backup.bad' };
  for (const c of candidates) {
    lastTried = restoreFromSource(
      c.dir,
      {
        mediaDir: c.man.mediaDir,
        installRoot: c.man.installRoot,
        commit: c.man.fingerprint.commit,
        files: c.man.files,
      },
      'backup'
    );
    if (lastTried.code !== 1) {
      return lastTried;
    }
  }
  return lastTried;
}
