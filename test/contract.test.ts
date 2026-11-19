// The capture contract every driver writes; checks read nothing else.
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STYLE_PROPERTIES, validateCell } from "../src/contract.js";
import { readCaptureDir } from "../src/runtime/harness.js";
import { PROBE_PROPS } from "../src/runtime/browser.js";

// What an Android driver would write for a Compose button: dp as px, ARGB as rgba().
const androidCell = {
  surface: "home",
  state: "default",
  context: "light",
  url: "app://home",
  browser: "Android 15 (Pixel 8 emulator)",
  tokens: { "--color-primary": { raw: "@color/primary", color: "rgb(24, 119, 215)" } },
  nodes: [
    {
      component: "Button",
      testId: "primary-button",
      path: "Column/Button[0]",
      box: { x: 16, y: 120, width: 328, height: 48 },
      hasText: true,
      text: "Continue",
      css: { "background-color": "rgb(24, 119, 215)", color: "rgb(255, 255, 255)", "padding-left": "16px", "border-top-left-radius": "12px", "font-size": "14px", "font-weight": "500", "elevation-dp": "2" },
    },
  ],
};

describe("capture contract", () => {
  it("covers every property the web probe collects", () => {
    expect(PROBE_PROPS.filter((p) => !(p in STYLE_PROPERTIES))).toEqual([]);
  });

  it("accepts a cell from a non-web driver, including its own extra properties", () => {
    expect(validateCell(androidCell)).toEqual([]);
  });

  it("names what is wrong in a malformed cell", () => {
    const bad = structuredClone(androidCell) as any;
    bad.state = "";
    bad.nodes[0].box.width = "48dp";
    bad.nodes[0].css["background-color"] = "#ZZZ";
    bad.nodes[0].css["padding-left"] = "16dp";
    bad.nodes.push({ box: { x: 0, y: 0, width: 1, height: 1 }, css: {} });
    expect(validateCell(bad, "c")).toEqual([
      'c: "state" must be a non-empty string',
      'c: nodes[0]: "box" needs numeric x, y, width, height',
      'c: nodes[0]: background-color "#ZZZ": expected rgb(), rgba() or hex',
      'c: nodes[0]: padding-left "16dp": expected a length in px',
      "c: nodes[1]: needs testId, component or path to be identified",
    ]);
    expect(validateCell(null)).toEqual(["cell: not an object"]);
  });

  it("drops cells a harness wrote wrongly and keeps the rest, with warnings", () => {
    const dir = mkdtempSync(join(tmpdir(), "da-contract-"));
    writeFileSync(join(dir, "home__default__light.cell.json"), JSON.stringify(androidCell));
    writeFileSync(join(dir, "home__broken__light.cell.json"), JSON.stringify({ surface: "home", state: "broken" }));
    writeFileSync(join(dir, "home__garbage__light.cell.json"), "{nope");
    const nodeIssue = structuredClone(androidCell) as any;
    nodeIssue.state = "odd";
    nodeIssue.nodes[0].css.color = "blue-ish";
    writeFileSync(join(dir, "home__odd__light.cell.json"), JSON.stringify(nodeIssue));
    const r = readCaptureDir(dir);
    expect(r.cells.map((c) => c.state).sort()).toEqual(["default", "odd"]);
    expect(r.warnings.join("\n")).toMatch(/home__broken__light.cell.json: dropped, it does not follow the capture contract/);
    expect(r.warnings.join("\n")).toMatch(/home__garbage__light.cell.json: not valid JSON/);
    expect(r.warnings.join("\n")).toMatch(/capture contract: home__odd__light.cell.json: nodes\[0\]: color "blue-ish"/);
  });
});

describe("capture contract: accessibility sections", () => {
  it("checks targets and focus when a driver writes them", () => {
    const cell = structuredClone(androidCell) as any;
    cell.targets = [{ path: "p", label: "l", role: "button", box: { x: 0, y: 0, width: "48dp", height: 48 }, fill: "#ffffff", backdrop: "white-ish" }];
    cell.focus = { path: "p" };
    expect(validateCell(cell, "c")).toEqual([
      'c: targets[0]: "box" needs numeric x, y, width, height',
      'c: targets[0]: backdrop "white-ish": expected rgb(), rgba() or hex',
      'c: "focus" must be null or { focused, rest, … }',
    ]);
    cell.targets = [];
    cell.focus = null;
    expect(validateCell(cell)).toEqual([]);
  });
});
