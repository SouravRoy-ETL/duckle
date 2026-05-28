import { useEffect, useState } from 'react';
import { ListTree, Clipboard } from 'lucide-react';
import type { Edge, Node } from '@xyflow/react';
import { compilePipelineSql, type StageSql } from '../tauri-bridge';
import { copyText } from '../tauri-io';
import type { DuckleNodeData } from '../pipeline-types';

type Props = {
    nodes: Node<DuckleNodeData>[];
    edges: Edge[];
};

// Live view of the compiled DuckDB SQL. Recompiles whenever the graph
// changes so the user can see exactly what each node lowers to (and
// catch planner-time errors - missing columns, bad joins - without
// having to run the pipeline).
export default function PlanView({ nodes, edges }: Props) {
    const [stages, setStages] = useState<StageSql[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        let cancelled = false;
        if (nodes.length === 0) {
            setStages(null);
            setError(null);
            return;
        }
        setLoading(true);
        // Small debounce so we don't recompile on every keystroke while
        // the user edits node properties.
        const handle = setTimeout(async () => {
            try {
                const result = await compilePipelineSql(nodes, edges);
                if (cancelled) return;
                if (result === null) {
                    setStages(null);
                    setError(null); // browser/dev mode: engine not available
                } else {
                    setStages(result);
                    setError(null);
                }
            } catch (err) {
                if (cancelled) return;
                setStages(null);
                setError(String(err));
            } finally {
                if (!cancelled) setLoading(false);
            }
        }, 250);
        return () => {
            cancelled = true;
            clearTimeout(handle);
        };
    }, [nodes, edges]);

    if (nodes.length === 0) {
        return (
            <div className="empty-state">
                <ListTree size={32} strokeWidth={1.4} className="empty-icon" />
                <div className="empty-title">Plan preview</div>
                <div className="empty-desc">
                    Add components to the canvas and the compiled DuckDB SQL for each step will
                    appear here.
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="plan-view">
                <div className="plan-error">
                    <div className="plan-error-title">Pipeline does not compile</div>
                    <pre className="plan-error-body">{error}</pre>
                </div>
            </div>
        );
    }

    if (!stages) {
        return (
            <div className="empty-state">
                <ListTree size={32} strokeWidth={1.4} className="empty-icon" />
                <div className="empty-title">Plan preview</div>
                <div className="empty-desc">
                    {loading
                        ? 'Compiling...'
                        : 'The compiled SQL appears here in the desktop app once the pipeline validates.'}
                </div>
            </div>
        );
    }

    const fullSql = stages
        .map(s => `-- ${s.kind.toUpperCase()} · ${s.label} (${s.node_id})\n${s.sql};`)
        .join('\n\n');

    return (
        <div className="plan-view">
            <div className="plan-view-toolbar">
                <span className="plan-view-count">
                    {stages.length} stage{stages.length === 1 ? '' : 's'}
                </span>
                <button
                    type="button"
                    className="plan-copy-btn"
                    onClick={() => void copyText(fullSql)}
                    title="Copy all SQL"
                >
                    <Clipboard size={12} /> Copy SQL
                </button>
            </div>
            <div className="plan-stages">
                {stages.map(s => (
                    <div className="plan-stage" key={s.node_id}>
                        <div className="plan-stage-head">
                            <span className={`plan-stage-kind plan-stage-kind-${s.kind}`}>
                                {s.kind}
                            </span>
                            <span className="plan-stage-label">{s.label}</span>
                            <span className="plan-stage-id">{s.node_id}</span>
                        </div>
                        <pre className="plan-stage-sql">{s.sql};</pre>
                    </div>
                ))}
            </div>
        </div>
    );
}
