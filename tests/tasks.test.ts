import { describe, expect, it } from "vitest";
import { CiuError, type ChatMessage, type ChatOptions } from "../src/lib/ciu";
import { DEFAULTS } from "../src/lib/settings";
import * as T from "../src/lib/tasks";

type Handler = (msgs: ChatMessage[], o: ChatOptions) => { text: string; finish?: string } | Error;

function fake(handler: Handler) {
  const calls: { msgs: ChatMessage[]; o: ChatOptions }[] = [];
  const chatImpl = async (_ep: string, msgs: ChatMessage[], o: ChatOptions) => {
    calls.push({ msgs, o });
    const r = handler(msgs, o);
    if (r instanceof Error) throw r;
    o.onToken?.(r.text);
    return { text: r.text, finishReason: r.finish ?? "stop", promptTokens: null, completionTokens: null };
  };
  return { calls, chatImpl: chatImpl as any };
}

const ctx = (chatImpl: any, nCtx = 4096, over: Partial<typeof DEFAULTS> = {}): T.TaskCtx => ({
  endpoint: "http://127.0.0.1:8674",
  settings: { ...DEFAULTS, ...over },
  nCtx,
  chatImpl,
});

const page = (chars: number) => ({
  title: "Long page",
  url: "https://example.com/a",
  text: Array.from({ length: Math.ceil(chars / 400) }, (_, i) => `Section ${i}: ` + "lorem ipsum dolor ".repeat(21)).join("\n\n"),
});

describe("summarise", () => {
  it("does one call for a page that fits and reports full coverage", async () => {
    const f = fake(() => ({ text: "- point" }));
    const out = await T.summarise(ctx(f.chatImpl), page(2000));
    expect(f.calls.length).toBe(1);
    expect(out.coverage.complete).toBe(true);
    expect(f.calls[0].msgs[0].role).toBe("system");
    expect(f.calls[0].msgs[1].content).toMatch(/<<<PAGE [0-9a-f]{12}>>>/);
  });
  it("map-reduces a long page and states partial coverage when capped", async () => {
    const f = fake(() => ({ text: "- note" }));
    const out = await T.summarise(ctx(f.chatImpl, 4096, { maxSections: 3 }), page(60_000));
    expect(f.calls.length).toBe(4); // 3 sections + combine
    expect(out.coverage.complete).toBe(false);
    expect(out.coverage.note).toMatch(/first 3 of \d+ sections/);
    for (const c of f.calls) expect(c.o.maxTokens).toBeLessThanOrEqual(768);
  });
  it("shrinks the budget and retries when CIU says the context is full", async () => {
    let first = true;
    const f = fake(() => {
      if (first) { first = false; return new CiuError("full", "context-full"); }
      return { text: "- ok" };
    });
    const out = await T.summarise(ctx(f.chatImpl), page(8000));
    expect(out.text).toBe("- ok");
    const lens = f.calls.map((c) => c.msgs[1].content.length);
    expect(lens[1]).toBeLessThan(lens[0]);
  });
  it("gives up with a clear message after repeated context errors", async () => {
    const f = fake(() => new CiuError("full", "context-full"));
    await expect(T.summarise(ctx(f.chatImpl), page(2000))).rejects.toThrow(/larger context/);
  });
});

describe("ask", () => {
  it("selects relevant sections on long pages and says so", async () => {
    const p = page(60_000);
    p.text += "\n\nThe secret launch date is 14 March 2027.";
    const f = fake(() => ({ text: "14 March 2027" }));
    const out = await T.ask(ctx(f.chatImpl), p, "What is the secret launch date?");
    const sent = f.calls[0].msgs.map((m) => m.content).join("\n");
    expect(sent).toContain("14 March 2027");
    expect(out.coverage.complete).toBe(false);
    expect(out.coverage.note).toMatch(/most relevant/);
  });
  it("keeps recent history, starting on a user turn", async () => {
    const f = fake(() => ({ text: "ok" }));
    const hist: ChatMessage[] = [
      { role: "assistant", content: "orphan" },
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ];
    await T.ask(ctx(f.chatImpl), page(1000), "q2", hist);
    const roles = f.calls[0].msgs.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "user", "assistant", "user"]);
    expect(f.calls[0].msgs.at(-1)!.content).toBe("q2");
  });
});

// A dense, TechCrunch-shaped article: month headings and one paragraph per
// company, each carrying all six requested facts.
const MONTHS = ["December", "November", "October", "September", "August", "July", "June", "May", "April", "March", "February", "January"];
function fundingArticle(n: number): string {
  let t = "Last year was a record year for AI funding. ".repeat(20) + "\n\n";
  for (let i = 1; i <= n; i++) {
    if (i % 5 === 1) t += `## ${MONTHS[Math.floor(i / 5) % 12]}\n\n`;
    t += `- **Startup${String(i).padStart(2, "0")}**, which builds AI agents for finance teams, raised a $${100 + i} million Series B round announced on December ${(i % 28) + 1}. The round was led by Fund${i} Ventures, valuing the company at $${i}.2 billion.\n\n`;
  }
  return t;
}
const FIELDS = ["company", "industry", "funding_raised", "valuation", "funding_round", "lead_investor"];

