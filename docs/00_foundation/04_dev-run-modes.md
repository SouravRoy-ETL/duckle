# Dev Run Modes

This note defines the intended local development modes for Stitchly v2.

The goal is to make browser-based UI development the fast default, while keeping real runtime execution and full Tauri desktop validation available when needed.

## Modes

| Mode | Command shape | Backend | Use for |
|---|---|---|---|
| `ui-only` | `npm --prefix frontend run dev` | None / browser fallbacks | Canvas, panels, forms, styling, prototype work. |
| `ui-http` | Vite plus local HTTP bridge | Headless Rust runtime | Browser studio with real pipeline execution. |
| `tauri` | `cargo tauri dev` | Tauri IPC | Desktop packaging, native dialogs, Tauri commands, release behavior. |

## Mode 1: UI Only

Run:

```bash
npm --prefix frontend run dev
```

Open:

```text
http://localhost:5173/
```

This is the fastest loop for UI work.

Expected behavior:

- React/Vite hot reload works.
- Browser rendering is smoother than the Linux Tauri webview on some WSL/Linux setups.
- Tauri-only commands return `null`, empty arrays, or browser fallbacks.
- Pipeline execution is not real unless mocked.

Use this mode for:

- workflow canvas changes,
- node palette changes,
- properties-panel work,
- modal/layout/styling iteration,
- browser compatibility checks.

Do not use this mode to validate engine behavior.

## Mode 2: UI Plus HTTP Bridge

Target shape:

```text
Vite browser studio
  -> local HTTP bridge
  -> DuckdbEngine / duckle-runner
  -> DuckDB CLI
```

Command shape:

```bash
cargo run -p duckle-runner -- serve \
  --host 127.0.0.1 \
  --port 8080 \
  --workspace /path/to/workspace \
  --duckdb /path/to/duckdb

VITE_DUCKLE_BACKEND=http \
VITE_DUCKLE_HTTP_URL=http://127.0.0.1:8080 \
npm --prefix frontend run dev
```

This mode is planned. The existing `duckle-runner serve` already provides an HTTP management panel, but it does not yet expose the full browser-studio API needed by the React app.

Expected first bridge capabilities:

- run the current canvas graph,
- run a partial graph to a selected node,
- compile a graph for the Plan view,
- infer source schemas where possible,
- read run history and logs,
- report bridge health.

Use this mode for:

- real pipeline execution from the browser,
- runtime/debug UI work without Tauri desktop,
- Dolt/Parquet workflow development,
- faster Linux/WSL iteration.

## Mode 3: Tauri Desktop

Run:

```bash
cd apps/desktop
cargo tauri dev
```

This starts Vite and the desktop shell.

Use this mode for:

- native file dialogs,
- Tauri IPC command validation,
- desktop window behavior,
- bundled runner/MCP behavior,
- engine installation flow,
- release/package checks.

This mode is heavier because it includes the desktop webview/windowing stack in addition to the Rust process and runtime engine.

## Backend Selection

The frontend should eventually select its backend using explicit mode settings:

```text
VITE_DUCKLE_BACKEND=mock
VITE_DUCKLE_BACKEND=http
VITE_DUCKLE_BACKEND=tauri
```

Recommended defaults:

| Environment | Default |
|---|---|
| Plain browser with no env | `mock` / UI-only |
| Browser with `VITE_DUCKLE_BACKEND=http` | HTTP bridge |
| Tauri webview | Tauri IPC |

Do not make browser mode silently depend on Tauri APIs. Browser mode should either call the HTTP bridge or return an explicit fallback.

## Recommended Daily Loop

For UI work:

```bash
npm --prefix frontend run dev
```

For browser UI with real execution, once implemented:

```bash
# terminal 1
cargo run -p duckle-runner -- serve --host 127.0.0.1 --port 8080 --workspace . --duckdb /path/to/duckdb

# terminal 2
VITE_DUCKLE_BACKEND=http VITE_DUCKLE_HTTP_URL=http://127.0.0.1:8080 npm --prefix frontend run dev
```

For desktop validation:

```bash
cd apps/desktop
cargo tauri dev
```

## Agent Rules

- Use `ui-only` for frontend-only implementation and visual QA.
- Use `ui-http` when a browser workflow needs real execution.
- Use `tauri` only when validating desktop-specific behavior.
- Keep Tauri IPC and HTTP bridge behavior aligned through one frontend runtime bridge API.
- Prefer explicit mode names over implicit environment guessing when debugging.
