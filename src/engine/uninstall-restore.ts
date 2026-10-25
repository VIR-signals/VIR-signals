// Uninstall restore: runs without the extension host, straight from the
// snapshot folder next to the compiled hook. Exit semantics per the
// contract: 0 restored and verified, 1 snapshot missing or broken with the
// site untouched, 2 the restore ran but verification failed or the outcome
// is uncertain.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SNAPSHOT_MANIFEST_NAME } from './paths';
import { mediaDirUnder } from './paths';
import { SnapshotMeta, markerPath, readMarker, snapshotDirFor } from './backup';
import { resolveVersionDir } from './locate';
import { listFiles, readJsonSync, replaceFileViaTmp, sha256File } from './fsutil';

export type UninstallOutcome =
  | { code: 0 }
  | { code: 1; why: string }
  | { code: 2; why: string };

// The stored media dir can go stale when the editor updated since the
// snapshot was written; re-resolve through the install root then.
function resolveCurrentMediaDir(meta: SnapshotMeta): string | undefined {
  if (fs.existsSync(meta.mediaDir) && fs.statSync(meta.mediaDir).isDirectory()) {
    return meta.mediaDir;
  }
  const versionDir = resolveVersionDir(meta.installRoot, meta.fingerprint.commit.slice(0, 10));
  if (versionDir === undefined) {
    return undefined;
  }
  const mediaDir = mediaDirUnder(path.join(meta.installRoot, versionDir, 'resources', 'app'));
  return fs.existsSync(mediaDir) ? mediaDir : undefined;
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
  const names = listFiles(snapDir).filter((n) => n !== SNAPSHOT_MANIFEST_NAME);
  for (const name of Object.keys(meta.files)) {
    if (!names.includes(name)) {
      return { code: 1, why: 'snapshot.fileMissing' };
    }
  }

  const mediaDir = resolveCurrentMediaDir(meta);
  if (mediaDir === undefined) {
    return { code: 1, why: 'snapshot.siteGone' };
  }
  try {
    for (const name of Object.keys(meta.files)) {
      replaceFileViaTmp(path.join(snapDir, name), path.join(mediaDir, name));
    }
    for (const name of Object.keys(meta.files)) {
      if (sha256File(path.join(mediaDir, name)) !== meta.files[name]) {
        return { code: 2, why: 'snapshot.verifyFailed' };
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
