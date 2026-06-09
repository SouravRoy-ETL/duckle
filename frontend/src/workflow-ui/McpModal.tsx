import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Clipboard, Loader2, X } from 'lucide-react';
import { ClaudeIcon } from './ClaudeIcon';
import { copyText } from '../tauri-io';
import {
    mcpConnectionInfo,
    connectClaudeCode,
    mcpInjectConfig,
    type McpConnInfo,
    type McpClient,
} from '../tauri-bridge';

type Busy = null | 'claude_code' | 'claude_desktop' | 'cursor';

/**
 * Compact popup that connects Duckle to an MCP-capable AI (Claude Code,
 * Claude Desktop, Cursor, etc.). It bundles the duckle-mcp server with the
 * real resolved paths filled in: one-click connect buttons per client, with
 * the raw command + config tucked into collapsible sections.
 */
export function McpModal({ onClose }: { onClose: () => void }) {
    const [info, setInfo] = useState<McpConnInfo | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState<string | null>(null);
    const [busy, setBusy] = useState<Busy>(null);
    const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

    useEffect(() => {
        let alive = true;
        mcpConnectionInfo()
            .then(i => { if (alive) setInfo(i); })
            .catch(e => { if (alive) setError(String(e)); });
        return () => { alive = false; };
    }, []);

    const copy = async (key: string, text: string) => {
        if (await copyText(text)) {
            setCopied(key);
            setTimeout(() => setCopied(c => (c === key ? null : c)), 1500);
        }
    };

    const connectClaude = async () => {
        setBusy('claude_code');
        setMsg(null);
        try {
            const out = await connectClaudeCode();
            setMsg({ ok: true, text: out || 'Connected. Restart Claude Code if it is open.' });
        } catch (e) {
            setMsg({ ok: false, text: String(e) });
        } finally {
            setBusy(null);
        }
    };

    const inject = async (client: McpClient, label: string) => {
        setBusy(client);
        setMsg(null);
        try {
            const path = await mcpInjectConfig(client);
            setMsg({ ok: true, text: `Added to ${label} (${path}). Restart ${label} to load it.` });
        } catch (e) {
            setMsg({ ok: false, text: String(e) });
        } finally {
            setBusy(null);
        }
    };

    const handleBackdrop = (e: React.MouseEvent) => {
        if (e.target === e.currentTarget) onClose();
    };

    return createPortal(
        <div className="modal-backdrop" onClick={handleBackdrop}>
            <div className="modal mcp-modal" role="dialog" aria-modal="true" aria-label="Connect to Claude">
                <div className="modal-header">
                    <div className="modal-title">
                        <ClaudeIcon size={16} className="claude-icon claude-icon-glow" />
                        <span style={{ marginLeft: 8 }}>Connect Duckle to Claude</span>
                    </div>
                    <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
                        <X size={16} />
                    </button>
                </div>

                <div className="modal-body">
                    {error ? (
                        <p className="mcp-warn">Could not load MCP details: {error}</p>
                    ) : !info ? (
                        <p className="mcp-muted"><Loader2 size={14} className="spin" /> Preparing the MCP server…</p>
                    ) : (
                        <>
                            <p className="mcp-muted">
                                Duckle ships a Model Context Protocol (MCP) server, so Claude can
                                generate, validate, run and build your pipelines for you - right in
                                this workspace.
                            </p>

                            {!info.bundled && (
                                <p className="mcp-warn">
                                    This build does not bundle the MCP server. Build it with
                                    <code> cargo build -p duckle-mcp --release</code> and point your client at it.
                                </p>
                            )}
                            {info.bundled && !info.duckdbFound && (
                                <p className="mcp-warn">
                                    The DuckDB engine is not installed yet. The AI can still generate and
                                    validate pipelines; install the engine (setup screen) to run or build them.
                                </p>
                            )}

                            {msg && <p className={msg.ok ? 'mcp-ok' : 'mcp-warn'}>{msg.text}</p>}

                            {/* Claude Code */}
                            <div className="mcp-section">
                                <div className="mcp-section-title">Claude Code</div>
                                <div className="mcp-actions">
                                    <button
                                        type="button"
                                        className="btn btn-primary"
                                        onClick={() => void connectClaude()}
                                        disabled={!info.bundled || busy !== null}
                                    >
                                        {busy === 'claude_code'
                                            ? <><Loader2 size={13} className="spin" /> Connecting…</>
                                            : 'Connect to Claude Code'}
                                    </button>
                                    <button type="button" className="btn mcp-copy" onClick={() => void copy('cmd', info.claudeCommand)}>
                                        {copied === 'cmd' ? <><Check size={12} /> Copied</> : <><Clipboard size={12} /> Copy command</>}
                                    </button>
                                </div>
                                <details className="mcp-disclose">
                                    <summary>Show command</summary>
                                    <code className="mcp-code">{info.claudeCommand}</code>
                                </details>
                            </div>

                            {/* Claude Desktop / Cursor / other */}
                            <div className="mcp-section">
                                <div className="mcp-section-title">Claude Desktop, Cursor, or any MCP client</div>
                                <div className="mcp-actions">
                                    <button
                                        type="button"
                                        className="btn btn-primary"
                                        onClick={() => void inject('claude_desktop', 'Claude Desktop')}
                                        disabled={!info.bundled || busy !== null}
                                    >
                                        {busy === 'claude_desktop'
                                            ? <><Loader2 size={13} className="spin" /> Adding…</>
                                            : 'Add to Claude Desktop'}
                                    </button>
                                    <button
                                        type="button"
                                        className="btn btn-primary"
                                        onClick={() => void inject('cursor', 'Cursor')}
                                        disabled={!info.bundled || busy !== null}
                                    >
                                        {busy === 'cursor'
                                            ? <><Loader2 size={13} className="spin" /> Adding…</>
                                            : 'Add to Cursor'}
                                    </button>
                                    <button type="button" className="btn mcp-copy" onClick={() => void copy('json', info.configJson)}>
                                        {copied === 'json' ? <><Check size={12} /> Copied</> : <><Clipboard size={12} /> Copy config</>}
                                    </button>
                                </div>
                                <p className="mcp-hint">Adds a "duckle" entry to the client's config. For any other client, copy the config.</p>
                                <details className="mcp-disclose">
                                    <summary>Show config</summary>
                                    <pre className="mcp-code mcp-pre">{info.configJson}</pre>
                                </details>
                            </div>

                            <details className="mcp-paths">
                                <summary>Resolved paths</summary>
                                <div className="mcp-kv"><span>MCP server</span><code>{info.mcpPath || '(not bundled)'}</code></div>
                                <div className="mcp-kv"><span>DuckDB</span><code>{info.duckdbPath || '(not installed)'}</code></div>
                                <div className="mcp-kv"><span>Runner</span><code>{info.runnerPath || '(not bundled)'}</code></div>
                            </details>
                        </>
                    )}
                </div>

                <div className="modal-footer">
                    <button type="button" className="btn" onClick={onClose}>Done</button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
