// Figma REST: variables across files and modes, cache by version, component sets, `figma pull`, and their
// use in C2 (code syntax) and C7 (a layer's own variable).
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVariableGraph, codeSyntaxFindings, nameMatch, resolveVariable, toReferenceTokens } from "../src/figma/variables.js";
import { cachedFigma, figmaClient, type FigmaClient } from "../src/figma/rest.js";
import { extractSetsFromNodes } from "../src/figma/components.js";
import { pullFigma } from "../src/figma/pull.js";
import { loadReference } from "../src/reference/figma.js";
import { parseConfig } from "../src/config.js";
import { checkFigmaStates } from "../src/checks/c7FigmaStates.js";
import { makeVariableResolver } from "../src/reference/components.js";
import type { SnapshotCell } from "../src/types.js";

const red = { r: 1, g: 0, b: 0, a: 1 };
const alias = (id: string) => ({ type: "VARIABLE_ALIAS", id });

// Product file: semantic Colors (mode Neon) aliasing into a library's Pairs (Light/Dark), which alias Palette.
const product = {
  meta: {
    variableCollections: {
      colors: { id: "colors", name: "Colors", defaultModeId: "neon", modes: [{ modeId: "neon", name: "Neon" }] },
    },
    variables: {
      level5: { id: "level5", name: "Level/L-5", resolvedType: "COLOR", variableCollectionId: "colors", valuesByMode: { neon: alias("pair5") }, codeSyntax: { WEB: "var(--color-level-5)" } },
      n60: { id: "n60", name: "Neutral/N-92-60%", resolvedType: "COLOR", variableCollectionId: "colors", valuesByMode: { neon: alias("pair60") }, codeSyntax: { WEB: "var(--color-neutral-92-60)" } },
      n40: { id: "n40", name: "Neutral/N-92-40%", resolvedType: "COLOR", variableCollectionId: "colors", valuesByMode: { neon: alias("pair40") }, codeSyntax: { WEB: "var(--color-neutral-92-60)" } },
      bad: { id: "bad", name: "Text/Text 1", resolvedType: "COLOR", variableCollectionId: "colors", valuesByMode: { neon: red }, codeSyntax: { WEB: "color-text-1" } },
      lost: { id: "lost", name: "Lost/L", resolvedType: "COLOR", variableCollectionId: "colors", valuesByMode: { neon: alias("nowhere") }, codeSyntax: { WEB: "var(--color-lost)" } },
      gap: { id: "gap", name: "Spacing/2", resolvedType: "FLOAT", variableCollectionId: "colors", valuesByMode: { neon: 4 }, codeSyntax: { WEB: "var(--spacing-2)" } },
    },
  },
};
const library = {
  meta: {
    variableCollections: {
      pairs: { id: "pairs", name: "Pairs", defaultModeId: "l", modes: [{ modeId: "l", name: "Light" }, { modeId: "d", name: "Dark" }] },
      pal: { id: "pal", name: "Palette", defaultModeId: "p", modes: [{ modeId: "p", name: "Mode 1" }] },
    },
    variables: {
      pair5: { id: "pair5", name: "Secondary/S97", resolvedType: "COLOR", variableCollectionId: "pairs", valuesByMode: { l: alias("white"), d: { r: 16 / 255, g: 18 / 255, b: 19 / 255, a: 1 } } },
      pair60: { id: "pair60", name: "Secondary/S92-60%", resolvedType: "COLOR", variableCollectionId: "pairs", valuesByMode: { l: { r: 233 / 255, g: 235 / 255, b: 236 / 255, a: 0.6 }, d: { r: 63 / 255, g: 69 / 255, b: 74 / 255, a: 0.6 } } },
      pair40: { id: "pair40", name: "Secondary/S92-40%", resolvedType: "COLOR", variableCollectionId: "pairs", valuesByMode: { l: { r: 233 / 255, g: 235 / 255, b: 236 / 255, a: 0.4 }, d: { r: 63 / 255, g: 69 / 255, b: 74 / 255, a: 0.4 } } },
      white: { id: "white", name: "Pallete/White", resolvedType: "COLOR", variableCollectionId: "pal", valuesByMode: { p: { r: 247 / 255, g: 247 / 255, b: 248 / 255, a: 1 } } },
    },
  },
};
const modes = { light: { Pairs: "Light" }, dark: { Pairs: ["Night", "Dark"] } };

