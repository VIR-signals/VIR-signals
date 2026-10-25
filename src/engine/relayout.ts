// Mechanism four: weekly update relayout. On activation the version
// fingerprint and the version folder are compared with the ledger; a change
// means the editor was updated: the fresh official files are backed up again
// under the on site marker rule and the active pack is laid over the new
// files. The old and new directory listings are diffed and reported as is.
import { VirMessage, msg } from './msg';
import { MARKER_NAME, TX_NAME, packsDirFor } from './paths';
import { Located } from './locate';
import { loadState, saveState } from './ledger';
import { listFiles } from './fsutil';
import { backupDirFor, loadBackupManifest, takeBackup, verifyBackup } from './backup';
import { applyPack } from './replace';
import { scanPacks } from './pack-reader';

export interface DriftCheck {
  relayoutNeeded: boolean;
  reason: VirMessage | undefined;
}

export function checkVersionDrift(located: Located, storageDir: string): DriftCheck {
  const applied = loadState(storageDir).applied;
  if (!applied) {
    return { relayoutNeeded: false, reason: undefined };
  }
  if (
    applied.fingerprint.version !== located.fingerprint.version ||
    applied.fingerprint.commit !== located.fingerprint.commit
  ) {
    return {
      relayoutNeeded: true,
      reason: msg(
        'relayout.fingerprintChanged',
        applied.fingerprint.version,
        located.fingerprint.version
      ),
    };
  }
  if (applied.versionDir !== located.versionDir) {
    return {
      relayoutNeeded: true,
      reason: msg('relayout.versionDirChanged', applied.versionDir, located.versionDir),
    };
  }
  return { relayoutNeeded: false, reason: undefined };
}

export interface RelayoutReport {
  newFiles: string[];
  vanishedFiles: string[];
  appliedAgain: boolean;
  warnings: VirMessage[];
}

export type RelayoutOutcome =
  | { ok: true; report: RelayoutReport }
  | { ok: false; error: VirMessage };

export function relayoutAfterUpdate(
  located: Located,
  storageDir: string,
  owner: string,
  extensionDir?: string
): RelayoutOutcome {
  const applied = loadState(storageDir).applied;
  if (!applied) {
    return { ok: false, error: msg('relayout.notApplied') };
  }
  const warnings: VirMessage[] = [];

  const oldBackupDir = backupDirFor(storageDir, applied.fingerprint);
  let oldListing: string[] = [];
  try {
    oldListing = Object.keys(loadBackupManifest(oldBackupDir).files);
  } catch {
    warnings.push(msg('relayout.oldListingMissing'));
  }
  const newListing = listFiles(located.mediaDir).filter(
    (n) => n !== TX_NAME && n !== MARKER_NAME
  );
  const newFiles = newListing.filter((n) => !oldListing.includes(n));
  const vanishedFiles = oldListing.filter((n) => !newListing.includes(n));

  const newBackupDir = backupDirFor(storageDir, located.fingerprint);
  if (!verifyBackup(newBackupDir).ok) {
    const tb = takeBackup(located, storageDir);
    if (!tb.ok) {
      return { ok: false, error: tb.error };
    }
  }

  const packId = loadState(storageDir).activePackId || applied.packId;
  const found = scanPacks(packsDirFor(storageDir)).find(
    (s) => s.result.ok && s.result.pack.id === packId
  );
  if (!found || !found.result.ok) {
    warnings.push(msg('relayout.packMissing', packId));
    const st = loadState(storageDir);
    st.applied = null;
    saveState(storageDir, st);
    return { ok: true, report: { newFiles, vanishedFiles, appliedAgain: false, warnings } };
  }
  const r = applyPack(located, found.result.pack, storageDir, owner, extensionDir);
  if (!r.ok) {
    return { ok: false, error: r.error };
  }
  warnings.push(...r.report.warnings);
  return { ok: true, report: { newFiles, vanishedFiles, appliedAgain: true, warnings } };
}
