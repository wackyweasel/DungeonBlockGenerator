// Derives, for every element set, the structural piece families (walls, liquids, paths...), grounds and decor
// from the element names, then writes:
//   tools/mask-jobs.json   jobs for tools/analyze-masks.py (orientation masks of structural pieces)
//   tools/sets-summary.txt human readable summary
//   src/sets.ts            generated set definitions (uses tools/masks-all.json when present)
// Usage: node tools/make-sets.mjs
import fs from 'node:fs';
import { OVERRIDES } from './set-overrides.mjs';

const els = JSON.parse(fs.readFileSync('catalogue/elements-v1.json', 'utf8'));
const masksPath = 'tools/masks-all.json';
const analyzed = fs.existsSync(masksPath) ? JSON.parse(fs.readFileSync(masksPath, 'utf8')) : {};

const LIQUID = /\b(water|lava|acid|river|swamp|poison|sewer|slime|magma|tar|blood)\b/;
const EXCLUDE = /diagonal|round angle|waterfall|watferfall|slope|bridge|roof|\blevel\b|balcony|platform|\bgate\b|fences up|cockpit|\bwing\b|entrance|pyramid|\bgrids?\b|starter|finish|switch|springboard|trampoline|\btube\b|\barch\b|buttress|shelter|scaffolding|\bleft\b|\bright\b|interior|exterior|\b1x\d\b|\b\dx\d\b|tunnel end|outlet|\bsign\b|\bstep\b|\bto\b|grotto|\bwell wall\b|\bwell ground\b/;
const STAIRS_DOWN = /(stairs|ladder) down/;
const NOT_STAIRS = /stair|ladder/;
const GROUND_WORDS = new Set(['ground', 'floor', 'grass', 'sand', 'snow', 'dirt', 'soil', 'mud', 'earth', 'gravel', 'moss', 'tiles', 'paved', 'pavement', 'cobblestone', 'cobblestones', 'planks', 'parquet', 'carpet', 'deck', 'street', 'road', 'ice']);

const ROLE_RULES = [
  [/\bstraight (?:left|right) corner\b/, 'straightcorner'],
  [/\bstraight 2 corners\b/, 'tedge'],
  [/\bangle corner\b/, 'anglecorner'],
  [/\b1 corner\b/, 'corner'],
  [/\b2 corners\b/, 'corners2'],
  [/\b3 corners\b/, 'corners3'],
  [/\b4 corners\b/, 'corners4'],
  [/\bt[- ]shaped\b/, 'tee'],
  [/\bx[- ]shaped\b/, 'cross'],
  [/\bcorridor end\b/, 'end'],
  [/\bend\b/, 'end'],
  [/\bcorr?idor\b|\bcorrdior\b/, 'corridor'],
  [/\bangle\b/, 'angle'],
  [/\bcorner\b/, 'corner'],
  [/\bstr?aight\b|\bstaight\b/, 'straight'],
  [/\bdoor\b/, 'door'],
  [/\bwindow\b/, 'window'],
  [/\bwall\b/, 'wall'],
];
const LIGHT = /torch|light|fire|candle|lamp|brazier|lantern/;
const LINKY = /path|river|rail|road|track|pipe|channel|dock|stream|trail|trench/;
const VARIANT_NOISE = /\b(\d+|lit|unlit|on|off|basic)\b/g;

const words = (s) => s.replace(VARIANT_NOISE, ' ').split(/\s+/).filter(Boolean);
const key = (ws) => ws.join(' ');

function parse(name) {
  const n = name.toLowerCase().replace(/\s+/g, ' ').trim();
  for (const [re, role] of ROLE_RULES) {
    const m = re.exec(n);
    if (!m) continue;
    let mat = words(n.slice(0, m.index));
    if (role !== 'wall' && role !== 'door' && role !== 'window') mat = mat.filter((w) => w !== 'wall');
    const suffix = words(n.slice(m.index + m[0].length));
    return { role, mat: key(mat), suffix: key(suffix), raw: n };
  }
  return { role: null, mat: key(words(n)), suffix: '', raw: n };
}