/**
 * A fake model that behaves like a real one on dense pages: it writes one row
 * per company in the text it is given, in page order, and is cut off once its
 * answer reaches max_tokens (about 3.5 characters per token).
 */
function denseModel(opts: { pretty?: boolean } = {}) {
  return fake((msgs, o) => {
    const page = msgs[1].content;
    const rows = Array.from(page.matchAll(/\*\*(Startup\d+)\*\*, which builds (.+?), raised a (\$\d+ million) (Series \w) round.+?led by (.+?), valuing the company at (\$[\d.]+ billion)/g), (m) => [m[1], m[2], m[3], m[6], m[4], m[5]]);
    const full = opts.pretty ? JSON.stringify({ rows }, null, 2) : JSON.stringify({ rows });
    const limit = Math.floor(o.maxTokens * 3.5);
    return full.length > limit ? { text: full.slice(0, limit), finish: "length" } : { text: full };
  });
}

describe("extract", () => {
  it("asks for compact rows in page order, at temperature 0", async () => {
    const f = fake(() => ({ text: '{"rows":[]}' }));
    await T.extract(ctx(f.chatImpl), page(1000), { what: "", fields: ["a", "b"] });
    const schema = f.calls[0].o.jsonSchema as any;
    expect(schema.properties.rows.items).toMatchObject({ type: "array", minItems: 2, maxItems: 2 });
    expect(schema.properties.records).toBeUndefined();
    expect(f.calls[0].msgs[1].content).toMatch(/in the order they appear/);
    expect(f.calls[0].o.temperature).toBe(0);
  });

  it("dense page: every company exactly once, in order, with no wasted calls", async () => {
    for (const pretty of [false, true]) {
      const f = denseModel({ pretty });
      const out = await T.extract(ctx(f.chatImpl, 4096, { maxSections: 30 }), { title: "AI startups", url: "https://example.com", text: fundingArticle(64) }, { what: "funding rounds", fields: FIELDS });
      const names = out.dataset.records.map((r) => r.company);
      expect(names, pretty ? "pretty" : "compact").toEqual(Array.from({ length: 64 }, (_, i) => `Startup${String(i + 1).padStart(2, "0")}`));
      expect(out.dataset.records[0]).toEqual({ company: "Startup01", industry: "AI agents for finance teams", funding_raised: "$101 million", valuation: "$1.2 billion", funding_round: "Series B", lead_investor: "Fund1 Ventures" });
      expect(out.coverage.complete).toBe(true);
      // Every call adds rows: nothing is thrown away and redone.
      expect(f.calls.length, `${f.calls.length} calls`).toBeLessThanOrEqual(pretty ? 9 : 6);
    }
  });

  it("keeps the finished rows of a cut-off answer and resumes after the last one", async () => {
    let n = 0;
    const f = fake((msgs) => {
      n++;
      if (n === 1) return { text: '{"rows":[["Startup01","x"],["Startup02","y"],["Startu', finish: "length" };
      const first = msgs[1].content.match(/\*\*(Startup\d+)/)?.[1];
      return { text: JSON.stringify({ rows: [[first, "z"]] }) };
    });
    const out = await T.extract(ctx(f.chatImpl), { title: "t", url: "u", text: fundingArticle(3) }, { what: "", fields: ["company", "note"] });
    expect(out.dataset.records.map((r) => r.company)).toEqual(["Startup01", "Startup02", "Startup03"]);
    expect(out.coverage.note).toMatch(/1 answer was cut off/);
  });

  it("locks auto-chosen columns after the first answer", async () => {
    let n = 0;
    const f = fake((_m, o) => {
      n++;
      const auto = !!(o.jsonSchema as any).properties.fields;
      return { text: JSON.stringify(auto ? { fields: ["a", "b"], rows: [[`x${n}`, n]] } : { rows: [[`x${n}`, n]] }) };
    });
    const out = await T.extract(ctx(f.chatImpl, 4096, { maxSections: 3 }), page(30_000), { what: "", fields: [] });
    expect((f.calls[0].o.jsonSchema as any).properties.fields).toBeDefined();
    expect((f.calls[1].o.jsonSchema as any).properties.fields).toBeUndefined();
    expect(out.dataset.fields).toEqual(["a", "b"]);
    expect(out.dataset.records.length).toBe(3);
  });

  it("Stop returns the rows found so far instead of discarding them", async () => {
    const ctl = new AbortController();
    let n = 0;
    const f = fake(() => {
      n++;
      if (n === 2) {
        ctl.abort();
        return new CiuError("Stopped.", "aborted");
      }
      return { text: JSON.stringify({ rows: [["kept", 1]] }) };
    });
    const partials: number[] = [];
    const c = { ...ctx(f.chatImpl, 4096, { maxSections: 10 }), signal: ctl.signal, onPartial: (d: any) => partials.push(d.records.length) };
    const out = await T.extract(c, page(30_000), { what: "", fields: ["a", "b"] });
    expect(out.dataset.records).toEqual([{ a: "kept", b: 1 }]);
    expect(out.coverage.complete).toBe(false);
    expect(out.coverage.note).toMatch(/^Stopped after reading \d+% of the page/);
    expect(partials).toEqual([1]);
  });

  it("reports unreadable output instead of inventing data", async () => {
    const f = fake(() => ({ text: "I cannot do that" }));
    const out = await T.extract(ctx(f.chatImpl), page(1000), { what: "", fields: ["a"] });
    expect(out.dataset.records).toEqual([]);
    expect(out.issues[0]).toMatch(/not valid data/);
  });

  it("copies page tables exactly", () => {
    const out = T.extractTable({ caption: "Prices", hasHeader: true, rows: [["Item", "Price"], ["Tea", "£2"]] });
    expect(out.dataset.records).toEqual([{ Item: "Tea", Price: "£2" }]);
    expect(out.source).toBe("table");
  });
});

