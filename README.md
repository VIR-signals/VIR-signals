# VIR Signals

**Read this first: this extension writes into the editor installation directory.** It replaces the built-in sound files of VS Code with audio from a voice pack. A full backup of the official files is kept, can be restored with one command, and is restored automatically when the extension is uninstalled. Not every installation type is supported: the Microsoft Store edition, system level installs on Windows, and read only package formats are detected and rejected with a clear message.

## How it works

- The official sound files live in a versioned folder inside the editor installation. The extension locates that folder, backs up every file it holds, then swaps in the audio of the selected voice pack.
- After a replacement the editor must be fully restarted before every signal picks up the new audio. The completion notice says so.
- When the editor updates itself, the fresh official files are backed up again and the active pack is laid over the new files automatically.

## Uninstalling

Uninstalling the extension puts the official sound files back automatically. The restore runs when VS Code next starts after the uninstall (the editor defers the uninstall work, including this restore, to the next launch), so until that restart the current sounds stay. The restore uses the snapshot inside the extension folder first and falls back to the backup in the extension storage; if both are gone it leaves the files untouched rather than guessing.

## Voice packs

A pack is a folder with a `manifest.json` and audio files (WAV or MP3). The `slots` object maps slot names to audio files inside the pack. A pack does not have to cover all slots: untouched slots keep the official sound. Use **VIR: Open Voice Packs Folder** to create and open the pack folder, drop packs in, then **VIR: Rescan Voice Packs** to pick them up.

## Signal switches

Replacing files does not turn signals on. The editor plays a signal only when its accessibility signal setting is on. The first run notice points at picking a pack, because signal switches only matter once a pack is applied. After every successful apply the result notification offers the two switch modes: **Enable All** (all editor signal settings on; untouched events keep the official sounds) or **Match the Pack** (covered settings on, everything else off). **VIR: Enable All Signals** does the enable-all at any time — a pure editor settings operation, the active pack is irrelevant — and **VIR: Restore Signal Toggles** puts those settings back the way they were.

## Commands

| Command | What it does |
|---|---|
| VIR: Open Voice Packs Folder | Create and open the pack folder. |
| VIR: Rescan Voice Packs | Rescan the pack folder and report broken packs. |
| VIR: Select Voice Pack | Pick the active pack and apply it right away; picking none restores the official sounds. Also reachable from the bell in the status bar. |
| VIR: Apply Voice Pack | Back up if needed, recompute every slot, replace the files, verify. Asks for a pack first when none is active. |
| VIR: Restore Original Sounds | Lay the official files back and verify every hash. |
| VIR: Open Signal Settings | Jump to the signal section of the settings page. |
| VIR: Enable All Signals | Switch on all signal settings of the editor. |
| VIR: Restore Signal Toggles | Put back the signal settings this extension switched on. |
| VIR: Status | Full report: pack, replacement, backup, slot coverage, switches. |
| VIR: Delete Backup | Delete the backup itself, after a confirmation. |
| VIR: Identify Sounds | Guided calibration flow that maps triggers to slots by ear. |

## Settings

- `vir.enabled`: master switch. Off means the extension stops intervening and leaves replaced files as they are.
- `vir.activePack`: the active pack id, written by the selection command.
- `vir.editorInstallPath`: manual override of the editor install location, for installs automatic detection cannot resolve.

## Restore and uninstall

- **VIR: Restore Original Sounds** restores every file from the backup and checks each hash against the backup record.
- The uninstall hook restores the official files automatically when the extension is uninstalled.
- **VIR: Delete Backup** removes the backup itself. Without a backup there is no way back short of reinstalling the editor, so it asks twice.
