// Mechanism three: transactional replacement with full recompute. Every
// apply rebuilds the whole target set from the verified official baseline:
// slots the pack declares get pack audio, every other slot is reset to the
// official file, so switching packs leaves no old pack audio behind. The
// write is one transaction: staged outside the target directory, committed
// file by file through a temp rename, verified by hash, rolled back from the
// pre transaction snapshot on any failure. A crash leaves the transaction
// record behind; the next mutating call completes the rollback first, it
// never guesses a half committed state forward.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { VirMessage, msg } from './msg';
import { STAGING_DIR_NAME, TX_NAME } from './paths';
import { Located } from './locate';
import { PackInfo, SlotAudio } from './pack-reader';
import { SLOTS } from './slot-table';
import {
  acquireLock,
  releaseLock,
} from './lock';
import {
  backupDirFor,
  readMarker,
  takeBackup,
  verifyBackup,
  writeMarker,
  writeUninstallSnapshot,
} from './backup';
import {
  atomicWriteFile,
  copyFileVerified,
  ensureDir,
  replaceFileViaTmp,
  sha256File,
} from './fsutil';
import { loadState, saveState } from './ledger';

export interface ApplyReport {
  replaced: string[];
  baseline: string[];
  warnings: VirMessage[];
  disabled: Record<string, VirMessage>;
}

export type ApplyOutcome =
  | { ok: true; report: ApplyReport }
  | { ok: false; error: VirMessage };

interface TxTarget {
  name: string;
  source: 'pack' | 'baseline';
  stagedHash: string;
  beforeHash: string;
  committed: boolean;
}

interface TxRecord {
  schemaVersion: 1;
  state: 'committing' | 'rolling-back';
  packId: string;
  packName: string;
  mediaDir: string;
  stagingDir: string;
  fingerprintVersion: string;
  targets: TxTarget[];
  createdAt: string;
}

export type PendingTx = { tx: TxRecord } | { bad: true };

function txPath(mediaDir: string): string {
  return path.join(mediaDir, TX_NAME);
}

let stagingSeq = 0;

function stagingDirFor(storageDir: string): string {
  stagingSeq += 1;
  return path.join(storageDir, STAGING_DIR_NAME, `${Date.now()}-${stagingSeq}`);
}

// Full recompute: the final state of every slot file, pack declared or
// official baseline.
function computePlan(
  pack: PackInfo,
  backupDir: string
): Array<{ name: string; source: 'pack' | 'baseline'; sourcePath: string }> {
  const out: Array<{ name: string; source: 'pack' | 'baseline'; sourcePath: string }> = [];
  for (const entry of SLOTS) {
    for (const file of entry.files) {
      let audio: SlotAudio | undefined;
      if (entry.slot === 'responseReceived') {
        const sub = file.slice(0, -'.mp3'.length);
        audio = pack.slots[sub] ?? pack.slots['responseReceived'];
      } else {
        audio = pack.slots[entry.slot];
      }
      if (audio) {
        out.push({ name: file, source: 'pack', sourcePath: audio.absPath });
      } else {
        out.push({ name: file, source: 'baseline', sourcePath: path.join(backupDir, file) });
      }
    }
  }
  return out;
}

export function readPendingTx(mediaDir: string): PendingTx | undefined {
  const p = txPath(mediaDir);
  if (!fs.existsSync(p)) {
    return undefined;
  }
  try {
    const tx = JSON.parse(fs.readFileSync(p, 'utf8')) as TxRecord;
    if (
      tx.schemaVersion !== 1 ||
      typeof tx.mediaDir !== 'string' ||
      typeof tx.stagingDir !== 'string' ||
      !Array.isArray(tx.targets)
    ) {
      return { bad: true };
    }
    return { tx };
  } catch {
    return { bad: true };
  }
}

type RollbackOutcome = { ok: true } | { ok: false; error: VirMessage };

