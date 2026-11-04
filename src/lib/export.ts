import type { Dataset } from "./schema";

/**
 * CSV per RFC 4180. Cells that a spreadsheet would execute as a formula are
 * prefixed with an apostrophe: page content is untrusted, and "=HYPERLINK(...)"
 * scraped from a page should open as text, not run.
 */
export function toCsv(d: Dataset): string {
  const cell = (v: unknown): string => {
    let s = v === null || v === undefined ? "" : String(v);
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [d.fields.map(cell).join(",")];
  for (const r of d.records) lines.push(d.fields.map((f) => cell(r[f])).join(","));
  return lines.join("\r\n") + "\r\n";
}

/**
 * CSV as a file to save. Starts with a UTF-8 byte-order mark: without it,
 * Excel (notably on macOS) guesses a legacy encoding and turns "£" into "¬£",
 * and breaks every accented or non-Latin character the same way. Clipboard
 * copies use plain toCsv, since a BOM there would be pasted as a stray character.
 */
export function toCsvFile(d: Dataset): string {
  return "\uFEFF" + toCsv(d);
}

export function toMarkdownTable(d: Dataset): string {
  const esc = (v: unknown) =>
    (v === null || v === undefined ? "" : String(v)).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const head = `| ${d.fields.map(esc).join(" | ")} |`;
  const sep = `| ${d.fields.map(() => "---").join(" | ")} |`;
  const rows = d.records.map((r) => `| ${d.fields.map((f) => esc(r[f])).join(" | ")} |`);
  return [head, sep, ...rows].join("\n");
}

export function toJson(d: Dataset): string {
  return JSON.stringify(d.records, null, 2);
}

/** Convert a raw HTML table (rows of cells) into a dataset, no model involved. */
export function tableToDataset(rows: string[][], hasHeader: boolean, columns?: number[]): Dataset {
  if (!rows.length) return { fields: [], records: [] };
  const width = Math.max(...rows.map((r) => r.length));
  const header = hasHeader ? rows[0] : Array.from({ length: width }, (_, i) => `column_${i + 1}`);
  const fields: string[] = [];
  for (let i = 0; i < width; i++) {
    let name = (header[i] ?? "").trim() || `column_${i + 1}`;
    let n = 2;
    const base = name;
    while (fields.includes(name)) name = `${base}_${n++}`;
    fields.push(name);
  }
  const body = hasHeader ? rows.slice(1) : rows;
  const keep = columns?.length ? columns.filter((c) => c < width) : fields.map((_, i) => i);
  const records = body.map((r) => Object.fromEntries(keep.map((i) => [fields[i], r[i] ?? null])));
  return { fields: keep.map((i) => fields[i]), records };
}
