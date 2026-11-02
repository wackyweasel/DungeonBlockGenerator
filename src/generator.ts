import { rotate } from './catalogue.js';
import { Rng } from './rng.js';
import { SETS, type Colossal, type EdgeFam, type LinkFam, type Pc, type SetDef, type SetStyle, type W } from './sets.js';
import type { DbbDesign, DbbTile } from './types.js';

export type Shape = 'rectangle' | 'ellipse' | 'diamond' | 'cross' | 'lshape' | 'ring' | 'organic';
export type Style = 'auto' | SetStyle;
export type RoomShapes = 'rect' | 'mixed' | 'round';
/** 'count': exactly roomCount rooms, the size is only a limit. 'fill': as many rooms as fit in the size. */
export type Layout = 'count' | 'fill';

export interface GenParams {
  seed: number;
  title: string;
  theme: string; // element set id
  style: Style;
  width: number;
  height: number;
  shape: Shape;
  layout: Layout;
  roomCount: number;
  roomMin: number;
  roomMax: number;
  roomShapes: RoomShapes;
  corridorWidth: 1 | 2;
  winding: number;
  loops: number;
  doors: number;
  decor: number;
  caveOpenness: number;
  /** Wilderness: how much of the ground rises into terraces and mesas. */
  elevation: number;
  water: number;
  paths: number;
  baseGrid: boolean;
  stairs: boolean;
}

export const DEFAULT_PARAMS: GenParams = {
  seed: 1,
  title: 'Generated Dungeon',
  theme: 'UD',
  style: 'auto',
  width: 24,
  height: 24,
  shape: 'rectangle',
  layout: 'count',
  roomCount: 8,
  roomMin: 3,
  roomMax: 7,
  roomShapes: 'mixed',
  corridorWidth: 1,
  winding: 0.3,
  loops: 0.25,
  doors: 0.8,
  decor: 0.5,
  caveOpenness: 0.5,
  elevation: 0.5,
  water: 0.4,
  paths: 1,
  baseGrid: true,
  stairs: true,
};

export interface GenResult {
  design: DbbDesign;
  style: SetStyle;
  rooms: number;
  floorCells: number;
  /** Allowed space: w x h coarse cells of `scale` x `scale` map cells, mask = 1 where usable. */
  area: { w: number; h: number; scale: number; mask: Uint8Array };
}

export function resolveStyle(p: Pick<GenParams, 'theme' | 'style'>): SetStyle {
  const set = SETS.find((s) => s.id === p.theme) ?? SETS[0];
  const style = p.style === 'auto' ? set.style : p.style;
  return style === 'colossal' && !set.opts.colossal ? 'dungeon' : style;
}

// Sides: 0=W 1=N 2=E 3=S. Corners (mask bits 4-7): NW NE SE SW; corner k touches sides k and k+1.
const DX = [-1, 0, 1, 0];
const DY = [0, -1, 0, 1];
const CX = [-1, 1, 1, -1];
const CY = [-1, -1, 1, 1];

const EMPTY = 0;
const ROOM = 1;
const CORRIDOR = 2;

type RoomKind = 'plain' | 'hall' | 'pool' | 'furnished' | 'shrine' | 'treasure';
type DecorCat = keyof SetDef['decor'];

interface Room {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  cells: number[];
  cx: number;
  cy: number;
  shape: string;
  kind: RoomKind;
  alive: boolean;
}

interface CRegion {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  cells: number[];
  hall: number;
  hs: number;
  kind: string;
  style: string;
  floor: string[];
}

interface Door {
  cell: number;
  dir: number;
  part: 'single' | 'left' | 'right';
}

interface Cand {
  c: string;
  o: number;
  w: number;
  m: number;
}

class Grid {
  readonly kind: Uint8Array;
  readonly room: Int16Array;
  readonly mask: Uint8Array;
  readonly halo: Uint8Array;

  constructor(readonly W: number, readonly H: number) {
    this.kind = new Uint8Array(W * H);
    this.room = new Int16Array(W * H).fill(-1);
    this.mask = new Uint8Array(W * H);
    this.halo = new Uint8Array(W * H);
  }

  in(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.W && y < this.H;
  }

  idx(x: number, y: number): number {
    return y * this.W + x;
  }

  floor(x: number, y: number): boolean {
    return this.in(x, y) && this.kind[this.idx(x, y)] !== EMPTY;
  }

  openSides(x: number, y: number): number {
    let bits = 0;
    for (let d = 0; d < 4; d++) if (!this.floor(x + DX[d], y + DY[d])) bits |= 1 << d;
    return bits;
  }
}

function popcount(n: number): number {
  let c = 0;
  for (; n; n &= n - 1) c++;
  return c;
}

// Mismatch cost between a piece mask and the wanted mask.
function maskCost(m: number, want: number): number {
  const s = m & 15;
  const ws = want & 15;
  const c = m >> 4;
  const wc = want >> 4;
  return popcount(s & ~ws) * 2 + popcount(ws & ~s) * 1.6 + popcount(c & ~wc) * 0.7 + popcount(wc & ~c) * 0.5;
}

function makeMask(g: Grid, shape: Shape, rng: Rng): void {
  const { W, H } = g;
  const cx = (W - 1) / 2;
  const cy = (H - 1) / 2;
  const rx = W / 2;
  const ry = H / 2;
  const blobs: [number, number, number][] = [];
  if (shape === 'organic') {
    let bx = cx;
    let by = cy;
    const n = 6 + Math.floor((W * H) / 300);
    for (let i = 0; i < n; i++) {
      const r = Math.min(W, H) * (0.15 + rng.next() * 0.15);
      blobs.push([bx, by, r]);
      const a = rng.next() * Math.PI * 2;
      bx = Math.min(W - r * 0.6, Math.max(r * 0.6, bx + Math.cos(a) * r * 1.1));
      by = Math.min(H - r * 0.6, Math.max(r * 0.6, by + Math.sin(a) * r * 1.1));
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      const r2 = nx * nx + ny * ny;
      let on = true;
      switch (shape) {
        case 'ellipse': on = r2 <= 1; break;
        case 'diamond': on = Math.abs(nx) + Math.abs(ny) <= 1.05; break;
        case 'cross': on = Math.abs(nx) <= 0.36 || Math.abs(ny) <= 0.36; break;
        case 'lshape': on = !(x > cx && y < cy); break;
        case 'ring': on = r2 <= 1 && r2 >= 0.22; break;
        case 'organic': on = blobs.some(([bx, by, r]) => (x - bx) ** 2 + (y - by) ** 2 <= r * r); break;
      }
      g.mask[g.idx(x, y)] = on ? 1 : 0;
    }
  }
}

function roomCells(x: number, y: number, w: number, h: number, shape: string): [number, number][] {
  const cells: [number, number][] = [];
  const cut = Math.floor(Math.min(w, h) / 3);
  const bw = Math.max(3, Math.round(w / 3));
  const bh = Math.max(3, Math.round(h / 3));
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let on = true;
      if (shape === 'circle') {
        const nx = (i - (w - 1) / 2) / (w / 2);
        const ny = (j - (h - 1) / 2) / (h / 2);
        on = nx * nx + ny * ny <= 1.05;
      } else if (shape === 'octagon') {
        const di = Math.min(i, w - 1 - i);
        const dj = Math.min(j, h - 1 - j);
        on = di + dj >= cut;
      } else if (shape === 'cross') {
        const ci = Math.abs(i - (w - 1) / 2) <= (bw - 1) / 2 + 0.01;
        const cj = Math.abs(j - (h - 1) / 2) <= (bh - 1) / 2 + 0.01;
        on = ci || cj;
      }
      if (on) cells.push([x + i, y + j]);
    }
  }
  return cells;
}

class MinHeap {
  private a: { k: number; v: number }[] = [];
  get size(): number {
    return this.a.length;
  }
  push(v: number, k: number): void {
    const a = this.a;
    a.push({ k, v });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].k <= a[i].k) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): number {
    const a = this.a;
    const top = a[0].v;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].k < a[m].k) m = l;
        if (r < a.length && a[r].k < a[m].k) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

// ---------------------------------------------------------------------------------------------

export function generate(params: GenParams): GenResult {
  const p = { ...DEFAULT_PARAMS, ...params };
  const set = SETS.find((s) => s.id === p.theme) ?? SETS[0];
  const style = resolveStyle(p);
  const gen = new Generator(set, style, p);
  gen.run();
  const levels = [];
  const base = p.baseGrid ? 1 : 0;
  if (p.baseGrid) levels.push({ index: 0, tiles: gen.baseGrid() });
  // pieces stacked above the ground (roofs, terraces) sit on levels 3 units apart
  for (const [off, tiles] of [...gen.layers].sort((a, b) => a[0] - b[0])) if (tiles.length) levels.push({ index: base + off, tiles });

  const now = new Date().toISOString();
  return {
    design: {
      id: crypto.randomUUID(),
      title: p.title,
      description: `Generated: ${set.name}, ${style}, ${p.shape}, ${p.width}x${p.height}, seed ${p.seed}`,
      creationDate: now,
      modificationDate: now,
      levels,
    },
    style,
    rooms: gen.rooms.filter((r) => r.alive).length,
    floorCells: gen.g.kind.reduce((s, k) => s + (k ? 1 : 0), 0),
    area: { w: gen.W, h: gen.H, scale: gen.s, mask: gen.g.mask },
  };
}

class Generator {
  readonly rng: Rng;
  readonly g: Grid;
  readonly s: number;
  readonly W: number;
  readonly H: number;
  readonly rooms: Room[] = [];
  readonly doors = new Map<number, Door>();
  readonly layers = new Map<number, DbbTile[]>(); // tiles by height offset above the ground level
  hs: Uint8Array | null = null; // terrain step (0 = ground, 1-3 = +3/+6/+9) per macro cell
  private drop = new Uint8Array(0); // height class of the cliff a ground cell leans on
  private mnt = new Int16Array(0); // mountain of every raised cell
  private mntVar: number[] = []; // material variant of every mountain
  private ringMnt = new Int16Array(0); // mountain a ground cell leans on
  private mntStairs = new Map<number, number>();
  private stairsAt: number[] = [];
  private keep = new Uint8Array(0); // swamp: cells kept free of big decor (around buildings and trails)
  private trail = new Uint8Array(0); // swamp: plank trail cells
  // colossal style
  private cReg = new Int16Array(0); // region of every macro cell (-1: void)
  private cRegions: CRegion[] = [];
  private cSide = new Uint8Array(0); // wall height class (1-3) per cell side (cell * 4 + side)
  private cStairs = new Map<number, { s: number; code: string }>(); // stairs climbing toward side s
  private cRuns: [number, number, number][][] = []; // grand staircases: [low cell, side, high cell]

  // per macro cell
  readonly reg: Int16Array; // walled region (-1: no walls)
  readonly fam: Int16Array; // wall family (-1: none)
  readonly gk: string[]; // ground key
  readonly liq: Int16Array; // liquid / patch family
  readonly lnk: Int16Array; // link family
  readonly lb: Uint8Array; // link bits
  readonly used: Uint8Array;
  want: Int16Array; // wanted wall mask (edge families)
  readonly regionAll: boolean[] = []; // region walls toward any other region (buildings)
  readonly links: LinkFam[];
  liquidEdgeOpen = false;
  private torches: number[] = [];
  private memo = new Map<Pc[], Map<number, { cost: number; list: Cand[] }>>();
  private readonly indoor: Set<string>;
  private occ: Uint8Array;

  constructor(readonly set: SetDef, readonly style: SetStyle, readonly p: GenParams) {
    this.rng = new Rng(p.seed);
    this.s = set.scale;
    this.indoor = new Set(set.indoor);
    this.W = Math.max(6, Math.floor(p.width / this.s));
    this.H = Math.max(6, Math.floor(p.height / this.s));
    const N = this.W * this.H;
    this.g = new Grid(this.W, this.H);
    this.reg = new Int16Array(N).fill(-1);
    this.fam = new Int16Array(N).fill(-1);
    this.gk = new Array<string>(N).fill(set.mainGround);
    this.liq = new Int16Array(N).fill(-1);
    this.lnk = new Int16Array(N).fill(-1);
    this.lb = new Uint8Array(N);
    this.used = new Uint8Array(N);
    this.want = new Int16Array(N);
    this.occ = new Uint8Array(N * this.s * this.s);
    this.links = [...set.links];
  }

  run(): void {
    makeMask(this.g, this.p.shape, this.rng);
    if (this.style === 'colossal') {
      this.layoutColossal();
      this.tileColossal();
      return;
    }
    switch (this.style) {
      case 'cave': this.layoutCave(); break;
      case 'wilds': this.layoutWilds(); break;
      case 'town': this.layoutTown(); break;
      case 'swamp': this.layoutSwamp(); break;
      case 'ship': this.layoutShip(); break;
      default: this.layoutDungeon();
    }
    this.computeWant();
    this.addLiquids();
    this.smoothLiquids();
    this.addLinks();
    this.tileSupports();
    this.tileWalls();
    this.tileRidges();
    if (this.style === 'swamp') this.decorateSwamp();
    this.tileLiquids();
    this.tileLinks();
    this.decorate();
    this.fillOutside();
    this.tileGrounds();
  }

  // Empty map cells around the layout get a filler floor (e.g. outer space) with rare decor.
  private fillOutside(): void {
    const out = this.set.opts.outside;
    if (!out?.floor.length) return;
    const { g, rng } = this;
    const floor = out.floor.filter((c) => this.fits(c)).map((v, i) => ({ v, w: i === 0 ? 8 : 1 }));
    const decor = (out.decor ?? []).filter((c) => this.fits(c));
    if (!floor.length) return;
    for (let i = 0; i < g.kind.length; i++) {
      if (g.kind[i] !== EMPTY || !g.mask[i] || this.used[i] || this.liq[i] >= 0) continue;
      if (decor.length && rng.chance(0.03 + this.p.decor * 0.05) && this.put(i, rng.pick(decor), rng.int(0, 3), (k) => !this.used[k])) continue;
      this.put(i, rng.weighted(floor), rng.int(0, 3));
    }
  }

  // ----- helpers -------------------------------------------------------------------------------

  private xy(i: number): [number, number] {
    return [i % this.W, Math.floor(i / this.W)];
  }

  private hasGround(k: string | null | undefined): k is string {
    return k != null && !!this.set.grounds[k]?.length;
  }

  private famIndex(key: string | undefined): number {
    if (key == null) return -1;
    return this.set.walls.findIndex((f) => f.key === key);
  }

  private roomFams(): number[] {
    const walls = this.set.walls;
    let list = (this.set.opts.roomWalls ?? []).map((k) => this.famIndex(k)).filter((i) => i >= 0);
    if (!list.length) list = walls.map((_, i) => i).filter((i) => walls[i].model === 'edge' && walls[i].h >= 3);
    if (!list.length && walls.length) list = [0];
    return list;
  }

  private famGround(f: number, fallback: string): string {
    const k = this.set.walls[f]?.ground;
    return this.hasGround(k) ? k : fallback;
  }

  private decorList(cat: DecorCat, outdoor = false): string[] {
    return (this.set.decor[cat] ?? []).filter((c) => this.fits(c) && !(outdoor && this.indoor.has(c)));
  }

  private fits(code: string): boolean {
    const [w, d] = this.set.fp[code] ?? [1, 1];
    return w % this.s === 0 && d % this.s === 0;
  }

  private best(pool: Pc[], want: number): { cost: number; list: Cand[] } {
    let mm = this.memo.get(pool);
    if (!mm) this.memo.set(pool, (mm = new Map()));
    let r = mm.get(want);
    if (r) return r;
    let bc = Infinity;
    let list: Cand[] = [];
    for (const pc of pool) {
      for (let o = 0; o < 4; o++) {
        const c = maskCost(pc.m[o], want);
        if (c < bc - 1e-6) {
          bc = c;
          list = [];
        }
        if (Math.abs(c - bc) < 1e-6) list.push({ c: pc.c, o, w: pc.w, m: pc.m[o] });
      }
    }
    r = { cost: bc, list };
    mm.set(want, r);
    return r;
  }

  private pickCand(list: Cand[]): Cand {
    return this.rng.weighted(list.map((c) => ({ v: c, w: c.w })));
  }

  // Macro cells covered by a piece anchored so that its footprint starts at macro cell i.
  private cover(i: number, code: string, o: number): { ax: number; ay: number; cells: number[] } | null {
    const [fw, fd] = this.set.fp[code] ?? [1, 1];
    const offs: [number, number][] = [];
    let minx = Infinity;
    let miny = Infinity;
    for (let u = 0; u < fw; u++) {
      for (let v = 0; v < fd; v++) {
        const [dx, dy] = rotate(u, v, o);
        offs.push([dx, dy]);
        minx = Math.min(minx, dx);
        miny = Math.min(miny, dy);
      }
    }
    const [X, Y] = this.xy(i);
    const s = this.s;
    const bx = X * s;
    const by = Y * s;
    const cells = new Set<number>();
    for (const [dx, dy] of offs) {
      const mx = Math.floor((bx + dx - minx) / s);
      const my = Math.floor((by + dy - miny) / s);
      if (!this.g.in(mx, my)) return null;
      cells.add(this.g.idx(mx, my));
    }
    return { ax: bx - minx, ay: by - miny, cells: [...cells] };
  }

  private layer(off: number): DbbTile[] {
    let l = this.layers.get(off);
    if (!l) this.layers.set(off, (l = []));
    return l;
  }

  private mark(cv: { ax: number; ay: number }, code: string, o: number): void {
    const [fw, fd] = this.set.fp[code] ?? [1, 1];
    const S = this.W * this.s;
    for (let u = 0; u < fw; u++) {
      for (let v = 0; v < fd; v++) {
        const [dx, dy] = rotate(u, v, o);
        const x = cv.ax + dx;
        const y = cv.ay + dy;
        if (x >= 0 && y >= 0 && x < S && y < this.H * this.s) this.occ[y * S + x] = 1;
      }
    }
  }

  private put(i: number, code: string, o: number, ok?: (k: number) => boolean): boolean {
    const cv = this.cover(i, code, o);
    if (!cv) return false;
    if (ok && !cv.cells.every(ok)) return false;
    // on raised terrain the piece sits on top of the support blocks
    const step = this.hs ? this.hs[cv.cells[0]] : 0;
    if (this.hs && cv.cells.some((k) => this.hs![k] !== step)) return false;
    for (const k of cv.cells) this.used[k] = 1;
    this.layer(step * 3).push({ x: cv.ax, y: cv.ay, element: code, orientation: o });
    this.mark(cv, code, o);
    return true;
  }

