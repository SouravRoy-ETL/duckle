import { isTauri } from './tauri-dialog';

const WORKSPACE_FILE = 'workspace.json';
const WORKSPACE_PATH_KEY = 'duckle:workspace-path';

export type WorkspaceState = {
    version: number;
    engine?: string;
    pipelineData?: Record<string, unknown>;
    repo?: unknown[];
    jobs?: unknown[];
    activeJobId?: string;
};

export function isInTauri(): boolean {
    return isTauri();
}

export function getWorkspacePath(): string | null {
    try {
        return localStorage.getItem(WORKSPACE_PATH_KEY);
    } catch {
        return null;
    }
}

export function setWorkspacePath(path: string): void {
    try {
        localStorage.setItem(WORKSPACE_PATH_KEY, path);
    } catch {
        /* ignore */
    }
}

export function clearWorkspacePath(): void {
    try {
        localStorage.removeItem(WORKSPACE_PATH_KEY);
    } catch {
        /* ignore */
    }
}

function joinPath(dir: string, name: string): string {
    // Normalize path separator — Tauri accepts both / and \ on Windows,
    // but stay consistent with whatever the user picked.
    if (dir.endsWith('/') || dir.endsWith('\\')) return dir + name;
    if (dir.includes('\\')) return dir + '\\' + name;
    return dir + '/' + name;
}

export async function pickWorkspaceDirectory(): Promise<string | null> {
    if (!isTauri()) return null;
    try {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const result = await open({
            directory: true,
            multiple: false,
            title: 'Choose Duckle workspace folder',
        });
        return typeof result === 'string' ? result : null;
    } catch (err) {
        console.error('Workspace picker failed', err);
        return null;
    }
}

export async function loadWorkspace(path: string): Promise<WorkspaceState | null> {
    if (!isTauri()) return null;
    try {
        const { readTextFile, exists } = await import('@tauri-apps/plugin-fs');
        const filePath = joinPath(path, WORKSPACE_FILE);
        if (!(await exists(filePath))) return null;
        const content = await readTextFile(filePath);
        return JSON.parse(content) as WorkspaceState;
    } catch (err) {
        console.error('Failed to load workspace', err);
        return null;
    }
}

export async function saveWorkspace(path: string, state: WorkspaceState): Promise<void> {
    if (!isTauri()) return;
    try {
        const { writeTextFile, mkdir, exists } = await import('@tauri-apps/plugin-fs');
        if (!(await exists(path))) {
            await mkdir(path, { recursive: true });
        }
        const filePath = joinPath(path, WORKSPACE_FILE);
        await writeTextFile(filePath, JSON.stringify(state, null, 2));
    } catch (err) {
        console.error('Failed to save workspace', err);
    }
}
