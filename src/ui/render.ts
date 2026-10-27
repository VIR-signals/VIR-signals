// UI rendering: engine message keys become localized sentences here, and
// nothing else in the UI writes sentences. Language selection is our own
// runtime bundle pick, not the platform l10n cache.
import * as vscode from 'vscode';
import { VirMessage } from '../engine/msg';
import { HopAttempt } from '../engine/net-fetch';
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

// Per-source failure lines for error notices: up to six attempt reasons
// ride along, falling back to the error itself when no attempt exists.
export function attemptsText(failed: {
  error: VirMessage;
  attempts: ReadonlyArray<HopAttempt>;
}): string {
  const lines = failed.attempts.slice(0, 6).map((a) => render(a.detail));
  return lines.length > 0 ? lines.join('\n') : render(failed.error);
}

// One sentence per convergence direction, shown after the switch command and
// by activation convergence alike.
export function convergeNote(expected: ExpectedState): string {
  return expected.kind === 'native'
    ? `${t('ui.switch.restoredNative')} ${t('ui.apply.restartHint')}`
    : `${t('ui.switch.reapplied', expected.packId)} ${t('ui.apply.restartHint')}`;
}
