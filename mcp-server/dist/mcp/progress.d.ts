import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import type { ProgressFn } from "../ue-bridge/run-control.js";
export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
/**
 * Build a {@link ProgressFn} from a tool handler's `extra`, or `undefined` when
 * the client requested no progress (no `progressToken`).
 */
export declare function progressFromExtra(extra: ToolExtra): ProgressFn | undefined;
//# sourceMappingURL=progress.d.ts.map