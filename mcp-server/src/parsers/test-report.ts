// Parser for the JSON automation report UE writes to -ReportExportPath.
// File is `index.json` in that directory.

export type TestState = "Success" | "Fail" | "InProcess" | "NotRun" | "Skipped";
export type TestEventType = "Info" | "Warning" | "Error";

export interface TestEvent {
  type: TestEventType;
  message: string;
  context?: string;
  artifact?: string;
  filename?: string;
  lineNumber?: number;
  timestamp?: string;
}

export interface TestRecord {
  fullTestPath: string;
  testDisplayName: string;
  state: TestState;
  duration: number; // seconds
  events: TestEvent[];
  errors: TestEvent[]; // events filtered to type === "Error"
  warnings: TestEvent[];
}

export interface TestReport {
  succeeded: number;
  failed: number;
  notRun: number;
  totalDuration: number; // seconds
  reportCreatedOn?: string;
  tests: TestRecord[];
}

/**
 * Normalise the raw report shape UE writes. UE has shipped multiple
 * subtle variants over versions; we tolerate field renames and missing
 * fields rather than throwing.
 */
export function parseTestReport(raw: unknown): TestReport {
  const r = (raw ?? {}) as Record<string, unknown>;

  const tests: TestRecord[] = [];
  const rawTests = (r.tests as unknown[] | undefined) ?? [];
  for (const t of rawTests) {
    const tt = t as Record<string, unknown>;
    const events: TestEvent[] = [];

    const rawEntries = (tt.entries as unknown[] | undefined) ?? [];
    for (const entry of rawEntries) {
      const e = entry as Record<string, unknown>;
      const eventField = (e.event as Record<string, unknown> | undefined) ?? e;
      const type = normaliseEventType(eventField.type as string | undefined);
      const message = String(eventField.message ?? "");
      events.push({
        type,
        message,
        context: optString(eventField.context),
        artifact: optString(eventField.artifact),
        filename: optString(e.filename),
        lineNumber: optNumber(e.lineNumber),
        timestamp: optString(e.timestamp),
      });
    }

    const state = normaliseState(tt.state as string | undefined);
    tests.push({
      fullTestPath: String(tt.fullTestPath ?? tt.testDisplayName ?? "<unknown>"),
      testDisplayName: String(tt.testDisplayName ?? tt.fullTestPath ?? "<unknown>"),
      state,
      duration: Number(tt.duration ?? 0),
      events,
      errors: events.filter((e) => e.type === "Error"),
      warnings: events.filter((e) => e.type === "Warning"),
    });
  }

  let succeeded = optNumber(r.succeeded) ?? 0;
  let failed = optNumber(r.failed) ?? 0;
  let notRun = optNumber(r.notRun) ?? 0;

  // If header counts are missing, derive from the per-test states.
  if (succeeded + failed + notRun === 0 && tests.length > 0) {
    for (const t of tests) {
      if (t.state === "Success") succeeded++;
      else if (t.state === "Fail") failed++;
      else notRun++;
    }
  }

  return {
    succeeded,
    failed,
    notRun,
    totalDuration: Number(r.totalDuration ?? 0),
    reportCreatedOn: optString(r.reportCreatedOn),
    tests,
  };
}

function normaliseState(s: string | undefined): TestState {
  if (!s) return "NotRun";
  const v = s.toLowerCase();
  if (v.includes("success") || v === "passed") return "Success";
  if (v.includes("fail")) return "Fail";
  if (v.includes("skip")) return "Skipped";
  if (v.includes("inprocess") || v === "running") return "InProcess";
  return "NotRun";
}

function normaliseEventType(t: string | undefined): TestEventType {
  if (!t) return "Info";
  const v = t.toLowerCase();
  if (v === "error") return "Error";
  if (v === "warning") return "Warning";
  return "Info";
}

function optString(v: unknown): string | undefined {
  if (typeof v === "string" && v.length > 0) return v;
  return undefined;
}

function optNumber(v: unknown): number | undefined {
  if (typeof v === "number" && !Number.isNaN(v)) return v;
  return undefined;
}

/**
 * Render a test report as readable markdown.
 *
 * Failures are shown verbosely (with errors/warnings/file/line). Successes
 * are summarised by name only — we don't need the full event log when
 * everything passed.
 */
export function formatTestReport(
  report: TestReport,
  options: { showAllEvents?: boolean } = {},
): string {
  const lines: string[] = [];
  const total = report.succeeded + report.failed + report.notRun;
  const pass = report.failed === 0 && total > 0;

  lines.push(
    pass
      ? `## Tests: PASSED — ${report.succeeded}/${total}`
      : `## Tests: FAILED — ${report.failed} failed, ${report.succeeded} passed${report.notRun ? `, ${report.notRun} not run` : ""}`,
  );
  if (report.totalDuration > 0) {
    lines.push(`Total duration: ${report.totalDuration.toFixed(2)}s.`);
  }

  const failures = report.tests.filter((t) => t.state === "Fail");
  const successes = report.tests.filter((t) => t.state === "Success");
  const skipped = report.tests.filter(
    (t) => t.state !== "Success" && t.state !== "Fail",
  );

  if (failures.length > 0) {
    lines.push("", `### Failures (${failures.length})`, "");
    for (const t of failures) {
      lines.push(`#### \`${t.fullTestPath}\` (${t.duration.toFixed(3)}s)`);
      if (t.errors.length === 0) {
        lines.push("- (no error events captured)");
      }
      for (const e of t.errors) {
        lines.push(`- **Error:** ${formatEvent(e)}`);
      }
      for (const w of t.warnings) {
        lines.push(`- *Warning:* ${formatEvent(w)}`);
      }
      lines.push("");
    }
  }

  if (skipped.length > 0) {
    lines.push("", `### Not run / skipped (${skipped.length})`, "");
    for (const t of skipped) {
      lines.push(`- \`${t.fullTestPath}\` — ${t.state}`);
    }
  }

  if (successes.length > 0) {
    lines.push("", `### Passed (${successes.length})`, "");
    if (options.showAllEvents) {
      for (const t of successes) {
        lines.push(
          `- \`${t.fullTestPath}\` (${t.duration.toFixed(3)}s)`,
        );
      }
    } else {
      // Compact: just the names, indented for grep-friendliness.
      const sample = successes.slice(0, 30);
      for (const t of sample) {
        lines.push(`- \`${t.fullTestPath}\``);
      }
      if (successes.length > sample.length) {
        lines.push(`- … and ${successes.length - sample.length} more.`);
      }
    }
  }

  return lines.join("\n");
}

function formatEvent(e: TestEvent): string {
  // UE often emits "Unknown" or empty filename for events with no source
  // location — drop those rather than render `\`Unknown\``.
  const usableFile =
    e.filename && e.filename !== "Unknown" ? e.filename : undefined;
  const loc = usableFile
    ? ` \`${usableFile}${e.lineNumber ? `:${e.lineNumber}` : ""}\``
    : "";
  return `${e.message}${loc}`;
}
