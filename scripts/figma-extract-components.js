// Read-only Figma Plugin API script that produced reference/figma/ai-chat-components.json.
// Run it through the Figma MCP `use_figma` tool (or a dev plugin) once per page, with PAGE and SETS set.
// It never modifies the file. Output: { sets: [{ id, name, page, variantProps, variants: [{ id, name, layers }] }] }.
const PAGE = "<page node id>", SETS = ["<component set node id>"]; // e.g. "12:345"
// Instances of these sets are recorded by name only; their own specs cover their insides.
const TRACKED = ["<component set name>"]; // sets captured on their own; their instances are recorded by name only
await figma.setCurrentPageAsync(await figma.getNodeByIdAsync(PAGE));
const cache = new Map();
async function vn(id) { if (!id) return undefined; if (!cache.has(id)) { const v = await figma.variables.getVariableByIdAsync(id); cache.set(id, v ? ((v.codeSyntax && v.codeSyntax.WEB) || v.name) : id); } return cache.get(id); }
const hx = (c, o) => { const h = x => Math.round(x * 255).toString(16).padStart(2, '0'); const a = o === undefined ? 1 : o; return '#' + h(c.r) + h(c.g) + h(c.b) + (a < 0.999 ? h(a) : ''); };
async function paint(list) { if (!Array.isArray(list)) return undefined; const p = list.find(x => x.visible !== false && x.type === 'SOLID'); return p ? { c: hx(p.color, p.opacity), v: await vn(p.boundVariables && p.boundVariables.color && p.boundVariables.color.id) } : undefined; }
async function walk(n, root, path, out) {
  if (n.visible === false) return;
  const bb = n.absoluteBoundingBox, rb = root.absoluteBoundingBox;
  const L = { path, type: n.type, box: [Math.round(bb.x - rb.x), Math.round(bb.y - rb.y), Math.round(bb.width), Math.round(bb.height)] };
  if ('layoutMode' in n && n.layoutMode !== 'NONE') { L.pad = [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft]; L.gap = n.itemSpacing; L.align = [n.primaryAxisAlignItems, n.counterAxisAlignItems]; L.mode = n.layoutMode; }
  if ('layoutSizingHorizontal' in n) L.sizing = [n.layoutSizingHorizontal, n.layoutSizingVertical];
  if ('cornerRadius' in n && typeof n.cornerRadius === 'number' && n.cornerRadius) L.radius = n.cornerRadius;
  if ('fills' in n && n.type !== 'TEXT') { const f = await paint(n.fills); if (f) L.fill = f; }
  if ('strokes' in n) { const s = await paint(n.strokes); if (s) L.stroke = { ...s, w: n.strokeWeight }; }
  if ('effects' in n) { const e = n.effects.find(e => e.visible !== false && e.type === 'DROP_SHADOW'); if (e) { L.shadow = { x: e.offset.x, y: e.offset.y, blur: e.radius, spread: e.spread || 0, c: hx(e.color, e.color.a) }; if (typeof n.effectStyleId === 'string' && n.effectStyleId) { const st = await figma.getStyleByIdAsync(n.effectStyleId); if (st) L.shadow.style = st.name; } } }
  if (n.type === 'TEXT') {
    const fn = n.fontName; const c = await paint(n.fills);
    L.text = { chars: n.characters.slice(0, 30), size: n.fontSize, weight: n.fontWeight, font: fn === figma.mixed ? 'mixed' : fn.family, lh: n.lineHeight === figma.mixed ? 'mixed' : n.lineHeight.unit === 'AUTO' ? 'auto' : n.lineHeight.value + (n.lineHeight.unit === 'PERCENT' ? '%' : 'px'), color: c };
    if (typeof n.textStyleId === 'string' && n.textStyleId) { const ts = await figma.getStyleByIdAsync(n.textStyleId); if (ts) L.text.style = ts.name; }
  }
  if (n.type === 'INSTANCE') {
    const mc = await n.getMainComponentAsync();
    const setName = mc && mc.parent && mc.parent.type === 'COMPONENT_SET' ? mc.parent.name : mc ? mc.name : '?';
    L.instanceOf = setName + (mc && mc.parent && mc.parent.type === 'COMPONENT_SET' ? ' / ' + mc.name : '');
    if (TRACKED.includes(setName)) { out.push(L); return; }
    if (setName.startsWith('Icons/') || setName.startsWith('Neon/')) { const vec = n.findOne(x => x.visible !== false && 'strokes' in x && Array.isArray(x.strokes) && x.strokes.length); if (vec) L.iconColor = await paint(vec.strokes); out.push(L); return; }
  }
  out.push(L);
  if ('children' in n) for (const c of n.children) await walk(c, root, path + '/' + c.name, out);
}
const sets = [];
for (const id of SETS) {
  const set = await figma.getNodeByIdAsync(id);
  const props = {}; for (const [k, d] of Object.entries(set.componentPropertyDefinitions)) if (d.type === 'VARIANT') props[k] = d.variantOptions;
  const variants = [];
  for (const v of set.children) { const layers = []; await walk(v, v, '', layers); layers[0].path = '.'; variants.push({ id: v.id, name: v.name, layers }); }
  sets.push({ id: set.id, name: set.name, page: PAGE, variantProps: props, variants });
}
return { sets };
