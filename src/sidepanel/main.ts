import { CiuError, getStatus, type ChatMessage, type CiuStatus } from "../lib/ciu";
import { toCsv, toCsvFile, toJson, toMarkdownTable } from "../lib/export";
import * as H from "../lib/history";
import {
  PageAccessError,
  activeTab,
  hasAllSites,
  readActiveTab,
  requestSiteAccess,
  type PageSnapshot,
} from "../lib/page";
import { parseFieldList } from "../lib/schema";
import { loadSettings, type Settings } from "../lib/settings";
import * as T from "../lib/tasks";
import type { PendingJob } from "../background";
import { renderMarkdown } from "./markdown";

const $ = <E extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as E;

let settings: Settings;
let status: CiuStatus = { state: "offline", model: null, nCtx: null, message: "", latencyMs: 0 };
let running: AbortController | null = null;
let tab: { id: number; url: string; title: string } | null = null;
/** Retried after the user grants site access. */
let lastAttempt: (() => void) | null = null;

// ------------------------------------------------------------ connection

async function refreshStatus(): Promise<CiuStatus> {
  status = await getStatus(settings.endpoint);
  const conn = $("conn");
  conn.dataset.state = status.state;
  const ctx = status.nCtx ? ` · ${status.nCtx >= 1024 ? Math.round(status.nCtx / 1024) + "K" : status.nCtx} context` : "";
  $("model").textContent =
    status.state === "ready" ? `${status.model ?? "Model"}${ctx}` :
    status.state === "loading" ? "Loading model" :
    status.state === "no-model" ? "No model loaded" :
    status.state === "forbidden" ? "Blocked by CIU" :
    status.state === "error" ? "Error" : "Not connected";
  conn.title = `${status.message} (${settings.endpoint}, ${status.latencyMs} ms)`;

  const n = $("notice");
  if (status.state === "ready") {
    n.hidden = true;
  } else if (status.state === "forbidden" && status.fix) {
    // CIU's guard refuses this extension's ID. Say which ID, and give the
    // exact command, since the ID differs per install until it is pinned.
    n.hidden = false;
    const cmd = document.createElement("code");
    cmd.className = "fix";
    cmd.textContent = status.fix;
    const copy = document.createElement("button");
    copy.className = "btn small";
    copy.type = "button";
    copy.textContent = "Copy command";
    copy.onclick = async () => {
      await navigator.clipboard.writeText(status.fix ?? "");
      copy.textContent = "Copied";
    };
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "Run it in your CIU folder (or use `ciu` instead of `python3 run.py` if you installed CIU with the installer).";
    n.replaceChildren(status.message + " ", document.createElement("br"), cmd, " ", copy, p);
  } else {
    n.hidden = false;
    n.replaceChildren(status.message + " ");
    const a = document.createElement("a");
    a.href = "#";
    a.textContent = status.state === "offline" ? "How to start CIU" : "Open CIU";
    a.onclick = (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: status.state === "offline" ? "https://runciu.com" : settings.endpoint });
    };
    n.append(a);
  }
  syncButtons();
  return status;
}

function syncButtons() {
  const ready = status.state === "ready" && !running;
  document.querySelectorAll<HTMLButtonElement>("[data-needs=ready]").forEach((b) => (b.disabled = !ready));
}

// ------------------------------------------------------------ tab

async function refreshTab() {
  try {
    const t = await activeTab();
    const changed = !tab || tab.id !== t.id || H.pageKey(tab.url) !== H.pageKey(t.url ?? "");
    tab = { id: t.id!, url: t.url ?? "", title: t.title ?? "" };
    // No URL means Chrome is hiding the tab from CIU: no access yet.
    $("pageTitle").textContent = tab.url ? tab.title || "(untitled page)" : "This page";
    let host = tab.url;
    try {
      host = new URL(tab.url).host || tab.url;
    } catch {}
    $("pageUrl").textContent = tab.url ? host : "Address hidden until CIU has access";
    $("pageUrl").title = tab.url;
    await showAccess(tab.url ? null : { origin: undefined });
    if (changed) {
      $("tables").replaceChildren();
      await renderHistory();
    }
  } catch {
    tab = null;
    $("pageTitle").textContent = "No page";
    $("pageUrl").textContent = "";
  }
}