describe("variable graph", () => {
  const g = buildVariableGraph([
    { fileKey: "PRODUCT", json: product },
    { fileKey: "LIB", json: library },
  ]);

  it("follows aliases across files and picks each collection's mode per theme", () => {
    expect(resolveVariable(g, "level5", modes.light)).toMatchObject({ value: "#f7f7f8", path: ["Level/L-5", "Secondary/S97", "Pallete/White"] });
    expect(resolveVariable(g, "level5", modes.dark).value).toBe("#101213"); // "Night" is absent, "Dark" is used
    expect(resolveVariable(g, "gap", modes.light)).toMatchObject({ value: "4", kind: "number" });
    expect(resolveVariable(g, "lost", modes.light).missing).toEqual({ id: "nowhere", from: "Lost/L" });
  });

  it("produces reference tokens named like the code, and lists what it could not resolve", () => {
    const r = toReferenceTokens(g, modes, { fileKey: "PRODUCT", exclude: ["--color-lost"] });
    const by = (name: string, mode: string) => r.tokens.find((t) => t.name === name && t.mode === mode)?.value;
    expect(by("--color-level-5", "dark")).toBe("#101213");
    expect(by("--spacing-2", "light")).toBe("4");
    expect(r.unresolved).toEqual([]);
    expect(toReferenceTokens(g, modes).unresolved.map((u) => u.variable)).toEqual(["Lost/L", "Lost/L"]);
  });

  it("takes the variable whose Figma name matches a shared CSS name as the reference", () => {
    const r = toReferenceTokens(g, modes, { exclude: ["--color-lost"] });
    expect(r.tokens.filter((t) => t.name === "--color-neutral-92-60").map((t) => `${t.mode} ${t.value}`)).toEqual(["light #e9ebec99", "dark #3f454a99"]);
    expect(nameMatch("Neutral/N-92-60%", "var(--color-neutral-92-60)")).toBeGreaterThan(nameMatch("Neutral/N-92-40%", "var(--color-neutral-92-60)"));
    expect(nameMatch("Text/T-04", "var(--color-text-4)")).toBeGreaterThan(nameMatch("Text/T-05", "var(--color-text-4)"));
    expect(nameMatch("Accent/A-0", "var(--color-accent-0)")).toBeGreaterThan(nameMatch("Label/LS-1", "var(--color-accent-0)"));
  });

  it("reports code syntax two variables share (with their values) and code syntax that is no CSS variable", () => {
    const f = codeSyntaxFindings(g, modes);
    const collision = f.find((x) => x.category === "figma-code-syntax-collision")!;
    expect(collision.severity).toBe("high");
    expect(collision.title).toBe("In Figma, Neutral/N-92-60% and Neutral/N-92-40% all export var(--color-neutral-92-60); their values differ, so code cannot match both");
    expect(collision.actual?.value).toContain("light: Neutral/N-92-60% = #e9ebec99, Neutral/N-92-40% = #e9ebec66");
    expect(f.find((x) => x.category === "figma-code-syntax-invalid")!.title).toContain('exports "color-text-1"');
    const withoutLibrary = codeSyntaxFindings(buildVariableGraph([{ fileKey: "PRODUCT", json: product }]), modes);
    expect(withoutLibrary.find((x) => x.category === "figma-code-syntax-collision")).toMatchObject({ severity: "medium" });
  });
});

function fakeClient(files: Record<string, { version: string; name: string; variables?: unknown; sets?: unknown; nodes?: unknown }>) {
  const calls: string[] = [];
  const client: FigmaClient = {
    async get(path: string) {
      calls.push(path);
      const key = path.split("/")[3]!.split("?")[0]!;
      const f = files[key];
      if (!f) throw new Error(`Figma ${path}: HTTP 404`);
      if (path.includes("?depth=1")) return { name: f.name, version: f.version, lastModified: "2026-11-19T00:00:00Z" };
      if (path.endsWith("/variables/local")) return f.variables;
      if (path.endsWith("/component_sets")) return f.sets;
      if (path.includes("/nodes?")) return f.nodes;
      throw new Error(`unexpected ${path}`);
    },
  };
  return { client, calls };
}

