// Scarica le previsioni Open-Meteo per tutti i posti e tutte le quote
// con UNA sola chiamata (Open-Meteo accetta liste di coordinate).
import { MODELS, HOURLY_VARS, summarizePoint, totalRange, pointNow, chartSeries } from './snow.js';
import { BANDS } from './places.js';
import { dailySlr, slrVars, SLR_LEVELS } from './slr.js';

const API = 'https://api.open-meteo.com/v1/forecast';
// Si salva il riassunto per giorno (non la risposta grezza, 3 volte più grande):
// così ci stanno molti posti nello spazio del browser.
const CACHE_KEY = 'mm.forecast.v3';
try {
  localStorage.removeItem('mm.forecast.v1'); // vecchio formato grezzo
  localStorage.removeItem('mm.forecast.v2'); // vento sempre a 3000 m
} catch {
  /* ignorato */
}
const MAX_AGE_MS = 60 * 60 * 1000; // un'ora
export const FORECAST_DAYS = 10; // panoramica: prossimi 1-5 e 6-10 giorni
export const DETAIL_DAYS = 10; // dettaglio del posto: grafici a 10 giorni (più in là la previsione non serve)
// Giorni passati scaricati insieme alla previsione: servono alle regole dei prossimi 3 giorni
// (neve fresca degli ultimi 3 giorni, giorni secchi prima della nevicata, neve soffice degli ultimi 7).
export const PAST_DAYS = 8;

function buildPoints(places) {
  const points = [];
  for (const place of places) {
    for (const band of BANDS) {
      // ridge: quota della cima, per il vento che forma gli accumuli in cresta.
      const ridge = place.single ? place.elevations.valle : place.elevations.cima;
      points.push({ placeId: place.id, band: band.id, lat: place.lat, lon: place.lon, elev: place.elevations[band.id], ridge });
    }
  }
  return points;
}

// Variabili di riserva: se Open-Meteo va in errore con tutti i livelli del vento
// (succede: "Something went wrong"), si riprova con meno livelli. windAt in snow.js
// usa quello che c'è e in ultimo il vento a 700 hPa.
const FALLBACK_VARS = [
  HOURLY_VARS.filter((v) => !v.includes('600hPa')),
  HOURLY_VARS.filter((v) => !v.includes('600hPa') && !v.startsWith('wind_speed_10m') && !v.startsWith('wind_direction_10m')),
];

export function buildUrl(points, days = FORECAST_DAYS, vars = HOURLY_VARS) {
  const q = new URLSearchParams({
    latitude: points.map((p) => p.lat).join(','),
    longitude: points.map((p) => p.lon).join(','),
    elevation: points.map((p) => p.elev).join(','),
    hourly: vars.join(','),
    models: MODELS.map((m) => m.id).join(','),
    forecast_days: String(days),
    past_days: String(PAST_DAYS),
    timezone: 'Europe/Rome',
  });
  return `${API}?${q}`;
}

// Separa i giorni passati da quelli di previsione: la panoramica mostra solo da oggi.
function splitPast(point) {
  if (!point) return null;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());
  const past = point.days.filter((d) => d.date < today);
  const days = point.days.filter((d) => d.date >= today).slice(0, FORECAST_DAYS);
  return { past, days, total: totalRange(days), ...(point.now || {}) };
}

/** Scarica la previsione; se Open-Meteo risponde con un errore riprova con meno variabili. */
async function fetchForecast(points, days) {
  let lastErr = null;
  for (const vars of [HOURLY_VARS, ...FALLBACK_VARS]) {
    try {
      const res = await fetch(buildUrl(points, days, vars));
      if (!res.ok) throw new Error(`Open-Meteo ha risposto ${res.status}`);
      const raw = await res.json();
      if (raw?.error) throw new Error(`Open-Meteo: ${raw.reason}`);
      return raw;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// Riassunto di un punto: giorni (passati e futuri) e situazione "adesso".
const compactPoint = (raw, elev, ridge = elev) =>
  raw ? { days: summarizePoint(raw, elev, MODELS, Math.max(ridge ?? elev, elev)).days, now: pointNow(raw, elev) } : null;

function readCache(key) {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    return c && c.key === key ? c : null;
  } catch {
    return null;
  }
}

function writeCache(key, data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ key, fetchedAt: Date.now(), data }));
  } catch {
    /* spazio pieno o navigazione privata: si va avanti senza cache */
  }
}

/**
 * Restituisce { fetchedAt, stale, byPlace: { [id]: { [band]: summary } } }.
 * `force` ignora la cache recente. Se la rete non risponde usa l'ultima copia.
 */
