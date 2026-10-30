// 2.5D isometric renderer for the settlement.
// Draws a 12x12 diamond island (painter's algorithm), animated sea and SW
// shoreline, forest, stone outcrops, dirt roads, building pads, buildings
// (PNG sprites with a procedural fallback), construction scaffolding, walking
// villagers, chimney smoke and floating popups. Gameplay state is read from a
// Game instance; this module never changes it.

import { mulberry32, rngTools } from './clock.js';

export const TILE_W = 64;
export const TILE_H = 32;
export const GRID = 14;
export const ORIGIN = { x: 480, y: 76 };
export const VIEW_W = 960;
export const VIEW_H = 540;

export function tileToScreen(i, j) {
  return { x: ORIGIN.x + (i - j) * (TILE_W / 2), y: ORIGIN.y + (i + j) * (TILE_H / 2) };
}

// Fixed settlement layout. Pads are where the player can build.
export const BATTLE_COLS = 15;
export const BATTLE_ROWS = 9;
export const BATTLE_BLOCKED = [[7, 2], [7, 6], [8, 4]];
export const TOWN_CENTER_TILE = [5, 5];
export const RESEARCH_TENT_TILE = [2, 6];
export const PADS = [
  { id: 'pad_1', tile: [8, 5] },
  { id: 'pad_2', tile: [5, 8] },
  { id: 'pad_3', tile: [8, 2] },
  { id: 'pad_4', tile: [2, 3] },
  { id: 'pad_5', tile: [8, 8] },
  { id: 'pad_6', tile: [5, 2] },
  { id: 'pad_7', tile: [2, 9] },
  { id: 'pad_8', tile: [9, 1] },
];

export const EXPANSION_PADS = {
  exp_1: [{ id: 'pad_9', tile: [2, 5] }, { id: 'pad_10', tile: [2, 8] }],
  exp_2: [{ id: 'pad_11', tile: [9, 3] }, { id: 'pad_12', tile: [9, 6] }],
};

const isWater = (i, j) => false;
const isForest = (i, j) => i + j <= 3;
const isStony = (i, j) => i >= 10 && j <= 2;
const key = (i, j) => `${i},${j}`;

// Road from the Town Center to a tile: walk along i, then along j.
function routeTiles(to) {
  const [ti, tj] = TOWN_CENTER_TILE;
  const out = [[ti, tj]];
  let i = ti;
  let j = tj;
  while (i !== to[0]) { i += Math.sign(to[0] - i); out.push([i, j]); }
  while (j !== to[1]) { j += Math.sign(to[1] - j); out.push([i, j]); }
  return out;
}

// Path from the Town Center to a building's doorstep. Every building sprite
// faces south, so the door is at the bottom centre of the sprite and the
// villager must arrive from the south, never through a side wall.
// Building tiles are walls. Tiles next to a foreign building cost extra, so
// routes keep to open ground instead of squeezing past walls (Dijkstra).
function findRoute(game, building) {
  const start = TOWN_CENTER_TILE;
  const goal = building.tile;
  const blocked = new Set();
  for (const b of game.buildings) {
    if (b === building || !b.tile) continue;
    blocked.add(b.tile.join(','));
  }
  blocked.delete(start.join(','));
  const nearWall = (i, j) => {
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      if (blocked.has(`${i + di},${j + dj}`)) return true;
    }
    return false;
  };
  // South doorstep tiles, nearest first.
  const doors = [[1, 1], [2, 1], [1, 2], [2, 2], [2, 0], [0, 2]]
    .map(([di, dj]) => [goal[0] + di, goal[1] + dj])
    .filter(([i, j]) => i >= 0 && j >= 0 && i < GRID && j < GRID && !blocked.has(`${i},${j}`));
  if (!doors.length) return routeTiles(goal);
  const dist = new Map([[start.join(','), 0]]);
  const prev = new Map();
  const open = [[0, start]];
  while (open.length) {
    let best = 0;
    for (let n = 1; n < open.length; n++) if (open[n][0] < open[best][0]) best = n;
    const [d, [ci, cj]] = open.splice(best, 1)[0];
    if (d > (dist.get(`${ci},${cj}`) ?? Infinity)) continue;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = ci + di;
      const nj = cj + dj;
      const k = `${ni},${nj}`;
      if (ni < 0 || nj < 0 || ni >= GRID || nj >= GRID || blocked.has(k)) continue;
      const nd = d + 1 + (nearWall(ni, nj) ? 3 : 0);
      if (nd < (dist.get(k) ?? Infinity)) {
        dist.set(k, nd);
        prev.set(k, [ci, cj]);
        open.push([nd, [ni, nj]]);
      }
    }
  }
  let door = null;
  let doorCost = Infinity;
  doors.forEach(([i, j], idx) => {
    const c = (dist.get(`${i},${j}`) ?? Infinity) + idx * 1.5;
    if (c < doorCost) { doorCost = c; door = [i, j]; }
  });
  if (!door || doorCost === Infinity) return routeTiles(goal);
  const path = [door];
  let cur = door;
  while (cur[0] !== start[0] || cur[1] !== start[1]) {
    cur = prev.get(cur.join(','));
    if (!cur) return routeTiles(goal);
    path.unshift(cur);
  }
  return path;
}

const ALL_ROUTED_PADS = [
  ...PADS,
  ...EXPANSION_PADS.exp_1,
  ...EXPANSION_PADS.exp_2,
];

export const ROUTES = Object.fromEntries([
  ...ALL_ROUTED_PADS.map((p) => [p.id, routeTiles(p.tile)]),
  ['research_tent', routeTiles(RESEARCH_TENT_TILE)],
]);

const ROAD = new Set();
for (const route of Object.values(ROUTES)) {
  for (const [i, j] of route.slice(1, -1)) ROAD.add(key(i, j));
}

const RESOURCE_ICON = { food: '\u{1F35E}', wood: '\u{1FAB5}', stone: '\u{1FAA8}', rp: '\u{1F4DC}', scrolls: '📜', coins: '🪙' };

// Procedural fallback palettes, also used for scaffolding tints.
const FALLBACK_STYLE = {
  town_center:           { w: 46, d: 46, h: 34, wall: '#c9a46a', roof: '#8a5a2b', roofH: 30 },
  town_center_stone_age: { w: 50, d: 50, h: 40, wall: '#b8b2a4', roof: '#6f4a2a', roofH: 34 },
  shelter:               { w: 30, d: 30, h: 18, wall: '#b98d58', roof: '#c2a052', roofH: 22 },
  forager_hut:           { w: 30, d: 28, h: 18, wall: '#a87b4b', roof: '#7d9a3f', roofH: 18 },
  research_tent:         { w: 30, d: 30, h: 8,  wall: '#d9c79c', roof: '#b24a3a', roofH: 30 },
  woodcutter_hut:        { w: 32, d: 30, h: 20, wall: '#8a5e36', roof: '#5f7d39', roofH: 18 },
  stone_quarry:          { w: 36, d: 34, h: 12, wall: '#9b9488', roof: '#77706a', roofH: 10 },
  tribal_monument:       { w: 22, d: 22, h: 52, wall: '#a69c8b', roof: '#c9a43a', roofH: 12 },
  granary:               { w: 30, d: 30, h: 24, wall: '#c8a464', roof: '#9a6a32', roofH: 20 },
  smelter:               { w: 32, d: 30, h: 22, wall: '#8d7f72', roof: '#b0602e', roofH: 16 },
  barracks:              { w: 46, d: 46, h: 28, wall: '#9a7b56', roof: '#a3302a', roofH: 14 },
  hero_arena:            { w: 48, d: 48, h: 30, wall: '#a87f52', roof: '#8a5a30', roofH: 16 },
};
const CHIP = 18;

