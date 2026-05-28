import { useCallback, useEffect, useState } from 'react';
import {
    AlertTriangle,
    ArrowDownToLine,
    ArrowUpToLine,
    Check,
    ExternalLink,
    GitBranch,
    GitCommit,
    Globe,
    Key,
    Loader2,
    Plus,
    RefreshCw,
    X,
} from 'lucide-react';
import {
    workspaceGitBranchCheckout,
    workspaceGitBranchCreate,
    workspaceGitBranches,
    workspaceGitClearPat,
    workspaceGitCommit,
    workspaceGitInit,
    workspaceGitPull,
    workspaceGitPush,
    workspaceGitRemoteSet,
    workspaceGitSavePat,
    workspaceGitStatus,
    type GitStatus,
} from '../tauri-bridge';
import { openExternal } from '../tauri-io';

type Props = {
    workspacePath: string;
    onClose: () => void;
};

/**
 * In-app Git panel for the user's workspace folder. Status + commit +
 * push + pull + branches + remote / PAT setup. Talend-style: the user
 * never leaves Duckle for routine operations.
 */
export default function GitPanel({ workspacePath, onClose }: Props) {
    const [status, setStatus] = useState<GitStatus | null>(null);
    const [branches, setBranches] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [info, setInfo] = useState<string | null>(null);

    const [commitMsg, setCommitMsg] = useState('');
    const [remoteUrl, setRemoteUrl] = useState('');
    const [newBranch, setNewBranch] = useState('');
    const [patPrompt, setPatPrompt] = useState(false);
    const [pat, setPat] = useState('');

    const refresh = useCallback(async () => {
        if (!workspacePath) return;
        setLoading(true);
        const st = await workspaceGitStatus(workspacePath);
        setStatus(st);
        if (st?.initialized) {
            try {
                const bs = await workspaceGitBranches(workspacePath);
                setBranches(bs);
            } catch {
                /* ignore */
            }
        }
        setLoading(false);
    }, [workspacePath]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    // Esc closes the panel.
    useEffect(() => {
        const h = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', h);
        return () => window.removeEventListener('keydown', h);
    }, [onClose]);

    const run = useCallback(
        async (label: string, fn: () => Promise<unknown>, ok?: string) => {
            setBusy(label);
            setError(null);
            setInfo(null);
            try {
                await fn();
                if (ok) setInfo(ok);
                await refresh();
            } catch (err) {
                const msg = String(err);
                if (msg.includes('AUTH_REQUIRED')) {
                    setPatPrompt(true);
                    setError('Authentication required. Save a Personal Access Token below.');
                } else {
                    setError(msg);
                }
            } finally {
                setBusy(null);
            }
        },
        [refresh],
    );

    const handleInit = () => run('init', () => workspaceGitInit(workspacePath), 'Initialized empty Git repo');
    const handleCommit = () =>
        commitMsg.trim() &&
        run('commit', async () => {
            await workspaceGitCommit(workspacePath, commitMsg.trim());
            setCommitMsg('');
        }, 'Committed');
    const handlePush = () => run('push', () => workspaceGitPush(workspacePath), 'Pushed');
    const handlePull = () => run('pull', () => workspaceGitPull(workspacePath), 'Pulled');
    const handleRemoteSet = () =>
        remoteUrl.trim() &&
        run('remote', async () => {
            await workspaceGitRemoteSet(workspacePath, remoteUrl.trim());
            setRemoteUrl('');
        }, 'Remote URL set');
    const handleBranchCreate = () =>
        newBranch.trim() &&
        run('branch-create', async () => {
            await workspaceGitBranchCreate(workspacePath, newBranch.trim());
            setNewBranch('');
        }, `Created branch ${newBranch.trim()}`);
    const handleCheckout = (name: string) =>
        run('checkout', () => workspaceGitBranchCheckout(workspacePath, name), `Switched to ${name}`);
    const handleSavePat = () =>
        pat.trim() &&
        run('save-pat', async () => {
            await workspaceGitSavePat(workspacePath, pat.trim());
            setPat('');
            setPatPrompt(false);
        }, 'PAT saved');
    const handleClearPat = () =>
        run('clear-pat', () => workspaceGitClearPat(workspacePath), 'PAT removed');

    const providerLabel = (provider?: string) => {
        switch (provider) {
            case 'github':
                return 'GH';
            case 'gitlab':
                return 'GL';
            case 'bitbucket':
                return 'BB';
            default:
                return '';
        }
    };
    const fileStatusColor = (s: string) => {
        switch (s) {
            case 'staged':
                return 'git-file-staged';
            case 'modified':
                return 'git-file-modified';
            case 'untracked':
                return 'git-file-untracked';
            case 'conflicted':
                return 'git-file-conflicted';
            case 'deleted':
                return 'git-file-deleted';
            default:
                return 'git-file-modified';
        }
    };

    return (
        <aside className="git-panel" role="complementary" aria-label="Git">
            <header className="git-panel-head">
                <div className="git-panel-title">
                    <GitBranch size={14} />
                    <span>Git</span>
                    {status?.branch ? <span className="git-panel-branch-tag">{status.branch}</span> : null}
                </div>
                <div className="git-panel-head-actions">
                    <button
                        type="button"
                        className="git-panel-icon-btn"
                        onClick={() => void refresh()}
                        disabled={loading}
                        title="Refresh"
                        aria-label="Refresh"
                    >
                        {loading ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
                    </button>
                    <button
                        type="button"
                        className="git-panel-icon-btn"
                        onClick={onClose}
                        title="Close (Esc)"
                        aria-label="Close"
                    >
                        <X size={12} />
                    </button>
                </div>
            </header>

            {!workspacePath ? (
                <div className="git-panel-state">
                    <AlertTriangle size={16} /> Pick a workspace first.
                </div>
            ) : loading ? (
                <div className="git-panel-state">
                    <Loader2 size={16} className="spin" /> Reading repo...
                </div>
            ) : !status?.initialized ? (
                <div className="git-panel-setup">
                    <div className="git-panel-setup-title">Workspace isn't a Git repo</div>
                    <div className="git-panel-setup-body">
                        Initialize a fresh repo here, or close this and clone an existing repo
                        into a workspace folder from your terminal.
                    </div>
                    <button
                        type="button"
                        className="git-panel-cta"
                        onClick={handleInit}
                        disabled={busy !== null}
                    >
                        {busy === 'init' ? <Loader2 size={13} className="spin" /> : <GitCommit size={13} />}
                        Initialize repo
                    </button>
                </div>
            ) : (
                <div className="git-panel-scroll">
                    {/* Counters */}
                    <div className="git-panel-counters">
                        <Counter
                            label="changed"
                            value={status.files.length}
                            tone={status.files.length > 0 ? 'warn' : 'ok'}
                        />
                        <Counter
                            label="ahead"
                            value={status.ahead}
                            tone={status.ahead > 0 ? 'accent' : 'mute'}
                        />
                        <Counter
                            label="behind"
                            value={status.behind}
                            tone={status.behind > 0 ? 'warn' : 'mute'}
                        />
                    </div>

                    {/* Remote */}
                    <Section title="Remote">
                        {status.remote ? (
                            <div className="git-panel-remote">
                                <span className="git-panel-remote-icon" title={status.remote.provider}>
                                    {providerLabel(status.remote.provider) || <Globe size={12} />}
                                </span>
                                <span className="git-panel-remote-url" title={status.remote.url}>
                                    {status.remote.url}
                                </span>
                            </div>
                        ) : (
                            <div className="git-panel-row">
                                <input
                                    type="text"
                                    className="git-panel-input"
                                    placeholder="https://github.com/you/repo.git"
                                    value={remoteUrl}
                                    onChange={e => setRemoteUrl(e.target.value)}
                                />
                                <button
                                    type="button"
                                    className="git-panel-btn"
                                    onClick={handleRemoteSet}
                                    disabled={!remoteUrl.trim() || busy === 'remote'}
                                >
                                    Set
                                </button>
                            </div>
                        )}
                    </Section>

                    {/* Changed files */}
                    {status.files.length > 0 ? (
                        <Section title={`Changes (${status.files.length})`}>
                            <ul className="git-panel-files">
                                {status.files.map(f => (
                                    <li key={f.path} className="git-panel-file">
                                        <span className={`git-file-badge ${fileStatusColor(f.status)}`}>
                                            {f.status[0].toUpperCase()}
                                        </span>
                                        <span className="git-panel-file-path" title={f.path}>
                                            {f.path}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </Section>
                    ) : (
                        <Section title="Working tree">
                            <div className="git-panel-clean">
                                <Check size={12} /> Clean. Nothing to commit.
                            </div>
                        </Section>
                    )}

                    {/* Commit */}
                    {status.files.length > 0 ? (
                        <Section title="Commit">
                            <textarea
                                className="git-panel-textarea"
                                placeholder="Message..."
                                rows={2}
                                value={commitMsg}
                                onChange={e => setCommitMsg(e.target.value)}
                            />
                            <button
                                type="button"
                                className="git-panel-cta"
                                onClick={handleCommit}
                                disabled={!commitMsg.trim() || busy !== null}
                            >
                                {busy === 'commit' ? (
                                    <Loader2 size={13} className="spin" />
                                ) : (
                                    <GitCommit size={13} />
                                )}
                                Stage all + commit
                            </button>
                        </Section>
                    ) : null}

                    {/* Push / Pull */}
                    <Section title="Sync">
                        <div className="git-panel-row">
                            <button
                                type="button"
                                className="git-panel-btn"
                                onClick={handlePull}
                                disabled={busy !== null}
                            >
                                {busy === 'pull' ? (
                                    <Loader2 size={12} className="spin" />
                                ) : (
                                    <ArrowDownToLine size={12} />
                                )}
                                Pull
                            </button>
                            <button
                                type="button"
                                className="git-panel-btn"
                                onClick={handlePush}
                                disabled={busy !== null || status.ahead === 0}
                            >
                                {busy === 'push' ? (
                                    <Loader2 size={12} className="spin" />
                                ) : (
                                    <ArrowUpToLine size={12} />
                                )}
                                Push {status.ahead > 0 ? `(${status.ahead})` : ''}
                            </button>
                        </div>
                    </Section>

                    {/* Branches */}
                    <Section title="Branches">
                        <ul className="git-panel-branches">
                            {branches.map(b => (
                                <li key={b} className="git-panel-branch">
                                    <button
                                        type="button"
                                        className={`git-panel-branch-btn ${
                                            b === status.branch ? 'is-current' : ''
                                        }`}
                                        onClick={() => handleCheckout(b)}
                                        disabled={busy !== null || b === status.branch}
                                    >
                                        <GitBranch size={11} /> {b}
                                        {b === status.branch ? (
                                            <span className="git-panel-branch-current">current</span>
                                        ) : null}
                                    </button>
                                </li>
                            ))}
                        </ul>
                        <div className="git-panel-row">
                            <input
                                type="text"
                                className="git-panel-input"
                                placeholder="new-branch-name"
                                value={newBranch}
                                onChange={e => setNewBranch(e.target.value)}
                            />
                            <button
                                type="button"
                                className="git-panel-btn"
                                onClick={handleBranchCreate}
                                disabled={!newBranch.trim() || busy !== null}
                            >
                                <Plus size={12} /> Create
                            </button>
                        </div>
                    </Section>

                    {/* PAT */}
                    <Section title="Auth (Personal Access Token)">
                        <div className="git-panel-pat-help">
                            {status.has_pat
                                ? 'A PAT is saved for this workspace.'
                                : 'No PAT saved. Push tries your system credential helper first; if it fails we ask for a token.'}
                        </div>
                        {patPrompt || !status.has_pat ? (
                            <div className="git-panel-row">
                                <input
                                    type="password"
                                    className="git-panel-input"
                                    placeholder="ghp_... or glpat-..."
                                    value={pat}
                                    onChange={e => setPat(e.target.value)}
                                />
                                <button
                                    type="button"
                                    className="git-panel-btn"
                                    onClick={handleSavePat}
                                    disabled={!pat.trim() || busy !== null}
                                >
                                    <Key size={12} /> Save
                                </button>
                            </div>
                        ) : (
                            <button
                                type="button"
                                className="git-panel-btn git-panel-btn-danger"
                                onClick={handleClearPat}
                                disabled={busy !== null}
                            >
                                Remove saved PAT
                            </button>
                        )}
                        <button
                            type="button"
                            className="git-panel-link"
                            onClick={() =>
                                void openExternal(
                                    status.remote?.provider === 'gitlab'
                                        ? 'https://gitlab.com/-/user_settings/personal_access_tokens'
                                        : 'https://github.com/settings/tokens?type=beta',
                                )
                            }
                        >
                            Create one <ExternalLink size={10} />
                        </button>
                    </Section>

                    {error ? <div className="git-panel-error">{error}</div> : null}
                    {info ? <div className="git-panel-info">{info}</div> : null}
                </div>
            )}
        </aside>
    );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div className="git-panel-section">
            <div className="git-panel-section-title">{title}</div>
            <div className="git-panel-section-body">{children}</div>
        </div>
    );
}

function Counter({
    label,
    value,
    tone,
}: {
    label: string;
    value: number;
    tone: 'ok' | 'warn' | 'accent' | 'mute';
}) {
    return (
        <div className={`git-counter git-counter-${tone}`}>
            <div className="git-counter-value">{value}</div>
            <div className="git-counter-label">{label}</div>
        </div>
    );
}
