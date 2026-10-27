// Market panel (spec 4.2): the pack picker in index form. Local packs and
// registry entries share one list, a standing direct install entry sits on
// top, registry picks open a three action follow up (preview, install or
// update, cancel), and the audition player is a webview panel whose whole
// pack download is removed the moment the panel closes. The engine stays
// vscode free; every sentence lives in the language bundles.
import * as vscode from 'vscode';
import { attemptsText, render, t } from './render';
import { VirUiContext } from './extension-context';
import { openPreviewPanel } from './preview-panel';
import { localPackListing } from './pack-source';
import { PackInfo, compareVersion, findPackById, parseVersion } from '../engine/pack-reader';
import { packsDirFor } from '../engine/paths';
import { loadState } from '../engine/ledger';
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
  DIRECT_DEFAULT_BRANCH,
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

// The audition player: one webview panel per pack over a whole pack
// download that lives in the preview folder, removed when the panel
// closes. Nothing is written into the packs folder.
async function previewEntry(
  ctx: VirUiContext,
  onLocalChoice: (choice: { pack: PackInfo } | { none: true }) => Promise<void>,
  entry: RegistryEntry
): Promise<void> {
  await openPreviewPanel(ctx, entry, mirrorPrefixCfg(), () =>
    installAndOffer(ctx, onLocalChoice, entry, entry.repo, entry.commit, entry.packPath)
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
  const note =
    outcome.status === 'installed'
      ? t('ui.market.installDone', outcome.pack.name)
      : outcome.status === 'updated'
        ? t('ui.market.updateDone', outcome.pack.version)
        : t('ui.market.uptoDate', outcome.localVersion);
  // Picking the pack already said "use it": the install lands and the choice
  // flow runs right away, no middle confirmation. Install time conflicts are
  // informational (the pack wins), so they ride along instead of gating.
  const conflictLines = outcome.status === 'uptoDate' ? [] : outcome.warnings.map(render);
  if (conflictLines.length > 0) {
    void vscode.window.showWarningMessage(note + '\n' + conflictLines.join('\n'));
  } else {
    void vscode.window.showInformationMessage(note);
  }
  const packId =
    entry !== undefined
      ? entry.id
      : outcome.status === 'uptoDate'
        ? outcome.packId
        : outcome.pack.id;
  const pack = findPackById(packsDirFor(ctx.storageDir), packId);
  if (pack === undefined) {
    await vscode.window.showErrorMessage(t('ui.market.applyMissing', packId));
    return;
  }
  await onLocalChoice({ pack });
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
    await previewEntry(ctx, onLocalChoice, entry);
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
    () => resolveBranchHead(httpsRawIo, parsed.repo, DIRECT_DEFAULT_BRANCH, mirrorPrefixCfg())
  );
  if (!head.ok) {
    await vscode.window.showErrorMessage(render(head.error) + '\n' + attemptsText({ error: head.error, attempts: head.attempts }));
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

  // The check mark means exactly one thing: this is what is in effect now.
  // Installed-and-current carries no mark (the local list shows that), a
  // newer remote build carries the up arrow, and an empty selection checks
  // the keep-official row.
  const activeId = loadState(ctx.storageDir).activePackId;
  const items: MarketPickItem[] = [];
  if (!registry.ok) {
    // Per source failure reasons ride the detail line: a silent generic
    // error would hide which hops were tried.
    items.push({
      label: '$(warning)' + ' ' + t('ui.market.indexUnavailable'),
      detail:
        render(registry.error) +
        '\n' +
        attemptsText({ error: registry.error, attempts: registry.attempts }),
      indexError: true,
    });
  }
  items.push({ label: '$(globe)' + ' ' + t('ui.market.directInstall'), direct: true, detail: t('ui.market.directDetail') });
  if (registry.ok) {
  for (const entry of registry.entries) {
    // Index rows are views of remote entries, never the thing in effect: a
    // local pack and an index entry can share one id (the bundled demo
    // does), so checking by id here would light two rows at once.
    const local = byId.get(entry.id);
    let mark = '';
    if (local !== undefined) {
      const remoteTriple = parseVersion(entry.version);
      const newer = remoteTriple !== undefined && compareVersion(remoteTriple, local.versionTriple) > 0;
      mark = newer ? '↑ ' : '';
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
      label: (pack.id === activeId ? '✓ ' : '') + '$(audio-file)' + ' ' + pack.name,
      description: pack.id,
      detail: t('ui.market.localDetail', pack.version),
      localPack: pack,
    });
  }
  items.push({ label: (activeId === '' ? '✓ ' : '') + t('ui.select.none'), none: true });
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
