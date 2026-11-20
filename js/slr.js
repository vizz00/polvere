// Rapporto neve/acqua (SLR) con il metodo di Cobb e Waldstreicher (NOAA/NWS, 2005,
// "A simple physically based snowfall algorithm"). Calcoli puri: niente rete né DOM.
//
// L'idea: i fiocchi prendono la forma (e quindi la leggerezza) dove si formano, nelle
// nuvole sopra il posto. Per ogni ora e ogni modello:
//   1. si guardano i livelli in quota sopra il posto (850, 700, 600, 500, 400 hPa);
//   2. "nuvola" = umidità rispetto al ghiaccio ≥ 90%;
//   3. ogni strato di nuvola dà un rapporto dalla sua temperatura (curva della Fig. 5:
//      massimo 50:1 tra −14 e −17 °C, dove crescono le dendriti; circa 6:1 sopra −10 °C,
//      dove i fiocchi si brinano; 10:1 sotto −22 °C);
//   4. gli strati pesano in base a quanto sale l'aria (ω), al quadrato rispetto al massimo,
//      e allo spessore: peso = ω · (ω / ωmax)² · spessore.
// Se il modello non dà la salita dell'aria (ICON, Météo-France) gli strati di nuvola
// pesano solo per lo spessore. Il giorno è la media delle ore pesata sulla neve caduta.

import { snowFraction } from './snow.js';

// Curva della Fig. 5 del PDF: rapporto per temperatura, da −30 °C a 0 °C ogni grado.
export const SR_CURVE = [
  10, 10, 10, 10, 10, 10, 10, 9.7, 10.5, 13.2, // −30 … −21
  19.2, 28.5, 39, 47, 50, 45.7, 36.3, 25, 15, 9, // −20 … −11
  6.2, 5.8, 6.1, 6.4, 6.4, 6.2, 5.9, 5.3, 4.7, 3.9, // −10 … −1
  3, // 0
];

/** Rapporto di uno strato di nuvola alla temperatura `t` (°C). */
export function layerRatio(t) {
  if (t <= -30) return SR_CURVE[0];
  if (t >= 0) return SR_CURVE[30];
  const x = t + 30;
  const i = Math.floor(x);
  return SR_CURVE[i] + (SR_CURVE[i + 1] - SR_CURVE[i]) * (x - i);
}

/** Umidità rispetto al ghiaccio (%) da quella rispetto all'acqua data dai modelli. */
export function rhIce(rhWater, t) {
  if (t >= 0) return rhWater;
  const ew = Math.exp((17.62 * t) / (243.12 + t));
  const ei = Math.exp((22.46 * t) / (272.62 + t));
  return (rhWater * ew) / ei;
}

export const SLR_LEVELS = [850, 700, 600, 500, 400];
// Tetto al rapporto mostrato. Il PDF arriva a 50:1 (dendriti perfette), ma non conta
// cosa succede sotto la nuvola: vento e caduta rompono i fiocchi prima che tocchino terra.
export const SLR_MAX = 25;
export const CLOUD_RH_ICE = 90;

/**
 * Rapporto di un'ora da un profilo verticale.
 * `levels`: [{ z: quota m, t: °C, rh: % (acqua), w: velocità verticale o null }] dal basso.
 * Open-Meteo dà la velocità verticale con il segno della ω: negativa = aria che sale.
 * Restituisce null se sopra `elev` non c'è nuvola.
 */
export function hourRatio(levels, elev) {
  const lv = levels.filter((l) => l.z != null && l.t != null && l.rh != null).sort((a, b) => a.z - b.z);
  const layers = [];
  for (let i = 0; i < lv.length; i++) {
    const l = lv[i];
    if (l.z < elev) continue;
    const below = i > 0 ? (lv[i - 1].z + l.z) / 2 : l.z - 500;
    const above = i < lv.length - 1 ? (l.z + lv[i + 1].z) / 2 : l.z + (l.z - (lv[i - 1]?.z ?? l.z - 1000)) / 2;
    const thick = above - Math.max(below, elev);
    if (thick <= 0) continue;
    if (rhIce(l.rh, l.t) < CLOUD_RH_ICE) continue;
    layers.push({ t: l.t, w: l.w, thick });
  }
  if (!layers.length) return null;
  const hasW = layers.every((l) => l.w != null);
  const up = layers.map((l) => (hasW ? Math.max(0, -l.w) : 1));
  const max = Math.max(...up);
  // Nuvola ma aria che non sale da nessuna parte: pesano tutti gli strati allo stesso modo.
  const wts = layers.map((l, k) => (max > 0 ? up[k] * (up[k] / max) ** 2 : 1) * l.thick);
  const sum = wts.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return null;
  return layers.reduce((acc, l, k) => acc + layerRatio(l.t) * (wts[k] / sum), 0);
}

/**
 * Rapporto per giorno di un modello: { 'AAAA-MM-GG': rapporto } (solo giorni con ≥ 0.5 mm di neve).
 * `h` è l'oggetto `hourly` di Open-Meteo con chiavi a suffisso `_<id>`.
 */
export function modelDailySlr(h, id, elev, levels = SLR_LEVELS) {
  const get = (k) => h[`${k}_${id}`] ?? (Object.keys(h).some((x) => x.endsWith(`_${id}`)) ? null : h[k]);
  const pr = get('precipitation');
  if (!pr) return {};
  const t2 = get('temperature_2m') || [];
  const fz = get('freezing_level_height') || [];
  const cols = levels.map((p) => ({
    z: get(`geopotential_height_${p}hPa`) || [],
    t: get(`temperature_${p}hPa`) || [],
    rh: get(`relative_humidity_${p}hPa`) || [],
    w: get(`vertical_velocity_${p}hPa`) || [],
  }));
  const acc = {};
  h.time.forEach((time, i) => {
    const water = (pr[i] ?? 0) * snowFraction(elev, t2[i], fz[i]);
    if (water <= 0) return;
    const r = hourRatio(cols.map((c) => ({ z: c.z[i], t: c.t[i], rh: c.rh[i], w: c.w[i] ?? null })), elev);
    if (r == null) return;
    const d = time.slice(0, 10);
    acc[d] ??= { w: 0, s: 0 };
    acc[d].w += water;
    acc[d].s += water * r;
  });
  const out = {};
  for (const [d, a] of Object.entries(acc)) if (a.w >= 0.5) out[d] = a.s / a.w;
  return out;
}

/** Rapporto per giorno: mediana dei modelli. { 'AAAA-MM-GG': rapporto arrotondato }. */
export function dailySlr(raw, elev, modelIds, levels = SLR_LEVELS) {
  const h = raw?.hourly;
  if (!h?.time) return {};
  const per = modelIds.map((id) => modelDailySlr(h, id, elev, levels));
  const dates = new Set(per.flatMap((m) => Object.keys(m)));
  const out = {};
  for (const d of dates) {
    const v = per.map((m) => m[d]).filter((x) => x != null).sort((a, b) => a - b);
    if (!v.length) continue;
    const m = Math.floor(v.length / 2);
    out[d] = Math.round(Math.min(SLR_MAX, v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2));
  }
  return out;
}

/** Variabili orarie da chiedere a Open-Meteo per il calcolo. */
export function slrVars(levels = SLR_LEVELS) {
  return [
    'precipitation',
    'temperature_2m',
    'freezing_level_height',
    ...levels.flatMap((p) => [`temperature_${p}hPa`, `relative_humidity_${p}hPa`, `vertical_velocity_${p}hPa`, `geopotential_height_${p}hPa`]),
  ];
}
