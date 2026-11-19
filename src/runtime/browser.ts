import { readFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { assertRuntimeReady, type AuditConfig } from "../config.js";
import { progress } from "../progress.js";
import { collectPlan } from "./collect.js";
import type { Context, ResolvedTokens, SnapshotCell } from "../types.js";

const here = dirname(fileURLToPath(import.meta.url));
export const PROBE_PATH = join(here, "browser", "probe.js");
export const PROBE_SCRIPT = readFileSync(PROBE_PATH, "utf8");

/** Properties the C3 check reads. */
export const PROBE_PROPS = [
  "color",
  "background-color",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "gap",
  "row-gap",
  "column-gap",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-right-radius",
  "border-bottom-left-radius",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "display",
  "position",
  "z-index",
  "overflow-x",
  "overflow-y",
  "text-overflow",
  "white-space",
  "-webkit-line-clamp",
  "box-shadow",
  "opacity",
  "letter-spacing",
  "flex-direction",
  "align-items",
  "justify-content",
];

async function ensureProbe(page: Page) {
  const has = await page.evaluate("typeof window.__designAuditor === 'object'");
  if (!has) await page.evaluate(PROBE_SCRIPT);
}

export async function resolveIn(page: Page, names: string[]): Promise<ResolvedTokens["tokens"]> {
  await ensureProbe(page);
  return page.evaluate(`window.__designAuditor.resolveTokens(${JSON.stringify(names)})`) as Promise<ResolvedTokens["tokens"]>;
}

function htmlAttrs(attrs: Record<string, string>): string {
  return Object.entries(attrs)
    .map(([k, v]) => `${k}="${v.replace(/"/g, "&quot;")}"`)
    .join(" ");
}

/**
 * Resolves the product's theme CSS in plain Chromium for every context.
 * Plain Chromium has no Opera env() values, so this yields the code's own fallbacks.
 */
export async function resolveCodeTokens(css: string, names: string[], contexts: Context[]): Promise<ResolvedTokens[]> {
  const browser = await chromium.launch();
  try {
    const out: ResolvedTokens[] = [];
    for (const ctx of contexts) {
      const page = await browser.newPage({ colorScheme: ctx.colorScheme });
      await page.setContent(
        `<!doctype html><html ${htmlAttrs(ctx.html)}><head><style>${css.replace(/<\/style/gi, "<\\/style")}</style></head><body></body></html>`,
      );
      out.push({ context: ctx.name, source: "code", browser: `chromium ${browser.version()}`, tokens: await resolveIn(page, names) });
      await page.close();
    }
    return out;
  } finally {
    await browser.close();
  }
}

type Action = NonNullable<AuditConfig["runtime"]["surfaces"][number]["states"][number]["actions"]>[number];

/** Script that, when run in a page, reports whether the deep active element matches a selector. */
const ACTIVE_MATCHES = (selector: string) =>
  `(() => { let a = document.activeElement; while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement; try { return !!(a && a.matches(${JSON.stringify(selector)})); } catch (e) { return false; } })()`;

/** Presses Tab until the element matching `selector` has focus (at most 40 times). */
export async function tabTo(page: Page, selector: string, nth = 0): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (await page.evaluate(ACTIVE_MATCHES(selector))) {
      if (nth === 0) return;
      nth--;
    }
    await page.keyboard.press("Tab");
  }
  throw new Error(`tabTo: ${selector} never got keyboard focus within 40 Tab presses`);
}

export async function runAction(page: Page, a: Action, warn: (m: string) => void = () => undefined) {
  const nth = a.nth ?? 0;
  if ("click" in a) await page.locator(a.click).nth(nth).click();
  else if ("hover" in a) await page.locator(a.hover).nth(nth).hover();
  else if ("press" in a) await page.keyboard.press(a.press);
  else if ("moveAway" in a) await page.mouse.move(1, 1);
  else if ("clickAway" in a) await page.mouse.click(1, 1);
  else if ("wait" in a) await page.waitForTimeout(a.wait);
  else if ("tabTo" in a) await tabTo(page, a.tabTo, nth);
  else if ("fill" in a) await page.locator(a.fill).nth(nth).fill(a.value);
  else if ("waitHidden" in a) await page.locator(a.waitHidden).nth(nth).waitFor({ state: "hidden" });
  else if ("clickIfVisible" in a) {
    const l = page.locator(a.clickIfVisible).nth(nth);
    if (await l.waitFor({ state: "visible", timeout: 1500 }).then(() => true, () => false)) await l.click();
  } else if ("reload" in a) await page.reload();
  else if ("scrollIntoView" in a)
    await page.locator(a.scrollIntoView).nth(nth).evaluate((el) => el.scrollIntoView({ block: "start", inline: "nearest", behavior: "instant" }));
  else if ("mock" in a) warn(`mock ${a.mock.endpoint} → ${a.mock.file} needs the harness driver (the product's mock server); ignored`);
}

