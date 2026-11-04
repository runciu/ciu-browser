# CIU Browser

A Chromium extension that lets the model already running in CIU read the page you are on. Summarise a page, ask questions about it, explain a selection, and pull structured data out of it, without configuring a second model and without page text leaving your machine.

Part of [CIU](https://runciu.com): one local model, shared by every app on your machine.

## Download and install

**[Download CIU Browser (latest)](https://github.com/runciu/ciu-browser/releases/latest/download/ciu-browser.zip)**

Works in Chrome, Edge, Brave and other Chromium browsers. You also need [CIU](https://github.com/runciu/ciu) running with a model loaded.

1. Unzip the download. You get a folder called `ciu-browser`.
2. Open `chrome://extensions` (in Edge, `edge://extensions`) and switch on **Developer mode**.
3. Click **Load unpacked** and choose the `ciu-browser` folder.
4. Pin CIU from the puzzle-piece menu, open any page, and click the CIU icon (or press Alt+Shift+C).

Keep the folder where it is: the browser loads the extension from it. To update, download the new zip, replace the folder's contents, and click the reload arrow on the CIU Browser card in `chrome://extensions`.

CIU Browser is an early beta, installed outside the Chrome Web Store for now. It never sends page content anywhere except the CIU server on your own machine; see [Security and privacy](#security-and-privacy).

## What it does

| Charter ID | Feature | Where |
|---|---|---|
| BR-01, BR-02 | Detects CIU, shows the active model and its context size, polls every 5 s | Panel header |
| BR-03 | Reads the page only when you invoke CIU on it | `src/lib/page.ts`, `src/content/extract.ts` |
| BR-04 | Summarise page (map-reduce on long pages) | **Summarise page** |
| BR-05 | Grounded Q&A, with follow-up history | Ask box |
| BR-06 | Explain selection, with surrounding context | **Explain selection**, right-click menu |
| BR-07 | Extract to a table. A request that matches a page table (by its caption, headers or the fields you name) is copied from it exactly, with only the columns you asked for; anything else goes to schema-constrained model extraction. Handles merged cells, multi-row headers, tables with small tables inside cells, and div-based ARIA grids. | **Extract data** |
| BR-08 | Copy, Markdown, CSV and JSON export | Buttons under each answer |
| BR-09 | Progress, plain-language errors, Stop (or Esc) | Composer bar |
| BR-10 | Context budgeting, chunking and an explicit coverage line on every answer | `src/lib/budget.ts`, `src/lib/tasks.ts` |
| BR-11 | Per-page conversation history, local only, with retention and delete | Trash icon, Settings |
| BR-12 | Translate and rewrite (simpler, shorter) a selection | Right-click menu |

Every answer ends with a coverage line: **FULL** (whole page read), **PARTIAL** (which sections, and how to read more), or **EXACT** (copied from a page table, no model involved).

## Build from source

You need Node 20+ and a running CIU.

    npm install
    npm run build

Then in Chrome, Edge or Brave: open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and choose the `dist` folder. Click the CIU icon (or press Alt+Shift+C) to open the side panel.

`npm run package` builds the release zips (`ciu-browser.zip` and a versioned copy) for testers to load the same way.

### The CIU side

CIU needs the request guard in `core-patch/0001-ciu-request-guard.patch` (see Security). Apply it in the CIU repo:

    cd ciu && git apply ../ciu-browser/core-patch/0001-ciu-request-guard.patch
    python -m pytest tests/test_guard.py

The extension works with an unpatched CIU, but without the guard any website can drive CIU.

## Releasing

Set the same new version in `package.json` and `static/manifest.json`, commit, then push a tag with that number:

    git tag v0.1.7
    git push origin v0.1.7

The Release workflow checks the versions match, runs the tests, builds `ciu-browser.zip` and publishes it as a GitHub release. The download link at the top always points to the newest release.

## How it talks to CIU

No new API. The extension uses two endpoints CIU already has:

* `GET /api/status` for detection, model name and `n_ctx` (2 s timeout).
* `POST /v1/chat/completions`, streamed, with `chat_template_kwargs.enable_thinking=false` by default and `response_format: json_schema` for extraction, which llama-server compiles into a grammar.

CIU's context-full error is caught and the task retries with a smaller budget (100%, 60%, 35%) before giving up with an instruction to reload at a larger context.

All inference runs in the side panel rather than the service worker: an MV3 worker can be suspended in the middle of a stream, and the panel lives exactly as long as the user is looking at it. The worker only owns the context menu.

## Security and privacy

* **Nothing leaves the machine.** The endpoint setting accepts loopback hosts only, and the extension's CSP sets `connect-src` to loopback, so even a bug cannot send page text elsewhere.
* **No standing page access by default.** The only fixed host permissions are `127.0.0.1` and `localhost`. CIU can read a page after you click its toolbar icon on it (Chrome's `activeTab`, which ends when the tab navigates away), after you allow that site, or after you choose "Allow on all sites" once. In every case it reads only when you press a button. Grants are listed and revocable in Settings.
* **Prompt injection.** Page text, titles and URLs only ever appear inside a fence whose boundary is random per request and stripped from the content, under a system prompt that says page text is data. Elements hidden from the reader (`display:none`, `visibility:hidden`, zero opacity) are dropped before the model sees anything. Model output is rendered with `textContent` only, and links are never made clickable.
* **Sensitive fields.** Inputs, textareas, selects and password fields are never read.
* **CSV export** prefixes cells starting with `=`, `+`, `-` or `@` so scraped text cannot run as a spreadsheet formula.
* **CIU request guard** (the core patch). Without it, any site you visit can POST to `127.0.0.1:8674`: unload the model, or burn the GPU with a `text/plain` chat request, and with DNS rebinding even read responses. The guard rejects any Host header that is not loopback (defeats rebinding) and any browser Origin that is not CIU's own page or a browser extension. Requests with no Origin, such as curl and the Blender and Godot addons, are unaffected. `CIU_ALLOWED_ORIGINS` adds local web apps on purpose.

## Testing

    npm test              # 42 unit tests: budgeting, chunking, SSE, schema, export, extraction, task orchestration
    npm run typecheck
    npm run mock-ciu      # fake CIU on :8674, same endpoints and error shapes
    npm run e2e           # 35 checks in real Chromium, including an https site before and after access is granted, with the extension loaded, against the mock
    npm run check-real-ciu  # extension vs a real CIU: passes the guard, model state shown

`npm run e2e` needs Chromium or Chrome for Testing (`CHROME=/path/to/binary`); branded Chrome ignores `--load-extension`.

### Evaluation suite (charter section 11)

    npm run eval                    # every case once, against CIU on :8674
    npm run eval -- --repeat 3      # for the 90% release gate
    npm run eval -- --only qa,long

Runs the extension's own task code on fixture pages in `eval/fixtures` (news article, API docs with a code block and a table, product cards, a 60k-character article with a fact near the end, a script-rendered page, and a page carrying visible and hidden prompt injections), plus CIU-unavailable and cancellation checks. It prints pass rates against both release gates (90% of basic tasks, all security cases) and writes full outputs and timings to `eval/results/`.

## Known limits

* Token counts are estimates (CIU does not expose a tokenizer on `/v1`). They are pessimistic, and the retry loop absorbs the rest.
* Long pages cost one model call per section. "Sections per task" (default 12) caps the run time; the coverage line says when it was reached.
* Collapsed content (closed accordions, inactive tabs) counts as hidden and is not read.
* PDFs, iframes, shadow DOM and canvas text are not read yet.
* Chromium only; Firefox is a later target.

## Layout

    static/            manifest, panel and settings HTML/CSS, icons
    src/background.ts  context menu, opens the panel
    src/sidepanel/     panel controller and safe Markdown renderer
    src/options/       settings page
    src/content/       page extractor, injected on demand
    src/lib/           CIU client, budgeting, prompts, tasks, schema, export, history, settings
    eval/              fixtures, suite and runner
    tools/             mock CIU, e2e and real-CIU checks
    core-patch/        request guard for CIU core

## Licence

CIU Browser is free software under the [GNU Affero General Public License v3.0](LICENSE). Bundled: [Mozilla Readability](https://github.com/mozilla/readability) (Apache-2.0).
