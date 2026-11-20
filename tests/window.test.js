import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { agreed, evaluateDay, evaluateWindows, leeSectors, meanDirection, problemAtElevation, statusLabel } from '../js/window.js';
import { summarizePoint } from '../js/snow.js';

// Giorno sintetico con gli stessi valori per 3 modelli.
const BASE = {
  snow: 0, precip: 0, rain: 0, windMax: 10, windDir: 0, transportDir: null, transportHours: 0,
  cloud: 10, nightCloud: 10, tMin: -8, tMax: -2, tNightMin: -8, tSnow: -3, freezingMax: 1800,
};
function day(date, over = {}) {
  const m = { ...BASE, ...over };
  return { date, models: { a: { ...m }, b: { ...m }, c: { ...m } } };
}
const ELEV = 2800;

test('versanti sottovento: vento da NO carica SE e i settori accanto', () => {
  assert.deepEqual(leeSectors(315), ['E', 'SE', 'S']);
  assert.deepEqual(leeSectors(0), ['SE', 'S', 'SO']);
  assert.deepEqual(leeSectors(null), []);
});

test('media circolare delle direzioni attraversa il nord', () => {
  assert.ok(Math.abs(meanDirection([350, 10]) - 0) < 1e-6 || Math.abs(meanDirection([350, 10]) - 360) < 1e-6);
});

test('giorno sereno, calmo e freddo senza neve: finestra buona', () => {
  const days = [day('2026-01-01'), day('2026-01-02'), day('2026-01-03')];
  const w = evaluateDay(days, 2, ELEV);
  assert.equal(w.status, 'aperta');
  assert.equal(w.signals.length, 0);
});

test('due giorni di neve con vento forte: chiusa (esempio di Riccardo)', () => {
  const days = [
    day('2026-01-01', { snow: 15, windMax: 50, transportDir: 315, transportHours: 10, cloud: 100 }),
    day('2026-01-02', { snow: 15, windMax: 45, transportDir: 315, transportHours: 10, cloud: 100 }),
    day('2026-01-03', { snow: 0, windMax: 15 }),
  ];
  const w = evaluateDay(days, 2, ELEV);
  assert.equal(w.status, 'chiusa');
  assert.ok(w.signals.some((s) => s.id === 'critical'));
  assert.deepEqual(w.loaded, ['E', 'SE', 'S']);
});

test('accumuli: vento oltre 30 km/h su neve soffice, al massimo ▲ anche sul mio versante', () => {
  const days = [
    day('2026-01-01', { snow: 12, windMax: 15 }),
    day('2026-01-02', { windMax: 15 }),
    day('2026-01-03', { windMax: 15 }),
    day('2026-01-04', { windMax: 35, transportDir: 0, transportHours: 6 }),
  ];
  const any = evaluateDay(days, 3, ELEV);
  assert.equal(any.status, 'avvisi');
  assert.deepEqual(any.loaded, ['SE', 'S', 'SO']);
  assert.match(any.signals.find((s) => s.id === 'windSlab').text, /^Vento oltre 30 km\/h da nord\|circa 35 km\/h: possibili accumuli a sud-est, sud, sud-ovest/);
  assert.equal(evaluateDay(days, 3, ELEV, { aspects: ['S'] }).status, 'avvisi');
  // versante non tuo: la riga resta senza segno, il giorno non cambia (resta il vento forte per il meteo)
  const notMine = evaluateDay(days, 3, ELEV, { aspects: ['N'] });
  assert.equal(notMine.status, 'meteo');
  assert.equal(notMine.signals.find((s) => s.id === 'windSlab').level, 'info');
});

test('accumuli: il vento di ieri conta ancora, quello di 2 giorni fa no', () => {
  const days = [day('d1', { snow: 12 }), day('d2', { windMax: 35, transportDir: 0 }), day('d3'), day('d4')];
  assert.match(evaluateDay(days, 2, ELEV).signals.find((s) => s.id === 'windSlab').text, /^Ieri vento oltre 30 km\/h/);
  assert.ok(!evaluateDay(days, 3, ELEV).signals.some((s) => s.id === 'windSlab'));
});

test('accumuli: poca neve, vento debole o vento solo prima della neve non contano', () => {
  const little = [day('d1', { snow: 6 }), day('d2', { windMax: 35, transportDir: 0 })];
  assert.equal(evaluateDay(little, 1, ELEV).signals.length, 0);
  const weak = [day('d1', { snow: 15 }), day('d2', { windMax: 25, transportDir: 0 })];
  assert.ok(!evaluateDay(weak, 1, ELEV).signals.some((s) => s.id === 'windSlab'));
  const before = [day('d1', { windMax: 40, transportDir: 0 }), day('d2', { snow: 15 }), day('d3')];
  assert.ok(!evaluateDay(before, 2, ELEV).signals.some((s) => s.id === 'windSlab'));
});

