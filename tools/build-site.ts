/**
 * Builds the static site served by GitHub Pages into `site/`:
 *
 *   site/
 *     index.html              landing page with one card per app
 *     validator/index.html    the validator app (data baked in)
 *
 * To add a tool: build its self-contained HTML, then add one entry to APPS.
 * The landing page and routing follow automatically.
 *
 *   pnpm build-site
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");

interface App {
  /** URL slug = site/<slug>/index.html */
  slug: string;
  /** Card title on the landing page. */
  title: string;
  /** One-line description on the card. */
  blurb: string;
  /** Emoji shown on the card. */
  icon: string;
  /**
   * Produces the app's self-contained HTML string. Each app owns its build;
   * this just collects the output.
   */
  build: () => string;
}

const APPS: App[] = [
  {
    slug: "validator",
    title: "Validator APY",
    blurb: "Set your self-stake, see your validator APY under Referendum 1909.",
    icon: "📊",
    build: () => {
      // Refresh embedded data + inject into the template, reusing the app's CLIs.
      execFileSync("pnpm", ["embed"], { cwd: ROOT, stdio: "inherit" });
      execFileSync("pnpm", ["exec", "tsx", "validator/cli/build-web.ts"], {
        cwd: ROOT,
        stdio: "inherit",
      });
      return readFileSync(
        join(ROOT, "validator", "web", "simulator.built.html"),
        "utf8",
      );
    },
  },
];

function landingPage(apps: App[]): string {
  const cards = apps
    .map(
      (a) => `      <a class="card" href="./${a.slug}/">
        <span class="icon">${a.icon}</span>
        <span class="title">${a.title}</span>
        <span class="blurb">${a.blurb}</span>
      </a>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Polkadot Staking Tools</title>
<style>
  :root {
    --ground: #0E1116; --panel: #161B22; --line: #283039;
    --text: #E6EDF3; --muted: #8B97A6; --faint: #5A6573; --accent: #E6007A;
    --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
    --sans: "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background:
      radial-gradient(1100px 520px at 85% -15%, rgba(230,0,122,0.08), transparent 60%), var(--ground);
    color: var(--text); font-family: var(--sans); -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 860px; margin: 0 auto; padding: clamp(40px, 9vw, 110px) clamp(16px, 4vw, 36px) 60px; }
  .brand { display: flex; align-items: center; gap: 11px; margin-bottom: 8px; }
  .brand .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 14px var(--accent); }
  h1 { font-family: var(--mono); font-size: clamp(22px, 3vw, 30px); font-weight: 600; letter-spacing: -0.02em; margin: 0; }
  .sub { color: var(--muted); font-size: 14px; margin: 6px 0 36px 21px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; }
  .card { display: flex; flex-direction: column; gap: 6px; background: var(--panel); border: 1px solid var(--line);
    border-radius: 16px; padding: 22px 22px 24px; text-decoration: none; color: inherit;
    transition: border-color 0.15s, transform 0.15s; }
  .card:hover { border-color: var(--accent); transform: translateY(-2px); }
  .card:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  .card .icon { font-size: 26px; }
  .card .title { font-family: var(--mono); font-size: 16px; font-weight: 600; }
  .card .blurb { font-size: 13px; color: var(--muted); line-height: 1.5; }
  footer { margin-top: 48px; font-size: 12px; color: var(--faint); }
  footer a { color: var(--muted); }
</style>
</head>
<body>
  <main class="wrap">
    <div class="brand"><span class="dot"></span><h1>Polkadot Staking Tools</h1></div>
    <p class="sub">Calculators and explorers for Polkadot staking-async.</p>
    <div class="grid">
${cards}
    </div>
    <footer>staking-async (DAP mode) · data is a point-in-time on-chain snapshot.</footer>
  </main>
</body>
</html>
`;
}

function main() {
  rmSync(SITE, { recursive: true, force: true });
  mkdirSync(SITE, { recursive: true });

  for (const app of APPS) {
    const html = app.build();
    const dir = join(SITE, app.slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), html, "utf8");
    console.log(`built site/${app.slug}/index.html (${html.length} bytes)`);
  }

  writeFileSync(join(SITE, "index.html"), landingPage(APPS), "utf8");
  // Jekyll-off so folders/files starting with _ (none now, but future-proof) ship.
  writeFileSync(join(SITE, ".nojekyll"), "", "utf8");
  console.log(`built site/index.html (landing, ${APPS.length} app(s))`);
}

main();
