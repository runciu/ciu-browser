// Context budgeting. CIU's /v1 proxy does not expose a tokenizer, so token
// counts here are estimates, deliberately pessimistic: overrunning the context
// costs a failed request, undershooting costs only a slightly smaller chunk.
// If an estimate is still wrong, callers catch the context-full error and
// retry with a smaller budget (see withShrinkingBudget).

/** Rough upper estimate of tokens for a string. */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
    else other++;
  }
  // English BPE averages ~4 chars/token; 3 leaves headroom for code, URLs and
  // numbers. Non-ASCII scripts often cost a token per character or more.
  return Math.ceil(ascii / 3 + other * 1.1);
}

export interface Budget {
  nCtx: number;
  maxOutput: number;
  /** Tokens left for page content after prompt scaffolding and output. */
  input: number;
}

/**
 * Work out how much page text fits. `scaffold` is every other token in the
 * request: system prompt, instructions, question, history.
 */
export function makeBudget(nCtx: number, maxOutput: number, scaffoldText: string): Budget {
  // Small contexts cannot afford the full requested output. Never let output
  // take more than a third of the window.
  const out = Math.min(maxOutput, Math.floor(nCtx / 3));
  // Chat template tokens per message plus a margin for estimate error.
  const overhead = estimateTokens(scaffoldText) + 48 + Math.ceil(nCtx * 0.04);
  return { nCtx, maxOutput: out, input: Math.max(0, nCtx - out - overhead) };
}

export interface Chunk {
  index: number;
  text: string;
  tokens: number;
}

/**
 * Split text into chunks of at most maxTokens, preferring paragraph, then
 * sentence, then hard character boundaries. Order is preserved.
 */
export function chunkText(text: string, maxTokens: number): Chunk[] {
  if (maxTokens <= 0) return [];
  const pieces: string[] = [];
  for (const para of text.split(/\n{2,}/)) {
    const p = para.trim();
    if (!p) continue;
    if (estimateTokens(p) <= maxTokens) {
      pieces.push(p);
      continue;
    }
    for (const sent of p.split(/(?<=[.!?。！？])\s+/)) {
      if (estimateTokens(sent) <= maxTokens) pieces.push(sent);
      else pieces.push(...hardSplit(sent, maxTokens));
    }
  }

  const chunks: Chunk[] = [];
  let cur: string[] = [];
  let curTok = 0;
  const flush = () => {
    if (!cur.length) return;
    const t = cur.join("\n\n");
    chunks.push({ index: chunks.length, text: t, tokens: estimateTokens(t) });
    cur = [];
    curTok = 0;
  };
  for (const p of pieces) {
    const t = estimateTokens(p) + 1;
    if (curTok + t > maxTokens) flush();
    cur.push(p);
    curTok += t;
  }
  flush();
  return chunks;
}

function hardSplit(s: string, maxTokens: number): string[] {
  const out: string[] = [];
  // Find a char length that fits, shrinking until the estimate agrees.
  let step = Math.max(1, maxTokens * 3);
  let i = 0;
  while (i < s.length) {
    let piece = s.slice(i, i + step);
    while (estimateTokens(piece) > maxTokens && piece.length > 1) {
      piece = piece.slice(0, Math.floor(piece.length * 0.8));
    }
    out.push(piece);
    i += piece.length;
  }
  return out;
}

const STOP = new Set(
  "a an the and or of to in on for with is are was were be been it this that what which who how why when where do does did can could should would from by as at about into than then there their its your you i we they he she".split(
    " ",
  ),
);

function terms(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

/**
 * Pick the chunks most relevant to a question that fit in `budget` tokens,
 * scored with BM25. Returned in document order, so the model reads the page
 * the way it was written.
 */
export function selectRelevant(question: string, chunks: Chunk[], budget: number): Chunk[] {
  const q = [...new Set(terms(question))];
  if (!chunks.length) return [];
  const docs = chunks.map((c) => terms(c.text));
  const avg = docs.reduce((a, d) => a + d.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1);
  const N = docs.length;
  const k1 = 1.2;
  const b = 0.75;
  const scored = chunks.map((c, i) => {
    const tf = new Map<string, number>();
    for (const w of docs[i]) tf.set(w, (tf.get(w) ?? 0) + 1);
    let s = 0;
    for (const w of q) {
      const f = tf.get(w) ?? 0;
      if (!f) continue;
      const n = df.get(w) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * docs[i].length) / avg)));
    }
    // Ties (and questions with no matching terms) favour the start of the
    // page, where the overview usually lives.
    return { c, s: s - i * 1e-6 };
  });
  scored.sort((x, y) => y.s - x.s);
  const picked: Chunk[] = [];
  let used = 0;
  for (const { c } of scored) {
    if (used + c.tokens > budget) continue;
    picked.push(c);
    used += c.tokens;
  }
  return picked.sort((x, y) => x.index - y.index);
}
