// Classifica "Polvere prossimi 3 giorni" dell'elenco Località (stile WePowder, ma per qualità).
// Usa solo i dati già scaricati per l'elenco (quota di metà): nessuna richiesta in più.
//
// Solo analisi della neve, senza i segni dei pericoli: per ognuno dei prossimi 3 giorni si
// prende la polvere stimata da js/powder.js (cm di neve fresca di oggi + ieri a peso minore,
// ridotti da neve pesante, vento forte, caldo, pioggia). Il posto prende il suo giorno migliore.
import { powderDays, POWDER } from './powder.js';

export const RANK = { days: 3 };

/**
 * summary: riassunto della quota (past + days), elev: quota.
 * Restituisce { score, date, level, label } oppure null senza dati.
 */
export function powderRank(summary, elev) {
  if (!summary?.days?.length) return null;
  const past = summary.past || [];
  const pw = powderDays([...past, ...summary.days], elev, past.length).slice(0, RANK.days);
  let best = null;
  for (const p of pw) if (p.score != null && (!best || p.score > best.score)) best = p;
  if (!best) return null;
  const level = POWDER.levels.find((l) => best.score >= l.min);
  return { score: best.score, date: best.date, level: level.id, label: level.label };
}
