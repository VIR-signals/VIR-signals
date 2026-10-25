// Signal switch handling: which accessibility signal settings the active
// pack covers, switching them on while remembering the previous global
// values, and putting them back on request.
import * as vscode from 'vscode';
import { loadState, saveState } from '../engine/ledger';
import { settingKeysForSlots } from '../engine/slot-table';
import { PackInfo } from '../engine/pack-reader';

export interface SignalValue {
  sound?: unknown;
  announcement?: unknown;
}

// Slot names a pack actually covers with usable audio.
export function coveredSlotsOfPack(pack: PackInfo): string[] {
  const names = new Set<string>();
  for (const audio of Object.values(pack.slots)) {
    names.add(audio.slot);
  }
  return [...names];
}

export function coveredSettingKeysOfPack(pack: PackInfo): string[] {
  return settingKeysForSlots(coveredSlotsOfPack(pack));
}

export function readGlobalSignal(key: string): SignalValue | undefined {
  const inspection = vscode.workspace.getConfiguration().inspect<SignalValue>(key);
  return inspection?.globalValue;
}

export type SoundState = 'on' | 'off' | 'auto' | 'unset';

export function effectiveSound(key: string): SoundState {
  const v = vscode.workspace.getConfiguration().get<SignalValue>(key);
  const sound = v && typeof v === 'object' ? v.sound : undefined;
  if (sound === 'on' || sound === 'off' || sound === 'auto') {
    return sound;
  }
  return 'unset';
}

// Switch every covered setting on at the global level, recording the prior
// global value of each key exactly once.
export async function enableCoveredSignals(
  storageDir: string,
  keys: string[]
): Promise<number> {
  const cfg = vscode.workspace.getConfiguration();
  const state = loadState(storageDir);
  for (const key of keys) {
    if (!(key in state.signalToggles)) {
      const before = readGlobalSignal(key);
      state.signalToggles[key] = before === undefined ? null : before;
    }
    const cur = cfg.get<SignalValue>(key);
    const next: SignalValue = cur && typeof cur === 'object' ? { ...cur } : {};
    next.sound = 'on';
    await cfg.update(key, next, vscode.ConfigurationTarget.Global);
  }
  saveState(storageDir, state);
  return keys.length;
}

// Put back every recorded value; a null record means the key had no global
// override before, so the override is removed.
export async function restoreSignalToggles(storageDir: string): Promise<number> {
  const cfg = vscode.workspace.getConfiguration();
  const state = loadState(storageDir);
  const keys = Object.keys(state.signalToggles);
  for (const key of keys) {
    const recorded = state.signalToggles[key];
    await cfg.update(
      key,
      recorded === null ? undefined : recorded,
      vscode.ConfigurationTarget.Global
    );
  }
  state.signalToggles = {};
  saveState(storageDir, state);
  return keys.length;
}