test('accumuli: neve vecchia ma soffice si sposta; pioggia o caldo la induriscono', () => {
  const soft = [day('d1', { snow: 20 }), day('d2'), day('d3'), day('d4'), day('d5'), day('d6', { windMax: 35, transportDir: 315 })];
  assert.ok(evaluateDay(soft, 5, ELEV).signals.some((s) => s.id === 'windSlab'));
  const rain = soft.map((d) => structuredClone(d));
  for (const m of Object.values(rain[2].models)) m.rain = 5;
  assert.ok(!evaluateDay(rain, 5, ELEV).signals.some((s) => s.id === 'windSlab'));
  const warm = soft.map((d) => structuredClone(d));
  for (const m of Object.values(warm[3].models)) m.tMax = 4;
  assert.ok(!evaluateDay(warm, 5, ELEV).signals.some((s) => s.id === 'windSlab'));
  const mild = soft.map((d) => structuredClone(d));
  for (const m of Object.values(mild[3].models)) m.tMax = 1; // poco sopra zero: a nord resta polvere
  assert.ok(evaluateDay(mild, 5, ELEV).signals.some((s) => s.id === 'windSlab'));
});

test('modelli d\'accordo: un modello che spara da solo non conta', () => {
  assert.equal(agreed([14, 18, 20, 22, 25, 66], () => 15), 19.8);
  // divisi a metà: per prudenza il gruppo più alto
  assert.equal(agreed([20, 20, 20, 50, 50, 50], () => 15), 50);
  const days = [day('d1', { snow: 15 }), day('d2')];
  days[1].models.a.windMax = 66;
  days[1].models.a.transportDir = 0;
  const w = evaluateDay(days, 1, ELEV);
  assert.ok(!w.signals.some((s) => s.id === 'windSlab'));
  assert.deepEqual(w.loaded, []);
});

test('neve fresca: soglie SLF a intervallo, giallo dentro e rosso oltre', () => {
  // vento debole → 30-40 cm
  const calm = (cmToday) => [day('d1'), day('d2', { snow: 0 }), day('d3', { snow: cmToday, cloud: 90 })];
  assert.ok(!evaluateDay(calm(25), 2, ELEV).signals.some((s) => s.id === 'critical'));
  assert.equal(evaluateDay(calm(35), 2, ELEV).signals.find((s) => s.id === 'critical').level, 'avviso');
  const red = evaluateDay(calm(45), 2, ELEV).signals.find((s) => s.id === 'critical');
  assert.equal(red.level, 'chiusa');
  assert.equal(red.text, 'Neve ultimi 3 giorni: 45 cm|caduta con vento debole, oltre i 40 cm critici');
  // freddo mentre nevica → 10-20 cm
  const cold = [day('d1'), day('d2'), day('d3', { snow: 12, tSnow: -12, cloud: 90 })];
  assert.equal(evaluateDay(cold, 2, ELEV).signals.find((s) => s.id === 'critical').level, 'avviso');
});

test('neve fresca: 2 giorni fa conta metà, il vento senza neve non cambia le condizioni', () => {
  // 40 cm due giorni fa (vale 20), poi vento forte senza neve: condizioni favorevoli, nessun segnale
  const days = [day('d1', { snow: 40 }), day('d2', { windMax: 50 }), day('d3')];
  assert.ok(!evaluateDay(days, 2, ELEV).signals.some((s) => s.id === 'critical'));
});

test('fondo debole: dopo 5 giorni secchi bastano 10 cm, ma solo giallo', () => {
  const dry = Array.from({ length: 6 }, (_, i) => day(`d${i}`));
  const days = [...dry, day('d6', { snow: 15, cloud: 90 })];
  const w = evaluateDay(days, 6, ELEV);
  const s = w.signals.find((x) => x.id === 'weakBase');
  assert.equal(s.level, 'avviso');
  assert.equal(w.status, 'avvisi');
  // senza giorni secchi prima: nessun segnale con 15 cm e vento debole
  assert.equal(evaluateDay([day('a', { snow: 3 }), day('b', { snow: 15, cloud: 90 })], 1, ELEV).signals.length, 0);
});

