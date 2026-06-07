import { z } from "zod";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { detectProject, normalizeToAssetPath } from "../ue-bridge/project-detector.js";
import { runPythonInUE } from "../ue-bridge/python-runner.js";
import { progressFromExtra } from "../mcp/progress.js";
import { graphEditStructuredShape } from "../mcp/output-schemas.js";

const pluginRoot = process.env.PLUGIN_ROOT || process.cwd();

interface OpResult {
  index: number;
  op: string;
  ok?: boolean;
  guid?: string;
  error?: string;
}
interface GraphEditResult {
  success: boolean;
  asset_path: string;
  graph: string;
  operations: OpResult[];
  handles: Record<string, string>;
  compiled?: boolean | null;
  saved?: boolean | null;
  auto_layout?: boolean | null;
  nodes?: string[];
  connections?: string[];
  error?: string;
  compile_error?: string;
  save_error?: string;
  auto_layout_error?: string;
}

/** Parse a "fromGuid|fromPin|toGuid|toPin|kind" edge string into an object. */
function parseConnection(s: string): {
  from: string;
  fromPin: string;
  to: string;
  toPin: string;
  kind: string;
} | null {
  const p = String(s).split("|");
  if (p.length < 5) return null;
  return { from: p[0], fromPin: p[1], to: p[2], toPin: p[3], kind: p[4] };
}

// Discriminated union of graph operations. Node references ("from"/"to"/"node")
// are either a local `id` assigned by an earlier add op in THIS batch, or an
// existing node GUID (from read-blueprint). Exec pins are named `then` (output)
// and `execute` (input); a function's data input pins use the UE parameter name.
const opSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("addFunctionNode"),
    id: z.string().optional().describe("Local handle for referencing this new node in later ops."),
    functionOwner: z
      .string()
      .describe("Class that owns the function: a UE Python class name (e.g. \"SystemLibrary\" = UKismetSystemLibrary, \"GameplayStatics\", \"MathLibrary\"), or a full class path (\"/Script/Engine.KismetSystemLibrary\", \"/Game/.../BP_Foo.BP_Foo_C\")."),
    functionName: z.string().describe("Function name, e.g. \"PrintString\"."),
    x: z.number().optional().describe("Node X position (default 0)."),
    y: z.number().optional().describe("Node Y position (default 0)."),
  }),
  z.object({
    op: z.literal("addCustomEvent"),
    id: z.string().optional().describe("Local handle for referencing this new node in later ops."),
    eventName: z.string().describe("Custom event name."),
    x: z.number().optional(),
    y: z.number().optional(),
  }),
  z.object({
    op: z.literal("connect"),
    from: z.string().describe("Source node: a local id from an earlier add op, or an existing node GUID."),
    fromPin: z.string().describe("Output pin name. Exec output is \"then\"."),
    to: z.string().describe("Target node: a local id or existing node GUID."),
    toPin: z.string().describe("Input pin name. Exec input is \"execute\"."),
  }),
  z.object({
    op: z.literal("setPinDefault"),
    node: z.string().describe("Node local id or GUID."),
    pin: z.string().describe("Input pin name (the UE parameter name, e.g. \"InString\")."),
    value: z.string().describe("Literal default value as a string."),
  }),
  z.object({
    op: z.literal("deleteNode"),
    node: z.string().describe("Node local id or GUID to delete (breaks its links)."),
  }),
  z.object({
    op: z.literal("addMemberVariable"),
    name: z.string().describe("Variable name to create on the blueprint."),
    varType: z
      .enum(["int", "bool", "float", "string", "name", "byte"])
      .default("int")
      .describe("Variable type."),
    default: z.string().optional().describe("Default value as a string, e.g. \"100\" or \"true\"."),
  }),
  z.object({
    op: z.literal("addVariableGet"),
    id: z.string().optional().describe("Local handle for referencing this node in later ops."),
    variable: z
      .string()
      .describe("Member/self variable name. The node's output data pin is named after the variable."),
    x: z.number().optional(),
    y: z.number().optional(),
  }),
  z.object({
    op: z.literal("addVariableSet"),
    id: z.string().optional().describe("Local handle for referencing this node in later ops."),
    variable: z
      .string()
      .describe("Member/self variable name. Exec in \"execute\"/out \"then\"; the input data pin (value to set) is named after the variable."),
    x: z.number().optional(),
    y: z.number().optional(),
  }),
  z.object({
    op: z.literal("addBranch"),
    id: z.string().optional().describe("Local handle for referencing this node in later ops."),
    x: z.number().optional(),
    y: z.number().optional(),
  }),
  z.object({
    op: z.literal("moveNode"),
    node: z.string().describe("Node local id or GUID to reposition."),
    x: z.number().describe("Graph X position."),
    y: z.number().describe("Graph Y position."),
  }),
  z.object({
    op: z.literal("addSequence"),
    id: z.string().optional().describe("Local handle for referencing this node in later ops."),
    numOutputs: z.number().int().min(2).default(2).describe("Number of exec output pins (then_0, then_1, ...)."),
    x: z.number().optional(),
    y: z.number().optional(),
  }),
  z.object({
    op: z.literal("addMacro"),
    id: z.string().optional().describe("Local handle for referencing this node in later ops."),
    macro: z.string().describe("Standard macro name: ForLoop, ForEachLoop, WhileLoop, Gate, DoOnce, FlipFlop."),
    x: z.number().optional(),
    y: z.number().optional(),
  }),
  z.object({
    op: z.literal("addCast"),
    id: z.string().optional().describe("Local handle for referencing this node in later ops."),
    targetClass: z
      .string()
      .describe("Class to cast to: a UE Python class name (e.g. \"PawnMovementComponent\") or a class path (\"/Game/.../BP_Foo.BP_Foo_C\")."),
    pure: z.boolean().default(false).describe("Pure cast (no exec pins)."),
    x: z.number().optional(),
    y: z.number().optional(),
  }),
  z.object({
    op: z.literal("addSelfFunctionNode"),
    id: z.string().optional().describe("Local handle for referencing this node in later ops."),
    functionName: z.string().describe("A function on this blueprint itself or an inherited/parent class."),
    x: z.number().optional(),
    y: z.number().optional(),
  }),
  z.object({
    op: z.literal("breakPinLink"),
    from: z.string().describe("Source node (local id or existing GUID)."),
    fromPin: z.string().describe("Output pin name."),
    to: z.string().describe("Target node (local id or existing GUID)."),
    toPin: z.string().describe("Input pin name."),
  }),
  z.object({
    op: z.literal("retargetNode"),
    node: z.string().describe("Existing node (local id or GUID) to reconfigure in place."),
    functionName: z.string().optional().describe("Retarget a CallFunction node to this function (pair with functionOwner)."),
    functionOwner: z.string().optional().describe("Owner class for functionName (UE Python class name or class path)."),
    targetClass: z.string().optional().describe("Retarget a Cast node to this class."),
    variable: z.string().optional().describe("Retarget a Variable Get/Set node to this self/member variable."),
    eventName: z.string().optional().describe("Rename a Custom Event node."),
  }),
]);

