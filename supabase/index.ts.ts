// =====================================================================
// IA-CENTRALE — Supabase Edge Function (Deno).
// Gira in cloud ogni 5 minuti via pg_cron, senza browser aperto.
// File nella stessa cartella: engine.js, dati.js (copie di src/ia-cloud/).
//
// Deploy (vedi README.md): supabase functions deploy ia-centrale
// Segreti (SOLO dashboard: Functions > ia-centrale > Secrets, MAI nel codice):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { iaTick } from "./engine.js";
import { IA_TIPI, IA_COMUNI, IA_VIE, IA_SEDI, IA_MEZZI } from "./dati.js";

const HEARTBEAT_MINUTI = 15; // simulatore muto da più di così -> l'IA riprende la missione
const STALE_CLAIM_MINUTI = 30; // lock di un run precedente bloccato -> subentro

const COLONNE = "missione_id,tipologia,descrizione,localita,comune,provincia,lat,lng,num_pazienti,pazienti,stato,codice,mezzi,cronologia,origine,gestita_da,pubblica,ia_fase,ia_scade,heartbeat_at,chiusa_il,created_at,updated_at";

Deno.serve(async () => {
  try {
    const URL = Deno.env.get("SUPABASE_URL") || "";
    const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!URL || !KEY) return Response.json({ ok: false, errore: "segreti mancanti" }, { status: 500 });
    const db = createClient(URL, KEY);
    const now = Date.now();

    // --- lock anti-doppie-esecuzioni (claim atomico + subentro se stantio) ---
    const st = await db.from("ia_stato").select("*").eq("id", 1).maybeSingle();
    if (st.error) throw st.error;
    const s = st.data || {};
    const lockFresco = s.in_corsa && s.aggiornato_il && (now - new Date(s.aggiornato_il).getTime() < STALE_CLAIM_MINUTI * 60000);
    if (lockFresco) return Response.json({ ok: true, salto: "run precedente ancora attivo" });
    const claim = await db.from("ia_stato").update({
      in_corsa: true, aggiornato_il: new Date(now).toISOString()
    }).eq("id", 1);
    if (claim.error) throw claim.error;

    let nUpsert = 0, nChiuse = 0, nSpawn = 0, nRecuperi = 0;
    try {
      // --- stato spawn ---
      const stato = {
        ultimo_spawn: s.ultimo_spawn ? new Date(s.ultimo_spawn).getTime() : null,
        prossimo_spawn: s.prossimo_spawn ? new Date(s.prossimo_spawn).getTime() : null
      };
      // --- missioni aperte ---
      const ap = await db.from("missioni_live").select(COLONNE)
        .in("stato", ["attiva", "in_corso"]).limit(200);
      if (ap.error) throw ap.error;
      let aperte = ap.data || [];
      // --- recupero missioni abbandonate dal simulatore (heartbeat stantio) ---
      const limite = new Date(now - HEARTBEAT_MINUTI * 60000).toISOString();
      for (const r of aperte) {
        if (r.gestita_da === "simulatore" && r.heartbeat_at && r.heartbeat_at < limite) {
          const crono = Array.isArray(r.cronologia) ? r.cronologia.slice(-99) : [];
          crono.push({ t: now, e: "🤖 centrale IA: riprendo la missione (simulatore scollegato)." });
          const rec = await db.from("missioni_live").update({
            gestita_da: "ia", cronologia: crono
          }).eq("missione_id", r.missione_id);
          if (!rec.error) { r.gestita_da = "ia"; r.cronologia = crono; nRecuperi++; }
        }
      }
      // --- motore ---
      const dati = { tipi: IA_TIPI, comuni: IA_COMUNI, vie: IA_VIE, sedi: IA_SEDI, mezzi: IA_MEZZI };
      const out = iaTick({
        aperte, stato, dati, now, rnd: Math.random,
        cfg: { minMinuti: 25, maxMinuti: 35, maxAperte: 5, maxiProb: 0.04 }
      });
      // --- scritture (solo righe IA: mai toccare quelle del simulatore attivo) ---
      for (const r of out.upsert) {
        if (r.gestita_da && r.gestita_da !== "ia") continue;
        const up = await db.from("missioni_live").upsert(r, { onConflict: "missione_id" });
        if (up.error) throw up.error;
        nUpsert++;
        if (r.stato === "attiva" && r.cronologia && r.cronologia.length <= 1) nSpawn++;
        if (r.stato === "chiusa") nChiuse++;
      }
      // --- salva stato spawn + rilascia lock ---
      await db.from("ia_stato").update({
        ultimo_spawn: out.stato.ultimo_spawn ? new Date(out.stato.ultimo_spawn).toISOString() : s.ultimo_spawn,
        prossimo_spawn: out.stato.prossimo_spawn ? new Date(out.stato.prossimo_spawn).toISOString() : s.prossimo_spawn,
        in_corsa: false, aggiornato_il: new Date().toISOString()
      }).eq("id", 1);
      return Response.json({ ok: true, upsert: nUpsert, spawn: nSpawn, chiuse: nChiuse, recuperi: nRecuperi, prossimo: out.stato.prossimo_spawn });
    } catch (e) {
      try {
        await db.from("ia_stato").update({ in_corsa: false, aggiornato_il: new Date().toISOString() }).eq("id", 1);
      } catch (_) { /* lock rilasciato al prossimo giro stantio */ }
      throw e;
    }
  } catch (e) {
    return Response.json({ ok: false, errore: String((e && e.message) || e).slice(0, 300) }, { status: 500 });
  }
});
