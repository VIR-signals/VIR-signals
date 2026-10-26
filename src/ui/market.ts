// Market panel (spec 4.2): the pack picker in index form. Local packs and
// registry entries share one list, a standing direct install entry sits on
// top, registry picks open a three action follow up (preview, install or
// update, cancel), and the audition player is a webview that deletes its
// temp file the moment the panel closes. The engine stays vscode free;
// every sentence lives in the language bundles.
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { render, t } from './render';
import { VirUiContext } from './extension-context';
import { localPackListing } from './pack-source';
import { PackInfo, compareVersion, findPackById, parseVersion } from '../engine/pack-reader';
import { packsDirFor } from '../engine/paths';
import { SLOTS, affectedEventsForSlots } from '../engine/slot-table';
import { slotNamesOfKeys } from './market-format';
import {
  buildHopUrls,
  fetchFiles,
  httpsRawIo,
  MANIFEST_LIMIT_BYTES,
  TEXT_HOP_TIMEOUT_MS,
} from '../engine/net-fetch';
import { RegistryEntry, displayName, fetchRegistry } from '../engine/registry-client';
import {
  fetchPreviewAudio,
  InstallOutcome,
  installPack,
  parseDirectInput,
  resolveBranchHead,
} from '../engine/market-install';

interface MarketPickItem extends vscode.QuickPickItem {
  entry?: RegistryEntry;
  localPack?: PackInfo;
  direct?: boolean;
  none?: boolean;
  indexError?: boolean;
}

function registryRepoCfg(): string {
  return vscode.workspace.getConfiguration().get<string>('vir.packRegistryRepo') ?? '';
}

function mirrorPrefixCfg(): string {
  return vscode.workspace.getConfiguration().get<string>('vir.packMirrorTemplate') ?? '';
}

// Slot names for coverage display: numbered responseReceived sub keys count
// as the one shared slot they feed.
export { slotNamesOfKeys } from './market-format';

// Prefetch every entry manifest for the coverage line; an entry whose
// manifest cannot be fetched shows the honest unknown marker. Real install
// validation happens in the installer, not here.
async function prefetchManifestSlots(
  entries: ReadonlyArray<RegistryEntry>,
  mirrorPrefix: string
): Promise<Map<string, ReadonlyArray<string>>> {
  const jobs = entries.map((e) => ({
    name: e.id,
    urls: buildHopUrls({
      repo: e.repo,
      ref: e.commit,
      filePath: e.packPath + '/manifest.json',
      mirrorPrefix,
    }),
    limitBytes: MANIFEST_LIMIT_BYTES,
  }));
  const rs = await fetchFiles(httpsRawIo, jobs, { timeoutMs: TEXT_HOP_TIMEOUT_MS, deadlineMs: 30 * 1000 });
  const map = new Map<string, ReadonlyArray<string>>();
  rs.forEach((r, i) => {
    if (!r.ok) {
      return;
    }
    try {
      const parsed = JSON.parse(r.data.toString('utf8')) as { slots?: Record<string, unknown> };
      const keys = Object.keys(parsed.slots ?? {}).filter(
        (k) => typeof (parsed.slots as Record<string, unknown>)[k] === 'string'
      );
      map.set(entries[i].id, keys);
    } catch {
      // Coverage stays unknown for this row; installing still validates.
    }
  });
  return map;
}

function coverageLine(slotKeys: ReadonlyArray<string> | undefined): string {
  if (slotKeys === undefined) {
    return t('ui.market.coverUnknown');
  }
  const slots = slotNamesOfKeys(slotKeys);
  const events = affectedEventsForSlots(slots).length;
  return t('ui.market.coverage', slots.length, SLOTS.length, events);
}

