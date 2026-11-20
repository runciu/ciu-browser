// What CIU Browser actually does. Each task takes a page snapshot (or a
// selection), fits it to the loaded model's context, calls CIU, and reports
// exactly how much of the page it covered. Nothing here touches the DOM or
// chrome.* APIs, so the same code runs in the side panel and in the Node eval.

import {
  chunkText,
  estimateTokens,
  makeBudget,
  selectRelevant,
  type Budget,
} from "./budget";
import { chat, CiuError, type ChatMessage, type ChatOptions, type ChatResult } from "./ciu";
import { tableToDataset } from "./export";
import * as P from "./prompts";
import {
  extractionSchema,
  mergeDatasets,
  readRows,
  rowsToDataset,
  validate,
  type Dataset,
} from "./schema";
import type { Settings } from "./settings";

export interface TaskCtx {
  endpoint: string;
  settings: Settings;
  /** Context of the loaded model, from CIU status. */
  nCtx: number;
  signal?: AbortSignal;
  onToken?: (t: string) => void;
  onProgress?: (msg: string) => void;
  /** Model extraction: the rows found so far, after each model call. */
  onPartial?: (d: Dataset) => void;
  /** Injectable for tests and the eval runner. */
  chatImpl?: typeof chat;
}

export interface PageInput {
  title: string;
  url: string;
  text: string;
  truncated?: boolean;
  fullLength?: number;
}

export interface Coverage {
  /** Plain-language statement shown under every answer. */
  note: string;
  complete: boolean;
  /** Overrides the full/partial tag, e.g. "general" for answers not from the page. */
  tag?: string;
}

export interface TextOutput {
  kind: "text";
  text: string;
  coverage: Coverage;
}

export interface DataOutput {
  kind: "data";
  dataset: Dataset;
  coverage: Coverage;
  /** Problems found and how they were handled. Empty on a clean run. */
  issues: string[];
  source: "model" | "table";
}

const SHRINK = [1, 0.6, 0.35];

/**
 * Run fn with the full input budget; if CIU still reports the context is
 * full (the token estimate was wrong for this text), retry with less. This
 * is the general fix for estimate error, whatever the page.
 */
async function withShrinkingBudget<T>(base: Budget, fn: (b: Budget) => Promise<T>): Promise<T> {
  let last: unknown;
  for (const f of SHRINK) {
    try {
      return await fn({ ...base, input: Math.floor(base.input * f) });
    } catch (e) {
      if (e instanceof CiuError && e.kind === "context-full") {
        last = e;
        continue;
      }
      throw e;
    }
  }
  throw new CiuError(
    "The page is too large for the loaded model's context, even in small sections. Reload the model in CIU with a larger context.",
    "context-full",
    last,
  );
}

/**
 * Output budget for one answer. Reasoning tokens count against max_tokens,
 * so with thinking on, the budget must cover the reasoning as well as the
 * answer. makeBudget still caps it at a third of the context.
 */
function outputTokens(s: Settings): number {
  return s.thinking ? Math.max(s.maxOutputTokens, 2048) : s.maxOutputTokens;
}

function opts(ctx: TaskCtx, maxTokens: number, stream: boolean, extra: Partial<ChatOptions> = {}): ChatOptions {
  return {
    maxTokens,
    temperature: ctx.settings.temperature,
    thinking: ctx.settings.thinking,
    signal: ctx.signal,
    onToken: stream ? ctx.onToken : undefined,
    ...extra,
  };
}

function call(ctx: TaskCtx, msgs: ChatMessage[], o: ChatOptions): Promise<ChatResult> {
  return (ctx.chatImpl ?? chat)(ctx.endpoint, msgs, o);
}

function truncNote(page: PageInput): string {
  if (!page.truncated) return "";
  const pct = page.fullLength ? Math.round((page.text.length / page.fullLength) * 100) : null;
  return ` The page was longer than CIU reads in one go, so only the first ${pct ?? "part"}${pct !== null ? "%" : ""} of its text was read.`;
}

function pct(a: number, b: number): number {
  return b ? Math.round((a / b) * 100) : 100;
}

// ------------------------------------------------------------ summarise

