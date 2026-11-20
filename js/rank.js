// Classifica "Polvere prossimi 3 giorni" dell'elenco Località (stile WePowder, ma per qualità).
// Usa solo i dati già scaricati per l'elenco (quota di metà): nessuna richiesta in più.
//
// Per ognuno dei prossimi 3 giorni si prende la polvere stimata da js/powder.js: cm di neve
// fresca (oggi + ieri a peso minore) ridotti da neve pesante, vento forte, caldo, pioggia.
// Se quel giorno il segno dei pericoli è ✕ vale la metà: meglio un posto con meno neve
// ma senza pericolo. Il posto prende il suo giorno migliore.
import { powderDays, POWDER } from './powder.js';

export const RANK = { days: 3, dangerFactor: 0.5 };

/**
 * summary: riassunto della quota (past + days), elev: quota, wins: segni dei prossimi giorni
 * (evaluateWindows). Restituisce { score, date, level, label, danger } oppure null senza dati.
 */
export function powderRank(summary, elev, wins = []) {
  if (!summary?.days?.length) return null;
  const past = summary.past || [];
  const pw = powderDays([...past, ...summary.days], elev, past.length).slice(0, RANK.days);
  let best = null;
  pw.forEach((p, i) => {
    if (p.score == null) return;
    const danger = wins[i]?.status === 'chiusa';
    const score = p.score * (danger ? RANK.dangerFactor : 1);
    if (!best || score > best.score) best = { score, date: p.date, raw: p.score, danger };
  });
  if (!best) return null;
  const level = POWDER.levels.find((l) => best.raw >= l.min);
  return { score: best.score, date: best.date, level: level.id, label: level.label, danger: best.danger };
}
