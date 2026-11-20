// Calcoli puri sulla risposta Open-Meteo: nessun accesso a rete o DOM,
// così si possono provare con `node --test`.

export const MODELS = [
  { id: 'ecmwf_ifs025', label: 'ECMWF' },
  { id: 'icon_seamless', label: 'ICON' },
  { id: 'gfs_seamless', label: 'GFS' },
  { id: 'meteofrance_seamless', label: 'Météo-France' },
  { id: 'meteoswiss_icon_ch2', label: 'MeteoSwiss CH2' },
  { id: 'italia_meteo_arpae_icon_2i', label: 'ICON-2I' },
];

export const HOURLY_VARS = [
  'temperature_2m',
  'precipitation',
  'freezing_level_height',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_speed_700hPa',
  'wind_direction_700hPa',
  'wind_speed_600hPa',
  'wind_direction_600hPa',
  'cloud_cover',
  'wind_gusts_10m',
];

// Vento alla quota del posto. I modelli danno il vento vicino al suolo (10 m) e a livelli fissi
// in quota (700 hPa ≈ 3000 m, 600 hPa ≈ 4200 m). Fino a 1500 m si usa il vento al suolo,
// sopra si passa gradualmente a quello dei livelli in quota (interpolazione sulla quota).
export const WIND_LEVELS = [
  { key: '10m', h: 1500 },
  { key: '700hPa', h: 3000 },
  { key: '600hPa', h: 4200 },
];

/** Serie orarie { speed, dir } del vento alla quota `elev` per il modello `id`. */
export function windAt(h, id, elev) {
  const sp = (k) => h[`wind_speed_${k}_${id}`];
  const dr = (k) => h[`wind_direction_${k}_${id}`];
  const L = WIND_LEVELS;
  let lo = L[0];
  let hi = L[0];
  if (elev >= L[L.length - 1].h) lo = hi = L[L.length - 1];
  else if (elev > L[0].h) {
    const j = L.findIndex((l) => l.h >= elev);
    lo = L[j - 1];
    hi = L[j];
  }
  const f = hi === lo ? 0 : (elev - lo.h) / (hi.h - lo.h);
  const sLo = sp(lo.key) || [];
  const sHi = sp(hi.key) || [];
  const dLo = dr(lo.key) || [];
  const dHi = dr(hi.key) || [];
  // Riserva: se mancano entrambi i livelli (modello senza quel dato) si usa il 700 hPa.
  const s7 = sp('700hPa') || [];
  const d7 = dr('700hPa') || [];
  const n = h.time.length;
  const speed = new Array(n);
  const dir = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = sLo[i] ?? null;
    const b = sHi[i] ?? null;
    speed[i] = a != null && b != null ? a + (b - a) * f : a ?? b ?? s7[i] ?? null;
    const near = f < 0.5 ? dLo[i] ?? dHi[i] : dHi[i] ?? dLo[i];
    dir[i] = near ?? d7[i] ?? null;
  }
  return { speed, dir };
}

// Vento in cresta da cui la neve soffice inizia a essere spostata (valore indicativo, km/h).
export const TRANSPORT_WIND_KMH = 25;

// Un modello "copre" un giorno se ha almeno 20 ore valide di precipitazione.
const MIN_HOURS_PER_DAY = 20;

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/**
 * Rapporto neve/acqua in funzione della temperatura alla quota:
 * circa 10:1 vicino a 0 °C, fino a 15:1 sotto −8 °C.
 */
export function snowRatio(tempC) {
  if (tempC == null) return 10;
  return 10 + (clamp(-tempC, 0, 8) * 5) / 8;
}

/**
 * Frazione della precipitazione che cade come neve alla quota `elev`.
 * Se il modello dà lo zero termico: limite neve ≈ zero termico − 300 m,
 * con una transizione di 300 m. Altrimenti (ECMWF, Météo-France) si usa
 * la temperatura alla quota: neve sotto +0.5 °C, pioggia sopra +2.5 °C.
 */
export function snowFraction(elev, tempC, freezingLevel) {
  if (freezingLevel != null) {
    const snowLine = freezingLevel - 300;
    return clamp((elev - (snowLine - 150)) / 300, 0, 1);
  }
  if (tempC == null) return 0;
  return clamp((2.5 - tempC) / 2, 0, 1);
}

/** Neve stimata (cm) per un'ora. */
export function hourlySnowCm(elev, precipMm, tempC, freezingLevel) {
  if (precipMm == null || precipMm <= 0) return 0;
  const frac = snowFraction(elev, tempC, freezingLevel);
  return (precipMm * frac * snowRatio(tempC)) / 10;
}

