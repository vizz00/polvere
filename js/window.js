// "Prossimi 3 giorni": i segnali di pericolo di oggi, domani e dopodomani (neve fresca, accumuli,
// pioggia, niente rigelo, primo sole) e, senza pericoli, se il meteo è buono per uscire.
// Ogni numero è quello su cui i modelli meteo sono d'accordo: un modello che "spara" da solo non conta.
//
// Calcoli puri (nessun DOM, nessuna rete), provati con `node --test`.
// Le regole e le soglie vengono da:
// - SLF, "Achtung Lawinen!" (2022): neve fresca critica in 3 giorni, vento forte > 40 km/h,
//   accumuli di neve ventata (più pericolosi durante e subito dopo il vento), pioggia, riscaldamento, rigelo.
// - EAWS, problemi valanghivi tipici; avalanche.report, i 10 Gefahrenmuster (gm.3, gm.6, gm.10).
// Il bollettino ufficiale, quando c'è, decide il segno del giorno.

export const RULES = {
  // Neve fresca: peso dei giorni (oggi, ieri, 2 giorni fa). Il peso è una scelta nostra:
  // la neve nuova è più pericolosa durante e subito dopo la nevicata, poi si assesta (EAWS).
  snowWeights: [1, 1, 0.5],
  // Neve fresca critica SLF in 1-3 giorni (cm): intervallo [basso, alto].
  // Sotto il basso nessun segnale, dentro l'intervallo ▲, oltre l'alto ✕.
  // Con vento debole il rosso parte da 40 cm (SLF dice 50: scelta di Riccardo, più prudente).
  critical: { sfavorevoli: [10, 20], medie: [20, 30], favorevoli: [30, 40] },
  strongWind: 40, // km/h mentre nevica: "vento forte" SLF, condizioni sfavorevoli
  moderateWind: 20, // km/h mentre nevica: sotto questo il vento è debole (condizioni favorevoli)
  coldUnfavorable: -7, // °C mentre nevica: freddo che rende sfavorevole la nevicata (SLF: −5/−10)
  snowDay: 1, // cm: un giorno con meno neve conta come secco
  dryBefore: 5, // giorni secchi prima della nevicata: fondo debole (SLF), al massimo ▲
  // Accumuli: neve soffice degli ultimi 7 giorni che il vento può spostare.
  softDays: 7,
  softSnow: 10, // cm di neve soffice perché il vento formi accumuli
  transportWind: 30, // km/h di vento in cresta che sposta la neve in quantità
  warmDay: 3, // °C di massima che fanno crosta e azzerano la neve soffice
  rainMm: 2, // mm di pioggia alla quota in un giorno
  warmingSnow: 10, // cm caduti nei 2 giorni prima del primo sole
  sunnyCloud: 40, // % nuvolosità diurna sotto cui il giorno è "sereno"
  okWind: 30, // km/h: vento alla quota del posto accettabile per uscire
  days: 3, // segni e segnali solo per oggi, domani e dopodomani: più in là la previsione è troppo incerta
  // Modelli d'accordo: due modelli stanno nello stesso gruppo se non sono più lontani di così.
  windGap: 15, // km/h
  tempGap: 3, // °C
};

export const SECTORS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];

const sectorIndex = (deg) => Math.round((((deg % 360) + 360) % 360) / 45) % 8;

/** Versanti sottovento (caricati) per un vento che arriva da `deg`: il settore opposto e i due accanto. */
export function leeSectors(deg) {
  if (deg == null) return [];
  const c = sectorIndex(deg + 180);
  return [c - 1, c, c + 1].map((i) => SECTORS[(i + 8) % 8]);
}

/** Media circolare di direzioni in gradi. */
export function meanDirection(degs) {
  const v = degs.filter((d) => d != null);
  if (!v.length) return null;
  let x = 0;
  let y = 0;
  for (const d of v) {
    x += Math.sin((d * Math.PI) / 180);
    y += Math.cos((d * Math.PI) / 180);
  }
  return (((Math.atan2(x, y) * 180) / Math.PI) + 360) % 360;
}

// Esposizioni del bollettino (inglese EAWS) → settori italiani.
const EN_TO_IT = { N: 'N', NE: 'NE', E: 'E', SE: 'SE', S: 'S', SW: 'SO', W: 'O', NW: 'NO' };

const boundM = (v) => (v === 'treeline' ? 2000 : v == null || v === '' ? null : Number(v));