// Restore every target from the pre transaction snapshot and verify. Runs
// full pass regardless of the per file committed flags, so re running it
// after a crash mid rollback converges.
function rollbackTx(tx: TxRecord): RollbackOutcome {
  try {
    tx.state = 'rolling-back';
    atomicWriteFile(txPath(tx.mediaDir), JSON.stringify(tx, null, 2));
    const snapDir = path.join(tx.stagingDir, 'before');
    for (const t of tx.targets) {
      replaceFileViaTmp(path.join(snapDir, t.name), path.join(tx.mediaDir, t.name));
    }
    for (const t of tx.targets) {
      if (sha256File(path.join(tx.mediaDir, t.name)) !== t.beforeHash) {
        throw new Error('recovery.rollbackHash');
      }
    }
    fs.rmSync(txPath(tx.mediaDir), { force: true });
    fs.rmSync(tx.stagingDir, { recursive: true, force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: msg('recovery.rollbackFailed', (e as Error).message) };
  }
}

// Resolve a crash left transaction before any mutating step: the rollback
// direction is always defined, completing it is the only resolution.
export function resolvePendingTx(mediaDir: string): RollbackOutcome {
  const pending = readPendingTx(mediaDir);
  if (pending === undefined) {
    return { ok: true };
  }
  if ('bad' in pending) {
    return { ok: false, error: msg('recovery.corrupt') };
  }
  return rollbackTx(pending.tx);
}

export function applyPack(
  located: Located,
  pack: PackInfo,
  storageDir: string,
  owner: string,
  extensionDir?: string
): ApplyOutcome {
  const lock = acquireLock(storageDir, owner);
  if (!lock.ok) {
    return { ok: false, error: lock.error };
  }
  try {
    const resolved = resolvePendingTx(located.mediaDir);
    if (!resolved.ok) {
      return { ok: false, error: resolved.error };
    }

    const backupDir = backupDirFor(storageDir, located.fingerprint);
    if (!verifyBackup(backupDir).ok) {
      if (readMarker(located.mediaDir) !== undefined) {
        return { ok: false, error: msg('apply.noBaseline') };
      }
      const tb = takeBackup(located, storageDir);
      if (!tb.ok) {
        return { ok: false, error: tb.error };
      }
    }

    const plan = computePlan(pack, backupDir);
    const stagingDir = stagingDirFor(storageDir);
    const stageDir = path.join(stagingDir, 'stage');
    const snapDir = path.join(stagingDir, 'before');
    ensureDir(stageDir);
    ensureDir(snapDir);
    const targets: TxTarget[] = [];
    for (const t of plan) {
      const staged = path.join(stageDir, t.name);
      copyFileVerified(t.sourcePath, staged);
      const before = path.join(snapDir, t.name);
      copyFileVerified(path.join(located.mediaDir, t.name), before);
      targets.push({
        name: t.name,
        source: t.source,
        stagedHash: sha256File(staged),
        beforeHash: sha256File(before),
        committed: false,
      });
    }
    const tx: TxRecord = {
      schemaVersion: 1,
      state: 'committing',
      packId: pack.id,
      packName: pack.name,
      mediaDir: located.mediaDir,
      stagingDir,
      fingerprintVersion: located.fingerprint.version,
      targets,
      createdAt: new Date().toISOString(),
    };
    atomicWriteFile(txPath(located.mediaDir), JSON.stringify(tx, null, 2));
    try {
      for (const t of targets) {
        replaceFileViaTmp(path.join(stageDir, t.name), path.join(located.mediaDir, t.name));
        t.committed = true;
        atomicWriteFile(txPath(located.mediaDir), JSON.stringify(tx, null, 2));
      }
      for (const t of targets) {
        if (sha256File(path.join(located.mediaDir, t.name)) !== t.stagedHash) {
          throw new Error('apply.verifyFailed');
        }
      }
    } catch (e) {
      const rb = rollbackTx(tx);
      if (!rb.ok) {
        return rb;
      }
      return { ok: false, error: msg('apply.rolledBack', (e as Error).message) };
    }

    writeMarker(located.mediaDir, {
      packId: pack.id,
      at: Date.now(),
      version: located.fingerprint.version,
    });
    fs.rmSync(txPath(located.mediaDir), { force: true });
    fs.rmSync(stagingDir, { recursive: true, force: true });
    if (extensionDir !== undefined) {
      writeUninstallSnapshot(extensionDir, backupDir);
    }

    const state = loadState(storageDir);
    state.applied = {
      packId: pack.id,
      packName: pack.name,
      fingerprint: located.fingerprint,
      versionDir: located.versionDir,
      mediaDir: located.mediaDir,
      installRoot: located.installRoot,
      files: Object.fromEntries(targets.map((t) => [t.name, t.stagedHash])),
      appliedAt: new Date().toISOString(),
    };
    state.activePackId = pack.id;
    saveState(storageDir, state);

    const warnings: VirMessage[] = [];
    for (const key of Object.keys(pack.slots)) {
      warnings.push(...pack.slots[key].warnings);
    }
    return {
      ok: true,
      report: {
        replaced: targets.filter((t) => t.source === 'pack').map((t) => t.name),
        baseline: targets.filter((t) => t.source === 'baseline').map((t) => t.name),
        warnings,
        disabled: pack.disabled,
      },
    };
  } finally {
    releaseLock(storageDir, owner);
  }
}
