# Extending design-auditor to other products and stacks

design-auditor is built as a pipeline of adapters around two stable contracts. A new product needs a config file; a new technology needs an adapter on one side of a contract. The checks in the middle do not change.

```
 design sources ──► ReferenceToken[] + FigmaComponentSet[] ─┐
 (Figma MCP, Figma REST, DTCG JSON, …)                      │
                                                            ├──► checks C1–C8 ──► findings ──► history, report
 code tokens   ──► CodeTokenDecl[] per context ─────────────┤
 (CSS custom properties, …)                                 │
                                                            │
 capture       ──► SnapshotCell[] ──────────────────────────┘
 (launch, harness, …)
```

## Where we are today

| Layer | Product-neutral? | Stack-neutral? | Adapters available |
| --- | --- | --- | --- |
| Design source | yes | yes | Figma MCP capture (`figma-variable-defs`), Figma REST variables, **W3C DTCG 2025.10 JSON** (`dtcg`: Tokens Studio, Style Dictionary v4, Figma/Penpot exports), Figma component sets (`reference.components`) |
| Code tokens | yes | **no**: CSS custom properties only | `themeCss` (follows `@import`, `light-dark()`, `env()` fallbacks, selector contexts) |
| Static rules (C1) | yes | **partly**: TSX/CSS/Tailwind patterns | `static/scanner.ts` |
| Capture | yes | web only | `launch` (any Chromium build, optional extension), `harness` (any Playwright suite of the product) |
| Checks C2–C8 | yes | yes, through the capture contract (CSS property names as the style vocabulary) | — |
| Findings, history, report | yes | yes | — |

`src/` contains no product names, test ids, flags or paths; everything about a product lives in its config file, its Figma reference files, its harness spec and its seeded-defect spec. What is still web-specific: the code-token reader (CSS custom properties, with `env()`/`data-*` theme handling), the C1 rule pack (TSX/CSS/Tailwind) and the two web drivers. Checks themselves are stack-neutral through the capture contract.

## Adding a product on the same stack (web)

1. Copy `design-auditor.example.yaml`, set `target` (repo, theme entry, scan globs), `contexts` (themes: html attributes, colour scheme, Figma mode).
2. Point `reference.sources` at the product's design tokens: Figma captures or a DTCG export per mode.
3. Choose a capture driver:
   - `launch` for anything a plain browser can open (a URL, a Storybook, an extension page);
   - `harness` when states need the product's own test fixtures (login, mocks, flags). Copy `examples/harness/capture.spec.ts`, replace its product hooks (open the surface, login, flags) with the product's fixtures, keep the capture-spec contract (env vars `DESIGN_AUDITOR_OUT`, `_PROBE`, `_SPEC`; one `<surface>__<state>__<context>.cell.json` per cell).
4. For C7, capture the product's Figma component sets and map them in `figmaComponents`.

Framework does not matter on the web: React, Svelte, Vue, Lit and server-rendered pages all end up as DOM and computed styles. A framework rewrite needs no change to the tool, and `compare` checks the rewrite against the original build.

## Adding a stack: the three adapters

### 1. The capture contract (what every driver writes)

Checks read only `SnapshotCell` (`src/types.ts`); the contract is spelled out and validated in `src/contract.ts`:

- **Style vocabulary = CSS property names with computed-value syntax** (`background-color: rgb(…)`, `padding-left: 16px`, `border-top-left-radius`, `font-size`, `box-shadow`, `-webkit-line-clamp`…). They are a published standard, React Native and most design-to-code tools already use them, and the checks and finding fingerprints stay unchanged. `STYLE_PROPERTIES` lists every property with its value kind and the checks that read it.
- **Units** are layout units in px: CSS px, Android dp and iOS pt all equal Figma units, so a native driver writes `16px` for 16 dp.
- **Colours** are `rgb()`/`rgba()` or hex; ARGB from Android and `UIColor` components convert directly.
- A driver that cannot provide a property omits it and the checks that need it skip it; extra properties of its own are allowed.
- `validateCell()` runs on every cell the harness reads: cells that break the contract are dropped with the reason, smaller problems become warnings, so a new driver learns what is wrong instead of getting silently fewer findings. `test/contract.test.ts` contains an Android-style cell that passes.

Mapping examples for native drivers:

| Contract property | Android (View / Compose) | iOS (UIKit / SwiftUI) | Flutter |
| --- | --- | --- | --- |
| `background-color` | `background` drawable colour / `Modifier.background` | `backgroundColor` | `BoxDecoration.color` |
| `color` | `TextView.currentTextColor` / `TextStyle.color` | `UILabel.textColor` | `TextStyle.color` |
| `padding-*` | `paddingLeft` (px ÷ density) / `Modifier.padding` | `layoutMargins`, `directionalLayoutMargins` | `RenderPadding.padding` |
| `border-*-radius` | `ShapeAppearance` / `RoundedCornerShape` | `layer.cornerRadius` | `BorderRadius` |
| `font-size`, `font-weight` | `textSize` ÷ scaledDensity, `Typeface` | `UIFont.pointSize`, weight trait | `TextStyle.fontSize/fontWeight` |
| `-webkit-line-clamp`, `text-overflow` | `maxLines`, `ellipsize` | `numberOfLines`, `lineBreakMode` | `maxLines`, `overflow` |
| `box-shadow` | `elevation` (approximate) | `layer.shadow*` | `BoxShadow` |

