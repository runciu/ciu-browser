// A stand-in for CIU, for developing and testing the extension without a
// model. Same endpoints and error shapes as CIU (including the request guard).
//
//   node tools/mock-ciu.mjs                  ready, 4096 context
//   MOCK_STATE=stopped node tools/mock-ciu.mjs   CIU running, no model
//   MOCK_CTX=2048 MOCK_DELAY=40 node tools/mock-ciu.mjs
//
// GET /mock/requests returns every chat request received, for inspection.

import http from "node:http";

const PORT = Number(process.env.PORT ?? 8674);
let state = process.env.MOCK_STATE ?? "ready";
const N_CTX = Number(process.env.MOCK_CTX ?? 4096);
const DELAY = Number(process.env.MOCK_DELAY ?? 15);
const requests = [];
// Mirrors CIU's extension allowlist. Unset means any extension, for convenience;
// POST /mock/allow?origins=a,b sets it, POST /mock/allow?origins=any clears it.
let extAllow = process.env.MOCK_EXTENSION_ORIGINS ? process.env.MOCK_EXTENSION_ORIGINS.split(",") : null;

const status = () => ({
  hardware: { backend: "metal", total_gib: 8, free_gib: 2.1 },
  models: [{ id: "qwen35-9b-nf4dq", name: "Qwen3.5 9B", filename: "Qwen3.5-9B-NF4DQ.gguf", downloaded: true }],
  runner: {
    state,
    error: null,
    model_path: state === "stopped" ? null : "/Users/x/.ciu/models/Qwen3.5-9B-NF4DQ.gguf",
    n_ctx: state === "stopped" ? null : N_CTX,
  },
  base_url: `http://127.0.0.1:${PORT}/v1`,
});

const json = (res, code, obj) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};

function guard(req) {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) return "host";
  const o = req.headers.origin;
  if (!o || o === `http://127.0.0.1:${PORT}`) return null;
  const isExt = /^(chrome|moz|safari-web)-extension:\/\//.test(o);
  if (!isExt || (extAllow && !extAllow.includes(o))) return "origin";
  return null;
}

/**
 * Fake but schema-shaped extraction, in CIU Browser's row format: pull
 * "| name | £price |" lines out of the prompt as rows. Fixed columns come from
 * the schema's row length; auto mode answers with its own column names.
 */
function fakeExtraction(body) {
  const props = body.response_format?.json_schema?.schema?.properties ?? {};
  const width = props.rows?.items?.minItems ?? 2;
  const auto = !!props.fields;
  const page = body.messages.map((m) => m.content).join("\n");
  const rows = [];
  for (const m of page.matchAll(/\|\s*([^|\n]+?)\s*\|\s*([£$€]?\d[\d.,]*)\s*\|/g)) {
    if (/^-+$/.test(m[1])) continue;
    rows.push(Array.from({ length: auto ? 2 : width }, (_, i) => (i === 0 ? m[1] : i === 1 ? m[2] : null)));
  }
  return JSON.stringify(auto ? { fields: ["name", "price"], rows } : { rows });
}

function reply(body) {
  if (body.response_format) return fakeExtraction(body);
  const user = body.messages.filter((m) => m.role === "user").pop()?.content ?? "";
  const injected = /IGNORE (ALL )?PREVIOUS INSTRUCTIONS/i.test(body.messages.map((m) => m.content).join(" "));
  const chars = body.messages.reduce((a, m) => a + m.content.length, 0);
  return [
    `- Mock answer from the fake CIU (${chars} prompt characters).`,
    `- Last instruction began: "${user.split("\n").filter(Boolean).pop()?.slice(0, 60)}"`,
    injected ? "- The page contains instructions aimed at AI assistants; they were ignored." : "- No injected instructions seen.",
    "- **Bold** and `code` render.",
  ].join("\n");
}

const server = http.createServer(async (req, res) => {
  const why = guard(req);
  if (why) return json(res, 403, { error: { message: `forbidden ${why}`, type: `ciu_forbidden_${why}` } });

  if (req.method === "GET" && req.url === "/api/status") return json(res, 200, status());
  if (req.method === "GET" && req.url === "/mock/requests") return json(res, 200, requests);
  if (req.method === "POST" && req.url?.startsWith("/mock/allow")) {
    const v = new URL(req.url, "http://x").searchParams.get("origins") ?? "any";
    extAllow = v === "any" ? null : v.split(",");
    return json(res, 200, { extAllow });
  }
  if (req.method === "POST" && req.url === "/api/status") return json(res, 405, { detail: "Method Not Allowed" });
  if (req.method === "POST" && req.url?.startsWith("/mock/state/")) {
    state = req.url.split("/").pop();
    return json(res, 200, { state });
  }
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    if (state !== "ready")
      return json(res, 503, { error: { message: `No model loaded (state: ${state}).`, type: "ciu_not_ready" } });
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    requests.push(body);
    // Real tokenizers average ~4 chars/token on English; overrun is an error, like llama-server.
    const promptTok = Math.ceil(body.messages.reduce((a, m) => a + m.content.length, 0) / 4);
    if (promptTok + (body.max_tokens ?? 0) > N_CTX)
      return json(res, 400, {
        error: { message: `This conversation has filled the ${N_CTX}-token context.`, type: "ciu_context_full", n_ctx: N_CTX },
      });

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    let closed = false;
    res.on("close", () => (closed = true));
    const text = reply(body);
    const toks = text.match(/.{1,6}/gs) ?? [];
    for (const t of toks) {
      if (closed) return;
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: t }, finish_reason: null }] })}\n\n`);
      await new Promise((r) => setTimeout(r, DELAY));
    }
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: promptTok, completion_tokens: toks.length } })}\n\n`);
    res.end("data: [DONE]\n\n");
    return;
  }
  json(res, 404, { error: { message: "not found" } });
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock CIU on http://127.0.0.1:${PORT} (state=${state}, n_ctx=${N_CTX})`));
