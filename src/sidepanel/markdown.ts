// Minimal Markdown to DOM. Model output is built with createElement and
// textContent only, never innerHTML, so nothing a page smuggles through the
// model can execute in the extension. Links are shown as text, not anchors:
// a URL the model wrote is not one the user should click blind.

export function renderMarkdown(src: string, into: HTMLElement): void {
  into.replaceChildren();
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let list: HTMLElement | null = null;
  let para: string[] = [];

  const endPara = () => {
    if (para.length) {
      const p = document.createElement("p");
      inline(para.join(" "), p);
      into.append(p);
      para = [];
    }
  };
  const endList = () => {
    list = null;
  };

  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```(\S*)/);
    if (fence) {
      endPara();
      endList();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i++; // closing fence (or end of a still-streaming block)
      const pre = document.createElement("pre");
      const c = document.createElement("code");
      c.textContent = code.join("\n");
      pre.append(c);
      into.append(pre);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      endPara();
      endList();
      const el = document.createElement(`h${Math.min(6, h[1].length + 2)}`);
      inline(h[2], el);
      into.append(el);
      i++;
      continue;
    }
    const li = line.match(/^\s*(?:[-*+•]|(\d+)[.)])\s+(.*)$/);
    if (li) {
      endPara();
      const ordered = !!li[1];
      const tag = ordered ? "OL" : "UL";
      if (!list || list.tagName !== tag) {
        list = document.createElement(tag.toLowerCase());
        into.append(list);
      }
      const item = document.createElement("li");
      inline(li[2], item);
      list.append(item);
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      endPara();
      endList();
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const cells = lines[i].trim().slice(1, -1).split("|").map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      into.append(tableEl(rows));
      continue;
    }
    if (!line.trim()) {
      endPara();
      endList();
      i++;
      continue;
    }
    endList();
    para.push(line.trim());
    i++;
  }
  endPara();
}

function tableEl(rows: string[][]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  const t = document.createElement("table");
  rows.forEach((r, ri) => {
    const tr = document.createElement("tr");
    for (const c of r) {
      const td = document.createElement(ri === 0 ? "th" : "td");
      inline(c, td);
      tr.append(td);
    }
    t.append(tr);
  });
  wrap.append(t);
  return wrap;
}

/** Bold, italic, inline code. Everything else is text. */
function inline(s: string, into: HTMLElement): void {
  const re = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*)/g;
  let last = 0;
  for (const m of s.matchAll(re)) {
    if (m.index! > last) into.append(s.slice(last, m.index));
    const tok = m[0];
    let el: HTMLElement;
    if (tok.startsWith("`")) {
      el = document.createElement("code");
      el.textContent = tok.slice(1, -1);
    } else if (tok.startsWith("**") || tok.startsWith("__")) {
      el = document.createElement("strong");
      el.textContent = tok.slice(2, -2);
    } else {
      el = document.createElement("em");
      el.textContent = tok.slice(1, -1);
    }
    into.append(el);
    last = m.index! + tok.length;
  }
  if (last < s.length) into.append(s.slice(last));
}
