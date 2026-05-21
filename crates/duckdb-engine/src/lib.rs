//! Duckle DuckDB engine adapter.
//!
//! Holds a single in-process DuckDB connection and lends it out to
//! callers that need to inspect a source's schema, sample its rows, or
//! eventually execute a full pipeline plan.
//!
//! Most heavy lifting (CSV inference, Parquet schema, JSON inference,
//! SQLite scanning) is delegated to DuckDB's own readers via SQL like
//! `DESCRIBE SELECT * FROM read_csv_auto('...')`. This means we get
//! DuckDB's mature dialect inference for free instead of re-implementing
//! it in Rust.

use async_trait::async_trait;
use duckdb::Connection;
use duckle_metadata::{Column, DataType};
use duckle_plugin_sdk::{Inspection, InspectError};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as JsonValue};
use std::sync::{Arc, Mutex};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("duckdb: {0}")]
    Duck(#[from] duckdb::Error),
    #[error("config: {0}")]
    Config(String),
    #[error("unsupported: {0}")]
    Unsupported(String),
}

impl From<EngineError> for InspectError {
    fn from(err: EngineError) -> Self {
        match err {
            EngineError::Config(m) => InspectError::Config(m),
            EngineError::Unsupported(m) => InspectError::Unsupported(m),
            other => InspectError::Other(other.to_string()),
        }
    }
}

/// Sample rows fetched alongside the schema for the Preview tab.
const PREVIEW_LIMIT: usize = 8;

/// Source-format / target-system dispatcher used by the autodetect Tauri
/// command. New formats only need a new arm here.
#[derive(Debug, Clone)]
pub struct DuckdbEngine {
    conn: Arc<Mutex<Connection>>,
}

impl DuckdbEngine {
    /// Create a fresh in-memory DuckDB instance. The engine is process-
    /// global, but each `inspect_*` call uses isolated SQL so multiple
    /// runs don't trample each other.
    pub fn new() -> Result<Self, EngineError> {
        let conn = Connection::open_in_memory()?;
        // Best-effort: load extensions we use lazily.
        let _ = conn.execute_batch("INSTALL sqlite; LOAD sqlite;");
        let _ = conn.execute_batch("INSTALL json; LOAD json;");
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Run an arbitrary closure with the underlying connection. Locked
    /// across the closure so we can hold prepared statements safely.
    pub fn with_connection<R>(&self, f: impl FnOnce(&Connection) -> R) -> R {
        let guard = self.conn.lock().expect("duckdb connection poisoned");
        f(&guard)
    }

    /// Inspect a source for its schema and a small preview. `format` is
    /// the same string the frontend ships (`"csv"`, `"parquet"`, ...).
    pub fn inspect(&self, format: &str, options: JsonValue) -> Result<Inspection, EngineError> {
        match format {
            "csv" | "tsv" => self.inspect_csv(options),
            "parquet" => self.inspect_parquet(options),
            "json" | "jsonl" | "ndjson" => self.inspect_json(options),
            "sqlite" => self.inspect_sqlite(options),
            "duckdb" => self.inspect_duckdb(options),
            other => Err(EngineError::Unsupported(format!(
                "Format '{}' is not supported by the DuckDB engine yet",
                other
            ))),
        }
    }

    fn inspect_csv(&self, options: JsonValue) -> Result<Inspection, EngineError> {
        #[derive(Debug, Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Opts {
            path: String,
            #[serde(default = "yes")]
            has_header: bool,
            #[serde(default)]
            delimiter: Option<String>,
            #[serde(default)]
            quote_char: Option<String>,
            #[serde(default)]
            null_value: Option<String>,
            #[serde(default)]
            skip_lines: Option<u32>,
            #[serde(default)]
            encoding: Option<String>,
        }
        fn yes() -> bool {
            true
        }

        let opts: Opts =
            serde_json::from_value(options).map_err(|e| EngineError::Config(e.to_string()))?;
        let mut args = vec![format!("'{}'", sql_escape(&opts.path))];
        args.push(format!("header={}", opts.has_header));
        if let Some(d) = &opts.delimiter {
            args.push(format!("delim='{}'", sql_escape(d)));
        }
        if let Some(q) = &opts.quote_char {
            if !q.is_empty() {
                args.push(format!("quote='{}'", sql_escape(q)));
            }
        }
        if let Some(n) = &opts.null_value {
            if !n.is_empty() {
                args.push(format!("nullstr='{}'", sql_escape(n)));
            }
        }
        if let Some(s) = opts.skip_lines {
            if s > 0 {
                args.push(format!("skip={}", s));
            }
        }
        if let Some(e) = opts.encoding {
            if !e.is_empty() {
                args.push(format!("encoding='{}'", sql_escape(&e)));
            }
        }
        let from = format!("read_csv_auto({})", args.join(", "));
        self.describe_and_preview(&from)
    }