const HINT_EDGE = { wall: 'wall', straight: 'wall', door: 'wall', window: 'wall', angle: 'angle', corridor: 'corridor', end: 'end', corner: 'corner', corners2: 'corners2', corners3: 'corners3', corners4: 'corners4', anglecorner: 'anglecorner', tedge: 'tedge', straightcorner: 'straightcorner', tee: 'tedge' };
const HINT_LINK = { wall: 'l-straight', straight: 'l-straight', corridor: 'l-straight', angle: 'l-angle', tee: 'l-t', cross: 'l-x', end: 'l-end', corner: 'l-end', door: 'l-straight' };

function rotMask(m, k) {
  k = ((k % 4) + 4) % 4;
  const s = m & 15;
  const c = m >> 4;
  return (((s << k) | (s >> (4 - k))) & 15) | ((((c << k) | (c >> (4 - k))) & 15) << 4);
}
const DEFAULT_BASE = { wall: 1, angle: 3, corridor: 10, end: 7, corner: 16, corners2: 48, corners3: 112, corners4: 240, anglecorner: 3 | 64, tedge: 1 | 32 | 64, straightcorner: 1 | 32, 'l-straight': 10, 'l-angle': 3, 'l-t': 7, 'l-x': 15, 'l-end': 1, full: 0 };
const MASK_FIX = Object.assign({}, ...Object.values(OVERRIDES).map((o) => o.masks ?? {}));
function masksFor(code, hint) {
  if (code in MASK_FIX) return [0, 1, 2, 3].map((o) => rotMask(MASK_FIX[code], o));
  const a = analyzed[code];
  if (a && a.masks && a.key && a.key.split('|')[1] === hint && (a.margin ?? 1) >= 0.12) return a.masks;
  const b = DEFAULT_BASE[hint] ?? 0;
  return [0, 1, 2, 3].map((o) => rotMask(b, hint === 'corridor' ? o + 1 : o));
}

const jobs = [];
const summary = [];
const sets = [];

