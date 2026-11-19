# design-auditor

Finds where a product drifts from its design system. It opens the product the way a user sees it, measures colours, spacing, component states and layout, and compares them with Figma. Every mismatch becomes an issue with an owner, a screenshot, and the commit that caused it.

It compares **measured values** (the colour a CSS variable resolves to, the padding an element really has, the contrast of a text against what is painted behind it), not pictures. Screenshots are kept only as evidence. Everything product-specific lives in one YAML file per product.

## Quick start

```bash
npm install
npm test                                                          # unit, real Chromium, fake harness, git scenarios
./bin/design-auditor.mjs run --config design-auditor.example.yaml   # static and token checks on the fixture product
open reports/latest/report.html
```

A real product gets its own config (copy `design-auditor.example.yaml`) and, for rendered checks, a way to open it: a URL (`runtime.driver: launch`) or the product's own Playwright suite (`runtime.driver: harness`, template in `examples/harness/capture.spec.ts`).

## What it checks

| Check | Gap | Compares | Finding when |
| --- | --- | --- | --- |
| **C1 · static** | B | Source vs the token set | hex colours in components, arbitrary Tailwind values (hex, `rgb()`, px, rem), inline style spacing, lengths in plain CSS, `var(--x)` that nothing defines |
| **C2 · token parity** | A | Figma variable vs the value the code resolves to, per theme; Figma vs itself | ΔE2000 > 2; a variable missing in code; two Figma variables exporting one CSS name; code syntax that is no CSS variable |
| **C3 · off-token values** | B | Rendered styles vs the theme's palette and scales | a colour matches no token; padding, margin, gap or radius off the scale |
| **C4 · component spec** | A | Designed spacing and how it is built | spacing differs from the spec, or matches but comes from margins instead of padding or gap |
| **C5 · layout integrity** | B | Geometry and hit-testing on screen | text over text, a control covered by another element, text cut off or cropped, sideways scroll |
| **C6 · layout regression** | B | Element boxes and screenshot vs the accepted build | moved, resized, appeared, disappeared, pixels changed elsewhere |
| **C7 · Figma component states** | A/B | Each Figma variant vs the element in the state that shows it, per theme | fill, stroke, radius, padding, gap, size, shadow or text differs; the same look from another token; a variant no state shows |
| **C8 · text contrast** | B | Every text as painted vs its composited backdrop | below WCAG 2.2 AA (4.5:1, or 3:1 for large text) |
| **C9 · accessibility** | B | Focus, target size, control boundaries | no visible focus, targets under 24 CSS px, control or icon contrast under 3:1 |

Gap A is Figma ↔ design-system code, gap B is design system ↔ product. `owners` in the config names the team for each, and the report is split by it.

How the comparison works:
- **Design values** come from Figma: the REST API (`figma-rest`: every variable of the listed files, aliases followed across files, the right mode picked per theme in each collection), Figma MCP captures, or W3C DTCG 2025.10 tokens. Component sets come from `design-auditor figma pull` with every variant and the variable each colour is bound to.
- **Code values** come from loading the theme CSS into Chromium per theme and resolving each variable on a real element, so `light-dark()`, `env()` fallbacks and theme overrides resolve exactly as the browser does.
- **Rendered values** come from a probe injected into each captured state. Drivers write cells in one contract (`src/contract.ts`: CSS property names with computed values), validated on read, so a native driver can feed the same checks.

## Commands

| Command | What it does |
| --- | --- |
| `run --config f [--checks all] [--runtime]` | Audit: report in `reports/<run>/` and `reports/latest/`. `--fail-on high` for CI, `--update-baseline` to accept the current layout |
| `mr --config f --base origin/main` | What a merge request adds: audits merge base and head (`git archive`, the checkout is untouched), pairs findings that moved with their code, names the commit that wrote each new one |
| `figma pull --config f` | Download Figma variables and the component sets listed under `reference.componentSources`, cached by file version |
| `figma suggest --config f` | Propose mappings from Figma components to captured elements, with the state that shows each variant |
| `eval --spec seeds.yaml` | Plant known defects in a throw-away copy (or inject CSS into captured states) and report recall, false alarms and negative controls |
| `compare --a run1 --b run2` | Parity of two captures, e.g. a framework rewrite against the original: styles, geometry and text per element |
| `accept --config f --reason "…"` | Accept current findings as debt: visible, never new, never failing a run |
| `state pull|push --config f` | Keep run history and layout baselines on a git branch shared by every machine and CI job |
| `triage --config f` | Ask Claude to label issues (regression, intended, existing debt, Figma-side, likely false positive) with a reason and a summary. Needs Claude API credentials; findings never depend on it |

