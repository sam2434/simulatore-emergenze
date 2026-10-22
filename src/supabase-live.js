/* =====================================================================
 * COEULIVE — ponte Simulatore Emergenze -> Supabase (tabella missioni_live)
 *
 * CONFIGURAZIONE (unico punto dove incollare i 2 valori, niente altro):
 *   1. SUPABASE_URL = il Project URL, formato https://xxxx.supabase.co
 *      (Dashboard > Project Settings > Data API > Project URL)
 *   2. SUPABASE_ANON_KEY = la Publishable key (quella che inizia con
 *      sb_publishable_...). E' pubblica per disegno: la RLS limita comunque
 *      la lettura alle righe con pubblica = true.
 * MAI qui password o chiavi riservate: solo i 2 valori pubblici sopra.
 *
 * COME FUNZIONA
 * - Legge le missioni aperte da COEUSIM.missioniLive() ogni 5 secondi e fa
 *   upsert su missione_id (mai duplicati: stessa missione = stessa riga).
 * - Quando una missione sparisce dall'elenco (chiusa a mano o in automatico)
 *   imposta stato = 'chiusa' (le chiusure rimuovono la missione dall'array,
 *   quindi la chiusura si rileva per sparizione).
 * - Scrive SOLO se l'operatore ha fatto login (Supabase Auth): la tabella
 *   accetta scritture solo dagli UUID in public.operatori. Senza login il
 *   gioco funziona normalmente e la sync resta in attesa.
 * ===================================================================== */