export class IsoRenderer {
  constructor(canvas, sprites, { seed = 42 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.sprites = sprites || {};
    this.seed = seed;
    const r = rngTools(mulberry32((seed ^ 0x5eed) >>> 0));
    this.ground = this.renderGround(rngTools(mulberry32((seed ^ 0x9a55) >>> 0)));
    this.fxRand = rngTools(mulberry32((seed ^ 0xf00d) >>> 0));
    this.popups = [];
    this.flyingIcons = [];
    this.particles = [];
    this.smokeTimers = new Map();
    this.villagers = new Map();
    this.bounces = new Map();   // building key -> real time the bounce started
    this.time = 0;              // real seconds, for ambient animation only
  }

  // Effects requested by the game (popups, dust, bounces, sparkles).
  fx(effect) {
    const pos = effect.tile ? tileToScreen(...effect.tile) : { x: effect.x, y: effect.y };
    switch (effect.type) {
      case 'popup':
        this.popups.push({ text: effect.text, color: effect.color || '#fff4c2', x: pos.x, y: pos.y - (effect.lift ?? 70), born: this.time });
        if (effect.text && effect.text.includes('+')) {
          const match = effect.text.match(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u);
          const icon = match ? match[0] : '✨';
          for (let i = 0; i < 4; i++) {
            this.flyingIcons.push({
              icon,
              sx: pos.x,
              sy: pos.y - 20,
              cx: (pos.x + 320) / 2 + (Math.random() - 0.5) * 80,
              cy: Math.min(pos.y, 22) - 60 - Math.random() * 50,
              tx: 320,
              ty: 22,
              born: this.time + i * 0.04,
              duration: 0.65,
            });
          }
        }
        break;
      case 'dust':
        for (let n = 0; n < 14; n++) this.particles.push(this.dustParticle(pos));
        break;
      case 'built':
        this.bounces.set(effect.key, this.time);
        for (let n = 0; n < 18; n++) this.particles.push(this.dustParticle(pos));
        break;
      case 'sparkle':
        for (let n = 0; n < 40; n++) this.particles.push(this.sparkParticle(pos));
        if (effect.key) this.bounces.set(effect.key, this.time);
        break;
      default:
        break;
    }
  }

  dustParticle(pos) {
    const r = this.fxRand;
    return {
      kind: 'dust', x: pos.x + r.range(-26, 26), y: pos.y + r.range(-6, 8),
      vx: r.range(-14, 14), vy: r.range(-22, -6), life: r.range(0.7, 1.3), age: 0, size: r.range(3, 7),
    };
  }

  sparkParticle(pos) {
    const r = this.fxRand;
    const a = r.range(0, Math.PI * 2);
    const s = r.range(30, 110);
    return {
      kind: 'spark', x: pos.x, y: pos.y - 50, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 40,
      life: r.range(0.8, 1.6), age: 0, size: r.range(2, 4), hue: r.pick([42, 48, 30, 190]),
    };
  }

  // Ground: grass, sand, roads and pad plots, rendered once to an offscreen canvas.
  renderGround(r) {
    const c = document.createElement('canvas');
    c.width = VIEW_W;
    c.height = VIEW_H;
    const g = c.getContext('2d');
    const hasBackdrop = !!this.sprites.valley_backdrop?.img;
    // Cliff faces under the south-east and south-west land edges (skip if painted backdrop is present).
    if (!hasBackdrop) {
      for (let i = 0; i < GRID; i++) {
        for (let j = 0; j < GRID; j++) {
          if (isWater(i, j)) continue;
          const { x, y } = tileToScreen(i, j);
          if (i === GRID - 1) sideFace(g, x, y, +1, '#7a5a3a', '#5e4430');
          if (j === GRID - 1 || isWater(i, j + 1)) sideFace(g, x, y, -1, '#8b6a45', '#6b4f34');
        }
      }
    }
    for (let i = 0; i < GRID; i++) {
      for (let j = 0; j < GRID; j++) {
        if (isWater(i, j)) continue;
        const { x, y } = tileToScreen(i, j);
        const shore = isWater(i, j + 1);
        let base;
        if (shore) base = shade('#e2cd92', r.range(-8, 8));
        else if (isStony(i, j)) base = shade('#97a06a', r.range(-10, 6));
        else if (isForest(i, j)) base = shade('#5f8f3c', r.range(-10, 6));
        else base = shade('#86b34e', r.range(-12, 10));
        g.save();
        if (hasBackdrop) {
          g.globalAlpha = 0.22;
        }
        diamond(g, x, y, TILE_W, TILE_H, base);
        // Soft tile edge so the grid reads without hard lines.
        g.strokeStyle = 'rgba(40,60,20,0.10)';
        g.lineWidth = 1;
        diamondPath(g, x, y, TILE_W, TILE_H);
        g.stroke();
        if (!shore && !ROAD.has(key(i, j))) {
          for (let n = 0; n < 5; n++) {
            const px = x + r.range(-20, 20);
            const py = y + r.range(-8, 8);
            if (Math.abs(px - x) / 32 + Math.abs(py - y) / 16 > 0.85) continue;
            g.fillStyle = r.chance(0.12) ? r.pick(['#f3e27a', '#f2f2f2', '#e98fb0']) : 'rgba(40,80,20,0.28)';
            g.fillRect(px, py, r.chance(0.5) ? 2 : 1, 2);
          }
        }
        if (shore) {
          for (let n = 0; n < 4; n++) {
            g.fillStyle = 'rgba(150,120,70,0.35)';
            g.fillRect(x + r.range(-18, 18), y + r.range(-6, 6), 2, 1);
          }
        }
        g.restore();
      }
    }
    // No roads: the meadow stays clean.
    // Plaza under the Town Center and the tent.
    for (const [i, j] of [TOWN_CENTER_TILE, RESEARCH_TENT_TILE]) {
      const { x, y } = tileToScreen(i, j);
      diamond(g, x, y, TILE_W * 1.5, TILE_H * 1.5, '#c2a173');
      diamond(g, x, y, TILE_W * 1.3, TILE_H * 1.3, '#cfb084');
    }
    // No fixed plot boxes: placement is free, so the meadow stays natural.
    // A soft worn-earth patch (radial, no hard edges) under the fixed starter
    // plots keeps the first guided builds readable.
    PADS.forEach((p) => {
      const { x, y } = tileToScreen(...p.tile);
      const grad = g.createRadialGradient(x, y, 2, x, y, 30);
      grad.addColorStop(0, 'rgba(199,168,120,0.30)');
      grad.addColorStop(1, 'rgba(199,168,120,0)');
      g.save();
      g.translate(x, y);
      g.scale(1, 0.5);
      g.translate(-x, -y);
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, 30, 0, Math.PI * 2);
      g.fill();
      g.restore();
    });
    return c;
  }

  // ---------------------------------------------------------------- frame
  render(game, realDt) {
    this.time += realDt;
    const simDt = realDt * (game.clock.paused ? 0 : game.clock.speed);
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(this.canvas.width / VIEW_W, 0, 0, this.canvas.height / VIEW_H, 0, 0);

    const inBattle = !!(game.battleState || (game.battleArena && game.battleArena.active) || (game.battle && (game.battle.active || game.battle.state)));
    if (inBattle) {
      this.renderBattleArena(ctx, game, realDt);
      ctx.restore();
      return;
    }

    this.drawSea(ctx);
    this.drawShallows(ctx);
    ctx.drawImage(this.ground, 0, 0);
    this.drawCultureAura(ctx, game);
    this.drawPadHighlights(ctx, game);

    const items = [];
    for (const b of game.buildings) {
      const pos = tileToScreen(...b.tile);
      items.push({ y: pos.y, draw: () => this.drawBuilding(ctx, game, b, pos) });
    }
    this.updateVillagers(game, simDt);
    for (const v of this.villagers.values()) items.push({ y: v.y, draw: () => drawVillager(ctx, v, this.time, this.sprites[v.variant]?.img || this.sprites.villager?.img, this.sprites[`${v.variant}_b`]?.img) });
    items.sort((a, b) => a.y - b.y);
    for (const it of items) it.draw();
    this.drawPlacementPreview(ctx, game);

    this.updateSmoke(game, simDt);
    this.drawParticles(ctx, realDt);
    for (const b of game.buildings) this.drawStatus(ctx, game, b);
    this.drawPopups(ctx, realDt);
    ctx.restore();
  }

  get activeAnimations() {
    return this.popups.length + (this.flyingIcons?.length || 0) + this.particles.filter((p) => p.kind !== 'smoke').length + this.bounces.size;
  }

