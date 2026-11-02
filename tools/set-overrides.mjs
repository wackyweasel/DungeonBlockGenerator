// Hand-written corrections for tools/make-sets.mjs (per element set).
//   name, style ('dungeon' | 'cave' | 'wilds' | 'town' | 'swamp' | 'ship' | 'colossal'), scale, mainGround, mainWall,
//   grounds {key: [codes]}, exclude [codes], linkWalls [family keys], linkFlat / edgeFlat [family keys],
//   keepFamilies [family keys never merged into the main wall], decor {category: [codes]},
//   opts: passed through to the generator:
//     roomWalls: [family keys] usable for rooms (default: all; main wall preferred)
//     outdoorGround / indoorGround: ground keys for town & swamp styles
//     boundaryWall: family key of the wall surrounding the open area (town)
//     landGround: ground key of islands (swamp)
//     swamp: {roofs, tower, trail, treeSmall/Mid/Tall/Haunted, wTree..., mushLand, mushWater, tufts, ...: [codes]} curated pieces (swamp style)
//     doubleDoor: {left, right}
//     ship: {hull: family key, bow, backWall, boats, masts, cabin*, hullCannon, bunks, platform, rail, stairs, cargo, hatches, ...: [codes]} (ship style)
//     colossal: {supports, walls (family keys by height class), styles, doors, giant, bigStairs, stairs, stairAngles, columns, ...}
//       curated pieces of the multi-level colossal style (see Colossal in src/sets.ts)
//   extraWalls: [{key, h, base/decor/torch/doors: [[code, mask hint, weight?]]}] hand-made wall families
//   opts.outside: {floor: [codes], decor: [codes]} fills the empty cells around the layout (e.g. outer space)
//   extraLinks: [{key, liquid, pieces: [[code, open-side mask at o=0 (1 W, 2 N, 4 E, 8 S), weight?]]}]
//   masks: {code: mask at o=0} replaces a wrong sprite-analysis result
// Only the packs listed here are generated: the official ones (Dungeon Blocks Builder "Pack" filter / MyMiniFactory store).
export const OVERRIDES = {
  UD: {
    name: 'Ultimate Dungeon',
    style: 'dungeon',
    grounds: { '': [{ v: 'UD-016', w: 6 }, { v: 'UD-017', w: 3 }], tiles: [{ v: 'UD-045', w: 5 }, { v: 'UD-046', w: 2 }, { v: 'UD-047', w: 2 }], wood: ['UD-035'], prison: ['UD-057'] },
    opts: { roomWalls: [''], doubleDoor: { left: 'UD-082', right: 'UD-083' } },
  },
  LC: { name: 'Lost Cave', style: 'cave', opts: { roomWalls: ['mine', 'flat'] } },
  MH: {
    name: 'Majestic Highlands (XL)', style: 'wilds', mainGround: 'grass',
    opts: { elevation: { supports: [['MH-901', 'MH-904'], ['MH-902', 'MH-905'], ['MH-903', 'MH-906']], classes: [['low'], ['medium'], ['high']], stairs: [['MH-069'], ['MH-096'], ['MH-133']] } },
  },
  CD: {
    name: 'Colossal Dungeon (XL)', style: 'colossal', edgeFlat: ['grass'], mainGround: '',
    // curved walls are not straight wall variants
    exclude: ['CD-165', 'CD-166', 'CD-167'],
    // columns have no floor of their own: only the colossal style stacks them on a floor tile
    decor: { columns: [] },
    opts: {
      elevation: { supports: [['CD-111'], ['CD-112'], ['CD-113']], classes: [['low'], ['medium'], ['tall']], stairs: [['CD-057'], ['CD-069'], ['CD-097']] },
      colossal: {
        supports: ['CD-111', 'CD-112', 'CD-113'],
        walls: ['low', 'medium', 'tall'],
        styles: {
          rock: ['CD-065', 'CD-066', 'CD-067', 'CD-068', 'CD-080', 'CD-081', 'CD-082', 'CD-083', 'CD-084', 'CD-085'],
          ruins: ['CD-170', 'CD-171', 'CD-172', 'CD-173', 'CD-174', 'CD-175', 'CD-176', 'CD-177', 'CD-178', 'CD-179', 'CD-180', 'CD-181', 'CD-182', 'CD-183'],
          columns: ['CD-076', 'CD-077', 'CD-078', 'CD-079'],
          columnRuins: ['CD-184', 'CD-185', 'CD-186', 'CD-187'],
        },
        doors: ['CD-086', 'CD-188'],
        giant: ['CD-088', 'CD-089', 'CD-090'],
        bigStairs: [['CD-059'], ['CD-071'], ['CD-107', 'CD-108', 'CD-109']],
        stairs: [['CD-057', 'CD-058'], ['CD-069', 'CD-070'], ['CD-097', 'CD-098']],
        stairAngles: ['CD-060', 'CD-272', 'CD-110'],
        columns: ['CD-131', 'CD-132'],
        caps: ['CD-134'],
        brokenColumns: ['CD-133'],
        pedestals: ['CD-130'],
        pits: ['CD-141', 'CD-142', 'CD-143', 'CD-144'],
        statues: ['CD-025'],
        ruinedStatues: ['CD-024', 'CD-026'],
        guardians: ['CD-017', 'CD-018'],
        thrones: ['CD-011'],
        coffins: ['CD-019', 'CD-020', 'CD-022', 'CD-023'],
        gold: ['CD-021'],
        fires: ['CD-015', 'CD-016', 'CD-014'],
        wells: ['CD-012', 'CD-013'],
        rubble: ['CD-004', 'CD-006', 'CD-007', 'CD-008', 'CD-010', 'CD-164', 'CD-005'],
        floors: ['CD-001', 'CD-002 CD-003', 'CD-168'],
        grass: ['CD-027', 'CD-035'],
        grassDecor: ['CD-036', 'CD-037', 'CD-038'],
      },
    },
  },
  MN: {
    name: 'Mythic Northlands (XL)', style: 'wilds',
    opts: { elevation: { supports: [['MN-182'], ['MN-183'], ['MN-184']], classes: [['low snow', 'low ice'], ['medium snow', 'medium ice'], ['tall snow', 'tall ice']] } },
  },
  CS: {
    name: 'Creepy Swamp',
    style: 'swamp',
    opts: {
      landGround: 'grass',
      indoorGround: 'rotten',
      roomWalls: [''],
      swamp: {
        bridge: ['raised dock'], // wall family key used for bridges and piers
        roofs: ['CS-147', 'CS-148', 'CS-149', 'CS-150', 'CS-151'],
        tower: ['CS-152'],
        trail: ['CS-102', 'CS-103', 'CS-104', 'CS-105'],
        ruinAngle: ['CS-117', 'CS-135', 'CS-136'],
        ruinWall: ['CS-115', 'CS-116'],
        treeSmall: ['CS-082', 'CS-085'],
        treeMid: ['CS-083', 'CS-086'],
        treeTall: ['CS-084', 'CS-087'],
        treeHaunted: ['CS-100'],
        wTreeSmall: ['CS-088', 'CS-091', 'CS-094', 'CS-097'],
        wTreeMid: ['CS-089', 'CS-092', 'CS-095', 'CS-098'],
        wTreeTall: ['CS-090', 'CS-093', 'CS-096', 'CS-099'],
        wTreeHaunted: ['CS-101'],
        mushLand: ['CS-079', 'CS-080', 'CS-081'],
        mushWater: ['CS-076', 'CS-077', 'CS-078'],
        tufts: ['CS-036', 'CS-037'],
        trap: ['CS-038'],
        reeds: ['CS-009'],
        longReeds: ['CS-022', 'CS-023'],
        lilies: ['CS-002', 'CS-003', 'CS-004'],
        flotsam: ['CS-005', 'CS-006', 'CS-012', 'CS-013'],
        rocks: ['CS-014', 'CS-015', 'CS-016'],
        beasts: ['CS-019', 'CS-020'],
        wrecks: ['CS-017', 'CS-018'],
        vortex: ['CS-008'],
      },
    },
  },
  DE1: { name: 'Ultimate Dungeon Extension 1', style: 'dungeon' },
  ET: { name: 'Egyptian Temple', style: 'dungeon', opts: { roomWalls: ['', 'sand'] } },
  TS: { name: 'Toxic Sewer', style: 'dungeon', opts: { roomWalls: [''] } },
  IS: {
    name: 'Infinite Spaceship', style: 'dungeon',
    opts: { outside: { floor: ['IS-088', 'IS-089', 'IS-090', 'IS-091', 'IS-092'], decor: ['IS-093', 'IS-094', 'IS-098', 'IS-099', 'IS-100', 'IS-101'] } },
  },
  HG: { name: 'Haunted Graveyard (Christian Version)', style: 'town', opts: { outdoorGround: '', indoorGround: 'crypt', boundaryWall: 'fences', roomWalls: ['crypt', 'tall crypt'] } },
  HG2: { name: 'Haunted Graveyard 2 (Non-Denominational Version)', style: 'dungeon', opts: { roomWalls: ['crypt', 'catacombs'] } },
  MT1: { name: 'Medieval Town 1', style: 'town', grounds: { pavement: ['MT1-001', 'MT1-002'], '': ['MT1-003'], wood: ['MT1-014'] }, opts: { outdoorGround: 'pavement', indoorGround: 'wood', roomWalls: [''] } },
  MT2: { name: 'Medieval Town 2', style: 'town', opts: { outdoorGround: 'paved', indoorGround: 'wood', roomWalls: [''] } },
  RR: { name: 'Ramparts & Ruins', style: 'town', opts: { outdoorGround: 'dirt', roomWalls: [''] } },
  PS: {
    name: 'Pirate Ship',
    style: 'ship',
    // prison hulls, 2-cell hull pieces and tall hulls stay out of the random props
    exclude: ['PS-004', 'PS-007', 'PS-008', 'PS-009', 'PS-010', 'PS-011', 'PS-016', 'PS-017', ...Array.from({ length: 27 }, (_, i) => `PS-0${21 + i}`), 'PS-189',
      // prison cells and doors, and the pieces made to be stacked ("Key")
      ...Array.from({ length: 10 }, (_, i) => `PS-0${55 + i}`), ...Array.from({ length: 12 }, (_, i) => `PS-0${81 + i}`), 'PS-073', 'PS-078', 'PS-148', 'PS-167'],
    extraWalls: [{
      key: 'hull',
      h: 4,
      base: [['PS-001', 'wall'], ['PS-002', 'wall', 0.4], ['PS-003', 'angle']],
      decor: [['PS-005', 'wall'], ['PS-006', 'wall'], ['PS-012', 'wall'], ['PS-013', 'wall'], ['PS-014', 'wall'], ['PS-015', 'wall']],
      torch: [['PS-018', 'wall'], ['PS-019', 'wall']],
    }],
    opts: {
      roomWalls: [''],
      ship: {
        hull: 'hull', bow: ['PS-174', 'PS-175'], backWall: ['PS-153', 'PS-154'], boats: ['PS-191', 'PS-192', 'PS-193'], masts: ['PS-183'],
        cabinBed: ['PS-161', 'PS-162'], cabinDesk: ['PS-163'], cabinChest: ['PS-132', 'PS-133', 'PS-134'], cabinTable: ['PS-142', 'PS-140'],
        hullCannon: ['PS-020'], bunks: ['PS-068', 'PS-069'], platform: ['PS-122'], rail: ['PS-112'], stairs: ['PS-111'],
        cargo: ['PS-127', 'PS-128', 'PS-136', 'PS-137'], hatches: ['PS-123', 'PS-124'], deckItems: ['PS-135', 'PS-138'], deckLights: ['PS-129', 'PS-130'],
      },
    },
  },
};
