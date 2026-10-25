// Shared names and path constants for the engine. All file names that the
// engine drops on disk live here so the surface stays auditable.
import * as path from 'node:path';

export const MEDIA_DIR_SEGMENTS: ReadonlyArray<string> = [
  'out',
  'vs',
  'platform',
  'accessibilitySignal',
  'browser',
  'media',
];

export const MARKER_NAME = '.vir.marker';
export const LOCK_NAME = 'vir.lock';
export const STATE_NAME = 'vir-state.json';
export const TX_NAME = 'vir-tx.json';
export const TMP_SUFFIX = '.vir-tmp';

export const PACKS_DIR_NAME = 'packs';
export const BACKUP_DIR_NAME = 'backup';
export const STAGING_DIR_NAME = 'staging';
export const BACKUP_MANIFEST_NAME = 'backup.json';
export const SNAPSHOT_DIR_NAME = 'restore';
export const SNAPSHOT_MANIFEST_NAME = 'snapshot.json';

export const PACK_MANIFEST_NAME = 'manifest.json';

export const LOCK_STALE_MS = 10 * 60 * 1000;
export const AUDIO_SIZE_LIMIT_BYTES = 20 * 1024 * 1024;
export const AUDIO_SOFT_SECONDS = 2;
export const PROGRESS_SOFT_SECONDS = 1;

// Media directory below a versioned app root (resources/app).
export function mediaDirUnder(versionedAppRoot: string): string {
  return path.join(versionedAppRoot, ...MEDIA_DIR_SEGMENTS);
}