  // free floor cell for decoration
  private free = (k: number): boolean =>
    this.g.kind[k] !== EMPTY && !this.used[k] && this.liq[k] < 0 && this.lnk[k] < 0 && !this.doors.has(k) && this.want[k] === 0 && !this.nearDoor(k);

  private nearDoor(k: number): boolean {
    const [x, y] = this.xy(k);
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (this.g.in(nx, ny) && this.doors.has(this.g.idx(nx, ny))) return true;
    }
    return false;
  }

  private putDecor(i: number, list: string[], ok: (k: number) => boolean = this.free): boolean {
    if (!list.length) return false;
    for (let t = 0; t < 3; t++) {
      const code = this.rng.pick(list);
      const o = this.rng.int(0, 3);
      if (this.put(i, code, o, ok)) return true;
    }
    return false;
  }

  private neighbours8(i: number, f: (k: number) => boolean): number {
    const [x, y] = this.xy(i);
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if ((dx || dy) && this.g.in(x + dx, y + dy) && f(this.g.idx(x + dx, y + dy))) n++;
      }
    }
    return n;
  }

  // ----- layouts -------------------------------------------------------------------------------

  private layoutDungeon(): void {
    const { g, p, rng } = this;
    const sc = this.s;
    const q = { ...p, roomMin: Math.max(3, Math.round(p.roomMin / sc)), roomMax: Math.max(3, Math.round(p.roomMax / sc)) };
    const target = p.layout === 'fill' ? Infinity : p.roomCount;
    // Retry until every wanted room is placed and connected; keep the best attempt.
    let best: { kind: Uint8Array; room: Int16Array; halo: Uint8Array; rooms: Room[]; doors: [number, Door][]; alive: number } | null = null;
    let sizes = q;
    for (let attempt = 0; attempt < 6; attempt++) {
      g.kind.fill(EMPTY);
      g.room.fill(-1);
      g.halo.fill(0);
      this.rooms.length = 0;
      this.doors.clear();
      placeRooms(g, sizes, rng, this.rooms, target, target === Infinity || attempt > 0, (w, h, shape) => this.pickRoomKind(w, h, shape));
      const placed = this.rooms.length;
      connectRooms(g, q, rng, this.rooms, this.doors);
      keepLargestComponent(g, this.rooms, this.doors);
      const alive = this.rooms.filter((r) => r.alive).length;
      if (!best || alive > best.alive) {
        best = { kind: g.kind.slice(), room: g.room.slice(), halo: g.halo.slice(), rooms: [...this.rooms], doors: [...this.doors], alive };
      }
      if (target === Infinity ? alive === this.rooms.length : alive >= target) break;
      // out of space: retry with smaller rooms (down to the minimum size, then to 3)
      if (placed < target && attempt > 0) {
        sizes = sizes.roomMax > sizes.roomMin
          ? { ...sizes, roomMax: Math.max(sizes.roomMin, Math.floor((sizes.roomMin + sizes.roomMax) / 2)) }
          : { ...sizes, roomMin: 3, roomMax: 3 };
      }
    }
    if (best) {
      g.kind.set(best.kind);
      g.room.set(best.room);
      g.halo.set(best.halo);
      this.rooms.splice(0, this.rooms.length, ...best.rooms);
      this.doors.clear();
      for (const [k, d] of best.doors) this.doors.set(k, d);
    }
    this.regionAll.push(false);
    const fams = this.roomFams();
    const main = fams[0] ?? -1;
    const freeGrounds = Object.keys(this.set.grounds).filter((k) => !this.set.walls.some((f, i) => i !== main && f.ground === k));
    const corridorGround = this.hasGround(this.set.mainGround) ? this.set.mainGround : freeGrounds[0];
    for (let i = 0; i < g.kind.length; i++) {
      if (g.kind[i] === EMPTY) continue;
      this.reg[i] = 0;
      this.fam[i] = main;
      this.gk[i] = this.famGround(main, corridorGround);
    }
    for (const r of this.rooms) {
      if (!r.alive) continue;
      const f = fams.length > 1 ? rng.weighted(fams.map((v, k) => ({ v, w: k === 0 ? 3 : 1 }))) : main;
      const own = this.set.walls[f]?.ground;
      const gr = f !== main && this.hasGround(own)
        ? own
        : rng.weighted(freeGrounds.map((v) => ({ v, w: v === this.set.mainGround ? 4 : 1.2 })));
      for (const i of r.cells) {
        this.fam[i] = f;
        this.gk[i] = gr ?? corridorGround;
      }
    }
    if (p.water > 0.25) this.dungeonChannels(main, corridorGround);
  }

  // Liquid channels (sewers, canals) between distant rooms, with a walkway carved on both sides.
  private dungeonChannels(main: number, ground: string): void {
    const { g, p, rng } = this;
    const fams = this.links.map((_, i) => i).filter((i) => this.links[i].liquid);
    const rooms = this.rooms.filter((r) => r.alive);
    if (!fams.length || rooms.length < 2) return;
    // channels stay in corridor space, one cell clear of rooms, so room walls never cross the water
    const ok = (k: number) => {
      const [x, y] = this.xy(k);
      if (x < 1 || y < 1 || x > g.W - 2 || y > g.H - 2 || !g.mask[k] || this.lnk[k] >= 0) return false;
      return this.neighbours8(k, (n) => g.kind[n] === ROOM) === 0 && g.kind[k] !== ROOM;
    };
    const count = p.water > 0.6 ? 2 : 1;
    for (let c = 0; c < count; c++) {
      const cor: number[] = [];
      for (let i = 0; i < g.kind.length; i++) if (g.kind[i] === CORRIDOR && ok(i)) cor.push(i);
      const pair = this.farPair(cor);
      if (!pair) return;
      const path = this.route(pair[0], pair[1], ok, (k) => (g.kind[k] === EMPTY ? 1.5 : 0));
      if (!path || path.length < 3) continue;
      this.markLink(path, rng.pick(fams));
      for (const i of path) {
        const [x, y] = this.xy(i);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const k = g.idx(x + dx, y + dy);
            if (g.kind[k] !== EMPTY) continue;
            g.kind[k] = CORRIDOR;
            this.reg[k] = 0;
            this.fam[k] = main;
            this.gk[k] = this.famGround(main, ground);
          }
        }
      }
    }
  }

  private pickRoomKind(w: number, h: number, shape: string): RoomKind {
    const { rng, p } = this;
    if (p.decor <= 0 || !rng.chance(0.3 + p.decor * 0.7)) return 'plain';
    const big = Math.min(w, h) >= 5;
    const opts: { v: RoomKind; w: number }[] = [{ v: 'plain', w: 2 }];
    if (this.decorList('furniture').length) opts.push({ v: 'furnished', w: 2 });
    if (this.decorList('treasure').length || this.decorList('props').length) opts.push({ v: 'treasure', w: 1 });
    if (big && (this.decorList('features').length || this.decorList('big').length)) opts.push({ v: 'shrine', w: 1 });
    if (big && this.decorList('columns').length) opts.push({ v: 'hall', w: shape === 'rect' ? 2 : 1 });
    if (big && this.pickLiquid(true) >= 0 && p.water > 0) opts.push({ v: 'pool', w: 0.6 + p.water * 1.5 });
    return rng.weighted(opts);
  }

  private carve(fill: number): void {
    carveCavern(this.g, fill, this.rng);
    keepLargestComponent(this.g, this.rooms, this.doors);
  }

  // Assign wall families by Voronoi zones.
  private zones(fams: number[], mainFam: number, perCells: number): void {
    const { g, rng } = this;
    const cells: number[] = [];
    for (let i = 0; i < g.kind.length; i++) if (g.kind[i] !== EMPTY) cells.push(i);
    if (!cells.length || !fams.length) return;
    const k = Math.max(1, Math.min(7, Math.round(cells.length / perCells)));
    const seeds: { x: number; y: number; f: number }[] = [];
    for (let z = 0; z < k; z++) {
      const [x, y] = this.xy(rng.pick(cells));
      const f = z === 0 || rng.chance(0.35) ? mainFam : rng.pick(fams);
      seeds.push({ x, y, f });
    }
    for (const i of cells) {
      const [x, y] = this.xy(i);
      let best = 0;
      let bd = Infinity;
      seeds.forEach((s, z) => {
        const d = Math.hypot(s.x - x, s.y - y) * (z === 0 ? 0.85 : 1);
        if (d < bd) {
          bd = d;
          best = z;
        }
      });
      this.fam[i] = seeds[best].f;
      this.gk[i] = this.famGround(seeds[best].f, this.set.mainGround);
    }
  }

  private layoutCave(): void {
    this.carve(0.5 + this.p.caveOpenness * 0.18);
    this.regionAll.push(false);
    const walls = this.set.walls;
    const room = new Set(this.set.opts.roomWalls ?? []);
    let fams = walls.map((_, i) => i).filter((i) => !room.has(walls[i].key));
    if (!fams.length) fams = walls.map((_, i) => i);
    const main = Math.max(0, this.famIndex(''));
    for (let i = 0; i < this.g.kind.length; i++) if (this.g.kind[i] !== EMPTY) this.reg[i] = 0;
    this.zones(fams, fams.includes(main) ? main : fams[0], 110);
  }

  private layoutWilds(): void {
    const walls = this.set.walls;
    // link-model walls (e.g. trenches) become linear features in the open
    for (const f of walls) if (f.model === 'link') this.links.push({ key: f.key, liquid: false, pieces: f.base });
    const cliffs = walls.map((_, i) => i).filter((i) => walls[i].model === 'edge');
    if (cliffs.length) this.carve(0.6 + this.p.caveOpenness * 0.25);
    else {
      for (let i = 0; i < this.g.kind.length; i++) this.g.kind[i] = this.g.mask[i] ? CORRIDOR : EMPTY;
    }
    this.fillSmallHoles(8);
    this.regionAll.push(false);
    for (let i = 0; i < this.g.kind.length; i++) if (this.g.kind[i] !== EMPTY) this.reg[i] = 0;
    if (cliffs.length) {
      const byH = [...cliffs].sort((a, b) => walls[a].h - walls[b].h);
      const main = byH[Math.floor((byH.length - 1) / 2)];
      this.zones(cliffs, main, 140);
    }
    for (let i = 0; i < this.g.kind.length; i++) this.gk[i] = this.set.mainGround;
    if (cliffs.length) this.elevate();
  }

  /**
   * Terraces and mesas. `hs` is the height step of every cell (0 = ground, 1-3 = +3/+6/+9). Raised cells stand on support
   * blocks; the cliff is drawn on the lower cell next to them, with the family of the matching drop.
   */
  private elevate(): void {
    const cfg = this.set.opts.elevation;
    if (!cfg || this.p.elevation <= 0) return;
    const { g, p, rng } = this;
    const N = g.W * g.H;
    const classes = cfg.classes.map((keys) => keys.map((k) => this.famIndex(k)).filter((i) => i >= 0));
    if (classes.length < 3 || classes.some((c) => !c.length)) return;
    const dEdge = chebyshev(g, (i) => g.kind[i] === EMPTY, true);
    const ok = (i: number) => g.kind[i] !== EMPTY && dEdge[i] >= 2;
    const sc = Math.max(3, Math.round(Math.min(g.W, g.H) / 2.5));
    const na = this.noise(sc, 0.7);
    const nb = this.noise(Math.max(2, Math.round(sc / 2)), 1.9);
    const field = na.map((v, i) => v * 0.7 + nb[i] * 0.3);
    const vals: number[] = [];
    for (let i = 0; i < N; i++) if (ok(i)) vals.push(field[i]);
    if (vals.length < 9) return;
    vals.sort((a, b) => b - a);
    const share = 0.14 + 0.6 * p.elevation;
    const at = (q: number) => vals[Math.min(vals.length - 1, Math.floor(vals.length * q))];
    const [t1, t2, t3] = [at(share), at(share * 0.6), at(share * 0.3)];
    const hs = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (ok(i)) hs[i] = field[i] >= t3 ? 3 : field[i] >= t2 ? 2 : field[i] >= t1 ? 1 : 0;
    const minAround = (i: number): number => {
      const [x, y] = this.xy(i);
      let m = hs[i];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          m = Math.min(m, g.in(x + dx, y + dy) && g.kind[g.idx(x + dx, y + dy)] !== EMPTY ? hs[g.idx(x + dx, y + dy)] : 0);
        }
      }
      return m;
    };
    // neighbouring cells differ by one step at most, so a ground cell leans on cliffs of one height only
    const settle = () => {
      for (let pass = 0; pass < 6; pass++) {
        let changed = false;
        for (let i = 0; i < N; i++) {
          if (hs[i] < 2) continue;
          const m = minAround(i);
          if (m < hs[i] - 1) {
            hs[i] = m + 1;
            changed = true;
          }
        }
        if (!changed) break;
      }
    };
    settle();
    // drop plateaus that are too small to look like anything
    const minSize = Math.max(3, Math.round(N / 120));
    for (let k = 1; k <= 3; k++) {
      const seen = new Uint8Array(N);
      for (let i = 0; i < N; i++) {
        if (hs[i] < k || seen[i]) continue;
        const comp = flood(g, i, seen, (c) => hs[c] >= k);
        if (comp.length < minSize) for (const c of comp) hs[c] = Math.min(hs[c], k - 1);
      }
    }
    settle();
    // every mountain keeps its own profile: terraces of one step each, or a mesa with a single tall cliff
    const mnt = new Int16Array(N).fill(-1);
    const maps: number[][] = [];
    const seen = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (!hs[i] || seen[i]) continue;
      const comp = flood(g, i, seen, (c) => hs[c] > 0);
      const top = Math.max(...comp.map((c) => hs[c]));
      const map = top === 1 ? [rng.weighted([{ v: 1, w: 2 }, { v: 2, w: 3 }, { v: 3, w: 3 }])]
        : top === 2 ? rng.pick([[1, 2], [1, 3], [2, 3], [1, 2]])
          : [1, 2, 3];
      for (const c of comp) mnt[c] = maps.length;
      maps.push(map);
    }
    if (!maps.length) return;
    for (let i = 0; i < N; i++) if (hs[i]) hs[i] = maps[mnt[i]][hs[i] - 1];
    this.hs = hs;
    this.mnt = mnt;
    this.mntVar = maps.map(() => rng.int(0, 1));
    // the cliff family of every ground cell next to a raised one
    this.drop = new Uint8Array(N);
    this.ringMnt = new Int16Array(N).fill(-1);
    for (let i = 0; i < N; i++) {
      if (g.kind[i] === EMPTY) continue;
      const [x, y] = this.xy(i);
      let d = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!g.in(x + dx, y + dy)) continue;
          const n = g.idx(x + dx, y + dy);
          if (g.kind[n] !== EMPTY && hs[n] - hs[i] > d) {
            d = hs[n] - hs[i];
            this.ringMnt[i] = mnt[n];
          }
        }
      }
      if (!d) continue;
      this.drop[i] = d;
      const list = classes[d - 1];
      this.fam[i] = list[this.mntVar[this.ringMnt[i]] % list.length];
    }
  }

  private tileSupports(): void {
    const cfg = this.set.opts.elevation;
    if (!this.hs || !cfg) return;
    for (let i = 0; i < this.hs.length; i++) {
      const s = this.hs[i];
      if (!s) continue;
      const list = cfg.supports[s - 1] ?? [];
      if (!list.length) continue;
      const code = list[this.mntVar[this.mnt[i]] % list.length];
      const cv = this.cover(i, code, 0);
      if (!cv) continue;
      this.layer(0).push({ x: cv.ax, y: cv.ay, element: code, orientation: 0 });
      this.mark(cv, code, 0);
    }
  }

  private fillSmallHoles(max: number): void {
    const { g } = this;
    const seen = new Uint8Array(g.W * g.H);
    for (let i = 0; i < seen.length; i++) {
      if (g.kind[i] !== EMPTY || seen[i] || !g.mask[i]) continue;
      const comp = flood(g, i, seen, (k) => g.kind[k] === EMPTY && g.mask[k] === 1);
      const edge = comp.some((k) => {
        const [x, y] = this.xy(k);
        for (let d = 0; d < 4; d++) {
          const nx = x + DX[d];
          const ny = y + DY[d];
          if (!g.in(nx, ny) || !g.mask[g.idx(nx, ny)]) return true;
        }
        return false;
      });
      if (!edge && comp.length <= max) for (const k of comp) g.kind[k] = CORRIDOR;
    }
    pruneNubs(g);
  }

  // Rectangular walled buildings on cells accepted by ok(); returns the number placed.
  private placeBuildings(count: number, minS: number, maxS: number, ok: (k: number) => boolean, gap: number, spots?: [number, number][]): void {
    const { g, rng } = this;
    const fams = this.roomFams();
    const indoor = this.hasGround(this.set.opts.indoorGround) ? this.set.opts.indoorGround! : this.set.mainGround;
    const reserved = new Uint8Array(g.W * g.H);
    for (const r of this.rooms) {
      for (let j = -gap; j < r.h + gap; j++) for (let i = -gap; i < r.w + gap; i++) if (g.in(r.x + i, r.y + j)) reserved[g.idx(r.x + i, r.y + j)] = 1;
    }
    for (let a = 0; a < (spots ? spots.length : count * 60) && this.rooms.length < count; a++) {
      const w = rng.int(minS, maxS);
      const h = rng.int(minS, Math.min(maxS, w + 2));
      const x = spots ? spots[a][0] : rng.int(1, g.W - w - 1);
      const y = spots ? spots[a][1] : rng.int(1, g.H - h - 1);
      if (x < 1 || y < 1) continue;
      const cells: number[] = [];
      let good = true;
      for (let j = -1; j <= h && good; j++) {
        for (let i = -1; i <= w && good; i++) {
          const k = g.idx(x + i, y + j);
          if (!g.in(x + i, y + j) || reserved[k] || !ok(k)) good = false;
          else if (i >= 0 && j >= 0 && i < w && j < h) cells.push(k);
        }
      }
      if (!good) continue;
      const id = this.rooms.length;
      const r = this.regionAll.length;
      this.regionAll.push(true);
      const f = fams.length ? rng.weighted(fams.map((v, k) => ({ v, w: k === 0 ? 3 : 1 }))) : -1;
      const gr = this.famGround(f, indoor);
      for (const k of cells) {
        g.kind[k] = ROOM;
        g.room[k] = id;
        this.reg[k] = r;
        this.fam[k] = f;
        this.gk[k] = gr;
      }
      for (let j = -gap; j < h + gap; j++) {
        for (let i = -gap; i < w + gap; i++) if (g.in(x + i, y + j)) reserved[g.idx(x + i, y + j)] = 1;
      }
      const room: Room = { id, x, y, w, h, cells, cx: x + (w - 1) / 2, cy: y + (h - 1) / 2, shape: 'rect', kind: 'plain', alive: true };
      room.kind = this.pickRoomKind(w, h, 'rect');
      if (room.kind === 'pool' || room.kind === 'hall') room.kind = 'furnished';
      this.rooms.push(room);
      // doors facing open cells, preferably toward the map centre
      const cands: { k: number; dir: number; score: number }[] = [];
      for (const k of cells) {
        const [cx, cy] = this.xy(k);
        let dir = -1;
        let n = 0;
        for (let d = 0; d < 4; d++) {
          if (g.room[g.idx(cx + DX[d], cy + DY[d])] !== id) {
            dir = d;
            n++;
          }
        }
        if (n !== 1) continue;
        const o = g.idx(cx + DX[dir], cy + DY[dir]);
        if (g.kind[o] === EMPTY || this.reg[o] === r) continue;
        const score = Math.hypot(cx + DX[dir] * 2 - g.W / 2, cy + DY[dir] * 2 - g.H / 2) + rng.next() * 6;
        cands.push({ k, dir, score });
      }
      cands.sort((a1, b1) => a1.score - b1.score);
      const nd = cands.length && w * h >= 16 && rng.chance(0.4) ? 2 : 1;
      for (const c of cands.slice(0, nd)) this.doors.set(c.k, { cell: c.k, dir: c.dir, part: 'single' });
    }
  }

  private layoutTown(): void {
    const { g, p } = this;
    const outdoor = this.hasGround(this.set.opts.outdoorGround) ? this.set.opts.outdoorGround! : this.set.mainGround;
    for (let i = 0; i < g.kind.length; i++) {
      g.kind[i] = g.mask[i] ? CORRIDOR : EMPTY;
      this.gk[i] = outdoor;
    }
    const boundary = this.famIndex(this.set.opts.boundaryWall);
    this.regionAll.push(false);
    if (boundary >= 0) {
      for (let i = 0; i < g.kind.length; i++) {
        if (g.kind[i] === EMPTY) continue;
        this.reg[i] = 0;
        this.fam[i] = boundary;
      }
    }
    const sc = this.s;
    const minS = Math.max(3, Math.round(p.roomMin / sc));
    const maxS = Math.max(minS, Math.round(p.roomMax / sc));
    const inner = (k: number) => {
      const [x, y] = this.xy(k);
      for (let d = 0; d < 4; d++) if (!g.floor(x + DX[d], y + DY[d])) return false;
      return g.kind[k] === CORRIDOR;
    };
    this.placeBuildings(p.roomCount, minS, maxS, inner, 2);
    if (boundary >= 0) {
      // a gate in the boundary wall
      const fence = this.set.walls[boundary];
      const cands: number[] = [];
      for (let i = 0; i < g.kind.length; i++) {
        if (this.reg[i] !== 0) continue;
        const [x, y] = this.xy(i);
        const out = [0, 1, 2, 3].filter((d) => !g.floor(x + DX[d], y + DY[d]));
        if (out.length === 1) cands.push(i);
      }
      if (fence.doors.length && cands.length) {
        const k = this.rng.pick(cands);
        const [x, y] = this.xy(k);
        const dir = [0, 1, 2, 3].find((d) => !g.floor(x + DX[d], y + DY[d]))!;
        this.doors.set(k, { cell: k, dir, part: 'single' });
      }
    }
  }

  private layoutSwamp(): void {
    const { g, p, rng } = this;
    const water = this.pickLiquid(true, true);
    const land = this.hasGround(this.set.opts.landGround) ? this.set.opts.landGround! : this.set.mainGround;
    this.liquidEdgeOpen = true;
    for (let i = 0; i < g.kind.length; i++) {
      g.kind[i] = g.mask[i] ? CORRIDOR : EMPTY;
      this.gk[i] = land;
    }
    const N = g.W * g.H;
    // land = the high part of a smooth noise field, so islands are big and coherent; its share follows the water setting
    const sc = Math.max(4, Math.round(Math.min(g.W, g.H) / 3.8));
    const na = this.noise(sc, 0.4);
    const nb = this.noise(Math.max(2, Math.round(sc / 2)), 1.1);
    const nc = this.noise(Math.max(2, Math.round(sc / 4)), 2.3);
    const nd = this.noise(2, 0.2);
    const field = na.map((v, i) => v * 0.5 + nb[i] * 0.3 + nc[i] * 0.15 + nd[i] * 0.05);
    const share = Math.min(0.85, Math.max(0.2, 0.7 - p.water * 0.42 + (p.caveOpenness - 0.5) * 0.15));
    const vals: number[] = [];
    for (let i = 0; i < N; i++) if (g.mask[i]) vals.push(field[i]);
    vals.sort((a, b) => b - a);
    const thr = vals.length ? vals[Math.min(vals.length - 1, Math.floor(vals.length * share))] : 0.5;
    let cur = new Uint8Array(N);
    for (let i = 0; i < N; i++) cur[i] = g.mask[i] && field[i] >= thr ? 1 : 0;
    const next = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const n = this.neighbours8(i, (k) => cur[k] === 1);
      next[i] = n >= 5 || (cur[i] && n >= 4) ? 1 : 0;
    }
    cur = next;
    const seen = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (cur[i] && !seen[i]) {
        const comp = flood(g, i, seen, (k) => cur[k] === 1);
        if (comp.length < 6) for (const k of comp) cur[k] = 0;
      }
    }
    // small lakes that do not reach the map edge fill in, so water comes in a few bodies instead of speckles
    const wseen = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (!g.mask[i] || cur[i] || wseen[i]) continue;
      const comp = flood(g, i, wseen, (k) => g.mask[k] === 1 && !cur[k]);
      const edge = comp.some((k) => this.neighbours8(k, (n) => !!g.mask[n]) < 8);
      if (!edge && comp.length < 16) for (const k of comp) cur[k] = 1;
    }
    // small ponds inside the land
    const ponds = Math.round((N / 450) * (0.4 + p.water));
    for (let t = 0; t < ponds; t++) {
      const open: number[] = [];
      for (let i = 0; i < N; i++) if (cur[i] && this.neighbours8(i, (k) => cur[k] === 1) === 8) open.push(i);
      if (!open.length) break;
      const size = rng.int(5, 12);
      const front = [rng.pick(open)];
      const pond = new Set<number>(front);
      while (front.length && pond.size < size) {
        const k = front.splice(rng.int(0, front.length - 1), 1)[0];
        const [x, y] = this.xy(k);
        for (let d = 0; d < 4; d++) {
          const nx = x + DX[d];
          const ny = y + DY[d];
          if (!g.in(nx, ny)) continue;
          const n = g.idx(nx, ny);
          if (!pond.has(n) && cur[n] && this.neighbours8(n, (q) => cur[q] === 1) >= 7) {
            pond.add(n);
            front.push(n);
          }
        }
      }
      for (const k of pond) cur[k] = 0;
    }
    if (water >= 0) for (let i = 0; i < N; i++) if (g.kind[i] !== EMPTY && !cur[i]) this.liq[i] = water;
    this.smoothLiquids();
    this.regionAll.push(false);
    this.keep = new Uint8Array(N);
    this.trail = new Uint8Array(N);
    // huts: 3x3 so that a roof fits on top; the first one is the witch's
    const onLand = (k: number) => g.kind[k] === CORRIDOR && this.liq[k] < 0;
    const want = Math.max(1, Math.round(p.roomCount / 2));
    this.placeBuildings(want, 3, 3, onLand, 3);
    // no room left on the land: raise a small islet for each missing hut, far from the others
    for (let t = 0; t < 8 && this.rooms.length < want; t++) {
      const near = chebyshev(g, (i) => g.room[i] >= 0, false);
      let best = -1;
      let score = -1;
      for (let a = 0; a < 60; a++) {
        const hx = rng.int(3, g.W - 6);
        const hy = rng.int(3, g.H - 6);
        const k = g.idx(hx + 1, hy + 1);
        const s = Math.min(near[k], 14) + rng.next() * 3;
        if (g.mask[k] && near[k] >= 6 && s > score) {
          score = s;
          best = g.idx(hx, hy);
        }
      }
      if (best < 0) break;
      const [hx, hy] = this.xy(best);
      for (let y = hy - 2; y <= hy + 4; y++) {
        for (let x = hx - 2; x <= hx + 4; x++) {
          const corner = (x < hx - 1 || x > hx + 3) && (y < hy - 1 || y > hy + 3);
          if (corner || !g.in(x, y) || !g.mask[g.idx(x, y)]) continue;
          g.kind[g.idx(x, y)] = CORRIDOR;
          this.liq[g.idx(x, y)] = -1;
        }
      }
      this.placeBuildings(this.rooms.length + 1, 3, 3, onLand, 3, [[hx, hy]]);
    }
    for (const r of this.rooms) {
      for (let y = r.y - 2; y < r.y + r.h + 2; y++) for (let x = r.x - 2; x < r.x + r.w + 2; x++) if (g.in(x, y)) this.keep[g.idx(x, y)] = 1;
    }
    // plank trails between the huts, from door to door
    const front = (r: Room): number => {
      for (const dr of this.doors.values()) {
        if (g.room[dr.cell] !== r.id) continue;
        const [x, y] = this.xy(dr.cell);
        return g.idx(x + DX[dr.dir], y + DY[dr.dir]);
      }
      return -1;
    };
    const walk = (k: number) => g.kind[k] === CORRIDOR && this.liq[k] < 0 && g.room[k] < 0 && this.neighbours8(k, (n) => g.room[n] >= 0) === 0;
    const left = [...this.rooms];
    let from = left.shift();
    while (from && left.length) {
      const [fx, fy] = [from.cx, from.cy];
      left.sort((a, b) => Math.hypot(a.cx - fx, a.cy - fy) - Math.hypot(b.cx - fx, b.cy - fy));
      const to = left.shift()!;
      const a = front(from);
      const b = front(to);
      from = to;
      if (a < 0 || b < 0 || this.liq[a] >= 0 || this.liq[b] >= 0) continue;
      const path = this.route(a, b, walk);
      if (!path) continue;
      for (const k of path) {
        this.trail[k] = 1;
        this.keep[k] = 1;
      }
    }
  }

  // Raised-dock bridges that join the islands (nearest first) plus a pier or two reaching into the water.
  private bridges(): void {
    const { g, p, rng } = this;
    const fam = this.famIndex(this.set.opts.swamp?.bridge?.[0]);
    if (fam < 0) return;
    const f = this.set.walls[fam];
    const N = g.W * g.H;
    const land = (k: number) => g.kind[k] !== EMPTY && this.liq[k] < 0;
    const water = (k: number) => g.kind[k] !== EMPTY && this.liq[k] >= 0 && !this.used[k];
    const side = (k: number, d: number) => {
      const [x, y] = this.xy(k);
      return g.in(x + DX[d], y + DY[d]) ? g.idx(x + DX[d], y + DY[d]) : -1;
    };
    const shore = (k: number) => [0, 1, 2, 3].some((d) => side(k, d) >= 0 && water(side(k, d)));
    const seen = new Uint8Array(N);
    const comps: number[][] = [];
    for (let i = 0; i < N; i++) if (land(i) && !seen[i]) comps.push(flood(g, i, seen, land));
    comps.sort((a, b) => b.length - a.length);
    const cells = new Set<number>();
    const connected = comps.length ? [comps[0].filter(shore)] : [];
    let rest = comps.slice(1).filter((c) => c.length >= 8).map((c) => c.filter(shore));
    const dist = (a: number, b: number) => {
      const [ax, ay] = this.xy(a);
      const [bx, by] = this.xy(b);
      return Math.abs(ax - bx) + Math.abs(ay - by);
    };
    for (let n = 0; n < p.paths + 2 && rest.length; n++) {
      let best: [number, number, number] | null = null;
      for (const A of connected) {
        for (const B of rest) {
          for (let t = 0; t < 60; t++) {
            const a = rng.pick(A);
            const b = rng.pick(B);
            const dd = dist(a, b);
            if (dd >= 3 && dd <= 16 && (!best || dd < best[2])) best = [a, b, dd];
          }
        }
      }
      if (!best) break;
      const [a, b] = best;
      const path = this.route(a, b, water);
      if (!path || path.length < 3) break;
      for (const k of path.slice(1, -1)) cells.add(k);
      const hit = rest.find((c) => c.includes(b));
      if (hit) {
        connected.push(hit);
        rest = rest.filter((c) => c !== hit);
      }
    }
    // piers: straight walkways from the shore into open water
    const starts = rng.shuffle((connected.flat()).filter((k) => !this.keep[k]));
    let piers = 1 + Math.round(p.decor);
    for (const k of starts) {
      if (piers <= 0) break;
      const d = rng.int(0, 3);
      const len = rng.int(3, 5);
      const line: number[] = [];
      let c = k;
      for (let i = 0; i < len; i++) {
        c = side(c, d);
        if (c < 0 || !water(c) || cells.has(c)) break;
        line.push(c);
      }
      if (line.length < 3) continue;
      for (const q of line) cells.add(q);
      piers--;
    }
    for (const k of cells) {
      let want = 0;
      for (let d = 0; d < 4; d++) {
        const n = side(k, d);
        if (n < 0 || !(cells.has(n) || land(n))) want |= 1 << d;
      }
      const pool = rng.chance(0.3) ? (rng.chance(0.5) ? f.torch : f.decor) : f.base;
      let b = this.best(pool, want);
      if (!b.list.length || b.cost > 0) b = this.best(f.base, want);
      if (!b.list.length) continue;
      const c = this.pickCand(b.list);
      this.put(k, c.c, c.o);
    }
  }

  // Gradient (Perlin) noise, roughly 0..1, with one random lattice gradient every `cell` map cells; `angle` turns the
  // lattice so that stacked octaves do not share axis-aligned contours.
  private noise(cell: number, angle = 0): Float32Array {
    const { W, H, rng } = this;
    const K = Math.ceil(Math.hypot(W, H) / cell) + 1;
    const gw = 2 * K + 2;
    const gx = new Float32Array(gw * gw);
    const gy = new Float32Array(gw * gw);
    for (let i = 0; i < gx.length; i++) {
      const a = rng.next() * Math.PI * 2;
      gx[i] = Math.cos(a);
      gy[i] = Math.sin(a);
    }
    const out = new Float32Array(W * H);
    const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const fx = (cos * (x - W / 2) - sin * (y - H / 2)) / cell + K;
        const fy = (sin * (x - W / 2) + cos * (y - H / 2)) / cell + K;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const dx = fx - x0;
        const dy = fy - y0;
        const dot = (ix: number, iy: number) => {
          const k = (y0 + iy) * gw + x0 + ix;
          return gx[k] * (dx - ix) + gy[k] * (dy - iy);
        };
        const tx = fade(dx);
        const ty = fade(dy);
        const top = dot(0, 0) + (dot(1, 0) - dot(0, 0)) * tx;
        const bottom = dot(0, 1) + (dot(1, 1) - dot(0, 1)) * tx;
        out[y * W + x] = 0.5 + (top + (bottom - top) * ty) * 0.7;
      }
    }
    return out;
  }

  // Swamp scenery, placed before the water is tiled: plank trails, roofs, mushroom groves, forests, reeds, lilies...
  private decorateSwamp(): void {
    if (!this.set.opts.swamp) return;
    const { g, p, rng } = this;
    const sw = (role: string) => (this.set.opts.swamp?.[role] ?? []).filter((c) => this.fits(c));
    const d = p.decor;
    const N = g.W * g.H;
    const isLand = (k: number) => g.kind[k] !== EMPTY && this.liq[k] < 0 && g.room[k] < 0;
    const landFree = (k: number) => isLand(k) && !this.used[k] && !this.keep[k] && this.want[k] === 0;
    const waterFree = (k: number) => this.liq[k] >= 0 && !this.used[k] && this.liquidWant(k) === 0;
    const dLand = chebyshev(g, (i) => g.kind[i] !== EMPTY && this.liq[i] < 0, false);
    const dWater = chebyshev(g, (i) => this.liq[i] >= 0, false);
    const hutDist = chebyshev(g, (i) => g.room[i] >= 0, false);
    const all = Array.from({ length: N }, (_, i) => i).filter((i) => g.kind[i] !== EMPTY);
    const landCells = rng.shuffle(all.filter(isLand));
    const waterCells = rng.shuffle(all.filter((i) => this.liq[i] >= 0));
    const o = () => rng.int(0, 3);
    const near = (k: number, r: number, f: (n: number, dist: number) => void) => {
      const [x, y] = this.xy(k);
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const dist = Math.hypot(dx, dy);
          if (dist <= r && g.in(x + dx, y + dy)) f(g.idx(x + dx, y + dy), dist);
        }
      }
    };

    // roofs on the huts (level above); the witch's has the tower
    const roofs = sw('roofs');
    const tower = sw('tower');
    this.rooms.forEach((r, n) => {
      if (!r.alive || r.w % 3 || r.h % 3) return;
      for (let by = 0; by < r.h; by += 3) {
        for (let bx = 0; bx < r.w; bx += 3) {
          const list = n === 0 && tower.length ? tower : roofs;
          if (!list.length) continue;
          const code = rng.pick(list);
          const o4 = o();
          const cv = this.cover(g.idx(r.x + bx, r.y + by), code, o4);
          if (cv) this.layer(3).push({ x: cv.ax, y: cv.ay, element: code, orientation: o4 });
        }
      }
    });

    // plank trails
    const trail = sw('trail').map((v, i) => ({ v, w: i < 2 ? 4 : 1 }));
    if (trail.length) for (let k = 0; k < N; k++) if (this.trail[k] && !this.used[k]) this.put(k, rng.weighted(trail), o());
    this.bridges();

    // mushroom groves: tall in the middle, small on the fringe
    const mushLand = sw('mushLand');
    const mushWater = sw('mushWater');
    const centres: number[] = [];
    const groves = Math.round((landCells.length / 280) * (0.5 + d));
    for (let t = 0; t < groves; t++) {
      const inWater = !!mushWater.length && (!mushLand.length || rng.chance(0.25));
      const pool = inWater ? waterCells.filter((k) => dLand[k] >= 2) : landCells.filter((k) => landFree(k) && dWater[k] >= 2);
      if (!pool.length) continue;
      let c = rng.pick(pool);
      const apart = (q: number) => {
        const [ax, ay] = this.xy(q);
        const [bx, by] = this.xy(c);
        return Math.hypot(ax - bx, ay - by) >= 9;
      };
      for (let tries = 0; tries < 12 && !centres.every(apart); tries++) c = rng.pick(pool);
      centres.push(c);
      const codes = inWater ? mushWater : mushLand;
      const r = rng.int(3, 4);
      near(c, r, (k, dist) => {
        if (k !== c && !rng.chance(0.85 * (1 - dist / (r + 0.8)))) return;
        this.put(k, codes[dist < 1.5 ? 2 : dist < 2.8 ? 1 : 0] ?? codes[0], o(), inWater ? waterFree : landFree);
      });
    }

    // ruined wall corners on the meadows
    const ruinAngle = sw('ruinAngle');
    const ruinWall = sw('ruinWall');
    const pcs = this.set.walls.flatMap((w) => [...w.base, ...w.decor]);
    const placeRuin = (k: number, code: string, mask: number) => {
      const o4 = pcs.find((x) => x.c === code)?.m.findIndex((m) => (m & 15) === mask) ?? -1;
      if (o4 >= 0) this.put(k, code, o4, landFree);
    };
    if (ruinAngle.length && ruinWall.length) {
      const ruins = Math.round((landCells.length / 420) * (0.4 + d));
      for (let t = 0; t < ruins; t++) {
        const pool = landCells.filter((k) => landFree(k) && dWater[k] >= 3 && hutDist[k] >= 5);
        if (!pool.length) break;
        const c = rng.pick(pool);
        const [x, y] = this.xy(c);
        const s1 = rng.int(0, 3);
        const s2 = (s1 + 1) % 4;
        placeRuin(c, rng.weighted(ruinAngle.map((v, i) => ({ v, w: i ? 1 : 3 }))), (1 << s1) | (1 << s2));
        for (const [s, dir] of [[s1, (s2 + 2) % 4], [s2, (s1 + 2) % 4]]) {
          for (let i = 1, len = rng.int(1, 3); i <= len; i++) {
            const nx = x + DX[dir] * i;
            const ny = y + DY[dir] * i;
            if (!g.in(nx, ny) || !landFree(g.idx(nx, ny))) break;
            if (!rng.chance(0.2)) placeRuin(g.idx(nx, ny), rng.pick(ruinWall), 1 << s);
          }
        }
      }
    }

    // forests: big trees in zones where a low-frequency noise field is high, open meadows elsewhere, clearings around huts
    const fs = Math.max(4, Math.round(Math.min(g.W, g.H) / 5));
    const fa = this.noise(fs, 0.9);
    const fb = this.noise(Math.max(2, Math.round(fs / 2)), 2.0);
    const forest = fa.map((v, i) => v * 0.7 + fb[i] * 0.3);
    const sorted = landCells.map((k) => forest[k]).sort((a, b) => a - b);
    const quant = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0.5;
    const q0 = quant(0.5);
    const q1 = quant(0.82);
    const dens = (k: number) => Math.max(0, Math.min(1, (forest[k] - q0) / Math.max(1e-6, q1 - q0))) * Math.max(0, Math.min(1, (hutDist[k] - 3) / 4));
    const tSmall = sw('treeSmall');
    const tMid = sw('treeMid');
    const tTall = sw('treeTall');
    const tHaunted = sw('treeHaunted');
    for (const k of landCells) {
      if (!landFree(k)) continue;
      const f = dens(k);
      if (!rng.chance((0.004 + f * f * 0.5) * (0.4 + d * 1.2) * Math.max(0.25, Math.min(1, (hutDist[k] - 2) / 4)))) continue;
      const list = rng.weighted([
        { v: tTall, w: 0.15 + f },
        { v: tMid, w: 0.7 },
        { v: tSmall, w: 1.2 - f },
        { v: tHaunted, w: f > 0.6 ? 0.12 : 0 },
      ].filter((e) => e.v.length));
      if (list) this.put(k, rng.pick(list), o(), landFree);
    }

    // undergrowth
    const tufts = sw('tufts');
    const trap = sw('trap');
    for (const k of landCells) {
      if (!landFree(k)) continue;
      if (tufts.length && rng.chance((dWater[k] <= 1 ? 0.3 : 0.1 + dens(k) * 0.08) * (0.4 + d))) this.put(k, rng.pick(tufts), o(), landFree);
      else if (mushLand.length && rng.chance(0.015 * (0.4 + d))) this.put(k, mushLand[0], o(), landFree);
      else if (trap.length && rng.chance(0.01 * d)) this.put(k, rng.pick(trap), o(), landFree);
    }

    // water: lily clusters, reed beds along the shore, mangrove groves, rocks, wrecks and beasts
    const lilies = sw('lilies');
    const reeds = sw('reeds');
    const longReeds = sw('longReeds');
    const wTree = [sw('wTreeSmall'), sw('wTreeMid'), sw('wTreeTall')];
    const wHaunted = sw('wTreeHaunted');
    const nWater = waterCells.length;
    const poolAt = (minLand: number) => waterCells.filter((k) => dLand[k] >= minLand && waterFree(k));
    const clusters = (count: number, minLand: number, r: number, fill: (k: number, dist: number, r: number) => void) => {
      for (let t = 0; t < count; t++) {
        const pool = poolAt(minLand);
        if (!pool.length) return;
        const c = rng.pick(pool);
        near(c, r, (k, dist) => fill(k, dist, r));
      }
    };
    if (lilies.length) clusters(Math.round((nWater / 70) * (0.4 + d)), 1, 3, (k, dist, r) => {
      if (rng.chance(0.65 * (1 - dist / (r + 1)))) this.put(k, rng.pick(lilies), o(), waterFree);
    });
    clusters(Math.round((nWater / 150) * (0.5 + d)), 3, 4, (k, dist, r) => {
      if (rng.chance(0.6 * (1 - dist / (r + 1)))) {
        const list = rng.weighted([{ v: wTree[2], w: 1 }, { v: wTree[1], w: 1.4 }, { v: wTree[0], w: 1.2 }, { v: wHaunted, w: 0.12 }].filter((e) => e.v.length));
        if (list) this.put(k, rng.pick(list), o(), waterFree);
      }
    });
    for (const k of waterCells) {
      if (dLand[k] > 2 || !waterFree(k) || !rng.chance(0.2 * (0.4 + d))) continue;
      const list = longReeds.length && rng.chance(0.4) ? longReeds : reeds;
      if (list.length) this.put(k, rng.pick(list), o(), waterFree);
    }
    const sprinkle = (codes: string[], perCells: number, minLand: number, min = 0) => {
      if (!codes.length) return;
      const n = Math.max(min, Math.round((nWater / perCells) * (0.4 + d)));
      for (let t = 0; t < n; t++) {
        const pool = poolAt(minLand);
        if (!pool.length) return;
        this.put(rng.pick(pool), rng.pick(codes), o(), waterFree);
      }
    };
    sprinkle(sw('rocks'), 110, 2);
    sprinkle(sw('flotsam'), 70, 1);
    sprinkle(sw('wrecks'), 380, 2, nWater > 200 ? 1 : 0);
    sprinkle(sw('beasts'), 260, 2, nWater > 200 ? 1 : 0);
    sprinkle(sw('vortex'), 700, 3);
  }

  // Ship, bow to the east: a long hull whose bow closes in at 45 degrees to the bowsprit cannon, carved stern wall, compartments inside.
  // Orientation rule for sided pieces: rotating by one step turns the piece a quarter turn clockwise, W -> N -> E -> S.
  private layoutShip(): void {
    const { g, p, rng } = this;
    const ship = this.set.opts.ship;
    let hull = this.famIndex(ship?.hull);
    if (hull < 0) hull = this.roomFams()[0] ?? 0;
    const water = this.pickLiquid(true);
    const L = Math.max(10, Math.min(g.W - 5, 44));
    const B = Math.max(6, Math.min(12, 2 * Math.round(L / 8.8), 2 * Math.floor((g.H - 6) / 2)));
    const x0 = 3 + Math.floor((g.W - 5 - L) / 2);
    const x1 = x0 + L - 1;
    const y0 = Math.floor((g.H - B) / 2);
    const y1 = y0 + B - 1;
    const cy = y0 + B / 2; // the two centre rows are cy-1 and cy
    this.regionAll.push(false);
    for (let i = 0; i < g.kind.length; i++) {
      const [x, y] = this.xy(i);
      const h = x >= x0 && x <= x1 ? Math.min(B / 2, x1 - x + 1) : 0;
      if (h && y >= cy - h && y < cy + h) {
        g.kind[i] = CORRIDOR;
        this.reg[i] = 0;
        this.fam[i] = hull;
        this.gk[i] = this.set.mainGround;
      } else {
        g.kind[i] = EMPTY;
        if (g.mask[i] && water >= 0) this.liq[i] = water;
      }
    }
    // every cell within m of this one is deck: it is not on the hull
    const inDeck = (k: number, m: number) => {
      const [x, y] = this.xy(k);
      for (let dy = -m; dy <= m; dy++) for (let dx = -m; dx <= m; dx++) if (!g.floor(x + dx, y + dy)) return false;
      return true;
    };
    const deckFree = (k: number) => g.kind[k] === CORRIDOR && g.room[k] < 0 && !this.used[k] && !this.nearDoor(k) && inDeck(k, 1);
    const sea = (k: number) => this.liq[k] === water && !this.used[k];
    const list = (k?: string[]) => (k ?? []).filter((c) => this.fits(c));
    // the bowsprit cannon fills the two-cell tip, pointing east
    const bow = list(ship?.bow);
    if (bow.length) this.put(g.idx(x1, cy - 1), rng.pick(bow), 0, (k) => g.kind[k] === CORRIDOR && !this.used[k]);
    this.fitOutShip({ x0, x1, y0, y1, cy, L, B }, deckFree);
    // boats and rocks out at sea
    const boats = ship?.boats ?? [];
    const open = (k: number) => sea(k) && this.neighbours8(k, (n) => g.kind[n] !== EMPTY || this.used[n] === 1) === 0;
    let nb = Math.round(p.water * 2 + p.decor);
    const cells = rng.shuffle(Array.from({ length: g.kind.length }, (_, i) => i).filter(open));
    for (const i of cells) {
      if (nb <= 0 || !boats.length) break;
      if (open(i) && this.putDecor(i, boats, open)) nb--;
    }
  }

  /**
   * The inside of the hull, stern to bow: the captain's cabin, crew quarters, the gun deck (cannon ports in the hull, masts, a
   * hatch) and the cargo hold, separated by bulkheads with a door in the middle. The cabin and the hold are roofed by raised
   * decks (stern castle and forecastle) reached by stairs.
   */
  private fitOutShip(s: { x0: number; x1: number; y0: number; y1: number; cy: number; L: number; B: number }, deckFree: (k: number) => boolean): void {
    const ship = this.set.opts.ship;
    const { g, p, rng } = this;
    const { x0, x1, y0, y1, cy, B } = s;
    const list = (k?: string[]) => (k ?? []).filter((c) => this.fits(c));
    const free = (k: number) => g.kind[k] === CORRIDOR && !this.used[k];
    const at = (x: number, y: number, codes: string[], o = 0) => !!codes.length && this.put(g.idx(x, y), rng.pick(codes), o, deckFree);
    const f = this.set.walls[this.roomFams()[0] ?? 0];
    // orientation of a one-sided wall piece of this family for a wall on `side` (0 W, 1 N, 2 E, 3 S)
    const sideO = (fam: typeof f | undefined, side: number): number => this.best(fam?.base ?? [], 1 << side).list.find((c) => popcount(c.m & 15) === 1)?.o ?? 0;
    // the inside is full width up to here, then the bow narrows
    const last = x1 - B / 2;
    const room = last - x0;
    const cabinW = Math.max(5, Math.min(8, Math.round(room * 0.24)));
    const crewW = room >= 28 ? Math.max(5, Math.min(8, Math.round(room * 0.22))) : 0;
    const holdW = room >= 22 ? 5 : 0;
    const cabin: [number, number] = [x0 + 1, x0 + cabinW];
    const crew: [number, number] | null = crewW ? [cabin[1] + 1, cabin[1] + crewW] : null;
    const gun: [number, number] = [(crew ?? cabin)[1] + 1, last - holdW];
    const hold: [number, number] | null = holdW ? [gun[1] + 1, last] : null;
    // carved stern wall: two-cell panels turned so that the wall is on the west edge
    const back = list(ship?.backWall);
    for (let y = y0 + 1; y < y1 && back.length; y += 2) this.put(g.idx(x0, y), rng.pick(back), 3, free);
    // bulkheads: a wall on the east edge of the last column of each compartment, with a door in the middle
    const wallAt = (x: number, y: number, door: boolean) => {
      if (!f) return;
      const cands: Cand[] = [];
      for (const pc of door ? f.doors : f.base) for (let o = 0; o < 4; o++) if ((pc.m[o] & 15) === 4) cands.push({ c: pc.c, o, w: pc.w, m: pc.m[o] });
      if (!cands.length) return;
      const c = this.pickCand(cands);
      if (this.put(g.idx(x, y), c.c, c.o, free) && door) this.doors.set(g.idx(x, y), { cell: g.idx(x, y), dir: 2, part: 'single' });
    };
    for (const c of [cabin, crew, gun]) {
      if (!c) continue;
      for (let y = y0 + 1; y < y1; y++) wallAt(c[1], y, y === cy && !!f?.doors.length);
    }
    // cannon ports along both sides of the gun deck; the muzzle points through the hull (a two-cell piece: hull cell and deck cell)
    const ports = list(ship?.hullCannon);
    for (let x = gun[0]; x <= gun[1] - 1 && ports.length; x += 2) {
      if (rng.chance(0.85)) this.put(g.idx(x, y0), rng.pick(ports), 3, free);
      if (rng.chance(0.85)) this.put(g.idx(x, y1 - 1), rng.pick(ports), 1, free);
    }
    // masts on the centre line of the gun deck, a hatch and a windlass
    const masts = list(ship?.masts);
    const nm = gun[1] - gun[0] >= 12 ? 2 : 1;
    for (let i = 0; i < nm; i++) {
      const mx = gun[0] + Math.round(((gun[1] - gun[0]) * (i + 1)) / (nm + 1)) - 1;
      for (const dx of [0, -1, 1]) if (at(mx + dx, cy - 1, masts)) break;
    }
    const mid = Math.round((gun[0] + gun[1]) / 2);
    for (const dx of [0, 1, -1, 2, -2]) if (at(mid + dx, cy, list(ship?.hatches))) break;
    at(mid + 2, cy - 1, list(ship?.cargo));
    at(gun[0] + 1, cy, list(ship?.deckItems));
    // raised decks over the cabin and the hold (a deck three units up with a rail on its inner edge and stairs on both sides)
    const floor = list(ship?.platform);
    const rail = list(ship?.rail);
    const stairs = list(ship?.stairs);
    const upCells = new Set<number>();
    const lift = this.layer(3);
    const up = (x: number, y: number, codes: string[], o = 0) => {
      if (!codes.length) return;
      const code = rng.pick(codes);
      const cv = this.cover(g.idx(x, y), code, o);
      if (!cv) return;
      for (const k of cv.cells) upCells.add(k);
      lift.push({ x: cv.ax, y: cv.ay, element: code, orientation: o });
    };
    const cab = floor.length ? up : at;
    // the captain's cabin: the bed's head and the desk's back against the carved stern wall
    const cx = cabin[0];
    cab(cx, y0 + 1, list(ship?.cabinBed), 0);
    cab(cx, cy - 1, list(ship?.cabinDesk), 0);
    cab(cx, y1 - 1, list(ship?.cabinChest), 0);
    if (cabin[1] - cx >= 5) cab(cx + 3, cy - 1, list(ship?.cabinTable), 0);
    cab(cx + 2, y1 - 1, list(ship?.deckLights), 0);
    // crew quarters: hammocks against both side walls (the wall of the piece is on its south side at orientation 0)
    if (crew) {
      for (let x = crew[0]; x <= crew[1] - 1; x += 2) {
        if (rng.chance(0.9)) at(x, y0 + 1, list(ship?.bunks), 2);
        if (rng.chance(0.9)) at(x, y1 - 1, list(ship?.bunks), 0);
      }
      at(crew[0] + 1, cy, list(ship?.cabinChest));
    }
    // cargo hold
    if (hold) {
      for (let x = hold[0]; x <= hold[1]; x++) {
        for (const y of [y0 + 1, y0 + 2, y1 - 2, y1 - 1, cy - 1, cy]) if (rng.chance(0.45 + p.decor * 0.3)) at(x, y, list(ship?.cargo), rng.int(0, 3));
      }
    }
    const raise = (c: [number, number], edgeX: number, outSide: number, stairX: number) => {
      if (!floor.length) return;
      const rows = [y0 + 2, y1 - 2];
      for (let x = c[0]; x <= c[1]; x++) {
        for (let y = y0 + 1; y < y1; y++) if (!(rail.length && x === edgeX && !rows.includes(y)) && !upCells.has(g.idx(x, y))) lift.push({ x, y, element: floor[0], orientation: 0 });
      }
      if (rail.length) {
        const ro = sideO(f, outSide);
        for (let y = y0 + 1; y < y1; y++) if (!rows.includes(y) && !upCells.has(g.idx(edgeX, y))) lift.push({ x: edgeX, y, element: rail[0], orientation: ro });
      }
      // the high end of the stairs is on the side of the deck
      if (stairs.length) for (const y of rows) this.put(g.idx(stairX, y), stairs[0], sideO(f, (outSide + 2) % 4), free);
    };
    raise(cabin, cabin[1], 2, cabin[1] + 1);
    if (hold) raise(hold, hold[0], 0, hold[0] - 1);
  }

  // ----- colossal style ------------------------------------------------------------------------

  /**
   * Multi-level halls. The area is split (BSP) into rectangular regions that are grouped into halls; every region has a
   * height step (0-3) and stands on support blocks. Regions of one hall are terraces joined by grand staircases, halls are
   * joined by doorways (same height) or stairs. Walls rise toward the void (tall at the back, low at the front so the
   * interior stays visible) and between halls of the same height; drops toward lower regions are open ledges.
   */
  private layoutColossal(): void {
    const { g, p, rng } = this;
    const { W, H } = g;
    const N = W * H;
    const e = p.elevation;
    const maxS = Math.min(8, Math.max(3, Math.round(p.roomMax * 0.75)));
    const minS = Math.max(2, Math.min(maxS - 1, Math.round(p.roomMin * 0.6)));
    const leaves: [number, number, number, number][] = [];
    const split = (x: number, y: number, w: number, h: number): void => {
      const canX = w >= 2 * minS;
      const canY = h >= 2 * minS;
      if ((canX || canY) && (w > maxS || h > maxS || (w * h >= 2 * minS * minS && rng.chance(0.2)))) {
        if (canX && (!canY || w > h || (w === h && rng.chance(0.5)))) {
          const c = rng.int(minS, w - minS);
          split(x, y, c, h);
          split(x + c, y, w - c, h);
        } else {
          const c = rng.int(minS, h - minS);
          split(x, y, w, c);
          split(x, y + c, w, h - c);
        }
        return;
      }
      leaves.push([x, y, w, h]);
    };
    split(0, 0, W, H);

    const reg = new Int16Array(N).fill(-1);
    let regions: CRegion[] = [];
    const maskArea = g.mask.reduce((s, v) => s + v, 0);
    for (let attempt = 0; attempt < 5; attempt++) {
      reg.fill(-1);
      regions = [];
      for (const [x, y, w, h] of leaves) {
        const cells: number[] = [];
        for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (g.mask[g.idx(x + i, y + j)]) cells.push(g.idx(x + i, y + j));
        if (cells.length < 2) continue;
        const border = x === 0 || y === 0 || x + w === W || y + h === H;
        if (attempt < 4 && leaves.length > 4 && w * h <= 16 && rng.chance(border ? 0.14 : 0.03)) continue;
        for (const k of cells) reg[k] = regions.length;
        regions.push({ id: regions.length, x, y, w, h, cells, hall: -1, hs: 0, kind: 'plain', style: 'plain', floor: [] });
      }
      // keep the largest connected group of regions
      const seen = new Uint8Array(N);
      let bestComp: number[] = [];
      for (let i = 0; i < N; i++) {
        if (reg[i] < 0 || seen[i]) continue;
        const comp = flood(g, i, seen, (k) => reg[k] >= 0);
        if (comp.length > bestComp.length) bestComp = comp;
      }
      const keepCell = new Uint8Array(N);
      for (const k of bestComp) keepCell[k] = 1;
      for (let i = 0; i < N; i++) if (!keepCell[i]) reg[i] = -1;
      if (bestComp.length >= maskArea * 0.82 || attempt === 4) break;
    }
    const live = regions.filter((r) => reg[r.cells[0]] === r.id);
    // region adjacency (shared boundary length)
    const adj = new Map<number, Map<number, number>>();
    for (const r of live) adj.set(r.id, new Map());
    const pairs = new Map<string, [number, number, number][]>(); // "a,b" (a < b) -> [cell of a, cell of b, side from a]
    for (let k = 0; k < N; k++) {
      if (reg[k] < 0) continue;
      const [x, y] = this.xy(k);
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        if (!g.in(nx, ny)) continue;
        const n = g.idx(nx, ny);
        if (reg[n] < 0 || reg[n] === reg[k]) continue;
        const m = adj.get(reg[k])!;
        m.set(reg[n], (m.get(reg[n]) ?? 0) + 1);
        if (reg[k] < reg[n]) {
          const key = `${reg[k]},${reg[n]}`;
          if (!pairs.has(key)) pairs.set(key, []);
          pairs.get(key)!.push([k, n, d]);
        }
      }
    }

    // halls of 1-3 regions: terraces at different heights
    const halls: number[][] = [];
    const pT = e <= 0 ? 0 : 0.3 + 0.45 * e;
    for (const r0 of rng.shuffle(live.map((r) => r.id))) {
      if (regions[r0].hall >= 0) continue;
      const hall = [r0];
      regions[r0].hall = halls.length;
      halls.push(hall);
      for (let chance = pT; hall.length < 3 && rng.chance(chance); chance *= 0.6) {
        const cands = hall.flatMap((q) => [...adj.get(q)!].filter(([n, len]) => regions[n].hall < 0 && len >= 2).map(([n]) => n));
        if (!cands.length) break;
        const n = rng.pick(cands);
        regions[n].hall = regions[r0].hall;
        hall.push(n);
      }
    }
    // heights and connections; rerolled when some terrace cannot be reached (thin regions or too high drops)
    for (let attempt = 0; ; attempt++) {
      this.doors.clear();
      this.cStairs.clear();
      this.cRuns = [];
      // heights: a walk over the regions so every region is within stair reach (3 steps) of the one it was reached from;
      // terraces of one hall always differ from each other, neighbouring halls often step up or down
      const maxH = e <= 0 || attempt >= 7 ? 0 : Math.round(Math.min(9, 2 + e * 10) / (attempt >= 5 ? 2 : 1));
      const hsOf = new Int8Array(regions.length).fill(-1);
      const tilt = rng.next() * 0.6;
      const tgt = (r: number) => {
        const q = regions[r];
        const fx = (q.x + q.w / 2) / W;
        const fy = (q.y + q.h / 2) / H;
        return maxH * (1.15 - (fx + fy) * (0.55 + tilt * 0.5)) ;
      };
      const start = live.reduce((a, b) => (b.x + b.w + b.y + b.h > a.x + a.w + a.y + a.h ? b : a));
      hsOf[start.id] = 0;
      const queue = [start.id];
      while (queue.length) {
        const r = queue.splice(rng.int(0, Math.min(2, queue.length - 1)), 1)[0];
        for (const [n] of rng.shuffle([...adj.get(r)!])) {
          if (hsOf[n] >= 0) continue;
          const same = regions[n].hall === regions[r].hall;
          const taken = new Set([...adj.get(n)!.keys()].filter((q) => regions[q].hall === regions[n].hall && hsOf[q] >= 0).map((q) => hsOf[q]));
          const opts: { v: number; w: number }[] = [];
          for (let v = 0; v <= maxH; v++) {
            const dd = Math.abs(v - hsOf[r]);
            if (dd > (same ? 3 : 6) || taken.has(v)) continue;
            let w = same ? [0, 1.5, 3, 1.5][dd] : [1 - 0.6 * e, 0.5, 1 + e, 0.8 + e, 0.4 + e, 0.3 + e, 0.2 + e][dd];
            if (Math.abs(v - tgt(n)) < Math.abs(hsOf[r] - tgt(n))) w *= 1.8; // terraces rise toward the back of the map
            else if (Math.abs(v - tgt(n)) > Math.abs(hsOf[r] - tgt(n))) w *= 0.55;
            if (w > 0) opts.push({ v, w });
          }
          hsOf[n] = opts.length ? rng.weighted(opts) : hsOf[r];
          queue.push(n);
        }
      }
      const hs = new Uint8Array(N);
      for (const r of live) {
        r.hs = hsOf[r.id];
        for (const k of r.cells) {
          hs[k] = r.hs;
          g.kind[k] = ROOM;
          g.room[k] = r.hall;
          this.reg[k] = r.hall;
        }
      }
      this.hs = hs;
      this.cReg = reg;
      this.cRegions = regions;

      // wall height class (1-3 = low/medium/tall) of every cell side; drops toward higher regions are recorded (for stairs)
      // but stay open so the support blocks show the height difference
      const side = new Uint8Array(N * 4);
      const back = [3, 3, 3, 3, 3, 2, 2, 2, 2, 2];
      const inner = [2, 2, 2, 2, 2, 1, 1, 1, 1, 1];
      this.want = new Int16Array(N);
      for (let k = 0; k < N; k++) {
        if (reg[k] < 0) continue;
        const [x, y] = this.xy(k);
        const h = hs[k];
        for (let d = 0; d < 4; d++) {
          const nx = x + DX[d];
          const ny = y + DY[d];
          const n = g.in(nx, ny) ? g.idx(nx, ny) : -1;
          let c = 0;
          let wall = true;
          if (n < 0 || reg[n] < 0) c = d <= 1 ? back[h] : 1;
          else if (reg[n] === reg[k]) c = 0;
          else if (hs[n] > h) {
            c = hs[n] - h;
            wall = false;
          } else if (hs[n] === h && d <= 1 && regions[reg[n]].hall !== regions[reg[k]].hall) c = inner[h];
          side[k * 4 + d] = c;
          if (c && wall) this.want[k] |= 1 << d;
        }
      }
      this.cSide = side;

      // connections: grand staircases between the terraces of a hall, doorways and stairs between halls
      this.keep = new Uint8Array(N);
      const keep = this.keep;
      const busy = (k: number) => this.doors.has(k) || this.cStairs.has(k) || this.used[k] === 1;
      const rh = hs.slice(); // region floor heights (stair cells may be raised below)
      const conn = (list: [number, number, number][], grand: boolean, force = false): boolean => {
        const [k0, n0] = list[0];
        if (Math.abs(rh[k0] - rh[n0]) > 6) return false;
        if (rh[k0] === rh[n0] && list.some(([k, n, d]) => !side[k * 4 + d] && !side[n * 4 + ((d + 2) % 4)])) return true;
        if (rh[k0] === rh[n0]) {
          const c: [number, number, number][] = [];
          for (const [k, n, d] of list) {
            const o = side[k * 4 + d] ? k : n;
            const s = o === k ? d : (d + 2) % 4;
            const q = o === k ? n : k;
            if (side[o * 4 + s] && (force || this.want[o] === 1 << s) && !busy(o) && !busy(q)) c.push([o, s, q]);
          }
          if (!c.length) return false;
          if (force) {
            // archway: just open the wall
            const [o, s, q] = rng.pick(c);
            this.want[o] &= ~(1 << s);
            side[o * 4 + s] = 0;
            keep[o] = keep[q] = 1;
            return true;
          }
          const [o, s, q] = c[Math.min(c.length - 1, Math.max(0, Math.floor(c.length / 2) + rng.int(-1, 1)))];
          this.doors.set(o, { cell: o, dir: s, part: 'single' });
          keep[o] = keep[q] = 1;
          return true;
        }
        const cfg = this.set.opts.colossal!;
        const big = grand || rng.chance(0.65);
        const pickStair = (drop: number) => {
          const l2 = (big ? cfg.bigStairs : cfg.stairs)?.[drop - 1]?.filter((x) => this.fits(x)) ?? [];
          return l2.length ? rng.weighted(l2.map((v) => ({ v, w: v === 'CD-109' ? 0.4 : 1 }))) : '';
        };
        const tot = Math.abs(rh[k0] - rh[n0]);
        const chain = (n: number) => {
          // landing, n flights (later ones raised on supports) and the top, in a row straddling the boundary at any offset
          const opts: [number, number[]][] = [];
          for (const [k, n2, d] of list) {
            const [l, s, u] = rh[k] < rh[n2] ? [k, d, n2] : [n2, (d + 2) % 4, k];
            const [x, y] = this.xy(l);
            for (let back = 0; back <= n; back++) {
              const ch: number[] = [];
              for (let i = 0; i < n + 2; i++) {
                const t = i - back;
                const cx = x + DX[s] * t;
                const cy = y + DY[s] * t;
                if (!g.in(cx, cy)) break;
                const q = g.idx(cx, cy);
                const home = t <= 0 ? l : u;
                const end = i === 0 || i === n + 1;
                const okReg = reg[q] === reg[home] || (force && end && reg[q] >= 0 && rh[q] === rh[home]);
                if (!okReg || busy(q) || this.cStairs.has(q)) break;
                if (!end && !force && this.want[q] !== 0) break;
                ch.push(q);
              }
              if (ch.length === n + 2) opts.push([s, ch]);
            }
          }
          if (!opts.length) return false;
          const [s, ch] = opts[Math.min(opts.length - 1, Math.max(0, Math.floor(opts.length / 2) + rng.int(-1, 1)))];
          const drops = n === 1 ? [tot] : [Math.ceil(tot / 2), tot - Math.ceil(tot / 2)];
          const codes = drops.map(pickStair);
          if (codes.some((x) => !x)) return false;
          let h = Math.min(rh[k0], rh[n0]);
          for (let i = 0; i < n; i++) {
            const q = ch[i + 1];
            hs[q] = h;
            h += drops[i];
            this.cStairs.set(q, { s, code: codes[i] });
            this.want[q] = 0;
          }
          for (const q of ch) keep[q] = 1;
          return true;
        };
        if (tot > 3) return chain(2);
        const c: [number, number, number, number][] = []; // low cell, side toward the high one, high cell, front cell
        for (const [k, n, d] of list) {
          const [l, s, u] = rh[k] < rh[n] ? [k, d, n] : [n, (d + 2) % 4, k];
          const [x, y] = this.xy(l);
          const fx = x - DX[s];
          const fy = y - DY[s];
          if (!g.in(fx, fy)) continue;
          const f = g.idx(fx, fy);
          const sameFloor = force ? reg[f] >= 0 && rh[f] === rh[l] : reg[f] === reg[l];
          if ((!force && this.want[l] !== 0) || busy(l) || busy(u) || busy(f) || !sameFloor || this.cStairs.has(f)) continue;
          c.push([l, s, u, f]);
        }
        if (!c.length) return force && chain(1);
        c.sort((a, b) => a[0] - b[0]);
        const runs: (typeof c)[] = [];
        for (const x of c) {
          const last = runs[runs.length - 1]?.[runs[runs.length - 1].length - 1];
          const [ax, ay] = last ? this.xy(last[0]) : [-9, -9];
          const [bx, by] = this.xy(x[0]);
          if (last && Math.abs(ax - bx) + Math.abs(ay - by) === 1) runs[runs.length - 1].push(x);
          else runs.push([x]);
        }
        let run: typeof c;
        if (grand) {
          run = runs.sort((a, b) => b.length - a.length)[0];
          if (run.length >= 5 && rng.chance(0.6)) run = run.slice(1, -1);
        } else {
          const all = runs.flat();
          run = [all[Math.min(all.length - 1, Math.max(0, Math.floor(all.length / 2) + rng.int(-1, 1)))]];
        }
        const total = tot;
        const code = pickStair(total);
        if (!code) return false;
        for (const [l, s, u, f] of run) {
          this.cStairs.set(l, { s, code });
          this.want[l] = 0;
          keep[l] = keep[u] = keep[f] = 1;
        }
        if (grand && run.length >= 2) this.cRuns.push(run.map(([l, s, u]) => [l, s, u]));
        return true;
      };
      const parent = live.map((r) => r.id);
      const ids = new Map(live.map((r, i) => [r.id, i]));
      const find = (r: number): number => {
        let i = ids.get(r)!;
        while (parent[i] !== live[i].id) i = ids.get(parent[i])!;
        return live[i].id;
      };
      const union = (a: number, b: number) => {
        parent[ids.get(find(a))!] = find(b);
      };
      const entries = rng.shuffle([...pairs.entries()]);
      const linked = new Set<string>();
      for (const [key, list] of entries) {
        const [a, b] = key.split(',').map(Number);
        if (regions[a].hall !== regions[b].hall) continue;
        if (conn(list, true)) {
          union(a, b);
          linked.add(key);
        }
      }
      for (const [key, list] of entries) {
        const [a, b] = key.split(',').map(Number);
        if (regions[a].hall === regions[b].hall || find(a) === find(b)) continue;
        if (conn(list, false)) {
          union(a, b);
          linked.add(key);
        }
      }
      for (const [key, list] of entries) {
        const [a, b] = key.split(',').map(Number);
        if (linked.has(key) || !rng.chance(p.loops * 0.6)) continue;
        if (conn(list, regions[a].hall === regions[b].hall)) linked.add(key);
      }
      for (const [key, list] of entries) {
        const [a, b] = key.split(',').map(Number);
        if (find(a) !== find(b) && conn(list, false, true)) union(a, b);
      }
      const comps = new Set(live.map((r) => find(r.id))).size;
      if (comps === 1 || attempt >= 7) {
        break;
      }
    }
    this.regionAll.push(...halls.map(() => true));
    for (const hall of halls) {
      const cells = hall.flatMap((r) => regions[r].cells);
      const xs = cells.map((k) => k % W);
      const ys = cells.map((k) => Math.floor(k / W));
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      const w = Math.max(...xs) - x + 1;
      const h = Math.max(...ys) - y + 1;
      this.rooms.push({ id: this.rooms.length, x, y, w, h, cells, cx: x + (w - 1) / 2, cy: y + (h - 1) / 2, shape: 'rect', kind: 'plain', alive: true });
    }
  }

  // Places a piece at an explicit height (columns on top of their floor, supports, pits).
  private placeAt(i: number, code: string, o: number, lvl: number, use = true): boolean {
    const cv = this.cover(i, code, o);
    if (!cv) return false;
    if (use) for (const k of cv.cells) this.used[k] = 1;
    this.layer(lvl).push({ x: cv.ax, y: cv.ay, element: code, orientation: o });
    this.mark(cv, code, o);
    return true;
  }

  private tileColossal(): void {
    const cfg = this.set.opts.colossal!;
    const { g, rng } = this;
    const hs = this.hs!;
    const N = g.W * g.H;
    const reg = this.cReg;
    const regions = this.cRegions;
    const ok = (l?: string[]) => (l ?? []).filter((c) => this.fits(c));
    const busy = (k: number) => this.doors.has(k) || this.cStairs.has(k);
    const open = (k: number) => reg[k] >= 0 && this.want[k] === 0 && !this.used[k] && !this.keep[k] && !busy(k);
    const noSupport = new Uint8Array(N);

    // the look of every hall
    const floors = (cfg.floors ?? []).map((f) => f.split(' ').filter((c) => this.fits(c))).filter((f) => f.length);
    const hallLook = new Map<number, { style: string; floor: string[] }>();
    for (const r of regions) {
      if (reg[r.cells[0]] !== r.id) continue;
      let look = hallLook.get(r.hall);
      if (!look) {
        const style = rng.weighted([{ v: 'plain', w: 4 }, { v: 'rock', w: 2 }, { v: 'ruins', w: 1.2 }, { v: 'columns', w: 2 }]);
        const floor = floors.length ? rng.weighted(floors.map((v, i) => ({ v, w: i === 0 ? 5 : 2 }))) : [];
        hallLook.set(r.hall, (look = { style, floor }));
      }
      r.style = look.style;
      r.floor = look.floor;
    }

    this.colossalGiantEntrance(cfg);
    this.colossalFeatures(cfg, open, noSupport);

    // walls, doorways and stairs
    const fam = cfg.walls.map((k) => this.famIndex(k));
    const pools = new Map<string, Pc[]>();
    const pool = (cls: number, style: string): Pc[] => {
      const key = `${cls}:${style}`;
      let pl = pools.get(key);
      if (!pl) {
        const f = this.set.walls[fam[cls - 1]];
        const codes = cfg.styles?.[style];
        pl = !f ? [] : codes ? [...f.base, ...f.decor].filter((pc) => codes.includes(pc.c)) : f.base;
        pools.set(key, pl);
      }
      return pl;
    };
    const doors = ok(cfg.doors);
    for (let k = 0; k < N; k++) {
      if (reg[k] < 0 || this.used[k]) continue;
      const st = this.cStairs.get(k);
      if (st) {
        this.put(k, st.code, (st.s + 3) % 4);
        continue;
      }
      const door = this.doors.get(k);
      if (door) {
        if (this.cSide[k * 4 + door.dir] >= 2 && doors.length) this.put(k, rng.pick(doors), door.dir);
        continue;
      }
      const want = this.want[k];
      if (!want) continue;
      let cls = 0;
      for (let d = 0; d < 4; d++) if (want & (1 << d)) cls = Math.max(cls, this.cSide[k * 4 + d]);
      const r = regions[reg[k]];
      let style = r.style;
      if (style === 'columns' && rng.chance(0.15)) style = 'columnRuins';
      if (style === 'plain' && rng.chance(0.1)) style = rng.pick(['ruins', 'rock']);
      let b = this.best(pool(cls, style), want);
      if (!b.list.length || b.cost > 0) b = this.best(pool(cls, 'plain'), want);
      if (!b.list.length) continue;
      const c = this.pickCand(b.list);
      this.put(k, c.c, c.o);
    }

    // support blocks under raised cells (stacked for the highest terraces)
    const sup = cfg.supports;
    for (let k = 0; k < N; k++) {
      if (reg[k] < 0 || !hs[k]) continue;
      for (let h = hs[k] - (noSupport[k] ? 2 : 0), z = 0; h > 0; ) {
        const n = Math.min(h, sup.length);
        if (!sup[n - 1]) break;
        this.placeAt(k, sup[n - 1], 0, z, false);
        h -= n;
        z += n * 3;
      }
    }

    // floors
    for (let k = 0; k < N; k++) {
      if (reg[k] < 0 || this.used[k]) continue;
      const f = regions[reg[k]].floor;
      const list = f.length ? f : (this.set.grounds[this.set.mainGround] ?? []).map((w) => w.v);
      if (list.length) this.put(k, rng.pick(list), rng.int(0, 3));
    }
  }

  // A giant gate in a tall back wall of a low hall.
  private colossalGiantEntrance(cfg: Colossal): void {
    const giant = (cfg.giant ?? []).filter((c) => (this.set.fp[c] ?? [1, 1])[1] === 2 * this.s);
    if (!giant.length) return;
    const { g, rng } = this;
    const hs = this.hs!;
    const reg = this.cReg;
    const cands: [number, number, number][] = [];
    for (let k = 0; k < g.W * g.H; k++) {
      if (reg[k] < 0 || hs[k] > 1) continue;
      for (const s of [0, 1]) {
        if (this.want[k] !== 1 << s || this.cSide[k * 4 + s] < 3) continue;
        const [x, y] = this.xy(k);
        const [mx, my] = s === 0 ? [x, y + 1] : [x + 1, y];
        if (!g.in(mx, my)) continue;
        const m = g.idx(mx, my);
        if (reg[m] !== reg[k] || this.want[m] !== 1 << s || this.cSide[m * 4 + s] < 3) continue;
        if (this.doors.has(k) || this.doors.has(m) || this.cStairs.has(k) || this.cStairs.has(m)) continue;
        cands.push([k, m, s]);
      }
    }
    if (!cands.length) return;
    const [k, m, s] = rng.pick(cands);
    if (!this.put(k, rng.pick(giant), s)) return;
    for (const c of [k, m]) {
      const [x, y] = this.xy(c);
      const fx = x - DX[s];
      const fy = y - DY[s];
      if (g.in(fx, fy)) this.keep[g.idx(fx, fy)] = 1;
    }
  }

  private colossalFeatures(cfg: Colossal, open: (k: number) => boolean, noSupport: Uint8Array): void {
    const { g, p, rng } = this;
    const hs = this.hs!;
    const reg = this.cReg;
    const d = p.decor;
    const ok = (l?: string[]) => (l ?? []).filter((c) => this.fits(c));
    const floorOf = (k: number) => {
      const f = this.cRegions[reg[k]].floor;
      return f.length ? rng.pick(f) : (this.set.grounds[this.set.mainGround]?.[0]?.v ?? '');
    };
    const columns = ok(cfg.columns);
    const caps = ok(cfg.caps);
    const statues = ok(cfg.statues);
    const ruined = ok(cfg.ruinedStatues);
    const fires = ok(cfg.fires);
    const wells = ok(cfg.wells);
    const thrones = ok(cfg.thrones);
    const coffins = ok(cfg.coffins);
    const gold = ok(cfg.gold);
    const pits = ok(cfg.pits);
    const rubble = ok(cfg.rubble);
    const grass = ok(cfg.grass);
    const grassDecor = ok(cfg.grassDecor);
    const guardians = ok(cfg.guardians);
    const bigStairs = (cfg.bigStairs ?? []).map(ok);
    const angles = ok(cfg.stairAngles);
    const pedestals = ok(cfg.pedestals);
    const broken = ok(cfg.brokenColumns);

    // a column stands on its own floor tile
    const column = (k: number, code: string, cap: boolean) => {
      const f = floorOf(k);
      if (!f || !this.put(k, f, rng.int(0, 3))) return;
      this.placeAt(k, code, 0, hs[k] * 3 + 1, false);
      if (cap && caps.length) this.placeAt(k, rng.pick(caps), 0, hs[k] * 3 + 10, false);
    };

    // stepped pyramid centred on c: rings of big stairs climbing toward the top cell
    const pyramid = (c: number, levels: number, top: string[]) => {
      const [cx, cy] = this.xy(c);
      const base = hs[c];
      for (let rr = levels; rr >= 1; rr--) {
        for (let dy = -rr; dy <= rr; dy++) {
          for (let dx = -rr; dx <= rr; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== rr) continue;
            const k = g.idx(cx + dx, cy + dy);
            hs[k] = base + levels - rr;
            const corner = Math.abs(dx) === rr && Math.abs(dy) === rr;
            if (corner) {
              const ci = [0, 1, 2, 3].find((q) => CX[q] === -Math.sign(dx) && CY[q] === -Math.sign(dy))!;
              if (angles[0]) this.put(k, angles[0], ci);
            } else {
              const s = Math.abs(dx) === rr ? (dx < 0 ? 2 : 0) : dy < 0 ? 3 : 1;
              const st = bigStairs[0]?.[0];
              if (st) this.put(k, st, (s + 3) % 4);
            }
          }
        }
      }
      hs[c] = base + levels;
      const t = top.length ? rng.pick(top) : '';
      if (t) this.put(c, t, rng.pick([0, 1]));
      else this.put(c, floorOf(c), 0);
    };
    const blockAt = (r: CRegion, c: number, rad: number) => {
      const [cx, cy] = this.xy(c);
      for (let dy = -rad; dy <= rad; dy++) {
        for (let dx = -rad; dx <= rad; dx++) {
          if (!g.in(cx + dx, cy + dy)) return false;
          const k = g.idx(cx + dx, cy + dy);
          if (reg[k] !== r.id || !open(k)) return false;
        }
      }
      return true;
    };
    const centreBlock = (r: CRegion, rad: number): number => {
      const mx = r.x + (r.w - 1) / 2;
      const my = r.y + (r.h - 1) / 2;
      let best = -1;
      let bd = Infinity;
      for (const k of r.cells) {
        const [x, y] = this.xy(k);
        const dd = Math.abs(x - mx) + Math.abs(y - my) + rng.next() * 0.5;
        if (dd < bd && blockAt(r, k, rad)) {
          bd = dd;
          best = k;
        }
      }
      return best;
    };

    // guardians on both sides of the top of grand staircases
    for (const run of this.cRuns) {
      if (!guardians.length || !rng.chance(0.3 + d * 0.5)) continue;
      const [, s] = run[0];
      const lat = [(s + 1) % 4, (s + 3) % 4];
      const ends = [run[0][2], run[run.length - 1][2]];
      const ups = new Set(run.map((x) => x[2]));
      for (const u of ends) {
        const [ux, uy] = this.xy(u);
        for (const ld of lat) {
          const nx = ux + DX[ld];
          const ny = uy + DY[ld];
          if (!g.in(nx, ny)) continue;
          const n = g.idx(nx, ny);
          if (ups.has(n) || reg[n] !== reg[u] || !open(n)) continue;
          this.put(n, guardians[ld === lat[0] ? 0 : guardians.length - 1], (s + 2) % 4);
        }
      }
    }

    let thronePlaced = false;
    const live = this.cRegions.filter((r) => reg[r.cells[0]] === r.id);
    for (const r of rng.shuffle([...live])) {
      const inner = r.cells.filter(open);
      if (!inner.length) continue;
      const big = r.w >= 4 && r.h >= 4;
      const kinds: { v: string; w: number }[] = [
        { v: 'plain', w: 1 },
        { v: 'colonnade', w: big && columns.length ? 3 : 0 },
        { v: 'ziggurat', w: r.w >= 5 && r.h >= 5 ? 3 : r.w >= 3 && r.h >= 3 ? 1 : 0 },
        { v: 'throne', w: !thronePlaced && thrones.length && r.w >= 4 && r.h >= 4 ? 2 : 0 },
        { v: 'crypt', w: coffins.length && inner.length >= 3 ? 1.2 : 0 },
        { v: 'pits', w: pits.length && r.hs >= 2 && inner.length >= 3 ? 2.5 : 0 },
        { v: 'atrium', w: grass.length && inner.length >= 4 ? 0.8 : 0 },
        { v: 'shrine', w: fires.length + wells.length && inner.length >= 2 ? 1 : 0 },
      ];
      r.kind = rng.weighted(kinds.filter((x) => x.w > 0));
      switch (r.kind) {
        case 'ziggurat':
        case 'throne': {
          const two = r.kind === 'ziggurat' && r.hs <= 6 ? centreBlock(r, 2) : -1;
          const c = two >= 0 ? two : centreBlock(r, 1);
          if (c < 0) break;
          if (r.kind === 'throne') thronePlaced = true;
          pyramid(c, two >= 0 ? 2 : 1, r.kind === 'throne' ? thrones : [...statues, ...fires, ...statues]);
          break;
        }
        case 'colonnade': {
          const cap = rng.chance(0.5);
          const code = rng.pick(columns);
          for (const k of r.cells) {
            const [x, y] = this.xy(k);
            if ((x - r.x) % 2 === 1 && (y - r.y) % 2 === 1 && open(k)) {
              if (broken.length && rng.chance(0.12)) column(k, rng.pick(broken), false);
              else column(k, code, cap);
            }
          }
          break;
        }
        case 'crypt': {
          const o = rng.int(0, 3);
          let goldLeft = gold.length ? 1 : 0;
          for (const k of r.cells) {
            const [x, y] = this.xy(k);
            if (!open(k) || (o % 2 === 0 ? (x - r.x) % 2 : (y - r.y) % 2) !== 1 || !rng.chance(0.85)) continue;
            this.put(k, goldLeft-- > 0 && rng.chance(0.4) ? gold[0] : rng.pick(coffins), o);
          }
          break;
        }
        case 'pits':
          for (const k of rng.shuffle([...inner])) {
            if (!open(k) || !rng.chance(0.45)) continue;
            if (this.neighbours8(k, (n) => noSupport[n] === 1) > 1) continue;
            noSupport[k] = 1;
            this.placeAt(k, rng.pick(pits), rng.int(0, 3), (hs[k] - 2) * 3);
          }
          break;
        case 'atrium':
          for (const k of inner) {
            if (!open(k)) continue;
            if (grassDecor.length && rng.chance(0.3 + d * 0.3)) this.put(k, rng.pick(grassDecor), rng.int(0, 3));
            else this.put(k, rng.pick(grass), rng.int(0, 3));
          }
          break;
        case 'shrine': {
          const c = centreBlock(r, 0);
          if (c >= 0) this.put(c, rng.pick([...fires, ...wells, ...pedestals]), rng.int(0, 3));
          break;
        }
      }
      // statues watch over the corners of large halls
      if (big && statues.length && (r.kind === 'plain' || r.kind === 'colonnade' || r.kind === 'throne')) {
        for (const [x, y] of [[r.x + 1, r.y + 1], [r.x + r.w - 2, r.y + 1], [r.x + 1, r.y + r.h - 2], [r.x + r.w - 2, r.y + r.h - 2]]) {
          if (g.in(x, y) && reg[g.idx(x, y)] === r.id && open(g.idx(x, y)) && rng.chance(0.25 + d * 0.4)) this.put(g.idx(x, y), rng.pick(rng.chance(0.2) && ruined.length ? ruined : statues), rng.int(0, 3));
        }
      }
      for (const k of r.cells) {
        if (!open(k)) continue;
        if (rubble.length && rng.chance(d * 0.16)) this.put(k, rng.pick(rubble), rng.int(0, 3));
        else if (fires.length && rng.chance(d * 0.03)) this.put(k, rng.pick(fires), rng.int(0, 3));
      }
    }
  }

  // ----- walls ---------------------------------------------------------------------------------

  private outsideOf(i: number, x: number, y: number): boolean {
    const { g } = this;
    if (!g.in(x, y)) return true;
    const k = g.idx(x, y);
    if (g.kind[k] === EMPTY) return true;
    if (this.hs && this.hs[k] > this.hs[i]) return true;
    const r = this.reg[i];
    if (this.reg[k] === r) return false;
    return this.regionAll[r];
  }

  private computeWant(): void {
    const { g } = this;
    this.want = new Int16Array(g.W * g.H);
    for (let i = 0; i < g.kind.length; i++) {
      if (g.kind[i] === EMPTY || this.reg[i] < 0) continue;
      const f = this.set.walls[this.fam[i]];
      if (!f || f.model !== 'edge') continue;
      const [x, y] = this.xy(i);
      let m = 0;
      for (let d = 0; d < 4; d++) if (this.outsideOf(i, x + DX[d], y + DY[d])) m |= 1 << d;
      for (let c = 0; c < 4; c++) {
        if (m & ((1 << c) | (1 << ((c + 1) & 3)))) continue;
        if (this.outsideOf(i, x + CX[c], y + CY[c])) m |= 1 << (4 + c);
      }
      this.want[i] = m;
    }
  }

  private torchOk(i: number): boolean {
    const [x, y] = this.xy(i);
    return this.torches.every((t) => {
      const [tx, ty] = this.xy(t);
      return Math.max(Math.abs(tx - x), Math.abs(ty - y)) > 2;
    });
  }

  private tileWalls(): void {
    const { g, rng, p } = this;
    for (let i = 0; i < g.kind.length; i++) {
      if (g.kind[i] === EMPTY || this.used[i]) continue;
      const f = this.set.walls[this.fam[i]];
      const door = this.doors.get(i);
      if (door) {
        this.placeDoor(i, door);
        continue;
      }
      const want = this.want[i];
      if (!f || !want) continue;
      const b = this.best(f.base, want);
      if (!b.list.length || maskCost(0, want) < b.cost) continue;
      let cand = this.pickCand(b.list);
      const single = popcount(cand.m & 15) === 1 && cand.m >> 4 === 0;
      const inRoom = g.kind[i] === ROOM;
      if (single && f.torch.length && this.torchOk(i) && rng.chance(p.decor * (inRoom ? 0.4 : 0.15))) {
        const t = this.best(f.torch, cand.m);
        if (t.cost === 0 && t.list.length) {
          cand = this.pickCand(t.list);
          this.torches.push(i);
        }
      } else if (f.decor.length && rng.chance(p.decor * 0.3)) {
        const t = this.best(f.decor, cand.m);
        if (t.cost === 0 && t.list.length) cand = this.pickCand(t.list);
      }
      if (single) {
        const stairs = this.stairsFor(i, cand.m);
        if (stairs) cand = { ...cand, c: stairs };
      }
      this.put(i, cand.c, cand.o);
    }
  }

  // A staircase instead of a straight cliff piece; the cell in front of it must be open ground at the same height.
  private stairsFor(i: number, m: number): string | null {
    const list = this.set.opts.elevation?.stairs?.[this.drop[i] - 1];
    if (!this.hs || !this.drop[i] || !list?.length) return null;
    const { g, rng } = this;
    const side = [0, 1, 2, 3].find((s) => m & (1 << s));
    if (side === undefined) return null;
    const [x, y] = this.xy(i);
    const fx = x + DX[(side + 2) % 4];
    const fy = y + DY[(side + 2) % 4];
    if (!g.in(fx, fy) || g.kind[g.idx(fx, fy)] === EMPTY || this.hs[g.idx(fx, fy)] !== this.hs[i]) return null;
    if (this.stairsAt.some((q) => Math.max(Math.abs((q % g.W) - x), Math.abs(Math.floor(q / g.W) - y)) <= 2)) return null;
    const mt = this.ringMnt[i];
    const n = this.mntStairs.get(mt) ?? 0;
    if (!rng.chance(n ? 0.12 : 0.5)) return null;
    this.mntStairs.set(mt, n + 1);
    this.stairsAt.push(i);
    return rng.pick(list);
  }

  private placeDoor(i: number, door: Door): void {
    const f = this.set.walls[this.fam[i]];
    const dd = this.set.opts.doubleDoor;
    const pool = f?.doors ?? [];
    const want = 1 << door.dir;
    if (door.part !== 'single' && dd) {
      const ref = pool[0];
      const o = ref ? Math.max(0, ref.m.findIndex((m) => (m & 15) === want)) : door.dir;
      this.put(i, door.part === 'left' ? dd.left : dd.right, o);
      return;
    }
    const cands: Cand[] = [];
    for (const pc of pool) for (let o = 0; o < 4; o++) if ((pc.m[o] & 15) === want) cands.push({ c: pc.c, o, w: pc.w, m: pc.m[o] });
    if (cands.length) {
      const c = this.pickCand(cands);
      this.put(i, c.c, c.o);
    } else if (f && this.want[i]) {
      // no door piece: leave an opening unless the wall would be broken
      this.doors.delete(i);
    }
  }

  // Ridge walls (link model) on empty cells bordering the floor.
  private tileRidges(): void {
    const { g } = this;
    const ridge = new Int16Array(g.W * g.H).fill(-1);
    for (let i = 0; i < g.kind.length; i++) {
      if (g.kind[i] !== EMPTY) continue;
      const [x, y] = this.xy(i);
      for (let dy = -1; dy <= 1 && ridge[i] < 0; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!g.floor(x + dx, y + dy)) continue;
          const f = this.fam[g.idx(x + dx, y + dy)];
          if (this.set.walls[f]?.model === 'link') {
            ridge[i] = f;
            break;
          }
        }
      }
    }
    for (let i = 0; i < ridge.length; i++) {
      if (ridge[i] < 0) continue;
      const [x, y] = this.xy(i);
      let bits = 0;
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        if (g.in(nx, ny) && ridge[g.idx(nx, ny)] >= 0) bits |= 1 << d;
      }
      const b = this.best(this.set.walls[ridge[i]].base, bits);
      if (!b.list.length) continue;
      const c = this.pickCand(b.list);
      this.put(i, c.c, c.o);
    }
  }

  // ----- liquids & patches ---------------------------------------------------------------------

  // Index of a liquid (or patch) family; prefers families with shore pieces.
  private pickLiquid(liquid: boolean, needPieces = false): number {
    const L = this.set.liquids;
    const idx = L.map((_, i) => i).filter((i) => L[i].liquid === liquid && (!needPieces || L[i].pieces.length));
    if (!idx.length) return needPieces ? this.pickLiquid(liquid, false) : -1;
    const withPieces = idx.filter((i) => L[i].pieces.length);
    return this.rng.pick(withPieces.length ? withPieces : idx);
  }

  private interior(k: number): boolean {
    return this.g.kind[k] !== EMPTY && this.want[k] === 0 && this.liq[k] < 0 && !this.doors.has(k) && !this.nearDoor(k) && this.g.room[k] < 0 && !this.hs?.[k];
  }

  private blob(fam: number, size: number): void {
    const { g, rng } = this;
    const ok = (k: number) => this.interior(k) && this.neighbours8(k, (n) => this.g.kind[n] !== EMPTY && this.want[n] === 0) === 8;
    const cands: number[] = [];
    for (let i = 0; i < g.kind.length; i++) if (ok(i)) cands.push(i);
    if (!cands.length) return;
    const start = rng.pick(cands);
    const front = [start];
    const got = new Set<number>([start]);
    while (front.length && got.size < size) {
      const k = front.splice(rng.int(0, front.length - 1), 1)[0];
      const [x, y] = this.xy(k);
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        if (!g.in(nx, ny)) continue;
        const n = g.idx(nx, ny);
        if (got.has(n) || !ok(n)) continue;
        got.add(n);
        front.push(n);
      }
    }
    for (const k of got) this.liq[k] = fam;
  }

  private addLiquids(): void {
    const { g, p, rng } = this;
    const floor = g.kind.reduce((s, k) => s + (k ? 1 : 0), 0);
    // pools in dungeon rooms
    for (const r of this.rooms) {
      if (!r.alive || r.kind !== 'pool') continue;
      const f = this.pickLiquid(true);
      if (f < 0) continue;
      for (const k of r.cells) {
        if (this.want[k] !== 0 || this.lnk[k] >= 0 || this.doors.has(k) || this.nearDoor(k)) continue;
        if (this.neighbours8(k, (n) => g.room[n] === r.id && this.want[n] === 0) === 8) this.liq[k] = f;
      }
    }
    if (this.style === 'cave' || this.style === 'wilds' || this.style === 'town') {
      const lakes = this.style === 'town' ? (p.water > 0.5 ? 1 : 0) : Math.round(p.water * (1 + floor / 160));
      for (let n = 0; n < lakes; n++) {
        const f = this.pickLiquid(true);
        if (f < 0) break;
        this.blob(f, rng.int(4, Math.max(6, Math.round(floor * (0.04 + p.water * 0.08)))));
      }
      const patches = this.style === 'town' ? 1 : Math.round(p.decor * 2 + floor / 300);
      for (let n = 0; n < patches; n++) {
        const f = this.pickLiquid(false);
        if (f < 0) break;
        this.blob(f, rng.int(4, Math.max(6, Math.round(floor * 0.05))));
      }
    }
  }

  private liquidSame(i: number, x: number, y: number): boolean {
    const { g } = this;
    if (!g.in(x, y) || !g.mask[g.idx(x, y)]) return this.liquidEdgeOpen;
    return this.liq[g.idx(x, y)] === this.liq[i];
  }

  private liquidWant(i: number): number {
    const [x, y] = this.xy(i);
    let m = 0;
    for (let d = 0; d < 4; d++) if (!this.liquidSame(i, x + DX[d], y + DY[d])) m |= 1 << d;
    for (let c = 0; c < 4; c++) {
      if (m & ((1 << c) | (1 << ((c + 1) & 3)))) continue;
      if (!this.liquidSame(i, x + CX[c], y + CY[c])) m |= 1 << (4 + c);
    }
    return m;
  }

  // Remove liquid cells that have no matching shore piece shape (peninsulas, 1-wide strips).
  private smoothLiquids(): void {
    const L = this.set.liquids;
    for (let it = 0; it < 8; it++) {
      let changed = false;
      for (let i = 0; i < this.liq.length; i++) {
        const f = this.liq[i];
        if (f < 0 || !L[f].pieces.length) continue;
        const m = this.liquidWant(i) & 15;
        const narrow = m === 5 || m === 10;
        const hasNarrow = L[f].pieces.some((pc) => pc.m.some((pm) => (pm & 15) === 5 || (pm & 15) === 10));
        if (popcount(m) >= 3 || (narrow && !hasNarrow)) {
          this.liq[i] = -1;
          changed = true;
        }
      }
      if (!changed) break;
    }
  }

  private tileLiquids(): void {
    const L = this.set.liquids;
    for (let i = 0; i < this.liq.length; i++) {
      const f = this.liq[i];
      if (f < 0 || this.used[i]) continue;
      const lf: EdgeFam = L[f];
      const want = lf.pieces.length ? this.liquidWant(i) : 0;
      if (want === 0) {
        const decor = lf.decor.filter((c) => this.fits(c));
        if (decor.length && !(this.style === 'swamp' && this.set.opts.swamp) && this.rng.chance(this.p.decor * (this.style === 'ship' ? 0.06 : 0.3)) && this.putDecor(i, decor, (k) => this.liq[k] === f && !this.used[k] && this.liquidWant(k) === 0)) continue;
        if (lf.full.length) this.put(i, this.rng.weighted(lf.full), this.rng.int(0, 3));
        continue;
      }
      const b = this.best(lf.pieces, want);
      if (!b.list.length) continue;
      const c = this.pickCand(b.list);
      this.put(i, c.c, c.o);
    }
  }

  // ----- links (paths, rivers, rails) ----------------------------------------------------------

  private passable(k: number): boolean {
    return this.interior(k) && !this.used[k] && (this.lnk[k] < 0);
  }

  private route(a: number, b: number, ok = (k: number) => this.passable(k), extra = (_k: number) => 0): number[] | null {
    const { g, rng } = this;
    const N = g.W * g.H;
    const noise = new Float32Array(N);
    for (let i = 0; i < N; i++) noise[i] = rng.next();
    const dist = new Float32Array(N * 4).fill(Infinity);
    const came = new Int32Array(N * 4).fill(-1);
    const heap = new MinHeap();
    for (let d = 0; d < 4; d++) {
      dist[a * 4 + d] = 0;
      heap.push(a * 4 + d, 0);
    }
    while (heap.size) {
      const node = heap.pop();
      const ci = node >> 2;
      const cd = node & 3;
      if (ci === b) {
        const path: number[] = [];
        for (let n = node; n >= 0; n = came[n]) path.push(n >> 2);
        return path.reverse();
      }
      const [x, y] = this.xy(ci);
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        if (!g.in(nx, ny)) continue;
        const ni = g.idx(nx, ny);
        if (ni !== b && !ok(ni)) continue;
        let step = 1 + noise[ni] * 1.5 + extra(ni);
        if (d !== cd && ci !== a) step += 1.2;
        const nn = ni * 4 + d;
        const nd = dist[node] + step;
        if (nd < dist[nn]) {
          dist[nn] = nd;
          came[nn] = node;
          heap.push(nn, nd);
        }
      }
    }
    return null;
  }

  private markLink(path: number[], f: number): void {
    for (let k = 0; k < path.length; k++) {
      const i = path[k];
      this.lnk[i] = f;
      for (const j of [path[k - 1], path[k + 1]]) {
        if (j === undefined) continue;
        const d = j === i - 1 ? 0 : j === i - this.W ? 1 : j === i + 1 ? 2 : 3;
        this.lb[i] |= 1 << d;
      }
    }
  }

  private farPair(cands: number[]): [number, number] | null {
    if (cands.length < 2) return null;
    let best: [number, number] | null = null;
    let bd = -1;
    for (let t = 0; t < 40; t++) {
      const a = this.rng.pick(cands);
      const b = this.rng.pick(cands);
      const [ax, ay] = this.xy(a);
      const [bx, by] = this.xy(b);
      const d = Math.hypot(ax - bx, ay - by);
      if (d > bd) {
        bd = d;
        best = [a, b];
      }
    }
    return bd >= 4 ? best : null;
  }

  private addLinks(): void {
    const { g, p, rng } = this;
    const links = this.links;
    if (!links.length || this.style === 'dungeon' || this.style === 'ship') return;
    const liquidLinks = links.map((_, i) => i).filter((i) => links[i].liquid);
    const dryLinks = links.map((_, i) => i).filter((i) => !links[i].liquid);
    const jobs: number[] = [];
    if (liquidLinks.length && p.water > 0.25 && this.style !== 'town') jobs.push(rng.pick(liquidLinks));
    for (let n = 0; n < p.paths; n++) {
      const pool = dryLinks.length ? dryLinks : liquidLinks;
      if (pool.length) jobs.push(rng.pick(pool));
    }
    const doorsOut: number[] = [];
    for (const d of this.doors.values()) {
      const [x, y] = this.xy(d.cell);
      const nx = x + DX[d.dir];
      const ny = y + DY[d.dir];
      if (g.in(nx, ny) && this.passable(g.idx(nx, ny))) doorsOut.push(g.idx(nx, ny));
    }
    for (const f of jobs) {
      const cands: number[] = [];
      for (let i = 0; i < g.kind.length; i++) if (this.passable(i)) cands.push(i);
      let pair: [number, number] | null = null;
      if (this.style === 'town' && doorsOut.length >= 2 && !links[f].liquid) {
        const a = rng.pick(doorsOut);
        const b = rng.pick(doorsOut.filter((k) => k !== a));
        pair = [a, b];
      } else pair = this.farPair(cands);
      if (!pair) continue;
      const path = this.route(pair[0], pair[1]);
      if (path && path.length >= 3) this.markLink(path, f);
    }
  }

  private tileLinks(): void {
    for (let i = 0; i < this.lnk.length; i++) {
      const f = this.lnk[i];
      if (f < 0 || this.used[i]) continue;
      const b = this.best(this.links[f].pieces, this.lb[i]);
      if (!b.list.length) continue;
      const c = this.pickCand(b.list);
      this.put(i, c.c, c.o);
    }
  }

  // ----- decoration ----------------------------------------------------------------------------

  private scatter(cells: number[], rate: number, cats: [DecorCat | 'ground', number][], outdoor = false): void {
    const { rng } = this;
    for (const i of cells) {
      if (!this.free(i) || !rng.chance(rate)) continue;
      const opts = cats
        .map(([c, w]) => ({ v: c === 'ground' ? (this.set.groundDecor[this.gk[i]] ?? []).filter((x) => this.fits(x)) : this.decorList(c, outdoor), w }))
        .filter((o) => o.v.length && o.w > 0);
      if (!opts.length) continue;
      this.putDecor(i, rng.weighted(opts));
    }
  }

  private decorate(): void {
    const { g, p, rng } = this;
    const all: number[] = [];
    for (let i = 0; i < g.kind.length; i++) if (g.kind[i] !== EMPTY) all.push(i);
    rng.shuffle(all);
    const d = p.decor;
    const cabin = this.style === 'ship' && !!this.set.opts.ship?.cabinBed;
    for (const r of this.rooms) if (r.alive) this.furnishRoom(r);
    const outside = all.filter((i) => g.room[i] < 0);
    switch (this.style) {
      case 'dungeon':
        this.scatter(outside, d * 0.05, [['hazards', 1], ['scatter', 2], ['ground', 1]], true);
        break;
      case 'cave':
        this.bigDecor(outside, Math.round(d * 2));
        this.scatter(outside, d * 0.14, [['ground', 3], ['scatter', 2], ['props', 1], ['columns', 1], ['lights', 0.3], ['hazards', 0.3], ['treasure', 0.2], ['trees', 0.5]], true);
        break;
      case 'wilds':
        this.bigDecor(outside, Math.round(d * 3));
        this.scatter(outside, d * 0.2, [['trees', 4], ['scatter', 3], ['ground', 3], ['props', 1], ['features', 0.3], ['lights', 0.15], ['columns', 0.3]], true);
        break;
      case 'town':
        this.bigDecor(outside, Math.round(d * 2));
        this.scatter(outside, d * 0.08, [['trees', 2], ['lights', 1.5], ['props', 1.2], ['features', 0.4], ['scatter', 1], ['ground', 1]], true);
        break;
      case 'ship':
        if (!cabin) this.scatter(outside, d * 0.1, [['furniture', 3], ['scatter', 2], ['treasure', 0.4], ['props', 0.6], ['lights', 0.4], ['hazards', 0.5]], true);
        break;
      case 'swamp':
        if (this.set.opts.swamp) break;
        this.bigDecor(outside.filter((i) => this.liq[i] < 0), Math.round(d * 2));
        this.scatter(outside, d * 0.2, [['trees', 4], ['ground', 3], ['scatter', 2], ['props', 0.6], ['lights', 0.2]], true);
        break;
    }
    const stairs = this.decorList('stairs');
    if (p.stairs && stairs.length) {
      const pool = this.style === 'swamp' && this.set.opts.swamp ? [] : this.rooms.filter((r) => r.alive).flatMap((r) => r.cells);
      const cells = rng.shuffle((pool.length ? pool : all).filter(this.free));
      let n = this.style === 'dungeon' ? 2 : 1;
      for (const i of cells) {
        if (n <= 0) break;
        if (this.free(i) && this.putDecor(i, stairs)) n--;
      }
    }
  }

  private bigDecor(cells: number[], count: number): void {
    const list = this.decorList('big', true);
    if (!list.length) return;
    let n = 0;
    for (const i of cells) {
      if (n >= count) break;
      if (this.free(i) && this.putDecor(i, list)) n++;
    }
  }

  private furnishRoom(r: Room): void {
    const { g, rng, p } = this;
    const cells = rng.shuffle(r.cells.filter(this.free));
    if (!cells.length) return;
    const d = p.decor;
    const lights = this.decorList('lights');
    const center = g.idx(Math.round(r.cx), Math.round(r.cy));
    switch (r.kind) {
      case 'hall': {
        const cols = this.decorList('columns');
        const code = rng.pick(cols);
        for (const i of r.cells) {
          const [x, y] = this.xy(i);
          if ((x - r.x) % 2 === 1 && (y - r.y) % 2 === 1 && x < r.x + r.w - 1 && y < r.y + r.h - 1 && this.free(i)) this.put(i, code, 0, this.free);
        }
        break;
      }
      case 'pool':
        for (const i of cells.slice(0, 2)) this.putDecor(i, lights);
        break;
      case 'shrine': {
        const feat = this.decorList('features');
        if (!(this.free(center) && this.putDecor(center, feat.length ? feat : this.decorList('big')))) this.putDecor(cells[0], feat);
        const [cx, cy] = this.xy(center);
        for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          if (g.in(cx + dx, cy + dy) && g.room[g.idx(cx + dx, cy + dy)] === r.id && this.free(g.idx(cx + dx, cy + dy)) && rng.chance(0.7)) this.putDecor(g.idx(cx + dx, cy + dy), lights);
        }
        break;
      }
      case 'furnished': {
        const n = 1 + Math.round(cells.length * (0.1 + d * 0.15));
        const furn = this.decorList('furniture');
        const big = this.decorList('big');
        if (big.length && rng.chance(0.5)) this.putDecor(center, big);
        let placed = 0;
        for (const i of cells) {
          if (placed >= n) break;
          if (this.free(i) && this.putDecor(i, furn)) placed++;
        }
        if (lights.length && rng.chance(0.6)) for (const i of cells) if (this.free(i) && this.putDecor(i, lights)) break;
        break;
      }
      case 'treasure': {
        const tr = this.decorList('treasure');
        const props = this.decorList('props');
        let n = rng.int(1, 3);
        for (const i of cells) {
          if (n <= 0) break;
          if (this.free(i) && this.putDecor(i, tr.length ? tr : props)) n--;
        }
        this.scatter(cells, d * 0.08, [['hazards', 1], ['props', 1]]);
        break;
      }
      default:
        this.scatter(cells, d * 0.12, [['scatter', 3], ['props', 1.5], ['ground', 1], ['furniture', 0.5], ['lights', 0.3]]);
    }
  }

  // ----- grounds & base grid -------------------------------------------------------------------

  private tileGrounds(): void {
    const { g, rng } = this;
    const fallback = this.set.grounds[this.set.mainGround] ?? Object.values(this.set.grounds)[0] ?? [];
    for (let i = 0; i < g.kind.length; i++) {
      if (g.kind[i] === EMPTY || this.used[i]) continue;
      const list: W[] = this.set.grounds[this.gk[i]] ?? fallback;
      if (!list.length) continue;
      this.put(i, rng.weighted(list), rng.int(0, 3));
    }
  }

  baseGrid(): DbbTile[] {
    const S = this.W * this.s;
    const T = this.H * this.s;
    const tiles: DbbTile[] = [];
    for (let by = 0; by < T; by += 3) {
      for (let bx = 0; bx < S; bx += 3) {
        let any = false;
        for (let y = by; y < Math.min(T, by + 3) && !any; y++) for (let x = bx; x < Math.min(S, bx + 3); x++) if (this.occ[y * S + x]) any = true;
        if (any) tiles.push({ x: bx, y: by, element: 'BB-001', orientation: 0 });
      }
    }
    return tiles;
  }
}

