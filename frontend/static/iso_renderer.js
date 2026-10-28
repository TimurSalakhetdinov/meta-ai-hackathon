// 2.5D isometric renderer for the settlement.
// Draws a 12x12 diamond island (painter's algorithm), animated sea and SW
// shoreline, forest, stone outcrops, dirt roads, building pads, buildings
// (PNG sprites with a procedural fallback), construction scaffolding, walking
// villagers, chimney smoke and floating popups. Gameplay state is read from a
// Game instance; this module never changes it.

import { mulberry32, rngTools } from './clock.js';

export const TILE_W = 64;
export const TILE_H = 32;
export const GRID = 12;
export const ORIGIN = { x: 480, y: 76 };
export const VIEW_W = 960;
export const VIEW_H = 540;

export function tileToScreen(i, j) {
  return { x: ORIGIN.x + (i - j) * (TILE_W / 2), y: ORIGIN.y + (i + j) * (TILE_H / 2) };
}

// Fixed settlement layout. Pads are where the player can build.
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
  { id: 'pad_8', tile: [9, 0] },
];

export const EXPANSION_PADS = {
  exp_1: [{ id: 'pad_9', tile: [2, 5] }, { id: 'pad_10', tile: [2, 8] }],
  exp_2: [{ id: 'pad_11', tile: [9, 3] }, { id: 'pad_12', tile: [9, 6] }],
};