export async function summarise(ctx: TaskCtx, page: PageInput): Promise<TextOutput> {
  const s = ctx.settings;
  const scaffold = P.SYSTEM_BASE + page.title + page.url + "Summarise the page above in 3 to 7 bullet points".repeat(2);
  const base = makeBudget(ctx.nCtx, outputTokens(s), scaffold);

  return withShrinkingBudget(base, async (b) => {
    if (estimateTokens(page.text) <= b.input) {
      ctx.onProgress?.("Summarising");
      const r = await call(ctx, P.summarisePrompt(page, page.text, ""), opts(ctx, b.maxOutput, true));
      const note = page.truncated ? "Summary of the part of the page CIU read." + truncNote(page) : "Covers the whole page.";
      return { kind: "text", text: r.text, coverage: { note, complete: !page.truncated } };
    }

    // Long page: summarise sections, then summarise the notes.
    const all = chunkText(page.text, b.input);
    const used = all.slice(0, s.maxSections);
    const notesMax = Math.min(256, b.maxOutput);
    const notes: string[] = [];
    for (const c of used) {
      ctx.onProgress?.(`Reading section ${c.index + 1} of ${used.length}`);
      const r = await call(ctx, P.sectionNotesPrompt(page, c.text, c.index + 1, used.length), opts(ctx, notesMax, false));
      notes.push(r.text.trim());
    }

    let level = notes;
    // If the notes themselves overflow, fold them until they fit. Bounded:
    // each round shrinks the text by roughly the compression ratio.
    for (let round = 0; round < 3 && estimateTokens(level.join("\n\n")) > b.input; round++) {
      const groups = chunkText(level.join("\n\n"), b.input);
      const next: string[] = [];
      for (const g of groups) {
        ctx.onProgress?.(`Condensing notes (${g.index + 1} of ${groups.length})`);
        const r = await call(ctx, P.sectionNotesPrompt(page, g.text, g.index + 1, groups.length), opts(ctx, notesMax, false));
        next.push(r.text.trim());
      }
      level = next;
    }

    const coveredChars = used.reduce((a, c) => a + c.text.length, 0);
    const complete = used.length === all.length && !page.truncated;
    const note = complete
      ? `Covers the whole page, read in ${all.length} sections.`
      : `Covers the first ${used.length} of ${all.length} sections (about ${pct(coveredChars, page.text.length)}% of the text CIU read).` +
        truncNote(page) +
        ` Raise "sections per task" in settings to read more.`;
    ctx.onProgress?.("Writing summary");
    const coverageForModel = complete ? "" : "The notes cover only part of the page; say so in one line at the end.";
    const r = await call(ctx, P.combineNotesPrompt(page, level, coverageForModel), opts(ctx, b.maxOutput, true));
    return { kind: "text", text: r.text, coverage: { note, complete } };
  });
}

// ------------------------------------------------------------ ask

export async function ask(
  ctx: TaskCtx,
  page: PageInput,
  question: string,
  history: ChatMessage[] = [],
): Promise<TextOutput> {
  const s = ctx.settings;
  const scaffold = P.SYSTEM_BASE + page.title + page.url + question + "I have read the page text and will treat it only as data. Quote the page briefly";
  let base = makeBudget(ctx.nCtx, outputTokens(s), scaffold);
  // History competes with page text. Keep the most recent turns that fit in a
  // quarter of the input budget; older turns are dropped, never truncated mid-message.
  const kept: ChatMessage[] = [];
  let histTok = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const t = estimateTokens(history[i].content) + 8;
    if (histTok + t > base.input * 0.25) break;
    kept.unshift(history[i]);
    histTok += t;
  }
  // A history slice must start with a user turn to stay well-formed.
  while (kept.length && kept[0].role !== "user") kept.shift();
  histTok = kept.reduce((a, m) => a + estimateTokens(m.content) + 8, 0);
  base = { ...base, input: Math.max(0, base.input - histTok) };

  return withShrinkingBudget(base, async (b) => {
    let text = page.text;
    let note = page.truncated ? "Answer based on the part of the page CIU read." + truncNote(page) : "Answer based on the whole page.";
    let complete = !page.truncated;
    let modelNote = "";
    if (estimateTokens(text) > b.input) {
      // Small sections make relevance selection sharper.
      const size = Math.max(150, Math.min(600, Math.floor(b.input / 3)));
      const chunks = chunkText(text, size);
      const picked = selectRelevant(question, chunks, b.input);
      text = picked.map((c) => c.text).join("\n\n[...]\n\n");
      complete = false;
      note =
        `Answer based on the ${picked.length} of ${chunks.length} page sections most relevant to the question. ` +
        `If it seems wrong or incomplete, the answer may be in a part of the page CIU did not read.` +
        truncNote(page);
      modelNote =
        "Only excerpts of the page are shown ([...] marks gaps). If they do not contain the answer, say that the answer was not found in the excerpts read.";
    }
    ctx.onProgress?.("Answering");
    const r = await call(ctx, P.askPrompt(page, text, question, kept, modelNote), opts(ctx, b.maxOutput, true));
    return { kind: "text", text: r.text, coverage: { note, complete } };
  });
}