Layout facts (`node.layout`: occlusion, clipping, insets, text rects, contrast colours) are optional; C5 and C8 run only where a driver provides them.

### 2. Code token sources

| Stack | Where tokens live | Adapter to add | Context (dark mode) |
| --- | --- | --- | --- |
| Web, CSS variables | `themes.css` | done | selectors, `light-dark()`, `prefers-color-scheme` |
| Web, Sass/LESS | `_tokens.scss` | compile with the product's toolchain, then the CSS adapter | — |
| Any, Style Dictionary | `tokens/*.json` (DTCG) | the `dtcg` adapter, used as code tokens instead of reference | one file per mode |
| Android | `res/values/colors.xml`, `res/values-night/colors.xml`, `themes.xml`, Compose `Color.kt` | XML resource reader; Compose theme via its generated tokens | `-night` qualifier |
| iOS | `*.xcassets/*.colorset/Contents.json`, Swift token enums | asset catalogue reader | `appearances: luminosity dark` |
| Flutter | `ThemeData` in Dart, often generated from DTCG | DTCG adapter on the generator input | `ThemeMode.dark` |

The `CodeTokenDecl` contract (name, value expression, context selector, file, line) already fits all of them; "selector" becomes the qualifier (`values-night`, `appearance=dark`).

### 3. Capture drivers (produce `SnapshotCell`)

| Stack | Driver | What the in-app probe walks | Identity used for `testId` |
| --- | --- | --- | --- |
| Web (any framework) | done: `launch`, `harness` | DOM, `getComputedStyle`, `elementFromPoint` | `data-testid`, `data-ds-component` |
| Storybook | `launch` over story URLs, one state per story/args | DOM | story id + `data-testid` — maps 1:1 to Figma variants, so C7 coverage is free |
| Electron, WebViews | `harness` with the app's Playwright/WebDriver setup | DOM | same as web |
| Android (Views/Compose) | instrumented test (Espresso / Compose UI test) that runs a debug-only probe and writes cells | View tree: `background`, `paddingX`, `textColors`; Compose: semantics + a `Modifier.designAudit()` tag that records resolved theme values | `resource-id`, `testTag` |
| iOS (UIKit/SwiftUI) | XCUITest launching a debug build with an in-app probe | `UIView` tree: `backgroundColor`, `layer.cornerRadius`, `layoutMargins`, `UIFont`; SwiftUI through hosting views or explicit `.designAudit()` modifiers | `accessibilityIdentifier` |
| Flutter | `integration_test` + probe over the `RenderObject` tree | `RenderDecoratedBox`, `RenderPadding`, `RenderParagraph` | `Key` / semantics label |

Native platforms do not expose resolved styles through their accessibility trees, so a small debug-only probe library inside the app is required; the harness pattern (run the product's own tests, read cell files) stays the same. Hit-testing for C5 maps to `hitTest` (iOS), `findViewAt`/semantics bounds (Android), `HitTestResult` (Flutter).

### Static rule packs (C1)

Same rule ids, per-language patterns:

| Rule | Web (now) | Kotlin | Swift | Dart |
| --- | --- | --- | --- | --- |
| hex colour in UI code | `#1877d7` in `.tsx`, `bg-[#…]` | `Color(0xFF1877D7)` | `Color(red:green:blue:)`, `UIColor(red:…)` | `Color(0xFF1877D7)` |
| off-scale spacing | `p-[10px]`, `padding: 10px` | `padding(10.dp)` | `.padding(10)` | `EdgeInsets.all(10)` |
| unknown token | `var(--x)` defined nowhere | `R.color.x` missing | `Color("x")` not in catalogue | `AppColors.x` missing |

## Order that pays off first

1. Done: the capture contract and its validator; DTCG as a design source; seeded-defect evaluation (`design-auditor eval`) and the MR check (`design-auditor mr`).
2. Storybook driver: cheapest full state coverage for any web product that has stories.
3. Code tokens from DTCG / Style Dictionary (many products generate CSS, Android and iOS from one JSON; checking that JSON covers all three platforms' token parity at once).
4. One native driver, chosen by the next product that needs it.

## Proving it works on a new product

Practitioners who validated similar tools published the same lesson: a percentage is only credible with a fixture and negative controls. For each new product, keep a seeded-defect branch (a few deliberate drifts: wrong token, off-scale padding, overlap, missing hover) and record precision and recall per check before trusting the numbers.
