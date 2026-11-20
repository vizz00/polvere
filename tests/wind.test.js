import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windAt, summarizePoint } from '../js/snow.js';

const ID = 'm';
const hourly = (n, vals) => {
  const h = { time: Array.from({ length: n }, (_, i) => `2026-11-20T${String(i).padStart(2, '0')}:00`) };
  for (const [k, v] of Object.entries(vals)) h[`${k}_${ID}`] = Array(n).fill(v);
  return h;
};

test('in pianura il vento è quello vicino al suolo', () => {
  const h = hourly(2, { wind_speed_10m: 5, wind_direction_10m: 90, wind_speed_700hPa: 55, wind_direction_700hPa: 270 });
  const w = windAt(h, ID, 210);
  assert.equal(w.speed[0], 5);
  assert.equal(w.dir[0], 90);
});

test('a metà tra 1500 e 3000 m si prende la via di mezzo tra suolo e 700 hPa', () => {
  const h = hourly(1, { wind_speed_10m: 10, wind_speed_700hPa: 50 });
  assert.equal(windAt(h, ID, 2250).speed[0], 30);
  assert.equal(windAt(h, ID, 3000).speed[0], 50);
});

test('sopra i 3000 m si sale verso il 600 hPa; senza 600 hPa resta il 700', () => {
  const h = hourly(1, { wind_speed_10m: 10, wind_speed_700hPa: 50, wind_speed_600hPa: 70 });
  assert.equal(windAt(h, ID, 3600).speed[0], 60);
  const h2 = hourly(1, { wind_speed_10m: 10, wind_speed_700hPa: 50 });
  assert.equal(windAt(h2, ID, 3600).speed[0], 50);
});

test('accumuli: il vento in cresta viene dalla quota della cima', () => {
  const h = hourly(24, {
    precipitation: 0, temperature_2m: -5, freezing_level_height: 1000, cloud_cover: 0, wind_gusts_10m: 10,
    wind_speed_10m: 8, wind_direction_10m: 180, wind_speed_700hPa: 45, wind_direction_700hPa: 180,
  });
  const d = summarizePoint({ hourly: h }, 1200, [{ id: ID }], 3000).days[0].models[ID];
  assert.ok(d.windMax < 15);
  assert.equal(d.ridgeWindMax, 45);
  assert.equal(d.transportHours, 24);
});
