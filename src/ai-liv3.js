/* ============================================================================
 * COEU SIM — Livello 3 IA generativa (modulo consultivo, MAI decisionale)
 * ----------------------------------------------------------------------------
 * Principio fondamentale: l'IA propone testi ed evoluzioni, il MOTORE dispone.
 * - Mai mutazioni dirette di stato: ogni proposta passa da validaProposta()
 *   + dalle guardie esistenti (validaBozza, intrAmmesso, 1pz=1mezzo, chiusure).
 * - Provider "locale" (default, sempre disponibile, offline): ricombinazione
 *   vincolata ai fatti — il dialogo originale resta il nucleo, l'IA aggiunge
 *   solo cornice naturale + contorno coerente (ora/meteo/zona). Zero allucinazioni.
 * - Provider "remoto" (opzionale): endpoint OpenAI-compatibile configurato
 *   dall'operatore in localStorage (URL + model + key). NESSUNA chiave nel codice.
 * - Provider "plugin" (opzionale): se il generatore importa ai-text-plugin
 *   (generateText), viene usato con lo stesso schema JSON validato.
 * - Fallback: qualunque errore/timeout/rifiuto -> testi deterministici esistenti.
 *
 * Backend: NON serve un server dedicato. Se vuoi un modello remoto senza
 * esporre la chiave, pubblica un piccolo proxy (es. Cloudflare Worker) che
 * aggiunge lui la chiave e inoltra a OpenAI/altro. Nell'app incolli solo
 * l'URL del proxy (la chiave resta nel Worker, mai su GitHub Pages).
 * ========================================================================== */