/** Answer without the page, for questions the page does not cover. */
export async function askGeneral(ctx: TaskCtx, question: string): Promise<TextOutput> {
  const base = makeBudget(ctx.nCtx, outputTokens(ctx.settings), question + "General knowledge answer".repeat(20));
  ctx.onProgress?.("Answering from general knowledge");
  const r = await call(ctx, P.generalPrompt(question), opts(ctx, base.maxOutput, true));
  return {
    kind: "text",
    text: r.text,
    coverage: {
      complete: false,
      tag: "general",
      note: "From the model's general knowledge, not from this page. Small local models get facts wrong more often than the page does: check anything important.",
    },
  };
}

// ------------------------------------------------------------ selection tasks

export async function explain(ctx: TaskCtx, page: { title: string; url: string }, selection: string, context: string): Promise<TextOutput> {
  const base = makeBudget(ctx.nCtx, outputTokens(ctx.settings), P.SYSTEM_BASE + page.title + page.url + "Explain the selected text in plain language".repeat(2));
  return withShrinkingBudget(base, async (b) => {
    let sel = selection;
    let complete = true;
    // Selection first, context with whatever is left.
    if (estimateTokens(sel) > b.input) {
      sel = chunkText(sel, b.input)[0]?.text ?? "";
      complete = false;
    }
    const left = b.input - estimateTokens(sel);
    const ctxText = left > 100 ? (chunkText(context, left)[0]?.text ?? "") : "";
    ctx.onProgress?.("Explaining");
    const r = await call(ctx, P.explainPrompt(page, sel, ctxText), opts(ctx, b.maxOutput, true));
    return {
      kind: "text",
      text: r.text,
      coverage: {
        complete,
        note: complete ? "Explains the full selection." : `The selection was too long, so only its first ${pct(sel.length, selection.length)}% was explained.`,
      },
    };
  });
}

/** Translate, rewrite, or summarise a selection; long selections are processed in order, section by section. */
export async function transformSelection(
  ctx: TaskCtx,
  page: { title: string; url: string },
  selection: string,
  mode: { kind: "translate"; language: string } | { kind: "rewrite"; style: P.RewriteStyle } | { kind: "summarise" },
): Promise<TextOutput> {
  // Translation output is about as long as its input, so split the window evenly.
  const base = makeBudget(ctx.nCtx, outputTokens(ctx.settings), P.SYSTEM_BASE + "Translate the text above. Output only".repeat(2));
  return withShrinkingBudget(base, async (b) => {
    const size = mode.kind === "summarise" ? b.input : Math.min(b.input, b.maxOutput);
    const parts = chunkText(selection, Math.max(64, size));
    const outs: string[] = [];
    const used = parts.slice(0, ctx.settings.maxSections);
    for (const c of used) {
      if (used.length > 1) ctx.onProgress?.(`Part ${c.index + 1} of ${used.length}`);
      else ctx.onProgress?.(mode.kind === "translate" ? "Translating" : mode.kind === "rewrite" ? "Rewriting" : "Summarising");
      const msgs =
        mode.kind === "translate"
          ? P.translatePrompt(c.text, mode.language)
          : mode.kind === "rewrite"
            ? P.rewritePrompt(c.text, mode.style)
            : P.selectionSummaryPrompt(page, c.text);
      if (c.index > 0) ctx.onToken?.("\n\n");
      const r = await call(ctx, msgs, opts(ctx, b.maxOutput, true));
      outs.push(r.text.trim());
    }
    const complete = used.length === parts.length;
    return {
      kind: "text",
      text: outs.join("\n\n"),
      coverage: {
        complete,
        note: complete
          ? used.length > 1
            ? `Processed the full selection in ${used.length} parts.`
            : "Processed the full selection."
          : `Processed the first ${used.length} of ${parts.length} parts of the selection.`,
      },
    };
  });
}

