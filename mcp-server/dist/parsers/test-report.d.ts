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
    duration: number;
    events: TestEvent[];
    errors: TestEvent[];
    warnings: TestEvent[];
}
export interface TestReport {
    succeeded: number;
    failed: number;
    notRun: number;
    totalDuration: number;
    reportCreatedOn?: string;
    tests: TestRecord[];
}
/**
 * Normalise the raw report shape UE writes. UE has shipped multiple
 * subtle variants over versions; we tolerate field renames and missing
 * fields rather than throwing.
 */
export declare function parseTestReport(raw: unknown): TestReport;
/**
 * Render a test report as readable markdown.
 *
 * Failures are shown verbosely (with errors/warnings/file/line). Successes
 * are summarised by name only — we don't need the full event log when
 * everything passed.
 */
export declare function formatTestReport(report: TestReport, options?: {
    showAllEvents?: boolean;
}): string;
//# sourceMappingURL=test-report.d.ts.map