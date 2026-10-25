// UI rendering: engine message keys become localized sentences here, and
// nothing else in the UI writes sentences.
import * as vscode from 'vscode';
import { VirMessage } from '../engine/msg';

export function t(key: string, ...args: Array<string | number>): string {
  return vscode.l10n.t(key, ...args.map(String));
}

export function render(m: VirMessage): string {
  return t(m.key, ...m.args);
}

export function renderAll(ms: ReadonlyArray<VirMessage>): string[] {
  return ms.map(render);
}