/** Il problema del bollettino riguarda questa quota? */
export function problemAtElevation(problem, elev) {
  const lo = boundM(problem.elevation?.lowerBound);
  const up = boundM(problem.elevation?.upperBound);
  if (lo != null && elev < lo) return false;
  if (up != null && elev > up) return false;
  return true;
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const median = (xs) => {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

// Notte senza rigelo: minima sopra 2 °C, o sopra 0 °C con notte coperta.
const noRefreeze = (m) => m.tNightMin != null && (m.tNightMin > 2 || (m.tNightMin > 0 && (m.nightCloud ?? 0) >= 60));
// Giorno che rende la neve dura (non più trasportabile): pioggia, caldo, niente rigelo.
const hardens = (m) => (m.rain ?? 0) >= RULES.rainMm || (m.tMax ?? -99) >= RULES.warmDay || noRefreeze(m);

/** Neve soffice disponibile alla fine del giorno `k`: neve degli ultimi 7 giorni dopo l'ultimo giorno che l'ha indurita. */
function softSnowAt(days, k, id) {
  let soft = 0;
  for (let j = Math.max(0, k - RULES.softDays + 1); j <= k; j++) {
    const m = days[j]?.models[id];
    if (!m) continue;
    if (hardens(m)) soft = 0;
    if ((m.rain ?? 0) < RULES.rainMm) soft += m.snow ?? 0;
  }
  return soft;
}

/**
 * Valore su cui i modelli sono d'accordo.
 * I valori in fila formano gruppi: un modello entra nel gruppo se è vicino al precedente (`gap`).
 * Conta il gruppo più numeroso (a parità, il più alto: per prudenza); il risultato è la sua media.
 * Un modello che "spara" da solo resta in un gruppo a parte e non conta.
 */
export function agreed(values, gap) {
  const v = values.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const groups = [[v[0]]];
  for (let i = 1; i < v.length; i++) {
    if (v[i] - v[i - 1] > gap(v[i - 1], v[i])) groups.push([]);
    groups.at(-1).push(v[i]);
  }
  const best = groups.reduce((g, x) => (x.length >= g.length ? x : g));
  return sum(best) / best.length;
}
const windGap = () => RULES.windGap;
// Neve e pioggia: lontani se differiscono di più di metà del valore più alto (almeno 5 cm / 2 mm).
const halfGap = (min) => (a, b) => Math.max(min, b / 2);
const tempGap = () => RULES.tempGap;
/** Sì/no: vale se lo vede almeno metà dei modelli. */
const most = (evals, key) => evals.length > 0 && evals.filter((e) => e[key]).length / evals.length >= 0.5;

const round5 = (x) => Math.round(x / 5) * 5;
const cm = (x) => (x < 10 ? Math.round(x) : round5(x));
const mm = (x) => (Math.round(x * 2) / 2).toString().replace('.', ',');
const SECTOR_NAME = { N: 'nord', NE: 'nord-est', E: 'est', SE: 'sud-est', S: 'sud', SO: 'sud-ovest', O: 'ovest', NO: 'nord-ovest' };
const HOW = { sfavorevoli: null, medie: 'con vento medio', favorevoli: 'con vento debole' };

/** Valuta un modello per il giorno `index` della lista continua `days` (passati + previsione). */
function evaluateModel(days, index, id, elev) {
  const today = days[index].models[id];
  if (!today) return null;
  const at = (k) => (k >= 0 ? days[k]?.models[id] : null);

  // --- Neve fresca (SLF): oggi e ieri per intero, 2 giorni fa per metà.
  const span = [0, 1, 2].map((back) => at(index - back));
  const snowW = span.reduce((t, m, back) => t + (m?.snow ?? 0) * RULES.snowWeights[back], 0);
  const snow3 = sum(span.map((m) => m?.snow ?? 0));
  // Condizioni solo dai giorni in cui nevicava.
  const snowy = span.filter((m) => m && m.snow >= RULES.snowDay);
  // Vento in cresta (quota della cima del posto): è lì che la neve viene spostata e pressata.
  const ridge = (m) => m?.ridgeWindMax ?? m?.windMax ?? 0;
  const windSnow = snowy.length ? Math.max(...snowy.map(ridge)) : 0;
  const tSnow = snowy.length ? Math.min(...snowy.map((m) => m.tSnow ?? m.tMin ?? 0)) : 0;
  // Fondo debole: almeno 5 giorni secchi prima del primo giorno di neve (SLF: vecchia superficie incoerente).
  let first = -1;
  for (let back = 2; back >= 0; back--) if ((span[back]?.snow ?? 0) >= RULES.snowDay) { first = index - back; break; }
  let dry = 0;
  if (first >= 0) for (let k = first - 1; k >= 0 && at(k) && (at(k).snow ?? 0) < RULES.snowDay; k--) dry++;

  // --- Accumuli: vento in cresta (oggi o ieri) su almeno 10 cm di neve soffice, durante o dopo la nevicata.
  const transport = [0, 1]
    .map((back) => ({ k: index - back, m: at(index - back) }))
    .filter(({ k, m }) => m && m.transportDir != null && softSnowAt(days, k, id) >= RULES.softSnow)
    .sort((x, y) => ridge(y.m) - ridge(x.m))[0] || null;

  const before = days.slice(Math.max(0, index - 2), index).map((d) => d.models[id]).filter(Boolean);
  const snowBefore = sum(before.map((m) => m.snow));
  const sunny = today.cloud != null && today.cloud < RULES.sunnyCloud;

  return {
    snow3,
    snowW,
    windSnow,
    tSnow,
    weakBase: dry >= RULES.dryBefore,
    slabWind: transport ? ridge(transport.m) : 0,
    transportDir: transport?.m.transportDir ?? null,
    slabYesterday: transport != null && transport.k < index,
    rain: today.rain ?? 0,
    firstSun: snowBefore >= RULES.warmingSnow && sunny && (today.tMax ?? -99) >= 0,
    noRefreeze: noRefreeze(today),
    sunny,
    calm: today.windMax != null && today.windMax < RULES.okWind,
    freezingOk: today.freezingMax != null ? today.freezingMax < elev : today.tMax != null && today.tMax <= 1,
    cloud: today.cloud,
    windMax: today.windMax,
    freezingMax: today.freezingMax,
  };
}

/**
 * Pericoli del giorno `index` di `days` (lista continua: giorni passati + previsione).
 * Ogni numero (neve, vento, pioggia) è quello su cui i modelli sono d'accordo.
 * opzioni:
 *  - aspects: versanti scelti dall'utente per il posto (es. ['N','NE']); se vuoto vale per tutti
 *  - bulletin: riassunto del bollettino di quel giorno (summarizeBulletin) o null
 * Restituisce { status, weatherOk, noBulletin, conditions, signals, loaded, slabSource, snow3 }.
 * status: 'aperta' (nessun pericolo, meteo buono) | 'avvisi' | 'chiusa' | 'meteo' (nessun pericolo, meteo non buono) | 'nd'
 * signals: [{ id, level: 'chiusa' | 'avviso' | 'info', text, icon, value }]
 * Il bollettino, quando c'è, decide il segno: grado 4-5 ✕, grado 3 almeno ▲; i nostri segnali arrivano al massimo a ▲.
 */
export function evaluateDay(days, index, elev, { aspects = [], bulletin = null } = {}) {
  const ids = Object.keys(days[index]?.models || {});
  const evals = ids.map((id) => evaluateModel(days, index, id, elev)).filter(Boolean);
  if (!evals.length) return { status: 'nd', conditions: [], signals: [], loaded: [], closedOn: [], snow3: null };

  const pick = (key, gap) => agreed(evals.map((e) => e[key]), gap);
  const snow3 = pick('snow3', halfGap(5));
  const signals = [];
  const add = (id, level, text, icon, value) => signals.push({ id, level, text, icon, value });

  // 1. Neve fresca critica (SLF): dentro l'intervallo ▲, oltre il limite alto ✕.
  const snowW = pick('snowW', halfGap(5));
  if (snowW >= RULES.snowDay) {
    const windSnow = pick('windSnow', windGap);
    const tSnow = pick('tSnow', tempGap);
    const cond = windSnow >= RULES.strongWind || tSnow <= RULES.coldUnfavorable
      ? 'sfavorevoli'
      : windSnow >= RULES.moderateWind ? 'medie' : 'favorevoli';
    const how = HOW[cond] || (windSnow >= RULES.strongWind ? 'con vento forte' : 'con gran freddo');
    const [lo, hi] = RULES.critical[cond];
    const head = `Neve ultimi 3 giorni: ${cm(snowW)} cm`;
    if (snowW > hi) add('critical', 'chiusa', `${head}|caduta ${how}, oltre i ${hi} cm critici`, 'snow', `${cm(snowW)} cm`);
    else if (snowW >= lo) add('critical', 'avviso', `${head}|caduta ${how}, vicino alla soglia critica (${lo}-${hi} cm)`, 'snow', `${cm(snowW)} cm`);
    else if (most(evals, 'weakBase') && snowW >= RULES.critical.sfavorevoli[0]) {
      add('weakBase', 'avviso', `${head}|su un fondo rimasto secco per ${RULES.dryBefore} giorni o più: può legarsi male`, 'snow', `${cm(snowW)} cm`);
    }
  }

  // 2. Accumuli: vento oltre 30 km/h su neve soffice. Versanti dal bollettino se segnala neve ventata.
  let loaded = [];
  let slabSource = null;
  const slabProblem = bulletin?.problems?.find((p) => p.type === 'wind_slab' && problemAtElevation(p, elev));
  if (slabProblem) {
    loaded = slabProblem.aspectList.length ? slabProblem.aspectList.map((a) => EN_TO_IT[a] || a) : [...SECTORS];
    slabSource = 'bollettino';
  }
  const slabWind = pick('slabWind', windGap);
  if (slabWind >= RULES.transportWind) {
    const near = evals.filter((e) => e.transportDir != null && Math.abs(e.slabWind - slabWind) <= RULES.windGap);
    const dir = meanDirection(near.map((e) => e.transportDir));
    if (!slabSource) {
      loaded = leeSectors(dir);
      slabSource = 'modelli';
    }
    const from = SECTOR_NAME[SECTORS[sectorIndex(dir)]];
    const where = loaded.length === 8 ? 'su tutti i versanti' : `a ${loaded.map((x) => SECTOR_NAME[x]).join(', ')}`;
    const mine = !aspects.length || loaded.some((x) => aspects.includes(x));
    const when = near.filter((e) => e.slabYesterday).length > near.length / 2 ? 'Ieri vento' : 'Vento';
    add('windSlab', mine ? 'avviso' : 'info', `${when} oltre 30 km/h da ${from}|circa ${Math.round(slabWind)} km/h: possibili accumuli ${where}`, 'wind', `${Math.round(slabWind)}`);
  }

  // 3. Pioggia su neve.
  const rain = pick('rain', halfGap(2));
  if (rain >= RULES.rainMm) add('rain', 'chiusa', `Pioggia: ${mm(rain)} mm|alla quota, la neve si appesantisce e perde coesione`, 'rain', `${mm(rain)} mm`);

  // 4. Niente rigelo notturno.
  if (most(evals, 'noRefreeze')) add('noRefreeze', 'chiusa', 'Notte sopra 0 °C|niente rigelo, neve molle già dal mattino', 'warm', '');

  // 5. Primo sole forte dopo una nevicata.
  if (most(evals, 'firstSun')) add('firstSun', 'avviso', 'Primo sole dopo la nevicata|meglio il mattino, attenzione ai versanti al sole', 'sun', '');

  // 6. Bollettino: con il bollettino i nostri segnali arrivano al massimo a ▲; il segno minimo lo dà lui.
  let floor = null;
  if (bulletin?.max != null) {
    for (const s of signals) if (s.level === 'chiusa') s.level = 'avviso';
    if (bulletin.max >= 4) floor = 'chiusa';
    else if (bulletin.max === 3) floor = 'avvisi';
  }

  // Condizioni meteo per uscire.
  const med = (k) => median(evals.map((e) => e[k]));
  const conditions = [
    { id: 'sun', label: 'sole', ok: most(evals, 'sunny'), text: `nuvole ${Math.round(med('cloud') ?? 0)}%` },
    { id: 'calm', label: 'vento debole', ok: most(evals, 'calm'), text: `vento ${Math.round(med('windMax') ?? 0)} km/h` },
    {
      id: 'freezing',
      label: 'zero termico sotto la quota',
      ok: most(evals, 'freezingOk'),
      text: med('freezingMax') != null ? `zero termico ${Math.round(med('freezingMax') / 100) * 100} m` : 'zero termico n.d.',
    },
  ];
  const weatherOk = conditions.every((c) => c.ok);

  let status;
  if (floor === 'chiusa' || signals.some((s) => s.level === 'chiusa')) status = 'chiusa';
  else if (floor === 'avvisi' || signals.some((s) => s.level === 'avviso')) status = 'avvisi';
  else if (!weatherOk) status = 'meteo';
  else status = 'aperta';

  const closedOn = loaded.filter((s) => !aspects.length || aspects.includes(s));
  // Senza bollettino (dopodomani, fuori stagione) il giudizio viene solo da meteo e neve.
  return { status, weatherOk, noBulletin: !bulletin, bulletinMax: bulletin?.max ?? null, conditions, signals, loaded, slabSource, closedOn, snow3 };
}

export const STATUS_LABEL = {
  aperta: 'Nessun pericolo, meteo buono',
  avvisi: 'Attenzione',
  chiusa: 'Pericolo',
  meteo: 'Nessun pericolo, meteo non buono',
  nd: 'n.d.',
};

/** Etichetta parlante di una finestra: tiene conto del meteo e del bollettino mancante. */
export function statusLabel(w) {
  if (!w) return STATUS_LABEL.nd;
  if (w.status === 'aperta' && w.noBulletin) return 'Nessun pericolo da meteo e neve, senza bollettino';
  return STATUS_LABEL[w.status];
}

/** Pericoli dei prossimi 3 giorni di un riassunto { past, days }: per gli altri giorni null. */
export function evaluateWindows(summary, elev, { aspects = [], bulletinFor = () => null } = {}) {
  const all = [...(summary.past || []), ...summary.days];
  const offset = (summary.past || []).length;
  return summary.days.map((d, i) => (i < RULES.days ? evaluateDay(all, offset + i, elev, { aspects, bulletin: bulletinFor(d.date) }) : null));
}
