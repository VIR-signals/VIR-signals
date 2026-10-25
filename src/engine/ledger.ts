// Extension state ledger: one JSON file in the platform storage directory.
// Missing file means first run; a corrupt file is a loud failure, never a
// quiet rebuild.
import * as path from 'node:path';
import * as fs from 'node:fs';
import { STATE_NAME } from './paths';
import { atomicWriteFile } from './fsutil';
import { Fingerprint } from './locate';

export interface AppliedState {
  packId: string;
  packName: string;
  fingerprint: Fingerprint;
  versionDir: string;
  mediaDir: string;
  installRoot: string;
  files: Record<string, string>;
  appliedAt: string;
}

export interface VirState {
  schemaVersion: 1;
  firstRunDone: boolean;
  firstRunChoice: string;
  activePackId: string;
  applied: AppliedState | null;
  signalToggles: Record<string, unknown>;
}

export function statePath(storageDir: string): string {
  return path.join(storageDir, STATE_NAME);
}

export function freshState(): VirState {
  return {
    schemaVersion: 1,
    firstRunDone: false,
    firstRunChoice: '',
    activePackId: '',
    applied: null,
    signalToggles: {},
  };
}

export function loadState(storageDir: string): VirState {
  const p = statePath(storageDir);
  if (!fs.existsSync(p)) {
    return freshState();
  }
  const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as VirState;
  if (raw.schemaVersion !== 1) {
    throw new Error('state.schemaUnknown');
  }
  return raw;
}

export function saveState(storageDir: string, state: VirState): void {
  fs.mkdirSync(storageDir, { recursive: true });
  atomicWriteFile(statePath(storageDir), JSON.stringify(state, null, 2));
}