describe("selection transforms", () => {
  it("translates long selections in order, part by part", async () => {
    const f = fake((m) => ({ text: `T(${m[1].content.length})` }));
    const out = await T.transformSelection(ctx(f.chatImpl, 2048), { title: "", url: "" }, page(8000).text, { kind: "translate", language: "French" });
    expect(f.calls.length).toBeGreaterThan(1);
    expect(out.text.split("\n\n").length).toBe(f.calls.length);
    expect(f.calls[0].msgs[1].content).toMatch(/into French/);
  });
});

describe("general knowledge", () => {
  it("sends no page and tags the answer as general", async () => {
    const f = fake(() => ({ text: "Edinburgh" }));
    const out = await T.askGeneral(ctx(f.chatImpl), "What is the capital of Scotland?");
    const sent = f.calls[0].msgs.map((m) => m.content).join("\n");
    expect(sent).not.toMatch(/<<<PAGE/);
    expect(sent).toMatch(/Today's date is/);
    expect(out.coverage.tag).toBe("general");
  });
  it("page answers no longer invite an outside-knowledge section", async () => {
    const f = fake(() => ({ text: "ok" }));
    await T.ask(ctx(f.chatImpl), page(1000), "q");
    expect(f.calls[0].msgs[0].content).toMatch(/Use only the page text/);
    expect(f.calls[0].msgs[0].content).not.toMatch(/begin with the words Not from the page/);
  });
});

describe("table routing", () => {
  const pop = { caption: "Population by country", hasHeader: true, rows: [["#", "Country or territory", "Population (1 July 2023)", "UN continental region"], ...Array.from({ length: 30 }, (_, i) => [String(i), `C${i}`, String(i * 1000), "Asia"])] };
  const small = { caption: "Footnotes", hasHeader: true, rows: [["Note", "Text"], ["a", "b"]] };
  it("routes a description that matches a table's headers", () => {
    expect(T.matchTable([small, pop], "List of countries and territories by total population", [])).toMatchObject({ index: 1 });
  });
  it("maps requested fields to columns and keeps only those", () => {
    const m = T.matchTable([small, pop], "", ["country", "population", "capital"])!;
    expect(m).toMatchObject({ index: 1, columns: [1, 2], unmatched: ["capital"] });
    const out = T.extractTable(pop, m.columns);
    expect(out.dataset.fields).toEqual(["Country or territory", "Population (1 July 2023)"]);
    expect(out.dataset.records.length).toBe(30);
  });
  it("falls back to the model when nothing matches", () => {
    expect(T.matchTable([pop], "each book with its price", [])).toBeNull();
    expect(T.matchTable([pop], "", ["title", "price", "availability"])).toBeNull();
    expect(T.matchTable([], "anything", [])).toBeNull();
  });
});

describe("cursor helpers", () => {
  it("takeHead cuts at paragraph breaks and never loses or repeats text", () => {
    const t = fundingArticle(20);
    let rest = t;
    let joined = "";
    let n = 0;
    while (rest) {
      const [h, r] = T.takeHead(rest, 300);
      expect(h.length).toBeGreaterThan(0);
      joined += h;
      rest = r;
      n++;
    }
    expect(joined).toBe(t);
    expect(n).toBeGreaterThan(3);
  });
  it("resumePoint finds the paragraph after the last row, matching rows in page order", () => {
    const t = "Intro mentions Startup02 early.\n\n- Startup01 raised.\n\n- Startup02 raised.\n\n- Startup03 raised.";
    const end = T.resumePoint(t, [["Startup01"], ["Startup02"]]);
    expect(t.slice(end).trim()).toBe("- Startup03 raised.");
    expect(T.resumePoint(t, [["Nowhere Ltd"]])).toBe(-1);
  });
});
