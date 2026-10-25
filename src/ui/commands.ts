// Command handlers for the ten contributed commands plus the status bar
// bell. Handlers are thin: validate, call the engine, render message keys.
import * as vscode from 'vscode';
import { render, t } from './render';
import { VirUiContext } from './extension-context';
import { locate, Located } from '../engine/locate';
import { scanPacks, findPackById, PackInfo, ScannedPack } from '../engine/pack-reader';
import { applyPack, readPendingTx } from '../engine/replace';
import { restoreOfficial } from '../engine/restore';
import { checkVersionDrift } from '../engine/relayout';
import { backupDirFor, deleteBackup, verifyBackup } from '../engine/backup';
import { loadState, saveState } from '../engine/ledger';
import { packsDirFor } from '../engine/paths';
import { ensureDir } from '../engine/fsutil';
import { SLOTS, affectedEventsForSlots, fileOwnerSlot } from '../engine/slot-table';
import { findCalibrationPack, worksheetRows } from '../engine/calibrate';
import { coveredSlotsOfPack, effectiveSound, restoreSignalToggles } from './settings';

const SIGNAL_QUERY = 'accessibility.signals';
const SIGNAL_KEY_PREFIX = 'accessibility.signals.';

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration();
}

function manualInstallPath(): string {
  return cfg().get<string>('vir.editorInstallPath') ?? '';
}

function activePackId(): string {
  return cfg().get<string>('vir.activePack') ?? '';
}

async function setActivePack(ctx: VirUiContext, id: string): Promise<void> {
  await cfg().update('vir.activePack', id, vscode.ConfigurationTarget.Global);
  const state = loadState(ctx.storageDir);
  state.activePackId = id;
  saveState(ctx.storageDir, state);
}

async function locateOrShow(): Promise<Located | undefined> {
  const r = locate(vscode.env.appRoot, manualInstallPath());
  if (!r.ok) {
    await vscode.window.showErrorMessage(render(r.error));
    return undefined;
  }
  return r.located;
}

function splitScan(scanned: ScannedPack[]): { good: PackInfo[]; badLines: string[] } {
  const good: PackInfo[] = [];
  const badLines: string[] = [];
  for (const s of scanned) {
    if (s.result.ok) {
      good.push(s.result.pack);
    } else {
      badLines.push(`${s.folderName}: ${render(s.result.error)}`);
    }
  }
  return { good, badLines };
}

function switchWord(state: string): string {
  return t(`ui.switch.${state}`);
}

async function openMarkdown(title: string, lines: string[]): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({
    content: [title, '', ...lines].join('\n'),
    language: 'markdown',
  });
  await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
}

async function cmdOpenPacksFolder(ctx: VirUiContext): Promise<void> {
  const dir = packsDirFor(ctx.storageDir);
  ensureDir(dir);
  await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(dir));
  await vscode.window.showInformationMessage(t('ui.packsFolder.opened', dir));
}

async function cmdRescan(ctx: VirUiContext): Promise<void> {
  const { good, badLines } = splitScan(scanPacks(packsDirFor(ctx.storageDir)));
  const head = t('ui.rescan.result', good.length, badLines.length);
  if (badLines.length === 0) {
    await vscode.window.showInformationMessage(head);
    return;
  }
  await vscode.window.showWarningMessage(`${head}\n${badLines.join('\n')}`);
}

async function cmdSelectPack(ctx: VirUiContext, statusBar: vscode.StatusBarItem): Promise<void> {
  const packs = splitScan(scanPacks(packsDirFor(ctx.storageDir))).good;
  const items: Array<{ label: string; description?: string; detail?: string; id: string }> = [];
  for (const pack of packs) {
    const slots = coveredSlotsOfPack(pack);
    const events = affectedEventsForSlots(slots).length;
    items.push({
      label: pack.name,
      description: pack.id,
      detail: `${slots.length}/28 - ${events}`,
      id: pack.id,
    });
  }
  items.push({ label: t('ui.select.none'), id: '' });
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: t('ui.select.placeholder'),
  });
  if (pick === undefined) {
    return;
  }
  await setActivePack(ctx, pick.id);
  const note = pick.id === '' ? t('ui.select.cleared') : t('ui.select.applied', pick.id);
  await vscode.window.showInformationMessage(note);
  refreshStatusBar(statusBar);
}

