// Hybrid sprite loader. Transparent isometric PNGs live in assets/sprites/
// (cut from the generated sheets by scripts/cutout_sprites.py). Any sprite that
// is missing or fails to load returns null, and iso_renderer.js falls back to
// its procedural isometric drawing for that building.

const BASE = '/static/assets/sprites/';

// width: on-screen width in px. anchor: the point of the image (fractions)
// that sits on the centre of the building's ground tile.
// chimney: smoke origin as a fraction of the drawn image, if any.
export const SPRITE_MANIFEST = {
  town_center:           { file: 'town_center.png',           width: 150, anchor: [0.50, 0.80] },
  town_center_stone_age: { file: 'town_center_stone_age.png', width: 168, anchor: [0.50, 0.80] },
  shelter:               { file: 'shelter.png',               width: 108, anchor: [0.52, 0.80], chimney: [0.62, 0.12] },
  forager_hut:           { file: 'forager_hut.png',           width: 108, anchor: [0.52, 0.80] },
  research_tent:         { file: 'research_tent.png',         width: 104, anchor: [0.52, 0.82] },
  woodcutter_hut:        { file: 'woodcutter_hut.png',        width: 110, anchor: [0.50, 0.80] },
  stone_quarry:          { file: 'stone_quarry.png',          width: 118, anchor: [0.52, 0.76] },
  tribal_monument:       { file: 'tribal_monument.png',       width: 112, anchor: [0.50, 0.78] },
};

export async function loadSprites() {
  const entries = await Promise.all(
    Object.entries(SPRITE_MANIFEST).map(async ([key, spec]) => {
      try {
        const img = await loadImage(BASE + spec.file);
        return [key, { ...spec, img, height: spec.width * (img.naturalHeight / img.naturalWidth) }];
      } catch {
        return [key, null];
      }
    }),
  );
  return Object.fromEntries(entries);
}

export function spriteUrl(key) {
  const spec = SPRITE_MANIFEST[key];
  return spec ? BASE + spec.file : null;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`sprite missing: ${src}`));
    img.src = src;
  });
}
