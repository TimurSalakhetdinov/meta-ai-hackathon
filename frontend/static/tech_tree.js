// 7-node Tech Tree modal. Nodes are buttons with data-target="tech_*"; clicks
// are routed through main.js like every other click in #game-root.

import { RESOURCE_LABEL, TECHS, TECH_ORDER } from './game.js';

const NODE_POS = {
  tech_toolmaking: [0, 116],
  tech_woodworking: [170, 0],
  tech_baskets: [170, 116],
  tech_masonry: [170, 232],
  tech_irrigation: [342, 52],
  tech_stone_age: [342, 190],
  tech_bronze_age: [514, 190],
};
const NODE_W = 150;
const NODE_H = 98;

export class TechTreeView {
  constructor(root, rpLabel) {
    this.root = root;
    this.rpLabel = rpLabel;
    this.signature = '';
  }

  update(game) {
    const res = game.roundedResources();
    this.rpLabel.textContent = `Research points: ${res.rp}  ·  Researched ${game.techs.size}/${TECH_ORDER.length}`;
    const sig = JSON.stringify([res, [...game.techs]]);
    if (sig === this.signature) return;
    this.signature = sig;
    this.root.innerHTML = this.edgesSvg(game) + TECH_ORDER.map((id) => this.node(game, id)).join('');
  }

  edgesSvg(game) {
    const lines = [];
    for (const id of TECH_ORDER) {
      for (const req of TECHS[id].requires) {
        const [ax, ay] = NODE_POS[req];
        const [bx, by] = NODE_POS[id];
        const x1 = ax + NODE_W;
        const y1 = ay + NODE_H / 2;
        const x2 = bx;
        const y2 = by + NODE_H / 2;
        const mx = (x1 + x2) / 2;
        const done = game.techs.has(req);
        lines.push(`<path d="M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}" fill="none"
          stroke="${done ? '#5f9a3a' : '#b08b4a'}" stroke-width="${done ? 4 : 3}" stroke-dasharray="${done ? '' : '6 5'}"/>`);
      }
    }
    return `<svg width="664" height="330">${lines.join('')}</svg>`;
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
      if (!st.available) cost = `\u{1F512} Needs ${TECHS[st.requires].label}`;
    }
    return `<button class="${cls}" data-target="${id}" style="left:${x}px;top:${y}px">
      <span class="t-ico">${spec.icon}</span>
      <span class="t-name">${spec.label}</span>
      <span class="t-eff">${spec.effect}</span>
      <span class="t-cost">${cost}</span>
    </button>`;
  }
}