async function cmdApply(ctx: VirUiContext, statusBar: vscode.StatusBarItem): Promise<void> {
  if (cfg().get<boolean>('vir.enabled', true) === false) {
    await vscode.window.showInformationMessage(t('ui.disabled'));
    return;
  }
  const packId = activePackId();
  if (packId === '') {
    await vscode.window.showErrorMessage(t('ui.apply.noPack'));
    return;
  }
  const pack = findPackById(packsDirFor(ctx.storageDir), packId);
  if (!pack) {
    await vscode.window.showErrorMessage(t('ui.apply.packMissing', packId));
    return;
  }
  const located = await locateOrShow();
  if (!located) {
    return;
  }
  const r = applyPack(located, pack, ctx.storageDir, ctx.owner);
  if (!r.ok) {
    await vscode.window.showErrorMessage(render(r.error));
    return;
  }
  refreshStatusBar(statusBar);
  const extra = [
    ...r.report.warnings.map(render),
    ...Object.keys(r.report.disabled).map((k) => `${k}: ${render(r.report.disabled[k])}`),
  ];
  const body = `${t('ui.apply.done', pack.name, r.report.replaced.length, r.report.baseline.length)} ${t('ui.apply.restartHint')}`;
  if (extra.length > 0) {
    await vscode.window.showWarningMessage(`${body}\n${extra.join('\n')}`);
  } else {
    await vscode.window.showInformationMessage(body);
  }
}

async function cmdRestoreSounds(ctx: VirUiContext, statusBar: vscode.StatusBarItem): Promise<void> {
  const located = await locateOrShow();
  if (!located) {
    return;
  }
  const r = restoreOfficial(located, ctx.storageDir, ctx.owner);
  if (!r.ok) {
    await vscode.window.showErrorMessage(render(r.error));
    return;
  }
  refreshStatusBar(statusBar);
  await vscode.window.showInformationMessage(t('ui.restore.done', r.fileCount));
}

async function cmdOpenSignalSettings(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.openSettings', SIGNAL_QUERY);
}

async function cmdRestoreToggles(ctx: VirUiContext): Promise<void> {
  const n = await restoreSignalToggles(ctx.storageDir);
  if (n > 0) {
    await vscode.window.showInformationMessage(t('ui.togglesRestored.done', n));
  } else {
    await vscode.window.showInformationMessage(t('ui.togglesRestored.none'));
  }
}

async function cmdDeleteBackup(ctx: VirUiContext): Promise<void> {
  const yes = t('ui.deleteBackup.confirmYes');
  const pick = await vscode.window.showWarningMessage(
    t('ui.deleteBackup.confirmTitle'),
    { modal: true, detail: t('ui.deleteBackup.confirmBody') },
    yes
  );
  if (pick !== yes) {
    await vscode.window.showInformationMessage(t('ui.common.canceled'));
    return;
  }
  deleteBackup(ctx.storageDir);
  await vscode.window.showInformationMessage(t('ui.deleteBackup.done'));
}

