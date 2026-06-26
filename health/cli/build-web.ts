/**
 * Builds the self-contained era-health HTML by inlining the embedded data
 * (health/web/data.json) into the template's `__DATA__` placeholder.
 *
 *   pnpm tsx health/cli/build-web.ts   # -> health/web/health.built.html
 *
 * Run `pnpm tsx health/cli/embed.ts > health/web/data.json` first (or use the
 * `build-health` script which chains both).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..", "web");

const tpl = readFileSync(join(web, "health.html"), "utf8");
const data = readFileSync(join(web, "data.json"), "utf8");
const dataMin = JSON.stringify(JSON.parse(data));
const lib = readFileSync(join(web, "lib.js"), "utf8");

for (const marker of ["__DATA__", "// __LIB__"]) {
  if (!tpl.includes(marker)) throw new Error(`template missing ${marker} placeholder`);
}

const out = tpl.replace("__DATA__", () => dataMin).replace("// __LIB__", () => lib);

const dest = join(web, "health.built.html");
writeFileSync(dest, out, "utf8");
console.log(`Built ${dest} (${out.length} bytes)`);
