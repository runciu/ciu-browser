import { getStatus } from "../lib/ciu";
import * as H from "../lib/history";
import { ALL_SITES, grantedSites } from "../lib/page";
import { loadSettings, normaliseEndpoint, saveSettings, type Settings } from "../lib/settings";

const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as E;

const NUM: (keyof Settings)[] = ["maxOutputTokens", "maxSections", "temperature", "historyDays", "fallbackCtx"];
const TXT: (keyof Settings)[] = ["endpoint", "translateTo"];
const BOOL: (keyof Settings)[] = ["thinking", "keepHistory"];

function fill(s: Settings) {
  for (const k of [...NUM, ...TXT]) $(k).value = String(s[k]);
  for (const k of BOOL) $(k).checked = Boolean(s[k]);
}

function read(): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const k of NUM) out[k] = Number($(k).value);
  for (const k of TXT) out[k] = $(k).value.trim();
  for (const k of BOOL) out[k] = $(k).checked;
  return out as Partial<Settings>;
}

async function test() {
  const r = $<HTMLElement>("testResult");
  let ep: string;
  try {
    ep = normaliseEndpoint($("endpoint").value);
  } catch (e) {
    r.className = "bad";
    r.textContent = (e as Error).message;
    return;
  }
  r.className = "hint";
  r.textContent = "Testing";
  const st = await getStatus(ep);
  r.className = st.state === "ready" ? "ok" : "bad";
  r.textContent =
    st.state === "ready"
      ? `Connected in ${st.latencyMs} ms. Model: ${st.model ?? "unknown"}, context ${st.nCtx ?? "unknown"} tokens.`
      : st.message;
  const diag = {
    extension: chrome.runtime.getManifest().version,
    endpoint: ep,
    state: st.state,
    latencyMs: st.latencyMs,
    model: st.model,
    nCtx: st.nCtx,
    message: st.message,
    // The raw payload minus the log tail, which can be long.
    ciu: st.raw ? { ...(st.raw as any), runner: { ...(st.raw as any).runner, log_tail: undefined } } : null,
  };
  $<HTMLElement>("diag").textContent = JSON.stringify(diag, null, 2);
}

async function renderSites() {
  const ul = $<HTMLElement>("sites");
  ul.replaceChildren();
  const sites = await grantedSites();
  if (!sites.length) {
    const li = document.createElement("li");
    li.className = "none";
    li.textContent = "None. CIU can read a page only after you click its toolbar icon on that page.";
    ul.append(li);
    return;
  }
  // "Allow on all sites" is two patterns; show and remove it as one entry.
  const all = ALL_SITES.every((p) => sites.includes(p));
  const entries: { label: string; patterns: string[] }[] = [
    ...(all ? [{ label: "All sites", patterns: ALL_SITES }] : []),
    ...sites.filter((s) => !all || !ALL_SITES.includes(s)).map((s) => ({ label: s, patterns: [s] })),
  ];
  for (const e of entries) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.className = "btn small danger";
    b.type = "button";
    b.textContent = "Remove";
    b.onclick = async () => {
      await chrome.permissions.remove({ origins: e.patterns });
      renderSites();
    };
    li.append(e.label, b);
    ul.append(li);
  }
}

async function renderStats() {
  const st = await H.stats();
  $<HTMLElement>("historyStats").textContent = `${st.pages} page${st.pages === 1 ? "" : "s"}, ${st.turns} messages, ${(st.bytes / 1024).toFixed(1)} KB`;
}

async function main() {
  fill(await loadSettings());
  renderSites();
  renderStats();
  $("test").onclick = test;
  $("clearHistory").onclick = async () => {
    if (!confirm("Delete all saved CIU conversations on this computer?")) return;
    await H.clearAll();
    renderStats();
  };
  $<HTMLFormElement>("form").onsubmit = async (e) => {
    e.preventDefault();
    const out = $<HTMLElement>("saved");
    try {
      const s = await saveSettings(read());
      fill(s);
      // Turning history off stops saving; deleting what exists is the explicit button's job.
      if (s.keepHistory) await H.pruneStored(s.historyDays);
      renderStats();
      out.className = "ok";
      out.textContent = "Saved.";
    } catch (err) {
      out.className = "bad";
      out.textContent = (err as Error).message;
    }
  };
  chrome.permissions.onAdded.addListener(renderSites);
  chrome.permissions.onRemoved.addListener(renderSites);
}

main();
