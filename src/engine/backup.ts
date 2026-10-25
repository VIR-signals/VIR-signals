// Mechanism two: full backup of the official media directory under the on
// site marker rule. A backup may only be taken from an untouched install:
// when the marker is present the files on disk are pack files, and copying
// them into the backup is refused. Every copy is read back and hash checked.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { msg, VirMessage } from './msg';
import { BACKUP_DIR_NAME, BACKUP_MANIFEST_NAME, MARKER_NAME, PROBE_NAME, SNAPSHOT_DIR_NAME, SNAPSHOT_MANIFEST_NAME, TX_NAME } from './paths';
import { acquireLock, releaseLock } from './lock';
import { Fingerprint, Located } from './locate';
import { atomicWriteFile, copyFileVerified, ensureDir, listDirs, listFiles, readJsonSync, sha256File } from './fsutil';

export interface BackupManifest {
  schemaVersion: 1;
  fingerprint: Fingerprint;
  versionDir: string;
  mediaDir: string;
  installRoot: string;
  createdAt: string;
  files: Record<string, string>;
}

export type BackupResult =
  | { ok: true; dir: string; manifest: BackupManifest; fileCount: number }
  | { ok: false; error: VirMessage };

export interface SiteMarker {
  readonly packId: string;
  readonly at: number;
  readonly version: string;
}

export function slugFor(fp: Fingerprint): string {
  const raw = `${fp.version}-${fp.commit.slice(0, 10)}`;
  return raw.replace(/[^0-9a-zA-Z.-]/g, '-');
}

export function backupDirFor(storageDir: string, fp: Fingerprint): string {
  return path.join(storageDir, BACKUP_DIR_NAME, slugFor(fp));
}

export function markerPath(mediaDir: string): string {
  return path.join(mediaDir, MARKER_NAME);
}

// The marker decides: file exists means the site was replaced. Content is
// informational; an unreadable marker still counts as present.
export function readMarker(mediaDir: string): SiteMarker | undefined {
  const p = markerPath(mediaDir);
  if (!fs.existsSync(p)) {
    return undefined;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as { packId?: unknown; at?: unknown; version?: unknown };
    return {
      packId: typeof raw.packId === 'string' ? raw.packId : '',
      at: typeof raw.at === 'number' ? raw.at : 0,
      version: typeof raw.version === 'string' ? raw.version : '',
    };
  } catch {
    return { packId: '', at: 0, version: '' };
  }
}

export function writeMarker(mediaDir: string, m: SiteMarker): void {
  atomicWriteFile(markerPath(mediaDir), JSON.stringify(m, null, 2));
}

export function takeBackup(located: Located, storageDir: string): BackupResult {
  if (readMarker(located.mediaDir) !== undefined) {
    return { ok: false, error: msg('backup.blocked', located.mediaDir) };
  }
  const dir = backupDirFor(storageDir, located.fingerprint);
  ensureDir(dir);
  // Control files we own never belong in a backup of official content.
  const names = listFiles(located.mediaDir).filter(
    (n) => n !== MARKER_NAME && n !== TX_NAME && n !== PROBE_NAME
  );
  if (names.length === 0) {
    return { ok: false, error: msg('backup.emptyDir', located.mediaDir) };
  }
  const files: Record<string, string> = {};
  for (const name of names) {
    copyFileVerified(path.join(located.mediaDir, name), path.join(dir, name));
    files[name] = sha256File(path.join(dir, name));
  }
  const manifest: BackupManifest = {
    schemaVersion: 1,
    fingerprint: located.fingerprint,
    versionDir: located.versionDir,
    mediaDir: located.mediaDir,
    installRoot: located.installRoot,
    createdAt: new Date().toISOString(),
    files,
  };
  atomicWriteFile(path.join(dir, BACKUP_MANIFEST_NAME), JSON.stringify(manifest, null, 2));
  dropOtherBackups(storageDir, dir);
  return { ok: true, dir, manifest, fileCount: names.length };
}

