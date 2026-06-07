// Adapter: turn an MCP tool-call `extra` into the transport-agnostic
// `ProgressFn` the UE bridge runners speak.
//
// MCP progress works like this: if the client attached a `progressToken` to
// the request's `_meta`, the server MAY stream `notifications/progress` carrying
// that token. `progress` must strictly increase; we keep a monotonic counter so
// callers only need to supply a message. If the client sent no token there's
// nothing to report to, so we return `undefined` and the runners stay silent.
/**
 * Build a {@link ProgressFn} from a tool handler's `extra`, or `undefined` when
 * the client requested no progress (no `progressToken`).
 */
export function progressFromExtra(extra) {
    const token = extra._meta?.progressToken;
    if (token === undefined || token === null)
        return undefined;
    let count = 0;
    return (message) => {
        count += 1;
        void extra
            .sendNotification({
            method: "notifications/progress",
            params: {
                progressToken: token,
                progress: count,
                message,
            },
        })
            .catch(() => {
            // Best effort — the client may have disconnected or cancelled.
        });
    };
}
//# sourceMappingURL=progress.js.map