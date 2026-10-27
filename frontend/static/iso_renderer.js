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

const isWater = (i, j) => j >= 10;
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

export const ROUTES = Object.fromEntries([
  ...PADS.map((p) => [p.id, routeTiles(p.tile)]),
  ['research_tent', routeTiles(RESEARCH_TENT_TILE)],
]);

const ROAD = new Set();
for (const route of Object.values(ROUTES)) {
  for (const [i, j] of route.slice(1, -1)) ROAD.add(key(i, j));
}

const RESOURCE_ICON = { food: '\u{1F35E}', wood: '\u{1FAB5}', stone: '\u{1FAA8}', rp: '\u{1F4DC}' };

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
};

export class IsoRenderer {
  constructor(canvas, sprites, { seed = 42 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.sprites = sprites || {};
    this.seed = seed;
    const r = rngTools(mulberry32((seed ^ 0x5eed) >>> 0));
    this.decor = buildDecor(r);
    this.ground = this.renderGround(rngTools(mulberry32((seed ^ 0x9a55) >>> 0)));
    this.fxRand = rngTools(mulberry32((seed ^ 0xf00d) >>> 0));
    this.popups = [];
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
    // Cliff faces under the south-east and south-west land edges.
    for (let i = 0; i < GRID; i++) {
      for (let j = 0; j < GRID; j++) {
        if (isWater(i, j)) continue;
        const { x, y } = tileToScreen(i, j);
        if (i === GRID - 1) sideFace(g, x, y, +1, '#7a5a3a', '#5e4430');
        if (j === GRID - 1 || isWater(i, j + 1)) sideFace(g, x, y, -1, '#8b6a45', '#6b4f34');
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
      }
    }
    // Dirt roads.
    for (const k of ROAD) {
      const [i, j] = k.split(',').map(Number);
      const { x, y } = tileToScreen(i, j);
      diamond(g, x, y, TILE_W * 0.82, TILE_H * 0.82, shade('#b48a5a', r.range(-8, 8)));
      g.fillStyle = 'rgba(90,60,30,0.30)';
      for (let n = 0; n < 6; n++) g.fillRect(x + r.range(-16, 16), y + r.range(-5, 5), 2, 2);
    }
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
    this.drawSea(ctx);
    this.drawShallows(ctx);
    ctx.drawImage(this.ground, 0, 0);
    this.drawPadHighlights(ctx, game);

    const items = [];
    for (const t of this.decor.trees) items.push({ y: t.y, draw: () => drawTree(ctx, t, this.time) });
    for (const s of this.decor.rocks) items.push({ y: s.y, draw: () => drawRock(ctx, s) });
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
    this.drawPopups(ctx);
    ctx.restore();
  }

  get activeAnimations() {
    return this.popups.length + this.particles.filter((p) => p.kind !== 'smoke').length + this.bounces.size;
  }

  drawSea(ctx) {
    const grad = ctx.createLinearGradient(0, 0, 0, VIEW_H);
    grad.addColorStop(0, '#2c6f8f');
    grad.addColorStop(1, '#174a6b');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.strokeStyle = 'rgba(200,235,255,0.16)';
    ctx.lineWidth = 1.5;
    for (let row = 0; row < 18; row++) {
      const y0 = 20 + row * 30;
      for (let col = 0; col < 9; col++) {
        const x0 = ((col * 130 + row * 47 + this.time * 9) % 1100) - 60;
        const yy = y0 + Math.sin(this.time * 1.3 + col + row) * 3;
        ctx.beginPath();
        ctx.moveTo(x0, yy);
        ctx.quadraticCurveTo(x0 + 12, yy - 4, x0 + 24, yy);
        ctx.stroke();
      }
    }
  }

  // Shallow water tiles along the SW edge, with shimmer and moving foam on the shoreline.
  drawShallows(ctx) {
    for (let i = 0; i < GRID; i++) {
      for (let j = 10; j < GRID; j++) {
        const { x, y } = tileToScreen(i, j);
        const depth = j - 10;
        const wave = Math.sin(this.time * 1.6 + i * 0.7 + j * 1.1);
        diamond(ctx, x, y, TILE_W + 1, TILE_H + 1, depth === 0 ? shade('#4fa9c4', wave * 6) : shade('#3b8db0', wave * 5));
        ctx.fillStyle = `rgba(255,255,255,${0.10 + 0.08 * wave})`;
        ctx.fillRect(x - 10 + wave * 4, y - 2, 12, 1.5);
      }
    }
    // Foam line along the land edge (between j = 9 and j = 10).
    ctx.lineWidth = 2.5;
    for (let i = 0; i < GRID; i++) {
      const a = tileToScreen(i, 9.5);
      const b = tileToScreen(i + 1, 9.5);
      const ax = a.x - TILE_W / 2;
      const off = Math.sin(this.time * 2 + i * 0.9) * 2.2;
      ctx.strokeStyle = `rgba(255,255,255,${0.55 + 0.25 * Math.sin(this.time * 2.4 + i)})`;
      ctx.beginPath();
      ctx.moveTo(ax + off, a.y + off * 0.5 + 2);
      ctx.lineTo(b.x - TILE_W / 2 + off, b.y + off * 0.5 + 2);
      ctx.stroke();
    }
  }

  drawPadHighlights(ctx, game) {
    if (!game.selectedCard) return;
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 5);
    for (const p of PADS) {
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
    if (b.type === 'town_center' && game.era === 'stone_age') return 'town_center_stone_age';
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
  }

  // Production timers, ready icons and blocked badges above buildings.
  drawStatus(ctx, game, b) {
    if (b.status !== 'done' || !b.produces) return;
    const { x, y } = tileToScreen(...b.tile);
    const top = y - 78;
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

  drawPopups(ctx) {
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
  }

  // ------------------------------------------------------------ targets
  // Clickable world objects in canvas (= #game-root) pixels.
  worldTargets(game) {
    const out = [];
    for (const b of game.buildings) {
      const { x, y } = tileToScreen(...b.tile);
      const big = b.type === 'town_center';
      const w = big ? 104 : 72;
      const h = big ? 96 : 76;
      out.push({ target_id: `building_${b.key}`, kind: 'building', x: x - w / 2, y: y - h + 14, w, h,
                 ready: !!b.ready, building_type: b.type });
    }
    for (const p of PADS) {
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
    const buildings = targets.filter((t) => t.kind === 'building' && inRect(t, x, y))
      .sort((a, b) => (b.ready - a.ready) || (b.y + b.h) - (a.y + a.h));
    return buildings[0] || pad || null;
  }
}

// ------------------------------------------------------------------ decor
function buildDecor(r) {
  const blocked = new Set([...ROAD]);
  const reserve = ([i, j], radius) => {
    for (let di = -radius; di <= radius; di++) for (let dj = -radius; dj <= radius; dj++) blocked.add(key(i + di, j + dj));
  };
  reserve(TOWN_CENTER_TILE, 1);
  reserve(RESEARCH_TENT_TILE, 1);
  PADS.forEach((p) => reserve(p.tile, 1));
  const trees = [];
  const rocks = [];
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      if (isWater(i, j) || isWater(i, j + 1) || blocked.has(key(i, j))) continue;
      const { x, y } = tileToScreen(i, j);
      if (isStony(i, j)) {
        const n = r.int(1, 2);
        for (let k = 0; k < n; k++) rocks.push({ x: x + r.range(-14, 14), y: y + r.range(-5, 5), s: r.range(0.7, 1.25), tone: r.range(-10, 10) });
        continue;
      }
      const dense = isForest(i, j);
      const n = dense ? r.int(1, 3) : (r.chance(0.16) ? 1 : 0);
      for (let k = 0; k < n; k++) {
        trees.push({
          x: x + r.range(-16, 16), y: y + r.range(-6, 6), s: r.range(0.8, 1.2),
          pine: dense ? r.chance(0.7) : r.chance(0.35), tone: r.range(-14, 10), phase: r.range(0, 6),
        });
      }
    }
  }
  return { trees, rocks };
}

function drawTree(ctx, t, time) {
  const sway = Math.sin(time * 1.1 + t.phase) * 1.3;
  ctx.fillStyle = 'rgba(20,40,10,0.28)';
  ctx.beginPath();
  ctx.ellipse(t.x + 4, t.y + 2, 13 * t.s, 5 * t.s, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#6b4526';
  ctx.fillRect(t.x - 2 * t.s, t.y - 12 * t.s, 4 * t.s, 13 * t.s);
  if (t.pine) {
    const layers = [[0, 16, 14], [-9, 13, 12], [-17, 10, 10]];
    layers.forEach(([dy, half, hgt], n) => {
      const top = t.y - 10 * t.s + dy * t.s - hgt * t.s - n * 2;
      const sx = sway * (n + 1) * 0.5;
      ctx.fillStyle = shade('#2f6b34', t.tone - n * 4);
      ctx.beginPath();
      ctx.moveTo(t.x + sx, top - 4 * t.s);
      ctx.lineTo(t.x + half * t.s + sx * 0.5, t.y - 10 * t.s + dy * t.s);
      ctx.lineTo(t.x - half * t.s + sx * 0.5, t.y - 10 * t.s + dy * t.s);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(160,220,120,0.18)';
      ctx.beginPath();
      ctx.moveTo(t.x + sx, top - 4 * t.s);
      ctx.lineTo(t.x - half * t.s + sx * 0.5, t.y - 10 * t.s + dy * t.s);
      ctx.lineTo(t.x - half * 0.3 * t.s + sx * 0.5, t.y - 10 * t.s + dy * t.s);
      ctx.closePath();
      ctx.fill();
    });
  } else {
    const cy = t.y - 22 * t.s;
    const blobs = [[-7, 3, 10], [7, 3, 10], [0, -6, 12], [0, 4, 11]];
    for (const [dx, dy, rad] of blobs) circle(ctx, t.x + dx * t.s + sway, cy + dy * t.s, rad * t.s, shade('#4f8f3a', t.tone));
    circle(ctx, t.x - 4 * t.s + sway, cy - 8 * t.s, 6 * t.s, 'rgba(190,240,140,0.25)');
  }
}

function drawRock(ctx, s) {
  const { x, y } = s;
  const k = s.s;
  ctx.fillStyle = 'rgba(30,30,30,0.25)';
  ctx.beginPath();
  ctx.ellipse(x + 3, y + 2, 14 * k, 5 * k, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = shade('#8c8a86', s.tone);
  ctx.beginPath();
  ctx.moveTo(x - 13 * k, y);
  ctx.lineTo(x - 9 * k, y - 12 * k);
  ctx.lineTo(x + 1 * k, y - 17 * k);
  ctx.lineTo(x + 11 * k, y - 10 * k);
  ctx.lineTo(x + 13 * k, y);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = shade('#b9b6ae', s.tone);
  ctx.beginPath();
  ctx.moveTo(x - 9 * k, y - 12 * k);
  ctx.lineTo(x + 1 * k, y - 17 * k);
  ctx.lineTo(x + 3 * k, y - 8 * k);
  ctx.lineTo(x - 6 * k, y - 5 * k);
  ctx.closePath();
  ctx.fill();
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
  if (v.carrying && v.carry) {
    const color = { food: '#e0a03a', wood: '#8a5a2b', stone: '#a9a49c' }[v.carry] || '#ddd';
    roundRect(ctx, x + 2 * v.facing, y - 16 - Math.abs(step), 5, 4, 1, color);
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
