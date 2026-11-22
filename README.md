# Ethiopic Font Editor

A desktop font editor where the fidel family system is the core data model.
A fidel is a recipe (a base plus the alterations its order rule names), not a
separate drawing, so the designer draws the system once and every family follows.

Stack: Tauri shell, Rust core, web UI. Windows first, macOS later.

## Layout

| Path | What it is |
| --- | --- |
| `crates/fidel-core` | The fidel data model: bases, alterations, order rules, families, glyph states, resolution to outlines (ETH-1) |
| `src-tauri` | Tauri desktop shell; exposes the core to the UI as commands (ETH-7) |
| `ui` | Web UI (Vite + TypeScript): canvas and panels |

## Development

Prerequisites: Rust (stable), Node 22, and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS
(on Windows: Microsoft C++ Build Tools and WebView2, which Windows 10/11 already has).

```sh
npm install
npm run tauri dev     # open the app with live reload
npm run tauri build   # build an installer for this OS
cargo test            # run the Rust tests
npm test              # run the UI tests
```

Every push to a pull request builds a Windows installer and a macOS app in
GitHub Actions. Download them from the run's Artifacts section.

Vocabulary and default order rules follow Hornus, *The Ethiopic Writing System:
A Typographic Approach* (University of Reading, 2006).

## Releases and updates

Every merge to `main` runs `.github/workflows/release.yml`, which builds the Windows installer and the macOS app, signs the update files, and publishes a GitHub Release named `v0.1.<run number>`. The installed app checks the newest release when it starts and offers "Update and restart".

Signing needs two repository secrets: `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The matching public key is in `src-tauri/tauri.conf.json`. If the private key is lost, installed copies cannot update and must be reinstalled by hand once with a new key.
