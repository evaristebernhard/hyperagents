// Bounded valid JSON for persisted tool UI; never add raw arguments or headers.
export function summarizeToolResult(result) {
  const raw = JSON.stringify(result) ?? 'null';
  if (raw.length <= 1200) return raw;
  const text = (value, size) => typeof value === 'string' ? value.slice(0, size) : undefined;
  const safeUrl = value => { try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password && u.href.length <= 300 ? u.href : undefined; } catch { return undefined; } };
  const projected = { status: text(result?.status, 60), truncated: true };
  if (typeof result?.query === 'string') projected.query = text(result.query, 160);
  const rows = Array.isArray(result?.results) ? result.results : Array.isArray(result?.tools) ? result.tools : null;
  if (rows) {
    projected.results = rows.slice(0, 5).map(row => ({ title: text(row?.title ?? row?.name, 100), url: safeUrl(row?.url), excerpt: text(row?.excerpt ?? row?.description, 100) }));
    while (JSON.stringify(projected).length > 1200 && projected.results.length) projected.results.pop();
    projected.returnedCount = rows.length;
    while (JSON.stringify(projected).length > 1200 && projected.results.length) projected.results.pop();
  } else {
    projected.title = text(result?.title, 180);
    projected.kind = text(result?.kind, 40);
    projected.error = text(result?.error, 250);
    projected.notice = 'Result preview shortened. This is not the full execution output.';
  }
  return JSON.stringify(projected);
}
