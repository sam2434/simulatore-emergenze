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
  let SUPABASE_URL = "https://kqtmfinowljajxowtzdl.supabase.co";
  let SUPABASE_ANON_KEY = "sb_publishable_cof3SAPRwDWXkHrCs7CiPQ_CAqnh00Z";
  // >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

  const FILE_URL = SUPABASE_URL;
  const FILE_KEY = SUPABASE_ANON_KEY;

  const LS_CFG = "coeulive_config"; // stessi 2 valori della pagina live, solo su questo browser

  function cfgSalvata(){
    try{
      const cfg = JSON.parse(localStorage.getItem(LS_CFG) || "null");
      if(cfg && typeof cfg.url === "string" && typeof cfg.key === "string") return cfg;
    }catch(_){}
    return { url: "", key: "" };
  }

  function applicaCfgSalvata(){
    const s = cfgSalvata();
    if(s.url && s.key){
      SUPABASE_URL = s.url;
      SUPABASE_ANON_KEY = s.key;
    }
  }

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

  const LS_RIGHE = "coeulive_righe";   // missione_id -> ultima riga completa (storico mezzi fino alla chiusura)
  function loadRighe(){ try{ const o = JSON.parse(localStorage.getItem(LS_RIGHE) || "{}"); return (o && typeof o === "object") ? o : {}; }catch(_){ return {}; } }
  function saveRighe(o){
    try{
      const keys = Object.keys(o).slice(-500), slim = {};
      for(const k of keys) slim[k] = o[k];
      localStorage.setItem(LS_RIGHE, JSON.stringify(slim));
    }catch(_){}
  }
  // unione per codice mezzo: i dati freschi vincono, gli usciti di scena restano con l'ultimo stato noto
  function unisciMezzi(vecchi, nuovi){
    const map = {};
    for(const v of (vecchi || [])) if(v && v.c) map[v.c] = v;
    for(const v of (nuovi || [])) if(v && v.c) map[v.c] = v;
    return Object.values(map);
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
    const righe = loadRighe();
    const ora = new Set(), daScrivere = [];
    for(const m of snap){
      const r = buildRow(m);
      const prev = righe[r.missione_id];
      // stesso intervento (stesso tipo+luogo): accumula tutti i mezzi visti finora.
      // Se l'id è stato riusato da un nuovo intervento (dopo un reset), si riparte da zero.
      if(prev && prev.tipologia === r.tipologia && prev.localita === r.localita){
        r.mezzi = unisciMezzi(prev.mezzi, r.mezzi);
      }
      const h = hashRow(r);
      righe[r.missione_id] = r;
      ora.add(r.missione_id);
      visti.add(r.missione_id);
      if(cache.get(r.missione_id) !== h){ daScrivere.push(r); cache.set(r.missione_id, h); }
    }
    // chiuse per sparizione: viste prima, non piu presenti, mai marcate.
    // Alla chiusura si salva la riga COMPLETA (tutti i mezzi accumulati fino alla
    // chiusura, col codice paziente di ognuno), non solo il cambio di stato.
    const sparite = [...visti].filter(id => !ora.has(id) && !chiuse.has(id));
    try{
      if(daScrivere.length){
        const { error } = await client.from("missioni_live").upsert(daScrivere, { onConflict: "missione_id" });
        if(error) throw error;
        moveCount += daScrivere.length;
      }
      for(const id of sparite){
        const last = righe[id];
        if(last){
          const fin = Object.assign({}, last, { stato: "chiusa" });
          const { error } = await client.from("missioni_live").upsert(fin, { onConflict: "missione_id" });
          if(error) throw error;
          moveCount++;
        }else{
          const { error } = await client.from("missioni_live").update({ stato: "chiusa" }).eq("missione_id", id);
          if(error) throw error;
        }
        chiuse.add(id);
        cache.delete(id);
        delete righe[id];
      }
      saveSet(LS_VISTE, new Set([...ora, ...[...visti].filter(id => ora.has(id))])); // tiene solo le attive
      saveSet(LS_CHIUSE, chiuse);
      saveRighe(righe);
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

  function hostPubblico(){
    try{ return new URL(String(SUPABASE_URL || "").trim()).hostname; }
    catch(_){ return ""; }
  }

  async function diagnostica(){
    let snap = [];
    try{ snap = (window.COEUSIM && COEUSIM.missioniLive) ? (COEUSIM.missioniLive() || []) : []; }catch(_){ snap = []; }
    let loggato = false;
    try{
      if(client){
        const r = await client.auth.getSession();
        loggato = !!(r && r.data && r.data.session);
      }
    }catch(_){ loggato = false; }
      const prima = snap.length ? snap[0] : null;
      return {
        configurato: configurato(),
        host: hostPubblico(),
        loggato,
        pubblica: pubblicaOn(),
        missioni: snap.length,
        prima: prima ? {
          codice: prima.codice || "SENZA CODICE",
          mezzi: Array.isArray(prima.mezzi) ? prima.mezzi.length : 0,
          tipi: Array.isArray(prima.mezzi) ? prima.mezzi.map(m => (m && (m.t || m.cat)) || "?").join("+") : "",
          tpaz: Array.isArray(prima.mezzi) ? prima.mezzi.map(m => (m && (m.tr ? (m.tpaz || "non ancora a bordo") : "non trasporta")) || "?").join("+") : ""
        } : null,
      errore: lastError || "",
      sync: lastSync || "",
      scritture: moveCount
    };
  }

  async function init(){
    if(booted) return;
    booted = true;
    applicaCfgSalvata();
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
        const righe = loadRighe();
        for(const id of [...visti]){
          if(!ora.has(id) && !chiuse.has(id)){
            const last = righe[id];
            let error = null;
            if(last){
              const res = await client.from("missioni_live").upsert(Object.assign({}, last, { stato: "chiusa" }), { onConflict: "missione_id" });
              error = res.error;
            }else{
              const res = await client.from("missioni_live").update({ stato: "chiusa" }).eq("missione_id", id);
              error = res.error;
            }
            if(!error){ chiuse.add(id); delete righe[id]; }
          }
        }
        saveSet(LS_CHIUSE, chiuse);
        saveRighe(righe);
      }
      saveSet(LS_VISTE, ora);
    }catch(_){ /* il gioco non deve mai bloccarsi per la sync */ }
    timer = setInterval(tick, POLL_MS);
    tick();
  }

  function wireDialog(){
    const dlg = $("liveLoginDlg"), formE = $("liveEmail"), formP = $("livePass"), st = $("liveStatus");
    const cfgUrl = $("liveCfgUrl"), cfgKey = $("liveCfgKey"), cfgSt = $("liveCfgStato");
    const salvata = cfgSalvata();
    if(cfgUrl) cfgUrl.value = salvata.url || (SUPABASE_URL.indexOf("INSERISCI-IL-TUO") < 0 ? SUPABASE_URL : "");
    if(cfgKey) cfgKey.value = salvata.key || (SUPABASE_ANON_KEY.indexOf("INCOLLA-QUI") < 0 ? SUPABASE_ANON_KEY : "");
    const riavviaConnessione = () => {
      try{ if(timer){ clearInterval(timer); timer = null; } }catch(_){}
      client = null;
      try{ cache.clear(); }catch(_){}
      lastError = "";
      booted = false;
      init();
    };
    const cfgSave = $("liveCfgSave");
    if(cfgSave) cfgSave.onclick = () => {
      if(!cfgUrl || !cfgKey) return;
      let url = String(cfgUrl.value || "").trim();
      while(url.slice(-1) === "/") url = url.slice(0, -1);
      const key = String(cfgKey.value || "").trim();
      if(!url || !key){ if(cfgSt) cfgSt.textContent = "Inserisci entrambi i valori e riprova."; return; }
      if(url.indexOf("sb_secret_") >= 0 || key.indexOf("sb_secret_") === 0){
        if(cfgSt) cfgSt.textContent = "Hai incollato una chiave riservata sb_secret_: usa la Publishable key.";
        return;
      }
      try{
        const u = new URL(url);
        if(u.protocol !== "https:" || u.hostname.toLowerCase().indexOf(".supabase.co") < 0) throw new Error("URL non valido");
      }catch(_){
        if(cfgSt) cfgSt.textContent = "Project URL non valido: deve essere https://xxxx.supabase.co.";
        return;
      }
      try{ localStorage.setItem(LS_CFG, JSON.stringify({ url, key })); }catch(_){}
      if(cfgSt) cfgSt.textContent = "Salvata. Riavvio la connessione…";
      riavviaConnessione();
      refreshDlg();
    };
    const cfgClear = $("liveCfgClear");
    if(cfgClear) cfgClear.onclick = () => {
      try{ localStorage.removeItem(LS_CFG); }catch(_){}
      SUPABASE_URL = FILE_URL;
      SUPABASE_ANON_KEY = FILE_KEY;
      if(cfgUrl) cfgUrl.value = "";
      if(cfgKey) cfgKey.value = "";
      if(cfgSt) cfgSt.textContent = "Configurazione cancellata da questo browser.";
      riavviaConnessione();
      refreshDlg();
    };
    const openBtn = $("liveLoginBtn");
    if(openBtn) openBtn.onclick = () => { if(dlg && dlg.showModal) dlg.showModal(); refreshDlg(); };
    const closeBtn = $("liveCloseBtn");
    if(closeBtn) closeBtn.onclick = () => { if(dlg && dlg.close) dlg.close(); };
    const loginBtn = $("liveDoLogin");
    if(loginBtn) loginBtn.onclick = async () => {
      if(!client){ if(st) st.textContent = "⚠️ salva prima Project URL e Publishable key qui sopra"; return; }
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
    const diagBtn = $("liveDiagBtn");
    if(diagBtn) diagBtn.onclick = async () => {
      if(st) st.textContent = "⏳ verifica in corso…";
      try{
        const d = await diagnostica();
        const prima = d.prima
          ? ("prima missione: " + d.prima.codice + " + " + d.prima.mezzi + " mezzi" + (d.prima.tipi ? " (" + d.prima.tipi + ")" : ""))
          + (d.prima.tpaz ? " · trasporto: " + d.prima.tpaz : "")
          : "nessuna missione aperta";
        if(st) st.textContent = "🧪 config: " + (d.configurato ? "sì" : "no") +
          " · login: " + (d.loggato ? "sì" : "no") +
          " · invio: " + (d.pubblica ? "on" : "off") +
          " · missioni: " + d.missioni +
          " · " + prima +
          (d.errore ? " · errore: " + d.errore : "") +
          (d.sync ? " · " + d.sync : "");
      }catch(e){ if(st) st.textContent = "⚠️ verifica non riuscita"; }
      statoUI();
    };
    const chiudiBtn = $("liveChiudiBtn");
    if(chiudiBtn) chiudiBtn.onclick = async () => {
      if(st) st.textContent = "⏳ chiusura bloccate in corso…";
      try{
        const r = await chiudiBloccate();
        if(st) st.textContent = r.ok
          ? ("✅ chiuse " + r.chiuse + " missioni bloccate (spariscono dal filtro Aperte)")
          : ("⚠️ " + (r.msg || "chiusura non riuscita"));
      }catch(e){ if(st) st.textContent = "⚠️ chiusura non riuscita"; }
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

  // Chiude le righe rimaste bloccate su "attiva/in_corso" (es. dopo un reset
  // senza sync): tutto ciò che è aperto in tabella ma non è più nel gioco
  // viene marcato 'chiusa' e sparisce dal filtro "Aperte" del pannello live.
  async function chiudiBloccate(){
    if(!client || !configurato()) return { ok:false, msg:"live non configurato" };
    let session = null;
    try{ const r = await client.auth.getSession(); session = r.data && r.data.session; }catch(_){}
    if(!session) return { ok:false, msg:"login operatore richiesto" };
    let snap = [];
    try{ snap = (window.COEUSIM && COEUSIM.missioniLive) ? (COEUSIM.missioniLive() || []) : []; }catch(_){ snap = []; }
    const ora = new Set(snap.map(m => String(m.id)));
    let aperte = [];
    try{
      const res = await client.from("missioni_live").select("missione_id").in("stato", ["attiva", "in_corso"]).limit(500);
      if(res.error) throw res.error;
      aperte = res.data || [];
    }catch(e){ return { ok:false, msg:String((e && e.message) || e).slice(0, 160) }; }
    const chiuse = loadSet(LS_CHIUSE);
    const mem = loadRighe();
    let n = 0;
    for(const r of aperte){
      const id = String(r.missione_id);
      if(ora.has(id)) continue; // ancora aperta nel gioco: non toccare
      try{
        let error = null;
        const last = mem[id];
        if(last){
          const res = await client.from("missioni_live").upsert(Object.assign({}, last, { stato: "chiusa" }), { onConflict: "missione_id" });
          error = res.error;
        }else{
          const res = await client.from("missioni_live").update({ stato: "chiusa" }).eq("missione_id", id);
          error = res.error;
        }
        if(error) throw error;
        chiuse.add(id);
        cache.delete(id);
        delete mem[id];
        n++;
      }catch(e){ return { ok:false, msg:String((e && e.message) || e).slice(0, 160), chiuse:n }; }
    }
    saveSet(LS_CHIUSE, chiuse);
    saveRighe(mem);
    tick();
    return { ok:true, chiuse:n };
  }

  return { init, tick, configurato, mappaStato, buildRow, diagnostica, chiudiBloccate };
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
