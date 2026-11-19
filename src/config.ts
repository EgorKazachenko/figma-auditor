import { readFileSync } from "node:fs";
import { dirname, resolve, isAbsolute } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Context, Severity } from "./types.js";
import type { ComponentSpec } from "./checks/c4Spec.js";
import { C7_PROPERTIES, type ComponentMapping, type C7Property } from "./checks/c7FigmaStates.js";

/**
 * `nth` picks a match of the selector (0-based); `moveAway` parks the pointer and `clickAway` clicks in the
 * top-left corner. `tabTo` presses Tab until that element has keyboard focus; `fill` types `value` into a
 * field; `waitHidden` waits until an element is gone; `clickIfVisible` clicks only when the element shows up
 * within a moment (consent dialogs); `mock` selects a mock-server scenario for an endpoint (harness driver);
 * `reload` reloads the page and waits for the surface's `waitFor` (a clean start for conversation states);
 * `scrollIntoView` scrolls an element to the top of its scroll container, so scrolled content is captured
 * at the same position every run.
 */
export type StateAction = (
  | { click: string }
  | { hover: string }
  | { wait: number }
  | { press: string }
  | { moveAway: true }
  | { clickAway: true }
  | { tabTo: string }
  | { fill: string; value: string }
  | { waitHidden: string }
  | { clickIfVisible: string }
  | { mock: { endpoint: string; file: string } }
  | { reload: true }
  | { scrollIntoView: string }
) & { nth?: number };

/**
 * One rendering of the page: a size, optionally a browser zoom (1.5 = 150%: the layout viewport shrinks to
 * width/zoom CSS px and pixels scale up, as with Ctrl/Cmd +) and a UI language. The first variant is the
 * default and applies to every state; others can be limited to some states to keep runs short.
 */
export interface ViewportVariant {
  name: string;
  width: number;
  height: number;
  zoom?: number;
  locale?: string;
  states?: string[];
}

export interface SurfaceState {
  name: string;
  actions?: StateAction[];
  /** Run after the capture to leave the page as the next state expects it (e.g. close a menu without Escape). */
  cleanup?: StateAction[];
  waitFor?: string;
  /** Run the state again this many times when it fails (states that wait on a network round trip). */
  retries?: number;
}

export interface Surface {
  name: string;
  /** Page to open with the launch driver; the harness driver opens its own page. */
  url: string;
  waitFor?: string;
  /** Elements painted over in screenshots: clocks, avatars, autoplaying carousels. */
  mask?: string[];
  states: SurfaceState[];
}

export interface ReferenceSource {
  /** figma-variable-defs: Figma MCP capture of one node; figma-rest-variables: Figma REST (Enterprise); dtcg: W3C design tokens JSON. */
  type: "figma-variable-defs" | "figma-rest-variables" | "dtcg" | "figma-rest";
  /** figma-rest: product and library files whose variables form one graph (aliases cross files). */
  files?: string[];
  /** figma-rest: per Figma mode of the contexts, which mode each collection uses (collection → mode names). */
  modes?: Record<string, Record<string, string | string[]>>;
  /** figma-rest: where downloaded files are cached by version (default .design-auditor/figma-cache). */
  cacheDir?: string;
  /** figma-rest: keep / drop variables by code name (globs such as "--color-*", "--gx-*"). */
  include?: string[];
  exclude?: string[];
  /** dtcg: the mode this file holds (one file per mode), how token paths become code names, rem size. */
  mode?: string;
  nameTemplate?: string;
  separator?: string;
  remPx?: number;
  path?: string;
  fileKey?: string;
  modeMap?: Record<string, string>;
}

