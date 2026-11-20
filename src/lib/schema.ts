// Structured extraction: build the JSON schema sent to CIU, parse what comes
// back, and validate it. llama-server compiles the schema into a grammar, so
// output should already be valid; validation is the second line of defence
// for grammar-less backends, truncated output and model slips.
//
// MV3 forbids eval, which rules out Ajv's compiled validators, so this is a
// small validator for the subset of JSON Schema the extension itself emits.

export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  maxItems?: number;
  minItems?: number;
};

/** Turn user-typed field names into stable keys: "Unit Price ($)" -> "unit_price". */
export function fieldKey(label: string): string {
  const k = label
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "");
  return k || "field";
}

/** Words that mean "every column" rather than naming one. */
const ALL_FIELDS = new Set(["all", "all_fields", "all_columns", "everything", "any", "fields", "columns", "field", "every_field", "every_column", "auto"]);

export function parseFieldList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,\n;]+/)) {
    const k = fieldKey(part.trim());
    if (!part.trim() || seen.has(k) || ALL_FIELDS.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

const SCALAR: JsonSchema = { type: ["string", "number", "boolean", "null"] };

/**
 * Extraction answers are rows of values in field order, not objects. Objects
 * repeat every field name in every record, which on a dense page made up
 * about 40% of the answer, and the answer length is what limits how much of
 * the page one model call can cover.
 *
 * Fixed fields: {"rows": [[v1, v2, ...], ...]}, each row exactly fields.length long.
 * Auto fields:  {"fields": [...], "rows": [...]}; "fields" comes first, so the
 *               model commits to its columns before writing rows.
 */
export function extractionSchema(fields: string[], maxRecords = 400): JsonSchema {
  const row: JsonSchema = fields.length
    ? { type: "array", items: SCALAR, minItems: fields.length, maxItems: fields.length }
    : { type: "array", items: SCALAR, minItems: 1, maxItems: 20 };
  const rows: JsonSchema = { type: "array", items: row, maxItems: maxRecords };
  return fields.length
    ? { type: "object", properties: { rows }, required: ["rows"], additionalProperties: false }
    : {
        type: "object",
        properties: { fields: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 }, rows },
        required: ["fields", "rows"],
        additionalProperties: false,
      };
}

/**
 * Read what can be trusted from an extraction answer, even one cut off
 * mid-way by the output limit: the "fields" list if it was finished, and
 * every row that was closed. A half-written last row is left out.
 */
export function readRows(text: string): { fields: string[] | null; rows: unknown[][]; complete: boolean } {
  try {
    const v = parseJsonLoose(text) as any;
    if (v && Array.isArray(v.rows)) {
      return { fields: Array.isArray(v.fields) ? v.fields.map(String) : null, rows: v.rows.filter(Array.isArray), complete: true };
    }
  } catch {
    /* cut off: fall through to the incremental reader */
  }
  const fields = (() => {
    const m = text.match(/"fields"\s*:\s*(\[[^\]]*\])/);
    if (!m) return null;
    try {
      return (JSON.parse(m[1]) as unknown[]).map(String);
    } catch {
      return null;
    }
  })();
  const rows: unknown[][] = [];
  const at = text.search(/"rows"\s*:\s*\[/);
  if (at === -1) return { fields, rows, complete: false };
  let i = text.indexOf("[", at) + 1;
  // Scan the rows array, string-aware, and parse each row as soon as it closes.
  let depth = 0;
  let start = -1;
  let inStr = false;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "]") {
      if (depth === 0) break; // end of the rows array
      depth--;
      if (depth === 0 && start !== -1) {
        try {
          const r = JSON.parse(text.slice(start, i + 1));
          if (Array.isArray(r)) rows.push(r);
        } catch {
          /* malformed row: skip it */
        }
        start = -1;
      }
    }
  }
  return { fields, rows, complete: false };
}

