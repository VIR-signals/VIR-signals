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
  enabled: boolean;
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

// What should be on disk, the single truth the switch convergence serves:
// a disabled switch or no selected pack means the official files; a selected
// pack rules only while the switch is on. Pure so it stays offline testable.
export type ExpectedState = { kind: 'native' } | { kind: 'pack'; packId: string };

export function expectedState(enabled: boolean, activePackId: string): ExpectedState {
  if (!enabled || activePackId === '') {
    return { kind: 'native' };
  }
  return { kind: 'pack', packId: activePackId };
}

export function freshState(): VirState {
  return {
    schemaVersion: 1,
    enabled: true,
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
    enabled: raw.enabled === false ? false : true,
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
