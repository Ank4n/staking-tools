/**
 * Builds the self-contained Balances HTML: inlines the embedded data
 * (balances/web/data.json), the esbuild-bundled live papi client (live.ts →
 * window.Live), and the UI (lib.js) into the template's placeholders.
 *
 *   pnpm tsx balances/cli/build-web.ts   # -> balances/web/balances.built.html
 *
 * Run `pnpm tsx balances/cli/embed.ts > balances/web/data.json` first (or use
 * the `build-balances` script which chains both).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..", "web");

const tpl = readFileSync(join(web, "balances.html"), "utf8");
const data = readFileSync(join(web, "data.json"), "utf8");
const dataMin = JSON.stringify(JSON.parse(data));
const lib = readFileSync(join(web, "lib.js"), "utf8");

// Bundle the live client for the browser. es2020 minimum: papi uses BigInt.
const result = buildSync({
  entryPoints: [join(web, "live.ts")],
  bundle: true,
  format: "iife",
  globalName: "Live",
  platform: "browser",
  target: "es2020",
  minify: true,
  write: false,
  logLevel: "warning",
});
// The bundle is inlined into a <script> tag: a literal "</script" inside a
// string would end the tag early.
const bundle = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");

for (const marker of ["__DATA__", "// __BUNDLE__", "// __LIB__"]) {
  if (!tpl.includes(marker)) throw new Error(`template missing ${marker} placeholder`);
}

// Function replacers: the payloads contain `$` sequences that string
// replacement would treat as substitution patterns.
const out = tpl
  .replace("__DATA__", () => dataMin)
  .replace("// __BUNDLE__", () => bundle)
  .replace("// __LIB__", () => lib);

const dest = join(web, "balances.built.html");
writeFileSync(dest, out, "utf8");
console.log(`Built ${dest} (${out.length} bytes)`);
