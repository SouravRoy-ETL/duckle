import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Loader2, Send, Sparkles, X, Workflow } from 'lucide-react';
import {
    chatExtractPipeline,
    chatSend,
    engineInstall,
    engineStatus,
    type ChatMessage,
    type EngineStatus,
    type InstallProgress,
} from '../tauri-bridge';
import { getWorkspacePath } from '../workspace';

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

type SetupState =
    | { phase: 'checking' }
    | { phase: 'not-installed'; engine: EngineStatus }
    | { phase: 'installing'; progress: InstallProgress | null }
    | { phase: 'ready' }
    | { phase: 'install-failed'; error: string };

const EXAMPLE_PROMPTS = [
    'Read orders.csv, filter where status = "shipped", write to shipped.parquet',
    'Pull GitHub issues from my repo and load them into a Postgres table',
    'Embed the description column with OpenAI and dedupe near-duplicates',
];

export default function ChatPanel({ onClose, onInsertPipeline }: Props) {
    const { t } = useTranslation();
    const [setup, setSetup] = useState<SetupState>({ phase: 'checking' });
    const [messages, setMessages] = useState<Bubble[]>([]);
    const [draft, setDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const scrollRef = useRef<HTMLDivElement | null>(null);

    // Detect the AI engine on mount so we can either show the chat
    // UI or a clear install card. Without this the user clicks Send
    // and gets a cryptic spawn error.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const list = await engineStatus();
            const llama = list.find(e => e.id === 'llamacpp');
            if (cancelled) return;
            if (!llama) {
                setSetup({ phase: 'install-failed', error: 'AI engine not registered.' });
                return;
            }
            setSetup(llama.installed
                ? { phase: 'ready' }
                : { phase: 'not-installed', engine: llama });
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const installEngine = useCallback(async () => {
        setSetup({ phase: 'installing', progress: null });
        try {
            await engineInstall('llamacpp', p => {
                setSetup({ phase: 'installing', progress: p });
            });
            setSetup({ phase: 'ready' });
        } catch (err) {
            setSetup({ phase: 'install-failed', error: String(err) });
        }
    }, []);

    const send = useCallback(async (text?: string) => {
        const body = (text ?? draft).trim();
        if (!body || busy || setup.phase !== 'ready') return;
        if (!text) setDraft('');
        const userMsg: Bubble = { role: 'user', content: body };
        setMessages(prev => [...prev, userMsg, { role: 'assistant', content: '', streaming: true }]);
        setBusy(true);
        const history: ChatMessage[] = [
            ...messages.map(m => ({ role: m.role, content: m.content })),
            { role: 'user', content: body },
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
                setMessages(prev => {
                    const out = prev.slice();
                    const last = out[out.length - 1];
                    if (last && last.role === 'assistant' && last.streaming) {
                        out[out.length - 1] = { ...last, streaming: false };
                        // Try to extract a pipeline once streaming finishes.
                        void chatExtractPipeline(last.content).then(pipe => {
                            if (pipe) {
                                setMessages(c => {
                                    const o2 = c.slice();
                                    const t = o2[o2.length - 1];
                                    if (t && t.role === 'assistant') {
                                        o2[o2.length - 1] = { ...t, pipeline: pipe };
                                    }
                                    return o2;
                                });
                            }
                        });
                    }
                    return out;
                });
                setBusy(false);
            } else if (ev.kind === 'error') {
                setMessages(prev => {
                    const out = prev.slice();
                    const last = out[out.length - 1];
                    if (last && last.role === 'assistant' && last.streaming) {
                        out[out.length - 1] = {
                            ...last,
                            streaming: false,
                            content: ev.message,
                        };
                    }
                    return out;
                });
                setBusy(false);
            }
        }, getWorkspacePath());
    }, [draft, busy, messages, setup.phase]);

    // Esc closes the panel.
    useEffect(() => {
        const h = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', h);
        return () => window.removeEventListener('keydown', h);
    }, [onClose]);

    // Auto-scroll as tokens stream in.
    useEffect(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [messages]);

    return (
        <aside className="chat-panel" role="complementary" aria-label={t('chat.title')}>
            <header className="chat-panel-head">
                <div className="chat-panel-title">
                    <Sparkles size={14} aria-hidden="true" />
                    <span>{t('chat.title')}</span>
                    {setup.phase === 'ready' ? (
                        <span className="chat-panel-tag">{t('chat.localTag')}</span>
                    ) : null}
                </div>
                <button
                    type="button"
                    className="chat-panel-close"
                    onClick={onClose}
                    title={t('common.close')}
                    aria-label={t('common.close')}
                >
                    <X size={14} />
                </button>
            </header>

            {setup.phase === 'checking' ? (
                <div className="chat-panel-state">
                    <Loader2 size={18} className="spin" />
                    <span>{t('chat.checking')}</span>
                </div>
            ) : setup.phase === 'not-installed' ? (
                <SetupCard
                    title={t('chat.installTitle')}
                    body={t('chat.installBody')}
                    cta={t('chat.installCta')}
                    onCta={installEngine}
                />
            ) : setup.phase === 'install-failed' ? (
                <SetupCard
                    title={t('chat.installFailedTitle')}
                    body={setup.error}
                    cta={t('chat.retry')}
                    onCta={installEngine}
                />
            ) : setup.phase === 'installing' ? (
                <div className="chat-panel-state chat-panel-state-install">
                    <Loader2 size={18} className="spin" />
                    <InstallProgressView progress={setup.progress} />
                </div>
            ) : (
                <>
                    <div ref={scrollRef} className="chat-panel-scroll">
                        {messages.length === 0 ? (
                            <div className="chat-panel-empty">
                                <Workflow size={26} className="chat-panel-empty-icon" />
                                <div className="chat-panel-empty-title">
                                    {t('chat.emptyTitle')}
                                </div>
                                <div className="chat-panel-empty-hint">
                                    {t('chat.emptyHint')}
                                </div>
                                <div className="chat-panel-prompts">
                                    {EXAMPLE_PROMPTS.map(p => (
                                        <button
                                            key={p}
                                            type="button"
                                            className="chat-panel-prompt"
                                            onClick={() => void send(p)}
                                        >
                                            {p}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        ) : (
                            messages.map((m, i) => (
                                <div key={i} className={`chat-bubble chat-bubble-${m.role}`}>
                                    <div className="chat-bubble-content">
                                        {m.content}
                                        {m.streaming ? <span className="chat-caret" /> : null}
                                    </div>
                                    {m.pipeline ? (
                                        <button
                                            type="button"
                                            className="chat-bubble-insert"
                                            onClick={() => onInsertPipeline(m.pipeline)}
                                        >
                                            <Workflow size={12} /> {t('chat.insertIntoCanvas')}
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
                            placeholder={busy ? t('chat.thinking') : t('chat.placeholder')}
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
                            className="chat-panel-send"
                            disabled={busy || !draft.trim()}
                            aria-label={t('chat.sendAria')}
                            title={t('chat.sendTooltip')}
                        >
                            {busy ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
                        </button>
                    </form>
                </>
            )}
        </aside>
    );
}

function SetupCard({
    title,
    body,
    cta,
    onCta,
}: {
    title: string;
    body: string;
    cta: string;
    onCta: () => void;
}) {
    return (
        <div className="chat-panel-setup">
            <div className="chat-panel-setup-icon">
                <Sparkles size={20} />
            </div>
            <div className="chat-panel-setup-title">{title}</div>
            <div className="chat-panel-setup-body">{body}</div>
            <button type="button" className="chat-panel-setup-cta" onClick={onCta}>
                <Download size={14} /> {cta}
            </button>
            <div className="chat-panel-setup-foot">
                Runs on your CPU. No data leaves your machine.
            </div>
        </div>
    );
}

function InstallProgressView({ progress }: { progress: InstallProgress | null }) {
    if (!progress) return <span>Starting download...</span>;
    let label = '';
    let pct: number | null = null;
    switch (progress.phase) {
        case 'downloading': {
            const mb = (progress.received / 1_000_000).toFixed(0);
            if (progress.total) {
                pct = Math.round((progress.received / progress.total) * 100);
                const totalMb = (progress.total / 1_000_000).toFixed(0);
                label = `Downloading server ${mb} / ${totalMb} MB`;
            } else {
                label = `Downloading server ${mb} MB`;
            }
            break;
        }
        case 'extracting':
            label = 'Extracting...';
            break;
        case 'verifying':
            label = 'Verifying...';
            break;
        case 'downloading_model': {
            const mb = (progress.received / 1_000_000).toFixed(0);
            if (progress.total) {
                pct = Math.round((progress.received / progress.total) * 100);
                const totalMb = (progress.total / 1_000_000).toFixed(0);
                label = `Downloading model ${mb} / ${totalMb} MB`;
            } else {
                label = `Downloading model ${mb} MB`;
            }
            break;
        }
        case 'installing_extension':
            label = `Installing extensions (${progress.index}/${progress.total})`;
            break;
        case 'done':
            label = 'Ready';
            break;
        case 'failed':
            label = progress.error;
            break;
    }
    return (
        <div className="chat-panel-install-progress">
            <div className="chat-panel-install-bar">
                <div
                    className="chat-panel-install-fill"
                    style={{ width: pct != null ? `${pct}%` : '30%' }}
                    data-indeterminate={pct == null}
                />
            </div>
            <div className="chat-panel-install-label">{label}</div>
        </div>
    );
}