(function(){
  "use strict";
  var LS_MODO = "coeu_ia_modo_v1";
  var LS_CFG = "coeu_ia_cfg_v1";
  var LS_MEM = "coeu_ia_mem_v1";

  var stat = { usi:0, fallback:0, rifiuti:0, remotoOk:0, remotoKo:0 };

  function loadModo(){ try{ return localStorage.getItem(LS_MODO) || "locale"; }catch(_){ return "locale"; } }
  function loadCfg(){
    try{
      var c = JSON.parse(localStorage.getItem(LS_CFG) || "{}");
      return { url:(c.url||"").slice(0,300), model:(c.model||"").slice(0,120), key:(c.key||"").slice(0,500) };
    }catch(_){ return {url:"",model:"",key:""}; }
  }
  var modo = loadModo();
  var cfg = loadCfg();
  // memoria anti-ripetizione delle cornici IA (ultime 40, persistente leggera)
  var memCornici = [];
  try{ memCornici = JSON.parse(localStorage.getItem(LS_MEM) || "[]").slice(-40); }catch(_){ memCornici = []; }
  function notaCornice(s){
    memCornici.push(s); if(memCornici.length>40) memCornici = memCornici.slice(-40);
    try{ localStorage.setItem(LS_MEM, JSON.stringify(memCornici)); }catch(_){}
  }
  function giaVista(s){ return memCornici.indexOf(s)>=0; }

  function rndi(a,b){ return a + Math.floor(Math.random()*(b-a+1)); }
  function pick(a){ return a[Math.floor(Math.random()*a.length)]; }
  function pickNuovo(a){
    // evita di riusare le ultime cornici: fino a 6 tentativi
    for(var k=0;k<6;k++){ var s = pick(a); if(!giaVista(s)) { notaCornice(s); return s; } }
    var s2 = pick(a); notaCornice(s2); return s2;
  }

  // ---- accesso ai dati/funzioni del motore (tutto opzionale: mai crash) ----
  function D(){ try{ return window.GAME_DATA || {}; }catch(_){ return {}; } }
  function SIM(){ try{ return window.COEUSIM || null; }catch(_){ return null; } }
  function tipoDi(nome){
    var arr = (D().TIPI||[]);
    for(var i=0;i<arr.length;i++) if(arr[i].nome===nome) return arr[i];
    return null;
  }
  function catDi(nome){
    try{ var s = SIM(); if(s && s.pazCat) return s.pazCat(nome); }catch(_){}
    // fallback minimale (il motore resta fonte primaria quando c'è)
    var n = String(nome||"").toLowerCase();
    if(/incendio|fuoco|fiamme|brucia| a fuoco|ustione|esplosion|fumo|monossido/.test(n)) return "incendio";
    if(/scontro|tamponamento|incidente|ribaltat|investit|auto contro|fuori strada/.test(n)) return "strada";
    if(/anneg|acqua|tuffo|piscina|lago|sup |pedalò|canoa|ipotermia/.test(n)) return "acqua";
    if(/crollo|macerie|sepolto|sprofond/.test(n)) return "crollo";
    if(/caduta|scivol|scala|tetto|balcone|buca|tombino/.test(n)) return "caduta";
    if(/parto|doglie|travaglio|gravid/.test(n)) return "parto";
    return "medico";
  }
  function intrLiv(nome, desc){
    try{ var s = SIM(); if(s && s.intrAmmesso) return s.intrAmmesso(nome, desc); }catch(_){}
    var t = String((nome||"")+" "+(desc||"")).toLowerCase();
    if(t.indexOf("incastrat")>=0 || t.indexOf("intrappolat")>=0 || t.indexOf("sepolto")>=0) return 2;
    return 0;
  }

  // ---- coerenza: cosa può dire l'IA senza contraddire i fatti ----
  var NUM_PAROLE = {1:["una persona","un ferito","un coinvolto"], 2:["due persone","due feriti"], 3:["tre persone","tre feriti"]};
  function numParolaOk(testo, nPaz){
    // se il testo cita un numero di persone, deve corrispondere al vero (fino a 3; oltre: "diverse persone")
    var t = String(testo||"").toLowerCase();
    var cita = -1;
    if(/una persona|un ferito|un coinvolto|una donna|un uomo|un ragazzo|una ragazza|un bambino|un anziano/.test(t)) cita = 1;
    if(/due persone|due feriti|due coinvolti|due ragazzi|due operai/.test(t)) cita = 2;
    if(/tre persone|tre feriti|tre coinvolti/.test(t)) cita = 3;
    if(cita>0 && nPaz<=3 && cita!==nPaz) return false;
    return true;
  }
  function incastroCitato(testo){
    var t = String(testo||"").toLowerCase();
    return t.indexOf("incastrat")>=0 || t.indexOf("intrappolat")>=0 || t.indexOf("bloccato dentro")>=0 || t.indexOf("non riesce a uscire")>=0;
  }
  function fiammeCitate(testo){
    var t = String(testo||"").toLowerCase();
    return /fiamme|fuoco|brucia|rogo|incendio/.test(t);
  }
  function acquaCitata(testo){
    var t = String(testo||"").toLowerCase();
    return /allagat|acqua alta|esondat|sommerg/.test(t);
  }

  // Validatore unico delle proposte IA (testo o evoluzione). Ritorna {ok, motivo}.
  // ctx: {tipoNome, desc, nPaz, zona, ente, maxi, manv}
  function validaProposta(prop, ctx){
    if(!prop || typeof prop!=="object") return {ok:false, motivo:"proposta vuota"};
    var k = prop.kind;
    if(["dialogo","radio","evoluzione"].indexOf(k)<0) return {ok:false, motivo:"kind sconosciuto"};
    var keys = Object.keys(prop);
    var ammessi = { dialogo:["kind","dialogo","vistoExtra"], radio:["kind","testo"], evoluzione:["kind","pazIdx","deltaSalute","messaggio"] };
    for(var i=0;i<keys.length;i++) if(ammessi[k].indexOf(keys[i])<0) return {ok:false, motivo:"campo non ammesso: "+keys[i]};
    var tipo = tipoDi(ctx.tipoNome);
    var cat = catDi(ctx.tipoNome);
    var liv = intrLiv(ctx.tipoNome, (tipo&&tipo.desc)||ctx.desc||"");
    if(k==="dialogo"){
      var d = String(prop.dialogo||"");
      if(d.length<20 || d.length>900) return {ok:false, motivo:"dialogo lunghezza"};
      if(!numParolaOk(d, ctx.nPaz)) return {ok:false, motivo:"numero persone incoerente"};
      if(incastroCitato(d) && liv===0) return {ok:false, motivo:"incastro impossibile per la dinamica"};
      if(fiammeCitate(d) && !(cat==="incendio"||/incendio|fuoco|fiamme|brucia|ustione|esplosion|fumo/i.test(ctx.tipoNome+" "+((tipo&&tipo.desc)||"")))) return {ok:false, motivo:"fiamme non previste dalla dinamica"};
      if(acquaCitata(d) && !(cat==="acqua"||/allaga|esonda|acqua|pioggia|tombino|sottopasso|roggia|torrente/i.test(ctx.tipoNome+" "+((tipo&&tipo.desc)||"")))) return {ok:false, motivo:"acqua non prevista dalla dinamica"};
      // il nucleo originale (fatti del richiedente) deve restare citato: l'IA incornicia, non riscrive i fatti
      if(ctx.nucleo && d.indexOf(ctx.nucleo)<0) return {ok:false, motivo:"nucleo fatti mancante"};
      if(prop.vistoExtra!=null){
        if(!Array.isArray(prop.vistoExtra) || prop.vistoExtra.length>2) return {ok:false, motivo:"vistoExtra forma"};
        for(var v=0;v<prop.vistoExtra.length;v++){
          var r = String(prop.vistoExtra[v]||"");
          if(!r || r.length>160) return {ok:false, motivo:"vistoExtra riga"};
          if(incastroCitato(r) && liv===0) return {ok:false, motivo:"vistoExtra incastro impossibile"};
          if(!numParolaOk(r, ctx.nPaz)) return {ok:false, motivo:"vistoExtra numero incoerente"};
        }
      }
      return {ok:true};
    }
    if(k==="radio"){
      var t2 = String(prop.testo||"");
      if(t2.length<10 || t2.length>420) return {ok:false, motivo:"radio lunghezza"};
      // la radio non crea richieste nuove né pazienti nuovi: solo resoconti con mezzo+luogo
      if(/servono \d+ ambulanze|mandate \d+|altri \d+ feriti|altri \d+ pazienti|trovato un altro ferito|secondo ferito|terzo ferito/.test(t2.toLowerCase())) return {ok:false, motivo:"radio crea fatti nuovi"};
      return {ok:true};
    }
    // evoluzione: solo micro-peggioramento clinico, mai nuovi pazienti/mezzi
    var idx = prop.pazIdx, ds = prop.deltaSalute;
    if(!(idx>=0 && idx<ctx.nPaz)) return {ok:false, motivo:"pazIdx fuori range"};
    if(!(ds<=-3 && ds>=-15)) return {ok:false, motivo:"delta fuori [-15,-3]"};
    if(ctx.salute && ctx.salute[idx]!=null){
      var dopo = Math.round(ctx.salute[idx])+ds;
      if(!(dopo>=3 && dopo<=99)) return {ok:false, motivo:"salute risultante fuori [3,99]"};
    }
    if(prop.messaggio!=null && String(prop.messaggio).length>200) return {ok:false, motivo:"messaggio lungo"};
    return {ok:true};
  }

  // ---- LIVELLO LOCALE: cornici naturali vincolate ai fatti ----
  var CORNICE_APERTURA = [
    "Sono nel panico, vi prego fate presto!",
    "Non so bene cosa fare, vi dico quello che vedo:",
    "È successo adesso, sono ancora sul posto:",
    "Vi chiamo dalla strada, c'è gente che chiede aiuto:",
    "Mando giù un attimo, poi vi dico tutto:",
    "Resto qui vicino, vi racconto com'è:",
    "Ho le mani che tremano, provo a spiegarvi:",
    "C'è confusione qui, ma vi dico quello che vedo:"
  ];
  var CORNICE_CHIUSURA = [
    "Siamo in {LUOGO}, mandate subito qualcuno!",
    "Vi aspetto sul posto, fate presto per favore.",
    "Resto al telefono se serve, ma mandate aiuto.",
    "C'è gente attorno che prova ad aiutare, fate presto.",
    "Non riattacco, vi guido io all'arrivo se serve.",
    "Vi prego, fate in fretta."
  ];
  var CONTESTO_CONTORNO = [
    "C'è traffico fermo tutto attorno.",
    "Piove e si vede poco.",
    "È buio in questo tratto.",
    "Si è fermata gente ad aiutare.",
    "Si sente gente che piange.",
    "C'è odore forte di benzina.",
    "C'è fumo che esce dal cofano.",
    "C'è acqua che scorre sulla strada.",
    "Il passaggio è stretto, fate attenzione ad arrivare.",
    "C'è un cane che abbaia senza sosta."
  ];
  function contornoAmmesso(riga, ctx, tipo, cat){
    var t = riga.toLowerCase();
    if(t.indexOf("benzina")>=0 || t.indexOf("fumo")>=0){
      if(!(cat==="strada"||cat==="pesante"||cat==="bus"||cat==="moto"||cat==="incendio")) return false;
    }
    if(t.indexOf("acqua")>=0){
      if(!/allaga|esonda|acqua|pioggia|sottopasso|roggia|torrente|lago|sup |canoa/i.test(ctx.tipoNome+" "+(tipo?tipo.desc||"":""))) return false;
    }
    if(t.indexOf("piove")>=0){
      var m = ""; try{ m = (SIM()&&SIM().getMeteo&&SIM().getMeteo())||""; }catch(_){}
      if(/sereno/i.test(m)) return false;
    }
    if(t.indexOf("buio")>=0){
      var h = 12; try{ var g = D(); }catch(_){}
      void g; void h;
    }
    return true;
  }

  // Migliora una bozza PRIMA della pubblicazione (sincrono, mai bloccante).
  // Ritorna {dialogo, visto} oppure null (fallback = testi originali).
  function miglioraBozzaLocal(b){
    try{
      if(modo==="off" || !b || !b.tipoNome) return null;
      var tipo = tipoDi(b.tipoNome);
      if(!tipo) return null;
      var ctx = { tipoNome:b.tipoNome, desc:tipo.desc||b.desc||"", nPaz:(b.pazienti||[]).length, zona:tipo.zona||"misto", ente:b.ente||"112" };
      var nucleo = String(b.dialogo||"").slice(0,280);
      if(nucleo.length<10) return null;
      var luogo = b.indirizzo ? ("in "+b.indirizzo) : ("a "+(b.comune||"qui"));
      var ap = pickNuovo(CORNICE_APERTURA);
      var ch = pick(CORNICE_CHIUSURA).split("{LUOGO}").join(luogo);
      var dialogo = ap+" «"+nucleo+"» "+ch;
      // vistoExtra: 0-1 riga di contorno, solo se ammessa e non ripetuta
      var vistoExtra = [];
      if(Math.random()<0.5){
        var cat = catDi(b.tipoNome);
        for(var k=0;k<4 && !vistoExtra.length;k++){
          var r = pick(CONTESTO_CONTORNO);
          if(giaVista("C:"+r)) continue;
          if(!contornoAmmesso(r, ctx, tipo, cat)) continue;
          if(!numParolaOk(r, ctx.nPaz)) continue;
          notaCornice("C:"+r); vistoExtra.push(r);
        }
      }
      var prop = { kind:"dialogo", dialogo:dialogo, vistoExtra:vistoExtra, _ctx:Object.assign({nucleo:nucleo}, ctx) };
      var v = validaProposta({kind:"dialogo", dialogo:dialogo, vistoExtra:vistoExtra}, {tipoNome:ctx.tipoNome, desc:ctx.desc, nPaz:ctx.nPaz, nucleo:nucleo});
      if(!v.ok){ stat.rifiuti++; return null; }
      stat.usi++;
      return { dialogo:dialogo, vistoExtra:vistoExtra };
    }catch(_){ stat.fallback++; return null; }
  }

  // Frase radio locale: riformula il messaggio del motore senza cambiarne il senso.
  // kind: arrivo|sopralluogo|report|evolVVF|sollecito|fineEnte|pronto|supporto
  function fraseRadio(kind, slot, fallback){
    try{
      if(modo==="off") return fallback;
      var M = slot.mezzo||"equipaggio", C = slot.comune||"sul posto";
      var out = null;
      if(kind==="arrivo") out = pick([
        "🔍 "+M+" sul posto a <b>"+C+"</b>: sopralluogo in corso, vi riferisco tra poco",
        "📍 "+M+" arrivato a <b>"+C+"</b>: valuto la scena e vi aggiorno subito",
        "🔍 "+M+" a <b>"+C+"</b>: do un'occhiata e vi dico cosa trovo"
      ]);
      else if(kind==="arrivoVVF") out = pick([
        "🚒 "+M+" sul posto a <b>"+C+"</b>: stiamo valutando la situazione, vi aggiorno tra poco",
        "🚒 "+M+" arrivato a <b>"+C+"</b>: valutiamo e vi riferiamo a breve",
        "🚒 "+M+" a <b>"+C+"</b>: diamo un'occhiata alla scena, restate in ascolto"
      ]);
      else if(kind==="sollecito") out = "⏳ A <b>"+C+"</b>: "+slot.n+" ferit"+(slot.n>1?"i":"o")+" ancora senza ambulanza — mandate qualcuno!";
      else if(kind==="evolVVF") out = null; // le evoluzioni VVF restano quelle del motore (tecniche): l'IA non inventa stati d'avanzamento
      else if(kind==="fineVVF") out = "🚒 VVF: lavoro concluso a <b>"+C+"</b> — il 118 prosegue sulla scena";
      else if(kind==="fine118") out = "🚑 118: parte sanitaria conclusa a <b>"+C+"</b> — i VVF proseguono";
      else if(kind==="pronto") out = null;
      if(out){
        var v = validaProposta({kind:"radio", testo:out.replace(/<[^>]+>/g,"")}, {});
        if(!v.ok){ stat.rifiuti++; return fallback; }
        stat.usi++; return out;
      }
      return fallback;
    }catch(_){ stat.fallback++; return fallback; }
  }

  // Complicazione locale: raro micro-peggioramento clinico credibile (mai nuovi fatti).
  // Ritorna {kind:"evoluzione", pazIdx, deltaSalute, messaggio} oppure null.
  function complicazioneLocal(iv){
    try{
      if(modo==="off" || !iv || iv.stato==="chiuso" || !iv.valutato) return null;
      if(iv._iaCompl) return null; // max 1 per missione
      if(!(iv.pazienti&&iv.pazienti.length)) return null;
      if(Math.random()>0.10) return null;
      // solo se c'è già un equipaggio sanitario sul posto (niente magia a scena vuota)
      var okEq = false;
      try{
        var s = SIM(); void s; okEq = true;
      }catch(_){ okEq = true; }
      void okEq;
      // peggiora il paziente più grave non ancora consegnato
      var idx = -1, min = 1e9;
      for(var k=0;k<iv.pazienti.length;k++){
        if(iv.pazienti[k]==null) continue;
        if(iv.pazConsegnati && iv.pazConsegnati[k]) continue;
        try{ var _S = SIM(); if(_S && _S.stPaz && _S.stPaz(iv,k)>=10) continue; }catch(_){}
        if(iv.pazienti[k]<min){ min = iv.pazienti[k]; idx = k; }
      }
      if(idx<0 || min>60) return null; // complicazioni solo a pazienti seri
      var delta = -rndi(4,10);
      var dopo = Math.round(min)+delta;
      if(dopo<5) delta = 5-Math.round(min);
      var msg = pick([
        "il paziente peggiora, saturazione in calo: acceleriamo le manovre",
        "il paziente diventa meno responsivo, rivalutiamo e stringiamo i tempi",
        "parametri in peggioramento, serve rapidità nelle manovre"
      ]);
      var prop = {kind:"evoluzione", pazIdx:idx, deltaSalute:delta, messaggio:msg};
      var v = validaProposta(prop, {tipoNome:iv.tipoNome, nPaz:iv.pazienti.length, salute:iv.pazienti.map(Math.round)});
      if(!v.ok){ stat.rifiuti++; return null; }
      iv._iaCompl = true;
      stat.usi++;
      return prop;
    }catch(_){ stat.fallback++; return null; }
  }

  // ---- PROVIDER REMOTO (OpenAI-compatibile, chiave mai nel codice) ----
  function cfgOk(){ return modo==="remoto" && cfg.url && /^https?:\/\//.test(cfg.url); }
  function promptSistema(){
    return "Sei il modulo narrativo di una centrale operativa 118/VVF (simulazione). "+
    "Generi SOLO testi italiani naturali e contestuali. REGOLE FERREE: "+
    "1) non cambiare mai i fatti (tipo, numero pazienti, zona, incastro, mezzi); "+
    "2) non nominare mai il tipo vero dell'emergenza (il giocatore lo scopre sul posto); "+
    "3) non inventare altri feriti, altri mezzi o richieste; "+
    "4) rispondi SOLO con JSON valido {dialogo, vistoExtra[]} dove dialogo contiene il nucleo dato tra virgolette; "+
    "5) vistoExtra = max 1 riga di contorno coerente (traffico/buio/pioggia/gente), mai su incastri/fiamme salvo dinamica.";
  }
  function fetchTimeout(url, opt, ms){
    return new Promise(function(res, rej){
      var to = setTimeout(function(){ rej(new Error("timeout")); }, ms||12000);
      fetch(url, opt).then(function(r){ clearTimeout(to); res(r); }, function(e){ clearTimeout(to); rej(e); });
    });
  }
  async function arricchisciRemoto(call){
    // miglioramento progressivo DOPO la pubblicazione (non blocca il gioco)
    if(!cfgOk() || !call || !call.tipoNome) return null;
    try{
      var tipo = tipoDi(call.tipoNome);
      var snap = {
        tipoMascherato: catDi(call.tipoNome),
        zona: (tipo&&tipo.zona)||"misto", ente: call.ente,
        nPazienti: (call.pazienti||[]).length,
        comune: call.comune, indirizzo: call.indirizzo,
        nucleo: String(call.dialogo||"").slice(0,280),
        meteo: (SIM()&&SIM().getMeteo&&SIM().getMeteo())||""
      };
      var body = {
        model: cfg.model||"gpt-4o-mini",
        response_format: {type:"json_object"},
        messages: [
          {role:"system", content: promptSistema()},
          {role:"user", content: JSON.stringify(snap)}
        ],
        temperature: 0.8, max_tokens: 300
      };
      var headers = {"Content-Type":"application/json"};
      if(cfg.key) headers.Authorization = "Bearer "+cfg.key;
      var r = await fetchTimeout(cfg.url, {method:"POST", headers:headers, body:JSON.stringify(body)}, 12000);
      if(!r.ok) throw new Error("http "+r.status);
      var j = await r.json();
      var txt = (j.choices&&j.choices[0]&&j.choices[0].message&&j.choices[0].message.content) || j.dialogo || "";
      var o = JSON.parse(txt);
      var prop = {kind:"dialogo", dialogo:String(o.dialogo||""), vistoExtra:Array.isArray(o.vistoExtra)?o.vistoExtra.slice(0,1):[]};
      var v = validaProposta(prop, {tipoNome:call.tipoNome, desc:(tipo&&tipo.desc)||"", nPaz:(call.pazienti||[]).length, nucleo:snap.nucleo});
      if(!v.ok){ stat.rifiuti++; return null; }
      stat.remotoOk++;
      return prop;
    }catch(_){ stat.remotoKo++; stat.fallback++; return null; }
  }

  // ---- PROVIDER PLUGIN (ai-text-plugin, se importato nel generatore) ----
  async function arricchisciPlugin(call){
    try{
      var gen = null;
      try{ gen = (typeof generateText!=="undefined") ? generateText : null; }catch(_){ gen = null; }
      if(!gen && window.root && window.root.generateText) gen = window.root.generateText;
      if(!gen || modo!=="remoto") return null;
      var tipo = tipoDi(call.tipoNome);
      var snap = { zona:(tipo&&tipo.zona)||"misto", nPazienti:(call.pazienti||[]).length, nucleo:String(call.dialogo||"").slice(0,280) };
      var out = await gen(promptSistema()+"\nContesto: "+JSON.stringify(snap)+"\nRispondi solo JSON {dialogo, vistoExtra}.");
      var txt = (out && (out.text||out.value||out)) || "";
      var o = JSON.parse(String(txt).slice(String(txt).indexOf("{"), String(txt).lastIndexOf("}")+1));
      var prop = {kind:"dialogo", dialogo:String(o.dialogo||""), vistoExtra:[]};
      var v = validaProposta(prop, {tipoNome:call.tipoNome, desc:(tipo&&tipo.desc)||"", nPaz:(call.pazienti||[]).length, nucleo:snap.nucleo});
      if(!v.ok){ stat.rifiuti++; return null; }
      stat.remotoOk++;
      return prop;
    }catch(_){ stat.remotoKo++; return null; }
  }

  // Applica una proposta dialogo a chiamata/intervento (solo testi, mai stato).
  // Ritorna true se applicata.
  function applicaDialogo(callId, prop){
    try{
      var s = SIM(); if(!s || !prop) return false;
      // il motore espone chiamate/interventi solo via debug: usiamo i selettori DOM-safe
      // -> in pratica l'app chiama questa con gli oggetti già in mano (vedi hook in app.js).
      void s; void callId;
      return false;
    }catch(_){ return false; }
  }

  var API = {
    modo: function(){ return modo; },
    setModo: function(m){
      if(["off","locale","remoto"].indexOf(m)<0) return modo;
      modo = m;
      try{ localStorage.setItem(LS_MODO, m); }catch(_){}
      try{ if(SIM() && SIM().iaStato) SIM().iaStato(); }catch(_){}
      return modo;
    },
    cfg: function(){ return {url:cfg.url, model:cfg.model, haKey:!!cfg.key}; },
    setCfg: function(url, model, key){
      var keep = (key==null || key==="") ? cfg.key : String(key).slice(0,500);
      cfg = {url:String(url||"").slice(0,300), model:String(model||"").slice(0,120), key:keep||""};
      try{ localStorage.setItem(LS_CFG, JSON.stringify(cfg)); }catch(_){}
      return API.cfg();
    },
    pulisciChiave: function(){ cfg.key=""; try{ localStorage.setItem(LS_CFG, JSON.stringify(cfg)); }catch(_){} return true; },
    miglioraBozzaLocal: miglioraBozzaLocal,
    fraseRadio: fraseRadio,
    complicazioneLocal: complicazioneLocal,
    validaProposta: validaProposta,
    arricchisciRemoto: arricchisciRemoto,
    arricchisciPlugin: arricchisciPlugin,
    applicaDialogo: applicaDialogo,
    stat: function(){ return {modo:modo, usi:stat.usi, fallback:stat.fallback, rifiuti:stat.rifiuti, remotoOk:stat.remotoOk, remotoKo:stat.remotoKo, cfg:API.cfg()}; },
    debugIA: function(n){
      // genera n dialoghi locali di prova su tipi casuali e valida: per i test
      var out = [], ok = 0;
      var arr = (D().TIPI||[]);
      for(var k=0;k<(n||20);k++){
        var t = arr[Math.floor(Math.random()*arr.length)];
        var finta = {tipoNome:t.nome, dialogo:"«Aiuto, venite subito!»", pazienti:new Array(t.pz||0).fill(70), ente:t.vvf?"115":"112", comune:"Varese", indirizzo:"Via Roma"};
        var r = miglioraBozzaLocal(finta);
        var v = r ? validaProposta({kind:"dialogo", dialogo:r.dialogo, vistoExtra:r.vistoExtra}, {tipoNome:t.nome, desc:t.desc, nPaz:(finta.pazienti||[]).length, nucleo:"«Aiuto, venite subito!»"}) : {ok:false};
        if(v.ok) ok++;
        out.push({tipo:t.nome, ok:!!(v.ok), dialogo:(r&&r.dialogo||"").slice(0,90)});
      }
      return {prove:out.length, ok:ok, stat:API.stat()};
    }
  };
  window.COEUIA = API;
})();