window.COEULIVE = (() => {
  // >>>>>>>>>>>>>>>>>>>>>>> CONFIG — INCOLLA QUI I TUOI 2 VALORI <<<<<<<<<<<<<<<<<<<<<<<
  const SUPABASE_URL = "https://INSERISCI-IL-TUO-PROJECT-URL.supabase.co";
  const SUPABASE_ANON_KEY = "INCOLLA-QUI-LA-TUA-PUBLISHABLE-KEY";
  // >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

  const LS_VISTE = "coeulive_viste";     // missione_id mai visti (per chiudere dopo un reload)
  const LS_CHIUSE = "coeulive_chiuse";   // missione_id gia marcati 'chiusa' (evita riscritture)
  const LS_PUBBLICA = "coeulive_pubblica"; // toggle globale "pubblica su live"
  const POLL_MS = 5000;

  let client = null, timer = null, booted = false;
  let lastError = "", lastSync = null, moveCount = 0;
  let cache = new Map(); // missione_id -> hash riga (solo righe attive viste in questa sessione)

  function $(id){ return document.getElementById(id); }
  function loadSet(k){ try{ return new Set(JSON.parse(localStorage.getItem(k) || "[]")); }catch(_){ return new Set(); } }
  function saveSet(k, s){ try{ localStorage.setItem(k, JSON.stringify([...s].slice(-500))); }catch(_){} }

  function configurato(){
    return SUPABASE_URL.indexOf("INSERISCI-IL-TUO") < 0 &&
           SUPABASE_ANON_KEY.indexOf("INCOLLA-QUI") < 0 &&
           SUPABASE_URL.indexOf("http") === 0;
  }

  // attesa/viaggio -> 'attiva' (appena creata / mezzi in arrivo)
  // sul_posto/trasporto -> 'in_corso' (squadre al lavoro / paziente a bordo)
  function mappaStato(st){
    return (st === "sul_posto" || st === "trasporto") ? "in_corso" : "attiva";
  }

  function buildRow(m){
    const loc = (m.indirizzo || "") +
      ((m.comune && (m.indirizzo || "").indexOf(m.comune) < 0) ? " - " + m.comune : "") +
      (m.prov ? " (" + m.prov + ")" : "");
    // NOTA: richiede le colonne `codice` (text) e `mezzi` (jsonb) in tabella.
    // Esegui una volta in SQL Editor: vedi MIGRAZIONE in fondo al file.
    return {
      missione_id: String(m.id),
      tipologia: m.tipo || "?",
      localita: loc || "?",
      comune: m.comune || null,
      provincia: m.prov || null,
      num_pazienti: Math.max(0, m.nPaz | 0),
      stato: mappaStato(m.stato),
      pubblica: true,
      codice: m.codice || "SENZA CODICE",
      mezzi: Array.isArray(m.mezzi) ? m.mezzi : []
    };
  }

  function hashRow(r){
    return [r.tipologia, r.localita, r.comune, r.provincia, r.num_pazienti, r.stato, r.pubblica, r.codice, JSON.stringify(r.mezzi)].join("|");
  }

  function setBox(txt){
    const b = $("liveSyncBox");
    if(b) b.textContent = txt;
    const btn = $("liveLoginBtn");
    if(btn) btn.textContent = client ? "🔑 Live: on" : "🔑 Live: off";
  }

  async function statoUI(){
    if(!configurato()){ setBox("⚪ live non configurato"); return; }
    if(!client){ setBox("⚪ live non configurato"); return; }
    try{
      const { data } = await client.auth.getSession();
      if(data && data.session){ setBox(lastError ? ("⚠️ live: errore") : ("🟢 live" + (lastSync ? " " + lastSync : ""))); }
      else setBox("🟡 live: login richiesto");
    }catch(_){ setBox("⚠️ live: errore rete"); }
  }

  async function tick(){
    if(!client || !configurato()) return;
    if(!pubblicaOn()) return; // toggle globale spento: nessuna scrittura
    let session = null;
    try{ const r = await client.auth.getSession(); session = r.data && r.data.session; }
    catch(e){ lastError = "rete"; statoUI(); return; }
    if(!session) return; // non loggato: il gioco continua, la sync aspetta
    if(!window.COEUSIM || !COEUSIM.missioniLive) return;
    let snap = [];
    try{ snap = COEUSIM.missioniLive() || []; }catch(_){ return; }

    const visti = loadSet(LS_VISTE), chiuse = loadSet(LS_CHIUSE);
    const ora = new Set(), daScrivere = [];
    for(const m of snap){
      const r = buildRow(m), h = hashRow(r);
      ora.add(r.missione_id);
      visti.add(r.missione_id);
      if(cache.get(r.missione_id) !== h){ daScrivere.push(r); cache.set(r.missione_id, h); }
    }
    // chiuse per sparizione: viste prima, non piu presenti, mai marcate
    const sparite = [...visti].filter(id => !ora.has(id) && !chiuse.has(id));
    try{
      if(daScrivere.length){
        const { error } = await client.from("missioni_live").upsert(daScrivere, { onConflict: "missione_id" });
        if(error) throw error;
        moveCount += daScrivere.length;
      }
      for(const id of sparite){
        const { error } = await client.from("missioni_live").update({ stato: "chiusa" }).eq("missione_id", id);
        if(error) throw error;
        chiuse.add(id);
        cache.delete(id);
      }
      saveSet(LS_VISTE, new Set([...ora, ...[...visti].filter(id => ora.has(id))])); // tiene solo le attive
      saveSet(LS_CHIUSE, chiuse);
      lastError = "";
      const d = new Date();
      lastSync = "sync " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + ":" + String(d.getSeconds()).padStart(2, "0");
    }catch(e){
      lastError = String((e && e.message) || e).slice(0, 160);
      try{ console.warn("[COEULIVE]", lastError); }catch(_){}
    }
    statoUI();
    const st = $("liveStatus");
    if(st) st.textContent = lastError ? ("⚠️ " + lastError) : ("✅ sessione attiva (" + moveCount + " scritture)");
  }

  function pubblicaOn(){
    try{ return localStorage.getItem(LS_PUBBLICA) !== "off"; }catch(_){ return true; }
  }

  async function init(){
    if(booted) return;
    booted = true;
    // ripristina toggle + collega il dialog SEMPRE (anche non configurato:
    // il gioco non deve mai accorgersi della sync)
    const tgl = $("livePubblica");
    if(tgl){
      tgl.checked = pubblicaOn();
      tgl.onchange = () => { try{ localStorage.setItem(LS_PUBBLICA, tgl.checked ? "on" : "off"); }catch(_){} statoUI(); };
    }
    wireDialog();
    if(!configurato()){ setBox("⚪ live non configurato"); return; }
    if(!window.supabase || !window.supabase.createClient){
      setBox("⚠️ live: libreria non caricata");
      return;
    }
    try{
      client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }catch(e){ setBox("⚠️ live: config errata"); return; }
    // (wireDialog già collegato sopra)
    // chiude dopo un reload le missioni viste in una sessione precedente
    try{
      const visti = loadSet(LS_VISTE), chiuse = loadSet(LS_CHIUSE);
      let snap = [];
      try{ snap = (window.COEUSIM && COEUSIM.missioniLive) ? (COEUSIM.missioniLive() || []) : []; }catch(_){}
      const ora = new Set(snap.map(m => String(m.id)));
      const { data } = await client.auth.getSession();
      if(data && data.session){
        for(const id of [...visti]){
          if(!ora.has(id) && !chiuse.has(id)){
            const { error } = await client.from("missioni_live").update({ stato: "chiusa" }).eq("missione_id", id);
            if(!error){ chiuse.add(id); }
          }
        }
        saveSet(LS_CHIUSE, chiuse);
      }
      saveSet(LS_VISTE, ora);
    }catch(_){ /* il gioco non deve mai bloccarsi per la sync */ }
    timer = setInterval(tick, POLL_MS);
    tick();
  }

  function wireDialog(){
    const dlg = $("liveLoginDlg"), formE = $("liveEmail"), formP = $("livePass"), st = $("liveStatus");
    const openBtn = $("liveLoginBtn");
    if(openBtn) openBtn.onclick = () => { if(dlg && dlg.showModal) dlg.showModal(); refreshDlg(); };
    const closeBtn = $("liveCloseBtn");
    if(closeBtn) closeBtn.onclick = () => { if(dlg && dlg.close) dlg.close(); };
    const loginBtn = $("liveDoLogin");
    if(loginBtn) loginBtn.onclick = async () => {
      if(!client){ if(st) st.textContent = "⚠️ incolla prima Project URL e Publishable key in src/supabase-live.js"; return; }
      if(st) st.textContent = "⏳ accesso in corso…";
      try{
        const { error } = await client.auth.signInWithPassword({ email: formE.value.trim(), password: formP.value });
        if(error) throw error;
        formP.value = "";
        if(st) st.textContent = "✅ operatore collegato";
        statoUI(); tick();
      }catch(e){ if(st) st.textContent = "⚠️ " + String((e && e.message) || e).slice(0, 200); }
    };
    const outBtn = $("liveDoLogout");
    if(outBtn) outBtn.onclick = async () => {
      try{ await client.auth.signOut(); }catch(_){}
      if(st) st.textContent = "operatore scollegato (gioco invariato)";
      statoUI();
    };
    try{
      client.auth.onAuthStateChange(() => { statoUI(); refreshDlg(); });
    }catch(_){}
  }

  async function refreshDlg(){
    const lbl = $("liveWho");
    if(!lbl || !client) return;
    try{
      const { data } = await client.auth.getSession();
      lbl.textContent = (data && data.session && data.session.user && data.session.user.email)
        ? ("collegato come " + data.session.user.email)
        : "non collegato (il gioco funziona comunque)";
    }catch(_){ lbl.textContent = "stato sconosciuto (errore rete)"; }
  }

  return { init, tick, configurato, mappaStato, buildRow };
})();
/* =====================================================================
 * MIGRAZIONE (una sola volta, in Supabase Dashboard > SQL Editor).
 * Aggiunge le 2 colonne usate per codice colore e mezzi assegnati.
 * Non tocca dati, RLS o policy esistenti.
 * =====================================================================
 * alter table public.missioni_live
 *   add column if not exists codice text not null default 'SENZA CODICE',
 *   add column if not exists mezzi jsonb not null default '[]';
 */