/** Viewports to capture; the first is the default and leaves `viewport` unset on its cells. */
export function viewportsOf(cfg: AuditConfig): AuditConfig["runtime"]["viewports"] {
  return cfg.runtime.viewports.length ? cfg.runtime.viewports : [{ name: "default", width: 1280, height: 860 }];
}

/**
 * Browser zoom as Ctrl/Cmd + does it: the layout viewport shrinks to width/zoom CSS px and every CSS px is
 * drawn with `zoom` device pixels, so layout reflows exactly as for a user who zoomed in, while computed
 * styles stay in CSS px (comparable with Figma). Applied through CDP device-metrics emulation.
 */
export async function applyZoom(page: Page, vp: { width: number; height: number; zoom?: number }): Promise<void> {
  const zoom = vp.zoom ?? 1;
  const width = Math.round(vp.width / zoom);
  const height = Math.round(vp.height / zoom);
  await page.setViewportSize({ width, height });
  if (zoom === 1) return;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: zoom, mobile: false });
}

/**
 * Makes a page render in another UI language before its scripts run: navigator.language(s) and, for
 * browser extensions, chrome.i18n.getUILanguage(). Products that read the language elsewhere need their
 * harness to set it.
 */
export const LOCALE_INIT_SCRIPT = (locale: string) => `(() => {
  const l = ${JSON.stringify(locale)};
  try { Object.defineProperty(navigator, "language", { get: () => l, configurable: true }); } catch (e) {}
  try { Object.defineProperty(navigator, "languages", { get: () => [l], configurable: true }); } catch (e) {}
  try { if (globalThis.chrome && chrome.i18n) chrome.i18n.getUILanguage = () => l; } catch (e) {}
  try { document.documentElement && document.documentElement.setAttribute("lang", l); } catch (e) {}
})();`;

/** States a viewport variant applies to: every state for the first (default) variant, else its `states` list. */
export const variantApplies = (vp: { states?: string[] }, index: number, state: string) => index === 0 || !vp.states || vp.states.includes(state);

async function extensionWorker(context: BrowserContext) {
  let sw = context.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15_000 }).catch(() => undefined);
  return sw;
}

/** What a runtime.setup module receives. It runs once per browser launch, before any surface opens. */
export interface SetupArgs {
  context: BrowserContext;
  extensionId?: string;
  serviceWorker?: import("playwright-core").Worker;
  contextName: string;
  colorScheme: "light" | "dark";
}

/**
 * Opens every surface × state × context in the product browser and records resolved tokens and element styles.
 * With an executablePath (e.g. Opera Neon) this captures the values the real browser injects through env().
 */