// ---------------------------------------------------------------------------------------------
// Room & corridor layout (dungeon style)

// Chebyshev distance from every cell to the nearest source cell.
function chebyshev(g: Grid, isSource: (i: number) => boolean, edgeIsSource: boolean): Int16Array {
  const { W, H } = g;
  const d = new Int16Array(W * H).fill(32767);
  let front: number[] = [];
  for (let i = 0; i < d.length; i++) {
    const x = i % W;
    const y = Math.floor(i / W);
    if (isSource(i)) d[i] = 0;
    else if (edgeIsSource && (x === 0 || y === 0 || x === W - 1 || y === H - 1)) d[i] = 1;
    else continue;
    front.push(i);
  }
  while (front.length) {
    const next: number[] = [];
    for (const i of front) {
      const x = i % W;
      const y = Math.floor(i / W);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!g.in(x + dx, y + dy)) continue;
          const n = g.idx(x + dx, y + dy);
          if (d[n] > d[i] + 1) {
            d[n] = d[i] + 1;
            next.push(n);
          }
        }
      }
    }
    front = next;
  }
  return d;
}

/**
 * Places up to `target` rooms. Loose: grows a cluster from the map centre (the map size is only a limit).
 * Packed: rooms hug each other and the map edge to fit as many as possible. Every valid position is scored, and rooms
 * shrink towards the minimum size (then below it) before one is given up.
 */
