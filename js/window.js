// "Finestra buona": i giorni in cui il meteo è buono per uscire (sole, poco vento,
// limite neve sotto la quota) e nessun segnale d'allarme di nivologia è scattato.
//
// Calcoli puri (nessun DOM, nessuna rete), provati con `node --test`.
// Le regole e le soglie vengono da:
// - SLF, "Achtung Lawinen!" (2022): neve fresca critica in 3 giorni, vento forte > 40 km/h,
//   accumuli di neve ventata (più pericolosi durante e subito dopo il vento), pioggia, riscaldamento, rigelo.
// - EAWS, problemi valanghivi tipici; avalanche.report, i 10 Gefahrenmuster (gm.3, gm.6, gm.10).
// L'app non dà un voto: dice quali condizioni sono rispettate e quali segnali sono scattati.
// Il bollettino ufficiale, quando c'è, ha sempre l'ultima parola.

export const RULES = {
  // Neve fresca: peso dei giorni (oggi, ieri, 2 giorni fa). Il peso è una scelta nostra:
  // la neve nuova è più pericolosa durante e subito dopo la nevicata, poi si assesta (EAWS).
  snowWeights: [1, 1, 0.5],
  // Neve fresca critica SLF in 1-3 giorni (cm): intervallo [basso, alto].
  // Sotto il basso nessun segnale, dentro l'intervallo ▲, oltre l'alto ✕.
  critical: { sfavorevoli: [10, 20], medie: [20, 30], favorevoli: [30, 50] },
  strongWind: 40, // km/h mentre nevica: "vento forte" SLF, condizioni sfavorevoli
  moderateWind: 20, // km/h mentre nevica: sotto questo il vento è debole (condizioni favorevoli)
  coldUnfavorable: -7, // °C mentre nevica: freddo che rende sfavorevole la nevicata (SLF: −5/−10)
  snowDay: 1, // cm: un giorno con meno neve conta come secco
  dryBefore: 5, // giorni secchi prima della nevicata: fondo debole (SLF), al massimo ▲
  // Accumuli: neve soffice degli ultimi 7 giorni che il vento può spostare.
  softDays: 7,
  softSnow: 10, // cm di neve soffice perché il vento formi accumuli
  transportWind: 30, // km/h di vento in quota che sposta la neve in quantità
  warmDay: 3, // °C di massima che fanno crosta e azzerano la neve soffice
  rainMm: 2, // mm di pioggia alla quota in un giorno
  warmingSnow: 10, // cm caduti nei 2 giorni prima del primo sole
  sunnyCloud: 40, // % nuvolosità diurna sotto cui il giorno è "sereno"
  okWind: 30, // km/h: vento in quota accettabile per uscire
  agree: 0.5, // quota di modelli perché un segnale sia "sì"
  maybe: 0.25, // quota di modelli perché un segnale sia "possibile"
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
  const windSnow = Math.max(0, ...snowy.map((m) => m.windMax ?? 0));
  const tSnow = Math.min(99, ...snowy.map((m) => m.tSnow ?? m.tMin ?? 99));
  const conditions = windSnow >= RULES.strongWind || tSnow <= RULES.coldUnfavorable
    ? 'sfavorevoli'
    : windSnow >= RULES.moderateWind ? 'medie' : 'favorevoli';
  const [low, high] = RULES.critical[conditions];
  // Fondo debole: almeno 5 giorni secchi prima del primo giorno di neve (SLF: vecchia superficie incoerente).
  let first = -1;
  for (let back = 2; back >= 0; back--) if ((span[back]?.snow ?? 0) >= RULES.snowDay) { first = index - back; break; }
  let dry = 0;
  if (first >= 0) for (let k = first - 1; k >= 0 && at(k) && (at(k).snow ?? 0) < RULES.snowDay; k--) dry++;
  const weakBase = dry >= RULES.dryBefore;

  // --- Accumuli: vento ≥ 30 km/h su almeno 10 cm di neve soffice, durante o dopo la nevicata.
  const windDays = [0, 1, 2, 3]
    .map((back) => ({ back, m: at(index - back) }))
    .filter(({ back, m }) => m && (m.windMax ?? 0) >= RULES.transportWind && m.transportDir != null
      && softSnowAt(days, index - back, id) >= RULES.softSnow);
  const fresh = windDays.filter((w) => w.back <= 1);
  const transport = (fresh.length ? fresh : windDays).map((w) => w.m).sort((x, y) => y.windMax - x.windMax)[0] || null;

  const before = days.slice(Math.max(0, index - 2), index).map((d) => d.models[id]).filter(Boolean);
  const snowBefore = sum(before.map((m) => m.snow));
  const sunny = today.cloud != null && today.cloud < RULES.sunnyCloud;
  const freezingOk = today.freezingMax != null ? today.freezingMax < elev : today.tMax != null && today.tMax <= 1;

  return {
    snow3,
    snowW,
    conditions,
    low,
    high,
    critHigh: snowW >= high,
    critLow: snowW >= low,
    weakBase: weakBase && snowW >= RULES.critical.sfavorevoli[0],
    windSlab: windDays.length > 0,
    windSlabFresh: fresh.length > 0,
    transportDir: transport?.transportDir ?? null,
    transportSpeed: transport?.windMax ?? null,
    soft: softSnowAt(days, index, id),
    rain: (today.rain ?? 0) >= RULES.rainMm,
    firstSun: snowBefore >= RULES.warmingSnow && sunny && (today.tMax ?? -99) >= 0,
    noRefreeze: noRefreeze(today),
    sunny,
    calm: today.windMax != null && today.windMax < RULES.okWind,
    freezingOk,
    cloud: today.cloud,
    windMax: today.windMax,
    freezingMax: today.freezingMax,
  };
}

