/**
 * design-auditor capture spec: a template for the `harness` driver.
 *
 * Copy it into the product's own Playwright suite and replace the marked hooks with the product's
 * fixtures (login, mocked backend, feature flags). design-auditor runs it with three environment
 * variables and reads back one `<surface>__<state>__<context>[__<viewport>].cell.json` per captured state:
 *   DESIGN_AUDITOR_SPEC   capture spec written by design-auditor (states, actions, contexts, viewports)
 *   DESIGN_AUDITOR_PROBE  the probe script that measures the page (src/runtime/browser/probe.js)
 *   DESIGN_AUDITOR_OUT    folder for cells and screenshots
 * Without them the test is skipped, so it never runs in normal test runs.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type BrowserContext, type CDPSession, type Page } from "@playwright/test";

type Action = {
  click?: string;
  hover?: string;
  press?: string;
  wait?: number;
  nth?: number;
  moveAway?: boolean;
  clickAway?: boolean;
  tabTo?: string;
  fill?: string;
  value?: string;
  waitHidden?: string;
  reload?: boolean;
};
type Variant = { name: string; width: number; height: number; zoom?: number; locale?: string; states?: string[] };
interface CaptureSpec {
  surface?: string;
  ready?: string;
  flagSteps?: Record<string, boolean>[];
  injectCss?: string;
  actionTimeoutMs?: number;
  routes?: { url: string; json: unknown }[];
  tokens: string[];
  props: string[];
  selector: string;
  match?: Record<string, string>;
  insideSvg?: boolean;
  viewports?: Variant[];
  contexts: { name: string; colorScheme: "light" | "dark" }[];
  states: { name: string; actions?: Action[]; waitFor?: string; cleanup?: Action[]; retries?: number }[];
}

const OUT = process.env.DESIGN_AUDITOR_OUT;
const PROBE = process.env.DESIGN_AUDITOR_PROBE;
const SPEC = process.env.DESIGN_AUDITOR_SPEC;
const LOCALE_KEY = "__designAuditorLocale";

// ---- Product hooks: replace these with the product's own fixtures. --------------------------------
/** Open the surface to audit, logged in, with the product's mocks in place. */
async function openSurface(page: Page): Promise<void> {
  await page.goto(process.env.PRODUCT_URL ?? "http://localhost:3000/");
}
/** Apply remote-config or feature flags (one step of spec.flagSteps). */
async function applyFlags(_context: BrowserContext, _flags: Record<string, boolean>): Promise<void> {
  // e.g. await enableFlags(context, flags);
}
// ----------------------------------------------------------------------------------------------------

async function tabTo(page: Page, selector: string, nth: number): Promise<void> {
  const isActive = () =>
    page.evaluate((sel) => {
      let a = document.activeElement;
      while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
      try {
        return !!(a && a.matches(sel));
      } catch {
        return false;
      }
    }, selector);
  for (let i = 0; i < 40; i++) {
    if (await isActive()) {
      if (nth === 0) return;
      nth--;
    }
    await page.keyboard.press("Tab");
  }
  throw new Error(`tabTo: ${selector} never got keyboard focus within 40 Tab presses`);
}

async function act(page: Page, a: Action, timeout: number, spec: CaptureSpec): Promise<void> {
  const nth = a.nth ?? 0;
  if (a.reload) {
    await page.reload();
    if (spec.ready) await page.waitForSelector(spec.ready, { timeout: 30_000 });
    if (spec.injectCss) await page.addStyleTag({ content: spec.injectCss });
  }
  if (a.click) await page.locator(a.click).nth(nth).click({ timeout });
  if (a.hover) await page.locator(a.hover).nth(nth).hover({ timeout });
  if (a.press) await page.keyboard.press(a.press);
  if (a.moveAway) await page.mouse.move(1, 1);
  if (a.clickAway) await page.mouse.click(1, 1);
  if (a.wait) await page.waitForTimeout(a.wait);
  if (a.tabTo) await tabTo(page, a.tabTo, nth);
  if (a.fill) await page.locator(a.fill).nth(nth).fill(a.value ?? "", { timeout });
  if (a.waitHidden) await page.locator(a.waitHidden).nth(nth).waitFor({ state: "hidden", timeout: Math.max(timeout, 30_000) });
}

