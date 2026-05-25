import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Loader2, Send, Sparkles, X } from 'lucide-react';
import {
    chatExtractPipeline,
    chatSend,
    type ChatMessage,
} from '../tauri-bridge';

type Props = {
    onClose: () => void;
    onInsertPipeline: (pipeline: unknown) => void;
};

type Bubble = ChatMessage & {
    /** True while tokens are still streaming in. */
    streaming?: boolean;
    /** Cached extracted pipeline, computed after the stream finishes. */
    pipeline?: unknown;
};

/**
 * Chat sidebar for the local AI assistant. Streams tokens from the
 * llama-server subprocess via the chat_send Tauri command. When an
 * assistant message contains a fenced JSON pipeline block the panel
 * shows an "Insert into canvas" button.
 */
export default function ChatPanel({ onClose, onInsertPipeline }: Props) {
    const [messages, setMessages] = useState<Bubble[]>([]);
    const [draft, setDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const scrollRef = useRef<HTMLDivElement | null>(null);

    const send = useCallback(async () => {
        const text = draft.trim();
        if (!text || busy) return;
        setDraft('');
        const userMsg: Bubble = { role: 'user', content: text };
        // Optimistically append the user bubble + an empty assistant bubble
        // that we mutate as tokens arrive.
        setMessages(prev => [...prev, userMsg, { role: 'assistant', content: '', streaming: true }]);
        setBusy(true);
        // Build history from current messages + the new user one.
        // (React state hasn't flushed yet so we splice manually.)
        const history: ChatMessage[] = [
            ...messages.map(m => ({ role: m.role, content: m.content })),
            { role: 'user', content: text },
        ];
        await chatSend(history, ev => {
            if (ev.kind === 'token') {
                setMessages(prev => {
                    const out = prev.slice();
                    const last = out[out.length - 1];
                    if (last && last.role === 'assistant' && last.streaming) {
                        out[out.length - 1] = { ...last, content: last.content + ev.text };
                    }
                    return out;
                });
            } else if (ev.kind === 'done') {
                // Mark the streaming bubble as done + try to extract a
                // pipeline. extract is fast (just JSON parsing) so we
                // do it after-the-fact to avoid re-running per token.
                setMessages(prev => {
                    const out = prev.slice();
                    const last = out[out.length - 1];
                    if (last && last.role === 'assistant' && last.streaming) {
                        out[out.length - 1] = { ...last, streaming: false };
                    }
                    return out;
                });
                void (async () => {
                    // Re-read the latest assistant message off state.
                    setMessages(curr => {
                        const tail = curr[curr.length - 1];
                        if (tail && tail.role === 'assistant') {
                            void chatExtractPipeline(tail.content).then(pipe => {
                                if (pipe) {
                                    setMessages(c => {
                                        const out = c.slice();
                                        const t = out[out.length - 1];
                                        if (t && t.role === 'assistant') {
                                            out[out.length - 1] = { ...t, pipeline: pipe };
                                        }
                                        return out;
                                    });
                                }
                            });
                        }
                        return curr;
                    });
                })();
                setBusy(false);
            } else if (ev.kind === 'error') {
                setMessages(prev => {
                    const out = prev.slice();
                    const last = out[out.length - 1];
                    if (last && last.role === 'assistant' && last.streaming) {
                        out[out.length - 1] = {
                            ...last,
                            streaming: false,
                            content: last.content + `\n\n[error: ${ev.message}]`,
                        };
                    }
                    return out;
                });
                setBusy(false);
            }
        });
    }, [draft, busy, messages]);

    // Auto-scroll to bottom as new tokens arrive.
    useEffect(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [messages]);

    return (
        <aside className="chat-panel" role="complementary" aria-label="AI assistant">
            <header className="chat-panel-head">
                <div className="chat-panel-title">
                    <Sparkles size={14} aria-hidden="true" /> AI Assistant
                </div>
                <button
                    type="button"
                    className="chat-panel-close"
                    onClick={onClose}
                    title="Close"
                    aria-label="Close chat"
                >
                    <X size={14} />
                </button>
            </header>

            <div ref={scrollRef} className="chat-panel-scroll">
                {messages.length === 0 ? (
                    <div className="chat-panel-empty">
                        <Bot size={28} />
                        <div className="chat-panel-empty-title">Describe a pipeline</div>
                        <div className="chat-panel-empty-hint">
                            Try: "Read orders.csv, filter manager = 'Sourav Roy', write to
                            orders.parquet"
                        </div>
                    </div>
                ) : (
                    messages.map((m, i) => (
                        <div key={i} className={`chat-bubble chat-bubble-${m.role}`}>
                            <div className="chat-bubble-content">
                                {m.content}
                                {m.streaming ? (
                                    <Loader2 size={12} className="spin chat-bubble-spin" />
                                ) : null}
                            </div>
                            {m.pipeline ? (
                                <button
                                    type="button"
                                    className="chat-bubble-insert"
                                    onClick={() => onInsertPipeline(m.pipeline)}
                                >
                                    Insert into canvas
                                </button>
                            ) : null}
                        </div>
                    ))
                )}
            </div>

            <form
                className="chat-panel-form"
                onSubmit={e => {
                    e.preventDefault();
                    void send();
                }}
            >
                <textarea
                    className="chat-panel-input"
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    placeholder={busy ? 'Thinking...' : 'Ask for a pipeline...'}
                    rows={2}
                    disabled={busy}
                    onKeyDown={e => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            void send();
                        }
                    }}
                />
                <button
                    type="submit"
                    className="btn btn-primary chat-panel-send"
                    disabled={busy || !draft.trim()}
                    aria-label="Send"
                >
                    <Send size={13} />
                </button>
            </form>
        </aside>
    );
}
