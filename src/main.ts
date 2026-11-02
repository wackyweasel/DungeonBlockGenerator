import { Catalogue, detectLocalAssets, footprintCells, localUrl, packOf, thumbnailUrl } from './catalogue.js';
import { DesignStore, emptyDesign, parseDesign, serializeDesign } from './editor.js';
import { DEFAULT_PARAMS, generate, resolveStyle, type GenParams } from './generator.js';
import { MapRenderer } from './renderer.js';
import { SETS } from './sets.js';
import type { DbbTile, Projection, SpriteSet } from './types.js';

type Tool = 'select' | 'place' | 'erase' | 'pick';
const STORAGE_KEY = 'dbgen.design';
const PARAMS_KEY = 'dbgen.params';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, children: (Node | string)[] = []): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

function toast(msg: string): void {
  const t = el('div', { className: 'toast', textContent: msg });
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

function thumbImg(code: string): HTMLImageElement {
  const remote = thumbnailUrl(code);
  const img = el('img', { src: localUrl(remote) ?? remote, loading: 'lazy', alt: '' });
  img.addEventListener('error', () => {
    if (img.src !== remote) img.src = remote;
  }, { once: true });
  return img;
}

async function main(): Promise<void> {
  let catalogue: Catalogue;
  try {
    [catalogue] = await Promise.all([Catalogue.load(), detectLocalAssets()]);
  } catch (e) {
    document.body.textContent = `Could not load the element catalogue: ${(e as Error).message}`;
    return;
  }

  const canvas = $<HTMLCanvasElement>('#canvas');
  const renderer = new MapRenderer(canvas, catalogue);

  let params: GenParams = { ...DEFAULT_PARAMS, seed: Math.floor(Math.random() * 1e6) };
  try {
    const saved = localStorage.getItem(PARAMS_KEY);
    if (saved) params = { ...params, ...JSON.parse(saved) };
  } catch { /* ignore corrupt storage */ }
  if (!['auto', 'dungeon', 'cave', 'wilds', 'town', 'swamp', 'ship', 'colossal'].includes(params.style)) params.style = 'auto';
  if (!SETS.some((s) => s.id === params.theme)) params.theme = DEFAULT_PARAMS.theme;

  let initial = null;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) initial = parseDesign(saved);
  } catch { /* ignore corrupt storage */ }
  const first = initial ? null : generate(params);
  const store = new DesignStore(catalogue, initial ?? first!.design);
  renderer.area = first?.area ?? null;

  // ---------- state ----------
  let activeTab: 'generate' | 'edit' | 'build' = 'generate';
  let tool: Tool = 'place';
  let currentElement: string | null = 'UD-001';
  let orientation = 0;
  let autoStack = false;
  let spaceDown = false;

  const titleInput = $<HTMLInputElement>('#title');
  const levelInput = $<HTMLInputElement>('#level');
  const orientSelect = $<HTMLSelectElement>('#orientation');

  const syncDesign = () => {
    renderer.design = store.design;
    titleInput.value = store.design.title ?? '';
    renderer.requestRender();
    updateStatus();
    if (activeTab === 'build') renderBuildList();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store.design));
    } catch { /* storage full: ignore */ }
  };
  store.onChange(syncDesign);

  const defaultLevel = () => (store.design.levels.some((l) => l.index === 1) ? 1 : store.design.levels[0]?.index ?? 0);
  renderer.activeLevel = defaultLevel();
  levelInput.value = String(renderer.activeLevel);
  syncDesign();
  requestAnimationFrame(() => renderer.fit());

  // ---------- header ----------
  titleInput.addEventListener('change', () => {
    store.checkpoint();
    store.design.title = titleInput.value.trim() || 'Untitled';
    store.changed();
  });
  $('#btn-new').addEventListener('click', () => {
    store.replace(emptyDesign());
    renderer.area = null;
    renderer.activeLevel = 1;
    levelInput.value = '1';
    selectTab('edit');
    renderer.fit();
  });
  const fileInput = $<HTMLInputElement>('#file-input');
  $('#btn-import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (!f) return;
    try {
      const d = parseDesign(await f.text());
      store.replace(d);
      renderer.area = null;
      renderer.activeLevel = defaultLevel();
      levelInput.value = String(renderer.activeLevel);
      renderer.fit();
      const unknown = new Set(d.levels.flatMap((l) => l.tiles.map((t) => t.element)).filter((c) => !catalogue.get(c)));
      toast(unknown.size ? `Imported. Unknown elements: ${[...unknown].join(', ')}` : `Imported "${d.title}"`);
    } catch (e) {
      toast(`Import failed: ${(e as Error).message}`);
    }
  });
  $('#btn-export').addEventListener('click', () => {
    const json = serializeDesign(store.design);
    const blob = new Blob([json], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `${(store.design.title || 'dungeon').replace(/[\\/:*?"<>|]+/g, '_')}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('#btn-undo').addEventListener('click', () => store.undo());
  $('#btn-redo').addEventListener('click', () => store.redo());

  // ---------- tabs ----------
  const selectTab = (tab: typeof activeTab) => {
    activeTab = tab;
    document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll<HTMLElement>('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${tab}`));
    renderer.ghost = null;
    renderer.hoverCell = null;
    if (tab !== 'edit') renderer.selected = null;
    if (tab === 'build') renderBuildList();
    if (tab === 'edit') renderPalette();
    renderer.requestRender();
  };
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab as typeof activeTab)));

  // ---------- generate form ----------
  const form = $<HTMLFormElement>('#gen-form');
  const f = (name: string) => form.elements.namedItem(name) as HTMLInputElement & HTMLSelectElement;
  for (const t of [...SETS].sort((a, b) => a.name.localeCompare(b.name))) f('theme').append(el('option', { value: t.id, textContent: `${t.name} (${t.id})` }));

  const writeForm = () => {
    f('seed').value = String(params.seed);
    f('theme').value = params.theme;
    f('style').value = params.style;
    const sizePreset = params.width === params.height && ['12', '18', '24', '36', '48'].includes(String(params.width)) ? String(params.width) : 'custom';
    f('sizePreset').value = sizePreset;
    f('width').value = String(params.width);
    f('height').value = String(params.height);
    f('shape').value = params.shape;
    f('layout').value = params.layout;
    f('roomCount').value = String(params.roomCount);
    const rs = `${params.roomMin}-${params.roomMax}`;
    f('roomSizePreset').value = [...f('roomSizePreset').options].some((o) => o.value === rs) ? rs : 'custom';
    f('roomMin').value = String(params.roomMin);
    f('roomMax').value = String(params.roomMax);
    f('roomShapes').value = params.roomShapes;
    f('corridorWidth').value = String(params.corridorWidth);
    f('winding').value = String(params.winding);
    f('loops').value = String(params.loops);
    f('doors').value = String(params.doors);
    f('decor').value = String(params.decor);
    f('caveOpenness').value = String(params.caveOpenness);
    f('elevation').value = String(params.elevation);
    f('water').value = String(params.water);
    f('paths').value = String(params.paths);
    f('baseGrid').checked = params.baseGrid;
    f('stairs').checked = params.stairs;
    refreshFormVisibility();
  };

  const clampInt = (v: string, min: number, max: number, def: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  };

  const readForm = (): GenParams => {
    const sizePreset = f('sizePreset').value;
    const width = sizePreset === 'custom' ? clampInt(f('width').value, 6, 90, 24) : Number(sizePreset);
    const height = sizePreset === 'custom' ? clampInt(f('height').value, 6, 90, 24) : Number(sizePreset);
    const rsp = f('roomSizePreset').value;
    let roomMin = clampInt(f('roomMin').value, 3, 20, 3);
    let roomMax = clampInt(f('roomMax').value, 3, 20, 7);
    if (rsp !== 'custom') [roomMin, roomMax] = rsp.split('-').map(Number);
    if (roomMax < roomMin) [roomMin, roomMax] = [roomMax, roomMin];
    return {
      seed: clampInt(f('seed').value, 0, 2 ** 31, 1),
      title: titleInput.value.trim() || params.title,
      theme: f('theme').value,
      style: f('style').value as GenParams['style'],
      width,
      height,
      shape: f('shape').value as GenParams['shape'],
      layout: f('layout').value === 'fill' ? 'fill' : 'count',
      roomCount: Number(f('roomCount').value),
      roomMin,
      roomMax,
      roomShapes: f('roomShapes').value as GenParams['roomShapes'],
      corridorWidth: Number(f('corridorWidth').value) === 2 ? 2 : 1,
      winding: Number(f('winding').value),
      loops: Number(f('loops').value),
      doors: Number(f('doors').value),
      decor: Number(f('decor').value),
      caveOpenness: Number(f('caveOpenness').value),
      elevation: Number(f('elevation').value),
      water: Number(f('water').value),
      paths: clampInt(f('paths').value, 0, 6, 1),
      baseGrid: f('baseGrid').checked,
      stairs: f('stairs').checked,
    };
  };

  function refreshFormVisibility(): void {
    const style = resolveStyle({ theme: f('theme').value, style: f('style').value as GenParams['style'] });
    const autoOpt = f('style').options[0];
    autoOpt.textContent = `Set default (${style})`;
    const show = (sel: string, on: boolean) => form.querySelectorAll<HTMLElement>(sel).forEach((e) => (e.style.display = on ? '' : 'none'));
    show('.rooms-only', style === 'dungeon' || style === 'town' || style === 'swamp' || style === 'colossal');
    show('.dungeon-only', style === 'dungeon');
    show('.cavern-only', style === 'cave' || style === 'wilds' || style === 'swamp' || style === 'colossal');
    show('.wilds-only', style === 'wilds' || style === 'colossal');
    show('.paths-only', style !== 'dungeon' && style !== 'ship' && style !== 'colossal');
    show('.not-colossal', style !== 'colossal');
    show('.room-count', style !== 'colossal' && (style !== 'dungeon' || f('layout').value !== 'fill'));
    (form.querySelector('.custom-size') as HTMLElement).style.display = f('sizePreset').value === 'custom' ? '' : 'none';
    (form.querySelector('.custom-rooms') as HTMLElement).style.display = f('roomSizePreset').value === 'custom' ? '' : 'none';
    form.querySelectorAll<HTMLElement>('.val').forEach((v) => {
      const input = f(v.dataset.for!);
      const n = Number(input.value);
      v.textContent = input.step === '1' ? String(n) : `${Math.round(n * 100)}%`;
    });
  }
  form.addEventListener('input', refreshFormVisibility);

  const runGenerate = () => {
    params = readForm();
    try {
      localStorage.setItem(PARAMS_KEY, JSON.stringify(params));
    } catch { /* ignore */ }
    const t0 = performance.now();
    const res = generate(params);
    store.replace(res.design);
    renderer.area = res.area;
    renderer.activeLevel = params.baseGrid ? 1 : 0;
    levelInput.value = String(renderer.activeLevel);
    renderer.selected = null;
    renderer.fit();
    const tiles = res.design.levels.reduce((s, l) => s + l.tiles.length, 0);
    const short = res.style === 'dungeon' && params.layout === 'count' && res.rooms < params.roomCount ? ` of ${params.roomCount} (no space left: larger size or smaller rooms)` : '';
    $('#gen-info').textContent = `${SETS.find((s) => s.id === params.theme)?.name ?? params.theme}, ${res.style}: ${res.rooms ? `${res.rooms}${short} ${res.style === 'dungeon' ? 'rooms' : res.style === 'colossal' ? 'halls' : 'buildings'}, ` : ''}${res.floorCells} cells, ${tiles} pieces (${Math.round(performance.now() - t0)} ms).`;
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    runGenerate();
  });
  $('#btn-dice').addEventListener('click', () => {
    f('seed').value = String(Math.floor(Math.random() * 1e6));
  });
  $('#btn-reroll').addEventListener('click', () => {
    f('seed').value = String(Math.floor(Math.random() * 1e6));
    runGenerate();
  });
  writeForm();

  // ---------- view controls ----------
  const viewSel = $<HTMLSelectElement>('#view');
  viewSel.addEventListener('change', () => {
    const [projection, spriteSet] = viewSel.value.split('|') as [Projection, SpriteSet];
    renderer.setProjection(projection, spriteSet);
  });
  $('#rot-left').addEventListener('click', () => renderer.setRotation(renderer.rotation + 3));
  $('#rot-right').addEventListener('click', () => renderer.setRotation(renderer.rotation + 1));
  const zoomCenter = (factor: number) => {
    const r = canvas.getBoundingClientRect();
    renderer.zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
  };
  $('#zoom-in').addEventListener('click', () => zoomCenter(1.25));
  $('#zoom-out').addEventListener('click', () => zoomCenter(0.8));
  $('#fit').addEventListener('click', () => renderer.fit());
  $<HTMLInputElement>('#grid').addEventListener('change', (e) => {
    renderer.showGrid = (e.target as HTMLInputElement).checked;
    renderer.requestRender();
  });

  // ---------- edit panel ----------
  const setTool = (t: Tool) => {
    tool = t;
    document.querySelectorAll<HTMLButtonElement>('.tools button').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
    renderer.ghost = null;
    renderer.requestRender();
  };
  document.querySelectorAll<HTMLButtonElement>('.tools button').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool as Tool)));
  setTool('place');

  levelInput.addEventListener('input', () => {
    renderer.activeLevel = clampInt(levelInput.value, 0, 60, 1);
    applyLevelVisibility();
  });
  const onlyBelow = $<HTMLInputElement>('#only-below');
  const dimLevels = $<HTMLInputElement>('#dim-levels');
  const applyLevelVisibility = () => {
    renderer.maxVisibleLevel = onlyBelow.checked ? renderer.activeLevel : Infinity;
    renderer.dimOtherLevels = dimLevels.checked;
    renderer.requestRender();
  };
  onlyBelow.addEventListener('change', applyLevelVisibility);
  dimLevels.addEventListener('change', applyLevelVisibility);
  $<HTMLInputElement>('#auto-stack').addEventListener('change', (e) => (autoStack = (e.target as HTMLInputElement).checked));
  const setOrientation = (o: number) => {
    orientation = ((o % 4) + 4) % 4;
    orientSelect.value = String(orientation);
  };
  orientSelect.addEventListener('change', () => setOrientation(Number(orientSelect.value)));
  $('#btn-basegrid').addEventListener('click', () => {
    store.checkpoint();
    const n = store.fillBaseGrid(renderer.activeLevel === 0 ? 1 : renderer.activeLevel);
    toast(n ? `Added ${n} base grid(s) on level 0.` : 'No base grids needed.');
  });

  // palette
  const searchInput = $<HTMLInputElement>('#search');
  const packFilter = $<HTMLSelectElement>('#pack-filter');
  const tagFilter = $<HTMLSelectElement>('#tag-filter');
  packFilter.append(el('option', { value: '', textContent: 'All packs' }));
  for (const p of catalogue.packs()) packFilter.append(el('option', { value: p.code, textContent: `${p.code} (${p.count})` }));
  packFilter.value = 'UD';
  const tagCounts = new Map<string, number>();
  for (const e of catalogue.elements) for (const t of e.tags ?? []) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  tagFilter.append(el('option', { value: '', textContent: 'All tags' }));
  for (const [t] of [...tagCounts].filter(([, c]) => c >= 5).sort((a, b) => a[0].localeCompare(b[0]))) tagFilter.append(el('option', { value: t, textContent: t }));

  const PALETTE_LIMIT = 240;
  function renderPalette(): void {
    const q = searchInput.value.trim().toLowerCase();
    const pack = packFilter.value;
    const tag = tagFilter.value;
    const matches = catalogue.elements.filter((e) => {
      if (pack && packOf(e.code) !== pack) return false;
      if (tag && !(e.tags ?? []).includes(tag)) return false;
      if (q && !`${e.code} ${e.name} ${(e.tags ?? []).join(' ')}`.toLowerCase().includes(q)) return false;
      return true;
    });
    const pal = $('#palette');
    pal.replaceChildren(
      ...matches.slice(0, PALETTE_LIMIT).map((e) => {
        const item = el('div', { className: `pal-item${e.code === currentElement ? ' active' : ''}`, title: `${e.code} - ${e.name}\n${e.footprint.join('x')}, height ${e.height}\n${(e.tags ?? []).join(', ')}` }, [
          thumbImg(e.code),
          el('span', { className: 'code', textContent: e.code }),
          el('span', { className: 'name', textContent: e.name }),
        ]);
        item.addEventListener('click', () => {
          currentElement = e.code;
          setTool('place');
          pal.querySelectorAll('.pal-item.active').forEach((n) => n.classList.remove('active'));
          item.classList.add('active');
          renderCurrent();
        });
        return item;
      }),
    );
    $('#palette-info').textContent = matches.length > PALETTE_LIMIT ? `Showing ${PALETTE_LIMIT} of ${matches.length}. Refine the search.` : `${matches.length} element(s).`;
  }
  let searchTimer = 0;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(renderPalette, 150);
  });
  packFilter.addEventListener('change', renderPalette);
  tagFilter.addEventListener('change', renderPalette);

  function renderCurrent(): void {
    const e = currentElement ? catalogue.get(currentElement) : undefined;
    $('#current-element').replaceChildren(...(e ? [el('span', { className: 'hint', textContent: 'Placing:' }), el('strong', { textContent: e.code }), el('span', { textContent: `${e.name} (${e.footprint.join('x')}, h${e.height})` })] : []));
  }
  renderCurrent();

  function renderSelection(): void {
    const box = $('#selection');
    const s = renderer.selected;
    if (!s) {
      box.replaceChildren('Nothing selected.');
      return;
    }
    const e = catalogue.get(s.tile.element);
    const rotateBtn = el('button', { textContent: 'Rotate (R)' });
    const delBtn = el('button', { textContent: 'Delete (Del)' });
    rotateBtn.addEventListener('click', rotateSelected);
    delBtn.addEventListener('click', deleteSelected);
    box.replaceChildren(
      el('div', {}, [el('strong', { textContent: s.tile.element }), ` ${e?.name ?? '(unknown element)'}`]),
      el('div', { textContent: `Level ${s.level} · (${s.tile.x}, ${s.tile.y}) · orientation ${s.tile.orientation}${e ? ` · ${e.footprint.join('x')} h${e.height}` : ''}` }),
      el('div', { className: 'sel-actions' }, [rotateBtn, delBtn]),
    );
  }

  function rotateSelected(): void {
    const s = renderer.selected;
    if (!s) return;
    store.checkpoint();
    const t: DbbTile = { ...s.tile, orientation: (s.tile.orientation + 1) % 4 };
    store.remove(s.level, s.tile);
    store.place(s.level, t);
    renderer.selected = { level: s.level, tile: t };
    renderSelection();
  }
  function deleteSelected(): void {
    const s = renderer.selected;
    if (!s) return;
    store.checkpoint();
    store.remove(s.level, s.tile);
    renderer.selected = null;
    renderSelection();
  }

  // build list
  function renderBuildList(): void {
    const counts = new Map<string, number>();
    let total = 0;
    for (const l of store.design.levels) {
      for (const t of l.tiles) {
        counts.set(t.element, (counts.get(t.element) ?? 0) + 1);
        total++;
      }
    }
    $('#build-summary').textContent = `${total} pieces, ${counts.size} distinct elements, levels: ${store.design.levels.filter((l) => l.tiles.length).map((l) => l.index).join(', ') || 'none'}`;
    $('#build-list').replaceChildren(
      ...[...counts].sort((a, b) => a[0].localeCompare(b[0])).map(([code, n]) =>
        el('tr', {}, [
          el('td', {}, [thumbImg(code)]),
          el('td', {}, [el('strong', { textContent: code }), el('br'), catalogue.get(code)?.name ?? '(unknown)']),
          el('td', { className: 'count', textContent: `x${n}` }),
        ]),
      ),
    );
  }

  function updateStatus(extra = ''): void {
    const tiles = store.design.levels.reduce((s, l) => s + l.tiles.length, 0);
    $('#status').textContent = `${tiles} pieces${extra ? ' · ' + extra : ''}`;
  }

  // ---------- canvas interaction ----------
  let panning = false;
  let painting = false;
  let lastPaintKey = '';
  let lastX = 0;
  let lastY = 0;

  const placementFor = (cell: { x: number; y: number }): { tile: DbbTile; level: number } | null => {
    if (!currentElement) return null;
    const tile: DbbTile = { x: cell.x, y: cell.y, element: currentElement, orientation };
    let level = renderer.activeLevel;
    if (autoStack) level = Math.max(level, store.stackLevel(footprintCells(catalogue.get(currentElement), cell.x, cell.y, orientation), renderer.maxVisibleLevel));
    return { tile, level };
  };

  const applyTool = (clientX: number, clientY: number, first: boolean) => {
    const cell = renderer.cellAt(clientX, clientY, renderer.activeLevel);
    const key = `${cell.x},${cell.y}`;
    if (!first && key === lastPaintKey) return;
    lastPaintKey = key;
    switch (tool) {
      case 'place': {
        const p = placementFor(cell);
        if (!p) return;
        store.place(p.level, p.tile);
        break;
      }
      case 'erase': {
        const t = store.tileAt(renderer.activeLevel, cell.x, cell.y);
        if (t) store.remove(renderer.activeLevel, t);
        break;
      }
      case 'select': {
        const t = store.tileAt(renderer.activeLevel, cell.x, cell.y);
        const top = t ? { level: renderer.activeLevel, tile: t } : store.topTileAt(cell.x, cell.y, renderer.maxVisibleLevel);
        renderer.selected = top ?? null;
        renderSelection();
        renderer.requestRender();
        break;
      }
      case 'pick': {
        const top = store.tileAt(renderer.activeLevel, cell.x, cell.y) ? { tile: store.tileAt(renderer.activeLevel, cell.x, cell.y)! } : store.topTileAt(cell.x, cell.y, renderer.maxVisibleLevel);
        if (top) {
          currentElement = top.tile.element;
          setOrientation(top.tile.orientation);
          setTool('place');
          renderCurrent();
          renderPalette();
        }
        break;
      }
    }
  };

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    lastX = e.clientX;
    lastY = e.clientY;
    if (e.button === 1 || e.button === 2 || (e.button === 0 && (spaceDown || activeTab !== 'edit'))) {
      panning = true;
      canvas.style.cursor = 'grabbing';
      return;
    }
    if (e.button === 0 && activeTab === 'edit') {
      if (tool === 'place' || tool === 'erase') store.checkpoint();
      painting = tool === 'place' || tool === 'erase';
      applyTool(e.clientX, e.clientY, true);
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (panning) {
      renderer.panBy(e.clientX - lastX, e.clientY - lastY);
      lastX = e.clientX;
      lastY = e.clientY;
      return;
    }
    const cell = renderer.cellAt(e.clientX, e.clientY, renderer.activeLevel);
    updateStatus(`cell (${cell.x}, ${cell.y}) · level ${renderer.activeLevel}`);
    if (activeTab !== 'edit') return;
    if (painting) applyTool(e.clientX, e.clientY, false);
    if (tool === 'place') {
      const p = placementFor(cell);
      renderer.ghost = p ? { tile: p.tile, level: p.level, valid: !!catalogue.get(p.tile.element) } : null;
      renderer.hoverCell = null;
    } else {
      renderer.ghost = null;
      renderer.hoverCell = cell;
    }
    renderer.requestRender();
  });
  const endPointer = () => {
    panning = false;
    painting = false;
    lastPaintKey = '';
    canvas.style.cursor = '';
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointerleave', () => {
    renderer.ghost = null;
    renderer.hoverCell = null;
    renderer.requestRender();
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    renderer.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });

  window.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    if (target.matches('input:not([type=checkbox]):not([type=range]), select, textarea')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) store.redo();
      else store.undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      store.redo();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case ' ':
        spaceDown = true;
        e.preventDefault();
        break;
      case 'r':
      case 'R':
        if (activeTab === 'edit' && tool === 'select' && renderer.selected) rotateSelected();
        else {
          setOrientation(orientation + (e.shiftKey ? 3 : 1));
          if (renderer.ghost) renderer.ghost = { ...renderer.ghost, tile: { ...renderer.ghost.tile, orientation } };
          renderer.requestRender();
        }
        break;
      case 'q':
      case 'Q':
        renderer.setRotation(renderer.rotation + 3);
        break;
      case 'e':
      case 'E':
        renderer.setRotation(renderer.rotation + 1);
        break;
      case 'f':
      case 'F':
        renderer.fit();
        break;
      case '+':
      case '=':
        zoomCenter(1.25);
        break;
      case '-':
        zoomCenter(0.8);
        break;
      case 'Delete':
      case 'Backspace':
        if (activeTab === 'edit') deleteSelected();
        break;
      case '1': case '2': case '3': case '4':
        if (activeTab === 'edit') setTool((['select', 'place', 'erase', 'pick'] as Tool[])[Number(e.key) - 1]);
        break;
      case 'PageUp':
        levelInput.value = String(renderer.activeLevel + 1);
        levelInput.dispatchEvent(new Event('input'));
        break;
      case 'PageDown':
        levelInput.value = String(Math.max(0, renderer.activeLevel - 1));
        levelInput.dispatchEvent(new Event('input'));
        break;
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === ' ') spaceDown = false;
  });
}

main();
