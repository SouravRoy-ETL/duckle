//! Pipeline diff for review ("data pull request"): compare two pipeline
//! versions structurally and at the compiled-plan level. Shared by the MCP
//! `diff_pipelines` tool and the `duckle-runner review` CLI so both report the
//! same thing. Compile-only; no DuckDB binary is required.

use crate::{compile_pipeline_sql, PipelineDoc};
use serde_json::{json, Value};

/// Compile each node to SQL for plan-level comparison. Best-effort: a compile
/// failure yields an empty map, so `planChanged` just falls back to false.
fn plan_sql_map(p: &Value) -> std::collections::HashMap<String, String> {
    let mut m = std::collections::HashMap::new();
    if let Ok(doc) = serde_json::from_value::<PipelineDoc>(p.clone()) {
        if let Ok(stages) = compile_pipeline_sql(&doc) {
            for st in stages {
                m.insert(st.node_id, st.sql);
            }
        }
    }
    m
}

/// Structural + compiled-plan diff between two pipeline versions. Reads the raw
/// JSON so it is independent of the typed structs. Returns
/// `{ summary, nodes: { added, removed, changed }, edges: { added, removed } }`.
pub fn diff_pipelines(before: &Value, after: &Value) -> Value {
    // Index nodes by id straight off the raw JSON.
    let index = |p: &Value| -> std::collections::BTreeMap<String, Value> {
        let mut m = std::collections::BTreeMap::new();
        if let Some(nodes) = p.get("nodes").and_then(|n| n.as_array()) {
            for n in nodes {
                if let Some(id) = n.get("id").and_then(|v| v.as_str()) {
                    m.insert(id.to_string(), n.clone());
                }
            }
        }
        m
    };
    let a = index(before);
    let b = index(after);

    let comp = |n: &Value| {
        n.pointer("/data/componentId").and_then(|v| v.as_str()).unwrap_or("").to_string()
    };
    let label =
        |n: &Value| n.pointer("/data/label").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let props = |n: &Value| n.pointer("/data/properties").cloned().unwrap_or(Value::Null);

    let pa = plan_sql_map(before);
    let pb = plan_sql_map(after);

    let mut added = Vec::new();
    let mut removed = Vec::new();
    let mut changed = Vec::new();
    for (id, n) in &b {
        if !a.contains_key(id) {
            added.push(json!({ "node": id, "componentId": comp(n), "label": label(n) }));
        }
    }
    for (id, n) in &a {
        if !b.contains_key(id) {
            removed.push(json!({ "node": id, "componentId": comp(n), "label": label(n) }));
        }
    }
    for (id, na) in &a {
        if let Some(nb) = b.get(id) {
            let (comp_a, comp_b) = (comp(na), comp(nb));
            let component_changed = comp_a != comp_b;
            let properties_changed = props(na) != props(nb);
            let plan_changed = pa.get(id) != pb.get(id);
            if component_changed || properties_changed || plan_changed {
                changed.push(json!({
                    "node": id,
                    "label": label(nb),
                    "componentChanged": if component_changed {
                        json!({ "from": comp_a, "to": comp_b })
                    } else {
                        Value::Null
                    },
                    "propertiesChanged": properties_changed,
                    "planChanged": plan_changed,
                }));
            }
        }
    }

    // Edges keyed by source/target plus handles, so a rewire is add + remove.
    let edge_key = |e: &Value| {
        let g = |k: &str| e.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        format!("{}->{}|{}|{}", g("source"), g("target"), g("sourceHandle"), g("targetHandle"))
    };
    let edge_set = |p: &Value| -> std::collections::BTreeMap<String, Value> {
        let mut m = std::collections::BTreeMap::new();
        if let Some(edges) = p.get("edges").and_then(|e| e.as_array()) {
            for e in edges {
                let g = |k: &str| e.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
                m.insert(edge_key(e), json!({ "source": g("source"), "target": g("target") }));
            }
        }
        m
    };
    let ea = edge_set(before);
    let eb = edge_set(after);
    let edges_added: Vec<Value> =
        eb.iter().filter(|(k, _)| !ea.contains_key(*k)).map(|(_, v)| v.clone()).collect();
    let edges_removed: Vec<Value> =
        ea.iter().filter(|(k, _)| !eb.contains_key(*k)).map(|(_, v)| v.clone()).collect();

    let plan_changed_any = !added.is_empty()
        || !removed.is_empty()
        || changed.iter().any(|c| c["planChanged"] == json!(true));

    json!({
        "summary": {
            "nodesAdded": added.len(),
            "nodesRemoved": removed.len(),
            "nodesChanged": changed.len(),
            "edgesAdded": edges_added.len(),
            "edgesRemoved": edges_removed.len(),
            "planChanged": plan_changed_any,
        },
        "nodes": { "added": added, "removed": removed, "changed": changed },
        "edges": { "added": edges_added, "removed": edges_removed },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diff_reports_node_and_edge_changes() {
        let before = json!({
            "nodes": [
                { "id": "s", "data": { "componentId": "src.csv", "label": "A", "properties": { "path": "old.csv" } } },
                { "id": "k", "data": { "componentId": "snk.csv", "label": "K", "properties": {} } }
            ],
            "edges": [ { "source": "s", "target": "k" } ]
        });
        let after = json!({
            "nodes": [
                { "id": "s", "data": { "componentId": "src.csv", "label": "A", "properties": { "path": "new.csv" } } },
                { "id": "x", "data": { "componentId": "xf.addcol", "label": "X", "properties": {} } },
                { "id": "k", "data": { "componentId": "snk.csv", "label": "K", "properties": {} } }
            ],
            "edges": [ { "source": "s", "target": "x" }, { "source": "x", "target": "k" } ]
        });
        let out = diff_pipelines(&before, &after);
        assert_eq!(out["summary"]["nodesAdded"], json!(1));
        assert_eq!(out["nodes"]["added"][0]["node"], json!("x"));
        let changed = out["nodes"]["changed"].as_array().unwrap();
        let s = changed.iter().find(|c| c["node"] == "s").expect("s changed");
        assert_eq!(s["propertiesChanged"], json!(true));
        assert_eq!(s["componentChanged"], Value::Null);
        assert_eq!(out["summary"]["edgesAdded"], json!(2));
        assert_eq!(out["summary"]["edgesRemoved"], json!(1));
    }

    #[test]
    fn diff_identical_is_empty() {
        let p = json!({
            "nodes": [ { "id": "s", "data": { "componentId": "src.csv", "label": "A", "properties": { "path": "x.csv" } } } ],
            "edges": []
        });
        let out = diff_pipelines(&p, &p);
        assert_eq!(out["summary"]["nodesChanged"], json!(0));
        assert_eq!(out["summary"]["planChanged"], json!(false));
    }
}
