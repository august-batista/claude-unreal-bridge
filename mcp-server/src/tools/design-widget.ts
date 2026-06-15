import { z } from "zod";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { detectProject, normalizeToAssetPath } from "../ue-bridge/project-detector.js";
import { runPythonInUE } from "../ue-bridge/python-runner.js";
import { progressFromExtra } from "../mcp/progress.js";

const pluginRoot = process.env.PLUGIN_ROOT || process.cwd();

interface WidgetOpResult {
  index: number;
  op: string;
  ok?: boolean;
  name?: string;
  error?: string;
}
interface DesignWidgetResult {
  success: boolean;
  asset_path: string;
  operations: WidgetOpResult[];
  widgets: string[];
  compiled?: boolean | null;
  saved?: boolean | null;
  error?: string;
  compile_error?: string;
}

const widgetOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("addWidget"),
    widgetClass: z
      .string()
      .describe(
        "Widget class: a UE Python name — panels (\"CanvasPanel\", \"VerticalBox\", \"HorizontalBox\", \"Overlay\", " +
          "\"Border\", \"SizeBox\", \"ScrollBox\", \"UniformGridPanel\", \"GridPanel\", \"WrapBox\") or leaf widgets " +
          "(\"Button\", \"TextBlock\", \"Image\", \"ProgressBar\", \"CheckBox\", \"EditableText\", \"Slider\") — or a class path.",
      ),
    name: z.string().describe("Unique name for the new widget. Becomes a BP variable so graphs can reference it."),
    parent: z
      .string()
      .default("")
      .describe("Name of the parent panel to add under. Empty = the tree root (the first empty-parent addWidget becomes the root widget)."),
    childIndex: z.number().int().default(-1).describe("Insertion index within the parent (-1 = append)."),
  }),
  z.object({
    op: z.literal("setCanvasSlot"),
    widget: z.string().describe("Name of a widget that lives directly under a CanvasPanel."),
    x: z.number().default(0).describe("Slot X position (px)."),
    y: z.number().default(0).describe("Slot Y position (px)."),
    width: z.number().default(100).describe("Slot width (px); ignored if autoSize."),
    height: z.number().default(30).describe("Slot height (px); ignored if autoSize."),
    alignX: z.number().default(0).describe("Horizontal alignment 0..1 (0 = left anchor)."),
    alignY: z.number().default(0).describe("Vertical alignment 0..1 (0 = top anchor)."),
    autoSize: z.boolean().default(false).describe("Size the slot to the widget's content (width/height ignored)."),
  }),
]);

export function registerDesignWidgetTool(server: McpServer): void {
  server.registerTool(
    "design-widget",
    {
      title: "Design Widget (UMG)",
      description:
        "Design a Widget Blueprint's UMG layout: add widgets to the tree (panels, buttons, text, images) and " +
        "position them in CanvasPanel slots, then compile + save. Ops: addWidget (widgetClass + name + parent panel), " +
        "setCanvasSlot (position/size a widget under a CanvasPanel). The first addWidget with an empty parent becomes " +
        "the root. Create the Widget Blueprint first with create-asset (assetKind: widget); use read-blueprint or the " +
        "returned widget list to see names. Requires the ClaudeUnrealBridge plugin (or sandbox ClaudeBPGraph) built. " +
        "Destructive: modifies the .uasset on disk (use git to roll back).",
      inputSchema: {
        projectPath: z.string().describe("Absolute path to the UE project directory"),
        widgetPath: z
          .string()
          .describe("Asset path (e.g. /Game/UI/WBP_Inventory) or file path to the Widget Blueprint"),
        operations: z
          .array(widgetOpSchema)
          .min(1)
          .describe("Ordered list of widget-tree operations to apply in a single session."),
        compile: z.boolean().default(true).describe("Compile the widget blueprint after applying operations (default true)."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ projectPath, widgetPath, operations, compile }, extra) => {
      try {
        const project = detectProject(projectPath);
        const assetPath = normalizeToAssetPath(widgetPath, project);
        const scriptPath = join(pluginRoot, "python-scripts", "design_widget.py");

        const result = await runPythonInUE(
          project,
          scriptPath,
          {
            asset_path: assetPath,
            operations: JSON.stringify(operations),
            compile: String(compile),
          },
          undefined,
          { signal: extra.signal, onProgress: progressFromExtra(extra) },
        );

        if (!result.success || !result.data) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text:
                  `Failed to design widget.\n\nError: ${result.errorSummary ?? result.stderr ?? "Unknown error"}\n\n` +
                  `Common causes: the ClaudeUnrealBridge plugin isn't enabled/built, the widget path is wrong, or it isn't a Widget Blueprint.`,
              },
            ],
          };
        }

        const data = result.data as DesignWidgetResult;
        if (data.error) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `Design widget failed: ${data.error}` }],
          };
        }

        return {
          content: [{ type: "text" as const, text: formatResult(data) }],
          structuredContent: {
            success: data.success,
            assetPath: data.asset_path,
            compiled: data.compiled ?? null,
            saved: data.saved ?? null,
            operations: (data.operations ?? []).map((o) => ({
              index: o.index,
              op: o.op,
              ...(o.ok !== undefined ? { ok: o.ok } : {}),
              ...(o.name ? { name: o.name } : {}),
              ...(o.error ? { error: o.error } : {}),
            })),
            widgets: data.widgets ?? [],
          },
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );
}

function formatResult(data: DesignWidgetResult): string {
  const lines: string[] = [];
  lines.push(`## Design widget: ${data.success ? "OK" : "FAILED"} — \`${data.asset_path}\``);
  lines.push("", "### Operations");
  for (const o of data.operations ?? []) {
    const tag = o.ok ? "✓" : "✗";
    const extra = o.name ? ` → \`${o.name}\`` : o.error ? ` — _${o.error}_` : "";
    lines.push(`${tag} ${o.index}. ${o.op}${extra}`);
  }
  if (data.widgets && data.widgets.length > 0) {
    lines.push("", "### Widget tree (name | class | parent)");
    for (const w of data.widgets) lines.push(`- ${w}`);
  }
  lines.push("");
  if (data.compiled !== undefined && data.compiled !== null) {
    lines.push(`Compiled: ${data.compiled ? "✓" : "✗"}${data.compile_error ? ` (${data.compile_error})` : ""}`);
  }
  if (data.saved !== undefined && data.saved !== null) {
    lines.push(`Saved: ${data.saved ? "✓" : "✗"}`);
  }
  return lines.join("\n");
}
