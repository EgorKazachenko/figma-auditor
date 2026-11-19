// Stands in for `npx playwright test <spec>`: reads the capture spec like the real harness spec does
// and writes one cell per state and context, plus an error file for a state named "broken".
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = process.env.DESIGN_AUDITOR_OUT;
const spec = JSON.parse(readFileSync(process.env.DESIGN_AUDITOR_SPEC, "utf8"));
const probeLoaded = readFileSync(process.env.DESIGN_AUDITOR_PROBE, "utf8").includes("__designAuditor");
if (process.argv[2] !== "the-spec.test.ts") { console.error(`unexpected spec ${process.argv[2]}`); process.exit(3); }
if (process.env.FAKE_HARNESS_FAIL) { console.error("browser crashed"); process.exit(1); }
mkdirSync(join(out, "shots"), { recursive: true });
const viewports = spec.viewports.length ? spec.viewports : [undefined];
for (const ctx of spec.contexts) for (const [vi, vp] of viewports.entries()) {
  const viewport = vi > 0 ? vp.name : undefined;
  for (const state of spec.states) {
    const key = `${spec.surface}__${state.name}__${ctx.name}${viewport ? `__${viewport}` : ""}`;
    if (state.name === "broken") { writeFileSync(join(out, `${key}.error.txt`), "locator.click: Timeout 10000ms exceeded.\nCall log: ..."); continue; }
    writeFileSync(join(out, `shots/${key}.png`), "");
    const chip = {
      component: null, testId: "chip", path: 'div[data-testid="chip"]', box: { x: 0, y: 0, width: 100, height: 33 }, hasText: true, text: "Opera AI",
      css: { "background-color": ctx.colorScheme === "dark" ? "rgb(255, 0, 0)" : "rgba(0, 0, 0, 0)", "border-top-left-radius": "8px", color: "rgb(23, 26, 28)", "font-size": "14px", "font-weight": "400", "font-family": "system-ui" },
      layout: { id: 0, ancestors: [], interactive: true, overlay: false, role: null, scroll: { w: 0, h: 0, cw: 0, ch: 0 }, visibleFraction: 1, textRects: [], occlusion: { samples: 5, covered: 0, centerCovered: false, by: [], overlayOnly: false }, insets: null, childGaps: [] },
    };
    writeFileSync(join(out, `${key}.cell.json`), JSON.stringify({
      surface: spec.surface, state: state.name, context: ctx.name, ...(viewport ? { viewport } : {}), url: "chrome-extension://x/aria.html", browser: `Fake Neon ${probeLoaded ? "probe" : "noprobe"}`,
      texts: [{ path: "span", anchor: '[data-testid="chip"]', text: "Opera AI", box: { x: 0, y: 0, width: 50, height: 17 }, fontSize: 14, fontWeight: 400, fg: "#9ca3ab", bg: "#ffffff", bgUnknown: null, disabled: false, viewFraction: 1 }],
      tokens: Object.fromEntries(spec.tokens.map((t) => [t, { raw: "", color: null }])), nodes: [chip], page: { scrollWidth: 600, innerWidth: 600, scrollHeight: 900, innerHeight: 900 }, screenshot: `shots/${key}.png`,
      flags: spec.flagSteps, routes: spec.routes.length, timeout: spec.actionTimeoutMs, env: process.env.FAKE_ENV ?? null,
    }));
  }
}
console.log("1 passed");
