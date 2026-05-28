// Cross-environment IO helpers. In the Tauri desktop webview the browser
// primitives we'd normally reach for silently no-op:
//   - navigator.clipboard is undefined / blocked
//   - <a download> clicks don't trigger a real download
//   - window.open / <a target=_blank> don't open the system browser
// So in Tauri we route through the matching plugins; in a plain browser
// (the web build / dev server) we fall back to the standard APIs.

import { isTauri, tauriSavePath, type FileFilter } from './tauri-dialog';

/// Copy text to the system clipboard. Returns true on success.
export async function copyText(text: string): Promise<boolean> {
    if (isTauri()) {
        try {
            const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
            await writeText(text);
            return true;
        } catch (err) {
            console.error('clipboard write (tauri) failed', err);
            return false;
        }
    }
    try {
        await navigator.clipboard?.writeText(text);
        return true;
    } catch (err) {
        console.error('clipboard write (browser) failed', err);
        return false;
    }
}

/// Save text to a file. In Tauri this opens a native save dialog and
/// writes via the fs plugin; returns false if the user cancels. In the
/// browser it triggers a download. `defaultName` seeds the filename.
export async function saveTextFile(
    defaultName: string,
    content: string,
    filters?: FileFilter[],
): Promise<boolean> {
    if (isTauri()) {
        const path = await tauriSavePath({ defaultPath: defaultName, filters });
        if (!path) return false; // user cancelled
        try {
            const { writeTextFile } = await import('@tauri-apps/plugin-fs');
            await writeTextFile(path, content);
            return true;
        } catch (err) {
            console.error('file save (tauri) failed', err);
            return false;
        }
    }
    try {
        const blob = new Blob([content], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = defaultName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        return true;
    } catch (err) {
        console.error('file save (browser) failed', err);
        return false;
    }
}

/// Open a URL in the system browser.
export async function openExternal(url: string): Promise<void> {
    if (isTauri()) {
        try {
            const { openUrl } = await import('@tauri-apps/plugin-opener');
            await openUrl(url);
            return;
        } catch (err) {
            console.error('open external (tauri) failed', err);
        }
    }
    window.open(url, '_blank', 'noopener');
}