function entryDescription(entry: RegistryEntry, slotKeys: ReadonlyArray<string> | undefined): string {
  const cats = entry.categories.join(',');
  return `v${entry.version} · ${entry.language}${cats === '' ? '' : ' · ' + cats} · ${coverageLine(slotKeys)}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string)
  );
}

function attemptsText(outcome: Extract<InstallOutcome, { status: 'failed' }>): string {
  const lines = outcome.attempts.slice(0, 6).map((a) => render(a.detail));
  return lines.length > 0 ? lines.join('\n') : render(outcome.error);
}

// The audition player: one webview, one audio tag, temp file deleted on
// panel close. Nothing is written into the packs folder.
async function previewEntry(ctx: VirUiContext, entry: RegistryEntry): Promise<void> {
  const tmpDir = path.join(ctx.storageDir, 'preview');
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t('ui.market.previewFetching') },
    async () => {
      const probe = path.join(tmpDir, entry.id + '.audio');
      const r = await fetchPreviewAudio(
        httpsRawIo,
        { repo: entry.repo, commit: entry.commit, packPath: entry.packPath },
        mirrorPrefixCfg(),
        probe
      );
      if (!r.ok) {
        await vscode.window.showErrorMessage(attemptsText({ status: 'failed', error: r.error, attempts: r.attempts }));
        return;
      }
      const ext = path.extname(r.rel) === '.mp3' ? '.mp3' : '.wav';
      const finalFile = path.join(tmpDir, entry.id + ext);
      fs.renameSync(probe, finalFile);
      const title = escapeHtml(displayName(entry, vscode.env.language));
      const panel = vscode.window.createWebviewPanel(
        'vir.preview',
        title,
        vscode.ViewColumn.Beside,
        { retainContextWhenHidden: false }
      );
      const src = panel.webview.asWebviewUri(vscode.Uri.file(finalFile));
      panel.webview.html =
        '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
        'body{display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:sans-serif}' +
        '</style></head><body><audio controls autoplay src="' + String(src) + '"></audio></body></html>';
      panel.onDidDispose(() => {
        fs.rmSync(finalFile, { force: true });
      });
    }
  );
}

async function installAndOffer(
  ctx: VirUiContext,
  onLocalChoice: (choice: { pack: PackInfo } | { none: true }) => Promise<void>,
  entry: RegistryEntry | undefined,
  repo: string,
  commit: string,
  packPath: string
): Promise<void> {
  const opts = { storageDir: ctx.storageDir, rawIo: httpsRawIo, mirrorPrefix: mirrorPrefixCfg(), owner: ctx.owner };
  const outcome = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t('ui.market.installing') },
    () =>
      installPack(
        httpsRawIo,
        { repo, commit, packPath },
        opts,
        entry === undefined
          ? undefined
          : {
              id: entry.id,
              version: entry.version,
              license: entry.license,
              author: entry.author,
              sourceLicense: entry.sourceLicense,
            }
      )
  );
  if (outcome.status === 'failed') {
    await vscode.window.showErrorMessage(render(outcome.error) + '\n' + attemptsText(outcome));
    return;
  }
  if (outcome.status === 'uptoDate') {
    await vscode.window.showInformationMessage(t('ui.market.uptoDate', outcome.localVersion));
    return;
  }
  const note =
    outcome.status === 'installed'
      ? t('ui.market.installDone', outcome.pack.name)
      : t('ui.market.updateDone', outcome.pack.version);
  const conflictLines = outcome.warnings.map(render);
  const body = conflictLines.length > 0 ? note + '\n' + conflictLines.join('\n') : note;
  const apply = t('ui.market.enableAndApply');
  const pick = await vscode.window.showInformationMessage(body, apply);
  if (pick === apply) {
    const pack = findPackById(packsDirFor(ctx.storageDir), (entry ? entry.id : readInstalledId(outcome)));
    if (pack) {
      await onLocalChoice({ pack });
    }
  }
}

function readInstalledId(outcome: Extract<InstallOutcome, { status: 'installed' | 'updated' }>): string {
  return outcome.pack.id;
}

async function entryActionFlow(
  ctx: VirUiContext,
  onLocalChoice: (choice: { pack: PackInfo } | { none: true }) => Promise<void>,
  entry: RegistryEntry
): Promise<void> {
  const preview = t('ui.market.preview');
  const installOrUpdate = t('ui.market.installOrUpdate');
  const cancel = t('ui.common.canceled');
  const pick = await vscode.window.showQuickPick(
    [
      { label: '$(play)' + ' ' + preview, action: 'preview' as const },
      { label: '$(cloud-download)' + ' ' + installOrUpdate, action: 'install' as const },
      { label: '$(close)' + ' ' + cancel, action: 'cancel' as const },
    ],
    { placeHolder: displayName(entry, vscode.env.language) }
  );
  if (!pick || pick.action === 'cancel') {
    return;
  }
  if (pick.action === 'preview') {
    await previewEntry(ctx, entry);
    return;
  }
  await installAndOffer(ctx, onLocalChoice, entry, entry.repo, entry.commit, entry.packPath);
}

async function directInstallFlow(
  ctx: VirUiContext,
  onLocalChoice: (choice: { pack: PackInfo } | { none: true }) => Promise<void>
): Promise<void> {
  const input = await vscode.window.showInputBox({ placeHolder: t('ui.market.directPlaceholder') });
  if (input === undefined || input.trim() === '') {
    return;
  }
  const parsed = parseDirectInput(input);
  if (!parsed.ok) {
    await vscode.window.showErrorMessage(render(parsed.error));
    return;
  }
  const head = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t('ui.market.resolving') },
    () => resolveBranchHead(httpsRawIo, parsed.repo, 'main', mirrorPrefixCfg())
  );
  if (!head.ok) {
    await vscode.window.showErrorMessage(render(head.error) + '\n' + attemptsText({ status: 'failed', error: head.error, attempts: head.attempts }));
    return;
  }
  await vscode.window.showInformationMessage(t('ui.market.resolved', head.sha.slice(0, 8)));
  await installAndOffer(ctx, onLocalChoice, undefined, parsed.repo, head.sha, parsed.packPath);
}

export async function marketSelectFlow(
  ctx: VirUiContext,
  onLocalChoice: (choice: { pack: PackInfo } | { none: true }) => Promise<void>
): Promise<void> {
  const listing = localPackListing(ctx);
  const byId = new Map(listing.good.map((p) => [p.id, p] as const));
  const qp = vscode.window.createQuickPick<MarketPickItem>();
  qp.placeholder = t('ui.select.placeholder');
  qp.busy = true;
  qp.show();
  const registry = await fetchRegistry(httpsRawIo, {
    registryRepo: registryRepoCfg(),
    mirrorPrefix: mirrorPrefixCfg(),
  });
  const manifests = registry.ok
    ? await prefetchManifestSlots(registry.entries, mirrorPrefixCfg())
    : new Map<string, ReadonlyArray<string>>();

  const items: MarketPickItem[] = [];
  if (!registry.ok) {
    // Per source failure reasons ride the detail line: a silent generic
    // error would hide which hops were tried.
    items.push({
      label: '$(warning)' + ' ' + t('ui.market.indexUnavailable'),
      detail:
        render(registry.error) +
        '\n' +
        attemptsText({ status: 'failed', error: registry.error, attempts: registry.attempts }),
      indexError: true,
    });
  }
  items.push({ label: '$(globe)' + ' ' + t('ui.market.directInstall'), direct: true, detail: t('ui.market.directDetail') });
  if (registry.ok) {
    for (const entry of registry.entries) {
      const local = byId.get(entry.id);
      let mark = '    ';
      if (local !== undefined) {
        const remoteTriple = parseVersion(entry.version);
        const newer = remoteTriple !== undefined && compareVersion(remoteTriple, local.versionTriple) > 0;
        mark = newer ? '↑ ' : '✓ ';
      }
      items.push({
        label: mark + displayName(entry, vscode.env.language),
        description: entryDescription(entry, manifests.get(entry.id)),
        detail: `${entry.author} · ${entry.repo}`,
        entry,
      });
    }
  }
  for (const pack of listing.good) {
    items.push({
      label: '$(audio-file)' + ' ' + pack.name,
      description: pack.id,
      detail: t('ui.market.localDetail', pack.version),
      localPack: pack,
    });
  }
  items.push({ label: t('ui.select.none'), none: true });
  qp.busy = false;
  qp.items = items;

  const chosen: MarketPickItem | undefined = await new Promise((resolve) => {
    qp.onDidAccept(() => resolve(qp.activeItems[0]));
    qp.onDidHide(() => resolve(undefined));
  });
  qp.dispose();
  if (chosen === undefined || chosen.indexError === true) {
    return;
  }
  if (chosen.none === true) {
    await onLocalChoice({ none: true });
    return;
  }
  if (chosen.direct === true) {
    await directInstallFlow(ctx, onLocalChoice);
    return;
  }
  if (chosen.localPack !== undefined) {
    await onLocalChoice({ pack: chosen.localPack });
    return;
  }
  if (chosen.entry !== undefined) {
    await entryActionFlow(ctx, onLocalChoice, chosen.entry);
  }
}
