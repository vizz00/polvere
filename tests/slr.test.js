import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { layerRatio, rhIce, hourRatio, dailySlr, SLR_MAX } from '../js/slr.js';

test('curva della Fig. 5: massimo a −16 °C, 10:1 al freddo, brinata sopra −10 °C', () => {
  assert.equal(layerRatio(-16), 50);
  assert.equal(layerRatio(-30), 10);
  assert.equal(layerRatio(-40), 10);
  assert.ok(layerRatio(-6) < 7);
  assert.equal(layerRatio(2), 3);
  assert.ok(Math.abs(layerRatio(-16.5) - 48.5) < 0.01);
});

test("umidità rispetto al ghiaccio più alta di quella rispetto all'acqua sotto zero", () => {
  assert.ok(rhIce(80, -15) > 90);
  assert.equal(rhIce(80, 5), 80);
});

test('esempio del PDF (Fig. 6): tre strati di 500 m, UVV 5, 8, 12 → circa 14:1', () => {
  // Rapporti degli strati 10, ~45, ~6 come nell'esempio; ω negativa = aria che sale.
  const levels = [
    { z: 1000, t: -6, rh: 100, w: -12 },
    { z: 1500, t: -15, rh: 100, w: -8 },
    { z: 2000, t: -25, rh: 100, w: -5 },
  ];
  const r = hourRatio(levels, 750);
  assert.ok(r > 13 && r < 16, `rapporto ${r}`);
});

test('strati sotto il posto o asciutti non contano', () => {
  const levels = [
    { z: 1500, t: -2, rh: 100, w: -10 }, // sotto il posto
    { z: 3000, t: -16, rh: 100, w: -1 },
    { z: 4200, t: -25, rh: 20, w: -5 }, // asciutto
  ];
  assert.equal(Math.round(hourRatio(levels, 2500)), 50);
  assert.equal(hourRatio([{ z: 3000, t: -15, rh: 30, w: -1 }], 2500), null);
});

test('senza velocità verticale gli strati pesano per lo spessore', () => {
  const r = hourRatio([
    { z: 3000, t: -16, rh: 100, w: null },
    { z: 4200, t: -25, rh: 100, w: null },
  ], 2500);
  assert.ok(r > 10 && r < 50);
});

test('risposta vera di Open-Meteo per Cervinia: rapporti per giorno entro i limiti', () => {
  const raw = JSON.parse(readFileSync(new URL('./fixtures/open-meteo-cervinia-quota.json', import.meta.url)));
  const ids = ['ecmwf_ifs025', 'icon_seamless', 'gfs_seamless', 'meteofrance_seamless', 'italia_meteo_arpae_icon_2i'];
  const out = dailySlr(raw, 2800, ids);
  const vals = Object.values(out);
  assert.ok(vals.length >= 5);
  for (const v of vals) assert.ok(v >= 3 && v <= SLR_MAX, `rapporto ${v}`);
});
