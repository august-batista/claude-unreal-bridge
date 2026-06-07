// Shared cancellation + progress plumbing for the UE bridge runners.
//
// This module deliberately has NO dependency on the MCP SDK — it speaks in
// plain `AbortSignal` + a `(message) => void` callback so the runner layer
// stays transport-agnostic and unit-testable. The SDK-facing adapter that
// turns an MCP request's `extra` into a `ProgressFn` lives in
// `src/mcp/progress.ts`.

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
export function linkAbort(
  signal: AbortSignal | undefined,
  kill: () => void,
): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    kill();
    return () => {};
  }
  const onAbort = () => kill();
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/**
 * Start a periodic "still working" heartbeat. Returns a stop function.
 *
 * UE operations run for minutes with no intermediate output; without this the
 * client sees a silent hang. The heartbeat reports elapsed wall-clock time so
 * the user knows the build/test is alive.
 */
export function startHeartbeat(
  onProgress: ProgressFn | undefined,
  label: string,
  intervalMs = 4000,
): () => void {
  if (!onProgress) return () => {};
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const secs = Math.round((Date.now() - startedAt) / 1000);
    onProgress(`${label} (${secs}s elapsed)…`);
  }, intervalMs);
  // Don't keep the event loop alive purely for the heartbeat.
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}
