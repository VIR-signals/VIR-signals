// Extension entry: registers the command face, then runs the activation
// pass: environment check, demo seeding, crash transaction notice, weekly
// update relayout, and the two stage first run flow.
import * as vscode from 'vscode';
import { render, t } from './render';
import { staleVerdict } from './localize';
import { VirUiContext } from './extension-context';
import { registerCommands } from './commands';
import { locate } from '../engine/locate';
import { checkPlatform, defaultProbes } from '../engine/platform-gate';
import { readPendingTx } from '../engine/replace';
import { checkVersionDrift, relayoutAfterUpdate } from '../engine/relayout';
import { loadState, saveState } from '../engine/ledger';
import { backupDirFor, ensureBackup, snapshotState, writeUninstallSnapshot } from '../engine/backup';
import { claimGuide } from './guide';
import { seedDemoPack } from './demo-seed';

function unsupportedEnv(): boolean {
  return vscode.env.uiKind === vscode.UIKind.Web;
}

// Stage one lands right after install: the backup already ran above, and
// the claiming window demands one reload so the platform nls picks up the
// user language. Zero pack guidance here. Other windows stay silent; each
// of them gets its own reload hint through nlsReloadOffer.
async function firstRunStageOne(ctx: VirUiContext): Promise<boolean> {
  const state = loadState(ctx.storageDir);
  if (state.stageOneDone) {
    return false;
  }
  if (!claimGuide(ctx.storageDir, ctx.owner, 'one')) {
    return false;
  }
  state.stageOneDone = true;
  state.stageOneOwner = ctx.owner;
  saveState(ctx.storageDir, state);
  const reload = t('ui.nls.reloadNow');
  const pick = await vscode.window.showInformationMessage(t('ui.stageOne.message'), reload);
  if (pick === reload) {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
  return true;
}

// Stage two runs on the first activation in a NEW session: the stage one
// window reloaded (or a fresh window opened), so the interface now speaks
// the user language and the pack question may appear. Claim guarded so
// only one window asks; dismissing counts as done, the standing commands
// always lead back in.
async function firstRunStageTwo(ctx: VirUiContext): Promise<void> {
  const state = loadState(ctx.storageDir);
  if (!state.stageOneDone || state.stageTwoDone) {
    return;
  }
  if (ctx.owner === state.stageOneOwner) {
    return;
  }
  if (!claimGuide(ctx.storageDir, ctx.owner, 'two')) {
    return;
  }
  state.stageTwoDone = true;
  saveState(ctx.storageDir, state);
  const pickPack = t('ui.firstRun.pickPack');
  const openPacks = t('ui.firstRun.openPacksFolder');
  const pick = await vscode.window.showInformationMessage(
    t('ui.firstRun.message'),
    pickPack,
    openPacks
  );
  if (pick === pickPack) {
    await vscode.commands.executeCommand('vir.selectPack');
  } else if (pick === openPacks) {
    await vscode.commands.executeCommand('vir.openPacksFolder');
  }
}

function manualInstallPath(): string {
  return vscode.workspace.getConfiguration().get<string>('vir.editorInstallPath') ?? '';
}

async function activationPass(ctx: VirUiContext): Promise<void> {
  const notes: string[] = [];
  let pendingTx = false;
  const located = locate(vscode.env.appRoot, manualInstallPath());
  // The platform gate runs before anything touches the editor directory:
  // unsupported positions get the explicit reason and zero writes.
  let writable = false;
  if (located.ok) {
    const gate = checkPlatform(located.located, defaultProbes());
    if (gate.ok) {
      writable = true;
    } else {
      notes.push(render(gate.error));
    }
  } else {
    notes.push(render(located.error));
  }
  if (located.ok && writable) {
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
  }
  const seedNote = seedDemoPack(ctx);
  if (seedNote) {
    notes.push(render(seedNote));
  }
  // Stage one comes first and is itself the reload demand, so the generic
  // reload hint must not stack on top of it in the claiming window. Every
  // other window falls through to the hint below, each window for itself.
  const stageOneShown = await firstRunStageOne(ctx);
  if (!stageOneShown) {
    await firstRunStageTwo(ctx);
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
// and offer the shortest path: one click reload. A platform that has no
// translation at all (raw key back) is never treated as stale, and the
// offer fires at most once per window session, so it cannot nag in a loop.
let nlsOfferShownThisSession = false;

function platformNlsStale(): boolean {
  const probe = 'ui.firstRun.message';
  return staleVerdict(vscode.l10n.t(probe), t(probe), probe);
}

async function nlsReloadOffer(): Promise<void> {
  if (nlsOfferShownThisSession || !platformNlsStale()) {
    return;
  }
  nlsOfferShownThisSession = true;
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
