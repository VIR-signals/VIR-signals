// The audition panel: download the whole pack into a preview folder under
// the extension storage (never the packs folder), lay out all 28 slots in
// a webview, play slot audio on row clicks (a user gesture, autoplay
// never), and run the same install flow the market entry uses. Closing
// the panel removes the preview folder; asking again for the same pack
// reveals the live panel instead of downloading a second time.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { attemptsText, render, t } from './render';
import { VirUiContext } from './extension-context';
import { RegistryEntry, displayName } from '../engine/registry-client';
import { SLOTS, affectedEventsForSlots } from '../engine/slot-table';
import { httpsRawIo } from '../engine/net-fetch';
import { downloadPackForPreview } from '../engine/market-install';
import { escapeHtml, previewPanelHtml, previewRows } from './preview-format';

const openPanels = new Map<string, { panel: vscode.WebviewPanel; dir: string }>();

export async function openPreviewPanel(
  ctx: VirUiContext,
  entry: RegistryEntry,
  mirrorPrefix: string,
  onInstall: () => Promise<void>
): Promise<void> {
  const alive = openPanels.get(entry.id);
  if (alive !== undefined) {
    alive.panel.reveal();
    return;
  }
  const dir = path.join(ctx.storageDir, 'preview', entry.id);
  const outcome = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t('ui.preview.fetching') },
    () =>
      downloadPackForPreview(
        httpsRawIo,
        { repo: entry.repo, commit: entry.commit, packPath: entry.packPath },
        mirrorPrefix,
        dir
      )
  );
  if (!outcome.ok) {
    await vscode.window.showErrorMessage(render(outcome.error) + '\n' + attemptsText(outcome));
    return;
  }
  const pack = outcome.pack;
  const panel = vscode.window.createWebviewPanel(
    'vir.preview',
    displayName(entry, vscode.env.language),
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: false,
      localResourceRoots: [vscode.Uri.file(dir)],
    }
  );
  openPanels.set(entry.id, { panel, dir });
  const inputs = previewRows(pack);
  const coveredSlots = inputs.filter((r) => r.covered).map((r) => r.slot);
  const html = previewPanelHtml(
    {
      title: escapeHtml(t('ui.preview.title', displayName(entry, vscode.env.language))),
      badge: escapeHtml('v' + entry.version),
      metaLine: escapeHtml(
        t(
          'ui.preview.metaLine',
          entry.repo,
          coveredSlots.length,
          SLOTS.length,
          affectedEventsForSlots(coveredSlots).length
        )
      ),
      headNote: escapeHtml(t('ui.preview.headNote')),
      colSlot: escapeHtml(t('ui.preview.colSlot')),
      colEvent: escapeHtml(t('ui.preview.colEvent')),
      colFile: escapeHtml(t('ui.preview.colFile')),
      notCovered: escapeHtml(t('ui.preview.notCovered')),
      install: escapeHtml(t('ui.market.installOrUpdate')),
      footNote: escapeHtml(t('ui.preview.footNote')),
      installing: escapeHtml(t('ui.preview.installing')),
      playFailed: escapeHtml(t('ui.preview.playFailed')),
      secondsFmt: escapeHtml(t('ui.preview.secondsFmt')),
      rows: inputs.map((r) => ({
        slot: escapeHtml(r.slot),
        evt: escapeHtml(t(r.evtKey)),
        file: escapeHtml(r.covered ? r.files.join(', ') : t('ui.preview.notCovered')),
        covered: r.covered,
        uris: r.absPaths.map((p) => String(panel.webview.asWebviewUri(vscode.Uri.file(p)))),
      })),
    },
    { nonce: crypto.randomBytes(16).toString('hex'), cspSource: panel.webview.cspSource }
  );
  panel.webview.html = html;
  // A message aimed at a panel that has since closed must not fire: the
  // webview getter throws once disposed (seen in the wild when the editor
  // quits while an install is still running). The flag flips inside
  // onDidDispose, and the check plus the post share one synchronous stretch,
  // so no dispose event can slip between them. The install itself always
  // runs to completion: its notifications live outside the panel.
  let disposed = false;
  const postState = (phase: string): void => {
    if (disposed) {
      return;
    }
    void panel.webview.postMessage({ type: 'installState', phase });
  };
  panel.webview.onDidReceiveMessage((m: unknown) => {
    if ((m as { type?: string } | null)?.type !== 'install') {
      return;
    }
    void (async () => {
      postState('running');
      try {
        await onInstall();
      } finally {
        postState('settled');
      }
    })();
  });
  panel.onDidDispose(() => {
    disposed = true;
    openPanels.delete(entry.id);
    fs.rmSync(dir, { recursive: true, force: true });
  });
}