function share(evals, key) {
  const n = evals.length;
  const k = evals.filter((e) => e[key]).length;
  if (!n || !k) return null;
  const f = k / n;
  if (f >= RULES.agree) return 'sì';
  if (f >= RULES.maybe) return 'possibile';
  return null;
}

const round5 = (x) => Math.round(x / 5) * 5;
const cm = (x) => (x < 10 ? Math.round(x) : round5(x));

/**
 * Finestra per il giorno `index` di `days` (lista continua: giorni passati + previsione).
 * opzioni:
 *  - aspects: versanti scelti dall'utente per il posto (es. ['N','NE']); se vuoto vale per versante
 *  - bulletin: riassunto del bollettino di quel giorno (summarizeBulletin) o null
 * Restituisce { status, conditions, signals, loaded, closedOn, snow3 }.
 * status: 'aperta' | 'avvisi' | 'chiusa' | 'meteo' (meteo non buono) | 'nd'
 * weatherOk: il meteo è buono; noBulletin: manca il bollettino di quel giorno
 */
export function evaluateDay(days, index, elev, { aspects = [], bulletin = null } = {}) {
  const ids = Object.keys(days[index]?.models || {});
  const evals = ids.map((id) => evaluateModel(days, index, id, elev)).filter(Boolean);
  if (!evals.length) return { status: 'nd', conditions: [], signals: [], loaded: [], closedOn: [], snow3: null };

  const snow3 = median(evals.map((e) => e.snow3));
  const signals = [];
  const add = (id, level, certainty, text, source) => certainty && signals.push({ id, level, certainty, text, source });

  // 1. Neve fresca critica (SLF): dentro l'intervallo ▲, oltre il limite alto ✕.
  const snowW = median(evals.map((e) => e.snowW));
  const condOf = (list) => {
    const lo = median(list.map((e) => e.low));
    return Object.keys(RULES.critical).find((k) => RULES.critical[k][0] === lo) || 'medie';
  };
  const high = share(evals, 'critHigh');
  const low = share(evals, 'critLow');
  if (high) {
    const c = condOf(evals.filter((e) => e.critHigh));
    add('critical', 'chiusa', high, `${cm(snowW)} cm di neve fresca recente: oltre la soglia critica (${RULES.critical[c][1]} cm con condizioni ${c})`, 'SLF');
  } else if (low) {
    const c = condOf(evals.filter((e) => e.critLow));
    const [lo, hi] = RULES.critical[c];
    add('critical', 'avviso', low, `${cm(snowW)} cm di neve fresca recente: vicino alla soglia critica (${lo}-${hi} cm con condizioni ${c})`, 'SLF');
  } else {
    add('weakBase', 'avviso', share(evals, 'weakBase'), `${cm(snowW)} cm di neve fresca su un fondo rimasto secco per ${RULES.dryBefore} giorni o più: può legarsi male`, 'SLF');
  }

  // 2. Accumuli: versanti sottovento.
  let loaded = [];
  let slabSource = null;
  const slabProblem = bulletin?.problems?.find((p) => p.type === 'wind_slab' && problemAtElevation(p, elev));
  if (slabProblem) {
    loaded = slabProblem.aspectList.length ? slabProblem.aspectList.map((a) => EN_TO_IT[a] || a) : [...SECTORS];
    slabSource = 'bollettino';
  }
  const slab = share(evals, 'windSlab');
  const slabFresh = share(evals, 'windSlabFresh');
  if (slab && !slabSource) {
    const withSlab = evals.filter((e) => e.windSlab);
    const dir = meanDirection(withSlab.map((e) => e.transportDir));
    loaded = leeSectors(dir);
    slabSource = 'modelli';
    const speed = median(withSlab.map((e) => e.transportSpeed));
    const soft = median(withSlab.map((e) => e.soft));
    const from = SECTORS[sectorIndex(dir)];
    const when = slabFresh ? 'accumuli freschi' : 'accumuli di 2-3 giorni fa, in via di stabilizzazione';
    add('windSlab', 'versanti', slab, `${cm(soft)} cm di neve soffice e vento da ${from} fino a ${Math.round(speed)} km/h: ${when} sui versanti ${loaded.join(', ')}`, 'SLF, EAWS');
  } else if (slabSource) {
    add('windSlab', 'versanti', 'sì', `bollettino: accumuli di neve ventata ${slabProblem.where}${loaded.length < 8 ? `, versanti ${loaded.join(', ')}` : ', tutte le esposizioni'}`, 'bollettino');
  }

  // 3. Pioggia su neve.
  add('rain', 'chiusa', share(evals, 'rain'), 'pioggia alla quota: la neve si appesantisce e perde coesione', 'SLF, gm.3');

  // 4. Niente rigelo notturno.
  add('noRefreeze', 'chiusa', share(evals, 'noRefreeze'), 'notte sopra 0 °C: niente rigelo, neve molle già dal mattino', 'SLF, gm.10');

  // 5. Primo sole forte dopo una nevicata.
  add('firstSun', 'avviso', share(evals, 'firstSun'), 'primo giorno di sole dopo la nevicata: meglio il mattino, attenzione ai versanti al sole', 'SLF');

  // 6. Bollettino ufficiale.
  if (bulletin?.max != null) {
    if (bulletin.max >= 4) add('danger', 'chiusa', 'sì', `bollettino: pericolo ${bulletin.max}`, 'bollettino');
    else if (bulletin.max === 3) add('danger', 'avviso', 'sì', 'bollettino: pericolo 3 marcato', 'bollettino');
    const pwl = bulletin.problems?.find((p) => p.type === 'persistent_weak_layers' && problemAtElevation(p, elev));
    if (pwl) add('pwl', 'avviso', 'sì', `bollettino: strati deboli persistenti ${pwl.where}${pwl.aspects ? `, ${pwl.aspects}` : ''}`, 'bollettino');
    const wet = bulletin.problems?.find((p) => p.type === 'wet_snow' && problemAtElevation(p, elev));
    if (wet) add('wet', 'avviso', 'sì', `bollettino: neve bagnata ${wet.where}${wet.period ? `, ${wet.period.toLowerCase()}` : ''}`, 'bollettino');
  }

  // Condizioni meteo per uscire.
  const med = (k) => median(evals.map((e) => e[k]));
  const conditions = [
    { id: 'sun', label: 'sole', ok: share(evals, 'sunny') === 'sì', text: `nuvole ${Math.round(med('cloud') ?? 0)}%` },
    { id: 'calm', label: 'vento debole', ok: share(evals, 'calm') === 'sì', text: `vento in quota ${Math.round(med('windMax') ?? 0)} km/h` },
    {
      id: 'freezing',
      label: 'zero termico sotto la quota',
      ok: share(evals, 'freezingOk') === 'sì',
      text: med('freezingMax') != null ? `zero termico ${Math.round(med('freezingMax') / 100) * 100} m` : 'zero termico n.d.',
    },
    { id: 'fresh', label: 'neve recente', ok: snow3 >= 5, bonus: true, text: `${cm(snow3)} cm in 3 giorni` },
  ];

  // Versanti degli accumuli: se l'utente ha scelto i suoi versanti, contano solo quelli.
  // Freschi (vento oggi o ieri) e sicuri: ✕ sui tuoi versanti, ▲ senza versanti scelti.
  // Vecchi (2-3 giorni): ▲. Solo "possibile": restano sulla rosa senza cambiare il segno.
  const closedOn = loaded.filter((s) => !aspects.length || aspects.includes(s));
  const slabSignal = signals.find((s) => s.id === 'windSlab');
  if (slabSignal) {
    const fromBulletin = slabSource === 'bollettino';
    const sure = slabSignal.certainty === 'sì';
    const freshSure = fromBulletin || slabFresh === 'sì';
    if (!sure) slabSignal.level = 'info';
    else if (aspects.length && !closedOn.length) slabSignal.level = 'info';
    else if (aspects.length && freshSure) slabSignal.level = 'chiusa';
    else slabSignal.level = 'avviso';
  }

  const weatherOk = conditions.filter((c) => !c.bonus).every((c) => c.ok);
  // Un segnale di nivologia, anche solo "possibile", conta più del meteo:
  // un giorno nuvoloso con un allarme non deve sembrare soltanto "nuvoloso".
  let status;
  if (signals.some((s) => s.level === 'chiusa' && s.certainty === 'sì')) status = 'chiusa';
  else if (signals.some((s) => s.level === 'chiusa' || s.level === 'avviso')) status = 'avvisi';
  else if (!weatherOk) status = 'meteo';
  else status = 'aperta';

  // Senza bollettino (giorni oltre domani, fuori stagione) il giudizio viene solo da meteo e neve.
  return { status, weatherOk, noBulletin: !bulletin, conditions, signals, loaded, slabSource, closedOn, snow3 };
}

export const STATUS_LABEL = {
  aperta: 'Finestra buona',
  avvisi: 'Buona, con avvisi',
  chiusa: 'Chiusa',
  meteo: 'Meteo non buono',
  nd: 'n.d.',
};

/** Etichetta parlante di una finestra: tiene conto del meteo e del bollettino mancante. */
export function statusLabel(w) {
  if (!w) return STATUS_LABEL.nd;
  if (w.status === 'avvisi' && w.weatherOk === false) return 'Avvisi, meteo non buono';
  if (w.status === 'aperta' && w.noBulletin) return 'Buona per meteo e neve, senza bollettino';
  return STATUS_LABEL[w.status];
}

/** Finestre per tutti i giorni di previsione di un riassunto { past, days }. */
export function evaluateWindows(summary, elev, { aspects = [], bulletinFor = () => null } = {}) {
  const all = [...(summary.past || []), ...summary.days];
  const offset = (summary.past || []).length;
  return summary.days.map((d, i) => evaluateDay(all, offset + i, elev, { aspects, bulletin: bulletinFor(d.date) }));
}
