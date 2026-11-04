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

describe("extract", () => {
  it("locks auto-chosen fields after the first section", async () => {
    let n = 0;
    const f = fake((_m, o) => {
      n++;
      const req = (o.jsonSchema as any).properties.records.items.required;
      return { text: JSON.stringify({ fields: req ?? ["a", "b"], records: [{ a: `x${n}`, b: n }] }) };
    });
    const out = await T.extract(ctx(f.chatImpl, 4096, { maxSections: 3 }), page(30_000), { what: "", fields: [] });
    expect((f.calls[0].o.jsonSchema as any).properties.records.items.required).toBeUndefined();
    expect((f.calls[1].o.jsonSchema as any).properties.records.items.required).toEqual(["a", "b"]);
    expect(out.dataset.fields).toEqual(["a", "b"]);
    expect(out.dataset.records.length).toBe(3);
    expect(f.calls.every((c) => c.o.temperature === 0)).toBe(true);
  });
  it("splits a section whose output ran out of room", async () => {
    let n = 0;
    const f = fake(() => {
      n++;
      if (n === 1) return { text: '{"fields":["a"],"records":[{"a":"tru', finish: "length" };
      return { text: JSON.stringify({ fields: ["a"], records: [{ a: `r${n}` }] }) };
    });
    const out = await T.extract(ctx(f.chatImpl), page(3000), { what: "", fields: ["a"] });
    // The truncated call is redone as smaller pieces; its broken JSON is never used.
    expect(f.calls.length).toBeGreaterThanOrEqual(3);
    expect(out.dataset.records.map((r) => r.a)).toEqual(Array.from({ length: f.calls.length - 1 }, (_, i) => `r${i + 2}`));
    expect(out.issues).toEqual([]);
  });
  it("reports unreadable output instead of inventing data", async () => {
    const f = fake(() => ({ text: "I cannot do that" }));
    const out = await T.extract(ctx(f.chatImpl), page(1000), { what: "", fields: ["a"] });
    expect(out.dataset.records).toEqual([]);
    expect(out.issues[0]).toMatch(/no JSON/);
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
