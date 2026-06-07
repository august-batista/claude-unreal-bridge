// JSON Schemas (as zod raw shapes) for tools that return structured content.
//
// Per MCP 2025-06-18 a tool may declare an `outputSchema`; when it does, every
// non-error response MUST carry `structuredContent` matching it (the SDK
// validates and rejects mismatches). These shapes mirror the parser output
// types in `../types/ue-project.ts` and `../parsers/*` so the markdown the
// client reads and the JSON it can compute against never drift apart.
//
// Each export is a `ZodRawShape` (a plain object of zod fields) — the form
// `server.registerTool({ outputSchema })` expects. Wrap with `z.object(shape)`
// to validate a value (the test suite does exactly this against fixtures).

import { z } from "zod";

// ---- compile-blueprints → CompileResult ----

const compileMessage = z.object({
  blueprint: z.string().optional(),
  category: z.string(),
  message: z.string(),
  severity: z.enum(["error", "warning"]),
  line: z.string(),
});

export const compileResultShape = {
  success: z.boolean(),
  errors: z.array(compileMessage),
  warnings: z.array(compileMessage),
  totals: z
    .object({
      successful: z.number(),
      failed: z.number(),
      failedBlueprints: z.array(z.string()).optional(),
    })
    .optional(),
  summary: z.string(),
  exitCode: z.number().nullable(),
} as const;

// ---- build-cpp → CppBuildResult ----

const cppBuildMessage = z.object({
  file: z.string().optional(),
  line: z.number().optional(),
  column: z.number().optional(),
  code: z.string().optional(),
  message: z.string(),
  severity: z.enum(["error", "warning"]),
  raw: z.string(),
});

export const cppBuildResultShape = {
  success: z.boolean(),
  target: z.string(),
  platform: z.string(),
  configuration: z.enum(["Debug", "DebugGame", "Development", "Shipping", "Test"]),
  errors: z.array(cppBuildMessage),
  warnings: z.array(cppBuildMessage),
  summary: z.string(),
  exitCode: z.number().nullable(),
  durationMs: z.number(),
} as const;

// ---- run-tests → unified run/list structure ----

export const testRunStructuredShape = {
  mode: z.enum(["run", "list"]),
  passed: z.boolean().optional(),
  succeeded: z.number().optional(),
  failed: z.number().optional(),
  notRun: z.number().optional(),
  totalDuration: z.number().optional(),
  durationMs: z.number(),
  tests: z
    .array(
      z.object({
        fullTestPath: z.string(),
        state: z.enum(["Success", "Fail", "InProcess", "NotRun", "Skipped"]),
        duration: z.number(),
        errors: z.array(z.string()),
      }),
    )
    .optional(),
  discoveredTests: z.array(z.string()).optional(),
} as const;

// ---- edit-blueprint-graph → batch result ----

export const graphEditStructuredShape = {
  success: z.boolean(),
  assetPath: z.string(),
  graph: z.string(),
  compiled: z.boolean().nullable().optional(),
  saved: z.boolean().nullable().optional(),
  autoLayout: z.boolean().nullable().optional(),
  /** Caller-assigned local op id -> the spawned node's GUID. */
  handles: z.record(z.string()),
  operations: z.array(
    z.object({
      index: z.number(),
      op: z.string(),
      ok: z.boolean().optional(),
      guid: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
  /** Post-edit node inventory, each "<guid>|<class>|<title>". */
  nodes: z.array(z.string()).optional(),
} as const;

// ---- read-logs → unified read/list structure ----

export const readLogsStructuredShape = {
  mode: z.enum(["read", "list"]),
  file: z
    .object({
      path: z.string(),
      isCurrent: z.boolean(),
      source: z.enum(["project", "platform-fallback"]),
      mtime: z.string(),
      sizeBytes: z.number(),
    })
    .optional(),
  entries: z
    .array(
      z.object({
        timestamp: z.string().optional(),
        frame: z.number().optional(),
        category: z.string().optional(),
        severity: z.string(),
        message: z.string(),
      }),
    )
    .optional(),
  stats: z
    .object({
      totalLines: z.number(),
      parsedLines: z.number(),
      matched: z.number(),
    })
    .optional(),
  logs: z
    .array(
      z.object({
        index: z.number(),
        path: z.string(),
        isCurrent: z.boolean(),
        source: z.enum(["project", "platform-fallback"]),
        mtime: z.string(),
        sizeBytes: z.number(),
      }),
    )
    .optional(),
} as const;
