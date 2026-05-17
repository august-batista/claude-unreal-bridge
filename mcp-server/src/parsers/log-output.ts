// UE log line parser + filter.
//
// Lines look like one of:
//   [2024.01.15-12.34.56:789][  0]LogBlueprint: Warning: message
//   [2024.01.15-12.34.56:789][  0]LogBlueprint: message            (no severity = Log/Display)
//   LogInit: message                                               (early-init lines have no timestamp)
//
// We don't try to model every shape — just the bits useful for filtering.

export type LogSeverity =
  | "fatal"
  | "error"
  | "warning"
  | "display"
  | "log"
  | "verbose"
  | "veryverbose";

const SEVERITY_RANK: Record<LogSeverity, number> = {
  fatal: 0,
  error: 1,
  warning: 2,
  display: 3,
  log: 4,
  verbose: 5,
  veryverbose: 6,
};

export interface LogEntry {
  timestamp?: string;
  frame?: number;
  category?: string;
  severity: LogSeverity;
  message: string;
  raw: string;
}

const LINE_RE =
  /^(?:\[([^\]]+)\]\[\s*(\d+)\])?Log([A-Za-z][A-Za-z0-9_]*):\s+(?:(Fatal|Error|Warning|Display|Log|Verbose|VeryVerbose):\s+)?(.*)$/;

export function parseLogLine(raw: string): LogEntry | null {
  const m = raw.match(LINE_RE);
  if (!m) return null;
  const sev = (m[4]?.toLowerCase() ?? "display") as LogSeverity;
  return {
    timestamp: m[1] || undefined,
    frame: m[2] ? parseInt(m[2], 10) : undefined,
    category: `Log${m[3]}`,
    severity: sev,
    message: m[5],
    raw,
  };
}

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

export function matchesFilter(entry: LogEntry, filter: LogFilter): boolean {
  const minRank = SEVERITY_RANK[filter.minSeverity ?? "warning"];
  if (SEVERITY_RANK[entry.severity] > minRank) return false;

  if (filter.categories && filter.categories.length > 0) {
    const wanted = filter.categories.map((c) => c.toLowerCase());
    const got = entry.category?.toLowerCase() ?? "";
    if (!wanted.includes(got)) return false;
  }

  if (filter.pattern) {
    const re = new RegExp(filter.pattern, filter.patternFlags ?? "i");
    if (!re.test(entry.message)) return false;
  }

  return true;
}

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
export function filterLog(
  contents: string,
  filter: LogFilter,
  maxResults = 200,
): { entries: LogEntry[]; stats: FilterStats } {
  const lines = contents.split(/\r?\n/);
  const matched: LogEntry[] = [];
  let parsed = 0;

  for (const line of lines) {
    if (!line) continue;
    const entry = parseLogLine(line);
    if (!entry) continue;
    parsed++;
    if (matchesFilter(entry, filter)) {
      matched.push(entry);
    }
  }

  // Return the most recent N (the tail) — that's almost always what you want.
  const tail =
    matched.length > maxResults ? matched.slice(-maxResults) : matched;

  return {
    entries: tail,
    stats: {
      totalLines: lines.length,
      parsedLines: parsed,
      matched: matched.length,
    },
  };
}

/**
 * Render a list of log entries as readable markdown.
 */
export function formatLogEntries(
  entries: LogEntry[],
  stats: FilterStats,
  fileLabel: string,
): string {
  const lines: string[] = [];
  lines.push(`## Log: ${fileLabel}`);
  lines.push(
    `Matched ${stats.matched} of ${stats.parsedLines} parseable line(s)` +
      (entries.length < stats.matched
        ? ` — showing last ${entries.length}.`
        : "."),
  );

  if (entries.length === 0) {
    lines.push("", "_No entries matched the filter._");
    return lines.join("\n");
  }

  lines.push("", "```");
  for (const e of entries) {
    const ts = e.timestamp ? `[${e.timestamp}]` : "";
    const sev = e.severity.toUpperCase();
    lines.push(`${ts} ${e.category} [${sev}] ${e.message}`);
  }
  lines.push("```");

  return lines.join("\n");
}
