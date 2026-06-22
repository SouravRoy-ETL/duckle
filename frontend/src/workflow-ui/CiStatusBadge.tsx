import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, CircleDashed, Loader2, XCircle } from 'lucide-react';
import { workspaceCiStatus, type CiStatus } from '../tauri-bridge';
import { openExternal } from '../tauri-io';

type Props = {
    workspacePath: string;
};

/**
 * Tiny topbar badge that polls the latest CI build status for the
 * workspace's configured remote. Click to open the build in your
 * browser. Hidden when there's no workspace or no remote configured.
 *
 * Polls every 30 s. Light enough that we don't bother with manual
 * refresh buttons; the GitPanel has its own refresh.
 */
export default function CiStatusBadge({ workspacePath }: Props) {
    const [status, setStatus] = useState<CiStatus | null>(null);
    const [loading, setLoading] = useState(true);

    const refresh = useCallback(async () => {
        if (!workspacePath) {
            setStatus(null);
            setLoading(false);
            return;
        }
        const s = await workspaceCiStatus(workspacePath);
        setStatus(s);
        setLoading(false);
    }, [workspacePath]);

    useEffect(() => {
        // Defer the first poll off the launch path: this shells `git` to read the
        // remote/branch, and on some Windows setups git's child processes
        // (fsmonitor daemon, credential manager, askpass) briefly flash a console
        // at startup. Polling a few seconds after the app is interactive avoids
        // that jarring "is this malware?" flash; git_cmd is also hardened so the
        // call itself stays silent.
        const first = window.setTimeout(() => void refresh(), 5_000);
        const interval = window.setInterval(refresh, 30_000);
        return () => {
            window.clearTimeout(first);
            window.clearInterval(interval);
        };
    }, [refresh]);

    if (!workspacePath || loading) return null;
    if (!status || status.state === 'none') return null;

    const tone = {
        success: 'ok',
        failure: 'fail',
        cancelled: 'fail',
        in_progress: 'busy',
        pending: 'busy',
        unknown: 'mute',
    }[status.state];

    const icon =
        status.state === 'success' ? (
            <CheckCircle2 size={12} />
        ) : status.state === 'failure' || status.state === 'cancelled' ? (
            <XCircle size={12} />
        ) : status.state === 'in_progress' || status.state === 'pending' ? (
            <Loader2 size={12} className="spin" />
        ) : (
            <CircleDashed size={12} />
        );

    const handleClick = () => {
        if (status.url) {
            void openExternal(status.url);
        }
    };

    return (
        <button
            type="button"
            className={`ci-badge ci-badge-${tone}`}
            onClick={handleClick}
            disabled={!status.url}
            title={`${status.label}${status.sha ? ` @ ${status.sha}` : ''}`}
            aria-label={status.label}
        >
            {icon}
            <span className="ci-badge-label">CI</span>
        </button>
    );
}
