import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { DuckleNodeData } from '../../pipeline-types';
import { getManifest } from '../../workflow-ui/fields/component-manifests';
import { metaFor } from '../connection-types';
import type { PortDef } from '../../workflow-ui/fields/types';

export type DuckleFlowNode = Node<DuckleNodeData>;

export default function DuckleNode({ data, selected, type }: NodeProps<DuckleFlowNode>) {
    const kind = type ?? 'transform';
    const manifest = getManifest(data.componentId);
    const ports = manifest?.ports;
    const inputs = ports?.inputs ?? [];
    const outputs = ports?.outputs ?? [];
    const portCount = Math.max(inputs.length, outputs.length);

    const classes =
        'node node-' + kind +
        (selected ? ' is-selected' : '') +
        (data.disabled ? ' is-disabled' : '');

    return (
        <div className={classes}>
            <div className="node-header">
                <div className="node-kind">{kind}</div>
                <div className="node-label">{data.label}</div>
                {data.subtitle ? <div className="node-subtitle">{data.subtitle}</div> : null}
                {data.disabled ? <div className="node-disabled-badge">disabled</div> : null}
            </div>
            {portCount > 0 ? (
                <div className="node-ports">
                    <div className="node-ports-col node-ports-inputs">
                        {inputs.map(port => (
                            <PortRow key={port.id} port={port} side="input" />
                        ))}
                    </div>
                    <div className="node-ports-col node-ports-outputs">
                        {outputs.map(port => (
                            <PortRow key={port.id} port={port} side="output" />
                        ))}
                    </div>
                </div>
            ) : null}
        </div>
    );
}

function PortRow({ port, side }: { port: PortDef; side: 'input' | 'output' }) {
    const meta = metaFor(port.type);
    const isInput = side === 'input';

    return (
        <div
            className={
                'node-port node-port-' +
                side +
                ' node-port-type-' +
                port.type +
                (port.optional ? ' is-optional' : '')
            }
            title={meta.label + ' · ' + meta.description}
        >
            {isInput ? (
                <Handle
                    type="target"
                    position={Position.Left}
                    id={port.id}
                    className="node-port-handle"
                    style={{ background: meta.color, borderColor: 'var(--bg-1)' }}
                />
            ) : null}
            {isInput ? (
                <>
                    <span
                        className="node-port-dot"
                        style={{ background: meta.color }}
                        aria-hidden="true"
                    />
                    <span className="node-port-label">{port.label}</span>
                </>
            ) : (
                <>
                    <span className="node-port-label">{port.label}</span>
                    <span
                        className="node-port-dot"
                        style={{ background: meta.color }}
                        aria-hidden="true"
                    />
                </>
            )}
            {!isInput ? (
                <Handle
                    type="source"
                    position={Position.Right}
                    id={port.id}
                    className="node-port-handle"
                    style={{ background: meta.color, borderColor: 'var(--bg-1)' }}
                />
            ) : null}
        </div>
    );
}
