import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { Edge } from '@xyflow/react';
import { metaFor, type ConnectionType } from './connection-types';

type Props = {
    edge: Edge;
    onSave: (patch: { label?: string; condition?: string }) => void;
    onCancel: () => void;
};

export default function EdgeEditorModal({ edge, onSave, onCancel }: Props) {
    const type = ((edge.data as { connectionType?: ConnectionType } | undefined)?.connectionType ??
        'main') as ConnectionType;
    const meta = metaFor(type);
    const showCondition = Boolean(meta.expressionRequired);
    const data = edge.data as { label?: string; condition?: string } | undefined;
    const [label, setLabel] = useState(data?.label ?? '');
    const [condition, setCondition] = useState(data?.condition ?? '');
    const ref = useRef<HTMLInputElement>(null);

    useEffect(() => {
        setTimeout(() => ref.current?.focus(), 30);
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onCancel();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onCancel]);

    const handleSave = () => {
        onSave({
            label: label.trim() || undefined,
            condition: showCondition ? condition.trim() || undefined : undefined,
        });
    };

    return createPortal(
        <div
            className="modal-backdrop"
            role="dialog"
            aria-modal="true"
            onClick={e => {
                if (e.target === e.currentTarget) onCancel();
            }}
        >
            <div className="modal modal-edge-editor">
                <div className="modal-header">
                    <div className="modal-title">
                        Edit{' '}
                        <span
                            className="edge-label-badge"
                            style={{ display: 'inline-block', marginLeft: 6 }}
                        >
                            {meta.badge ?? meta.label}
                        </span>{' '}
                        connection
                    </div>
                    <button
                        type="button"
                        className="modal-close"
                        onClick={onCancel}
                        aria-label="Close"
                    >
                        <X size={16} />
                    </button>
                </div>
                <div className="modal-body">
                    <div className="modal-field">
                        <label className="modal-field-label">Label (optional)</label>
                        <input
                            ref={ref}
                            type="text"
                            className="modal-input"
                            value={label}
                            placeholder="e.g. row1, paid_orders"
                            onChange={e => setLabel(e.target.value)}
                            onKeyDown={e => {
                                if (e.key === 'Enter' && !showCondition) {
                                    e.preventDefault();
                                    handleSave();
                                }
                            }}
                            spellCheck={false}
                        />
                    </div>
                    {showCondition ? (
                        <div className="modal-field">
                            <label className="modal-field-label">
                                Condition (boolean expression)
                            </label>
                            <textarea
                                className="modal-input modal-input-path"
                                value={condition}
                                placeholder="row.amount > 100 AND row.currency = 'USD'"
                                onChange={e => setCondition(e.target.value)}
                                rows={3}
                                spellCheck={false}
                            />
                            <div className="modal-field-hint">
                                The trigger fires when this expression evaluates to true at runtime.
                            </div>
                        </div>
                    ) : null}
                    <div className="modal-tip" style={{ marginTop: 8 }}>
                        <span style={{ flexShrink: 0 }}>{meta.label}</span>
                    </div>
                </div>
                <div className="modal-footer">
                    <button type="button" className="btn btn-secondary" onClick={onCancel}>
                        Cancel
                    </button>
                    <button type="button" className="btn btn-primary" onClick={handleSave}>
                        Save
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
