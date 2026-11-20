// Sincronizzazione automatica dei posti tra dispositivi, con un account (email + codice).
// Si salva una sola riga per persona su Supabase: i posti aggiunti, l'elenco, le stelle, i versanti.
// Senza configurazione (js/sync-config.js vuoto) è spenta e l'app funziona come prima.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './sync-config.js';
import { exportData, cleanData, mergeImport } from './transfer.js';
import { replacePlaces } from './myplaces.js';
import { PLACES } from './places.js';

const KEY = 'mm.sync.v1';
const TABLE = 'posti';

export const syncEnabled = () => Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {
    return null;
  }
}
function store(s) {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* ignorato */
  }
}

/** Chi è collegato, quando è stata l'ultima sincronizzazione ed eventuale errore. */
export function syncStatus() {
  const s = load();
  return s ? { email: s.email, at: s.syncedAt || null, error: s.error || null } : null;
}

async function call(path, { method = 'GET', body, token, prefer } = {}) {
  const headers = { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* risposta vuota o non JSON */
  }
  if (!res.ok) {
    const err = new Error(json?.msg || json?.message || json?.error_description || `Errore ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

/** Passo 1: manda il codice all'email (crea l'account se non c'è). */
export async function requestCode(email) {
  email = String(email || '').trim().toLowerCase();
  if (!validEmail(email)) throw new Error('Scrivi un indirizzo email valido.');
  await call('/auth/v1/otp', { method: 'POST', body: { email, create_user: true } });
  return email;
}

function saveSession(email, r, extra = {}) {
  const prev = load() || {};
  const s = {
    ...prev,
    ...extra,
    email,
    userId: r.user?.id || prev.userId,
    access: r.access_token,
    refresh: r.refresh_token,
    expiresAt: Date.now() + (r.expires_in || 3600) * 1000,
  };
  store(s);
  return s;
}

/** Passo 2: controlla il codice arrivato per email. */
export async function verifyCode(email, code) {
  code = String(code || '').replace(/\s/g, '');
  if (!/^\d{6,10}$/.test(code)) throw new Error('Il codice è fatto di sole cifre: copialo dall\'email.');
  const r = await call('/auth/v1/verify', { method: 'POST', body: { type: 'email', email, token: code } });
  // Primo accesso su questo dispositivo: i posti di qui e quelli dell'account si uniscono.
  store(null);
  return saveSession(email, r, { first: true });
}

export function signOut() {
  const s = load();
  store(null);
  if (s?.access) call('/auth/v1/logout', { method: 'POST', token: s.access }).catch(() => {});
}

async function token() {
  let s = load();
  if (!s?.refresh) return null;
  if (Date.now() > s.expiresAt - 60 * 1000) {
    try {
      const r = await call('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: s.refresh } });
      s = saveSession(s.email, r);
    } catch (err) {
      // Accesso scaduto o tolto: si esce, i posti restano su questo dispositivo.
      if (err.status === 400 || err.status === 401) store(null);
      throw err;
    }
  }
  return s;
}

const snapshot = (prefs) => JSON.stringify(exportData(prefs));

/** Mette i dati arrivati al posto di quelli di qui. */
function applyRemote(data, prefs) {
  replacePlaces(data.places);
  const known = new Set(PLACES.map((p) => p.id));
  const list = [...new Set([...data.list, ...data.favorites])].filter((id) => known.has(id));
  return { ...prefs, places: list, favorites: data.favorites.filter((id) => known.has(id)), aspects: data.aspects };
}

let running = null;
let again = false;

/**
 * Allinea questo dispositivo con l'account.
 * - primo accesso: unisce i posti di qui con quelli dell'account;
 * - se l'account è cambiato altrove e qui no: prende quelli dell'account;
 * - se è cambiato qui: manda i posti di qui (se sono cambiati tutti e due, prima li unisce).
 * @param {() => object} getPrefs preferenze attuali
 * @param {(prefs: object) => void} setPrefs da chiamare quando i posti cambiano
 */
export function syncNow(getPrefs, setPrefs) {
  if (!syncEnabled() || !load()) return Promise.resolve();
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      await syncOnce(getPrefs, setPrefs);
    } catch (err) {
      const s = load();
      if (s) store({ ...s, error: navigator.onLine === false ? 'offline' : err.message });
    } finally {
      running = null;
      if (again) {
        again = false;
        syncNow(getPrefs, setPrefs);
      }
    }
  })();
  return running;
}

async function syncOnce(getPrefs, setPrefs) {
  let s = await token();
  if (!s) return;
  const rows = await call(`/rest/v1/${TABLE}?select=dati,aggiornato&user_id=eq.${s.userId}`, { token: s.access });
  const row = Array.isArray(rows) ? rows[0] : null;
  const remote = row ? cleanData(row.dati) : null;
  let prefs = getPrefs();
  const localChanged = snapshot(prefs) !== s.pushed;
  const remoteChanged = row && row.aggiornato !== s.remoteAt;

  if (remote && (s.first || (remoteChanged && localChanged))) {
    prefs = mergeImport(remote, prefs).prefs;
    setPrefs(prefs);
  } else if (remote && remoteChanged) {
    prefs = applyRemote(remote, prefs);
    setPrefs(prefs);
    s = load();
    store({ ...s, pushed: snapshot(prefs), remoteAt: row.aggiornato, syncedAt: Date.now(), error: null, first: false });
    return;
  }

  const snap = snapshot(prefs);
  s = load();
  if (snap === s.pushed && !s.first) {
    store({ ...s, syncedAt: Date.now(), error: null });
    return;
  }
  const aggiornato = new Date().toISOString();
  await call(`/rest/v1/${TABLE}?on_conflict=user_id`, {
    method: 'POST',
    token: s.access,
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: { user_id: s.userId, dati: JSON.parse(snap), aggiornato },
  });
  store({ ...load(), pushed: snap, remoteAt: aggiornato, syncedAt: Date.now(), error: null, first: false });
}
