// Master switch convergence: bring the install site to the expected state.
// Every mutation reuses the existing restoreOfficial / applyPack paths, both
// already under the cross window lock. Before any write the site is checked
// against the expectation, so an already converged site costs zero writes —
// the second window reacting to the same setting change does nothing but
// read. A lock held by another window is waited out, never treated as an
// error: serializing the two windows is the whole point.
import { Located } from './locate';
import { ExpectedState, loadState } from './ledger';
import { readMarker } from './backup';
import { restoreOfficial } from './restore';
import { applyPack } from './replace';
import { findPackById, PackInfo } from './pack-reader';
import { packsDirFor } from './paths';
import { VirMessage } from './msg';

const LOCK_RETRY_DELAY_MS = 250;
const LOCK_RETRY_LIMIT = 40;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Pure read of the ledger plus the on site marker: is the install already in
// the expected state? The applied record is written only after the files and
// the marker are final, so seeing the converged shape means it truly is.
export function alreadyConverged(
  expected: ExpectedState,
  storageDir: string,
  located: Located
): boolean {
  const applied = loadState(storageDir).applied;
  if (expected.kind === 'native') {
    return applied === null && readMarker(located.mediaDir) === undefined;
  }
  return (
    applied !== null &&
    applied.packId === expected.packId &&
    applied.fingerprint.version === located.fingerprint.version &&
    applied.fingerprint.commit === located.fingerprint.commit &&
    readMarker(located.mediaDir) !== undefined
  );
}

export type ConvergeOutcome =
  | { ok: true; action: 'restored' | 'reapplied' | 'none' }
  | { ok: false; error: VirMessage };

export async function convergeToExpected(
  located: Located,
  storageDir: string,
  owner: string,
  extensionDir: string | undefined,
  expected: ExpectedState
): Promise<ConvergeOutcome> {
  let pack: PackInfo | undefined;
  if (expected.kind === 'pack') {
    pack = findPackById(packsDirFor(storageDir), expected.packId);
    if (!pack) {
      return { ok: false, error: { key: 'relayout.packMissing', args: [expected.packId] } };
    }
  }
  for (let attempt = 0; ; attempt++) {
    // Re-checked every round: once the other window finishes, this one sees
    // the converged shape and returns without a single write.
    if (alreadyConverged(expected, storageDir, located)) {
      return { ok: true, action: 'none' };
    }
    let error: VirMessage;
    if (expected.kind === 'native') {
      const r = restoreOfficial(located, storageDir, owner);
      if (r.ok) {
        return { ok: true, action: 'restored' };
      }
      error = r.error;
    } else {
      const r = applyPack(located, pack as PackInfo, storageDir, owner, extensionDir);
      if (r.ok) {
        return { ok: true, action: 'reapplied' };
      }
      error = r.error;
    }
    if (error.key !== 'lock.busy' || attempt >= LOCK_RETRY_LIMIT) {
      return { ok: false, error };
    }
    await sleep(LOCK_RETRY_DELAY_MS);
  }
}
