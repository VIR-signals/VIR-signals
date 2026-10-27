// Pure layout computations for the audition panel: turning a parsed pack
// into the 28 slot rows (covered or official) and rendering the webview
// HTML. No vscode import, so the node test runner can exercise the whole
// panel face offline; the vscode side only supplies localized labels,
// webview uris and the nonce. The HTML shape is the approved mockup:
// header with pack name and coverage, one row per slot with a play affordance
// on covered rows, grayed official rows otherwise, and an install button.
import { SLOTS } from '../engine/slot-table';
import { PackInfo } from '../engine/pack-reader';

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string)
  );
}

export interface PreviewRowInput {
  readonly slot: string;
  readonly covered: boolean;
  readonly files: ReadonlyArray<string>;
  readonly absPaths: ReadonlyArray<string>;
  readonly evtKey: string;
}

// One row per SLOTS entry, in table order. Numbered responseReceived sub
// keys fold into their one shared slot, so a pack shipping all four files
// still shows as the single responseReceived row with four files.
export function previewRows(pack: PackInfo): PreviewRowInput[] {
  const rows: PreviewRowInput[] = [];
  for (const entry of SLOTS) {
    const hits = Object.values(pack.slots).filter((s) => s.slot === entry.slot);
    rows.push({
      slot: entry.slot,
      covered: hits.length > 0,
      files: hits.map((h) => h.file.split('/').pop() as string),
      absPaths: hits.map((h) => h.absPath),
      evtKey: 'ui.preview.slot.' + entry.slot,
    });
  }
  return rows;
}

// Labels and rows resolved by the vscode side; everything here is final
// text, so the builder only has to assemble markup.
export interface PreviewPanelModel {
  readonly title: string;
  readonly badge: string;
  readonly metaLine: string;
  readonly headNote: string;
  readonly colSlot: string;
  readonly colEvent: string;
  readonly colFile: string;
  readonly notCovered: string;
  readonly install: string;
  readonly footNote: string;
  readonly installing: string;
  readonly playFailed: string;
  readonly secondsFmt: string;
  readonly rows: ReadonlyArray<{
    slot: string;
    evt: string;
    file: string;
    covered: boolean;
    uris: ReadonlyArray<string>;
  }>;
}

export function previewPanelHtml(
  model: PreviewPanelModel,
  opts: { nonce: string; cspSource: string }
): string {
  // The script payload is injected as JSON with < escaped, so nothing in
  // pack or entry data can close the script tag early.
  const data = JSON.stringify({
    labels: {
      playFailed: model.playFailed,
      secondsFmt: model.secondsFmt,
      installing: model.installing,
      footNote: model.footNote,
    },
    rows: model.rows,
  }).replace(/</g, '\\u003c');
  const csp =
    "default-src 'none'; style-src " + opts.cspSource + " 'unsafe-inline';" +
    ' media-src ' + opts.cspSource + "; script-src 'nonce-" + opts.nonce + "';";
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  *{box-sizing:border-box}
  body{background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font-family:var(--vscode-font-family),"Segoe UI","Microsoft YaHei",sans-serif;margin:0;padding:16px}
  .wrap{max-width:760px;margin:0 auto;border:1px solid var(--vscode-panel-border,rgba(128,128,128,.35));background:var(--vscode-editorWidget-background,var(--vscode-sideBar-background));border-radius:6px;overflow:hidden}
  .head{padding:14px 18px;border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.35));display:flex;justify-content:space-between;align-items:center;gap:16px}
  .head h1{font-size:15px;margin:0;font-weight:600;white-space:nowrap}
  .head .sub{color:var(--vscode-descriptionForeground);font-size:12px;margin-top:4px}
  .badge{background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-size:11px;padding:2px 8px;border-radius:9px;margin-left:8px;white-space:nowrap}
  .headNote{color:var(--vscode-descriptionForeground);font-size:12px;text-align:right;flex-shrink:0}
  table{width:100%;border-collapse:collapse;font-size:13px}
  thead th{text-align:left;color:var(--vscode-descriptionForeground);font-weight:400;font-size:11px;padding:8px 18px;border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.35));text-transform:uppercase;letter-spacing:.4px}
  tbody td{padding:0 18px;border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.2));height:38px}
  tbody tr{cursor:default}
  tbody tr.covered{cursor:pointer}
  tbody tr.covered:hover{background:var(--vscode-list-hoverBackground)}
  tbody tr.playing{background:var(--vscode-list-activeSelectionBackground)}
  .play{width:24px;color:var(--vscode-charts-blue,var(--vscode-focusBorder));font-size:14px}
  tr.playing .play{color:var(--vscode-list-activeSelectionForeground,var(--vscode-editor-foreground))}
  .slot{font-family:var(--vscode-editor-font-family,'Consolas','Courier New',monospace);color:var(--vscode-charts-green,var(--vscode-terminal-ansiGreen))}
  .evt{color:var(--vscode-editor-foreground)}
  .file{color:var(--vscode-descriptionForeground);font-family:var(--vscode-editor-font-family,'Consolas','Courier New',monospace);font-size:12px;word-break:break-all}
  tr.nocover .evt{color:var(--vscode-disabledForeground)}
  tr.nocover .play{color:var(--vscode-disabledForeground)}
  .state{font-size:11px;color:var(--vscode-descriptionForeground)}
  tr.playing .state{color:var(--vscode-list-activeSelectionForeground,var(--vscode-editor-foreground))}
  .foot{padding:12px 18px;border-top:1px solid var(--vscode-panel-border,rgba(128,128,128,.35));display:flex;align-items:center;gap:12px}
  button.install{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:6px 16px;border-radius:3px;font-size:13px;cursor:pointer;font-family:inherit}
  button.install:hover:not(:disabled){background:var(--vscode-button-hoverBackground)}
  button.install:disabled{opacity:.6;cursor:default}
  .foot .note{color:var(--vscode-descriptionForeground);font-size:12px}