function placeRooms(g: Grid, p: GenParams, rng: Rng, rooms: Room[], target: number, packed: boolean, kindOf: (w: number, h: number, shape: string) => RoomKind): void {
  const { W, H } = g;
  const gap = p.corridorWidth + 2; // halo + corridor + halo between two rooms
  const minS = Math.max(3, Math.min(p.roomMin, p.roomMax));
  const maxS = Math.max(minS, p.roomMax);
  // summed-area table of cells a room may not cover (outside the map shape or already a room)
  const sat = new Int32Array((W + 1) * (H + 1));
  const buildSat = () => {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = g.idx(x, y);
        const bad = !g.mask[i] || g.kind[i] === ROOM ? 1 : 0;
        sat[(y + 1) * (W + 1) + x + 1] = bad + sat[y * (W + 1) + x + 1] + sat[(y + 1) * (W + 1) + x] - sat[y * (W + 1) + x];
      }
    }
  };
  const blockedIn = (x: number, y: number, w: number, h: number) =>
    sat[(y + h) * (W + 1) + x + w] - sat[y * (W + 1) + x + w] - sat[(y + h) * (W + 1) + x] + sat[y * (W + 1) + x];
  const edgeDist = packed ? chebyshev(g, (i) => !g.mask[i], true) : null;
  let roomDist = chebyshev(g, () => false, false);
  buildSat();

  const spot = (w: number, h: number, minGap: number): { x: number; y: number } | null => {
    let best: { x: number; y: number } | null = null;
    let bestScore = Infinity;
    for (let y = 0; y + h <= H; y++) {
      for (let x = 0; x + w <= W; x++) {
        if (blockedIn(x, y, w, h)) continue;
        // nearest room / edge distance is reached on the rectangle border
        let dr = 32767;
        let de = 32767;
        for (let i = 0; i < w; i++) {
          for (const yy of [y, y + h - 1]) {
            const k = g.idx(x + i, yy);
            dr = Math.min(dr, roomDist[k]);
            if (edgeDist) de = Math.min(de, edgeDist[k]);
          }
        }
        for (let j = 1; j < h - 1; j++) {
          for (const xx of [x, x + w - 1]) {
            const k = g.idx(xx, y + j);
            dr = Math.min(dr, roomDist[k]);
            if (edgeDist) de = Math.min(de, edgeDist[k]);
          }
        }
        if (dr <= minGap) continue;
        let score: number;
        if (packed) {
          // hug other rooms and the map edge to waste as little space as possible
          const a = Math.min(dr - minGap - 1, 8);
          const b = Math.min(de - 1, 8);
          score = Math.min(a, b) + 0.15 * Math.max(a, b) + rng.next() * 0.6;
        } else if (rooms.length) {
          score = dr - minGap + rng.next() * 5;
        } else {
          score = Math.hypot(x + w / 2 - W / 2, y + h / 2 - H / 2) * 0.5 + rng.next() * Math.min(W, H) * 0.25;
        }
        if (score < bestScore) {
          bestScore = score;
          best = { x, y };
        }
      }
    }
    return best;
  };

  while (rooms.length < target) {
    let w = rng.int(minS, maxS);
    let h = rng.int(minS, maxS);
    if (w > h * 2) w = h * 2;
    if (h > w * 2) h = w * 2;
    // fallbacks: shrink towards the minimum size, then (count mode) below it
    const tries: [number, number][] = [];
    for (;;) {
      tries.push([w, h]);
      if (w <= minS && h <= minS) break;
      if (w >= h && w > minS) w--;
      else h--;
    }
    if (target !== Infinity) {
      for (let s = minS - 1; s >= 3; s--) tries.push([s, s]);
    }
    let found: { x: number; y: number; w: number; h: number } | null = null;
    for (const [tw, th] of tries) {
      if (tw > W || th > H) continue;
      const s = spot(tw, th, gap);
      if (s) {
        found = { ...s, w: tw, h: th };
        break;
      }
    }
    if (!found) break;
    const { x, y } = found;
    w = found.w;
    h = found.h;
    let shape: 'rect' | 'octagon' | 'circle' | 'cross' = 'rect';
    if (p.roomShapes !== 'rect' && w >= 5 && h >= 5) {
      if (p.roomShapes === 'round') shape = rng.chance(0.5) ? 'circle' : 'octagon';
      else shape = rng.weighted([{ v: 'rect' as const, w: 5 }, { v: 'octagon' as const, w: 1.5 }, { v: 'circle' as const, w: 1 }, { v: 'cross' as const, w: 1 }]);
    }
    const id = rooms.length;
    const idxs = roomCells(x, y, w, h, shape).map(([cx, cy]) => g.idx(cx, cy));
    for (const i of idxs) {
      g.kind[i] = ROOM;
      g.room[i] = id;
    }
    rooms.push({ id, x, y, w, h, cells: idxs, shape, cx: 0, cy: 0, kind: 'plain', alive: true });
    buildSat();
    roomDist = chebyshev(g, (i) => g.kind[i] === ROOM, false);
  }

  // Fill: rectangular rooms grow into the leftover space (keeping the corridor gap) up to the maximum size.
  if (target === Infinity) {
    const clear = (r: Room, x: number, y: number): boolean => {
      if (!g.in(x, y) || !g.mask[g.idx(x, y)]) return false;
      for (let dy = -gap; dy <= gap; dy++) {
        for (let dx = -gap; dx <= gap; dx++) {
          if (!g.in(x + dx, y + dy)) continue;
          const k = g.idx(x + dx, y + dy);
          if (g.kind[k] === ROOM && g.room[k] !== r.id) return false;
        }
      }
      return true;
    };
    for (let grew = true; grew;) {
      grew = false;
      for (const r of rng.shuffle([...rooms])) {
        if (r.shape !== 'rect') continue;
        for (const d of rng.shuffle([0, 1, 2, 3])) {
          const horiz = d % 2 === 0;
          const nw = r.w + (horiz ? 1 : 0);
          const nh = r.h + (horiz ? 0 : 1);
          if (nw > maxS || nh > maxS || nw > nh * 2 || nh > nw * 2) continue;
          const strip: [number, number][] = [];
          if (horiz) for (let j = 0; j < r.h; j++) strip.push([d === 0 ? r.x - 1 : r.x + r.w, r.y + j]);
          else for (let i = 0; i < r.w; i++) strip.push([r.x + i, d === 1 ? r.y - 1 : r.y + r.h]);
          if (!strip.every(([x, y]) => clear(r, x, y))) continue;
          for (const [x, y] of strip) {
            const k = g.idx(x, y);
            g.kind[k] = ROOM;
            g.room[k] = r.id;
            r.cells.push(k);
          }
          if (d === 0) r.x--;
          if (d === 1) r.y--;
          r.w = nw;
          r.h = nh;
          grew = true;
        }
      }
    }
  }

  for (const r of rooms) {
    r.cx = r.x + (r.w - 1) / 2;
    r.cy = r.y + (r.h - 1) / 2;
    r.kind = kindOf(r.w, r.h, r.shape);
    for (const ci of r.cells) {
      const cx = ci % W;
      const cy = Math.floor(ci / W);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (g.in(cx + dx, cy + dy) && g.kind[g.idx(cx + dx, cy + dy)] !== ROOM) g.halo[g.idx(cx + dx, cy + dy)] = 1;
        }
      }
    }
  }
}

