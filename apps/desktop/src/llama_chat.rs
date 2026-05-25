//! Local AI chat assistant powered by llama.cpp + a small Qwen GGUF.
//!
//! The architecture mirrors how the rest of the engine talks to
//! external runtimes: we don't link the inference engine into our
//! binary; we shell out to a pre-built `llama-server` that's
//! installed (alongside the model file) into the user's app-data
//! directory by `engine_manager::install("llamacpp", ...)`.
//!
//! The server exposes an OpenAI-compatible chat-completions API on
//! `http://127.0.0.1:<port>/v1/chat/completions`, so chat streaming
//! is the same SSE parse loop our `xf.ai.llm` connector already uses.
//!
//! Lifecycle (managed by lib.rs):
//!   - First chat message: spawn server (lazy boot)
//!   - Subsequent messages: reuse the running server
//!   - App shutdown: kill child

use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// System prompt that teaches Qwen to emit Duckle pipeline JSON when
/// the user asks for one. Kept terse so it doesn't eat the model's
/// 4k context window; lists only the most common components since
/// the Qwen 1.5B model can't reliably distinguish 300 vendor tiles.
pub const SYSTEM_PROMPT: &str = r#"You are Duckle's pipeline assistant. Duckle is a local-first ETL/ELT studio. When the user asks for a pipeline, output ONE valid JSON pipeline definition inside a ```json fenced code block, then a one-sentence summary.

Pipeline schema:
{
  "nodes": [
    { "id": "<unique-id>", "type": "<component-id>", "data": { "label": "<display name>", "props": {...} } }
  ],
  "edges": [
    { "id": "<edge-id>", "source": "<node-id>", "target": "<node-id>", "sourceHandle": "main", "targetHandle": "main" }
  ]
}

Common component IDs (use exactly these strings):
- Sources: src.csv, src.json, src.parquet, src.excel, src.postgres, src.mysql, src.sqlite, src.duckdb, src.s3, src.rest, src.git, src.dynamodb, src.kinesis, src.email, src.ftp, src.webhook
- Transforms: xf.filter, xf.select, xf.rename, xf.aggregate, xf.join, xf.lookup, xf.sort, xf.distinct, xf.union, xf.cast, xf.derive, xf.ai.embed, xf.ai.llm, xf.ai.classify, xf.ai.chunk, xf.ai.pii, xf.ai.dedupe
- Sinks: snk.csv, snk.json, snk.parquet, snk.postgres, snk.mysql, snk.s3, snk.email, snk.rest, snk.webhook
- Code: code.sql, code.shell, code.javascript, code.wasm

Connect sources to transforms to sinks via main edges. Keep IDs short (s1, t1, k1). Props are component-specific; for files use {"path": "..."}, for filters use {"predicate": "col > 5"}, for SQL use {"sql": "SELECT ..."}.

If the user is just chatting, reply conversationally without JSON.
"#;

/// llama-server is a separate process; we manage its lifecycle here.
pub struct LlamaServer {
    child: Child,
    port: u16,
}

