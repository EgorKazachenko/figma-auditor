/** Shared data contracts. Every stage reads and writes these plain JSON-able shapes. */

export type Mode = string; // "light" | "dark" | any Figma mode name mapped in config

/** A token as defined by the design reference (Figma). */
export interface ReferenceToken {
  /** Normalised CSS custom property name, e.g. "--color-level-5", or a scale key such as "spacing_2". */
  name: string;
  /** Name exactly as Figma shows it, e.g. "var(--color-level-5)". */
  figmaName: string;
  kind: "color" | "number" | "font" | "effect" | "other";
  mode: Mode;
  /** Raw value as given by the source, e.g. "#f7f7f8", "4", "Font(...)". */
  value: string;
  source: { type: string; fileKey?: string; nodeId?: string; fileName?: string; url?: string };
}

/** A CSS custom property declaration found in the product's theme CSS. */
export interface CodeTokenDecl {
  name: string;
  /** Normalised name used to match Figma names. */
  key: string;
  selector: string;
  file: string;
  line: number;
  value: string;
  /** Browser-provided environment variable the value reads from, e.g. "-neon-color-elevation-5". */
  envName?: string;
  /** Fallback expression used when the browser does not provide envName. */
  fallback?: string;
}

/** How the product is rendered for one context (theme + colour scheme). */
export interface Context {
  name: string;
  html: Record<string, string>;
  colorScheme: "light" | "dark";
  /** Figma mode whose values apply to this context. */
  figmaMode: Mode;
  /** Colour behind translucent tokens when comparing them. */
  backdrop: string;
}

