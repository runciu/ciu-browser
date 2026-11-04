// Runs the evaluation suite against a real CIU.
//
//   npm run eval                          every case once
//   npm run eval -- --repeat 3            three runs per case (for the 90% gate)
//   npm run eval -- --only news,long      cases whose id contains any of these
//   npm run eval -- --thinking            let the model reason first (compare with a run without)
//   npm run eval -- --endpoint http://127.0.0.1:8674
//
// Writes eval/results/<timestamp>.json and prints a summary table.
// Fixtures are parsed with jsdom; dynamic pages run their own scripts first.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { extractPage } from "../src/content/extract";
import { chat, CiuError, getStatus } from "../src/lib/ciu";
import { parseFieldList } from "../src/lib/schema";
import { DEFAULTS, normaliseEndpoint } from "../src/lib/settings";
import * as T from "../src/lib/tasks";
import { CASES, type Case, type Output } from "./suite";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const endpoint = normaliseEndpoint(arg("endpoint") ?? DEFAULTS.endpoint);
const repeat = Number(arg("repeat") ?? 1);
const only = arg("only")?.split(",");
const thinking = process.argv.includes("--thinking");

async function loadFixture(name: string) {
  const html = readFileSync(join(root, "eval", "fixtures", name), "utf8");
  const dom = new JSDOM(html, { url: `https://fixtures.ciu.test/${name}`, runScripts: "dangerously", pretendToBeVisual: true });
  if (/<script/i.test(html)) await new Promise((r) => setTimeout(r, 600));
  return dom;
}

