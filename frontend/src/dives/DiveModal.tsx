// Opens a saved dive in a modal: parses the repo item's payload into a Dive and
// hands it to DivePanel, which runs the query live and renders the chart + table.
// See docs/design/dives.md.

import type { RepoItem } from '../repo-types';
import { loadDive } from './dive-io';
import { DivePanel } from './DivePanel';

interface DiveModalProps {
    item: RepoItem | null;
    workspacePath: string | null;
    theme?: 'light' | 'dark';
    onClose: () => void;
}

export function DiveModal({ item, workspacePath, theme, onClose }: DiveModalProps) {
    let error: string | null = null;
    let dive = null;
    try {
        if (item?.payload) dive = loadDive(item.payload);
        else error = 'This dive has no saved definition yet.';
    } catch (e) {
        error = e instanceof Error ? e.message : String(e);
    }

    return (
        <div className="dive-modal-backdrop" onClick={onClose}>
            <div className="dive-modal" onClick={(e) => e.stopPropagation()}>
                <div className="dive-modal-head">
                    <span>{item?.name ?? 'Dive'}</span>
                    <button className="dive-modal-x" onClick={onClose} aria-label="Close" title="Close">
                        ×
                    </button>
                </div>
                <div className="dive-modal-body">
                    {error ? (
                        <div className="dive-panel-msg dive-panel-err">{error}</div>
                    ) : dive ? (
                        <DivePanel dive={dive} workspacePath={workspacePath} theme={theme} />
                    ) : null}
                </div>
            </div>
        </div>
    );
}