/** Value of each token after the browser resolved it in one context. */
export interface ResolvedTokens {
  context: string;
  /** "code" = resolved by plain Chromium (env() fallbacks); "runtime" = resolved inside the real product browser. */
  source: "code" | "runtime";
  browser: string;
  tokens: Record<string, { raw: string; color: string | null }>;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Layout facts measured in the page: geometry, hit-testing and clipping. */
export interface NodeLayout {
  /** Index of this node in the cell's node list. */
  id: number;
  /** Indices of collected nodes that contain this one (across shadow roots). */
  ancestors: number[];
  interactive: boolean;
  /** Inside a dialog, menu, listbox, tooltip, popover or a fixed layer: meant to cover other content. */
  overlay: boolean;
  role: string | null;
  scroll: { w: number; h: number; cw: number; ch: number };
  /** Share of the box not hidden by clipping ancestors (scroll containers excluded). */
  visibleFraction: number;
  /** Share of the box on screen now: scroll containers clip too (0 = scrolled out of view). */
  viewFraction?: number;
  textRects: Rect[];
  /** Five hit-test points inside the box and what was found on top of the element. */
  occlusion: { samples: number; covered: number; centerCovered: boolean; by: string[]; overlayOnly: boolean };
  /** Spacing per side as designed: padding plus the margin of the child nearest to that side. */
  insets: { top: number; right: number; bottom: number; left: number } | null;
  /** Distance from the inner border edge to the nearest child's content on each side, however it is made. */
  visualInsets?: { top: number; right: number; bottom: number; left: number } | null;
  /** Gaps between consecutive children of a start-aligned flex container and their make-up. */
  childGaps: { gap: number; axis: "x" | "y"; fromGap: number; marginA: number; marginB: number; a: string; b: string }[];
  /** For elements with their own text: text and backdrop colours as painted (opaque hex). */
  contrast?: TextColors;
}

export interface TextColors {
  fg: string;
  bg: string;
  /** Why the backdrop cannot be known from styles (image, gradient, filter, another element under the text); null when known. */
  bgUnknown: string | null;
}

/** One element that holds text, as a reader sees it. Collected for every text on the page, marked or not. */
export interface TextSample extends TextColors {
  path: string;
  /** Nearest ancestor with a test id, DS component or id, for grouping and for people. */
  anchor: string;
  text: string;
  box: { x: number; y: number; width: number; height: number };
  fontSize: number;
  fontWeight: number;
  disabled: boolean;
  viewFraction: number;
}

export interface SnapshotNode {
  component: string | null;
  testId: string | null;
  path: string;
  box: { x: number; y: number; width: number; height: number };
  hasText: boolean;
  text: string;
  css: Record<string, string>;
  /** Named selectors from the run (e.g. C7 mappings without a test id) that this element matches. */
  matches?: string[];
  layout?: NodeLayout;
}

/** Where a capture was taken: surface × state × context (× viewport when several are captured). */
export interface CellRef {
  surface: string;
  state: string;
  context: string;
  viewport?: string;
}

export interface SnapshotCell {
  surface: string;
  state: string;
  context: string;
  /** Viewport name when the run captures several sizes; absent for the first (default) viewport. */
  viewport?: string;
  url: string;
  browser: string;
  tokens: ResolvedTokens["tokens"];
  nodes: SnapshotNode[];
  page?: { scrollWidth: number; innerWidth: number; scrollHeight: number; innerHeight: number };
  screenshot?: string;
  /** Every text on the page with its painted colours (C8). Absent in captures from older probes. */
  texts?: TextSample[];
  /** Browser zoom the cell was rendered at (1.5 = 150%), when the matrix varies it. */
  zoom?: number;
  /** UI language the cell was rendered in, when the matrix varies it. */
  locale?: string;
  /** Every interactive element on screen (C9 target size and non-text contrast). */
  targets?: TargetSample[];
  /** The keyboard-focused element, focused and unfocused (C9 focus visible); null when nothing has keyboard focus. */
  focus?: FocusSample | null;
}

/** An interactive element as WCAG 2.5.8 and 1.4.11 need it. Colours are opaque hex as painted. */
export interface TargetSample {
  path: string;
  label: string;
  role: string;
  box: { x: number; y: number; width: number; height: number };
  /** A link inside a sentence: exempt from the target size rule. */
  inline: boolean;
  /** Visually hidden (sr-only, 1×1 px): nobody aims at it. */
  hidden: boolean;
  disabled: boolean;
  /** Reachable with the Tab key (tabIndex ≥ 0). */
  tabbable?: boolean;
  /** Inside a composite widget (menu, toolbar, listbox, …) that moves focus with arrow keys. */
  inWidget?: boolean;
  /** Text field: its boundary identifies it. */
  textEntry: boolean;
  hasText: boolean;
  backdrop: string;
  fill: string;
  border: { width: number; color: string } | null;
  /** Colour of the icon of a control without text, when it can be read. */
  icon: string | null;
  viewFraction: number;
  /** Indices of targets nested inside this one. */
  ancestorOf: number[];
}

export interface FocusLook {
  outlineStyle: string;
  outlineWidth: number;
  outlineColor: string;
  outlineOffset: number;
  boxShadow: string;
  border: { width: number; color: string } | null;
  fill: string;
  color: string;
  backdrop: string;
}

export interface FocusSample {
  path: string;
  label: string;
  box: { x: number; y: number; width: number; height: number };
  /**
   * "focus": the element measured focused and after blur; "label": a visually hidden control measured on its
   * label; "hidden": a visually hidden control without a label (nothing can show its focus);
   * "activedescendant": the active option vs a sibling option.
   */
  via: "focus" | "label" | "hidden" | "activedescendant";
  focused: FocusLook;
  rest: FocusLook | null;
  /** Hit-test of the focused element: covered by other content (WCAG 2.4.11)? */
  obscured: { samples: number; covered: number; centerCovered: boolean; by: string[]; overlayOnly: boolean };
}

export interface StaticHit {
  rule:
    | "hex-in-source"
    | "hex-in-css"
    | "tailwind-arbitrary-color"
    | "tailwind-arbitrary-spacing"
    | "tailwind-arbitrary-radius"
    | "tailwind-arbitrary-type"
    | "inline-style-spacing"
    | "inline-style-radius"
    | "css-spacing"
    | "css-radius"
    | "unknown-css-var";
  file: string;
  line: number;
  column: number;
  match: string;
  snippet: string;
  blame?: { commit: string; author?: string; time?: number };
  /** Inline `design-auditor-ignore` directive that covers this hit (category or rule, "*" for any). */
  suppress?: { category: string; reason: string };
}

export type Severity = "high" | "medium" | "low";
export type Gap = "A" | "B";

export interface Finding {
  id: string;
  fingerprint: string;
  check: "C1" | "C2" | "C3" | "C4" | "C5" | "C6" | "C7" | "C8" | "C9";
  category: string;
  gap: Gap;
  severity: Severity;
  title: string;
  component?: string | null;
  token?: string;
  context?: string;
  cell?: CellRef;
  property?: string;
  expected?: { value: string; source: string; token?: string };
  actual?: { value: string; source: string };
  deltaE?: number;
  related?: string[];
  links: { figma?: string; source?: string; commit?: string };
  evidence?: { swatches?: string[]; screenshot?: string; box?: SnapshotNode["box"]; diff?: string; baseline?: string };
  /** new/open come from history; accepted = in the accepted-debt list; suppressed = an inline or config suppression applies. */
  status?: "new" | "open" | "accepted" | "suppressed";
  /** Why the finding is suppressed and where the suppression lives. */
  suppressed?: { reason: string; source: "inline" | "config"; until?: string };
  /** Why it was accepted as existing debt. */
  accepted?: { reason?: string; at: string };
  firstSeen?: { commit?: string; at: string };
  /** How many identical elements produced this finding (e.g. repeated list items). */
  occurrences?: number;
}

export interface RunMeta {
  id: string;
  at: string;
  repo: string;
  commit?: string;
  configPath: string;
  checks: string[];
  browser?: string;
  /** Who acts on each gap: A = Figma ↔ design-system code, B = design system ↔ product. */
  owners?: { A: string; B: string };
}

/**
 * One thing to fix: findings that share check, category, element, property and value, wherever they were seen
 * (states, themes, widths, or several lines of a file). Findings keep their own fingerprints; issues are a view.
 */
export interface Issue {
  id: string;
  key: string;
  check: Finding["check"];
  category: string;
  gap: Gap;
  severity: Severity;
  /** new if any active member is new; accepted/suppressed only when every member is. */
  status: NonNullable<Finding["status"]>;
  title: string;
  component?: string | null;
  token?: string;
  property?: string;
  expected?: Finding["expected"];
  actual?: Finding["actual"];
  deltaE?: number;
  related?: string[];
  links: Finding["links"];
  findingIds: string[];
  /** Distinct states, themes, widths and surfaces the members were captured in (runtime checks). */
  seen: { cells: number; states: string[]; contexts: string[]; viewports: string[]; surfaces: string[]; places: string[] };
  /** "seen in 18 states · 2 themes · 2 widths", "3 places in Login.tsx". */
  seenText: string;
  evidence?: { screenshot?: string; box?: SnapshotNode["box"]; crop?: string; figmaImage?: string; swatches?: string[]; diff?: string };
  suppressed?: Finding["suppressed"];
  accepted?: Finding["accepted"];
}

export interface Report {
  meta: RunMeta;
  summary: {
    total: number;
    bySeverity: Record<Severity, number>;
    byCheck: Record<string, number>;
    new: number;
    fixed: number;
    /** Issue view: what a reviewer reads. Counts exclude accepted and suppressed issues. */
    issues?: number;
    issuesBySeverity?: Record<Severity, number>;
    accepted?: number;
    suppressed?: number;
  };
  issues?: Issue[];
  findings: Finding[];
  fixed: { fingerprint: string; title: string }[];
  groups: { key: string; title: string; findingIds: string[]; issueIds?: string[] }[];
  notes: string[];
}
