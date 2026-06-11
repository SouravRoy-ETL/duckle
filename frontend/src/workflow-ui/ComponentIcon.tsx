import type { ComponentType } from 'react';
import {
    ArrowDownToLine,
    ArrowUpFromLine,
    Workflow,
    GitFork,
    ShieldCheck,
    Code2,
    Table,
    Braces,
    FileCode,
    Globe,
    Webhook,
    Network,
    Mail,
    Clipboard,
    Boxes,
    Layers,
    Radio,
    AlignLeft,
    Database,
} from 'lucide-react';
import { BRAND_ICONS, type BrandIcon } from './brand-icons.generated';
import type { NodeKind } from './palette-data';

type IconProps = { size?: number; className?: string };

// Connector base name = component id minus its type prefix (src./snk./xf./...).
function baseName(componentId: string): string {
    const dot = componentId.indexOf('.');
    return dot >= 0 ? componentId.slice(dot + 1) : componentId;
}

/** The brand mark for a component, if one exists (e.g. src.postgres -> PostgreSQL). */
export function brandIconFor(componentId: string): BrandIcon | undefined {
    const base = baseName(componentId);
    // Try the full base first (e.g. "excel-online"), then the head before any
    // sub-dot (e.g. "ducklake.changes" -> "ducklake").
    return BRAND_ICONS[base] ?? BRAND_ICONS[base.split('.')[0]];
}

// Generic lucide fallbacks for components without a brand mark, by base name.
const BASE_FALLBACK: Record<string, ComponentType<IconProps>> = {
    csv: Table,
    tsv: Table,
    json: Braces,
    jsonl: Braces,
    xml: FileCode,
    fixedwidth: AlignLeft,
    rest: Globe,
    http: Globe,
    odata: Globe,
    soap: FileCode,
    grpc: Network,
    webhook: Webhook,
    email: Mail,
    clipboard: Clipboard,
    ftp: ArrowUpFromLine,
    iceberg: Layers,
    redpanda: Radio,
    kinesis: Radio,
    pinecone: Boxes,
    weaviate: Boxes,
    chroma: Boxes,
    lancedb: Boxes,
};

// Last-resort fallback by node kind.
const KIND_FALLBACK: Record<NodeKind, ComponentType<IconProps>> = {
    source: ArrowDownToLine,
    sink: ArrowUpFromLine,
    transform: Workflow,
    control: GitFork,
    quality: ShieldCheck,
    custom: Code2,
};

type Props = { componentId: string; kind: NodeKind; size?: number; className?: string };

/**
 * Native brand mark for a connector (monochrome, rendered in currentColor), with
 * a sensible generic fallback for non-brand components and transforms.
 */
export default function ComponentIcon({ componentId, kind, size = 14, className }: Props) {
    const brand = brandIconFor(componentId);
    if (brand && 'svg' in brand) {
        // Full-colour gilbarbara logo, rendered as a self-contained image so its
        // own fills/gradients show through (data URI = no XSS surface).
        return (
            <img
                src={`data:image/svg+xml;utf8,${encodeURIComponent(brand.svg)}`}
                alt={brand.title}
                width={size}
                height={size}
                className={className}
                style={{ objectFit: 'contain' }}
                draggable={false}
            />
        );
    }
    if (brand) {
        // Single-mark brand tinted with its official colour.
        return (
            <svg
                role="img"
                aria-label={brand.title}
                viewBox="0 0 24 24"
                width={size}
                height={size}
                fill={brand.color}
                className={className}
            >
                <path d={brand.path} />
            </svg>
        );
    }
    const base = baseName(componentId);
    const Fallback =
        BASE_FALLBACK[base] ?? BASE_FALLBACK[base.split('.')[0]] ?? KIND_FALLBACK[kind] ?? Database;
    return <Fallback size={size} className={className} />;
}
