// Duckle brand mark: the pixel-art orange "D" sloth. Transparent PNG (the sloth
// is negative space) so it reads on both dark and light surfaces; the soft glow
// comes from the .brand-logo CSS filter. Decorative by default - the adjacent
// "Duckle" wordmark carries the accessible name.
import logoUrl from './duckle-logo-pixel.png';

export function DuckleLogo({ size = 24, className }: { size?: number; className?: string }) {
    return (
        <img
            src={logoUrl}
            width={size}
            height={size}
            className={className ? `duckle-logo ${className}` : 'duckle-logo'}
            alt=""
            aria-hidden="true"
        />
    );
}
