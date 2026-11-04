// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { collectTables, domToText, extractPage, scanTables } from "../src/content/extract";

function load(html: string) {
  // innerHTML never runs scripts, which is what we want for fixtures.
  const doc = new DOMParser().parseFromString(html, "text/html");
  document.documentElement.replaceWith(document.adoptNode(doc.documentElement));
}

describe("page extraction", () => {
  it("keeps structure and drops scripts, forms and passwords", () => {
    load(`<html><head><title>T</title></head><body><main>
      <h2>Heading</h2><p>Para <b>one</b>.</p><ul><li>a</li><li>b</li></ul>
      <pre>code()</pre><script>evil()</script>
      <form><input type="password" value="hunter2"><textarea>secret draft</textarea></form>
    </main></body></html>`);
    const t = domToText(document.body, { dropChrome: true });
    expect(t).toContain("## Heading");
    expect(t).toContain("- a");
    expect(t).toContain("```\ncode()\n```");
    expect(t).not.toMatch(/evil|hunter2|secret draft/);
  });
  it("collects data tables and skips layout tables", () => {
    load(`<body><h3>Prices</h3><table><thead><tr><th>Item</th><th>Cost</th></tr></thead>
      <tr><td>Tea</td><td>£2</td></tr></table>
      <table><tr><td>only one column</td></tr><tr><td>x</td></tr></table></body>`);
    const tables = collectTables(document);
    expect(tables).toHaveLength(1);
    expect(tables[0]).toMatchObject({ caption: "Prices", hasHeader: true, rows: [["Item", "Cost"], ["Tea", "£2"]] });
  });
  it("produces a full snapshot and truncates explicitly", () => {
    load(`<html lang="en"><head><title>  Article  </title></head><body><nav>menu menu</nav><article><h1>Big</h1>${"<p>Sentence about things. </p>".repeat(200)}</article></body></html>`);
    const s = extractPage(document, window, 1000);
    expect(s.title).toBe("Article");
    expect(s.lang).toBe("en");
    expect(s.truncated).toBe(true);
    expect(s.text.length).toBe(1000);
    expect(s.fullLength).toBeGreaterThan(1000);
  });
});

describe("table detection", () => {
  it("keeps a data table that holds a small nested table, and skips layout wrappers", () => {
    load(`<body>
      <table id="layout"><tr><td><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table></td></tr></table>
      <h2>Population</h2>
      <table class="wikitable"><thead><tr><th>Country</th><th>Population</th></tr></thead>
        <tr><td>Austria</td><td>9,130,429</td></tr>
        <tr><td>Belize <table><tr><td>legend</td><td>x</td></tr></table></td><td>411,106</td></tr>
        <tr><td>Bhutan</td><td>786,385</td></tr></table></body>`);
    const { tables, skipped } = scanTables(document);
    const pop = tables.find((t) => t.caption === "Population");
    expect(pop?.rows.length).toBe(4);
    expect(pop?.rows[3]).toEqual(["Bhutan", "786,385"]);
    expect(skipped.some((r) => /layout/.test(r))).toBe(true);
  });
  it("aligns rowspan and colspan cells and merges two-row headers", () => {
    load(`<body><table>
      <thead><tr><th rowspan="2">Country</th><th colspan="2">Population</th></tr><tr><th>2022</th><th>2023</th></tr></thead>
      <tr><td rowspan="2">Region A</td><td>1</td><td>2</td></tr>
      <tr><td>3</td><td>4</td></tr></table></body>`);
    const [t] = collectTables(document);
    expect(t.rows[0]).toEqual(["Country", "Population 2022", "Population 2023"]);
    expect(t.rows[2]).toEqual(["Region A", "3", "4"]);
  });
  it("reads div-based ARIA grids", () => {
    load(`<body><div role="table" aria-label="Prices">
      <div role="row"><span role="columnheader">Item</span><span role="columnheader">Cost</span></div>
      <div role="row"><span role="cell">Tea</span><span role="cell">£2</span></div>
      <div role="row"><span role="cell">Cake</span><span role="cell">£3</span></div></div></body>`);
    const [t] = collectTables(document);
    expect(t).toMatchObject({ caption: "Prices", hasHeader: true, kind: "grid" });
    expect(t.rows).toEqual([["Item", "Cost"], ["Tea", "£2"], ["Cake", "£3"]]);
  });
});

describe("footnote markers", () => {
  it("strips citation markers from headers and values but keeps real superscripts", () => {
    load(`<body><table><tr><th>UN region<sup>[1]</sup></th><th>Population</th><th>Area (km<sup>2</sup>)</th></tr>
      <tr><td>Europe</td><td>9,064,677<sup class="reference"><a>[2]</a></sup></td><td>83,871<sup>[note 3]</sup></td></tr></table></body>`);
    const [t] = collectTables(document);
    expect(t.rows[0]).toEqual(["UN region", "Population", "Area (km2)"]);
    expect(t.rows[1]).toEqual(["Europe", "9,064,677", "83,871"]);
  });
});
