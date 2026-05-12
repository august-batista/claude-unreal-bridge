import type { BlueprintInfo } from "../types/blueprint.js";
/**
 * Format a BlueprintInfo as human-readable markdown text.
 *
 * Detail levels:
 *   summary    — signatures and metadata, no graph bodies
 *   full       — everything: signatures + function bodies + event graphs
 *   graph-only — function bodies + event graphs, no vars/components/dispatchers
 */
export declare function formatBlueprintAsMarkdown(bp: BlueprintInfo, detail?: "summary" | "full" | "graph-only"): string;
/**
 * Validate that the JSON data looks like a valid BlueprintInfo.
 */
export declare function validateBlueprintJson(data: unknown): data is BlueprintInfo;
//# sourceMappingURL=blueprint-json.d.ts.map