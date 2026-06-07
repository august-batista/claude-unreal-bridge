import { z } from "zod";
export declare const compileResultShape: {
    readonly success: z.ZodBoolean;
    readonly errors: z.ZodArray<z.ZodObject<{
        blueprint: z.ZodOptional<z.ZodString>;
        category: z.ZodString;
        message: z.ZodString;
        severity: z.ZodEnum<["error", "warning"]>;
        line: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        message: string;
        category: string;
        severity: "error" | "warning";
        line: string;
        blueprint?: string | undefined;
    }, {
        message: string;
        category: string;
        severity: "error" | "warning";
        line: string;
        blueprint?: string | undefined;
    }>, "many">;
    readonly warnings: z.ZodArray<z.ZodObject<{
        blueprint: z.ZodOptional<z.ZodString>;
        category: z.ZodString;
        message: z.ZodString;
        severity: z.ZodEnum<["error", "warning"]>;
        line: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        message: string;
        category: string;
        severity: "error" | "warning";
        line: string;
        blueprint?: string | undefined;
    }, {
        message: string;
        category: string;
        severity: "error" | "warning";
        line: string;
        blueprint?: string | undefined;
    }>, "many">;
    readonly totals: z.ZodOptional<z.ZodObject<{
        successful: z.ZodNumber;
        failed: z.ZodNumber;
        failedBlueprints: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        failed: number;
        successful: number;
        failedBlueprints?: string[] | undefined;
    }, {
        failed: number;
        successful: number;
        failedBlueprints?: string[] | undefined;
    }>>;
    readonly summary: z.ZodString;
    readonly exitCode: z.ZodNullable<z.ZodNumber>;
};
export declare const cppBuildResultShape: {
    readonly success: z.ZodBoolean;
    readonly target: z.ZodString;
    readonly platform: z.ZodString;
    readonly configuration: z.ZodEnum<["Debug", "DebugGame", "Development", "Shipping", "Test"]>;
    readonly errors: z.ZodArray<z.ZodObject<{
        file: z.ZodOptional<z.ZodString>;
        line: z.ZodOptional<z.ZodNumber>;
        column: z.ZodOptional<z.ZodNumber>;
        code: z.ZodOptional<z.ZodString>;
        message: z.ZodString;
        severity: z.ZodEnum<["error", "warning"]>;
        raw: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        message: string;
        severity: "error" | "warning";
        raw: string;
        code?: string | undefined;
        line?: number | undefined;
        file?: string | undefined;
        column?: number | undefined;
    }, {
        message: string;
        severity: "error" | "warning";
        raw: string;
        code?: string | undefined;
        line?: number | undefined;
        file?: string | undefined;
        column?: number | undefined;
    }>, "many">;
    readonly warnings: z.ZodArray<z.ZodObject<{
        file: z.ZodOptional<z.ZodString>;
        line: z.ZodOptional<z.ZodNumber>;
        column: z.ZodOptional<z.ZodNumber>;
        code: z.ZodOptional<z.ZodString>;
        message: z.ZodString;
        severity: z.ZodEnum<["error", "warning"]>;
        raw: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        message: string;
        severity: "error" | "warning";
        raw: string;
        code?: string | undefined;
        line?: number | undefined;
        file?: string | undefined;
        column?: number | undefined;
    }, {
        message: string;
        severity: "error" | "warning";
        raw: string;
        code?: string | undefined;
        line?: number | undefined;
        file?: string | undefined;
        column?: number | undefined;
    }>, "many">;
    readonly summary: z.ZodString;
    readonly exitCode: z.ZodNullable<z.ZodNumber>;
    readonly durationMs: z.ZodNumber;
};
export declare const testRunStructuredShape: {
    readonly mode: z.ZodEnum<["run", "list"]>;
    readonly passed: z.ZodOptional<z.ZodBoolean>;
    readonly succeeded: z.ZodOptional<z.ZodNumber>;
    readonly failed: z.ZodOptional<z.ZodNumber>;
    readonly notRun: z.ZodOptional<z.ZodNumber>;
    readonly totalDuration: z.ZodOptional<z.ZodNumber>;
    readonly durationMs: z.ZodNumber;
    readonly tests: z.ZodOptional<z.ZodArray<z.ZodObject<{
        fullTestPath: z.ZodString;
        state: z.ZodEnum<["Success", "Fail", "InProcess", "NotRun", "Skipped"]>;
        duration: z.ZodNumber;
        errors: z.ZodArray<z.ZodString, "many">;
    }, "strip", z.ZodTypeAny, {
        duration: number;
        fullTestPath: string;
        state: "Success" | "Fail" | "InProcess" | "NotRun" | "Skipped";
        errors: string[];
    }, {
        duration: number;
        fullTestPath: string;
        state: "Success" | "Fail" | "InProcess" | "NotRun" | "Skipped";
        errors: string[];
    }>, "many">>;
    readonly discoveredTests: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
};
export declare const graphEditStructuredShape: {
    readonly success: z.ZodBoolean;
    readonly assetPath: z.ZodString;
    readonly graph: z.ZodString;
    readonly compiled: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    readonly saved: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    readonly autoLayout: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    /** Caller-assigned local op id -> the spawned node's GUID. */
    readonly handles: z.ZodRecord<z.ZodString, z.ZodString>;
    readonly operations: z.ZodArray<z.ZodObject<{
        index: z.ZodNumber;
        op: z.ZodString;
        ok: z.ZodOptional<z.ZodBoolean>;
        guid: z.ZodOptional<z.ZodString>;
        error: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        index: number;
        op: string;
        error?: string | undefined;
        guid?: string | undefined;
        ok?: boolean | undefined;
    }, {
        index: number;
        op: string;
        error?: string | undefined;
        guid?: string | undefined;
        ok?: boolean | undefined;
    }>, "many">;
    /** Post-edit node inventory, each "<guid>|<class>|<title>|<x,y>". */
    readonly nodes: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    /** Post-edit edge list (NodeGuid + pin name on both ends). */
    readonly connections: z.ZodOptional<z.ZodArray<z.ZodObject<{
        from: z.ZodString;
        fromPin: z.ZodString;
        to: z.ZodString;
        toPin: z.ZodString;
        kind: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        from: string;
        fromPin: string;
        to: string;
        toPin: string;
        kind: string;
    }, {
        from: string;
        fromPin: string;
        to: string;
        toPin: string;
        kind: string;
    }>, "many">>;
};
export declare const readLogsStructuredShape: {
    readonly mode: z.ZodEnum<["read", "list"]>;
    readonly file: z.ZodOptional<z.ZodObject<{
        path: z.ZodString;
        isCurrent: z.ZodBoolean;
        source: z.ZodEnum<["project", "platform-fallback"]>;
        mtime: z.ZodString;
        sizeBytes: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        path: string;
        isCurrent: boolean;
        source: "project" | "platform-fallback";
        mtime: string;
        sizeBytes: number;
    }, {
        path: string;
        isCurrent: boolean;
        source: "project" | "platform-fallback";
        mtime: string;
        sizeBytes: number;
    }>>;
    readonly entries: z.ZodOptional<z.ZodArray<z.ZodObject<{
        timestamp: z.ZodOptional<z.ZodString>;
        frame: z.ZodOptional<z.ZodNumber>;
        category: z.ZodOptional<z.ZodString>;
        severity: z.ZodString;
        message: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        message: string;
        severity: string;
        category?: string | undefined;
        timestamp?: string | undefined;
        frame?: number | undefined;
    }, {
        message: string;
        severity: string;
        category?: string | undefined;
        timestamp?: string | undefined;
        frame?: number | undefined;
    }>, "many">>;
    readonly stats: z.ZodOptional<z.ZodObject<{
        totalLines: z.ZodNumber;
        parsedLines: z.ZodNumber;
        matched: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        totalLines: number;
        parsedLines: number;
        matched: number;
    }, {
        totalLines: number;
        parsedLines: number;
        matched: number;
    }>>;
    readonly logs: z.ZodOptional<z.ZodArray<z.ZodObject<{
        index: z.ZodNumber;
        path: z.ZodString;
        isCurrent: z.ZodBoolean;
        source: z.ZodEnum<["project", "platform-fallback"]>;
        mtime: z.ZodString;
        sizeBytes: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        path: string;
        index: number;
        isCurrent: boolean;
        source: "project" | "platform-fallback";
        mtime: string;
        sizeBytes: number;
    }, {
        path: string;
        index: number;
        isCurrent: boolean;
        source: "project" | "platform-fallback";
        mtime: string;
        sizeBytes: number;
    }>, "many">>;
};
//# sourceMappingURL=output-schemas.d.ts.map