// Old version backups are stale data: a new fingerprint backup replaces them.
function dropOtherBackups(storageDir: string, keep: string): void {
  const root = path.join(storageDir, BACKUP_DIR_NAME);
  if (!fs.existsSync(root)) {
    return;
  }
  for (const name of listDirs(root)) {
    const p = path.join(root, name);
    if (p !== keep) {
      fs.rmSync(p, { recursive: true, force: true });
    }
  }
}

export function loadBackupManifest(dir: string): BackupManifest {
  const m = readJsonSync<BackupManifest>(path.join(dir, BACKUP_MANIFEST_NAME));
  if (m.schemaVersion !== 1) {
    throw new Error('backup.schemaUnknown');
  }
  return m;
}

export type VerifyBackupResult =
  | { ok: true; manifest: BackupManifest }
  | { ok: false; error: VirMessage };

export function verifyBackup(dir: string): VerifyBackupResult {
  let manifest: BackupManifest;
  try {
    manifest = loadBackupManifest(dir);
  } catch {
    return { ok: false, error: msg('backup.absent', dir) };
  }
  for (const name of Object.keys(manifest.files)) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) {
      return { ok: false, error: msg('backup.verifyFailed', name) };
    }
    if (sha256File(p) !== manifest.files[name]) {
      return { ok: false, error: msg('backup.verifyFailed', name) };
    }
  }
  return { ok: true, manifest };
}

export function deleteBackup(storageDir: string): void {
  fs.rmSync(path.join(storageDir, BACKUP_DIR_NAME), { recursive: true, force: true });
}

// Activation time backup: make sure the official baseline exists in storage
// before anything else happens. Replacements still verify and enforce the
// backup on their own, this only front loads the safety line.
export type EnsureBackupResult =
  | { ok: true; created: boolean }
  | { ok: false; error: VirMessage };

export function ensureBackup(
  located: Located,
  storageDir: string,
  owner: string
): EnsureBackupResult {
  if (verifyBackup(backupDirFor(storageDir, located.fingerprint)).ok) {
    return { ok: true, created: false };
  }
  const lock = acquireLock(storageDir, owner);
  if (!lock.ok) {
    return { ok: false, error: lock.error };
  }
  try {
    const tb = takeBackup(located, storageDir);
    if (!tb.ok) {
      return { ok: false, error: tb.error };
    }
    return { ok: true, created: true };
  } finally {
    releaseLock(storageDir, owner);
  }
}

// Uninstall snapshot: a copy of the official baseline that lives inside the
// extension folder, so the uninstall hook survives even after globalStorage
// is gone.
export interface SnapshotMeta {
  schemaVersion: 1;
  mediaDir: string;
  installRoot: string;
  fingerprint: Fingerprint;
  createdAt: string;
  files: Record<string, string>;
}

export function snapshotDirFor(extensionDir: string): string {
  return path.join(extensionDir, 'out', SNAPSHOT_DIR_NAME);
}

export function writeUninstallSnapshot(extensionDir: string, backupDir: string): void {
  const manifest = loadBackupManifest(backupDir);
  const dir = snapshotDirFor(extensionDir);
  fs.rmSync(dir, { recursive: true, force: true });
  ensureDir(dir);
  for (const name of Object.keys(manifest.files)) {
    copyFileVerified(path.join(backupDir, name), path.join(dir, name));
  }
  const meta: SnapshotMeta = {
    schemaVersion: 1,
    mediaDir: manifest.mediaDir,
    installRoot: manifest.installRoot,
    fingerprint: manifest.fingerprint,
    createdAt: new Date().toISOString(),
    files: manifest.files,
  };
  atomicWriteFile(path.join(dir, SNAPSHOT_MANIFEST_NAME), JSON.stringify(meta, null, 2));
}

export type SnapshotState = 'ok' | 'missing' | 'bad';

export function snapshotState(extensionDir: string): SnapshotState {
  const metaPath = path.join(snapshotDirFor(extensionDir), SNAPSHOT_MANIFEST_NAME);
  if (!fs.existsSync(metaPath)) {
    return 'missing';
  }
  try {
    const meta = readJsonSync<SnapshotMeta>(metaPath);
    if (meta.schemaVersion !== 1 || Object.keys(meta.files ?? {}).length === 0) {
      return 'bad';
    }
  } catch {
    return 'bad';
  }
  return 'ok';
}