async function cmdStatus(ctx: VirUiContext): Promise<void> {
  const state = loadState(ctx.storageDir);
  const lines: string[] = [];
  const packId = activePackId();
  lines.push(packId ? t('ui.status.pack', packId) : t('ui.status.packNone'));
  if (state.applied) {
    lines.push(
      t(
        'ui.status.applied',
        state.applied.packName,
        state.applied.appliedAt,
        state.applied.fingerprint.version
      )
    );
  } else {
    lines.push(t('ui.status.notApplied'));
  }

  const located = locate(vscode.env.appRoot, manualInstallPath());
  const locatedOk = located.ok ? located.located : undefined;
  const fp = state.applied ? state.applied.fingerprint : locatedOk?.fingerprint;
  if (fp) {
    const vb = verifyBackup(backupDirFor(ctx.storageDir, fp));
    lines.push(
      vb.ok
        ? t('ui.status.backup', Object.keys(vb.manifest.files).length, vb.manifest.fingerprint.version)
        : t('ui.status.backupNone')
    );
  } else {
    lines.push(t('ui.status.backupNone'));
  }

  if (state.applied) {
    const slotNames = new Set(
      Object.keys(state.applied.files)
        .map((f) => fileOwnerSlot(f)?.slot)
        .filter((s): s is string => s !== undefined)
    );
    const events = affectedEventsForSlots([...slotNames]).length;
    lines.push(t('ui.status.coverage', slotNames.size, SLOTS.length, events));
  } else {
    lines.push(t('ui.status.coverage', 0, SLOTS.length, 0));
  }

  lines.push(t('ui.status.switches'));
  for (const entry of SLOTS) {
    for (const key of entry.settingKeys) {
      lines.push(`- ${key}: ${switchWord(effectiveSound(key))}`);
    }
  }

  if (locatedOk && readPendingTx(locatedOk.mediaDir) !== undefined) {
    lines.push(t('ui.status.recoveryPending'));
  }
  if (locatedOk) {
    const drift = checkVersionDrift(locatedOk, ctx.storageDir);
    if (drift.reason) {
      lines.push(render(drift.reason));
    }
  } else if (!located.ok) {
    lines.push(render(located.error));
  }
  await openMarkdown(t('ui.status.title'), lines);
}

async function cmdIdentify(ctx: VirUiContext): Promise<void> {
  const calib = findCalibrationPack(scanPacks(packsDirFor(ctx.storageDir)));
  if (!calib) {
    await vscode.window.showErrorMessage(t('ui.identify.needCalibPack'));
    return;
  }
  const located = await locateOrShow();
  if (!located) {
    return;
  }
  const r = applyPack(located, calib, ctx.storageDir, ctx.owner);
  if (!r.ok) {
    await vscode.window.showErrorMessage(render(r.error));
    return;
  }
  await vscode.window.showInformationMessage(
    `${t('ui.identify.applied')} ${t('ui.apply.restartHint')}`
  );
  const lines: string[] = [t('ui.worksheet.hint'), ''];
  lines.push(
    `| ${t('ui.worksheet.colSlot')} | ${t('ui.worksheet.colEvents')} | ${t('ui.worksheet.colSettingKeys')} | ${t('ui.worksheet.colHeard')} |`
  );
  lines.push('| --- | --- | --- | --- |');
  for (const row of worksheetRows()) {
    const keys = row.settingKeys.map((k) => k.slice(SIGNAL_KEY_PREFIX.length)).join(', ');
    lines.push(`| ${row.slot} | ${row.events.join(', ')} | ${keys} | |`);
  }
  await openMarkdown(t('ui.worksheet.title'), lines);
}

export function refreshStatusBar(item: vscode.StatusBarItem): void {
  const packId = activePackId();
  item.text = packId ? `$(bell) ${packId.slice(0, 14)}` : '$(bell)';
}

export function registerCommands(ctx: VirUiContext): Array<vscode.Disposable> {
  const subs: Array<vscode.Disposable> = [];
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'vir.selectPack';
  statusBar.tooltip = t('ui.statusbar.tooltip');
  refreshStatusBar(statusBar);
  statusBar.show();
  subs.push(statusBar);

  const reg = (id: string, run: () => Promise<void>) => {
    subs.push(
      vscode.commands.registerCommand(id, () =>
        run().then(undefined, (e: unknown) => {
          void vscode.window.showErrorMessage(String((e as Error).message ?? e));
        })
      )
    );
  };
  reg('vir.openPacksFolder', () => cmdOpenPacksFolder(ctx));
  reg('vir.rescan', () => cmdRescan(ctx));
  reg('vir.selectPack', () => cmdSelectPack(ctx, statusBar));
  reg('vir.apply', () => cmdApply(ctx, statusBar));
  reg('vir.restoreSounds', () => cmdRestoreSounds(ctx, statusBar));
  reg('vir.openSignalSettings', () => cmdOpenSignalSettings());
  reg('vir.restoreToggles', () => cmdRestoreToggles(ctx));
  reg('vir.status', () => cmdStatus(ctx));
  reg('vir.deleteBackup', () => cmdDeleteBackup(ctx));
  reg('vir.identify', () => cmdIdentify(ctx));
  return subs;
}
