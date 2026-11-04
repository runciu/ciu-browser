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

export function extractionSchema(fields: string[], maxRecords = 200): JsonSchema {
  const record: JsonSchema = fields.length
    ? {
        type: "object",
        properties: Object.fromEntries(fields.map((f) => [f, { type: ["string", "number", "boolean", "null"] }])),
        required: fields,
        additionalProperties: false,
      }
    : { type: "object", additionalProperties: SCALAR };
  return {
    type: "object",
    properties: {
      fields: { type: "array", items: { type: "string" } },
      records: { type: "array", items: record, maxItems: maxRecords },
    },
    required: ["fields", "records"],
    additionalProperties: false,
  };
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
