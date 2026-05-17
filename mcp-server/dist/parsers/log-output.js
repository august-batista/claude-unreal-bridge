// UE log line parser + filter.
//
// Lines look like one of:
//   [2024.01.15-12.34.56:789][  0]LogBlueprint: Warning: message
//   [2024.01.15-12.34.56:789][  0]LogBlueprint: message            (no severity = Log/Display)
//   LogInit: message                                               (early-init lines have no timestamp)
//
// We don't try to model every shape — just the bits useful for filtering.
const SEVERITY_RANK = {
    fatal: 0,
    error: 1,
    warning: 2,
    display: 3,
    log: 4,
    verbose: 5,
    veryverbose: 6,
};
const LINE_RE = /^(?:\[([^\]]+)\]\[\s*(\d+)\])?Log([A-Za-z][A-Za-z0-9_]*):\s+(?:(Fatal|Error|Warning|Display|Log|Verbose|VeryVerbose):\s+)?(.*)$/;
export function parseLogLine(raw) {
    const m = raw.match(LINE_RE);
    if (!m)
        return null;
    const sev = (m[4]?.toLowerCase() ?? "display");
    return {
        timestamp: m[1] || undefined,
        frame: m[2] ? parseInt(m[2], 10) : undefined,
        category: `Log${m[3]}`,
        severity: sev,
        message: m[5],
        raw,
    };
}
export function matchesFilter(entry, filter) {
    const minRank = SEVERITY_RANK[filter.minSeverity ?? "warning"];
    if (SEVERITY_RANK[entry.severity] > minRank)
        return false;
    if (filter.categories && filter.categories.length > 0) {
        const wanted = filter.categories.map((c) => c.toLowerCase());
        const got = entry.category?.toLowerCase() ?? "";
        if (!wanted.includes(got))
            return false;
    }
    if (filter.pattern) {
        const re = new RegExp(filter.pattern, filter.patternFlags ?? "i");
        if (!re.test(entry.message))
            return false;
    }
    return true;
}
/**
 * Scan a log file's contents and return matching entries.
 * Lines that don't parse as log entries (banners, blank, multi-line stack
 * traces) are skipped silently — they're noise for filtering purposes.
 */
export function filterLog(contents, filter, maxResults = 200) {
    const lines = contents.split(/\r?\n/);
    const matched = [];
    let parsed = 0;
    for (const line of lines) {
        if (!line)
            continue;
        const entry = parseLogLine(line);
        if (!entry)
            continue;
        parsed++;
        if (matchesFilter(entry, filter)) {
            matched.push(entry);
        }
    }
    // Return the most recent N (the tail) — that's almost always what you want.
    const tail = matched.length > maxResults ? matched.slice(-maxResults) : matched;
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
export function formatLogEntries(entries, stats, fileLabel) {
    const lines = [];
    lines.push(`## Log: ${fileLabel}`);
    lines.push(`Matched ${stats.matched} of ${stats.parsedLines} parseable line(s)` +
        (entries.length < stats.matched
            ? ` — showing last ${entries.length}.`
            : "."));
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
//# sourceMappingURL=log-output.js.map