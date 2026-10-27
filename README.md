# VIR Signals

[English](README.md) | [简体中文](README.zh-CN.md)

Source: [VIR-signals/vir-signals](https://github.com/VIR-signals/vir-signals)

VIR Signals replaces the built-in sound files of VS Code with the audio of a selected voice pack. The editor’s signal system is unchanged: it plays the same signals as before, and the sounds come from the selected pack. A demo pack ships with the extension; packs can also be installed from a registry index, and any local folder with a conforming manifest can serve as a pack.

**Features**

- **Replacement** — pack audio replaces the official sound files slot by slot; the slots a pack covers are declared in its manifest.
- **Pack sources** — a bundled demo pack, registry index entries, and local pack directories.
- **Signal switches** — each signal can be enabled or disabled individually, and the replacement can be paused as a whole.
- **Backup and restore** — official sound files are backed up before any change, restorable with a single command, and restored automatically on uninstall.

> **Read this first: this extension writes into the editor installation directory.** It replaces the built-in sound files of VS Code with audio from a voice pack. A full backup of the official files is kept, can be restored with one command, and is restored automatically when the extension is uninstalled. Not every installation type is supported: the Microsoft Store edition, system level installs on Windows, and read only package formats are detected and rejected with a clear message.

## How it works

- The official sound files live in a versioned folder inside the editor installation. The extension locates that folder, backs up every file it holds, then swaps in the audio of the selected voice pack.
- After a replacement the editor must be fully restarted before every signal picks up the new audio. A standalone warning notice says so at the end of every replacement.
- When the editor updates itself, the fresh official files are backed up again and the active pack is laid over the new files automatically.

## Getting started

1. On first launch, the extension performs the initial backup of the official sound files and requests a single window reload, so that its command titles follow the editor display language.
2. After the reload, the extension directs to voice pack selection. The selector lists the bundled demo pack, the packs recorded in the registry index, and all local packs.
3. Selecting a pack applies it immediately. The result notification offers the two signal switch modes, and the flow ends with a standalone warning notice: a full editor restart is required before every signal adopts the replaced audio.

## Uninstalling

Before using the editor's own Disable command on this extension, run **VIR: Toggle Sound Replacement** to restore the official files first: a disabled extension cannot restore anything, only the uninstall hook remains.

Uninstalling the extension puts the official sound files back automatically and returns every signal setting it switched to its previous value. The restore runs when VS Code next starts after the uninstall (the editor defers the uninstall work, including this restore, to the next launch), so until that restart the current sounds stay. The files restore uses the snapshot inside the extension folder first and falls back to the backup in the extension storage; if both are gone it leaves the files untouched rather than guessing.

## Voice packs

The selector (**VIR: Select Voice Pack**, also reachable from the status bar bell) presents the following kinds of rows. Exactly one row carries a check mark, marking the pack currently in effect; a registry entry whose version exceeds the installed local copy is marked with an upgrade arrow instead.

- **Registry entries** — packs published in the index repository, listed with version, language and slot coverage. Selecting one offers **Preview** and **Install or Update**.
- **Local packs** — directories in the pack folder. Selecting one applies it immediately.
- **No pack** — restores and maintains the official sounds.
- **Direct install** — accepts an `owner/repo` reference (optionally with a pack path) and installs from an arbitrary repository without consulting the index.

**Preview** opens an audition panel: the complete pack is downloaded into a dedicated temporary directory (the pack folder is never written), all slots are listed with the system events that trigger them, and selecting a covered row plays its audio. Closing the panel removes the temporary directory. The panel's install button forwards to the standard install flow.

A pack is a directory with a `manifest.json` and audio files (WAV or MP3). The `slots` object maps slot names to audio files inside the pack. A pack does not have to cover all slots: untouched slots keep the official sound. Use **VIR: Open Voice Packs Folder** to create and open the pack folder, place packs there, then **VIR: Rescan Voice Packs** to pick them up. Authoring a pack is specified in the [voice pack authoring guide](docs/voice-pack-authoring.md) ([简体中文](docs/voice-pack-authoring.zh-CN.md)).

## Network access

The pack picker fetches the registry index from GitHub: the direct raw URL first, then the jsDelivr mirror, then the mirror prefix from `vir.packMirrorTemplate` if one is set. Pack downloads always come from the pack author's own repository, pinned to the commit recorded in the registry entry. Each hop has its own timeout, and a failed index fetch never blocks the list: local packs and the direct install entry still show.

All requests follow the editor's proxy configuration (`http.proxy`). On networks where GitHub stays unreachable, set `http.proxy` in VS Code, or set `vir.packMirrorTemplate` to a mirror prefix such as `https://ghproxy.net/`. A mirror is a third party relay you choose to trust; downloads pinned to a commit hash come out byte identical through it, while the branch addressed index may lag behind by the mirror's cache window.

## Signal switches

Replacing files does not turn signals on. The editor plays a signal only when its accessibility signal setting is on. The first run notice points at picking a pack, because signal switches only matter once a pack is applied. After every successful apply the result notification offers the two switch modes: **Enable All** (all editor signal settings on; untouched events keep the official sounds) or **Match the Pack** (covered settings on, everything else off). **VIR: Enable All Signals** does the enable-all at any time — a pure editor settings operation, the active pack is irrelevant — and **VIR: Restore Signal Toggles** puts those settings back the way they were.

## Commands

| Command | What it does |
|---|---|
| VIR: Open Voice Packs Folder | Create and open the pack folder. |
| VIR: Rescan Voice Packs | Rescan the pack folder and report broken packs. |
| VIR: Select Voice Pack | Select the active pack and apply it immediately; selecting none restores the official sounds. Also reachable from the status bar bell. |
| VIR: Apply Voice Pack | Back up if needed, recompute every slot, replace the files, verify. Asks for a pack first when none is active. |
| VIR: Toggle Sound Replacement | The master switch. Off restores the official sounds right away, on lays the selected pack back; editor updates respect it, so a fresh version stays native while the switch is off. |
| VIR: Restore Original Sounds | Lay the official files back and verify every hash. |
| VIR: Open Signal Settings | Jump to the signal section of the settings page. |
| VIR: Enable All Signals | Switch on all signal settings of the editor. |
| VIR: Restore Signal Toggles | Put back the signal settings this extension switched on. |
| VIR: Status | Full report: pack, replacement, backup, slot coverage, switches. |
| VIR: Delete Backup | Delete the backup itself, after a confirmation. |
| VIR: Identify Sounds | Guided calibration flow that maps triggers to slots by ear. |

## Settings

- `vir.editorInstallPath`: manual override of the editor install location, for installs automatic detection cannot resolve.
- `vir.packRegistryRepo`: the GitHub repository used as the pack index, in `owner/repo` form.
- `vir.packMirrorTemplate`: optional URL prefix prepended to direct GitHub URLs as an extra mirror hop, for networks where GitHub is unreachable.

## Unsupported installations

The extension detects and rejects these with a clear message instead of guessing: the Microsoft Store edition, Windows system level installs (writes would land under `C:\Program Files`), macOS (modifying the app bundle breaks its code signature), Linux installs owned by root (deb, rpm, `/opt`), and read only package formats (snap, flatpak — no elevation helps there). Use a user level install of the official VS Code.

## Restore and uninstall

- **VIR: Restore Original Sounds** restores every file from the backup and checks each hash against the backup record.
- The uninstall hook restores the official files automatically when the extension is uninstalled.
- **VIR: Delete Backup** removes the backup itself. Without a backup there is no way back short of reinstalling the editor, so it asks twice.

## License

MIT © 2026 XKDMW404 — see [LICENSE](LICENSE).
