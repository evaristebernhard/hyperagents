export type TableData = { columns: string[]; rows: string[][] };
export function parseTable(content: string): TableData {
  let data: unknown;
  try { data = JSON.parse(content); } catch { throw Error("Table content must be JSON with columns and rows."); }
  const t = data as TableData;
  if (!t || !Array.isArray(t.columns) || !t.columns.length || t.columns.length > 30 || t.columns.some(c => typeof c !== "string") || !Array.isArray(t.rows) || t.rows.length > 500 || t.rows.some(row => !Array.isArray(row) || row.length !== t.columns.length || row.some(cell => typeof cell !== "string"))) throw Error("Table requires 1–30 string columns and up to 500 matching string rows.");
  return t;
}
export function tableCsv(content: string): string {
  const data = parseTable(content);
  const cell = (value: string) => {
    // Prevent formula execution when opened in desktop spreadsheet applications.
    const safe = /^[\s]*[=+\-@\t\r]/.test(value) ? "'" + value : value;
    return '"' + safe.replaceAll('"', '""') + '"';
  };
  return [data.columns, ...data.rows].map(row => row.map(cell).join(",")).join("\r\n") + "\r\n";
}
