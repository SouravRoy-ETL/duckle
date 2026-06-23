# HTTP Runtime Bridge

This note defines the planned HTTP bridge that lets the browser studio run real workflows without launching the Tauri desktop shell.

## Problem

The current frontend execution path is Tauri IPC:

```text
React app
  -> @tauri-apps/api invoke(...)
  -> apps/desktop Rust command
  -> DuckdbEngine
  -> DuckDB CLI
```

That path only works inside the Tauri webview. A normal browser at `http://localhost:5173/` cannot call Tauri commands.

For faster local development, we want:

```text
React app in browser
  -> HTTP API on localhost
  -> DuckdbEngine / duckle-runner
  -> DuckDB CLI
```

## Preferred Implementation

Extend the existing `duckle-runner serve` command first.

Existing command:

```bash
duckle-runner serve \
  --host 127.0.0.1 \
  --port 8080 \
  --workspace /path/to/workspace \
  --duckdb /path/to/duckdb
```

Existing server purpose:

- serve a small operations panel,
- discover saved pipeline JSON files,
- run saved pipelines,
- show run history and logs,
- manage simple interval schedules.

The bridge should add browser-studio endpoints while reusing the same engine and workspace model.

## Proposed Endpoints

| Endpoint | Purpose | Priority |
|---|---|---|
| `GET /api/studio/health` | Confirm bridge is reachable and report workspace/DuckDB path. | High |
| `POST /api/studio/run` | Execute an in-memory `PipelineDoc` from the current canvas. | High |
| `POST /api/studio/run-partial` | Execute upstream graph through a selected node. | High |
| `POST /api/studio/compile` | Return generated stage SQL for the Plan view. | High |
| `POST /api/studio/autodetect` | Infer schema/sample rows for source configuration. | Medium |
| `GET /api/studio/history` | Return run history for a workspace/pipeline id. | Medium |
| `POST /api/studio/cancel` | Cancel the active interactive run. | Medium |

Initial implementation can return final run results only. Streaming live node events can be added later.

## Request Shapes

Run current graph:

```json
{
  "pipeline": {
    "nodes": [],
    "edges": []
  },
  "pipelineId": "pipeline-id-or-null",
  "pipelineName": "display-name-or-null",
  "workspacePath": "/path/to/workspace-or-null"
}
```

Run partial graph:

```json
{
  "pipeline": {
    "nodes": [],
    "edges": []
  },
  "targetNodeId": "node-id",
  "pipelineId": "pipeline-id-or-null",
  "pipelineName": "display-name-or-null",
  "workspacePath": "/path/to/workspace-or-null"
}
```

Compile graph:

```json
{
  "pipeline": {
    "nodes": [],
    "edges": []
  }
}
```

Autodetect:

```json
{
  "format": "csv",
  "options": {
    "path": "/path/to/file.csv"
  }
}
```

## Response Compatibility

HTTP responses should match the existing frontend TypeScript types where possible:

- `RunResult`
- `PipelineEvent` if streaming is later added
- `StageSql`
- `RunRecord`
- autodetect `{ columns, sampleRows }`

The goal is for the frontend runtime bridge to choose a transport without changing app components.

```text
runPipeline(...)
  -> Tauri IPC in desktop mode
  -> HTTP fetch in browser-runtime mode
  -> null/mock in UI-only mode
```

## Frontend Integration

Current frontend API:

- `frontend/src/tauri-bridge.ts`

Target frontend shape:

```text
frontend/src/runtime-bridge.ts
  runtime mode detection
  common exported functions
  Tauri transport
  HTTP transport
  mock/browser fallback transport
```

Mode selection should be explicit:

```text
VITE_DUCKLE_BACKEND=mock
VITE_DUCKLE_BACKEND=http
VITE_DUCKLE_BACKEND=tauri
VITE_DUCKLE_HTTP_URL=http://127.0.0.1:8080
```

Tauri mode should still be selected automatically when running inside the desktop shell unless overridden for debugging.

## CORS

The HTTP bridge must allow the Vite dev origin:

```text
http://localhost:5173
http://127.0.0.1:5173
```

For local development, permissive localhost CORS is acceptable. Do not expose the bridge beyond localhost without authentication.

## Execution Model

