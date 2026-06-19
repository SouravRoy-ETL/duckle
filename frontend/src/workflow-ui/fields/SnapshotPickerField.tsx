import { useContext, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Loader2, History } from 'lucide-react';
import type { Field } from './types';
import { FieldContext } from './FieldContext';
import { tauriAutodetect } from '../../tauri-bridge';

type Props = {
    field: Field;
    value: string | undefined;
    onChange: (v: unknown) => void;
};

type Snapshot = { snapshot_id: number | string; snapshot_time?: string };

/**
 * DuckLake "AS OF" version field with a Browse button that lists the catalog's
 * snapshots (via the ducklake_snapshots inspect format) and fills the chosen
 * snapshot id. Reads the catalog `path` from the node's sibling props.
 */
export function SnapshotPickerField({ field, value, onChange }: Props) {
    const ctx = useContext(FieldContext);
    const catalog = (ctx.nodeProps?.path as string | undefined)?.trim();
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [snaps, setSnaps] = useState<Snapshot[]>([]);

    const browse = async () => {
        setError(null);
        setSnaps([]);
        setOpen(true);
        if (!catalog) {
            setError('Set the catalog path first.');
            return;
        }
        setLoading(true);
        try {
            const r = await tauriAutodetect('ducklake_snapshots', { path: catalog });
            if (!r) {
                setError('Could not read snapshots (is the catalog path correct?).');
            } else {
                setSnaps((r.sampleRows ?? []) as Snapshot[]);
            }
        } catch (e) {
            setError(String(e));
        } finally {
            setLoading(false);
        }
    };

    const rowBtn: React.CSSProperties = {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        width: '100%',
        gap: 12,
        padding: '8px 10px',
        borderRadius: 8,
        border: '1px solid var(--border-2, #2a2a2a)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        marginBottom: 6,
        textAlign: 'left',
    };

    return (
        <>
            <div style={{ display: 'flex', gap: 6 }}>
                <input
                    className="field-input"
                    type="text"
                    value={value ?? ''}
                    onChange={e => onChange(e.target.value)}
                    placeholder={field.placeholder}
                    spellCheck={false}
                    style={{ flex: 1 }}
                />
                <button
                    type="button"
                    onClick={browse}
                    title="Browse DuckLake snapshots"
                    style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 5,
                        padding: '0 10px',
                        borderRadius: 8,
                        border: '1px solid var(--border-2, #2a2a2a)',
                        background: 'transparent',
                        color: 'inherit',
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                    }}
                >
                    <History size={13} /> Browse
                </button>
            </div>
            {open
                ? createPortal(
                      <div
                          className="modal-backdrop"
                          onClick={e => {
                              if (e.target === e.currentTarget) setOpen(false);
                          }}
                      >
                          <div
                              className="modal"
                              role="dialog"
                              aria-modal="true"
                              aria-label="DuckLake snapshots"
                              style={{ maxWidth: 460 }}
                          >
                              <div className="modal-header">
                                  <div className="modal-title">DuckLake snapshots</div>
                                  <button
                                      type="button"
                                      className="modal-close"
                                      onClick={() => setOpen(false)}
                                      aria-label="Close"
                                  >
                                      <X size={16} />
                                  </button>
                              </div>
                              <div className="modal-body" style={{ maxHeight: 360, overflowY: 'auto' }}>
                                  {loading ? (
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: 0.7 }}>
                                          <Loader2 size={14} className="spin" /> Loading snapshots...
                                      </div>
                                  ) : null}
                                  {error ? (
                                      <div style={{ color: 'var(--danger, #ff4d6d)', fontSize: 12 }}>{error}</div>
                                  ) : null}
                                  {!loading && !error && snaps.length === 0 ? (
                                      <div style={{ opacity: 0.7, fontSize: 12 }}>No snapshots found.</div>
                                  ) : null}
                                  {snaps.map((s, i) => (
                                      <button
                                          key={i}
                                          type="button"
                                          style={rowBtn}
                                          onClick={() => {
                                              onChange(String(s.snapshot_id));
                                              setOpen(false);
                                          }}
                                      >
                                          <b style={{ fontVariantNumeric: 'tabular-nums' }}>
                                              v{String(s.snapshot_id)}
                                          </b>
                                          <span style={{ opacity: 0.7, fontSize: 12 }}>
                                              {s.snapshot_time ? String(s.snapshot_time) : ''}
                                          </span>
                                      </button>
                                  ))}
                              </div>
                          </div>
                      </div>,
                      document.body
                  )
                : null}
        </>
    );
}