    fn inspect_parquet(&self, options: JsonValue) -> Result<Inspection, EngineError> {
        #[derive(Debug, Deserialize)]
        struct Opts {
            path: String,
        }
        let opts: Opts =
            serde_json::from_value(options).map_err(|e| EngineError::Config(e.to_string()))?;
        let from = format!("read_parquet('{}')", sql_escape(&opts.path));
        self.describe_and_preview(&from)
    }

    fn inspect_json(&self, options: JsonValue) -> Result<Inspection, EngineError> {
        #[derive(Debug, Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Opts {
            path: String,
            #[serde(default)]
            format: Option<String>,
        }
        let opts: Opts =
            serde_json::from_value(options).map_err(|e| EngineError::Config(e.to_string()))?;
        let mut args = vec![format!("'{}'", sql_escape(&opts.path))];
        if let Some(fmt) = opts.format.as_deref() {
            let mapped = match fmt {
                "array" => "array",
                "jsonl" | "ndjson" => "newline_delimited",
                "object" => "unstructured",
                _ => "auto",
            };
            args.push(format!("format='{}'", mapped));
        }
        let from = format!("read_json_auto({})", args.join(", "));
        self.describe_and_preview(&from)
    }

    fn inspect_sqlite(&self, options: JsonValue) -> Result<Inspection, EngineError> {
        #[derive(Debug, Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Opts {
            database: String,
            mode: Option<String>,
            schema_name: Option<String>,
            table_name: Option<String>,
            sql: Option<String>,
        }
        let opts: Opts =
            serde_json::from_value(options).map_err(|e| EngineError::Config(e.to_string()))?;
        let from = match opts.mode.as_deref().unwrap_or("table") {
            "sql" => {
                let sql = opts
                    .sql
                    .ok_or_else(|| EngineError::Config("SQL query is required".into()))?;
                format!("sqlite_scan('{}', '{}')", sql_escape(&opts.database), sql_escape(&sql))
            }
            _ => {
                let table = opts
                    .table_name
                    .ok_or_else(|| EngineError::Config("Table name is required".into()))?;
                let qualified = match opts.schema_name {
                    Some(s) if !s.is_empty() => format!("{}.{}", s, table),
                    _ => table,
                };
                format!(
                    "sqlite_scan('{}', '{}')",
                    sql_escape(&opts.database),
                    sql_escape(&qualified)
                )
            }
        };
        self.describe_and_preview(&from)
    }

    fn inspect_duckdb(&self, options: JsonValue) -> Result<Inspection, EngineError> {
        #[derive(Debug, Deserialize)]
        struct Opts {
            database: String,
            sql: Option<String>,
        }
        let opts: Opts =
            serde_json::from_value(options).map_err(|e| EngineError::Config(e.to_string()))?;
        // Attach the other DB file and run user SQL (or SELECT *) against it.
        self.with_connection(|conn| -> Result<Inspection, EngineError> {
            conn.execute_batch(&format!(
                "ATTACH '{}' AS source_db (READ_ONLY);",
                sql_escape(&opts.database)
            ))?;
            let result = (|| -> Result<Inspection, EngineError> {
                let sql = opts
                    .sql
                    .as_deref()
                    .unwrap_or("SELECT 1 AS placeholder LIMIT 0");
                let from = format!("({})", sql);
                self.describe_and_preview(&from)
            })();
            let _ = conn.execute_batch("DETACH source_db;");
            result
        })
    }

    fn describe_and_preview(&self, from_clause: &str) -> Result<Inspection, EngineError> {
        self.with_connection(|conn| -> Result<Inspection, EngineError> {
            let schema = read_schema(conn, from_clause)?;
            let sample_rows = read_preview(conn, from_clause, &schema, PREVIEW_LIMIT)?;
            Ok(Inspection {
                schema,
                sample_rows,
            })
        })
    }
}

