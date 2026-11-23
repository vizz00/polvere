// Grado di pericolo valanghe ufficiale per micro-zona, dai bollettini EAWS.
//
// Fonte unica e aperta (CC BY 4.0) per AINEVA (Valle d'Aosta, Piemonte, Lombardia),
// SLF (Svizzera) e gli altri servizi europei:
//   https://static.avalanche.report/eaws_bulletins/eaws_bulletins/<giorno>/<giorno>-<regione>.it.json
// Confini delle micro-zone (per i posti senza zona fissa):
//   https://regions.avalanches.org/micro-regions/<regione>_micro-regions.geojson.json
//
// Qui si leggono solo i valori ufficiali: grado, quota limite, mattino/pomeriggio,
// problemi valanghivi. Nessuna interpretazione.

const BULLETIN_BASE = 'https://static.avalanche.report/eaws_bulletins/eaws_bulletins';
const REGIONS_BASE = 'https://regions.avalanches.org';
const CACHE_KEY = 'mm.avalanche.v2';
const ZONE_CACHE_KEY = 'mm.avalanche-zones.v1';
const MAX_AGE_MS = 30 * 60 * 1000; // i bollettini escono verso le 17 e (SLF) alle 8

// Scala europea a 5 gradi, nomi ufficiali italiani.
export const DANGER = {
  low: { level: 1, label: 'Debole' },
  moderate: { level: 2, label: 'Moderato' },
  considerable: { level: 3, label: 'Marcato' },
  high: { level: 4, label: 'Forte' },
  very_high: { level: 5, label: 'Molto forte' },
  no_snow: { level: 0, label: 'Senza neve' },
  no_rating: { level: null, label: 'Non valutato' },
};

// Tipi di problema valanghivo EAWS, nomi ufficiali italiani.
export const PROBLEMS = {
  new_snow: 'Neve fresca',
  wind_slab: 'Neve ventata',
  persistent_weak_layers: 'Strati deboli persistenti',
  wet_snow: 'Neve bagnata',
  gliding_snow: 'Valanghe di slittamento',
  cornices: 'Cornici',
  no_distinct_problem: 'Nessun problema evidente',
  favourable_situation: 'Situazione favorevole',
};

const PERIODS = { all_day: 'Tutto il giorno', earlier: 'Mattino', later: 'Pomeriggio' };
const ASPECT_ORDER = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const ASPECT_IT = { N: 'N', NE: 'NE', E: 'E', SE: 'SE', S: 'S', SW: 'SO', W: 'O', NW: 'NO' };

// ---------- date ----------

