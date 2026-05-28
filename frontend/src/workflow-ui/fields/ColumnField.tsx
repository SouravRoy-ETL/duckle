import { useContext } from 'react';
import type { Field } from './types';
import { FieldContext } from './FieldContext';

type Props = {
    field: Field;
    value: string | undefined;
    onChange: (v: string) => void;
};

export function ColumnField({ field: _field, value, onChange }: Props) {
    const { upstreamSchema } = useContext(FieldContext);
    const names = upstreamSchema.map(c => c.name);
    // A previously-picked column that is no longer in the upstream (the
    // source changed, an upstream rename, etc.). We must still render it
    // as a selectable option, otherwise the stale value is invisible in
    // the dropdown but still saved in the config - the user can't see or
    // change it, and the pipeline keeps failing on a column they can't
    // find in the UI.
    const staleValue = value && !names.includes(value) ? value : null;

    if (upstreamSchema.length === 0 && !staleValue) {
        return (
            <div className="field-input field-warning">
                No upstream schema. Connect an input to populate this list.
            </div>
        );
    }

    return (
        <select
            className="field-input field-select"
            value={value ?? ''}
            onChange={e => onChange(e.target.value)}
        >
            <option value="">- select column -</option>
            {upstreamSchema.map(c => (
                <option key={c.name} value={c.name}>
                    {c.name}  ({c.type})
                </option>
            ))}
            {staleValue ? (
                <option value={staleValue}>{staleValue}  (not in input)</option>
            ) : null}
        </select>
    );
}

type MultiProps = {
    field: Field;
    value: string[] | undefined;
    onChange: (v: string[]) => void;
};

export function ColumnsField({ value, onChange }: MultiProps) {
    const { upstreamSchema } = useContext(FieldContext);
    const selected = new Set(value ?? []);
    const upstreamNames = new Set(upstreamSchema.map(c => c.name));
    // Selected columns that are no longer in the upstream. Render them too
    // (flagged "not in input") so the user can SEE and uncheck them. Without
    // this, a stale selection - e.g. an "order_id" left over after the
    // source was swapped to a file that doesn't have it - has no checkbox,
    // so it stays in the config invisibly and keeps failing the run with no
    // way to remove it from the UI.
    const stale = (value ?? []).filter(n => !upstreamNames.has(n));

    if (upstreamSchema.length === 0 && stale.length === 0) {
        return (
            <div className="field-input field-warning">
                No upstream schema. Connect an input to populate this list.
            </div>
        );
    }

    const toggle = (name: string) => {
        const next = new Set(selected);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        onChange(Array.from(next));
    };

    return (
        <div className="field-columns">
            {upstreamSchema.map(c => (
                <label key={c.name} className="field-columns-row">
                    <input
                        type="checkbox"
                        checked={selected.has(c.name)}
                        onChange={() => toggle(c.name)}
                    />
                    <span className="field-columns-name">{c.name}</span>
                    <span className="field-columns-type">{c.type}</span>
                </label>
            ))}
            {stale.map(name => (
                <label key={name} className="field-columns-row field-columns-stale">
                    <input type="checkbox" checked onChange={() => toggle(name)} />
                    <span className="field-columns-name">{name}</span>
                    <span className="field-columns-type">not in input</span>
                </label>
            ))}
        </div>
    );
}
