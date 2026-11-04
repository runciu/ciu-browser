// Injected into a page only when the user asks CIU to read it. Never runs on
// its own, never stays resident, never touches form values.
//
// Produces readable text (Markdown-ish, headings and lists kept so the model
// sees structure), the page's data tables verbatim, and the current selection.

import { Readability } from "@mozilla/readability";

export interface PageTable {
  caption: string;
  hasHeader: boolean;
  rows: string[][];
  /** "table" for <table>, "grid" for a div-based ARIA grid. */
  kind?: string;
}

export interface PageSnapshot {
  title: string;
  url: string;
  lang: string;
  text: string;
  selection: string;
  /** Text immediately around the selection, for "explain" context. */
  selectionContext: string;
  tables: PageTable[];
  /** Why candidate tables were not offered. */
  tableSkips: string[];
  /** True when text was cut at maxChars. */
  truncated: boolean;
  /** Characters before truncation. */
  fullLength: number;
  hiddenSkipped: number;
  method: "readability" | "dom";
}

const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME", "OBJECT", "EMBED",
  "INPUT", "TEXTAREA", "SELECT", "BUTTON", "OPTION", "FORM", "DIALOG",
]);
const CHROME_TAGS = new Set(["NAV", "FOOTER", "ASIDE", "HEADER"]);
const BLOCK = new Set([
  "P", "DIV", "SECTION", "ARTICLE", "MAIN", "BLOCKQUOTE", "FIGURE", "FIGCAPTION", "DL", "DT", "DD",
  "UL", "OL", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "PRE", "TABLE", "TR", "HR", "BR", "DETAILS", "SUMMARY",
]);

function clean(s: string): string {
  return s.replace(/[ \t\f\v ]+/g, " ").replace(/ *\n */g, "\n").trim();
}