export function registerEditBlueprintGraphTool(server: McpServer): void {
  server.registerTool(
    "edit-blueprint-graph",
    {
      title: "Edit Blueprint Graph",
      description:
        "Add / wire / delete nodes in a Blueprint's K2 graph, then compile and save — all in one editor session. " +
        "Op kinds: addFunctionNode, addSelfFunctionNode, addCustomEvent, addVariableGet, addVariableSet, addBranch, addSequence, addMacro (ForLoop/ForEachLoop/WhileLoop/Gate/DoOnce/FlipFlop), addCast, addMemberVariable, connect, breakPinLink (disconnect one wire), setPinDefault, deleteNode, moveNode, retargetNode (reconfigure an existing node in place: retarget a function call / cast / variable, or rename a custom event). " +
        "Operations are applied in order; nodes spawned earlier in the batch can be referenced by a local `id` (later ops use that id or an existing node GUID). " +
        "Create a variable with addMemberVariable BEFORE adding get/set nodes that reference it. " +
        "Pass autoLayout: true to tidy the graph (or call with empty operations + autoLayout to just re-arrange an existing graph). " +
        "Requires the ClaudeUnrealBridge plugin enabled + its editor target built in the project. " +
        "Use read-blueprint first to get existing node/pin GUIDs. Destructive: modifies the .uasset on disk (use git to roll back).",
      inputSchema: {
        projectPath: z.string().describe("Absolute path to the UE project directory"),
        blueprintPath: z
          .string()
          .describe("Asset path (e.g. /Game/Blueprints/BP_Player) or file path to the blueprint"),
        graphName: z
          .string()
          .default("")
          .describe("Graph to edit by name. Empty (default) targets the event graph."),
        operations: z
          .array(opSchema)
          .default([])
          .describe("Ordered list of graph operations to apply in a single session. May be empty for a layout-only call (pair with autoLayout: true to re-arrange an existing graph)."),
        compile: z
          .boolean()
          .default(true)
          .describe("Compile the blueprint after applying operations (default true)."),
        autoLayout: z
          .boolean()
          .default(false)
          .describe(
            "Auto-arrange the whole graph into a tidy left-to-right flow after applying ops. Recommended when authoring a new graph; avoid on graphs a human has hand-arranged (it repositions every node).",
          ),
      },
      outputSchema: graphEditStructuredShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ projectPath, blueprintPath, graphName, operations, compile, autoLayout }, extra) => {
      try {
        if (operations.length === 0 && !autoLayout) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: "Nothing to do: `operations` is empty and `autoLayout` is false. Provide operations, or set autoLayout: true for a layout-only pass.",
              },
            ],
          };
        }
        const project = detectProject(projectPath);
        const assetPath = normalizeToAssetPath(blueprintPath, project);
        const scriptPath = join(pluginRoot, "python-scripts", "edit_blueprint_graph.py");

        const result = await runPythonInUE(
          project,
          scriptPath,
          {
            asset_path: assetPath,
            graph_name: graphName ?? "",
            operations: JSON.stringify(operations),
            compile: String(compile),
            auto_layout: String(autoLayout),
          },
          undefined,
          { signal: extra.signal, onProgress: progressFromExtra(extra) },
        );

        if (extra.signal?.aborted) {
          return { isError: true, content: [{ type: "text" as const, text: "Graph edit cancelled." }] };
        }

        if (!result.success || !result.data) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text:
                  `Failed to edit blueprint graph.\n\nError: ${result.errorSummary ?? result.stderr ?? "Unknown error"}\n\n` +
                  `Common causes: the ClaudeUnrealBridge plugin isn't enabled/built in this project, the asset path is wrong, or the editor failed to load.`,
              },
            ],
          };
        }

        const data = result.data as GraphEditResult;

        // A library/asset-level failure surfaced as a top-level error string.
        if (data.error) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `Graph edit failed: ${data.error}` }],
          };
        }

        const structured = {
          success: data.success,
          assetPath: data.asset_path,
          graph: data.graph,
          compiled: data.compiled ?? null,
          saved: data.saved ?? null,
          autoLayout: data.auto_layout ?? null,
          handles: data.handles ?? {},
          operations: (data.operations ?? []).map((o) => ({
            index: o.index,
            op: o.op,
            ...(o.ok !== undefined ? { ok: o.ok } : {}),
            ...(o.guid ? { guid: o.guid } : {}),
            ...(o.error ? { error: o.error } : {}),
          })),
          ...(data.nodes ? { nodes: data.nodes } : {}),
          connections: (data.connections ?? [])
            .map(parseConnection)
            .filter((c): c is NonNullable<typeof c> => c !== null),
        };

        return {
          content: [{ type: "text" as const, text: formatResult(data) }],
          structuredContent: structured,
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}