const packs = Object.keys(OVERRIDES).sort();
for (const pack of packs) {
  const ov = OVERRIDES[pack];
  const all = els
    .filter((e) => e.code.startsWith(pack + '-') && !/-[789]\d\d$/.test(e.code))
    .filter((e) => !(ov.exclude ?? []).includes(e.code));
  if (!all.length) continue;
  const P = all.map((e) => ({ e, code: e.code, h: e.height, fp: e.footprint, fixed: !e.orientable, ...parse(e.name) }));
  const byCode = new Map(P.map((p) => [p.code, p]));

  // Scale = footprint of the most common plain ground.
  const groundLike = P.filter((p) => !p.role && p.h <= 1 && p.fp[0] === p.fp[1]);
  const fpCount = {};
  for (const p of groundLike) fpCount[p.fp[0]] = (fpCount[p.fp[0]] ?? 0) + 1;
  const scale = ov.scale ?? Number(Object.entries(fpCount).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 1);
  const fits = (p) => p.fp[0] % scale === 0 && p.fp[1] % scale === 0;
  const single = (p) => p.fp[0] === scale && p.fp[1] === scale;

  const used = new Set();
  const isLiquidFull = (p) => !p.role && single(p) && p.h <= 1 && LIQUID.test(p.raw) && words(p.raw).every((w) => LIQUID.test(w) || w === 'bones' || w === 'pipe' || w === 'empty');

  // ---- grounds
  const grounds = {};
  const groundDecor = {};
  for (const p of P) {
    if (p.role || !single(p) || p.h > 1 || EXCLUDE.test(p.raw) || STAIRS_DOWN.test(p.raw) || isLiquidFull(p)) continue;
    const ws = words(p.raw);
    let gi = ws.findIndex((w) => w === 'ground' || w === 'floor');
    let k;
    let rest;
    if (gi >= 0) {
      k = key(ws.slice(0, gi));
      rest = ws.slice(gi + 1);
    } else if (GROUND_WORDS.has(ws[0])) {
      k = ws[0];
      rest = ws.slice(1);
    } else continue;
    if (LIQUID.test(k)) continue;
    const decorish = rest.some((w) => !['broken', 'cracked', 'tile', 'tiles', 'basic', 'stones', 'stone'].includes(w));
    if (decorish) {
      (groundDecor[k] ??= []).push(p.code);
    } else {
      (grounds[k] ??= []).push({ v: p.code, w: rest.length ? 0.4 : 1 });
    }
    used.add(p.code);
  }
  for (const [k, codes] of Object.entries(ov.grounds ?? {})) {
    grounds[k] = codes.map((c) => (typeof c === 'string' ? { v: c, w: 1 } : c));
    for (const c of codes) used.add(typeof c === 'string' ? c : c.v);
  }
  const groundKeys = Object.keys(grounds);
  const mainGround = ov.mainGround ?? (grounds[''] ? '' : groundKeys.sort((a, b) => grounds[b].length - grounds[a].length)[0]);
  if (mainGround === undefined) {
    summary.push(`== ${pack}: no ground, skipped`);
    continue;
  }
  const refGround = grounds[mainGround][0].v;

  // ---- structural families
  const fam = new Map(); // key -> {key, flat, pieces: [{p, role, suffix}]}
  for (const p of P) {
    if (!p.role || used.has(p.code) || EXCLUDE.test(p.raw) || NOT_STAIRS.test(p.raw) || !fits(p)) continue;
    if (!single(p)) continue;
    const flat = p.h <= 2;
    const fkey = (flat ? 'flat:' : 'tall:') + p.mat;
    if (!fam.has(fkey)) fam.set(fkey, { key: p.mat, flat, pieces: [] });
    fam.get(fkey).pieces.push(p);
  }
  for (const f of fam.values()) for (const p of f.pieces) if (f.flat && p.h === 2 && f.pieces.every((q) => q.h === 2)) f.flat = !!LIQUID.test(f.key);
  // Tall families where every wall has a suffix ("Low Wall Snow", "Low Wall Ice") are split by the suffix's first word.
  for (const [fk, f] of [...fam.entries()]) {
    if (f.flat) continue;
    const wallsOf = f.pieces.filter((p) => p.role === 'wall' || p.role === 'straight');
    if (!wallsOf.length || wallsOf.some((p) => !p.suffix)) continue;
    fam.delete(fk);
    for (const p of f.pieces) {
      const [first, ...rest] = p.suffix.split(' ');
      const k2 = key([f.key, first].filter(Boolean));
      const fk2 = 'tall:' + k2;
      if (!fam.has(fk2)) fam.set(fk2, { key: k2, flat: false, pieces: [] });
      fam.get(fk2).pieces.push({ ...p, mat: k2, suffix: key(rest) });
    }
  }
  // Tall families of liquids (river cliffs, waterfalls...) need a context we do not generate.
  for (const [fk, f] of [...fam.entries()]) if (!f.flat && LIQUID.test(f.key)) fam.delete(fk);

  const walls = [];
  const liquids = [];
  const links = [];
  const roleSet = (f) => new Set(f.pieces.map((p) => p.role));

  // tall families
  for (const f of [...fam.values()].filter((x) => !x.flat)) {
    const rs = roleSet(f);
    const model = ov.linkWalls?.includes(f.key) || rs.has('tee') || rs.has('cross') ? 'link' : 'edge';
    const hasWall = rs.has('wall') || rs.has('straight');
    if (!hasWall) continue;
    const plain = f.pieces.filter((p) => (p.role === 'wall' || p.role === 'straight') && !p.suffix);
    const hs = (plain.length ? plain : f.pieces).map((p) => p.h);
    const h = hs.sort((a, b) => hs.filter((x) => x === b).length - hs.filter((x) => x === a).length)[0];
    walls.push({ key: f.key, model, h, f });
  }
  // merge tall wall-less families (doors, windows) & small variant families into the closest family
  const mainWall = ov.mainWall !== undefined ? walls.find((w) => w.key === ov.mainWall) : walls.filter((w) => roleSet(w.f).has('angle')).sort((a, b) => (a.key === '' ? -1 : 0) - (b.key === '' ? -1 : 0) || roleSet(b.f).size - roleSet(a.f).size)[0];
  const finalWalls = [];
  for (const w of walls) {
    const rs = roleSet(w.f);
    const ownGround = grounds[w.key] ? w.key : null;
    if (w !== mainWall && mainWall && !ownGround && !rs.has('angle') === true) {
      // no angle: becomes decor variants of the main wall family
      if (mainWall.model !== w.model) continue;
      mainWall.f.pieces.push(...w.f.pieces.map((p) => ({ ...p, suffix: p.suffix || w.key || 'variant' })));
      continue;
    }
    if (w !== mainWall && mainWall && !ownGround && Math.abs(w.h - mainWall.h) <= 1 && w.model === mainWall.model && !(ov.keepFamilies ?? []).includes(w.key) && ov.style !== 'wilds' && ov.style !== 'colossal') {
      mainWall.f.pieces.push(...w.f.pieces.map((p) => ({ ...p, suffix: p.suffix || w.key || 'variant' })));
      continue;
    }
    finalWalls.push(w);
  }
  // doors/windows in tall families without walls
  for (const f of [...fam.values()].filter((x) => !x.flat)) {
    const rs = roleSet(f);
    if (rs.has('wall') || rs.has('straight')) continue;
    const target = finalWalls.find((w) => w.key === f.key) ?? finalWalls.filter((w) => f.key.startsWith(w.key)).sort((a, b) => b.key.length - a.key.length)[0] ?? mainWall;
    if (target) target.f.pieces.push(...f.pieces.filter((p) => ['door', 'window', 'angle', 'corner', 'corridor', 'end'].includes(p.role)).map((p) => ({ ...p, suffix: p.suffix || (p.role === 'door' || p.role === 'window' ? '' : f.key) })));
  }

  const wallDefs = [];
  for (const w of finalWalls) {
    const base = [];
    const decor = [];
    const torch = [];
    const doors = [];
    const hintOf = (role) => (w.model === 'link' ? HINT_LINK[role] : HINT_EDGE[role]);
    for (const p of w.f.pieces) {
      const role = p.role === 'straight' ? 'wall' : p.role;
      const hint = hintOf(role);
      if (!hint || ['tedge', 'straightcorner', 'anglecorner', 'corners2', 'corners3', 'corners4'].includes(hint)) continue;
      if (p.h < Math.min(2, w.h)) continue;
      used.add(p.code);
      if (!p.fixed) jobs.push({ code: p.code, hint, scale });
      const pc = { c: p.code, w: 1, m: p.fixed ? [0, 0, 0, 0].map(() => masksFor(p.code, hint)[0]) : masksFor(p.code, hint) };
      if (role === 'door') doors.push(pc);
      else if (role === 'window') decor.push({ ...pc, w: 0.5 });
      else if (LIGHT.test(p.suffix)) torch.push(pc);
      else if (p.suffix || Math.abs(p.h - w.h) > 1) decor.push({ ...pc, w: /broken|debris|ruin/.test(p.suffix) ? 0.5 : 1 });
      else base.push(pc);
    }
    if (!base.length) {
      base.push(...decor.splice(0, decor.length));
    }
    if (!base.length) continue;
    wallDefs.push({ key: w.key, model: w.model, h: w.h, ground: grounds[w.key] ? w.key : null, base, decor, torch, doors });
  }
  // hand-made families (e.g. ship hulls whose names carry no "wall" role)
  const extraCodes = new Set();
  for (const x of ov.extraWalls ?? []) {
    const mk = (list = []) => list.map(([c, hint, w = 1]) => (extraCodes.add(c), { c, w, m: masksFor(c, hint) }));
    wallDefs.push({ key: x.key, model: 'edge', h: x.h, ground: null, base: mk(x.base), decor: mk(x.decor), torch: mk(x.torch), doors: mk(x.doors) });
  }
  for (const w of wallDefs) {
    if ((ov.extraWalls ?? []).some((x) => x.key === w.key)) continue;
    for (const k of ['base', 'decor', 'torch', 'doors']) w[k] = w[k].filter((pc) => !extraCodes.has(pc.c));
  }

  // flat families: liquids (edge, with a full tile) and links (paths, rivers, rails...)
  const fullTiles = (k) => {
    const ws = k.split(' ');
    for (let n = ws.length; n > 0; n--) {
      const kk = key(ws.slice(0, n));
      const list = P.filter((p) => !p.role && single(p) && p.h <= 1 && p.mat === kk);
      if (list.length) return list;
    }
    return [];
  };
  for (const f of [...fam.values()].filter((x) => x.flat)) {
    const rs = roleSet(f);
    const cornerish = ['corner', 'corners3', 'corners4', 'anglecorner'].some((r) => rs.has(r));
    const linkish = ['end', 'tee', 'cross'].some((r) => rs.has(r));
    const edgeType = (ov.linkFlat ?? []).includes(f.key) ? false : (ov.edgeFlat ?? []).includes(f.key) || cornerish || (!linkish && ['corners2', 'tedge', 'straightcorner', 'corridor'].some((r) => rs.has(r)));
    if (edgeType) {
      const full = fullTiles(f.key);
      if (!full.length) {
        summary.push(`  (dropped edge family "${f.key}" without full tile)`);
        continue;
      }
      const ref = full[0].code;
      const pieces = [];
      for (const p of f.pieces) {
        const hint = HINT_EDGE[p.role === 'tee' ? 'tedge' : p.role];
        if (!hint || p.role === 'door' || p.role === 'window' || p.role === 'cross') continue;
        used.add(p.code);
        if (!p.fixed) jobs.push({ code: p.code, hint, ref, scale });
        pieces.push({ c: p.code, w: p.suffix ? 0.4 : 1, m: masksFor(p.code, hint) });
      }
      for (const p of full) used.add(p.code);
      const liquidDecor = P.filter((p) => !p.role && single(p) && !used.has(p.code) && p.mat.startsWith(f.key.split(' ')[0] + ' ') && LIQUID.test(f.key) && !EXCLUDE.test(p.raw)).map((p) => p.code);
      for (const c of liquidDecor) used.add(c);
      const fullW = full.map((p) => ({ v: p.code, w: words(p.raw).length > words(full[0].raw).length ? 0.3 : 1 }));
      liquids.push({ key: f.key, liquid: LIQUID.test(f.key), full: fullW, pieces, decor: liquidDecor });
    } else {
      const pieces = [];
      const hasStraight = rs.has('straight') || rs.has('wall') || rs.has('corridor');
      const straightCands = hasStraight ? [] : P.filter((p) => !p.role && single(p) && p.mat === f.key);
      const j0 = jobs.length;
      for (const p of [...f.pieces, ...straightCands.map((p) => ({ ...p, role: 'straight' }))]) {
        const hint = HINT_LINK[p.role];
        if (p.role === 'door' || p.role === 'window') continue;
        if (!hint) continue;
        used.add(p.code);
        if (!p.fixed) jobs.push({ code: p.code, hint, ref: refGround, scale });
        pieces.push({ c: p.code, w: p.suffix ? 0.4 : 1, m: masksFor(p.code, hint) });
      }
      const hints = new Set(pieces.map((p) => p.m.join()));
      if (f.key && rs.has('angle') && pieces.length >= 2 && hints.size >= 2 && (LIQUID.test(f.key) || LINKY.test(f.key))) links.push({ key: f.key, liquid: LIQUID.test(f.key), pieces });
      else {
        for (const p of pieces) used.delete(p.c);
        jobs.length = j0;
      }
    }
  }

  // hand-made link families: [code, open-side mask at o=0, weight?]
  for (const x of ov.extraLinks ?? []) {
    const pieces = x.pieces.map(([c, m, w = 1]) => (extraCodes.add(c), used.add(c), { c, w, m: [0, 1, 2, 3].map((o) => rotMask(m, o)) }));
    links.push({ key: x.key, liquid: !!x.liquid, pieces });
  }

  // liquid tiles not used by any edge family: full-only liquids (pools without shores)
  {
    const loose = P.filter((p) => isLiquidFull(p) && !used.has(p.code));
    const groups = {};
    for (const p of loose) (groups[words(p.raw)[0]] ??= []).push(p);
    for (const [k, list] of Object.entries(groups)) {
      if (liquids.some((l) => l.key === k)) continue;
      for (const p of list) used.add(p.code);
      liquids.push({ key: k, liquid: true, full: list.map((p) => ({ v: p.code, w: 1 })), pieces: [], decor: [] });
    }
  }

  // ---- decor
  const cat = { scatter: [], props: [], trees: [], columns: [], lights: [], furniture: [], hazards: [], treasure: [], features: [], big: [], stairs: [] };
  const groundAff = {};
  const liquidDecor = {};
  for (const l of liquids) liquidDecor[l.key] = l.decor;
  for (const p of P) {
    if (used.has(p.code) || p.role || EXCLUDE.test(p.raw) || !fits(p)) continue;
    if (STAIRS_DOWN.test(p.raw)) {
      if (single(p)) cat.stairs.push(p.code);
      continue;
    }
    if (NOT_STAIRS.test(p.raw)) continue;
    const ws = words(p.raw);
    if (LIQUID.test(ws[0]) && !/\bgrass\b/.test(p.raw)) {
      const l = liquids.find((x) => x.key.split(' ')[0] === ws[0]);
      if (l && single(p)) l.decor.push(p.code);
      continue;
    }
    if (!single(p)) {
      cat.big.push(p.code);
      continue;
    }
    const gk = groundKeys.find((k) => k && ws[0] === k && k !== mainGround);
    if (gk && p.h <= 2) {
      (groundAff[gk] ??= []).push(p.code);
      continue;
    }
    if (/trap|spike|saw|vortex|tornado|tentacle/.test(p.raw)) cat.hazards.push(p.code);
    else if (/chest|treasure|coins|gold|loot/.test(p.raw)) cat.treasure.push(p.code);
    else if (/column|pillar/.test(p.raw)) cat.columns.push(p.code);
    else if (/\btree|pine|bush|cactus|mushroom|plant|flower|fern/.test(p.raw)) cat.trees.push(p.code);
    else if (LIGHT.test(p.raw)) cat.lights.push(p.code);
    else if (/table|bench|chair|bed|shel|wardrobe|locker|barrel|box|crate|bin|cabinet|desk|bookcase|sofa|throne|stool|cupboard|cart|sack|forge|anvil|machine|computer/.test(p.raw)) cat.furniture.push(p.code);
    else if (/statue|obelisk|fountain|well\b|altar|sarcophag|coffin|tomb|pentacle|mausoleum|dolmen|idol|totem|monolith|portal|mirror|clock|telescope/.test(p.raw)) cat.features.push(p.code);
    else if (p.h <= 2) cat.scatter.push(p.code);
    else cat.props.push(p.code);
  }
  for (const [k, v] of Object.entries(groundDecor)) (groundAff[k] ??= []).push(...v.filter((c) => !/trap/.test(byCode.get(c).raw)));
  for (const v of Object.values(groundDecor)) cat.hazards.push(...v.filter((c) => /trap/.test(byCode.get(c).raw)));
  for (const [k, v] of Object.entries(ov.decor ?? {})) cat[k] = v;
  const shipCodes = new Set([...Object.values(ov.opts?.ship ?? {}), ...Object.values(ov.opts?.outside ?? {}), ...Object.values(ov.opts?.swamp ?? {})].flat().filter((c) => typeof c === 'string' && c.includes('-')));
  for (const k of Object.keys(cat)) cat[k] = cat[k].filter((c) => !extraCodes.has(c) && !shipCodes.has(c));
  const indoor = Object.values(cat)
    .flat()
    .filter((c) => /fireplace|chimney|wardrobe|buffet|\bbar\b|chandelier|\bbath|\bbed\b|shel|bookcase|cupboard|cabinet|locker|sofa|tapestry|painting|stove|oven|kitchen|toilet|sink|desk|computer/.test(byCode.get(c)?.raw ?? ''));

  const fp = {};
  for (const p of P) if (p.fp[0] !== 1 || p.fp[1] !== 1) fp[p.code] = p.fp;

  const style = ov.style ?? 'dungeon';
  const set = {
    id: pack,
    name: ov.name ?? pack,
    style,
    scale,
    grounds,
    mainGround,
    walls: wallDefs.sort((a, b) => (a.key === (ov.mainWall ?? mainWall?.key) ? -1 : 0) - (b.key === (ov.mainWall ?? mainWall?.key) ? -1 : 0)),
    liquids: liquids.map(({ key: k, liquid, full, pieces, decor }) => ({ key: k, liquid, full, pieces, decor })),
    links,
    decor: Object.fromEntries(Object.entries(cat).filter(([, v]) => v.length)),
    groundDecor: groundAff,
    indoor,
    opts: ov.opts ?? {},
    fp,
  };
  if (!set.walls.length && style === 'dungeon') {
    summary.push(`== ${pack}: no walls found`);
  }
  sets.push(set);

  // summary
  const nm = (c) => `${c.slice(pack.length + 1)}`;
  summary.push(`== ${pack} "${set.name}" style=${style} scale=${scale} mainGround="${mainGround}"`);
  summary.push(`  grounds: ${Object.entries(grounds).map(([k, v]) => `"${k}"[${v.map((x) => nm(x.v)).join(',')}]`).join(' ')}`);
  for (const w of set.walls) summary.push(`  wall "${w.key}" ${w.model} h${w.h} ground=${w.ground ?? '-'} base[${w.base.map((x) => nm(x.c)).join(',')}] decor[${w.decor.map((x) => nm(x.c)).join(',')}] torch[${w.torch.map((x) => nm(x.c)).join(',')}] doors[${w.doors.map((x) => nm(x.c)).join(',')}]`);
  for (const l of set.liquids) summary.push(`  edge "${l.key}" full[${l.full.map((x) => nm(x.v)).join(',')}] pieces[${l.pieces.map((x) => nm(x.c)).join(',')}] decor[${l.decor.map(nm).join(',')}]`);
  for (const l of set.links) summary.push(`  link "${l.key}" [${l.pieces.map((x) => nm(x.c)).join(',')}]`);
  for (const [k, v] of Object.entries(set.decor)) summary.push(`  ${k}: ${v.map((c) => `${nm(c)} ${byCode.get(c).e.name}`).join(', ')}`);
  for (const [k, v] of Object.entries(groundAff)) summary.push(`  on "${k}": ${v.map(nm).join(',')}`);
}