## Memory

Every finding has a fingerprint built from what it is, not from line numbers: file, rule, value and occurrence for code; element, property, state and theme for the UI; token and theme for Figma. Editing nearby code does not make an old finding new.

- **Decisions** live in the repository and change through merge requests: the config (mappings, suppressions with a reason and an expiry, severity overrides) and the accepted-debt file.
- **Machine memory** lives on a git branch (`state.branch`, default `design-audit/state`, one folder per product): the run history (new, open, fixed, first-seen commit) and the C6 baselines.
- **Caches** (Figma downloads and renders, triage verdicts) stay in `.design-auditor/` and the CI cache.

A finding counts as fixed only when its check ran again and, for rendered checks, its screen was captured again.

## Noise control

Findings that share check, category, element, property and value become one **issue** ("seen in 18 states · 2 themes · 2 widths"). `accept` records existing debt; inline `design-auditor-ignore <rule> -- <reason>` comments and config `suppress` rules record agreed exceptions; `severity` overrides adjust or switch off a rule. The report shows issues to look at by default and lists the rest in notes.

## Measuring it

`eval` plants realistic defects (raw hex class, off-scale gap, a token typo, a token value just past the threshold, a lost hover, a covered link, faint text, a removed focus ring) and edits that change nothing visible. A defect counts as found only when a new finding names it; every other new finding is a false alarm. Keep a seeded-defect spec per product and run it when the checks change.

## CI

- `.github/workflows/test.yml`: types and tests for this tool.
- `ci/post-gitlab-comment.sh`: posts the `mr` comment to a GitLab merge request (prints it without a token).
- A typical setup: the `mr` command on every merge request (static and token checks, seconds), and a nightly `state pull` → `run --runtime --checks all` → `state push` on a runner with the product's browser.

Config paths take `${VAR}` and `${VAR:-default}`, so one config works on a laptop and in CI. Behind a corporate proxy, `NODE_USE_SYSTEM_CA=1` makes the launcher pass `--use-system-ca` to Node.

## Configuration

| Key | Meaning |
| --- | --- |
| `target` | Repository, theme entry CSS, Tailwind config, scan folders and excludes |
| `contexts` | One per theme: `<html>` attributes, colour scheme, Figma mode, backdrop for translucent colours |
| `reference.sources` | `figma-rest`, `figma-variable-defs`, `figma-rest-variables` or `dtcg` |
| `reference.components`, `componentSources` | Figma component sets for C7, and which to pull by name |
| `figmaComponents` | C7 mappings: Figma set → element (`[data-testid=…]` or any selector) → captured state per variant |
| `runtime` | `driver` (`launch` or `harness`), surfaces and states with actions, `viewports` (widths, zoom, locales), timeouts |
| `scales`, `thresholds` | Spacing and radius scales; ΔE, px tolerance, contrast ratios |
| `owners`, `suppress`, `severity`, `accepted`, `state` | Who acts on each gap; exceptions; severity overrides; accepted debt; the memory branch |

## Extending

`docs/extending.md` explains the two contracts the engine is built around (design sources in, captured cells in) and how to add a product, a design source, a code-token reader or a capture driver for another stack.

## Layout

```
src/
  cli.ts, commands.ts, pipeline.ts, config.ts, types.ts, contract.ts
  color.ts, names.ts, issues.ts, noise.ts, history.ts, triage.ts, findings.ts, baseline.ts, git.ts
  css/          theme CSS loader
  reference/    Figma MCP and REST adapters, DTCG, component sets
  figma/        variable graph, REST cache, pull, mapping suggestions
  static/       C1 scanner
  runtime/      launch and harness drivers, the in-page probe
  checks/       C1–C9
  eval/, ci/, compare/, state/, triage/, report/
examples/harness/   capture spec template for a product's Playwright suite
test/               unit, Chromium, harness, git and CLI tests with a synthetic fixture product
```
