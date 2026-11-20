# Accendere la sincronizzazione dei posti

L'app è già pronta: la sincronizzazione resta **spenta** finché non riempi due righe in `js/sync-config.js`.
Serve un database gratuito su **Supabase** (piano Free, senza carta). Tempo: circa 15 minuti.

## 1. Crea il progetto
1. Vai su https://supabase.com → **Start your project** → entra con GitHub.
2. **New project**: nome `polvere`, scegli una password per il database (salvala, non serve all'app), regione **Central EU (Frankfurt)**. Crea.

## 2. Crea la tabella (copia e incolla)
Nel menu a sinistra **SQL Editor** → **New query**, incolla tutto questo e premi **Run**:

```sql
create table public.posti (
  user_id uuid primary key references auth.users on delete cascade default auth.uid(),
  dati jsonb not null,
  aggiornato timestamptz not null default now()
);
alter table public.posti enable row level security;
create policy "leggo i miei" on public.posti for select using (auth.uid() = user_id);
create policy "scrivo i miei" on public.posti for insert with check (auth.uid() = user_id);
create policy "cambio i miei" on public.posti for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "cancello i miei" on public.posti for delete using (auth.uid() = user_id);
```

Queste regole fanno sì che ognuno legga e scriva **solo la propria riga**.

## 3. Email con il codice (non con il link)
L'app chiede un codice di 6 cifre (un link nell'email aprirebbe Safari, che sull'iPhone ha dati separati dall'app sulla schermata Home).

1. **Authentication** → **Emails** (o *Email Templates*) → **Magic Link**.
2. Sostituisci il testo con:
   ```html
   <h2>Il tuo codice per Polvere</h2>
   <p style="font-size:28px;letter-spacing:4px"><b>{{ .Token }}</b></p>
   ```
   Fai lo stesso nel modello **Confirm signup**. Salva.
3. **Authentication** → **Sign In / Providers** → **Email**: deve essere attivo.

## 4. Copia le due chiavi nell'app
1. **Project Settings** → **API** (o *Data API* e *API Keys*).
2. Copia **Project URL** (tipo `https://abcd.supabase.co`) e la chiave **anon / publishable** (quella pubblica, NON la `service_role` o *secret*).
3. Su GitHub apri `js/sync-config.js` → matita ✏️ → incolla:
   ```js
   export const SUPABASE_URL = 'https://abcd.supabase.co';
   export const SUPABASE_ANON_KEY = 'la-chiave-anon';
   ```
4. In `sw.js` aumenta di 1 il numero di `VERSION` (così il telefono si aggiorna) e salva con **Commit changes**.

La chiave *anon* è fatta per stare nel sito: da sola non permette di leggere i dati degli altri.

## 5. Amici
Il servizio email incluso in Supabase manda poche email all'ora e (sul piano gratuito) solo agli indirizzi del tuo team Supabase:
per te va subito. Per farla provare agli amici serve un servizio email gratuito, per esempio **Brevo** (300 email al giorno):
**Authentication** → **Emails** → **SMTP Settings** → attiva *Custom SMTP* e copia i dati SMTP che Brevo ti dà.

## Come funziona
- Entri con la tua email su ogni dispositivo (pagina in fondo a **Località** → "Stessi posti su tutti i tuoi dispositivi").
- Al primo accesso i posti del dispositivo e quelli dell'account si **uniscono** (non si perde niente).
- Poi ogni modifica (posto aggiunto o tolto, stella, ordine, versanti) va all'account in un paio di secondi e gli altri dispositivi la prendono quando apri l'app.
- Senza rete l'app funziona come sempre e sincronizza quando torna il campo.
- Le modifiche ai posti predefiniti (Modifica su Cervinia, ecc.) restano solo sul dispositivo.
