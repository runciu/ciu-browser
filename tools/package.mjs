// Builds the release zips from dist/:
//   release/ciu-browser.zip           stable name, for the "latest" download link
//   release/ciu-browser-<version>.zip versioned copy, for people who need an exact build
// Both unpack to a single ciu-browser/ folder, ready for "Load unpacked".
//   release/ciu-browser-webstore.zip  for the Chrome Web Store, which needs
//                                     manifest.json at the top of the zip
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const { version } = JSON.parse(readFileSync(join(root, "dist", "manifest.json"), "utf8"));
const pkgVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
if (version !== pkgVersion) throw new Error(`manifest version ${version} != package.json ${pkgVersion}`);

const stage = join(root, ".release");
const out = join(root, "release");
rmSync(stage, { recursive: true, force: true });
rmSync(out, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, "dist"), join(stage, "ciu-browser"), { recursive: true });
copyFileSync(join(root, "LICENSE"), join(stage, "ciu-browser", "LICENSE"));

execFileSync("zip", ["-qrX", join(out, "ciu-browser.zip"), "ciu-browser"], { cwd: stage });
copyFileSync(join(out, "ciu-browser.zip"), join(out, `ciu-browser-${version}.zip`));
execFileSync("zip", ["-qrX", join(out, "ciu-browser-webstore.zip"), "."], { cwd: join(stage, "ciu-browser") });
rmSync(stage, { recursive: true, force: true });
console.log(`release/ciu-browser.zip, release/ciu-browser-${version}.zip and release/ciu-browser-webstore.zip (v${version})`);