The HTTP bridge should use the same core engine path as Tauri:

```text
HTTP request
  -> PipelineDoc
  -> DuckdbEngine::execute_pipeline...
  -> DuckDB CLI
  -> RunResult
```

For the first version, serialize interactive runs with a lock. The existing runner server already serializes saved pipeline runs because workspace env vars and run state are shared.

## Streaming Later

Tauri currently streams run events over a `Channel`.

The HTTP bridge can later support the same event model through:

- Server-Sent Events,
- NDJSON streaming,
- WebSocket.

Recommended first streaming option: NDJSON or SSE.

Until streaming exists, the frontend should:

1. set nodes to a coarse running state,
2. wait for final `RunResult`,
3. update node statuses from the final response.

## Security

The bridge can run arbitrary workflow nodes, including `code.shell`.

Rules:

- bind to `127.0.0.1` by default,
- do not use `0.0.0.0` without explicit user intent,
- do not add remote access before authentication exists,
- treat all requests as local developer control-plane requests,
- avoid exposing secrets in compile/plan responses.

## Phased Implementation Plan

Build this endpoint-first. Each phase should be runnable and testable before moving to the next one.

### Phase 0: Prove Existing Runner Server

Goal: verify the current `duckle-runner serve` path works before adding studio endpoints.

Implementation:

- No code changes.
- Start the existing runner server.
- Confirm current management-panel APIs respond.

Command:

```bash
cargo run -p duckle-runner -- serve \
  --host 127.0.0.1 \
  --port 8080 \
  --workspace . \
  --duckdb /path/to/duckdb
```

Checks:

```bash
curl http://127.0.0.1:8080/api/summary
curl http://127.0.0.1:8080/api/pipelines
```

Exit criteria:

- Runner server starts.
- Existing JSON endpoints respond.
- DuckDB path is resolved.

### Phase 1: Health and CORS

Goal: make the browser studio able to detect the bridge.

Implementation:

- Add CORS headers for local Vite origins.
- Add `OPTIONS` handling.
- Add `GET /api/studio/health`.

Endpoint:

```text
GET /api/studio/health
```

Example response:

```json
{
  "ok": true,
  "mode": "duckle-runner-serve",
  "workspace": "/path/to/workspace",
  "duckdb": "/path/to/duckdb"
}
```

Checks:

```bash
curl http://127.0.0.1:8080/api/studio/health
curl -i -X OPTIONS http://127.0.0.1:8080/api/studio/health
```

Exit criteria:

- Browser-origin requests from `localhost:5173` are allowed.
- Health endpoint reports bridge/workspace/DuckDB state.

### Phase 2: Compile Endpoint

Goal: validate planner access without executing a workflow.

Implementation:

- Add `POST /api/studio/compile`.
- Parse request body into `PipelineDoc`.
- Return `compile_pipeline_sql` result.

Endpoint:

```text
POST /api/studio/compile
```

Request:

```json
{
  "pipeline": {
    "nodes": [],
    "edges": []
  }
}
```

Checks:

```bash
curl -X POST http://127.0.0.1:8080/api/studio/compile \
  -H 'content-type: application/json' \
  -d @sample-compile-request.json
```

Exit criteria:

- Valid pipelines return stage SQL.
- Invalid pipelines return clear planner errors.
- No DuckDB execution happens.

### Phase 3: Final-Result Run Endpoint

Goal: run the current browser canvas graph through the headless runtime.

Implementation:

- Add `POST /api/studio/run`.
- Parse request body into `PipelineDoc`.
- Execute with `DuckdbEngine`.
- Return final `RunResult`.
- Record run history when `pipelineId` and workspace are provided.
- Serialize interactive runs with a lock.

Endpoint:

```text
POST /api/studio/run
```

Request:

```json
{
  "pipeline": {
    "nodes": [],
    "edges": []
  },
  "pipelineId": "example",
  "pipelineName": "Example",
  "workspacePath": "/path/to/workspace"
}
```

Checks:

```bash
curl -X POST http://127.0.0.1:8080/api/studio/run \
  -H 'content-type: application/json' \
  -d @sample-run-request.json
```

Exit criteria:

- Simple file/SQL workflows execute successfully.
- Failed workflows return structured `RunResult` errors.
- No live events are required yet.