test.describe("design-auditor capture", () => {
  test.skip(!OUT || !PROBE || !SPEC, "Runs only from design-auditor (DESIGN_AUDITOR_* not set)");

  test("capture states for design-auditor", async ({ page, context, browser }) => {
    const spec = JSON.parse(readFileSync(SPEC!, "utf8")) as CaptureSpec;
    const timeout = spec.actionTimeoutMs ?? 10_000;
    const variants: (Variant | undefined)[] = spec.viewports?.length ? spec.viewports : [undefined];
    const applies = (v: Variant | undefined, i: number, state: string) => i === 0 || !v?.states || v.states.includes(state);
    const cells = spec.contexts.length * variants.reduce((n, v, i) => n + spec.states.filter((s) => applies(v, i, s.name)).length, 0);
    test.setTimeout(120_000 + cells * (timeout * 2 + 8_000));
    const probe = readFileSync(PROBE!, "utf8");

    for (const r of spec.routes ?? []) await context.route(r.url, (route) => route.fulfill({ json: r.json }));
    // A language variant stores the language and reloads; this runs before the app on every load.
    await page.addInitScript((key) => {
      try {
        const l = sessionStorage.getItem(key);
        if (!l) return;
        Object.defineProperty(navigator, "language", { get: () => l, configurable: true });
        Object.defineProperty(navigator, "languages", { get: () => [l], configurable: true });
      } catch {
        /* storage unavailable */
      }
    }, LOCALE_KEY);
    await openSurface(page);
    for (const flags of spec.flagSteps ?? []) await applyFlags(context, flags);
    if (spec.injectCss) await page.addStyleTag({ content: spec.injectCss });
    const browserName = `${browser.browserType().name()} ${browser.version()}`;
    const surface = spec.surface ?? "page";
    mkdirSync(join(OUT!, "shots"), { recursive: true });

    let locale: string | undefined;
    const setLocale = async (next: string | undefined) => {
      if (next === locale) return;
      await page.evaluate(([key, l]) => (l ? sessionStorage.setItem(key, l) : sessionStorage.removeItem(key)), [LOCALE_KEY, next ?? ""] as const);
      await page.reload();
      if (spec.ready) await page.waitForSelector(spec.ready, { timeout: 30_000 });
      if (spec.injectCss) await page.addStyleTag({ content: spec.injectCss });
      locale = next;
    };
    let zoomSession: CDPSession | undefined;
    const setVariant = async (v: Variant | undefined) => {
      if (zoomSession) {
        await zoomSession.send("Emulation.clearDeviceMetricsOverride").catch(() => undefined);
        await zoomSession.detach().catch(() => undefined);
        zoomSession = undefined;
      }
      if (!v) return;
      const zoom = v.zoom ?? 1;
      const width = Math.round(v.width / zoom);
      const height = Math.round(v.height / zoom);
      await page.setViewportSize({ width, height });
      if (zoom !== 1) {
        // Browser zoom: the layout viewport shrinks to width/zoom CSS px and each CSS px is drawn larger.
        zoomSession = await context.newCDPSession(page);
        await zoomSession.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: zoom, mobile: false });
      }
    };

    const capture = async (state: CaptureSpec["states"][number], key: string, ctx: string, viewport: string | undefined, v: Variant | undefined) => {
      await page.keyboard.press("Escape");
      await page.mouse.move(1, 1);
      await page.waitForTimeout(200);
      for (const a of state.actions ?? []) await act(page, a, timeout, spec);
      if (state.waitFor) await page.waitForSelector(state.waitFor, { timeout: Math.max(timeout, 45_000) });
      await page.waitForTimeout(300);
      if (!(await page.evaluate("typeof window.__designAuditor === 'object'"))) await page.evaluate(probe);
      const tokens = await page.evaluate(`window.__designAuditor.resolveTokens(${JSON.stringify(spec.tokens)})`);
      const nodes = await page.evaluate(
        `window.__designAuditor.collect(${JSON.stringify(spec.selector)}, ${JSON.stringify(spec.props)}, ${JSON.stringify({ insideSvg: Boolean(spec.insideSvg), match: spec.match ?? {} })})`,
      );
      const texts = await page.evaluate(`window.__designAuditor.texts(${JSON.stringify({ insideSvg: Boolean(spec.insideSvg) })})`);
      const targets = await page.evaluate("window.__designAuditor.targets()");
      const pageInfo = await page.evaluate("window.__designAuditor.page()");
      const screenshot = `shots/${key}.png`;
      await page.screenshot({ path: join(OUT!, screenshot), animations: "disabled", caret: "hide" });
      const focus = await page.evaluate("window.__designAuditor.focusState()"); // after the screenshot: it blurs
      writeFileSync(
        join(OUT!, `${key}.cell.json`),
        JSON.stringify({
          surface,
          state: state.name,
          context: ctx,
          ...(viewport ? { viewport } : {}),
          ...(v?.zoom && v.zoom !== 1 ? { zoom: v.zoom } : {}),
          ...(v?.locale ? { locale: v.locale } : {}),
          url: page.url(),
          browser: browserName,
          tokens,
          nodes,
          texts,
          targets,
          focus,
          page: pageInfo,
          screenshot,
        }),
      );
    };

    for (const ctx of spec.contexts) {
      await page.emulateMedia({ colorScheme: ctx.colorScheme });
      for (const [vi, v] of variants.entries()) {
        const states = spec.states.filter((s) => applies(v, vi, s.name));
        if (!states.length) continue;
        await setLocale(v?.locale);
        await setVariant(v);
        const viewport = vi > 0 && v ? v.name : undefined;
        for (const state of states) {
          const key = `${surface}__${state.name}__${ctx.name}${viewport ? `__${viewport}` : ""}`.replace(/[^\w.-]+/g, "_");
          const attempts = (state.retries ?? 0) + 1;
          for (let attempt = 1; attempt <= attempts; attempt++) {
            try {
              await capture(state, key, ctx.name, viewport, v);
              break;
            } catch (error) {
              if (attempt < attempts) continue;
              writeFileSync(join(OUT!, `${key}.error.txt`), error instanceof Error ? error.message.split("\n")[0]! : String(error));
            }
          }
          for (const a of state.cleanup ?? []) await act(page, a, timeout, spec).catch(() => undefined);
        }
      }
      await setVariant(variants[0]);
    }
    await setLocale(undefined);
  });
});