describe("aliases into a library's own listing", () => {
  it("matches a remote reference (VariableID:<key>/<node>) to the library's local variable by key", () => {
    const key = "9e76dee100c1fbd6c6e937bc44dee35867b1d468";
    const consumer = { meta: { variableCollections: { c: { id: "c", name: "Colors", defaultModeId: "n", modes: [{ modeId: "n", name: "Neon" }] } }, variables: {
      n90: { id: "n90", name: "Neutral/N-90", resolvedType: "COLOR", variableCollectionId: "c", valuesByMode: { n: alias(`VariableID:${key}/3668:12`) }, codeSyntax: { WEB: "var(--color-neutral-90)" } },
      copy: { id: `VariableID:${key}/3668:12`, name: "Secondary/S90-30", key, remote: true, resolvedType: "COLOR", variableCollectionId: "c", valuesByMode: { n: alias("gone") }, codeSyntax: { WEB: "BAD" } },
    } } };
    const lib = { meta: { variableCollections: { p: { id: "p", name: "Pairs", defaultModeId: "l", modes: [{ modeId: "l", name: "Light" }] } }, variables: {
      local: { id: "VariableID:2439:84", name: "Secondary/S90-30", key, resolvedType: "COLOR", variableCollectionId: "p", valuesByMode: { l: { r: 227 / 255, g: 230 / 255, b: 232 / 255, a: 1 } }, codeSyntax: { WEB: "BAD" } },
    } } };
    const g = buildVariableGraph([{ fileKey: "C", json: consumer }, { fileKey: "L", json: lib }]);
    expect(resolveVariable(g, "n90", { Pairs: "Light" }).value).toBe("#e3e6e8");
    // the variable is counted once although both copies are in the graph
    expect(codeSyntaxFindings(g, { light: {} }).filter((f) => f.category === "figma-code-syntax-invalid")).toHaveLength(1);
  });
});

describe("cache by file version", () => {
  it("downloads once, reuses the cache while the version holds, works offline from the cache", async () => {
    const dir = mkdtempSync(join(tmpdir(), "da-fcache-"));
    const files = { K: { version: "1", name: "Lib", variables: library } };
    const { client, calls } = fakeClient(files);
    const a = await cachedFigma(client, dir, "K", "variables", "/v1/files/K/variables/local");
    const b = await cachedFigma(client, dir, "K", "variables", "/v1/files/K/variables/local");
    expect([a.from, b.from]).toEqual(["network", "cache"]);
    expect(calls.filter((c) => c.endsWith("/variables/local"))).toHaveLength(1);
    files.K.version = "2";
    expect((await cachedFigma(client, dir, "K", "variables", "/v1/files/K/variables/local")).from).toBe("network");
    expect((await cachedFigma(null, dir, "K", "variables", "/v1/files/K/variables/local")).from).toBe("cache");
    await expect(cachedFigma(null, dir, "NEW", "variables", "/x")).rejects.toThrow(/No FIGMA_TOKEN/);
    expect(figmaClient(undefined)).toBeNull();
  });

  it("explains a 403 from Figma", async () => {
    const client = figmaClient("t", (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch)!;
    await expect(client.get("/v1/files/K/variables/local")).rejects.toThrow(/HTTP 403 \(token lacks access or scope/);
  });
});

// A component set as GET /v1/files/:key/nodes returns it.
const setNode = {
  document: {
    id: "1:1",
    name: "Chip",
    type: "COMPONENT_SET",
    componentPropertyDefinitions: { State: { type: "VARIANT", variantOptions: ["Default", "Hover"] } },
    children: [
      {
        id: "1:2",
        name: "State=Hover",
        type: "COMPONENT",
        absoluteBoundingBox: { x: 100, y: 50, width: 100, height: 33 },
        layoutMode: "HORIZONTAL",
        paddingLeft: 8,
        itemSpacing: 2,
        counterAxisAlignItems: "CENTER",
        layoutSizingHorizontal: "HUG",
        layoutSizingVertical: "FIXED",
        cornerRadius: 8,
        fills: [{ type: "SOLID", color: { r: 233 / 255, g: 235 / 255, b: 236 / 255, a: 1 }, opacity: 0.4, boundVariables: { color: { type: "VARIABLE_ALIAS", id: "n40" } } }],
        effects: [{ type: "DROP_SHADOW", visible: true, color: { r: 0, g: 0, b: 0, a: 0.3 }, offset: { x: 0, y: 6 }, radius: 20 }],
        styles: { effect: "S:1" },
        children: [
          {
            id: "1:3",
            name: "Label",
            type: "TEXT",
            absoluteBoundingBox: { x: 108, y: 58, width: 58, height: 17 },
            characters: "Opera AI",
            style: { fontFamily: "SF Pro", fontWeight: 400, fontSize: 14, lineHeightUnit: "INTRINSIC_%" },
            fills: [{ type: "SOLID", color: { r: 23 / 255, g: 26 / 255, b: 28 / 255, a: 1 } }],
            styles: { text: "S:2" },
          },
          { id: "1:4", name: "Icon", type: "INSTANCE", componentId: "C:icon", absoluteBoundingBox: { x: 170, y: 58, width: 17, height: 17 }, children: [{ id: "1:5", name: "v", type: "VECTOR", strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }] }] },
          { id: "1:6", name: "Hidden", type: "FRAME", visible: false },
        ],
      },
    ],
  },
  components: { "C:icon": { name: "Icons/Chevron" } },
  styles: { "S:1": { name: "ElevationShadow/Dark/E5", styleType: "EFFECT" }, "S:2": { name: "MacOS/Body/M", styleType: "TEXT" } },
};

