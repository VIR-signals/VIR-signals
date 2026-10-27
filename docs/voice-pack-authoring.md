# Voice Pack Authoring Guide

[English](voice-pack-authoring.md) | [简体中文](voice-pack-authoring.zh-CN.md)

A voice pack is a directory containing a manifest file (`manifest.json`) and the audio assets referenced by that manifest. The extension loads every valid pack directory found in the pack folder, which **VIR: Open Voice Packs Folder** creates. This document specifies the pack format exactly as the extension validates it.

The bundled `demo` pack serves as a minimal working reference: a complete manifest covering two slots.

## Pack layout

```
my-pack/
  manifest.json
  sounds/
    error.wav
    save.mp3
    ...
```

- Audio assets must be WAV or MP3. The format is identified from file content (magic bytes), not from the file extension.
- Paths in the manifest are relative to the pack directory and use forward slashes exclusively (`sounds/error.wav`).
- A pack is not required to cover all slots. Any slot it omits retains the official sound.

## Manifest specification

| Field | Required | Specification |
|---|---|---|
| `schema` | yes | Exactly `1`. A greater value is rejected with a newer-schema message. |
| `id` | yes | Pack identifier. Must be unique within the pack folder; when two directories declare the same id, the directory sorting later is rejected. |
| `name` | yes | Display name shown in the pack selector. |
| `version` | yes | Three numeric segments separated by dots, for example `1.0.0`. |
| `author` | no | Shown in the selector detail line for registry entries. |
| `license` | yes | License of the pack itself, for example `CC0-1.0` or `MIT`. |
| `sourceLicense` | yes | Provenance of the audio. One of: `original`, `game-asset`, `third-party-cc0`, `unknown`. |
| `language` | no | Free-form tag such as `zh` or `en`; defaults to `none`. |
| `categories` | no | Array of free-form strings, shown in the selector. |
| `slots` | yes | Object mapping slot names to audio file paths. At least one entry is required. |

A manifest-level violation rejects the entire pack. A defect confined to a single audio file disables only the corresponding slot; the remaining slots stay usable, and the reason is reported by **VIR: Rescan Voice Packs**.

### Example

The manifest of the bundled demo pack:

```json
{
  "schema": 1,
  "id": "demo",
  "name": "Demo save+err",
  "version": "1.0.0",
  "author": "VIR Signals",
  "license": "CC0-1.0",
  "sourceLicense": "third-party-cc0",
  "slots": {
    "error": "sounds/error_004.wav",
    "save": "sounds/confirmation_002.wav"
  }
}
```

Two slots are covered; the remaining twenty-six retain the official sound. The demo pack includes a `SOURCE.txt` recording the provenance of its audio. Packs incorporating third-party audio should document provenance in the same manner.

## Slots

A slot corresponds to one editor sound position, and the slot name matches the base name of the official media file at that position. The sound set verified against editor 1.143.1 comprises 28 slots:

| Slot | Triggers |
|---|---|
| `error` | error line, error position, or a failed terminal command |
| `warning` | warning line or warning position |
| `break` | breakpoint line or a debug pause hit |
| `quickFixes` | inline suggestion or terminal quick fix |
| `taskCompleted` | background task completed (incl. notebook cells) |
| `taskFailed` | background task failed (incl. notebook cells) |
| `voiceRecordingStarted` | voice recording started or voice mode on |
| `voiceRecordingStopped` | voice recording stopped or voice mode off |
| `save` | file saved |
| `format` | document formatted |
| `clear` | terminal cleared |
| `progress` | long task in progress |
| `foldedAreas` | cursor jumped onto a folded region |
| `confetti` | confetti celebration |
| `terminalBell` | terminal bell |
| `terminalCommandSucceeded` | terminal command succeeded |
| `diffLineInserted` | diff view: inserted line |
| `diffLineModified` | diff view: modified line |
| `diffLineDeleted` | diff view: deleted line |
| `chatEditModifiedFile` | chat edited a file |
| `chatUserActionRequired` | chat waits for your action |
| `codeActionTriggered` | code action triggered |
| `codeActionApplied` | code action applied |
| `editsKept` | kept chat edits |
| `editsUndone` | undid chat edits |
| `nextEditSuggestion` | next edit suggestion |
| `requestSent` | chat request sent |
| `responseReceived` | chat reply arrived |

Slot names outside this table are rejected at the manifest level. When an official media file is missing or renamed in the editor installation, the situation is reported at apply time and the affected slot retains the official sound.

### Chat response slot

The editor ships four media files for the chat response sound and selects one at random on each event. A manifest must address them in exactly one of two forms; combining both forms in one manifest is rejected:

- `"responseReceived": "sounds/reply.mp3"` — a single file substituted for all four positions.
- `"responseReceived1"` through `"responseReceived4"` — four independent entries, one per position.

## Audio validation

| Check | Limit | On failure |
|---|---|---|
| Format | WAV or MP3, identified by magic bytes | The slot is disabled and the reason reported. |
| File size | 20 MB hard limit | The slot is disabled and the reason reported. |
| Duration | Soft limit of 2 seconds (1 second for `progress`) | Warning only; the slot remains loadable and playable. |

**VIR: Identify Sounds** applies a calibration pack and prints a worksheet listing every slot with its triggers and setting keys, used to map sounds to slots by ear.

## Publishing through the registry

Packs are distributed through an index repository. The index stores entries only; the audio assets remain in the pack author's own Git repository, and every download is pinned to an exact commit, so the content delivered to users is byte-identical to what the author published.

A registry entry consists of: `id`, `names` (display names per language), `categories`, `language`, `author`, `version`, `repo` (`owner/repo` form), `branch`, `commit`, `packPath` (the repository directory containing the `manifest.json`), `license`, and `sourceLicense`. The selector compares the entry `version` against the installed copy and marks a newer release with an upgrade arrow.

Modifications to the index go through that repository's pull request process; direct pushes are not accepted.
