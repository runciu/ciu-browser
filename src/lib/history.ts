// Local conversation history, per page. Stored only in chrome.storage.local,
// never synced, and deletable per page or all at once.

export interface Turn {
  role: "user" | "assistant";
  content: string;
  at: number;
  /** What produced the turn: "ask", "summarise", "explain", ... */
  kind: string;
  coverage?: string;
}

export interface PageHistory {
  title: string;
  updatedAt: number;
  turns: Turn[];
}

type HistoryMap = Record<string, PageHistory>;

const KEY = "history";
const MAX_PAGES = 200;
const MAX_TURNS = 60;

/** Same page, regardless of fragment. Query strings are kept: they often change content. */
export function pageKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

async function readAll(): Promise<HistoryMap> {
  return ((await chrome.storage.local.get(KEY))[KEY] ?? {}) as HistoryMap;
}

async function writeAll(m: HistoryMap): Promise<void> {
  await chrome.storage.local.set({ [KEY]: m });
}

export function prune(m: HistoryMap, days: number, now = Date.now()): HistoryMap {
  const out: HistoryMap = {};
  const cutoff = days > 0 ? now - days * 86_400_000 : -Infinity;
  const entries = Object.entries(m)
    .filter(([, h]) => h.updatedAt >= cutoff)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, MAX_PAGES);
  for (const [k, h] of entries) out[k] = { ...h, turns: h.turns.filter((t) => t.at >= cutoff).slice(-MAX_TURNS) };
  return out;
}

export async function getPage(url: string): Promise<PageHistory | null> {
  return (await readAll())[pageKey(url)] ?? null;
}

export async function appendTurns(url: string, title: string, turns: Turn[], days: number): Promise<void> {
  const m = await readAll();
  const k = pageKey(url);
  const cur = m[k] ?? { title, updatedAt: 0, turns: [] };
  cur.title = title;
  cur.updatedAt = Date.now();
  cur.turns = [...cur.turns, ...turns];
  m[k] = cur;
  await writeAll(prune(m, days));
}

export async function clearPage(url: string): Promise<void> {
  const m = await readAll();
  delete m[pageKey(url)];
  await writeAll(m);
}

export async function clearAll(): Promise<void> {
  await chrome.storage.local.remove(KEY);
}

export async function stats(): Promise<{ pages: number; turns: number; bytes: number }> {
  const m = await readAll();
  const pages = Object.keys(m).length;
  const turns = Object.values(m).reduce((a, h) => a + h.turns.length, 0);
  return { pages, turns, bytes: JSON.stringify(m).length };
}

export async function pruneStored(days: number): Promise<void> {
  await writeAll(prune(await readAll(), days));
}
