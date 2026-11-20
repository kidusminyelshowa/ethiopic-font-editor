# Ethiopic Font Editor

A desktop font editor where the fidel family system is the core data model.
A fidel is a recipe (a base plus the alterations its order rule names), not a
separate drawing, so the designer draws the system once and every family follows.

Stack: Tauri shell, Rust core, web UI. Windows first, macOS later.

## Layout

| Path | What it is |
| --- | --- |
| `crates/fidel-core` | The fidel data model: bases, alterations, order rules, families, glyph states, resolution to outlines (ETH-1) |

## Development

```sh
cargo test            # run the core tests
```

Vocabulary and default order rules follow Hornus, *The Ethiopic Writing System:
A Typographic Approach* (University of Reading, 2006).
