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
  stageOneDone: boolean;
  stageOneOwner: string;
  stageTwoDone: boolean;
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
    stageOneDone: false,
    stageOneOwner: '',
    stageTwoDone: false,
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
  const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<VirState>;
  if (raw.schemaVersion !== 1) {
    throw new Error('state.schemaUnknown');
  }
  // Fields from earlier builds are dropped, never interpreted: the known
  // fields are the whole state.
  return {
    schemaVersion: 1,
    stageOneDone: raw.stageOneDone === true,
    stageOneOwner: typeof raw.stageOneOwner === 'string' ? raw.stageOneOwner : '',
    stageTwoDone: raw.stageTwoDone === true,
    activePackId: typeof raw.activePackId === 'string' ? raw.activePackId : '',
    applied: raw.applied ?? null,
    signalToggles:
      raw.signalToggles && typeof raw.signalToggles === 'object' ? raw.signalToggles : {},
  };
}

export function saveState(storageDir: string, state: VirState): void {
  fs.mkdirSync(storageDir, { recursive: true });
  atomicWriteFile(statePath(storageDir), JSON.stringify(state, null, 2));
}