export async function loadForecast(places, { force = false } = {}) {
  const points = buildPoints(places);
  const url = buildUrl(points);
  const cached = readCache(url);
  let points2 = null;
  let fetchedAt = null;
  let stale = false;

  if (!force && cached && Date.now() - cached.fetchedAt < MAX_AGE_MS) {
    points2 = cached.data;
    fetchedAt = cached.fetchedAt;
  } else {
    try {
      const raw = await fetchForecast(points, FORECAST_DAYS);
      const list = Array.isArray(raw) ? raw : [raw];
      points2 = points.map((p, i) => compactPoint(list[i], p.elev, p.ridge));
      fetchedAt = Date.now();
      writeCache(url, points2);
    } catch (err) {
      if (!cached) throw err;
      points2 = cached.data;
      fetchedAt = cached.fetchedAt;
      stale = true;
    }
  }

  const byPlace = {};
  points.forEach((p, i) => {
    byPlace[p.placeId] ??= {};
    byPlace[p.placeId][p.band] = splitPast(points2[i]);
  });
  return { fetchedAt, stale, byPlace };
}

// ---------- dettaglio di un posto: 10 giorni, una sola quota ----------

const DETAIL_KEY = 'mm.detail.v1';
const detailMemo = new Map();

/** Serie orarie per i grafici del posto alla quota scelta (cache di un'ora, solo l'ultimo posto). */
export async function loadDetail(place, band, { force = false } = {}) {
  const elev = place.elevations[band];
  const point = { lat: place.lat, lon: place.lon, elev };
  const url = buildUrl([point], DETAIL_DAYS);
  let raw = null;
  const memo = detailMemo.get(url);
  if (!force && memo && Date.now() - memo.fetchedAt < MAX_AGE_MS) raw = memo.data;
  if (!raw) {
    let stored = null;
    try {
      stored = JSON.parse(localStorage.getItem(DETAIL_KEY) || 'null');
    } catch {
      /* ignorato */
    }
    if (!force && stored?.key === url && Date.now() - stored.fetchedAt < MAX_AGE_MS) raw = stored.data;
    else {
      try {
        raw = await fetchForecast([point], DETAIL_DAYS);
        detailMemo.set(url, { fetchedAt: Date.now(), data: raw });
        try {
          localStorage.setItem(DETAIL_KEY, JSON.stringify({ key: url, fetchedAt: Date.now(), data: raw }));
        } catch {
          /* spazio pieno: resta solo in memoria */
        }
      } catch (err) {
        if (stored?.key !== url) throw err;
        raw = stored.data;
      }
    }
  }
  const one = Array.isArray(raw) ? raw[0] : raw;
  return { elev, series: chartSeries(one, elev, MODELS) };
}

// ---------- rapporto neve/acqua (metodo del PDF): profili in quota, solo per il posto aperto ----------

// MeteoSwiss CH2 non dà i livelli in quota, quindi resta fuori.
const SLR_MODELS = MODELS.filter((m) => m.id !== 'meteoswiss_icon_ch2').map((m) => m.id);
const SLR_KEY = 'mm.slr.v1';

function slrUrl(point, levels) {
  const q = new URLSearchParams({
    latitude: String(point.lat),
    longitude: String(point.lon),
    elevation: String(point.elev),
    hourly: slrVars(levels).join(','),
    models: SLR_MODELS.join(','),
    forecast_days: String(DETAIL_DAYS),
    timezone: 'Europe/Rome',
  });
  return `${API}?${q}`;
}

/**
 * { 'AAAA-MM-GG': rapporto } per il posto alla quota scelta (cache di un'ora).
 * Se Open-Meteo non risponde restituisce {}: l'app usa la stima semplice.
 */
export async function loadSlr(place, band, { force = false } = {}) {
  const point = { lat: place.lat, lon: place.lon, elev: place.elevations[band] };
  const key = slrUrl(point, SLR_LEVELS);
  try {
    const c = JSON.parse(localStorage.getItem(SLR_KEY) || 'null');
    if (!force && c?.key === key && Date.now() - c.fetchedAt < MAX_AGE_MS) return c.data;
  } catch {
    /* ignorato */
  }
  // Se va in errore con tutti i livelli si riprova senza 850 e 400 hPa.
  for (const levels of [SLR_LEVELS, [700, 600, 500]]) {
    try {
      const res = await fetch(slrUrl(point, levels));
      if (!res.ok) continue;
      const raw = await res.json();
      if (raw?.error) continue;
      const data = dailySlr(Array.isArray(raw) ? raw[0] : raw, point.elev, SLR_MODELS, levels);
      try {
        localStorage.setItem(SLR_KEY, JSON.stringify({ key, fetchedAt: Date.now(), data }));
      } catch {
        /* spazio pieno */
      }
      return data;
    } catch {
      /* si riprova */
    }
  }
  return {};
}
