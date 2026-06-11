import { useEffect, useMemo, useState } from 'react';
import { History, CheckCircle2, XCircle, MinusCircle } from 'lucide-react';
import { runHistory, type RunRecord } from '../tauri-bridge';

type Props = {
    workspacePath: string | null;
    pipelineId: string | null;
    // Bumped by the parent whenever a run finishes, so history reloads.
    runResultKey: number;
};

function StatusIcon({ status }: { status: string }) {
    if (status === 'ok') return <CheckCircle2 size={13} className="run-row-ok" />;
    if (status === 'error') return <XCircle size={13} className="run-row-err" />;
    return <MinusCircle size={13} className="run-row-idle" />;
}

function relativeTime(iso: string): string {
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return iso;
    const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
}

// Inline duration sparkline (oldest -> newest, left -> right). Failed runs
// are drawn red so a glance shows where things broke.
function Sparkline({ records }: { records: RunRecord[] }) {
    if (records.length < 2) return null;
    const w = 240;
    const h = 36;
    const max = Math.max(...records.map(r => r.duration_ms), 1);
    const step = w / (records.length - 1);
    const pts = records.map((r, i) => {
        const x = i * step;
        const y = h - 2 - (r.duration_ms / max) * (h - 4);
        return { x, y, r };
    });
    const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    return (
        <svg className="runs-sparkline" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
            <path d={path} fill="none" stroke="var(--accent)" strokeWidth="1.5" />
            {pts.map((p, i) => (
                <circle
                    key={i}
                    cx={p.x}
                    cy={p.y}
                    r={2}
                    fill={p.r.status === 'error' ? 'var(--danger)' : 'var(--accent)'}
                />
            ))}
        </svg>
    );
}

// History + trends for the active pipeline's recent runs (the retained
// workspace/runs/<id>.json window). Reloads when a run finishes.
export default function RunHistoryView({ workspacePath, pipelineId, runResultKey }: Props) {
    const [records, setRecords] = useState<RunRecord[]>([]);
    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        let alive = true;
        if (!workspacePath || !pipelineId) {
            setRecords([]);
            setLoaded(true);
            return;
        }
        runHistory(workspacePath, pipelineId).then(r => {
            if (alive) {
                setRecords(r);
                setLoaded(true);
            }
        });
        return () => {
            alive = false;
        };
    }, [workspacePath, pipelineId, runResultKey]);

    const stats = useMemo(() => {
        if (records.length === 0) return null;
        const ok = records.filter(r => r.status === 'ok').length;
        const rate = Math.round((ok / records.length) * 100);
        const avg = Math.round(
            records.reduce((s, r) => s + r.duration_ms, 0) / records.length,
        );
        return { rate, avg, total: records.length };
    }, [records]);

    if (loaded && records.length === 0) {
        return (
            <div className="empty-state">
                <History size={32} strokeWidth={1.4} className="empty-icon" />
                <div className="empty-title">No run history</div>
                <div className="empty-desc">
                    Past runs of this pipeline (status, duration, rows, errors) will appear here
                    once you run it. History is kept per pipeline in the workspace.
                </div>
            </div>
        );
    }

    // runHistory returns newest-first; chart wants oldest-first.
    const chartRecords = [...records].slice(0, 30).reverse();

    return (
        <div className="runs-view">
            {stats ? (
                <div className="runs-summary">
                    <div className="runs-stat">
                        <span className="runs-stat-value">{stats.rate}%</span>
                        <span className="runs-stat-label">success ({stats.total} runs)</span>
                    </div>
                    <div className="runs-stat">
                        <span className="runs-stat-value">{stats.avg} ms</span>
                        <span className="runs-stat-label">avg duration</span>
                    </div>
                    <Sparkline records={chartRecords} />
                </div>
            ) : null}

            <table className="run-table runs-table">
                <thead>
                    <tr>
                        <th></th>
                        <th>When</th>
                        <th>Trigger</th>
                        <th className="run-num">Rows</th>
                        <th className="run-num">Time</th>
                    </tr>
                </thead>
                <tbody>
                    {records.map((r, i) => (
                        <tr key={i} className={`run-row run-row-${r.status}`}>
                            <td>
                                <StatusIcon status={r.status} />
                            </td>
                            <td>
                                <div className="runs-when" title={r.at}>
                                    {relativeTime(r.at)}
                                </div>
                                {r.error ? (
                                    <div className="run-node-error">
                                        {r.category ? (
                                            <span className="run-error-category">{r.category}</span>
                                        ) : null}
                                        {r.error}
                                    </div>
                                ) : null}
                            </td>
                            <td>{r.trigger}</td>
                            <td className="run-num">{r.rows.toLocaleString()}</td>
                            <td className="run-num">{r.duration_ms} ms</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
