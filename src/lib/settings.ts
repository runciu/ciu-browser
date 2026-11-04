// Settings live in chrome.storage.local. Everything here has a safe default,
// so a fresh install works against a stock CIU with no configuration at all.

export interface Settings {
  /** Root of the CIU server, without /v1. Loopback only. */
  endpoint: string;
  /** Upper bound on generated tokens for one answer. */
  maxOutputTokens: number;
  /** Let thinking models think. Off by default: on a 4K context it eats the budget. */
  thinking: boolean;
  temperature: number;
  /** Language for translations. */
  translateTo: string;
  /** Keep per-page conversation history. */
  keepHistory: boolean;
  /** Delete history older than this. 0 keeps it until cleared. */
  historyDays: number;
  /** Fallback context size when CIU does not report one. */
  fallbackCtx: number;
  /**
   * Most model calls one long-page summary or extraction may make. Each call
   * is a full prompt pass, so on a laptop this is the main latency knob.
   */
  maxSections: number;
}

export const DEFAULTS: Settings = {
  endpoint: "http://127.0.0.1:8674",
  maxOutputTokens: 768,
  thinking: false,
  temperature: 0.2,
  translateTo: "English",
  keepHistory: true,
  historyDays: 30,
  fallbackCtx: 4096,
  maxSections: 12,
};

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Accept only http(s) URLs on a loopback host. This is the single gate that
 * guarantees page content is never sent off the machine, so it is strict:
 * no credentials, no path, no query.
 */
export function normaliseEndpoint(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error("Not a valid URL.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Use http:// or https://.");
  }
  if (!LOOPBACK.has(u.hostname)) {
    throw new Error("CIU must run on this machine (127.0.0.1 or localhost).");
  }
  if (u.username || u.password) throw new Error("Credentials are not allowed in the URL.");
  // Users often paste the API base. Strip a trailing /v1 rather than reject it.
  const path = u.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  if (path !== "") throw new Error("Give the server root, e.g. http://127.0.0.1:8674");
  return `${u.protocol}//${u.host}`;
}

type Store = Pick<typeof chrome.storage.local, "get" | "set">;

function store(): Store {
  return chrome.storage.local;
}

export async function loadSettings(): Promise<Settings> {
  const got = await store().get("settings");
  const s = { ...DEFAULTS, ...(got.settings ?? {}) } as Settings;
  try {
    s.endpoint = normaliseEndpoint(s.endpoint);
  } catch {
    s.endpoint = DEFAULTS.endpoint;
  }
  return s;
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const cur = await loadSettings();
  const next = { ...cur, ...patch };
  next.endpoint = normaliseEndpoint(next.endpoint);
  next.maxOutputTokens = clampInt(next.maxOutputTokens, 64, 8192);
  next.historyDays = clampInt(next.historyDays, 0, 3650);
  next.fallbackCtx = clampInt(next.fallbackCtx, 1024, 262144);
  next.maxSections = clampInt(next.maxSections, 1, 100);
  next.temperature = Math.min(2, Math.max(0, Number(next.temperature) || 0));
  await store().set({ settings: next });
  return next;
}

function clampInt(v: unknown, lo: number, hi: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}