// ------------------------------------------------------------ extract

export interface ExtractRequest {
  /** What to extract, in the user's words. May be empty. */
  what: string;
  /** Field keys; empty lets the model choose. */
  fields: string[];
}

type TableLike = { caption: string; hasHeader: boolean; rows: string[][] };

/** A page table becomes a dataset directly. No model, no chance of invented rows. */
export function extractTable(t: TableLike, columns?: number[], why = ""): DataOutput {
  const dataset = tableToDataset(t.rows, t.hasHeader, columns);
  return {
    kind: "data",
    dataset,
    coverage: {
      complete: true,
      note: `Copied directly from the page table "${t.caption}" (${dataset.records.length} rows). No model was used, so values are exact.${why ? " " + why : ""}`,
    },
    issues: [],
    source: "table",
  };
}

const GENERIC = new Set(
  "list table tables data all every each extract get give me the of and or in on by with from to for a an page rows row columns column fields field values items entries info information details".split(" "),
);

function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !GENERIC.has(w))
    .map((w) => w.replace(/(ies)$/, "y").replace(/(?<=[^s])s$/, ""));
}

export interface TableMatch {
  index: number;
  /** Columns to keep, or undefined for all. */
  columns?: number[];
  /** Requested fields with no matching column. */
  unmatched: string[];
}

/**
 * Decide whether a request is really "give me this table". Values in a page
 * table are already structured, so copying them is exact and instant, while
 * model extraction of a large table costs one call per few dozen rows and
 * can misread values. Returns null when the request does not fit any table.
 *
 *  - Fields given: pick the table whose headers match the most fields, and
 *    keep just those columns. At least half the fields must match.
 *  - Description only: pick the table whose caption and headers share the
 *    most words with it.
 *  - Neither: the largest table, when it clearly dominates the page.
 */
export function matchTable(tables: TableLike[], what: string, fields: string[], pageChars = 0): TableMatch | null {
  if (!tables.length) return null;
  const headerOf = (t: TableLike) => (t.hasHeader ? t.rows[0] : []);
  const size = (t: TableLike) => t.rows.length - (t.hasHeader ? 1 : 0);

  if (fields.length) {
    let best: TableMatch & { hits: number } = { index: -1, hits: 0, unmatched: fields };
    tables.forEach((t, index) => {
      const heads = headerOf(t).map((h) => words(h));
      const columns: number[] = [];
      const unmatched: string[] = [];
      for (const f of fields) {
        const fw = words(f.replace(/_/g, " "));
        const col = heads.findIndex((hw) => fw.length > 0 && fw.every((w) => hw.some((h) => h === w || h.startsWith(w) || w.startsWith(h))));
        if (col >= 0 && !columns.includes(col)) columns.push(col);
        else unmatched.push(f);
      }
      const hits = columns.length;
      if (hits > best.hits || (hits === best.hits && hits > 0 && size(t) > size(tables[best.index]))) best = { index, columns, unmatched, hits };
    });
    return best.index >= 0 && best.hits >= Math.ceil(fields.length / 2) ? { index: best.index, columns: best.columns, unmatched: best.unmatched } : null;
  }

  const req = new Set(words(what));
  if (req.size) {
    let bestI = -1;
    let bestScore = 0;
    tables.forEach((t, i) => {
      const have = new Set(words(t.caption + " " + headerOf(t).join(" ")));
      const score = [...req].filter((w) => have.has(w)).length;
      if (score > bestScore || (score === bestScore && score > 0 && size(t) > size(tables[bestI]))) {
        bestI = i;
        bestScore = score;
      }
    });
    return bestI >= 0 ? { index: bestI, unmatched: [] } : null;
  }

  // No request at all: use the main table if it is most of the page.
  const biggest = tables.reduce((b, t, i) => (size(t) > size(tables[b]) ? i : b), 0);
  const chars = tables[biggest].rows.reduce((a, r) => a + r.join(" ").length, 0);
  return size(tables[biggest]) >= 5 && (!pageChars || chars >= pageChars * 0.3) ? { index: biggest, unmatched: [] } : null;
}