</style>
</head>
<body>
<div class="wrap">
  <div class="head">
    <div>
      <h1>${model.title}<span class="badge">${model.badge}</span></h1>
      <div class="sub">${model.metaLine}</div>
    </div>
    <div class="headNote">${model.headNote}</div>
  </div>
  <table>
    <thead><tr><th style="width:36px"></th><th>${model.colSlot}</th><th>${model.colEvent}</th><th>${model.colFile}</th><th style="width:90px"></th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
  <div class="foot">
    <button class="install" id="installBtn">${model.install}</button>
    <span class="note" id="note">${model.footNote}</span>
  </div>
</div>
<script nonce="${opts.nonce}">
(function () {
  var vscode = acquireVsCodeApi();
  var DATA = ${data};
  var audio = null;
  var playingRow = null;
  function byId(id) { return document.getElementById(id); }
  function stopPlay() {
    if (audio !== null) {
      audio.pause();
      audio.src = '';
      audio = null;
    }
    if (playingRow !== null) {
      playingRow.classList.remove('playing');
      var st = playingRow.querySelector('.state');
      if (st !== null) { st.textContent = ''; }
      playingRow = null;
    }
  }
  function playRow(tr, uris) {
    if (playingRow === tr) { stopPlay(); return; }
    stopPlay();
    audio = new Audio(uris[Math.floor(Math.random() * uris.length)]);
    audio.ontimeupdate = function () {
      if (playingRow !== null && audio !== null) {
        var st = playingRow.querySelector('.state');
        if (st !== null) {
          st.textContent = DATA.labels.secondsFmt.replace('{0}', audio.currentTime.toFixed(1));
        }
      }
    };
    audio.onended = stopPlay;
    audio.onerror = function () {
      if (playingRow !== null) {
        var st = playingRow.querySelector('.state');
        if (st !== null) { st.textContent = DATA.labels.playFailed; }
      }
    };
    playingRow = tr;
    tr.classList.add('playing');
    audio.play();
  }
  var tb = byId('rows');
  DATA.rows.forEach(function (r) {
    var tr = document.createElement('tr');
    tr.className = r.covered ? 'covered' : 'nocover';
    tr.innerHTML = '<td class="play">' + (r.covered ? '\\u25B6' : '\\u00B7') + '</td>' +
      '<td class="slot">' + r.slot + '</td>' +
      '<td class="evt">' + r.evt + '</td>' +
      '<td class="file">' + r.file + '</td>' +
      '<td class="state"></td>';
    if (r.covered) {
      tr.addEventListener('click', function () { playRow(tr, r.uris); });
    }
    tb.appendChild(tr);
  });
  var btn = byId('installBtn');
  var note = byId('note');
  var busy = false;
  btn.addEventListener('click', function () {
    if (busy) { return; }
    vscode.postMessage({ type: 'install' });
  });
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (m === null || m.type !== 'installState') { return; }
    if (m.phase === 'running') {
      busy = true;
      btn.disabled = true;
      note.textContent = DATA.labels.installing;
      stopPlay();
      return;
    }
    busy = false;
    btn.disabled = false;
    note.textContent = DATA.labels.footNote;
  });
}());
</script>
</body>
</html>`;
}