export function median(values) {
  const v = values.filter((x) => x != null && !Number.isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * Riassume per giorno e per modello un punto della risposta Open-Meteo
 * (un oggetto con `hourly` e chiavi con suffisso del modello).
 * Restituisce { days: [{ date, models: {id: {...}}, snow: {min,max,median,n}, ... }] }
 */
export function summarizePoint(point, elev, models = MODELS, ridgeElev = elev) {
  const h = point.hourly;
  const times = h.time;
  const dayIndex = new Map();
  times.forEach((t, i) => {
    const d = t.slice(0, 10);
    if (!dayIndex.has(d)) dayIndex.set(d, []);
    dayIndex.get(d).push(i);
  });

  const days = [];
  for (const [date, idxs] of dayIndex) {
    const perModel = {};
    for (const m of models) {
      const get = (v) => h[`${v}_${m.id}`];
      const pr = get('precipitation');
      if (!pr) continue;
      const valid = idxs.filter((i) => pr[i] != null);
      if (valid.length < MIN_HOURS_PER_DAY) continue;
      const t = get('temperature_2m') || [];
      const fl = get('freezing_level_height') || [];
      // Vento alla quota del posto (meteo, polvere) e alla quota della cima (accumuli in cresta).
      const { speed: ws, dir: wd } = windAt(h, m.id, elev);
      const { speed: rs, dir: rd } = ridgeElev === elev ? { speed: ws, dir: wd } : windAt(h, m.id, ridgeElev);
      const cc = get('cloud_cover') || [];
      const wg = get('wind_gusts_10m') || [];
      let gustMax = null;
      let snow = 0;
      let precip = 0;
      let flMax = null;
      let windMax = null;
      let windDir = null;
      let ridgeWindMax = null;
      let rain = 0;
      let tx = 0;
      let ty = 0;
      let transportHours = 0;
      let tNightMin = null;
      let snowTemp = 0;
      let snowW = 0;
      const clouds = [];
      const nightClouds = [];
      for (const i of valid) {
        const hour = Number(times[i].slice(11, 13));
        precip += pr[i];
        const hs = hourlySnowCm(elev, pr[i], t[i], fl[i]);
        snow += hs;
        if (hs > 0 && t[i] != null) {
          snowTemp += hs * t[i];
          snowW += hs;
        }
        if (pr[i] > 0) rain += pr[i] * (1 - snowFraction(elev, t[i], fl[i]));
        // Direzione del vento che sposta la neve (in cresta): media vettoriale pesata sulle ore con vento ≥ soglia.
        if (rs[i] != null && rd[i] != null && rs[i] >= TRANSPORT_WIND_KMH) {
          const rad = (rd[i] * Math.PI) / 180;
          tx += rs[i] * Math.sin(rad);
          ty += rs[i] * Math.cos(rad);
          transportHours++;
        }
        if (rs[i] != null && (ridgeWindMax == null || rs[i] > ridgeWindMax)) ridgeWindMax = rs[i];
        // Notte (0-6): rigelo della neve.
        if (hour <= 6) {
          if (t[i] != null) tNightMin = tNightMin == null ? t[i] : Math.min(tNightMin, t[i]);
          if (cc[i] != null) nightClouds.push(cc[i]);
        }
        if (wg[i] != null) gustMax = gustMax == null ? wg[i] : Math.max(gustMax, wg[i]);
        if (fl[i] != null) flMax = flMax == null ? fl[i] : Math.max(flMax, fl[i]);
        if (ws[i] != null && (windMax == null || ws[i] > windMax)) {
          windMax = ws[i];
          windDir = wd[i] ?? null;
        }
        // Nuvolosità solo nelle ore diurne (8-17).
        if (cc[i] != null && hour >= 8 && hour <= 17) clouds.push(cc[i]);
      }
      const tvals = valid.map((i) => t[i]).filter((x) => x != null);
      perModel[m.id] = {
        snow,
        precip,
        freezingMax: flMax,
        windMax,
        windDir,
        ridgeWindMax,
        cloud: clouds.length ? clouds.reduce((a, b) => a + b, 0) / clouds.length : null,
        tMin: tvals.length ? Math.min(...tvals) : null,
        tMax: tvals.length ? Math.max(...tvals) : null,
        rain,
        gustMax,
        transportHours,
        transportDir: transportHours ? (((Math.atan2(tx, ty) * 180) / Math.PI) + 360) % 360 : null,
        tNightMin,
        tSnow: snowW ? snowTemp / snowW : null, // temperatura media mentre nevica
        nightCloud: nightClouds.length ? nightClouds.reduce((a, b) => a + b, 0) / nightClouds.length : null,
      };
    }
    const vals = Object.values(perModel);
    const snows = vals.map((x) => x.snow);
    // Il vento del giorno è quello del modello "mediano" per velocità.
    const winds = vals.filter((x) => x.windMax != null).sort((a, b) => a.windMax - b.windMax);
    const midWind = winds.length ? winds[Math.floor((winds.length - 1) / 2)] : null;
    days.push({
      date,
      models: perModel,
      nModels: vals.length,
      snow: vals.length
        ? { min: Math.min(...snows), max: Math.max(...snows), median: median(snows) }
        : null,
      freezingMax: median(vals.map((x) => x.freezingMax)),
      freezingModels: vals.filter((x) => x.freezingMax != null).length,
      wind: midWind ? { speed: midWind.windMax, dir: midWind.windDir } : null,
      cloud: median(vals.map((x) => x.cloud)),
      tMin: median(vals.map((x) => x.tMin)),
      tMax: median(vals.map((x) => x.tMax)),
      rain: median(vals.map((x) => x.rain)),
      gustMax: median(vals.map((x) => x.gustMax)),
    });
  }
  return { days, total: totalRange(days, models) };
}

/**
 * Totale del periodo come intervallo tra i modelli che coprono tutti i giorni
 * (i modelli ad alta risoluzione coprono meno giorni e sottostimerebbero).
 */
export function totalRange(days, models = MODELS) {
  const full = models.filter((m) => days.length && days.every((d) => d.models[m.id]));
  if (!full.length) return null;
  const sums = full.map((m) => days.reduce((s, d) => s + d.models[m.id].snow, 0));
  return { min: Math.min(...sums), max: Math.max(...sums), median: median(sums), models: full.map((m) => m.id) };
}

/** Arrotondamento leggibile per i cm di neve. */
export function roundCm(x) {
  if (x == null) return null;
  if (x < 0.5) return 0;
  if (x < 10) return Math.round(x);
  return Math.round(x / 5) * 5 || Math.round(x);
}

/** Testo "a–b" in cm, oppure "0". */
export function rangeText(r) {
  if (!r) return 'n.d.';
  const a = roundCm(r.min);
  const b = roundCm(r.max);
  if (b === 0) return '0';
  if (a === b) return `${a}`;
  return `${a}–${b}`;
}

const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
/** Direzione di provenienza del vento in punti cardinali italiani. */
export function compass(deg) {
  if (deg == null) return '';
  return DIRS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

/**
 * Trova la prossima nevicata significativa (mediana ≥ soglia) fra tutti i posti.
 * `summaries` è un array di { place, summary }.
 */
export function nextSnowfall(summaries, threshold = 5) {
  const ndays = Math.max(0, ...summaries.map((s) => s.summary.days.length));
  for (let i = 0; i < ndays; i++) {
    const hits = summaries.filter((s) => s.summary.days[i]?.snow?.median >= threshold);
    if (!hits.length) continue;
    // Estende l'episodio ai giorni consecutivi con neve.
    let end = i;
    while (end + 1 < ndays && summaries.some((s) => s.summary.days[end + 1]?.snow?.median >= threshold)) end++;
    const ranked = summaries
      .map((s) => {
        const ds = s.summary.days.slice(i, end + 1);
        const r = totalRange(ds) || { min: 0, max: 0, median: 0 };
        return { place: s.place, min: r.min, max: r.max, median: r.median };
      })
      .sort((a, b) => b.median - a.median);
    return { startIndex: i, endIndex: end, best: ranked[0] };
  }
  return null;
}

// ---------- valori orari ----------

/** Indice dell'ora corrente (ora italiana) nella lista `time` di Open-Meteo, o -1. */
export function hourIndex(times, now = new Date()) {
  const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' });
  const key = fmt.format(now).replace(' ', 'T').slice(0, 13); // "YYYY-MM-DDTHH"
  return times.findIndex((t) => t.slice(0, 13) === key);
}

/**
 * Condizioni dell'ora corrente (mediana tra i modelli) e neve stimata nelle ultime 24 ore.
 * Restituisce { now: {temp, cloud, wind, windDir, gust, precip, snowing}, last24 } oppure null.
 */
export function pointNow(point, elev, models = MODELS, now = new Date()) {
  const h = point.hourly;
  const i = hourIndex(h.time, now);
  if (i < 0) return null;
  const at = (v) => median(models.map((m) => h[`${v}_${m.id}`]?.[i] ?? null));
  const winds = models.map((m) => windAt(h, m.id, elev));
  const dirs = winds.map((w) => w.dir[i]).filter((x) => x != null);
  let x = 0;
  let y = 0;
  for (const d of dirs) {
    x += Math.sin((d * Math.PI) / 180);
    y += Math.cos((d * Math.PI) / 180);
  }
  const last = models
    .map((m) => {
      const pr = h[`precipitation_${m.id}`];
      if (!pr) return null;
      let sum = 0;
      let n = 0;
      for (let k = Math.max(0, i - 24); k < i; k++) {
        if (pr[k] == null) continue;
        n++;
        sum += hourlySnowCm(elev, pr[k], h[`temperature_2m_${m.id}`]?.[k], h[`freezing_level_height_${m.id}`]?.[k]);
      }
      return n >= 12 ? sum : null;
    })
    .filter((v) => v != null);
  const temp = at('temperature_2m');
  const precip = at('precipitation');
  return {
    now: {
      temp,
      cloud: at('cloud_cover'),
      wind: median(winds.map((w) => w.speed[i] ?? null)),
      windDir: dirs.length ? (((Math.atan2(x, y) * 180) / Math.PI) + 360) % 360 : null,
      gust: at('wind_gusts_10m'),
      precip,
      snowing: precip > 0.1 && snowFraction(elev, temp, at('freezing_level_height')) > 0.5,
    },
    last24: last.length ? median(last) : null,
  };
}

/**
 * Serie per i grafici del dettaglio, a passi di `step` ore, dall'ora corrente in avanti.
 * Per ogni modello: neve cumulata, quota neve, temperatura, vento alla quota, raffiche, nuvolosità,
 * precipitazione (con la parte nevosa). Più la mediana tra i modelli.
 */
export function chartSeries(point, elev, models = MODELS, { step = 3, now = new Date() } = {}) {
  const h = point.hourly;
  let start = hourIndex(h.time, now);
  if (start < 0) start = 0;
  // Allinea all'inizio del passo (00, 03, 06…) così le righe dei giorni cadono sulla mezzanotte.
  start = Math.max(0, start - (Number(h.time[start].slice(11, 13)) % step));
  const times = [];
  for (let i = start; i < h.time.length; i += step) times.push(h.time[i]);
  const vars = ['snowTotal', 'snowLine', 'temp', 'wind', 'gust', 'cloud'];
  const byModel = {};
  for (const m of models) {
    const g = (v) => h[`${v}_${m.id}`] || [];
    const pr = g('precipitation');
    if (!pr.length) continue;
    const t = g('temperature_2m');
    const fl = g('freezing_level_height');
    const ws = windAt(h, m.id, elev).speed;
    const wg = g('wind_gusts_10m');
    const cc = g('cloud_cover');
    const out = { snowTotal: [], snowLine: [], temp: [], wind: [], gust: [], cloud: [], snow: [], rain: [] };
    let cum = 0;
    let alive = true;
    for (let i = start; i < h.time.length; i += step) {
      let sn = 0;
      let rn = 0;
      let valid = 0;
      for (let k = i; k < Math.min(i + step, h.time.length); k++) {
        if (pr[k] == null) continue;
        valid++;
        const s = hourlySnowCm(elev, pr[k], t[k], fl[k]);
        sn += s;
        rn += pr[k] * (1 - snowFraction(elev, t[k], fl[k]));
      }
      if (!valid) alive = false;
      cum += sn;
      const mean = (arr) => {
        const v = [];
        for (let k = i; k < Math.min(i + step, h.time.length); k++) if (arr[k] != null) v.push(arr[k]);
        return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
      };
      const maxOf = (arr) => {
        let mx = null;
        for (let k = i; k < Math.min(i + step, h.time.length); k++) if (arr[k] != null) mx = mx == null ? arr[k] : Math.max(mx, arr[k]);
        return mx;
      };
      out.snowTotal.push(alive ? cum : null);
      out.snow.push(valid ? sn : null);
      out.rain.push(valid ? rn : null);
      const f = mean(fl);
      out.snowLine.push(f != null ? Math.max(0, f - 300) : null);
      out.temp.push(mean(t));
      out.wind.push(maxOf(ws));
      out.gust.push(maxOf(wg));
      out.cloud.push(mean(cc));
    }
    byModel[m.id] = out;
  }
  const ids = Object.keys(byModel);
  const med = {};
  for (const v of [...vars, 'snow', 'rain']) {
    med[v] = times.map((_, j) => median(ids.map((id) => byModel[id][v][j])));
  }
  // Neve cumulata: mediana dei totali dei modelli ancora attivi; non scende mai quando un modello finisce.
  let prev = 0;
  med.snowTotal = med.snowTotal.map((x) => (prev = Math.max(prev, x ?? prev)));
  // Direzione del vento mediana (media circolare) per le frecce.
  const dirs = models.map((m) => windAt(h, m.id, elev).dir);
  med.windDir = times.map((_, j) => {
    let x = 0;
    let y = 0;
    let n = 0;
    for (const dm of dirs) {
      const d = dm[start + j * step];
      if (d == null) continue;
      x += Math.sin((d * Math.PI) / 180);
      y += Math.cos((d * Math.PI) / 180);
      n++;
    }
    return n ? (((Math.atan2(x, y) * 180) / Math.PI) + 360) % 360 : null;
  });
  return { times, step, byModel, median: med };
}
