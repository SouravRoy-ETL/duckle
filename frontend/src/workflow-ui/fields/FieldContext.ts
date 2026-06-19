import { createContext } from 'react';
import type { Column } from '../../pipeline-types';
import type { ConnectionPayload, RepoItem, RoutinePayload } from '../../repo-types';

export type ActiveContext = {
    id: string;
    name: string;
    variables: { key: string; value: string; secret?: boolean }[];
};

export type FieldContextValue = {
    upstreamSchema: Column[];
    nodeSchema: Column[];
    repoItems: RepoItem[];
    /** Workspace root, for resolving the ${workspace}/${projectroot} builtins. */
    workspacePath?: string | null;
    /** The context whose variables fields can bind to (if any). */
    activeContext?: ActiveContext;
    /** The selected node's current properties, so a field can read sibling
     *  values (e.g. the DuckLake snapshot picker needs the catalog `path`). */
    nodeProps?: Record<string, unknown>;
    onPickConnection?: (payload: ConnectionPayload) => void;
    onPickRoutine?: (payload: RoutinePayload, routineId: string) => void;
};

export const FieldContext = createContext<FieldContextValue>({
    upstreamSchema: [],
    nodeSchema: [],
    repoItems: [],
});
