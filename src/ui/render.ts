// UI rendering: engine message keys become localized sentences here, and
// nothing else in the UI writes sentences. Language selection is our own
// runtime bundle pick, not the platform l10n cache.
import * as vscode from 'vscode';
import { VirMessage } from '../engine/msg';
import { ExpectedState } from '../engine/ledger';
import { Bundle, bundleDirFrom, bundleFileNameFor, loadBundle, lookup } from './localize';

let currentLanguage = '';
let currentBundle: Bundle = {};

function bundle(): Bundle {
  if (currentLanguage !== vscode.env.language) {
    currentLanguage = vscode.env.language;
    currentBundle = loadBundle(bundleDirFrom(__dirname), bundleFileNameFor(currentLanguage));
  }
  return currentBundle;
}

export function t(key: string, ...args: Array<string | number>): string {
  return lookup(bundle(), key, args.map(String));
}

export function render(m: VirMessage): string {
  return t(m.key, ...m.args);
}

export function renderAll(ms: ReadonlyArray<VirMessage>): string[] {
  return ms.map(render);
}

// One sentence per convergence direction, shown after the switch command and
// by activation convergence alike.
export function convergeNote(expected: ExpectedState): string {
  return expected.kind === 'native'
    ? `${t('ui.switch.restoredNative')} ${t('ui.apply.restartHint')}`
    : `${t('ui.switch.reapplied', expected.packId)} ${t('ui.apply.restartHint')}`;
}
