export type LogSeverity = "fatal" | "error" | "warning" | "display" | "log" | "verbose" | "veryverbose";
export interface LogEntry {
    timestamp?: string;
    frame?: number;
    category?: string;
    severity: LogSeverity;
    message: string;
    raw: string;
}
export declare function parseLogLine(raw: string): LogEntry | null;
export interface LogFilter {
    /** Only include these categories (case-insensitive, e.g. ["LogBlueprint"]). */
    categories?: string[];
    /** Minimum severity to include. Default: warning. */
    minSeverity?: LogSeverity;
    /** Regex pattern (string) to match against the message body. */
    pattern?: string;
    /** Optional regex flags (e.g. "i"). Default "i". */
    patternFlags?: string;
}
export declare function matchesFilter(entry: LogEntry, filter: LogFilter): boolean;
export interface FilterStats {
    totalLines: number;
    parsedLines: number;
    matched: number;
}
/**
 * Scan a log file's contents and return matching entries.
 * Lines that don't parse as log entries (banners, blank, multi-line stack
 * traces) are skipped silently — they're noise for filtering purposes.
 */
export declare function filterLog(contents: string, filter: LogFilter, maxResults?: number): {
    entries: LogEntry[];
    stats: FilterStats;
};
/**
 * Render a list of log entries as readable markdown.
 */
export declare function formatLogEntries(entries: LogEntry[], stats: FilterStats, fileLabel: string): string;
//# sourceMappingURL=log-output.d.ts.map