/**
 * Split off the start of `text` that fits in `maxTokens`, cutting at a
 * paragraph break, else a sentence end, else mid-text. Verbatim: head + rest
 * is exactly `text`, so a cursor over the page never skips or repeats text.
 */
export function takeHead(text: string, maxTokens: number): [string, string] {
  if (estimateTokens(text) <= maxTokens) return [text, ""];
  let cut = -1;
  for (const re of [/\n\s*\n/g, /[.!?。！？]\s+/g]) {
    for (const m of text.matchAll(re)) {
      const end = m.index! + m[0].length;
      if (estimateTokens(text.slice(0, end)) > maxTokens) break;
      cut = end;
    }
    if (cut > 0) break;
  }
  if (cut <= 0) {
    cut = Math.max(1, maxTokens * 3);
    while (cut > 1 && estimateTokens(text.slice(0, cut)) > maxTokens) cut = Math.floor(cut * 0.85);
  }
  return [text.slice(0, cut), text.slice(cut)];
}

/**
 * Where in `text` the last of `rows` came from, so reading can resume after
 * it. Rows are in page order, so each row's first usable value is searched
 * for after the previous row's. Returns the end of the paragraph holding the
 * last row, or -1 when it cannot be placed (values reworded, say).
 */
export function resumePoint(text: string, rows: unknown[][]): number {
  const hay = text.toLowerCase();
  let pos = 0;
  let found = false;
  for (const r of rows) {
    const key = r.find((v) => typeof v === "string" && v.trim().length >= 3) as string | undefined;
    if (!key) continue;
    const at = hay.indexOf(key.trim().toLowerCase(), pos);
    if (at === -1) {
      found = false;
      continue;
    }
    pos = at + key.trim().length;
    found = true;
  }
  if (!found) return -1;
  const br = text.slice(pos).search(/\n\s*\n/);
  return br === -1 ? text.length : pos + br;
}

