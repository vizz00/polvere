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
  // Sempre nello stesso ordine (per id): mettere una stella o riordinare i posti non cambia
  // la richiesta, così la copia salvata resta valida (anche senza rete).
  for (const place of [...places].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
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

export function buildUrl(points, days = FORECAST_DAYS, vars = HOURLY_VARS, pastDays = PAST_DAYS) {
  const q = new URLSearchParams({
    latitude: points.map((p) => p.lat).join(','),
    longitude: points.map((p) => p.lon).join(','),
    elevation: points.map((p) => p.elev).join(','),
    hourly: vars.join(','),
    models: MODELS.map((m) => m.id).join(','),
    forecast_days: String(days),
    past_days: String(pastDays),
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

// Con poco segnale una richiesta può restare appesa a lungo: oltre questo tempo si rinuncia
// e si usa l'ultima copia salvata.
const NET_TIMEOUT_MS = 25000;

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), NET_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const raw = await res.json().catch(() => null);
    // Errore di Open-Meteo (risposta arrivata): si può riprovare con meno variabili.
    if (!res.ok || raw?.error) throw Object.assign(new Error(`Open-Meteo: ${raw?.reason || res.status}`), { server: true });
    return raw;
  } finally {
    clearTimeout(timer);
  }
}

/** Scarica la previsione; se Open-Meteo risponde con un errore riprova con meno variabili. */
async function fetchForecast(points, days, pastDays = PAST_DAYS) {
  let lastErr = null;
  for (const vars of [HOURLY_VARS, ...FALLBACK_VARS]) {
    try {
      return await fetchJson(buildUrl(points, days, vars, pastDays));
    } catch (err) {
      lastErr = err;
      // Senza rete (o rete troppo lenta) riprovare non serve: si passa subito alla copia salvata.
      if (!err.server) break;
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

// Chiave di un punto: serve a ritrovarlo nella copia salvata anche se l'elenco dei posti è cambiato.
const pointKey = (p) => `${p.placeId}|${p.band}|${p.elev}|${p.ridge}`;

// Copia salvata per i punti richiesti, anche se fatta con un elenco di posti diverso:
// i posti che non c'erano restano vuoti. Null se non c'è nessun punto in comune.
function fromAnyCache(points) {
  let c = null;
  try {
    c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
  } catch {
    return null;
  }
  if (!c?.points || !Array.isArray(c.data)) return null;
  const at = new Map(c.points.map((k, i) => [k, c.data[i]]));
  const data = points.map((p) => at.get(pointKey(p)) ?? null);
  return data.some(Boolean) ? { fetchedAt: c.fetchedAt, data } : null;
}

function writeCache(key, data, points) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ key, fetchedAt: Date.now(), points: points.map(pointKey), data }));
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
      writeCache(url, points2, points);
    } catch (err) {
      // Senza rete: l'ultima copia, anche se fatta prima di aggiungere o togliere un posto.
      const any = cached || fromAnyCache(points);
      if (!any) throw err;
      points2 = any.data;
      fetchedAt = any.fetchedAt;
      stale = true;
    }
  }
  return assemble(points, points2, fetchedAt, stale);
}

/**
 * Ultima previsione salvata, senza rete e di qualsiasi età (null se non c'è).
 * Serve a mostrare subito qualcosa all'apertura mentre si scarica quella nuova.
 */
export function cachedForecast(places) {
  const points = buildPoints(places);
  const any = readCache(buildUrl(points)) || fromAnyCache(points);
  return any ? assemble(points, any.data, any.fetchedAt, false) : null;
}

function assemble(points, points2, fetchedAt, stale) {
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
  // I grafici partono da adesso: i giorni passati non servono (download più leggero).
  const url = buildUrl([point], DETAIL_DAYS, HOURLY_VARS, 0);
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
        raw = await fetchForecast([point], DETAIL_DAYS, 0);
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
