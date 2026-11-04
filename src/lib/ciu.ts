// The only module that talks to CIU. Everything goes through two endpoints
// CIU already has: GET /api/status for detection and model info, and the
// OpenAI-compatible POST /v1/chat/completions for inference. No adapter.

export type ConnState = "offline" | "no-model" | "loading" | "ready" | "error";

export interface CiuStatus {
  state: ConnState;
  /** Human-readable model name, e.g. "Qwen3.5 9B". */
  model: string | null;
  /** Context window the model was loaded with, in tokens. */
  nCtx: number | null;
  message: string;
  latencyMs: number;
  /** Raw status payload, kept for the diagnostics view. */
  raw?: unknown;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  maxTokens: number;
  temperature: number;
  thinking: boolean;
  /** JSON schema to constrain output. llama-server turns it into a grammar. */
  jsonSchema?: object;
  signal?: AbortSignal;
  onToken?: (text: string) => void;
  onReasoning?: (text: string) => void;
}

export interface ChatResult {
  text: string;
  finishReason: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
}

/** An error that carries a plain-language message fit to show the user. */
export class CiuError extends Error {
  constructor(
    message: string,
    public kind:
      | "offline"
      | "not-ready"
      | "context-full"
      | "bad-response"
      | "aborted"
      | "http",
    public detail?: unknown,
  ) {
    super(message);
    this.name = "CiuError";
  }
}

const STATUS_TIMEOUT_MS = 2000;

export async function getStatus(endpoint: string, fetchImpl: typeof fetch = fetch): Promise<CiuStatus> {
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), STATUS_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${endpoint}/api/status`, { signal: ctl.signal, cache: "no-store" });
    const latencyMs = Date.now() - t0;
    if (!res.ok) {
      return { state: "error", model: null, nCtx: null, latencyMs, message: `CIU answered HTTP ${res.status}.` };
    }
    const raw = await res.json();
    return { ...parseStatus(raw), latencyMs, raw };
  } catch (e) {
    const latencyMs = Date.now() - t0;
    const timedOut = ctl.signal.aborted;
    return {
      state: "offline",
      model: null,
      nCtx: null,
      latencyMs,
      message: timedOut
        ? "CIU did not answer within 2 seconds."
        : "CIU is not running. Start CIU (the `ciu` command, or `python3 run.py` in your CIU folder) and try again.",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Pure: turn CIU's /api/status payload into what the extension needs. */
export function parseStatus(raw: any): Omit<CiuStatus, "latencyMs"> {
  const runner = raw?.runner ?? {};
  const state: string = runner.state ?? "stopped";
  const path: string | null = runner.model_path ?? null;
  let model: string | null = null;
  if (path) {
    const hit = (raw?.models ?? []).find((m: any) => m?.filename && path.endsWith(m.filename));
    model = hit?.name ?? path.split(/[\\/]/).pop() ?? null;
  }
  const nCtx = typeof runner.n_ctx === "number" ? runner.n_ctx : null;
  switch (state) {
    case "ready":
      return { state: "ready", model, nCtx, message: "Connected." };
    case "loading":
      return { state: "loading", model, nCtx, message: "CIU is loading the model." };
    case "error":
      return {
        state: "error",
        model,
        nCtx,
        message: runner.error ? `CIU reported an error: ${runner.error}` : "CIU reported an error.",
      };
    default:
      return { state: "no-model", model: null, nCtx: null, message: "CIU is running but no model is loaded." };
  }
}

/**
 * Stream a chat completion. Resolves with the full text when the stream ends.
 * Abort via options.signal; that rejects with CiuError("aborted").
 */
export async function chat(
  endpoint: string,
  messages: ChatMessage[],
  opts: ChatOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    messages,
    stream: true,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
    // Qwen3-family templates read this. Other templates ignore it.
    chat_template_kwargs: { enable_thinking: opts.thinking },
    stream_options: { include_usage: true },
  };
  if (opts.jsonSchema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "extraction", strict: true, schema: opts.jsonSchema },
    };
  }

  let res: Response;
  try {
    res = await fetchImpl(`${endpoint}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (e) {
    if (opts.signal?.aborted) throw new CiuError("Stopped.", "aborted");
    throw new CiuError("Could not reach CIU. Is it still running?", "offline", e);
  }

  if (!res.ok) throw await errorFromResponse(res);
  if (!res.body) throw new CiuError("CIU returned an empty response.", "bad-response");

  const out: ChatResult = { text: "", finishReason: null, promptTokens: null, completionTokens: null };
  try {
    for await (const evt of sseEvents(res.body)) {
      if (evt === "[DONE]") break;
      let j: any;
      try {
        j = JSON.parse(evt);
      } catch {
        continue; // keep-alive or a partial vendor line; not fatal
      }
      if (j.error) throw new CiuError(j.error.message ?? "CIU reported an error mid-stream.", "http", j.error);
      const choice = j.choices?.[0];
      const delta = choice?.delta ?? {};
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
        opts.onReasoning?.(delta.reasoning_content);
      }
      if (typeof delta.content === "string" && delta.content) {
        out.text += delta.content;
        opts.onToken?.(delta.content);
      }
      if (choice?.finish_reason) out.finishReason = choice.finish_reason;
      if (j.usage) {
        out.promptTokens = j.usage.prompt_tokens ?? out.promptTokens;
        out.completionTokens = j.usage.completion_tokens ?? out.completionTokens;
      }
    }
  } catch (e) {
    if (opts.signal?.aborted) throw new CiuError("Stopped.", "aborted");
    if (e instanceof CiuError) throw e;
    throw new CiuError("The connection to CIU dropped while answering.", "offline", e);
  }
  return out;
}

async function errorFromResponse(res: Response): Promise<CiuError> {
  let payload: any = null;
  try {
    payload = await res.json();
  } catch {
    /* not JSON */
  }
  const err = payload?.error ?? {};
  const msg: string = err.message ?? `CIU answered HTTP ${res.status}.`;
  if (err.type === "ciu_not_ready" || res.status === 503) {
    return new CiuError("No model is loaded in CIU. Open CIU and load one.", "not-ready", payload);
  }
  if (err.type === "ciu_context_full" || /context|n_ctx|exceed/i.test(msg)) {
    return new CiuError(msg, "context-full", payload);
  }
  if (res.status === 403) {
    return new CiuError(
      "CIU refused the request from the extension. Update CIU, or check its allowed origins.",
      "http",
      payload,
    );
  }
  return new CiuError(msg, "http", payload);
}

/** Yield the data payload of each server-sent event. */
export async function* sseEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      // Events are separated by a blank line. Normalise CRLF first.
      buf = buf.replace(/\r\n/g, "\n");
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = raw
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data) yield data;
      }
    }
    buf += dec.decode();
    const tail = buf
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}