// Giorno del calendario in Italia (YYYY-MM-DD): i bollettini sono archiviati per giorno di validità.
export function romeDate(date = new Date(), addDays = 0) {
  const d = new Date(date.getTime() + addDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// lang 'it' esiste per AINEVA, SLF e altri; alcuni servizi (es. Francia) hanno solo il file senza lingua.
export function bulletinUrl(day, region, lang = 'it') {
  return `${BULLETIN_BASE}/${day}/${day}-${region}${lang ? `.${lang}` : ''}.json`;
}

// Cartine ufficiali AINEVA (immagini pubblicate col bollettino, stesse del sito bollettini.aineva.it).
// fd = giorno intero; am/pm = mattino/pomeriggio quando il bollettino li separa.
const AINEVA_FILES = 'https://bollettini.aineva.it/albina_files';
export const AINEVA_REGIONS = ['IT-21', 'IT-23', 'IT-25', 'IT-32-BZ', 'IT-32-TN', 'IT-34', 'IT-36', 'IT-57'];
export const isAineva = (region) => AINEVA_REGIONS.includes(region);
export function ainevaMapUrl(day, region, period = 'fd', ext = 'webp') {
  return `${AINEVA_FILES}/${day}/${period}_${region}_map.${ext}`;
}
// Cartina della singola area del bollettino (la zona del posto e quelle con lo stesso grado).
export function ainevaBulletinMapUrl(day, region, bulletinId, ext = 'webp') {
  return `${AINEVA_FILES}/${day}/${region}_${bulletinId}.${ext}`;
}

// Codici dei servizi EAWS quando differiscono da quello della regione salvata nel posto.
const PROVIDER_ALIAS = { DE: 'DE-BY' };
export const providerCode = (region) => PROVIDER_ALIAS[region] || region;

// ---------- lettura del bollettino ----------

// Il bollettino che copre la micro-zona; se ce ne sono più di uno (es. aggiornamento SLF del mattino)
// vale quello pubblicato per ultimo.
export function findBulletin(json, zoneId) {
  const list = (json?.bulletins || []).filter((b) => (b.regions || []).some((r) => r.regionID === zoneId));
  list.sort((a, b) => String(b.publicationTime).localeCompare(String(a.publicationTime)));
  return list[0] || null;
}

function boundText(v) {
  if (v == null || v === '') return null;
  if (v === 'treeline') return 'limite del bosco';
  const n = Number(v);
  return Number.isFinite(n) ? `${n} m` : String(v);
}

// "sopra 2400 m", "sotto il limite del bosco", "tra 1800 e 2400 m", "tutte le quote"
export function elevationText(elev) {
  const lo = boundText(elev?.lowerBound);
  const up = boundText(elev?.upperBound);
  if (lo && up) return `tra ${lo.replace(/ m$/, '')} e ${up}`;
  if (lo) return lo === 'limite del bosco' ? 'sopra il limite del bosco' : `sopra ${lo}`;
  if (up) return up === 'limite del bosco' ? 'sotto il limite del bosco' : `sotto ${up}`;
  return 'tutte le quote';
}

// Quota numerica usata solo per ordinare le righe dall'alto al basso.
function sortKey(elev) {
  const n = (v) => (v === 'treeline' ? 2000 : Number(v));
  if (elev?.lowerBound != null) return n(elev.lowerBound) + 1;
  if (elev?.upperBound != null) return n(elev.upperBound) - 1;
  return 0;
}

// Testi dei previsori: i tag HTML (SLF) diventano interruzioni, i doppi spazi separano i paragrafi.
export function cleanText(v) {
  if (typeof v !== 'string') return [];
  return v
    .replace(/<[^>]*>/g, '  ')
    .replace(/&nbsp;/g, ' ')
    .split(/\s{2,}|\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

const SMALL = new Set(['e', 'di', 'del', 'della', 'dello', 'dei', 'delle', 'da', 'a', 'in', 'la', 'le', 'il', 'al', 'ai']);
// "D - CERVINIA E ALTA VALPELLINE" -> "Cervinia e Alta Valpelline"
export function zoneLabel(name) {
  const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
  return String(name || '')
    .replace(/^[A-Z]\s+-\s+/, '')
    .toLowerCase()
    .split(/\s+/)
    .map((w, i) =>
      w
        .split(/([-'’])/)
        .map((part, j) => ((i > 0 && j === 0 && SMALL.has(part)) || (j === 0 && part.length === 1 && /['’]/.test(w[1] || '')) ? part : /^[-'’]$/.test(part) ? part : cap(part)))
        .join(''),
    )
    .join(' ');
}

// Le 10 situazioni tipo AINEVA ("DP6" nel file = st.6). Nomi noti con certezza; gli altri restano solo "st.N".
export const SITUAZIONI_TIPO = { 6: 'neve a debole coesione e vento' };
export const dangerPatternNumber = (code) => {
  const m = /^DP\s*(\d+)$/i.exec(String(code));
  return m ? Number(m[1]) : null;
};

const TENDENCY = { decreasing: 'in diminuzione', steady: 'stabile', increasing: 'in aumento' };
const FREQUENCY = { few: 'pochi pendii', some: 'alcuni pendii', many: 'molti pendii' };
const STABILITY = { good: 'buona', fair: 'discreta', poor: 'scarsa', very_poor: 'molto scarsa' };
const SIZE = { 1: 'piccole', 2: 'medie', 3: 'grandi', 4: 'molto grandi', 5: 'eccezionali' };

const SUBDIVISION = { plus: '+', minus: '−', neutral: '=' };

function ratingRow(r) {
  const d = DANGER[r.mainValue] || { level: null, label: r.mainValue || 'n.d.' };
  const sub = SUBDIVISION[r.customData?.CH?.subdivision] || '';
  return { key: r.mainValue, level: d.level, label: d.label, sub, where: elevationText(r.elevation), sort: sortKey(r.elevation) };
}

function aspectsText(list) {
  if (!list?.length) return '';
  if (list.length >= 8) return 'tutte le esposizioni';
  return ASPECT_ORDER.filter((a) => list.includes(a)).map((a) => ASPECT_IT[a]).join(' ');
}

// Riassunto per la micro-zona: solo i campi ufficiali, pronti da mostrare.
export function summarizeBulletin(json, zoneId) {
  const b = findBulletin(json, zoneId);
  if (!b) return null;
  const ratings = b.dangerRatings || [];
  const hasSplit = ratings.some((r) => r.validTimePeriod === 'earlier' || r.validTimePeriod === 'later');
  const periodIds = hasSplit ? ['earlier', 'later'] : ['all_day'];
  const periods = periodIds
    .map((p) => ({
      id: p,
      label: PERIODS[p],
      rows: ratings
        .filter((r) => (r.validTimePeriod || 'all_day') === p || (hasSplit && (r.validTimePeriod || 'all_day') === 'all_day'))
        .map(ratingRow)
        .sort((x, y) => y.sort - x.sort),
    }))
    .filter((p) => p.rows.length);
  const levels = periods.flatMap((p) => p.rows.map((r) => r.level)).filter((l) => l != null);
  const zone = b.regions.find((r) => r.regionID === zoneId);
  return {
    zoneId,
    zoneName: zone?.name && zone.name !== zoneId ? zone.name : null,
    day: b.customData?.ALBINA?.mainDate || null,
    bulletinId: b.bulletinID,
    publicationTime: b.publicationTime || null,
    validFrom: b.validTime?.startTime || null,
    validTo: b.validTime?.endTime || null,
    unscheduled: !!b.unscheduled,
    provider: b.source?.provider?.name || null,
    providerUrl: b.source?.provider?.website || null,
    max: levels.length ? Math.max(...levels) : null,
    periods,
    // Testi del previsore (quando il servizio li pubblica: AINEVA e SLF)
    headline: cleanText(b.avalancheActivity?.highlights),
    activity: cleanText(b.avalancheActivity?.comment),
    snowpack: cleanText(b.snowpackStructure?.comment),
    weather: cleanText(b.weatherForecast?.comment),
    tendency: (b.tendency || [])[0]
      ? {
          type: b.tendency[0].tendencyType || null,
          label: TENDENCY[b.tendency[0].tendencyType] || null,
          text: cleanText(b.tendency[0].highlights || b.tendency[0].comment),
          day: b.tendency[0].validTime?.startTime ? romeDate(new Date(b.tendency[0].validTime.startTime), 0) : null,
        }
      : null,
    patterns: (b.customData?.LWD_Tyrol?.dangerPatterns || []).map(dangerPatternNumber).filter((n) => n != null),
    zones: (b.regions || []).map((r) => zoneLabel(r.name)).filter(Boolean).sort((x, y) => x.localeCompare(y, 'it')),
    problems: (b.avalancheProblems || []).map((p) => ({
      size: SIZE[p.avalancheSize] || null,
      sizeN: p.avalancheSize || null,
      frequency: FREQUENCY[p.frequency] || null,
      stability: STABILITY[p.snowpackStability] || null,
      note: cleanText(p.comment),
      type: p.problemType,
      label: PROBLEMS[p.problemType] || p.problemType,
      where: elevationText(p.elevation),
      aspects: aspectsText(p.aspects),
      aspectList: p.aspects || [],
      elevation: p.elevation || null,
      period: p.validTimePeriod && p.validTimePeriod !== 'all_day' ? PERIODS[p.validTimePeriod] : null,
    })),
  };
}

// ---------- micro-zona da coordinate ----------

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygon(x, y, rings) {
  return inRing(x, y, rings[0]) && !rings.slice(1).some((h) => inRing(x, y, h));
}

// Le micro-zone cambiano nel tempo: il file contiene anche quelle vecchie con start_date/end_date.
function validOn(props, day) {
  return (!props.start_date || props.start_date <= day) && (!props.end_date || props.end_date > day);
}

export function zoneInGeojson(geojson, lat, lon, day = romeDate()) {
  for (const f of geojson?.features || []) {
    if (!f.geometry || !validOn(f.properties || {}, day)) continue;
    const g = f.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    if (polys.some((p) => inPolygon(lon, lat, p))) return f.properties.id;
  }
  return null;
}

// Con poco segnale una richiesta può restare appesa: oltre 20 secondi si rinuncia
// (e si usa l'ultima copia salvata del bollettino).
function fetchTimeout(url, opts = {}, ms = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

const memo = new Map();
async function getJson(url) {
  if (!memo.has(url)) {
    memo.set(
      url,
      fetchTimeout(url).then((r) => {
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
        return r.json();
      }),
    );
  }
  try {
    return await memo.get(url);
  } catch (err) {
    memo.delete(url);
    throw err;
  }
}

function readStore(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}
function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignorato */
  }
}

// Micro-zona EAWS che contiene il punto. Restituisce { id, name } oppure null.
// `region` è il codice EAWS del servizio (IT-23, IT-21, IT-25, CH, FR, AT-07, IT-32-BZ…).
export async function zoneForPoint(lat, lon, region) {
  const cacheKey = `${region}:${lat.toFixed(4)},${lon.toFixed(4)}`;
  const cache = readStore(ZONE_CACHE_KEY) || {};
  if (cache[cacheKey]) return cache[cacheKey];
  if (!region || region === 'ALTRO') return null;
  let geo = null;
  try {
    geo = await getJson(`${REGIONS_BASE}/micro-regions/${providerCode(region)}_micro-regions.geojson.json`);
  } catch (err) {
    console.warn(err); // zona non coperta da EAWS
    return null;
  }
  const id = geo ? zoneInGeojson(geo, lat, lon) : null;
  if (!id) return null;
  let name = null;
  try {
    const names = await getJson(`${REGIONS_BASE}/micro-regions_names/it.json`);
    name = names?.[id] || null;
  } catch {
    /* il nome è facoltativo */
  }
  const zone = { id, name };
  writeStore(ZONE_CACHE_KEY, { ...cache, [cacheKey]: zone });
  return zone;
}

async function zoneForPlace(place) {
  if (place.avalancheZone) return { id: place.avalancheZone, name: place.avalancheZoneName || null };
  if (!place.region || place.lat == null || place.lon == null) return null;
  return zoneForPoint(place.lat, place.lon, place.region);
}

// ---------- caricamento per tutti i posti ----------

// Per ogni posto: micro-zona, bollettino di oggi e (dopo le 17 circa) di domani.
// Risultato: { fetchedAt, today, tomorrow, byPlace: { [id]: { zone, today, tomorrow, error } } }
export async function loadAvalanche(places, { force = false, day = null } = {}) {
  const today = day || romeDate();
  const tomorrow = romeDate(new Date(`${today}T12:00:00Z`), 1);
  const key = `${today}|${places.map((p) => `${p.id}:${p.region}:${p.avalancheZone || `${p.lat},${p.lon}`}`).join(';')}`;
  const cached = readStore(CACHE_KEY);
  if (!force && cached?.key === key && Date.now() - cached.fetchedAt < MAX_AGE_MS) return cached;

  const files = new Map(); // `${giorno}|${regione}` -> json | null
  const file = (d, region) => {
    const k = `${d}|${region}`;
    if (!files.has(k)) {
      const code = providerCode(region);
      files.set(k, getJsonFresh(bulletinUrl(d, code)).then((j) => j ?? getJsonFresh(bulletinUrl(d, code, ''))));
    }
    return files.get(k);
  };

  const byPlace = {};
  let anyOk = false;
  await Promise.all(
    places.map(async (place) => {
      const entry = { zone: null, today: null, tomorrow: null, error: null };
      byPlace[place.id] = entry;
      try {
        entry.zone = await zoneForPlace(place);
        if (!entry.zone) return;
        const [a, b] = await Promise.all([file(today, place.region), day ? null : file(tomorrow, place.region)]);
        entry.today = a ? summarizeBulletin(a, entry.zone.id) : null;
        entry.tomorrow = b ? summarizeBulletin(b, entry.zone.id) : null;
        if (!entry.zone.name) entry.zone.name = entry.today?.zoneName || entry.tomorrow?.zoneName || null;
        anyOk = true;
      } catch (err) {
        console.error(err);
        entry.error = 'Non riesco a scaricare il bollettino.';
      }
    }),
  );

  const result = { key, fetchedAt: Date.now(), today, tomorrow: day ? null : tomorrow, byPlace };
  if (!day && anyOk) writeStore(CACHE_KEY, result);
  if (!anyOk && cached?.byPlace && !day) return { ...cached, stale: true };
  return result;
}

// I bollettini si aggiornano: niente memo tra un caricamento e l'altro.
async function getJsonFresh(url) {
  const r = await fetchTimeout(url, { cache: 'no-cache' });
  if (r.status === 404 || r.status === 403) return null; // nessun bollettino per quel giorno
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}