/** Rows to records, by field order. Also accepts object records from grammar-less backends. */
export function rowsToDataset(rows: unknown[], fields: string[]): Dataset {
  const records = rows.map((r) =>
    Object.fromEntries(
      fields.map((f, i) => [f, normaliseCell(Array.isArray(r) ? r[i] : (r as Record<string, unknown> | null)?.[f])]),
    ),
  );
  return { fields: [...fields], records };
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function typeMatches(want: string, got: string): boolean {
  return want === got || (want === "number" && got === "integer");
}

/** Returns a list of human-readable problems; empty means valid. */
export function validate(schema: JsonSchema, value: unknown, path = "$"): string[] {
  const errs: string[] = [];
  const got = typeOf(value);
  if (schema.type) {
    const wants = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!wants.some((w) => typeMatches(w, got))) {
      errs.push(`${path}: expected ${wants.join(" or ")}, got ${got}`);
      return errs;
    }
  }
  if (got === "object") {
    const obj = value as Record<string, unknown>;
    for (const r of schema.required ?? []) if (!(r in obj)) errs.push(`${path}: missing "${r}"`);
    for (const [k, v] of Object.entries(obj)) {
      const sub = schema.properties?.[k];
      if (sub) errs.push(...validate(sub, v, `${path}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${path}: unexpected field "${k}"`);
      else if (typeof schema.additionalProperties === "object")
        errs.push(...validate(schema.additionalProperties, v, `${path}.${k}`));
    }
  }
  if (got === "array") {
    const arr = value as unknown[];
    if (schema.maxItems !== undefined && arr.length > schema.maxItems)
      errs.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.minItems !== undefined && arr.length < schema.minItems)
      errs.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.items) arr.forEach((v, i) => errs.push(...validate(schema.items!, v, `${path}[${i}]`)));
  }
  return errs;
}

/**
 * Parse model output that should be JSON. Tolerates code fences and stray
 * prose around the object, which small models produce when no grammar is
 * enforced. Throws with a short reason when there is no object at all.
 */
export function parseJsonLoose(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      /* fall through */
    }
  }
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a !== -1 && b > a) {
    try {
      return JSON.parse(t.slice(a, b + 1));
    } catch (e) {
      throw new Error(`Output is not valid JSON (${(e as Error).message}).`);
    }
  }
  throw new Error("Output contains no JSON object.");
}

export interface Dataset {
  fields: string[];
  records: Record<string, string | number | boolean | null>[];
}

/** Align records to one field order. Auto-mode records may disagree on keys. */
export function toDataset(value: any, requested: string[]): Dataset {
  const recs: Record<string, any>[] = Array.isArray(value?.records) ? value.records : [];
  const order: string[] = [];
  const add = (k: string) => {
    if (!order.includes(k)) order.push(k);
  };
  if (requested.length) requested.forEach(add);
  else {
    (Array.isArray(value?.fields) ? value.fields : []).forEach((f: unknown) => typeof f === "string" && add(f));
    for (const r of recs) Object.keys(r ?? {}).forEach(add);
  }
  const records = recs.map((r) => Object.fromEntries(order.map((k) => [k, normaliseCell(r?.[k])])));
  return { fields: order, records };
}

function normaliseCell(v: unknown): string | number | boolean | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  return JSON.stringify(v);
}

/** Merge datasets from several chunks, dropping exact duplicate records. */
export function mergeDatasets(parts: Dataset[], requested: string[]): Dataset {
  const fields: string[] = [...requested];
  for (const p of parts) for (const f of p.fields) if (!fields.includes(f)) fields.push(f);
  const seen = new Set<string>();
  const records: Dataset["records"] = [];
  for (const p of parts)
    for (const r of p.records) {
      const row = Object.fromEntries(fields.map((f) => [f, r[f] ?? null]));
      const key = JSON.stringify(fields.map((f) => row[f]));
      if (fields.every((f) => row[f] === null) || seen.has(key)) continue;
      seen.add(key);
      records.push(row);
    }
  return { fields, records };
}
