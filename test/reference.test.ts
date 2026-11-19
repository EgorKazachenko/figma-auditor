import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { figmaNodeUrl, fromRestVariables, fromVariableDefs, loadReference, referenceScale } from "../src/reference/figma.js";

const fixtures = join(import.meta.dirname, "fixtures", "figma");

describe("fromVariableDefs", () => {
  const tokens = fromVariableDefs({
    source: { fileKey: "KEY", nodeId: "1:69890", fileName: "Chat Sidepanel", mode: "light" },
    variables: {
      "var(--color-level-5)": "#f7f7f8",
      spacing_2: "4",
      "MacOS/Body/M": 'Font(family: "SF Pro", size: 14)',
      "ElevationShadow/Light/E5": "Effect(type: DROP_SHADOW)",
      Weird: "auto",
    },
  });

  it("normalises names and classifies kinds", () => {
    expect(tokens.map((t) => [t.name, t.kind])).toEqual([
      ["--color-level-5", "color"],
      ["spacing_2", "number"],
      ["MacOS/Body/M", "font"],
      ["ElevationShadow/Light/E5", "effect"],
      ["Weird", "other"],
    ]);
  });

  it("keeps the Figma name, mode and a link to the node", () => {
    expect(tokens[0]).toMatchObject({
      figmaName: "var(--color-level-5)",
      mode: "light",
      source: { fileKey: "KEY", nodeId: "1:69890", url: "https://www.figma.com/design/KEY/?node-id=1-69890" },
    });
  });

  it("rejects files without variables or mode", () => {
    expect(() => fromVariableDefs({ source: { mode: "light" } })).toThrow(/variables/);
    expect(() => fromVariableDefs({ source: {}, variables: {} })).toThrow(/mode/);
  });
});

describe("fromRestVariables", () => {
  const json = {
    meta: {
      variableCollections: {
        c1: { id: "c1", name: "Colors", defaultModeId: "m1", modes: [{ modeId: "m1", name: "Light" }, { modeId: "m2", name: "Dark" }] },
        c2: { id: "c2", name: "Primitives", defaultModeId: "p1", modes: [{ modeId: "p1", name: "Value" }] },
      },
      variables: {
        v1: {
          id: "v1",
          name: "color/level/5",
          resolvedType: "COLOR",
          variableCollectionId: "c1",
          codeSyntax: { WEB: "var(--color-level-5)" },
          valuesByMode: { m1: { r: 247 / 255, g: 247 / 255, b: 248 / 255, a: 1 }, m2: { type: "VARIABLE_ALIAS", id: "v2" } },
        },
        v2: {
          id: "v2",
          name: "gray/950",
          resolvedType: "COLOR",
          variableCollectionId: "c2",
          valuesByMode: { p1: { r: 16 / 255, g: 18 / 255, b: 19 / 255, a: 1 } },
        },
        v3: { id: "v3", name: "spacing_2", resolvedType: "FLOAT", variableCollectionId: "c2", valuesByMode: { p1: 4 } },
      },
    },
  };
  const tokens = fromRestVariables(json, "KEY", { Value: "base" });

  it("emits one token per variable and mode, named by WEB code syntax", () => {
    const level5 = tokens.filter((t) => t.name === "--color-level-5");
    expect(level5.map((t) => [t.mode, t.value])).toEqual([
      ["light", "#f7f7f8"],
      ["dark", "#101213"],
    ]);
  });

  it("resolves aliases across collections and applies the mode map", () => {
    expect(tokens.find((t) => t.name === "gray/950")).toMatchObject({ mode: "base", value: "#101213" });
    expect(tokens.find((t) => t.name === "spacing_2")).toMatchObject({ kind: "number", value: "4", mode: "base" });
  });
});

describe("loadReference and referenceScale", () => {
  it("merges several sources, later ones winning per name and mode", async () => {
    const tokens = await loadReference([
      { type: "figma-variable-defs", path: join(fixtures, "light.json") },
      { type: "figma-variable-defs", path: join(fixtures, "dark.json") },
    ]);
    const level5 = tokens.filter((t) => t.name === "--color-level-5").map((t) => `${t.mode}:${t.value}`);
    expect(level5.sort()).toEqual(["dark:#101213", "light:#f7f7f8"]);
    expect(referenceScale(tokens, "spacing_")).toEqual([2, 6]);
    expect(referenceScale(tokens, "radius_")).toEqual([8]);
  });

  it("explains a missing token for the REST source", async () => {
    const old = process.env.FIGMA_TOKEN;
    delete process.env.FIGMA_TOKEN;
    await expect(loadReference([{ type: "figma-rest-variables", fileKey: "KEY" }])).rejects.toThrow(/FIGMA_TOKEN/);
    if (old !== undefined) process.env.FIGMA_TOKEN = old;
  });

  it("builds node links", () => {
    expect(figmaNodeUrl("KEY", "12:34")).toBe("https://www.figma.com/design/KEY/?node-id=12-34");
    expect(figmaNodeUrl(undefined, "1:2")).toBeUndefined();
  });
});