describe("component sets from REST", () => {
  const g = buildVariableGraph([{ fileKey: "PRODUCT", json: product }]);
  const [set] = extractSetsFromNodes([setNode], g, { fileKey: "LIB", fileName: "Lib" });

  it("writes the same layer format as the plugin capture, with the variable's identity", () => {
    expect(set).toMatchObject({ name: "Chip", variantProps: { State: ["Default", "Hover"] }, fileKey: "LIB" });
    const [root, label, icon] = set!.variants[0]!.layers;
    expect(root).toMatchObject({ path: ".", box: [0, 0, 100, 33], pad: [0, 0, 0, 8], gap: 2, align: ["MIN", "CENTER"], sizing: ["HUG", "FIXED"], radius: 8 });
    expect(root!.fill).toEqual({ c: "#e9ebec66", v: "var(--color-neutral-92-60)", var: { id: "n40", name: "Neutral/N-92-40%" } });
    expect(root!.shadow).toEqual({ x: 0, y: 6, blur: 20, spread: 0, c: "#0000004d", style: "ElevationShadow/Dark/E5" });
    expect(label).toMatchObject({ path: "/Label", box: [8, 8, 58, 17], text: { chars: "Opera AI", size: 14, weight: 400, font: "SF Pro", lh: "auto", style: "MacOS/Body/M", color: { c: "#171a1c" } } });
    expect(icon).toMatchObject({ path: "/Icon", instanceOf: "Icons/Chevron", iconColor: { c: "#000000" } });
    expect(set!.variants[0]!.layers.map((l) => l.path)).toEqual([".", "/Label", "/Icon"]); // hidden layers and icon insides skipped
  });
});

