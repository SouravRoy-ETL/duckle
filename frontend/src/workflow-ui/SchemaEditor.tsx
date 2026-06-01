import { X } from 'lucide-react';
import { DATA_TYPES, type Column, type DataType } from '../pipeline-types';

type Props = {
    columns: Column[];
    onChange: (columns: Column[]) => void;
    readOnly?: boolean;
};

export default function SchemaEditor({ columns, onChange, readOnly = false }: Props) {
    const update = (i: number, patch: Partial<Column>) => {
        const next = columns.map((c, idx) => (idx === i ? { ...c, ...patch } : c));
        onChange(next);
    };

    const addColumn = () => {
        onChange([
            ...columns,
            { name: 'col_' + (columns.length + 1), type: 'string', nullable: true },
        ]);
    };

    const removeColumn = (i: number) => {
        onChange(columns.filter((_, idx) => idx !== i));
    };

    return (
        <div className="schema-editor">
            <div className="schema-toolbar">
                <span className="schema-count">
                    {columns.length} column{columns.length === 1 ? '' : 's'}
                </span>
                {!readOnly ? (
                    <button type="button" className="schema-add" onClick={addColumn}>
                        + Add column
                    </button>
                ) : null}
            </div>
            <div className="schema-table">
                <div className="schema-row schema-header-row">
                    <div className="schema-cell schema-cell-name">Name</div>
                    <div className="schema-cell schema-cell-type">Type</div>
                    <div className="schema-cell schema-cell-format">Format</div>
                    <div className="schema-cell schema-cell-null">Null</div>
                    <div className="schema-cell schema-cell-pk">PK</div>
                    {!readOnly ? <div className="schema-cell schema-cell-action" /> : null}
                </div>
                {columns.length === 0 ? (
                    <div className="schema-empty">No columns. Click + Add column to define one.</div>
                ) : null}
                {columns.map((c, i) => (
                    <div className="schema-row" key={i}>
                        <div className="schema-cell schema-cell-name">
                            <input
                                type="text"
                                className="schema-input"
                                value={c.name}
                                onChange={e => update(i, { name: e.target.value })}
                                disabled={readOnly}
                                spellCheck={false}
                            />
                        </div>
                        <div className="schema-cell schema-cell-type">
                            <select
                                className="schema-input"
                                value={c.type}
                                onChange={e => update(i, { type: e.target.value as DataType })}
                                disabled={readOnly}
                            >
                                {DATA_TYPES.map(t => (
                                    <option key={t} value={t}>
                                        {t}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className="schema-cell schema-cell-format">
                            {c.type === 'date' || c.type === 'timestamp' ? (
                                <input
                                    type="text"
                                    className="schema-input"
                                    value={c.format ?? ''}
                                    onChange={e =>
                                        update(i, { format: e.target.value || undefined })
                                    }
                                    disabled={readOnly}
                                    spellCheck={false}
                                    placeholder="%d/%m/%Y"
                                    title="strptime format, e.g. %d/%m/%Y. Leave blank to auto-detect. A wrong format makes unmatched values empty."
                                />
                            ) : null}
                        </div>
                        <div className="schema-cell schema-cell-null">
                            <input
                                type="checkbox"
                                checked={c.nullable}
                                onChange={e => update(i, { nullable: e.target.checked })}
                                disabled={readOnly}
                            />
                        </div>
                        <div className="schema-cell schema-cell-pk">
                            <input
                                type="checkbox"
                                checked={c.primaryKey ?? false}
                                onChange={e => update(i, { primaryKey: e.target.checked })}
                                disabled={readOnly}
                            />
                        </div>
                        {!readOnly ? (
                            <div className="schema-cell schema-cell-action">
                                <button
                                    type="button"
                                    className="schema-remove"
                                    onClick={() => removeColumn(i)}
                                    aria-label={'Remove ' + c.name}
                                >
                                    <X size={12} />
                                </button>
                            </div>
                        ) : null}
                    </div>
                ))}
            </div>
        </div>
    );
}