  drawSea(ctx) {
    if (this.sprites.valley_backdrop?.img) {
      ctx.drawImage(this.sprites.valley_backdrop.img, 0, 0, VIEW_W, VIEW_H);
      // Animated turquoise waterfall mist particles near (400, 95)
      for (let i = 0; i < 7; i++) {
        const mx = 400 + Math.sin(this.time * 2.5 + i * 1.2) * 14;
        const my = 95 + ((this.time * 30 + i * 16) % 40);
        const r = 3 + (i % 3) * 2;
        const alpha = 0.22 + 0.16 * Math.sin(this.time * 3.5 + i);
        ctx.fillStyle = `rgba(140, 235, 245, ${alpha})`;
        ctx.beginPath();
        ctx.arc(mx, my, r, 0, Math.PI * 2);
        ctx.fill();
      }
      // Gentle river sparkles near (680, 495)
      for (let i = 0; i < 6; i++) {
        const sx = 650 + ((i * 26 + this.time * 20) % 75);
        const sy = 490 + Math.sin(this.time * 2.8 + i * 1.7) * 9;
        const alpha = 0.35 + 0.35 * Math.sin(this.time * 4.5 + i * 2);
        ctx.fillStyle = `rgba(235, 255, 255, ${alpha})`;
        ctx.fillRect(sx, sy, 3, 3);
      }
      // Flowing river: dashed current lines and foam dots travel along the
      // painted river (bottom right, under the bridge) so the water moves.
      const riverPts = [[-10, 397], [90, 413], [190, 470], [260, 490], [340, 500], [430, 520], [540, 523], [640, 503], [720, 475], [800, 450], [880, 394], [962, 364]];
      const riverPoint = (t) => {
        const seg = Math.max(0, Math.min(riverPts.length - 2, Math.floor(t * (riverPts.length - 1))));
        const lt = t * (riverPts.length - 1) - seg;
        const [ax, ay] = riverPts[seg];
        const [bx, by] = riverPts[seg + 1];
        return { x: ax + (bx - ax) * lt, y: ay + (by - ay) * lt };
      };
      // Two separate flow segments: downstream of the bridge and upstream
      // of it. Nothing is drawn between them, so no flow can cross the bridge.
      // Short segments that follow the water only; gaps at the rocks and
      // bends keep the dashes off the grass banks.
      // Three segments between the left edge and the bridge, each fitted
      // to the painted river: inflow, the rapids dip, then the rise to
      // the bridge. A fourth runs right of the bridge.
      const riverSegs = [
        [[-10, 397], [90, 413], [190, 470]],
        [[225, 460], [300, 490], [380, 513]],
        [[470, 527], [580, 520], [680, 490], [745, 465]],
        [[850, 407], [962, 364]],
      ];
      ctx.save();
      for (const [off, wdt, alpha] of [[0, 3, 0.40], [14, 2, 0.32], [28, 2, 0.26]]) {
        ctx.strokeStyle = `rgba(220, 248, 255, ${alpha})`;
        ctx.lineWidth = wdt;
        ctx.setLineDash([16, 22]);
        ctx.lineDashOffset = -(this.time * 42 + off);
        for (const segPts of riverSegs) {
          ctx.beginPath();
          segPts.forEach(([x, y], i) => {
            const yy = y + (off - 14) * 0.55;
            if (i === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
          });
          ctx.stroke();
        }
      }
      ctx.setLineDash([]);
      for (let i = 0; i < 9; i++) {
        const t = (((this.time * 0.055 + i / 9) % 1) + 1) % 1;
        const p = riverPoint(t);
        // Foam vanishes well before the bridge and reappears after it.
        if (p.x > 745 && p.x < 858 && p.y > 375 && p.y < 455) continue;
        const a = 0.25 + 0.45 * Math.sin(t * Math.PI);
        ctx.fillStyle = `rgba(255,255,255,${a})`;
        ctx.beginPath();
        ctx.arc(p.x + Math.sin(i * 7.3) * 7, p.y + Math.cos(i * 5.1) * 4, 1.6 + (i % 3) * 0.7, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      // The bridge is painted into the backdrop, so repaint it over the
      // flow lines: the water passes under the bridge, not over it. The
      // clip follows the bridge outline (arch opening excluded, so the
      // flow stays visible through it); same image, so no seam.
      const bgImg = this.sprites.valley_backdrop.img;
      ctx.save();
      ctx.beginPath();
      const bridgePoly = [
        [690, 400], [700, 388], [730, 376], [790, 378], [845, 398],
        [868, 420], [870, 452], [855, 468], [840, 452], [832, 418],
        [766, 462], [742, 428], [716, 424], [706, 460], [694, 458],
      ];
      bridgePoly.forEach(([x, y], i) => { if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(bgImg, 0, 0, VIEW_W, VIEW_H);
      ctx.restore();
    } else {
      // Fallback: rich sunlit emerald Alpine Valley gradient (#6eb349 -> #468330)
      const grad = ctx.createLinearGradient(0, 0, 0, VIEW_H);
      grad.addColorStop(0, '#6eb349');
      grad.addColorStop(1, '#468330');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);

      // Northern limestone cliff polygons (#8d877a)
      ctx.fillStyle = '#8d877a';
      ctx.beginPath();
      ctx.moveTo(310, 0);
      ctx.lineTo(355, 65);
      ctx.lineTo(405, 105);
      ctx.lineTo(465, 75);
      ctx.lineTo(530, 0);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#7a7469';
      ctx.beginPath();
      ctx.moveTo(375, 0);
      ctx.lineTo(415, 80);
      ctx.lineTo(455, 0);
      ctx.closePath();
      ctx.fill();

      // Cascading turquoise waterfall (#59d8e6)
      ctx.strokeStyle = '#59d8e6';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(408, 15);
      ctx.lineTo(404, 70);
      ctx.lineTo(410, 110);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Southern rushing river (#2fa4c7) with stone bridge
      ctx.fillStyle = '#2fa4c7';
      ctx.beginPath();
      ctx.moveTo(560, 460);
      ctx.bezierCurveTo(620, 475, 710, 495, 830, 540);
      ctx.lineTo(560, 540);
      ctx.closePath();
      ctx.fill();

      // Stone bridge
      roundRect(ctx, 640, 480, 48, 16, 4, '#78736a');
      ctx.strokeStyle = '#555048';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(640, 480, 48, 16, 4);
      ctx.stroke();
    }

    // 4 grazing white sheep near the meadow edges
    const sheepPos = [
      { x: 120, y: 375 },
      { x: 148, y: 395 },
      { x: 800, y: 342 },
      { x: 832, y: 360 },
    ];
    for (let i = 0; i < sheepPos.length; i++) {
      const s = sheepPos[i];
      const bob = Math.sin(this.time * 2.2 + i * 1.5) * 0.8;
      ctx.fillStyle = '#fbfbfa';
      ctx.beginPath();
      ctx.ellipse(s.x, s.y + bob, 8, 5, 0, 0, Math.PI * 2);
      ctx.fill();
      circle(ctx, s.x + 6, s.y + bob - 2, 2.5, '#3a342e');
      ctx.strokeStyle = '#3a342e';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(s.x - 4, s.y + bob + 4); ctx.lineTo(s.x - 4, s.y + bob + 8);
      ctx.moveTo(s.x + 3, s.y + bob + 4); ctx.lineTo(s.x + 3, s.y + bob + 8);
      ctx.stroke();
    }

    // 3 gliding V-shaped birds
    for (let b = 0; b < 3; b++) {
      const bx = ((this.time * 26 + b * 300) % 1160) - 100;
      const by = 55 + b * 48 + Math.sin(this.time * 1.4 + b) * 12;
      const flap = Math.sin(this.time * 4.2 + b * 2) * 3;
      ctx.strokeStyle = 'rgba(40, 50, 35, 0.65)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(bx - 8, by + flap);
      ctx.lineTo(bx, by);
      ctx.lineTo(bx + 8, by + flap);
      ctx.stroke();
    }
  }

  // Soft wildflower & meadow tufts across the southern meadows
  drawShallows(ctx) {
    const tufts = [
      { x: 250, y: 440, color: '#f7d75a' },
      { x: 300, y: 465, color: '#e58cb3' },
      { x: 370, y: 480, color: '#ffffff' },
      { x: 440, y: 495, color: '#f7d75a' },
      { x: 510, y: 485, color: '#e58cb3' },
      { x: 580, y: 465, color: '#7ad3f7' },
      { x: 210, y: 420, color: '#ffffff' },
      { x: 340, y: 445, color: '#f7d75a' },
    ];
    for (let idx = 0; idx < tufts.length; idx++) {
      const tf = tufts[idx];
      const sway = Math.sin(this.time * 2.2 + idx) * 2;
      ctx.strokeStyle = '#4e8d35';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(tf.x, tf.y);
      ctx.lineTo(tf.x - 3 + sway, tf.y - 7);
      ctx.moveTo(tf.x, tf.y);
      ctx.lineTo(tf.x + sway * 0.5, tf.y - 9);
      ctx.moveTo(tf.x, tf.y);
      ctx.lineTo(tf.x + 3 + sway, tf.y - 7);
      ctx.stroke();
      circle(ctx, tf.x + sway * 0.5, tf.y - 9, 2, tf.color);
    }
  }

  // Culture Site Adjacency Aura: pulsing lime-green radial diamond around completed tribal_monument
  drawCultureAura(ctx, game) {
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 4);
    const alpha = 0.16 + 0.08 * pulse;
    const monumentTiles = [];
    for (const b of game.buildings) {
      if (b.type === 'tribal_monument' && b.status === 'done') {
        monumentTiles.push(b.tile);
      }
    }
    // No aura preview over every free tile while placing the monument;
    // the aura shows once the monument stands.
    if (monumentTiles.length === 0) return;
    ctx.save();
    ctx.setLineDash([8, 6]);
    ctx.strokeStyle = '#8cff66';
    ctx.lineWidth = 2.5;
    for (const tile of monumentTiles) {
      const { x, y } = tileToScreen(...tile);
      diamond(ctx, x, y, TILE_W * 5, TILE_H * 5, `rgba(110, 245, 85, ${alpha})`);
      diamondPath(ctx, x, y, TILE_W * 5, TILE_H * 5);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawPadHighlights(ctx, game) {
    if (!game.selectedCard) return;
    // Free placement: one soft golden wash over the whole buildable meadow
    // (borderless tile fills merge into a single glow, no checkerboard), and
    // only the guide target gets an outline.
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 5);
    const pads = game.padsFor ? game.padsFor(game.selectedCard) : (game.activePads ? game.activePads() : PADS);
    ctx.fillStyle = `rgba(255,238,170,${0.10 + 0.04 * pulse})`;
    for (const p of pads) {
      if (game.buildingAt(p.id)) continue;
      const { x, y } = tileToScreen(...p.tile);
      diamondPath(ctx, x, y, TILE_W, TILE_H);
      ctx.fill();
    }
    // Outline the whole buildable diamond so painted meadow outside the
    // field does not look placeable.
    // One row less on the top-right: the outline runs along j=1, not j=0,
    // so the forest row at the top-right stays outside the building box.
    const n = tileToScreen(0, 1), e = tileToScreen(GRID - 1, 1), s = tileToScreen(GRID - 1, GRID - 1), w = tileToScreen(0, GRID - 1);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(n.x, n.y - TILE_H / 2);
    ctx.lineTo(e.x + TILE_W / 2, e.y);
    ctx.lineTo(s.x, s.y + TILE_H / 2);
    ctx.lineTo(w.x - TILE_W / 2, w.y);
    ctx.closePath();
    ctx.strokeStyle = `rgba(255,215,94,${0.55 + 0.35 * pulse})`;
    ctx.lineWidth = 3;
    ctx.shadowColor = '#ffd75e';
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.restore();
    // Blocked tiles inside the field (forest, cliffs, standing buildings)
    // get a red wash and cross, so "cannot build here" is visible, not silent.
    const buildable = new Set(pads.map((p) => p.tile.join(',')));
    for (let i = 0; i < GRID; i++) {
      for (let j = 0; j < GRID; j++) {
        if (buildable.has(`${i},${j}`)) continue;
        if (i === TOWN_CENTER_TILE[0] && j === TOWN_CENTER_TILE[1]) continue;
        if (i === RESEARCH_TENT_TILE[0] && j === RESEARCH_TENT_TILE[1]) continue;
        const { x, y } = tileToScreen(i, j);
        diamondPath(ctx, x, y, TILE_W * 0.96, TILE_H * 0.96);
        ctx.fillStyle = 'rgba(200,60,40,0.16)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(220,70,50,0.45)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x - 10, y - 5);
        ctx.lineTo(x + 10, y + 5);
        ctx.moveTo(x + 10, y - 5);
        ctx.lineTo(x - 10, y + 5);
        ctx.stroke();
      }
    }
    // The pine woods on the far left and far right are outside the field:
    // mark them blocked too, so they do not look placeable.
    const pineTiles = [[-1, 10], [-1, 12], [-1, 14], [0, 14], [-2, 12], [-2, 14],
      [10, -1], [12, -1], [14, -1], [14, 0], [12, -2], [14, -2]];
    for (const [i, j] of pineTiles) {
      const { x, y } = tileToScreen(i, j);
      if (x < -20 || x > VIEW_W + 20) continue;
      diamondPath(ctx, x, y, TILE_W * 0.96, TILE_H * 0.96);
      ctx.fillStyle = 'rgba(200,60,40,0.16)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(220,70,50,0.45)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x - 10, y - 5);
      ctx.lineTo(x + 10, y + 5);
      ctx.moveTo(x + 10, y - 5);
      ctx.lineTo(x - 10, y + 5);
      ctx.stroke();
    }
    const guide = game.guideTarget ? game.guideTarget() : null;
    for (const p of pads) {
      if (p.id !== guide || game.buildingAt(p.id)) continue;
      const { x, y } = tileToScreen(...p.tile);
      ctx.save();
      ctx.shadowColor = '#ffd75e';
      ctx.shadowBlur = 10 + pulse * 10;
      ctx.strokeStyle = `rgba(255,215,94,${0.6 + 0.4 * pulse})`;
      ctx.lineWidth = 3;
      diamondPath(ctx, x, y, TILE_W * 0.96, TILE_H * 0.96);
      ctx.stroke();
      ctx.restore();
    }
  }

  // HoH placement widget: translucent ghost of the chosen building on the
  // tapped tile, green footprint, and cancel / confirm buttons below it.
  // Nothing is built until confirm is tapped.
  drawPlacementPreview(ctx, game) {
    const pending = game.pendingPlacement;
    if (!pending || game.modal) return;
    const { x, y } = tileToScreen(...pending.tile);
    ctx.save();
    diamondPath(ctx, x, y, TILE_W * 0.96, TILE_H * 0.96);
    ctx.fillStyle = 'rgba(110,245,85,0.35)';
    ctx.fill();
    ctx.strokeStyle = '#6ef555';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.globalAlpha = 0.6;
    this.drawBuilding(ctx, game, { key: 'ghost', type: pending.type, tile: pending.tile, status: 'done', level: 1, worker: 0 }, { x, y });
    ctx.restore();
    const btn = (cx, fill, glyph) => {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, y + 35, 16, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#fff3c4';
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 17px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(glyph, cx, y + 36);
      ctx.restore();
    };
    btn(x - 35, '#c0392b', '✕');
    btn(x + 35, '#2e9e2e', '✓');
  }

  spriteKeyFor(game, b) {
    if (b.type === 'town_center') {
      if (game.era === 'bronze_age') return 'town_center_bronze_age';
      if (game.era === 'stone_age') return 'town_center_stone_age';
      return 'town_center';
    }
    if (b.type === 'shelter') {
      return ((b.level || 1) >= 2 && this.sprites.small_home_lv2) ? 'small_home_lv2' : 'shelter';
    }
    if (b.type === 'forager_hut') {
      return ((b.level || 1) >= 2 && this.sprites.rural_farm) ? 'rural_farm' : 'forager_hut';
    }
    if (b.type === 'hero_arena') return 'hero_arena';
    if (b.type === 'barracks') {
      return ((b.level || 1) >= 2 && this.sprites.barracks_lv2) ? 'barracks_lv2' : 'barracks';
    }
    if (b.type === 'tribal_monument') {
      return ((b.level || 1) >= 2 && this.sprites.culture_site) ? 'culture_site' : 'tribal_monument';
    }
    return b.type;
  }

  drawBuilding(ctx, game, b, pos) {
    const spriteKey = this.spriteKeyFor(game, b);
    if (b.status === 'building') {
      const p = Math.max(0, Math.min(1, (game.clock.t - b.placedAt) / game.config.build_time_sec));
      this.drawConstruction(ctx, spriteKey, pos, p);
      return;
    }
    let scale = 1;
    const started = this.bounces.get(b.key);
    if (started !== undefined) {
      const k = (this.time - started) / 0.45;
      if (k >= 1) this.bounces.delete(b.key);
      else scale = 1 + 0.14 * Math.sin(k * Math.PI) * (1 - k);
    }
    const sprite = this.sprites[spriteKey];
    if (sprite) {
      const w = sprite.width * scale;
      const h = sprite.height * scale;
      ctx.drawImage(sprite.img, pos.x - sprite.anchor[0] * w, pos.y - sprite.anchor[1] * h, w, h);
      // Animated flames over the painted fires (Town Center campfire and
      // braziers, smelter furnace). Anchors live in the sprite manifest.
      if (sprite.fire) {
        let seed = 0;
        for (const ch of b.key || '') seed += ch.charCodeAt(0);
        for (const [fx, fy] of sprite.fire) {
          this.drawFire(ctx,
            pos.x - sprite.anchor[0] * w + fx * w,
            pos.y - sprite.anchor[1] * h + fy * h,
            w * 0.085, seed);
          seed += 7;
        }
      }
    } else {
      drawProceduralBuilding(ctx, spriteKey, pos, scale);
    }
  }

  // Flickering flame at (x, y) on the fire's base, about `size` px tall.
  drawFire(ctx, x, y, size, seed) {
    const t = this.time;
    const sway = Math.sin(t * 9 + seed * 1.7) * size * 0.10 + Math.sin(t * 23 + seed) * size * 0.04;
    const tall = size * (1 + 0.16 * Math.sin(t * 11 + seed * 2.3) + 0.07 * Math.sin(t * 27 + seed));
    // Warm glow.
    const glow = ctx.createRadialGradient(x, y - tall * 0.4, 1, x, y - tall * 0.4, size * 1.15);
    glow.addColorStop(0, 'rgba(255,170,60,0.34)');
    glow.addColorStop(1, 'rgba(255,140,40,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y - tall * 0.4, size * 1.15, 0, Math.PI * 2);
    ctx.fill();
    // Three nested teardrop flames, tips leaning with the flicker.
    const flame = (w, h, tip, color) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x - w, y);
      ctx.bezierCurveTo(x - w, y - h * 0.55, x + tip - w * 0.35, y - h * 0.75, x + tip, y - h);
      ctx.bezierCurveTo(x - tip + w * 0.35, y - h * 0.75, x + w, y - h * 0.55, x + w, y);
      ctx.bezierCurveTo(x + w * 0.45, y - h * 0.16, x - w * 0.45, y - h * 0.16, x - w, y);
      ctx.fill();
    };
    flame(size * 0.52, tall, sway, 'rgba(232,106,26,0.92)');
    flame(size * 0.36, tall * 0.74, sway * 1.25, 'rgba(248,178,44,0.95)');
    flame(size * 0.20, tall * 0.48, sway * 1.5, 'rgba(255,236,170,0.97)');
    // Rising embers.
    for (let i = 0; i < 3; i++) {
      const k = (t * 0.7 + seed * 0.13 + i / 3) % 1;
      ctx.fillStyle = `rgba(255,${170 + Math.floor(60 * (1 - k))},60,${0.75 * (1 - k)})`;
      ctx.beginPath();
      ctx.arc(x + Math.sin(seed + i * 5 + t * 3) * size * 0.3 * k, y - tall * (0.5 + k * 0.9), 1.3 * (1 - k) + 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawConstruction(ctx, spriteKey, pos, p) {
    const { x, y } = pos;
    // Foundation stones.
    diamond(ctx, x, y, 56, 28, '#9a8a72');
    diamond(ctx, x, y - 2, 50, 25, '#b5a386');
    // Building rising behind the scaffold, revealed bottom-up.
    const sprite = this.sprites[spriteKey];
    if (sprite && p > 0.15) {
      const w = sprite.width;
      const h = sprite.height;
      const top = pos.y - sprite.anchor[1] * h;
      const reveal = h * Math.min(1, (p - 0.15) / 0.85);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x - w, top + h - reveal, w * 2, reveal);
      ctx.clip();
      ctx.globalAlpha = 0.35 + 0.5 * p;
      ctx.drawImage(sprite.img, x - sprite.anchor[0] * w, top, w, h);
      ctx.restore();
    }
    // Scaffolding poles and beams.
    const H = 18 + 46 * Math.min(1, p * 1.3);
    const corners = [[-24, 0], [0, -12], [24, 0], [0, 12]];
    ctx.strokeStyle = '#7b5130';
    ctx.lineWidth = 2.5;
    for (const [dx, dy] of corners) {
      ctx.beginPath();
      ctx.moveTo(x + dx, y + dy);
      ctx.lineTo(x + dx, y + dy - H);
      ctx.stroke();
    }
    ctx.strokeStyle = '#a5743f';
    ctx.lineWidth = 2;
    for (let level = 12; level < H; level += 14) {
      ctx.beginPath();
      corners.forEach(([dx, dy], n) => {
        const px = x + dx;
        const py = y + dy - level;
        if (n === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.closePath();
      ctx.stroke();
    }
    // Diagonal braces on the two front faces.
    ctx.strokeStyle = 'rgba(123,81,48,0.8)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x - 24, y);
    ctx.lineTo(x, y + 12 - H);
    ctx.moveTo(x + 24, y);
    ctx.lineTo(x, y + 12 - H);
    ctx.stroke();
    // Progress bar.
    const bw = 54;
    roundRect(ctx, x - bw / 2, y - H - 22, bw, 8, 4, 'rgba(30,20,10,0.75)');
    roundRect(ctx, x - bw / 2 + 1.5, y - H - 20.5, (bw - 3) * p, 5, 2.5, '#f0c24b');
    if (this.fxRand.chance(0.25)) this.particles.push(this.dustParticle({ x, y }));

    // Bright green ⚡ FREE pill on top of scaffolding
    const chipX = x - 28;
    const chipY = y - 58;
    roundRect(ctx, chipX, chipY, 56, 20, 10, '#10b981');
    ctx.strokeStyle = '#065f46';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(chipX, chipY, 56, 20, 10);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 11px Georgia, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('⚡ FREE', x, chipY + 10);
    ctx.textBaseline = 'alphabetic';
  }

  // Production timers, ready icons and blocked badges above buildings.
  drawStatus(ctx, game, b) {
    if (b.status !== 'done') return;
    this.drawBadges(ctx, game, b);
    // A hero training at the Arena shows a countdown badge over the roof.
    if (b.type === 'hero_arena' && game.heroTraining) {
      const { x, y } = tileToScreen(...b.tile);
      const left = Math.max(0, Math.ceil(game.heroTraining.completeAt - game.clock.t));
      roundRect(ctx, x - 52, y - 88, 104, 20, 10, 'rgba(60,35,90,0.92)');
      ctx.fillStyle = '#e8dcff';
      ctx.font = 'bold 11px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.fillText(`⚔️ Training ${left}s`, x, y - 74);
      return;
    }
    if (!b.produces) return;
    const { x, y } = tileToScreen(...b.tile);
    const top = y - 78;
    if (b.blockedReason && !b.worker && b.blockedReason.startsWith('Unstaffed')) {
      roundRect(ctx, x - 46, top - 10, 92, 20, 10, 'rgba(214,140,28,0.94)');
      ctx.fillStyle = '#2b1a05';
      ctx.font = 'bold 11px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.fillText('\u26A0\uFE0F No Worker', x, top + 4);
      return;
    }
    if (b.blockedReason) {
      roundRect(ctx, x - 62, top - 10, 124, 20, 10, 'rgba(60,28,20,0.86)');
      ctx.fillStyle = '#ffd9c0';
      ctx.font = 'bold 10px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.fillText(b.blockedReason, x, top + 4);
      return;
    }
    if (b.ready) {
      const bob = Math.sin(this.time * 4 + b.tile[0]) * 4;
      ctx.save();
      ctx.shadowColor = 'rgba(255,220,120,0.9)';
      ctx.shadowBlur = 12;
      circle(ctx, x, top + bob, 15, '#fff8e1');
      ctx.restore();
      ctx.strokeStyle = '#c99a2e';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, top + bob, 15, 0, Math.PI * 2);
      ctx.stroke();
      // Painted resource icon (Muse Image) in the bubble; emoji fallback.
      const resImg = this.sprites[`res_${b.produces}`]?.img;
      if (resImg) {
        const iw = 23;
        const ih = iw * (resImg.naturalHeight / resImg.naturalWidth);
        ctx.drawImage(resImg, x - iw / 2, top + bob - ih / 2, iw, ih);
      } else {
        ctx.font = '17px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#000';
        ctx.fillText(RESOURCE_ICON[b.produces], x, top + bob + 1);
        ctx.textBaseline = 'alphabetic';
      }
      return;
    }
    const p = game.productionProgress(b);
    circle(ctx, x, top, 9, 'rgba(30,20,10,0.6)');
    ctx.strokeStyle = '#9be36a';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, top, 7, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
    ctx.stroke();
  }

  // Upgrade and worker chips under a building. The level shows only in the
  // brief "Lv.X!" popup at upgrade time; no permanent badge stays on the building.
  drawBadges(ctx, game, b) {
    const { x, y } = tileToScreen(...b.tile);
    if (b.cultureBoost) {
      roundRect(ctx, x - 26, y - 82, 52, 16, 8, '#3bb346');
      ctx.strokeStyle = '#1d5e23';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.roundRect(x - 26, y - 82, 52, 16, 8);
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 10px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('😊 +20%', x, y - 74);
      ctx.textBaseline = 'alphabetic';
    }
    for (const chip of this.chipsFor(game, b)) {
      const cx = chip.x + CHIP / 2;
      const cy = chip.y + CHIP / 2;
      circle(ctx, cx, cy, CHIP / 2, chip.kind === 'upgrade' ? (chip.affordable ? '#f0c24b' : '#8f7a4a') : (chip.staffed ? '#4f7d3a' : '#d68c1c'));
      ctx.strokeStyle = 'rgba(30,20,10,0.8)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, CHIP / 2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.font = '11px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#1d1208';
      ctx.fillText(chip.kind === 'upgrade' ? '\u2B06' : '\u{1F477}', cx, cy + 1);
      ctx.textBaseline = 'alphabetic';
    }
  }

  chipsFor(game, b) {
    const { x, y } = tileToScreen(...b.tile);
    if (b.status === 'building') {
      return [{
        target_id: 'free_' + b.key,
        kind: 'free_finish',
        building_type: b.type,
        x: x - 28,
        y: y - 58,
        w: 56,
        h: 20,
        affordable: true,
      }];
    }
    if (b.status !== 'done' || !(b.key.startsWith('pad_') || b.key.startsWith('tile_'))) return [];
    const out = [];
    // The worker sign is an action prompt: it shows only while the building has
    // no worker, and clicking it assigns one. A staffed building shows no sign.
    if (b.produces && game.workersPerBuilding > 0 && !b.worker) {
      out.push({ target_id: `worker_${b.key}`, kind: 'worker', x: x - 34, y: y + 2, w: CHIP, h: CHIP,
                 staffed: false, building_type: b.type });
    }
    // The upgrade chip shows only when the upgrade can actually be used now:
    // research unlocked and affordable. Otherwise it stays hidden.
    const up = game.upgradeStatus(b);
    if (up.available && up.affordable) {
      out.push({ target_id: `upgrade_${b.key}`, kind: 'upgrade', x: x + 16, y: y + 2, w: CHIP, h: CHIP,
                 level: up.level, affordable: true, building_type: b.type });
    }
    return out;
  }

  updateVillagers(game, simDt) {
    const wanted = new Set();
    for (const b of game.buildings) {
      if (b.status !== 'done' || !b.worker) continue;
      wanted.add(b.key);
      // Routes are recomputed when the settlement changes, so villagers
      // path around new buildings instead of walking through them.
      const signature = game.buildings.length;
      const existing = this.villagers.get(b.key);
      if (!existing || existing.signature !== signature) {
        const tiles = findRoute(game, b);
        const pts = tiles.map(([i, j]) => tileToScreen(i, j));
        // Final approach: align south of the door, then walk straight up
        // into it. The door is at the bottom centre of every sprite, so the
        // last segment is vertical and the villager never crosses a wall.
        const bp = tileToScreen(...b.tile);
        const approach = { x: bp.x, y: bp.y + 46 };
        const last = pts[pts.length - 1];
        if (!last || Math.hypot(last.x - approach.x, last.y - approach.y) > 4) pts.push(approach);
        pts.push({ x: bp.x, y: bp.y + 14 });
        const r = this.fxRand;
        // Each building's villager keeps one of the four Viking looks.
        let vhash = 0;
        for (const ch of b.key) vhash += ch.charCodeAt(0);
        this.villagers.set(b.key, {
          variant: existing ? existing.variant : ['villager_m_black', 'villager_m_blond', 'villager_f_black', 'villager_f_blond'][vhash % 4],
          pts, signature, s: existing ? existing.s : r.range(0, 0.3), dir: existing ? existing.dir : 1,
          pause: 0, inside: 0, x: pts[0].x, y: pts[0].y,
          tunic: existing ? existing.tunic : r.pick(['#a8432f', '#3e6fa8', '#6b8d2f', '#8a5aa8', '#c07a2a']),
          carry: b.produces, phase: existing ? existing.phase : r.range(0, 6),
        });
      }
    }
    for (const k of [...this.villagers.keys()]) if (!wanted.has(k)) this.villagers.delete(k);
    for (const v of this.villagers.values()) {
      const segs = v.pts.length - 1;
      // Inside the building: hidden at the doorway for a spell, then walks back out.
      if (v.inside > 0) { v.inside -= simDt; if (v.inside <= 0) v.dir = -1; continue; }
      if (v.pause > 0) { v.pause -= simDt; continue; }
      v.s += (v.dir * simDt * 0.55) / Math.max(1, segs);
      if (v.s >= 1) { v.s = 1; v.inside = 2.4; }
      if (v.s <= 0) { v.s = 0; v.dir = 1; v.pause = 1.5; }
      const f = v.s * segs;
      const n = Math.min(segs - 1, Math.floor(f));
      const t = f - n;
      // Progress along the final (door) segment, for the doorway fade.
      v.doorT = n === segs - 1 ? t : 0;
      const a = v.pts[n];
      const b = v.pts[n + 1] || a;
      // Walk along the road with a little sideways offset so two villagers don't overlap.
      v.x = a.x + (b.x - a.x) * t + (v.dir > 0 ? -5 : 5);
      v.y = a.y + (b.y - a.y) * t + (v.dir > 0 ? -2 : 2);
      v.facing = Math.sign(b.x - a.x) * v.dir || 1;
      v.moving = v.pause <= 0;
      v.carrying = v.dir < 0;
    }
  }

  updateSmoke(game, simDt) {
    for (const b of game.buildings) {
      // Smoke only where a fire belongs: home chimneys and the smelter forge.
      // The Town Center (main building) has no roof smoke.
      if (b.status !== 'done' || !['shelter', 'smelter', 'research_tent'].includes(b.type)) continue;
      const t = (this.smokeTimers.get(b.key) || 0) - simDt;
      if (t > 0) { this.smokeTimers.set(b.key, t); continue; }
      this.smokeTimers.set(b.key, 0.45);
      const pos = tileToScreen(...b.tile);
      const sprite = this.sprites[this.spriteKeyFor(game, b)];
      let sx = pos.x + 10;
      let sy = pos.y - 52;
      if (sprite && sprite.chimney) {
        sx = pos.x - sprite.anchor[0] * sprite.width + sprite.chimney[0] * sprite.width;
        sy = pos.y - sprite.anchor[1] * sprite.height + sprite.chimney[1] * sprite.height;
      }
      const r = this.fxRand;
      this.particles.push({ kind: 'smoke', x: sx, y: sy, vx: r.range(3, 9), vy: r.range(-16, -10), life: 3.2, age: 0, size: r.range(3, 5) });
    }
  }

  drawParticles(ctx, realDt) {
    const keep = [];
    for (const p of this.particles) {
      p.age += realDt;
      if (p.age >= p.life) continue;
      p.x += p.vx * realDt;
      p.y += p.vy * realDt;
      const k = p.age / p.life;
      if (p.kind === 'smoke') {
        circle(ctx, p.x, p.y, p.size + k * 9, `rgba(235,232,225,${0.45 * (1 - k)})`);
      } else if (p.kind === 'dust') {
        p.vy += 10 * realDt;
        circle(ctx, p.x, p.y, p.size * (0.6 + k), `rgba(196,170,128,${0.55 * (1 - k)})`);
      } else {
        p.vy += 90 * realDt;
        ctx.fillStyle = `hsla(${p.hue},95%,65%,${1 - k})`;
        ctx.fillRect(p.x, p.y, p.size, p.size);
      }
      keep.push(p);
    }
    this.particles = keep;
  }

  drawPopups(ctx, dt) {
    const keep = [];
    ctx.textAlign = 'center';
    ctx.font = 'bold 16px Georgia, "Palatino Linotype", serif';
    for (const p of this.popups) {
      const k = (this.time - p.born) / 1.5;
      if (k >= 1) continue;
      const y = p.y - 34 * k;
      ctx.globalAlpha = k < 0.75 ? 1 : 1 - (k - 0.75) / 0.25;
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(30,18,8,0.9)';
      ctx.strokeText(p.text, p.x, y);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, p.x, y);
      ctx.globalAlpha = 1;
      keep.push(p);
    }
    this.popups = keep;

    // Curved Bezier fly-to-HUD resource arcs
    const keepIcons = [];
    for (const fi of (this.flyingIcons || [])) {
      if (this.time < fi.born) {
        keepIcons.push(fi);
        continue;
      }
      const t = (this.time - fi.born) / fi.duration;
      if (t >= 1) continue;
      const oneMinusT = 1 - t;
      const px = oneMinusT * oneMinusT * fi.sx + 2 * oneMinusT * t * fi.cx + t * t * fi.tx;
      const py = oneMinusT * oneMinusT * fi.sy + 2 * oneMinusT * t * fi.cy + t * t * fi.ty;
      ctx.save();
      ctx.globalAlpha = t < 0.75 ? 1 : (1 - t) / 0.25;
      ctx.font = '16px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(fi.icon, px, py);
      ctx.restore();
      keepIcons.push(fi);
    }
    this.flyingIcons = keepIcons;
  }

  // ------------------------------------------------------------ targets
  // Clickable world objects in canvas (= #game-root) pixels.
  worldTargets(game) {
    if (game.battleState && game.battleState.active) return this.battleTargets(game);
    const out = [];
    for (const b of game.buildings) {
      const { x, y } = tileToScreen(...b.tile);
      const big = b.type === 'town_center';
      const w = big ? 104 : 72;
      const h = big ? 96 : 76;
      out.push({ target_id: `building_${b.key}`, kind: 'building', x: x - w / 2, y: y - h + 14, w, h,
                 ready: !!b.ready, building_type: b.type, level: b.level || 1,
                 staffed: b.produces ? !!b.worker : undefined });
      out.push(...this.chipsFor(game, b));
    }
    const pads = game.activePads ? game.activePads() : PADS;
    for (const p of pads) {
      if (game.buildingAt(p.id)) continue;
      const { x, y } = tileToScreen(...p.tile);
      out.push({ target_id: p.id, kind: 'pad', x: x - TILE_W / 2, y: y - TILE_H / 2, w: TILE_W, h: TILE_H });
    }
    if (game.pendingPlacement) {
      const { x, y } = tileToScreen(...game.pendingPlacement.tile);
      out.push({ target_id: 'btn_cancel_placement', kind: 'placement', x: x - 52, y: y + 18, w: 34, h: 34, affordable: true });
      out.push({ target_id: 'btn_confirm_placement', kind: 'placement', x: x + 18, y: y + 18, w: 34, h: 34, affordable: true });
    }
    return out;
  }

  // World hit test. While a build card is selected the highlighted plots win
  // (placement mode); otherwise ready buildings and front-most objects win.
  hitTest(game, x, y) {
    const targets = this.worldTargets(game);
    if (game.battleState && game.battleState.active) {
      return targets.find((t) => inRect(t, x, y)) || null;
    }
    const pad = targets.find((t) => t.kind === 'pad'
      && Math.abs(x - (t.x + t.w / 2)) / (TILE_W / 2) + Math.abs(y - (t.y + t.h / 2)) / (TILE_H / 2) <= 1);
    const chip = targets.find((t) => (t.kind === 'upgrade' || t.kind === 'worker' || t.kind === 'free_finish' || t.kind === 'expansion' || t.kind === 'placement') && inRect(t, x, y));
    if (chip) return chip;
    // Placement mode: the tile wins. Building sprites are tall and overlap
    // the tiles below them; without this, the tile under a ready farm could
    // never be picked (the click harvested instead of placing).
    if (pad && game.selectedCard) return pad;
    // The floating harvest bubble sits above the building box; clicking it harvests.
    const bubble = targets.find((t) => t.kind === 'building' && t.ready
      && Math.hypot(x - (t.x + t.w / 2), y - (t.y + t.h - 14 - 78)) <= 20);
    if (bubble) return bubble;
    const readyBuilding = targets.find((t) => t.kind === 'building' && t.ready && inRect(t, x, y));
    if (readyBuilding) return readyBuilding;
    const buildings = targets.filter((t) => t.kind === 'building' && inRect(t, x, y))
      .sort((a, b) => (b.ready - a.ready) || (b.y + b.h) - (a.y + a.h));
    return buildings[0] || pad || null;
  }

  // ------------------------------------------------------------ battle arena
  // Fixed unit slots: heroes left, enemies right. Units stand still.
  // HoMM3 hex field: flat-top hexagons in odd-r offset. Tiles must tile
  // without overlap: horizontal step is 3/4 of the hex width, vertical
  // step is the full hex height, odd rows shifted by half a step.
  battleHexCenter(gx, gy) {
    // The field starts below the battle HUD so no figure can leave the top
    // of the screen, and ends with room for the bars below the feet.
    return { x: 66 + gx * 56 + (gy % 2 ? 28 : 0), y: 188 + gy * 39 };
  }

  battleUnitPos(unit) {
    const c = this.battleHexCenter(unit.gx ?? 1, unit.gy ?? 3);
    return { x: c.x, y: c.y + 16 };
  }

  battleTargets(game) {
    const bs = game.battleState;
    if (!bs || !bs.active) return [];
    const out = [];
    (bs.units || []).forEach((u) => {
      if (!u.alive) return;
      const p = this.battleUnitPos(u);
      out.push({ target_id: `unit_hero_${u.id}`, kind: 'battle_hero', x: p.x - 48, y: p.y - 120, w: 96, h: 132, affordable: !!u.activeTurn });
    });
    (bs.enemies || []).forEach((e) => {
      if (!e.alive) return;
      const p = this.battleUnitPos(e);
      out.push({ target_id: `unit_enemy_${e.idx}`, kind: 'battle_enemy', x: p.x - 48, y: p.y - 120, w: 96, h: 132, affordable: true });
    });
    // Glowing hexes the active hero can still reach this turn.
    if (game.battleReachableTiles) {
      for (const t of game.battleReachableTiles()) {
        const c = this.battleHexCenter(t.gx, t.gy);
        out.push({ target_id: `battle_hex_${t.gx}_${t.gy}`, kind: 'battle_hex', x: c.x - 33, y: c.y - 21, w: 66, h: 42, affordable: true });
      }
    }
    return out;
  }

  renderBattleArena(ctx, game, dt) {
    const bs = game.battleState || game.battle || game.battleArena;
    if (!bs) return;

    // 1. Background (arena image or canyon/megalith fallback)
    if (this.sprites.battle_arena_bg?.img) {
      ctx.drawImage(this.sprites.battle_arena_bg.img, 0, 0, VIEW_W, VIEW_H);
    } else {
      const bgGrad = ctx.createLinearGradient(0, 0, 0, VIEW_H);
      bgGrad.addColorStop(0, '#4a2416');
      bgGrad.addColorStop(0.35, '#7c3b22');
      bgGrad.addColorStop(0.7, '#965b32');
      bgGrad.addColorStop(1, '#532e16');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);

      // Distant canyon cliffs & ancient megaliths
      ctx.fillStyle = '#3d2015';
      const pillars = [
        { x: 110, y: 130, w: 52, h: 180 },
        { x: 200, y: 160, w: 42, h: 130 },
        { x: 740, y: 150, w: 46, h: 150 },
        { x: 825, y: 120, w: 58, h: 190 },
      ];
      for (const p of pillars) {
        roundRect(ctx, p.x, p.y, p.w, p.h, 6, '#3d2015');
      }

      // Arena dirt floor oval
      ctx.fillStyle = '#6e4125';
      ctx.beginPath();
      ctx.ellipse(480, 370, 430, 135, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#8a5530';
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    // No canvas banner here: the HTML battle top bar already shows the
    // stage name and wave, and drawing both put one menu behind the other.

    // HoMM3 hex grid: every tile outlined, rock hexes blocked, and the
    // active hero's reachable hexes glowing gold.
    const hexPath = (cx, cy) => {
      ctx.beginPath();
      const pts = [[-37, 0], [-18, -23], [18, -23], [37, 0], [18, 23], [-18, 23]];
      pts.forEach(([dx, dy], i) => (i ? ctx.lineTo(cx + dx, cy + dy) : ctx.moveTo(cx + dx, cy + dy)));
      ctx.closePath();
    };
    const reachable = game.battleReachableTiles ? game.battleReachableTiles() : [];
    const reachSet = new Set(reachable.map((t) => `${t.gx},${t.gy}`));
    for (let gx = 0; gx < BATTLE_COLS; gx++) {
      for (let gy = 0; gy < BATTLE_ROWS; gy++) {
        const c = this.battleHexCenter(gx, gy);
        const blocked = BATTLE_BLOCKED.some(([x, y]) => x === gx && y === gy);
        hexPath(c.x, c.y);
        if (blocked) {
          // Blocked rock hex: drawn as nothing. The painting already shows
          // the rocks; no dark rhomb on top of it.
        } else if (reachSet.has(`${gx},${gy}`)) {
          // Reachable hexes glow white only: no yellow checkerboard.
          ctx.fillStyle = `rgba(255,255,255,${0.10 + 0.03 * Math.sin(this.time * 5)})`;
          ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,0.45)';
          ctx.lineWidth = 1;
          ctx.stroke();
        } else {
          // Every hex on the field stays barely visible, so the player can
          // always see where a move could go. Dark edges read on light dirt
          // where a white line would vanish.
          ctx.fillStyle = 'rgba(255,255,255,0.04)';
          ctx.fill();
          ctx.strokeStyle = 'rgba(74,45,16,0.30)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
    }
    // Turn-based units on their hexes: no marching, no bobbing. A gold ring
    // marks the picked hero; a dimmed unit has already acted this round.
    const drawUnit = (u, p, spriteKey, accent) => {
      ctx.save();
      if (!u.alive) ctx.globalAlpha = 0.8;
      else if (u.acted) ctx.globalAlpha = 0.85;
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath();
      ctx.ellipse(p.x, p.y + 8, 34, 11, 0, 0, Math.PI * 2);
      ctx.fill();
      // Enemies get a rust-red base ring so they read at a glance.
      if (u.kind === 'enemy') {
        ctx.strokeStyle = 'rgba(178,52,32,0.9)';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y + 8, 38, 13, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (bs.selectedUnit && u.id === bs.selectedUnit) {
        ctx.strokeStyle = '#ffd75e';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y + 8, 40, 14, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      const spr = this.sprites[spriteKey];
      if (spr?.img) {
        // Cap the drawn height so tall sprites never leave the screen.
        const drawH = Math.min(spr.height, 100);
        const drawW = spr.width * (drawH / spr.height);
        if (!u.alive) {
          // The fallen stay on the field, tipped over, instead of vanishing.
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(-Math.PI / 2.2);
          ctx.drawImage(spr.img, -drawW / 2, -drawH * 0.35, drawW, drawH);
          ctx.restore();
        } else {
          ctx.drawImage(spr.img, p.x - spr.anchor[0] * drawW, p.y - spr.anchor[1] * drawH, drawW, drawH);
        }
      } else {
        circle(ctx, p.x, p.y - 24, 20, accent);
      }
      ctx.restore();
      // Compact health bar below the feet; names and exact numbers live in
      // the inspection strip, not over heads. The active unit gets its name.
      const pct = Math.max(0, Math.min(1, u.hp / (u.maxHp || 1)));
      roundRect(ctx, p.x - 30, p.y + 14, 60, 6, 3, 'rgba(15,12,10,0.75)');
      roundRect(ctx, p.x - 29, p.y + 15, 58 * pct, 4, 2, u.kind === 'hero' ? '#22c55e' : '#ef4444');
      if (u.activeTurn || (bs.selectedUnit && u.id === bs.selectedUnit)) {
        ctx.fillStyle = '#fff4c2';
        ctx.font = 'bold 10px Georgia, serif';
        ctx.textAlign = 'center';
        ctx.fillText(u.kind === 'hero' ? u.name.split(' ')[0] : u.name, p.x, p.y + 32);
      }
      if (u.kind === 'hero' && u.alive) {
        roundRect(ctx, p.x - 30, p.y + 22, 60, 4, 2, 'rgba(15,12,10,0.75)');
        roundRect(ctx, p.x - 29, p.y + 23, 58 * Math.min(1, (u.rage || 0) / 100), 2, 1,
          (u.rage || 0) >= 100 ? '#ffd700' : '#f97316');
      }
    };
    (bs.units || []).forEach((u) => drawUnit(u, this.battleUnitPos(u), `hero_${u.id}`, '#d97706'));
    (bs.enemies || []).forEach((e) => drawUnit(e, this.battleUnitPos(e),
      (e.sprite && this.sprites[e.sprite]?.img) ? e.sprite
        : (e.name === 'Warlord' || e.role === 'boss' ? 'enemy_viking_boss' : 'enemy_viking'), '#991b1b'));


    // 4. Dramatic diagonal comic-book slash banner if bs.cutIn is active
    if (bs.cutIn) {
      ctx.save();
      // Dramatic diagonal comic-book slash banner across the canvas
      ctx.fillStyle = 'rgba(15, 10, 10, 0.90)';
      ctx.beginPath();
      ctx.moveTo(0, 175);
      ctx.lineTo(VIEW_W, 105);
      ctx.lineTo(VIEW_W, 265);
      ctx.lineTo(0, 335);
      ctx.closePath();
      ctx.fill();

      // Bold golden border accents
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(0, 175); ctx.lineTo(VIEW_W, 105);
      ctx.moveTo(0, 335); ctx.lineTo(VIEW_W, 265);
      ctx.stroke();

      // Hero portrait in circular frame
      const pSprite = this.sprites[bs.cutIn.portrait];
      if (pSprite?.img) {
        const pw = 140;
        const ph = 140;
        ctx.save();
        ctx.beginPath();
        ctx.arc(215, 235, 60, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(pSprite.img, 215 - pw / 2, 235 - ph / 2, pw, ph);
        ctx.restore();
        ctx.strokeStyle = '#ffd700';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(215, 235, 60, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Hero name & bold golden ultimate attack text
      ctx.fillStyle = '#fef08a';
      ctx.font = 'bold 15px Georgia, serif';
      ctx.textAlign = 'left';
      ctx.fillText(bs.cutIn.name?.toUpperCase() || 'HERO', 310, 210);

      ctx.save();
      ctx.shadowColor = '#f59e0b';
      ctx.shadowBlur = 18;
      ctx.fillStyle = '#ffd700';
      ctx.font = '900 28px Georgia, Impact, sans-serif';
      ctx.fillText(bs.cutIn.ult || 'ULTIMATE SMASH!', 310, 252);
      ctx.restore();

      ctx.restore();
    }

    // Battle particles and popups
    this.drawParticles(ctx, dt);
    this.drawPopups(ctx, dt);
  }
}

function drawVillager(ctx, v, time, img, imgB) {
  if (v.inside > 0) return; // inside the building, out of sight
  const step = v.moving ? Math.sin(time * 10 + v.phase) : 0;
  // Two-frame walk: swap to the opposite-leg pose on the other half-step.
  if (img && imgB && v.moving && step < 0) img = imgB;
  const { x, y } = v;
  // Fade only while crossing the doorstep (last steps of the final
  // segment), so the villager slips through the door, not through a wall.
  ctx.save();
  if ((v.doorT || 0) > 0.6) ctx.globalAlpha = Math.max(0.1, 1 - (v.doorT - 0.6) / 0.4);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(x, y + 1, 5, 2, 0, 0, Math.PI * 2);
  ctx.fill();
  if (img) {
    // Painted villager sprite (Muse Image): bob while walking, face the
    // way he walks, feet on the ground point.
    const h = 30;
    const w = h * (img.naturalWidth / img.naturalHeight);
    const bob = v.moving ? Math.abs(step) * 1.6 : 0;
    ctx.translate(x, y + 1 - bob);
    if ((v.facing || 1) < 0) ctx.scale(-1, 1);
    ctx.drawImage(img, -w / 2, -h, w, h);
    ctx.restore();
    return;
  }
  ctx.strokeStyle = '#3b2a1c';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(x - 1, y - 6);
  ctx.lineTo(x - 1 - step * 2, y);
  ctx.moveTo(x + 1, y - 6);
  ctx.lineTo(x + 1 + step * 2, y);
  ctx.stroke();
  roundRect(ctx, x - 3, y - 13 - Math.abs(step), 6, 8, 2, v.tunic);
  circle(ctx, x, y - 16 - Math.abs(step), 2.8, '#e7b98b');
  ctx.fillStyle = '#4a2f1a';
  ctx.fillRect(x - 2.8, y - 19 - Math.abs(step), 5.6, 1.8);
  if (v.carrying && v.carry && RESOURCE_ICON[v.carry]) {
    ctx.font = '9px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(RESOURCE_ICON[v.carry], x + 5 * v.facing, y - 15 - Math.abs(step));
  }
  ctx.restore();
}

function drawProceduralBuilding(ctx, type, pos, scale = 1) {
  const st = FALLBACK_STYLE[type] || FALLBACK_STYLE.shelter;
  const w = st.w * scale;
  const d = st.d * scale;
  const h = st.h * scale;
  const { x, y } = pos;
  ctx.fillStyle = 'rgba(30,20,10,0.25)';
  ctx.beginPath();
  ctx.ellipse(x + 6, y + 4, w * 0.9, d * 0.42, 0, 0, Math.PI * 2);
  ctx.fill();
  // Stone foundation.
  isoBox(ctx, x, y, w + 6, d + 6, 5, '#8a8170', '#6f6758', '#a49b88');
  // Walls.
  isoBox(ctx, x, y - 5, w, d, h, shade(st.wall, -18), shade(st.wall, -34), st.wall);
  // Timber framing on the front faces.
  ctx.strokeStyle = 'rgba(70,40,20,0.7)';
  ctx.lineWidth = 1.5;
  const base = y - 5;
  for (const f of [0.33, 0.66]) {
    ctx.beginPath();
    ctx.moveTo(x - w / 2 + (w / 2) * f, base + (d / 4) * f - d / 4 + d / 4);
    ctx.lineTo(x - w / 2 + (w / 2) * f, base + (d / 4) * f - h);
    ctx.stroke();
  }
  // Pitched roof.
  const top = y - 5 - h;
  ctx.fillStyle = shade(st.roof, -20);
  ctx.beginPath();
  ctx.moveTo(x - w / 2 - 3, top);
  ctx.lineTo(x, top + d / 4 + 3);
  ctx.lineTo(x, top - st.roofH * scale + d / 4);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = st.roof;
  ctx.beginPath();
  ctx.moveTo(x, top + d / 4 + 3);
  ctx.lineTo(x + w / 2 + 3, top);
  ctx.lineTo(x, top - st.roofH * scale - d / 4);
  ctx.lineTo(x, top - st.roofH * scale + d / 4);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = shade(st.roof, 18);
  ctx.beginPath();
  ctx.moveTo(x - w / 2 - 3, top);
  ctx.lineTo(x, top - d / 4 - 3);
  ctx.lineTo(x, top - st.roofH * scale - d / 4);
  ctx.lineTo(x, top - st.roofH * scale + d / 4);
  ctx.closePath();
  ctx.fill();
}

// ---------------------------------------------------------------- helpers
function isoBox(ctx, x, y, w, d, h, left, right, topColor) {
  const hw = w / 2;
  const hd = d / 4;
  ctx.fillStyle = left;
  ctx.beginPath();
  ctx.moveTo(x - hw, y - h);
  ctx.lineTo(x, y + hd - h);
  ctx.lineTo(x, y + hd);
  ctx.lineTo(x - hw, y);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = right;
  ctx.beginPath();
  ctx.moveTo(x + hw, y - h);
  ctx.lineTo(x, y + hd - h);
  ctx.lineTo(x, y + hd);
  ctx.lineTo(x + hw, y);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = topColor;
  ctx.beginPath();
  ctx.moveTo(x, y - hd - h);
  ctx.lineTo(x + hw, y - h);
  ctx.lineTo(x, y + hd - h);
  ctx.lineTo(x - hw, y - h);
  ctx.closePath();
  ctx.fill();
}

function sideFace(ctx, x, y, side, light, dark) {
  const depth = 14;
  ctx.fillStyle = side > 0 ? dark : light;
  ctx.beginPath();
  if (side > 0) {
    ctx.moveTo(x + TILE_W / 2, y);
    ctx.lineTo(x, y + TILE_H / 2);
    ctx.lineTo(x, y + TILE_H / 2 + depth);
    ctx.lineTo(x + TILE_W / 2, y + depth);
  } else {
    ctx.moveTo(x - TILE_W / 2, y);
    ctx.lineTo(x, y + TILE_H / 2);
    ctx.lineTo(x, y + TILE_H / 2 + depth);
    ctx.lineTo(x - TILE_W / 2, y + depth);
  }
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(40,25,10,0.25)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function diamondPath(ctx, x, y, w, h) {
  ctx.beginPath();
  ctx.moveTo(x, y - h / 2);
  ctx.lineTo(x + w / 2, y);
  ctx.lineTo(x, y + h / 2);
  ctx.lineTo(x - w / 2, y);
  ctx.closePath();
}

function diamond(ctx, x, y, w, h, color) {
  diamondPath(ctx, x, y, w, h);
  ctx.fillStyle = color;
  ctx.fill();
}

function circle(ctx, x, y, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0, r), 0, Math.PI * 2);
  ctx.fill();
}

function roundRect(ctx, x, y, w, h, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x, y, Math.max(0, w), h, r);
  ctx.fill();
}

function inRect(t, x, y) {
  return x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h;
}

// Lighten (amt > 0) or darken a #rrggbb colour by amt in 0..255 units.
export function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, Math.round(v + amt)));
  const r = c((n >> 16) & 255);
  const g = c((n >> 8) & 255);
  const b = c(n & 255);
  return `rgb(${r},${g},${b})`;
}