interface DoorChoice {
  cells: number[];
  dir: number;
  outside: number[];
  anchor: [number, number];
}

function doorCandidates(g: Grid, room: Room, cw: number): DoorChoice[] {
  const res: DoorChoice[] = [];
  const inRoom = (x: number, y: number) => g.in(x, y) && g.room[g.idx(x, y)] === room.id;
  const outwardDir = (x: number, y: number): number => {
    let dir = -1;
    for (let d = 0; d < 4; d++) {
      if (!inRoom(x + DX[d], y + DY[d])) {
        if (dir >= 0) return -1;
        dir = d;
      }
    }
    return dir;
  };
  const okOutside = (x: number, y: number) => {
    if (!g.in(x, y)) return false;
    const i = g.idx(x, y);
    return g.mask[i] === 1 && g.kind[i] !== ROOM;
  };
  for (const ci of room.cells) {
    const x = ci % g.W;
    const y = Math.floor(ci / g.W);
    const d = outwardDir(x, y);
    if (d < 0) continue;
    const ox = x + DX[d];
    const oy = y + DY[d];
    if (!okOutside(ox, oy)) continue;
    if (cw === 1) {
      res.push({ cells: [ci], dir: d, outside: [g.idx(ox, oy)], anchor: [ox, oy] });
    } else {
      const px = d % 2 === 0 ? 0 : 1;
      const py = d % 2 === 0 ? 1 : 0;
      const x2 = x + px;
      const y2 = y + py;
      if (!inRoom(x2, y2) || outwardDir(x2, y2) !== d) continue;
      if (!okOutside(ox + px, oy + py)) continue;
      const ax = DX[d] < 0 ? ox - 1 : ox;
      const ay = DY[d] < 0 ? oy - 1 : oy;
      res.push({ cells: [ci, g.idx(x2, y2)], dir: d, outside: [g.idx(ox, oy), g.idx(ox + px, oy + py)], anchor: [ax, ay] });
    }
  }
  return res;
}