export async function probeProduct(
  cfg: AuditConfig,
  tokenNames: string[],
  outDir: string,
): Promise<{ cells: SnapshotCell[]; browser: string; warnings: string[] }> {
  assertRuntimeReady(cfg);
  const rt = cfg.runtime;
  const userDataDir = mkdtempSync(join(tmpdir(), "design-auditor-"));
  const args = rt.extensionPath
    ? [`--disable-extensions-except=${rt.extensionPath}`, `--load-extension=${rt.extensionPath}`]
    : [];
  const warnings: string[] = [];
  const cells: SnapshotCell[] = [];
  let browserName = "chromium";
  mkdirSync(join(outDir, "shots"), { recursive: true });

  const viewports = viewportsOf(cfg);
  const plan = collectPlan(cfg);
  for (const ctx of cfg.contexts) {
    const context = await chromium.launchPersistentContext(userDataDir, {
      executablePath: rt.executablePath,
      headless: rt.headless,
      colorScheme: ctx.colorScheme,
      viewport: { width: viewports[0]!.width, height: viewports[0]!.height },
      args,
    });
    try {
      browserName = `${rt.executablePath ? rt.executablePath.split("/").pop() : "chromium"} ${context.browser()?.version() ?? ""}`.trim();
      const serviceWorker = rt.extensionPath ? await extensionWorker(context) : undefined;
      const extensionId = serviceWorker?.url().split("/")[2];
      if (rt.extensionPath && !extensionId) warnings.push("Extension service worker did not start; chrome-extension:// surfaces will fail");
      if (rt.setup) {
        const mod = (await import(pathToFileURL(rt.setup).href)) as { default?: (a: SetupArgs) => Promise<void> };
        if (typeof mod.default !== "function") throw new Error(`runtime.setup ${rt.setup} must export a default async function`);
        await mod.default({ context, extensionId, serviceWorker, contextName: ctx.name, colorScheme: ctx.colorScheme });
      }

      for (const surface of rt.surfaces) {
        const url = surface.url.replace("{extensionId}", extensionId ?? "missing-extension-id");
        for (const state of surface.states) for (const [vi, vp] of viewports.entries()) {
          if (!variantApplies(vp, vi, state.name)) continue;
          const viewport = vi === 0 ? undefined : vp.name;
          const where = `${surface.name}/${state.name}/${ctx.name}${viewport ? `@${viewport}` : ""}`;
          const attempts = (state.retries ?? 0) + 1;
          for (let attempt = 1; attempt <= attempts; attempt++) {
            const page = await context.newPage();
            page.setDefaultTimeout(rt.actionTimeoutMs);
            try {
              await applyZoom(page, vp);
              if (vp.locale) await page.addInitScript(LOCALE_INIT_SCRIPT(vp.locale));
              await page.goto(url, { waitUntil: "load" });
              if (rt.injectCss) await page.addStyleTag({ content: rt.injectCss });
              if (rt.forceContextAttributes) {
                await ensureProbe(page);
                await page.evaluate(`window.__designAuditor.applyHtml(${JSON.stringify(ctx.html)})`);
              }
              if (surface.waitFor) await page.waitForSelector(surface.waitFor);
              for (const a of state.actions ?? []) await runAction(page, a, (m) => warnings.push(`${where}: ${m}`));
              if (state.waitFor) await page.waitForSelector(state.waitFor);
              await page.waitForTimeout(150);
              await ensureProbe(page);
              if (rt.forceContextAttributes) await page.evaluate(`window.__designAuditor.applyHtml(${JSON.stringify(ctx.html)})`);
              const tokens = await resolveIn(page, tokenNames);
              const nodes = (await page.evaluate(
                `window.__designAuditor.collect(${JSON.stringify(plan.selector)}, ${JSON.stringify(PROBE_PROPS)}, ${JSON.stringify({ insideSvg: rt.includeSvgContent, match: plan.match })})`,
              )) as SnapshotCell["nodes"];
              const texts = (await page.evaluate(`window.__designAuditor.texts(${JSON.stringify({ insideSvg: rt.includeSvgContent })})`)) as SnapshotCell["texts"];
              const pageInfo = (await page.evaluate("window.__designAuditor.page()")) as SnapshotCell["page"];
              const targets = (await page.evaluate("window.__designAuditor.targets()")) as SnapshotCell["targets"];
              let screenshot: string | undefined;
              if (rt.screenshots) {
                screenshot = join("shots", `${surface.name}-${state.name}-${ctx.name}${viewport ? `-${viewport}` : ""}.png`.replace(/[^\w.-]+/g, "_"));
                // Animations off and unstable regions masked, so two runs of the same build give the same pixels.
                await page.screenshot({
                  path: join(outDir, screenshot),
                  fullPage: false,
                  animations: "disabled",
                  caret: "hide",
                  mask: (surface.mask ?? []).map((sel) => page.locator(sel)),
                });
              }
              // Measured after the screenshot: it blurs the focused element to see how it looks unfocused.
              const focus = (await page.evaluate("window.__designAuditor.focusState()")) as SnapshotCell["focus"];
              cells.push({
                surface: surface.name,
                state: state.name,
                context: ctx.name,
                ...(viewport ? { viewport } : {}),
                ...(vp.zoom ? { zoom: vp.zoom } : {}),
                ...(vp.locale ? { locale: vp.locale } : {}),
                url,
                browser: browserName,
                tokens,
                nodes,
                texts,
                targets,
                focus,
                page: pageInfo,
                screenshot,
              });
              progress(`  ✓ ${where} · ${(nodes as unknown[]).length} elements`);
              break;
            } catch (e) {
              if (attempt === attempts) {
                warnings.push(`${where}: ${(e as Error).message.split("\n")[0]}${attempts > 1 ? ` (after ${attempts} attempts)` : ""}`);
                progress(`  ✗ ${where}: ${(e as Error).message.split("\n")[0]}`);
              }
            } finally {
              await page.close();
            }
          }
        }
      }
    } finally {
      await context.close();
    }
  }
  rmSync(userDataDir, { recursive: true, force: true });
  return { cells, browser: browserName, warnings };
}
