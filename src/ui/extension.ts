// Extension entry: registers the command face, then runs the activation
// pass: environment check, crash transaction notice, weekly update
// relayout, and the one time first run notification.
import * as vscode from 'vscode';
import { render, t } from './render';
import { VirUiContext } from './extension-context';
import { registerCommands, runEnableAllSignals } from './commands';
import { locate } from '../engine/locate';
import { readPendingTx } from '../engine/replace';
import { checkVersionDrift, relayoutAfterUpdate } from '../engine/relayout';
import { loadState, saveState } from '../engine/ledger';
import { backupDirFor, ensureBackup, snapshotState, writeUninstallSnapshot } from '../engine/backup';

function unsupportedEnv(): boolean {
  return vscode.env.uiKind === vscode.UIKind.Web;
}

async function firstRunFlow(ctx: VirUiContext): Promise<{ notes: string[]; asked: boolean }> {
  const notes: string[] = [];
  const state = loadState(ctx.storageDir);
  if (state.firstRunDone) {
    return { notes, asked: false };
  }
  const enableAll = t('ui.firstRun.enableAll');
  const openSettings = t('ui.firstRun.openSettings');
  const pick = await vscode.window.showInformationMessage(
    t('ui.firstRun.message'),
    enableAll,
    openSettings
  );
  if (pick === enableAll) {
    notes.push(...(await runEnableAllSignals(ctx)));
    state.firstRunChoice = 'enableAll';
  } else if (pick === openSettings) {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'accessibility.signals');
    state.firstRunChoice = 'openSettings';
  } else {
    state.firstRunChoice = 'dismissed';
  }
  state.firstRunDone = true;
  saveState(ctx.storageDir, state);
  return { notes, asked: true };
}

function manualInstallPath(): string {
  return vscode.workspace.getConfiguration().get<string>('vir.editorInstallPath') ?? '';
}

async function activationPass(ctx: VirUiContext): Promise<void> {
  const notes: string[] = [];
  let pendingTx = false;
  const located = locate(vscode.env.appRoot, manualInstallPath());
  if (located.ok) {
    const ensured = ensureBackup(located.located, ctx.storageDir, ctx.owner);
    if (!ensured.ok && ensured.error.key !== 'lock.busy') {
      notes.push(render(ensured.error));
    }
    if (readPendingTx(located.located.mediaDir) !== undefined) {
      pendingTx = true;
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
  // One activation may raise at most one toast: the reload offer would only
  // stack on top of the first-run question (both clear after the same single
  // reload), and warning notes merge with the pending-transaction line so the
  // restore button rides on a single notification.
  const firstRun = await firstRunFlow(ctx);
  notes.push(...firstRun.notes);
  if (!firstRun.asked) {
    await nlsReloadOffer();
  }
  if (notes.length > 0 || pendingTx) {
    const lines = [...notes];
    if (pendingTx) {
      lines.push(t('ui.recovery.pendingShort'));
    }
    const restoreNow = t('ui.recovery.restoreNow');
    const pick = await vscode.window.showWarningMessage(
      lines.join('\n'),
      ...(pendingTx ? [restoreNow] : [])
    );
    if (pick === restoreNow) {
      await vscode.commands.executeCommand('vir.restoreSounds');
    }
  }
}

// Mid session installs get served the default language bundle by the still
// running extension host: command titles and the platform l10n stay English
// until one host reload. Detect the mismatch through our own runtime bundle
// and offer the shortest path: one click reload.
function platformNlsStale(): boolean {
  const probe = 'ui.firstRun.message';
  return vscode.l10n.t(probe) !== t(probe);
}

async function nlsReloadOffer(): Promise<void> {
  if (!platformNlsStale()) {
    return;
  }
  const now = t('ui.nls.reloadNow');
  const pick = await vscode.window.showInformationMessage(t('ui.nls.reloadHint'), now);
  if (pick === now) {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
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