/**
 * Show or hide the access prompt. `need` is null when the page is readable;
 * otherwise it carries the site's origin pattern when known.
 */
async function showAccess(need: { origin?: string } | null) {
  const box = $("access");
  if (!need) {
    box.hidden = true;
    return;
  }
  const all = await hasAllSites();
  box.hidden = false;
  const site = $("allowSite");
  site.hidden = !need.origin;
  site.dataset.origin = need.origin ?? "";
  $("allowAll").hidden = all;
  $("accessText").textContent = all
    ? "Browsers do not let extensions read this kind of page (settings, extension, store and new-tab pages)."
    : need.origin
      ? "CIU needs your permission to read this site."
      : "CIU cannot see this page yet.";
}

async function grantAccess(pattern: string | null) {
  // Called straight from the click so Chrome accepts the permission prompt.
  const ok = await requestSiteAccess(pattern);
  if (!ok) return;
  await refreshTab();
  const again = lastAttempt;
  lastAttempt = null;
  again?.();
}

async function renderHistory() {
  const feed = $("feed");
  feed.querySelectorAll(".msg").forEach((m) => m.remove());
  const h = tab && settings.keepHistory ? await H.getPage(tab.url) : null;
  for (const t of h?.turns ?? []) {
    if (t.role === "user") addUser(t.content, t.kind);
    else {
      const b = addBot();
      b.done(
        { kind: "text", text: t.content, coverage: { note: t.coverage ?? "", complete: true, tag: t.kind === "general" ? "general" : undefined } },
        true,
      );
    }
  }
  $("empty").hidden = !!h?.turns.length;
}

// ------------------------------------------------------------ feed

const KIND_LABEL: Record<string, string> = {
  summarise: "Summarise page",
  explain: "Explain",
  extract: "Extract",
  translate: "Translate",
  rewrite: "Rewrite",
  "summarise-selection": "Summarise selection",
  general: "General knowledge",
  ask: "",
};

function addUser(text: string, kind: string) {
  $("empty").hidden = true;
  const m = document.createElement("div");
  m.className = "msg user";
  const label = KIND_LABEL[kind];
  if (label) {
    const k = document.createElement("span");
    k.className = "kind";
    k.textContent = label;
    m.append(k);
  }
  m.append(text.length > 600 ? text.slice(0, 600) + "…" : text);
  $("feed").append(m);
  scrollFeed();
}

function scrollFeed() {
  const f = $("feed");
  f.scrollTop = f.scrollHeight;
}

function slug(s: string) {
  return (s || "page").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "page";
}