export interface AuditConfig {
  project: string;
  configPath: string;
  target: {
    repo: string;
    themeEntry: string;
    tailwindConfig?: string;
    scan: { include: string[]; extensions: string[]; exclude: string[]; knownVarPrefixes: string[]; hexExtensions: string[] };
  };
  contexts: Context[];
  reference: {
    sources: ReferenceSource[];
    aliases: Record<string, string>;
    /** Figma component sets with their variants, captured by scripts/figma-extract-components.js (C7). */
    components: string[];
    /** Component sets pulled from Figma REST by name into `out` (then listed in `components`). */
    componentSources: { file: string; sets: string[]; out: string }[];
    /** Cache for Figma REST downloads. */
    figmaCacheDir: string;
    /** Name prefixes of reference tokens that form the spacing and radius scales. */
    scalePrefixes: { spacing: string[]; radius: string[] };
  };
  /** Which product element shows each Figma component, and which captured state shows each variant (C7). */
  figmaComponents: ComponentMapping[];
  scales: { spacing: number[]; spacingFromTailwind?: string; radius: number[] };
  thresholds: {
    colorDeltaE: number;
    px: number;
    maxCheckedSpacing: number;
    minOverlapPx: number;
    /** C8 minimum contrast ratios; WCAG 2.2 AA by default. */
    contrast: { normal: number; large: number };
  };
  componentSpecs: ComponentSpec[];
  runtime: {
    enabled: boolean;
    /** launch: open the extension in the browser directly. harness: run the product's Playwright suite (mocks, login). */
    driver: "launch" | "harness";
    harness?: {
      cwd: string;
      /** Spec file inside cwd; substituted for {spec} in the command. */
      spec: string;
      command: string[];
      env: Record<string, string>;
      /** Remote-config flag sets applied in order; a list allows a flip (off → on) that makes the app refetch. */
      flags: Record<string, boolean>[];
      /** API responses the harness serves instead of the mock server's: `json` inline or `file`. */
      routes: { url: string; json?: unknown; file?: string }[];
      viewport?: { width: number; height: number };
      timeoutMs: number;
    };
    executablePath?: string;
    extensionPath?: string;
    headless: boolean;
    forceContextAttributes: boolean;
    collectSelector: string;
    screenshots: boolean;
    /** Upper bound for each navigation, click and wait, so a broken state fails fast. */
    actionTimeoutMs: number;
    /** Optional module run once per browser launch, before any surface opens (auth mocks, feature flags). */
    setup?: string;
    /** Also check elements inside <svg>; off by default because illustrations are artwork, not UI tokens. */
    includeSvgContent: boolean;
    /** Stylesheet added to every captured page before states run. Set by `eval` for css seeds; not a config key. */
    injectCss?: string;
    /**
     * Viewport sizes to capture every state in. The first is the default: its cells carry no viewport name,
     * so baselines and history stay valid when sizes are added. Empty = the driver's own size.
     */
    viewports: ViewportVariant[];
    surfaces: Surface[];
  };
  /** Git branch that holds machine memory (history, baselines); see src/state/sync.ts. */
  state: { remote?: string; branch: string; folder?: string };
  /** Who acts on each gap; the report and its filters are split by it. */
  owners: { A: string; B: string };
  report: {
    dir: string;
    /** Element crops with the element outlined, cut from cell screenshots (default true). */
    crops: boolean;
    /** Figma renders of linked nodes beside findings, through the REST API and FIGMA_TOKEN (default true). */
    figmaImages: boolean;
  };
  history: { path: string };
  baseline: { dir: string };
  /** Existing debt accepted on purpose (`design-auditor accept`): never new, never fails a run. */
  accepted: { path: string };
  /** Suppressions with a reason; `until` (YYYY-MM-DD) makes them expire. */
  suppress: SuppressRule[];
  /** Severity per check ("C8") or check/category ("C1/tailwind-arbitrary-type"); "off" drops the findings. */
  severity: Record<string, Severity | "off">;
}

export interface SuppressRule {
  check?: string;
  category?: string;
  /** Every string must appear in the finding's title, source, component, token, property or values. */
  contains?: string[];
  reason: string;
  until?: string;
}

export class ConfigError extends Error {}

function req<T>(value: T | undefined, path: string): T {
  if (value === undefined || value === null) throw new ConfigError(`Missing required config field: ${path}`);
  return value;
}

function asArray<T>(value: unknown, path: string): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ConfigError(`Config field ${path} must be a list`);
  return value as T[];
}

const ENV_REF = /\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g;

