// Bundles the extension into dist/. `node build.mjs --watch` rebuilds on save.
import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const watch = process.argv.includes("--watch");
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
cpSync("static", "dist", { recursive: true });

const common = { bundle: true, target: "chrome116", sourcemap: watch ? "inline" : false, minify: !watch, logLevel: "info", legalComments: "none" };
const builds = [
  { ...common, entryPoints: { background: "src/background.ts" }, format: "esm", outdir: "dist" },
  { ...common, entryPoints: { sidepanel: "src/sidepanel/main.ts", options: "src/options/main.ts" }, format: "esm", outdir: "dist" },
  // Injected into pages as a classic script, so an IIFE.
  { ...common, entryPoints: { extract: "src/content/extract.ts" }, format: "iife", outdir: "dist" },
];
if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
