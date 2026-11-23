/**
 * Types for the self-hosted executor map (`executors.js`), so the contract tests
 * can hold the bundle to the same shapes as the hosted context.
 */
export type LocalExecutor = (supabase: any, args?: Record<string, any>) => Promise<any>;

export declare const LOCAL_ADVERTISED_EXECUTORS: Record<string, LocalExecutor>;
export declare const LOCAL_EXTRA_EXECUTORS: Record<string, LocalExecutor>;
export declare const LOCAL_REPO_TOOL_EXECUTORS: Record<string, LocalExecutor>;
export declare const LOCAL_TOOL_EXECUTORS: Record<string, LocalExecutor>;
