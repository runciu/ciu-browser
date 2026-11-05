// End-to-end check in a real Chromium with the built extension loaded,
// against the mock CIU. Run `npm run build` and `npm run mock-ciu` first.
//
//   CHROME=/path/to/chrome node tools/e2e.mjs
//
// Branded Chrome ignores --load-extension since v137; use Chromium or
// Chrome for Testing. The panel is opened as a tab aimed at a fixture tab,
// via the ?targetTab= hook, because automation cannot open a side panel.

import http from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
const CHROME = process.env.CHROME ?? "/usr/bin/google-chrome";
const FIX_PORT = 8700;
const shots = join(root, "e2e-shots");
mkdirSync(shots, { recursive: true });

const fixtures = http
  .createServer((req, res) => {
    try {
      const body = readFileSync(join(root, "eval", "fixtures", (req.url ?? "/").replace(/^\/+/, "").split("?")[0]));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  })
  .listen(FIX_PORT, "127.0.0.1");

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
};

const ctx = await chromium.launchPersistentContext("", {
  executablePath: CHROME,
  headless: true,
  args: [`--disable-extensions-except=${join(root, "dist")}`, `--load-extension=${join(root, "dist")}`, "--headless=new"],
  viewport: { width: 420, height: 820 },
});

try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 10_000 });
  const extId = new URL(sw.url()).host;
  check("extension loads and service worker starts", !!extId, extId);

  const menus = await sw.evaluate(() => new Promise((r) => chrome.contextMenus.removeAll(() => r(true))).then(() => true)).catch(() => false);
  check("context menu API available", menus);

  async function openPair(fixture) {
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${FIX_PORT}/${fixture}`);
    const tabId = await sw.evaluate(async (url) => (await chrome.tabs.query({ url })).at(-1)?.id, page.url());
    const panel = await ctx.newPage();
    await panel.goto(`chrome-extension://${extId}/sidepanel.html?targetTab=${tabId}`);
    await panel.waitForSelector('#conn[data-state="ready"]', { timeout: 5000 });
    return { page, panel };
  }

  const lastBot = (panel) => panel.locator(".msg.bot").last();
  // Waits for a new answer to finish: one more bot message than before the
  // action, no longer streaming, and the progress bar gone.
  const bots = new WeakMap();
  const mark = async (panel) => bots.set(panel, await panel.locator(".msg.bot").count());
  const waitDone = (panel) =>
    panel.waitForFunction(
      (n) => document.querySelectorAll(".msg.bot").length > n && !document.querySelector(".body.streaming") && document.getElementById("progress").hidden,
      bots.get(panel) ?? 0,
      { timeout: 20_000 },
    );

  // 1. Connection and model display
  const { page: news, panel } = await openPair("news-article.html");
  const model = await panel.textContent("#model");
  check("shows connection and active model", /Qwen3\.5 9B · 4K context/.test(model ?? ""), model);
  check("shows current page", (await panel.textContent("#pageTitle"))?.includes("solar farm"));

  // 2. Summarise
  await mark(panel);
  await panel.click("#summarise");
  await waitDone(panel);
  const sumText = await lastBot(panel).textContent();
  check("summarise streams an answer with coverage", /Mock answer/.test(sumText) && /whole page/.test(sumText), sumText.slice(0, 80));
  const reqs = await (await fetch("http://127.0.0.1:8674/mock/requests")).json();
  const lastReq = reqs.at(-1);
  const user = lastReq.messages.find((m) => m.role === "user").content;
  check("page text reached CIU inside a random fence", /<<<PAGE [0-9a-f]{12}>>>/.test(user) && user.includes("38-megawatt"));
  check("site chrome excluded (nav, aside)", !/Most read|Dog show/.test(user));
  check("thinking disabled by default", lastReq.chat_template_kwargs?.enable_thinking === false);
  await panel.screenshot({ path: join(shots, "1-summary.png") });

  // 3. Ask, with history
  await mark(panel);
  await panel.fill("#question", "What did SEPA do?");
  await panel.press("#question", "Enter");
  await waitDone(panel);
  await mark(panel);
  await panel.fill("#question", "And when does construction start?");
  await panel.press("#question", "Enter");
  await waitDone(panel);
  const reqs2 = await (await fetch("http://127.0.0.1:8674/mock/requests")).json();
  const roles = reqs2.at(-1).messages.map((m) => m.role).join(",");
  check("follow-up question carries history", roles === "system,user,assistant,user,assistant,user", roles);

  // 3b. General knowledge: a separate run with no page, tagged by the extension.
  await mark(panel);
  await lastBot(panel).getByRole("button", { name: "Answer from general knowledge" }).click();
  await waitDone(panel);
  const gReq = (await (await fetch("http://127.0.0.1:8674/mock/requests")).json()).at(-1);
  const gSent = gReq.messages.map((m) => m.content).join("\n");
  check("general knowledge: no page sent", !/<<<PAGE/.test(gSent) && !/38-megawatt/.test(gSent) && gReq.messages.at(-1).content === "And when does construction start?");
  check("general knowledge: tagged GENERAL", (await lastBot(panel).locator(".coverage .tag").textContent()) === "general");

  // 4. Explain selection
  await news.evaluate(() => {
    const p = [...document.querySelectorAll("p")].find((x) => x.textContent.includes("SEPA"));
    const r = document.createRange();
    r.selectNodeContents(p);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  await mark(panel);
  await panel.click("#explainSel");
  await waitDone(panel);
  const reqs3 = await (await fetch("http://127.0.0.1:8674/mock/requests")).json();
  check("explain sends the selected paragraph", /SELECTION[\s\S]*withdrew its initial objection/.test(reqs3.at(-1).messages[1].content));

  // 5. History persists across panel reloads
  await panel.reload();
  await panel.waitForSelector('#conn[data-state="ready"]');
  const n = await panel.locator(".msg").count();
  check("conversation history restored for the page", n >= 8, `${n} messages`);
  await panel.click("#newchat");
  check("clearing page history empties the feed", (await panel.locator(".msg").count()) === 0);

  // 6. Table extraction without the model
  const { panel: p2 } = await openPair("docs-qa.html");
  await p2.click("#extractToggle");
  await p2.waitForSelector("#tables .btn");
  await p2.click("#tables .btn");
  const rows = await p2.locator(".msg.bot table tr").count();
  check("page table copied exactly (header + 3 rows)", rows === 4, `${rows} rows`);
  check("exact-source tag shown", (await p2.locator(".coverage .tag").last().textContent()) === "exact");
  await p2.screenshot({ path: join(shots, "2-table.png") });

  // 7. A request that names table columns is copied from the table, not sent to the model.
  const before7 = (await (await fetch("http://127.0.0.1:8674/mock/requests")).json()).length;
  await p2.fill("#exWhat", "plans and limits");
  await p2.fill("#exFields", "Plan, Requests per minute");
  await mark(p2);
  await p2.click("#exRun");
  await waitDone(p2);
  const after7 = (await (await fetch("http://127.0.0.1:8674/mock/requests")).json()).length;
  const heads7 = await lastBot(p2).locator("th").allTextContents();
  check("matching request copies the table's chosen columns, no model call", after7 === before7 && heads7.join("|") === "Plan|Requests per minute", heads7.join("|"));

  // 7b. "Extract with the model instead" sends a strict schema at temperature 0.
  await mark(p2);
  await lastBot(p2).getByRole("button", { name: "Extract with the model instead" }).click();
  await waitDone(p2);
  const reqs4 = await (await fetch("http://127.0.0.1:8674/mock/requests")).json();
  const rf = reqs4.at(-1).response_format;
  check("model extraction sends a strict JSON schema", rf?.type === "json_schema" && rf.json_schema.schema.properties.records.items.required.join() === "plan,requests_per_minute");
  check("model extraction runs at temperature 0", reqs4.at(-1).temperature === 0);

  // 7c. The Wikipedia-shaped case: 230 rows, a small table nested in one cell,
  // asked for in plain words with "all fields". Must be exact and fast.
  const { panel: pp } = await openPair("population-table.html");
  await pp.click("#extractToggle");
  await pp.fill("#exWhat", "List of countries and inhabited territories by total population");
  await pp.fill("#exFields", "all fields");
  const t7 = Date.now();
  await mark(pp);
  await pp.click("#exRun");
  await waitDone(pp);
  const count7 = await lastBot(pp).locator(".count").textContent();
  check("large table with nested cell table copied exactly and fast", /^230 records · 6 fields/.test(count7) && Date.now() - t7 < 5000, `${count7}, ${Date.now() - t7} ms`);
  await pp.screenshot({ path: join(shots, "7-big-table.png") });

  // 8. Dynamic page: content rendered by script after load
  const { page: dyn, panel: p3 } = await openPair("dynamic.html");
  await dyn.waitForSelector("#board table");
  await p3.click("#extractToggle");
  await p3.waitForSelector("#tables .btn");
  check("dynamic content captured at read time", /3 rows/.test(await p3.textContent("#tables")));

  // 9. Hidden prompt injection never reaches the model
  const { panel: p4 } = await openPair("injection.html");
  await mark(p4);
  await p4.click("#summarise");
  await waitDone(p4);
  const reqs5 = await (await fetch("http://127.0.0.1:8674/mock/requests")).json();
  const injUser = reqs5.at(-1).messages[1].content;
  check("display:none injection removed", !/SYSTEM OVERRIDE/.test(injUser));
  check("visible injection still fenced as data", /<<<PAGE [0-9a-f]{12}>>>[\s\S]*Note to AI assistants[\s\S]*<<<END PAGE/.test(injUser));

  // 10. Cancellation
  await fetch("http://127.0.0.1:8674/mock/state/ready", { method: "POST" });
  await mark(p4);
  await p4.fill("#question", "How do I feed it?");
  await p4.press("#question", "Enter");
  await p4.waitForSelector(".msg.bot .body.streaming");
  await p4.waitForTimeout(150);
  const t0 = Date.now();
  await p4.click("#stop");
  await waitDone(p4);
  const stopped = await lastBot(p4).textContent();
  check("stop cancels generation promptly", Date.now() - t0 < 1500 && /Stopped/.test(stopped), `${Date.now() - t0} ms`);

  // 11. CIU without a model, then recovering
  await fetch("http://127.0.0.1:8674/mock/state/stopped", { method: "POST" });
  await p4.reload();
  await p4.waitForSelector('#conn[data-state="no-model"]', { timeout: 8000 });
  check("no-model state shown, actions disabled", (await p4.isDisabled("#summarise")) && /no model/i.test(await p4.textContent("#notice")));
  await p4.screenshot({ path: join(shots, "3-no-model.png") });
  await fetch("http://127.0.0.1:8674/mock/state/ready", { method: "POST" });
  await p4.waitForSelector('#conn[data-state="ready"]', { timeout: 8000 });
  check("recovers when a model is loaded", !(await p4.isDisabled("#summarise")));

  // 11b. CIU running but refusing this extension's ID (the allowlist case).
  // GET /api/status passes the guard, so the panel must probe with a POST,
  // show "Blocked by CIU" with the exact fix, and disable the actions.
  await fetch("http://127.0.0.1:8674/mock/allow?origins=chrome-extension://someotherid", { method: "POST" });
  await p4.reload();
  await p4.waitForSelector('#conn[data-state="forbidden"]', { timeout: 8000 });
  const notice = await p4.textContent("#notice");
  check("refused extension: shown as blocked, not connected", (await p4.textContent("#model")) === "Blocked by CIU" && (await p4.isDisabled("#summarise")));
  check("refused extension: gives its own ID and the exact command", notice.includes(`CIU_EXTENSION_ORIGINS=chrome-extension://${extId} python3 run.py`), notice.slice(0, 120));
  await p4.screenshot({ path: join(shots, "8-blocked.png") });
  await fetch(`http://127.0.0.1:8674/mock/allow?origins=chrome-extension://${extId}`, { method: "POST" });
  await p4.waitForSelector('#conn[data-state="ready"]', { timeout: 8000 });
  check("allowed by exact ID: connects again", !(await p4.isDisabled("#summarise")));
  await fetch("http://127.0.0.1:8674/mock/allow?origins=any", { method: "POST" });

  // 12. An ordinary https site the extension has no access to. Chrome hides
  // the URL and title; the panel must ask for access, not call it unreadable.
  // (The fixtures above are on 127.0.0.1, which the extension always has.)
  await ctx.route("https://wiki.example/**", (r) =>
    r.fulfill({ contentType: "text/html", body: readFileSync(join(root, "eval", "fixtures", "news-article.html")) }));
  const newestTab = () => sw.evaluate(async () => Math.max(...(await chrome.tabs.query({})).map((t) => t.id)));
  const site = await ctx.newPage();
  await site.goto("https://wiki.example/solar");
  const sid = await newestTab();
  const p5 = await ctx.newPage();
  await p5.goto(`chrome-extension://${extId}/sidepanel.html?targetTab=${sid}`);
  await p5.waitForSelector('#conn[data-state="ready"]');
  await p5.waitForSelector("#access:not([hidden])", { timeout: 3000 }).catch(() => {});
  await p5.screenshot({ path: join(shots, "6-needs-access.png") });
  check("no-access site: access prompt shown up front", await p5.isVisible("#access") && await p5.isVisible("#allowAll"));
  check("no-access site: not mislabelled as unreadable", (await p5.textContent("#pageTitle")) === "This page" && !/no page CIU can read/.test(await p5.textContent("body")));
  await mark(p5);
  await p5.click("#summarise");
  await p5.waitForSelector(".msg.bot.error");
  const nmsg = await p5.textContent(".msg.bot.error");
  check("no-access site: summarise explains how to grant access", /does not have access/.test(nmsg) && /CIU icon/.test(nmsg), nmsg);

  // Browser pages look the same as no-access pages from inside an extension.
  const restricted = await ctx.newPage();
  await restricted.goto("chrome://version");
  const rid = await newestTab();
  const p6 = await ctx.newPage();
  await p6.goto(`chrome-extension://${extId}/sidepanel.html?targetTab=${rid}`);
  await p6.waitForSelector('#conn[data-state="ready"]');
  await p6.waitForSelector("#access:not([hidden])", { timeout: 3000 }).catch(() => {});
  check("browser page without access: access prompt, no crash", await p6.isVisible("#access"));

  // 13. Settings refuse non-local endpoints
  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${extId}/options.html`);
  await opt.fill("#endpoint", "https://evil.example");
  await opt.click("button[type=submit]");
  check("settings refuse a remote endpoint", /this machine/.test(await opt.textContent("#saved")));
  await opt.fill("#endpoint", "http://127.0.0.1:8674");
  await opt.click("#test");
  await opt.waitForSelector("#testResult.ok");
  check("connection test reports model and context", /Qwen3\.5 9B, context 4096/.test(await opt.textContent("#testResult")));
  await opt.screenshot({ path: join(shots, "4-settings.png"), fullPage: true });
} finally {
  await ctx.close();
  fixtures.close();
}

// 14. After "Allow on all sites". Automation cannot click Chrome's permission
// dialog, so this loads a copy of the build whose manifest already holds the
// same host patterns the button requests.
{
  const { cpSync, readFileSync: rf, writeFileSync, rmSync } = await import("node:fs");
  const granted = join(root, ".e2e-granted");
  rmSync(granted, { recursive: true, force: true });
  cpSync(join(root, "dist"), granted, { recursive: true });
  const m = JSON.parse(rf(join(granted, "manifest.json"), "utf8"));
  m.host_permissions = [...m.host_permissions, ...m.optional_host_permissions];
  writeFileSync(join(granted, "manifest.json"), JSON.stringify(m));
  const c2 = await chromium.launchPersistentContext("", {
    executablePath: CHROME, headless: true, viewport: { width: 420, height: 820 },
    args: [`--disable-extensions-except=${granted}`, `--load-extension=${granted}`, "--headless=new"],
  });
  try {
    let [sw2] = c2.serviceWorkers();
    if (!sw2) sw2 = await c2.waitForEvent("serviceworker", { timeout: 10_000 });
    const id2 = new URL(sw2.url()).host;
    await c2.route("https://wiki.example/**", (r) =>
      r.fulfill({ contentType: "text/html", body: readFileSync(join(root, "eval", "fixtures", "news-article.html")) }));
    const pg = await c2.newPage();
    await pg.goto("https://wiki.example/solar");
    const tid = await sw2.evaluate(async () => (await chrome.tabs.query({ url: "https://wiki.example/*" }))[0]?.id);
    const pan = await c2.newPage();
    await pan.goto(`chrome-extension://${id2}/sidepanel.html?targetTab=${tid}`);
    await pan.waitForSelector('#conn[data-state="ready"]');
    check("granted: real title shown, no access prompt", /solar farm/.test(await pan.textContent("#pageTitle")) && !(await pan.isVisible("#access")));
    const before = (await (await fetch("http://127.0.0.1:8674/mock/requests")).json()).length;
    await pan.click("#summarise");
    await pan.waitForFunction(() => !document.querySelector(".body.streaming") && document.querySelectorAll(".msg.bot").length > 0 && document.getElementById("progress").hidden, null, { timeout: 20_000 });
    const reqs = await (await fetch("http://127.0.0.1:8674/mock/requests")).json();
    check("granted: https page read and summarised", reqs.length > before && reqs.at(-1).messages[1].content.includes("38-megawatt"));

    await (await c2.newPage()).goto("chrome://version");
    const rid2 = await sw2.evaluate(async () => Math.max(...(await chrome.tabs.query({})).map((t) => t.id)));
    const pan2 = await c2.newPage();
    await pan2.goto(`chrome-extension://${id2}/sidepanel.html?targetTab=${rid2}`);
    await pan2.waitForSelector("#access:not([hidden])", { timeout: 5000 }).catch(() => {});
    check("granted: browser pages explained as unreadable", /do not let extensions read/.test(await pan2.textContent("#accessText")));
    await pan.screenshot({ path: join(shots, "5-granted.png") });
  } finally {
    await c2.close();
    rmSync(granted, { recursive: true, force: true });
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