function chooseDoor(g: Grid, room: Room, tx: number, ty: number, cw: number, rng: Rng, doors: Map<number, Door>, exclude: Set<string>): DoorChoice | null {
  const cands = doorCandidates(g, room, cw).filter((c) => !exclude.has(c.cells.join(',')));
  if (!cands.length) return null;
  let best: DoorChoice | null = null;
  let bestScore = Infinity;
  for (const c of cands) {
    const o = c.outside[0];
    const ox = o % g.W;
    const oy = Math.floor(o / g.W);
    let score = Math.hypot(ox - tx, oy - ty) + rng.next() * 4;
    if (c.cells.every((ci) => doors.has(ci))) score -= 3;
    else {
      for (const ci of c.cells) {
        const x = ci % g.W;
        const y = Math.floor(ci / g.W);
        for (let d = 0; d < 4; d++) {
          if (g.in(x + DX[d], y + DY[d]) && doors.has(g.idx(x + DX[d], y + DY[d])) && !c.cells.includes(g.idx(x + DX[d], y + DY[d]))) score += 6;
        }
      }
    }
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

function findPath(g: Grid, start: [number, number], goal: [number, number], cw: number, allowed: Set<number>, noise: Float32Array, winding: number): number[] | null {
  const { W, H } = g;
  const passable = (ax: number, ay: number): boolean => {
    for (let j = 0; j < cw; j++) {
      for (let i = 0; i < cw; i++) {
        const x = ax + i;
        const y = ay + j;
        if (!g.in(x, y)) return false;
        const k = g.idx(x, y);
        if (!g.mask[k] || g.kind[k] === ROOM) return false;
        if (g.halo[k] && !allowed.has(k)) return false;
      }
    }
    return true;
  };
  if (!passable(start[0], start[1]) || !passable(goal[0], goal[1])) return null;
  const N = W * H;
  const gScore = new Float32Array(N * 4).fill(Infinity);
  const came = new Int32Array(N * 4).fill(-1);
  const heap = new MinHeap();
  const s = g.idx(start[0], start[1]);
  const goalIdx = g.idx(goal[0], goal[1]);
  const turnCost = (1 - winding) * 2;
  for (let d = 0; d < 4; d++) {
    gScore[s * 4 + d] = 0;
    heap.push(s * 4 + d, 0);
  }
  const h = (i: number) => (Math.abs((i % W) - goal[0]) + Math.abs(Math.floor(i / W) - goal[1])) * 0.35;
  while (heap.size) {
    const node = heap.pop();
    const ci = node >> 2;
    const cd = node & 3;
    if (ci === goalIdx) {
      const path: number[] = [];
      for (let n = node; n >= 0; n = came[n]) path.push(n >> 2);
      return path.reverse();
    }
    const cx = ci % W;
    const cy = Math.floor(ci / W);
    for (let d = 0; d < 4; d++) {
      const nx = cx + DX[d];
      const ny = cy + DY[d];
      if (!passable(nx, ny)) continue;
      const ni = g.idx(nx, ny);
      let step = g.kind[ni] === CORRIDOR ? 0.35 : 1 + noise[ni] * winding * 3;
      if (d !== cd && ci !== s) step += turnCost;
      const ng = gScore[node] + step;
      const nn = ni * 4 + d;
      if (ng < gScore[nn]) {
        gScore[nn] = ng;
        came[nn] = node;
        heap.push(nn, ng + h(ni));
      }
    }
  }
  return null;
}

function connectRooms(g: Grid, p: GenParams, rng: Rng, rooms: Room[], doors: Map<number, Door>): void {
  if (rooms.length < 2) return;
  const noise = new Float32Array(g.W * g.H);
  for (let i = 0; i < noise.length; i++) noise[i] = rng.next();

  const parent = rooms.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const edges: [number, number, number][] = [];
  for (let a = 0; a < rooms.length; a++) {
    for (let b = a + 1; b < rooms.length; b++) {
      edges.push([a, b, Math.hypot(rooms[a].cx - rooms[b].cx, rooms[a].cy - rooms[b].cy)]);
    }
  }
  edges.sort((e1, e2) => e1[2] - e2[2]);
  const connected = new Set<string>();

  const connect = (A: Room, B: Room): boolean => {
    for (const cw of p.corridorWidth === 2 ? [2, 1] : [1]) {
      const exA = new Set<string>();
      const exB = new Set<string>();
      for (let attempt = 0; attempt < 4; attempt++) {
        const da = chooseDoor(g, A, B.cx, B.cy, cw, rng, doors, exA);
        const db = chooseDoor(g, B, A.cx, A.cy, cw, rng, doors, exB);
        if (!da || !db) break;
        const allowed = new Set([...da.outside, ...db.outside]);
        const path = findPath(g, da.anchor, db.anchor, cw, allowed, noise, p.winding);
        if (!path) {
          exA.add(da.cells.join(','));
          exB.add(db.cells.join(','));
          continue;
        }
        for (const ai of path) {
          const ax = ai % g.W;
          const ay = Math.floor(ai / g.W);
          for (let j = 0; j < cw; j++) {
            for (let i = 0; i < cw; i++) {
              const k = g.idx(ax + i, ay + j);
              if (g.kind[k] === EMPTY) g.kind[k] = CORRIDOR;
            }
          }
        }
        const useDoor = rng.chance(p.doors);
        for (const dc of [da, db]) {
          if (!useDoor || dc.cells.some((c) => doors.has(c))) continue;
          if (dc.cells.length === 1) doors.set(dc.cells[0], { cell: dc.cells[0], dir: dc.dir, part: 'single' });
          else {
            const [c0, c1] = dc.cells;
            const [lx, ly] = rotate(0, 1, dc.dir);
            const isLeftSecond = c1 - c0 === g.idx(lx, ly) - g.idx(0, 0);
            doors.set(c0, { cell: c0, dir: dc.dir, part: isLeftSecond ? 'right' : 'left' });
            doors.set(c1, { cell: c1, dir: dc.dir, part: isLeftSecond ? 'left' : 'right' });
          }
        }
        return true;
      }
    }
    return false;
  };

  for (const [a, b] of edges) {
    if (find(a) === find(b)) continue;
    if (connect(rooms[a], rooms[b])) {
      parent[find(a)] = find(b);
      connected.add(`${a},${b}`);
    }
  }
  if (p.loops > 0) {
    for (const r of rooms) {
      const near = edges.filter((e) => (e[0] === r.id || e[1] === r.id) && !connected.has(`${e[0]},${e[1]}`)).slice(0, 2);
      for (const [a, b] of near) {
        if (rng.chance(p.loops * 0.6) && connect(rooms[a], rooms[b])) connected.add(`${a},${b}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Cellular caverns

function carveCavern(g: Grid, fill: number, rng: Rng): void {
  const { W, H } = g;
  let cur = new Uint8Array(W * H);
  for (let i = 0; i < cur.length; i++) cur[i] = g.mask[i] && rng.chance(fill) ? 1 : 0;
  for (let it = 0; it < 5; it++) {
    const next = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = g.idx(x, y);
        if (!g.mask[i]) continue;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if ((dx || dy) && g.in(x + dx, y + dy) && cur[g.idx(x + dx, y + dy)]) n++;
          }
        }
        next[i] = n >= 5 || (cur[i] && n >= 4) ? 1 : 0;
      }
    }
    cur = next;
  }
  for (let i = 0; i < cur.length; i++) g.kind[i] = cur[i] ? CORRIDOR : EMPTY;
  const seen = new Uint8Array(W * H);
  for (let i = 0; i < seen.length; i++) {
    if (g.kind[i] !== EMPTY || seen[i]) continue;
    const comp = flood(g, i, seen, (k) => g.kind[k] === EMPTY);
    const touchesEdge = comp.some((k) => {
      const x = k % W;
      const y = Math.floor(k / W);
      return x === 0 || y === 0 || x === W - 1 || y === H - 1 || !g.mask[k];
    });
    if (!touchesEdge && comp.length <= 2) for (const k of comp) g.kind[k] = CORRIDOR;
  }
  pruneNubs(g);
}

function pruneNubs(g: Grid): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (let y = 0; y < g.H; y++) {
      for (let x = 0; x < g.W; x++) {
        const i = g.idx(x, y);
        if (g.kind[i] !== EMPTY && popcount(g.openSides(x, y)) >= 3) {
          g.kind[i] = EMPTY;
          changed = true;
        }
      }
    }
  }
}

function flood(g: Grid, start: number, seen: Uint8Array, ok: (k: number) => boolean): number[] {
  const out: number[] = [];
  const stack = [start];
  seen[start] = 1;
  while (stack.length) {
    const k = stack.pop()!;
    out.push(k);
    const x = k % g.W;
    const y = Math.floor(k / g.W);
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (!g.in(nx, ny)) continue;
      const n = g.idx(nx, ny);
      if (!seen[n] && ok(n)) {
        seen[n] = 1;
        stack.push(n);
      }
    }
  }
  return out;
}

function keepLargestComponent(g: Grid, rooms: Room[], doors: Map<number, Door>): void {
  const seen = new Uint8Array(g.W * g.H);
  let best: number[] = [];
  for (let i = 0; i < seen.length; i++) {
    if (g.kind[i] === EMPTY || seen[i]) continue;
    const comp = flood(g, i, seen, (k) => g.kind[k] !== EMPTY);
    if (comp.length > best.length) best = comp;
  }
  const keep = new Uint8Array(g.W * g.H);
  for (const k of best) keep[k] = 1;
  for (let i = 0; i < keep.length; i++) {
    if (!keep[i]) {
      g.kind[i] = EMPTY;
      g.room[i] = -1;
      doors.delete(i);
    }
  }
  for (const r of rooms) r.alive = r.cells.some((c) => keep[c]);
}