function formatResult(data: GraphEditResult): string {
  const lines: string[] = [];
  const head = data.success ? "OK" : "FAILED";
  lines.push(`## Edit graph: ${head} — \`${data.asset_path}\`${data.graph ? ` (graph: ${data.graph})` : " (event graph)"}`);

  lines.push("", "### Operations");
  for (const o of data.operations ?? []) {
    const tag = o.ok ? "✓" : "✗";
    const extra = o.guid ? ` → \`${o.guid}\`` : o.error ? ` — _${o.error}_` : "";
    lines.push(`${tag} ${o.index}. ${o.op}${extra}`);
  }

  const handleEntries = Object.entries(data.handles ?? {});
  if (handleEntries.length > 0) {
    lines.push("", "### Node handles");
    for (const [id, guid] of handleEntries) {
      lines.push(`- \`${id}\` = \`${guid}\``);
    }
  }

  lines.push("");
  if (data.compiled !== undefined && data.compiled !== null) {
    lines.push(`Compiled: ${data.compiled ? "✓" : "✗"}${data.compile_error ? ` (${data.compile_error})` : ""}`);
  }
  if (data.saved !== undefined && data.saved !== null) {
    lines.push(`Saved: ${data.saved ? "✓" : "✗"}${data.save_error ? ` (${data.save_error})` : ""}`);
  }
  if (data.auto_layout !== undefined && data.auto_layout !== null) {
    lines.push(`Auto-layout: ${data.auto_layout ? "✓" : "✗"}${data.auto_layout_error ? ` (${data.auto_layout_error})` : ""}`);
  }
  if (data.nodes) {
    lines.push(`Nodes now in graph: ${data.nodes.length}`);
  }
  if (data.connections) {
    lines.push(`Connections now in graph: ${data.connections.length}`);
  }

  return lines.join("\n");
}
