// 8-node Tech Tree modal. Nodes are buttons with data-target="tech_*"; clicks
// are routed through main.js like every other click in #game-root.

import { RESOURCE_LABEL, TECHS, TECH_ORDER } from './game.js';

// Five columns; each chain sits on one row so its arrows run straight.
// The era chain runs along the bottom row and Irrigation (a Bronze Age tech) is last.
// Nodes are wide enough that names and effects never clip.
const COL = [0, 178, 356, 534, 712];
const ROW = [0, 134, 268];
const NODE_POS = {
  tech_toolmaking: [COL[0], ROW[1]],
  tech_woodworking: [COL[1], ROW[0]],
  tech_baskets: [COL[1], ROW[1]],
  tech_masonry: [COL[1], ROW[2]],
  tech_construction: [COL[2], ROW[0]],
  tech_stone_age: [COL[2], ROW[2]],
  tech_bronze_age: [COL[3], ROW[2]],
  tech_irrigation: [COL[4], ROW[2]],
};
const NODE_W = 166;
const NODE_H = 118;
const TREE_W = COL[4] + NODE_W;
const TREE_H = ROW[2] + NODE_H;

// True if `req` is already implied by another requirement of `id` (e.g. Toolmaking -> Masonry -> Stone Age).
function implied(id, req) {
  const reaches = (from) => TECHS[from].requires.some((r) => r === req || reaches(r));
  return TECHS[id].requires.some((other) => other !== req && reaches(other));
}

export class TechTreeView {
  constructor(root, rpLabel) {
    this.root = root;
    this.rpLabel = rpLabel;
    this.signature = '';
  }

  update(game) {
    const res = game.roundedResources();
    this.rpLabel.textContent = `Research points: ${res.rp}  ·  Researched ${game.techs.size}/${TECH_ORDER.length}`;
    // Only the resources techs cost: passive coins tick every second, and rebuilding the
    // nodes under the pointer swallows clicks.
    const sig = JSON.stringify([res.food, res.wood, res.stone, res.rp, [...game.techs], this.flash?.until]);
    if (sig === this.signature) return;
    this.signature = sig;
    this.root.innerHTML = this.edgesSvg(game) + TECH_ORDER.map((id) => this.node(game, id)).join('');
  }

  // Shake a node the player could not afford and say what is missing.
  flashRejected(id, game) {
    const st = game.techStatus(id);
    const msg = !st.available
      ? (st.reason === 'too_early' ? 'The Bronze Age opens later in the game' : `Learn ${TECHS[st.requires].label} first`)
      : st.missing ? `Need ${st.missing.required} ${RESOURCE_LABEL[st.missing.resource]} · have ${Math.floor(st.missing.available)}` : '';
    this.flash = { id, msg, until: performance.now() + 2500 };
    this.signature = '';
    this.update(game);
    setTimeout(() => { this.signature = ''; }, 2600);
  }

  // Right-angled arrows through the middle of the column gap; implied edges are left out.
  edgesSvg(game) {
    const lines = [];
    for (const id of TECH_ORDER) {
      for (const req of TECHS[id].requires) {
        if (implied(id, req)) continue;
        const [ax, ay] = NODE_POS[req];
        const [bx, by] = NODE_POS[id];
        const x1 = ax + NODE_W;
        const y1 = ay + NODE_H / 2;
        const x2 = bx - 3;
        const y2 = by + NODE_H / 2;
        const mx = Math.round((x1 + x2) / 2);
        const r = Math.min(10, Math.abs(y2 - y1) / 2);
        const dy = Math.sign(y2 - y1);
        const d = dy === 0 ? `M${x1} ${y1} H${x2}`
          : `M${x1} ${y1} H${mx - r} Q${mx} ${y1} ${mx} ${y1 + dy * r} V${y2 - dy * r} Q${mx} ${y2} ${mx + r} ${y2} H${x2}`;
        const done = game.techs.has(req);
        lines.push(`<path d="${d}" fill="none" stroke="${done ? '#5f9a3a' : '#a07a3c'}" stroke-width="3"
          stroke-linejoin="round" stroke-dasharray="${done ? '' : '7 5'}" marker-end="url(#${done ? 'arr-done' : 'arr'})"/>`);
      }
    }
    const marker = (mid, color) => `<marker id="${mid}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="${color}"/></marker>`;
    return `<svg width="${TREE_W}" height="${TREE_H}"><defs>${marker('arr', '#a07a3c')}${marker('arr-done', '#5f9a3a')}</defs>${lines.join('')}</svg>`;
  }

  node(game, id) {
    const spec = TECHS[id];
    const st = game.techStatus(id);
    const [x, y] = NODE_POS[id];
    let cls = 'tech';
    let cost;
    if (st.done) {
      cls += ' done';
      cost = '✓ Researched';
    } else {
      if (!st.available) cls += ' locked';
      else if (st.affordable) cls += ' ready';
      const res = game.roundedResources();
      cost = Object.entries(st.costs).filter(([, v]) => v > 0)
        .map(([r, v]) => `<span class="${res[r] < v ? 'short' : ''}">${v} ${RESOURCE_LABEL[r]}</span>`).join(' · ');
      // Shorten the lock label ("Stone Age Awakening" -> "Stone Age") so it fits the node.
      if (!st.available) cost = st.reason === 'too_early'
        ? `\u{1F512} Opens at ${Math.floor((st.unlocksAtSec || 0) / 60)} min`
        : `\u{1F512} ${TECHS[st.requires].label.replace(/ (Awakening|Dawn)$/, '')}`;
    }
    if (this.flash?.id === id && performance.now() < this.flash.until) {
      cls += ' shake';
      cost = this.flash.msg;
    }
    return `<button class="${cls}" data-target="${id}" style="left:${x}px;top:${y}px">
      <span class="t-ico">${spec.icon}</span>
      <span class="t-name">${spec.label}</span>
      <span class="t-eff">${spec.effect}</span>
      <span class="t-cost">${cost}</span>
    </button>`;
  }
}
