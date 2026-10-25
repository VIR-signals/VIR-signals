// Extension entry: registers the command face, then runs the activation
// pass: environment check, crash transaction notice, weekly update
// relayout, and the one time first run notification.
import * as vscode from 'vscode';
import { render, t } from './render';
import { VirUiContext } from './extension-context';
import { registerCommands } from './commands';
import { locate } from '../engine/locate';
import { readPendingTx } from '../engine/replace';
import { checkVersionDrift, relayoutAfterUpdate } from '../engine/relayout';
import { loadState, saveState } from '../engine/ledger';
import { backupDirFor, snapshotState, writeUninstallSnapshot } from '../engine/backup';
import { findPackById } from '../engine/pack-reader';
import { packsDirFor } from '../engine/paths';
import { coveredSettingKeysOfPack, enableCoveredSignals } from './settings';

function unsupportedEnv(): boolean {
  return vscode.env.uiKind === vscode.UIKind.Web;
}

async function firstRunFlow(ctx: VirUiContext): Promise<string[]> {
  const notes: string[] = [];
  const state = loadState(ctx.storageDir);
  if (state.firstRunDone) {
    return notes;
  }
  const enableAll = t('ui.firstRun.enableAll');
  const openSettings = t('ui.firstRun.openSettings');
  const pick = await vscode.window.showInformationMessage(
    t('ui.firstRun.message'),
    enableAll,
    openSettings
  );
  if (pick === enableAll) {
    const pack = findPackById(packsDirFor(ctx.storageDir), activePackId());
    if (!pack) {
      notes.push(t('ui.enableAll.noPack'));
    } else {
      const n = await enableCoveredSignals(ctx.storageDir, coveredSettingKeysOfPack(pack));
      notes.push(t('ui.enableAll.done', n));
    }
    state.firstRunChoice = 'enableAll';
  } else if (pick === openSettings) {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'accessibility.signals');
    state.firstRunChoice = 'openSettings';
  } else {
    state.firstRunChoice = 'dismissed';
  }
  state.firstRunDone = true;
  saveState(ctx.storageDir, state);
  return notes;
}

function activePackId(): string {
  return vscode.workspace.getConfiguration().get<string>('vir.activePack') ?? '';
}

function manualInstallPath(): string {
  return vscode.workspace.getConfiguration().get<string>('vir.editorInstallPath') ?? '';
}

async function activationPass(ctx: VirUiContext): Promise<void> {
  const notes: string[] = [];
  const located = locate(vscode.env.appRoot, manualInstallPath());
  if (located.ok) {
    if (readPendingTx(located.located.mediaDir) !== undefined) {
      notes.push(t('ui.status.recoveryPending'));
    }
    const drift = checkVersionDrift(located.located, ctx.storageDir);
    if (drift.relayoutNeeded && drift.reason) {
      const r = relayoutAfterUpdate(located.located, ctx.storageDir, ctx.owner, ctx.extensionDir);
      if (r.ok) {
        const parts = [render(drift.reason), t('ui.apply.restartHint')];
        if (r.report.newFiles.length > 0) {
          parts.push(`${t('ui.relayout.newFiles')}: ${r.report.newFiles.join(', ')}`);
        }
        if (r.report.vanishedFiles.length > 0) {
          parts.push(`${t('ui.relayout.vanishedFiles')}: ${r.report.vanishedFiles.join(', ')}`);
        }
        notes.push(parts.join(' '));
      } else {
        notes.push(render(r.error));
      }
    }
    const state = loadState(ctx.storageDir);
    if (state.applied && snapshotState(ctx.extensionDir) !== 'ok') {
      try {
        writeUninstallSnapshot(
          ctx.extensionDir,
          backupDirFor(ctx.storageDir, state.applied.fingerprint)
        );
      } catch (e) {
        notes.push(String((e as Error).message));
      }
    }
  } else {
    notes.push(render(located.error));
  }
  const firstRunNotes = await firstRunFlow(ctx);
  notes.push(...firstRunNotes);
  if (notes.length > 0) {
    await vscode.window.showWarningMessage(notes.join('\n'));
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const ctx: VirUiContext = {
    storageDir: context.globalStorageUri.fsPath,
    extensionDir: context.extensionUri.fsPath,
    owner: vscode.env.sessionId,
  };
  if (unsupportedEnv()) {
    void vscode.window.showWarningMessage(t('ui.env.notSupported'));
    return;
  }
  for (const d of registerCommands(ctx)) {
    context.subscriptions.push(d);
  }
  void activationPass(ctx).then(undefined, (e: unknown) => {
    void vscode.window.showErrorMessage(String((e as Error).message ?? e));
  });
}
