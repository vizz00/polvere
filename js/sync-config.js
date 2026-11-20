// Sincronizzazione dei posti tra dispositivi (js/sync.js). Spenta finché questi due campi sono vuoti.
// Si riempiono con i dati del progetto Supabase: vedi SINCRONIZZAZIONE.md.
// La chiave "anon" è pubblica per natura (sta in ogni sito che usa Supabase): i dati di ognuno
// sono protetti dalle regole del database, che lasciano leggere e scrivere solo i propri.
export const SUPABASE_URL = '';
export const SUPABASE_ANON_KEY = '';
