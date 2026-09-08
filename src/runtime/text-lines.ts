// ACP ReadTextFileRequest (the pinned SDK's schema/schema.json) uses 1-based lines
// but also permits zero. Treat zero as the first line; null means no restriction.
// Slice the original string so selected lines retain their LF or CRLF terminators.
export function selectTextLines(text: string, line?: number | null, limit?: number | null): string {
    if (limit === 0)
        return "";
    const firstLine = Math.max(1, line ?? 1);
    let start = 0;
    for (let current = 1; current < firstLine; current += 1) {
        const newline = text.indexOf("\n", start);
        if (newline === -1)
            return "";
        start = newline + 1;
    }
    if (limit === undefined || limit === null)
        return text.slice(start);
    let end = start;
    for (let count = 0; count < limit; count += 1) {
        const newline = text.indexOf("\n", end);
        if (newline === -1)
            return text.slice(start);
        end = newline + 1;
    }
    return text.slice(start, end);
}