export async function extract(ctx: TaskCtx, page: PageInput, req: ExtractRequest): Promise<DataOutput> {
  const s = ctx.settings;
  // A row answer can be as long as the text it comes from, so give
  // extraction the largest output share the context allows (a third).
  const b = makeBudget(
    ctx.nCtx,
    Math.max(outputTokens(s), 1536),
    P.SYSTEM_BASE + page.title + page.url + req.what + req.fields.join(",") + "Extract: Columns, in this order Return rows one row per item List the items in the order they appear".repeat(2),
  );
  const issues: string[] = [];
  const text = page.text;
  let cursor = 0;
  let fields = req.fields;
  let rows: unknown[][] = [];
  let calls = 0;
  let cutOff = 0;
  let stopped = false;
  // Answer tokens per (estimated) page token, measured as we go and kept at
  // the highest seen. Starts at the old 1:3 guess; dense pages raise it after
  // the first call, and every later section is sized so its answer fits.
  let density = 1 / 3;
  let inputCap = b.input;

  const snapshot = (): Dataset => mergeDatasets([rowsToDataset(rows, fields)], fields);
  const pct = () => Math.round((cursor / Math.max(1, text.length)) * 100);

  while (cursor < text.length) {
    if (calls >= s.maxSections) break;
    if (ctx.signal?.aborted) {
      stopped = true;
      break;
    }
    const size = Math.max(150, Math.min(inputCap, Math.floor((0.85 * b.maxOutput) / density)));
    const [head] = takeHead(text.slice(cursor), size);
    calls++;
    ctx.onProgress?.(`Extracting with the model: ${pct()}% of the page read, ${rows.length} rows so far (call ${calls})`);
    const schema = extractionSchema(fields);
    let res: ChatResult;
    try {
      res = await call(ctx, P.extractPrompt(page, head, req.what, fields), opts(ctx, b.maxOutput, false, { jsonSchema: schema, temperature: 0 }));
    } catch (e) {
      if (e instanceof CiuError && e.kind === "aborted") {
        stopped = true;
        break;
      }
      if (e instanceof CiuError && e.kind === "context-full") {
        // The token estimate was low for this text: retry the same place smaller.
        inputCap = Math.floor(inputCap * 0.6);
        if (inputCap < 150) throw new CiuError("The page text is too dense for the loaded model's context. Reload the model in CIU with a larger context.", "context-full", e);
        continue;
      }
      throw e;
    }

    const got = readRows(res.text);
    if (!fields.length && got.fields?.length) fields = got.fields; // lock auto-chosen columns
    const usable = fields.length ? got.rows : [];
    const outTokens = res.completionTokens ?? estimateTokens(res.text);
    const truncated = res.finishReason === "length";

    if (!truncated && !got.complete && !usable.length) {
      // Finished but not JSON (a grammar-less backend, or a refusal): nothing to keep here.
      issues.push("One section's answer was not valid data and was skipped.");
      cursor += head.length;
    } else if (!truncated) {
      const problems = validate(schema, schema.required?.includes("fields") ? { fields, rows: usable } : { rows: usable });
      if (problems.length) issues.push(`Some rows did not match the columns (${problems.slice(0, 2).join("; ")}). Kept what could be read.`);
      rows = rows.concat(usable);
      density = Math.max(density, outTokens / Math.max(1, estimateTokens(head)));
      cursor += head.length;
    } else {
      cutOff++;
      // Keep every finished row, then resume after the last one in the text.
      const end = usable.length ? resumePoint(head, usable) : -1;
      if (end > 0) {
        rows = rows.concat(usable);
        density = Math.max(density, outTokens / Math.max(1, estimateTokens(head.slice(0, end))));
        cursor += end;
      } else {
        // Nothing placeable: the section was far too big for one answer. Halve it and try again.
        density = Math.max(density * 2, outTokens / Math.max(1, estimateTokens(head)) * 2);
        if (size <= 150) {
          issues.push("A passage produced more data than one answer can hold; it was skipped.");
          cursor += head.length;
        }
      }
    }
    ctx.onPartial?.(snapshot());
  }

  const dataset = snapshot();
  const done = cursor >= text.length;
  const complete = done && !page.truncated && !stopped;
  const read = done ? "the whole page" : `${pct()}% of the page`;
  let note: string;
  if (stopped) note = `Stopped after reading ${read}. The rows found so far are below.`;
  else if (!done) note = `Read ${read} in ${calls} model calls, the limit per task. Raise "Sections per task" in settings to read more.`;
  else note = calls > 1 ? `Read the whole page in ${calls} model calls.` : "Read the whole page.";
  note += truncNote(page) + " Values were written by the model: check them before relying on them.";
  if (cutOff) note += ` ${cutOff} answer${cutOff === 1 ? " was" : "s were"} cut off at the output limit; their finished rows were kept and reading resumed after them.`;
  return { kind: "data", dataset, coverage: { note, complete }, issues, source: "model" };
}

/**
 * What the Extract button does: copy a matching page table exactly, or fall
 * back to model extraction when no table fits the request.
 */
export async function extractAuto(
  ctx: TaskCtx,
  page: PageInput & { tables: TableLike[] },
  req: ExtractRequest,
  forceModel = false,
): Promise<DataOutput> {
  const m = forceModel ? null : matchTable(page.tables, req.what, req.fields, page.text.length);
  if (m) {
    const why =
      (m.unmatched.length ? `No column matched: ${m.unmatched.join(", ")}. ` : "") +
      `Your request matched this table, so it was copied instead of asking the model. For something the table does not hold directly, use "Extract with the model instead".`;
    return extractTable(page.tables[m.index], m.columns, why);
  }
  return extract(ctx, page, req);
}