/**
 * Expands ${VAR} and ${VAR:-default} from the environment so machine-specific paths stay out of the file
 * (CI sets DESIGN_AUDITOR_TARGET to its checkout; a laptop falls back to the sibling folder).
 */
function expandEnv(value: string, path: string): string {
  return value.replace(ENV_REF, (_, name: string, fallback: string | undefined) => {
    const v = process.env[name] || fallback;
    if (v === undefined) throw new ConfigError(`Config field ${path} uses \${${name}}, which is not set`);
    return v;
  });
}

/** Like expandEnv, but leaves unknown ${VAR} in place so the runtime step can report it. */
function softExpand(value: string): string {
  return value.replace(ENV_REF, (whole, name: string, fallback: string | undefined) => process.env[name] || fallback || whole);
}

/** Throws a readable error when a runtime path still contains an unexpanded ${VAR}. */
export function assertRuntimeReady(cfg: AuditConfig) {
  for (const [field, value] of [
    ["runtime.executablePath", cfg.runtime.executablePath],
    ["runtime.extensionPath", cfg.runtime.extensionPath],
  ] as const) {
    const m = value ? /\$\{([A-Z0-9_]+)\}/.exec(value) : null;
    if (m) throw new ConfigError(`${field} uses \${${m[1]}}, which is not set. Export it before running with --runtime.`);
  }
  if (!cfg.runtime.surfaces.length) throw new ConfigError("runtime.surfaces is empty: list at least one page to open.");
  if (cfg.runtime.driver === "launch") {
    const noUrl = cfg.runtime.surfaces.find((s) => !s.url);
    if (noUrl) throw new ConfigError(`runtime.surfaces "${noUrl.name}" needs a url with the launch driver`);
  }
}

