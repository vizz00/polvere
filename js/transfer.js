// Porta i posti e i preferiti da un dispositivo all'altro, senza account:
// il codice è un link che contiene i posti aggiunti, i preferiti (in ordine) e i versanti scelti.
// Su iPhone l'app sulla schermata Home ha dati separati da Safari, per questo il codice
// si può anche incollare dentro l'app.
import { PLACES } from './places.js';
import { importPlaces } from './myplaces.js';

const PLACE_FIELDS = ['id', 'name', 'lat', 'lon', 'elevations', 'region', 'regionName', 'single'];

const esc = (t) =>
  String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Id dei posti: lettere minuscole, numeri e trattini (vedi slug in geo.js).
const validId = (id) => typeof id === 'string' && /^[a-z0-9-]{1,40}$/.test(id);
const validElev = (v) => Number.isFinite(v) && v >= 0 && v <= 5000;
function validPlace(p) {
  return (
    p &&
    validId(p.id) &&
    typeof p.name === 'string' &&
    p.name.length <= 80 &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lon) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lon) <= 180 &&
    p.elevations &&
    ['valle', 'meta', 'cima'].every((b) => validElev(p.elevations[b])) &&
    (p.region == null || (typeof p.region === 'string' && /^[A-Z0-9-]{1,12}$/.test(p.region))) &&
    (p.regionName == null || (typeof p.regionName === 'string' && p.regionName.length <= 60))
  );
}

function toBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(code) {
  const b64 = code.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** Il codice da copiare: un link all'app che porta con sé i dati. */
/** I dati da portare altrove: posti aggiunti (non le copie modificate dei predefiniti), elenco, stelle, versanti. */
export function exportData(prefs) {
  const places = PLACES.filter((p) => p.custom && !p.temp && !p.override).map((p) =>
    Object.fromEntries(PLACE_FIELDS.filter((k) => p[k] !== undefined).map((k) => [k, p[k]]))
  );
  return { v: 1, places, list: prefs.places, favorites: prefs.favorites, aspects: prefs.aspects || {} };
}

export function exportLink(prefs) {
  const data = exportData(prefs);
  const base = location.href.split('#')[0];
  return `${base}#/trasferisci?d=${toBase64Url(JSON.stringify(data))}`;
}

/** Legge un link o un codice incollato. Restituisce i dati o null se non è valido. */
export function readCode(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const m = raw.match(/[?&]d=([A-Za-z0-9_-]+)/);
  const code = m ? m[1] : raw;
  if (!/^[A-Za-z0-9_-]+$/.test(code)) return null;
  try {
    return cleanData(JSON.parse(fromBase64Url(code)));
  } catch {
    return null;
  }
}

/** Controlla dati arrivati da fuori (codice o sincronizzazione): tiene solo campi noti e valori sensati. */
export function cleanData(data) {
  try {
    if (data?.v !== 1 || !Array.isArray(data.places) || !Array.isArray(data.favorites)) return null;
    // Il codice può arrivare da chiunque: si tengono solo i campi noti e con valori sensati,
    // così un link fatto apposta non può infilare pezzi di pagina nell'app.
    data.places = data.places.filter(validPlace).map((p) => ({
      ...Object.fromEntries(PLACE_FIELDS.filter((k) => p[k] !== undefined).map((k) => [k, p[k]])),
      elevations: { valle: p.elevations.valle, meta: p.elevations.meta, cima: p.elevations.cima },
    }));
    data.favorites = data.favorites.filter(validId);
    data.list = (Array.isArray(data.list) ? data.list : [...data.favorites, ...data.places.map((p) => p.id)]).filter(validId);
    const SECT = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
    data.aspects = Object.fromEntries(
      Object.entries(data.aspects && typeof data.aspects === 'object' ? data.aspects : {})
        .filter(([id, list]) => validId(id) && Array.isArray(list))
        .map(([id, list]) => [id, list.filter((a) => SECT.includes(a))]),
    );
    return data;
  } catch {
    return null;
  }
}

/**
 * Unisce i dati importati a quelli di questo dispositivo: aggiunge i posti che mancano
 * e le stelle nuove in fondo, senza togliere niente.
 * @returns {{prefs: object, addedPlaces: number, addedFavs: number}}
 */
export function mergeImport(data, prefs) {
  importPlaces(data.places);
  const known = new Set(PLACES.map((p) => p.id));
  const newFavs = data.favorites.filter((f) => known.has(f) && !prefs.favorites.includes(f));
  const newList = [...new Set([...data.list, ...data.favorites])].filter((f) => known.has(f) && !prefs.places.includes(f));
  const aspects = { ...(data.aspects || {}), ...(prefs.aspects || {}) };
  return {
    prefs: { ...prefs, favorites: [...prefs.favorites, ...newFavs], places: [...prefs.places, ...newList], aspects },
    addedPlaces: newList.length,
    addedFavs: newFavs.length,
  };
}

/** Sincronizzazione automatica con l'account (solo se attiva, vedi js/sync.js). */
function syncSection(sync) {
  if (!sync) return '';
  const ago = (ts) => {
    const min = Math.round((Date.now() - ts) / 60000);
    return min < 1 ? 'adesso' : min < 60 ? `${min} min fa` : new Date(ts).toLocaleString('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };
  const msg = sync.msg ? `<p class="muted small" role="status">${esc(sync.msg)}</p>` : '';
  if (sync.status) {
    const st = sync.status;
    const line = st.error
      ? st.error === 'offline' ? 'Senza rete: sincronizzo appena torna.' : `Non riesco a sincronizzare (${esc(st.error)}). Riprovo da solo.`
      : st.at ? `Ultima sincronizzazione: ${ago(st.at)}.` : 'Sincronizzo…';
    return `<section class="transfer sync">
      <h2>Sincronizzati con il tuo account</h2>
      <p>${esc(st.email)}</p>
      <p class="muted small">${line} Ogni posto che aggiungi, togli o metti con la stella arriva da solo sugli altri dispositivi collegati.</p>
      ${msg}
      <div class="transfer-actions">
        <button type="button" class="btn" data-sync-now ${sync.busy ? 'disabled' : ''}>Sincronizza ora</button>
        <button type="button" class="btn ghost" data-sync-out>Esci</button>
      </div>
    </section>`;
  }
  if (sync.step === 'code') {
    return `<section class="transfer sync">
      <h2>Controlla l'email</h2>
      <p class="muted small">Ti ho mandato un codice a ${esc(sync.email)}. Scrivilo qui (sull'iPhone dentro l'app aperta dalla schermata Home).</p>
      ${msg}
      <form data-sync-code class="sync-form">
        <label for="sync-code" class="sr-only">Codice</label>
        <input id="sync-code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="123456" required>
        <button type="submit" class="btn" ${sync.busy ? 'disabled' : ''}>Entra</button>
      </form>
      <p class="small"><button type="button" class="linklike" data-sync-back>Cambia email</button></p>
    </section>`;
  }
  return `<section class="transfer sync">
    <h2>Sempre uguali, da soli</h2>
    <p class="muted small">Entra con la tua email su ogni dispositivo: i posti e le stelle restano sincronizzati, senza copiare niente. Nessuna password: ti arriva un codice.</p>
    ${msg}
    <form data-sync-email class="sync-form">
      <label for="sync-email" class="sr-only">Email</label>
      <input id="sync-email" name="email" type="email" autocomplete="email" placeholder="nome@email.it" value="${esc(sync.email || '')}" required>
      <button type="submit" class="btn" ${sync.busy ? 'disabled' : ''}>Mandami il codice</button>
    </form>
  </section>`;
}

export function transferPage({ prefs, code, result, sync }) {
  const nPlaces = prefs.places.length;
  const nFavs = prefs.favorites.length;
  const done = result
    ? `<div class="notice" role="status"><p>${
        result.addedPlaces || result.addedFavs
          ? `Fatto: ${result.addedPlaces} ${result.addedPlaces === 1 ? 'posto aggiunto' : 'posti aggiunti'}${
              result.addedFavs ? `, ${result.addedFavs} con la stella` : ''
            }.`
          : 'Avevi già tutti questi posti.'
      }</p><p><a class="btn" href="#/">Vai alle località</a></p></div>`
    : '';
  const bad = code && !result && !readCode(code)
    ? '<div class="notice error" role="alert"><p>Il codice non è valido: copialo di nuovo per intero dall\'altro dispositivo.</p></div>'
    : '';
  return `<h1 class="page-title">${sync ? 'I tuoi dispositivi' : 'Altro dispositivo'}</h1>
    ${sync ? '' : '<p class="muted">Per avere gli stessi posti sul Mac e sull\'iPhone: copia il codice su un dispositivo e incollalo sull\'altro.</p>'}
    ${done}${bad}
    ${syncSection(sync)}
    ${sync ? '<h2 class="transfer-or">Oppure, una volta sola, con un codice</h2>' : ''}
    <section class="transfer">
      <h2>1 · Copia da questo dispositivo</h2>
      <p>${nPlaces} ${nPlaces === 1 ? 'posto' : 'posti'}${nFavs ? `, ${nFavs} con la stella` : ''}.</p>
      <div class="transfer-actions">
        <button type="button" class="btn" data-transfer-copy>Copia codice</button>
        ${navigator.share ? '<button type="button" class="btn ghost" data-transfer-share>Invia…</button>' : ''}
      </div>
      <p class="muted small" data-transfer-copied role="status"></p>
    </section>
    <section class="transfer">
      <h2>2 · Incolla sull'altro dispositivo</h2>
      <p class="muted small">Sull'iPhone incollalo dentro l'app aperta dalla schermata Home: Safari e l'app tengono i dati separati.</p>
      <label for="transfer-code" class="sr-only">Codice</label>
      <textarea id="transfer-code" rows="3" placeholder="Incolla qui il codice" data-transfer-input>${code && !result && readCode(code) ? esc(code) : ''}</textarea>
      <div class="transfer-actions"><button type="button" class="btn" data-transfer-import>Aggiungi questi posti</button></div>
    </section>`;
}