impl LlamaServer {
    /// Spawn the server with the Qwen model loaded. Picks a free port
    /// (lets the OS choose by binding to :0 then dropping). Waits up
    /// to 15s for the /health endpoint to return ready.
    pub fn spawn(bin: &PathBuf, model: &PathBuf) -> Result<Self, String> {
        if !bin.exists() {
            return Err(format!(
                "llama-server not installed at {}. Run AI Assistant install.",
                bin.display()
            ));
        }
        if !model.exists() {
            return Err(format!(
                "Qwen model not present at {}. Run AI Assistant install.",
                model.display()
            ));
        }
        // Pick a free port. There's a small TOCTOU race window between
        // close(listener) and the child binding, but localhost is
        // single-user so collisions are rare in practice.
        let port = {
            let l = TcpListener::bind("127.0.0.1:0")
                .map_err(|e| format!("pick port: {}", e))?;
            l.local_addr().unwrap().port()
        };
        let mut cmd = Command::new(bin);
        cmd.arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(port.to_string())
            .arg("--model")
            .arg(model)
            // Small context for a small machine - 2048 tokens fits the
            // system prompt + a few conversation turns + a pipeline
            // response. Bump later if users want longer chats.
            .arg("--ctx-size")
            .arg("2048")
            .arg("--threads")
            .arg(num_threads().to_string())
            // Quiet output - we don't capture it but llama-server is
            // very chatty about token sampling.
            .arg("--log-disable");
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let child = cmd
            .spawn()
            .map_err(|e| format!("spawn llama-server: {}", e))?;
        let server = LlamaServer { child, port };
        // Poll /health until ready (or 30s deadline).
        let deadline = Instant::now() + Duration::from_secs(30);
        let url = format!("http://127.0.0.1:{}/health", port);
        loop {
            if let Ok(resp) = ureq::get(&url).timeout(Duration::from_millis(500)).call() {
                if resp.status() < 400 {
                    return Ok(server);
                }
            }
            if Instant::now() > deadline {
                let _ = server.kill();
                return Err("llama-server didn't become ready within 30s".into());
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Send SIGKILL (or TerminateProcess on Windows) and reap.
    pub fn kill(mut self) -> Result<(), String> {
        let _ = self.child.kill();
        let _ = self.child.wait();
        Ok(())
    }
}

/// Best-effort thread count for inference. Use half the cores so the
/// rest of the desktop stays responsive.
fn num_threads() -> usize {
    std::thread::available_parallelism()
        .map(|n| (n.get() / 2).max(2))
        .unwrap_or(4)
}

/// State the lib.rs holds: at most one server running at a time.
pub static LLAMA_SERVER: Mutex<Option<LlamaServer>> = Mutex::new(None);

/// One streamed event the frontend reads off a Tauri Channel.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChatEvent {
    /// One token (or short text run) from the model.
    Token { text: String },
    /// Conversation finished cleanly.
    Done,
    /// Something broke mid-stream - send to the user as an error toast.
    Error { message: String },
}

/// One message in a chat conversation. Matches OpenAI's shape so we
/// can forward straight to llama-server's chat completions endpoint.
#[derive(Debug, Clone, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// Send a user message + prior history to the running llama-server,
/// stream tokens out via the `on_event` callback as they arrive. The
/// system prompt is prepended automatically.
pub fn chat_stream<F: FnMut(ChatEvent)>(
    port: u16,
    history: &[ChatMessage],
    mut on_event: F,
) -> Result<(), String> {
    let mut messages: Vec<serde_json::Value> = Vec::with_capacity(history.len() + 1);
    messages.push(serde_json::json!({
        "role": "system",
        "content": SYSTEM_PROMPT,
    }));
    for m in history {
        messages.push(serde_json::json!({
            "role": m.role,
            "content": m.content,
        }));
    }
    let body = serde_json::json!({
        "model": "qwen2.5-coder",
        "messages": messages,
        "stream": true,
        "temperature": 0.2,
        "top_p": 0.9,
    });
    let url = format!("http://127.0.0.1:{}/v1/chat/completions", port);
    let resp = ureq::post(&url)
        .set("Content-Type", "application/json")
        .timeout(Duration::from_secs(300))
        .send_string(&body.to_string())
        .map_err(|e| format!("chat send: {}", e))?;
    let reader = BufReader::new(resp.into_reader());
    // OpenAI-style SSE: each event is a "data: <json>" line. The
    // final line is "data: [DONE]". Empty lines separate events.
    for line in reader.lines() {
        let Ok(line) = line else { break };
        let Some(payload) = line.strip_prefix("data: ") else {
            continue;
        };
        if payload.trim() == "[DONE]" {
            on_event(ChatEvent::Done);
            return Ok(());
        }
        // Parse the JSON chunk; choices[0].delta.content has the text.
        let chunk: serde_json::Value = match serde_json::from_str(payload) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let text = chunk
            .pointer("/choices/0/delta/content")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !text.is_empty() {
            on_event(ChatEvent::Token {
                text: text.to_string(),
            });
        }
        // OpenAI's finish_reason ends the stream too (some servers
        // don't emit [DONE]).
        if chunk
            .pointer("/choices/0/finish_reason")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .is_some()
        {
            on_event(ChatEvent::Done);
            return Ok(());
        }
    }
    on_event(ChatEvent::Done);
    Ok(())
}

/// Pull a JSON pipeline definition out of an assistant message.
/// Looks for a ```json fenced code block and parses its contents
/// as { nodes, edges }. Returns Err if no JSON block, parse fails,
/// or the shape doesn't match.
pub fn extract_pipeline(assistant_text: &str) -> Result<serde_json::Value, String> {
    // Find the first ```json ... ``` block.
    let lower = assistant_text.to_ascii_lowercase();
    let start = lower
        .find("```json")
        .or_else(|| lower.find("```"))
        .ok_or_else(|| "no fenced code block found".to_string())?;
    let after_fence = &assistant_text[start..];
    // Move past the opening fence + language tag + newline.
    let body_start = after_fence
        .find('\n')
        .map(|n| start + n + 1)
        .ok_or_else(|| "unterminated code-block opener".to_string())?;
    let body_after = &assistant_text[body_start..];
    let end = body_after
        .find("```")
        .ok_or_else(|| "unterminated code block".to_string())?;
    let body = &body_after[..end];
    let parsed: serde_json::Value = serde_json::from_str(body.trim())
        .map_err(|e| format!("JSON parse: {}", e))?;
    // Minimum shape check - nodes must be an array.
    if !parsed.get("nodes").map(|v| v.is_array()).unwrap_or(false) {
        return Err("pipeline JSON missing `nodes` array".into());
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_pipeline_pulls_json_from_fenced_block() {
        let text = "Sure! Here's a CSV-to-Parquet pipeline:\n\n```json\n{\n  \"nodes\": [{\"id\":\"s\",\"type\":\"src.csv\"},{\"id\":\"k\",\"type\":\"snk.parquet\"}],\n  \"edges\": [{\"source\":\"s\",\"target\":\"k\"}]\n}\n```\n\nLet me know if you want to add a filter.";
        let pipe = extract_pipeline(text).expect("should parse");
        assert_eq!(pipe["nodes"].as_array().unwrap().len(), 2);
        assert_eq!(pipe["edges"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn extract_pipeline_handles_unmarked_fence() {
        // Model sometimes uses bare ``` without the json tag.
        let text = "```\n{\"nodes\":[{\"id\":\"a\"}]}\n```";
        let pipe = extract_pipeline(text).expect("should parse");
        assert_eq!(pipe["nodes"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn extract_pipeline_errors_when_no_fence() {
        assert!(extract_pipeline("just chatting, no pipeline here").is_err());
    }

    #[test]
    fn extract_pipeline_errors_when_no_nodes() {
        let text = "```json\n{\"not_a_pipeline\": true}\n```";
        assert!(extract_pipeline(text).is_err());
    }
}