fn read_schema(conn: &Connection, from_clause: &str) -> Result<Vec<Column>, EngineError> {
    let mut stmt = conn.prepare(&format!("DESCRIBE SELECT * FROM {}", from_clause))?;
    let rows = stmt.query_map([], |row| {
        let name: String = row.get(0)?;
        let type_name: String = row.get(1)?;
        let null_flag: String = row.get(2).unwrap_or_else(|_| "YES".to_string());
        Ok((name, type_name, null_flag))
    })?;
    let mut columns = Vec::new();
    for row in rows {
        let (name, type_name, null_flag) = row?;
        columns.push(Column {
            name,
            data_type: map_duckdb_type(&type_name),
            nullable: !null_flag.eq_ignore_ascii_case("NO"),
            primary_key: None,
        });
    }
    Ok(columns)
}

fn read_preview(
    conn: &Connection,
    from_clause: &str,
    schema: &[Column],
    limit: usize,
) -> Result<Vec<JsonValue>, EngineError> {
    if schema.is_empty() {
        return Ok(Vec::new());
    }
    let column_list = schema
        .iter()
        .map(|c| format!("\"{}\"", c.name.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT {} FROM {} LIMIT {}",
        column_list, from_clause, limit
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let mut map = Map::with_capacity(schema.len());
        for (idx, col) in schema.iter().enumerate() {
            let value = duckdb_value_to_json(row, idx);
            map.insert(col.name.clone(), value);
        }
        out.push(JsonValue::Object(map));
    }
    Ok(out)
}

fn map_duckdb_type(t: &str) -> DataType {
    // DuckDB type names are uppercase but may include parameters: VARCHAR,
    // INTEGER, BIGINT, DECIMAL(10,2), TIMESTAMP_NS, etc.
    let upper = t.to_uppercase();
    let base = upper.split('(').next().unwrap_or(&upper).trim();
    match base {
        "BOOLEAN" | "BOOL" => DataType::Bool,
        "TINYINT" | "SMALLINT" | "INTEGER" | "INT" | "INT4" | "INT2" | "UTINYINT" | "USMALLINT"
        | "UINTEGER" => DataType::Int32,
        "BIGINT" | "INT8" | "HUGEINT" | "UBIGINT" => DataType::Int64,
        "REAL" | "FLOAT" | "FLOAT4" => DataType::Float32,
        "DOUBLE" | "FLOAT8" => DataType::Float64,
        "DECIMAL" | "NUMERIC" => DataType::Decimal,
        "DATE" => DataType::Date,
        "TIME" => DataType::Time,
        "TIMESTAMP" | "TIMESTAMP_S" | "TIMESTAMP_MS" | "TIMESTAMP_NS" | "TIMESTAMP_US"
        | "TIMESTAMPTZ" | "TIMESTAMP WITH TIME ZONE" => DataType::Timestamp,
        "JSON" | "MAP" | "STRUCT" | "LIST" | "ARRAY" => DataType::Json,
        "BLOB" | "VARBINARY" => DataType::Binary,
        _ => DataType::String,
    }
}

fn duckdb_value_to_json(row: &duckdb::Row<'_>, idx: usize) -> JsonValue {
    use duckdb::types::Value;
    let value: Value = match row.get::<usize, Value>(idx) {
        Ok(v) => v,
        Err(_) => return JsonValue::Null,
    };
    match value {
        Value::Null => JsonValue::Null,
        Value::Boolean(b) => JsonValue::Bool(b),
        Value::TinyInt(n) => JsonValue::from(n),
        Value::SmallInt(n) => JsonValue::from(n),
        Value::Int(n) => JsonValue::from(n),
        Value::BigInt(n) => JsonValue::from(n),
        Value::HugeInt(n) => JsonValue::String(n.to_string()),
        Value::UTinyInt(n) => JsonValue::from(n),
        Value::USmallInt(n) => JsonValue::from(n),
        Value::UInt(n) => JsonValue::from(n),
        Value::UBigInt(n) => JsonValue::String(n.to_string()),
        Value::Float(f) => serde_json::Number::from_f64(f as f64)
            .map(JsonValue::Number)
            .unwrap_or(JsonValue::Null),
        Value::Double(f) => serde_json::Number::from_f64(f)
            .map(JsonValue::Number)
            .unwrap_or(JsonValue::Null),
        Value::Decimal(d) => JsonValue::String(d.to_string()),
        Value::Timestamp(_, _) | Value::Date32(_) | Value::Time64(_, _) => {
            JsonValue::String(format!("{:?}", value))
        }
        Value::Text(s) => JsonValue::String(s),
        Value::Blob(b) => JsonValue::String(format!("<{} bytes>", b.len())),
        other => JsonValue::String(format!("{:?}", other)),
    }
}

fn sql_escape(s: &str) -> String {
    s.replace('\'', "''")
}

/// Convenience: a [`SchemaInspector`] impl backed by [`DuckdbEngine`].
/// Used by the desktop autodetect command.
pub struct DuckdbInspector {
    engine: DuckdbEngine,
    format: String,
}

impl DuckdbInspector {
    pub fn new(engine: DuckdbEngine, format: impl Into<String>) -> Self {
        Self {
            engine,
            format: format.into(),
        }
    }
}

#[async_trait]
impl duckle_plugin_sdk::SchemaInspector for DuckdbInspector {
    fn component_id(&self) -> &str {
        &self.format
    }

    async fn inspect(
        &self,
        config: JsonValue,
    ) -> Result<Inspection, InspectError> {
        let engine = self.engine.clone();
        let format = self.format.clone();
        tokio::task::spawn_blocking(move || engine.inspect(&format, config))
            .await
            .map_err(|e| InspectError::Other(e.to_string()))?
            .map_err(Into::into)
    }
}

/// Lightweight serializable preview row — useful in tests + the
/// downstream Tauri command output.
#[derive(Debug, Serialize)]
pub struct PreviewRow(pub Map<String, JsonValue>);

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[tokio::test]
    async fn csv_via_duckdb() {
        let mut f = NamedTempFile::new().unwrap();
        write!(
            f,
            "order_id,status,amount,created_at\n\
             1001,paid,129.95,2026-05-18\n\
             1002,pending,49.00,2026-05-18\n\
             1003,paid,12.50,2026-05-19\n"
        )
        .unwrap();
        f.flush().unwrap();

        let engine = DuckdbEngine::new().unwrap();
        let result = engine
            .inspect(
                "csv",
                serde_json::json!({ "path": f.path().to_str().unwrap() }),
            )
            .unwrap();
        assert_eq!(result.schema.len(), 4);
        assert_eq!(result.schema[0].name, "order_id");
        assert!(
            matches!(result.schema[0].data_type, DataType::Int32 | DataType::Int64),
            "expected order_id to be integer, got {:?}",
            result.schema[0].data_type
        );
        assert!(result.sample_rows.len() <= PREVIEW_LIMIT);
        assert!(result.sample_rows.len() >= 3);
    }
}