### Phase 4: Frontend HTTP Transport

Goal: let the React studio use the HTTP bridge.

Implementation:

- Add explicit backend mode selection.
- Add HTTP transport for at least:
  - `runPipeline`,
  - `compilePipelineSql`.
- Keep Tauri IPC behavior unchanged in desktop mode.
- Keep mock/null fallbacks for `ui-only`.

Environment:

```text
VITE_DUCKLE_BACKEND=http
VITE_DUCKLE_HTTP_URL=http://127.0.0.1:8080
```

Check:

```bash
VITE_DUCKLE_BACKEND=http \
VITE_DUCKLE_HTTP_URL=http://127.0.0.1:8080 \
npm --prefix frontend run dev
```

Exit criteria:

- Browser studio can compile a pipeline through HTTP.
- Browser studio can run a simple pipeline through HTTP.
- Tauri mode still uses IPC.
- UI-only mode still works without a bridge.

### Phase 5: Partial Run and Preview

Goal: support run-to-node and preview workflows from browser mode.

Implementation:

- Add `POST /api/studio/run-partial`.
- Execute upstream subgraph through `targetNodeId`.
- Return final `RunResult` with preview rows.

Endpoint:

```text
POST /api/studio/run-partial
```

Checks:

```bash
curl -X POST http://127.0.0.1:8080/api/studio/run-partial \
  -H 'content-type: application/json' \
  -d @sample-run-partial-request.json
```

Exit criteria:

- Browser mode can preview selected nodes.
- Partial execution matches Tauri behavior for the same graph.

### Phase 6: Autodetect

Goal: make browser-mode source configuration useful with real files.

Implementation:

- Add `POST /api/studio/autodetect`.
- Route to the same schema inspection behavior exposed by the Tauri command.
- Return `{ columns, sampleRows }`.

Endpoint:

```text
POST /api/studio/autodetect
```

Checks:

```bash
curl -X POST http://127.0.0.1:8080/api/studio/autodetect \
  -H 'content-type: application/json' \
  -d '{"format":"csv","options":{"path":"/path/to/file.csv"}}'
```

Exit criteria:

- CSV/Parquet/JSON source setup works from browser mode.
- Missing files return clear errors.

### Phase 7: History and Logs

Goal: make bottom-panel and run-history views useful in browser-runtime mode.

Implementation:

- Add studio-shaped history/log endpoints or adapt the existing runner endpoints.
- Keep response shapes close to frontend `RunRecord` and log types.

Endpoints:

```text
GET /api/studio/history
GET /api/studio/logs
```

Exit criteria:

- Browser mode can show previous runs.
- Browser mode can show runtime logs for a selected pipeline.

### Phase 8: Cancel

Goal: stop long-running browser-triggered workflows.

Implementation:

- Add active-run tracking for studio runs.
- Add `POST /api/studio/cancel`.
- Scope cancellation to the current interactive run where possible.

Endpoint:

```text
POST /api/studio/cancel
```

Exit criteria:

- Cancelling a long-running workflow returns a cancelled result.
- A stale cancel request does not cancel future runs.

### Phase 9: Streaming Events

Goal: restore Tauri-like live node status in browser-runtime mode.

Implementation options:

- Server-Sent Events,
- NDJSON streaming,
- WebSocket.

Recommended first option: SSE or NDJSON.

Events should match the existing `PipelineEvent` type:

```text
started
stage_started
stage_finished
log
cancelled
finished
```

Exit criteria:

- Browser nodes update while a run is in progress.
- Final `RunResult` remains available.
- Tauri and HTTP transports expose equivalent event semantics to the UI.

## Recommended First Slice

Implement phases 1 through 4 first:

```text
health -> compile -> run -> frontend HTTP transport
```

This creates a useful browser runtime loop without solving previews, autodetect, cancel, history, or streaming immediately.

## Open Questions

- Whether to keep extending `duckle-runner serve` or split a dedicated `duckle-http-bridge` binary later.
- Whether browser-runtime mode should write run history using `workspacePath` from the frontend or the bridge's configured workspace.
- Whether cancellation should be process-wide or scoped to the latest interactive request.
- Whether the first implementation should support live events immediately or final results only.