export function parseConfig(text: string, configPath: string): AuditConfig {
  const raw = (parseYaml(text) ?? {}) as Record<string, any>;
  const base = dirname(resolve(configPath));
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(base, p));

  const target = req(raw.target, "target");
  const repo = abs(expandEnv(req(target.repo, "target.repo"), "target.repo"));
  const inRepo = (p: string) => (isAbsolute(p) ? p : resolve(repo, p));

  const contexts: Context[] = asArray<any>(raw.contexts, "contexts").map((c, i) => {
    const scheme = c.colorScheme ?? "light";
    if (scheme !== "light" && scheme !== "dark") throw new ConfigError(`contexts[${i}].colorScheme must be light or dark`);
    return {
      name: req(c.name, `contexts[${i}].name`),
      html: c.html ?? {},
      colorScheme: scheme,
      figmaMode: c.figmaMode ?? scheme,
      backdrop: c.backdrop ?? (scheme === "dark" ? "#000000" : "#ffffff"),
    };
  });
  if (contexts.length === 0) throw new ConfigError("Config needs at least one entry under contexts");

  const sources: ReferenceSource[] = asArray<any>(raw.reference?.sources, "reference.sources").map((s, i) => {
    if (s.type !== "figma-variable-defs" && s.type !== "figma-rest-variables" && s.type !== "dtcg" && s.type !== "figma-rest")
      throw new ConfigError(`reference.sources[${i}].type must be figma-rest, figma-variable-defs, figma-rest-variables or dtcg`);
    if (s.type === "figma-rest") {
      if (!Array.isArray(s.files) || !s.files.length) throw new ConfigError(`reference.sources[${i}]: a figma-rest source needs files (Figma file keys)`);
      if (!s.modes || typeof s.modes !== "object" || !Object.keys(s.modes).length)
        throw new ConfigError(`reference.sources[${i}]: a figma-rest source needs modes, e.g. { light: { Pairs: Light }, dark: { Pairs: Dark } }`);
      return { ...s, cacheDir: abs(s.cacheDir ?? ".design-auditor/figma-cache") };
    }
    if (s.type === "dtcg" && (!s.path || !s.mode)) throw new ConfigError(`reference.sources[${i}]: a dtcg source needs path and mode`);
    return { ...s, path: s.path ? abs(s.path) : undefined };
  });

  const rt = raw.runtime ?? {};
  const driver = rt.driver ?? "launch";
  if (driver !== "launch" && driver !== "harness") throw new ConfigError("runtime.driver must be launch or harness");
  const surfaces: Surface[] = asArray<any>(rt.surfaces, "runtime.surfaces").map((s, i) => ({
    name: req(s.name, `runtime.surfaces[${i}].name`),
    url: driver === "launch" ? req(s.url, `runtime.surfaces[${i}].url`) : (s.url ?? ""),
    waitFor: s.waitFor,
    mask: asArray<string>(s.mask, `runtime.surfaces[${i}].mask`),
    states: s.states?.length ? s.states : [{ name: "default" }],
  }));

  const spacingFromTailwind = raw.scales?.spacing?.tailwindPrefix as string | undefined;

  let harness: AuditConfig["runtime"]["harness"];
  if (rt.harness) {
    const hcwd = abs(softExpand(req(rt.harness.cwd, "runtime.harness.cwd")));
    const command = asArray<string>(rt.harness.command, "runtime.harness.command");
    if (!command.length) throw new ConfigError("runtime.harness.command must list the program and its arguments");
    harness = {
      cwd: hcwd,
      spec: req(rt.harness.spec, "runtime.harness.spec"),
      command: command.map(String),
      env: Object.fromEntries(Object.entries(rt.harness.env ?? {}).map(([k, v]) => [k, String(v)])),
      flags: Array.isArray(rt.harness.flags) ? rt.harness.flags : rt.harness.flags ? [rt.harness.flags] : [],
      routes: asArray<any>(rt.harness.routes, "runtime.harness.routes").map((r, i) => {
        if (!r?.url) throw new ConfigError(`runtime.harness.routes[${i}].url is required`);
        if (r.json === undefined && !r.file) throw new ConfigError(`runtime.harness.routes[${i}] needs json or file`);
        return { url: r.url, json: r.json, file: r.file ? abs(r.file) : undefined };
      }),
      viewport: rt.harness.viewport,
      timeoutMs: rt.harness.timeoutMs ?? 600_000,
    };
  }
  const viewports: ViewportVariant[] = asArray<any>(rt.viewports, "runtime.viewports").map((v, i) => {
    if (!v?.name || !(v.width > 0) || !(v.height > 0)) throw new ConfigError(`runtime.viewports[${i}] needs name, width and height`);
    if (v.zoom !== undefined && !(Number(v.zoom) >= 0.25 && Number(v.zoom) <= 5)) throw new ConfigError(`runtime.viewports[${i}].zoom must be between 0.25 and 5 (1.5 = 150%)`);
    if (v.locale !== undefined && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(String(v.locale))) throw new ConfigError(`runtime.viewports[${i}].locale must be a language tag such as de or pt-BR`);
    if (v.states !== undefined && i === 0) throw new ConfigError("runtime.viewports[0] is the default and applies to every state; limit states on the other variants");
    const states = v.states === undefined ? undefined : asArray<string>(v.states, `runtime.viewports[${i}].states`).map(String);
    return {
      name: String(v.name),
      width: Number(v.width),
      height: Number(v.height),
      ...(v.zoom !== undefined && Number(v.zoom) !== 1 ? { zoom: Number(v.zoom) } : {}),
      ...(v.locale !== undefined ? { locale: String(v.locale) } : {}),
      ...(states ? { states } : {}),
    };
  });
  if (new Set(viewports.map((v) => v.name)).size !== viewports.length) throw new ConfigError("runtime.viewports names must be unique");
  const stateNames = new Set(surfaces.flatMap((s) => s.states.map((st: { name: string }) => st.name)));
  for (const v of viewports)
    for (const st of v.states ?? [])
      if (!stateNames.has(st)) throw new ConfigError(`runtime.viewports "${v.name}" lists state "${st}", which no surface defines`);
  if (!viewports.length && harness?.viewport) viewports.push({ name: "default", ...harness.viewport });
  if (driver === "harness" && !harness) throw new ConfigError("runtime.driver is harness: add runtime.harness (cwd, spec, command)");

  const figmaComponents: ComponentMapping[] = asArray<any>(raw.figmaComponents, "figmaComponents").map((m, i) => {
    if (!m?.figma || !m?.element) throw new ConfigError(`figmaComponents[${i}] needs figma (component set name) and element (selector)`);
    if (typeof m.element !== "string" || !m.element.trim()) throw new ConfigError(`figmaComponents[${i}].element must be a CSS selector`);
    if (!m.variants || typeof m.variants !== "object") throw new ConfigError(`figmaComponents[${i}].variants must map variant names to states`);
    const variants: ComponentMapping["variants"] = {};
    for (const [name, v] of Object.entries<any>(m.variants)) {
      if (v === null) variants[name] = null;
      else if (typeof v === "string") variants[name] = { state: v };
      else if (v?.state) variants[name] = { state: v.state, nth: v.nth };
      else throw new ConfigError(`figmaComponents[${i}].variants["${name}"] must be a state name, { state, nth } or null`);
    }
    const properties = m.properties === undefined ? undefined : asArray<string>(m.properties, `figmaComponents[${i}].properties`);
    const badProp = properties?.find((p) => !(C7_PROPERTIES as readonly string[]).includes(p));
    if (badProp) throw new ConfigError(`figmaComponents[${i}].properties: unknown "${badProp}" (use ${C7_PROPERTIES.join(", ")})`);
    return { figma: m.figma, element: m.element, layer: m.layer, variants, text: m.text, properties: properties as C7Property[] | undefined };
  });

  return {
    project: raw.project ?? "design-audit",
    configPath: resolve(configPath),
    target: {
      repo,
      themeEntry: inRepo(req(target.themeEntry, "target.themeEntry")),
      tailwindConfig: target.tailwindConfig ? inRepo(target.tailwindConfig) : undefined,
      scan: {
        include: asArray<string>(target.scan?.include ?? ["src"], "target.scan.include"),
        extensions: asArray<string>(target.scan?.extensions ?? [".ts", ".tsx", ".css"], "target.scan.extensions"),
        exclude: asArray<string>(target.scan?.exclude ?? ["node_modules"], "target.scan.exclude"),
        knownVarPrefixes: asArray<string>(target.scan?.knownVarPrefixes ?? ["--tw-"], "target.scan.knownVarPrefixes"),
        hexExtensions: asArray<string>(target.scan?.hexExtensions ?? [".tsx"], "target.scan.hexExtensions"),
      },
    },
    contexts,
    reference: {
      sources,
      aliases: raw.reference?.aliases ?? {},
      components: asArray<string>(raw.reference?.components, "reference.components").map(abs),
      componentSources: asArray<any>(raw.reference?.componentSources, "reference.componentSources").map((c, i) => {
        if (!c?.file || !Array.isArray(c.sets) || !c.sets.length || !c.out)
          throw new ConfigError(`reference.componentSources[${i}] needs file (Figma file key), sets (names) and out (JSON path)`);
        return { file: String(c.file), sets: c.sets.map(String), out: abs(c.out) };
      }),
      figmaCacheDir: abs(raw.reference?.figmaCacheDir ?? ".design-auditor/figma-cache"),
      scalePrefixes: {
        spacing: asArray<string>(raw.reference?.scalePrefixes?.spacing ?? ["spacing_"], "reference.scalePrefixes.spacing"),
        radius: asArray<string>(raw.reference?.scalePrefixes?.radius ?? ["radius_"], "reference.scalePrefixes.radius"),
      },
    },
    figmaComponents,
    scales: {
      spacing: asArray<number>(raw.scales?.spacing?.values ?? [], "scales.spacing.values"),
      spacingFromTailwind,
      radius: asArray<number>(raw.scales?.radius ?? [], "scales.radius"),
    },
    thresholds: {
      colorDeltaE: raw.thresholds?.colorDeltaE ?? 2,
      px: raw.thresholds?.px ?? 1,
      maxCheckedSpacing: raw.thresholds?.maxCheckedSpacing ?? 64,
      minOverlapPx: raw.thresholds?.minOverlapPx ?? 16,
      contrast: { normal: raw.thresholds?.contrast?.normal ?? 4.5, large: raw.thresholds?.contrast?.large ?? 3 },
    },
    componentSpecs: asArray<any>(raw.componentSpecs, "componentSpecs").map((c, i) => {
      if (!c?.match?.testId && !c?.match?.component)
        throw new ConfigError(`componentSpecs[${i}].match needs testId or component`);
      if (c.padding !== undefined && (!Array.isArray(c.padding) || c.padding.length !== 4))
        throw new ConfigError(`componentSpecs[${i}].padding must list 4 values: top, right, bottom, left (null skips a side)`);
      return { name: c.name ?? c.match.testId ?? c.match.component, match: c.match, padding: c.padding, gap: c.gap, figma: c.figma };
    }),
    runtime: {
      enabled: rt.enabled ?? false,
      driver,
      harness,
      // Runtime paths are expanded lazily: a missing variable only matters when --runtime is used.
      executablePath: rt.executablePath ? softExpand(rt.executablePath) : undefined,
      extensionPath: rt.extensionPath ? abs(softExpand(rt.extensionPath)) : undefined,
      headless: rt.headless ?? true,
      forceContextAttributes: rt.forceContextAttributes ?? true,
      collectSelector: rt.collectSelector ?? "[data-ds-component],[data-testid]",
      screenshots: rt.screenshots ?? true,
      actionTimeoutMs: rt.actionTimeoutMs ?? 10_000,
      setup: rt.setup ? abs(rt.setup) : undefined,
      includeSvgContent: rt.includeSvgContent ?? false,
      viewports,
      surfaces,
    },
    owners: { A: String(raw.owners?.A ?? "Design system team"), B: String(raw.owners?.B ?? "Product team") },
    state: {
      remote: raw.state?.remote ? softExpand(String(raw.state.remote)) : undefined,
      branch: String(raw.state?.branch ?? "design-audit/state"),
      folder: raw.state?.folder ? String(raw.state.folder) : undefined,
    },
    report: { dir: abs(raw.report?.dir ?? "reports"), crops: raw.report?.crops ?? true, figmaImages: raw.report?.figmaImages ?? true },
    history: { path: abs(raw.history?.path ?? ".design-auditor/history.json") },
    baseline: { dir: abs(raw.baseline?.dir ?? ".design-auditor/baselines") },
    accepted: { path: abs(raw.accepted?.path ?? ".design-auditor/accepted.json") },
    suppress: asArray<any>(raw.suppress, "suppress").map((r, i) => {
      if (!r || typeof r !== "object") throw new ConfigError(`suppress[${i}] must be an object`);
      if (typeof r.reason !== "string" || !r.reason.trim()) throw new ConfigError(`suppress[${i}] needs a reason: say why this is not drift`);
      if (!r.check && !r.category && !r.contains) throw new ConfigError(`suppress[${i}] needs check, category or contains, or it would hide everything`);
      if (r.until !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(r.until))) throw new ConfigError(`suppress[${i}].until must be YYYY-MM-DD`);
      return {
        check: r.check ? String(r.check).toUpperCase() : undefined,
        category: r.category,
        contains: r.contains === undefined ? undefined : asArray<string>(r.contains, `suppress[${i}].contains`).map(String),
        reason: r.reason.trim(),
        until: r.until === undefined ? undefined : String(r.until),
      };
    }),
    severity: Object.fromEntries(
      Object.entries((raw.severity ?? {}) as Record<string, unknown>).map(([k, v]) => {
        if (!/^C\d+(\/[\w-]+)?$/i.test(k)) throw new ConfigError(`severity key "${k}" must be a check ("C8") or check/category ("C1/tailwind-arbitrary-type")`);
        if (!["high", "medium", "low", "off"].includes(String(v))) throw new ConfigError(`severity "${k}" must be high, medium, low or off`);
        const [check, category] = k.split("/");
        return [category ? `${check!.toUpperCase()}/${category}` : check!.toUpperCase(), v as Severity | "off"];
      }),
    ),
  };
}

export function loadConfig(path: string): AuditConfig {
  return parseConfig(readFileSync(path, "utf8"), path);
}