fs.writeFileSync('tools/mask-jobs.json', JSON.stringify(jobs));
fs.writeFileSync('tools/sets-summary.txt', summary.join('\n'));
const ts = `// GENERATED by tools/make-sets.mjs - do not edit by hand (edit tools/set-overrides.mjs instead).
// Masks: bits 0-3 = sides W N E S, bits 4-7 = corners NW NE SE SW, one mask per orientation.
export interface W { v: string; w: number }
export interface Pc { c: string; w: number; m: number[] }
export interface WallFam { key: string; model: 'edge' | 'link'; h: number; ground: string | null; base: Pc[]; decor: Pc[]; torch: Pc[]; doors: Pc[] }
export interface EdgeFam { key: string; liquid: boolean; full: W[]; pieces: Pc[]; decor: string[] }
export interface LinkFam { key: string; liquid: boolean; pieces: Pc[] }
export type SetStyle = 'dungeon' | 'cave' | 'wilds' | 'town' | 'swamp' | 'ship' | 'colossal';
/** Colossal style: curated pieces. Lists by height class are indexed 0-2 = +3/+6/+9 (low/medium/tall). */
export interface Colossal {
  supports: string[];
  /** wall family keys by height class */
  walls: string[];
  /** wall variants (codes taken from the wall families' pieces) */
  styles?: Record<string, string[]>;
  doors?: string[];
  giant?: string[];
  bigStairs?: string[][];
  stairs?: string[][];
  stairAngles?: string[];
  columns?: string[];
  caps?: string[];
  brokenColumns?: string[];
  pedestals?: string[];
  pits?: string[];
  statues?: string[];
  ruinedStatues?: string[];
  guardians?: string[];
  thrones?: string[];
  coffins?: string[];
  gold?: string[];
  fires?: string[];
  wells?: string[];
  rubble?: string[];
  /** floor palettes: space-separated codes */
  floors?: string[];
  grass?: string[];
  grassDecor?: string[];
}
export interface SetDef {
  id: string;
  name: string;
  style: SetStyle;
  scale: number;
  grounds: Record<string, W[]>;
  mainGround: string;
  walls: WallFam[];
  liquids: EdgeFam[];
  links: LinkFam[];
  decor: Partial<Record<'scatter' | 'props' | 'trees' | 'columns' | 'lights' | 'furniture' | 'hazards' | 'treasure' | 'features' | 'big' | 'stairs', string[]>>;
  groundDecor: Record<string, string[]>;
  /** Decor that only makes sense inside rooms/buildings (fireplaces, beds, wardrobes, ...). */
  indoor: string[];
  opts: {
    roomWalls?: string[];
    outdoorGround?: string;
    indoorGround?: string;
    boundaryWall?: string;
    landGround?: string;
    doubleDoor?: { left: string; right: string };
    /** Ship style: hull wall family and accessories (bow/stern pieces attach to the E/W hull ends at o=0/3). */
    ship?: { hull: string; bow?: string[]; backWall?: string[]; boats?: string[]; masts?: string[]; cabinBed?: string[]; cabinDesk?: string[]; cabinChest?: string[]; cabinTable?: string[]; cargo?: string[]; hatches?: string[]; deckItems?: string[]; deckLights?: string[]; hullCannon?: string[]; bunks?: string[]; platform?: string[]; rail?: string[]; stairs?: string[] };
    /** fill the empty cells around the layout (e.g. outer space): first floor code is the most common */
    outside?: { floor: string[]; decor?: string[] };
    /** Swamp style: curated piece lists by role (roofs, trees, mushrooms, water plants...). */
    swamp?: Record<string, string[]>;
    /** Wilds style: support blocks, cliff families and stairs by height step (+3, +6, +9). */
    elevation?: { supports: string[][]; classes: string[][]; stairs?: string[][] };
    colossal?: Colossal;
  };
  fp: Record<string, number[]>;
}
export const SETS: SetDef[] = ${JSON.stringify(sets)};
`;
fs.writeFileSync('src/sets.ts', ts);
console.log(`${sets.length} sets, ${jobs.length} mask jobs, analyzed ${Object.keys(analyzed).length}`);
