// Rosa dei venti a 8 petali (stile bollettino valanghe): petali pieni = versanti interessati,
// vuoti = non interessati; lettere N E S O sui petali principali. Grafica nostra.
const ORDER = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const ALIAS = { SO: 'SW', O: 'W', NO: 'NW' };
const LETTER = { N: 'N', E: 'E', S: 'S', W: 'O' };
const norm = (a) => ALIAS[a] || a;

export function roseSvg(selected = [], { size = 44, mine = [], label = '', cls = '' } = {}) {
  const on = new Set(selected.map(norm));
  const hi = new Set(mine.map(norm));
  const c = size / 2;
  const R = c - 1;
  const pt = (rad, deg) => {
    const a = ((deg - 90) * Math.PI) / 180;
    return `${(c + rad * Math.cos(a)).toFixed(2)},${(c + rad * Math.sin(a)).toFixed(2)}`;
  };
  const fs = Math.max(6, size * 0.19).toFixed(1);
  const petals = ORDER.map((name, i) => {
    const deg = i * 45;
    const card = i % 2 === 0;
    const len = card ? R : R * 0.8;
    const d = `M${c},${c} L${pt(len * 0.6, deg - 30)} L${pt(len, deg)} L${pt(len * 0.6, deg + 30)} Z`;
    const cls2 = `${on.has(name) ? 'on' : ''}${hi.has(name) ? ' mine' : ''}`;
    const l = LETTER[name]
      ? `<text x="${pt(len * 0.55, deg).split(',')[0]}" y="${(Number(pt(len * 0.55, deg).split(',')[1]) + size * 0.065).toFixed(2)}" font-size="${fs}">${LETTER[name]}</text>`
      : '';
    return `<g class="${cls2}"><path d="${d}"/>${l}</g>`;
  }).join('');
  const aria = label || (on.size >= 8 ? 'tutte le esposizioni' : on.size ? `esposizioni: ${[...on].join(' ')}` : 'nessuna esposizione');
  return `<svg class="rose ${cls}" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${aria}"><title>${aria}</title>${petals}</svg>`;
}