/** Walk an element and emit block-structured text. Works on detached trees. */
export function domToText(root: Element, opts: { dropChrome: boolean }): string {
  const out: string[] = [];
  let line = "";
  const flush = () => {
    const t = clean(line);
    if (t) out.push(t);
    line = "";
  };

  const walk = (node: Node, listDepth: number) => {
    if (node.nodeType === 3) {
      line += node.textContent ?? "";
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (SKIP_TAGS.has(tag)) return;
    if (opts.dropChrome && CHROME_TAGS.has(tag)) return;
    if (el.getAttribute("type") === "password") return;

    if (/^H[1-6]$/.test(tag)) {
      flush();
      line = "#".repeat(Number(tag[1])) + " ";
      el.childNodes.forEach((c) => walk(c, listDepth));
      flush();
      return;
    }
    if (tag === "PRE") {
      flush();
      out.push("```\n" + (el.textContent ?? "").replace(/\n+$/, "") + "\n```");
      return;
    }
    if (tag === "TABLE") {
      flush();
      // Same grid as table extraction, so text the model reads lines up with the columns.
      const rows = toGrid(ownRows(el), ownCells, 2000).grid;
      if (rows.length) out.push(rows.map((r) => "| " + r.join(" | ") + " |").join("\n"));
      return;
    }
    if (tag === "LI") {
      flush();
      line = "  ".repeat(Math.max(0, listDepth - 1)) + "- ";
      el.childNodes.forEach((c) => walk(c, listDepth));
      flush();
      return;
    }
    if (tag === "BR") {
      line += "\n";
      return;
    }
    if (tag === "IMG") {
      const alt = el.getAttribute("alt");
      if (alt) line += ` [image: ${alt}] `;
      return;
    }
    const isList = tag === "UL" || tag === "OL";
    const block = BLOCK.has(tag);
    if (block) flush();
    el.childNodes.forEach((c) => walk(c, isList ? listDepth + 1 : listDepth));
    if (block) flush();
  };
  walk(root, 0);
  flush();
  return out.join("\n\n");
}

/** Superscript note markers: [1], [a], [note 3], [citation needed]. */
const NOTE_MARK = /^\s*\[[^\[\]]{1,20}\]\s*$/;

/**
 * Cell text without footnote markers. "9,064,677[2]" must export as a number,
 * and "Region[1]" as a clean column name. Only superscripts that look like
 * markers are removed, so real superscript content (m², x²) is kept.
 */
function cellText(c: Element): string {
  let t = (c as HTMLElement).innerText ?? c.textContent ?? "";
  for (const sup of Array.from(c.querySelectorAll("sup"))) {
    const m = sup.textContent ?? "";
    if (!NOTE_MARK.test(m)) continue;
    const at = t.lastIndexOf(m.trim());
    if (at !== -1) t = t.slice(0, at) + t.slice(at + m.trim().length);
  }
  return clean(t).replace(/\n+/g, " ");
}

/** A table's own rows: not those of tables nested inside it. */
function ownRows(t: Element): Element[] {
  return Array.from(t.querySelectorAll("tr")).filter((tr) => tr.closest("table") === t);
}

function ownCells(tr: Element): Element[] {
  return Array.from(tr.children).filter((c) => c.tagName === "TD" || c.tagName === "TH");
}

function span(el: Element, attr: string, max: number): number {
  const n = parseInt(el.getAttribute(attr) ?? "1", 10);
  return Number.isFinite(n) && n > 1 ? Math.min(n, max) : 1;
}

/**
 * Lay rows out on a grid, honouring rowspan and colspan, so every row has a
 * value in the column it visually belongs to. Without this, a merged cell
 * shifts every later cell in the row one column to the left.
 */
function toGrid(rows: Element[], cellsOf: (r: Element) => Element[], maxRows: number): { grid: string[][]; header: boolean[] } {
  const grid: string[][] = [];
  const header: boolean[] = [];
  const carry = new Map<number, { text: string; left: number }>();
  for (const r of rows.slice(0, maxRows)) {
    const row: string[] = [];
    let col = 0;
    let allHeader = true;
    const fillCarried = () => {
      while (carry.has(col)) {
        const c = carry.get(col)!;
        row[col] = c.text;
        if (--c.left <= 0) carry.delete(col);
        col++;
      }
    };
    for (const cell of cellsOf(r)) {
      fillCarried();
      const isHead = cell.tagName === "TH" || cell.getAttribute("role") === "columnheader";
      if (!isHead) allHeader = false;
      const text = cellText(cell);
      const cs = span(cell, "colspan", 50);
      const rs = span(cell, "rowspan", 1000);
      for (let k = 0; k < cs; k++) {
        row[col] = text;
        if (rs > 1) carry.set(col, { text, left: rs - 1 });
        col++;
      }
    }
    // Columns still covered by rowspans from above, after this row's last cell.
    for (const [c, v] of [...carry.entries()].sort((a, b) => a[0] - b[0])) {
      if (c >= col && row[c] === undefined) {
        row[c] = v.text;
        if (--v.left <= 0) carry.delete(c);
      }
    }
    if (!row.length) continue;
    grid.push(Array.from(row, (v) => v ?? ""));
    header.push(allHeader || r.parentElement?.tagName === "THEAD");
  }
  return { grid, header };
}

/**
 * Merge leading header rows into one, so a two-row header such as
 * "Population" over "2022 | 2023" becomes "Population 2022", "Population 2023".
 */
function mergeHeader(grid: string[][], header: boolean[]): { rows: string[][]; hasHeader: boolean } {
  let n = 0;
  while (n < header.length && header[n] && n < grid.length - 1) n++;
  if (n <= 1) return { rows: grid, hasHeader: n === 1 };
  const width = Math.max(...grid.map((r) => r.length));
  const merged = Array.from({ length: width }, (_, c) => {
    const parts: string[] = [];
    for (let i = 0; i < n; i++) {
      const v = grid[i][c] ?? "";
      if (v && parts[parts.length - 1] !== v) parts.push(v);
    }
    return parts.join(" ");
  });
  return { rows: [merged, ...grid.slice(n)], hasHeader: true };
}

function captionFor(t: Element, fallback: string): string {
  let caption = clean(t.querySelector("caption")?.textContent ?? t.getAttribute("aria-label") ?? "");
  if (!caption) {
    // Nearest preceding heading is usually the table's title.
    let p: Element | null = t;
    while (p && !caption) {
      let s = p.previousElementSibling;
      while (s && !caption) {
        if (/^H[1-6]$/.test(s.tagName)) caption = clean(s.textContent ?? "");
        else {
          const h = s.querySelectorAll("h1,h2,h3,h4,h5,h6");
          if (h.length) caption = clean(h[h.length - 1].textContent ?? "");
        }
        s = s.previousElementSibling;
      }
      p = p.parentElement;
    }
  }
  return caption.slice(0, 120) || fallback;
}

export interface TableScan {
  tables: PageTable[];
  /** Why candidate tables were not offered, so a miss can be diagnosed. */
  skipped: string[];
}

const MAX_TABLE_ROWS = 5000;

/**
 * Find data tables: real <table> elements and ARIA grids built from divs.
 * Layout tables are skipped by structure, and every skip records a reason.
 */
export function scanTables(doc: Document, limit = 50): TableScan {
  const tables: PageTable[] = [];
  const skipped: string[] = [];
  const add = (el: Element, grid: string[][], header: boolean[], kind: string) => {
    const label = captionFor(el, `Table ${tables.length + 1}`);
    const width = Math.max(0, ...grid.map((r) => r.length));
    if (grid.length < 2) return void skipped.push(`"${label}": fewer than 2 rows`);
    if (width < 2) return void skipped.push(`"${label}": only one column`);
    if (tables.length >= limit) return void skipped.push(`"${label}": over the ${limit}-table limit`);
    const { rows, hasHeader } = mergeHeader(grid, header);
    tables.push({ caption: label, hasHeader, rows, kind });
  };

  for (const t of Array.from(doc.querySelectorAll("table"))) {
    if (t.getAttribute("role") === "presentation" || t.getAttribute("role") === "none") continue;
    const rows = ownRows(t);
    // A layout table wraps other content, so most of its rows hold whole
    // tables. A data table may hold the odd small table (a legend, a note)
    // in a cell; that must not disqualify it.
    const nestedRows = rows.filter((r) => r.querySelector("table")).length;
    if (rows.length && nestedRows / rows.length > 0.5) {
      skipped.push(`"${captionFor(t, "table")}": looks like page layout (rows contain tables)`);
      continue;
    }
    const { grid, header } = toGrid(rows, ownCells, MAX_TABLE_ROWS);
    add(t, grid, header, "table");
  }

  const ARIA = "[role=table],[role=grid],[role=treegrid]";
  for (const g of Array.from(doc.querySelectorAll(ARIA))) {
    if (g.tagName === "TABLE") continue;
    const rows = Array.from(g.querySelectorAll("[role=row]")).filter((r) => r.closest(ARIA) === g);
    const cellsOf = (r: Element) =>
      Array.from(r.querySelectorAll("[role=cell],[role=gridcell],[role=columnheader],[role=rowheader]")).filter(
        (c) => c.closest("[role=row]") === r,
      );
    const { grid, header } = toGrid(rows, cellsOf, MAX_TABLE_ROWS);
    add(g, grid, header, "grid");
  }
  return { tables, skipped: skipped.slice(0, 20) };
}

/** Data tables only. Kept for callers that do not need skip reasons. */
export function collectTables(doc: Document, limit = 50): PageTable[] {
  return scanTables(doc, limit).tables;
}

function isVisible(el: Element): boolean {
  const anyEl = el as any;
  if (typeof anyEl.checkVisibility === "function") {
    return anyEl.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  }
  return true; // detached or very old engines: cannot tell, keep it
}

/**
 * Clone the document without the elements a reader cannot see. Hidden text is
 * a common carrier for prompt injection, and CIU should read what the user
 * reads. The clone has the same element order as the live tree, so the two
 * can be walked in parallel.
 */
function visibleClone(doc: Document): { clone: Document; skipped: number } {
  const clone = doc.cloneNode(true) as Document;
  const live = doc.body ? Array.from(doc.body.querySelectorAll("*")) : [];
  const copy = clone.body ? Array.from(clone.body.querySelectorAll("*")) : [];
  let skipped = 0;
  if (live.length === copy.length) {
    const doomed: Element[] = [];
    for (let i = 0; i < live.length; i++) {
      if (SKIP_TAGS.has(live[i].tagName.toUpperCase())) continue;
      if (!isVisible(live[i])) doomed.push(copy[i]);
    }
    for (const el of doomed) {
      if (el.isConnected) {
        el.remove();
        skipped++;
      }
    }
  }
  return { clone, skipped };
}

function selectionWithContext(win: Window): { selection: string; context: string } {
  const sel = win.getSelection();
  const selection = clean(sel?.toString() ?? "");
  if (!selection || !sel?.rangeCount) return { selection, context: "" };
  let node: Node | null = sel.getRangeAt(0).commonAncestorContainer;
  if (node.nodeType === 3) node = node.parentNode;
  let el = node as Element | null;
  // Climb until the surrounding block has a useful amount of text around the selection.
  while (el && el.parentElement && clean(el.textContent ?? "").length < selection.length + 400) {
    el = el.parentElement;
  }
  const context = el ? clean((el as HTMLElement).innerText ?? el.textContent ?? "").slice(0, 3000) : "";
  return { selection, context: context === selection ? "" : context };
}

export function extractPage(doc: Document, win: Window, maxChars = 400_000): PageSnapshot {
  const { clone, skipped } = visibleClone(doc);
  const bodyText = domToText(clone.body ?? clone.documentElement, { dropChrome: false });

  let text = "";
  let method: PageSnapshot["method"] = "dom";
  try {
    const art = new Readability(clone.cloneNode(true) as Document, { charThreshold: 300 }).parse();
    if (art?.content) {
      // Parse into an inert document: nothing executes, nothing loads.
      const inert = doc.implementation.createHTMLDocument("");
      inert.body.innerHTML = art.content;
      const t = domToText(inert.body, { dropChrome: false });
      // Readability is tuned for articles. On docs, listings and apps it can
      // keep a sliver of the page; fall back when it kept under a third.
      if (t.length >= 500 && t.length >= bodyText.length * 0.33) {
        text = t;
        method = "readability";
      }
    }
  } catch {
    /* fall back below */
  }
  if (!text) {
    const main = clone.querySelector("main, [role=main], article") ?? clone.body;
    const mainText = main ? domToText(main, { dropChrome: true }) : "";
    text = mainText.length >= bodyText.length * 0.33 ? mainText : bodyText;
  }

  const fullLength = text.length;
  const truncated = fullLength > maxChars;
  if (truncated) text = text.slice(0, maxChars);

  const { selection, context } = selectionWithContext(win);
  return {
    title: clean(doc.title || "") || "(untitled page)",
    url: win.location.href,
    lang: doc.documentElement.lang || "",
    text,
    selection: selection.slice(0, 20_000),
    selectionContext: context,
    ...(({ tables, skipped }) => ({ tables, tableSkips: skipped }))(scanTables(doc)),
    truncated,
    fullLength,
    hiddenSkipped: skipped,
    method,
  };
}

// Entry point when injected as a file: expose one function on the isolated
// world's global, which a follow-up executeScript call invokes.
(globalThis as any).__ciuExtract = (maxChars?: number) => extractPage(document, window, maxChars);
