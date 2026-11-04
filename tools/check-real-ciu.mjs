// Smoke test against a real, running CIU (no model needed): the extension's
// requests must pass CIU's request guard, and a web page's must not.
//
//   CHROME=/path/to/chromium node tools/check-real-ciu.mjs

import { resolve, join } from "node:path";
import { chromium } from "playwright-core";

const dist = join(resolve(import.meta.dirname, ".."), "dist");
const ctx = await chromium.launchPersistentContext("", {
  executablePath: process.env.CHROME ?? "/usr/bin/google-chrome",
  headless: true,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--headless=new"],
});
let ok = true;
try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  const id = new URL(sw.url()).host;

  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await panel.waitForSelector('#conn:not([data-state="offline"])', { timeout: 8000 });
  console.log("panel state:", await panel.getAttribute("#conn", "data-state"), "|", (await panel.textContent("#model"))?.trim());

  const [code] = await panel.evaluate(async () => {
    const r = await fetch("http://127.0.0.1:8674/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    return [r.status];
  });
  console.log("extension POST /v1/chat/completions ->", code, code === 403 ? "(BLOCKED: wrong)" : "(passes the guard)");
  ok &&= code !== 403;

  // A hostile web page tries a form-style POST that needs no CORS preflight.
  const site = await ctx.newPage();
  await site.route("https://evil.example/", (r) => r.fulfill({ contentType: "text/html", body: "<p>hi</p>" }));
  await site.goto("https://evil.example/");
  await site.evaluate(() => fetch("http://127.0.0.1:8674/api/unload", { method: "POST", mode: "no-cors" }).catch(() => {}));
  console.log("hostile page POST /api/unload sent; check CIU log for 403");
} finally {
  await ctx.close();
}
process.exit(ok ? 0 : 1);
