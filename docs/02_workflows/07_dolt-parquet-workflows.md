# Dolt Parquet Workflows

This note defines the first Stitchly v2 Dolt workflow family.

The goal is to ingest Dolt repositories into durable Parquet artifacts in a way that is simple to build first, then progressively made idempotent and efficient.

Use this with:

- `docs/01_nodes/01_source-node-contracts.md`
- `docs/01_nodes/03_sink-node-contracts.md`
- `docs/01_nodes/04_quality-node-contracts.md`
- `docs/01_nodes/05_control-and-code-node-contracts.md`
- `docs/02_workflows/00_workflow-design-principles.md`
- `docs/03_runtime/04_runtime-specs.md`

## Design Position

Dolt should be treated as a versioned source system.

The workflow should not clone a database from scratch on every run. It should keep a persistent local clone, read the current Dolt commit, compare it to previously processed state, and only export when there is new work.

Parquet should be the durable interchange format.

DuckDB should be used for:

- reading staged Parquet artifacts,
- applying deltas,
- validating row counts and schema contracts,
- writing final Parquet outputs.

Shell nodes are acceptable for the first Dolt integration because Dolt is naturally CLI-driven. Once the pattern is stable, the shell pieces can be converted into first-class `src.dolt`, `xf.dolt.diff`, or `snk.dolt` nodes.

## Connector Rule

`snk.*` nodes are terminal connectors in v2. Do not design a workflow that expects to connect `snk.parquet` to a later state-update or logging node.

When a Dolt workflow needs to publish Parquet and then update sync state, use one of these shapes:

| Shape | Use when | Pattern |
|---|---|---|
| Terminal sink | No downstream state change is needed. | `validate -> ctl.log -> snk.parquet` |
| Pass-through checkpoint | A Parquet sidecar is enough and downstream nodes must continue. | `validate -> ctl.checkpoint -> code.shell commit_state -> ctl.log` |
| Shell publish step | Publication and state update must be atomic. | `validate -> code.shell publish_artifacts_and_commit_state -> ctl.log` |

For the Dolt workflows below, prefer the shell publish step first. It can move staged Parquet files into deterministic artifact paths, verify they exist, and update `.stitchly/state/dolt_sync.duckdb` in one controlled side-effect boundary.

## Workflow Family

| Workflow | Purpose | Status | Main output |
|---|---|---|---|
| `dolt.naive_snapshot_to_parquet` | Prove the Dolt CLI path with full-table exports. | First spike | Full Parquet snapshot per table. |
| `dolt.sync_repo_cache` | Maintain a persistent local clone and resolve commit state. | Foundation | Repo path, previous commit, current commit. |
| `dolt.plan_table_exports` | Decide which tables need export. | Foundation | Extraction plan table or JSON manifest. |
| `dolt.snapshot_changed_tables` | Export changed tables as full snapshots. | Useful v1 of efficient workflow | Per-table snapshot Parquet. |
| `dolt.delta_export_tables` | Export inserts, updates, and deletes between commits. | Later optimization | Per-table delta Parquet. |
| `dolt.apply_delta_to_current` | Apply Dolt deltas into a DuckDB current table. | Later optimization | Current DuckDB table and current Parquet. |
| `dolt.publish_artifacts` | Atomically publish final Parquet files and update manifest/state. | Required for idempotency | Published artifact manifest. |
| `dolt.master_sync` | Orchestrate repo sync, planning, extraction, validation, and publish. | Target workflow | End-to-end Dolt sync result. |

## Workspace Layout

Use deterministic paths so reruns are safe and inspectable.

```text
.stitchly/
  cache/
    dolt/
      <repo_key>/
        repo/
  state/
    dolt_sync.duckdb
  tmp/
    dolt/
      <run_id>/

artifacts/
  dolt/
    <repo_key>/
      <branch>/
        <table>/
          snapshots/
            commit=<commit_hash>/
              data.parquet
          deltas/
            from=<old_commit>_to=<new_commit>/
              inserts.parquet
              updates.parquet
              deletes.parquet
          current/
            data.parquet
            manifest.json
```

Required state table:

| Column | Purpose |
|---|---|
| `repo_key` | Stable local identifier for the remote Dolt repository. |
| `remote_url` | Dolt remote URL. |
| `branch` | Branch being synchronized. |
| `table_name` | Dolt table name. |
| `last_processed_commit` | Commit that has been successfully published. |
| `last_snapshot_commit` | Last commit with a full snapshot artifact. |
| `schema_hash` | Hash of the exported schema. |
| `artifact_manifest_path` | Latest published manifest path. |
| `row_count` | Published current row count. |
| `updated_at` | State update timestamp. |

State must be advanced only after artifacts and quality checks succeed.

## Workflow 1: Naive Snapshot to Parquet

Name: `dolt.naive_snapshot_to_parquet`

Purpose: create the simplest working Dolt workflow without trying to optimize. This is the first implementation target.

Graph:

```text
code.shell bootstrap/export
  -> code.sql inspect_exports
  -> qa.contract validate_exports
  -> ctl.log
  -> snk.parquet publish_snapshot
```

Node plan:

| Step | Node name | Node type | Config | Output |
|---|---|---|---|---|
| 1 | `bootstrap_export` | `code.shell` | Clone if missing, pull, export selected Dolt tables to staged CSV or Parquet. | One row with stdout, stderr, exit code. |
| 2 | `inspect_exports` | `code.sql` | Read staged files with DuckDB and normalize types. | Typed relation. |
| 3 | `validate_exports` | `qa.contract` | Required keys, not-null checks, row count floor. | Pass/fail relation. |
| 4 | `log_result` | `ctl.log` | Log table, commit, row count, output path before the terminal sink. | Run log. |
| 5 | `publish_snapshot` | `snk.parquet` | Write `artifacts/dolt/<repo>/<branch>/<table>/snapshots/commit=<head>/data.parquet`. | Terminal file side effect. |

Minimal shell behavior:

```bash
set -euo pipefail

repo_key="${REPO_KEY}"
remote_url="${REMOTE_URL}"
branch="${BRANCH:-main}"
table="${TABLE}"
cache_dir=".stitchly/cache/dolt/${repo_key}/repo"
stage_dir=".stitchly/tmp/dolt/${RUN_ID}/${table}"

mkdir -p "$(dirname "$cache_dir")" "$stage_dir"

if [ ! -d "$cache_dir/.dolt" ]; then
  dolt clone "$remote_url" "$cache_dir"
fi

cd "$cache_dir"
dolt checkout "$branch"
dolt pull

head_commit="$(dolt log -n 1 --format='%H')"
dolt sql -r csv -q "select * from \`${table}\`" > "${OLDPWD}/${stage_dir}/data.csv"

printf '{"repo_key":"%s","branch":"%s","table":"%s","head_commit":"%s","stage_path":"%s"}\n' \
  "$repo_key" "$branch" "$table" "$head_commit" "${stage_dir}/data.csv"
```

Naive limitations:

- It exports the whole table on each run.
- It rewrites the same output even when the commit is unchanged.
- It does not track per-table state.
- It does not distinguish inserts, updates, and deletes.
- It is useful for proving the Dolt CLI, paths, permissions, and Parquet publication.

## Workflow 2: Repo Cache Sync

Name: `dolt.sync_repo_cache`

Purpose: maintain a local Dolt clone and resolve previous/current commit state without exporting data.

Graph:

```text
code.shell sync_repo
  -> code.sql read_sync_state
  -> code.sql decide_skip_or_continue
  -> ctl.log
```

Node plan:

| Step | Node name | Node type | Config | Output |
|---|---|---|---|---|
| 1 | `sync_repo` | `code.shell` | `remote_url`, `repo_key`, `branch`, `cache_root`. Clone if missing, otherwise fetch/pull. | JSON metadata row in stdout. |
| 2 | `read_sync_state` | `code.sql` | Read `.stitchly/state/dolt_sync.duckdb` for previous processed commit. | `repo_key`, `branch`, `previous_commit`, `head_commit`. |
| 3 | `decide_skip_or_continue` | `code.sql` | Emit `should_skip = previous_commit = head_commit`. | Control row. |
| 4 | `log_sync_result` | `ctl.log` | Log cache path and commit comparison. | Run log. |

Recommended output columns:

| Column | Type | Notes |
|---|---|---|
| `repo_key` | text | Stable identifier. |
| `branch` | text | Dolt branch. |
| `repo_path` | text | Local clone path. |
| `previous_commit` | text nullable | Last successfully processed commit. |
| `head_commit` | text | Current Dolt commit. |
| `should_skip` | boolean | True when no extraction is needed. |

Idempotency rule:

If `should_skip = true`, downstream extraction should not run.

In the current v2 graph, this can be represented first as a `code.shell` no-op guard or a `ctl.switch` branch. If branching feels cumbersome, keep this workflow as a script node that exits successfully with a skip marker.

## Workflow 3: Plan Table Exports

Name: `dolt.plan_table_exports`

Purpose: decide which Dolt tables need extraction for a commit transition.

Graph:

```text
dolt.sync_repo_cache
  -> code.shell list_changed_tables
  -> code.sql build_export_plan
  -> snk.parquet write_plan
```

Node plan:

| Step | Node name | Node type | Config | Output |
|---|---|---|---|---|
| 1 | `sync_repo` | `ctl.runpipeline` or inlined `code.shell` | Runs `dolt.sync_repo_cache`. | Commit metadata. |
| 2 | `list_changed_tables` | `code.shell` | Use Dolt diff/status commands between previous and head commit. | Raw changed-table list. |
| 3 | `build_export_plan` | `code.sql` | Normalize changed tables into plan rows. | One row per table action. |
| 4 | `write_plan` | `snk.parquet` | Write plan to `.stitchly/tmp/dolt/<run_id>/export_plan.parquet`. | Plan artifact. |

Plan columns:

| Column | Type | Notes |
|---|---|---|
| `repo_key` | text | Repo identifier. |
| `branch` | text | Branch. |
| `table_name` | text | Dolt table. |
| `previous_commit` | text nullable | Previous processed commit. |
| `head_commit` | text | Current commit. |
| `export_mode` | text | `snapshot`, `delta`, or `skip`. |
| `reason` | text | `initial_load`, `changed`, `schema_changed`, `unchanged`, `forced`. |
| `snapshot_path` | text | Deterministic target path for snapshot. |
| `delta_path` | text nullable | Deterministic target path for delta files. |

Initial logic:

| Condition | Export mode |
|---|---|
| No previous commit exists | `snapshot` |
| Table has no previous state | `snapshot` |
| Schema changed | `snapshot` |
| Table data changed and delta support is enabled | `delta` |
| Table data changed and delta support is not enabled | `snapshot` |
| No data/schema change | `skip` |

## Workflow 4: Snapshot Changed Tables

Name: `dolt.snapshot_changed_tables`

Purpose: efficient first production version. It avoids reprocessing unchanged commits/tables but still exports full snapshots for changed tables.

Graph:

```text
dolt.plan_table_exports
  -> code.shell export_snapshots
  -> src.parquet read_staged_snapshots
  -> qa.contract validate_snapshot
  -> code.shell publish_snapshot_and_commit_state
  -> ctl.log
```

Node plan:

| Step | Node name | Node type | Config | Output |
|---|---|---|---|---|
| 1 | `plan_exports` | `ctl.runpipeline` or inlined nodes | Produce export plan. | Plan rows. |
| 2 | `export_snapshots` | `code.shell` | For plan rows where `export_mode = snapshot`, run Dolt SQL exports. | Staged files and metadata. |
| 3 | `read_staged_snapshots` | `src.parquet` or `code.sql` | Read staged Parquet/CSV exports. | Typed table rows. |
| 4 | `validate_snapshot` | `qa.contract` | Required keys, expected row count, optional schema hash. | Validated rows. |
| 5 | `publish_snapshot_and_commit_state` | `code.shell` | Copy/move staged Parquet to deterministic artifact paths, verify files, then update `.stitchly/state/dolt_sync.duckdb`. | Publish result rows. |
| 6 | `log_snapshot_publish` | `ctl.log` | Log published tables, commit, and artifact paths. | Run log. |

Preferred staged format:

Use Parquet if the Dolt CLI export path can produce it directly in the local environment. If not, export CSV and immediately convert to staged Parquet with DuckDB before validation.

Publication rule:

Write to staging first:

```text
.stitchly/tmp/dolt/<run_id>/<table>/snapshot.parquet
```

Then publish to deterministic final path:

```text
artifacts/dolt/<repo_key>/<branch>/<table>/snapshots/commit=<head_commit>/data.parquet
```

If the final path already exists for the same commit, reuse it instead of rewriting it.

State update rule:

Because `snk.parquet` is terminal, do not put state update downstream of a sink. For this workflow, `publish_snapshot_and_commit_state` should be a shell node that performs the final artifact move and state update together. If a later first-class state node exists, this can become `ctl.checkpoint -> state.commit -> ctl.log`.

## Workflow 5: Delta Export Tables

Name: `dolt.delta_export_tables`

Purpose: avoid full table exports by extracting row-level changes between two Dolt commits.

Graph:

```text
dolt.plan_table_exports
  -> code.shell export_dolt_diffs
  -> code.sql normalize_delta_files
  -> qa.contract validate_delta
  -> snk.parquet publish_delta
```

Node plan:

| Step | Node name | Node type | Config | Output |
|---|---|---|---|---|
| 1 | `plan_exports` | `ctl.runpipeline` or inlined nodes | Plan tables with `export_mode = delta`. | Delta plan rows. |
| 2 | `export_dolt_diffs` | `code.shell` | Run Dolt diff SQL/CLI between `previous_commit` and `head_commit`. | Staged insert/update/delete files. |
| 3 | `normalize_delta_files` | `code.sql` | Normalize change records to a standard delta schema. | Delta rows. |
| 4 | `validate_delta` | `qa.contract` | Ensure key columns and operation values are present. | Valid delta rows. |
| 5 | `publish_delta` | `snk.parquet` | Write delta files under `deltas/from=<old>_to=<new>/`. | Delta artifacts. |

Standard delta columns:

| Column | Type | Notes |
|---|---|---|
| `_dolt_op` | text | `insert`, `update`, `delete`. |
| `_dolt_from_commit` | text | Previous processed commit. |
| `_dolt_to_commit` | text | Current head commit. |
| `_dolt_table` | text | Source table. |
| `_row_hash` | text | Hash of current row values for insert/update, previous values for delete if available. |
| Business key columns | source type | Required for deterministic merge. |
| Data columns | source type | Current row values for insert/update. |

Restriction:

Delta mode requires stable key columns. If no stable key exists, fall back to full snapshot for that table.

## Workflow 6: Apply Delta to Current

Name: `dolt.apply_delta_to_current`

Purpose: materialize the latest table state from the prior current Parquet plus published delta files.

Graph:

```text
src.parquet read_current
  -> src.parquet read_delta
  -> code.sql apply_merge
  -> qa.contract validate_current
  -> snk.parquet publish_current
```

Node plan:

| Step | Node name | Node type | Config | Output |
|---|---|---|---|---|
| 1 | `read_current` | `src.parquet` | Current Parquet path for table. | Existing current rows. |
| 2 | `read_delta` | `src.parquet` | Delta Parquet path. | Change rows. |
| 3 | `apply_merge` | `code.sql` | Delete rows matching delete/update keys, then union inserts/updates. | New current rows. |
| 4 | `validate_current` | `qa.contract` | Key uniqueness, not-null keys, row count sanity. | Valid current rows. |
| 5 | `publish_current` | `snk.parquet` | Write staged current, then final current. | Current artifact. |

Merge shape:

```sql
with affected_keys as (
  select distinct business_key
  from delta
),
survivors as (
  select c.*
  from current c
  left join affected_keys k using (business_key)
  where k.business_key is null
),
upserts as (
  select * exclude (_dolt_op, _dolt_from_commit, _dolt_to_commit, _dolt_table, _row_hash)
  from delta
  where _dolt_op in ('insert', 'update')
)
select * from survivors
union all
select * from upserts;
```

For large tables, partition `current` and only rewrite affected partitions. Do not design that first unless table size forces it.

## Workflow 7: Publish Artifacts and Commit State

Name: `dolt.publish_artifacts`

Purpose: make publication atomic from the workflow perspective.

Graph:

```text
src.parquet read_state_candidates
  -> qa.contract validate_publish_manifest
  -> code.shell move_or_reuse_artifacts
  -> code.shell commit_dolt_state
  -> ctl.log
```

Node plan:

| Step | Node name | Node type | Config | Output |
|---|---|---|---|---|
| 1 | `read_state_candidates` | `src.parquet` | Reads staged state candidate file. | Candidate state rows. |
| 2 | `validate_publish_manifest` | `qa.contract` | Validate commit, table, artifact path, row count. | Valid candidates. |
| 3 | `move_or_reuse_artifacts` | `code.shell` | Move staged outputs to final deterministic paths if absent. Reuse existing same-commit files. | Publish result rows. |
| 4 | `commit_dolt_state` | `code.shell` | Update `.stitchly/state/dolt_sync.duckdb` through DuckDB CLI after artifact publication succeeds. | New state rows. |
| 5 | `log_publish` | `ctl.log` | Log updated tables and commit. | Run log. |

State commit rule:

Never update `last_processed_commit` before all selected table artifacts are published and validated.

## Workflow 8: Master Sync

Name: `dolt.master_sync`

Purpose: one runnable workflow for local studio use.

Graph:

```text
dolt.sync_repo_cache
  -> dolt.plan_table_exports
  -> dolt.snapshot_changed_tables
  -> dolt.delta_export_tables
  -> dolt.apply_delta_to_current
  -> dolt.publish_artifacts
```

Practical first version:

```text
sync_repo_cache
  -> plan_table_exports
  -> snapshot_changed_tables
  -> publish_artifacts
```

Then add delta support after the snapshot workflow is stable.

Master config:

| Config | Required | Example | Notes |
|---|---|---|---|
| `repo_key` | yes | `liquibase_sample` | Filesystem-safe identifier. |
| `remote_url` | yes | `https://doltremoteapi.dolthub.com/...` | Dolt remote. |
| `branch` | yes | `main` | Branch to sync. |
| `tables` | yes | `["customers", "orders"]` | Explicit allowlist first. |
| `key_columns` | later | `{ "orders": ["order_id"] }` | Required for delta merge. |
| `cache_root` | yes | `.stitchly/cache/dolt` | Persistent clone root. |
| `artifact_root` | yes | `artifacts/dolt` | Published Parquet root. |
| `state_db` | yes | `.stitchly/state/dolt_sync.duckdb` | Durable sync state. |
| `mode` | yes | `snapshot_changed_tables` | Later: `delta`. |
| `force_snapshot` | no | `false` | Force full snapshot for selected tables. |

## Recommended Build Plan

| Phase | Build | Result |
|---|---|---|
| 1 | `dolt.naive_snapshot_to_parquet` for one table. | Proves CLI, local cache, export, DuckDB read, Parquet write. |
| 2 | Add `dolt.sync_repo_cache` state check. | Skips unchanged commits. |
| 3 | Add `dolt.plan_table_exports` for explicit table allowlist. | Avoids unnecessary table exports. |
| 4 | Add `dolt.snapshot_changed_tables`. | Efficient enough for practical use without row-level delta complexity. |
| 5 | Add `dolt.publish_artifacts`. | Proper idempotent publishing and state advance. |
| 6 | Add `dolt.delta_export_tables` and `dolt.apply_delta_to_current`. | Avoids full exports when keys and Dolt diffs are reliable. |
| 7 | Convert stable shell logic into first-class Dolt nodes. | Better UI, validation, and agent generation. |

## Agent Rules

- Start with explicit table allowlists. Do not default to every table in a Dolt repo.
- Use commit hashes in output paths.
- Keep clone/cache paths separate from published artifacts.
- Treat `.stitchly/state/dolt_sync.duckdb` as the source of processed-state truth.
- Do not advance state until all final artifacts are published.
- Prefer Parquet for staged and published data.
- Use shell nodes for Dolt CLI operations until first-class Dolt nodes exist.
- Use DuckDB SQL nodes for validation, row counts, schema hashes, and delta application.
- Use full-table snapshots before building row-level delta mode.
- Fall back to snapshot mode when key columns are missing or schema changes.

## Open Questions

- Exact Dolt CLI commands for stable row-level diff export need to be tested against target repositories.
- Exact raw workflow JSON property names should be verified from a saved v2 workflow before generating these automatically.
- We need to decide whether Dolt state lives in a shared `.stitchly/state/dolt_sync.duckdb` or per-workflow state DB.
- We need sample Dolt repositories and expected outputs for regression testing.
