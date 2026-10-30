// Hybrid sprite loader. Transparent isometric PNGs live in assets/sprites/
// (cut from the generated sheets by scripts/cutout_sprites.py). Any sprite that
// is missing or fails to load returns null, and iso_renderer.js falls back to
// its procedural isometric drawing for that building.

const BASE = '/static/assets/sprites/';

// width: on-screen width in px. anchor: the point of the image (fractions)
// that sits on the centre of the building's ground tile.
// chimney: smoke origin as a fraction of the drawn image, if any.
export const SPRITE_MANIFEST = {
  town_center:           { file: 'town_center.png',           width: 150, anchor: [0.50, 0.80], fire: [[0.87, 0.86]] },
  town_center_stone_age: { file: 'town_center_stone_age.png', width: 168, anchor: [0.50, 0.80], fire: [[0.30, 0.79]] },
  town_center_bronze_age:{ file: 'town_center_bronze_age.png',width: 176, anchor: [0.50, 0.80], fire: [[0.55, 0.83], [0.86, 0.67]] },
  shelter:               { file: 'shelter.png',               width: 108, anchor: [0.52, 0.80], chimney: [0.74, 0.10] },
  small_home_lv2:        { file: 'small_home_lv2.png',        width: 114, anchor: [0.52, 0.80], chimney: [0.74, 0.10] },
  forager_hut:           { file: 'forager_hut.png',           width: 108, anchor: [0.52, 0.80] },
  rural_farm:            { file: 'rural_farm.png',            width: 118, anchor: [0.50, 0.80] },
  research_tent:         { file: 'research_tent.png',         width: 104, anchor: [0.52, 0.82], chimney: [0.51, 0.06], fire: [[0.74, 0.775]] },
  woodcutter_hut:        { file: 'woodcutter_hut.png',        width: 110, anchor: [0.50, 0.80] },
  stone_quarry:          { file: 'stone_quarry.png',          width: 118, anchor: [0.52, 0.76] },
  tribal_monument:       { file: 'tribal_monument.png',       width: 112, anchor: [0.50, 0.78] },
  culture_site:          { file: 'culture_site.png',          width: 116, anchor: [0.50, 0.78] },
  granary:               { file: 'granary.png',               width: 106, anchor: [0.50, 0.80] },
  smelter:               { file: 'smelter.png',               width: 110, anchor: [0.50, 0.80], chimney: [0.70, 0.10], fire: [[0.41, 0.68]] },
  barracks:              { file: 'barracks.png',              width: 122, anchor: [0.50, 0.80] },
  barracks_lv2:          { file: 'barracks_lv2.png',          width: 132, anchor: [0.50, 0.80] },
  hero_arena:            { file: 'barracks_lv2.png',          width: 122, anchor: [0.50, 0.80] },
  hero_vaelen:           { file: 'hero_vaelen.png',           width: 76,  anchor: [0.50, 1.00] },
  hero_lyra:             { file: 'hero_lyra.png',             width: 50,  anchor: [0.50, 1.00] },
  hero_ignis:            { file: 'hero_ignis.png',            width: 54,  anchor: [0.50, 1.00] },
  hero_aurelius:         { file: 'hero_aurelius.png',         width: 85,  anchor: [0.50, 1.00] },
  enemy_viking:          { file: 'enemy_viking.png',          width: 67,  anchor: [0.50, 1.00] },
  enemy_viking_boss:     { file: 'enemy_viking_boss.png',     width: 81,  anchor: [0.50, 1.00] },
  // Rival clan roster (scripts/generate_enemy_sprites.py): drawn big enough
  // to read against the painted arena, bosses bigger still.
  enemy_ash_clubman:     { file: 'enemy_ash_clubman.png',     width: 92,  anchor: [0.50, 1.00] },
  enemy_reed_slinger:    { file: 'enemy_reed_slinger.png',    width: 92,  anchor: [0.50, 1.00] },
  enemy_birch_knifer:    { file: 'enemy_birch_knifer.png',    width: 92,  anchor: [0.50, 1.00] },
  enemy_flint_axeman:    { file: 'enemy_flint_axeman.png',    width: 92,  anchor: [0.50, 1.00] },
  enemy_moss_bowhand:    { file: 'enemy_moss_bowhand.png',    width: 92,  anchor: [0.50, 1.00] },
  enemy_oak_doorward:    { file: 'enemy_oak_doorward.png',    width: 92,  anchor: [0.50, 1.00] },
  enemy_thorn_runner:    { file: 'enemy_thorn_runner.png',    width: 92,  anchor: [0.50, 1.00] },
  enemy_reed_herbkeeper: { file: 'enemy_reed_herbkeeper.png', width: 92,  anchor: [0.50, 1.00] },
  enemy_flint_hookman:   { file: 'enemy_flint_hookman.png',   width: 92,  anchor: [0.50, 1.00] },
  enemy_ash_drumhand:    { file: 'enemy_ash_drumhand.png',    width: 92,  anchor: [0.50, 1.00] },
  enemy_frost_guard:     { file: 'enemy_frost_guard.png',     width: 92,  anchor: [0.50, 1.00] },
  enemy_cinder_dartman:  { file: 'enemy_cinder_dartman.png',  width: 92,  anchor: [0.50, 1.00] },
  enemy_boar_cleaver:    { file: 'enemy_boar_cleaver.png',    width: 92,  anchor: [0.50, 1.00] },
  enemy_gale_scout:      { file: 'enemy_gale_scout.png',      width: 92,  anchor: [0.50, 1.00] },
  enemy_thorn_longbow:   { file: 'enemy_thorn_longbow.png',   width: 92,  anchor: [0.50, 1.00] },
  enemy_tusk_shieldwall: { file: 'enemy_tusk_shieldwall.png', width: 92,  anchor: [0.50, 1.00] },
  enemy_tusk_spearcast:  { file: 'enemy_tusk_spearcast.png',  width: 92,  anchor: [0.50, 1.00] },
  enemy_raven_standard:  { file: 'enemy_raven_standard.png',  width: 92,  anchor: [0.50, 1.00] },
  enemy_iron_swordsman:  { file: 'enemy_iron_swordsman.png',  width: 92,  anchor: [0.50, 1.00] },
  enemy_gale_harrier:    { file: 'enemy_gale_harrier.png',    width: 92,  anchor: [0.50, 1.00] },
  enemy_frost_bonewright:{ file: 'enemy_frost_bonewright.png',width: 92,  anchor: [0.50, 1.00] },
  enemy_night_gateward:  { file: 'enemy_night_gateward.png',  width: 92,  anchor: [0.50, 1.00] },
  enemy_night_bowguard:  { file: 'enemy_night_bowguard.png',  width: 92,  anchor: [0.50, 1.00] },
  enemy_iron_breaker:    { file: 'enemy_iron_breaker.png',    width: 92,  anchor: [0.50, 1.00] },
  enemy_tusk_chief:      { file: 'enemy_tusk_chief.png',      width: 108, anchor: [0.50, 1.00] },
  enemy_raven_marshal:   { file: 'enemy_raven_marshal.png',   width: 108, anchor: [0.50, 1.00] },
  enemy_shadowclaw:      { file: 'enemy_shadowclaw.png',      width: 108, anchor: [0.50, 1.00] },
  villager:              { file: 'villager.png',              width: 18,  anchor: [0.50, 1.00] },
  res_food:              { file: 'res_food.png',              width: 24,  anchor: [0.50, 0.50] },
  res_wood:              { file: 'res_wood.png',              width: 24,  anchor: [0.50, 0.50] },
  res_stone:             { file: 'res_stone.png',             width: 24,  anchor: [0.50, 0.50] },
  res_coins:             { file: 'res_coins.png',             width: 24,  anchor: [0.50, 0.50] },
  villager_m_black:      { file: 'villager_m_black.png',      width: 18,  anchor: [0.50, 1.00] },
  villager_m_black_b:    { file: 'villager_m_black_b.png',    width: 18,  anchor: [0.50, 1.00] },
  villager_m_blond:      { file: 'villager_m_blond.png',      width: 18,  anchor: [0.50, 1.00] },
  villager_m_blond_b:    { file: 'villager_m_blond_b.png',    width: 18,  anchor: [0.50, 1.00] },
  villager_f_black:      { file: 'villager_f_black.png',      width: 18,  anchor: [0.50, 1.00] },
  villager_f_black_b:    { file: 'villager_f_black_b.png',    width: 18,  anchor: [0.50, 1.00] },
  villager_f_blond:      { file: 'villager_f_blond.png',      width: 18,  anchor: [0.50, 1.00] },
  villager_f_blond_b:    { file: 'villager_f_blond_b.png',    width: 18,  anchor: [0.50, 1.00] },
  enemy_beast_pack:      { file: 'enemy_beast_pack.png',      width: 96,  anchor: [0.50, 0.85] },
  boss_shadowclaw:       { file: 'boss_shadowclaw.png',       width: 132, anchor: [0.50, 0.85] },
  portrait_vaelen:       { file: 'portrait_vaelen.png',       width: 160, anchor: [0.50, 0.50] },
  portrait_lyra:         { file: 'portrait_lyra.png',         width: 160, anchor: [0.50, 0.50] },
  portrait_ignis:        { file: 'portrait_ignis.png',        width: 160, anchor: [0.50, 0.50] },
  portrait_aurelius:     { file: 'portrait_aurelius.png',     width: 160, anchor: [0.50, 0.50] },
  portrait_archon:       { file: 'portrait_archon.png',       width: 160, anchor: [0.50, 0.50] },
  victory_chest:         { file: 'victory_chest.png',         width: 140, anchor: [0.50, 0.50] },
  valley_backdrop:       { file: 'valley_backdrop.jpg',       width: 960, anchor: [0.00, 0.00] },
  battle_arena_bg:       { file: 'battle_arena_bg.jpg',       width: 960, anchor: [0.00, 0.00] },
  campaign_map_bg:       { file: 'campaign_map_bg.jpg',       width: 960, anchor: [0.00, 0.00] },
  hero_hall_bg:          { file: 'hero_hall_bg.jpg',          width: 960, anchor: [0.00, 0.00] },
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