const isWater = (i, j) => false;
const isForest = (i, j) => i + j <= 3;
const isStony = (i, j) => i >= 10 && j <= 4;
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
          g.globalAlpha = ROAD.has(key(i, j)) ? 0.88 : 0.22;
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
    // Dirt roads.
    g.save();
    if (hasBackdrop) g.globalAlpha = 0.88;
    for (const k of ROAD) {
      const [i, j] = k.split(',').map(Number);
      const { x, y } = tileToScreen(i, j);
      diamond(g, x, y, TILE_W * 0.82, TILE_H * 0.82, shade('#b48a5a', r.range(-8, 8)));
      g.fillStyle = 'rgba(90,60,30,0.30)';
      for (let n = 0; n < 6; n++) g.fillRect(x + r.range(-16, 16), y + r.range(-5, 5), 2, 2);
    }
    g.restore();
    // Plaza under the Town Center and the tent.
    for (const [i, j] of [TOWN_CENTER_TILE, RESEARCH_TENT_TILE]) {
      const { x, y } = tileToScreen(i, j);
      diamond(g, x, y, TILE_W * 1.5, TILE_H * 1.5, '#c2a173');
      diamond(g, x, y, TILE_W * 1.3, TILE_H * 1.3, '#cfb084');
    }
    // Pad plots: stone rim with packed earth.
    PADS.forEach((p, idx) => {
      const { x, y } = tileToScreen(...p.tile);
      diamond(g, x, y, TILE_W * 0.96, TILE_H * 0.96, '#8d7f6b');
      diamond(g, x, y, TILE_W * 0.82, TILE_H * 0.82, '#c7a878');
      g.fillStyle = 'rgba(70,50,30,0.25)';
      for (let n = 0; n < 8; n++) {
        const a = (n / 8) * Math.PI * 2;
        g.fillRect(x + Math.cos(a) * 28 - 1, y + Math.sin(a) * 14 - 1, 3, 2);
      }
      g.font = 'bold 10px Georgia, serif';
      g.textAlign = 'center';
      g.fillStyle = 'rgba(70,45,20,0.55)';
      g.fillText(String(idx + 1), x, y + 4);
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
    for (const v of this.villagers.values()) items.push({ y: v.y, draw: () => drawVillager(ctx, v, this.time) });
    items.sort((a, b) => a.y - b.y);
    for (const it of items) it.draw();

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

    // 3 drifting translucent cloud shadows (rgba(15, 35, 18, 0.09))
    for (let c = 0; c < 3; c++) {
      const cx = ((this.time * 14 + c * 350) % 1250) - 150;
      const cy = 110 + c * 135 + Math.sin(c * 2) * 25;
      ctx.fillStyle = 'rgba(15, 35, 18, 0.09)';
      ctx.beginPath();
      ctx.ellipse(cx, cy, 95, 45, 0.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // 4 grazing white sheep near the meadow edges
    const sheepPos = [
      { x: 120, y: 375 },
      { x: 148, y: 395 },
      { x: 835, y: 190 },
      { x: 865, y: 215 },
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
    if (game.selectedCard === 'tribal_monument') {
      const pads = game.activePads ? game.activePads() : PADS;
      for (const p of pads) {
        if (!game.buildingAt(p.id)) {
          monumentTiles.push(p.tile);
        }
      }
    }
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
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 5);
    const pads = game.activePads ? game.activePads() : PADS;
    for (const p of pads) {
      if (game.buildingAt(p.id)) continue;
      const { x, y } = tileToScreen(...p.tile);
      ctx.save();
      ctx.shadowColor = '#ffd75e';
      ctx.shadowBlur = 10 + pulse * 10;
      ctx.strokeStyle = `rgba(255,215,94,${0.6 + 0.4 * pulse})`;
      ctx.lineWidth = 3;
      diamondPath(ctx, x, y, TILE_W * 0.96, TILE_H * 0.96);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = `rgba(255,236,160,${0.18 + 0.15 * pulse})`;
      diamondPath(ctx, x, y, TILE_W * 0.82, TILE_H * 0.82);
      ctx.fill();
      ctx.fillStyle = '#fff6d0';
      ctx.font = 'bold 18px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.fillText('+', x, y + 6);
    }
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
    } else {
      drawProceduralBuilding(ctx, spriteKey, pos, scale);
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
      ctx.font = '17px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#000';
      ctx.fillText(RESOURCE_ICON[b.produces], x, top + bob + 1);
      ctx.textBaseline = 'alphabetic';
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

  // Level badge plus the small upgrade and worker chips under a building.
  drawBadges(ctx, game, b) {
    const { x, y } = tileToScreen(...b.tile);
    if ((b.level || 1) > 1) {
      roundRect(ctx, x + 14, y - 62, 34, 16, 8, '#f0c24b');
      ctx.strokeStyle = '#7a5410';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x + 14.5, y - 61.5, 33, 15);
      ctx.fillStyle = '#3d2706';
      ctx.font = 'bold 10px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.fillText(`Lv.${b.level}`, x + 31, y - 50);
    }
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
    if (b.status !== 'done' || !b.key.startsWith('pad_')) return [];
    const out = [];
    if (b.produces && game.workersPerBuilding > 0) {
      out.push({ target_id: `worker_${b.key}`, kind: 'worker', x: x - 34, y: y + 2, w: CHIP, h: CHIP,
                 staffed: !!b.worker, building_type: b.type });
    }
    const up = game.upgradeStatus(b);
    if (up.available) {
      out.push({ target_id: `upgrade_${b.key}`, kind: 'upgrade', x: x + 16, y: y + 2, w: CHIP, h: CHIP,
                 level: up.level, affordable: !!up.affordable, building_type: b.type });
    }
    return out;
  }

  updateVillagers(game, simDt) {
    const wanted = new Set();
    for (const b of game.buildings) {
      if (b.status !== 'done' || !b.worker || !ROUTES[b.routeKey]) continue;
      wanted.add(b.key);
      if (!this.villagers.has(b.key)) {
        const pts = ROUTES[b.routeKey].map(([i, j]) => tileToScreen(i, j));
        const r = this.fxRand;
        this.villagers.set(b.key, {
          pts, s: r.range(0, 0.3), dir: 1, pause: 0, x: pts[0].x, y: pts[0].y,
          tunic: r.pick(['#a8432f', '#3e6fa8', '#6b8d2f', '#8a5aa8', '#c07a2a']),
          carry: b.produces, phase: r.range(0, 6),
        });
      }
    }
    for (const k of [...this.villagers.keys()]) if (!wanted.has(k)) this.villagers.delete(k);
    for (const v of this.villagers.values()) {
      const segs = v.pts.length - 1;
      if (v.pause > 0) { v.pause -= simDt; continue; }
      v.s += (v.dir * simDt * 0.55) / Math.max(1, segs);
      if (v.s >= 1) { v.s = 1; v.dir = -1; v.pause = 1.2; }
      if (v.s <= 0) { v.s = 0; v.dir = 1; v.pause = 1.5; }
      const f = v.s * segs;
      const n = Math.min(segs - 1, Math.floor(f));
      const t = f - n;
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
      if (b.status !== 'done' || !['shelter', 'town_center'].includes(b.type)) continue;
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
      } else if (b.type === 'town_center') {
        sx = pos.x + 22;
        sy = pos.y - 86;
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
    if (game.battleState && game.battleState.active) return [];
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
    return out;
  }

  // World hit test. While a build card is selected the highlighted plots win
  // (placement mode); otherwise ready buildings and front-most objects win.
  hitTest(game, x, y) {
    const targets = this.worldTargets(game);
    const pad = targets.find((t) => t.kind === 'pad'
      && Math.abs(x - (t.x + t.w / 2)) / (TILE_W / 2) + Math.abs(y - (t.y + t.h / 2)) / (TILE_H / 2) <= 1);
    if (pad && game.selectedCard) return pad;
    const chip = targets.find((t) => (t.kind === 'upgrade' || t.kind === 'worker' || t.kind === 'free_finish' || t.kind === 'expansion') && inRect(t, x, y));
    if (chip) return chip;
    // The floating harvest bubble sits above the building box; clicking it harvests.
    const bubble = targets.find((t) => t.kind === 'building' && t.ready
      && Math.hypot(x - (t.x + t.w / 2), y - (t.y + t.h - 14 - 78)) <= 20);
    if (bubble) return bubble;
    const buildings = targets.filter((t) => t.kind === 'building' && inRect(t, x, y))
      .sort((a, b) => (b.ready - a.ready) || (b.y + b.h) - (a.y + a.h));
    return buildings[0] || pad || null;
  }

  // ------------------------------------------------------------ battle arena
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

    // Overhead Banner: Stage Name and Wave
    const stageTitle = bs.stage?.name || `Stage ${bs.stageId || 1}`;
    roundRect(ctx, VIEW_W / 2 - 150, 18, 300, 36, 18, 'rgba(20, 12, 8, 0.88)');
    ctx.strokeStyle = '#f0c24b';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(VIEW_W / 2 - 150, 18, 300, 36, 18);
    ctx.stroke();
    ctx.fillStyle = '#fff4c2';
    ctx.font = 'bold 14px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${stageTitle} · Wave ${bs.wave || 1}/${bs.totalWaves || 1}`, VIEW_W / 2, 36);
    ctx.textBaseline = 'alphabetic';

    // Animation cycles
    const attackCycle = (this.time * 3.2) % Math.PI;
    const alliedLunge = Math.sin(attackCycle) * 18;
    const enemyLunge = -Math.sin(attackCycle + 1.4) * 16;
    const bobV = Math.sin(this.time * 6) * 3;
    const bobL = Math.sin(this.time * 6 + 1.3) * 3;
    const bobE1 = Math.sin(this.time * 5.5 + 0.6) * 3;
    const bobE2 = Math.sin(this.time * 5.5 + 2.1) * 3;
    const auraPulse = 0.5 + 0.5 * Math.sin(this.time * 4.5);

    // 2. Allied Heroes (Left Side)
    // hero_vaelen at (250, 320)
    const vx = 250 + alliedLunge;
    const vy = 320 + bobV;
    // Golden aura ring
    ctx.save();
    ctx.strokeStyle = `rgba(245, 195, 75, ${0.45 + 0.35 * auraPulse})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(vx, 328, 36, 14, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // Vaelen Sprite
    const vSprite = this.sprites.hero_vaelen;
    if (vSprite?.img) {
      const w = vSprite.width;
      const h = vSprite.height;
      ctx.drawImage(vSprite.img, vx - vSprite.anchor[0] * w, vy - vSprite.anchor[1] * h, w, h);
    } else {
      circle(ctx, vx, vy - 24, 20, '#d97706');
    }

    // Overhead green HP bar for Vaelen / Allies
    const phpPct = Math.max(0, Math.min(1, bs.playerHp / (bs.playerMaxHp || 1)));
    roundRect(ctx, 160, 205, 150, 15, 7.5, 'rgba(15, 12, 10, 0.85)');
    roundRect(ctx, 162, 207, 146 * phpPct, 11, 5.5, '#22c55e');
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 9px Georgia, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${bs.playerHp} / ${bs.playerMaxHp} HP`, 235, 212.5);
    ctx.textBaseline = 'alphabetic';

    // Rage bar for Vaelen
    const vRagePct = Math.min(1, (bs.vaelenRage || 0) / 100);
    roundRect(ctx, 160, 224, 150, 6, 3, 'rgba(15, 12, 10, 0.85)');
    roundRect(ctx, 161, 225, 148 * vRagePct, 4, 2, vRagePct >= 1 ? '#ffd700' : '#f97316');

    // hero_lyra at (165, 345) if unlocked
    const lyraUnlocked = !!(game.heroes?.lyra?.unlocked);
    if (lyraUnlocked) {
      const lx = 165 + alliedLunge * 0.75;
      const ly = 345 + bobL;
      ctx.save();
      ctx.strokeStyle = `rgba(255, 235, 140, ${0.45 + 0.35 * auraPulse})`;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.ellipse(lx, 352, 30, 12, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      const lSprite = this.sprites.hero_lyra;
      if (lSprite?.img) {
        const w = lSprite.width;
        const h = lSprite.height;
        ctx.drawImage(lSprite.img, lx - lSprite.anchor[0] * w, ly - lSprite.anchor[1] * h, w, h);
      } else {
        circle(ctx, lx, ly - 20, 16, '#ec4899');
      }

      // Rage bar for Lyra
      const lRagePct = Math.min(1, (bs.lyraRage || 0) / 100);
      roundRect(ctx, 110, 240, 90, 5, 2.5, 'rgba(15, 12, 10, 0.85)');
      roundRect(ctx, 111, 241, 88 * lRagePct, 3, 1.5, lRagePct >= 1 ? '#ffd700' : '#a855f7');
    }

    // 3. Enemy Beasts (Right Side)
    // Overhead red HP bar for Enemies
    const ehpPct = Math.max(0, Math.min(1, bs.enemyHp / (bs.enemyMaxHp || 1)));
    roundRect(ctx, 650, 205, 160, 15, 7.5, 'rgba(15, 12, 10, 0.85)');
    roundRect(ctx, 652, 207, 156 * ehpPct, 11, 5.5, '#ef4444');
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 9px Georgia, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${bs.enemyHp} / ${bs.enemyMaxHp} HP`, 730, 212.5);
    ctx.textBaseline = 'alphabetic';

    const isBoss = bs.stageId === 'stage_8' || bs.stageId === 'stage_6';
    if (isBoss) {
      // boss_shadowclaw
      const bx = 710 + enemyLunge;
      const by = 300 + bobE1;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
      ctx.beginPath();
      ctx.ellipse(bx, 318, 52, 18, 0, 0, Math.PI * 2);
      ctx.fill();

      const bossSprite = this.sprites.boss_shadowclaw;
      if (bossSprite?.img) {
        const w = bossSprite.width;
        const h = bossSprite.height;
        ctx.drawImage(bossSprite.img, bx - bossSprite.anchor[0] * w, by - bossSprite.anchor[1] * h, w, h);
      } else {
        circle(ctx, bx, by - 32, 28, '#7c2d12');
      }
    }

    // Enemy beast pack wolves/boars at (670, 315) and (755, 350)
    const beastSprite = this.sprites.enemy_beast_pack;
    const beastPos = isBoss
      ? [{ x: 775 + enemyLunge, y: 350 + bobE2 }]
      : [{ x: 670 + enemyLunge, y: 315 + bobE1 }, { x: 755 + enemyLunge, y: 350 + bobE2 }];

    for (const bp of beastPos) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.beginPath();
      ctx.ellipse(bp.x, bp.y + 6, 28, 10, 0, 0, Math.PI * 2);
      ctx.fill();
      if (beastSprite?.img) {
        const w = beastSprite.width;
        const h = beastSprite.height;
        ctx.drawImage(beastSprite.img, bp.x - beastSprite.anchor[0] * w, bp.y - beastSprite.anchor[1] * h, w, h);
      } else {
        circle(ctx, bp.x, bp.y - 18, 18, '#991b1b');
      }
    }

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

function drawVillager(ctx, v, time) {
  const step = v.moving ? Math.sin(time * 10 + v.phase) : 0;
  const { x, y } = v;
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(x, y + 1, 5, 2, 0, 0, Math.PI * 2);
  ctx.fill();
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
