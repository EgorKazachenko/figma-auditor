// Runs inside the page under test. Plain JavaScript on purpose: it is injected as text,
// so no bundler helper can leak into it. Exposes window.__designAuditor.
(() => {
  if (window.__designAuditor) return;

  // A colour no real token uses; a probe that inherits it means the token is not a colour.
  const SENTINEL = "rgba(1, 2, 3, 0.5)";
  // Elements that are meant to sit on top of other content.
  const OVERLAY_SELECTOR =
    '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[role="tooltip"],[aria-modal="true"],[popover],dialog';
  const INTERACTIVE_SELECTOR =
    'a[href],button,input,select,textarea,[role="button"],[role="link"],[role="menuitem"],[role="option"],[role="tab"],[tabindex]:not([tabindex="-1"])';

  const r1 = (n) => Math.round(n * 10) / 10;

  /** Resolves each custom property to a colour by applying it to a real `color` property. */
  function resolveTokens(names) {
    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "position:absolute;left:-10000px;top:0;width:1px;height:1px;overflow:hidden;color:" + SENTINEL;
    const probe = document.createElement("span");
    host.appendChild(probe);
    (document.body || document.documentElement).appendChild(host);
    const sentinel = getComputedStyle(host).color;
    const root = getComputedStyle(document.documentElement);
    const out = {};
    for (const name of names) {
      const raw = root.getPropertyValue(name).trim();
      if (!raw) {
        out[name] = { raw: "", color: null };
        continue;
      }
      probe.style.color = "";
      probe.style.color = "var(" + name + ")";
      const color = getComputedStyle(probe).color;
      out[name] = { raw, color: color === sentinel ? null : color };
    }
    host.remove();
    return out;
  }

  /** Parent across shadow boundaries: a shadow root's child continues at its host. */
  function composedParent(n) {
    const p = n.parentNode;
    if (!p) return null;
    return p.nodeType === 11 ? p.host : p;
  }

  function composedContains(a, b) {
    for (let n = b; n; n = composedParent(n)) if (n === a) return true;
    return false;
  }

  // Ids generated per render (React useId ":r1:" / "_r_24_" / "«r1»", Radix, Headless UI, MUI, uuids)
  // change between runs, so they cannot anchor a stable path.
  const GENERATED_ID = /^([:«_]r[0-9a-z]+[:»_]|_r_[0-9a-z]+_|radix-|headlessui-|mui-\d|floating-ui-|react-aria\d|[0-9a-f]{8}-[0-9a-f]{4}-)|\d{4,}/i;

  function label(el) {
    const ds = el.getAttribute("data-ds-component");
    if (ds) return el.localName + '[data-ds-component="' + ds + '"]';
    const tid = el.getAttribute("data-testid");
    if (tid) return el.localName + '[data-testid="' + tid + '"]';
    if (el.id && !GENERATED_ID.test(el.id)) return el.localName + "#" + el.id;
    return null;
  }

  /** Short, stable path: walks up to the nearest anchored ancestor (test id, DS component or id). */
  function pathOf(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      const anchored = label(node);
      if (anchored) {
        parts.unshift(anchored);
        break;
      }
      let part = node.localName;
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.localName === node.localName);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      if (parent) node = parent;
      else {
        const root = node.getRootNode();
        node = root && root.host ? root.host : null;
        if (node) parts.unshift("::shadow");
      }
    }
    return parts.join(" > ");
  }

  function gather(root, selector, out) {
    root.querySelectorAll(selector).forEach((e) => out.push(e));
    root.querySelectorAll("*").forEach((e) => {
      if (e.shadowRoot) gather(e.shadowRoot, selector, out);
    });
    return out;
  }

  function visible(el) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (!(r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0)) return false;
    // A wrapper at opacity 0 hides everything inside it (show/hide by fading).
    for (let n = composedParent(el); n && n.nodeType === 1; n = composedParent(n)) if (Number(getComputedStyle(n).opacity) === 0) return false;
    return true;
  }

  function hasOwnText(el) {
    for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) return true;
    return false;
  }

  /** Boxes of the element's own text, line by line. */
  function textRects(el) {
    const out = [];
    for (const n of el.childNodes) {
      if (n.nodeType !== 3 || !n.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects())
        if (r.width > 0 && r.height > 0) out.push({ x: r1(r.left), y: r1(r.top), w: r1(r.width), h: r1(r.height) });
    }
    return out;
  }

  /** Deepest element at a point, entering open shadow roots. */
  function topAt(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  function isOverlay(el) {
    for (let n = el; n && n.nodeType === 1; n = composedParent(n)) {
      if (n.matches(OVERLAY_SELECTOR)) return true;
      if (getComputedStyle(n).position === "fixed") return true;
    }
    return false;
  }

  function nearestLabel(el) {
    for (let n = el; n && n.nodeType === 1; n = composedParent(n)) {
      const l = label(n);
      if (l) return l;
    }
    return pathOf(el);
  }

  /** Its own <label> on top of a form control forwards clicks to it (visually hidden file inputs). */
  function isOwnLabel(el, t) {
    const labels = el.labels ? Array.from(el.labels) : [];
    return labels.some((l) => l === t || composedContains(l, t));
  }

  /**
   * Hit-tests five points inside the part of the box left visible by every clipping ancestor, scroll
   * containers included (content scrolled out of view cannot be covered).
   */
  function occlusion(el, r, view) {
    const points = [
      [0.5, 0.5],
      [0.25, 0.25],
      [0.75, 0.25],
      [0.25, 0.75],
      [0.75, 0.75],
    ];
    let samples = 0;
    let covered = 0;
    let centerCovered = false;
    let allOverlay = true;
    const by = [];
    points.forEach(([fx, fy], i) => {
      const x = r.left + r.width * fx;
      const y = r.top + r.height * fy;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return;
      if (x < view.x1 || x >= view.x2 || y < view.y1 || y >= view.y2) return;
      samples++;
      const t = topAt(x, y);
      if (!t || t === el || composedContains(el, t) || composedContains(t, el) || isOwnLabel(el, t)) return;
      covered++;
      if (i === 0) centerCovered = true;
      const l = nearestLabel(t);
      if (!by.includes(l)) by.push(l);
      if (!isOverlay(t)) allOverlay = false;
    });
    return { samples, covered, centerCovered, by, overlayOnly: covered > 0 && allOverlay };
  }

  /**
   * Region left visible by ancestors that clip (overflow hidden or clip).
   * Climbing stops at the first scroll container: content scrolled out of view is not a defect.
   */
  function clipRect(el, throughScrollers) {
    let x1 = -Infinity, y1 = -Infinity, x2 = Infinity, y2 = Infinity;
    for (let n = composedParent(el); n && n.nodeType === 1; n = composedParent(n)) {
      if (n === document.body || n === document.documentElement) break;
      const cs = getComputedStyle(n);
      if (/auto|scroll/.test(cs.overflowX) || /auto|scroll/.test(cs.overflowY)) {
        if (!throughScrollers) break;
        const p = n.getBoundingClientRect();
        x1 = Math.max(x1, p.left);
        x2 = Math.min(x2, p.right);
        y1 = Math.max(y1, p.top);
        y2 = Math.min(y2, p.bottom);
        continue;
      }
      const clipsX = cs.overflowX === "hidden" || cs.overflowX === "clip";
      const clipsY = cs.overflowY === "hidden" || cs.overflowY === "clip";
      if (!clipsX && !clipsY) continue;
      const p = n.getBoundingClientRect();
      if (clipsX) {
        x1 = Math.max(x1, p.left);
        x2 = Math.min(x2, p.right);
      }
      if (clipsY) {
        y1 = Math.max(y1, p.top);
        y2 = Math.min(y2, p.bottom);
      }
    }
    return { x1, y1, x2, y2 };
  }

  function visibleFraction(r, clip) {
    if (r.width <= 0 || r.height <= 0) return 0;
    const w = Math.max(0, Math.min(r.right, clip.x2) - Math.max(r.left, clip.x1));
    const h = Math.max(0, Math.min(r.bottom, clip.y2) - Math.max(r.top, clip.y1));
    return Math.round(((w * h) / (r.width * r.height)) * 1000) / 1000;
  }

  /** Text boxes cut to what is actually visible, so hidden overflow cannot collide with anything. */
  function clipRects(rects, clip) {
    const out = [];
    for (const t of rects) {
      const x1 = Math.max(t.x, clip.x1), y1 = Math.max(t.y, clip.y1);
      const x2 = Math.min(t.x + t.w, clip.x2), y2 = Math.min(t.y + t.h, clip.y2);
      if (x2 > x1 && y2 > y1) out.push({ x: r1(x1), y: r1(y1), w: r1(x2 - x1), h: r1(y2 - y1) });
    }
    return out;
  }

  function flowChildren(el) {
    return Array.from(el.children).filter((c) => {
      const cs = getComputedStyle(c);
      const cr = c.getBoundingClientRect();
      return cr.width > 0 && cr.height > 0 && cs.display !== "none" && cs.visibility !== "hidden" && cs.position !== "absolute" && cs.position !== "fixed";
    });
  }

  /**
   * Spacing on each side as the design defines it: the container's padding plus the margin of the child
   * nearest to that side. Free space and alignment do not count, so "padding 8px" and "child margin 8px"
   * give the same number while the computed padding tells them apart.
   */
  function insetsOf(el, r, cs) {
    const kids = flowChildren(el);
    if (!kids.length) return null;
    const out = {};
    for (const [side, S] of [["top", "Top"], ["right", "Right"], ["bottom", "Bottom"], ["left", "Left"]]) {
      let nearest = null;
      let best = Infinity;
      for (const k of kids) {
        const kr = k.getBoundingClientRect();
        const d = side === "top" ? kr.top - r.top : side === "bottom" ? r.bottom - kr.bottom : side === "left" ? kr.left - r.left : r.right - kr.right;
        if (d < best) {
          best = d;
          nearest = k;
        }
      }
      const margin = Math.max(0, parseFloat(getComputedStyle(nearest)["margin" + S]) || 0);
      out[side] = r1((parseFloat(cs["padding" + S]) || 0) + margin);
    }
    return out;
  }

  /**
   * What a reader sees: distance from the inner border edge to the nearest child's box on each side,
   * whatever makes it (padding, margin, free space, the child's own box). Compared with insets it tells
   * "looks like the design" apart from "is built like the design".
   */
  function visualInsetsOf(el, r, cs) {
    const kids = flowChildren(el);
    if (!kids.length) return null;
    const out = {};
    for (const [side, S] of [["top", "Top"], ["right", "Right"], ["bottom", "Bottom"], ["left", "Left"]]) {
      let best = Infinity;
      for (const k of kids) {
        // the child's content: its own padding counts as space too
        const kr = k.getBoundingClientRect();
        const kcs = getComputedStyle(k);
        const inner = (p) => parseFloat(kcs["padding" + p]) || 0;
        const d =
          side === "top" ? kr.top + inner("Top") - r.top : side === "bottom" ? r.bottom - kr.bottom + inner("Bottom") : side === "left" ? kr.left + inner("Left") - r.left : r.right - kr.right + inner("Right");
        best = Math.min(best, d);
      }
      out[side] = r1(best - (parseFloat(cs["border" + S + "Width"]) || 0));
    }
    return out;
  }

  /** Gaps between consecutive children of a start-aligned flex container, with what they are made of. */
  function gapsOf(el, cs) {
    if (!/flex/.test(cs.display)) return [];
    if (!["normal", "flex-start", "start", "left", "stretch"].includes(cs.justifyContent)) return [];
    const row = cs.flexDirection.startsWith("row");
    const kids = flowChildren(el);
    const out = [];
    for (let i = 1; i < kids.length; i++) {
      const a = kids[i - 1].getBoundingClientRect();
      const b = kids[i].getBoundingClientRect();
      const g = row ? b.left - a.right : b.top - a.bottom;
      if (g < -0.5) continue; // wrapped onto a new line or reversed
      const ca = getComputedStyle(kids[i - 1]);
      const cb = getComputedStyle(kids[i]);
      out.push({
        gap: r1(g),
        axis: row ? "x" : "y",
        fromGap: parseFloat(row ? cs.columnGap : cs.rowGap) || 0,
        marginA: parseFloat(row ? ca.marginRight : ca.marginBottom) || 0,
        marginB: parseFloat(row ? cb.marginLeft : cb.marginTop) || 0,
        a: label(kids[i - 1]) || kids[i - 1].localName + " " + i,
        b: label(kids[i]) || kids[i].localName + " " + (i + 1),
      });
    }
    return out;
  }

  /**
   * Computed styles and layout facts of every visible element matching `selector`, including open shadow roots.
   * Content inside <svg> (illustrations, icon internals) is skipped unless options.insideSvg is true.
   * Elements fully hidden by a clipping ancestor (e.g. off-screen carousel slides) are skipped.
   */
  function collect(selector, props, options) {
    const insideSvg = Boolean(options && options.insideSvg);
    // Named selectors (e.g. C7 mappings without a test id): each node lists the ones it matches.
    const named = Object.entries((options && options.match) || {});
    const els = gather(document, selector, [])
      .filter((el) => insideSvg || !(el.parentElement && el.parentElement.closest("svg")))
      .filter(visible);
    const rows = [];
    const kept = [];
    for (const el of els) {
      const r = el.getBoundingClientRect();
      const clip = clipRect(el, false);
      const fraction = visibleFraction(r, clip);
      if (fraction === 0) continue;
      // What is on screen right now: scroll containers clip too.
      const view = clipRect(el, true);
      const cs = getComputedStyle(el);
      const css = {};
      for (const p of props) css[p] = cs.getPropertyValue(p);
      kept.push(el);
      rows.push({
        component: el.getAttribute("data-ds-component"),
        testId: el.getAttribute("data-testid"),
        path: pathOf(el),
        box: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
        hasText: hasOwnText(el),
        text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60),
        css,
        matches: named.length ? named.filter(([, sel]) => safeMatches(el, sel)).map(([k]) => k) : undefined,
        layout: {
          id: rows.length,
          ancestors: [],
          interactive: el.matches(INTERACTIVE_SELECTOR),
          overlay: isOverlay(el),
          role: el.getAttribute("role"),
          scroll: { w: el.scrollWidth, h: el.scrollHeight, cw: el.clientWidth, ch: el.clientHeight },
          visibleFraction: fraction,
          viewFraction: visibleFraction(r, view),
          textRects: clipRects(textRects(el), view),
          occlusion:
            cs.opacity === "0"
              ? { samples: 0, covered: 0, centerCovered: false, by: [], overlayOnly: false }
              : occlusion(el, r, view),
          insets: insetsOf(el, r, cs),
          visualInsets: visualInsetsOf(el, r, cs),
          childGaps: gapsOf(el, cs),
          contrast: hasOwnText(el) ? textColors(el, textRect(el)) : undefined,
        },
      });
    }
    for (let i = 0; i < kept.length; i++)
      for (let j = 0; j < kept.length; j++) if (i !== j && composedContains(kept[j], kept[i])) rows[i].layout.ancestors.push(j);
    return rows;
  }

  // ---------------------------------------------------------------- contrast

  function rgba(css) {
    const m = /rgba?\(([^)]+)\)/.exec(css || "");
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
    if (p.length < 3 || p.some((v) => Number.isNaN(v))) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  const over = (top, back, alpha) => {
    const a = (top.a == null ? 1 : top.a) * (alpha == null ? 1 : alpha);
    return { r: top.r * a + back.r * (1 - a), g: top.g * a + back.g * (1 - a), b: top.b * a + back.b * (1 - a), a: 1 };
  };
  const hex = (c) => "#" + [c.r, c.g, c.b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");

  /** The canvas colour of the page in its used colour scheme (what shows through when nothing paints). */
  function canvasColor() {
    const root = getComputedStyle(document.documentElement).backgroundColor;
    const rc = rgba(root);
    if (rc && rc.a >= 1) return rc;
    const t = document.createElement("div");
    t.style.cssText = "position:absolute;left:-10000px;background-color:Canvas";
    (document.body || document.documentElement).appendChild(t);
    const c = rgba(getComputedStyle(t).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
    t.remove();
    return c;
  }

  /**
   * Text colour and the colour behind it as painted: ancestors' backgrounds composited bottom-up, each
   * ancestor's opacity applied to everything it contains. `bgUnknown` names what makes the backdrop
   * unknowable from styles alone: an image or gradient, a filter or blend mode, or another element
   * painted between the text and its own backgrounds (checked by hit-testing the text's centre).
   */
  function textColors(el, rect) {
    const chain = [];
    for (let n = el; n && n.nodeType === 1; n = composedParent(n)) chain.unshift(n);
    let unknown = null;
    for (const n of chain) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== "none") unknown = unknown || "background image or gradient on " + (label(n) || n.localName);
      if (cs.filter && cs.filter !== "none") unknown = unknown || "filter on " + (label(n) || n.localName);
      if (cs.backdropFilter && cs.backdropFilter !== "none") unknown = unknown || "backdrop-filter on " + (label(n) || n.localName);
      if (cs.mixBlendMode && cs.mixBlendMode !== "normal") unknown = unknown || "blend mode on " + (label(n) || n.localName);
    }
    const canvas = canvasColor();
    // Walk down from the root: each node paints its background on what is below it; opacity < 1
    // blends the node's whole subtree with what was below it.
    function render(i, below) {
      const n = chain[i];
      const cs = getComputedStyle(n);
      const bg = rgba(cs.backgroundColor);
      const inside = bg && bg.a > 0 ? over(bg, below) : below;
      let pair;
      if (i === chain.length - 1) {
        const fg = rgba(cs.color) || { r: 0, g: 0, b: 0, a: 1 };
        pair = { fg: over(fg, inside), bg: inside };
      } else pair = render(i + 1, inside);
      const op = Number(cs.opacity);
      if (op < 1) pair = { fg: over(pair.fg, below, op), bg: over(pair.bg, below, op) };
      return pair;
    }
    const pair = render(0, canvas);
    // Something that is not an ancestor painted under the text? Then ancestors do not tell the backdrop.
    if (!unknown && rect && rect.width > 0 && rect.height > 0) {
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      if (x >= 0 && y >= 0 && x < innerWidth && y < innerHeight && document.elementsFromPoint) {
        const stack = document.elementsFromPoint(x, y);
        const at = stack.indexOf(el);
        const under = at >= 0 ? stack.slice(at + 1) : [];
        for (const u of under) {
          if (composedContains(u, el)) {
            const ucs = getComputedStyle(u);
            const ub = rgba(ucs.backgroundColor);
            if (ub && ub.a >= 1 && ucs.opacity === "1") break; // an opaque ancestor: nothing below matters
            continue;
          }
          const ucs = getComputedStyle(u);
          const ub = rgba(ucs.backgroundColor);
          if ((ub && ub.a > 0) || (ucs.backgroundImage && ucs.backgroundImage !== "none") || u.localName === "img" || u.localName === "video" || u.localName === "canvas") {
            unknown = "painted over " + (label(u) || pathOf(u));
            break;
          }
        }
      }
    }
    return { fg: hex(pair.fg), bg: hex(pair.bg), bgUnknown: unknown };
  }

  function isDisabled(el) {
    return Boolean(el.closest('[disabled],[aria-disabled="true"],:disabled'));
  }

  function textRect(el) {
    const rects = textRects(el);
    if (!rects.length) return null;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const t of rects) {
      x1 = Math.min(x1, t.x); y1 = Math.min(y1, t.y); x2 = Math.max(x2, t.x + t.w); y2 = Math.max(y2, t.y + t.h);
    }
    return { left: x1, top: y1, width: x2 - x1, height: y2 - y1, right: x2, bottom: y2 };
  }

  function walkTextParents(root, out, seen, insideSvg) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const p = t.parentElement;
      if (!p || seen.has(p) || !t.textContent.trim()) continue;
      if (/^(script|style|noscript|template|title)$/.test(p.localName)) continue;
      if (!insideSvg && p.closest("svg")) continue;
      seen.add(p);
      out.push(p);
    }
    root.querySelectorAll("*").forEach((e) => {
      if (e.shadowRoot) walkTextParents(e.shadowRoot, out, seen, insideSvg);
    });
    return out;
  }

  /**
   * Every element on the page that holds text, with the colours a reader sees: the input for the
   * contrast check. Independent of the collect selector, so unmarked text is covered too.
   */
  function texts(options) {
    const insideSvg = Boolean(options && options.insideSvg);
    const limit = (options && options.limit) || 3000;
    const out = [];
    for (const el of walkTextParents(document, [], new Set(), insideSvg)) {
      if (out.length >= limit) break;
      if (!visible(el)) continue;
      const r = textRect(el);
      if (!r) continue;
      const view = clipRect(el, true);
      const viewFraction = visibleFraction(r, view);
      if (viewFraction === 0) continue;
      const cs = getComputedStyle(el);
      const c = textColors(el, r);
      out.push({
        path: pathOf(el),
        anchor: nearestLabel(el),
        text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60),
        box: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
        fontSize: parseFloat(cs.fontSize),
        fontWeight: Number(cs.fontWeight) || 400,
        fg: c.fg,
        bg: c.bg,
        bgUnknown: c.bgUnknown,
        disabled: isDisabled(el),
        viewFraction: viewFraction,
      });
    }
    return out;
  }

  // ---------------------------------------------------------------- accessibility (C9)

  /** Colour painted behind an element: its ancestors' backgrounds composited with their opacity. */
  function backdropOf(el) {
    const chain = [];
    for (let n = composedParent(el); n && n.nodeType === 1; n = composedParent(n)) chain.unshift(n);
    let below = canvasColor();
    for (const n of chain) {
      const cs = getComputedStyle(n);
      const bg = rgba(cs.backgroundColor);
      const op = Number(cs.opacity);
      if (bg && bg.a > 0) below = over(bg, below, op < 1 ? op : 1);
    }
    return below;
  }

  /** The element's own fill as painted on its backdrop (the backdrop when it paints nothing). */
  function fillOf(el, backdrop) {
    const cs = getComputedStyle(el);
    const bg = rgba(cs.backgroundColor);
    return bg && bg.a > 0 ? over(bg, backdrop) : backdrop;
  }

  const TEXT_ENTRY = 'input:not([type]),input[type="text"],input[type="search"],input[type="email"],input[type="url"],input[type="tel"],input[type="password"],input[type="number"],textarea,[contenteditable=""],[contenteditable="true"],[role="textbox"],[role="searchbox"],[role="combobox"]';

  /** Widest visible border: its colour composited on the element's fill, or null. */
  function borderOf(el, under) {
    const cs = getComputedStyle(el);
    let best = null;
    for (const side of ["top", "right", "bottom", "left"]) {
      const w = parseFloat(cs.getPropertyValue("border-" + side + "-width")) || 0;
      const style = cs.getPropertyValue("border-" + side + "-style");
      const c = rgba(cs.getPropertyValue("border-" + side + "-color"));
      if (w < 1 || style === "none" || style === "hidden" || !c || c.a === 0) continue;
      if (!best || w > best.width) best = { width: w, color: hex(over(c, under)) };
    }
    return best;
  }

  /** Colour of the first visible icon stroke or fill inside an element (SVG or icon font glyph). */
  function iconColorOf(el, under) {
    const shapes = el.querySelectorAll("svg path, svg circle, svg rect, svg line, svg polyline, svg polygon, svg ellipse");
    for (const sh of shapes) {
      const r = sh.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const cs = getComputedStyle(sh);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      for (const prop of ["stroke", "fill"]) {
        const c = rgba(cs.getPropertyValue(prop));
        const op = Number(cs.getPropertyValue(prop + "-opacity") || 1) * Number(cs.opacity || 1);
        if (c && c.a > 0 && op > 0) return hex(over(c, under, op));
      }
    }
    // Icons painted as a CSS mask over a background colour (common for themable icon sets).
    for (const n of [el, ...el.querySelectorAll("*")]) {
      const cs = getComputedStyle(n);
      const mask = cs.maskImage || cs.webkitMaskImage || cs.getPropertyValue("-webkit-mask-image");
      if (!mask || mask === "none") continue;
      const r = n.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const c = rgba(cs.backgroundColor);
      if (c && c.a > 0) return hex(over(c, under, Number(cs.opacity || 1)));
    }
    return null; // raster or font icon: colour unknown
  }

  /**
   * Every interactive element on screen with what WCAG 2.5.8 (target size) and 1.4.11 (non-text contrast)
   * need: box, whether it is an inline link in text, disabled or visually hidden, and its boundary and icon
   * colours against what is behind it.
   */
  function targets() {
    const out = [];
    const seen = new Set();
    for (const el of gather(document, INTERACTIVE_SELECTOR, [])) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      const view = clipRect(el, true);
      const viewFraction = visibleFraction(r, view);
      if (viewFraction === 0) continue;
      const cs = getComputedStyle(el);
      const parent = composedParent(el);
      const inline = el.localName === "a" && cs.display === "inline" && Boolean(parent && hasOwnText(parent));
      const hidden = (r.width <= 2 && r.height <= 2) || cs.clipPath === "inset(50%)" || /rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)/.test(cs.clip || "");
      const backdrop = backdropOf(el);
      const fill = fillOf(el, backdrop);
      const text = (el.innerText || el.value || "").trim();
      out.push({
        path: pathOf(el),
        label: nearestLabel(el),
        role: el.getAttribute("role") || el.localName,
        box: { x: r1(r.x), y: r1(r.y), width: r1(r.width), height: r1(r.height) },
        inline: inline,
        hidden: hidden,
        disabled: isDisabled(el),
        // Reachable with Tab; controls inside composite widgets (menus, toolbars, …) use roving focus instead.
        tabbable: el.tabIndex >= 0 && !el.closest("[inert]"),
        inWidget: Boolean(el.parentElement && el.parentElement.closest('[role="menu"],[role="menubar"],[role="listbox"],[role="grid"],[role="tablist"],[role="toolbar"],[role="radiogroup"],[role="tree"],[role="treegrid"]')),
        textEntry: el.matches(TEXT_ENTRY),
        hasText: text.length > 0,
        backdrop: hex(backdrop),
        fill: hex(fill),
        border: borderOf(el, fill),
        icon: text ? null : iconColorOf(el, fill),
        viewFraction: viewFraction,
        ancestorOf: [],
      });
      out[out.length - 1]._el = el;
    }
    // Nested targets (a button inside a clickable row) do not crowd each other.
    for (let i = 0; i < out.length; i++)
      for (let j = 0; j < out.length; j++) if (i !== j && composedContains(out[i]._el, out[j]._el)) out[i].ancestorOf.push(j);
    for (const t of out) delete t._el;
    return out;
  }

  function deepActive() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a && a !== document.body && a !== document.documentElement ? a : null;
  }

  function focusLook(el) {
    const cs = getComputedStyle(el);
    const backdrop = backdropOf(el);
    return {
      outlineStyle: cs.outlineStyle,
      outlineWidth: parseFloat(cs.outlineWidth) || 0,
      outlineColor: cs.outlineColor,
      outlineOffset: parseFloat(cs.outlineOffset) || 0,
      boxShadow: cs.boxShadow,
      border: borderOf(el, fillOf(el, backdrop)),
      fill: hex(fillOf(el, backdrop)),
      color: cs.color,
      backdrop: hex(backdrop),
    };
  }

  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  /**
   * The keyboard-focused element and how it looks focused and unfocused. Call it after the screenshot: it
   * blurs the element to measure the rest look. Text fields are skipped (the caret marks their focus).
   * For aria-activedescendant widgets (menus, listboxes) the active option is compared with a sibling option.
   */
  async function focusState() {
    let el = deepActive();
    if (!el) return null;
    if (el.matches(TEXT_ENTRY) && !el.getAttribute("aria-activedescendant")) return null;
    const keyboard = safeMatches(el, ":focus-visible");
    if (!keyboard) return null;
    const freeze = document.createElement("style");
    freeze.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}";
    (document.head || document.documentElement).appendChild(freeze);
    await frame();
    try {
      const activeId = el.getAttribute("aria-activedescendant");
      const root = el.getRootNode();
      const option = activeId && root.getElementById ? root.getElementById(activeId) : null;
      if (option) {
        const role = option.getAttribute("role");
        const sibling = Array.from((option.parentElement || option).children).find((c) => c !== option && (!role || c.getAttribute("role") === role) && visible(c));
        const r = option.getBoundingClientRect();
        return { path: pathOf(option), label: nearestLabel(option), box: { x: r1(r.x), y: r1(r.y), width: r1(r.width), height: r1(r.height) }, via: "activedescendant", focused: focusLook(option), rest: sibling ? focusLook(sibling) : null, obscured: occlusion(option, r, clipRect(option, true)) };
      }
      const r = el.getBoundingClientRect();
      // A visually hidden control (sr-only file input, custom checkbox) shows its focus on its label, if at all.
      const tiny = r.width <= 2 && r.height <= 2;
      const shown = tiny ? (el.labels && el.labels[0]) || null : el;
      if (!shown) {
        const l = focusLook(el);
        return { path: pathOf(el), label: nearestLabel(el), box: { x: r1(r.x), y: r1(r.y), width: r1(r.width), height: r1(r.height) }, via: "hidden", focused: l, rest: l, obscured: { samples: 0, covered: 0, centerCovered: false, by: [], overlayOnly: false } };
      }
      const sr = shown.getBoundingClientRect();
      const focused = focusLook(shown);
      const obscured = occlusion(shown, sr, clipRect(shown, true));
      el.blur();
      await frame();
      const rest = focusLook(shown);
      return { path: pathOf(el), label: nearestLabel(el), box: { x: r1(sr.x), y: r1(sr.y), width: r1(sr.width), height: r1(sr.height) }, via: shown === el ? "focus" : "label", focused: focused, rest: rest, obscured: obscured };
    } finally {
      freeze.remove();
    }
  }

  function safeMatches(el, sel) {
    try {
      return el.matches(sel);
    } catch (e) {
      return false;
    }
  }

  function page() {
    const d = document.documentElement;
    return { scrollWidth: d.scrollWidth, innerWidth: innerWidth, scrollHeight: d.scrollHeight, innerHeight: innerHeight };
  }

  function applyHtml(attrs) {
    const html = document.documentElement;
    for (const [k, v] of Object.entries(attrs)) html.setAttribute(k, v);
  }

  window.__designAuditor = { resolveTokens, collect, texts, targets, focusState, page, applyHtml, version: 5 };
})();
