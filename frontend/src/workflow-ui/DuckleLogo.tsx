// Duckle "D." brand mark: a disc with a half-disc "D" and a dot. Disc, glyph
// and ring colors come from the --logo-* CSS variables so the mark follows the
// active theme (yellow-on-slate in dark, orange on light). Decorative by
// default - the adjacent "Duckle" wordmark carries the accessible name.

export function DuckleLogo({ size = 24, className }: { size?: number; className?: string }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 256 256"
            className={className ? `duckle-logo ${className}` : 'duckle-logo'}
            aria-hidden="true"
        >
            <circle className="duckle-logo-disc" cx="128" cy="128" r="120" vectorEffect="non-scaling-stroke" />
            <g className="duckle-logo-glyph">
                <path d="M56 54 A74 74 0 0 1 56 202 Z" />
                <circle cx="173" cy="128" r="27" />
            </g>
        </svg>
    );
}
