/** Emit a human-readable progress line to the MCP client. Monotonic under the hood. */
export type ProgressFn = (message: string) => void;
export interface RunControl {
    /** Aborts the spawned child process when the client cancels the request. */
    signal?: AbortSignal;
    /** Receives periodic + milestone progress messages. Undefined = no client interest. */
    onProgress?: ProgressFn;
}
/**
 * Wire an AbortSignal to a kill function. If the signal is already aborted,
 * `kill` is invoked synchronously. Returns a detach function to remove the
 * listener once the run completes (call it from the process `close` handler).
 */
export declare function linkAbort(signal: AbortSignal | undefined, kill: () => void): () => void;
/**
 * Start a periodic "still working" heartbeat. Returns a stop function.
 *
 * UE operations run for minutes with no intermediate output; without this the
 * client sees a silent hang. The heartbeat reports elapsed wall-clock time so
 * the user knows the build/test is alive.
 */
export declare function startHeartbeat(onProgress: ProgressFn | undefined, label: string, intervalMs?: number): () => void;
//# sourceMappingURL=run-control.d.ts.map