describe("figma pull and figma-rest sources", () => {
  const dir = mkdtempSync(join(tmpdir(), "da-pull-"));
  writeFileSync(
    join(dir, "audit.yaml"),
    `
target: { repo: ., themeEntry: t.css }
contexts: [{ name: light, colorScheme: light }, { name: dark, colorScheme: dark }]
reference:
  sources:
    - type: figma-rest
      files: [PRODUCT, LIB]
      modes: { light: { Pairs: Light }, dark: { Pairs: Dark } }
      exclude: ["--color-lost"]
  componentSources:
    - { file: LIB, sets: [Chip, Nope], out: refs/components.json }
  components: [refs/components.json]
`,
  );
  const cfg = parseConfig(readFileSync(join(dir, "audit.yaml"), "utf8"), join(dir, "audit.yaml"));
  const { client } = fakeClient({
    PRODUCT: { version: "7", name: "Product", variables: product },
    LIB: { version: "3", name: "Lib", variables: library, sets: { meta: { component_sets: [{ name: "Chip", node_id: "1:1", containing_frame: { pageName: "Chips" } }] } }, nodes: { nodes: { "1:1": setNode } } },
  });

  it("pulls variables and named component sets, and says which were not found", async () => {
    const notes = await pullFigma(cfg, { client });
    expect(notes).toContain("variables Product: downloaded (version 7)");
    expect(notes).toContain('component set "Nope" not found in Lib');
    expect(notes.find((n) => n.startsWith("components Lib: 1 sets, 1 variants"))).toBeTruthy();
    const out = JSON.parse(readFileSync(join(dir, "refs/components.json"), "utf8"));
    expect(out.source).toMatchObject({ fileKey: "LIB", version: "3" });
    expect(out.sets[0]).toMatchObject({ name: "Chip", page: "Chips" });
    expect((await pullFigma(cfg, { client }))[0]).toBe("variables Product: unchanged (version 7)");
    await expect(pullFigma(cfg, { client: null })).rejects.toThrow(/FIGMA_TOKEN/);
  });

  it("loads per-theme tokens offline from the cache and keeps the graph for checks", async () => {
    const extras = { graphs: [] as any[] };
    const warnings: string[] = [];
    const tokens = await loadReference(cfg.reference.sources, warnings, extras, { client: null });
    expect(tokens.find((t) => t.name === "--color-level-5" && t.mode === "dark")?.value).toBe("#101213");
    expect(extras.graphs).toHaveLength(1);
    expect(warnings).toEqual([]);
    expect(existsSync(join(dir, ".design-auditor/figma-cache/PRODUCT/variables.json"))).toBe(true);
  });

  it("validates figma-rest and componentSources config", () => {
    const base = "target: {repo: r, themeEntry: t}\ncontexts: [{name: l}]\n";
    expect(() => parseConfig(`${base}reference:\n  sources: [{ type: figma-rest, modes: { light: {} } }]`, "/a.yaml")).toThrow(/needs files/);
    expect(() => parseConfig(`${base}reference:\n  sources: [{ type: figma-rest, files: [K] }]`, "/a.yaml")).toThrow(/needs modes/);
    expect(() => parseConfig(`${base}reference:\n  componentSources: [{ file: K, sets: [] }]`, "/a.yaml")).toThrow(/needs file/);
  });
});

describe("C7 with a layer's own variable", () => {
  const g = buildVariableGraph([
    { fileKey: "PRODUCT", json: product },
    { fileKey: "LIB", json: library },
  ]);
  const [set] = extractSetsFromNodes([setNode], g, { fileKey: "LIB" });
  const cell: SnapshotCell = {
    surface: "p",
    state: "hover",
    context: "dark",
    url: "x",
    browser: "B",
    tokens: { "--color-neutral-92-60": { raw: "", color: "rgba(63, 69, 74, 0.6)" } } as SnapshotCell["tokens"],
    nodes: [
      {
        component: null,
        testId: "chip",
        path: "div",
        box: { x: 0, y: 0, width: 100, height: 33 },
        hasText: false,
        text: "",
        css: { "background-color": "rgba(63, 69, 74, 0.6)", "border-top-left-radius": "8px", "box-shadow": "rgba(0, 0, 0, 0.3) 0px 6px 20px 0px" },
      },
    ],
  };
  const f = checkFigmaStates([cell], {
    sets: [set!],
    mappings: [{ figma: "Chip", element: "[data-testid=chip]", properties: ["background"], variants: { "State=Hover": { state: "hover" } } }],
    contexts: [{ name: "dark", html: {}, colorScheme: "dark", figmaMode: "dark", backdrop: "#000000" }],
    resolveVar: makeVariableResolver([], "light"),
    resolveVarId: (id, mode) => resolveVariable(g, id, mode === "dark" ? { Pairs: "Dark" } : { Pairs: "Light" }).value ?? null,
    codeSyntaxCollisions: new Map([["--color-neutral-92-60", ["Neutral/N-92-60%", "Neutral/N-92-40%"]]]),
    colorDeltaE: 2,
    px: 1,
  });

  it("compares with the exact variable Figma used and names the code syntax it shares", () => {
    expect(f).toHaveLength(1);
    expect(f[0]!.title).toContain("Figma var(--color-neutral-92-60) = #3f454a66");
    expect(f[0]!.title).toContain("Figma uses Neutral/N-92-40%, but Neutral/N-92-60% also exports var(--color-neutral-92-60)");
  });
});