function download(name: string, mime: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function toolButton(label: string, fn: () => void | Promise<void>) {
  const b = document.createElement("button");
  b.className = "btn";
  b.type = "button";
  b.textContent = label;
  b.onclick = async () => {
    await fn();
    const old = b.textContent;
    b.textContent = "Done";
    setTimeout(() => (b.textContent = old), 1200);
  };
  return b;
}

function addBot() {
  $("empty").hidden = true;
  const m = document.createElement("div");
  m.className = "msg bot";
  const body = document.createElement("div");
  body.className = "body streaming";
  m.append(body);
  $("feed").append(m);
  let text = "";
  let reasoning = "";
  let reasoningEl: HTMLElement | null = null;
  let pending = false;

  const paint = () => {
    pending = false;
    renderMarkdown(text, body);
    scrollFeed();
  };

  return {
    token(t: string) {
      text += t;
      if (!pending) {
        pending = true;
        requestAnimationFrame(paint);
      }
    },
    reason(t: string) {
      reasoning += t;
      if (!reasoningEl) {
        const d = document.createElement("details");
        d.className = "reasoning";
        const s = document.createElement("summary");
        s.textContent = "Model reasoning";
        reasoningEl = document.createElement("pre");
        d.append(s, reasoningEl);
        m.insertBefore(d, body);
      }
      reasoningEl.textContent = reasoning;
    },
    done(out: T.TextOutput | T.DataOutput, fromHistory = false) {
      body.classList.remove("streaming");
      const tools = document.createElement("div");
      tools.className = "tools";
      if (out.kind === "text") {
        text = out.text;
        renderMarkdown(text || "_(no answer)_", body);
        tools.append(
          toolButton("Copy", () => navigator.clipboard.writeText(text)),
          toolButton("Save .md", () => download(`${slug(tab?.title ?? "")}-ciu.md`, "text/markdown", `${text}\n\nSource: ${tab?.url ?? ""}\n`)),
        );
      } else {
        const d = out.dataset;
        body.replaceChildren();
        const count = document.createElement("div");
        count.className = "count";
        count.textContent = `${d.records.length} record${d.records.length === 1 ? "" : "s"} · ${d.fields.length} field${d.fields.length === 1 ? "" : "s"}`;
        body.append(count, dataTable(d));
        if (out.issues.length) {
          const ul = document.createElement("ul");
          ul.className = "issues";
          for (const i of out.issues) {
            const li = document.createElement("li");
            li.textContent = i;
            ul.append(li);
          }
          body.append(ul);
        }
        const base = slug(tab?.title ?? "");
        tools.append(
          toolButton("Copy CSV", () => navigator.clipboard.writeText(toCsv(d))),
          toolButton("Copy table", () => navigator.clipboard.writeText(toMarkdownTable(d))),
          toolButton("CSV", () => download(`${base}.csv`, "text/csv;charset=utf-8", toCsvFile(d))),
          toolButton("JSON", () => download(`${base}.json`, "application/json;charset=utf-8", toJson(d))),
        );
      }
      if (out.coverage.note) {
        const c = document.createElement("div");
        c.className = "coverage" + (out.coverage.complete ? "" : " partial");
        const tag = document.createElement("span");
        tag.className = "tag" + (out.coverage.tag ? ` tag-${out.coverage.tag}` : "");
        tag.textContent =
          out.coverage.tag ?? (out.kind === "data" && out.source === "table" ? "exact" : out.coverage.complete ? "full" : "partial");
        c.append(tag, out.coverage.note);
        m.append(c);
      }
      if (!fromHistory || out.kind === "text") m.append(tools);
      scrollFeed();
    },
    /** Model extraction in progress: show the rows found so far. */
    partial(d: { fields: string[]; records: Record<string, unknown>[] }) {
      const count = document.createElement("div");
      count.className = "count";
      count.textContent = `${d.records.length} row${d.records.length === 1 ? "" : "s"} so far…`;
      body.replaceChildren(count, dataTable(d));
      scrollFeed();
    },
    fail(msg: string) {
      body.classList.remove("streaming");
      m.classList.add("error");
      body.textContent = msg;
      scrollFeed();
    },
    element: m,
    get text() {
      return text;
    },
  };
}

function dataTable(d: { fields: string[]; records: Record<string, unknown>[] }) {
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  const t = document.createElement("table");
  const head = document.createElement("tr");
  for (const f of d.fields) {
    const th = document.createElement("th");
    th.textContent = f;
    head.append(th);
  }
  t.append(head);
  for (const r of d.records.slice(0, 500)) {
    const tr = document.createElement("tr");
    for (const f of d.fields) {
      const td = document.createElement("td");
      const v = r[f];
      if (v === null || v === undefined) {
        td.className = "null";
        td.textContent = "empty";
      } else td.textContent = String(v);
      tr.append(td);
    }
    t.append(tr);
  }
  wrap.append(t);
  return wrap;
}

// ------------------------------------------------------------ running tasks

function setProgress(msg: string | null) {
  $("progress").hidden = msg === null;
  if (msg !== null) $("progressText").textContent = msg;
}

function friendly(e: unknown): string {
  if (e instanceof CiuError || e instanceof PageAccessError) return e.message;
  return `Something went wrong: ${(e as Error)?.message ?? e}`;
}

interface RunSpec {
  kind: string;
  /** Shown as the user's turn. */
  prompt: string;
  /** Saved to history only for these kinds. */
  save?: boolean;
  work: (ctx: T.TaskCtx) => Promise<T.TextOutput | T.DataOutput>;
  /** For page questions: offer to re-ask from general knowledge. */
  question?: string;
}

async function run(spec: RunSpec) {
  if (running) return;
  // Claim the slot before the first await, so a double click cannot start two runs.
  running = new AbortController();
  syncButtons();
  const st = await refreshStatus();
  if (st.state !== "ready" || running.signal.aborted) {
    running = null;
    syncButtons();
    return;
  }
  addUser(spec.prompt, spec.kind);
  const bot = addBot();
  setProgress("Starting");
  const started = Date.now();
  try {
    const out = await spec.work({
      endpoint: settings.endpoint,
      settings,
      nCtx: status.nCtx ?? settings.fallbackCtx,
      signal: running.signal,
      onToken: (t) => {
        setProgress(`Generating · ${Math.round((Date.now() - started) / 1000)}s`);
        bot.token(t);
      },
      onProgress: (msg) => setProgress(`${msg} · ${Math.round((Date.now() - started) / 1000)}s`),
      onPartial: (d) => bot.partial(d),
    });
    bot.done(out);
    if (spec.question) {
      const q = spec.question;
      bot.element.querySelector(".tools")?.append(
        toolButton("Answer from general knowledge", () => askFromKnowledge(q)),
      );
    }
    if (settings.keepHistory && tab && spec.save !== false) {
      const content = out.kind === "text" ? out.text : toMarkdownTable({ ...out.dataset, records: out.dataset.records.slice(0, 50) });
      await H.appendTurns(
        tab.url,
        tab.title,
        [
          { role: "user", content: spec.prompt, at: started, kind: spec.kind },
          { role: "assistant", content, at: Date.now(), kind: spec.kind, coverage: out.coverage.note },
        ],
        settings.historyDays,
      );
    }
  } catch (e) {
    if (e instanceof CiuError && e.kind === "aborted") {
      // Keep what was generated visible; a partial answer is often useful.
      if (bot.text) bot.done({ kind: "text", text: bot.text, coverage: { note: "Stopped before the answer finished.", complete: false } });
      else bot.fail("Stopped.");
    } else if (e instanceof PageAccessError && e.kind === "needs-permission") {
      bot.fail(e.message + " Use the buttons above, or click the CIU icon in the toolbar, then try again.");
      await showAccess({ origin: e.origin });
      lastAttempt = () => run(spec);
    } else {
      bot.fail(friendly(e));
      if (e instanceof CiuError && (e.kind === "offline" || e.kind === "not-ready")) refreshStatus();
    }
  } finally {
    running = null;
    setProgress(null);
    syncButtons();
  }
}

async function snapshot(): Promise<PageSnapshot> {
  const s = await readActiveTab();
  // Title and URL may have changed since the panel last looked (SPAs).
  if (tab) {
    tab.title = s.title;
    tab.url = s.url;
  }
  return s;
}

function chatHistory(turns: H.Turn[]): ChatMessage[] {
  return turns.filter((t) => t.kind === "ask").map((t) => ({ role: t.role, content: t.content }));
}

// ------------------------------------------------------------ actions

function summarisePage() {
  run({
    kind: "summarise",
    prompt: "Summarise this page",
    work: async (ctx) => T.summarise(ctx, await snapshot()),
  });
}

function askFromKnowledge(q: string) {
  run({ kind: "general", prompt: q, work: (ctx) => T.askGeneral(ctx, q) });
}

function askQuestion(q: string) {
  run({
    kind: "ask",
    prompt: q,
    question: q,
    work: async (ctx) => {
      const page = await snapshot();
      const prior = settings.keepHistory ? (await H.getPage(page.url))?.turns ?? [] : [];
      return T.ask(ctx, page, q, chatHistory(prior));
    },
  });
}

function explainSelection(given?: { text: string; title: string; url: string }) {
  run({
    kind: "explain",
    prompt: given ? `“${given.text}”` : "Explain the selected text",
    work: async (ctx) => {
      let sel = given?.text ?? "";
      let context = "";
      let page = { title: given?.title ?? tab?.title ?? "", url: given?.url ?? tab?.url ?? "" };
      try {
        const s = await snapshot();
        page = s;
        if (!sel) sel = s.selection;
        if (s.selection && sel.replace(/\s+/g, " ").trim() === s.selection.replace(/\s+/g, " ").trim()) context = s.selectionContext;
      } catch (e) {
        // With a selection from the context menu, page access is a nice-to-have.
        if (!given) throw e;
      }
      if (!sel) {
        throw new PageAccessError("Select some text on the page first, or right-click a selection and choose CIU, then Explain.", "failed");
      }
      return T.explain(ctx, page, sel, context);
    },
  });
}

function runExtract(forceModel = false) {
  const what = $<HTMLInputElement>("exWhat").value.trim();
  const fields = parseFieldList($<HTMLInputElement>("exFields").value);
  const label = [what || "Main items on the page", fields.length ? `(${fields.join(", ")})` : ""].join(" ").trim();
  let usedTable = false;
  run({
    kind: "extract",
    prompt: forceModel ? `${label} (with the model)` : label,
    work: async (ctx) => {
      const page = await snapshot();
      showTables(page);
      const out = await T.extractAuto(ctx, page, { what, fields }, forceModel);
      usedTable = out.source === "table";
      return out;
    },
  }).then(() => {
    if (!usedTable) return;
    const tools = Array.from(document.querySelectorAll(".msg.bot")).at(-1)?.querySelector(".tools");
    tools?.append(toolButton("Extract with the model instead", () => runExtract(true)));
  });
}

function showTables(page: PageSnapshot) {
  const box = $("tables");
  box.replaceChildren();
  if (!page.tables.length) {
    $("exHint").textContent = "";
    if (page.tableSkips?.length) {
      // Say why tables were passed over, so a miss is visible rather than silent.
      const d = document.createElement("details");
      d.className = "label";
      const sm = document.createElement("summary");
      sm.textContent = `No data tables found (${page.tableSkips.length} skipped)`;
      const ul = document.createElement("ul");
      for (const r of page.tableSkips) {
        const li = document.createElement("li");
        li.textContent = r;
        ul.append(li);
      }
      d.append(sm, ul);
      box.append(d);
    }
    return;
  }
  const lab = document.createElement("div");
  lab.className = "label";
  lab.textContent = "Tables on this page, copied exactly without the model:";
  box.append(lab);
  page.tables.forEach((t) => {
    const b = document.createElement("button");
    b.className = "btn small";
    b.type = "button";
    b.textContent = `${t.caption} (${t.rows.length - (t.hasHeader ? 1 : 0)} rows)`;
    b.onclick = () => {
      addUser(`Table: ${t.caption}`, "extract");
      const bot = addBot();
      bot.done(T.extractTable(t));
    };
    box.append(b);
  });
}

async function toggleExtract() {
  const btn = $("extractToggle");
  const open = btn.getAttribute("aria-expanded") !== "true";
  btn.setAttribute("aria-expanded", String(open));
  $("extract").hidden = !open;
  if (open) {
    $("exWhat").focus();
    // Listing tables needs no model and is cheap; do it right away if allowed.
    try {
      showTables(await snapshot());
    } catch (e) {
      if (e instanceof PageAccessError && e.kind === "needs-permission") {
        await showAccess({ origin: e.origin });
        lastAttempt = async () => showTables(await snapshot());
      }
    }
  }
}

function runSelectionTransform(job: PendingJob) {
  const page = { title: job.title, url: job.url };
  const text = job.selectionText;
  switch (job.action) {
    case "explain":
      return explainSelection({ text, ...page });
    case "summarise-selection":
      return run({ kind: "summarise-selection", prompt: `“${text}”`, work: (ctx) => T.transformSelection(ctx, page, text, { kind: "summarise" }) });
    case "translate":
      return run({
        kind: "translate",
        prompt: `“${text}” → ${settings.translateTo}`,
        work: (ctx) => T.transformSelection(ctx, page, text, { kind: "translate", language: settings.translateTo }),
      });
    case "rewrite-simpler":
    case "rewrite-shorter": {
      const style = job.action === "rewrite-simpler" ? "simpler" : "shorter";
      return run({ kind: "rewrite", prompt: `“${text}” (${style})`, work: (ctx) => T.transformSelection(ctx, page, text, { kind: "rewrite", style }) });
    }
    case "extract-selection":
      return run({
        kind: "extract",
        prompt: `Extract from: “${text}”`,
        work: (ctx) => T.extract(ctx, { title: job.title, url: job.url, text }, { what: "", fields: [] }),
      });
    case "summarise-page":
      return summarisePage();
  }
}

async function takePending() {
  const { pending } = (await chrome.storage.session.get("pending")) as { pending?: PendingJob };
  if (!pending) return;
  await chrome.storage.session.remove("pending");
  if (Date.now() - pending.at > 60_000) return; // stale; the user has moved on
  await refreshTab();
  // Wait out an in-flight status check so the job is not dropped as "not ready".
  if (status.state !== "ready") await refreshStatus();
  runSelectionTransform(pending);
}

// ------------------------------------------------------------ wiring

async function main() {
  settings = await loadSettings();
  if (settings.keepHistory) H.pruneStored(settings.historyDays).catch(() => {});

  $("summarise").onclick = summarisePage;
  $("explainSel").onclick = () => explainSelection();
  $("extractToggle").onclick = toggleExtract;
  $("exRun").onclick = () => runExtract();
  $("stop").onclick = () => running?.abort();
  $("settings").onclick = () => chrome.runtime.openOptionsPage();
  $("newchat").onclick = async () => {
    if (tab) await H.clearPage(tab.url);
    await renderHistory();
  };
  $("allowSite").onclick = () => grantAccess($("allowSite").dataset.origin || null);
  $("allowAll").onclick = () => grantAccess(null);
  chrome.permissions.onAdded.addListener(() => refreshTab());
  chrome.permissions.onRemoved.addListener(() => refreshTab());
  chrome.runtime.onMessage.addListener((m) => {
    if (m?.type === "ciu-access-granted") refreshTab();
  });
  const q = $<HTMLTextAreaElement>("question");
  $("askForm").onsubmit = (e) => {
    e.preventDefault();
    const text = q.value.trim();
    if (!text || running || status.state !== "ready") return;
    q.value = "";
    askQuestion(text);
  };
  q.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $<HTMLFormElement>("askForm").requestSubmit();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && running) running.abort();
  });

  chrome.tabs.onActivated.addListener(() => refreshTab());
  chrome.tabs.onUpdated.addListener((id, info) => {
    if (id === tab?.id && (info.url || info.title || info.status === "complete")) refreshTab();
  });
  chrome.windows.onFocusChanged.addListener(() => refreshTab());
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === "session" && changes.pending?.newValue) takePending();
    if (area === "local" && changes.settings) {
      settings = await loadSettings();
      refreshStatus();
    }
  });

  await Promise.all([refreshStatus(), refreshTab()]);
  takePending();

  // Poll while visible; CIU may be started, or a model loaded, at any time.
  setInterval(() => {
    if (document.visibilityState === "visible" && !running) refreshStatus();
  }, 5000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      refreshStatus();
      refreshTab();
    }
  });
}

main();