test('pioggia e notte senza rigelo chiudono la finestra', () => {
  const rain = [day('d1'), day('d2'), day('d3', { rain: 5, cloud: 10 })];
  assert.equal(evaluateDay(rain, 2, ELEV).status, 'chiusa');
  const warm = [day('d1'), day('d2'), day('d3', { tNightMin: 3, tMin: 3, tMax: 8, freezingMax: 2000 })];
  assert.ok(evaluateDay(warm, 2, ELEV).signals.some((s) => s.id === 'noRefreeze'));
});

test('meteo non buono senza segnali: nuvole o zero termico sopra la quota', () => {
  const cloudy = [day('d1'), day('d2'), day('d3', { cloud: 90 })];
  assert.equal(evaluateDay(cloudy, 2, ELEV).status, 'meteo');
  const warm = [day('d1'), day('d2'), day('d3', { freezingMax: 3200 })];
  assert.equal(evaluateDay(warm, 2, ELEV).status, 'meteo');
});

test('pioggia di un solo modello non conta', () => {
  const days = [day('d1'), day('d2'), day('d3')];
  days[2].models.a.rain = 5;
  assert.equal(evaluateDay(days, 2, ELEV).status, 'aperta');
});

test('il bollettino ha la precedenza: grado 4 chiude, 3 dà almeno ▲, neve ventata dà i versanti', () => {
  const days = [day('d1'), day('d2'), day('d3')];
  const b4 = { max: 4, problems: [] };
  assert.equal(evaluateDay(days, 2, ELEV, { bulletin: b4 }).status, 'chiusa');
  assert.equal(evaluateDay(days, 2, ELEV, { bulletin: { max: 3, problems: [] } }).status, 'avvisi');
  // con il bollettino i nostri segnali arrivano al massimo a ▲
  const rain = [day('d1'), day('d2'), day('d3', { rain: 5 })];
  assert.equal(evaluateDay(rain, 2, ELEV).status, 'chiusa');
  const capped = evaluateDay(rain, 2, ELEV, { bulletin: { max: 2, problems: [] } });
  assert.equal(capped.status, 'avvisi');
  assert.equal(capped.signals.find((s) => s.id === 'rain').level, 'avviso');
  const slab = {
    max: 2,
    problems: [{ type: 'wind_slab', where: 'sopra 2400 m', aspectList: ['N', 'NW'], elevation: { lowerBound: '2400' } }],
  };
  const w = evaluateDay(days, 2, ELEV, { bulletin: slab });
  assert.deepEqual(w.loaded, ['N', 'NO']);
  assert.equal(w.slabSource, 'bollettino');
  // sotto la quota del problema non vale
  assert.deepEqual(evaluateDay(days, 2, 2000, { bulletin: slab }).loaded, []);
});

test('quota del problema: limite del bosco = 2000 m', () => {
  assert.equal(problemAtElevation({ elevation: { upperBound: 'treeline' } }, 1800), true);
  assert.equal(problemAtElevation({ elevation: { upperBound: 'treeline' } }, 2500), false);
  assert.equal(problemAtElevation({ elevation: null }, 2500), true);
});

test('risposta reale Open-Meteo: segni solo per i prossimi 3 giorni, senza errori', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/open-meteo-cervinia.json', import.meta.url)));
  const list = Array.isArray(fixture) ? fixture : [fixture];
  const s = summarizePoint(list[0], 2050);
  const ws = evaluateWindows({ past: [], days: s.days }, 2050);
  assert.equal(ws.length, s.days.length);
  ws.forEach((w, i) => {
    if (i < 3) assert.ok(['aperta', 'avvisi', 'chiusa', 'meteo', 'nd'].includes(w.status));
    else assert.equal(w, null);
  });
});

test('un pericolo conta più del meteo: nuvoloso con pioggia dà la croce', () => {
  const days = [day('d1'), day('d2'), day('d3', { cloud: 90, rain: 5 })];
  const w = evaluateDay(days, 2, ELEV);
  assert.equal(w.status, 'chiusa');
  assert.equal(w.weatherOk, false);
});

test('senza bollettino il segno lo dice', () => {
  const days = [day('d1'), day('d2'), day('d3')];
  const w = evaluateDay(days, 2, ELEV);
  assert.equal(w.noBulletin, true);
  assert.equal(statusLabel(w), 'Nessun pericolo da meteo e neve, senza bollettino');
  const withB = evaluateDay(days, 2, ELEV, { bulletin: { max: 1, problems: [] } });
  assert.equal(withB.noBulletin, false);
  assert.equal(statusLabel(withB), 'Nessun pericolo, meteo buono');
});
