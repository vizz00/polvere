// Rosa a 8 spicchi nello stile delle rose dei bollettini valanghe: spicchi pieni = versanti interessati,
// vuoti = non interessati; solo "N" in alto e "S" in basso, piccole al centro. Grafica nostra.
const ORDER = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const ALIAS = { SO: 'SW', O: 'W', NO: 'NW' };
const norm = (a) => ALIAS[a] || a;

export function roseSvg(selected = [], { size = 36, mine = [], label = '', cls = '' } = {}) {
  const on = new Set(selected.map(norm));
  const hi = new Set(mine.map(norm));
  const c = size / 2;
  const R = c - 1;
  const gap = 3; // mezzo grado di vuoto tra gli spicchi, in gradi
  const pt = (rad, deg) => {
    const a = ((deg - 90) * Math.PI) / 180;
    return `${(c + rad * Math.cos(a)).toFixed(2)},${(c + rad * Math.sin(a)).toFixed(2)}`;
  };
  const paths = ORDER.map((name, i) => {
    const a0 = i * 45 - 22.5 + gap;
    const a1 = i * 45 + 22.5 - gap;
    const d = `M${c},${c} L${pt(R, a0)} A${R},${R} 0 0 1 ${pt(R, a1)} Z`;
    return `<path class="${on.has(name) ? 'on' : ''}${hi.has(name) ? ' mine' : ''}" d="${d}"/>`;
  }).join('');
  const disc = `<circle cx="${c}" cy="${c}" r="${(size * 0.2).toFixed(1)}"/>`;
  const fs = Math.max(5, size * 0.15).toFixed(1);
  const text = `<text x="${c}" y="${(c - size * 0.03).toFixed(1)}" font-size="${fs}">N</text><text x="${c}" y="${(c + size * 0.12).toFixed(1)}" font-size="${fs}">S</text>`;
  const aria = label || (on.size >= 8 ? 'tutte le esposizioni' : on.size ? `esposizioni: ${[...on].join(' ')}` : 'nessuna esposizione');
  return `<svg class="rose ${cls}" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${aria}"><title>${aria}</title>${paths}${disc}${text}</svg>`;
}
