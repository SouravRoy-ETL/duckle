// Standalone read-only share page for a dive or dashboard, served at /dive/<id>
// or /dash/<id> (the web server SPA-falls-back those paths to index.html, and
// the same-origin guard keeps the run path safe). It loads the artifact from the
// server workspace and renders it live - no editor chrome. See docs/design/dives.md.

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { RepoItem } from './repo-types';
import { loadWorkspace } from './workspace';
import { loadDive } from './dives/dive-io';
import { DivePanel } from './dives/DivePanel';
import { parseDashboard } from './dives/dashboard-types';
import type { Dive } from './dives/dive-types';

interface ShareViewProps {
    kind: 'dive' | 'dash';
    id: string;
}

export function ShareView({ kind, id }: ShareViewProps) {
    const [workspace, setWorkspace] = useState<string | null>(null);
    const [repo, setRepo] = useState<RepoItem[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const b = await invoke<{ workspace?: string }>('web_bootstrap');
                const ws = b?.workspace ?? '';
                const state = await loadWorkspace(ws);
                if (cancelled) return;
                setWorkspace(ws);
                setRepo((state?.repo as RepoItem[]) ?? []);
                setLoading(false);
            } catch (e) {
                if (!cancelled) {
                    setError(e instanceof Error ? e.message : String(e));
                    setLoading(false);
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    if (loading) return <div className="share-msg">Loading…</div>;
    if (error) return <div className="share-msg share-err">{error}</div>;

    const item = repo.find((i) => i.id === id);
    if (!item) return <div className="share-msg share-err">Not found: {id}</div>;

    if (kind === 'dive') {
        let dive: Dive;
        try {
            dive = loadDive(item.payload);
        } catch (e) {
            return <div className="share-msg share-err">{e instanceof Error ? e.message : String(e)}</div>;
        }
        return (
            <div className="share-page">
                <h1 className="share-title">{item.name}</h1>
                <DivePanel dive={dive} workspacePath={workspace} />
            </div>
        );
    }

    const parsed = parseDashboard(item.payload);
    if (!parsed.ok || !parsed.dashboard) {
        return <div className="share-msg share-err">{parsed.error ?? 'Invalid dashboard.'}</div>;
    }
    const cells = parsed.dashboard.diveIds.map((did) => repo.find((i) => i.id === did)).filter(Boolean) as RepoItem[];
    return (
        <div className="share-page">
            <h1 className="share-title">{item.name}</h1>
            <div className="dash-grid">
                {cells.map((di) => {
                    let dv: Dive | null = null;
                    try {
                        dv = loadDive(di.payload);
                    } catch {
                        dv = null;
                    }
                    return (
                        <div key={di.id} className="dash-cell">
                            {dv ? (
                                <DivePanel dive={dv} workspacePath={workspace} />
                            ) : (
                                <div className="share-msg">Missing dive: {di.id}</div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