function select(dom: JSDOM, needle: string) {
  const { document, window } = dom.window;
  const el = Array.from(document.querySelectorAll("pre, p, li, td")).find((e) => e.textContent?.includes(needle));
  if (!el) throw new Error(`selection target not found: ${needle}`);
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

function asText(o: Output): string {
  return o.kind === "text" ? o.text : JSON.stringify(o.dataset);
}

interface Result {
  id: string;
  group: string;
  run: number;
  pass: boolean;
  reasons: string[];
  ms: number;
  calls: number;
  completionTokens: number;
  coverage: string;
  output: string;
}

async function runCase(c: Case, nCtx: number, run: number): Promise<Result> {
  const dom = await loadFixture(c.fixture);
  if (c.task.kind === "explain") select(dom, c.task.select);
  const snap = extractPage(dom.window.document, dom.window as unknown as Window);
  let calls = 0;
  let completionTokens = 0;
  const counted: typeof chat = async (ep, msgs, o) => {
    calls++;
    const r = await chat(ep, msgs, o);
    completionTokens += r.completionTokens ?? 0;
    return r;
  };
  const ctx: T.TaskCtx = { endpoint, settings: { ...DEFAULTS, thinking }, nCtx, chatImpl: counted };
  const t0 = Date.now();
  const reasons: string[] = [];
  let out: Output | null = null;
  try {
    switch (c.task.kind) {
      case "summarise":
        out = await T.summarise(ctx, snap);
        break;
      case "ask":
        out = await T.ask(ctx, snap, c.task.question);
        break;
      case "extract-auto":
        out = await T.extractAuto(ctx, snap, { what: c.task.what, fields: parseFieldList(c.task.fields) }, c.task.forceModel);
        break;
      case "general":
        out = await T.askGeneral(ctx, c.task.question);
        break;
      case "explain":
        if (!snap.selection) throw new Error("no selection captured");
        out = await T.explain(ctx, snap, snap.selection, snap.selectionContext);
        break;
      case "extract":
        out = await T.extract(ctx, snap, { what: c.task.what, fields: c.task.fields });
        break;
      case "table": {
        const t = snap.tables[c.task.index];
        if (!t) throw new Error(`no table ${c.task.index} on page (found ${snap.tables.length})`);
        out = T.extractTable(t);
        break;
      }
    }
  } catch (e) {
    reasons.push(`error: ${(e as Error).message}`);
  }
  const ms = Date.now() - t0;
  if (out) {
    const text = asText(out);
    for (const re of c.must ?? []) if (!re.test(text)) reasons.push(`missing ${re}`);
    for (const re of c.mustNot ?? []) if (re.test(text)) reasons.push(`forbidden ${re}`);
    const extra = c.check?.(out);
    if (extra) reasons.push(extra);
  }
  dom.window.close();
  return {
    id: c.id,
    group: c.group,
    run,
    pass: reasons.length === 0,
    reasons,
    ms,
    calls,
    completionTokens,
    coverage: out?.coverage.note ?? "",
    output: out ? asText(out).slice(0, 4000) : "",
  };
}

/** Robustness cases that exercise the client rather than a page. */
async function robustness(): Promise<Result[]> {
  const out: Result[] = [];
  const base = { group: "robustness", run: 1, calls: 0, completionTokens: 0, coverage: "", output: "" };

  let t0 = Date.now();
  const dead = await getStatus("http://127.0.0.1:1");
  out.push({ ...base, id: "ciu-unavailable", ms: Date.now() - t0, pass: dead.state === "offline" && Date.now() - t0 < 2500, reasons: dead.state === "offline" ? [] : [`state ${dead.state}`] });

  t0 = Date.now();
  const ctl = new AbortController();
  let firstToken = 0;
  let abortedAt = 0;
  const reasons: string[] = [];
  try {
    await chat(endpoint, [{ role: "user", content: "Count slowly from 1 to 400, one number per line." }], {
      maxTokens: 1200, temperature: 0, thinking: false, signal: ctl.signal,
      onToken: () => {
        if (!firstToken) {
          firstToken = Date.now();
          setTimeout(() => {
            abortedAt = Date.now();
            ctl.abort();
          }, 500);
        }
      },
    });
    reasons.push("stream finished instead of stopping");
  } catch (e) {
    if (!(e instanceof CiuError && e.kind === "aborted")) reasons.push(`wrong error: ${(e as Error).message}`);
  }
  const stopLag = abortedAt ? Date.now() - abortedAt : -1;
  if (stopLag > 1500) reasons.push(`took ${stopLag} ms to stop`);
  out.push({ ...base, id: "cancellation", ms: Date.now() - t0, pass: reasons.length === 0, reasons, output: abortedAt ? `stopped ${stopLag} ms after abort` : "" });
  return out;
}

async function main() {
  const st = await getStatus(endpoint);
  if (st.state !== "ready") {
    console.error(`CIU at ${endpoint} is not ready: ${st.message}`);
    process.exit(2);
  }
  const nCtx = st.nCtx ?? DEFAULTS.fallbackCtx;
  console.log(`CIU ready: ${st.model}, ${nCtx}-token context. ${repeat} run(s) per case. Thinking ${thinking ? "ON" : "off"}.\n`);

  const cases = CASES.filter((c) => !only || only.some((o) => c.id.includes(o)));
  const results: Result[] = [];
  for (let r = 1; r <= repeat; r++) {
    for (const c of cases) {
      process.stdout.write(`${c.id.padEnd(24)} run ${r} ... `);
      const res = await runCase(c, nCtx, r);
      results.push(res);
      console.log(`${res.pass ? "PASS" : "FAIL"}  ${(res.ms / 1000).toFixed(1)}s  ${res.calls} call(s)${res.pass ? "" : "  " + res.reasons.join("; ")}`);
    }
  }
  if (!only) {
    for (const r of await robustness()) {
      results.push(r);
      console.log(`${r.id.padEnd(24)} run 1 ... ${r.pass ? "PASS" : "FAIL"}  ${r.output || r.reasons.join("; ")}`);
    }
  }

  const basicIds = new Set(CASES.filter((c) => c.basic).map((c) => c.id));
  const basic = results.filter((r) => basicIds.has(r.id));
  const security = results.filter((r) => r.group === "security");
  const basicRate = basic.length ? basic.filter((r) => r.pass).length / basic.length : 0;
  const secOk = security.every((r) => r.pass);
  const tokens = results.reduce((a, r) => a + r.completionTokens, 0);
  const genMs = results.reduce((a, r) => a + r.ms, 0);

  console.log(`\nBasic tasks: ${(basicRate * 100).toFixed(0)}% (${basic.filter((r) => r.pass).length}/${basic.length}), gate 90%: ${basicRate >= 0.9 ? "MET" : "NOT MET"}`);
  console.log(`Security:    ${security.filter((r) => r.pass).length}/${security.length}, gate all: ${secOk ? "MET" : "NOT MET"}`);
  console.log(`Overall:     ${results.filter((r) => r.pass).length}/${results.length} passed, ${tokens} tokens generated in ${(genMs / 1000).toFixed(0)}s of task time`);

  mkdirSync(join(root, "eval", "results"), { recursive: true });
  const file = join(root, "eval", "results", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify({ endpoint, model: st.model, nCtx, repeat, thinking, basicRate, securityPassed: secOk, results }, null, 2));
  console.log(`\nDetails: ${file}`);
  process.exit(basicRate >= 0.9 && secOk ? 0 : 1);
}

main();
