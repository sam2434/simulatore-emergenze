// COEU SIM - engine VA/CO/LC - mappa Google come LSTSim
window.COEUSIM = (() => {
  const D = () => window.GAME_DATA;
  let map, layerInterventi, layerMezzi, layerSedi, layerVVF, layerChiamate, layerRoutes, layerStrade, layerStradeMP, layerStradeT, layerStradeR;
  let vvfOn = true;
  let interventi = [];
 let mezzi = [];
 let chiamate = []; // chiamate in arrivo da accettare (una a una)
  let pma = null; // {lat,lng} — ospedale da campo piazzato dall'operatore (uno solo)
  let pmaArmed = false; // tasto PMA premuto: il prossimo click mappa piazza
  let pmaMarker = null;
  let highlightCall = null;
  let idCounter = 1;
  let callCounter = 1;
  let selectedId = null;
  let clockMin = 8*60; // 08:00
  let speed = 4; // game-sec per real-sec (1 = tempo reale, 5 = 5x, 30 = 30x)
  // --- BOOST MOTO gameplay: a 1x il traffico reale (75 km/h) richiederebbe minuti veri
  // per pochi km; i mezzi in gioco sono quindi più rapidi del reale, e la spinta cresce
  // col passo di simulazione (1x < 5x < 10x < 30x). Vale SOLO per lo spostamento
  // (advanceAlongPath + stima etaMinuti): orologio, cure, sopralluogo e scene restano
  // in game-min invariati, quindi la missione resta coerente (si arriva prima, il resto uguale).
  function boostMoto(){
    if(speed<=1) return 6;
    if(speed<=5) return 6+(speed-1)*1; // 5x -> 10
    if(speed<=30) return 10+(speed-5)*0.32; // 10x -> ~11.6, 30x -> 18
    return 18;
  }
  // --- USCITA DALLA SEDE (game-min): l'equipaggio non parte subito — 30" sul rosso,
  // 42" sul giallo, 51" sul verde, 60" sul bianco/VVF senza codice. A 1x sono secondi
  // veri, alle alte velocità scala col tempo di gioco. Vale solo uscendo dalla sede
  // (i dirottati ripartono da dove sono, senza attesa).
  function turnoutPrio(prio){
    if(prio<=1) return 0.5;
    if(prio===2) return 0.7;
    if(prio===3) return 0.85;
    return 1.0;
  }
  // --- MEDICALIZZATE PIÙ SCATTANTI: MSA/automediche dirette sull'intervento (+25%)
  function medMult(mz){
    return (mz && mz.stato==="viaggio" && (mz.tipo==="MSA"||mz.tipo==="AUTOMEDICA")) ? 1.25 : 1;
  }
  // velocità effettiva del mezzo in km/h (base × bonus medicalizzata; il boostMoto
  // scala col tempo di gioco e non cambia i km/h): per scheda/test
  function velEff(mz){
    if(!mz) return null;
    const base = isEli(mz) ? 180 : (meteo.cond==="Nebbia" ? 50 : (mz.velKmh||50));
    return Math.round(base*medMult(mz)*10)/10;
  }
  let paused = false;
  let autoInflow = false; // spento: le chiamate arrivano su richiesta (una a una)
  // --- AFFLUSSO DINAMICO: centrale viva, mai un timer fisso ---
  // Ogni chiamata programma da sé la successiva (regimi base/picco/calma + ritmo scelto
  // dall'operatore + ora di gioco + carico reale). accetta/rifiuta/chiudi NON toccano
  // mai `flusso`: niente azzeramenti errati, niente debiti accumulati.
  const RITMI = {
    tranquillo:{ base:0.45, picco:0.05, calma:0.30, cap:5 },   // turno calmo: poche chiamate, morbido
    normale:{ base:1.8, picco:0.12, calma:0.10, cap:12 },      // turno standard (1x: ~1 chiamata al minuto di giorno)
    intenso:{ base:2.1, picco:0.20, calma:0.10, cap:12 },      // serata che picchia
    maxi:{ base:3.2, picco:0.30, calma:0.04, cap:16 },         // maxi emergenza: pioggia di chiamate
  };
  let flusso = { ritmo:"normale", attesa:3, fuochi:[] }; // attesa in game-min alla prossima chiamata; fuochi = ore di gioco (clockMin) degli ultimi arrivi
  function oraFattore(){
    const h = Math.floor(clockMin/60)%24;
    if(h<5) return 0.45;   // notte fonda: si dorme
    if(h<7) return 0.8;    // alba
    if(h<9) return 1.3;    // punta del mattino
    if(h<12) return 1.1;   // mattina
    if(h<15) return 1.0;   // primo pomeriggio
    if(h<19) return 1.25;  // pomeriggio + punta serale
    if(h<22) return 0.9;   // sera
    return 0.6;            // tarda sera
  }
  function caricoCentrale(){
    const aperti = interventi.filter(i=>i.stato!=="chiuso").length;
    return { aperti, coda: chiamate.length, tot: aperti + chiamate.length };
  }
  function sparaChiamata(){
    makeChiamata();
    flusso.fuochi.push(Math.round(clockMin*100)/100); // orario esatto di ogni arrivo (per diagnostica/test)
    if(flusso.fuochi.length>60) flusso.fuochi.shift();
  }
  function programmaFlusso(){
    const R = RITMI[flusso.ritmo] || RITMI.normale;
    if(Math.random() < R.calma){
      flusso.attesa = rnd(6,14); // calma piatta: anche 10+ minuti senza una chiamata
      return;
    }
    let f = R.base * oraFattore();
    const carico = caricoCentrale().tot;
    if(carico===0) f *= 1.4;                 // centrale vuota: un po' più di movimento
    else if(carico >= R.cap*0.75) f *= 0.6;  // centrale sotto carico: rallenta da sola
    flusso.attesa = Math.max(0.15, rnd(0.8,2.4)/f);
  }
  function scattaFlusso(){
    const R = RITMI[flusso.ritmo] || RITMI.normale;
    const libero = ()=>caricoCentrale().tot < R.cap && chiamate.length<3;
    // mai sovraccarico artificiale: a centrale satura si salta il giro senza accumulare debito
    if(!libero()){ programmaFlusso(); return; }
    sparaChiamata();
    // RAFFICA: con probabilità picco arrivano subito altre 1-3 chiamate nello STESSO
    // istante di gioco — il vero picco (a ogni velocità), mai code ingestibili (stop ai cap)
    if(Math.random() < R.picco){
      const extra = rndi(1,3);
      for(let k=0;k<extra && libero();k++) sparaChiamata();
    }
    programmaFlusso(); // la prossima è già programmata, da sola
  }
  let score = 0;
  let chiusi = 0;
  let contaColori = {1:0,2:0,3:0,4:0}; // codici classificati finora
  // MI = Milano e tutta la provincia (133 comuni)
  let filters = { VA:true, CO:true, LC:true, MB:true, MI:true, P1:true, P2:true, P3:true, P4:true, soloAttesa:false, search:"" };
  let markersInt = new Map();
  let markersMz = new Map();
  let sedeMarkers = []; // {marker, sede} 118 — tooltip con mezzi in sede
  let vvfMarkers = []; // {marker, sede} VVF — tooltip con mezzi in sede
  let ospMarkers = []; // {marker, osp} — H con scheda reparti (mostraOspedale)
  let ultimiTipi = []; // nomi degli ultimi tipi generati (anti-ripetizione)
  const STORICO_TIPI = 12; // quanti tipi recenti ricordare
  const BAN_TIPI = 10; // gli ultimi N tipi non escono proprio: mai due uguali, mai di fila
  // memoria chiamate recenti (anti-ripetizione tra turni): ogni nuova chiamata è un
  // evento indipendente — se tipo+dialogo ricalcano una chiamata recente si rigenera
  // tutto prima di mostrarla (le bozze scartate non sono pubblicate: mai duplicati)
  let ultimeChiamate = []; // {tipo, dialogo} delle ultime chiamate pubblicate
  const STORICO_CHIAMATE = 8;
  function chiamataRipetuta(b, forbidTipo){
    for(const p of ultimeChiamate){
      if(forbidTipo && p.tipo === b.tipoNome) return true; // stesso tipo di una recente
      if(p.tipo === b.tipoNome && p.dialogo === b.dialogo) return true; // stessa combinazione evento+dialogo
    }
    return false;
  }
  function dialogoRipetuto(d){ for(const p of ultimeChiamate){ if(p.dialogo === d) return true; } return false; }
  function notaChiamata(b){
    if(!b) return;
    ultimeChiamate.push({tipo: b.tipoNome, dialogo: b.dialogo});
    if(ultimeChiamate.length>STORICO_CHIAMATE) ultimeChiamate.shift();
  }
  function tipoBandito(nome){ return ultimiTipi.slice(-BAN_TIPI).indexOf(nome)>=0; }
  function notaTipo(nome){ // registra il tipo uscito, senza doppioni consecutivi
    if(!nome || ultimiTipi[ultimiTipi.length-1]===nome) return;
    ultimiTipi.push(nome);
    if(ultimiTipi.length>STORICO_TIPI) ultimiTipi.shift();
  }

  const $ = (id) => document.getElementById(id);
  const rnd = (a,b) => a + Math.random()*(b-a);
  const rndi = (a,b) => Math.floor(rnd(a,b+1));
  const pickWeighted = (arr, wkey) => {
    let tot = 0;
    for (const o of arr) tot += (o[wkey] ?? o.peso ?? 1);
    let r = Math.random()*tot;
    for (const o of arr) { r -= (o[wkey] ?? o.peso ?? 1); if (r<=0) return o; }
    return arr[arr.length-1];
  };

  function haversineKm(a,b,c,d){
    const R=6371, toR=x=>x*Math.PI/180;
    const dLat=toR(c-a), dLon=toR(d-b);
    const s=Math.sin(dLat/2)**2 + Math.cos(toR(a))*Math.cos(toR(c))*Math.sin(dLon/2)**2;
    return 2*R*Math.asin(Math.sqrt(s));
  }

  // punto in acqua? (laghi Como/Maggiore/Lugano) — niente interventi nel lago
  function inAcqua(lat, lng){
    const laghi = D().LAGHI || [];
    for(const ring of laghi){
      let dentro = false;
      for(let i=0, j=ring.length-1; i<ring.length; j=i++){
        const xi=ring[i][1], yi=ring[i][0], xj=ring[j][1], yj=ring[j][0];
        if(((yi>lat)!==(yj>lat)) && (lng < (xj-xi)*(lat-yi)/(yj-yi)+xi)) dentro = !dentro;
      }
      if(dentro) return true;
    }
    return false;
  }

    // peso spawn: Milano e la metà sud della mappa generano più chiamate
  const SUD_LAT = 45.62, SUD_MULT = 2, MI_MULT = 2, MILANO_MULT = 6;
  function pesoComune(c){
    return (c.peso||1) * (c.p==="MI" ? MI_MULT : 1) * (c.lat<SUD_LAT ? SUD_MULT : 1) * (c.n==="Milano" ? MILANO_MULT : 1);
  }
  function pickPesato(list){
    let tot = 0;
    for(const c of list) tot += pesoComune(c);
    let r = Math.random()*tot;
    for(const c of list){ r -= pesoComune(c); if(r<=0) return c; }
    return list[list.length-1];
  }
  function comuneRandom(provFilter=null){
    const list = D().COMUNI.filter(c => !provFilter || c.p===provFilter);
    return pickPesato(list);
  }

  function nMezziRichiesti(t){
    let n = 0; const m = t.mezzi || {};
    for(const k in m) n += Math.max(0, m[k] || 0);
    return n;
  }

  // priorità secondo distribuzione del tipo (usata anche per i danni da maltempo forzati)
  function prioDaTipo(t){
    const [w1,w2,w3,w4] = t.prio;
    const rp = Math.random()*100;
    if (rp < w1) return 1;
    if (rp < w1+w2) return 2;
    if (rp < w1+w2+w3) return 3;
    return 4;
  }
  // tipi già aperti (in coda o in corso, non chiusi): non se ne genera uno uguale
  function tipiAperti(){
    const s = new Set();
    for(const c of chiamate) s.add(c.tipoNome);
    for(const iv of interventi) if(iv.stato!=="chiuso") s.add(iv.tipoNome);
    return s;
  }
  // ---------- GENERAZIONE MISSIONI DALL'ARCHIVIO (categorie pesate) ----------
  // Livello 1: categoria per pesi calibrati (le frequenze restano quelle impostate).
  // Livello 2: scenario per plausibilita di contesto dentro la categoria
  // (uniforme a contesto neutro). I dati dei tipi non si toccano mai.
  // Pesi calibrati sulla distribuzione misurata col sistema precedente
  // (6000 draw, contesto neutro: MED 35.7 STRADA 34 CASA 10.8 LAVORO 3.2 SPORT 3
  // ACQUA 1.5 EVENTI 4.9 VVF 7.1): ordinari (MED+STRADA+CASA) ~77%; VVF invariati;
  // scontri a 3+ mezzi (232 tipi, frenati ×0.3 in selezione): categoria propria ~0.5%;
  // trasporti programmati rari ~2% (scorporati da MED).
  const SECONDARI_NOMI = ["Trasporto dialisi","Trasporto radioterapia","Trasporto chemioterapia","Visita specialistica programmata","Controllo post-ricovero","Medicazione programmata"];
  const TRIPLO_RE = /scontro tra [^,]+,[^,]+ e /i;
  // incidenti espliciti a 3+ veicoli (tre mezzi dichiarati dal chiamante):
  // mai da "1 paziente" — tutti i coinvolti noti da subito, niente verifiche
  const TRE_VEICOLI_RE = /scontro tra [^,]+,[^,]+ e |tre (auto|macchine|mezzi|veicoli)|quattro auto|tamponamento triplo|carambola/i;
  function categoriaMissione(t){
    if(!t) return "?";
    if(SECONDARI_NOMI.indexOf(t.nome)>=0) return "SECONDARI";
    if(t.vvf){
      const b = pzvBucket(t.nome, t.desc);
      if(b==="crolloM"||b==="crolloX") return "V_CRO";
      if(b==="tecnico") return "V_TEC";
      if(b==="casaF"||b==="pubG"||b==="pubP"||b==="rurale"||b==="veget"||b==="veicF") return "V_INC";
      return "V_SOC";
    }
    if(TRIPLO_RE.test(t.nome||"")) return "TRI";
    const c = pazCat(t.nome);
    if(c==="medico"||c==="cardio"||c==="neuro"||c==="resp"||c==="ped"||c==="parto"||c==="tossAlim") return "MED";
    if(c==="strada"||c==="moto"||c==="bici"||c==="bus"||c==="pesante"||c==="treno") return "STRADA";
    if(c==="casa"||c==="caduta"||c==="trauma") return "CASA";
    if(c==="lavoro") return "LAVORO";
    if(c==="sport") return "SPORT";
    if(c==="acqua") return "ACQUA";
    return "EVENTI";
  }
  const CATEGORIE_PESO = {MED:34, STRADA:31.5, CASA:11, TRI:0.5, LAVORO:3, SPORT:3, ACQUA:1.5, EVENTI:5, SECONDARI:2, V_INC:2.3, V_CRO:0.5, V_SOC:1.2, V_TEC:3};
  let CATS_CACHE = null;
  function categorieMissioni(){
    if(CATS_CACHE) return CATS_CACHE;
    CATS_CACHE = Object.keys(CATEGORIE_PESO).map(k=>({k, peso:CATEGORIE_PESO[k], membri:[]}));
    for(const t of D().TIPI){
      const c = CATS_CACHE.find(x=>x.k===categoriaMissione(t));
      if(c) c.membri.push(t);
    }
    return CATS_CACHE;
  }
  // plausibilita di contesto (NON frequenza): meteo, ora, stagione, nebbia, fascia-ambulanze
  // PZ1_BOOST: le missioni da 1 paziente escono piu spesso (solo sanitarie con
  // tipo.pz esatto == 1; VVF escluse: i loro feriti sono dinamici per tipologia)
  const PZ1_BOOST = 3;
  // incidenti a 3+ veicoli: escono con meno probabilita (moltiplicatore secco in selezione)
  const TRE_VEICOLI_MULT = 0.3;
  // incidenti in autostrada/tangenziale/superstrada (+Scontro tra camion): escono con piu
  // probabilita (moltiplicatore secco in selezione; la nascita resta sul tratto vero)
  const HWY_RE = /autostrada|tangenziale|superstrada|spartitraffico/i;
  const HWY_MULT = 20;
  // missioni all'aeroporto di Malpensa: escono con molta piu probabilita
  // (moltiplicatore secco in selezione; la nascita resta sul punto fisso vero)
  const MALPENSA_RE = /malpensa/i;
  const MALPENSA_MULT = 5;
  function plausTipo(x){
    return ((x.meteo&&x.meteo[meteo.cond])||1)*oreMult(x.nome)*sensoMult(x.nome)*(meteo.cond==="Nebbia"&&x.zona==="strada"?1.6:1)*fasciaAmbMult(x)*(x.vvf||x.pz!==1?1:PZ1_BOOST)*(TRE_VEICOLI_RE.test(x.nome||"")?TRE_VEICOLI_MULT:1)*(HWY_RE.test(x.nome||"")||x.nome==="Scontro tra camion"?HWY_MULT:1)*(MALPENSA_RE.test(x.nome||"")?MALPENSA_MULT:1);
  }
   function tipoRandom(){
    // archivio in due livelli: categoria per pesi calibrati, scenario per plausibilita.
    // Anti-ripetizione invariata: mai tipo gia aperto, mai ultimi 10 usciti.
    const open = tipiAperti();
    const arr = D().TIPI, cats = categorieMissioni();
    let t = null;
    for(let k=0;k<25;k++){
      let tot = 0;
      const cw = new Array(cats.length);
      for(let ci=0;ci<cats.length;ci++){
        let n = 0;
        const mm = cats[ci].membri;
        for(let m=0;m<mm.length;m++){ const x = mm[m]; if(!open.has(x.nome)&&!tipoBandito(x.nome)) n++; }
        const w = mm.length ? cats[ci].peso*(n/mm.length) : 0; // massa = peso x frazione ammissibile: le frequenze restano quelle impostate
        cw[ci] = w; tot += w;
      }
      let r = Math.random()*tot, ci = cats.length-1;
      for(let c2=0;c2<cats.length;c2++){ r -= cw[c2]; if(r<=0){ ci = c2; break; } }
      const pool = cats[ci].membri.filter(x=>!open.has(x.nome)&&!tipoBandito(x.nome));
      let cand;
      if(!pool.length){ cand = arr[rndi(0,arr.length-1)]; }
      else {
        let pt = 0;
        const ws = new Array(pool.length);
        for(let p2=0;p2<pool.length;p2++){ const w = plausTipo(pool[p2]); ws[p2] = w; pt += w; }
        let r2 = Math.random()*pt; cand = pool[pool.length-1];
        for(let p3=0;p3<pool.length;p3++){ r2 -= ws[p3]; if(r2<=0){ cand = pool[p3]; break; } }
      }
      if(!t) t = cand; // riserva se tutti i tipi fossero aperti
      if(!open.has(cand.nome) && !tipoBandito(cand.nome)){ t = cand; break; }
    }
    if(!t) t = arr[rndi(0,arr.length-1)]; // ultima rete di sicurezza (praticamente mai)
    // priorità secondo distribuzione del tipo
    const p = prioDaTipo(t);
    return { tipo:t, prio:p };
  }

  // profili di luogo: ogni tipo nasce nel suo ambiente realistico (casa in paese, strada, natura, riva)
  const ZONA_JITTER = { casa:[0.003,0.004], strada:[0.007,0.009], misto:[0.011,0.014], natura:[0.012,0.016], ferro:[0.004,0.005], infra:[0.004,0.005] };
  function nearestComune(lat, lng){
    let best = D().COMUNI[0], bd = 1e9;
    for(const cc of D().COMUNI){ const d = haversineKm(lat, lng, cc.lat, cc.lng); if(d<bd){ bd=d; best=cc; } }
    return best;
  }
  // via con coordinate più vicina al punto (stesso comune): indirizzi onesti in bosco/riva
  function viaPiuVicina(nomeComune, lat, lng){
    const VC = D().VIE_COORD || {}, pref = nomeComune + "|";
    let bestV = null, bdV = 1e9;
    for(const k in VC){
      if(k.indexOf(pref) !== 0) continue;
      const v = VC[k];
      if(typeof v[0] === "number"){
        const dd = haversineKm(lat, lng, v[0], v[1]);
        if(dd < bdV){ bdV = dd; bestV = k.slice(pref.length); }
      } else {
        for(const q of v){
          const dd = haversineKm(lat, lng, q[0], q[1]);
          if(dd < bdV){ bdV = dd; bestV = k.slice(pref.length); }
        }
      }
    }
    return bestV ? { via: bestV, d: bdV } : null;
  }
  // --- CHIAMANTE (realismo chiamate) ---
  // cosa vede il richiedente sulla scena: osservazioni coerenti col tipo (mezzi, feriti,
  // pericoli), generate alla creazione e stabili; mai il tipo vero, solo ciò che si vede
  function osservazioniScena(tipo, pz, zona, opt){
    const out = [];
    const nome = (tipo.nome||"").toLowerCase();
    const pick = (a)=>a[rndi(0,a.length-1)];
    const maybe = (p)=>Math.random()<p;
    // persone visibili (solo dai pazienti NOTI, senza percentuali): la centrale non
    // conosce il numero esatto — se il chiamante non sa dire, resta sconosciuto
    const n = (pz||[]).length;
    const ign = !!(opt&&opt.ignoti), ver = !!(opt&&opt.verifica)||((opt&&opt.nascosti)||0)>0;
    if(n>0 && (tipo.trasporto || tipo.vvf || /ferit|coinvolt|investit|persona|persone|occupant|passegger|conducent|bambin|bimbo|sciator|motociclista|ciclista|pedone/i.test(nome))){
      if(n>4) out.push("tanta gente coinvolta, almeno " + n + " persone a terra");
      else out.push(n===1 ? "si vede 1 persona coinvolta" : "si vedono " + n + " persone coinvolte");
      const crit = pz.filter(s=>s<30).length, mid = pz.filter(s=>s>=30 && s<60).length;
      if(crit>0) out.push(crit===1 ? "una non si muove e non risponde" : crit + " non si muovono e non rispondono");
      else if(mid>0) out.push("sono coscienti ma stanno male");
      else out.push(n===1 ? "cammina e parla, ma è spaventata" : "camminano e parlano, ma sono spaventate");
      if(n>=2 && maybe(0.5)) out.push(pick(["una piange e chiede aiuto","una è seduta a lato strada","una è rimasta dentro il mezzo"]));
      if(ver||ign) out.push(pick(["è agitato e fa fatica a spiegarsi","non sa dire altro, è sotto shock","piange e non riesce a spiegarsi meglio"]));
    } else if(n===0 && ign){
      out.push(pick(["non riesce a vedere bene la scena","c'è troppo fumo per vedere","non riesce ad avvicinarsi abbastanza"]));
    } else if(n>0 && ver){
      // dinamica senza riga persone (es. sciame, cadute leggere): resta comunque un'osservazione neutra
      out.push(pick(["non sa dire altro, è tutto confuso","è agitato e non riesce a spiegarsi meglio"]));
    }
    // veicoli incidentati
    if(/ribaltat|cappottat/.test(nome)){ out.push("l'auto è ribaltata su un fianco"); if(maybe(0.4)) out.push("dal cofano esce del fumo"); }
    if(/scontro|tamponamento|incidente|investimento|auto contro|fuori strada|frontale|testa-coda|pirata/.test(nome)){
      out.push(pick(["un'auto ha il muso completamente distrutto","ci sono vetri e pezzi di carrozzeria ovunque","le due auto sono incastrate in mezzo alla strada"]));
      if(maybe(0.4)) out.push(pick(["dal cofano di un'auto esce del fumo","si sente odore di benzina","da un'auto cola del liquido scuro"]));
      if(maybe(0.3)) out.push("una persona è incastrata dentro l'auto");
    }
    if(/moto|motorino|scooter|monopattino|bici|ciclista/.test(nome) && /scontro|investimento|incidente|caduta/.test(nome))
      out.push(pick(["la moto è a terra in mezzo alla strada","la bici è distrutta sul marciapiede"]));
    if(/camion|tir|autoarticolato|autocarro|betoniera|autobus|pullman|scuolabus/.test(nome))
      out.push(pick(["il mezzo pesante è di traverso e blocca tutto","il camion ha perso parte del carico sull'asfalto"]));
    // ferrovia: treni veri sui binari veri (solo dinamiche da nome, mai luoghi inventati)
    if(/deragli|treno|treni|carrozza(?! contro auto)|vagone|in galleria|sui binari|ferroviaria|ferroviario|passaggio a livello|linea aerea|carro merci|macchinista|in stazione/i.test(nome) && nome!=="Carrozza contro auto" && !/stradale/i.test(nome)){
      if(/treno|vagone|deragli|collisione|a bordo|macchinista/i.test(nome)) out.push(pick(["il treno è fermo con le porte bloccate","i vagoni sono rovesciati sui binari","la gente sta scendendo sui binari"]));
      else if(/carrozza|in stazione/i.test(nome)) out.push(pick(["è successo in stazione, c'è gente attorno","il treno è fermo in stazione e non riparte"]));
      else out.push(pick(["i binari sono interrotti in quel tratto","la linea è ferma, non passano treni"]));
      if(/deragli|collisione|scontro/i.test(nome)) out.push(pick(["le carrozze sono deformate","c'è gente incastrata dentro le carrozze"]));
      if(/incendio|fumo| a fuoco/i.test(nome)) out.push("c'è fumo denso e la gente evacua");
      if(/merci pericolose/i.test(nome)) out.push("dal carro esce un liquido che puzza forte");
      if(/cavi|linea aerea|scossa/i.test(nome)) out.push("i cavi penzolano sui binari, nessuno si avvicina");
    }
    // infrastrutture reali OSM (solo dinamiche da nome, mai luoghi inventati)
    if(/elettrodotto|traliccio|antenna|cabina elettrica|trasformatore|metanodotto|tubo del gas|serbatoio idrico|acquedotto|argine|diga|guado|galleria stradale|rifugio|baita|alpeggio|sentiero|dirupo|funivia|cabinovia|pontile|porto|magazzino|piazzale|deposito|aviosuperficie|muletto|elisuperficie/i.test(nome)){
      if(/elettrodotto|traliccio|antenna|cabina elettrica|trasformatore|scossa elettrica|folgor/i.test(nome)) out.push(pick(["i cavi penzolano e nessuno si avvicina","si sentono crepitii dal traliccio, meglio stare lontani"]));
      else if(/metanodotto|tubo del gas|distributore|fuga di gas|deposito gas/i.test(nome)) out.push("si sente un forte odore di gas");
      else if(/fiume|argine|diga|guado|porto|pontile|peschereccio|anneg/i.test(nome)) out.push(pick(["l'acqua è alta e la corrente tira","il livello continua a salire"]));
      else if(/galleria stradale/i.test(nome)) out.push(pick(["è successo in galleria, c'è poca visibilità","le auto sono ferme in galleria"]));
      else if(/rifugio|baita|alpeggio|sentiero|dirupo|vipera|funivia|cabinovia/i.test(nome)) out.push(pick(["il posto è impervio, si arriva solo a piedi","c'è gente che fa strada sul sentiero"]));
      else out.push(pick(["i colleghi sono attorno a lui","il piazzale è pieno di mezzi in manovra"]));
    }
    // fuoco e fumo
    if(/incendio|fuoco|fiamme|brucia| a fuoco|fulmine|esplosion|scoppio/.test(nome)){
      out.push(pick(["si vedono fiamme alte e fumo nero","il fumo si vede da lontano","le fiamme stanno raggiungendo il piano di sopra"]));
    }
    // natura e acqua
    if(/albero|ramo|tronco|pianta/.test(nome)) out.push(pick(["un albero è caduto e blocca tutto","un grosso ramo penzola sui cavi"]));
    if(/allagat|esond|acqua|anneg|tuffo|piscina|lago|sup |pedalò|canoa/.test(nome))
      out.push(pick(["c'è acqua alta, non si passa","l'acqua continua a salire"]));
    if(/gas|monossido|esalazioni|vapori|odore/.test(nome)) out.push("si sente un forte odore di gas");
    // cadute e infortuni
    if(/caduta|scivol|precipit|scala|tetto|impalcatura|ponteggio|balcone/.test(nome))
      out.push(pick(["è caduto da un'altezza di alcuni metri","è a terra e non riesce ad alzarsi"]));
    if(/incastrat/.test(nome)) out.push(pick(["è incastrato e non riesce a liberarsi","è bloccato e non si muove da lì"]));
    if(/ponte/.test(nome)) out.push(pick(["è oltre la ringhiera del ponte","è seduto sul bordo del ponte, penzoloni"]));
    if(/aggressione|rissa|accoltell|arma|rapina|ladro/.test(nome))
      out.push(pick(["c'è gente che urla e litiga ancora","qualcuno è scappato via di corsa"]));
    if(/lavoro|operaio|cantiere|fabbrica|muletto|pressa|trattore|motosega|saldat/.test(nome))
      out.push(pick(["i colleghi sono attorno a lui","il macchinario è ancora acceso"]));
    if(/cane|gatto|cavallo|mucca|volpe|cervo|tasso|cigno|cinghiale|capriolo|pecora|asino|vipera|serpente|api|vesp|calabroni/.test(nome))
      out.push(pick(["l'animale è agitato e potrebbe mordere","l'animale è ferito e non si muove"]));
    if(/parto|doglie|gravid|nascit/.test(nome)) out.push(pick(["si sentono urla forti","sta per nascere, non c'è tempo"]));
    // contorno: traffico, buio, meteo, gente
    if(zona==="strada" && maybe(0.6)) out.push(pick(["il traffico è completamente bloccato","le auto passano a fatica","si sta formando una lunga coda"]));
    if(maybe(0.3)) out.push(pick(["c'è gente attorno che prova ad aiutare","nessuno sa cosa fare, sono tutti agitati","un passante sta facendo da palo"]));
    const h = Math.floor(clockMin/60)%24;
    if((h<6 || h>=22) && maybe(0.6)) out.push("è buio, si vede poco");
    if((meteo.cond==="Pioggia"||meteo.cond==="Temporale"||meteo.cond==="Pioggia intensa") && maybe(0.5))
      out.push("piove forte e si vede poco");
    // 2-4 osservazioni al massimo: si taglia dalla fine (il contorno generico),
    // le righe importanti (persone, mezzo, pericolo) restano sempre
    while(out.length>4) out.pop();
    if(!out.length) out.push(pick(["la situazione sembra stabile per ora","non si riesce a capire bene da qui"]), pick(["bisogna venire a vedere di persona","il richiedente è agitato e non sa spiegarsi bene"]));
    return out;
  }
 // varietà dialoghi: aperture + scena (per zona, coerente col punto) + chiusure,
  // varietà dialoghi: gancio (tono) + fatto + luogo (per zona) + disponibilità.
  // I ganci non affermano MAI gravità, coscienza, numero o esito (vale per ogni
  // missione, anche VVF tecniche): solo urgenza percepita e chi chiama.
  const DIAL_PANICO = [
    "«Aiuto, presto, mandate qualcuno!»",
    "«Pronto?! C'è un'emergenza, fate presto!»",
    "«Oddio... venite subito, vi prego!»",
    "«È grave, mandate un'ambulanza!»",
    "«Pronto, presto! Non c'è tempo!»",
    "«Aiuto! Non so cosa fare, venite!»",
    "«Vi prego, fate presto, vi prego!»",
    "«C'è qualcosa di brutto qui, correte!»",
    "«Mio Dio, mandate qualcuno subito!»",
    "«Pronto? Pronto! Serve aiuto immediatamente!»",
  ];
  const DIAL_PREOCCUPATO = [
    "«Pronto, centrale? Ho bisogno di un'ambulanza.»",
    "«Buongiorno, chiamo perché c'è una persona che sta male.»",
    "«Salve, abbiamo bisogno di aiuto qui.»",
    "«Pronto, sono un passante, c'è stato un incidente.»",
    "«Chiamo perché c'è una persona che non sta bene per niente.»",
    "«Pronto, è successa una cosa brutta qui.»",
    "«Salve, segnalo un ferito, servirebbe un'ambulanza.»",
    "«Pronto? Mi sa che serve un'ambulanza, e in fretta.»",
    "«Chiamo dal posto, c'è bisogno di aiuto.»",
    "«Pronto, qui c'è una persona che si è fatta male.»",
    "«Salve, sono qui adesso, mi sembra che stia male.»",
    "«Pronto, ho visto un incidente qui.»",
  ];
  const DIAL_CALMO = [
    "«Pronto? Vi segnalo una cosa, non so quanto sia grave.»",
    "«Salve, chiamo per una persona che sta male.»",
    "«Buonasera, servirebbe un'ambulanza, non so quanto sia urgente.»",
    "«Pronto, vi chiamo con calma ma è meglio se venite a vedere.»",
    "«Salve, è successa una cosa qui.»",
    "«Pronto? C'è una persona caduta, vi dico dove siamo.»",
    "«Buongiorno, una persona qui non si sente bene.»",
    "«Salve, vi disturbo per una cosa successa qui.»",
    "«Pronto, la situazione sembra calma, ma è meglio se venite.»",
    "«Sì, pronto, vi spiego con calma cosa vedo.»",
  ];
 const DIAL_SCENA = {
    casa: ["«Siamo in casa.»","«È successo in appartamento, al primo piano.»","«Siamo nel cortile del condominio.»","«È in giardino, dietro casa.»","«Sulle scale del palazzo.»","«In bagno.»","«In camera da letto.»","«In cucina.»","«Nel garage sotto casa.»","«In mansarda.»","«Sul balcone.»","«A casa di mia madre, l'indirizzo preciso non me lo ricordo...»"],
    strada: ["«Siamo in strada, in mezzo alla carreggiata.»","«Sul marciapiede.»","«Alla fermata dell'autobus.»","«Nel parcheggio qui.»","«Alla rotonda.»","«All'incrocio col semaforo.»","«In una laterale, il nome non lo so...»","«Sulla principale, ci vedete da lontano.»","«Nel parcheggio sotterraneo.»","«Sul ciglio della strada.»","«Poco dopo l'uscita del paese.»","«Davanti al distributore.»"],
    natura: ["«Sul sentiero, nel bosco.»","«In un prato fuori dal paese.»","«Lungo la mulattiera.»","«Al parco, vicino ai giochi.»","«Dietro le case, nel prato.»","«Nel bosco, non so spiegarvi il punto...»","«Vicino al torrente.»","«Sul percorso vita.»"],
    lago: ["«Sulla riva.»","«Al lido.»","«Sul lungolago.»","«Vicino all'imbarcadero.»","«Al pontile.»","«In spiaggia.»","«Vicino al porticciolo.»"],
    misto: ["«Qui sul posto.»","«Non si può sbagliare, si vede dalla strada.»","«Davanti al supermercato.»","«All'ingresso della stazione.»","«In piazza.»","«Vicino alla chiesa.»","«Al mercato.»","«Il punto esatto non lo so spiegare, ma ci trovate.»"],
  };
  // chiusure urgenti SOLO se il gancio era calmo (mai due suppliche di fila)
  const DIAL_CHIUSURE_CALDE = [
    "«Fate presto, per favore!»",
    "«Ho paura che peggiori!»",
    "«Sbrigatevi, vi prego!»",
    "«Ho le mani che tremano, fate presto.»",
    "«Il telefono sta per scaricarsi, sbrigatevi.»",
    "«Vi aspettiamo qui, correte!»",
  ];
  // disponibilità e risposte oneste: il chiamante resta, richiama, o ammette i buchi
  const DIAL_CHIUSURE_DISP = [
    "«Vi aspetto sul posto, non mi muovo.»",
    "«Vi faccio strada io quando arrivate.»",
    "«Resto qui accanto.»",
    "«Vi richiamo se cambia qualcosa.»",
    "«Altro non so dirvi, vi ho detto tutto quello che vedo.»",
    "«Se avete altre domande sono qui.»",
    "«Grazie, vi aspetto.»",
    "«C'è gente che aiuta, non siamo soli.»",
    "«Non conosco i precedenti, non è un parente.»",
    "«L'età non ve la so dire.»",
    "«Non so cosa sia successo, fate voi quando arrivate.»",
    "«Chiamatemi a questo numero se non ci trovate.»",
  ];
  // depistaggi: chi minimizza o descrive male (il tipo vero resta nascosto, ma classificare diventa una scommessa)
  const DIAL_FUORVIANTI = {
    "Arresto cardiaco": ["«È svenuto all'improvviso... dite che devo fargli qualcosa?»","«È caduto per terra e non risponde... respira piano, credo»"],
    "Dolore toracico": ["«Ha un peso sullo stomaco e suda freddo, sarà la digestione...»","«Gli fa male il braccio da un'ora, magari è cervicale»"],
    "Ictus sospetto": ["«Parla strano da stamattina, sarà la stanchezza... però mi preoccupo»","«Ha la faccia un po' storta, sarà il nervo...»"],
    "Dispnea grave": ["«Respira male da un po', sarà l'asma...»","«Ha il fiatone anche da fermo, non so»"],
    "Crisi convulsiva": ["«Trema tutto e non risponde, avrà freddo...»","«Si è irrigidito e ha la bava, non so cos'è»"],
    "Emorragia digestiva": ["«Vomita scuro, sarà qualcosa che ha mangiato»","«Va in bagno e perde sangue, tanto»"],
    "Overdose": ["«Dorme e non si sveglia, russava strano»","«È strano, suda e non risponde, ieri sera era fuori»"],
    "Tentato suicidio": ["«Ho trovato il flacone vuoto sul comodino, lui è strano...»","«Ha preso delle pastiglie e adesso dorme, non si sveglia»"],
    "Coma etilico": ["«Ha bevuto e adesso dorme per terra, non si muove»"],
    "Soffocamento": ["«Mangiava e all'improvviso non respira più!»","«Ha qualcosa in gola, diventa viola!»"],
    "Annegamento": ["«L'ho tirato fuori dall'acqua ma non respira»","«È stato sotto troppo, non si muove»"],
    "Caduta dall'alto": ["«È caduto dal tetto ma dice di stare bene»","«È caduto dall'impalcatura, si muove ma...»"],
    "Folgorazione": ["«Ha toccato i fili e adesso è strano»","«C'è stata una scarica e lui è per terra»"],
    "Intossicazione": ["«Stiamo male tutti in casa, nausea e mal di testa... sarà l'influenza?»"],
    "Colpo d'arma da fuoco": ["«Si è sentito un botto e lui è per terra, c'è sangue»","«È caduto e sanguina, ho sentito uno sparo»"],
    "Accoltellamento": ["«Hanno litigato e uno sanguina da un fianco»","«C'è una lama per terra e lui perde sangue»"],
    "Aggressione": ["«L'hanno picchiato in tre, è per terra»","«Lo hanno preso a calci, non si alza»"],
    "Parto": ["«Ha un gran mal di pancia... aspetti, credo stia partorendo!»","«Ha le doglie ogni due minuti, perde le acque!»"],
    "Perdite in gravidanza": ["«È incinta e perde sangue, ho paura»"],
    "Crisi diabetica": ["«È diabetico, suda freddo e non capisce più niente»","«Farfuglia e trema... ha il diabete»"],
    "Reazione allergica": ["«L'ha punto una vespa e si sta gonfiando tutto!»","«Ha mangiato qualcosa e si gonfia la faccia, respira male»"],
    "Urgenza psichiatrica": ["«Urla e spacca tutto, ho paura che si faccia male»","«È fuori di sé, non lo riconosco»"],
    "Dito amputato": ["«La sega gli ha preso un dito... c'è sangue dappertutto»"],
    "Frattura da caduta": ["«È caduto e la gamba fa un angolo strano»"],
    "Caduta in casa": ["«È scivolato ma sta bene, solo un livido... però non si alza»","«È caduto, dice che non è niente, ma non appoggia la gamba»"],
    "Sincope": ["«È svenuto un attimo, ora ride e scherza... sarà il caldo»"],
    "Ferita da taglio": ["«Si è tagliato ma poco, un cerotto basta... però sanguina ancora»"],
    "Trauma sportivo": ["«Ha preso una botta giocando ma continua a correre... anzi no, si è fermato»"],
    "Incidente stradale": ["«Ci siamo toccati piano, quasi niente... però ho il collo strano»","«Solo un tamponamento leggero, ma uno non si sente bene»"],
    "Caduta in bici": ["«È caduto dalla bici, si è sbucciato... anzi, il ginocchio è messo male»"],
    "Caduta dalle scale": ["«È ruzzolato per due gradini, niente di che... non riesce a camminare però»"],
    "Ustione": ["«Si è scottato un po'... la pelle fa le bolle»"],
    "Morso di cane": ["«L'ha morsicato il cane del vicino, due buchi... sanguina»"],
    "Crisi ipertensiva": ["«Ha la pressione alta ma dice di stare bene... 220, ho misurato»"],
    "Emorragia post parto": ["«Ha partorito in casa, perde sangue ma dice che è normale... è pallidissima»"],
    "Pila a bottone ingerita": ["«Il bimbo tossisce un po', forse ha ingoiato qualcosa del telecomando»"],
    "Soffocamento al ristorante": ["«Al ristorante uno tossisce forte, non riesce a parlare...»"],
    "Shock da arachidi a scuola": ["«A scuola il bambino si gonfia un po' in faccia dopo mensa, sarà niente...»"],
    "Doppia dose di insulina": ["«Ha preso l'insulina ma è strano, suda... forse ha sbagliato dose»"],
    "Sospetto monossido in casa": ["«Abbiamo tutti mal di testa e nausea... sarà l'influenza?»"],
    "Intossicato dal gas in cucina": ["«È intontito in cucina, sarà la stanchezza... c'è un odore strano»"],
    "Persona investita dal treno": ["«C'è gente sui binari e il treno è passato... uno è per terra»"],
    "Sepolto dallo scavo": ["«In cantiere la terra l'ha preso, scaviamo a mano!»"],
    "Mano nel tritacarne": ["«Si è incastrato la mano nell'attrezzo in cucina, c'è sangue»"],
    "Sospetto pneumotorace": ["«Di colpo gli manca il fiato... sarà stanchezza»"],
    "Gravidanza extrauterina sospetta": ["«Ha un dolore al fianco e perdite... sarà il ciclo»"],
    "Sospetta epiglottite": ["«Il bimbo sbava e respira male... sarà mal di gola»"],
    "Parto con cordone al collo": ["«Sta partorendo in casa, il bimbo è quasi fuori... c'è qualcosa attorno al collo»"],
    "Peritonite, pancia di legno": ["«Ha mal di pancia e la febbre... sarà qualcosa che ha mangiato»"],
    "Blocco intestinale nell'anziano": ["«Mio padre è bloccato da giorni... sarà stitichezza»"],
    "Acino d'uva in gola al bimbo": ["«Il piccolo tossisce mangiando l'uva... anzi, adesso non tossisce più»"],
    "Doglie premature": ["«Sono incinta e ho un forte mal di pancia... sono al settimo mese»"],
    "Valanga travolge sciatore": ["«L'abbiamo tirato fuori dalla neve, ride... però è strano»"],
    "Annegamento in piscina privata": ["«L'abbiamo ripescato, tossisce... respira, credo»"],
    "Vespa in lattina, puntura in bocca": ["«Ha bevuto dalla lattina e ora ha la gola che pizzica... si gonfia?»"],
    "Motosega sulla coscia nel bosco": ["«Mi sono tagliato con la sega nel bosco... un taglietto, ma sanguina»","«La lama mi ha sfiorato la gamba tagliando legna... però esce tanto sangue»"],
    "Boccone di traverso alla sagra": ["«Mangiando alla sagra ha tossito forte... adesso sembra meglio, ma è strano»","«Gli è andato di traverso un boccone, tossisce... dite che passa da solo?»"],
    "Dolore toracico in casa": ["«Ha un peso sullo stomaco (dolore toracico in casa), sarà la digestione... però suda freddo»","«Gli fa male il braccio (dolore toracico in casa), magari è cervicale...»"],
    "Dolore toracico in bagno": ["«Dice che gli brucia il petto (dolore toracico in bagno), sarà acidità...»"],
    "Dolore toracico in camera da letto": ["«Ha un peso sullo stomaco (dolore toracico in camera da letto), sarà la digestione... però suda freddo»","«Gli fa male il braccio (dolore toracico in camera da letto), magari è cervicale...»"],
    "Dolore toracico in cucina": ["«Dice che gli brucia il petto (dolore toracico in cucina), sarà acidità...»"],
    "Dolore toracico al mercato": ["«Ha un peso sullo stomaco (dolore toracico al mercato), sarà la digestione... però suda freddo»","«Gli fa male il braccio (dolore toracico al mercato), magari è cervicale...»"],
    "Dolore toracico al supermercato": ["«Dice che gli brucia il petto (dolore toracico al supermercato), sarà acidità...»"],
    "Dispnea in casa": ["«Respira male (dispnea in casa), sarà l'asma...»"],
    "Dispnea in bagno": ["«Respira male (dispnea in bagno), sarà l'asma...»"],
    "Dispnea in camera da letto": ["«Respira male (dispnea in camera da letto), sarà l'asma...»"],
    "Dispnea al mercato": ["«Respira male (dispnea al mercato), sarà l'asma...»"],
    "Crisi convulsiva in casa": ["«Trema tutto (crisi convulsiva in casa), avrà freddo...»"],
    "Crisi convulsiva in bagno": ["«Trema tutto (crisi convulsiva in bagno), avrà freddo...»"],
    "Caduto dal ponteggio al secondo piano": ["«È caduto dal ponteggio ma si è rialzato... cammina, sarà niente»","«Volato dal ponteggio, dice che sta bene... però è tutto storto»"],
    "Reazione al mezzo di contrasto in radiologia": ["«Dopo la TAC ha prurito ovunque... sarà il cerotto»","«Finita la TAC si gratta e ha i pomfi... magari è il lenzuolo»"],
    "Crisi epilettica sull'autobus": ["«Sull'autobus un passeggero si dimena... forse gli gira per il caldo»","«Un uomo sull'autobus trema e sbatte... dite che è ubriaco?»"],
    "Escursionista con dolore toracico in vetta": ["«Ha un peso sul petto in vetta, sarà la quota, siamo a duemila metri...»","«Il petto gli fa male in vetta, sarà la fatica della salita...»"],
    "Fungaiolo con infarto nel bosco di montagna": ["«Si sente male nel bosco, sarà la salita che l'ha stancato...»","«Ha il petto chiuso, sarà il peso del cesto di funghi...»"],
    "Escursionista ipotermica nella bufera al valico": ["«Trema e farnetica al valico, sarà il freddo, la copro...»","«È confusa nella bufera, sarà la stanchezza...»"],
    "Infarto sul treno in stazione": ["«Ha un peso sul petto sul treno, sarà il viaggio...»","«Il petto gli fa male sul treno, sarà l'agitazione della partenza...»"],
    "Ictus sul treno in stazione": ["«Parla strano sul treno, sarà la stanchezza del viaggio...»","«Ha la faccia tirata sul treno, sarà lo stress...»"],
    "Viaggiatore colto da convulsioni sul treno": ["«Trema tutto sul treno, avrà freddo con l'aria condizionata...»","«Si dimena sul treno, forse gli gira per il caldo...»"],
  };
  // secondi dialoghi per i tipi più comuni (50%: un giorno dice una cosa, un giorno un'altra)
  const DIAL_EXTRA = {
    "Malore": ["«Mi gira tutto e sto per svenire, mi sono seduto per terra...»","«Vedo nero e ho le gambe molli, venite?»"],
    "Caduta in casa": ["«Sono scivolata in cucina, ho sbattuto il fianco...»","«È caduto dalla sedia e non riesce ad alzarsi da solo»"],
    "Febbre alta": ["«Ho 39.5 da ieri e non scende con niente»","«Il bimbo scotta, termometro a 40, cosa faccio?»"],
    "Lombalgia": ["«Mi sono bloccato con la schiena, non mi muovo dal letto»","«Un colpo alla schiena, non riesco a stare in piedi»"],
    "Sincope": ["«Sono svenuto un attimo, adesso sto meglio ma ho paura»","«Ha perso i sensi per qualche secondo»"],
    "Dolore addominale": ["«Ho una fitta al fianco destro che non passa»","«Mal di pancia forte da ore, non riesco a stare dritto»"],
    "Incidente stradale": ["«Due macchine si sono toccate, uno ha dolore al collo»","«Mi hanno tamponato, ho la testa che gira»"],
    "Caduta in bici": ["«Sono volato oltre il manubrio, il ginocchio è aperto»"],
    "Ferita da taglio": ["«Mi sono tagliato con il coltello in cucina, sanguina»"],
    "Trauma sportivo": ["«Mi sono fatto male al ginocchio giocando a calcetto»"],
    "Colica renale": ["«Ho un dolore al fianco che va e viene, da impazzire»"],
    "Palpitazioni": ["«Il cuore va a mille da mezz'ora, ho paura»"],
    "Fame d'aria nell'anziano": ["«Mio padre fa fatica a respirare stanotte»"],
    "Crisi asmatica": ["«Non trovo il ventolin e fischio sempre di più»"],
    "Attacco di panico": ["«Ho il cuore in gola e mi manca l'aria, sto morendo?»"],
    "Sangue dal naso": ["«Perdo sangue dal naso da venti minuti, non si ferma»"],
    "Caduta in strada": ["«Sono inciampato e ho sbattuto il ginocchio, non cammino»"],
    "Caduta dalle scale": ["«Sono caduto dalle scale, la caviglia fa malissimo»"],
  };
 // chiamate da altri enti: solo 112 e 113 (15%: sostituiscono l'apertura normale)
 const DIAL_112 = [
   "«Qui 112, carabinieri: serve un'ambulanza sul posto.»",
    "«112, vi giro una richiesta: c'è un ferito qui.»",
    "«Carabinieri: abbiamo bisogno del sanitario qui subito.»",
    "«112: la pattuglia è già sul posto, mandate un'ambulanza.»",
    "«Qui 112, vi passo le coordinate: serve il 118.»",
  ];
  const DIAL_113 = [
    "«Qui 113, polizia: mandate un'ambulanza, c'è una persona a terra.»",
    "«113, abbiamo un ferito in strada, serve il sanitario.»",
    "«Polizia: serve un equipaggio sanitario qui subito.»",
    "«113: teniamo la scena, mandate il sanitario.»",
    "«Qui 113, vi giro la posizione: serve un'ambulanza.»",
  ];
  const DIAL_115 = [
    "«Pronto, i pompieri? Serve aiuto, fate presto!»",
    "«115? Venite qui, è urgente!»",
    "«Pronto, chiamavo i vigili del fuoco!»",
    "«Vigili del fuoco? Vi dico dove siamo, sbrigatevi!»",
  ];
 // veste la chiamata (il tipo vero resta nascosto)
 function vesteChiamata(tipo, ente){
   let dialogo;
   const fx = DIAL_FUORVIANTI[tipo.nome];
   if(fx && Math.random()<0.4) dialogo = fx[rndi(0,fx.length-1)];
   else {
     // pesca tra dialogo base + 2 varianti + eventuali extra: ogni tipo ha 3-4 voci diverse
     const pool = [((D().CHIAMATE||{})[tipo.nome] || "«Aiuto, venite subito!»")];
     const vx = ((D().CHIAMATE_VAR||{})[tipo.nome])||[];
     for(let i=0;i<vx.length;i++) pool.push(vx[i]);
     const ex = DIAL_EXTRA[tipo.nome];
     if(ex) for(let i=0;i<ex.length;i++) pool.push(ex[i]);
     dialogo = pool[rndi(0,pool.length-1)];
   }
   const z = tipo.zona || "misto";
   const parts = [];
   const rAp = Math.random();
    // flusso naturale stile 112: gancio (tono) → fatto → luogo → disponibilità.
    // L'ente che ha passato la chiamata fa da gancio (112/113/115 coerenti).
   const poolEnte = ente==="115" ? DIAL_115 : ente==="113" ? DIAL_113 : DIAL_112;
    let urgente = false, hook = null;
    if(rAp<0.15){ hook = poolEnte[rndi(0,poolEnte.length-1)]; urgente = true; }
    else if(rAp<0.70){
      const rT = Math.random();
      if(rT<0.30){ hook = DIAL_PANICO[rndi(0,DIAL_PANICO.length-1)]; urgente = true; }
      else if(rT<0.65){ hook = DIAL_PREOCCUPATO[rndi(0,DIAL_PREOCCUPATO.length-1)]; urgente = Math.random()<0.3; }
      else hook = DIAL_CALMO[rndi(0,DIAL_CALMO.length-1)];
    }
    if(hook) parts.push(hook);
    // niente "Pronto" due volte: se c'è il gancio, il fatto parte diretto
    if(hook){ const s = dialogo.replace(/^«\s*Pronto[,.!?…\s]*/, "«"); if(s.length>6) dialogo = s; }
    parts.push(dialogo);
    if(!tipo.qui && Math.random()<0.55){
      const pool = DIAL_SCENA[z] || DIAL_SCENA.misto;
      parts.push(pool[rndi(0,pool.length-1)]);
    }
    // mai due suppliche di fila: dopo un gancio urgente solo disponibilità oneste
    if(Math.random()<0.45){
      if(urgente) parts.push(DIAL_CHIUSURE_DISP[rndi(0,DIAL_CHIUSURE_DISP.length-1)]);
      else parts.push(Math.random()<0.4 ? DIAL_CHIUSURE_CALDE[rndi(0,DIAL_CHIUSURE_CALDE.length-1)] : DIAL_CHIUSURE_DISP[rndi(0,DIAL_CHIUSURE_DISP.length-1)]);
    }
    dialogo = parts.join(" ");
    return { dialogo, muta: false };
 }
 // fasce orarie: certi tipi escono di più a certe ore (notte, punta traffico, orario lavoro)
  const ORE_PESO = [
    {h:[0,1,2,3,4,5], rx:/Rissa|Aggressione|Coma etilico|Overdose|Tentato suicidio|Urgenza psichiatrica|Colpo d'arma|Accoltellamento|Rissa al bar/, m:2.2},
    {h:[0,1,2,3,4,5], rx:/Incidente|Tamponamento|Scontro|Investimento|Auto contro|Infortunio|Schiacciamento|Esposizione/, m:0.4},
    {h:[7,8], rx:/Incidente|Tamponamento|Scontro|Investimento|Auto contro|Maxi/, m:2.0},
    {h:[17,18,19], rx:/Incidente|Tamponamento|Scontro|Investimento|Auto contro/, m:1.6},
    {h:[8,9,10,11,12,13,14,15,16,17], rx:/Infortunio|Schiacciamento|Esposizione a solventi|Caduta da impalcatura/, m:1.8},
    {h:[20,21,22,23], rx:/Rissa al bar|Aggressione/, m:1.8},
  ];
  // COERENZA: ogni missione deve avere senso nel contesto in cui esce
  // (stagione via temperatura, ora del giorno, meteo). Moltiplicatore 0-1 sul peso.
  const SENSO_NEVE = /valanga|sciatore|sciatori|pista da sci|slittin|motoslitta|palaghiaccio|hockey|ghiaccio coi pattini|racchette da neve|bufera|tormenta|innevato|ghiacciaio|crepaccio|seracco|nevaio|ramponi|piolet|pista da fondo|snowpark/i;
  const SENSO_ESTATE = /tuffo|spiaggia|bagnino|pedalò|windsurf|kitesurf|motoscafo|moto d'acqua|shock termico|colpo di calore|caldo in auto|caldo a tennis|scivolo acquatico|piscina|insolazione|colpo di sole|sci nautico|canoa|sup vicino riva|sup trascinato|materassino|medusa|elica di barca|boma in barca/i;
  const SENSO_SCUOLA = /scuolabus|scuola|scolastica|asilo/i;
  const SENSO_LAVORO = /fabbrica|cantiere|officina|magazzino|muletto|transpallet|ponteggio|impalcatura|capannone|segheria|betoniera|\bgru\b|autogru|trattore|mietitrebbia|falciatrice|pressa|tornio|sega a nastro/i;
  const SENSO_SPORT = /stadio|partita|torneo|allenamento|maratona|triathlon|palestra|tennis|paddle|golf|calcio|basket|rugby|boxe|judo|karate|bocce|bowling|skateboard|pattini|podista|corsa campestre|\bgara\b/i;
  const SENSO_MERCATO = /mercato|supermercato|banca|ufficio|postale|farmacia|dentista|barbiere|tatuaggi|parrucchiere|negozio|pizzeria|ristorante/i;
  function sensoMult(nome){
    const h = Math.floor(clockMin/60)%24, temp = meteo.temp, cond = meteo.cond;
    const notte = (h<6);
    const esenteNotte = /di notte|notturn/i.test(nome); // es. "Ufficio postale a fuoco di notte"
    let m = 1;
    if(SENSO_NEVE.test(nome)){ // neve solo col freddo (la temperatura fa da stagione)
      if(temp>16) return 0;
      if(temp>12) m*=0.05;
    }
    if(SENSO_ESTATE.test(nome) && !/cloro/i.test(nome)){ // piscina coperta col cloro: tutto l'anno
      if(cond==="Pioggia"||cond==="Temporale"||cond==="Pioggia intensa") m*=0.1; // tuffi e pedalò col maltempo: quasi mai
      if(cond==="Nebbia") m*=0.5; // lago e spiaggia nella nebbia: pochi
      if(temp<5) return 0;
      if(temp<10) m*=0.05; else if(temp<15) m*=0.3;
    }
    if(SENSO_SCUOLA.test(nome)){ if(h<7||h>=19) return 0; } // scuola solo in orario scolastico
    if(notte && !esenteNotte){ // di notte la gente dorme: fabbriche, sport, negozi e lago quasi mai
      if(SENSO_LAVORO.test(nome)) m*=0.1;
      if(SENSO_SPORT.test(nome) && !/monopattini/i.test(nome)) m*=0.15; // i monopattini a noleggio girano anche di notte
      if(SENSO_MERCATO.test(nome)) m*=0.05;
      if(SENSO_ESTATE.test(nome)) m*=0.2;
      if(SENSO_NEVE.test(nome)) m*=0.2;
    }
    if(/discoteca/i.test(nome) && h>=6 && h<20) m*=0.15;
    if(/concerto|festa|sagra|stadio/i.test(nome) && h>=6 && h<13) m*=0.4;
    return m;
  }
  function oreMult(nome){
    const h = Math.floor(clockMin/60)%24;
    let m = 1;
    for(const o of ORE_PESO){ if(o.h.includes(h) && o.rx.test(nome)) m *= o.m; }
    return m;
  }
  // pianificazione per fasce orarie (pannello ⏰ Fasce): automedica meno/più, più pazienti, maxiemergenze
 const FASCE = [
    { nome:"00–06", amb:5, maxi:4, manv:5 },
    { nome:"06–12", amb:5, maxi:4, manv:5 },
    { nome:"12–18", amb:5, maxi:4, manv:5 },
    { nome:"18–24", amb:5, maxi:4, manv:5 },
  ];
  function fasciaAmbNum(v){
    if(v==="meno") return 2;
    if(v==="norm") return 5;
    if(v==="piu") return 8;
    return Math.max(0.5, Math.min(10, parseFloat(v)||5));
  }
  // peso missioni da ambulanza 1-10 (1 rarissime … 10 molto frequenti); le automediche restano a probabilità base
  function fasciaAmbMult(t){
    if(!(t.mezzi && ((t.mezzi.MSB||0)>0 || (t.mezzi.MSA||0)>0))) return 1;
    return 0.15*Math.pow(1.55, fasciaAmbNum(FASCE[fasciaIdx()].amb)-1); // 1→0.15 … 5→0.86 … 10→7.7
  }
  // frequenza eventi grossi 1-10 (1 rarissima … 10 molto frequente); restano validi mai/rara/freq
  function fasciaMaxiProb(v){
    if(v==="mai") return 0;
    if(v==="rara") return 0.02;
    if(v==="freq") return 0.06;
    const n = Math.max(0.5, Math.min(10, parseFloat(v)||1));
    return 0.002*Math.pow(1.8, n-1); // 0.5→0.15% … 1→0.2% … 4→1.2% … 8→12% … 9→22% … 10→40% a chiamata
  }
  function fasciaIdx(){ const h = Math.floor(clockMin/60)%24; return h<6?0:h<12?1:h<18?2:3; }
  function setFascia(i,k,v){
    if(!FASCE[i]) return;
    if(k==="maxi"||k==="manv") FASCE[i][k] = Math.max(0.5, Math.min(10, parseFloat(v)||1));
    else if(k==="amb") FASCE[i][k] = fasciaAmbNum(v);
  }
  // tasto ✅ Applica del pannello Fasce: legge i 12 input e li applica in blocco (clamp 0.5-10)
  function applicaFasce(){
    const keys = ["amb","maxi","manv"];
    for(let i=0;i<4;i++) for(const k of keys){
      const el = document.getElementById("fas"+i+k);
      if(el) setFascia(i,k,el.value);
    }
    syncFasce();
    toast("✅ Fasce orarie applicate");
  }
  // riallinea gli input ai valori reali (apertura pannello / dopo Applica)
  function syncFasce(){
    const keys = ["amb","maxi","manv"];
    for(let i=0;i<4;i++) for(const k of keys){
      const el = document.getElementById("fas"+i+k);
      if(el && FASCE[i]) el.value = FASCE[i][k];
    }
  }
  // liste eventi grossi (UTENTE: mandami le tue liste e le metto qui — i nomi devono esistere nei TIPI)
  const MAXI_TIPI = ["Maxi tamponamento","Tamponamento in autostrada","Incendio capannone","Fuga di gas in palazzina","Crollo edificio","Pullman contro guardrail","Tamponamento tra bus e auto in coda","Incidente autobus","Palco crollato al concerto","Rissa in discoteca","Crollo palazzina in centro","Incendio in discoteca affollata","Deragliamento treno passeggeri","Scontro tra treni in galleria","Autobus nel burrone","Pullman contro pilone in autostrada","Incendio mercato coperto affollato","Esplosione palazzina per fuga di gas","Crollo ponte con auto sopra","Incendio in casa di riposo","Naufragio battello sul lago","Funivia bloccata con cabine piene","Crollo tribuna allo stadio","Fuga di ammoniaca al palazzetto","Incendio in scuola con evacuazione","Cisterna contro auto in autostrada","Maxi tamponamento in galleria","Crollo gru su palazzina","Incendio deposito fuochi d'artificio","Valanga sulla strada con auto travolte"];
  const MANV_TIPI = ["Incidente scuolabus","Incidente stradale","Pullman contro guardrail","Tamponamento tra bus e auto in coda","Rissa in discoteca","Concerto e calca","Rissa in campo","Rissa al bar","Sciame d'api","Intossicazione alimentare","Scontro tra auto e moto al semaforo","Scontro tra furgone e bici alla rotonda","Scontro tra taxi e monopattino in centro","Scontro tra SUV e moto in curva cieca","Scontro tra autobus e auto al capolinea","Scontro tra camion e furgone in zona industriale","Scontro tra auto d'epoca e spider sul lungolago","Scontro tra camper e auto in galleria","Scontro tra pick-up e bici in salita","Scontro tra tram e auto in viale","Scontro tra pullman e auto in autostrada","Scontro tra scuolabus e auto all'uscita","Scontro tra NCC e moto di notte","Scontro tra limousine e scooter in centro","Scontro tra fuoristrada e quad in discesa","Scontro tra minibus e auto al bivio","Scontro tra betoniera e auto in cantiere","Scontro tra spazzatrice e bici all'alba","Scontro tra corriera e furgone sul ponte","Scontro tra Apecar e moto in discesa","Scontro tra moto in curva cieca","Scontro tra bici e monopattino sulla ciclabile","Scontro tra auto e monopattino sulle strisce","Scontro tra filobus e bici in viale","Scontro tra taxi e bus in corsia","Scontro tra furgoncino e moto al semaforo","Scontro tra station wagon e scooter alla rotonda","Scontro tra roulotte e auto in discesa","Scontro tra camper e moto in autostrada","Scontro tra SUV e autobus in tangenziale","Scontro tra auto e cinghiale di notte","Scontro tra moto e cervo sulla provinciale","Scontro tra auto e autoarticolato in retromarcia","Scontro tra bici e auto in contromano","Scontro tra furgone e tram sui binari","Scontro tra moto e guardrail in curva","Scontro tra auto e muro in galleria","Scontro tra pullman e camion in autostrada","Scontro tra scuolabus e bici all'uscita","Scontro tra auto sul passo innevato","Tamponamento tra auto e moto in coda","Tamponamento tra furgone e auto al semaforo","Tamponamento tra taxi e bus in coda","Tamponamento tra SUV e camper in autostrada","Tamponamento tra moto e scooter in centro","Tamponamento tra autobus e auto in coda","Tamponamento tra camion e auto in galleria","Tamponamento tra NCC e taxi in stazione","Tamponamento tra pick-up e furgone in salita","Tamponamento tra camper e roulotte in discesa","Tamponamento tra tram e auto ai binari","Tamponamento tra monopattino e auto in centro","Tamponamento tra scuolabus e auto in colonna","Tamponamento tra pullman e camion in autostrada","Tamponamento tra Apecar e furgone in paese","Tamponamento tra fuoristrada e SUV in sterrata","Tamponamento tra minibus e taxi in fiera","Tamponamento tra betoniera e camion in cantiere","Tamponamento tra spider e moto sul lungolago","Tamponamento tra station wagon e furgoncino alla rotonda","Tamponamento tra limousine e NCC in centro","Tamponamento tra filobus e auto in viale","Tamponamento tra corriera e camper sul ponte","Tamponamento tra spazzatrice e furgone all'alba","Tamponamento tra autoarticolato e auto in rotonda","Tamponamento tra camper e bus in piazzola","Tamponamento tra taxi e moto al semaforo","Tamponamento tra auto e volante della polizia","Tamponamento tra moto d'epoca e auto in piazza","Tamponamento tra SUV e moto in tangenziale","Investimento pedone sulle strisce di notte","Investimento ciclista in galleria","Investimento runner all'alba","Investimento monopattino in discesa","Bimbo in bici investito all'uscita di scuola","Anziano investito al mercato","Motociclista contro guardrail in tangenziale","Scooter contro palo in viale","Auto contro albero sulla provinciale","Furgone contro muretto in curva","Camper contro pensilina del distributore","Autobus contro pensilina alla fermata","Filobus contro palo in viale","Pullman nella scarpata in montagna","Scuolabus contro guardrail in gita","Camion contro casa in curva","Auto nel fiume dal ponte","Moto nel torrente","Bici contro portiera in centro","Passeggino urtato sulle strisce","Carrozzina investita sulle strisce","Skate contro auto al parco","Ciclista caduto nella rotaia del tram","Moto contro cinghiale di notte","Auto contro mucca al pascolo","Furgone contro gregge in montagna","Camion contro traliccio in campagna","Auto contro pensilina del distributore","Auto contro masso in montagna","Tettoia crollata sulle auto al mercato"];
  function pescaDaLista(lista){
    const cand = [];
    for(const n of lista){ const t = D().TIPI.find(x=>x.nome===n); if(t) cand.push(t); }
    return cand.length ? cand[rndi(0,cand.length-1)] : null;
  }
  // conteggio MANV da 5 in su (pesi su 100: 5 ~70%, 6 ~20%, 7 ~10%)
  function tiraNManv(){
    const ws = [0,0,0,0,70,20,10,0];
    let tot = 0; for(const w of ws) tot += w;
    let r = Math.random()*tot;
    for(let i=0;i<ws.length;i++){ r -= ws[i]; if(r<=0) return i+1; }
    return 5;
  }
  // conteggio maxiemergenza da 8 in su (pesi su 28.5: 8 ~35%, 9 ~25%, 10 ~18%, 11+ rari)
  function tiraConteggioMaxi(){
    const ws = [[8,10],[9,7],[10,5],[11,2],[12,1.5],[13,1],[14,1],[15,1]];
    let tot = 0; for(const c of ws) tot += c[1];
    let r = Math.random()*tot;
    for(const c of ws){ r -= c[1]; if(r<=0) return c[0]; }
    return 8;
  }
  function tiraEventoGrande(){
    // maxiemergenza (8-15 feriti) e MANV (5-7 feriti) — i pazienti si assegnano dopo;
    // riprova finché non trova un tipo sensato, non aperto e non appena uscito
    const f = FASCE[fasciaIdx()];
    const pMaxi = fasciaMaxiProb(f.maxi), pManv = fasciaMaxiProb(f.manv);
    const r = Math.random();
    const okEv = (t)=>t && sensoMult(t.nome)>=0.2 && !tipiAperti().has(t.nome) && !tipoBandito(t.nome);
    if(r < pMaxi){ for(let k=0;k<6;k++){ const t = pescaDaLista(MAXI_TIPI); if(okEv(t)) return { tipo:t, maxi:true }; } }
    if(r < pMaxi + pManv){ for(let k=0;k<6;k++){ const t = pescaDaLista(MANV_TIPI); if(okEv(t)) return { tipo:t, manv:true }; } }
    return null;
  }

  // punto ESATTAMENTE su una vera autostrada/statale (missioni autostradali): zero jitter,
  // le geometrie STRADE sono dense (errore max ~1 m) quindi il punto cade sulla strada vera
  function puntoSuStrada(soloA){
    const ST = D().STRADE || {};
    const refs = Object.keys(ST).filter(r=>!soloA || ST[r].cls==="A");
    if(!refs.length) return null;
    for(let k=0;k<24;k++){
      const r = refs[rndi(0,refs.length-1)];
      const segs = ST[r].seg || [];
      const s = segs[rndi(0,segs.length-1)];
      if(!s || s.length<2) continue;
      const i = rndi(0,s.length-2), t = Math.random();
      const la = s[i][0]+(s[i+1][0]-s[i][0])*t;
      const ln = s[i][1]+(s[i+1][1]-s[i][1])*t;
      if(inAcqua(la,ln)) continue;
      return {lat:la, lng:ln, ref:r};
    }
    return null;
  }
  // punto SU una vera ferrovia (missioni ferroviarie): modi stazione/galleria/PL/libero dal nome;
  // le geometrie FERROVIE sono OSM reali (errore ~2 m), il punto cade sul binario vero
  function modoFerro(nome){
    const n = (nome||"").toLowerCase();
    if(n.indexOf("galleria")>=0) return "galleria";
    if(n.indexOf("passaggio a livello")>=0 || n.indexOf("sbarra del passaggio")>=0 || n.indexOf("sbarra passaggio")>=0 || n.indexOf("sul passaggio")>=0) return "PL";
    if(n.indexOf("in stazione")>=0 || n.indexOf("sul treno")>=0 || n.indexOf("in carrozza")>=0 || n.indexOf("a bordo")>=0 || n.indexOf("macchinista")>=0 || n.indexOf("passeggeri")>=0 || n.indexOf("evacuare")>=0) return "stazione";
    return "libero";
  }
  // punto stradale per i mezzi (stazioni e PL sono su strada, in linea si usa il più vicino)
  function accessoFerro(la, ln){
    const F = (typeof FERROVIE!=="undefined") ? FERROVIE : null;
    let best = null, bd = 25; // max 25 km dalla scena
    if(F){
      for(const s of (F.STAZ||[])){ const d = haversineKm(la, ln, s.la, s.ln); if(d<bd){ bd=d; best=[s.la,s.ln]; } }
      for(const p of (F.PL||[])){ const d = haversineKm(la, ln, p[0], p[1]); if(d<bd){ bd=d; best=[p[0],p[1]]; } }
    }
    return best || [la, ln];
  }
  function indirizzoFerro(fp, comune){
    const lin = fp.linea ? ("Linea "+fp.linea) : "Tratta ferroviaria";
    if(fp.modo==="stazione" && fp.luogo) return lin+" ("+fp.luogo+") - "+comune;
    if(fp.modo==="PL") return lin+" (passaggio a livello) - "+comune;
    if(fp.modo==="galleria") return lin+" (galleria) - "+comune;
    return lin+" - "+comune;
  }
  function lineaVicina(la, ln){
    const F = (typeof FERROVIE!=="undefined") ? FERROVIE : null;
    if(!F) return "";
    let best = "", bd = 1.2; // nome della linea attiva più vicina entro ~1,2 km
    for(const l of (F.LINEE||[])){
      if(l.d || !l.n) continue;
      for(const s of (l.s||[])){
        for(let i=0;i<s.length;i++){
          const d = haversineKm(la, ln, s[i][0], s[i][1]);
          if(d<bd){ bd=d; best=l.n; }
        }
      }
    }
    return best;
  }
  function puntoSuFerrovia(nome){
    const F = (typeof FERROVIE!=="undefined") ? FERROVIE : null;
    if(!F) return null;
    const modo = modoFerro(nome);
    for(let k=0;k<24;k++){
      let la, ln, linea = "", luogo = "";
      if(modo==="stazione"){
        const S = F.STAZ||[];
        if(!S.length) return null;
        const s = S[rndi(0,S.length-1)];
        la = s.la+rnd(-0.0006,0.0006); ln = s.ln+rnd(-0.0006,0.0006);
        luogo = s.n ? ("Stazione di "+s.n) : "";
        linea = lineaVicina(la, ln);
      } else if(modo==="galleria"){
        const T = F.TUN||[];
        if(!T.length) return null;
        const t = T[rndi(0,T.length-1)];
        la = t[0]+rnd(-0.0006,0.0006); ln = t[1]+rnd(-0.0006,0.0006);
        linea = lineaVicina(la, ln);
      } else if(modo==="PL"){
        const P = F.PL||[];
        if(!P.length) return null;
        const p = P[rndi(0,P.length-1)];
        la = p[0]+rnd(-0.0006,0.0006); ln = p[1]+rnd(-0.0006,0.0006);
        linea = lineaVicina(la, ln);
      } else {
        const L = (F.LINEE||[]).filter(l=>!l.d && (l.s||[]).length); // tutto il binario attivo, anche senza nome (indirizzo: Tratta ferroviaria)
        if(!L.length) return null;
        let tot = 0;
        for(const l of L){ let np = 0; for(const s of l.s) np += s.length; l._np = np; tot += np; }
        let r = Math.random()*tot, scelta = L[L.length-1];
        for(const l of L){ r -= l._np; if(r<=0){ scelta = l; break; } }
        const segs = scelta.s;
        const s = segs[rndi(0,segs.length-1)];
        if(!s || s.length<2) continue;
        const i = rndi(0,s.length-2), t = Math.random();
        la = s[i][0]+(s[i+1][0]-s[i][0])*t;
        ln = s[i][1]+(s[i+1][1]-s[i][1])*t;
        linea = scelta.n;
      }
      const ncF = nearestComune(la, ln);
      if(haversineKm(la, ln, ncF.lat, ncF.lng)>4) continue; // fuori area di gioco (es. Milano città): resta in VA/CO/LC/MB/MI
      if(inAcqua(la,ln)) continue;
      const acc = accessoFerro(la, ln);
      return {lat:la, lng:ln, linea:linea, luogo:luogo, modo:modo, accLa:acc[0], accLng:acc[1]};
    }
    return null;
  }
  // reti infrastrutturali reali OSM (INFRA da src/infra.js): punti assoluti in
  // P/GAL/GUA, polilinee delta-encoded in G (interi ×1e5, primo assoluto + delta,
  // come STRADE_ALL). Mai doppioni con ferrovie/strade (solo 118+VVF).
  const _infraG = {};
  function infraLinee(cat){
    if(_infraG[cat]) return _infraG[cat];
    const out = [];
    try{
      const I = (typeof INFRA!=="undefined") ? INFRA : null;
      const raw = (I && I.G && I.G[cat]) || null;
      if(raw) for(const e of raw){
        const a = Array.isArray(e) ? e : (e && e.g);
        if(!a || a.length<4) continue;
        const p = [[a[0]/100000, a[1]/100000]];
        let la = a[0], ln = a[1];
        for(let i=2;i+1<a.length;i+=2){ la += a[i]; ln += a[i+1]; p.push([la/100000, ln/100000]); }
        out.push({pts:p, n:((e && e.n) || "")});
      }
    }catch(_){}
    _infraG[cat] = out;
    return out;
  }
  function infraPunti(cat){
    try{
      const I = (typeof INFRA!=="undefined") ? INFRA : null;
      if(!I) return [];
      if(cat==="GAL") return I.GAL || [];
      if(cat==="GUA") return I.GUA || [];
      return (I.P && I.P[cat]) || [];
    }catch(_){ return []; }
  }
  // etichetta per l'indirizzo quando il punto non ha un nome proprio
  const INFRA_ETICH = {FIU:"sul fiume",LAGO:"al lago",DIGA:"alla diga",BOSCO:"nel bosco",ELET:"sotto l'elettrodotto",IND_A:"nella zona industriale",MONT:"in montagna",GASL:"sul metanodotto",ARG:"sull'argine",VET:"in vetta",PORT:"al porto",CARB:"al distributore",TOW:"sotto il traliccio",SENT:"sul sentiero",DGAP:"alla cascata",SOTT:"al parcheggio",RIF:"al rifugio",TLC:"sotto l'antenna",IDRO:"all'acquedotto",IND:"in fabbrica",ELI:"all'elisuperficie",SUB:"alla cabina elettrica",GAS:"al deposito gas",FUNI:"alla funivia",BAGN:"in spiaggia",SPORT:"al campo sportivo",AERO:"all'aviosuperficie",LOGI:"al deposito",GAL:"in galleria",GUA:"al guado"};
  // punto SU una vera rete (missioni infrastrutturali): da polilinea (punto su
  // segmento, nome del fiume se c'è) o da punto noto (nome proprio se c'è)
  function puntoSuInfra(spec){
    const cats = Array.isArray(spec) ? spec : [spec];
    for(let k=0;k<24;k++){
      const cat = cats[rndi(0,cats.length-1)];
      const G = infraLinee(cat), P = infraPunti(cat);
      if(!G.length && !P.length) continue;
      let la, ln, luogo = "";
      if(G.length && (Math.random()<0.75 || !P.length)){
        const e = G[rndi(0,G.length-1)];
        const s = e.pts;
        if(!s || s.length<2) continue;
        const i = rndi(0,s.length-2), t = Math.random();
        la = s[i][0]+(s[i+1][0]-s[i][0])*t;
        ln = s[i][1]+(s[i+1][1]-s[i][1])*t;
        luogo = e.n || "";
      } else {
        const p = P[rndi(0,P.length-1)];
        la = p[0]+rnd(-0.0006,0.0006); ln = p[1]+rnd(-0.0006,0.0006);
        if(typeof p[2]==="string" && p[2]) luogo = p[2];
      }
      const nc = nearestComune(la, ln);
      if(haversineKm(la, ln, nc.lat, nc.lng)>4) continue; // fuori area di gioco: resta in VA/CO/LC/MB/MI
      if(inAcqua(la,ln)) continue;
      return {lat:la, lng:ln, luogo:luogo, etich:INFRA_ETICH[cat]||"sull'infrastruttura", cat:cat};
    }
    return null;
  }
  // punto rete più vicino entro maxKm (snap del tasto destro): scansione con scarto rapido su bbox
  function puntoSuInfraVicino(la, ln, spec, maxKm){
    const cats = Array.isArray(spec) ? spec : [spec];
    let best = null, bd = maxKm || 1.5;
    for(const cat of cats){
      const et = INFRA_ETICH[cat]||"sull'infrastruttura";
      for(const p of infraPunti(cat)){
        if(Math.abs(p[0]-la)>0.02 || Math.abs(p[1]-ln)>0.02) continue;
        const d = haversineKm(la, ln, p[0], p[1]);
        if(d<bd){ bd = d; best = {lat:p[0], lng:p[1], luogo:(typeof p[2]==="string"?p[2]:""), etich:et, cat:cat}; }
      }
      for(const e of infraLinee(cat)){
        for(const q of (e.pts||[])){
          if(Math.abs(q[0]-la)>0.02 || Math.abs(q[1]-ln)>0.02) continue;
          const d = haversineKm(la, ln, q[0], q[1]);
          if(d<bd){ bd = d; best = {lat:q[0], lng:q[1], luogo:e.n||"", etich:et, cat:cat}; }
        }
      }
    }
    return best;
  }
  function indirizzoInfra(ip, comune){
    if(ip.luogo) return ip.luogo+" - "+comune;
    const e = ip.etich||"sull'infrastruttura";
    return e.charAt(0).toUpperCase()+e.slice(1)+" - "+comune;
  }
  // Tipi alpini: nascono solo sulle montagne vere (viste prima: vette, rifugi,
  // sentieri reali da src/infra.js). I falsi amici restano dove sono (sci nautico
  // al lago, pattinaggio in paese, paracadute in aviosuperficie...).
  function isMontagna(tipo){
    const t = ((tipo.nome||"")+" "+(tipo.desc||"")).toLowerCase();
    if(/sci nautico|indoor|palaghiaccio|pattin|rotelle|scooter|motorino|ciclomotore|paracadute|kitesurf|wakeboard|sup |paddle|parco giochi|percorso vita|tenda da sole|camper|roulotte|del lago|lungolago|cantiere|scavo/.test(t)) return false;
    return /valanga|fuoripista|pista da sci|sciator|scialpin|alpinismo|ferrata|falesia|rifugio|baita|casera|alpeggio|malga|pascolo alto|escursionista|fungaiolo|motoslitta|slittino|dirupo|burrone|tibetano|bufera|trail|speleologo|grotta|orientista|innevato|valico|sentiero|mulattiera|cresta|vetta|parete|forra|canyonista|greto|cascata|seggiovia|cabinovia|funivia|parapendio|deltaplano|forcella|montagna|ghiacciaio|crepaccio|seracco|cordata|bivacco|morena|nevaio|ghiaione|canalone|crestone|risalita|stazione di monte|stazione di valle|pista da fondo|snowpark/.test(t);
  }
  // vette come prova di montagna vera (punti SENT/RIF isolati in pianura esclusi)
  let _vetPts = null;
  function montagnaVera(la, ln, maxKm){
    if(!_vetPts) _vetPts = infraPunti("VET");
    const lim = maxKm || 3;
    for(const p of _vetPts){
      if(Math.abs(p[0]-la)>0.05 || Math.abs(p[1]-ln)>0.05) continue; // scarto rapido su bbox
      if(haversineKm(la, ln, p[0], p[1])<=lim) return true;
    }
    return false;
  }
  function creaBozzaUna(forceProv=null, forceTipoNome=null){
        // spawn pesato direttamente sui comuni delle province abilitate (Milano + sud pesano di più)
    let c, prov;
    if(forceProv){ prov = forceProv; c = comuneRandom(prov); }
    else {
      const pool = D().COMUNI.filter(cc=>filters[cc.p]);
      c = pickPesato(pool.length ? pool : D().COMUNI.filter(cc=>cc.p==="VA"));
      prov = c.p;
    }
    const provs = ["VA","CO","LC","MB","MI"].filter(p=>filters[p]);
    if(!provs.length) provs.push("VA");
    let { tipo, prio } = tipoRandom();
    let maxi = false, manv = false;
    if(forceTipoNome){
      const ft = D().TIPI.find(x=>x.nome===forceTipoNome);
      if(ft){ tipo = ft; prio = prioDaTipo(ft); } // danno mirato (maltempo): niente maxi/MANV sopra
    } else {
      const evG = tiraEventoGrande();
      // evento grosso della fascia: codice rosso (ma mai uguale a uno già aperto o appena uscito)
      if(evG && !tipiAperti().has(evG.tipo.nome) && !tipoBandito(evG.tipo.nome)){ tipo = evG.tipo; prio = 1; maxi = !!evG.maxi; manv = !!evG.manv; }
    }
  // (notaTipo spostata nel wrapper: si registra solo la bozza accettata e mostrata)
    const enteBozza = tipo.vvf ? "115" : (Math.random()<0.5 ? "112" : "113");
    const vest = vesteChiamata(tipo, enteBozza);
    let via = viaDaComune(c.n);
    // posizione realistica secondo zona del tipo: casa in paese, strada, natura, riva lago, punto fisso
    const z = tipo.zona || "misto";
    let cc = c, pp = prov, iLat = c.lat, iLng = c.lng;
    // missioni autostradali/tangenziali/superstrade: punto SU una vera strada
    let hwyRef = null;
    if(/autostrada|tangenziale|superstrada|spartitraffico/i.test(tipo.nome) || tipo.nome==="Scontro tra camion"){
      const hp = puntoSuStrada(/autostrada/i.test(tipo.nome));
      if(hp){ iLat = hp.lat; iLng = hp.lng; hwyRef = hp.ref; const nb = nearestComune(iLat, iLng); cc = nb; pp = nb.p; }
    }
    // missioni ferroviarie: punto SU un vero binario/stazione/galleria/PL
    let ferroRef = null;
    if((tipo.zona||"")==="ferro"){
      const fp = puntoSuFerrovia(tipo.nome);
      if(fp){ iLat = fp.lat; iLng = fp.lng; ferroRef = fp; const nb = nearestComune(iLat, iLng); cc = nb; pp = nb.p; }
    }
    // missioni infrastrutturali: punto SU una vera rete (fiume, elettrodotto, sentiero...)
    let infraRef = null;
    if((tipo.zona||"")==="infra" && tipo.infra){
      const ip = puntoSuInfra(tipo.infra);
      if(ip){ iLat = ip.lat; iLng = ip.lng; infraRef = ip; const nb = nearestComune(iLat, iLng); cc = nb; pp = nb.p; }
    }
    // chiamate di montagna solo sulle montagne vere: i tipi alpini senza punto
    // proprio (natura generica) si agganciano a vette/funivie/montagna; rifugi e
    // sentieri valgono solo se davvero in quota (entro 3 km da una vetta mappata);
    // la neve (valanghe/sci/slittini/motoslitte) al primo giro vuole solo quota vera
    let montRef = null;
    if(!hwyRef && !ferroRef && !infraRef && !tipo.qui && z!=="lago" && isMontagna(tipo)){
      const _tm = ((tipo.nome||"")+" "+(tipo.desc||"")).toLowerCase();
      const _snow = /valanga|fuoripista|pista da sci|sciator|scialpin|alpinismo|motoslitta|slittino|ghiacciaio|crepaccio|pista da fondo|snowpark/.test(_tm);
      for(let pass=0; pass<2 && !montRef; pass++){
        for(let k=0;k<24 && !montRef;k++){
          const mp = puntoSuInfra(["VET","MONT","FUNI","RIF","SENT"]);
          if(!mp) continue;
          if(mp.cat==="RIF"||mp.cat==="SENT"){
            if(_snow && pass===0) continue;
            if(!montagnaVera(mp.lat, mp.lng)) continue;
          }
          iLat=mp.lat; iLng=mp.lng; montRef=mp; const nb=nearestComune(iLat,iLng); cc=nb; pp=nb.p;
        }
      }
    }
    if(hwyRef){ /* gia posizionato sulla strada vera */ }
    else if(ferroRef){ /* gia posizionato sulla ferrovia vera */ }
    else if(infraRef){ /* gia posizionato sulla rete vera */ }
    else if(montRef){ /* gia posizionato sulle montagne vere */ }
    else if(tipo.qui){
      iLat = tipo.qui[0]+rnd(-0.002,0.002); iLng = tipo.qui[1]+rnd(-0.002,0.002);
      cc = nearestComune(iLat, iLng); pp = cc.p;
    } else if(z==="lago"){
      const laghi = D().LAGHI || [];
      for(let k=0;k<30;k++){
        const poly = laghi[rndi(0,laghi.length-1)];
        const v = poly[rndi(0,poly.length-1)];
        const tLat = v[0]+rnd(-0.004,0.004), tLng = v[1]+rnd(-0.005,0.005);
        if(inAcqua(tLat,tLng)) continue;
        if(tLng<8.95 && tLat>46.095) continue; // sponda svizzera del Maggiore (Locarno): niente missioni in Svizzera
        const nb = nearestComune(tLat, tLng);
        if(forceProv ? nb.p!==forceProv : !provs.includes(nb.p)) continue;
        if(haversineKm(tLat,tLng,nb.lat,nb.lng)>3) continue; // etichetta sempre vicina al punto reale
        iLat=tLat; iLng=tLng; cc=nb; pp=nb.p; break;
      }
    } else {
      const j = ZONA_JITTER[z] || ZONA_JITTER.misto;
      for(let k=0;k<12;k++){
        const tLat = c.lat + rnd(-j[0],j[0]), tLng = c.lng + rnd(-j[1],j[1]);
        if(!inAcqua(tLat,tLng)){ iLat=tLat; iLng=tLng; break; }
      }
      const nb2 = nearestComune(iLat, iLng); // l'etichetta segue sempre il punto reale
      if(forceProv ? nb2.p===forceProv : provs.includes(nb2.p)){ cc=nb2; pp=nb2.p; }
    }
    const gen = generaPazienti(prio, tipo); // VERITÀ dello scenario (tutti i coinvolti, vedi sopra)
    const pz = gen.salute;
    if(maxi && tipo.pz>0){ const nG = tiraConteggioMaxi(); while(pz.length < nG) pushPaziente(pz, gen.profili, prio, tipo, gen.vds); } // maxiemergenza: 5-15 feriti
    else if(manv && tipo.pz>0){ const nM = tiraNManv(); while(pz.length < nM) pushPaziente(pz, gen.profili, prio, tipo, gen.vds); } // MANV: 5-7 feriti, 5 favorito
    // la centrale NON conosce il totale: solo i noti viaggiano in chiaro, gli altri
    // si scoprono sul posto (i nascosti mai rivelati al chiamante né al giocatore)
    const pre = {pazienti: pz, profili: gen.profili, maxi, manv};
    applicaStimaPazienti(pre, tipo);
    via = viaDaComune(cc.n); // la via segue il comune effettivo (lago/punto fisso)
    let indirizzo;
    if(hwyRef){ indirizzo = hwyRef + " - " + cc.n; } // es. A8 - Busto Arsizio
    else if(ferroRef){ indirizzo = indirizzoFerro(ferroRef, cc.n); } // es. Linea Saronno-Como (Stazione di Saronno) - Saronno
    else if(infraRef){ indirizzo = indirizzoInfra(infraRef, cc.n); } // es. Naviglio Martesana - Cassano d'Adda
    else if(montRef){ indirizzo = indirizzoInfra(montRef, cc.n); } // es. In vetta - Esino Lario
    else if(tipo.qui){
      indirizzo = "Aeroporto di Malpensa"; // punto fisso: l'indirizzo è il sito, coincide per definizione
    } else if(z==="natura" || z==="lago"){
      // bosco/riva: il marker resta sul posto realistico e l'indirizzo cita la via
      // con coordinate più vicina
      const pv = viaPiuVicina(cc.n, iLat, iLng);
      if(pv) via = pv.via;
      indirizzo = via + " - " + cc.n;
    } else {
      // casa/strada in paese: il marker nasce su un punto reale della via
      // (ogni via ha punti ogni ~150m), indirizzo e punto coincidono
      const vc = (D().VIE_COORD||{})[cc.n+"|"+via];
      const qp = (vc && typeof vc[0] !== "number" && vc.length) ? vc[rndi(0,vc.length-1)] : (vc || null);
      if(qp){ iLat = qp[0]+rnd(-0.001,0.001); iLng = qp[1]+rnd(-0.001,0.001); }
      else { iLat = cc.lat+rnd(-0.001,0.001); iLng = cc.lng+rnd(-0.001,0.001); }
      // l'etichetta segue il punto reale: se il jitter ha spostato il marker
      // più vicino a un'altra via in archivio, si cita quella
      const pvf = viaPiuVicina(cc.n, iLat, iLng);
      if(pvf && pvf.d < 0.3) via = pvf.via;
      indirizzo = via;
    }
    const telBozza = "3" + rndi(20,99) + " " + rndi(100,999) + " " + rndi(1000,9999);
    const visto0 = osservazioniScena(tipo, pre.pazienti, z, {ignoti: pre.pazIgnoti, verifica: pre.pazDaVerificare, nascosti: pre.pazientiNascosti.length});
    if(gen.evac>0) visto0.push("c'è gente che sta evacuando il palazzo");
    return {
      tipoNome: tipo.nome, // VERO tipo: resta nascosto, si scopre a fine intervento
      tel: telBozza, ente: enteBozza, visto: visto0,
      maxi: !!maxi, manv: !!manv,
      truePrio: prio,      // VERA priorità (nascosta: il tipo vero si rivela alla chiusura)
      emoji: tipo.emoji,
      dialogo: vest.dialogo, muta: vest.muta,
      lat: iLat, lng: iLng,
      accLa: ferroRef?ferroRef.accLa:iLat, accLng: ferroRef?ferroRef.accLng:iLng, // i mezzi vanno all'accesso, mai sui binari
      indirizzo,
      comune: cc.n, prov: pp,
      vvf: !!tipo.vvf, // VVF: senza gravità, mezzi a scelta libera dell'operatore
      richiesti: { ...tipo.mezzi },
      durata: rndi(tipo.durata[0], tipo.durata[1]),
      trasporto: tipo.trasporto,
      desc: tipo.desc,
      t0: clockMin,
      pazienti: pre.pazienti, profili: pre.profili,
      pazientiNascosti: pre.pazientiNascosti, profiliNascosti: pre.profiliNascosti,
      pazIgnoti: pre.pazIgnoti, pazDaVerificare: pre.pazDaVerificare,
      illesi: gen.illesi, evac: gen.evac, variante: gen.variante,
    };
  }
 function creaBozza(forceProv=null, forceTipoNome=null){
   // la bozza accettata entra nella memoria anti-ripetizione (anche forzati/maxi/maltempo)
   let b = creaBozzaUna(forceProv, forceTipoNome);
   // tipo forzato (danno mirato): si rigenera solo il dialogo, il tipo resta quello
   for(let k=0; k<8 && chiamataRipetuta(b, !forceTipoNome); k++) b = creaBozzaUna(forceProv, forceTipoNome);
   // validazione PRIMA di mostrare al giocatore: correzioni deterministiche,
   // oppure rigenerazione se il tipo non esiste piu (mai correzioni casuali)
   for(let k=0;k<4;k++){
     const v = validaBozza(b);
     if(v.ok){ if(v.correzioni.length) console.warn("[COEU] bozza corretta ("+b.tipoNome+"): "+v.correzioni.join(", ")); break; }
     b = creaBozzaUna(forceProv, forceTipoNome);
   }
   iaMiglioraBozza(b);
   notaTipo(b.tipoNome);
   return b;
 }
 // NOTE: hook reale sotto in creaBozza (iaMiglioraBozza) — vedi sotto
 // ---------- LIVELLO 3 IA (consultivo): l'IA propone, il motore dispone ----------
  // Mai stato toccato dall'IA: solo testi (dialogo/visto/radio) + micro-evoluzioni
  // cliniche validate. Tutto passa da validaBozza/validaProposta, fallback ai testi base.
  function iaRadio(kind, slot, fallback){
    try{
      const IA = window.COEUIA;
      if(!IA || IA.modo()==="off") return fallback;
      return IA.fraseRadio(kind, slot||{}, fallback) || fallback;
    }catch(_){ return fallback; }
  }
  function iaMiglioraBozza(b){
    // cornice naturale vincolata ai fatti, DOPO validaBozza (i fatti restano quelli validati)
    try{
      const IA = window.COEUIA;
      if(!IA || IA.modo()==="off") return;
      const r = IA.miglioraBozzaLocal(b);
      if(!r || !r.dialogo) return;
      // il nucleo originale deve restare citato (lo garantisce il validatore IA),
      // la memoria anti-ripetizione resta sui tipi, i dialoghi arricchiti variano da soli
      b.dialogo = r.dialogo;
      if(r.vistoExtra && r.vistoExtra.length) b.visto = (b.visto||[]).concat(r.vistoExtra);
    }catch(_){ /* fallback: testi originali */ }
  }
  function iaArricchisciRemoto(call){
    // miglioramento progressivo DOPO la pubblicazione (remoto/plugin): aggiorna solo i testi
    try{
      const IA = window.COEUIA;
      if(!IA || IA.modo()!=="remoto" || !call) return;
      const p = (IA.arricchisciRemoto(call) || Promise.resolve(null));
      Promise.resolve(p).then(async (prop)=>{
        if(!prop){ try{ const q = await IA.arricchisciPlugin(call); if(q) prop = q; }catch(_){} }
        if(!prop || !prop.dialogo) return;
        const qc = chiamate.find(c=>c.callId===call.callId);
        if(!qc) return; // chiamata già gestita: niente modifiche tardive
        qc.dialogo = prop.dialogo;
        if(prop.vistoExtra && prop.vistoExtra.length) qc.visto = (qc.visto||[]).concat(prop.vistoExtra);
        renderCalls();
      }).catch(()=>{});
    }catch(_){}
  }
  function iaComplicazione(iv){
    // micro-peggioramento clinico credibile (max 1/missione, solo con scena valutata)
    try{
      const IA = window.COEUIA;
      if(!IA || IA.modo()==="off" || !iv || iv._iaCompl) return;
      const prop = IA.complicazioneLocal(iv);
      if(!prop) return;
      const v = IA.validaProposta(prop, {tipoNome:iv.tipoNome, nPaz:(iv.pazienti||[]).length, salute:(iv.pazienti||[]).map(Math.round)});
      if(!v.ok) return;
      iv.pazienti[prop.pazIdx] = Math.max(3, Math.round(iv.pazienti[prop.pazIdx])+prop.deltaSalute);
      // riallinea il profilo al nuovo stato (coscienza/quadro restano, salute guida tutto)
      log(`🩺 <b>${iv.comune}</b>: ${prop.messaggio} (P${prop.pazIdx+1} al ${Math.round(iv.pazienti[prop.pazIdx])}%)`, "alarm");
      renderListe();
    }catch(_){}
  }
  // geocodifica inversa del punto cliccato (tasto destro): l'indirizzo diventa quello
  // vero della mappa (via reale da OpenStreetMap); in attesa di risposta, o
  // senza strada vicina, resta l'indirizzo provvisorio (via più vicina in archivio)
  async function precisaIndirizzoClick(call){
    try{
      const url = "https://nominatim.openstreetmap.org/reverse?format=json&zoom=18&addressdetails=1&lat=" + call.lat + "&lon=" + call.lng;
      const r = await (await fetch(url, { headers: { Accept: "application/json" } })).json();
      const ad = r && r.address;
      const road = ad && (ad.road || ad.pedestrian || ad.footway || ad.cycleway || ad.path || ad.square);
      if(!road) return;
      const t = (D().TIPI.find(x=>x.nome===call.tipoNome) || {});
      const z = t.zona || "misto";
      let nuovo = null;
      if(t.qui) nuovo = "Aeroporto di Malpensa";
      else if(z==="natura" || z==="lago")
        nuovo = road + " - " + call.comune;
      else nuovo = road;
      if(!nuovo || nuovo === call.indirizzo) return;
      call.indirizzo = nuovo;
      const qc = chiamate.find(c=>c.callId===call.callId);
      if(qc) qc.indirizzo = nuovo;
      const iv = interventi.find(i=>i.callId===call.callId);
      if(iv) iv.indirizzo = nuovo;
      refreshCallMarkers(); renderCalls();
      if(iv){ refreshMarkers(); renderListe(); }
    }catch(_){}
  }
  // chiamata creata dal tasto destro sulla mappa: coordinate esatte, comune più vicino per il nome
  function creaChiamataQui(lat, lng){
    if (chiamate.length >= 3){ toast("C'è già una coda di chiamate: accettane prima una"); return null; }
    if (inAcqua(lat, lng)){ toast("Lì c'è il lago: scegli un punto a terra"); return null; }
    let best = D().COMUNI[0], bd = 1e9;
    for(const c of D().COMUNI){ const d = haversineKm(lat, lng, c.lat, c.lng); if(d<bd){ bd=d; best=c; } }
    const tp = tipoRandom();
    let tipo = tp.tipo, prioQui = tp.prio, maxiQui = false, manvQui = false;
    const evQui = tiraEventoGrande();
    if(evQui && !tipiAperti().has(evQui.tipo.nome) && !tipoBandito(evQui.tipo.nome)){ tipo = evQui.tipo; prioQui = 1; maxiQui = !!evQui.maxi; manvQui = !!evQui.manv; }
    notaTipo(tipo.nome);
    const ente2 = tipo.vvf ? "115" : (Math.random()<0.5 ? "112" : "113");
    const vest2 = vesteChiamata(tipo, ente2);
    const z2 = tipo.zona || "misto";
    let via = viaDaComune(best.n);
    let ind2;
    let accLa2 = lat, accLng2 = lng;
    if(z2==="ferro"){
      // missioni ferroviarie dal click: snap al binario più vicino (entro 1,5 km),
      // altrimenti punto ferroviario casuale (sui binari veri, mai a caso nel paese)
      const F0 = (typeof FERROVIE!=="undefined") ? FERROVIE : null;
      let fp = null;
      if(F0){
        let bd0 = 1.5;
        for(const l of (F0.LINEE||[])){ if(l.d) continue; for(const s of (l.s||[])){ for(const q of s){ const d = haversineKm(lat, lng, q[0], q[1]); if(d<bd0){ bd0=d; fp = {lat:q[0], lng:q[1], linea:l.n||"", luogo:"", modo:"libero"}; } } } }
      }
      if(!fp){ const fp0 = puntoSuFerrovia(tipo.nome); if(fp0) fp = fp0; }
      if(fp){
        lat = fp.lat; lng = fp.lng;
        let bdC = 1e9;
        for(const c of D().COMUNI){ const d = haversineKm(lat, lng, c.lat, c.lng); if(d<bdC){ bdC=d; best=c; } }
        const acc0 = accessoFerro(lat, lng);
        accLa2 = acc0[0]; accLng2 = acc0[1];
        ind2 = indirizzoFerro({linea:fp.linea||"", luogo:fp.luogo||"", modo:fp.modo||"libero"}, best.n);
      }
    }
    if(ind2){ /* gia indirizzo ferroviario */ }
    else if(z2==="infra" && tipo.infra){
      // missioni infrastrutturali dal click: snap alla rete vera più vicina (entro 1,5 km),
      // altrimenti punto casuale sulla rete vera (mai a caso nel paese)
      let ip = puntoSuInfraVicino(lat, lng, tipo.infra, 1.5);
      if(!ip) ip = puntoSuInfra(tipo.infra);
      if(ip){
        lat = ip.lat; lng = ip.lng;
        let bdC = 1e9;
        for(const c of D().COMUNI){ const d = haversineKm(lat, lng, c.lat, c.lng); if(d<bdC){ bdC=d; best=c; } }
        ind2 = indirizzoInfra(ip, best.n);
      }
    }
    if(ind2){ /* gia indirizzo ferroviario o infrastrutturale */ }
    else if(tipo.qui){
      ind2 = "Aeroporto di Malpensa";
    } else if(z2==="natura" || z2==="lago"){
      const pv2 = viaPiuVicina(best.n, lat, lng);
      if(pv2) via = pv2.via;
      ind2 = via + " - " + best.n;
    } else {
      const pv2b = viaPiuVicina(best.n, lat, lng);
      if(pv2b) via = pv2b.via;
      ind2 = via;
    }
    const pz2 = generaPazienti(prioQui, tipo); // VERITÀ dello scenario (tutti i coinvolti)
    if(maxiQui && tipo.pz>0){ const nG2 = tiraConteggioMaxi(); while(pz2.salute.length < nG2) pushPaziente(pz2.salute, pz2.profili, prioQui, tipo, pz2.vds); }
    else if(manvQui && tipo.pz>0){ const nM2 = tiraNManv(); while(pz2.salute.length < nM2) pushPaziente(pz2.salute, pz2.profili, prioQui, tipo, pz2.vds); }
    const pre2 = {pazienti: pz2.salute, profili: pz2.profili, maxi: maxiQui, manv: manvQui};
    applicaStimaPazienti(pre2, tipo); // la centrale conosce solo i noti
    const visto2 = osservazioniScena(tipo, pre2.pazienti, z2, {ignoti: pre2.pazIgnoti, verifica: pre2.pazDaVerificare, nascosti: pre2.pazientiNascosti.length});
    if(pz2.evac>0) visto2.push("c'è gente che sta evacuando il palazzo");
    const b = {
      tipoNome: tipo.nome, truePrio: prioQui, maxi: maxiQui, manv: manvQui, emoji: tipo.emoji,
      tel: "3" + rndi(20,99) + " " + rndi(100,999) + " " + rndi(1000,9999),
      ente: ente2,
      visto: visto2,
      dialogo: vest2.dialogo, muta: vest2.muta,
      lat, lng, indirizzo: ind2, viaClick: via,
      accLa: accLa2, accLng: accLng2,
      comune: best.n, prov: best.p, vvf: !!tipo.vvf,
      richiesti: { ...tipo.mezzi }, durata: rndi(tipo.durata[0], tipo.durata[1]),
      trasporto: tipo.trasporto, desc: tipo.desc, t0: clockMin, pazienti: pre2.pazienti,
      profili: pre2.profili, pazientiNascosti: pre2.pazientiNascosti, profiliNascosti: pre2.profiliNascosti,
      pazIgnoti: pre2.pazIgnoti, pazDaVerificare: pre2.pazDaVerificare,
      illesi: pz2.illesi, evac: pz2.evac, variante: pz2.variante,
    };
    // click destro: il punto resta quello scelto, ma se il dialogo ricalca una chiamata
    // recente si rigenerano parole e dettagli (mai duplicati: nulla di pubblicato)
    for(let k=0; k<8 && dialogoRipetuto(b.dialogo); k++){
      const vv2 = vesteChiamata(tipo, ente2);
      b.dialogo = vv2.dialogo; b.muta = vv2.muta;
      const vs2 = osservazioniScena(tipo, pre2.pazienti, z2, {ignoti: pre2.pazIgnoti, verifica: pre2.pazDaVerificare, nascosti: pre2.pazientiNascosti.length});
      if(pz2.evac>0) vs2.push("c'è gente che sta evacuando il palazzo");
      b.visto = vs2;
    }
    { iaMiglioraBozza(b); const _vb = validaBozza(b); if(_vb.correzioni.length) console.warn("[COEU] bozza click corretta ("+b.tipoNome+"): "+_vb.correzioni.join(", ")); }
    const call = { ...b, callId: callCounter++ };
    chiamate.unshift(call);
    statCall(call); // statistiche: diario chiamata pubblicata
    notaChiamata(call);
    iaArricchisciRemoto(call);
    // maxiemergenze e MANV arrivano in silenzio: niente annunci nel radio, li scopri rispondendo
    if(!(b.maxi||b.manv)) log(`🔔 Chiamata in arrivo da <b>${b.comune}</b> (${b.prov}) — rispondi per i dettagli`, "alarm");
    if(tipo.zona!=="ferro" && tipo.zona!=="infra") precisaIndirizzoClick(call); // indirizzo reale del punto cliccato (via geocodifica inversa; ferroviarie e infrastrutturali restano sulla rete)
    blip(); if(!(b.maxi||b.manv)) toast("🔔 Nuova chiamata in arrivo!");
    refreshCallMarkers(); renderCalls(); updateStats();
    return call;
  }

  // debug: campiona bozze per verificare le zone (tipo, zona, distanza km dal comune)
  function debugZone(n){
    const out = [];
    for(let i=0;i<(n||200);i++){
      const b = creaBozza();
      const t = D().TIPI.find(x=>x.nome===b.tipoNome) || {};
      const cx = D().COMUNI.find(x=>x.n===b.comune);
      out.push({t:b.tipoNome, z:t.zona||"misto", vvf:!!t.vvf, d:cx?Math.round(haversineKm(b.lat,b.lng,cx.lat,cx.lng)*100)/100:-1, c:b.comune, lat:Math.round(b.lat*10000)/10000, lng:Math.round(b.lng*10000)/10000});
    }
    return out;
  }
  // --- NUOVA CHIAMATA in arrivo (una a una): da accettare manualmente ---
  // force = generazione manuale (tasti 📞/Extra): senza tetto di coda, missioni infinite
  function makeChiamata(forceProv=null, force=false){
    if(chiamate.length>=3 && !force){ toast("C'è già una coda di chiamate: accettane prima una"); return null; }
    const b = creaBozza(forceProv);
    const call = { ...b, callId: callCounter++ };
    chiamate.unshift(call);
    statCall(call); // statistiche: diario chiamata pubblicata
    notaChiamata(call);
    iaArricchisciRemoto(call);
    // maxiemergenze e MANV arrivano in silenzio: niente annunci nel radio, li scopri rispondendo
    if(!(b.maxi||b.manv)) log(`🔔 Chiamata in arrivo da <b>${b.comune}</b> (${b.prov}) — rispondi per i dettagli`, "alarm");
    blip();
    if(!(b.maxi||b.manv)) toast("🔔 Nuova chiamata in arrivo!");
    refreshCallMarkers();
    renderCalls();
    updateStats();
    return call;
  }
  function nuovaChiamata(prov=null){ return makeChiamata(prov, true); }

  // --- MALTEMPO CHE PICCHIA: durante temporale/pioggia/vento i danni arrivano davvero, in diretta ---
  const STORM_TIPI = {
    Temporale:["Albero in carreggiata","Albero su auto occupata","Albero su auto vuota","Albero pericolante","Albero caduto sulla strada","Albero sui cavi","Albero sul tetto","Sottopasso allagato con auto","Sottopasso allagato","Garage interrato allagato","Garage allagato","Allagamento cantina","Roggia esondata","Roggia straripata","Esondazione torrente","Esondazione dell'argine","Colpito da fulmine","Fulmine vicino agli escursionisti","Albero incendiato da fulmine","Feriti dalla grandine","Grandine in alta quota","Albero su tenda con occupanti","Sottopasso ferroviario allagato","Albero su pista ciclabile","Tenda allagata al campeggio","Tromba d'aria","Traliccio caduto su auto","Traliccio alta tensione caduto","Cavi elettrici caduti","Cavi penzolanti sulla strada","Tenda da sole divelta","Antenna caduta sul tetto","Grondaia crollata in strada","Auto travolta da frana","Frana","Pensilina distributore pericolante","Albero caduto sul sentiero"],
    Pioggia:["Sottopasso allagato con auto","Garage interrato allagato","Roggia esondata","Sottopasso ferroviario allagato","Cabina elettrica allagata","Canile allagato","Sede canottieri allagata","Auto travolta da frana","Ciclista caduto in sottopasso allagato","Lago esondato"],
    Vento:["Albero in carreggiata","Albero su auto vuota","Albero su auto occupata","Albero pericolante","Albero caduto sulla strada","Albero caduto sul sentiero","Albero sul tetto","Albero sui cavi","Siepe divelta dal vento","Antenna caduta sul tetto","Tenda da sole divelta","Ponteggio nel vento","Ponteggio crollato in strada","Ponteggio crollato su auto","Gonfiabile volato via col vento","Alveare caduto dal tetto","Sup trascinato dal vento","Albero su pista ciclabile","Albero su panchina al parco","Tromba d'aria","Traliccio pericolante","Traliccio caduto su auto","Traliccio alta tensione caduto","Cavi elettrici caduti","Grondaia crollata in strada","Grondaia caduta addosso","Pensilina distributore pericolante","Pensilina autogrill pericolante","Pensilina crollata"]
  };
  // danni tipici di temporale e vento forte: pescano con peso triplo rispetto agli altri della lista
  const STORM_TIPICI = {
    Temporale:new Set(["Albero in carreggiata","Albero su auto occupata","Albero su auto vuota","Albero caduto sulla strada","Albero sui cavi","Albero sul tetto","Colpito da fulmine","Fulmine vicino agli escursionisti","Albero incendiato da fulmine","Feriti dalla grandine","Grandine in alta quota","Sottopasso allagato con auto","Sottopasso allagato","Garage interrato allagato","Garage allagato","Roggia esondata","Roggia straripata","Tromba d'aria","Sottopasso ferroviario allagato"]),
    Vento:new Set(["Albero in carreggiata","Albero su auto vuota","Albero su auto occupata","Albero caduto sulla strada","Albero pericolante","Albero sul tetto","Albero sui cavi","Antenna caduta sul tetto","Tenda da sole divelta","Ponteggio nel vento","Ponteggio crollato in strada","Tromba d'aria","Traliccio pericolante","Traliccio caduto su auto","Siepe divelta dal vento","Gonfiabile volato via col vento","Grondaia crollata in strada"])
  };
  function stormPeso(nome, cond){ const s = STORM_TIPICI[cond]; return (s && s.has(nome)) ? 3 : 1; }
  const STORM_EVERY = { Temporale:4, Pioggia:12, "Pioggia intensa":6, Vento:5 }; // temporale e vento forte picchiano duro e spesso // game-min tra un danno e l'altro
  let stormTimer = 0;
  function makeChiamataTipo(nome){
    if(chiamate.length>=3) return null;
    // danno da maltempo mai uguale a uno già aperto o appena uscito: se il nome è occupato se ne usa un altro della stessa lista
    if(tipiAperti().has(nome) || tipoBandito(nome)){
      const alt = (STORM_TIPI[meteo.cond]||[]).filter(n=>n!==nome && D().TIPI.some(x=>x.nome===n) && !tipiAperti().has(n) && !tipoBandito(n));
      if(alt.length) nome = alt[rndi(0,alt.length-1)];
    }
    const b = creaBozza(null, nome);
    const call = { ...b, callId: callCounter++ };
    chiamate.unshift(call);
    statCall(call); // statistiche: diario chiamata pubblicata
    notaChiamata(call);
    iaArricchisciRemoto(call);
    const emo = {Temporale:"⛈️",Pioggia:"🌦️","Pioggia intensa":"🌧️",Vento:"💨"}[meteo.cond]||"🔔";
    log(`${emo} Danno da maltempo a <b>${b.comune}</b> (${b.prov}) — rispondi per i dettagli`, "alarm");
    blip(); toast(`${emo} Danno da maltempo in arrivo!`);
    refreshCallMarkers(); renderCalls(); updateStats();
   return call;
 }

 function stormTick(dtGameMin){
 
    const lista = STORM_TIPI[meteo.cond] || (meteo.cond==="Pioggia intensa" ? STORM_TIPI.Pioggia : null); // l’intensa fa gli stessi danni della pioggia
    if(!lista){ stormTimer = 0; return; }
    stormTimer += dtGameMin;
    if(stormTimer < STORM_EVERY[meteo.cond]+rnd(0,4)) return;
    stormTimer = 0;
    if(chiamate.length>=3) return; // coda piena: salta questo giro
    // preferisce un danno non già aperto (tutti uguali solo se la lista è esaurita);
    // i danni tipici della condizione in corso pescano con peso triplo (stormPeso)
    makeChiamataTipo(pescaStorm(lista, meteo.cond));
  }
  function pescaStorm(lista, cond){
    const liberi = lista.filter(n=>D().TIPI.some(x=>x.nome===n) && !tipiAperti().has(n));
    const pool = liberi.length ? liberi : lista.filter(n=>D().TIPI.some(x=>x.nome===n));
    let totW = 0;
    for(const n of pool) totW += stormPeso(n, cond);
    let rr = Math.random()*totW;
    for(const n of pool){ rr -= stormPeso(n, cond); if(rr<=0) return n; }
    return pool[pool.length-1];
  }

  // --- CLASSIFICA: scegli il codice colore -> diventa intervento attivo ---
  // R = rosso(P1), G = giallo(P2), V = verde(P3), B = bianco(P4)
  const COLORI = { R:{prio:1, nome:"ROSSO", col:"#d00000"}, G:{prio:2, nome:"GIALLO", col:"#e6a100"}, V:{prio:3, nome:"VERDE", col:"#35a835"}, B:{prio:4, nome:"BIANCO", col:"#888888"} };
  function accettaChiamata(callId, colore, mezziCodici){
    const idx = chiamate.findIndex(c=>c.callId===callId);
    if (idx<0) return false;
    const call = chiamate.splice(idx,1)[0];
    const isVVF = !!call.vvf || colore==="VVF"; // resta missione VVF anche con codice colore scelto
    const col = COLORI[colore] || COLORI.G;
    const iv = {
      id: idCounter++,
      callId: call.callId, // per aggiornare l'indirizzo se arriva la geocodifica inversa del click
      tipoNome: call.tipoNome, // vero tipo: nascosto fino a chiusura
      truePrio: call.truePrio,
      prio: COLORI[colore] ? COLORI[colore].prio : 0, // VVF: codice scelto, oppure 0 = senza codice
      vvf: isVVF,
      lat: call.lat, lng: call.lng,
      accLa: call.accLa!=null?call.accLa:call.lat, accLng: call.accLng!=null?call.accLng:call.lng,
      zona: (D().TIPI.find(x=>x.nome===call.tipoNome)||{}).zona||"misto",
      indirizzo: call.indirizzo, comune: call.comune, prov: call.prov,
      stato: "attesa",
      mezziIds: [],
      richiesti: call.richiesti,
      durata: call.durata,
      tempoSulPosto: 0,
      trasporto: call.trasporto,
      daTrasportare: call.trasporto ? (call.pazienti||[]).filter(x=>x!=null).length : 0, // 1 viaggio ambulanza = 1 paziente
      // il trasporto parte solo a pazienti stabilizzati al 100% (vedi cura sul posto nel tick)
      stabilizzato: !(call.trasporto && (call.pazienti||[]).some(s=>s!=null && s<100)),
      dialogo: call.dialogo, muta: !!call.muta, visto: call.visto||[],
      profili: (call.profili||[]).map(p=>({...p})), illesi: call.illesi||0, evac: call.evac||0, variante: call.variante||"media",
      t0: clockMin, attesa: 0,
      pazienti: (call.pazienti||[]).filter(x=>x!=null),
      pazientiNascosti: (call.pazientiNascosti||[]).filter(x=>x!=null),
      profiliNascosti: (call.profiliNascosti||[]).map(p=>({...p})),
      pazIgnoti: !!call.pazIgnoti, pazDaVerificare: !!call.pazDaVerificare, scopTra: null,
      emoji: call.emoji, desc: call.desc,
      ospedale: null,
      pazDest: {}, // idx paziente -> nome ospedale scelto
      pazConsegnati: {}, // idx paziente -> true (handover fatto in PS)
      supporti: null, // richieste/arrivi per gruppo (MSA/VVF/ALTRO): init in initSupporti
      fuoco: fuocoInit(call.tipoNome, call.desc), // evoluzione dinamica del rogo (null se non c'e un fuoco attivo)
    };
    iv.pazIds = (iv.pazienti||[]).map((_,k)=>"M"+iv.id+"-P"+(k+1)); // identificativo univoco per paziente, stabile per tutta la missione
    iv.pazS = {}; iv.affidi = {}; iv.liberati = {}; iv.avvisi = {}; iv.libTimer = 0; iv.noVVFTimer = 0;
    // classifica con il colore scelto (niente punti: il codice serve solo a gestire l'intervento)
    // VVF: nessun codice, nessun conteggio nei codici classificati
    if(iv.prio>0) contaColori[iv.prio]=(contaColori[iv.prio]||0)+1;
    interventi.unshift(iv);
    selectedId = iv.id;
    initSupporti(iv); // richieste iniziali del tipo, per missione
    let inviati = 0; const nomiInv = [];
    for(const cod of (mezziCodici||[])){ const _m0 = mezzi.find(m=>m.codice===cod); if(assegnaMezzo(cod, iv.id, true)){ inviati++; if(_m0){ const _n0 = nomem(_m0); if(nomiInv.indexOf(_n0)<0) nomiInv.push(_n0); } } }
    highlightCall = null;
    // un solo messaggio di invio per missione (la centrale assegna) + un solo ricevuto
    // (il primo mezzo conferma); gli altri partono in silenzio, i loro arrivi non sono radio
    if(isVVF) log(`🚒 VVF${iv.prio>0 ? " — "+col.nome : ""} a <b>${iv.comune}</b> (${iv.prov})${nomiInv.length?" — escono: "+nomiInv.join(", "):" — nessun mezzo libero, in attesa"}`, "status");
    else log(`📞 <b>${col.nome}</b> a <b>${iv.comune}</b> (${iv.prov})${nomiInv.length?" — inviate: "+nomiInv.join(", "):" — nessun mezzo libero, in attesa"}`);
    if(nomiInv.length) log(`📻 ${nomiInv[0]}: ricevuto, andiamo a <b>${iv.comune}</b>`, "status");
    refreshCallMarkers();
    refreshMarkers();
    renderCalls();
    renderListe();
    updateStats();
    statAccetta(call, iv); // statistiche: avvio missione
    return true;
  }
  function COLORI_NOME(p){ return p===1?"ROSSO":p===2?"GIALLO":p===3?"VERDE":"BIANCO"; }

  function rifiutaChiamata(callId){
    const idx = chiamate.findIndex(c=>c.callId===callId);
    if (idx<0) return;
    const call = chiamate.splice(idx,1)[0];
    statEsito(call.callId, "rifiutata"); // statistiche: chiamata annullata
    log(`☎️ Chiamata da ${call.comune} (${call.prov}) annullata — falso allarme`);
    refreshCallMarkers();
    renderCalls();
    updateStats();
  }

  // checklist mezzi nella chiamata: i più vicini (118 + VVF), da inviare insieme al codice
  function callMzHTML(call){
    const sel = call.incaricoMz||[];
    const ck = c => sel.includes(c) ? " checked" : "";
    const d118 = mezzi.filter(m=>m.stato==="disponibile"&&m.corpo!=="VVF")
      .map(mz=>({mz, d:haversineKm(call.lat,call.lng,mz.lat,mz.lng)}))
      .sort((a,b)=>a.d-b.d).slice(0,8);
    const dVVF = mezzi.filter(m=>m.stato==="disponibile"&&m.corpo==="VVF")
      .map(mz=>({mz, d:haversineKm(call.lat,call.lng,mz.lat,mz.lng)}))
      .sort((a,b)=>a.d-b.d).slice(0,6);
    let h = '<div class="small" style="margin:4px 0">Spunta i mezzi da inviare (i più vicini):</div><div class="callMz">';
    for(const e of d118)
      h += '<label title="' + e.mz.codice + " — " + e.mz.tipo + " — " + e.mz.sede + '"><input type="checkbox" value="' + e.mz.codice + '"' + ck(e.mz.codice) + '> ' + mzNomeHTML(e.mz, e.mz.codice) + ' (' + e.mz.tipo + ") — " + e.d.toFixed(1) + " km</label>";
    if(!d118.length) h += '<div class="small">Nessun mezzo 118 libero.</div>';
    // impegnati ma dirottabili SUBITO: anche chi sta rientrando riparte da dove si trova
    const stTx = s=>s==="viaggio"?"in viaggio":s==="rientro"?"in rientro":"sul posto";
    const busyCall = (corpo)=> mezzi.filter(m=>(m.stato==="viaggio"||m.stato==="rientro"||m.stato==="sul_posto")&&m.corpo===corpo)
      .map(mz=>({mz, d:haversineKm(call.lat,call.lng,mz.lat,mz.lng)}))
      .sort((a,b)=>a.d-b.d);
    const b118 = busyCall("118").slice(0,6);
    if(b118.length){
      h += '<div class="small" style="margin:4px 0">↩️ Impegnati — spunta per dirottarli subito (ripartono da dove sono):</div>';
      for(const e of b118){
        const m = e.mz;
        h += '<label title="' + m.codice + " — " + stTx(m.stato) + '"><input type="checkbox" value="' + m.codice + '"' + ck(m.codice) + '> ' + mzNomeHTML(m, m.codice) + " (" + m.tipo + ") 🟠 " + stTx(m.stato) + " — " + e.d.toFixed(1) + " km</label>";
      }
    }
    h += "</div>";
    // VVF sotto pulsante apribile (stessa classe callMz: le spunte valgono come prima)
    const bVVF = busyCall("VVF").slice(0,4);
    h += '<details class="vvfSec"><summary>🚒 Vigili del Fuoco <span class="small">— i più vicini + impegnati</span></summary><div class="callMz">';
    for(const e of dVVF)
      h += '<label title="' + (e.mz.radio||e.mz.codice) + " — " + e.mz.tipo + " — " + e.mz.sede + '"><input type="checkbox" value="' + e.mz.codice + '"' + ck(e.mz.codice) + '> 🚒 ' + mzNomeHTML(e.mz) + ' (' + e.mz.tipo + ") — " + e.d.toFixed(1) + " km</label>";
    if(bVVF.length){
      h += '<div class="small" style="margin:4px 0">↩️ Impegnati — spunta per dirottarli subito (ripartono da dove sono):</div>';
      for(const e of bVVF){
        const m = e.mz;
        h += '<label title="' + m.codice + " — " + stTx(m.stato) + '"><input type="checkbox" value="' + m.codice + '"' + ck(m.codice) + '> 🚒 <b>' + (m.radio||m.codice) + "</b> (" + m.tipo + ") 🟠 " + stTx(m.stato) + " — " + e.d.toFixed(1) + " km</label>";
      }
    }
    if(!dVVF.length && !bVVF.length) h += '<div class="small">Nessun mezzo VVF libero.</div>';
    h += "</div></details>";
    return h;
  }
  function renderCalls(){
    const box = $("callQueue");
    if (box){
      box.innerHTML = "";
      if (chiamate.length!==0){
        const frag = document.createDocumentFragment();
        for(const call of chiamate){
          const div = document.createElement("div");
          div.className = "callCard" + (call.callId===highlightCall ? " flash" : "");
          div.id = "call-" + call.callId;
         if (!call.answered){
            // squilla stile LSTSim: ora + "Nuova telefonata." + Rispondi (il motivo NON si vede)
            div.innerHTML = `
              <div class="callLST"><span class="callTime">${hhmmss(call.t0)}</span><span class="callText">Nuova telefonata.</span><button class="lstBtn small primary" data-act="ans">Rispondi</button><button class="lstBtn small" data-act="map" title="Mostra su mappa">🗺️</button><button class="lstBtn small" data-act="ref" title="Rifiuta">✖</button></div>`;
            div.querySelector('[data-act="ans"]').onclick = ()=>{ call.answered = true; call.tAns = statClock; if(!(call.maxi||call.manv)) log(call.vvf ? `☎️ In linea con ${call.comune} (${call.prov}) — intervento VVF, prendi in carico` : `☎️ In linea con ${call.comune} (${call.prov}) — ascolta e classifica`); renderCalls(); }; // tAns = orario risposta (statistiche)
            div.querySelector('[data-act="map"]').onclick = ()=>{ highlightCall = call.callId; if(map) map.panTo([call.lat,call.lng]); renderCalls(); };
            div.querySelector('[data-act="ref"]').onclick = ()=>rifiutaChiamata(call.callId);
          } else {
           // il richiedente parla: incarico in finestra separata (mezzi + codice)
   div.innerHTML = `
             <div class="intTop"><b>☎️ In linea</b><span class="cod">${hhmm(call.t0)}</span></div>
             <div class="intAddr">📍 ${luogoIV(call,true)}</div>
             <div class="dialogo">${call.dialogo}</div>
             ${call.incarico
               ? '<div class="callBtns"><button class="lstBtn small primary" data-act="open">📋 Continua incarico</button></div>'
               : '<div class="callBtns"><button class="lstBtn small primary" data-act="open">📋 Crea nuovo incarico</button></div>'}
   `;
           div.querySelectorAll("[data-act]").forEach(b=>{
             b.onclick = ()=>{ openIncarico(call.callId); };
           });
           const refRow = document.createElement("div");
            refRow.className = "callBtns";
            refRow.innerHTML = '<button class="lstBtn small">✖ Rifiuta (falso allarme)</button>';
            refRow.querySelector("button").onclick = ()=>rifiutaChiamata(call.callId);
            div.appendChild(refRow);
          }
          frag.appendChild(div);
        }
        box.innerHTML = "";
        box.appendChild(frag);
        if (highlightCall){
          const el = box.querySelector("#call-"+highlightCall);
          if (el) el.scrollIntoView({block:"nearest"});
        }
      }
    }
    if ($("callCount")) $("callCount").textContent = chiamate.length;
    renderIncarico();
  }

  // incarico in finestra separata (stile LSTSim): mezzi + codice, poi crea e si chiude
  let incaricoCallId = null;
  function openIncarico(callId){
    const call = chiamate.find(c=>c.callId===callId);
    if(!call) return;
    call.incarico = true;
    if(!call.incaricoMz) call.incaricoMz = [];
    incaricoCallId = callId;
    renderCalls();
  }
  function closeIncarico(collapse){
    const call = chiamate.find(c=>c.callId===incaricoCallId);
    if(collapse && call) call.incarico = false;
    incaricoCallId = null;
    const ov = document.querySelector("#incaricoOverlay");
    if(ov) ov.style.display = "none";
    renderCalls();
  }
  function renderIncarico(){
    const ov = document.querySelector("#incaricoOverlay");
    const body = document.querySelector("#incaricoBody");
    if(!ov || !body) return;
    const head = document.querySelector("#incaricoHead");
    const win = document.querySelector("#incaricoWin");
    if(head && win && !head._drag){
      head._drag = true;
      head.onmousedown = e=>{
        if(e.target.tagName==="BUTTON") return;
        e.preventDefault();
        const r = win.getBoundingClientRect();
        const ox = e.clientX - r.left, oy = e.clientY - r.top;
        win.style.position = "fixed"; win.style.margin = "0";
        win.style.left = r.left + "px"; win.style.top = r.top + "px";
        const mv = ev=>{ win.style.left = (ev.clientX - ox) + "px"; win.style.top = (ev.clientY - oy) + "px"; };
        const up = ()=>{ document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); };
        document.addEventListener("mousemove", mv);
        document.addEventListener("mouseup", up);
      };
    }
    const x = document.querySelector("#incaricoX");
    if(x) x.onclick = ()=>closeIncarico(true);
    const call = chiamate.find(xc=>xc.callId===incaricoCallId);
    if(!call || !call.incarico){ ov.style.display = "none"; return; }
    if(call.vvf && !call.codSel) call.codSel = "VVF"; // default VVF: senza codice
    const cs = call.codSel;
    const codeBtn = (cc,label,col)=>'<button class="lstBtn small' + (cs===cc?" primary":"") + '" data-c="' + cc + '" style="border-left:6px solid ' + col + '">' + label + "</button>";
    const effCod = call.vvf ? call.codSel : cs;
    body.innerHTML = `
      <div class="intTop"><b>📋 Nuovo incarico</b></div>
      <div class="intAddr">📍 ${luogoIV(call,true)}</div>
      <div class="dialogo">${call.dialogo}</div>
      ${callMzHTML(call)}
      ${call.vvf
        ? '<div class="small" style="margin:4px 0">🚒 Vigili del Fuoco — codice (oppure senza):</div><div class="colorBtns">' + codeBtn("R","🔴 Rosso","#d00000") + " " + codeBtn("G","🟡 Giallo","#e6a100") + " " + codeBtn("V","🟢 Verde","#35a835") + " " + codeBtn("B","⚪ Bianco","#888") + " " + codeBtn("VVF","🚒 Senza codice","#666") + "</div>"
        : '<div class="small" style="margin:4px 0">Codice:</div><div class="colorBtns">' + codeBtn("R","🔴 Rosso","#d00000") + " " + codeBtn("G","🟡 Giallo","#e6a100") + " " + codeBtn("V","🟢 Verde","#35a835") + " " + codeBtn("B","⚪ Bianco","#888") + "</div>"}
      <div class="callBtns"><button class="lstBtn small primary" data-act="create">${effCod==="VVF" ? "🚒 Crea intervento" : "✅ Crea intervento"}</button><button class="lstBtn small" data-act="close">✖ Chiudi</button></div>`;
    body.querySelectorAll(".colorBtns button").forEach(b=>{ b.onclick = ()=>{ call.codSel = b.dataset.c; renderIncarico(); }; });
    body.querySelectorAll(".callMz input").forEach(ii=>{ ii.onchange = ()=>{ call.incaricoMz = [...body.querySelectorAll(".callMz input:checked")].map(xx=>xx.value); }; });
    body.querySelectorAll("[data-act]").forEach(b=>{ b.onclick = ()=>{
      const act = b.dataset.act;
      if(act==="close") closeIncarico(true);
      else if(act==="create"){
        if(!call.vvf && !call.codSel){ toast("Scegli il codice colore"); return; }
        const cid = call.callId, cod = call.codSel || "VVF";
        const mz = [...body.querySelectorAll(".callMz input:checked")].map(xx=>xx.value);
        incaricoCallId = null; ov.style.display = "none";
        accettaChiamata(cid, cod, mz);
      }
    };});
    const t = document.querySelector("#incaricoTitle");
    if(t) t.textContent = "📋 Nuovo incarico — " + call.comune + " (" + call.prov + ")";
    ov.style.display = "flex";
  }
  // assistenza in finestra separata (come incarico): mezzi + invia, poi si chiude
  let assistIvId = null;
  function openAssist(ivId){
    assistIvId = ivId;
    renderAssist();
  }
  function closeAssist(){
    assistIvId = null;
    const ov = document.querySelector("#assistOverlay");
    if(ov) ov.style.display = "none";
  }
  function renderAssist(){
    const ov = document.querySelector("#assistOverlay");
    const body = document.querySelector("#assistBody");
    if(!ov || !body) return;
    wirePop("#assistHead", "#assistWin", "#assistX", ()=>closeAssist());
    const iv = interventi.find(x=>x.id===assistIvId);
    if(!iv){ ov.style.display = "none"; return; }
    const disp = mezzi.filter(m=>m.stato==="disponibile"&&m.corpo!=="VVF");
    const dispVVF = mezzi.filter(m=>m.stato==="disponibile"&&m.corpo==="VVF");
    body.innerHTML = `
      <div class="intTop"><b>🆘 Assistenza</b></div>
      <div class="intAddr">📍 ${luogoIV(iv,true)}</div>
      <div class="small" style="margin:4px 0">${iv.vvf ? "Scegli liberamente i mezzi da inviare (118 e/o VVF, senza vincoli):" : "Spunta i mezzi da inviare (ordinati per distanza):"}</div>
      <div class="selGrid" id="selGrid"></div>
      <button class="lstBtn primary" id="sendSelBtn">🚀 Invia selezionati (0)</button>
      <details class="vvfSec" id="vvfSec">
        <summary>🚒 Vigili del Fuoco <span class="small">— distaccamenti in ordine di distanza</span></summary>
        <div id="vvfGrid"></div>
        <button class="lstBtn primary" id="sendVvfBtn">🚀 Invia VVF selezionati (0)</button>
      </details>
      <details class="vvfSec" id="eliSec">
        <summary>🚁 Elisoccorso <span class="small">— tutti gli elicotteri</span></summary>
        <div id="eliGrid"></div>
        <button class="lstBtn primary" id="sendEliBtn">🚀 Invia ELI selezionati (0)</button>
      </details>
      <details class="vvfSec" id="miSec">
        <summary>🚒 VVF Milano <span class="small">— comando + distaccamenti MI</span></summary>
        <div id="miGrid"></div>
        <button class="lstBtn primary" id="sendMiBtn">🚀 Invia VVF Milano selezionati (0)</button>
      </details>
    `;
    const sg=$("selGrid"), sendBtn=$("sendSelBtn");
    const byDist = disp.map(mz=>({mz, d:haversineKm(iv.lat,iv.lng,mz.lat,mz.lng)}))
      .sort((a,b)=>a.d-b.d).slice(0,40);
    const updCount = ()=>{
      const n = sg.querySelectorAll("input:checked").length;
      sendBtn.textContent = `🚀 Invia selezionati (${n})`;
    };
    for(const {mz, d} of byDist){
      const lab=document.createElement("label");
      const cb=document.createElement("input");
      cb.type="checkbox"; cb.value=mz.codice;
      cb.onchange=updCount;
      lab.appendChild(cb);
      const sp=document.createElement("span");
      sp.innerHTML=` ${mzNomeHTML(mz, mz.codice)} (${mz.tipo}) ${mz.sede} — ${d.toFixed(1)} km`;
      lab.appendChild(sp);
      lab.title=`${mz.codice} — ${mz.tipo} — ${mz.sede}`;
      sg.appendChild(lab);
    }
    if(disp.length===0) sg.innerHTML=`<div class="small">Nessun mezzo libero.</div>`;
    // già impegnati ma dirottabili: ripartono da dove si trovano
    const busy = mezzi.filter(m=>m.corpo!=="VVF"&&(m.stato==="viaggio"||m.stato==="rientro"||m.stato==="sul_posto"))
      .map(mz=>({mz, d:haversineKm(iv.lat,iv.lng,mz.lat,mz.lng)}))
      .sort((a,b)=>a.d-b.d).slice(0,10);
    if(busy.length){
      const sep=document.createElement("div");
      sep.className="small"; sep.style.margin="4px 0";
      sep.textContent="↩️ Già impegnati — spunta per dirottarli (ripartono da dove sono):";
      sg.appendChild(sep);
      for(const {mz, d} of busy){
        const lab=document.createElement("label");
        const cb=document.createElement("input");
        cb.type="checkbox"; cb.value=mz.codice;
        cb.onchange=updCount;
        lab.appendChild(cb);
        const sp=document.createElement("span");
        const stTxt = mz.stato==="viaggio"?"in viaggio":mz.stato==="rientro"?"in rientro":"sul posto";
        sp.innerHTML=` ${mzNomeHTML(mz, mz.codice)} (${mz.tipo}) 🟠 ${stTxt} — ${d.toFixed(1)} km`;
        lab.appendChild(sp);
        lab.title=`${mz.codice} — ${mz.tipo} — ${stTxt} — dirottabile, riparte da dove si trova`;
        sg.appendChild(lab);
      }
    }
    sendBtn.onclick=()=>{
      const checked=[...sg.querySelectorAll("input:checked")].map(i=>i.value);
      if(checked.length===0){ toast("Spunta almeno un mezzo!"); return; }
      let ok=0;
      for(const cod of checked){ if(assegnaMezzo(cod, iv.id)) ok++; }
      if(ok>0){ closeAssist(); renderListe(); }
      toast(ok>0 ? `🚀 Inviati ${ok} mezzi all'intervento #${iv.id}` : "Nessun mezzo inviato");
    };
    // ---- sezione VVF: distaccamenti ordinati per distanza, con i loro mezzi ----
    const vg=$("vvfGrid"), sendVvfBtn=$("sendVvfBtn");
    if(vg && sendVvfBtn){
      vg.innerHTML="";
      const gruppi = new Map(); // sede -> {sede, d, mezzi[]}
      for(const mz of dispVVF){
        const s = D().VVF_SEDI.find(x=>x.nome===mz.sede);
        const d = s ? haversineKm(iv.lat,iv.lng,s.lat,s.lng) : haversineKm(iv.lat,iv.lng,mz.lat,mz.lng);
        if(!gruppi.has(mz.sede)) gruppi.set(mz.sede, {sede:mz.sede, prov:mz.prov, d, mezzi:[]});
        gruppi.get(mz.sede).mezzi.push(mz);
      }
      const ordinati=[...gruppi.values()].sort((a,b)=>a.d-b.d);
      const updVvfCount = ()=>{
        const n = vg.querySelectorAll("input:checked").length;
        sendVvfBtn.textContent = `🚀 Invia VVF selezionati (${n})`;
      };
      for(const g of ordinati){
        const gh=document.createElement("div");
        gh.className="vvfGroup";
        gh.innerHTML=`🚒 <b>${g.sede}</b> <span class="small">(${g.prov}) — ${g.d.toFixed(1)} km</span>`;
        vg.appendChild(gh);
        for(const mz of g.mezzi){
          const lab=document.createElement("label");
          const cb=document.createElement("input");
          cb.type="checkbox"; cb.value=mz.codice;
          cb.onchange=updVvfCount;
          lab.appendChild(cb);
          const sp=document.createElement("span");
          sp.innerHTML=` ${mzNomeHTML(mz)} (${mz.tipo})`;
          lab.appendChild(sp);
          lab.title=`${mz.radio||mz.codice} — ${mz.tipo} — ${mz.sede}`;
          vg.appendChild(lab);
        }
      }
      if(ordinati.length===0) vg.innerHTML=`<div class="small">Nessun mezzo VVF libero.</div>`;
      // VVF impegnati ma dirottabili
      const busyVVF = mezzi.filter(m=>m.corpo==="VVF"&&(m.stato==="viaggio"||m.stato==="rientro"||m.stato==="sul_posto"))
        .map(mz=>({mz, d:haversineKm(iv.lat,iv.lng,mz.lat,mz.lng)}))
        .sort((a,b)=>a.d-b.d).slice(0,10);
      if(busyVVF.length){
        const sep=document.createElement("div");
        sep.className="small"; sep.style.margin="4px 0";
        sep.textContent="↩️ VVF impegnati — spunta per dirottarli (ripartono da dove sono):";
        vg.appendChild(sep);
        for(const {mz, d} of busyVVF){
          const lab=document.createElement("label");
          const cb=document.createElement("input");
          cb.type="checkbox"; cb.value=mz.codice;
          cb.onchange=updVvfCount;
          lab.appendChild(cb);
          const sp=document.createElement("span");
          const stTxt = mz.stato==="viaggio"?"in viaggio":mz.stato==="rientro"?"in rientro":"sul posto";
          sp.innerHTML=` ${mzNomeHTML(mz)} (${mz.tipo}) 🟠 ${stTxt} — ${d.toFixed(1)} km`;
          lab.appendChild(sp);
          lab.title=`${mz.radio||mz.codice} — ${mz.tipo} — ${stTxt} — dirottabile`;
          vg.appendChild(lab);
        }
      }
      sendVvfBtn.onclick=()=>{
        const checked=[...vg.querySelectorAll("input:checked")].map(i=>i.value);
        if(checked.length===0){ toast("Spunta almeno un mezzo VVF!"); return; }
        let ok=0;
        for(const cod of checked){ if(assegnaMezzo(cod, iv.id)) ok++; }
        if(ok>0){ closeAssist(); renderListe(); }
        toast(ok>0 ? `🚒 Inviati ${ok} mezzi VVF all'intervento #${iv.id}` : "Nessun mezzo inviato");
      };
    }
    // ---- sezione ELI: tutti gli elicotteri (118 + DRAGO153), liberi e dirottabili ----
    const eg=$("eliGrid"), sendEliBtn=$("sendEliBtn");
    if(eg && sendEliBtn){
      eg.innerHTML="";
      const updEliCount = ()=>{
        const n = eg.querySelectorAll("input:checked").length;
        sendEliBtn.textContent = `🚀 Invia ELI selezionati (${n})`;
      };
      const eliAddRow = (mz, extra)=>{
        const lab=document.createElement("label");
        const cb=document.createElement("input");
        cb.type="checkbox"; cb.value=mz.codice;
        cb.onchange=updEliCount;
        lab.appendChild(cb);
        const sp=document.createElement("span");
        sp.innerHTML=` 🚁 ${mzNomeHTML(mz)} — ${mz.sede}${extra||""}`;
        lab.appendChild(sp);
        lab.title=`${mz.radio||mz.codice} — ${mz.tipo} — ${mz.sede}`;
        eg.appendChild(lab);
      };
      const eliFree = mezzi.filter(m=>m.tipo==="ELI"&&m.stato==="disponibile")
        .map(mz=>({mz, d:haversineKm(iv.lat,iv.lng,mz.lat,mz.lng)}))
        .sort((a,b)=>a.d-b.d);
      for(const {mz, d} of eliFree) eliAddRow(mz, ` — ${d.toFixed(1)} km`);
      if(eliFree.length===0) eg.innerHTML=`<div class="small">Nessun elicottero libero.</div>`;
      const eliBusy = mezzi.filter(m=>m.tipo==="ELI"&&(m.stato==="viaggio"||m.stato==="rientro"||m.stato==="sul_posto"))
        .map(mz=>({mz, d:haversineKm(iv.lat,iv.lng,mz.lat,mz.lng)}))
        .sort((a,b)=>a.d-b.d);
      if(eliBusy.length){
        const sep=document.createElement("div");
        sep.className="small"; sep.style.margin="4px 0";
        sep.textContent="↩️ Elicotteri impegnati — spunta per dirottarli (ripartono da dove sono):";
        eg.appendChild(sep);
        for(const {mz, d} of eliBusy){
          const stTxt = mz.stato==="viaggio"?"in viaggio":mz.stato==="rientro"?"in rientro":"sul posto";
          eliAddRow(mz, ` 🟠 ${stTxt} — ${d.toFixed(1)} km`);
        }
      }
      sendEliBtn.onclick=()=>{
        const checked=[...eg.querySelectorAll("input:checked")].map(i=>i.value);
        if(checked.length===0){ toast("Spunta almeno un elicottero!"); return; }
        let ok=0;
        for(const cod of checked){ if(assegnaMezzo(cod, iv.id)) ok++; }
        if(ok>0){ closeAssist(); renderListe(); }
        toast(ok>0 ? `🚁 Inviati ${ok} elicotteri all'intervento #${iv.id}` : "Nessun mezzo inviato");
      };
    }
    // ---- sezione VVF Milano: comando + distaccamenti MI, raggruppati per sede ----
    const mg=$("miGrid"), sendMiBtn=$("sendMiBtn");
    if(mg && sendMiBtn){
      mg.innerHTML="";
      const updMiCount = ()=>{
        const n = mg.querySelectorAll("input:checked").length;
        sendMiBtn.textContent = `🚀 Invia VVF Milano selezionati (${n})`;
      };
      const miAddRow = (mz, extra)=>{
        const lab=document.createElement("label");
        const cb=document.createElement("input");
        cb.type="checkbox"; cb.value=mz.codice;
        cb.onchange=updMiCount;
        lab.appendChild(cb);
        const sp=document.createElement("span");
        sp.innerHTML=` ${mzNomeHTML(mz)} (${mz.tipo})${extra||""}`;
        lab.appendChild(sp);
        lab.title=`${mz.radio||mz.codice} — ${mz.tipo} — ${mz.sede}`;
        mg.appendChild(lab);
      };
      const gruppiMI = new Map();
      for(const mz of mezzi.filter(m=>m.corpo==="VVF"&&m.prov==="MI"&&m.stato==="disponibile")){
        const s = D().VVF_SEDI.find(x=>x.nome===mz.sede);
        const d = s ? haversineKm(iv.lat,iv.lng,s.lat,s.lng) : haversineKm(iv.lat,iv.lng,mz.lat,mz.lng);
        if(!gruppiMI.has(mz.sede)) gruppiMI.set(mz.sede, {sede:mz.sede, d, mezzi:[]});
        gruppiMI.get(mz.sede).mezzi.push(mz);
      }
      for(const g of [...gruppiMI.values()].sort((a,b)=>a.d-b.d)){
        const gh=document.createElement("div");
        gh.className="vvfGroup";
        gh.innerHTML=`🚒 <b>${g.sede}</b> <span class="small">— ${g.d.toFixed(1)} km</span>`;
        mg.appendChild(gh);
        for(const mz of g.mezzi) miAddRow(mz);
      }
      if(gruppiMI.size===0) mg.innerHTML=`<div class="small">Nessun mezzo VVF Milano libero.</div>`;
      const miBusy = mezzi.filter(m=>m.corpo==="VVF"&&m.prov==="MI"&&(m.stato==="viaggio"||m.stato==="rientro"||m.stato==="sul_posto"))
        .map(mz=>({mz, d:haversineKm(iv.lat,iv.lng,mz.lat,mz.lng)}))
        .sort((a,b)=>a.d-b.d);
      if(miBusy.length){
        const sep=document.createElement("div");
        sep.className="small"; sep.style.margin="4px 0";
        sep.textContent="↩️ VVF Milano impegnati — spunta per dirottarli (ripartono da dove sono):";
        mg.appendChild(sep);
        for(const {mz, d} of miBusy){
          const stTxt = mz.stato==="viaggio"?"in viaggio":mz.stato==="rientro"?"in rientro":"sul posto";
          miAddRow(mz, ` 🟠 ${stTxt} — ${d.toFixed(1)} km`);
        }
      }
      sendMiBtn.onclick=()=>{
        const checked=[...mg.querySelectorAll("input:checked")].map(i=>i.value);
        if(checked.length===0){ toast("Spunta almeno un mezzo VVF Milano!"); return; }
        let ok=0;
        for(const cod of checked){ if(assegnaMezzo(cod, iv.id)) ok++; }
        if(ok>0){ closeAssist(); renderListe(); }
        toast(ok>0 ? `🚒 Inviati ${ok} mezzi VVF Milano all'intervento #${iv.id}` : "Nessun mezzo inviato");
      };
    }
    const t = document.querySelector("#assistTitle");
    if(t) t.textContent = "🆘 Assistenza — " + iv.comune + " (" + iv.prov + ")";
    ov.style.display = "flex";
  }
  // finestra trascinabile generica (testata trascina, X chiude)
  function wirePop(headSel, winSel, xSel, onX){
    const head = document.querySelector(headSel);
    const win = document.querySelector(winSel);
    const x = document.querySelector(xSel);
    if(x) x.onclick = onX;
    if(!head || !win || head._drag) return;
    head._drag = true;
    head.onmousedown = e=>{
      if(e.target.tagName==="BUTTON") return;
      e.preventDefault();
      const r = win.getBoundingClientRect();
      const ox = e.clientX - r.left, oy = e.clientY - r.top;
      win.style.position = "fixed"; win.style.margin = "0";
      win.style.left = r.left + "px"; win.style.top = r.top + "px";
      const mv = ev=>{ win.style.left = (ev.clientX - ox) + "px"; win.style.top = (ev.clientY - oy) + "px"; };
      const up = ()=>{ document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); };
      document.addEventListener("mousemove", mv);
      document.addEventListener("mouseup", up);
    };
  }
  function refreshCallMarkers(){
    if (!map || !layerChiamate) return;
    layerChiamate.clearLayers();
    for(const call of chiamate){
      const mk = L.marker([call.lat,call.lng],{
        icon: L.divIcon({className:'callIcon',
          html:`<div class="callDot pulse">📞</div>`,
          iconSize:[22,22], iconAnchor:[11,11]})
      });
      mk.bindTooltip(`🔔 Chiamata in arrivo<br>${luogoIV(call,false)}`);
      mk.on('click', ()=>{ highlightCall = call.callId; renderCalls(); });
      mk.addTo(layerChiamate);
    }
  }

 function hhmm(t){ return `${String(Math.floor(t/60)).padStart(2,"0")}:${String(Math.floor(t%60)).padStart(2,"0")}`; }
  function hhmmss(t){ return hhmm(t)+":"+String(Math.floor((t*60)%60)).padStart(2,"0"); }

  // pazienti dal tipo: pz = persone coinvolte (numero esatto, 0 = nessun ferito), sal = range salute %;
  // senza sal si usa il fallback da codice (P1 grave … P4 lieve)
  function randomSalute(prio){
    if(prio===1) return rndi(5,50);
    if(prio===2) return rndi(20,70);
    if(prio===3) return rndi(40,90);
    return rndi(60,99);
  }
 function salutePaziente(prio, tipo){
    let s = (tipo && tipo.sal) ? triRange(tipo.sal[0], tipo.sal[1]) : randomSalute(prio||4);
    const d = dinamicaGravita(tipo?tipo.nome:"", tipo?tipo.desc:"");
    return Math.max(3, Math.min(99, Math.round(s + d.ds + rndi(-3,3))));
 }
  // ---------- GRAVITÀ DINAMICA: quanto è violento l'evento (tutte le missioni) ----------
  // Disegno a triangolo nel range: valori centrali più probabili, code plausibili —
  // due missioni dello stesso tipo danno quasi sempre gravità diverse.
  function triRange(lo, hi){ const t = (Math.random()+Math.random())/2; return Math.round(lo + t*(hi-lo)); }
  // Energia della dinamica da nome+desc (stessa per tutti i feriti della missione,
  // più jitter per paziente): incidenti violenti abbassano la salute, lievi l'alzano.
  const DIN_MOLTO = /treno|ferrovia|passaggio a livello|aereo|elicottero|ultraleggero|arma da fuoco|colpi d'arma|spari|proiettil|impicc|sepolto|macerie|travi|valanga/;
  const DIN_FORTE = /frontale|schianto|ribaltat|cappottat|esplosion|scoppio|deflagra|investit|folgorat|fulmine|annegamento|precipitat|travolt|crollo|schiaccia|accoltell|ferita d'arma/;
  const DIN_MEDIA = /tetto|impalcatura|ponteggio|balcone|scala|gru|caduta dall'alto|moto |motorino|scooter|aggressione|rissa|ustione estesa|ustioni estese|scossa con/;
  const DIN_LIEVE = /lieve|lievi|contusione|distorsione|puntura|zecca|vaccin|controllo|medicazione|paura|stato d'ansia|banale/;
  function dinamicaGravita(nome, desc){
    const t = ((nome||"")+" "+(desc||"")).toLowerCase();
    let ds = 0, livello = "media";
    if(DIN_MOLTO.test(t)){ ds = -14; livello = "estrema"; }
    else if(DIN_FORTE.test(t)){ ds = -9; livello = "alta"; }
    else if(DIN_MEDIA.test(t)){ ds = -5; livello = "media-alta"; }
    else if(DIN_LIEVE.test(t)){ ds = +8; livello = "lieve"; }
    return {ds, livello};
  }
  // intrappolato: stesse regole del validatore (intrAmmesso): esplicito 70%,
  // crollo 35% se grave, dinamica violenta stradale 15% se grave (tetto max 2 dopo)
  function tiraIntr(cat, tipoNome, s){
    const livIntr = intrAmmesso(tipoNome||"");
    if(livIntr===2) return Math.random()<0.7;
    if(livIntr===1 && s<65) return Math.random() < (cat==="crollo" ? 0.35 : 0.15);
    return false;
  }
  // quadro coerente con la dinamica: se l'evento parla di incastro/fumo/acqua/
  // emorragia/frattura, preferisce i quadri che la descrivono (mai ripetuti se possibile)
  function quadroCoerente(pool, nome, intr, usati){
    const n = (nome||"").toLowerCase();
    let rx = null;
    if(intr) rx = /incastr|intrappol|schiaccia|compressione/;
    else if(/fumo|inalazione|incendio| a fuoco|brucia|monossido|ustione/.test(n)) rx = /fumo|inalazione|ustione|monossido|vie aeree/;
    else if(/anneg|acqua|ipotermia/.test(n)) rx = /anneg|acqua|ipotermia|inalazione/;
    else if(/emorragia|sangue|arma|coltell/.test(n)) rx = /emorragia|sangue|arma|ferita/;
    else if(/frattura|trauma cranico|testa|distorsione/.test(n)) rx = /frattura|trauma|testa|distorsione/;
    if(!rx) return null;
    const freschi = pool.filter(q=>rx.test(q) && !usati.has(q));
    if(freschi.length) return freschi[rndi(0,freschi.length-1)];
    const tutti = pool.filter(q=>rx.test(q));
    if(tutti.length) return tutti[rndi(0,tutti.length-1)];
    return null;
  }
  // (randomPazienti rimossa: il numero di pazienti è sempre tipo.pz, mai pescato)
  function pazientiTXT(list){
    const a = (list||[]).filter(x=>x!=null);
    if(!a.length) return `👤 Nessun ferito`;
    return `👤 Pazienti (${a.length}): ${a.map(s=>"<b>"+Math.round(s)+"%</b>").join(" · ")}`;
  }
  // ---------- PAZIENTI v2: numero dai dati + profili individuali ----------
  // Il motore continua a usare l'array di salute % (cura, trasporti 1=1, MSA, report).
  // QUANTI sono lo decide solo tipo.pz (persone coinvolte: 0 = nessun ferito):
  // la categoria serve solo per i quadri clinici, mai per il numero. Qui si decide
  // CHI sono (età/sesso/coscienza/quadro/vitali). Contorno: solo gli evacuati (incendi,
  // crolli: non sono pazienti e non si trasportano). Gli illesi non esistono più: ogni
  // coinvolto è un paziente da valutare e trasportare. Tabelle configurabili: PZ_VAR per le
  // varianti di gravità (spostano solo la salute), PZ_QUADRI per i quadri clinici
  // (ogni paziente pesca dalla piscina della SUA categoria: niente combinazioni
  // assurde). I profili nascono alla creazione e viaggiano call→intervento;
  // le funzioni di disegno leggono soltanto: nessun duplicato ai refresh e nessun
  // paziente aggiunto agli aggiornamenti (mappa, mezzi, evoluzioni).
  function pazCat(nome){
    const n = (nome||"").toLowerCase();
    if(/scuolabus|autobus|pullman|ncc|\bbus\b/.test(n)) return "bus";
    if(/camion|\btir\b|autoarticolato|autocarro|betoniera|bilico|scontro tra camion|auto contro camion|autobotte|autocisterna|aereo|precipitat|elicottero|ultraleggero/.test(n)) return "pesante";
    if(/moto|motorino|scooter|vespa|\bquad\b|ciclomotore/.test(n)) return "moto";
    if(/treno|treni|ferrovia|linea ferroviaria|passaggio a livello|\bbinari\b|sbarra\b|deragli|vagone|vagoni|locomotore|capotreno/.test(n)) return "treno";
    if(/pedone|investit|ciclista|\bbici\b|monopattino|passeggino|carrozzina|\bbiker\b|\bmtb\b/.test(n)) return "bici";
    if(/parto|doglie|gravid|nascit|gemellar|travaglio|aborto|gestosi|ombelicale|neonato|puerperio|eclampsia/.test(n)) return "parto";
    if(/arma da fuoco/.test(n)) return "aggr"; // ferite d'arma: mai quadri da incendio
    if(/toro scatenato/.test(n)) return "aggr"; // travolto dal toro: mai quadri da intossicazione
    if(/incendio|fuoco|fiamme|brucia| a fuoco|ustione|esplosion|scoppio|fumo|monossido|\bgas\b|gpl|metano|ammoniaca|esalazioni|vapori|\bco2\b|cloro|solventi/.test(n)) return "incendio";
    if(/arresto cardiaco|infarto|dolore toracico|palpitazioni|fibrillazione|ischemi|edema polmonare|shock cardiogeno/.test(n)) return "cardio";
    if(/ictus|convuls|epiless|coma|meningite|sincope|sven|vertigin|paresi|afasia|stato di male|emicrania|cefalea/.test(n)) return "neuro";
    if(/dispnea|asma|soffoc|respir|bronchiolite|polmonite|epiglottite|pleurite|pneumotorace|laringite|fame d'aria|apnea|boccone|acino|palloncino|caramella in gola|corpo estraneo in gola|strozz/.test(n)) return "resp";
    // pediatria: bimbo + patologia medica (i traumi restano nelle categorie trauma)
    const bimbo = /bambin|bimbo|bimbi|lattante|neonat|bimba|poppante|infante/.test(n);
    const patMed = /febbre|vomito|bronchiolite|laringite|gastroenterite|convulsioni|apnea|ittero|epiglottite|asma|otite|esantema|vaccino|dissenteria|disidratazione|ingest|ingerit|ingoi|mangiato|bevuto|bottone|moneta|fagiolo|acino/.test(n);
    const daTrauma = /cadut|trauma|frattura|ferita|ustione|morso|puntura|incastr|taglio|scossa|botta|contusione|distorsione|anneg|soffoc|investit|scontro|incidente/.test(n);
    if(bimbo && patMed && !daTrauma) return "ped";
    if(/folgor|scossa elettrica|scossa da|elettrocuzione|filo elettrico|presa elettrica|cavi elettrici|colonnina di ricarica|linea elettrica|fulmine/.test(n)) return "folgor";
    if(/impicc|suicid|buttarsi|ponte intenzionat|tagli ai polsi|gesto anticonservativo/.test(n)) return "autol";
    if(/sciame|\bapi\b|vesp|calabroni|processionaria/.test(n)) return "api";
    if(/morso|morsi|puntura|punture|zecca|vipera|ragno|medusa|tracina|pungiglione|apicoltore|graffio|aggredit/.test(n)) return "morsi";
    if(/anneg|acqua|tuffo|piscina|lago|\bsup\b|pedalò|canoa|motoscafo|ipotermia|sommozz|assider|infreddolit|congelat|roggia|torrente|allagat|esondat|alluvione|bagnante|bagnino|in difficoltà|barca|catamarano|pontile|imbarcazione|al largo|alla deriva|materassino|boma|elica|scogli/.test(n)) return "acqua";
    if(/grandine|tendone|tribuna|gonfiabile|ruota panoramica|effetto folla|calca/.test(n) && !/palco.*croll|tendone.*divel/.test(n)) return "folla";
    if(/palco.*croll|tendone.*divel|tenda da sole divelta|gonfiabile volato/.test(n)) return "folla";
    if(/crollo|macerie|sepolto|sprofond|travi|muro di cinta|grondaia|comignolo|insegna|lampione|vetrata crollata|scaffale|container|balla di fieno|rotolo di carta|mensola|lampadario|televisore|letto a scomparsa|bilanciere|tronco su|albero su|su auto|su tenda|schiaccia|ponticello|muretto crollato|altana crollata|parete rocciosa|massi|valanga|frana contro|frana su|auto travolta|traliccio|cartellone|striscione|statua|lapidi|campanile|pensilina crollata|balcone crollato|ponteggio crollato|tromba d'aria|diga|argine|pericolante/.test(n) && !/maratona|maratoneta|maratoneti|podista|podisti|corridore|corridori|partita|gara|gare|atleta|atleti|allenamento/.test(n)) return "crollo";
    // utensili: contesto lavoro → lavoro, altrimenti domestico → casa
    if(/trapano|smerigliatrice|sega\b|tornio|pressa|fresatrice|tagliasiepi|cesoie|decespugliatore|tosaerba|motosega|ascia|forcone|falciatrice|mietitrebbia|muletto|transpallet|benna|escavatore|compattatore|affettatrice|tritacarne|sparachiodi|idropulitrice|saldat|sporgente|macchinario|lamiera|lamiere/.test(n))
      return /cantiere|fabbrica|magazzino|officina|forno|professionale|isola ecologica|stalle|stalla|fienile|campo\b|vigna|serra|operaio|in fabbrica|in cantiere|cava|miniera|panificio|macelleria|pizzeria|lavoro\b/.test(n) ? "lavoro" : "casa";
    if(/caduta|scivol|cadut|precipit|scala|tetto|impalcatura|balcone|altalena|giostra|buca|tombino|dirupo|scarpata|burrone|cade\b|cadde|inciampa|a terra/.test(n)) return "caduta";
    // professioni a rischio → lavoro (dopo le cadute: "cacciatore caduto" resta caduta)
    if(/fabbro|fornaio|pizzaiolo|imbianchino|muratore|falegname|idraulico|elettricista|meccanico|magazziniere|corriere|postino|boscaiolo|contadino|allevatore|pescatore|cacciatore|vignaiolo|panettiere|macellaio|operaio|infortunio sul lavoro/.test(n)) return "lavoro";
    if(/cucina|forno|pentola|padella|coltello|mandolina|frullatore|robot da cucina|apriscatole|taglierina|pelapatate|phon|lavatrice|oblò|porta|finestra|specchio|cassettiera|divano|poltrona|dondolo|sedia|cancello|portone|saracinesca|vasca|doccia|bagno|rubinetto|scaldabagno|stufa|caminetto|amputat|forbici|ago\b|thermos\b/.test(n)) return "casa";
    if(/calcio di|caricat[oi] da|zampata|cornata/.test(n)) return "aggr";
    if(/partita|paddle|basket|sparring|boxe|rugby|maratona|triathlon|judo|karate|bocce|bowling|freccette|pallavolo|volley|squash|hockey|fioretto|tiro con l'arco|skate|parkour|allenamento|mischia|placcaggio|pallonata|proiezione|sci\b|snowboard|slalom|trampolin|kitesurf|surf|windsurf|parapendio|paracadute|deltaplano|escursionista|ferrata|falesia|canyonista|fungaiolo|rifugio|gare\b|podista|maratoneta|corridore|palaghiaccio|pattin|disarcionat|equitazione|maneggio|galoppo|calcetto|calcio\b|corsa|correndo|capanno/.test(n)) return "sport";
    if(/lavoro|operaio|cantiere|fabbrica|muletto|pressa|trattore|gru|officina|stalla|silos|botte|infortunio/.test(n)) return "lavoro";
    if(/aggressione|rissa|accoltell|arma|rapina|spari|coltell|spranga|proiettil|ferita d'arma|picchiat|pestaggio/.test(n)) return "aggr";
    // trauma generico: ferite, fratture, emorragie, corpi estranei, incidenti domestici minori
    if(/trauma|frattura|lussaz|lussat|emorragia|ferita|botta in testa|chiodo|truciolo|scheggia|spina|amo\b|petardo|siringa|freccetta|varice|epistassi|labbro|occhio|orecchio|incastrat|ringhiera|pila a bottone|corpo estraneo|vapore|taglio|tagliat|anello|detersivo|caustic|sangue dal|naso sanguinante|tosse con sangue|rotta |rotto |rotti |rotte |ascesso|grattugiat|grattat|strappat|strappo|distorsione|chiuso in/.test(n)) return "trauma";
    if(/intossicazione alimentare|mense|ristorante|sagra|banchetto|funghi\b|botulino/.test(n)) return "tossAlim";
    if(/scontro|tamponamento|tamponat|incidente|auto contro|contro auto|fuori strada|frontale|testa-coda|pirata|ribaltat|cappottat|frusta|coda|rotonda|guardrail|transenna|spartitraffico|autostrada|tangenziale|superstrada|contro muro|muretto|parapetto|\bmuro\b|palo|stradale|strada\b|carreggiata|marciapiede|parcheggio|incrocio|svincolo|precedenza|sportello|portiera|cofano|paraurti|parabrezza|apecar|semaforo|idrante/.test(n)) return "strada";
    return "medico";
  }
  // variante di gravità dell'evento per prio (pesi su 100): sposta solo la salute, mai il numero.
  // Le risorse seguono da sole le regole esistenti (più feriti → più ambulanze, salute<35 → MSA).
  const PZ_VAR = {1:[10,30,35,25], 2:[20,45,25,10], 3:[35,45,15,5], 4:[60,32,7,1]};
  const PZ_VAR_FX = [{k:"lieve",ds:+12},{k:"media",ds:0},{k:"grave",ds:-12},{k:"critica",ds:-22}];
 function varianteGravita(prio){
   const w = PZ_VAR[prio] || PZ_VAR[4];
   let r = Math.random()*100, idx = 1;
   for(let k=0;k<4;k++){ r -= w[k]; if(r<=0){ idx = k; break; } }
   return PZ_VAR_FX[idx];
 }
  // ---------- PAZIENTI VVF DINAMICI: numero per tipologia di intervento ----------
  // Le missioni VVF nascono quasi tutte con pz 0/1 nei dati: il numero reale di
  // feriti lo decide la TIPOLOGIA di scenario (intervalli + probabilità su
  // nome+desc, come pazCat/intrAmmesso: vale per i tipi presenti e futuri con
  // nomi simili, senza correzioni per singola missione). Le sanitarie restano
  // esatte (tipo.pz = persone coinvolte). w = [[n,peso]...] su 100, sal = range
  // di salute usato quando i dati non lo danno (tipo.sal ha sempre priorità).
  const PZV_TAB = {
    tecnico: {w:[[0,100]], sal:null},        // intervento tecnico: mai feriti
    singolo: {w:[[1,100]], sal:[40,85]},     // 1 persona: soccorso o incastro
    ricerca: {w:[[0,60],[1,40]], sal:[50,90]}, // disperso: ritrovato o no
    crolloX: {w:[[0,15],[1,25],[2,25],[3,15],[4,10],[5,5],[6,5]], sal:[5,55]}, // palazzina: 0..numerosi
    crolloM: {w:[[0,70],[1,22],[2,8]], sal:[25,75]}, // crollo minore
    casaF:   {w:[[0,55],[1,28],[2,12],[3,5]], sal:[30,85]}, // incendio in abitazione
    pubG:    {w:[[0,45],[1,20],[2,15],[3,8],[4,5],[5,3],[6,2],[7,1],[8,1]], sal:[35,90]}, // edificio pubblico
    pubP:    {w:[[0,60],[1,25],[2,10],[3,5]], sal:[40,88]}, // negozi e artigiani
    rurale:  {w:[[0,90],[1,10]], sal:[40,85]}, // stalle e fienili
    veget:   {w:[[0,88],[1,10],[2,2]], sal:[40,85]}, // bosco e sterpaglie
    veicF:   {w:[[0,80],[1,20]], sal:[45,90]}, // veicolo a fuoco
    stradaV: {w:[[0,70],[1,20],[2,7],[3,3]], sal:[15,70]}, // stradale VVF
    funivia: {w:[[0,50],[1,25],[2,15],[3,7],[4,3]], sal:[60,95]}, // cabine e giostre
    motoV:   {w:[[1,85],[2,15]], sal:[15,60]}, // moto: conducente (+passeggero raro)
    lagoV:   {w:[[0,70],[1,30]], sal:[40,80]}, // auto in acqua: conducente fuori
    ferroV:  {w:[[0,40],[1,25],[2,15],[3,10],[4,6],[5,4]], sal:[10,70]}, // ferrovia: deragli, collisioni, evacuazioni (0..5 feriti)
    ferroX:  {w:[[2,18],[3,22],[4,20],[5,15],[6,12],[7,7],[8,6]], sal:[8,60]}, // disastro ferroviario passeggeri: sempre feriti (2..8)
    fuocoX:  {w:[[1,20],[2,25],[3,22],[4,15],[5,10],[6,8]], sal:[15,65]}, // rogo di treno in galleria/locomotore (1..6 feriti)
  };
  // tipologia VVF di un tipo (dal particolare al generale: l'ordine conta).
  // Persona/incastro/ricerca/moto si leggono sul NOME (il desc cita anche i
  // passanti); incendi/crolli/stradali su nome+desc (conta il contesto).
  function pzvBucket(nome, desc){
    const nm = (nome||"").toLowerCase();
    const t = (nm+" "+(desc||"")).toLowerCase();
    const has = (...ws)=>{ for(const w of ws) if(t.indexOf(w)>=0) return true; return false; };
    const hn = (...ws)=>{ for(const w of ws) if(nm.indexOf(w)>=0) return true; return false; };
    const fire = has("fuoco","fiamme","fumo","incendio","brucia","rogo","a fuoco","esplosion");
    if(has("senza feriti","edificio vuoto","senza passeggeri","nessuno a bordo","auto vuota")) return "tecnico";
    if(has("funivia","ruota panoramica","giostra","seggiovia","cabinovia")) return "funivia";
    if(has("palazzina","crollo generalizzato","possibili sepolti")) return "crolloX";
    if(has("croll","sprofond","macerie","sepolto","frana","valanga","smottamento","ponticello","divelt") && !has("maratona","maratoneta","podista","corridore","atleta","partita","gara")) return "crolloM";
    if(hn("dispers","scompars","perso in spiaggia","smarrito")) return "ricerca";
    if(has("cervo","capriolo","cinghiale","gatto","cane","piccione","cigno","tasso","volpe","cavallo","mucca","pecora","asino","vipera","serpente","sciame","calabroni","carcassa","animale")) return "tecnico";
    if(hn("persona","persone","operaio","bimbo","bimba","bambino","anzian","escursionist","pescatore","biker","cacciatore","malore","con persone","soccorso a persona","sul ponte","sotto il sole","macchinario","tritacarne","ascensore","bloccato in","chiuso dentro","speleologo","dietro porta","scarpata","dirupo","burrone","fungaiolo","muratore ","falegname ","idraulico","elettricista","meccanico ","magazziniere","corriere","postino","boscaiolo","contadino","allevatore","vignaiolo","bagnante","sciatore","uomo","donna","ragazzo","bambina","pozzo","parapendio","paracadute","deltaplano","mano ","piede ","testa ","braccio ")) return "singolo";
    if(has("fotovoltaic","colonnin","quadro elettrico","trasformatore","sottostazione","cabina elettrica","contatore","traliccio","palo della luce","cavi elettrici")) return "tecnico";
    if(has("a fuoco","in fiamme","brucia","prende fuoco") && has("auto","furgone","moto ","scooter","barca","autobus","camion","veicolo","bus ","truck","trattore","escavatore","autobetoniera")) return "veicF";
    if(has("scontro tra treni","collisione tra due treni","deragliamento","carrozza deragliata") && !has("merci")) return "ferroX";
    if(fire && has("treno") && has("galleria","locomotore") && !has("stazione","merci")) return "fuocoX";
    if(fire && has("treno","treni","carrozza","vagone","vagoni")) return "pubG";
    if(has("deragliamento","deragliato","deragliata","collisione tra","scontro tra treni","treno contro treno") || (has("treno","treni","carrozza","vagone","vagoni","binari","ferrovia","stazione","passaggio a livello") && has("merci pericolose")) || (has("treno","treni","carrozza","vagone","vagoni","binari","ferrovia","stazione","passaggio a livello") && has("evacua") && !fire)) return "ferroV";
    if(has("cloro","ammoniaca") && has("piscina","spogliatoi","palestra")) return "pubP";
    if(fire && has("scuola","hotel","albergo","discoteca","cinema","supermercato","centro commerciale","capannone","ospedale","mensa scolastica","asilo nido","nido","luna park","circo","tendone","stabilimento balneare","darsena coperta","darsena","oratorio","teatro","chiesa","biblioteca","archivio comunale","ipermercato")) return "pubG";
    if(fire && has("negozio","edicola","chiosco","ufficio","lavanderia","carrozzeria","pizzeria","ristorante","panificio","panetteria","forno","officina","falegnameria","deposito","fabbrica","fornace","segheria","vetreria","mulino","frantoio","caseificio","tintoria","conceria","cartiera","tipografia","calzaturificio","mobilificio","magazzino","container","ponteggio","pompa di benzina","distributore")) return "pubP";
    if(has("stalla","fienile","legnaia","essiccatoio","pagliaio","pollaio","concimaia","canile","scuderia","maneggio","colombaia","rotoballe","serra","cascina")) return "rurale";
    if(fire && has("bosco","sottobosco","sterpaglia","sterpaglie","canneto","vegetazione")) return "veget";
    if(fire && has("appartamento","cucina","sottotetto","cantina","garage","tetto","camera da letto","balcone","bagno","soggiorno","abitazione","condominio","camino","canna fumaria","asciugatrice","barbecue","tenda da campeggio","roulotte","baita","casera","baracca","rifugio","casetta in legno","in casa")) return "casaF";
    if(hn("motociclista","motorino","scooter","centauro","ciclomotore","moto ")) return "motoV";
    if(has("ribaltat","cappottat","fuori strada","cisterna ribaltata","rovesciat","scontro","tamponamento","investit")) return "stradaV";
    if(has("lago","in acqua","nel fiume","roggia","torrente","alluvione","esondazione","allagat") && has("auto","persona","pescatore","barca","motoscafo","conducente")) return "lagoV";
    return "tecnico";
  }
  // estrae il numero di feriti dalla tabella del bucket (pesi su 100)
  function pzvConta(tipo){
    const tab = PZV_TAB[pzvBucket(tipo.nome, tipo.desc)] || PZV_TAB.tecnico;
    let r = Math.random()*100;
    for(const coppia of tab.w){ r -= coppia[1]; if(r<=0) return coppia[0]; }
    return tab.w[0][0];
  }
  // validatore configurazione (pesi a 100, tetti, piscine quadri): corre al boot, avvisa in console
 function validaPZConfig(){
   const errs = [];
   for(const p in PZ_VAR){ const s = PZ_VAR[p].reduce((a,b)=>a+b,0); if(s!==100) errs.push("varianti prio"+p+" somma "+s); }
    for(const k in PZV_TAB){ const s = PZV_TAB[k].w.reduce((a,x)=>a+x[1],0); if(s!==100) errs.push("pzv "+k+" somma "+s); }
    for(const k in PZ_QUADRI){ for(const b of ["g","m","l"]){ if(!(PZ_QUADRI[k][b]||[]).length) errs.push(k+"."+b+" vuoto"); } }
    return errs;
  }
  // ---------- CENTRALE AFFIDABILE: validazione e ciclo operativo ----------
  // Sistema generale di coerenza missioni, valido per tutti i tipi presenti e futuri:
  //  A) validaTipi: audit statico dei dati (al boot, mai in partita);
  //  B) validaBozza: ogni bozza viene controllata e corretta con regole deterministiche
  //     PRIMA di essere mostrata al giocatore (mai correzioni casuali);
  //  C) guardie di ciclo: stati per ente, chiusure e solleciti coerenti a missione aperta.
  // Intrappolamento ammesso dalla dinamica? 2 = esplicito, 1 = plausibile, 0 = mai.
  // Unica fonte di verita per generazione profili e validatore (stesse regole, due usi).
  function intrAmmesso(nome, desc){
    const t = ((nome||"") + " " + (desc||"")).toLowerCase();
    if(t.indexOf("incastrat")>=0 || t.indexOf("intrappolat")>=0 || t.indexOf("sepolto")>=0 || t.indexOf("tra le lamiere")>=0 || t.indexOf("sotto le lamiere")>=0 || t.indexOf("sotto auto")>=0 || t.indexOf("sotto l'auto")>=0 || t.indexOf("sotto l\u2019auto")>=0) return 2;
    const cat = pazCat(nome);
    if(cat==="crollo") return 1;
    if((cat==="strada"||cat==="pesante"||cat==="bus"||cat==="treno") && (t.indexOf("scontro")>=0||t.indexOf("frontale")>=0||t.indexOf("ribaltat")>=0||t.indexOf("cappottat")>=0||t.indexOf("tamponamento")>=0||t.indexOf("schiaccia")>=0||t.indexOf("travolt")>=0||t.indexOf("investit")>=0||t.indexOf("fuori strada")>=0||t.indexOf("scarpata")>=0||t.indexOf("burrone")>=0)) return 1;
    return 0;
  }
  // dinamica violenta secondo le stesse parole che usa il richiedente quando descrive
  // la scena (osservazioniScena): se lui dice "incastrata", la dinamica deve ammetterlo
  function dinamicaViolenta(nome, desc){
    if(intrAmmesso(nome, desc)>0) return true;
    const t = ((nome||"") + " " + (desc||"")).toLowerCase();
    return t.indexOf("scontro")>=0||t.indexOf("incidente")>=0||t.indexOf("investimento")>=0||t.indexOf("auto contro")>=0||t.indexOf("fuori strada")>=0||t.indexOf("frontale")>=0||t.indexOf("testa-coda")>=0||t.indexOf("pirata")>=0;
  }
  // audit statico di tutti i TIPI: schema + coerenza dinamica/mezzi/pazienti. Ritorna errori [].
  function validaTipi(){
    const errs = [];
    const visti = {};
    const arr = (D() && D().TIPI) || [];
    for(const t of arr){
      const nm = (t && t.nome) || "?";
      visti[nm] = (visti[nm]||0)+1;
      if(!t || typeof t.nome!=="string" || !t.nome) errs.push(nm+": nome mancante");
      if(!(t.pz>=0 && t.pz<=15)) errs.push(nm+": pz="+t.pz);
      if(t.pz>0 && (!t.sal || !(t.sal[0]>=0) || !(t.sal[1]<=100) || t.sal[0]>t.sal[1])) errs.push(nm+": sal="+JSON.stringify(t.sal));
      const pr = t.prio||[];
      if(!(pr.length===4 && pr[0]>=0 && pr[1]>=0 && pr[2]>=0 && pr[3]>=0 && (pr[0]+pr[1]+pr[2]+pr[3])===100)) errs.push(nm+": prio="+JSON.stringify(t.prio));
      if(!t.durata || !(t.durata[0]>=1) || t.durata[0]>t.durata[1]) errs.push(nm+": durata="+JSON.stringify(t.durata));
      if(t.zona && ["casa","strada","natura","lago","misto","ferro","infra"].indexOf(t.zona)<0) errs.push(nm+": zona="+t.zona);
      if(!(t.peso>0)) errs.push(nm+": peso="+t.peso);
      if(!t.emoji) errs.push(nm+": emoji mancante");
      if(!t.desc) errs.push(nm+": desc mancante");
      const m = t.mezzi||{};
      const san = (m.MSB||0)+(m.MSA||0)+(m.AUTOMEDICA||0);
      if(t.pz===0 && t.trasporto) errs.push(nm+": trasporto con pz=0 (nessun ferito)");
      if(t.pz===0 && san>0) errs.push(nm+": mezzi sanitari con pz=0 "+JSON.stringify(m));
      if(t.vvf && t.trasporto) errs.push(nm+": VVF con trasporto");
      if(t.vvf && san>0) errs.push(nm+": VVF con mezzi sanitari "+JSON.stringify(m)+" (scelta libera)");
      if(!t.vvf && (m.VVF||0)>0) errs.push(nm+": sanitaria con VVF nei mezzi (li chiede la scena solo se servono)");
    }
    for(const k in visti) if(visti[k]>1) errs.push("doppione: "+k+" x"+visti[k]);
    return errs;
  }
  // numero atteso di pazienti di una bozza: esatto dai dati, oppure conteggio evento (maxi/MANV)
  function attesiBozza(b, tipo){
    if(b.maxi && tipo.pz>0) return [8,15];
    if(b.manv && tipo.pz>0) return [5,7];
    // VVF: intervallo della tipologia di scenario (dinamico, vedi PZV_TAB)
    if(tipo.vvf){ const tab = PZV_TAB[pzvBucket(tipo.nome, tipo.desc)] || PZV_TAB.tecnico; return [tab.w[0][0], tab.w[tab.w.length-1][0]]; }
    if(TRE_VEICOLI_RE.test(tipo.nome||"")) return [0,6]; // 3+ veicoli: 0-6 feriti di qualsiasi gravita
    return [tipo.pz||0, tipo.pz||0];
  }
  // il richiedente dice che qualcuno è incastrato? (solo righe su PERSONE, mai "auto incastrate")
  function vistoDiceIncastro(visto){
    return (visto||[]).some(v=>v.indexOf("persona \u00e8 incastrata")>=0 || v.indexOf("\u00e8 incastrato e")>=0 || v.indexOf("\u00e8 bloccato e non si muove")>=0);
  }
  // Controlla e corregge una bozza PRIMA che diventi chiamata visibile.
  // Ritorna {ok, correzioni[]}: ok=false solo se il tipo non esiste (allora si rigenera).
  function validaBozza(b){
    const fix = [];
    const tipo = D().TIPI.find(x=>x.nome===b.tipoNome);
    if(!tipo) return {ok:false, correzioni:["tipo sconosciuto: "+b.tipoNome]};
    if(!(b.durata>=1)){ b.durata = rndi(8,14); fix.push("durata"); }
    const att = attesiBozza(b, tipo);
    // il numero VERO è noti+nascosti (la centrale conosce solo i noti)
    const tot0 = (b.pazienti||[]).length + (b.pazientiNascosti||[]).length;
    if(!Array.isArray(b.pazienti) || tot0<att[0] || tot0>att[1]){
      const g = generaPazienti(b.truePrio, tipo);
      b.pazienti = g.salute; b.profili = g.profili; b.illesi = g.illesi; b.evac = g.evac; b.variante = g.variante;
      if(b.maxi && tipo.pz>0){ const nG=tiraConteggioMaxi(); while(b.pazienti.length<nG) pushPaziente(b.pazienti,b.profili,b.truePrio,tipo,g.vds); }
      else if(b.manv && tipo.pz>0){ const nM=tiraNManv(); while(b.pazienti.length<nM) pushPaziente(b.pazienti,b.profili,b.truePrio,tipo,g.vds); }
      b.pazientiNascosti = []; b.profiliNascosti = []; // resettati prima dello split (niente doppi)
      applicaStimaPazienti(b, tipo);
      fix.push("pazienti ricostruiti ("+att[0]+"-"+att[1]+")");
    }
    if(b.pazientiNascosti==null) b.pazientiNascosti = [];
    if(b.profiliNascosti==null) b.profiliNascosti = [];
    if(b.pazIgnoti==null) b.pazIgnoti = false;
    if(b.pazDaVerificare==null) b.pazDaVerificare = false;
    if(!Array.isArray(b.profili) || b.profili.length!==b.pazienti.length || b.profiliNascosti.length!==b.pazientiNascosti.length){
      const cat = pazCat(tipo.nome), us = new Set();
      b.profili = b.pazienti.map(s=>profiloPaziente(s, tipo.nome, cat, us));
      b.profiliNascosti = b.pazientiNascosti.map(s=>profiloPaziente(s, tipo.nome, cat, us));
      let nv = 0; for(const p of b.profili.concat(b.profiliNascosti)){ if(p.intr){ nv++; if(nv>2) p.intr = false; } }
      fix.push("profili riallineati");
    }
    const liv = intrAmmesso(tipo.nome, tipo.desc);
    let clr = 0;
    for(const p of ((b.profili||[]).concat(b.profiliNascosti||[]))){ if(p && p.intr && liv===0){ p.intr = false; clr++; } }
    if(clr) fix.push("incastro impossibile rimosso x"+clr);
    if(vistoDiceIncastro(b.visto) && !((b.profili||[]).concat(b.profiliNascosti||[])).some(p=>p&&p.intr) && b.profili && b.profili[0] && dinamicaViolenta(tipo.nome, tipo.desc)){
      b.profili[0].intr = true; fix.push("incastro segnalato applicato a P1");
    }
    const r = b.richiesti || (b.richiesti = {});
    const nPzTot = (b.pazienti||[]).filter(x=>x!=null).length + (b.pazientiNascosti||[]).filter(x=>x!=null).length;
    if((tipo.pz||0)===0 || nPzTot===0){ for(const k of ["MSB","MSA","AUTOMEDICA"]) if(r[k]>0){ r[k] = 0; fix.push("sanitari tolti (pz=0)"); } }
    if(!tipo.vvf){ if(r.VVF>0){ r.VVF = 0; fix.push("VVF tolti (li chiede la scena se servono)"); } }
    else { for(const k of ["MSB","MSA","AUTOMEDICA"]) if(r[k]>0){ r[k] = 0; fix.push("sanitari tolti (VVF: scelta libera)"); } }
    if(b.trasporto && !(b.pazienti||[]).length){ b.trasporto = false; fix.push("trasporto spento (nessun paziente)"); }
    return {ok:true, correzioni:fix};
  }
  // feriti non ancora consegnati in PS (qualunque missione)
  function pazientiInSospeso(iv){
    let n = 0; const L = iv.pazienti||[];
    for(let k=0;k<L.length;k++){ if(L[k]!=null && !(iv.pazConsegnati&&iv.pazConsegnati[k]) && statoPaziente(iv,k)<10) n++; }
    return n;
  }
  // c'è almeno un mezzo 118 legato alla missione (in viaggio, sul posto, con paziente, in PS)?
  function aiuto118(iv){
    return mezzi.some(m=>m.interventoId===iv.id && m.corpo!=="VVF" && m.tipo!=="CNSAS" && (m.stato==="viaggio"||m.stato==="sul_posto"||m.stato==="pronto"||m.stato==="trasporto"||m.stato==="ospedale"));
  }
  // mezzi che hanno un paziente a bordo o in carico (mai da chiudere né da rientrare)
  function mezziConPaziente(iv){
    return mezzi.filter(m=>m.interventoId===iv.id && (m.trasportaPz || m.pazIdx!=null || m.affido!=null || m.stato==="pronto"||m.stato==="trasporto"||m.stato==="ospedale"));
  }
  // feriti che aspettano ancora un'ambulanza: missione sanitaria scoperta, oppure VVF
  // con feriti senza alcun 118 legato (chi è gestito sul posto non conta mai)
  function pazientiDaAssistere(iv){
    const n = pazientiInSospeso(iv);
    if(!n || aiuto118(iv)) return 0;
    if(iv.trasporto || iv.vvf) return n;
    return 0;
  }
  // stato operativo per ente (missioni congiunte): ogni corpo chiude la SUA parte,
  // la missione resta aperta finche tutti hanno finito e i pazienti sono consegnati
  function contaEnti(iv){
    let m118 = 0, vvf = 0;
    for(const c of (iv.mezziIds||[])){ const m = mezzi.find(x=>x.codice===c); if(!m) continue; if(m.corpo==="VVF") vvf++; else m118++; }
    return {m118, vvf};
  }
  function notaFineEnte(iv, corpo){
    if(!iv || iv.stato==="chiuso") return;
    const s = contaEnti(iv);
    const altroAttivo = corpo==="VVF" ? s.m118>0 : s.vvf>0;
    const mioResiduo = corpo==="VVF" ? s.vvf : s.m118;
    if(mioResiduo===0 && altroAttivo){
      if(corpo==="VVF" && !iv.fineVVF){ iv.fineVVF = true; logRadio(iaRadio("fineVVF", {comune:iv.comune}, "\uD83D\uDE92 VVF: lavoro concluso a <b>"+iv.comune+"</b> \u2014 il 118 prosegue sulla scena"), "status"); }
      if(corpo!=="VVF" && !iv.fine118){ iv.fine118 = true; logRadio(iaRadio("fine118", {comune:iv.comune}, "\uD83D\uDE91 118: parte sanitaria conclusa a <b>"+iv.comune+"</b> \u2014 i VVF proseguono"), "status"); }
    }
  }
  // quadri clinici per categoria × fascia (g = salute<40, m = 40-70, l = >70)
  const PZ_QUADRI = {
    strada:{ g:["trauma cranico commotivo","emotorace","frattura di bacino","frattura di femore","trauma addominale chiuso","shock emorragico"],
      m:["frattura polso","frattura costale multipla","colpo di frusta severo","ferita lacero-contusa","lussazione spalla","trauma ginocchio"],
      l:["colpo di frusta","contusioni multiple","escoriazioni diffuse","cervicalgia","stato di agitazione"] },
    pesante:{ g:["schiacciamento torace","trauma cranico grave","emotorace","frattura esposta"],
      m:["frattura costale","trauma arto inferiore","ferita lacero-contusa"],
      l:["contusioni","cervicalgia","escoriazioni"] },
    bus:{ g:["trauma cranico","frattura femore","trauma toracico"],
      m:["frattura polso","trauma spalla","ferite da vetri","colpo di frusta"],
      l:["contusioni","escoriazioni","stato di agitazione","cervicalgia"] },
    moto:{ g:["trauma cranico (casco danneggiato)","frattura esposta di gamba","trauma toracico severo","frattura di bacino"],
      m:["frattura clavicola","lussazione spalla","frattura polso","ferita lacero-contusa"],
      l:["escoriazioni estese","contusioni","distorsione caviglia"] },
    bici:{ g:["trauma cranico","frattura anca","trauma toracico"],
      m:["frattura polso","trauma ginocchio","ferita al volto"],
      l:["escoriazioni","contusioni","spavento"] },
    medico:{ g:["arresto cardiaco (RCP)","infarto in atto","ictus in atto","stato di male epilettico","shock anafilattico","overdose con depressione respiratoria","coma ipoglicemico"],
      m:["dolore toracico","dispnea severa","crisi convulsiva (post-critica)","ipoglicemia","crisi ipertensiva","sanguinamento in atto","disidratazione severa"],
      l:["lipotimia","stato ansioso","febbre alta","dolore addominale","emicrania severa","ipertensione","blocco vertebrale acuto","torcicollo","malore risolto"] },
    tossAlim:{ g:["shock settico iniziale","disidratazione grave"],
      m:["vomito incoercibile","dissenteria severa","dolori addominali forti"],
      l:["nausea e vomito","crampi addominali","dissenteria lieve"] },
    api:{ g:["shock anafilattico","edema della glottide"],
      m:["punture multiple al volto","reazione allergica estesa"],
      l:["punture localizzate","reazione cutanea"] },
    caduta:{ g:["trauma cranico","frattura femore","frattura vertebrale","emotorace"],
      m:["frattura polso","trauma spalla","frattura caviglia","ferita al volto"],
      l:["contusione anca","distorsione caviglia","escoriazioni","lombalgia acuta"] },
    incendio:{ g:["ustioni II-III grado diffuse","intossicazione grave da fumo","ustione vie aeree"],
      m:["intossicazione da fumo","ustione mani e volto","ustione arto"],
      l:["irritazione vie aeree","ustione lieve","stato di agitazione"] },
    lavoro:{ g:["schiacciamento arto","amputazione parziale","trauma cranico (casco)","caduta dall'alto"],
      m:["ferita profonda","frattura mano","trauma spalla","ustione chimica"],
      l:["ferita da taglio","contusione","corpo estraneo occhio","distorsione"] },
    aggr:{ g:["accoltellamento addome","trauma cranico severo","ferita d'arma da fuoco"],
      m:["ferite da taglio","frattura naso","trauma facciale","morso esteso"],
      l:["contusioni","escoriazioni","ferita superficiale"] },
    parto:{ g:["emorragia post-partum","eclampsia","emorragia gravidica","apnea neonatale"],
      m:["travaglio avanzato","parto precipitoso","ipertensione gravidica","minaccia d'aborto","emergenza neonatale"],
      l:["travaglio in corso","doglie ravvicinate","rottura acque","ittero neonatale"] },
    cardio:{ g:["arresto cardiaco (RCP)","infarto esteso","shock cardiogeno","FV (defibrillazione)"],
      m:["infarto in atto","dolore toracico tipico","aritmia instabile","edema polmonare"],
      l:["dolore toracico atipico","palpitazioni","crisi ipertensiva","malore risolto"] },
    neuro:{ g:["ictus in atto","stato di male epilettico","coma","emorragia subaracnoidea"],
      m:["ictus sospetto (FAST+)","crisi convulsiva (post-critica)","confusione acuta","paresi in atto"],
      l:["sincope risolta","emicrania severa","vertigini forti","TIA risolto"] },
    resp:{ g:["arresto respiratorio","soffocamento completo","edema della glottide","insufficienza respiratoria grave"],
      m:["dispnea severa","crisi asmatica grave","soffocamento parziale","polmonite con desaturazione"],
      l:["dispnea lieve","crisi asmatica lieve","bronchite acuta","tosse con sangue"] },
    ped:{ g:["convulsioni febbrili prolungate","apnea del neonato","shock settico iniziale","disidratazione grave"],
      m:["convulsioni febbrili","bronchiolite con dispnea","vomito incoercibile","laringite con stridore","ingestione caustici","intossicazione alcolica acuta"],
      l:["febbre alta","vomito","otite acuta","esantema febbrile","corpo estraneo ingerito"] },
    casa:{ g:["folgorazione con arresto","ustione estesa da fiamma","amputazione dito","emorragia grave"],
      m:["ferita profonda mano","ustione di II grado","frattura da caduta domestica","scossa elettrica con ustione"],
      l:["ferita da taglio","scottatura lieve","contusione","corpo estraneo"] },
    crollo:{ g:["schiacciamento torace (crush)","trauma cranico grave","seppellimento con asfissia","fratture multiple"],
      m:["schiacciamento arto","frattura costale","trauma cranico lieve","ferite da macerie"],
      l:["contusioni","escoriazioni","spavento con agitazione"] },
    treno:{ g:["politrauma da investimento","amputazione traumatica","trauma cranico grave"],
      m:["frattura esposta","trauma toracico","ferita grave"],
      l:["contusioni","escoriazioni"] },
    folla:{ g:["schiacciamento da calca","trauma cranico"],
      m:["frattura da caduta","ferite da vetri","contusioni multiple"],
      l:["contusioni","escoriazioni","stato di agitazione","malore da calca"] },
    morsi:{ g:["shock anafilattico","morso al volto con emorragia","necrosi da morso di vipera"],
      m:["morso profondo arto","punture multiple","reazione allergica estesa"],
      l:["morso superficiale","puntura locale","escoriazione"] },
    sport:{ g:["trauma cranico con LOC","frattura esposta","trauma vertebrale"],
      m:["frattura","lussazione spalla","commozione cerebrale","distorsione severa"],
      l:["distorsione","contusione","crampo severo","epistassi"] },
    folgor:{ g:["arresto da folgorazione (RCP)","ustioni di ingresso/uscita"],
      m:["folgorazione con ustioni alle mani","scossa con perdita di coscienza"],
      l:["scossa senza perdita di coscienza","formicolio agli arti"] },
    autol:{ g:["impiccamento (ipossia cerebrale)","tagli profondi ai polsi","intossicazione massiva da farmaci"],
      m:["tentato suicidio farmacologico","tagli superficiali multipli","precipitazione intenzionale"],
      l:["ideazione suicidaria","autolesioni superficiali","stato di agitazione"] },
    trauma:{ g:["emorragia grave da arto","frattura esposta","trauma cranico con vomito","shock emorragico"],
      m:["frattura","lussazione","distorsione severa","ferita profonda","emorragia in atto","corpo estraneo ingerito (pila)","ingestione caustici","epistassi severa","ustione da vapore","incastramento arto"],
      l:["ferita da taglio","epistassi lieve","corpo estraneo occhio/orecchio","contusione","distorsione","dermatite da contatto","bimbo chiuso (vigile, da valutare)"] },
    acqua:{ g:["annegamento (RCP)","ipotermia severa","arresto da annegamento","trauma da impatto in acqua"],
      m:["inalazione di acqua","ipotermia moderata","affaticamento da nuoto","ferite da scogli/elica"],
      l:["principio di ipotermia","spavento","crampo","bagnante esausto"] },
  };
  function etaPerContesto(cat, nome){
    const n = (nome||"").toLowerCase(), R = Math.random();
    if(/scuola|bambin|bimbo|asilo|oratorio|parco giochi|pedibus|neonato|lattante/.test(n)) return R<0.6?rndi(4,13):R<0.8?rndi(14,19):rndi(25,45);
    if(/anzian|nonn|casa|demenza|alzheimer|badante|ospizio|rsa|solitudine/.test(n)) return R<0.7?rndi(70,94):rndi(50,69);
    if(/sport|partita|campo|palestra|piscina|maratona|sci\b|snowboard|calcio|rugby|tennis|basket|discoteca|bar|stadio|concerto|festa|rave/.test(n)) return R<0.55?rndi(16,29):R<0.9?rndi(30,50):rndi(51,70);
    if(cat==="lavoro") return rndi(20,60);
    if(cat==="parto") return rndi(20,40);
    if(cat==="ped") return R<0.7 ? rndi(1,10) : rndi(11,17);
    if(R<0.08) return rndi(4,14);
    if(R<0.22) return rndi(15,29);
    if(R<0.62) return rndi(30,64);
    return rndi(65,94);
  }
 function profiloPaziente(sal, tipoNome, cat, usati){
   const s = Math.round(sal);
   const band = s<40 ? "g" : s<=70 ? "m" : "l";
   const sesso = (cat==="parto") ? "F" : (Math.random()<0.5 ? "M" : "F");
   const eta = etaPerContesto(cat, tipoNome);
   let cosc;
   if(s<20) cosc = "incosciente";
   else if(s<35) cosc = "soporoso";
   else if(s<55) cosc = (cat==="medico"||cat==="tossAlim") ? (Math.random()<0.5?"confuso":"dispneico") : "confuso";
   else cosc = "cosciente";
    // intrappolato prima del quadro: l'incastrato pesca quadri da incastro se ci sono
    const _intrArg = (arguments.length>4) ? arguments[4] : null;
    const intr = (_intrArg!=null) ? _intrArg : tiraIntr(cat, tipoNome, s);
   // quadro dalla piscina di categoria, senza ripetere lo stesso nell'intervento (salvo esaurimento)
   const pool = (PZ_QUADRI[cat]||PZ_QUADRI.medico)[band] || PZ_QUADRI.medico[band];
    const coer = quadroCoerente(pool, tipoNome, intr, usati);
    let quadro;
    if(coer){ quadro = coer; }
    else {
      const freschi = pool.filter(q=>!usati.has(q));
      const src = freschi.length ? freschi : pool;
      quadro = src[rndi(0,src.length-1)];
    }
   usati.add(quadro);
   // vitali simulati coerenti con la gravità (dispnea/fumo abbassano la Sat)
   let vit;
   if(s<18 && /arresto|annegamento|RCP/.test(quadro)) vit = "RCP in corso";
   else {
     const disp = /dispnea|fumo|inalazione|anneg|polmon|asma|ustione vie/.test(quadro);
     const fc = s<40 ? rndi(120,145) : s<=70 ? rndi(95,118) : rndi(68,95);
     const sat = s<40 ? rndi(82,90) : s<=70 ? rndi(91,95) : rndi(96,99);
     const pa = s<40 ? rndi(80,100) : s<=70 ? rndi(100,120) : rndi(110,140);
     vit = "FC"+fc+" Sat"+Math.max(70,sat-(disp?5:0))+"% PA"+pa;
   }
   // priorità di soccorso (triage) dalla salute: il colore si vede nella scheda
   const t = s<25 ? 1 : s<50 ? 2 : s<75 ? 3 : 4;
   return { s:sesso, e:eta, c:cosc, q:quadro, v:vit, intr, t };
  }
  // ---------- NUMERO DINAMICO DEI PAZIENTI: la centrale parte da info incomplete ----------
  // La VERITÀ dello scenario (quanti sono DAVVERO i coinvolti) nasce alla creazione come
  // prima (sanitarie: tipo.pz esatto; VVF: pzvConta; maxi 5-15 / MANV 1-8 espliciti) ma la
  // centrale ne conosce solo una parte: i NOTI viaggiano in b.pazienti, gli altri restano
  // in b.pazientiNascosti e li scoprono le squadre sul posto (scopriPazienti in scenaTick:
  // scheda creata, statistiche e ambulanze aggiornate). Mai inventare un numero certo: se
  // il chiamante non sa dire, pazIgnoti=true; finché ci sono verifiche aperte,
  // pazDaVerificare=true (poi le squadre confermano il totale o che non c'è nessun altro).
  function stimaInizialePazienti(tipo, N, isGrande){
    const nome = (tipo && tipo.nome) || "";
    const cat = pazCat(nome);
    const fuoco = (cat==="incendio" || cat==="crollo");
    if(!(N>0)){
      // nessun ferito (o disperso non trovato): da verificare solo se il chiamante
      // teme qualcuno sotto le macerie o disperso (crolli/ricerche VVF)
      const cerca = !!tipo.vvf && /dispers|scompars|smarrito|ricerca|sepol|possibili sepolti|croll/i.test(nome+" "+(tipo.desc||""));
      return {noti:0, ignoti:cerca, verifica:cerca};
    }
    if(isGrande) return {noti:N, ignoti:false, verifica:false}; // maxi/MANV: conteggio esplicito dell'evento
    if(N>=3 && !tipo.vvf && TRE_VEICOLI_RE.test(nome)) return {noti:N, ignoti:false, verifica:false}; // 3+ veicoli visti dal chiamante: tutti i feriti noti da subito
    if(N===1){
      if(fuoco) return {noti:1, ignoti:false, verifica:true}; // visto uno, ma dentro potrebbero essercene altri
      return {noti:1, ignoti:false, verifica:false}; // soccorso singolo: un solo paziente noto
    }
    if(fuoco) return {noti:1, ignoti:true, verifica:true}; // fumo/macerie: numero sconosciuto
    if(cat==="bus" || cat==="folla" || N>=5) return {noti:Math.min(2,N), ignoti:true, verifica:true};
    return {noti:1, ignoti:false, verifica:true}; // stradale & co.: almeno uno visto, altri da verificare
  }
  // divide la verità completa in noti/nascosti (idempotente: su bozza già divisa ritrova lo stesso split)
  function applicaStimaPazienti(b, tipo){
    const allS = (b.pazienti||[]).concat(b.pazientiNascosti||[]);
    const allP = (b.profili||[]).concat(b.profiliNascosti||[]);
    const st = stimaInizialePazienti(tipo, allS.length, !!(b.maxi||b.manv));
    b.pazienti = allS.slice(0, st.noti);
    b.profili = allP.slice(0, st.noti);
    b.pazientiNascosti = allS.slice(st.noti);
    b.profiliNascosti = allP.slice(st.noti);
    b.pazIgnoti = st.ignoti;
    b.pazDaVerificare = st.verifica;
    return st;
  }
  // genera l'equipaggio di feriti di una chiamata: {salute[], profili[], illesi, evac, cat, variante}
  // REGOLA: sanitarie = ESATTAMENTE le persone coinvolte nei dati (tipo.pz);
  // VVF = numero dinamico per tipologia di scenario (PZV_TAB via pzvBucket).
  // È la VERITÀ dello scenario (tutti i coinvolti): la centrale ne conosce solo una parte
  // (applicaStimaPazienti divide noti/nascosti); la variante di gravità sposta solo la salute.
  function generaPazienti(prio, tipo){
    const nome = tipo ? tipo.nome : "";
    const cat = pazCat(nome);
    const pzv = tipo && tipo.vvf ? pzvBucket(nome, tipo.desc) : null;
    const ptab = pzv ? PZV_TAB[pzv] : null;
    const triplo = !!tipo && !tipo.vvf && TRE_VEICOLI_RE.test(nome); // 3+ veicoli: 0-6 feriti di qualsiasi gravita (niente numero fisso dai dati)
    const nP = ptab ? pzvConta(tipo) : (triplo ? rndi(0,6) : (tipo ? (tipo.pz ?? 1) : 1));
    if(!(nP>0)) return { salute:[], profili:[], illesi:0, evac:0, cat, variante:"media", pzv };
    // variante di gravità dell'evento: sposta solo la salute, mai il numero
    const vv = varianteGravita(prio);
    const n = Math.max(1, Math.round(nP));
    // P1 (il segnalato) dai dati; gli altri dall'unione dati+bucket: lo scenario
    // allarga il ventaglio (lievi/gravi/critici), la coerenza resta nei testi
    const sal0 = (tipo && tipo.sal) ? tipo.sal : (ptab ? ptab.sal : null);
    const salW = (ptab && tipo && tipo.sal && ptab.sal) ? [Math.min(tipo.sal[0], ptab.sal[0]), Math.max(tipo.sal[1], ptab.sal[1])] : sal0;
   const grave = (prio===1);
   let salute = [], profili = [];
   const usati = new Set();
    // gravità dinamica dell'evento (stessa per tutti i feriti: è la violenza di QUESTA missione)
    const din = dinamicaGravita(nome, tipo ? tipo.desc : "");
   for(let i=0;i<n;i++){
     const range = triplo ? null : ((i===0) ? sal0 : (salW || sal0));
      let s = triplo ? rndi(5,95) : (range ? triRange(range[0], range[1]) : salutePaziente(prio, tipo));
     if(range && i>0){
       // coerenza gravità: i successivi di solito più lievi, a volte peggio (eccezione plausibile)
       const r = Math.random(), mid = (range[0]+range[1])/2;
       if(grave) s = r<0.5 ? s : r<0.8 ? rndi(mid,range[1]) : rndi(range[0],mid);
       else s = r<0.65 ? rndi(mid,range[1]) : r<0.9 ? s : rndi(range[0],mid);
     }
      // variante evento + dinamica + jitter per paziente; l'incastrato perde di più
      s = Math.max(3, Math.min(99, Math.round(s + vv.ds + din.ds + rndi(-3,3))));
      const intr = tiraIntr(cat, nome, s);
      if(intr) s = Math.max(3, s-6);
      salute.push(s);
      profili.push(profiloPaziente(s, nome, cat, usati, intr));
    }
    // ordina per gravità: il più grave è P1 (l'ordine resta fisso per tutta la gestione)
    const ord = salute.map((s,i)=>i).sort((a,b)=>salute[a]-salute[b]);
    salute = ord.map(i=>salute[i]); profili = ord.map(i=>profili[i]);
    // niente "illesi non trasportati": ogni persona sulla scena è un paziente da valutare,
    // stabilizzare e portare in PS (1 paziente = 1 mezzo). I coinvolti sono ESATTAMENTE
    // quelli dei dati (sanitarie: tipo.pz; VVF: intervallo PZV; tripli a 3+ veicoli: 0-6): nessuno in più, nessuno in meno.
    // max 2 intrappolati per intervento
    let visti = 0;
    for(const p of profili){ if(p.intr){ visti++; if(visti>2) p.intr = false; } }
    // contorno: evacuati (incendi, crolli) — gli illesi non esistono più (vedi sopra)
    let evac = 0;
    if(cat==="incendio" && Math.random()<0.5) evac = rndi(1,6);
    else if(cat==="crollo" && Math.random()<0.4) evac = rndi(1,8);
    return { salute, profili, illesi: 0, evac, cat, variante: vv.k, vds: vv.ds, pzv };
  }
  // aggiunge UN ferito a liste esistenti (maxi/MANV: conteggi espliciti dell'evento): salute + profilo coerente.
  // vds = scarto di gravità dell'evento (dalla sua variante): il rinforzo condivide la violenza
  // della scena, come i feriti base (senza: resterebbe sistematicamente più lieve negli eventi gravi/critici)
  function pushPaziente(salArr, profArr, prio, tipo, vds){
    const s = Math.max(3, Math.min(99, salutePaziente(prio, tipo) + (vds||0)));
    salArr.push(s);
    const us = new Set((profArr||[]).map(p=>p.q));
    profArr.push(profiloPaziente(s, tipo?tipo.nome:"", pazCat(tipo?tipo.nome:""), us));
    return s;
  }
  // riga radio/dettaglio: il quadro peggiore senza rivelare il tipo vero
  function quadroPeggiore(iv){
    const Lq = iv.pazienti||[];
    let bi = -1;
    for(let k=0;k<Lq.length;k++){ if(Lq[k]==null || !pazAttivo(iv,k)) continue; if(bi<0 || Lq[k]<Lq[bi]) bi = k; }
    if(bi<0) return null;
    const p = (iv.profili||[])[bi];
    if(!p) return null;
    return `quadro peggiore: ${p.q} (${p.c}, salute ${Math.round(Lq[bi])}%)`;
  }
  // scheda intervento stile LSTSim: una riga per paziente con % colorata + stato trasporto a destra
  function saluteCol(s){
    const v = Math.round(s);
    if(v<30) return "#d40000";
    if(v<55) return "#e04e00";
    if(v<80) return "#a86a00";
    return "#2e8b57";
  }
  // sigla ospedale tipo "H Varese" / "H Lecco" (città = ultima parola del nome; Busto Arsizio e Carate Brianza per intero)
  function ospShort(nome){
    if(!nome) return "";
    const w = String(nome).split(" ");
    const last = w[w.length-1] || "";
    const prev = w.length>1 ? w[w.length-2] : "";
    const city = (prev==="Busto"||prev==="Carate") ? prev+" "+last : last;
    return "H " + city;
  }
 function codQuad(prio){
  if(!(prio>0)) return "";
  const L = prio===1?"R":prio===2?"G":prio===3?"V":"B";
  const N = prio===1?"ROSSO":prio===2?"GIALLO":prio===3?"VERDE":"BIANCO";
  return `<span class="trasQ" style="background:${prioColor(prio)}" title="Codice trasporto: ${N}">${L}</span>`;
 }
 function pazientiHTML(iv){
    const list = (iv.pazienti||[]).filter(x=>x!=null);
    if(!list.length) return `👤 Nessun ferito`;
    const claimedIdx = new Set(claimants(iv.id).map(m=>(m.pazIdx!=null?m.pazIdx:m.affido)));
    const righe = list.map((s,k)=>{
      const p = (iv.profili||[])[k];
      const tcol = prioColor((p&&p.t)||4);
      const dot = p ? `<span class="prioDot" style="background:${tcol}" title="triage P${p.t||4}"></span> ` : "";
      const _crit = !!((s!=null && s<SOGLIA_MSA && pazAttivo(iv,k)) && !msaAssegnatoA(iv,k)); // scritta MSA solo sotto il 35%: sopra sparisce (anche col flag di gestione ancora attivo); alla presa in carico sparisce
      const base = `Paziente ${k+1}: <b style="color:${saluteCol(s)}">${Math.round(s)}%</b>${_crit?' <b style="color:#d40000">MSA</b>':""}`;
      const bis = bisognoPaziente(iv,k);
      const st = statoPaziente(iv,k);
      const _rifOk = iv.trasporto && iv.reportFatto && (st===4||st===6) && Math.round(s)>=70;
      let tag = "";
      if(st===10) tag = `<span style="color:#2e8b57">✅ ${ospShort((iv.pazDest&&iv.pazDest[k])||"")}${codQuad(iv.prio)}</span>`;
      else if(st===11) tag = `<span style="color:#2e8b57">✅ concluso sul posto</span>`;
      else if(st===12) tag = `✋ rifiuto registrato`;
      else if(st===13) tag = `🕊 deceduto`;
      else if(st===14) tag = `✅ concluso`;
      else if(st===9){ const _d=(iv.pazDest&&iv.pazDest[k])||""; tag = _d?("🚑 "+ospShort(_d)+codQuad(iv.prio)):"🚑 in trasporto"; }
      else if(st===8){ const _cm=mezzi.find(m=>m.interventoId===iv.id&&m.pazIdx===k&&m.trasportaPz); tag = _cm?("🚑 a bordo ("+nomem(_cm)+")"):"🚑 a bordo"; }
      else if(st===7){ const _am=(iv.affidi&&iv.affidi[k])?mezzi.find(m=>m.codice===iv.affidi[k]):null; tag = _am?("👨‍⚕️ in carico ("+nomem(_am)+")"):"👨‍⚕️ preso in carico"; }
      else if(st===5) tag = `🔒 in attesa di liberazione`;
      else if(!iv.trasporto) tag = "gestito sul posto";
      else if(st===6) tag = "⏳ in attesa di ambulanza"+(_rifOk?` <button class="lstBtn small" data-rif="${k}" title="Registra rifiuto del trasporto">✋</button>`:"");
      else if(st===4) tag = "🩺 in valutazione"+(_rifOk?` <button class="lstBtn small" data-rif="${k}" title="Registra rifiuto del trasporto">✋</button>`:"");
      else if(st===3) tag = "⏳ in attesa di soccorso";
      else if(st===2) tag = "🔍 da valutare";
      else tag = "🚨 segnalato";
      return `<div style="display:flex;justify-content:space-between;gap:12px;padding:1px 0"><span>${base}</span><span style="color:#777">${tag}</span></div>`;
    });
    let extra = "";
    if(iv.evac>0) extra += `<div>🏃 Da evacuare: ${iv.evac}</div>`;
    return `${righe.join("")}${extra}`;
  }
  // luogo senza doppioni: natura/lago hanno già "VIA - COMUNE" nell'indirizzo
  function luogoIV(o, bold){
    const c = bold ? `<b>${o.comune}</b>` : o.comune;
    if(o.indirizzo.slice(-(" - "+o.comune).length)===" - "+o.comune) return `${o.indirizzo} (${o.prov})`;
    return `${o.indirizzo}, ${c} (${o.prov})`;
  }
  // via reale della città (verificate) o nome generico per i piccoli comuni
  function viaDaComune(nome){
    const l = (D().VIE_CITTA||{})[nome];
    const arr = (l && l.length) ? l : D().VIE;
    return arr[rndi(0,arr.length-1)];
  }

  function generaN(n, prov=null){
    for(let i=0;i<n;i++) makeChiamata(prov);
  }

  // ---------- MEZZI ----------
    // Categorie operative esplicite (spec §1-2, §6): VVF = tecnico (non sanitario),
  // AMBULANZA = MSB (assistenza + trasporto, cap 1), MSI_MSA = MSA/AUTOMEDICA/ELI
  // (soccorso avanzato; MSI e MSA stessa categoria; ELI e DRAGO153 trasportano per
  // configurazione esplicita del mezzo, non per la categoria). Mai dedurre dai nomi.
  function catDaTipo(tipo, corpo){
    if(corpo==="VVF") return "VVF";
    if(tipo==="MSB") return "AMBULANZA";
    return "MSI_MSA";
  }
  function initMezzi(){
    mezzi = D().MEZZI.map((m,i)=>{
      const sede = D().SEDI.find(s=>s.nome===m.sede) || D().SEDI[0];
     return {
       idx:i, codice:m.codice, tipo:m.tipo, sede:m.sede, prov:sede.prov, corpo:"118", cat:catDaTipo(m.tipo,"118"), cap:((m.tipo==="MSB"||m.tipo==="ELI"||m.trasp)?1:0), trasporto:(m.tipo==="MSB"||m.tipo==="ELI"||!!m.trasp), clinica:(m.tipo==="MSB"?"base":"avanzata"),
        turno:(m.turno||null), autoFS:false,
       baseLat:sede.lat, baseLng:sede.lng,
       lat:sede.lat+rnd(-0.004,0.004), lng:sede.lng+rnd(-0.004,0.004),
       stato:"disponibile", interventoId:null,
       targetLat:null, targetLng:null,
       sulPostoTimer:0, ospedale:null, pazIdx:null, affido:null, tArrivo:null,
     };
   });
    for(const mz of mezzi){ if(mz.turno && !turnoAttivo(mz)){ mz.stato="fuori_servizio"; mz.autoFS=true; } } // a quest'ora il turno non è attivo: parte fuori servizio
    // mezzi VVF: stanno nello stesso array (stesso routing/movimento), con corpo "VVF"
    for(const m of (D().MEZZI_VVF||[])){
      const sede = D().VVF_SEDI.find(s=>s.nome===m.sede) || D().VVF_SEDI[0];
      mezzi.push({
        idx:mezzi.length, codice:m.codice, tipo:m.tipo, radio:m.radio||null, sede:m.sede, prov:sede.prov, corpo:"VVF", cat:"VVF", cap:(m.tipo==="ELI"?1:0), trasporto:(m.tipo==="ELI"), clinica:"tecnica",
        baseLat:sede.lat, baseLng:sede.lng,
        lat:sede.lat+rnd(-0.004,0.004), lng:sede.lng+rnd(-0.004,0.004),
        stato:"disponibile", interventoId:null,
        targetLat:null, targetLng:null,
        sulPostoTimer:0, ospedale:null, pazIdx:null, affido:null, tArrivo:null,
      });
    }
  }


 function mezziDisponibili(tipoWanted=null, corpoWanted=null){
 
    return mezzi.filter(m=>m.stato==="disponibile" && (!tipoWanted || m.tipo===tipoWanted) && (!corpoWanted || m.corpo===corpoWanted));
  }

  function nearestMezzo(lat,lng,tipoWanted=null,corpoWanted=null){
    let best=null,bd=1e9;
    for(const m of mezziDisponibili(tipoWanted,corpoWanted)){
      const d=haversineKm(lat,lng,m.lat,m.lng);
      if(d<bd){bd=d;best=m;}
    }
    // fallback: qualunque disponibile se tipo non trovato
    if(!best && tipoWanted){
      for(const m of mezziDisponibili(null,corpoWanted)){
        const d=haversineKm(lat,lng,m.lat,m.lng);
        if(d<bd){bd=d;best=m;}
      }
    }
    return best;
  }

  // disciplina radio: l'invio iniziale alla creazione e annunciato una sola volta
  // da accettaChiamata (un messaggio + un ricevuto); qui parla solo chi arriva dopo
  // (assistenza, dirottamenti): niente duplicati con l'invio iniziale
  function assegnaMezzo(mezzoCodice, interventoId, silent){
    const mz = mezzi.find(m=>m.codice===mezzoCodice);
    const iv = interventi.find(x=>x.id===interventoId);
    if(!mz||!iv) return false;
    // con paziente a bordo non si dirotta
    if(mz.stato==="trasporto"||mz.stato==="ospedale"||mz.stato==="pronto"||mz.affido!=null){ toast(`${mz.codice} ha il paziente a bordo: non dirottabile`); return false; }
    if(!["disponibile","viaggio","rientro","sul_posto"].includes(mz.stato)){ toast(`${mz.codice} non disponibile`); return false; }
    if(iv.stato==="chiuso") return false;
    // gia collegato alla stessa missione: collega la richiesta esistente, niente duplicati
    if(mz.interventoId===iv.id && iv.mezziIds.includes(mz.codice)){ ensureSupporti(iv); return true; }
    // dirottamento: stacca dal vecchio intervento, riparte da dove si trova (nessun teletrasporto)
    const dirottato = mz.interventoId!=null && mz.interventoId!==iv.id;
    let oldId = null;
    if(dirottato){
      const old = interventi.find(x=>x.id===mz.interventoId);
      oldId = (old && old.id!=null) ? old.id : mz.interventoId;
      if(old){
        old.mezziIds = old.mezziIds.filter(c=>c!==mz.codice);
        suppLog(old, gruppoSupporto(mz), "deviato", mz.codice, "alla missione " + iv.id);
        notaFineEnte(old, mz.corpo==="VVF"?"VVF":"118");
        if(old.mezziIds.length===0 && old.stato!=="chiuso") old.stato="attesa";
        checkChiusura(old);
      }
    }
    { const _o = mz.interventoId!=null ? interventi.find(x=>x.id===mz.interventoId) : null; if(_o && _o.affidi){ for(const _k in _o.affidi){ if(_o.affidi[_k]===mz.codice){ delete _o.affidi[_k]; if(statoPaziente(_o,+_k)===7) setStatoPaziente(_o,+_k,6,"rilascio: mezzo riassegnato"); } } } }
    mz.interventoId=iv.id; mz._t0=clockMin; mz.sulPostoTimer=0; mz.atteseFollow=0; mz.ospedale=null; mz.ospedaleScelto=null; mz.trasportaPz=false; mz.pazIdx=null; mz.affido=null; mz.tArrivo=null;
    const esceDallaSede = (mz.stato==="disponibile");
    vaiA(mz, iv.accLa!=null?iv.accLa:iv.lat, iv.accLng!=null?iv.accLng:iv.lng, "viaggio"); // ferroviarie: i mezzi vanno all'accesso, mai sui binari
    if(esceDallaSede) mz.uscita = turnoutPrio(iv.prio); // equipaggio in uscita: 30" sul rosso, 60" sul bianco
    if(!iv.mezziIds.includes(mz.codice)) iv.mezziIds.push(mz.codice);
    if(iv.stato==="attesa") iv.stato="viaggio";
    suppLog(iv, gruppoSupporto(mz), dirottato ? "dirottato" : "assegnato", mz.codice, dirottato && oldId!=null ? ("dalla missione " + oldId) : null);
    if(!silent) log(`${mz.corpo==="VVF"?"🚒":(mz.tipo==="AUTOMEDICA"||isMedica(mz))?"🚓":"🚑"} ${nomem(mz)} ${dirottato?"dirottato a":"→"} <b>${iv.comune}</b>`, "status");
    refreshMarkers(); renderListe(); updateStats();
    statAssegna(mz); // statistiche: invio mezzo
    invioBatch(); // raggruppa gli invii ravvicinati: un solo bip se partono 2+ mezzi insieme
    return true;
  }

  // ---------- ROUTING SU STRADE REALI (niente linea d'aria) ----------
  const routeCache = new Map();
  function cacheKey(a,b,c,d){ return [a,b,c,d].map(v=>v.toFixed(4)).join(","); }
  async function fetchRoute(lat1,lng1,lat2,lng2){
    const key = cacheKey(lat1,lng1,lat2,lng2);
    if (routeCache.has(key)) return routeCache.get(key);
    try{
      const ctl = new AbortController();
      const to = setTimeout(()=>ctl.abort(), 9000);
      const url = `https://router.project-osrm.org/route/v1/driving/${lng1},${lat1};${lng2},${lat2}?overview=full&geometries=geojson&alternatives=false&steps=false&annotations=speed,distance`;
      const r = await fetch(url, {signal: ctl.signal});
      clearTimeout(to);
      const j = await r.json();
      if (j && j.code==="Ok" && j.routes && j.routes[0]){
        const coords = j.routes[0].geometry.coordinates.map(p=>[p[1],p[0]]);
        const res = {coords};
        // tempi/distanza reali del percorso: la velocita media (alta in autostrada) guida il mezzo
        res.duration = j.routes[0].duration; res.distance = j.routes[0].distance;
        // velocita reali per segmento (m/s): in autostrada ~30 (=108 km/h), in citta ~3-8
        try{ const an = (j.routes[0].legs[0]||{}).annotation||{}; res.anSpeed = an.speed||null; res.anDist = an.distance||null; }catch(_){ res.anSpeed = null; res.anDist = null; }
        if (routeCache.size>200) routeCache.clear(); // le annotazioni di velocita allargano le entry
        routeCache.set(key, res);
        return res;
      }
    }catch(e){}
    return null;
  }
  function setPath(mz, coords, segVel){
    mz.path = coords; mz.segVel = segVel||null; // km/h per segmento (reali OSRM) o null = media uniforme
    mz.segLens = [];
    for(let i=0;i<coords.length-1;i++) mz.segLens.push(haversineKm(coords[i][0],coords[i][1],coords[i+1][0],coords[i+1][1]));
    mz.segIdx = 0; mz.segProg = 0;
  }
  // velocita contenute: sotto il limite reale (90%; automediche 95%).
  // Autostrade (tratto OSRM >= 90): la reale.
  function lstSegVel(kmh, mz){
    if(kmh>=90) return kmh;
    if(mz && mz.tipo==="AUTOMEDICA") return kmh*0.95;
    return kmh*0.9;
  }
  // allinea le velocita OSRM (una per segmento annotato) ai punti della geometria:
  // ogni tratto eredita la velocita del segmento che lo contiene (LSTSim sotto i 90, reale sopra; 30-130)
  function alignSegVel(full, res, mz){
    try{
      if(!res || !res.anSpeed || !res.anDist || res.anSpeed.length!==res.anDist.length || !res.anSpeed.length) return null;
      const cum=[0]; for(const d of res.anDist) cum.push(cum[cum.length-1]+d/1000);
      const cumG=[0]; for(let i=0;i<full.length-1;i++) cumG.push(cumG[cumG.length-1]+haversineKm(full[i][0],full[i][1],full[i+1][0],full[i+1][1]));
      const totalAn = cum[cum.length-1], totalG = cumG[cumG.length-1];
      if(!(totalAn>0) || !(totalG>0)) return null;
      const scale = totalAn/totalG;
      const out=[]; let j=0;
      for(let i=0;i<full.length-1;i++){
        const m = (cumG[i]+cumG[i+1])/2*scale;
        while(j<cum.length-2 && cum[j+1] < m) j++;
        const ms = Math.max(8, Math.min(36, res.anSpeed[j]||0));
        out.push(Math.round(Math.max(30, Math.min(130, lstSegVel(ms*3.6, mz)))));
      }
      return (out.length===full.length-1) ? out : null;
    }catch(_){ return null; }
  }
  // imposta destinazione: subito dritto (fallback), poi percorso stradale appena arriva (gli eli restano in linea d'aria)
  function vaiA(mz, lat, lng, stato){
    mz.stato = stato;
    mz.uscita = 0; // riparte da dove si trova: l'attesa di uscita la arma assegnaMezzo solo uscendo dalla sede
    if(stato==="viaggio") mz.atteseFollow = 0; // nuova missione: azzera attese
    if(stato==="rientro" && mz.trasportaPz && mz.pazIdx!=null){
      const ivR = interventi.find(x=>x.id===mz.interventoId);
      if(ivR && !(ivR.pazConsegnati && ivR.pazConsegnati[mz.pazIdx])){ // rete di sicurezza: il paziente torna in attesa, mai perso
        if(ivR.trasporto) ivR.daTrasportare = (ivR.daTrasportare||0)+1;
        if(ivR.pazDest) delete ivR.pazDest[mz.pazIdx];
        console.warn("[COEU] rientro con paziente a bordo: "+pazUid(ivR,mz.pazIdx)+" rimesso in attesa");
      }
      mz.trasportaPz = false; mz.pazIdx = null;
    } else if(stato==="rientro"){
      if(mz.affido!=null){ const ivA = interventi.find(x=>x.id===mz.interventoId); if(ivA){ if(ivA.affidi) delete ivA.affidi[mz.affido]; if(statoPaziente(ivA,mz.affido)===7) setStatoPaziente(ivA,mz.affido,6,"rilascio: rientro"); } mz.affido=null; }
      mz.trasportaPz = false; mz.pazIdx = null;
    }
   mz.targetLat = lat; mz.targetLng = lng;
   setPath(mz, [[mz.lat,mz.lng],[lat,lng]]);
    mz.velKmh = null; // in attesa del percorso reale: 50 fissi, poi la media dei tratti
    if(isEli(mz)) { refreshRoutes(); return; } // elisoccorso: niente strade, dritto per dritto
    const fromLat = mz.lat, fromLng = mz.lng;
    const stillThere = () => mz.targetLat===lat && mz.targetLng===lng &&
      (mz.stato==="viaggio"||mz.stato==="trasporto"||mz.stato==="rientro");
   const apply = (res) => {
     if (!res || !stillThere()) return false;
      const full = [[mz.lat,mz.lng], ...res.coords.slice(1)];
      const sv = alignSegVel(full, res, mz); // tratti LSTSim (autostrada = reale)
      if(sv){ let tot=0, wsum=0; for(let qi=0;qi<sv.length;qi++){ const L=haversineKm(full[qi][0],full[qi][1],full[qi+1][0],full[qi+1][1]); tot+=sv[qi]*L; wsum+=L; }
        if(wsum>0) mz.velKmh = Math.max(30, Math.min(115, Math.round(tot/wsum))); }
      else if(res.distance>0 && res.duration>0){
        const v = (res.distance/1000)/(res.duration/3600);
        mz.velKmh = Math.max(30, Math.min(115, Math.round(v))); // fallback: media reale
      }
      setPath(mz, full, sv); // velocita per tratto: base realistica, in autostrada si corre davvero
      for(const e of ospMarkers){ try{ e.marker.setTooltipContent(ospTooltipHTML(e.osp)); }catch(_){} }
      try{ if(pmaMarker) pmaMarker.setTooltipContent(pmaTooltipHTML()); }catch(_){}
    refreshRoutes();
      return true;
    };
    fetchRoute(fromLat, fromLng, lat, lng).then(res=>{
      if (apply(res)) return;
      // un solo retry dopo 5s (es. rate-limit temporaneo del servizio)
      setTimeout(()=>{ fetchRoute(mz.lat, mz.lng, lat, lng).then(apply); }, 5000);
    });
  }
  // avanza di gameHours ore: con velocita quasi reale per tratto (autostrada = reale),
  // senza (fallback/eli/nebbia) con la media uniforme
  function advanceAlongPath(mz, gameHours){
    if(!mz.path || mz.path.length<2 || !mz.segLens){
      setPath(mz, [[mz.lat,mz.lng],[mz.targetLat,mz.targetLng]]);
    }
    const uni = isEli(mz) ? 180 : (meteo.cond==="Nebbia" ? 50 : (mz.velKmh||50));
    const sv = (mz.segVel && mz.segVel.length===mz.segLens.length && meteo.cond!=="Nebbia" && !isEli(mz)) ? mz.segVel : null;
    let guard = 0;
    if(sv){
      let tLeft = gameHours;
      while(tLeft>0 && mz.segIdx < mz.segLens.length && guard++<8000){
        const segLen = mz.segLens[mz.segIdx];
        if(segLen < 1e-9){ mz.segIdx++; mz.segProg=0; continue; }
        const v = Math.max(20, (sv[mz.segIdx]||uni)*medMult(mz)); // km/h su questo tratto (medicalizzate +25% verso scena)
        const left = segLen - mz.segProg;
        const tNeed = left/v; // ore per finire il tratto
        if(tLeft < tNeed){ mz.segProg += tLeft*v; tLeft=0; }
        else { tLeft -= tNeed; mz.segIdx++; mz.segProg=0; }
      }
    } else {
      let remaining = uni*medMult(mz)*gameHours;
      while(remaining>0 && mz.segIdx < mz.segLens.length && guard++<5000){
        const segLen = mz.segLens[mz.segIdx];
        if (segLen < 1e-9){ mz.segIdx++; mz.segProg=0; continue; }
        const left = segLen - mz.segProg;
        if(remaining < left){ mz.segProg += remaining; remaining=0; }
        else { remaining -= left; mz.segIdx++; mz.segProg=0; }
      }
    }
    if(mz.segIdx >= mz.segLens.length){ mz.lat=mz.targetLat; mz.lng=mz.targetLng; return true; }
    const a=mz.path[mz.segIdx], b=mz.path[mz.segIdx+1];
    const f=mz.segLens[mz.segIdx]>0?mz.segProg/mz.segLens[mz.segIdx]:1;
    mz.lat=a[0]+(b[0]-a[0])*f; mz.lng=a[1]+(b[1]-a[1])*f;
    if(haversineKm(mz.lat,mz.lng,mz.targetLat,mz.targetLng)<0.08) return true;
    return false;
  }

  function autoAssegna(interventoId){
    const iv = interventi.find(x=>x.id===interventoId);
    if(!iv) return;
    if(iv.vvf){ toast("🚒 Intervento VVF: scegli i mezzi a mano"); return; }
    // prova a soddisfare richiesti: MSA, AUTOMEDICA, MSB in ordine
    const ordine = ["AUTOMEDICA","MSA","MSB"];
    let assegnati=0;
    // conta già assegnati per tipo
    const countByType = {};
    for(const c of iv.mezziIds){
      const m = mezzi.find(x=>x.codice===c);
      if(m) countByType[m.tipo]=(countByType[m.tipo]||0)+1;
    }
    for(const t of ordine){
      const need = (iv.richiesti[t]||0) - (countByType[t]||0);
      for(let k=0;k<need;k++){
        const mz = nearestMezzo(iv.lat,iv.lng,t,"118");
        if(mz && assegnaMezzo(mz.codice, iv.id)){ assegnati++; countByType[t]=(countByType[t]||0)+1; }
      }
    }
    // se ancora nessun mezzo e serve assistenza sanitaria, manda il più vicino qualsiasi (solo 118: i VVF si scelgono a mano)
    const needTot = Object.values(iv.richiesti||{}).reduce((a,b)=>a+(b||0),0);
    if(iv.mezziIds.length===0 && needTot>0){
      const mz = nearestMezzo(iv.lat,iv.lng,null,"118");
      if(mz){ assegnaMezzo(mz.codice, iv.id); assegnati++; }
    }
    if(assegnati===0) toast(needTot>0 ? "Nessun mezzo disponibile!" : "🚒 Nessun sanitario richiesto — apri i Vigili del Fuoco");
    else{ toast(`Assegnati ${assegnati} mezzi all'intervento #${iv.id}`); renderListe(); }
  }

  function rientraMezzo(codice){
    const mz = mezzi.find(m=>m.codice===codice);
    if(!mz) return;
    if(mz.trasportaPz || mz.pazIdx!=null||mz.affido!=null || mz.stato==="pronto" || mz.stato==="trasporto" || mz.stato==="ospedale"){ toast(`🏥 ${nomem(mz)} ha il paziente a bordo: prima la consegna in PS`); return; }
    const iv = interventi.find(x=>x.id===mz.interventoId);
    if(iv){
      iv.mezziIds = iv.mezziIds.filter(c=>c!==mz.codice);
      suppLog(iv, gruppoSupporto(mz), "rientrato", mz.codice, null);
      statStacco(mz, iv, "manuale"); // statistiche: distacco con eventuali sospesi
      notaFineEnte(iv, mz.corpo==="VVF"?"VVF":"118");
      // se era l'ultimo mezzo e intervento non chiuso, rimanda in attesa
      if(iv.mezziIds.length===0 && iv.stato!=="chiuso"){
        iv.stato="attesa";
      }
    checkChiusura(iv);
    }
    mz.ospedale=null; mz.ospedaleScelto=null; mz.trasportaPz=false; mz.pazIdx=null; mz.affido=null;
    vaiA(mz, mz.baseLat, mz.baseLng, "rientro");
    log(`↩️ ${nomem(mz)} rientra in sede`, "status");
    refreshMarkers(); renderListe();
  }

 // FMS manuale stile LSTSim: 6 = fuori servizio (solo da libero in sede), 1 = di nuovo in servizio
  // Turni a fascia oraria (es. NEF Magenta 8-20 / 20-8): turno=[dalle,alle], notte a cavallo ammessa
  function turnoAttivo(mz){
    if(!mz.turno) return true;
    const h = Math.floor(clockMin/60)%24, a = mz.turno[0], b = mz.turno[1];
    return a<=b ? (h>=a && h<b) : (h>=a || h<b);
  }
  function applicaTurni(){
    let cambiato = false;
    for(const mz of mezzi){
      if(!mz.turno) continue;
      if(!turnoAttivo(mz)){
        if(mz.stato==="disponibile" && mz.interventoId==null){ mz.stato="fuori_servizio"; mz.autoFS=true; log(`⏰ ${nomem(mz)} fuori servizio (fine turno ${mz.turno[0]}:00-${mz.turno[1]}:00)`, "status"); cambiato=true; }
      } else if(mz.stato==="fuori_servizio" && mz.autoFS){ mz.stato="disponibile"; mz.autoFS=false; log(`⏰ ${nomem(mz)} in servizio (inizio turno ${mz.turno[0]}:00-${mz.turno[1]}:00)`, "status"); cambiato=true; }
    }
    if(cambiato){ refreshMarkers(); renderListe(); }
  }
 function fuoriServizio(codice, fs){
   const mz = mezzi.find(m=>m.codice===codice);
   if(!mz) return;
   if(fs){
     if(mz.stato!=="disponibile"||mz.interventoId!=null){ toast(`${mz.codice}: fuori servizio solo da libero in sede`); return; }
     mz.stato="fuori_servizio";
     log(`🔧 ${nomem(mz)} fuori servizio (FMS 6)`, "status");
   } else {
     if(mz.stato!=="fuori_servizio") return;
      if(mz.turno && !turnoAttivo(mz)){ toast(`${mz.codice}: fuori turno (${mz.turno[0]}:00-${mz.turno[1]}:00)`); return; }
     mz.stato="disponibile";
     log(`✅ ${nomem(mz)} di nuovo in servizio (FMS 1)`, "status");
   }
   refreshMarkers(); renderListe();
 }

  // MSA/automediche (MSI_MSA senza trasporto, tranne le MSA con trasp:1 come MDCCST): non trasportano, al massimo seguono in ospedale
  function isMedica(mz){ return !!(mz && mz.cat==="MSI_MSA" && !mz.trasporto && mz.tipo!=="CNSAS" && mz.tipo!=="PMA"); } // CNSAS/PMA: solo estetica, mai medicalizzato operativo
  // ELI = elisoccorso: vola in linea d'aria, fa da automedica E da ambulanza (trasporta)
  function isEli(mz){ return mz.tipo==="ELI"; }
  // supporto avanzato (MSA/automedica/eli): se la scena l'ha chiesto, si aspetta il suo arrivo
  function isAvanzato(mz){ return mz && (mz.tipo==="MSA"||mz.tipo==="AUTOMEDICA"||mz.tipo==="ELI"||isMedica(mz)||isEli(mz)); }
  // REGOLA UNIVERSALE (vale per ogni missione, senza eccezioni per tipo): ogni singolo
  // paziente con salute sotto SOGLIA_MSA chiede automaticamente un MSA/MSI, resta in
  // gestione sanitaria e si procede (cura/carico) solo dopo il suo arrivo effettivo.
  const SOGLIA_MSA = 35;
  function msaSulPosto(iv){ return mezzi.some(m=>m.interventoId===iv.id && m.stato==="sul_posto" && isAvanzato(m)); }
  function msaAtteso(iv){ return iv && iv.attesaMSA && !msaSulPosto(iv); }
  // --- ASSEGNAZIONE PRIORITARIA MSA/MSI (regola globale, ogni missione senza eccezioni) ---
  // Ogni paziente sotto soglia resta in gestione avanzata (flag iv.pazMSA[k]) finché non è
  // stabilizzato al 100% o esce di scena: ritrovarne uno nuovo non aspetta gli altri e non
  // cancella nessuno. Ogni mezzo avanzato sul posto segue UN solo paziente (iv.msaDi:
  // codice mezzo -> indice paziente): il più critico (% più bassa) tra quelli in attesa;
  // a paziente finito ne prende un altro; mai due mezzi sullo stesso paziente e mai un
  // mezzo su due pazienti. L'arrivo fisico non basta: vale la presa in carico registrata.
  function msaBisognosi(iv){
    const out = [];
    const L = (iv&&iv.pazienti)||[];
    for(let k=0;k<L.length;k++){
      if(L[k]==null || !pazAttivo(iv,k) || L[k]>=100) continue;
      if(!(iv.pazMSA && iv.pazMSA[k])) continue;
      out.push(k);
    }
    out.sort((a,b)=>L[a]-L[b]); // più critico prima
    return out;
  }
  function msaAssegnatoA(iv,k){
    if(!iv || !iv.msaDi) return null;
    for(const cod in iv.msaDi){
      if(iv.msaDi[cod]!==k) continue;
      const m = mezzi.find(x=>x.codice===cod);
      if(m && m.interventoId===iv.id && m.stato==="sul_posto" && isAvanzato(m)) return cod;
    }
    return null;
  }
  function msaInAttesa(iv){ return msaBisognosi(iv).filter(k=>!msaAssegnatoA(iv,k)); }
  function assegnaMSA(iv, mz){
    if(!iv || !mz || !isAvanzato(mz) || !iv.valutato) return -1; // prima del report nessuno prende in carico
    if(!iv.msaDi) iv.msaDi = {};
    const L = iv.pazienti||[];
    const valido = (k)=>k!=null && L[k]!=null && L[k]<100 && pazAttivo(iv,k) && iv.pazMSA && iv.pazMSA[k];
    if(valido(iv.msaDi[mz.codice])){
      // mai interrompere la presa in carico in corso (§4): resta dov'è — a meno che un
      // altro avanzato non abbia preso lo stesso paziente (mai due sullo stesso)
      const gia = iv.msaDi[mz.codice];
      let rubato = false;
      for(const m of mezzi){
        if(m.codice===mz.codice || m.interventoId!==iv.id || m.stato!=="sul_posto" || !isAvanzato(m)) continue;
        if((iv.msaDi&&iv.msaDi[m.codice]===gia) || (iv.curaDi&&iv.curaDi[m.codice]===gia)){ rubato = true; break; }
      }
      if(!rubato) return gia;
    }
    const occupati = new Set();
    for(const cod in iv.msaDi){
      if(cod===mz.codice) continue;
      const m = mezzi.find(x=>x.codice===cod);
      if(m && m.interventoId===iv.id && m.stato==="sul_posto" && isAvanzato(m) && iv.msaDi[cod]!=null) occupati.add(iv.msaDi[cod]);
    }
    for(const m of mezzi){ // mai lo stesso paziente a due avanzati (neanche a chi lo sta già curando)
      if(m.codice===mz.codice || m.interventoId!==iv.id || m.stato!=="sul_posto" || !isAvanzato(m)) continue;
      if(iv.curaDi && iv.curaDi[m.codice]!=null) occupati.add(iv.curaDi[m.codice]);
    }
    const cand = msaBisognosi(iv).filter(k=>!occupati.has(k));
    if(!cand.length){ if(iv.msaDi[mz.codice]!=null) delete iv.msaDi[mz.codice]; return -1; }
    const k = cand[0]; // il più critico in attesa
    if(iv.msaDi[mz.codice]!==k){
      iv.msaDi[mz.codice] = k;
      for(const m of mezzi){ // priorità al più critico anche se un'ordinaria lo curava: cede il passo
        if(m.interventoId!==iv.id || m.stato!=="sul_posto" || m===mz || isAvanzato(m)) continue;
        if(iv.curaDi && iv.curaDi[m.codice]===k) delete iv.curaDi[m.codice];
      }
      log(`🚓 ${nomem(mz)} a <b>${iv.comune}</b>: prende in carico <b>P${k+1}</b> (${Math.round(iv.pazienti[k])}%, il più critico)`, "status");
    }
    return k;
  }
  function aggiornaMSA(iv){ // una sola fonte per flag/coda/attesa (niente sistemi paralleli)
    if(!iv || iv.stato==="chiuso") return;
    const L = iv.pazienti||[];
    if(!iv.msaDi) iv.msaDi = {};
    for(let k=0;k<L.length;k++){ // stabilizzato o uscito di scena: non serve più il medicalizzato
      if(iv.pazMSA && iv.pazMSA[k] && (L[k]==null || L[k]>=100 || !pazAttivo(iv,k))) iv.pazMSA[k] = false;
    }
    for(const cod in iv.msaDi){ // assegnazioni decadute (mezzo andato via, paziente finito)
      const k = iv.msaDi[cod];
      const m = mezzi.find(x=>x.codice===cod);
      if(!m || m.interventoId!==iv.id || m.stato!=="sul_posto" || !isAvanzato(m) || k==null || L[k]==null || L[k]>=100 || !pazAttivo(iv,k) || !(iv.pazMSA&&iv.pazMSA[k])) delete iv.msaDi[cod];
    }
    for(const m of mezzi){ // chi è libero prende il più critico in attesa (mai staccare chi assiste)
      if(m.interventoId!==iv.id || m.stato!=="sul_posto" || !isAvanzato(m)) continue;
      const k = iv.msaDi[m.codice];
      if(k==null || L[k]==null || L[k]>=100 || !pazAttivo(iv,k) || !(iv.pazMSA&&iv.pazMSA[k])) assegnaMSA(iv, m);
    }
    if(msaBisognosi(iv).length && !msaSulPosto(iv) && !iv.attesaMSA){ // richieste sempre attive (rilevazione silenziosa, mai duplicati)
      iv.attesaMSA = true; iv.msaTimer = 18;
      ensureSupporti(iv);
      registraRichiesta(iv, "MSA", Math.max((iv.supporti.MSA&&iv.supporti.MSA.richiesti)||0, 1), motivoMSA(iv));
    }
  }
  // ---------- SUPPORTI: richieste / assegnate / arrivate, per missione ----------
  // Per gruppo (MSA = supporto avanzato inclusi ELI e automediche MSA1/MSA2, VVF,
  // ALTRO = altri mezzi): richieste = unita chieste dalla scena, assegnate = mezzi
  // collegati ora (derivati da iv.mezziIds: dirottamenti e rientri aggiornano da soli),
  // arrivate = mezzi giunti davvero sul posto (idempotente). Chiave = (missione,
  // gruppo, fabbisogno): stessa missione + stesso fabbisogno = stessa richiesta
  // (mai duplicati); due missioni diverse restano sempre separate.
  const SUP_GRUPPI = ["MSA","VVF","ALTRO"];
  function gruppoSupporto(mz){
    if(!mz) return "ALTRO";
    if(isAvanzato(mz)) return "MSA";
    if(mz.corpo==="VVF") return "VVF";
    return "ALTRO";
  }
  function ensureSupporti(iv){
    if(!iv) return null;
    if(!iv.supporti) iv.supporti = {};
    for(const g of SUP_GRUPPI){
      if(!iv.supporti[g]) iv.supporti[g] = {richiesti:0, arrivati:[], log:[]};
      if(!Array.isArray(iv.supporti[g].arrivati)) iv.supporti[g].arrivati = [];
      if(!Array.isArray(iv.supporti[g].log)) iv.supporti[g].log = [];
    }
    return iv.supporti;
  }
  function initSupporti(iv){
    ensureSupporti(iv);
    const r = iv.richiesti || {};
    let altro = 0;
    for(const k in r){
      if(k==="MSA"||k==="AUTOMEDICA") continue;
      if(k==="VVF") iv.supporti.VVF.richiesti = Math.max(iv.supporti.VVF.richiesti||0, Math.max(0, r[k]||0));
      else altro += Math.max(0, r[k]||0);
    }
    iv.supporti.MSA.richiesti = Math.max(0, (r.MSA||0)+(r.AUTOMEDICA||0));
    iv.supporti.ALTRO.richiesti = Math.max(0, altro);
    return iv.supporti;
  }
  function suppLog(iv, gruppo, ev, codice, msg){
    if(!iv) return;
    ensureSupporti(iv);
    const b = iv.supporti[gruppo];
    if(!b) return;
    b.log.push({t: Math.round(clockMin*10)/10, ev, codice: codice||null, msg: msg||null});
    if(b.log.length>30) b.log.splice(0, b.log.length-30);
  }
  // registra un fabbisogno TOTALE per (missione, gruppo): idempotente, richiami con
  // gli stessi numeri non incrementano. Ritorna true solo se le richieste crescono.
  function registraRichiesta(iv, gruppo, totale, motivo){
    if(!iv || !gruppo) return false;
    ensureSupporti(iv);
    const b = iv.supporti[gruppo];
    if(!b) return false;
    const tot = Math.max(0, Math.round(totale||0));
    if(tot>(b.richiesti||0)){
      const prima = b.richiesti||0;
      b.richiesti = tot;
      suppLog(iv, gruppo, "richiesta", null, (motivo||"supporto richiesto") + " (" + prima + "->" + tot + ")");
      return true;
    }
    return false;
  }
  function mezziAssegnati(iv, gruppo){
    const out = [];
    if(!iv || !iv.mezziIds) return out;
    for(const c of iv.mezziIds){
      const m = mezzi.find(x=>x.codice===c);
      if(m && gruppoSupporto(m)===gruppo) out.push(m);
    }
    return out;
  }
  function contaSupporti(iv){
    ensureSupporti(iv);
    const r = {};
    for(const g of SUP_GRUPPI){
      const ass = mezziAssegnati(iv, g);
      r[g] = {
        richiesti: iv.supporti[g].richiesti||0,
        assegnati: ass.length,
        inViaggio: ass.filter(m=>m.stato==="viaggio").length,
        sulPosto: ass.filter(m=>m.stato==="sul_posto"||m.stato==="pronto").length,
        arrivati: iv.supporti[g].arrivati.length,
        arrivatiCod: iv.supporti[g].arrivati.map(e=>e.codice)
      };
    }
    return r;
  }
  // arrivo effettivo, una sola volta per (missione, mezzo): true solo al primo conteggio
  function registraArrivo(iv, mz){
    if(!iv || !mz) return false;
    if(mz.interventoId!==iv.id) return false; // lavora altrove: non conta per questa missione
    if(mz.stato!=="sul_posto" && mz.stato!=="pronto") return false; // solo arrivo reale, mai al semplice invio
    ensureSupporti(iv);
    const g = gruppoSupporto(mz);
    const b = iv.supporti[g];
    for(const e of b.arrivati) if(e.codice===mz.codice) return false;
    b.arrivati.push({codice: mz.codice, t: Math.round(clockMin*10)/10});
    mz.tArrivo = Math.round(clockMin*10)/10; // orario di arrivo mostrato in scheda
    suppLog(iv, g, "arrivo", mz.codice, null);
    statArrivo(iv, mz); // statistiche: tempo di arrivo mezzo
    return true;
  }
  function suppTxt(n, uno, molti){ return n + " " + (n===1 ? uno : molti); }
  function supportiHTML(iv){
    const c = contaSupporti(iv);
    const riga = (g, label) => {
      const v = c[g];
      let s = "<div class=\"kv\">" + label + ": " + suppTxt(v.richiesti, "richiesta", "richieste") + ", " + suppTxt(v.assegnati, "assegnata", "assegnate") + ", " + suppTxt(v.arrivati, "arrivata", "arrivate");
      if(v.inViaggio>0) s += " — 🟠 " + v.inViaggio + " in viaggio";
      return s + "</div>";
    };
    return "<div class=\"kv\"><b>🆘 Supporti:</b></div>" + riga("MSA", "🚓 Automedica") + riga("VVF", "🚒 VVF") + riga("ALTRO", "🚑 Altri supporti");
  }
  function supportoStato(id){
    const iv = interventi.find(x=>x.id===id);
    if(!iv) return null;
    return {id: iv.id, comune: iv.comune, supporti: contaSupporti(iv), mezzi: (iv.mezziIds||[]).slice()};
  }
  // gestione intelligente pazienti: 1 paziente = 1 mezzo. Chi va PRONTO prende in
  // carico un paziente libero (mz.trasportaPz); chi è pronto dopo, senza pazienti
  // liberi, rientra invece di andare in ospedale a vuoto.
  // può prendere in carico e trasportare pazienti: solo se configurato (MSB, ELI, DRAGO153)
  // ---------- STATI PAZIENTE (sorgente centrale unica, 14 stati) ----------
  // 1 Segnalato - 2 Da valutare - 3 Attesa soccorso - 4 Valutazione sanitaria - 5 Attesa liberazione -
  // 6 Attesa ambulanza - 7 Preso in carico - 8 Caricato - 9 In trasporto - 10 In ospedale -
  // 11 Concluso sul posto - 12 Rifiuto trasporto - 13 Deceduto - 14 Missione conclusa.
  // Un solo stato alla volta; ogni passaggio registra da/a, orario ed evento. I terminali (10-13)
  // vanno solo verso 14; il 14 non si riapre (solo correzioni esplicite via forzaStatoPaziente).
  const ST_PAZ = {1:"Segnalato",2:"Da valutare",3:"In attesa di soccorso",4:"In valutazione sanitaria",5:"In attesa di liberazione",6:"In attesa di ambulanza",7:"Preso in carico",8:"Caricato in ambulanza",9:"In trasporto",10:"In ospedale",11:"Trattamento concluso sul posto",12:"Rifiuto del trasporto",13:"Deceduto",14:"Missione paziente conclusa"};
  const TRANS_PAZ = {1:[2,13],2:[3,4,5,13],3:[4,5,11,13],4:[6,7,11,12,13],5:[3,4,13],6:[7,11,12,13],7:[8,6],8:[9,6],9:[10,6],10:[14],11:[14],12:[14],13:[14],14:[]};
  let storicoPazienti = [];
  let verificaTimer = 0;
  function statoPaziente(iv,k){ if(iv && iv.pazS && iv.pazS[k]) return iv.pazS[k].st; return 1; }
  function pazAttivo(iv,k){ const L=(iv&&iv.pazienti)||[]; return L[k]!=null && statoPaziente(iv,k)<10; }
  function pazEleggibileCarico(iv,k){ const L=(iv&&iv.pazienti)||[]; if(L[k]==null||!pazAttivo(iv,k)) return false; const p=(iv.profili||[])[k]; if(p&&p.intr&&!((iv.liberati||{})[k])) return false; return true; }
  function setStatoPaziente(iv,k,nuovo,ev){
    if(!iv) return false;
    const cur = statoPaziente(iv,k);
    if(cur===nuovo) return true;
    const amm = TRANS_PAZ[cur]||[];
    if(amm.indexOf(nuovo)<0){ console.warn("[COEU] transizione paziente vietata: "+pazUid(iv,k)+" "+cur+"->"+nuovo+" ("+(ev||"")+")"); return false; }
    if(!iv.pazS) iv.pazS={};
    const e = iv.pazS[k] || (iv.pazS[k]={st:1, dal:(iv.t0!=null?iv.t0:clockMin), log:[]});
    e.log.push({da:cur, a:nuovo, t:Math.round(clockMin*10)/10, ev:String(ev||"").slice(0,120)});
    if(e.log.length>40) e.log = e.log.slice(-40);
    e.st = nuovo; e.dal = clockMin;
    return true;
  }
  function forzaStatoPaziente(iv,k,nuovo,ev){
    if(typeof iv==="number") iv = interventi.find(x=>x.id===iv);
    if(!iv) return false;
    if(!iv.pazS) iv.pazS={};
    const e = iv.pazS[k] || (iv.pazS[k]={st:1, dal:(iv.t0!=null?iv.t0:clockMin), log:[]});
    e.log.push({da:e.st, a:nuovo, t:Math.round(clockMin*10)/10, ev:"FORZATO: "+String(ev||"").slice(0,120)});
    e.st = nuovo; e.dal = clockMin;
    return true;
  }
  function chiudiPazientiMissione(iv,come){
    if(!iv) return;
    const L = iv.pazienti||[];
    for(let k=0;k<L.length;k++){
      if(L[k]==null) continue;
      const st = statoPaziente(iv,k);
      if(st===14) continue;
      if(st===10||st===11||st===12||st===13){ setStatoPaziente(iv,k,14,come+": missione conclusa"); continue; }
      if(!iv.trasporto && (st===3||st===4||st===6)){ setStatoPaziente(iv,k,11,come+": concluso sul posto"); try{ if(window.COEUGLOB) COEUGLOB.bumpPosto(pazUid(iv,k)); }catch(_){} setStatoPaziente(iv,k,14,come+": missione conclusa"); continue; }
      console.error("[COEU] chiusura con paziente non terminale: "+pazUid(iv,k)+" st="+st);
      forzaStatoPaziente(iv,k,14,come+": chiusura forzata (anomalia)");
    }
    for(let k=0;k<L.length;k++){
      if(L[k]==null) continue;
      storicoPazienti.push({uid:pazUid(iv,k), iv:iv.id, comune:iv.comune, tipo:iv.tipoNome, fine:statoPaziente(iv,k), log:(((iv.pazS||{})[k]||{}).log||[]).slice()});
    }
    if(storicoPazienti.length>300) storicoPazienti = storicoPazienti.slice(-300);
  }
  function registraRifiuto(id,k){
    const iv = interventi.find(x=>x.id===id);
    if(!iv) return false;
    if(!iv.trasporto || !iv.reportFatto){ toast("Rifiuto registrabile solo dopo la valutazione sanitaria"); return false; }
    const st = statoPaziente(iv,k);
    if(st!==4 && st!==6){ toast("Rifiuto non registrabile in questo stato"); return false; }
    if((iv.pazienti||[])[k]==null || Math.round(iv.pazienti[k])<70){ toast("Rifiuto solo per pazienti lievi (salute \u226570%)"); return false; }
    if(!setStatoPaziente(iv,k,12,"rifiuto firmato")) return false;
    if(iv.daTrasportare>0) iv.daTrasportare--;
    log(`✋ A <b>${iv.comune}</b>: <b>P${k+1}</b> rifiuta il trasporto (verbale firmato)`, "status");
    renderListe();
    return true;
  }
  function verificaStati(){
    const out = {riparati:[], avvisi:[], morti:[]};
    for(const iv of interventi){
      if(iv.stato==="chiuso") continue;
      if(!iv.avvisi) iv.avvisi={};
      const L = iv.pazienti||[];
      const resp = {};
      for(const m of mezzi){
        if(m.interventoId!==iv.id) continue;
        const ks = [];
        if(m.trasportaPz && m.pazIdx!=null) ks.push(m.pazIdx);
        if(m.affido!=null && ks.indexOf(m.affido)<0) ks.push(m.affido);
        for(const kk of ks){ (resp[kk]=resp[kk]||[]).push(m.codice); }
      }
      for(const kk in resp){
        if(resp[kk].length>1){
          for(let j=1;j<resp[kk].length;j++){ const m = mezzi.find(x=>x.codice===resp[kk][j]); if(!m) continue; if(m.pazIdx===+kk){ m.pazIdx=null; m.trasportaPz=false; } if(m.affido===+kk){ m.affido=null; if(iv.affidi) delete iv.affidi[kk]; } }
          out.riparati.push(pazUid(iv,+kk)+" doppio:"+resp[kk].join("+")+" -> "+resp[kk][0]);
        }
      }
      for(let k=0;k<L.length;k++){
        if(L[k]==null) continue;
        const st = statoPaziente(iv,k);
        const e = (iv.pazS||{})[k];
        const inSt = e ? (clockMin-e.dal) : 0;
        const uid = pazUid(iv,k);
        if(st===7 && !(iv.affidi&&iv.affidi[k])){ setStatoPaziente(iv,k,6,"verifica: affido perso"); out.riparati.push(uid+" 7->6 affido perso"); continue; }
        if(st===8 && !mezzi.some(m=>m.interventoId===iv.id&&m.pazIdx===k&&m.trasporto)){
          if(iv.pazConsegnati&&iv.pazConsegnati[k]){ setStatoPaziente(iv,k,9,"verifica: in viaggio"); setStatoPaziente(iv,k,10,"verifica: consegnato"); }
          else { setStatoPaziente(iv,k,6,"verifica: carico perso"); out.riparati.push(uid+" 8->6 carico perso"); }
          continue;
        }
        if(st===9 && !mezzi.some(m=>m.interventoId===iv.id&&m.pazIdx===k&&(m.stato==="trasporto"||m.stato==="ospedale"))){
          if(iv.pazConsegnati&&iv.pazConsegnati[k]) setStatoPaziente(iv,k,10,"verifica: consegnato");
          else { if(iv.trasporto) iv.daTrasportare=(iv.daTrasportare||0)+1; setStatoPaziente(iv,k,6,"verifica: trasporto perso"); out.riparati.push(uid+" 9->6 trasporto perso"); }
          continue;
        }
        const throttled = iv.avvisi[uid+":"+st];
        if(st===5 && inSt>8 && !mezzi.some(m=>m.interventoId===iv.id&&m.corpo==="VVF"&&m.stato==="sul_posto") && !throttled){ iv.avvisi[uid+":"+st]=1; out.avvisi.push(uid+" attesa liberazione"); } // niente radio qui: il sollecito lo fa scenaTick, una sola volta per missione
        else if(st===6 && inSt>15 && !throttled){ iv.avvisi[uid+":"+st]=1; out.avvisi.push(uid+" attesa ambulanza"); } // niente radio qui: il sollecito lo fa scenaTick, una sola volta per missione
        else if(st===2 && inSt>10 && !throttled){ iv.avvisi[uid+":"+st]=1; out.avvisi.push(uid+" da valutare da "+Math.round(inSt)+" min"); }
        if(iv.valutato && (st===2||st===3||st===4||st===5||st===6) && Math.round(L[k])<=6 && !aiuto118(iv) && inSt>20){
          if(setStatoPaziente(iv,k,13,"decesso: critico senza assistenza")){
            if(iv.trasporto && iv.daTrasportare>0) iv.daTrasportare--;
            log(`🕊 A <b>${iv.comune}</b>: purtroppo <b>P${k+1}</b> deceduto (critico, senza assistenza)`, "alarm");
            out.morti.push(uid);
          }
        }
      }
    }
    if(ST) ST.verifica = {s:Math.round(statClock*10)/10, riparati:out.riparati.slice(-20), avvisi:out.avvisi.slice(-20), morti:out.morti.slice()};
    return out;
  }
  function codeMortiCoda(){
    for(let i=chiamate.length-1;i>=0;i--){
      const c = chiamate[i];
      if((clockMin-c.t0)<=25) continue;
      const crit = (c.pazienti||[]).some(s=>s!=null&&Math.round(s)<=8);
      if(!crit) continue;
      for(let k=0;k<(c.pazienti||[]).length;k++){
        if(c.pazienti[k]!=null && Math.round(c.pazienti[k])<=8) storicoPazienti.push({uid:"Q"+c.callId+"-P"+(k+1), iv:null, comune:c.comune, tipo:c.tipoNome, fine:13, log:[{da:1,a:13,t:Math.round(clockMin*10)/10,ev:"decesso prima dell'arrivo"}]});
      }
      if(storicoPazienti.length>300) storicoPazienti = storicoPazienti.slice(-300);
      log(`🕊 Chiamata da <b>${c.comune}</b>: paziente critico deceduto prima dell'arrivo`, "alarm");
      chiamate.splice(i,1);
      refreshCallMarkers(); renderCalls(); updateStats();
    }
  }
  function puoTrasportare(mz){ return !!(mz && mz.trasporto); }
  function claimants(ivId){
    const iv = interventi.find(x=>x.id===ivId);
    return mezzi.filter(m=>m.interventoId===ivId && ((m.trasportaPz && m.pazIdx!=null) || m.affido!=null) && (m.stato==="pronto"||m.stato==="trasporto"||m.stato==="ospedale") && !(iv && iv.pazConsegnati && iv.pazConsegnati[m.pazIdx]));
  }
  // indici dei pazienti liberi: né consegnati in PS né in carico a un mezzo attivo
  function liberiIdx(iv){
    const out = [];
    const list = iv.pazienti||[];
    const claimed = new Set(claimants(iv.id).map(m=>(m.pazIdx!=null?m.pazIdx:m.affido)));
    if(iv.affidi) for(const k in iv.affidi) claimed.add(+k); // anche gli affidi dei mezzi ancora sul posto
    for(let k=0;k<list.length;k++){
      if(list[k]==null || !pazEleggibileCarico(iv,k)) continue;
      if(iv.pazConsegnati && iv.pazConsegnati[k]) continue;
      if(claimed.has(k)) continue;
      out.push(k);
    }
    return out;
  }
  function pazUid(iv,k){ return (iv && iv.pazIds && iv.pazIds[k]) || ("M"+(iv&&iv.id!=null?iv.id:"?")+"-P"+(k+1)); }
 function pazientiLiberi(iv){ return liberiIdx(iv).length; }
  // presa in carico immediata: un paziente stabilizzato "in attesa di ambulanza" (st 6)
  // viene affidato SUBITO all'ambulanza già sul posto, senza aspettare il fine-scena:
  // la scritta sparisce all'arrivo fisico del mezzo (o subito, se il mezzo è già lì)
  function affidoImmediato(iv){
    if(!iv || !iv.trasporto || !iv.stabilizzato || !iv.reportFatto) return false;
    if(msaAtteso(iv)) return false;
    let fatto = false;
    const amb = mezzi.filter(m=>m.interventoId===iv.id && m.stato==="sul_posto" && m.trasporto && m.affido==null);
    for(const mz of amb){
      const lib = liberiIdx(iv).filter(k=>statoPaziente(iv,k)===6);
      if(!lib.length) break;
      const k = lib[0];
      mz.affido = k; if(!iv.affidi) iv.affidi={}; iv.affidi[k]=mz.codice;
      if(setStatoPaziente(iv,k,7,"affido "+nomem(mz))){
        if(!(mz.sulPostoTimer>0 && mz.sulPostoTimer<1.5)) mz.sulPostoTimer = 1.5;
        log(`👨‍⚕️ ${nomem(mz)}: <b>P${k+1}</b> preso in carico, carico in corso`, "ok");
        fatto = true;
      } else { mz.affido=null; if(iv.affidi) delete iv.affidi[k]; }
    }
    if(fatto){ refreshMarkers(); renderListe(); }
    return fatto;
  }
  // ---------- OSPEDALI REALI: bisogno per paziente + scheda reparti ----------
  const NEED_FLAG = {USTIONI:"ustioni", TRAUMA:"trauma", CARDIO:"cardio", STROKE:"stroke", NEUROCH:"neuroch", PED:"ped", TIN:"tin", OST:"ost", RIAN:"rian"};
  const NEED_MOTIVO = {USTIONI:"centro ustioni", TRAUMA:"trauma center (CTZ)", CARDIO:"emodinamica/cardiologia", STROKE:"stroke unit", NEUROCH:"neurochirurgia", PED:"pediatria", TIN:"terapia intensiva neonatale", OST:"ostetricia/punto nascita", RIAN:"rianimazione", GENERICO:"pronto soccorso"};
  // bisogno assistenziale del paziente k: da quadro clinico, età e salute (mai il tipo vero)
  function bisognoPaziente(iv, k){
    const p = (iv.profili||[])[k] || {};
    const q = (p.q||"").toLowerCase();
    const sal = (iv.pazienti||[])[k];
    const eta = p.e;
    if(/ustioni|ustione|bruciat/.test(q)) return "USTIONI";
    if(/neonat|apnea del neonato|ittero neonatale/.test(q)) return "TIN";
    if(/travaglio|doglie|parto|rottura acque|eclampsia|emorragia gravidica|emergenza neonatale|ipertensione gravidica|minaccia d'aborto|puerperio|emorragia post-partum/.test(q)) return "OST";
    if(eta!=null && eta<1) return "TIN";
    if(eta!=null && eta<=14 && !/trauma|frattura|ferita|ustione|contusione|distorsione/.test(q)) return "PED";
    if(/arresto cardiaco|infarto|shock cardiogeno|fibrillazione|edema polmonare|aritmia/.test(q)) return "CARDIO";
    if(/ictus|FAST\+|TIA|stato di male/.test(q)) return "STROKE";
    if(/emorragia subaracnoidea|trauma cranico grave/.test(q)) return "NEUROCH";
    if(sal!=null && sal<25 && /coma|RCP|insufficienza respiratoria|ipossia/.test(q)) return "RIAN";
    if(/politrauma|schiacciamento|frattura di bacino|frattura di femore|emotorace|trauma toracico|frattura esposta|amputazione|fratture multiple|seppellimento|shock emorragico/.test(q)) return "TRAUMA";
    if(sal!=null && sal<40 && /trauma|frattura|schiacciamento|caduta|investimento/.test(q)) return "TRAUMA";
    return "GENERICO";
  }
  function etaMinuti(km, mz){ return km/((mz&&isEli(mz))?180:((mz&&mz.velKmh)||50))*60/boostMoto(); }
  // proposte compatibili col bisogno, ordinate: reparto verificato (1 prima di "nd"),
  // poi distanza. Niente compatibili = ripiego sul PS più vicino.
  // Bellano (ps:0) non è mai proposta.
  function ospedaliPerBisogno(bisogno, lat, lng, mz){
    const flag = NEED_FLAG[bisogno];
    const all = (D().OSPEDALI||[]).filter(o=>o.ps!==0);
    const rows = all.map(o=>{
      const km = haversineKm(lat,lng,o.lat,o.lng);
      const fv = flag ? ((o.spec||{})[flag]) : "gen";
      const ok = !flag ? true : (fv===1||fv==="nd");
      return {o, km, min:etaMinuti(km,mz), fv, ok,
        motivo: !flag ? "pronto soccorso più vicino" : (fv===1 ? NEED_MOTIVO[bisogno]+" ✓" : fv==="nd" ? NEED_MOTIVO[bisogno]+" (da verificare)" : null)};
    });
    const comp = rows.filter(r=>r.ok).sort((a,b)=>
      ((a.fv==="nd")-(b.fv==="nd")) || (a.km-b.km));
    if(comp.length) return {bisogno, proposte:comp, ripiego:false};
    const rip = rows.sort((a,b)=>(a.km-b.km));
    return {bisogno, proposte:rip.slice(0,3), ripiego:true};
  }
  // scheda reparto per popup H: reparti verificati + fonte
  function schedaOspedaleHTML(nome){
    const o = (D().OSPEDALI||[]).find(x=>x.nome===nome);
    if(!o) return "";
    const specOk = Object.keys(NEED_FLAG).filter(k=>o.spec&&o.spec[NEED_FLAG[k]]===1).map(k=>NEED_MOTIVO[k]);
    const specNd = Object.keys(NEED_FLAG).filter(k=>o.spec&&o.spec[NEED_FLAG[k]]==="nd").map(k=>NEED_MOTIVO[k]);
    return `<b>🏥 ${o.nomeUff||o.nome}</b>${o.addr&&o.addr!=="nd"?"<br>"+o.addr:""}`
      + `<br>PS: ${o.ps===1?"sì":o.ps===0?"no":"da verificare"}`
      + (o.eli?`<br>🚁 elisuperficie (meta degli elisoccorsi)`:"")
      + (specOk.length?`<br>✓ ${specOk.join(" · ")}`:"")
      + (specNd.length?`<br><span class="small">da verificare: ${specNd.join(" · ")}</span>`:"")
      + ((o.rep||[]).length?`<br><span class="small">${o.rep.join(" · ")}</span>`:"")
      + (o.fonte?`<br><span class="small">fonte: ${o.fonte}</span>`:"");
  }
  function mezziInPS(nome){ return mezzi.filter(m=>m.stato==="ospedale"&&m.ospedale===nome); }
  function ospPSHTML(nome){
    const inPS = mezziInPS(nome);
    return inPS.length ? `<br><b>In PS:</b> ${inPS.map(m=>{ const v=(m.interventoId!=null)?interventi.find(x=>x.id===m.interventoId):null; return nomem(m)+(v?codQuad(v.prio):""); }).join(", ")}` : "";
  }
  function ospTooltipHTML(o){ return `<b>${o.nomeUff||o.nome}</b>${ospPSHTML(o.nome)}`; }
  function mostraOspedale(nome){
    const e = ospMarkers.find(x=>x.osp.nome===nome);
    if(e && map){ map.panTo([e.osp.lat,e.osp.lng]); try{ e.marker.openPopup(); }catch(_){} return true; }
    return false;
  }
  // ---------- PMA (Posto Medico Avanzato da campo: uno solo, capacita illimitata) ----------
  // Destinazione solo con missioni da 10+ pazienti (noti+nascosti); altrimenti resta inattivo.
  function pmaTotPaz(iv){ return (iv.pazienti||[]).length + (iv.pazientiNascosti||[]).length; }
  function maxiAperta(){ return interventi.some(iv=>iv.stato!=="chiuso" && pmaTotPaz(iv)>=10); }
  function pmaAttivo(){ return !!pma && maxiAperta(); }
  function refreshPmaBtn(){
    const b = document.getElementById("pmaBtn");
    if(!b) return;
    b.textContent = pma ? "⛑️ PMA ✓" : "⛑️ PMA";
    b.style.background = pmaArmed ? "#ffe9a8" : "";
    b.style.fontWeight = pmaArmed ? "bold" : "";
    b.title = pma ? "PMA piazzato — tasto per spostarlo, click sul marker per rimuoverlo" : (pmaArmed ? "Clicca sulla mappa dove piazzare il PMA (ESC annulla)" : "Piazza un ospedale da campo (si attiva con missioni da 10+ pazienti)");
  }
  function togglePMA(){
    if(pmaArmed){ pmaArmed = false; refreshPmaBtn(); toast("⛺ Piazzamento PMA annullato"); return "off"; }
    pmaArmed = true; refreshPmaBtn();
    toast("⛺ Clicca sulla mappa dove piazzare il PMA (ESC o tasto per annullare)");
    return "armed";
  }
  function pmaTooltipHTML(){
    if(!pma) return "";
    const st = pmaAttivo() ? "attivo — accoglie pazienti (missione da 10+ in corso)" : "inattivo — si attiva con una missione da 10+ pazienti";
    return `<b>⛺ PMA — Posto Medico Avanzato</b><br><span class="small">` + st + `</span>` + ospPSHTML("PMA");
  }
  function piazzaPMA(lat, lng){
    if(inAcqua(lat, lng)){ toast("Lì c'è il lago: scegli un punto a terra"); return false; }
    pma = {lat:Math.round(lat*10000)/10000, lng:Math.round(lng*10000)/10000};
    pmaArmed = false;
    disegnaPMA();
    refreshPmaBtn();
    log(`⛺ <b>PMA</b> piazzato — ` + (pmaAttivo()?"attivo: accoglie i pazienti":"inattivo (si attiva con una missione da 10+ pazienti)"), "status");
    return true;
  }
  function disegnaPMA(){
    if(!map || !layerSedi) return;
    try{ if(pmaMarker){ pmaMarker.remove(); pmaMarker=null; } }catch(_){}
    if(!pma) return;
    pmaMarker = L.marker([pma.lat, pma.lng],{
      icon: L.divIcon({className:'pmaIcon', html:`<div class="pmaDot">⛺</div>`, iconSize:[22,22], iconAnchor:[11,11]})
    }).bindTooltip(pmaTooltipHTML()).addTo(layerSedi);
    pmaMarker.on("click", ()=>{
      const st = pmaAttivo() ? "🟢 <b>attivo</b> — accoglie pazienti" : "⚪ <b>inattivo</b> — serve una missione da 10+ pazienti";
      pmaMarker.bindPopup('<div style="min-width:200px"><b>⛺ PMA — Posto Medico Avanzato</b><br>' + st + ospPSHTML("PMA") + '<br><button class="lstBtn small" id="pmaRmBtn">❌ Rimuovi PMA</button></div>').openPopup();
      const bb = document.getElementById("pmaRmBtn");
      if(bb) bb.onclick = ()=>{ try{ map.closePopup(); }catch(_){} rimuoviPMA(); };
    });
  }
  function rimuoviPMA(){
    if(!pma) return 0;
    pma = null; pmaArmed = false;
    try{ if(pmaMarker){ pmaMarker.remove(); pmaMarker=null; } }catch(_){}
    let n = 0;
    for(const m of mezzi){
      if(m.ospedale!=="PMA" || m.stato!=="trasporto") continue;
      let b2 = D().OSPEDALI[0], d2 = 1e9;
      for(const o of D().OSPEDALI){ if(o.ps===0) continue; const d = haversineKm(m.lat,m.lng,o.lat,o.lng); if(d<d2){ d2=d; b2=o; } }
      m.ospedale = b2.nome;
      const iv = interventi.find(x=>x.id===m.interventoId);
      if(iv && m.pazIdx!=null){ if(!iv.pazDest) iv.pazDest={}; iv.pazDest[m.pazIdx]=b2.nome; }
      vaiA(m, b2.lat, b2.lng, "trasporto");
      n++;
    }
    refreshPmaBtn(); refreshMarkers(); renderListe();
    log(`⛺ <b>PMA rimosso</b>` + (n?(" — "+n+" mezz"+(n>1?"i rirottati":"o rirottato")+" al PS più vicino"):""), "status");
    return n;
  }
  function pmaReset(){
    pma = null; pmaArmed = false;
    try{ if(pmaMarker){ pmaMarker.remove(); pmaMarker=null; } }catch(_){}
    refreshPmaBtn();
  }
  function pmaStato(){ return {piazzato:!!pma, armato:pmaArmed, attivo:pmaAttivo(), pos:pma}; }
  // ambulanza vista laterale stile LSTSim (croce rossa, banda MSB rossa / MSA gialla)
    function AMB_TOP(stripe, s){
    return `<svg viewBox="0 0 54 42" width="${s}" height="${s}" aria-hidden="true"><ellipse cx="27" cy="37" rx="19" ry="3" fill="#000" opacity="0.2"/><clipPath id="ambClip"><path d="M7,8 H37 Q39,8 41,10 L48,16 Q49,17 49,19 V28 Q49,32 45,32 H7 Q3,32 3,28 V12 Q3,8 7,8 Z"/></clipPath><path d="M7,8 H37 Q39,8 41,10 L48,16 Q49,17 49,19 V28 Q49,32 45,32 H7 Q3,32 3,28 V12 Q3,8 7,8 Z" fill="#ffffff" stroke="#3a2530" stroke-width="2"/><g clip-path="url(#ambClip)"><rect x="3" y="21" width="46" height="5.5" fill="${stripe}"/><rect x="40" y="11" width="9" height="8" rx="1" fill="#5fb5e8"/><polygon points="40,19 44,11 46.5,11 42.5,19" fill="#2f7fb8"/></g><rect x="24" y="4.5" width="2" height="3.5" fill="#3a2530"/><rect x="21" y="1" width="8" height="4" rx="1" fill="#e8332a" stroke="#3a2530" stroke-width="1.2"/><rect x="40" y="11" width="9" height="8" rx="1" fill="none" stroke="#3a2530" stroke-width="1.5"/><polygon points="42,13 44.5,13 42,17.5" fill="#cfeaff"/><path d="M11.5 10.5 H15.5 V13.8 H18.8 V17.8 H15.5 V21 H11.5 V17.8 H8.2 V13.8 H11.5 Z" fill="#e8332a" stroke="#3a2530" stroke-width="1.2" stroke-linejoin="round"/><rect x="47" y="23" width="2" height="3" fill="#ffdf60" stroke="#3a2530" stroke-width="0.8"/><circle cx="13" cy="32" r="5.5" fill="#3a2530"/><circle cx="13" cy="32" r="2.5" fill="#9fb3c8"/><circle cx="38" cy="32" r="5.5" fill="#3a2530"/><circle cx="38" cy="32" r="2.5" fill="#9fb3c8"/></svg>`;
  }
  function SUV_TOP(s){
    return `<svg viewBox="0 0 54 42" width="${s}" height="${s}" aria-hidden="true"><ellipse cx="27" cy="37" rx="19" ry="3" fill="#000" opacity="0.2"/><clipPath id="suvClip"><path d="M4,32 V21 Q4,17 8,16.5 L15,15.5 L20,8 Q21,6.5 23,6.5 H37 Q39,6.5 40.5,8.5 L44.5,14.5 L48.5,16 Q51,17 51,20.5 V28 Q51,32 47,32 Z"/></clipPath><path d="M4,32 V21 Q4,17 8,16.5 L15,15.5 L20,8 Q21,6.5 23,6.5 H37 Q39,6.5 40.5,8.5 L44.5,14.5 L48.5,16 Q51,17 51,20.5 V28 Q51,32 47,32 Z" fill="#ffcf00" stroke="#3a2530" stroke-width="2"/><g clip-path="url(#suvClip)"><rect x="4" y="24" width="47" height="4" fill="#ffffff" opacity="0.9"/><rect x="14" y="8" width="24" height="7" fill="#5fb5e8"/><polygon points="39,8.5 43,14.5 39,14.5" fill="#5fb5e8"/></g><rect x="14" y="8" width="24" height="7" fill="none" stroke="#3a2530" stroke-width="1.5"/><polygon points="39,8.5 43,14.5 39,14.5" fill="none" stroke="#3a2530" stroke-width="1.5"/><polygon points="21.5,8 24,8 22,15.5 19,15.5" fill="none" stroke="#3a2530" stroke-width="1.2"/><rect x="20" y="3.5" width="16" height="2.4" rx="1" fill="#3a2530"/><rect x="25" y="1" width="5" height="3.4" rx="1" fill="#2255ff" stroke="#3a2530" stroke-width="1"/><rect x="48.5" y="22" width="2" height="3" fill="#ffdf60" stroke="#3a2530" stroke-width="0.8"/><rect x="3.2" y="22" width="1.8" height="3" fill="#d00000"/><rect x="25" y="17" width="7" height="7" rx="1" fill="#ffffff" stroke="#3a2530" stroke-width="1"/><path d="M27.6 18.2 H29.4 V20 H31.2 V21.8 H29.4 V23.6 H27.6 V21.8 H25.8 V20 H27.6 Z" fill="#d00000"/><circle cx="15" cy="32" r="6" fill="#3a2530"/><circle cx="15" cy="32" r="2.8" fill="#9fb3c8"/><circle cx="40" cy="32" r="6" fill="#3a2530"/><circle cx="40" cy="32" r="2.8" fill="#9fb3c8"/></svg>`;
  }
  function CAR_TOP(s){
    return `<svg viewBox="0 0 54 42" width="${s}" height="${s}" aria-hidden="true"><ellipse cx="27" cy="37" rx="19" ry="3" fill="#000" opacity="0.2"/><clipPath id="carClip"><path d="M5,31 V22 Q5,18 9,17.5 L17,16.5 L23,9.5 Q24,8 26,8 H35 Q37,8 38.5,9.5 L43,15.5 L47,17 Q50,18 50,21.5 V28 Q50,32 46,32 H9 Q5,32 5,31 Z"/></clipPath><path d="M5,31 V22 Q5,18 9,17.5 L17,16.5 L23,9.5 Q24,8 26,8 H35 Q37,8 38.5,9.5 L43,15.5 L47,17 Q50,18 50,21.5 V28 Q50,32 46,32 H9 Q5,32 5,31 Z" fill="#ffffff" stroke="#3a2530" stroke-width="2"/><g clip-path="url(#carClip)"><rect x="5" y="23" width="45" height="4.5" fill="#0645ad"/><polygon points="25,9 31,9 28,16.5 21,16.5" fill="#5fb5e8"/><rect x="30" y="9" width="7" height="7.5" fill="#5fb5e8"/></g><polygon points="25,9 31,9 28,16.5 21,16.5" fill="none" stroke="#3a2530" stroke-width="1.5"/><rect x="30" y="9" width="7" height="7.5" fill="none" stroke="#3a2530" stroke-width="1.5"/><polygon points="32,10.5 35,10.5 32,15" fill="#cfeaff"/><rect x="27" y="4.5" width="2" height="3.5" fill="#3a2530"/><rect x="24" y="1" width="5" height="4" rx="1" fill="#2255ff" stroke="#3a2530" stroke-width="1.2"/><rect x="30" y="1" width="5" height="4" rx="1" fill="#ff2222" stroke="#3a2530" stroke-width="1.2"/><rect x="48" y="23" width="2" height="3" fill="#ffdf60" stroke="#3a2530" stroke-width="0.8"/><rect x="4" y="23" width="1.6" height="3" fill="#d00000"/><circle cx="15" cy="32" r="5" fill="#3a2530"/><circle cx="15" cy="32" r="2.2" fill="#9fb3c8"/><circle cx="39" cy="32" r="5" fill="#3a2530"/><circle cx="39" cy="32" r="2.2" fill="#9fb3c8"/></svg>`;
  }
  function HELI_TOP(col, s){
    return `<svg viewBox="0 0 54 42" width="${s}" height="${s}" aria-hidden="true"><rect x="6" y="3" width="42" height="3" rx="1.5" fill="#3a2530"/><rect x="25" y="6" width="3" height="7" fill="#3a2530"/><polygon points="21,19 6,14 6,17.5 21,24" fill="${col}" stroke="#3a2530" stroke-width="1.5" stroke-linejoin="round"/><polygon points="6,14 3,5 6.5,5 9.5,14" fill="${col}" stroke="#3a2530" stroke-width="1.5" stroke-linejoin="round"/><rect x="2" y="5" width="2.4" height="11" rx="1" fill="#3a2530"/><clipPath id="heliClip"><rect x="19" y="12" width="22" height="16" rx="8"/></clipPath><rect x="19" y="12" width="22" height="16" rx="8" fill="${col}" stroke="#3a2530" stroke-width="2"/><g clip-path="url(#heliClip)"><rect x="19" y="21" width="22" height="3.2" fill="#ffffff" opacity="0.9"/></g><ellipse cx="34" cy="19.5" rx="4.5" ry="5.5" fill="#5fb5e8" stroke="#3a2530" stroke-width="1.5"/><polygon points="32.5,15.5 35,15.5 33,22" fill="#cfeaff"/><rect x="23" y="28" width="2.5" height="6" fill="#3a2530"/><rect x="33" y="28" width="2.5" height="6" fill="#3a2530"/><rect x="20" y="33.5" width="20" height="2.5" rx="1.2" fill="#3a2530"/></svg>`;
  }
  function TRUCK_TOP(s){
    return `<svg viewBox="0 0 60 42" width="${s}" height="${s}" aria-hidden="true"><ellipse cx="30" cy="37" rx="22" ry="3" fill="#000" opacity="0.2"/><rect x="6" y="5" width="36" height="3.5" rx="1" fill="#c9c9c9" stroke="#3a2530" stroke-width="1.5"/><line x1="12" y1="5" x2="12" y2="8.5" stroke="#3a2530" stroke-width="1"/><line x1="20" y1="5" x2="20" y2="8.5" stroke="#3a2530" stroke-width="1"/><line x1="28" y1="5" x2="28" y2="8.5" stroke="#3a2530" stroke-width="1"/><line x1="36" y1="5" x2="36" y2="8.5" stroke="#3a2530" stroke-width="1"/><clipPath id="truckClip"><path d="M3,31 V12 Q3,10 5,10 H38 L44,10 L52,17 Q53,18 53,20 V28 Q53,32 49,32 H7 Q3,32 3,31 Z"/></clipPath><path d="M3,31 V12 Q3,10 5,10 H38 L44,10 L52,17 Q53,18 53,20 V28 Q53,32 49,32 H7 Q3,32 3,31 Z" fill="#d00000" stroke="#3a2530" stroke-width="2"/><g clip-path="url(#truckClip)"><rect x="3" y="21" width="50" height="4" fill="#ffffff"/><rect x="41" y="12" width="8" height="7" fill="#5fb5e8"/><rect x="7" y="12" width="9" height="17" fill="#c9c9c9"/><rect x="18" y="12" width="9" height="17" fill="#c9c9c9"/></g><rect x="41" y="12" width="8" height="7" fill="none" stroke="#3a2530" stroke-width="1.5"/><polygon points="43,13.5 45.5,13.5 43,17.5" fill="#cfeaff"/><rect x="7" y="12" width="9" height="17" fill="none" stroke="#3a2530" stroke-width="1.2"/><rect x="18" y="12" width="9" height="17" fill="none" stroke="#3a2530" stroke-width="1.2"/><line x1="7" y1="17" x2="16" y2="17" stroke="#3a2530" stroke-width="0.7"/><line x1="7" y1="21" x2="16" y2="21" stroke="#3a2530" stroke-width="0.7"/><line x1="18" y1="17" x2="27" y2="17" stroke="#3a2530" stroke-width="0.7"/><line x1="18" y1="21" x2="27" y2="21" stroke="#3a2530" stroke-width="0.7"/><rect x="40" y="6.5" width="2" height="3.5" fill="#3a2530"/><rect x="37" y="3" width="8" height="4" rx="1" fill="#2255ff" stroke="#3a2530" stroke-width="1.2"/><rect x="51" y="23" width="2" height="3" fill="#ffdf60" stroke="#3a2530" stroke-width="0.8"/><circle cx="12" cy="32" r="5" fill="#3a2530"/><circle cx="12" cy="32" r="2.2" fill="#9fb3c8"/><circle cx="28" cy="32" r="5" fill="#3a2530"/><circle cx="28" cy="32" r="2.2" fill="#9fb3c8"/><circle cx="44" cy="32" r="5" fill="#3a2530"/><circle cx="44" cy="32" r="2.2" fill="#9fb3c8"/></svg>`;
  }
  // nome da mostrare: nominativo radio ("APS ISPRA"), mai il codice sigla ("IS-APS")
  function nomem(mz){ return (mz && (mz.radio||mz.codice)) || "?"; }
  // nome mezzo nelle liste: medicalizzate (MSA/AUTOMEDICA/ELI) in rosso, VVF in grigio scuro (colorati senza grassetto), gli altri invariati
  function mzNomeHTML(mz, txt){
    const t = (txt==null) ? nomem(mz) : txt;
    if(mz && mz.tipo!=="CNSAS"&&mz.tipo!=="PMA" && mz.tipo!=="PMA"){
      if(mz.cat==="MSI_MSA") return `<span style="color:#d00000">${t}</span>`;
      if(mz.cat==="VVF"||mz.corpo==="VVF") return `<span style="color:#555">${t}</span>`;
    }
    return `<b>${t}</b>`;
  }
  // ---------- GRAFICHE MEZZI PNG stile LSTSim ----------
  // Vista laterale verso destra, sfondo trasparente, in src/assets/vehicles/.
  // Chiave = categoria operativa (vehKey); se il PNG manca o non e caricato, iconFor usa il fallback SVG.
  const VEH_PNG = {
    MSB: "src/assets/vehicles/rtw.png"
  };
  const VEH_W = { MSB: 64, MSA: 56, AUTOMEDICA: 48, VVF: 76, ELI: 64, ELI_VVF: 64 }; // larghezza marker proporzionata al mezzo
  const VEH_OK = {};
  function vehKey(mz){
    if(!mz) return "";
    if(mz.cat==="VVF") return mz.tipo==="ELI" ? "ELI_VVF" : "VVF";
    if(mz.tipo==="ELI") return "ELI";
    if(mz.cat==="MSI_MSA") return mz.tipo==="AUTOMEDICA" ? "AUTOMEDICA" : "MSA";
    return "MSB";
  }
  function vehImg(mz, mult){
    const k = vehKey(mz);
    if(!k || !VEH_PNG[k] || !VEH_OK[k]) return "";
    const w = Math.round((VEH_W[k]||64) * (mult||1));
    return '<img class="vehPng" src="' + VEH_PNG[k] + '" style="width:' + w + 'px;height:auto;" alt="" draggable="false">';
  }
  function preloadVeh(){
    for(const k in VEH_PNG){
      const im = new Image();
      im.onload = function(){ VEH_OK[k] = true; try{ refreshMarkers(); }catch(_){} try{ if(selMz) showMzDetail(selMz); }catch(_){} };
      im.src = VEH_PNG[k];
    }
  }
  function PMA_TOP(s){
    return `<svg viewBox="0 0 54 42" width="${s}" height="${s}" aria-hidden="true"><ellipse cx="27" cy="37" rx="19" ry="3" fill="#000" opacity="0.2"/><clipPath id="pmaClip"><path d="M7,8 H37 Q39,8 41,10 L48,16 Q49,17 49,19 V28 Q49,32 45,32 H7 Q3,32 3,28 V12 Q3,8 7,8 Z"/></clipPath><path d="M7,8 H37 Q39,8 41,10 L48,16 Q49,17 49,19 V28 Q49,32 45,32 H7 Q3,32 3,28 V12 Q3,8 7,8 Z" fill="#ffffff" stroke="#3a2530" stroke-width="2"/><g clip-path="url(#pmaClip)"><rect x="40" y="11" width="9" height="8" rx="1" fill="#5fb5e8"/><polygon points="40,19 44,11 46.5,11 42.5,19" fill="#2f7fb8"/></g><rect x="24" y="4.5" width="2" height="3.5" fill="#3a2530"/><rect x="21" y="1" width="8" height="4" rx="1" fill="#ffffff" stroke="#3a2530" stroke-width="1.2"/><rect x="40" y="11" width="9" height="8" rx="1" fill="none" stroke="#3a2530" stroke-width="1.5"/><polygon points="42,13 44.5,13 42,17.5" fill="#cfeaff"/><rect x="47" y="23" width="2" height="3" fill="#ffdf60" stroke="#3a2530" stroke-width="0.8"/><circle cx="13" cy="32" r="5.5" fill="#3a2530"/><circle cx="13" cy="32" r="2.5" fill="#9fb3c8"/><circle cx="38" cy="32" r="5.5" fill="#3a2530"/><circle cx="38" cy="32" r="2.5" fill="#9fb3c8"/></svg>`;
  }
  function iconFor(mz, px){
    const s = px||40;
    if(!mz) return "🚑";
    const _vi = vehImg(mz, s/52);
    if(_vi) return _vi;
    if(mz.cat==="VVF") return mz.tipo==="ELI" ? HELI_TOP("#d00000",s) : TRUCK_TOP(s);
    if(mz.tipo==="ELI") return HELI_TOP("#ffcf00",s);
    if(mz.tipo==="CNSAS") return SUV_TOP(s); // fuoristrada giallo CNSAS
    if(mz.tipo==="PMA") return PMA_TOP(s); // furgone tutto bianco PMA
    if(mz.cat==="MSI_MSA"){ if(mz.trasporto) return AMB_TOP("#ffcf00", s); return CAR_TOP(s); } // MSA che trasporta (MDCCST): furgone ambulanza con banda gialla
    return AMB_TOP("#d00000", s); // AMBULANZA: banda rossa
  }

  // Trasporto automatico al PS più vicino (niente proposte, niente attese):
  // appena il paziente è a bordo si parte; la destinazione resta registrata
  // per paziente (iv.pazDest) con log di partenza/arrivo/consegna.
  // ospedale valido più vicino; soloEli = solo hub con elisuperficie (trasporti ELI)
  function nearestOspedale(lat, lng, soloEli){
    let best = null, bd = 1e9;
    for(const o of D().OSPEDALI){
      if(o.ps===0) continue; // senza PS (Bellano) mai destinazione
      if(soloEli && !o.eli) continue; // eli solo sugli hub (BG, BS, CO-S.Anna, LC, MI, MB, PV, VA)
      const d = haversineKm(lat,lng,o.lat,o.lng);
      if(d<bd){ bd=d; best=o; }
    }
    return best;
  }
  function mandaOspedale(codice, ospNome){
    const mz = mezzi.find(m=>m.codice===codice);
    if(!mz) return;
    if(mz.cat==="VVF"&&!mz.trasporto){ toast("🚒 I VVF non fanno trasporti sanitari"); return; }
    if(mz.tipo==="CNSAS"){ toast("⛰️ Il CNSAS non fa trasporti sanitari"); return; }
    if(mz.tipo==="PMA"){ toast("⛺ Il PMA non fa trasporti sanitari"); return; }
    if(mz.cat==="MSI_MSA"&&!mz.trasporto){ toast("🚓 L'automedica non può trasportare: serve un'ambulanza"); return; }
    const iv = interventi.find(x=>x.id===mz.interventoId);
    if(mz.stato!=="pronto"){ toast(`🏥 ${nomem(mz)}: parte solo da PRONTO (paziente a bordo)`); return; }
    // sicurezza: niente trasporto se i pazienti non sono stabili al 100%
    if(iv && iv.trasporto && !iv.stabilizzato){
      const _att = (iv.pazienti||[]).filter((s,k)=>s!=null&&pazAttivo(iv,k));
      const min = _att.length ? Math.round(Math.min(..._att)) : 100;
      toast(`🩺 Paziente non ancora stabile (${min}%): completa la stabilizzazione al 100%`);
      return;
    }
    // 1 paziente = 1 mezzo: il mezzo pronto ha già il suo paziente (pazIdx)
    if(mz.stato==="trasporto"||mz.stato==="ospedale") return; // già partito/consegnato: niente doppio invio
    if(mz.pazIdx!=null && iv){
      if(iv.pazConsegnati && iv.pazConsegnati[mz.pazIdx]){ toast("🏥 P"+(mz.pazIdx+1)+" già consegnato in PS"); return; }
      const _occ = mezzi.find(m=>m!==mz && m.interventoId===mz.interventoId && m.pazIdx===mz.pazIdx && m.trasportaPz && (m.stato==="pronto"||m.stato==="trasporto"||m.stato==="ospedale"));
      if(_occ){ toast("🏥 "+nomem(mz)+": P"+(mz.pazIdx+1)+" già in carico a "+nomem(_occ)); return; }
    }
    if(mz.pazIdx==null){
      const lib = iv ? liberiIdx(iv) : [];
      if(iv && iv.trasporto && lib.length>0){
        mz.pazIdx = lib[0];
        mz.affido = mz.pazIdx; if(!iv.affidi) iv.affidi={}; iv.affidi[mz.pazIdx]=mz.codice; setStatoPaziente(iv,mz.pazIdx,7,"affido "+nomem(mz)); setStatoPaziente(iv,mz.pazIdx,8,"caricato su "+nomem(mz));
      }
      else { toast(`🏥 ${nomem(mz)}: nessun paziente libero — è già in carico a un altro mezzo`); return; }
    }
    const k = mz.pazIdx;
    const bis = iv ? bisognoPaziente(iv, k) : "GENERICO";
    const eli = isEli(mz); // elisoccorso: solo hub con elisuperficie (mai PMA, mai PS minori)
    let best = null;
    if(ospNome){
      best = (D().OSPEDALI||[]).find(x=>x.nome===ospNome);
      if(!best){ toast("🏥 Ospedale non trovato"); return; }
      if(best.ps===0){ toast(`🏥 ${best.nome}: niente pronto soccorso (solo riabilitazione)`); return; }
      if(eli && !best.eli){ toast(`🚁 ${best.nome}: niente elisuperficie — gli eli volano solo sugli hub (Bergamo, Brescia, Como S.Anna, Lecco, Legnano, Milano, Monza, Pavia, Varese)`); return; }
    } else {
      best = nearestOspedale(mz.lat, mz.lng, eli);
      if(!best){ toast(eli ? "🚁 Nessun hub con elisuperficie disponibile" : "🏥 Nessun ospedale disponibile"); return; }
      // PMA attivo = destinazione come un PS (vince se e il piu vicino) — mai per gli eli
      if(!eli && pma && maxiAperta()){
        let bd = haversineKm(mz.lat,mz.lng,best.lat,best.lng);
        if(haversineKm(mz.lat,mz.lng,pma.lat,pma.lng)<bd) best = {nome:"PMA", lat:pma.lat, lng:pma.lng};
      }
    }
    mz.ospedale=best.nome;
    if(iv){ if(!iv.pazDest) iv.pazDest={}; iv.pazDest[k]=best.nome; }
    vaiA(mz, best.lat, best.lng, "trasporto");
    if(iv && mz.pazIdx!=null){ if(statoPaziente(iv,mz.pazIdx)===7) setStatoPaziente(iv,mz.pazIdx,8,"caricato su "+nomem(mz)); if(statoPaziente(iv,mz.pazIdx)===8) setStatoPaziente(iv,mz.pazIdx,9,"partenza per "+best.nome); }
    if(iv){ iv.stato="trasporto"; iv.ospedale=best.nome; }
    // ogni viaggio porta 1 paziente: se ne restano, serve un'altra ambulanza
    if(iv && iv.trasporto && (iv.daTrasportare||0)>0){
      iv.daTrasportare--;
      if(iv.daTrasportare>0) log(`⚠️ Restano <b>${iv.daTrasportare}</b> pazient${iv.daTrasportare>1?"i":"e"} da trasportare — manda un'altra ambulanza`);
    }
    const km = haversineKm(mz.lat,mz.lng,best.lat,best.lng).toFixed(1);
    const codTx = " " + stNum(mz.stato); // numero di stato (7 in trasporto)
    logRadio(`🏥 ${nomem(mz)}${codTx} → ${best.nome} con <b>P${k+1}</b> (${bis} · ${km} km)`, "status");
    // nei casi gravi (rosso/giallo) le automediche sul posto seguono l'ambulanza in PS
    if(iv && iv.prio>=1 && iv.prio<=2){
      for(const c of [...iv.mezziIds]){
        const f = mezzi.find(m=>m.codice===c);
        if(f && f!==mz && isMedica(f) && f.stato==="sul_posto") mandaFollowMedica(f, best.nome, nomem(mz));
      }
    }
    refreshMarkers(); renderListe();
  }

  // automedica al seguito dell'ambulanza in ospedale (senza paziente a bordo)
  function mandaFollowMedica(mz, ospNome, ambNome){
    const o = (ospNome==="PMA"&&pma) ? {nome:"PMA",lat:pma.lat,lng:pma.lng} : ((D().OSPEDALI||[]).find(x=>x.nome===ospNome) || D().OSPEDALI[0]);
    mz.ospedale = o.nome;
    vaiA(mz, o.lat, o.lng, "trasporto");
    const codF = " " + stNum(mz.stato); // numero di stato (7 in trasporto)
    logRadio(`🚓 ${nomem(mz)}${codF} segue ${ambNome} in PS (${o.nome})`, "status");
    refreshMarkers(); renderListe();
  }

  // missioni congiunte VVF+118: se c’è un ferito e un’ambulanza/eli del 118 legata
  // all’intervento, la parte sanitaria vive di vita propria anche su chiamate nate
  // VVF (trasporto=false): niente rientri a vuoto con pazienti da assistere
  function apriFabbisognoSanitario(iv){
    if(!iv || iv.trasporto || iv.stato==="chiuso") return;
    if(!(iv.pazienti||[]).some((x,k)=>x!=null&&pazAttivo(iv,k))) return;
    const amb = mezzi.some(m=>m.interventoId===iv.id && m.corpo!=="VVF" && m.trasporto);
    if(!amb) return;
    iv.trasporto = true;
    let n = 0;
    for(let k=0;k<iv.pazienti.length;k++){ if(iv.pazienti[k]!=null && !(iv.pazConsegnati&&iv.pazConsegnati[k]) && pazAttivo(iv,k)) n++; }
    iv.daTrasportare = n;
    iv.stabilizzato = !(iv.pazienti||[]).some((x,k)=>x!=null&&x<100&&pazAttivo(iv,k));
    log(`🚑 A <b>${iv.comune}</b>: feriti da assistere e trasportare — la missione sanitaria prosegue`, "status");
    renderListe();
  }
  function checkChiusura(iv){
    if(!iv || iv.stato==="chiuso") return; // idempotente: mai due chiusure (no doppi in archivio/punti/log)
    // chiudi se: nessun mezzo assegnato E (e stato gestito almeno una volta) — MA non con
    // pazienti ancora da consegnare (missioni con trasporto) né con feriti senza ambulanza (VVF)
    // né con verifiche sul numero dei feriti ancora aperte (si chiude a mano, mai da sola)
    const pendingPz = pazientiInSospeso(iv)>0 && (iv.trasporto || iv.vvf);
    if(iv.mezziIds.length===0 && iv.gestito && !(pendingPz || (iv.trasporto && (iv.daTrasportare||0)>0) || iv.pazDaVerificare || (iv.fuoco && !iv.fuoco.spento))){
      chiudiPazientiMissione(iv,"auto");
      iv.stato="chiuso";
      chiusi++;
      const attesaMin = Math.max(0, clockMin - iv.t0);
      let pts = 100;
      if(iv.prio===1 && attesaMin<6) pts+=50;
      if(attesaMin>20) pts-=40;
      if(attesaMin>40) pts-=60;
      score+=pts;
      log(`\u2705 Chiuso a <b>${iv.comune}</b>`, "ok");
      statChiudi(iv, "auto"); // statistiche: chiusura in archivio
      interventi = interventi.filter(x=>x.id!==iv.id);
      if(selectedId===iv.id) selectedId=null;
      refreshMarkers(); renderListe(); updateStats();
    }
  }

  // ---------- METEO: evolve col tempo, sposta le probabilità di ogni tipo ----------
  let meteo = {cond:"Nuvoloso", temp:14};
  let meteoTimer = 0;
  let meteoLastReal = Date.now(); // ultimo cambio effettivo (orologio reale)
  const METEO_NEXT = {
    Sereno:{temp:[18,28], next:{Sereno:60,Nuvoloso:24,Nebbia:6,Vento:10}},
    Nuvoloso:{temp:[13,20], next:{Nuvoloso:45,Sereno:18,Pioggia:18,Nebbia:9,Vento:10}},
    Nebbia:{temp:[8,15], next:{Nebbia:40,Nuvoloso:25,Sereno:20,Pioggia:15}},
    Pioggia:{temp:[9,16], next:{Pioggia:43,"Pioggia intensa":12,Nuvoloso:20,Temporale:13,Vento:12}},
    "Pioggia intensa":{temp:[8,14], next:{"Pioggia intensa":35,Pioggia:35,Temporale:15,Nuvoloso:15}},
    Temporale:{temp:[11,18], next:{Temporale:28,Pioggia:35,"Pioggia intensa":14,Nuvoloso:15,Vento:8}},
    Vento:{temp:[11,19], next:{Vento:35,Nuvoloso:28,Sereno:12,Temporale:12,Pioggia:13}},
  };
  const METEO_EMOJI = {Sereno:"☀️",Nuvoloso:"☁️",Nebbia:"🌫️",Pioggia:"🌦️","Pioggia intensa":"🌧️",Temporale:"⛈️",Vento:"💨"};
  // selettore meteo manuale: il riquadro in alto diventa un tasto con le 7 condizioni;
  // "Vento" si mostra come "Vento forte". La scelta vale subito, poi il meteo evolve da solo.
  const METEO_SCELTE = ["Sereno","Nuvoloso","Nebbia","Pioggia","Pioggia intensa","Temporale","Vento"];
  const METEO_NOME = {Vento:"Vento forte"};
  function meteoNome(c){ return METEO_NOME[c]||c; }
  function impostaMeteo(c){
    if(!METEO_NEXT[c]) return false;
    meteo.cond = c;
    const lim = METEO_NEXT[c].temp;
    if(lim) meteo.temp = rnd(lim[0],lim[1]);
    meteoTimer = 0; meteoLastReal = Date.now(); meteoUpdate();
    return true;
  }
  function wireMeteo(){
    const btn = $("meteoBtn"), menu = $("meteoMenu");
    if(!btn || !menu || btn._w) return; btn._w = true;
    menu.innerHTML = "";
    for(const c of METEO_SCELTE){
      const b = document.createElement("button");
      b.className = "lstBtn small"; b.style.cssText = "display:block;width:100%;text-align:left;margin:1px 0;";
      b.textContent = (METEO_EMOJI[c]||"") + " " + meteoNome(c);
      // scelta manuale: solo stato in header, niente radio (non e una comunicazione operativa)
      b.onclick = e=>{ e.stopPropagation(); impostaMeteo(c); menu.hidden = true; };
      menu.appendChild(b);
    }
    btn.onclick = e=>{ e.stopPropagation(); menu.hidden = !menu.hidden; };
    document.addEventListener("click", ()=>{ menu.hidden = true; });
  }
  // orologio a tasto: scelta manuale dell’ora di gioco (presets + ora esatta);
  // cambia subito fasce orarie, pesi notte/giorno e coerenza missioni
  function impostaOrario(h, m){
    h = Math.max(0, Math.min(23, h|0)); m = Math.max(0, Math.min(59, m|0));
   clockMin = h*60+m; updateClock();
    applicaTurni(); // cambio ora manuale: i mezzi a turno entrano/escono subito dal servizio
   // cambio ora: solo orologio aggiornato, niente radio (non e una comunicazione operativa)
    return true;
  }
  function wireOra(){
    const btn = $("oraBtn"), menu = $("oraMenu");
    if(!btn || !menu || btn._w) return; btn._w = true;
    menu.querySelectorAll("[data-h]").forEach(b=>{ b.onclick = e=>{ e.stopPropagation(); impostaOrario(+b.dataset.h, 0); menu.hidden = true; }; });
    const vai = $("oraVai");
    if(vai) vai.onclick = e=>{ e.stopPropagation(); const v = ($("oraInput")||{}).value || "08:00"; const p = v.split(":"); impostaOrario(+p[0], +(p[1]||0)); menu.hidden = true; };
    btn.onclick = e=>{ e.stopPropagation(); const inp = $("oraInput"); if(inp) inp.value = String(Math.floor(clockMin/60)).padStart(2,"0") + ":" + String(Math.floor(clockMin%60)).padStart(2,"0"); menu.hidden = !menu.hidden; };
    document.addEventListener("click", ()=>{ menu.hidden = true; });
  }
  function meteoUpdate(){
    const el=$("wetter");
    if(el) el.textContent=`${meteoNome(meteo.cond)}, ${Math.round(meteo.temp)} °C ${METEO_EMOJI[meteo.cond]||""}`;
    // effetti visivi sulla mappa: disattivati su richiesta (il maltempo genera comunque danni)
  }
  function meteoTick(dtGameMin){
    meteoTimer += dtGameMin;
    meteo.temp += rnd(-0.15,0.15)*dtGameMin*0.2;
    // cambio ogni 2,5-4,5 ore di gioco E almeno ogni 3 minuti reali: ad alta velocità
    // il meteo non impazzisce più (prima cambiava ogni ~30 secondi a 100x)
    if(meteoTimer < 150+rnd(0,120)) return;
    if(Date.now()-meteoLastReal < 180000) return;
    meteoTimer = 0;
    meteoLastReal = Date.now();
    const cfg = METEO_NEXT[meteo.cond] || METEO_NEXT.Nuvoloso;
    let r = Math.random()*100, nc = meteo.cond;
    for(const k of Object.keys(cfg.next)){ r-=cfg.next[k]; if(r<=0){ nc=k; break; } }
    // il meteo evolve da solo: solo stato in header, niente radio (non e una comunicazione operativa)
    if(nc!==meteo.cond){ meteo.cond=nc; }
    const lim = cfg.temp; meteo.temp += (rnd(lim[0],lim[1])-meteo.temp)*0.4;
    meteoUpdate();
  }

  // ---------- SIM TICK ----------
  // libera il mezzo dalla scena e lo rimanda in sede (resta legato all'intervento finché arriva: marker visibile, niente sparizioni)
  function rientraDaScena(mz, iv2){
    if(mz.trasportaPz || mz.pazIdx!=null || mz.stato==="pronto"||mz.stato==="trasporto"||mz.stato==="ospedale") return; // mai staccare un mezzo con paziente
    if(iv2){ iv2.gestito=true; }
    const ivId = mz.interventoId;
    suppLog(iv2, gruppoSupporto(mz), "fine-scena", mz.codice, null);
    statStacco(mz, iv2, "auto"); // statistiche: distacco con eventuali sospesi
    vaiA(mz, mz.baseLat, mz.baseLng, "rientro");
    const ivv = interventi.find(x=>x.id===ivId);
    if(ivv){
      ivv.mezziIds=ivv.mezziIds.filter(c=>c!==mz.codice);
      notaFineEnte(ivv, mz.corpo==="VVF"?"VVF":"118");
      if(ivv.mezziIds.length===0){ ivv.gestito=true; checkChiusura(ivv); }
    }
  }
  function tick(dtRealSec){
    if(paused) return;
    const dtGameMin = dtRealSec/60*speed*4; // speed 4 => ~16 game-sec per real-sec? tarato sotto
    // Avanza orologio: speed = game-min per real-sec
   clockMin += dtRealSec*speed/60;
   if(clockMin>=24*60) clockMin-=24*60;
    applicaTurni(); // mezzi a turno (es. NEF Magenta): entrano/escono dal servizio alla loro ora
   statTick(dtGameMin); // statistiche: orologio cumulativo, giorni, servizio mezzi
    meteoTick(dtRealSec*speed/60);
    stormTick(dtRealSec*speed/60); // maltempo che picchia: danni in diretta

    // afflusso dinamico: ogni chiamata programma da sé la successiva (regimi base/
    // picco/calma); accetta/rifiuta/chiudi non toccano mai il conto alla rovescia.
    // Il while recupera i cicli persi (tab in background) e fa partire le raffiche
    // davvero insieme — mai più di 6 scatti a tick, e a centrale satura si salta.
    if(autoInflow){
      flusso.attesa -= dtRealSec*speed/60; // game-min trascorsi
      let scatti = 0;
      while(flusso.attesa<=0 && scatti<6){ scattaFlusso(); scatti++; }
    }

    // muovi mezzi
    for(const mz of mezzi){
      if(mz.stato==="viaggio"||mz.stato==="trasporto"||mz.stato==="rientro"){
       // avanza lungo il percorso stradale (fallback dritto se manca); gli eli volano dritti e più veloci
        const gameHours = (dtRealSec*speed/60)/60*boostMoto();
        if(mz.uscita>0){
          // equipaggio ancora in uscita dalla sede: fermo finché non esce (30"-60" di gioco)
          mz.uscita -= dtRealSec*speed/60;
          moveMarkerMz(mz);
        } else if (advanceAlongPath(mz, gameHours)){ // velocita reali per tratto dentro advanceAlongPath
          // arrivato
          mz.lat=mz.targetLat; mz.lng=mz.targetLng;
          onArrivo(mz);
        } else {
          moveMarkerMz(mz);
        }
      } else if(mz.stato==="sul_posto"){
        mz.sulPostoTimer -= dtRealSec*speed/60;
        const iv = interventi.find(x=>x.id===mz.interventoId);
        if(iv) iv.tempoSulPosto += dtRealSec*speed/60;
        if(iv) apriFabbisognoSanitario(iv);
        // Rilevazione MSA/MSI sempre attiva (§1-2: anche in attesa del medicalizzato,
        // anche a scena ferma): ogni paziente sotto il 35% chiede il medicalizzato, una
        // volta sola per paziente — il ritrovamento non aspetta le cure in corso.
        // Radio: una sola riga per missione, per il primo critico (annunciaMSA).
        if(iv && (mz.corpo!=="VVF"||isEli(mz))){
          for(let k=0;k<(iv.pazienti||[]).length;k++){
            if(iv.pazienti[k]!=null && iv.pazienti[k]<SOGLIA_MSA && pazAttivo(iv,k)){
              if(!iv.pazMSA) iv.pazMSA = [];
              if(!iv.pazMSA[k]){
                iv.pazMSA[k] = true;
                ensureSupporti(iv);
                registraRichiesta(iv, "MSA", Math.max((iv.supporti.MSA&&iv.supporti.MSA.richiesti)||0, 1), motivoMSA(iv));
                annunciaMSA(iv, k); // una sola riga per missione: solo il primo critico
              }
            }
          }
          aggiornaMSA(iv); // coda per gravità, presa in carico del più critico, attesa se nessuno sul posto
        }
        // cura sul posto: il personale sanitario stabilizza i pazienti verso il 100%;
        // senza 100% su tutti non si carica e non si trasporta (niente PRONTO, niente PS).
        // Se la scena ha chiesto un MSA, l'equipaggio aspetta il suo arrivo prima di curare/caricare.
        if(iv && iv.trasporto && !iv.stabilizzato && !msaAtteso(iv) && (iv.pazienti||[]).some(s=>s<100) && mz.tipo!=="CNSAS"&&mz.tipo!=="PMA" && (mz.corpo!=="VVF"||isEli(mz))){
          const avanzato = (mz.tipo==="MSA"||mz.tipo==="AUTOMEDICA"||isEli(mz));
          const rate = (mz.tipo==="MSA"||isEli(mz)) ? 9 : mz.tipo==="MSB" ? 5 : 4; // % salute per game-min
          const q = dtRealSec*speed/60*rate;
          // UN MEZZO = UN PAZIENTE (assegnazione stabile per tutto l'intervento: niente
          // rimbalzi tra feriti): l'MSB segue un solo paziente (il peggiore tra quelli liberi);
          // MSA/MSI segue solo quello per cui è stato richiesto (flag iv.pazMSA: sotto soglia).
          // REGOLA UNIVERSALE: sotto il 35% il paziente resta in gestione finché il
          // medicalizzato non arriva davvero (niente stabilizzazione/affido senza di lui).
          if(!iv.curaDi) iv.curaDi = {};
          const sulPosto = mezzi.filter(m=>m.stato==="sul_posto" && m.interventoId===iv.id && (m.corpo!=="VVF"||isEli(m)));
          const curanti = sulPosto.filter(m=>(m.tipo==="MSB"||m.tipo==="MSA"||m.tipo==="AUTOMEDICA"||isEli(m))).map(m=>m.codice);
          const attiviSotto100 = ()=>{
            const arr = [];
            for(let k=0;k<iv.pazienti.length;k++){
              if(!pazAttivo(iv,k)) continue; // deceduto/consegnato: salute congelata
              if(iv.pazienti[k]==null || iv.pazienti[k]>=100) continue;
              arr.push(k);
            }
            arr.sort((a,b)=>iv.pazienti[a]-iv.pazienti[b]); // peggiore prima
            return arr;
          };
          const inPool = (k)=>{
            if(!avanzato) return true;
            const fl = attiviSotto100().filter(x=>iv.pazMSA && iv.pazMSA[x]);
            if(!fl.length) return true; // nessuno da medicalizzare: dà una mano sul peggiore (mai stallo)
            return !!(iv.pazMSA && iv.pazMSA[k]);
          };
          let target = iv.curaDi[mz.codice];
          if(avanzato && iv.valutato){
            // MSA/MSI: segue il paziente assegnatogli — il più critico tra quelli in
            // attesa (assegnaMSA: mai interrotto, mai due mezzi sullo stesso paziente).
            // Senza bisognosi dà una mano sul peggiore libero (mai stallo).
            const a = assegnaMSA(iv, mz);
            if(a>=0){ target = a; iv.curaDi[mz.codice] = a; }
            else {
              const tutti = attiviSotto100();
              const libero = tutti.filter(k=>!curanti.some(c=>c!==mz.codice && iv.curaDi[c]===k));
              target = (libero.length ? libero[0] : tutti[0]);
              if(target==null) target = -1; else iv.curaDi[mz.codice] = target;
            }
          } else if(target==null || !pazAttivo(iv,target) || iv.pazienti[target]==null || iv.pazienti[target]>=100 || !inPool(target)){
            const tutti = attiviSotto100();
            let pool = avanzato ? tutti.filter(x=>iv.pazMSA && iv.pazMSA[x]) : tutti;
            if(!pool.length) pool = tutti; // fallback: peggiore libero (mai stallo)
            // l'MSB non ruba i pazienti già presi in carico da un avanzato sul posto
            const msaOcc = new Set();
            if(!avanzato) for(const cod in (iv.msaDi||{})){
              if(cod===mz.codice) continue;
              const mm = mezzi.find(x=>x.codice===cod);
              if(mm && mm.interventoId===iv.id && mm.stato==="sul_posto" && isAvanzato(mm)) msaOcc.add(iv.msaDi[cod]);
            }
            const libero = pool.filter(k=>!msaOcc.has(k) && !curanti.some(c=>c!==mz.codice && iv.curaDi[c]===k));
            target = (libero.length ? libero[0] : pool[0]);
            if(target==null) target = -1; else iv.curaDi[mz.codice] = target;
          }
          if(target>=0){
            const sotto = iv.pazienti[target]!=null && iv.pazienti[target]<SOGLIA_MSA;
            const qq = sotto ? q*0.4 : q; // sotto il 35% la salute risale più lentamente (×0,4)
            iv.pazienti[target] = Math.round(Math.min(100, iv.pazienti[target]+qq)*10)/10;
          }
          if(iv.pazienti.every((s,k)=>s>=100||!pazAttivo(iv,k))){
            iv.stabilizzato = true;
            for(let _k=0;_k<(iv.pazienti||[]).length;_k++){ if(statoPaziente(iv,_k)===4 && iv.trasporto) setStatoPaziente(iv,_k,6,"stabilizzato: pronto al carico"); }
            affidoImmediato(iv); // ambulanza già sul posto: la scritta "in attesa di ambulanza" sparisce subito
            log(`💚 Pazienti stabilizzati al 100% a <b>${iv.comune}</b> — pronti per il trasporto`, "ok");
            refreshMarkers(); renderListe();
          } else {
            // la % visibile sale di 1 alla volta (1,2,3…): mostra ogni punto intero,
            // con throttle anti-spam ad alta velocità (a 1x il throttle non scatta mai)
            const shown = (iv.pazienti||[]).map(s=>Math.round(s)).join(",");
            const ora = performance.now();
            if(shown!==iv._curaShown && ora-(iv._curaT||0)>250){ iv._curaShown = shown; iv._curaT = ora; renderListe(); }
          }
        }
        if(mz.sulPostoTimer<=0){
          // fine sul posto: il paziente viaggia solo in ambulanza;
          // MSA1/MSA2 non trasportano: nei casi gravi seguono l'ambulanza in PS, altrimenti rientrano (come VVF)
          const iv2 = interventi.find(x=>x.id===mz.interventoId);
          if(iv2 && iv2.trasporto && mz.trasporto){
            if(msaAtteso(iv2)){
              mz.sulPostoTimer = 1; // MSA richiesto ma non ancora arrivato: si aspetta, niente carico
              renderListe();
           } else if(iv2.stabilizzato && iv2.reportFatto){
             // paziente caricato solo se ce n'è uno libero (1 paziente = 1 mezzo):
             // chi è pronto dopo, a pazienti esauriti, rientra invece di andare in PS a vuoto (parte da solo chi ha il paziente)
             // il mezzo PRONTO parte da solo per il PS più vicino (trasporto automatico)
             const lib = liberiIdx(iv2);
             if(mz.affido==null){
               if(lib.length>0){
                 mz.affido = lib[0]; if(!iv2.affidi) iv2.affidi={}; iv2.affidi[lib[0]]=mz.codice;
                 setStatoPaziente(iv2, lib[0], 7, "affido "+nomem(mz));
                 mz.sulPostoTimer = 1.5;
                 log(`👨‍⚕️ ${nomem(mz)}: <b>P${lib[0]+1}</b> preso in carico, carico in corso`, "ok");
                 refreshMarkers(); renderListe();
               } else if((iv2.pazienti||[]).some((ss,kk)=>ss!=null && pazAttivo(iv2,kk) && !(iv2.pazConsegnati&&iv2.pazConsegnati[kk]) && !pazEleggibileCarico(iv2,kk))){
                 mz.sulPostoTimer = 2; // incastrati in attesa di liberazione: aspetta sul posto, non rientrare
                 renderListe();
               } else {
                const chi = claimants(iv2.id).map(nomem).join(", ") || "un altro mezzo";
                log(`${isEli(mz)?"🚁":"🚑"} ${nomem(mz)}: nessun paziente libero (già in carico a ${chi}) — rientra in sede`, "status");
                rientraDaScena(mz, iv2);
                renderListe();
               }
             } else if(!pazEleggibileCarico(iv2, mz.affido)){
               if(iv2.affidi) delete iv2.affidi[mz.affido];
               if(statoPaziente(iv2, mz.affido)===7) setStatoPaziente(iv2, mz.affido, 6, "affido decaduto");
               mz.affido = null; mz.sulPostoTimer = 1;
               renderListe();
             } else {
               const _ak = mz.affido;
               if(statoPaziente(iv2,_ak)!==7){
                 if(iv2.affidi) delete iv2.affidi[_ak]; mz.affido = null; mz.sulPostoTimer = 1;
                 renderListe();
               } else {
               mz.trasportaPz = false; mz.pazIdx = null;
               mz.trasportaPz = true; mz.pazIdx = _ak;
               setStatoPaziente(iv2, _ak, 8, "caricato su "+nomem(mz));
               mz.stato="pronto"; mz.sulPostoTimer=0;
               // la partenza la annuncia mandaOspedale (un solo messaggio con destinazione): niente doppioni
               mandaOspedale(mz.codice);
               refreshMarkers(); renderListe();
               }
             }
            } else {
              mz.sulPostoTimer = 1; // pazienti non ancora stabili al 100%: resta sul posto a curare
              renderListe();
            }
          } else if(iv2 && (isMedica(mz)||mz.tipo==="AUTOMEDICA")){
            const amb = mezzi.find(m=>m.interventoId===iv2.id && m!==mz && !isMedica(m) && m.corpo!=="VVF" && (m.stato==="trasporto"||m.stato==="ospedale") && m.ospedale);
            const ambInArrivo = !amb && iv2.trasporto && iv2.prio<=2 && mezzi.some(m=>m.interventoId===iv2.id && m!==mz && !isMedica(m) && m.corpo!=="VVF" && (m.stato==="viaggio"||m.stato==="sul_posto"));
            const ambPronta = !amb && iv2.trasporto && iv2.prio<=2 && mezzi.some(m=>m.interventoId===iv2.id && m!==mz && !isMedica(m) && m.corpo!=="VVF" && m.stato==="pronto");
            if(amb && iv2.prio<=2){
              mandaFollowMedica(mz, amb.ospedale, nomem(amb));
            } else if(ambPronta){
              mz.sulPostoTimer = rnd(4,7); // l'ambulanza è pronta: aspetta che parta per seguirla in PS
            } else if(ambInArrivo && (mz.atteseFollow||0)<6){
              mz.atteseFollow=(mz.atteseFollow||0)+1;
              mz.sulPostoTimer = rnd(4,7); // aspetta che l'ambulanza parta per seguirla
            } else {
              mz.atteseFollow=0;
              rientraDaScena(mz, iv2);
            }
          } else if(mz.corpo==="VVF" && !mz.trasporto){
            // i VVF restano sul posto finché l'operatore non li fa rientrare (Rientra o Chiudi): niente rientro automatico
            mz.sulPostoTimer = rnd(8,15);
            renderListe();
          } else if(mz.tipo==="CNSAS"||mz.tipo==="PMA"){
            // CNSAS/PMA restano sul posto finché l'operatore non li fa rientrare (come i VVF): solo presenza, niente rientro automatico
            mz.sulPostoTimer = rnd(8,15);
            renderListe();
          } else {
            rientraDaScena(mz, iv2);
          }
          renderListe();
        }
      } else if(mz.stato==="ospedale"){
        mz.sulPostoTimer -= dtRealSec*speed/60;
        if(mz.sulPostoTimer<=0){
          const ivId=mz.interventoId;
          const ivv=interventi.find(x=>x.id===ivId);
          if(ivv && mz.pazIdx!=null){
            if(!ivv.pazConsegnati) ivv.pazConsegnati={};
            ivv.pazConsegnati[mz.pazIdx]=true;
            if(!ivv.pazMezzo) ivv.pazMezzo={}; ivv.pazMezzo[mz.pazIdx]=mz.codice; // audit: quale ambulanza ha portato il paziente
            setStatoPaziente(ivv, mz.pazIdx, 10, "handover in PS"); if(ivv.affidi) delete ivv.affidi[mz.pazIdx];
            try{ if(window.COEUGLOB) COEUGLOB.bumpPS(pazUid(ivv, mz.pazIdx)); }catch(_){} // statistiche globali: paziente trasportato
            log(`✅ <b>P${mz.pazIdx+1}</b> consegnato a <b>${mz.ospedale||"PS"}</b> da ${nomem(mz)} (${bisognoPaziente(ivv,mz.pazIdx)})`, "ok");
          }
          if(ivv){ ivv.gestito=true; ivv.mezziIds=ivv.mezziIds.filter(c=>c!==mz.codice); notaFineEnte(ivv, mz.corpo==="VVF"?"VVF":"118"); if(ivv.mezziIds.length===0) checkChiusura(ivv); }
          mz.ospedale=null; mz.ospedaleScelto=null; mz.trasportaPz=false; mz.pazIdx=null;
          vaiA(mz, mz.baseLat, mz.baseLng, "rientro");
          log(`↩️ ${nomem(mz)} libero da PS, rientra`, "status");
          renderListe();
        }
      }
    }

    // attesa interventi
    for(const iv of interventi){
      if(iv.stato==="attesa") iv.attesa = clockMin-iv.t0;
    }
    verificaTimer += dtRealSec*speed/60; if(verificaTimer>=5){ verificaTimer = 0; verificaStati(); }
    codeMortiCoda();
    scenaTick(dtRealSec*speed/60); // sopralluogo, evoluzione VVF e solleciti via radio

    // refresh UI leggera ogni tick
    updateClock();
    // aggiorna posizioni marker mezzi ogni tick (già fatto per movimento) + clock stats ogni 2s
    if(Math.floor(performance.now()/1000)%2===0){ updateStats(); }
  }

  function onArrivo(mz){
    if(mz.stato==="rientro"){
      mz.stato="disponibile"; mz.interventoId=null; mz.targetLat=null; mz._t0=null;
      // rientro completato: solo stato in scheda e mappa, niente radio (la partenza era gia annunciata)
      refreshMarkers(); renderListe(); updateStats();
      return;
    }
    if(mz.stato==="trasporto"){
      mz.stato="ospedale"; mz.sulPostoTimer=rnd(4,9); // handover PS in game-min
      const ivT = interventi.find(x=>x.id===mz.interventoId);
      const pk = (mz.pazIdx!=null) ? ` con <b>P${mz.pazIdx+1}</b>${ivT?" ("+bisognoPaziente(ivT,mz.pazIdx)+")":""}` : "";
      log(`🏥 ${nomem(mz)} in PS (${mz.ospedale})${pk}`, "status");
      refreshMarkers(); renderListe();
      return;
    }
    if(mz.stato==="viaggio"){
      mz.stato="sul_posto";
      const iv = interventi.find(x=>x.id===mz.interventoId);
      if(iv){
        iv.stato="sul_posto"; iv.gestito=true; iv.tSulPosto=clockMin;
        // durata sul posto = durata intervento (se più mezzi, usa max)
        mz.sulPostoTimer = iv.durata * (iv.vvf ? rnd(1.4,2.0) : rnd(0.8,1.2)); // i VVF tecnici poi restano sul posto finché l'operatore non li fa rientrare (niente rientro automatico, vedi tick)
        if(iv.attesaMSA && isAvanzato(mz)){
          iv.attesaMSA = false; // un medicalizzato è sul posto: si può stabilizzare e caricare
          logRadio(`🚓 ${nomem(mz)} ${stNum(mz.stato)} sul posto: supporto avanzato arrivato, l'equipaggio riprende`, "status");
        }
        // l'arrivo fisico non chiude i bisogni né cancella la coda: il mezzo prende in
        // carico il paziente più critico in attesa (registrato in iv.msaDi); gli altri
        // restano in gestione con la richiesta attiva finché non tocca a loro
        if(isAvanzato(mz)) assegnaMSA(iv, mz);
        registraArrivo(iv, mz); // arrivo effettivo: una sola volta, solo sulla missione giusta
        affidoImmediato(iv); // ambulanza appena arrivata: niente più "in attesa di ambulanza"
        // prima il sopralluogo: cosa è successo e quanti feriti lo riferiscono via radio dopo aver valutato
        // (un solo annuncio di arrivo per missione: chi arriva dopo resta in silenzio radio)
        if(!iv.valutato){
          if(iv.sopralluogo==null) iv.sopralluogo = iv.vvf ? rnd(2,4) : rnd(2,5);
          if(!iv.ferroDetto && iv.zona==="ferro"){ iv.ferroDetto = true; log(`🚂 Circolazione sospesa nel tratto di <b>${iv.comune}</b>: mezzi su gomma, restate fuori dai binari`); }
          for(let _k=0;_k<(iv.pazienti||[]).length;_k++){ if(statoPaziente(iv,_k)===1) setStatoPaziente(iv,_k,2,"arrivo "+nomem(mz)); }
          if(!iv.arrivoDetto){ iv.arrivoDetto = true; logRadio(iaRadio(iv.vvf?"arrivoVVF":"arrivo", {mezzo:nomem(mz)+" "+stNum(mz.stato), comune:iv.comune}, iv.vvf ? `🚒 ${nomem(mz)+" "+stNum(mz.stato)} sul posto a <b>${iv.comune}</b>: stiamo valutando la situazione, vi aggiorno tra poco` : `🔍 ${nomem(mz)+" "+stNum(mz.stato)} sul posto a <b>${iv.comune}</b>: sopralluogo in corso, vi riferisco tra poco`)); }
        }
        // arrivi successivi al primo: solo stato in scheda, niente radio (il primo ha gia riferito)
        else { if(iv && iv.valutato && mz.corpo!=="VVF"){ for(let _k=0;_k<(iv.pazienti||[]).length;_k++){ if(statoPaziente(iv,_k)===3) setStatoPaziente(iv,_k,4,"118 sul posto"); } } }
      } else {
        mz.sulPostoTimer=5;
      }
      refreshMarkers(); renderListe(); updateStats();
    }
  }

  // annuncio sotto-soglia: UNA sola riga per missione, per il primo paziente critico
  function annunciaMSA(iv,k){
    if(!iv || iv.msaDetto) return;
    iv.msaDetto = true;
    logRadio(`⏳ A <b>${iv.comune}</b>: <b>P${k+1}</b> sotto il 35% — inviate un mezzo medicalizzato`, "alarm");
  }
  // motivo della richiesta MSA: clinico ma senza rivelare il tipo vero (già visibili salute e codice)
  function motivoMSA(iv){
    const ps = (iv.pazienti||[]).filter((s,k)=>s!=null&&pazAttivo(iv,k));
    const min = ps.length ? Math.round(Math.min(...ps)) : null;
    if(min!=null && min<25) return `paziente critico (salute ${min}%)`;
    if(min!=null && min<50) return `paziente grave (salute ${min}%)`;
    if(iv.truePrio===1) return "codice rosso, serve equipaggio medicalizzato";
    if(iv.truePrio===2) return "paziente instabile, serve equipaggio medicalizzato";
    return "serve supporto sanitario avanzato";
  }

  // --- NUMERO DINAMICO: scoperta progressiva dei feriti da parte delle squadre ---
  // Ogni nuovo paziente nasce UNA sola volta (dai nascosti pre-generati alla creazione:
  // mai inventati, mai duplicati, mai rimossi): prende il primo indice libero con UID
  // stabile "M{id}-P{n}", stato iniziale coerente con la scena e la sua ambulanza (1=1)
  // senza aspettare che il totale sia noto. Statistiche e richieste si aggiornano da
  // sole (live su iv.pazienti, chiusure sul finale).
  function rivelaPaziente(iv, mz){
    const s = (iv.pazientiNascosti||[]).shift();
    const p = (iv.profiliNascosti||[]).shift();
    if(s==null || !p) return false;
    const k = (iv.pazienti||[]).length;
    iv.pazienti.push(s);
    if(!iv.profili) iv.profili = [];
    iv.profili.push(p);
    if(!iv.pazIds) iv.pazIds = [];
    iv.pazIds[k] = "M"+iv.id+"-P"+(k+1); // stesso formato degli altri: identificato una sola volta
    const intr = p.intr && !((iv.liberati||{})[k]);
    const has118 = mezzi.some(m=>m.interventoId===iv.id && m.stato==="sul_posto" && m.corpo!=="VVF");
    setStatoPaziente(iv,k,2,"individuato sul posto");
    if(intr) setStatoPaziente(iv,k,5,"intrappolato: serve liberazione");
    else if(has118) setStatoPaziente(iv,k,4,"valutato dal 118");
    else setStatoPaziente(iv,k,3,"individuato, in attesa");
    if(iv.trasporto){
      iv.daTrasportare = (iv.daTrasportare||0)+1; // un'altra ambulanza per lui (1=1)
      iv.stabilizzato = false; // da curare al 100% come gli altri: niente PRONTO finché non è stabile
      ensureSupporti(iv);
      registraRichiesta(iv, "ALTRO", Math.max(iv.supporti.ALTRO.richiesti||0, (iv.pazienti||[]).length), "ambulanze per i pazienti da trasportare");
    } else apriFabbisognoSanitario(iv); // missioni VVF: la parte sanitaria vive se c'è un 118 con trasporto
    if(s<SOGLIA_MSA){ // critico scoperto dopo: medicalizzato come al report (stessa soglia,
      // anche con un avanzato già sul posto: resta in coda finché non lo prende in carico)
      if(!iv.pazMSA) iv.pazMSA = [];
      iv.pazMSA[k] = true;
      ensureSupporti(iv);
      registraRichiesta(iv, "MSA", Math.max((iv.supporti.MSA&&iv.supporti.MSA.richiesti)||0, 1), motivoMSA(iv));
      annunciaMSA(iv, k); // una sola riga per missione: solo il primo critico
      aggiornaMSA(iv); // attesa se nessuno sul posto, altrimenti coda per gravità
    }
    log(`🔍 ${nomem(mz)} a <b>${iv.comune}</b>: trovato un altro ferito (${Math.round(s)}%${s<SOGLIA_MSA?", critico":""}) — ${iv.pazienti.length} pazienti finora, serve un'altra ambulanza!`, "alarm");
    return true;
  }
  // verifiche in corso: rivela a gruppi (1-2 alla volta) oppure conferma che non ce ne sono altri
  function scopriPazienti(iv, mz){
    if((iv.pazientiNascosti||[]).length>0){
      const n = iv.pazientiNascosti.length>3 ? 2 : 1;
      for(let i=0;i<n && (iv.pazientiNascosti||[]).length>0;i++) rivelaPaziente(iv, mz);
    }
    if((iv.pazientiNascosti||[]).length===0 && iv.pazDaVerificare){
      iv.pazDaVerificare = false;
      const tot = (iv.pazienti||[]).length;
      log(`✅ ${nomem(mz)} a <b>${iv.comune}</b>: verifiche concluse — ${tot===0?"nessuna persona coinvolta":tot===1?"un solo paziente, nessun altro ferito":"nessun altro ferito (totale "+tot+" pazienti)"}`, "ok");
    }
    renderListe();
  }

  // --- REPORT DI SCENA: il primo mezzo arrivato descrive cosa ha trovato e chiede rinforzi se servono ---
  function reportScena(iv, mz){
    if(iv.pazDaVerificare && iv.scopTra==null) iv.scopTra = rnd(4,9); // verifiche armate: si scoprono altri feriti o si conferma che non ce ne sono
    for(let _k=0;_k<(iv.pazienti||[]).length;_k++){
      if(statoPaziente(iv,_k)!==2) continue;
      const _intr = (iv.profili||[])[_k] && iv.profili[_k].intr && !((iv.liberati||{})[_k]);
      const _118 = mezzi.some(m=>m.interventoId===iv.id && m.stato==="sul_posto" && m.corpo!=="VVF");
      if(_intr) setStatoPaziente(iv,_k,5,"intrappolato: serve liberazione");
      else if(_118) setStatoPaziente(iv,_k,4,"valutato dal 118");
      else setStatoPaziente(iv,_k,3,"individuato, in attesa");
    }
    // VVF: scelta libera dell'operatore — ma se ci sono feriti si chiede subito
    // un'ambulanza (missione congiunta: la parte sanitaria vive di vita propria)
    if(iv.vvf){
      logRadio(`\uD83D\uDE92 ${nomem(mz)} sul posto a <b>${iv.comune}</b> \u2014 ${iv.emoji||""} <b>${iv.tipoNome}</b>: ${iv.desc||""} (${pazientiTXT(iv.pazienti)})`);
      const nF = pazientiInSospeso(iv);
      if(nF>0){
        ensureSupporti(iv);
        registraRichiesta(iv, "ALTRO", Math.max(iv.supporti.ALTRO.richiesti||0, nF), "feriti da portare in PS");
        logRadio(`\uD83D\uDE91 A <b>${iv.comune}</b>: ${nF} ferit${nF>1?"i":"o"} da assistere e portare in PS \u2014 mandate un\u2019ambulanza!`, "alarm");
        iv.sollecito = 12;
        // paziente critico trovato dai VVF: serve anche un mezzo medicalizzato (stessa soglia delle sanitarie)
        if((iv.pazienti||[]).some((s,k)=>s!=null && s<SOGLIA_MSA && pazAttivo(iv,k))){
          ensureSupporti(iv);
          if(!iv.pazMSA) iv.pazMSA = [];
          (iv.pazienti||[]).forEach((s,k)=>{ if(s!=null && s<SOGLIA_MSA && pazAttivo(iv,k)) iv.pazMSA[k] = true; }); // chi ha chiesto il medicalizzato resta in gestione finché non è stabilizzato (anche con un avanzato già sul posto: va in coda)
          registraRichiesta(iv, "MSA", Math.max((iv.supporti.MSA&&iv.supporti.MSA.richiesti)||0, 1), motivoMSA(iv));
          iv.attesaMSA = true; iv.msaTimer = 18; // attesa a tempo: mai stallo (vedi scenaTick)
          const primoCritico = (iv.pazienti||[]).findIndex((s,k)=>s!=null && s<SOGLIA_MSA && pazAttivo(iv,k));
          if(primoCritico>=0 && !iv.msaDetto){ iv.msaDetto = true; logRadio(`\u23F3 A <b>${iv.comune}</b>: ${motivoMSA(iv)} \u2014 inviate un mezzo medicalizzato`, "alarm"); } // VVF col motivo: una sola riga per missione
        }
      } else logRadio(`\u2705 ${nomem(mz)}: intervento in gestione, nessun altro mezzo richiesto`);
      return;
    }
    const dot = `<span class="prioDot" style="background:${prioColor(iv.prio)}"></span>`;
    const pq = quadroPeggiore(iv);
    const fuocoTxt = iv.fuoco ? ` · 🔥 fronte al ${Math.round(iv.fuoco.spento ? 0 : iv.fuoco.fronte)}%` : "";
    log(`📍 ${dot} ${nomem(mz)} sul posto a <b>${iv.comune}</b> — ${iv.emoji||""} <b>${iv.tipoNome}</b>: ${iv.desc||""} (👤 ${iv.pazienti.map(s=>Math.round(s)+"%").join(" · ")}${pq?" · "+pq:""}${fuocoTxt})`);
    // confronta mezzi richiesti dal tipo con quelli effettivamente assegnati
    const ass = mezzi.filter(m=>iv.mezziIds.includes(m.codice));
    const conta = {};
    for(const m of ass){
      if(m.trasp){ conta.MSA=(conta.MSA||0)+1; conta.MSB=(conta.MSB||0)+1; continue; } // MSA che trasporta (es. MDCCST): vale come medicalizzato e come ambulanza
      if(m.tipo==="ELI"){ conta.MSA=(conta.MSA||0)+1; conta.MSB=(conta.MSB||0)+1; conta.AUTOMEDICA=(conta.AUTOMEDICA||0)+1; if(m.corpo==="VVF") conta.VVF=(conta.VVF||0)+1; continue; } // l'eli fa da ambulanza e automedica (anche DRAGO VVF)
      if(m.corpo==="VVF"){ conta.VVF=(conta.VVF||0)+1; continue; }
      conta[m.tipo]=(conta[m.tipo]||0)+1;
    }
    const mancano = [];
    let chiedeMSA = false;
    for(const k in (iv.richiesti||{})){
      const need = Math.max(0, (iv.richiesti[k]||0)) - (conta[k]||0);
      if(need>0){
        // MSA/automedica solo per pazienti sotto il 35%: gli altri si gestiscono con l'ambulanza
        if(k==="MSA"||k==="AUTOMEDICA"){
          if(!(iv.pazienti||[]).some(s=>s<SOGLIA_MSA)) continue;
          chiedeMSA = true;
        }
        mancano.push(k==="MSA" ? `${need}× ${k} (${motivoMSA(iv)})` : `${need}× ${k}`);
      }
    }
    // 1 ambulanza = 1 paziente: altre ambulanze solo se i feriti superano i mezzi da trasporto già sul posto (eli compreso, anche VVF)
    if(iv.trasporto){
      const ambAss = ass.filter(m=>m.trasporto).length;
      const needAmb = Math.max(0, iv.pazienti.length - ambAss);
      if(needAmb>0) mancano.push(`${needAmb}× ambulanza per ${iv.pazienti.length} pazienti`);
    }
    if(iv.vvf && !(conta.VVF>0)) mancano.push("VVF");
    // paziente incastrato senza VVF sul posto: serve estricazione
    if(!iv.vvf && (iv.profili||[]).some(p=>p.intr) && !(conta.VVF>0)) mancano.push("🚒 VVF (paziente incastrato: serve estricazione)");
    // tracciamento supporti per missione (idempotente: stesse cifre = stessa richiesta, mai duplicati)
    ensureSupporti(iv);
    if(chiedeMSA) registraRichiesta(iv, "MSA", Math.max(iv.supporti.MSA.richiesti||0, (iv.richiesti.MSA||0)+(iv.richiesti.AUTOMEDICA||0), (conta.MSA||0)+1), motivoMSA(iv));
    if(chiedeMSA){ if(!iv.pazMSA) iv.pazMSA = []; (iv.pazienti||[]).forEach((s,k)=>{ if(s!=null && s<SOGLIA_MSA && pazAttivo(iv,k)){ iv.pazMSA[k] = true; annunciaMSA(iv, k); } }); } // chi ha chiesto il medicalizzato resta in gestione finché non è stabilizzato (anche con un avanzato già sul posto: va in coda). Radio: una sola riga per missione (annunciaMSA), niente riga di report
    if(iv.trasporto) registraRichiesta(iv, "ALTRO", Math.max(iv.supporti.ALTRO.richiesti||0, (iv.pazienti||[]).length||0), "ambulanze per i pazienti da trasportare");
    if(!(conta.VVF>0)){
      if(iv.vvf) registraRichiesta(iv, "VVF", Math.max(1, iv.supporti.VVF.richiesti||0), "supporto VVF richiesto dalla scena");
      if((iv.profili||[]).some(p=>p.intr)) registraRichiesta(iv, "VVF", Math.max(1, iv.supporti.VVF.richiesti||0), "paziente incastrato: serve estricazione");
    }
    if(mancano.length) log(`⚠️ ${nomem(mz)} chiede rinforzi a <b>${iv.comune}</b>: servono ${mancano.join(", ")}`);
    if(chiedeMSA && !msaSulPosto(iv)){
      iv.attesaMSA = true; // l'equipaggio aspetta l'MSA prima di stabilizzare e caricare (a tempo: mai stallo)
      iv.msaTimer = 18; // game-min: attesa max (vedi scenaTick)
    }
    // niente richieste = la scena basta a sé stessa: una sola conferma, poi silenzio radio
    // (chi segue in PS lo dice partendo; i dettagli restano nella scheda intervento)
    else if(!mancano.length) log(`✅ ${nomem(mz)}: situazione sotto controllo a <b>${iv.comune}</b>, nessun altro mezzo necessario`);
  }

  // ---------- EVOLUZIONE DINAMICA INCENDIO (tutti i tipi con un rogo attivo) ----------
  // Il rogo ha un fronte 0-100 che evolve da solo: sale senza VVF al lavoro (piu in fretta
  // col vento, piu piano con la pioggia), scende di 4/min per ogni squadra VVF sul posto
  // (max 3). Avanzamento coerente con cosa brucia (fuocoClasse): edifici (crollo del tetto),
  // veicoli (esplosione del serbatoio), fuochi all'aperto (propagazione spinta dal vento),
  // piccoli roghi contenuti (cassonetti, quadri elettrici, camini, tende: fronte basso che
  // si spegne in fretta, niente crolli). Soglie radio a 70 (avviso) e 85 (evento grave: il
  // ferito noto piu grave peggiora di 12, minimo 3). A 0 il rogo e spento (bonifica); alone
  // rosso sulla mappa proporzionale al fronte. Senza un fuoco attivo (ustioni domestiche,
  // folgorazioni, allarmi, fumogeni, gas senza fiamme) niente fronte: fuocoInit da null.
  // Parametri per classe: fronte iniziale, crescita al minuto, moltiplicatore vento.
  const FUOCO_CL = {
    edificio: {f0:[40, 50], cresc:1.2, vento:1.7},
    veicolo:  {f0:[30, 40], cresc:1.0, vento:1.7},
    aperto:   {f0:[35, 45], cresc:1.5, vento:2.2},
    piccolo:  {f0:[20, 30], cresc:0.7, vento:1.5},
  };
  let layerFuoco = null;
  const fuocoCerchi = {}; // id intervento -> L.circle
  // che cosa sta bruciando: null = nessun rogo attivo (niente fronte)
  function fuocoClasse(nome, desc){
    const nm = (nome || "").toLowerCase();
    const t = (nm + " " + (desc || "")).toLowerCase();
    if(/arma da fuoco|mangiafuoco|allarme incendio|fumogen/.test(t)) return null; // mai un rogo
    if(/trasporto.*ustione|medicazione.*ustione/.test(t)) return null; // postumi, niente fuoco
    if(/bombol[ea] (vicino|presso)/.test(t)) return null; // esposizione, non rogo
    if(/copertone|pentola a pressione/.test(t)) return null; // scoppio senza fiamme
    if(!/incendio| a fuoco|in fiamme|brucia|rogo|fiamme|esplosion|scoppio|incendiato| in fumo|fumo (in|da|dal|del|nel|per)|dal fumo|del fumo|per fumo|intossicat/.test(t)) return null;
    const espl = /bombola|fuochi d'artificio|distributore|pompa di benzina|benzina|gasolio|gasdotto|metanodotto|serbatoio|cisterna|silos|autocisterna|deposito (oli|vernici)/.test(t)
      && !/palazzina| casa|appartamento/.test(t); // gia esploso: l'evento grave e il crollo
    if(/^(rimessaggio|rimessa|deposito|autorimessa|capannone|garage|officina|carrozzeria|gommista|magazzino|fabbrica|falegnameria|segheria|mobilificio|caseificio|panificio|forno|pizzeria|ristorante|mensa|supermercato|mercato|negozio|hotel|albergo|agriturismo|scuola|discoteca|cinema|teatro|chiesa|oratorio|biblioteca|museo|palestra|stazione|aerostazione|terminal|edificio|palazzina|casa|appartamento|villa|taverna|mansarda|sottotetto|solaio|cantina|cucina|veranda|stalla|fienile|cascina|baita|rifugio|casera|malga|alpeggio|baracca|container|darsena|canile|colombaia|pollaio|scuderia|maneggio|serra|mulino|frantoio|fornace|vetreria|conceria|cartiera|tipografia|copisteria|tintoria|edicola|chiosco|silos|ufficio|archivio)/.test(nm)) return {cl:"edificio", espl};
    if(/^(auto|moto|motorino|scooter|furgone|furgoncino|camion|tir|autobus|bus|filobus|pullman|bisarca|caravan|camper|roulotte|trattore|escavatore|autobetoniera|spazzatrice|barca|barche|motoscafo|nave|mongolfiera|autoscontro|treno|vagone|locomotore|carrozza|ruspa|autogru)/.test(nm)
      || /\bquad\b|camion|autocisterna|autobus|filobus|tram|vagone|locomotore|treno|traghetto|barca|imbarcazione|velivolo|aeromobile|carrozza|truck/.test(nm)) return {cl:"veicolo", espl:true};
    if(/bosco|sterpaglie|canneto|macchia|sottobosco|pineta|vigneto|frutteto|pioppeto|pascolo|siepe|roveto|brughiera|potature|pagliaio|rotoballe|fieno|letame|concimaia|cumulo|copertoni| gomme|albero|abete(?! di natale)/.test(nm)) return {cl:"aperto", espl:false};
    if(/cassonetto|bidon|tenda|gazebo|presepe|abete di natale|albero di natale|camino|canna fumaria|stufa|caldaia|contatore|quadro|centralin|cabina|trasformatore|colonnina|cavi |fotovoltaico|pannelli|accumulo|batteria|pentola|fornello|cappa|barbecue|griglia|tuta|camicia|capelli|vestit|pigiama|divano|materasso|poltrona|bancarella|stand|\bcapanno\b|casetta|rimessa attrezzi|legnaia|bombola|fumo (dal|in|da|del)| in fumo|per fumo|dal fumo|del fumo/.test(nm)) return {cl:"piccolo", espl};
    if(/casa|tetto|garage|cucina|stalla|fienile|cascina|baita|rifugio|negozio|hotel|albergo|scuola|discoteca|edificio|palazzina|appartamento|capannone|chiesa|deposito|officina|fabbrica|magazzino|stazione|aerostazione|terminal|circo|luna park|tendone|palco|tribuna|mensa|forno|pizzeria|ristorante|supermercato|mercato|cinema|teatro|biblioteca|museo/.test(nm)) return {cl:"edificio", espl};
    return {cl:"edificio", espl}; // incendio generico: si comporta da rogo di struttura
  }
  function fuocoInit(nome, desc){
    const c = fuocoClasse(nome, desc);
    if(!c) return null;
    const P = FUOCO_CL[c.cl];
    const evTipo = c.espl ? "ESPLOSIONE" : c.cl === "edificio" ? "CROLLO PARZIALE" : c.cl === "aperto" ? "PROPAGAZIONE" : "ESTENSIONE";
    const avv = c.cl === "edificio" ? "il rogo cresce, il tetto sta per cedere — servono più squadre sul fuoco!"
      : c.cl === "veicolo" ? "le fiamme avvolgono il mezzo, il serbatoio può esplodere — servono più squadre sul fuoco!"
      : c.cl === "aperto" ? "il fronte avanza e rischia di allargarsi — servono più squadre sul fuoco!"
      : "il rogo cresce e rischia di estendersi — servono più squadre sul fuoco!";
    const evTxt = evTipo === "CROLLO PARZIALE" ? "ceduta una porzione dello stabile"
      : evTipo === "PROPAGAZIONE" ? "il fronte si è allargato oltre il perimetro"
      : evTipo === "ESTENSIONE" ? "le fiamme si sono allargate alle adiacenze"
      : c.cl === "veicolo" ? "il serbatoio è esploso" : "violenta deflagrazione";
    return {fronte: rndi(P.f0[0], P.f0[1]), cl: c.cl, espl: !!c.espl, avv, evTipo, evTxt,
      spentoTxt: c.cl === "aperto" ? "fronte spento, bonifica del perimetro in corso" : "rogo spento, iniziamo la bonifica",
      ann70: false, crollo: false, spento: false};
  }
  function fuocoVVF(iv){
    let n = 0;
    for(const m of mezzi){
      if(m.interventoId === iv.id && m.stato === "sul_posto" && m.corpo === "VVF" && m.tipo !== "ELI") n++;
    }
    return Math.min(n, 3);
  }
  function fuocoHalo(iv){
    try{
      if(!map || typeof L === "undefined") return;
      if(!layerFuoco){ layerFuoco = L.layerGroup().addTo(map); }
      const id = iv.id;
      if(iv.stato === "chiuso" || !iv.fuoco || iv.fuoco.spento){
        if(fuocoCerchi[id]){ layerFuoco.removeLayer(fuocoCerchi[id]); delete fuocoCerchi[id]; }
        return;
      }
      const r = Math.max(60, Math.round(iv.fuoco.fronte * 9));
      const col = iv.fuoco.fronte >= 70 ? "#ff4400" : "#d00000";
      if(fuocoCerchi[id]){
        fuocoCerchi[id].setLatLng([iv.lat, iv.lng]);
        fuocoCerchi[id].setRadius(r);
        fuocoCerchi[id].setStyle({color: col});
        if(fuocoCerchi[id].setTooltipContent) fuocoCerchi[id].setTooltipContent("🔥 Fronte del rogo: " + Math.round(iv.fuoco.fronte) + "%");
      } else {
        fuocoCerchi[id] = L.circle([iv.lat, iv.lng], {radius: r, color: col, weight: 2, fillOpacity: 0.12}).addTo(layerFuoco)
          .bindTooltip("🔥 Fronte del rogo: " + Math.round(iv.fuoco.fronte) + "%");
      }
    }catch(e){}
  }
  function fuocoTick(iv, dtG){
    for(const id of Object.keys(fuocoCerchi)){
      if(!interventi.some(v => v.id === +id)){
        try{ if(layerFuoco) layerFuoco.removeLayer(fuocoCerchi[id]); }catch(e){}
        delete fuocoCerchi[id];
      }
    }
    const F = iv.fuoco;
    if(!F || F.spento || !(dtG > 0)){ fuocoHalo(iv); return; }
    const P = FUOCO_CL[F.cl] || FUOCO_CL.edificio;
    const nV = fuocoVVF(iv);
    let vento = 1, pioggia = 1;
    try{
      const c = (meteo && meteo.cond) || "";
      if(c.indexOf("Vento") >= 0) vento = P.vento;
      if(c.indexOf("Pioggia intensa") >= 0) pioggia = 0.2;
      else if(c === "Temporale" || c === "Pioggia") pioggia = 0.45;
      else if(c === "Nuvoloso" || c === "Nebbia") pioggia = 0.8;
    }catch(e){}
    F.fronte += (P.cresc * vento * pioggia - 4 * nV) * dtG;
    if(F.fronte < 0) F.fronte = 0;
    if(F.fronte > 100) F.fronte = 100;
    if(F.fronte >= 70 && !F.ann70){
      F.ann70 = true;
      logRadio(`🔥 A <b>${iv.comune}</b>: ${F.avv}`, "alarm");
      renderListe();
    }
    if(F.fronte >= 85 && !F.crollo){
      F.crollo = true;
      let pegg = -1, peggSal = 101;
      (iv.pazienti || []).forEach((s, k) => {
        if(s != null && pazAttivo(iv, k) && s < peggSal){ peggSal = s; pegg = k; }
      });
      if(pegg >= 0) iv.pazienti[pegg] = Math.max(3, Math.round((peggSal - 12) * 10) / 10);
      logRadio(`🔥 ${F.evTipo} a <b>${iv.comune}</b>: ${F.evTxt}${pegg >= 0 ? " — un ferito peggiora" : ""}!`, "alarm");
      renderListe();
    }
    if(F.fronte <= 0){
      F.spento = true;
      logRadio(`🚒 A <b>${iv.comune}</b>: ${F.spentoTxt}`, "ok");
      renderListe();
    }
    fuocoHalo(iv);
  }
  function fuocoReset(){
    try{
      for(const id of Object.keys(fuocoCerchi)){
        if(layerFuoco) layerFuoco.removeLayer(fuocoCerchi[id]);
        delete fuocoCerchi[id];
      }
    }catch(e){}
  }
  function fuocoStato(id){
    const iv = interventi.find(v => v.id === id);
    if(!iv || !iv.fuoco) return null;
    return {fronte: Math.round(iv.fuoco.fronte * 10) / 10, spento: !!iv.fuoco.spento, crollo: !!iv.fuoco.crollo, vvf: fuocoVVF(iv), classe: iv.fuoco.cl || "edificio"};
  }

  // evoluzione di un intervento VVF: resta sul posto a lavorare e aggiorna via radio
  // (solo testi operativi: i feriti nascosti si rivelano con scopriPazienti, mai da qui)
  function evoluzioneVVF(iv, mz){
    const nm = iv.tipoNome || "";
  // (solo testi: se il tipo prevede feriti nascosti li scopre scopriPazienti in scenaTick;
  // gli interventi VVF tecnici restano senza feriti)
    const tardi = (iv.evoluzioni||0) >= 2;
    let righe;
    // evoluzioni solo con contenuto operativo concreto: niente riempitivi
    // ("vi aggiorno tra poco" non e una comunicazione)
    if(/incendio|fuoco|fiamme|brucia|rogo|falo|camino|sterpagli|canneto|boschiv|legnaia|discarica|cassonetto|tetto|fotovoltaico|auto a fuoco/i.test(nm))
      righe = tardi
        ? ["fuoco sotto controllo, iniziamo la bonifica", "fiamme spente, bonifica e messa in sicurezza in corso", "spento, restiamo per i controlli finali"]
        : ["attacco al fuoco in corso, zona transennata", "manichette stese, stiamo circoscrivendo il rogo", "secondo getto in manovra, fiamme in regressione"];
    else if(/allaga|esonda|acqua|alluvione|prosciuga|pompa|tubo|perdita|fuga gas/i.test(nm))
      righe = tardi
        ? ["quasi prosciugato, ultime verifiche nei locali", "livello rientrato, verifichiamo i locali allagati"]
        : ["idrovore in funzione, livello in lento calo", "prosciugamento avviato con due motopompe"];
    else if(/persona|recupero|ricerca|dispers|apertura|ascensore|blocc|soccorso|scompars/i.test(nm))
      righe = tardi
        ? ["persona messa in sicurezza, verifichiamo le condizioni", "recupero quasi concluso, zona quasi in sicurezza"]
        : ["squadra al lavoro per raggiungere la persona", "contatto visivo con la persona, prepariamo il recupero"];
    else
      righe = tardi
        ? ["messa in sicurezza quasi ultimata, ultimi controlli", "quasi concluso, restiamo sul posto per le verifiche finali"]
        : ["messa in sicurezza in corso, verifiche tecniche sullo stabile", "squadre al lavoro, area transennata"];
    logRadio(`🚒 ${nomem(mz)} da <b>${iv.comune}</b>: ${righe[rndi(0,righe.length-1)]}`);
  }

  // sopralluogo ed evoluzione scene, ogni tick: gli equipaggi valutano prima di riferire;
  // i VVF aggiornano via radio mentre lavorano; i feriti senza ambulanza vengono sollecitati
  function scenaTick(dtG){
    for(const iv of interventi){
      if(iv.stato==="chiuso") continue;
      if(iv.fuoco) fuocoTick(iv, dtG); // evoluzione dinamica del rogo (tutti i tipi con fuoco attivo)
      // peggioramento sotto il 35%: senza medicalizzato sul posto la salute scende
      // molto lentamente (0,5 %/game-min); a 0 il paziente decede e non serve più il trasporto
      if(!msaSulPosto(iv) && dtG>0){
        const cal = 0.5*dtG;
        let peggShow = false, mortoOra = false;
        const pegg = (L, noti)=>{
          for(let k=0;k<(L||[]).length;k++){
            if(L[k]==null || L[k]<=0 || L[k]>=SOGLIA_MSA) continue;
            if(noti && !pazAttivo(iv,k)) continue;
            const nv = Math.round(Math.max(noti?0:3, L[k]-cal)*10)/10; // i nascosti scendono fino al 3% senza morire da nascosti
            if(nv!==L[k]){ L[k] = nv; peggShow = true; }
            if(noti && nv<=0){
              if(iv.pazMSA) iv.pazMSA[k] = false;
              if(setStatoPaziente(iv,k,13,"decesso: salute esaurita in attesa del medicalizzato")){
                if(iv.trasporto && iv.daTrasportare>0) iv.daTrasportare--;
                logRadio(`🕊 A <b>${iv.comune}</b>: purtroppo <b>P${k+1}</b> è deceduto — non serve più il trasporto`, "alarm");
                mortoOra = true;
              }
            }
          }
        };
        pegg(iv.pazienti, true);
        pegg(iv.pazientiNascosti, false);
        if(mortoOra) renderListe();
        else if(peggShow){
          const shown = (iv.pazienti||[]).map(s=>s==null?"x":Math.round(s)).join(",");
          const ora = performance.now();
          if(shown!==iv._peggShown && ora-(iv._peggT||0)>250){ iv._peggShown = shown; iv._peggT = ora; renderListe(); }
        }
      }
      // feriti in attesa di ambulanza: sollecito periodico se nessun 118 legato
      // (missioni sanitarie scoperte e VVF con feriti: stessa regola, un solo punto)
      const bisAmb = pazientiDaAssistere(iv);
      // verifiche in stallo: feriti da scoprire ma nessun equipaggio sul posto che li cerchi
      const stallVer = iv.valutato && iv.pazDaVerificare && (iv.pazientiNascosti||[]).length>0 && !mezzi.some(m=>m.interventoId===iv.id && m.stato==="sul_posto");
      if(bisAmb>0 || stallVer){
        iv.sollecito = (iv.sollecito==null ? 10 : iv.sollecito) - dtG;
        if(iv.sollecito<=0){
          iv.sollecito = 12;
          if(bisAmb>0) log(iaRadio("sollecito", {comune:iv.comune, n:bisAmb}, `⏳ A <b>${iv.comune}</b>: ${bisAmb} ferit${bisAmb>1?"i":"o"} ancora senza ambulanza \u2014 serve un mezzo sul posto`), "alarm");
          else log(`🔍 A <b>${iv.comune}</b>: verifiche sui feriti non completate — mandate un mezzo a controllare`, "alarm");
        }
      } else iv.sollecito = 10;
      // attesa MSA a tempo: l'equipaggio aspetta il supporto avanzato ma non all'infinito —
      // REGOLA UNIVERSALE: si aspetta l'arrivo effettivo del medicalizzato (niente fallback).
      // Se non resta più nessun paziente sotto il 35% (decesso o fine gestione)
      // l'attesa si chiude da sola — mai stallo, mai attesa fantasma.
      if(msaAtteso(iv)){
        const critici = (iv.pazienti||[]).some((s,k)=>s!=null && s<SOGLIA_MSA && pazAttivo(iv,k));
        if(!critici){
          iv.attesaMSA = false;
          log(`🚓 A <b>${iv.comune}</b>: nessun paziente sotto il 35% — si procede con l'equipaggio sul posto`, "status");
        }
      }
      aggiornaMSA(iv); // coda MSA/MSI per gravità + attesa: una sola fonte, a ogni tick
      affidoImmediato(iv); // scritta "in attesa di ambulanza": sparisce appena un'ambulanza è sul posto (affido immediato)
      // anti-zombie: verifica aperta ma niente da scoprire e nessuno sul posto che possa
      // verificare (es. collettivi con tutti i feriti già noti e mezzi già ripartiti ai PS):
      // gira anche a scena vuota (prima del gate sulPosto); chiude e prova la chiusura
      if(iv.valutato && iv.pazDaVerificare && (iv.pazientiNascosti||[]).length===0 && (iv.pazienti||[]).length>0){
        if(!mezzi.some(m=>m.interventoId===iv.id && m.stato==="sul_posto")){
          iv.pazDaVerificare = false;
          checkChiusura(iv);
          refreshMarkers(); renderListe(); updateStats();
        }
      }
      const sulPosto = mezzi.filter(m=>m.interventoId===iv.id && m.stato==="sul_posto");
      if(!sulPosto.length) continue;
      const primo = sulPosto[0];
      if(!iv.valutato){
        if(iv.sopralluogo==null) iv.sopralluogo = iv.vvf ? rnd(2,4) : rnd(2,5);
        iv.sopralluogo -= dtG;
        if(iv.sopralluogo<=0){
          iv.valutato = true; iv.reportFatto = true;
          reportScena(iv, primo);
          if(iv.vvf){ iv.evoluzioni = 0; iv.evolTra = rnd(4,8); }
          refreshMarkers(); renderListe(); updateStats();
        }
        continue;
      }
      if(iv.valutato){
        let _daLib = [];
        for(let _k=0;_k<(iv.pazienti||[]).length;_k++){ const _p=(iv.profili||[])[_k]; if(_p&&_p.intr&&!((iv.liberati||{})[_k])&&statoPaziente(iv,_k)===5) _daLib.push(_k); }
        if(_daLib.length){
          const _vvf = sulPosto.some(m=>m.corpo==="VVF");
          if(_vvf){ iv.libTimer=(iv.libTimer||0)+dtG; iv.noVVFTimer=0; } else { iv.noVVFTimer=(iv.noVVFTimer||0)+dtG; }
          const _pronti = _vvf && iv.libTimer>=6;
          const _fortuna = !_vvf && iv.noVVFTimer>=14;
          if(_pronti || _fortuna){
            if(!iv.liberati) iv.liberati={};
            for(const _k of _daLib){ iv.liberati[_k]=true; const _118b = sulPosto.some(m=>m.corpo!=="VVF"); setStatoPaziente(iv,_k,_118b?4:3,_pronti?"liberato dai VVF":"disincarcerazione di fortuna"); }
            logRadio(_pronti?`🔓 VVF a <b>${iv.comune}</b>: persona liberata, la squadra sanitaria la prende in carico`:`🔓 A <b>${iv.comune}</b>: il 118 libera il ferito con i divaricatori di bordo (manovra di fortuna)`, "status");
            iv.libTimer=0; iv.noVVFTimer=0;
            refreshMarkers(); renderListe(); updateStats();
          } else if(!_vvf && iv.noVVFTimer>=8 && !(iv.avvisi&&iv.avvisi.lib)){ if(!iv.avvisi) iv.avvisi={}; iv.avvisi.lib=1; log(`🔒 A <b>${iv.comune}</b>: ferito incastrato, liberazione in corso \u2014 sollecitare i VVF`, "alarm"); }
        }
      }
      // numero dinamico: le squadre sul posto scoprono altri feriti oppure confermano
      // che non ce ne sono (mai più del vero scenario: solo i nascosti pre-generati)
      if(iv.valutato && iv.pazDaVerificare && sulPosto.length){
        if(iv.scopTra==null) iv.scopTra = rnd(4,9);
        iv.scopTra -= dtG;
        if(iv.scopTra<=0){
          scopriPazienti(iv, primo);
          iv.scopTra = rnd(5,10);
          refreshMarkers(); renderListe(); updateStats();
        }
      }
      // evoluzioni VVF: le prime 2 ravvicinate, poi aggiornamenti di mantenimento
      // più radi finché restano sul posto (niente più silenzio radio a lavoro in corso)
      if(iv.vvf){
        if(iv.evolTra==null) iv.evolTra = rnd(4,8);
        iv.evolTra -= dtG;
        if(iv.evolTra<=0 && (iv.evoluzioni||0)<2){
          iv.evoluzioni = (iv.evoluzioni||0)+1;
          evoluzioneVVF(iv, primo);
          iv.evolTra = rnd(5,10);
          refreshMarkers(); renderListe(); updateStats();
        } else if(iv.evolTra<=0){
          iv.evoluzioni = (iv.evoluzioni||0)+1;
          evoluzioneVVF(iv, primo);
          iv.evolTra = rnd(10,16);
          refreshMarkers(); renderListe(); updateStats();
        }
      }
      iaComplicazione(iv); // Livello 3 IA: micro-evoluzione validata (max 1/missione)
    }
  }

  // ---------- STATISTICHE DI CENTRALE (pannello Statistiche) ----------
  // Contatori e storico calcolati SOLO dai dati reali del motore (interventi,
  // chiamate, mezzi, storicoPazienti) + un diario compatto degli eventi che il
  // live non conserva (chiamate pubblicate, missioni chiuse, arrivi, invii).
  // statClock = game-min cumulativi (non wrappa mai, a differenza di clockMin).
  // Congiunte = 1 sola riga nei totali (flag dedicato, mai duplicati).
  let statClock = 0, statDay = 1, statGameMin = 0, statSaveT = 0, statPrevClock = 8*60;
  const bootReal = Date.now(); // avvio sessione (tempo reale, mai azzerato dal reset)
  let ST = null;
  const STAT_CAP = {calls:800, missions:800, chiuse:800, arrivi:2000, stacchi:200};
  const STAT_KEY = "coeusim-stats-v1";
  function statInit(){
    ST = {calls:[], missions:[], chiuse:[], arrivi:[], stacchi:[],
      perMezzo:{}, // cod -> {invii, arrN, arrSomma, servMin}
      verifica:{s:0, riparati:[], avvisi:[], morti:[]},
      giorni:{}, // day -> {calls, chiuse}
      tipi:{}, // "tipo|v" -> {tipo, vvf, calls, chiuse}
      tot:{calls:0, accettate:0, rifiutate:0, chiuse:0, fallite:0}};
  }
  function statMezzo(cod){
    if(!ST.perMezzo[cod]) ST.perMezzo[cod] = {invii:0, arrN:0, arrSomma:0, servMin:0};
    return ST.perMezzo[cod];
  }
  // orologio cumulativo, giorno di gioco, tempo in servizio mezzi, autosave (dal tick)
  function statTick(dtG){
    statClock += dtG; statGameMin += dtG;
    // wrap mezzanotte = nuovo giorno (salto >12h: i cambi ora manuali non contano)
    if(clockMin < statPrevClock && (statPrevClock-clockMin) > 12*60) statDay++;
    statPrevClock = clockMin;
    for(const m of mezzi){
      if(m.stato!=="disponibile" && m.stato!=="fuori_servizio") statMezzo(m.codice).servMin += dtG;
    }
    const ora = performance.now();
    if(ora - statSaveT > 30000){ statSaveT = ora; try{ statsSave(); }catch(_){} }
  }
  // diario chiamata pubblicata (una riga per callId: mai duplicati)
  function statCall(call){
    if(!ST) return;
    call._s0 = statClock; call._day = statDay;
    if(!ST.calls.some(c=>c.callId===call.callId)){
      ST.calls.push({callId:call.callId, s:statClock, day:statDay, ora:Math.floor(clockMin/60)%24,
        tipo:call.tipoNome, vvf:!!call.vvf, prio:call.truePrio||0, prov:call.prov||"?", esito:"attesa"});
      if(ST.calls.length>STAT_CAP.calls) ST.calls = ST.calls.slice(-STAT_CAP.calls);
    }
    ST.tot.calls++;
    const g = ST.giorni[statDay] || (ST.giorni[statDay]={calls:0, chiuse:0});
    g.calls++;
    const tk = call.tipoNome+"|"+(call.vvf?1:0);
    const te = ST.tipi[tk] || (ST.tipi[tk]={tipo:call.tipoNome, vvf:!!call.vvf, calls:0, chiuse:0});
    te.calls++;
    try{ if(window.COEUGLOB) COEUGLOB.bumpMissione(call.callId); }catch(_){} // statistiche globali: missione generata
  }
  function statEsito(callId, esito){
    if(!ST) return;
    const e = ST.calls.find(c=>c.callId===callId);
    if(e) e.esito = esito;
    if(esito==="rifiutata") ST.tot.rifiutate++;
    if(esito==="accettata") ST.tot.accettate++;
  }
  // avvio missione (dalla chiamata accettata: attesa risposta e attesa invio)
  function statAccetta(call, iv){
    if(!ST) return;
    statEsito(call.callId, "accettata");
    iv._s0 = statClock; iv._day = statDay;
    ST.missions.push({id:iv.id, callId:call.callId, s0:statClock, day:statDay,
      tipo:iv.tipoNome, vvf:!!iv.vvf, prio:iv.prio||0, prov:iv.prov||"?", comune:iv.comune||"?",
      nPaz:(iv.pazienti||[]).length,
      tRisposta:(call.tAns!=null && call._s0!=null)?Math.max(0,call.tAns-call._s0):null,
      tInvio:(call._s0!=null)?Math.max(0,statClock-call._s0):null});
    if(ST.missions.length>STAT_CAP.missions) ST.missions = ST.missions.slice(-STAT_CAP.missions);
    try{ if(window.COEUGLOB) COEUGLOB.bumpCodice(iv.id, iv.prio||0); }catch(_){} // statistiche globali: intervento per codice
  }
  function statAssegna(mz){
    if(!ST || !mz) return;
    statMezzo(mz.codice).invii++;
    mz._statD0 = statClock; // partenza per il tempo di arrivo
  }
  function statArrivo(iv, mz){
    if(!ST || !iv || !mz) return;
    const leg = Math.max(0, statClock-(mz._statD0!=null?mz._statD0:statClock));
    ST.arrivi.push({cod:mz.codice, iv:iv.id, s:statClock, corpo:mz.corpo, leg:Math.round(leg*10)/10});
    if(ST.arrivi.length>STAT_CAP.arrivi) ST.arrivi = ST.arrivi.slice(-STAT_CAP.arrivi);
    const pm = statMezzo(mz.codice); pm.arrN++; pm.arrSomma += leg;
  }
  // mezzo staccato dalla missione (manuale o automatico) con eventuali feriti in sospeso
  function statStacco(mz, iv, come){
    if(!ST || !mz) return;
    ST.stacchi.push({cod:mz.codice, iv:iv?iv.id:mz.interventoId, s:statClock, day:statDay,
      come:come||"auto", pending:iv?pazientiInSospeso(iv):null});
    if(ST.stacchi.length>STAT_CAP.stacchi) ST.stacchi = ST.stacchi.slice(-STAT_CAP.stacchi);
  }
  // enti coinvolti davvero: collegati ora + diario supporti (niente duplicati)
  function entiCoinvolti(iv){
    let had118=false, hadVVF=false; const visti={};
    const marca=(cod)=>{ if(!cod||visti[cod])return; visti[cod]=1;
      const m=mezzi.find(x=>x.codice===cod); if(!m)return;
      if(m.corpo==="VVF")hadVVF=true; else had118=true; };
    for(const c of (iv.mezziIds||[])) marca(c);
    for(const g of ["MSA","VVF","ALTRO"]){ const b=iv.supporti&&iv.supporti[g]; if(b) for(const e of (b.log||[])) marca(e.codice); }
    return {h118:had118, hvvf:hadVVF, cong:had118&&hadVVF};
  }
  // chiusura missione (auto o manuale): una sola riga per id, mai duplicati
  function statChiudi(iv, come){
    if(!ST || !iv) return;
    if(ST.chiuse.some(c=>c.id===iv.id)) return;
    const en = entiCoinvolti(iv);
    let cons=0, dec=0, intr=0, lib=0;
    for(let k=0;k<(iv.pazienti||[]).length;k++){
      if(iv.pazienti[k]==null) continue;
      if(iv.pazConsegnati&&iv.pazConsegnati[k]) cons++;
      if(statoPaziente(iv,k)===13) dec++;
      if((iv.profili||[])[k]&&iv.profili[k].intr){ intr++; if(iv.liberati&&iv.liberati[k]) lib++; }
    }
    const m0 = ST.missions.find(m=>m.id===iv.id);
    const s0 = (m0&&m0.s0!=null)?m0.s0:(iv._s0!=null?iv._s0:statClock);
    ST.chiuse.push({id:iv.id, day:statDay, tipo:iv.tipoNome, vvf:!!iv.vvf,
      cong:en.cong, h118:en.h118, hvvf:en.hvvf,
      prio:iv.prio||0, prov:iv.prov||"?", comune:iv.comune||"?",
      nPaz:(iv.pazienti||[]).length, cons:cons, dec:dec, intr:intr, lib:lib,
      s0:s0, s1:statClock, dur:Math.max(0,statClock-s0), come:come||"auto"});
    if(ST.chiuse.length>STAT_CAP.chiuse) ST.chiuse = ST.chiuse.slice(-STAT_CAP.chiuse);
    ST.tot.chiuse++; if(dec>0) ST.tot.fallite++;
    const g = ST.giorni[statDay] || (ST.giorni[statDay]={calls:0, chiuse:0});
    g.chiuse++;
    const tk = iv.tipoNome+"|"+(iv.vvf?1:0);
    if(ST.tipi[tk]) ST.tipi[tk].chiuse++;
  }
  // persistenza reload (localStorage; niente kv-plugin nel progetto): id inclusi
  // per non riusare gli stessi id dopo il reload (niente collisioni col diario)
  function statsSave(){
    if(!ST) return false;
    try{
      localStorage.setItem(STAT_KEY, JSON.stringify({v:1, day:statDay,
        clock:Math.round(statClock*10)/10, gameMin:Math.round(statGameMin*10)/10,
        idCounter:idCounter, callCounter:callCounter,
        ST:{calls:ST.calls.slice(-400), missions:ST.missions.slice(-400), chiuse:ST.chiuse.slice(-400),
          arrivi:ST.arrivi.slice(-800), stacchi:ST.stacchi.slice(-100),
          perMezzo:ST.perMezzo, verifica:ST.verifica, giorni:ST.giorni, tipi:ST.tipi, tot:ST.tot}}));
      return true;
    }catch(_){ return false; }
  }
  function statsLoad(){
    statInit();
    try{
      const raw = localStorage.getItem(STAT_KEY);
      if(!raw) return false;
      const d = JSON.parse(raw);
      if(!d || d.v!==1 || !d.ST) return false;
      statDay = d.day||1; statClock = d.clock||0; statGameMin = d.gameMin||0;
      if(d.idCounter) idCounter = d.idCounter;
      if(d.callCounter) callCounter = d.callCounter;
      ST.calls = d.ST.calls||[]; ST.missions = d.ST.missions||[];
      ST.chiuse = d.ST.chiuse||[]; ST.arrivi = d.ST.arrivi||[];
      ST.stacchi = d.ST.stacchi||[]; ST.perMezzo = d.ST.perMezzo||{};
      ST.verifica = d.ST.verifica||{s:0,riparati:[],avvisi:[],morti:[]};
      ST.giorni = d.ST.giorni||{}; ST.tipi = d.ST.tipi||{};
      ST.tot = d.ST.tot||{calls:0,accettate:0,rifiutate:0,chiuse:0,fallite:0};
      return true;
    }catch(_){ statInit(); return false; }
  }
  function statsReset(){
    statClock=0; statDay=1; statGameMin=0; statPrevClock=8*60; statInit();
    try{ localStorage.removeItem(STAT_KEY); }catch(_){}
  }
  // --- formattazione snapshot ---
  function stFmtDur(min){ if(min==null||!isFinite(min)) return "N/D"; min=Math.max(0,Math.round(min)); const h=Math.floor(min/60); return h>0?(h+"h"+String(min%60).padStart(2,"0")+"m"):(min+"m"); }
  function stAvg(a){ if(!a||!a.length) return null; let s=0; for(const v of a) s+=v; return s/a.length; }
  function stMatchDay(day, f){ return !f || f.periodo!=="oggi" || day===statDay; }
  function stMatchServ(en, f){
    if(!f || !f.servizio || f.servizio==="tutti") return true;
    if(f.servizio==="congiunte") return !!en.cong;
    if(f.servizio==="118") return !!en.h118 && !en.hvvf;
    if(f.servizio==="VVF") return !!en.hvvf && !en.h118;
    return true;
  }
  function stMatchTipo(tipo, f){ return !f || !f.tipo || f.tipo==="tutte" || tipo===f.tipo; }
  // tipologie operative VVF (bucket a parole chiave sul nome missione)
  const VVF_BUCKET = [
    ["Incendi", /incendio|fuoco|fiamme|brucia|rogo|falo|camino|canneto|sterpagli|discarica|cassonetto|fotovoltaico|auto a fuoco|fumo|ustioni|esplosione/i],
    ["Ferrovia", /deragli|tren[oi]|carrozza|vagone|binari|passaggio a livello|macchinista|capotreno|locomotore/i],
    ["Incidenti stradali", /auto|moto|strad|tampon|scontro|invest|ribalt|veicolo|tir|camion|bus|treno|passaggio a livello|rotonda|guardrail|galleria|viadotto|sottopasso/i],
    ["Crolli e dissesti", /croll|cediment|smottament|frana|valanga|macerie|alluvione|esonda|voragine|sprofond/i],
    ["Soccorso a persona", /persona|dispers|ricerca|scompars|recupero|soccorso|escursion|alpin|pescatore|bagnante|anneg|sommozz|dirupo|scarpata|burrone|pozzo|tombino/i],
    ["Acqua e allagamenti", /allag|prosciug|pompa|idrovora|alluvione|pioggia|temporale|tromba/i],
    ["Animali", /cane|gatto|cavallo|mucca|cigno|tasso|cervo|cinghiale|alveare|calabroni|vespe|serpente|vipera|ragno|colombaia|canile|stella|pollai/i],
  ];
  function vvfBucket(nome){
    for(const b of VVF_BUCKET){ if(b[1].test(nome||"")) return b[0]; }
    return "Altri interventi";
  }
  // scansione pazienti attivi (una riga per paziente: mai confusi con le missioni)
  function scanPazienti(){
    const out = [];
    for(const iv of interventi){
      if(iv.stato==="chiuso") continue;
      const linked118 = mezzi.some(m=>m.interventoId===iv.id && m.corpo!=="VVF" && (m.stato==="viaggio"||m.stato==="sul_posto"||m.stato==="pronto"||m.stato==="trasporto"));
      const L = iv.pazienti||[];
      for(let k=0;k<L.length;k++){
        if(L[k]==null) continue;
        const st = statoPaziente(iv,k);
        const p = (iv.profili||[])[k]||{};
        const resp = (iv.pazMezzo&&iv.pazMezzo[k])||(iv.affidi&&iv.affidi[k])||null;
        out.push({uid:pazUid(iv,k), iv:iv.id, idx:k, st:st, t:(p.t||null), sal:Math.round(L[k]),
          intr:!!(p.intr&&!(iv.liberati&&iv.liberati[k])), lib:!!(iv.liberati&&iv.liberati[k]),
          resp:resp, has118:linked118, trasporto:!!iv.trasporto, tipo:iv.tipoNome, vvf:!!iv.vvf,
          comune:iv.comune||"?", valutato:!!iv.valutato, t0:iv.t0,
          log:(((iv.pazS||{})[k]||{}).log||[])});
      }
    }
    return out;
  }
  // snapshot completo (f = {periodo, servizio, tipo, grav, stato})
  function statistiche(f){
    f = f||{};
    if(!ST) statInit();
    const live = interventi.filter(i=>i.stato!=="chiuso");
    // --- missioni per la tabella (aperte + chiuse filtrate, congiunte 1 riga) ---
    const righe = [];
    for(const iv of live){
      const en = entiCoinvolti(iv);
      if(!stMatchDay(iv._day||statDay, f) || !stMatchServ(en, f) || !stMatchTipo(iv.tipoNome, f)) continue;
      if(f.stato==="concluse" || f.stato==="annullate") continue;
      righe.push({id:iv.id, day:(iv._day||statDay), tipo:iv.tipoNome, vvf:!!iv.vvf,
        cong:en.cong, serv:en.cong?"Congiunta":(en.hvvf?"VVF":"118"),
        prio:iv.prio||0, prov:iv.prov||"?", comune:iv.comune||"?",
        nPaz:(iv.pazienti||[]).length, stato:iv.stato,
        dur:(iv._s0!=null)?Math.max(0,statClock-iv._s0):null});
    }
    for(const c of ST.chiuse){
      if(!stMatchDay(c.day, f) || !stMatchServ(c, f) || !stMatchTipo(c.tipo, f)) continue;
      if(f.stato==="attive") continue;
      righe.push({id:c.id, day:c.day, tipo:c.tipo, vvf:c.vvf, cong:c.cong,
        serv:c.cong?"Congiunta":(c.hvvf?"VVF":"118"),
        prio:c.prio, prov:c.prov, comune:c.comune, nPaz:c.nPaz, stato:"chiusa",
        dur:c.dur, cons:c.cons, dec:c.dec, come:c.come});
    }
    const aperte = live.length;
    const inAttesaAss = live.filter(iv=>iv.stato==="attesa" && !(iv.mezziIds||[]).length).length;
    // --- generali ---
    const tRisp = ST.missions.map(m=>m.tRisposta).filter(v=>v!=null);
    const tInv = ST.missions.map(m=>m.tInvio).filter(v=>v!=null);
    const tArr = ST.arrivi.map(a=>a.leg);
    const durs = ST.chiuse.map(c=>c.dur);
    const okChiuse = ST.tot.chiuse - ST.tot.fallite;
    const generali = {
      totChiamate: ST.tot.calls, inAttesa: chiamate.length,
      gestiteChiuse: ST.tot.chiuse, attive: aperte, concluse: ST.tot.chiuse,
      annullate: ST.tot.rifiutate, fallite: ST.tot.fallite,
      attesaAssegnazione: inAttesaAss,
      tRisposta: stAvg(tRisp), tInvio: stAvg(tInv), tArrivo: stAvg(tArr),
      durMedia: stAvg(durs),
      percOk: ST.tot.chiuse>0 ? (okChiuse/ST.tot.chiuse*100) : null,
      giorno: statDay, gameMin: Math.round(statGameMin)
    };
    // --- per servizio (118 / VVF / congiunte) ---
    const perServ = (want)=>{
      const isW = (h118,hvvf,cong)=>want==="cong"?cong:(want==="VVF"?(hvvf&&!h118):(h118&&!hvvf));
      const misA = live.filter(iv=>{ const en=entiCoinvolti(iv); return isW(en.h118,en.hvvf,en.cong); });
      const chA = ST.chiuse.filter(c=>isW(c.h118,c.hvvf,c.cong));
      const mz = (want==="cong") ? [] : mezzi.filter(m=>want==="VVF"?m.corpo==="VVF":m.corpo!=="VVF");
      const disp = mz.filter(m=>m.stato==="disponibile").length;
      const imp = mz.filter(m=>["viaggio","sul_posto","pronto","trasporto","ospedale","rientro"].includes(m.stato)).length;
      const vag = mz.filter(m=>m.stato==="viaggio").length;
      const fs = mz.filter(m=>m.stato==="fuori_servizio").length;
      return {interventi: misA.length+chA.length, attivi: misA.length, chiusi: chA.length,
        mezziTot: mz.length, disp: disp, imp: imp, viaggio: vag, fuoriServ: fs,
        tMedio: stAvg(chA.map(c=>c.dur))};
    };
    const servizi = {s118: perServ("118"), vvf: perServ("VVF"), cong: perServ("cong"),
      congTot: ST.chiuse.filter(c=>c.cong).length + live.filter(iv=>entiCoinvolti(iv).cong).length};
    // --- sanitari (pazienti live + chiusi; mai confusi con le missioni) ---
    const paz = scanPazienti();
    const pazF = (f.grav && f.grav!=="tutte") ? paz.filter(p=>String(p.t||"")===String(f.grav)) : paz;
    const att = (st)=>pazF.filter(p=>p.st===st).length;
    const consegneChiuse = ST.chiuse.reduce((s,c)=>s+(c.cons||0),0);
    const natiChiuse = ST.chiuse.reduce((s,c)=>s+(c.nPaz||0),0);
    const perGrav = [1,2,3,4].map(t=>{
      const q = pazF.filter(p=>p.t===t);
      return {t:t, n:q.length, salMed:stAvg(q.map(p=>p.sal))};
    });
    const affidi = [];
    for(const p of paz){
      for(const e of (p.log||[])){ if(e.a===7 && e.t>=p.t0){ affidi.push(Math.max(0, e.t-p.t0)); break; } }
    }
    const ambImp = mezzi.filter(m=>m.trasporto && m.interventoId!=null && ["viaggio","sul_posto","pronto","trasporto","ospedale"].includes(m.stato)).length;
    const gestiti = new Set(paz.filter(p=>p.resp).map(p=>p.uid)).size;
    const sanitari = {
      totLive: paz.length, totChiusi: natiChiuse, tot: paz.length+natiChiuse,
      perGrav: perGrav, salMed: stAvg(pazF.map(p=>p.sal)),
      attesaSoccorso: att(1)+att(2)+att(3), nonAccessibili: att(5),
      valutazione: att(4), presiInCarico: att(7),
      caricati: att(8), inTrasporto: att(9), consegnatiLive: att(10),
      consegnati: paz.filter(p=>p.st===10).length+consegneChiuse,
      conclusiPosto: att(11), rifiuti: att(12), decedutiLive: att(13),
      senzaRisorsa: pazF.filter(p=>p.st<10 && p.st!==12 && !p.resp && !p.has118).length,
      tPresa: stAvg(affidi), ambImpegnate: ambImp, gestiti: gestiti
    };
    // --- VVF operativi ---
    const bucket = {};
    for(const b of VVF_BUCKET) bucket[b[0]] = {attivi:0, chiusi:0};
    bucket["Altri interventi"] = {attivi:0, chiusi:0};
    const vvfLive = live.filter(iv=>iv.vvf);
    const vvfChiuse = ST.chiuse.filter(c=>c.vvf);
    for(const iv of vvfLive) bucket[vvfBucket(iv.tipoNome)].attivi++;
    for(const c of vvfChiuse) bucket[vvfBucket(c.tipo)].chiusi++;
    const inviiVVF = ST.arrivi.filter(a=>a.corpo==="VVF");
    const intrLive = paz.filter(p=>p.intr).length;
    const intrChiusi = ST.chiuse.reduce((s,c)=>s+(c.intr||0),0);
    const libChiusi = ST.chiuse.reduce((s,c)=>s+(c.lib||0),0);
    const libLive = paz.filter(p=>p.lib).length;
    const vvfOp = {bucket:bucket, avvii: ST.missions.filter(m=>m.vvf).length,
      invii:inviiVVF.length, tArrivo:stAvg(inviiVVF.map(a=>a.leg)),
      intrLive:intrLive, intrTot:intrLive+intrChiusi, estratti:libLive+libChiusi,
      concluse:vvfChiuse.length, inCorso:vvfLive.length};
    // --- chiamate ---
    const perTipo = Object.values(ST.tipi).sort((a,b)=>b.calls-a.calls);
    const topTipi = perTipo.slice(0,12);
    const fasce = [0,0,0,0];
    for(const c of ST.calls){ const h=c.ora||0; fasce[h<6?0:h<12?1:h<18?2:3]++; }
    const urg = ST.calls.filter(c=>(c.prio||0)>=1 && (c.prio||0)<=2).length;
    const giorni = Object.keys(ST.giorni).map(Number).sort((a,b)=>a-b).map(d=>({day:d, calls:ST.giorni[d].calls||0, chiuse:ST.giorni[d].chiuse||0}));
    const chiamateS = {tot:ST.tot.calls, attese:chiamate.length,
      accettate:ST.tot.accettate, rifiutate:ST.tot.rifiutate,
      topTipi:topTipi, altriTipi:Math.max(0,perTipo.length-topTipi.length),
      fasce:fasce, urgenti:urg, nonUrgenti:Math.max(0,ST.calls.length-urg),
      giorni:giorni, serieCap:STAT_CAP.calls};
    // --- mezzi (filtro servizio) ---
    const righeMz = [];
    for(const m of mezzi){
      if(f.servizio==="118" && m.corpo==="VVF") continue;
      if(f.servizio==="VVF" && m.corpo!=="VVF") continue;
      const pm = ST.perMezzo[m.codice]||{invii:0, arrN:0, arrSomma:0, servMin:0};
      righeMz.push({cod:m.codice, tipo:m.tipo, corpo:m.corpo, stato:m.stato,
        invii:pm.invii, servMin:pm.servMin,
        arrMedio:pm.arrN>0?pm.arrSomma/pm.arrN:null,
        utilizzo:statGameMin>0?(pm.servMin/statGameMin*100):null});
    }
    righeMz.sort((a,b)=>b.servMin-a.servMin);
    // --- diagnostica ---
    const senzaAmb = paz.filter(p=>p.st===6 && !p.has118 && !p.resp)
      .map(p=>({uid:p.uid, comune:p.comune, tipo:p.tipo}));
    const conAttesa = live.filter(iv=>pazientiInSospeso(iv)>0)
      .map(iv=>{ const en=entiCoinvolti(iv);
        return {id:iv.id, comune:iv.comune||"?", tipo:iv.tipoNome||"?", n:pazientiInSospeso(iv), h118:en.h118}; });
    const stacchiRec = ST.stacchi.filter(s=>(s.pending||0)>0).slice(-20).reverse();
    const bloccate = [];
    for(const iv of live){
      const en = entiCoinvolti(iv);
      const age = (iv._s0!=null)?(statClock-iv._s0):((clockMin>=iv.t0)?(clockMin-iv.t0):null);
      if(iv.stato==="attesa" && !(iv.mezziIds||[]).length && age!=null && age>15)
        bloccate.push({id:iv.id, comune:iv.comune||"?", motivo:"in attesa senza mezzi da "+Math.round(age)+" min"});
      else if(pazientiInSospeso(iv)>0 && !en.h118)
        bloccate.push({id:iv.id, comune:iv.comune||"?", motivo:"feriti in sospeso senza 118 collegato"});
      else if(age!=null && age>180)
        bloccate.push({id:iv.id, comune:iv.comune||"?", motivo:"aperta da oltre 3 ore di gioco"});
    }
    const diagnostica = {senzaAmb:senzaAmb, conAttesa:conAttesa, stacchi:stacchiRec,
      bloccate:bloccate, verifica:ST.verifica};
    return {ora:{day:statDay, clock:hhmm(clockMin), gameMin:Math.round(statGameMin), realeMin:Math.round((Date.now()-bootReal)/60000*10)/10},
      generali:generali, servizi:servizi, sanitari:sanitari, vvfOp:vvfOp,
      chiamate:chiamateS, mezzi:righeMz, diagnostica:diagnostica, missioni:righe.slice(-150).reverse(),
      filtri:{periodo:f.periodo||"tutto", servizio:f.servizio||"tutti", tipo:f.tipo||"tutte", grav:f.grav||"tutte", stato:f.stato||"tutti"}};
  }
  // export CSV (missioni filtrate + mezzi): ; come separatore, testi quotati
  function statsCSV(f){
    const s = statistiche(f||{});
    const q = (v)=>{ if(v==null) return ""; const t=String(v); return (/[;"\n]/.test(t))?('"'+t.replace(/"/g,'""')+'"'):t; };
    const L = [];
    L.push("STATISTICHE COEU SIM;giorno "+s.ora.day+";ore "+s.ora.clock);
    L.push("TOTALE CHIAMATE;"+s.generali.totChiamate+";IN ATTESA;"+s.generali.inAttesa+";CONCLUSE;"+s.generali.concluse+";ANNULLATE;"+s.generali.annullate+";FALLITE;"+s.generali.fallite);
    L.push("");
    L.push("MISSIONI");
    L.push(["id","giorno","tipo","servizio","prio","prov","comune","pazienti","stato","durata_min","consegnati","deceduti","chiusura"].join(";"));
    for(const m of s.missioni) L.push([m.id, m.day, q(m.tipo), q(m.serv), m.prio, q(m.prov), q(m.comune), m.nPaz, q(m.stato), (m.dur!=null?Math.round(m.dur*10)/10:""), (m.cons!=null?m.cons:""), (m.dec!=null?m.dec:""), q(m.come||"")].join(";"));
    L.push("");
    L.push("MEZZI");
    L.push(["codice","tipo","corpo","stato","invii","servizio_min","arrivo_medio_min","utilizzo_perc"].join(";"));
    for(const m of s.mezzi) L.push([q(m.cod), q(m.tipo), q(m.corpo), q(m.stato), m.invii, Math.round(m.servMin*10)/10, (m.arrMedio!=null?Math.round(m.arrMedio*10)/10:""), (m.utilizzo!=null?Math.round(m.utilizzo*10)/10:"")].join(";"));
    return L.join("\n");
  }

 // ---------- MAPPA (NON OSM!) ----------
 function initMap(){
    // Base Google come LSTSim (le mappe visibili di LSTSim vengono da Google Maps). Default: Mappa stradale.
    const gRoad = L.tileLayer('https://mt{s}.google.com/vt/lyrs=m&hl=it&x={x}&y={y}&z={z}', {
      subdomains:['0','1','2','3'], attribution:'Map data © Google', maxZoom:20 });
    const gSat = L.tileLayer('https://mt{s}.google.com/vt/lyrs=y&hl=it&x={x}&y={y}&z={z}', {
      subdomains:['0','1','2','3'], attribution:'Imagery © Google', maxZoom:20 });
    const satGroup = L.layerGroup([gSat]);
    map = L.map('mapEl', { center:[45.83,9.08], zoom:10, layers:[gRoad] });
    map._karte = gRoad; map._sat = satGroup;
    window._mapDbg = map; // hook debug/test (zoom, screenshot)
    // niente selettore layer standard: si usano i bottoni Karte/Satellit in stile LSTSim

    // niente raggruppamento: ogni intervento mostra sempre il suo spillo (richiesta utente)
    layerInterventi = L.layerGroup();
    layerInterventi.addTo(map);
    layerMezzi = L.layerGroup().addTo(map);
    layerSedi = L.layerGroup().addTo(map);

    // sedi + ospedali statici
    for(const s of D().SEDI){
      const mk = L.marker([s.lat,s.lng],{
        icon: sedeIcon(s.nome,false)
      }).bindTooltip(sedeTooltipHTML(s.nome,false)).addTo(layerSedi);
      sedeMarkers.push({marker:mk, sede:s});
    }
    for(const o of D().OSPEDALI){
      const omk = L.marker([o.lat,o.lng],{
        icon: L.divIcon({className:'ospIcon', html:`<div class="ospDot">H</div>`, iconSize:[14,14], iconAnchor:[7,7]})
      }).bindTooltip(ospTooltipHTML(o)).addTo(layerSedi);
      ospMarkers.push({marker:omk, osp:o});
      omk.on("click", ()=>{
        omk.bindPopup('<div style="min-width:220px">' + schedaOspedaleHTML(o.nome) + ospPSHTML(o.nome) + '</div>').openPopup();
      });
    }
    // sedi Vigili del Fuoco (marker rossi con popup indirizzo, posizioni reali)
    layerVVF = L.layerGroup().addTo(map);
    for(const v of (D().VVF_SEDI||[])){
      const mk = L.marker([v.lat,v.lng],{
        icon: sedeIcon(v.nome,true)
      }).bindTooltip(sedeTooltipHTML(v.nome,true))
        .bindPopup(`<div style="min-width:180px"><b>🚒 ${v.nome}</b><br>${v.addr ? v.addr + "<br>" : ""}${v.comune} (${v.prov})</div>`)
        .addTo(layerVVF);
      vvfMarkers.push({marker:mk, sede:v});
    }
    // chiamate in arrivo (marker gialli squillanti, una a una)
    layerChiamate = L.layerGroup().addTo(map);
    // percorsi stradali dei mezzi dell'intervento selezionato
    layerRoutes = L.layerGroup().addTo(map);
    // grafica della rete autostradale rimossa (richiesta utente):
    // le missioni autostradali nascono comunque sul tratto vero (STRADE da src/data.js)
    layerStrade = L.layerGroup().addTo(map);
    // grafica della rete ferroviaria rimossa (richiesta utente):
    // le missioni nascono comunque sui binari veri (FERROVIE da src/ferrovie.js)
    layerFerro = L.layerGroup().addTo(map);
    // livelli grafici delle reti infrastrutturali rimossi (richiesta utente):
    // le missioni nascono comunque sui punti reali della rete (INFRA da src/infra.js)
    layerInfra = L.layerGroup().addTo(map);
    // rete stradale completa OSM (STRADE_ALL da src/strade-all.js, 167k vie):
    // bianche sottili su renderer canvas, sempre tutte visibili (richiesta utente)
    try{
      if(typeof STRADE_ALL!=="undefined"){
        const roadCv = L.canvas({padding:0.3});
        const decRoad = (a,mul)=>{ const p=[[a[0]/mul,a[1]/mul]]; let la=a[0], ln=a[1];
          for(let i=2;i<a.length;i+=2){ la+=a[i]; ln+=a[i+1]; p.push([la/mul,ln/mul]); } return p; };
        layerStradeMP = L.layerGroup(); layerStradeT = L.layerGroup(); layerStradeR = L.layerGroup();
        // su Satellite si vedono (lì non servirebbero, ma aiutano a leggere la rete), su Mappa no
        if(map.hasLayer(satGroup)){ layerStradeMP.addTo(map); layerStradeT.addTo(map); layerStradeR.addTo(map); }
        for(const a of (STRADE_ALL.M||[])) L.polyline(decRoad(a,100000),{color:"#ffffff",weight:4,opacity:0.9,renderer:roadCv}).addTo(layerStradeMP);
        for(const a of (STRADE_ALL.P||[])) L.polyline(decRoad(a,100000),{color:"#ffffff",weight:3,opacity:0.9,renderer:roadCv}).addTo(layerStradeMP);
        for(const a of (STRADE_ALL.T||[])) L.polyline(decRoad(a,10000),{color:"#ffffff",weight:2,opacity:0.85,renderer:roadCv}).addTo(layerStradeT);
        // residenziali differite di 2s per non bloccare il boot (83k vie)
        setTimeout(()=>{
          try{
            for(const a of (STRADE_ALL.R||[])) L.polyline(decRoad(a,10000),{color:"#ffffff",weight:1.5,opacity:0.8,renderer:roadCv}).addTo(layerStradeR);
          }catch(_){}
        },2000);
      }
    }catch(_){}
    map.fitBounds([[45.52,8.55],[46.18,9.52]]);
    // scala metrica, coordinate sotto il mouse, tasto destro = crea chiamata qui
    try{ L.control.scale({imperial:false}).addTo(map); }catch(_){}
    try{ map.getContainer().addEventListener("contextmenu", e=>e.preventDefault()); }catch(_){}
    const coordBox = document.createElement("div");
    coordBox.id = "coordRead";
    coordBox.style.cssText = "position:absolute;right:6px;bottom:18px;z-index:500;background:#ffffffe0;border:1px solid #888;padding:0 5px;font-size:10px;font-family:monospace;pointer-events:none;";
    coordBox.textContent = "—";
    const mwBox = document.getElementById("mapWrap");
    if(mwBox) mwBox.appendChild(coordBox);
    const legBox = document.createElement("div");
    legBox.style.cssText = "position:absolute;left:6px;bottom:18px;z-index:500;background:#ffffffe0;border:1px solid #888;padding:0 5px;font-size:10px;pointer-events:none;";
    legBox.innerHTML = "<span style='display:inline-block;width:14px;height:3px;background:#fff;border:1px solid #999;vertical-align:middle'></span> tutte le strade";
    if(mwBox) mwBox.appendChild(legBox);
    map.on("mousemove", e=>{ coordBox.textContent = e.latlng.lat.toFixed(4) + ", " + e.latlng.lng.toFixed(4); });
    map.on("mouseout", ()=>{ coordBox.textContent = "—"; });
    map.on("contextmenu", e=>{
      const ql = e.latlng;
      if(inAcqua(ql.lat, ql.lng)){ toast("Lì c'è il lago: scegli un punto a terra"); return; }
      const pop = L.popup().setLatLng(ql).setContent('<div style="min-width:170px"><b>📍 ' + ql.lat.toFixed(4) + ", " + ql.lng.toFixed(4) + '</b><br><button class="lstBtn small primary" id="callHereBtn">📞 Crea chiamata qui</button></div>').openOn(map);
      const bb = document.getElementById("callHereBtn");
      if(bb) bb.onclick = ()=>{ map.closePopup(pop); creaChiamataQui(ql.lat, ql.lng); };
    });
    map.on("click", e=>{ if(pmaArmed) piazzaPMA(e.latlng.lat, e.latlng.lng); });
    document.addEventListener("keydown", e=>{ if(e.key==="Escape"&&pmaArmed) togglePMA(); });
  }

  function toggleVVF(show){
    vvfOn = !!show;
    if(!map || !layerVVF) return vvfOn;
    try{
      if(vvfOn){ if(!map.hasLayer(layerVVF)) layerVVF.addTo(map); }
      else { if(map.hasLayer(layerVVF)) map.removeLayer(layerVVF); }
    }catch(e){}
    return vvfOn;
  }

  function prioColor(p){ return p===1?"#d00000":p===2?"#e6a100":p===3?"#35a835":"#888888"; }
  function _touchMz(mz){ mz._t0 = clockMin; }
  function _clearMz(mz){ mz._t0 = null; }

  // icone sedi fisse: casetta verde (118) e casetta rossa (VVF), senza stati
  function sedeHaMezzi(nome, isVVF){
    return mezzi.some(m=>m.stato==="disponibile"&&m.sede===nome&&((m.corpo==="VVF")===isVVF));
  }
  const HOUSE_SVG = c => `<svg width="18" height="18" viewBox="0 0 24 24"><path d="M12 2 L2 12 h3 v9 h6 v-6 h2 v6 h6 v-9 h3 z" fill="${c}" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
  function sedeIcon(nome, isVVF){
    if(isVVF) return L.divIcon({className:'vvfIcon', html:`<div class="vvfDot" title="${nome}">${HOUSE_SVG("#d00000")}</div>`, iconSize:[20,20], iconAnchor:[10,10]});
    if(!isVVF && (D().MEZZI||[]).some(m=>m.sede===nome && m.tipo==="CNSAS")) return L.divIcon({className:'sedeIcon', html:`<div class="sedeDot" title="${nome}">${HOUSE_SVG("#e6a100")}</div>`, iconSize:[18,18], iconAnchor:[9,9]}); // sedi CNSAS: casetta gialla
    const col = sedeHaMezzi(nome,false) ? "#35a835" : "#888888";
    return L.divIcon({className:'sedeIcon', html:`<div class="sedeDot" title="${nome}">${HOUSE_SVG(col)}</div>`, iconSize:[18,18], iconAnchor:[9,9]});
  }

  // tooltip sede: nome + mezzi presenti in sede in questo momento (solo disponibili)
  function sedeTooltipHTML(nome, isVVF){
    const inSede = mezzi.filter(m=>m.stato==="disponibile"&&m.sede===nome&&((m.corpo==="VVF")===isVVF));
    let h = `<span style="color:#e8720c;text-decoration:underline"><b>${nome}</b></span>`;
    if(!inSede.length) h += `<br><span class="small">nessun mezzo in sede</span>`;
    else for(const m of inSede.slice(0,12))
      h += `<br><span style="color:${(m.cat==="VVF"||m.corpo==="VVF")?"#555":(m.cat==="MSI_MSA"&&m.tipo!=="CNSAS"&&m.tipo!=="PMA"?"#d00000":"#0645ad")}">${m.radio||m.codice}</span>`;
    if(inSede.length>12) h += `<br><span class="small">+ altri ${inSede.length-12}</span>`;
    return h;
  }

  // spillo rosso stile LSTSim per gli interventi
  // Icona missione: colore del codice assegnato; grigia se VVF senza codice (prio 0,
  // resta grigia anche quando il 118 si collega: il colore segue il codice scelto).
  function pinSVG(iv){ const c = iv.prio>0 ? prioColor(iv.prio) : "#666666"; return `<svg width="26" height="32" viewBox="0 0 26 32"><path d="M13 1 C6 1 2 6.5 2 12 C2 20.5 13 31 13 31 C13 31 24 20.5 24 12 C24 6.5 20 1 13 1 Z" fill="${c}" stroke="#fff" stroke-width="1.5"/><circle cx="13" cy="12" r="4" fill="#fff"/></svg>`; }
  function refreshMarkers(){
    if(!map) return;
    layerInterventi.clearLayers(); markersInt.clear();
    const vis = filteredInterventi().slice(0,250); // max 250 marker per performance
    for(const iv of vis){
      if(iv.stato==="chiuso") continue;
      const pulse = iv.stato==="attesa" ? " pulse" : "";
      const mk = L.marker([iv.lat,iv.lng],{
        icon: L.divIcon({className:'intIcon',
          html:`<div class="intPin${pulse}">${pinSVG(iv)}</div>`,
          iconSize:[26,32], iconAnchor:[13,30]})
      });
      mk.bindTooltip(`${luogoIV(iv,false)}<br>Stato: ${iv.stato}`);
      mk.on('click', ()=>{ openIntervento(iv.id); });
      mk.addTo(layerInterventi);
      markersInt.set(iv.id, mk);
    }
    // mezzi assegnati + in rientro (viaggiano visibili, niente sparizioni/teletrasporti);
    // quelli sul posto sono nascosti (stanno dentro lo spillo)
    layerMezzi.clearLayers(); markersMz.clear();
    for(const mz of mezzi){
      if(mz.interventoId==null) continue;
      if(mz.stato==="sul_posto"||mz.stato==="pronto"||mz.stato==="ospedale") continue; // in PS sparisce (resta nel tooltip della H), ricompare al rientro
      const isBusy = mz.stato!=="disponibile";
      let ax = 28; // centrato
      const mk = L.marker([mz.lat,mz.lng],{zIndexOffset:1000,
       icon: L.divIcon({className:'mzIcon',
          html:`<div class="mzDot ${mz.stato}" title="${nomem(mz)} ${statoLabel(mz.stato)}">${iconFor(mz,52)}</div>`,
          iconSize:[56,56], iconAnchor:[ax,28]})
      });
      mk.bindTooltip(`${nomem(mz)} (${mz.tipo})<br>${mz.sede} - ${mz.stato}${mz.interventoId?" → #"+mz.interventoId:""}`);
      mk.on("click", ()=>{ selMz = mz.codice; showMzDetail(mz.codice); renderListe(); const el = document.querySelector("#mzList .selMz"); if(el) el.scrollIntoView({block:"nearest"}); });
      mk.addTo(layerMezzi);
      markersMz.set(mz.codice, mk);
    }
    // tooltip + colore sedi: mezzi presenti in sede in questo momento
    for(const e of sedeMarkers){ try{ e.marker.setTooltipContent(sedeTooltipHTML(e.sede.nome,false)); e.marker.setIcon(sedeIcon(e.sede.nome,false)); }catch(_){} }    for(const e of vvfMarkers){ try{ e.marker.setTooltipContent(sedeTooltipHTML(e.sede.nome,true)); e.marker.setIcon(sedeIcon(e.sede.nome,true)); }catch(_){} }
    for(const e of ospMarkers){ try{ e.marker.setTooltipContent(ospTooltipHTML(e.osp)); }catch(_){} }
    refreshRoutes();
  }

  // tracce dei percorsi: rimosse su richiesta (il layer resta ma vuoto)
  function refreshRoutes(){
    if(!map || !layerRoutes) return;
    layerRoutes.clearLayers();
  }

  function moveMarkerMz(mz){
    const mk = markersMz.get(mz.codice);
    if(mk) mk.setLatLng([mz.lat,mz.lng]);
  }

  // ---------- FILTRI / LISTE ----------
  function filteredInterventi(){
    return interventi.filter(iv=>{
      if(!filters[iv.prov]) return false;
      if(iv.prio>0 && !filters["P"+iv.prio]) return false; // prio 0 = VVF senza codice: sempre visibile
      if(filters.soloAttesa && iv.stato==="chiuso") return false;
      if(filters.soloAttesa && !(iv.stato==="attesa"||iv.stato==="viaggio")) return false;
      if(filters.search){
        const s=filters.search.toLowerCase();
        const hay=`${iv.comune} ${iv.indirizzo} ${iv.dialogo||""}`.toLowerCase();
        if(!hay.includes(s)) return false;
      }
      return true;
    }).sort((a,b)=>{
      // attesa prima, poi priorità (rosso→bianco), poi recenti
      const rank = s=> s==="attesa"?0 : s==="viaggio"?1 : s==="sul_posto"?2 : s==="trasporto"?3 : 4;
      if(rank(a.stato)!==rank(b.stato)) return rank(a.stato)-rank(b.stato);
      const pa=a.prio||4, pb=b.prio||4; if(pa!==pb) return pa-pb; // VVF senza codice in fondo
      return b.id-a.id;
    });
  }

  function statoLabel(s){
    return {attesa:"IN ATTESA", viaggio:"IN VIAGGIO", sul_posto:"SUL POSTO", pronto:"PRONTO — PAZIENTE A BORDO", trasporto:"TRASPORTO", chiuso:"CHIUSO", disponibile:"LIBERO", rientro:"RIENTRO", ospedale:"IN PS", fuori_servizio:"FUORI SERVIZIO"}[s]||s;
  }

  function stNum(s){
    // numerino stile LSTSim (S1..S8) per la casellina colorata
    return {disponibile:"1", viaggio:"3", sul_posto:"4", pronto:"5", trasporto:"7", ospedale:"8", rientro:"2", attesa:"0", chiuso:"6", fuori_servizio:"6"}[s] ?? "?";
  }

  function renderListe(){
    // interventi in corso (solo indirizzi, in alto a destra)
    const list = filteredInterventi();
    const aperti = list.filter(i=>i.stato!=="chiuso");
    const el = $("intTopList");
    if(el){
      el.innerHTML = "";
      const frag = document.createDocumentFragment();
      for(const iv of list.slice(0,250)){
        const div = document.createElement("div");
        div.className = "intRow" + (iv.id===selectedId?" sel":"");
        div.id = "introw-" + iv.id;
       const badge = iv.prio>0 ? `<span class="prioDot" style="background:${prioColor(iv.prio)}"></span>` : `<span title="Senza codice — VVF">🚒</span>`;
        const hList = [...new Set(iv.mezziIds.map(c=>mezzi.find(x=>x.codice===c)).filter(m=>m&&m.ospedale&&(m.stato==="trasporto"||m.stato==="ospedale")).map(m=>ospShort(m.ospedale)+codQuad(iv.prio)))];
        div.innerHTML = badge + `<span style="flex:1;min-width:0">📍 ${luogoIV(iv,true)}${hList.length?`<div class="intH">${hList.join(" · ")}</div>`:""}</span><span class="caret">${iv.id===selectedId?"▾":"▸"}</span>`;
        div.title=`#${iv.id} — ${statoLabel(iv.stato)} — ${iv.mezziIds.map(c=>nomem(mezzi.find(x=>x.codice===c))).join(", ")||"nessun mezzo"}`;
        div.onclick = ()=>selectIntervento(iv.id);
        frag.appendChild(div);
        if(iv.id===selectedId){
          // tendina: i dettagli si aprono qui sotto l'indirizzo
          const dd = document.createElement("div");
          dd.className = "detDrop";
          dd.id = "detDrop";
          frag.appendChild(dd);
        }
      }
      if(aperti.length===0){
        const d=document.createElement("div");
        d.className="small"; d.style.padding="4px 6px"; d.style.color="#555";
        d.textContent="Nessun intervento in corso.";
        frag.appendChild(d);
      }
      el.appendChild(frag);
    }
    if($("intCount")) $("intCount").textContent = `${aperti.length} aperti / ${list.length}`;

    // mezzi 118 + VVF/CNSAS/PMA attivati (assegnati a un intervento: da qui si apre il dettaglio col tasto ➡️ Dirotta)
    const mzEl = $("mzList");
    if(mzEl){
      mzEl.innerHTML="";
      const f2 = document.createDocumentFragment();
      const mezzi118 = mezzi.filter(m=>m.corpo!=="VVF" && m.tipo!=="CNSAS" && m.tipo!=="PMA");
      const vvfAttivi = mezzi.filter(m=>m.corpo==="VVF" && m.interventoId!=null);
      const cnsasAttivi = mezzi.filter(m=>m.tipo==="CNSAS" && m.interventoId!=null);
      const pmaAttivi = mezzi.filter(m=>m.tipo==="PMA" && m.interventoId!=null);
      for(const mz of [...mezzi118, ...vvfAttivi, ...cnsasAttivi, ...pmaAttivi]){
        const d=document.createElement("div");
        d.className="mzCard "+mz.stato + (mz.codice===selMz?" selMz":"");
        const _mc = mz.tipo==="CNSAS" ? "#e6a100" : mz.tipo==="PMA" ? "#0e7c86" : (mz.cat==="MSI_MSA" ? "#d00000" : ((mz.cat==="VVF"||mz.corpo==="VVF") ? "#555" : ""));
        d.innerHTML=`<span class="code"${_mc?` style="color:${_mc}"`:""}>${mz.corpo==="VVF"?"🚒 ":mz.tipo==="CNSAS"?"⛰️ ":mz.tipo==="PMA"?"⛺ ":""}${mz.codice}</span><span class="stBox st-${mz.stato}">${stNum(mz.stato)}</span>`;
        d.title=`${mz.codice} (${mz.tipo}) — ${mz.sede} — ${statoLabel(mz.stato)}${mz.interventoId?" → #"+mz.interventoId:""}`;
        d.onclick=()=>{ selMz=mz.codice; showMzDetail(mz.codice); renderListe(); };
        f2.appendChild(d);
      }
      mzEl.appendChild(f2);
      const disp = mezzi118.filter(m=>m.stato==="disponibile").length;
      if($("mzCount")) $("mzCount").textContent = `${disp}/${mezzi118.length}`;
    }
    if(selMz) showMzDetail(selMz);
    renderDetail();
  }

  function selectIntervento(id){
    // tendina sotto l'indirizzo: primo click apre, secondo richiude
    selectedId = (selectedId===id) ? null : id;
    renderListe();
    const iv = interventi.find(x=>x.id===id);
    if(selectedId!=null && iv && map){ try{ map.panTo([iv.lat,iv.lng], {animate:true}); }catch(e){} }
    const row = document.getElementById("introw-"+id);
    if(row) row.scrollIntoView({block:"nearest"});
  }
  function openIntervento(id){
    // click sullo spillo in mappa: apre sempre (mai toggle), porta la mappa sul punto e mostra la riga
    selectedId = id;
    renderListe();
    const iv = interventi.find(x=>x.id===id);
    if(iv && map){ try{ map.panTo([iv.lat,iv.lng], {animate:true}); }catch(e){} }
    const row = document.getElementById("introw-"+id);
    if(row) row.scrollIntoView({block:"nearest"});
  }

  let selMz = null;
  function showMzDetail(codice){
    const box = $("mzDetail");
    const mz = mezzi.find(m=>m.codice===codice);
    if(!box) return;
    if(!mz){ box.innerHTML = `<span class="small">Seleziona un mezzo.</span>`; return; }
    const iv = interventi.find(x=>x.id===mz.interventoId);
    box.innerHTML = `
     <div class="mzPic">${vehImg(mz,2.1)||iconFor(mz,40)}</div>
     <div>${mz.tipo==="PMA"?`<span class="code" style="color:#0e7c86">${nomem(mz)}</span>`:mz.tipo==="CNSAS"?`<span class="code" style="color:#e6a100">${nomem(mz)}</span>`:(mz.cat==="MSI_MSA"?`<span class="code" style="color:#d00000">${nomem(mz)}</span>`:((mz.cat==="VVF"||mz.corpo==="VVF")?`<span class="code" style="color:#555">${nomem(mz)}</span>`:`<b class="code" style="color:#0645ad">${nomem(mz)}</b>`))} <span class="stBox st-${mz.stato}">${stNum(mz.stato)}</span>
      <span class="small">${mz.tipo}${mz.turno?` · ⏰ ${mz.turno[0]}:00-${mz.turno[1]}:00${turnoAttivo(mz)?"":" (fuori turno)"}`:""}</span></div>
      <div class="kv"><b>Categoria:</b> ${mz.cat} (${mz.tipo}) · posti paziente: ${mz.cap} · trasporto: ${mz.trasporto?"sì":"no"}${mz.tArrivo!=null?" · arrivato "+hhmm(mz.tArrivo):""}</div>
      <div class="kv"><b>Posizione:</b> ${mz.sede} ${mz.stato!=="disponibile"&&iv?"→ #"+iv.id:""}</div>
      ${mz.uscita>0?`<div class="kv">🚪 In uscita dalla sede…</div>`:""}
      <div class="kv"><b>Ospedale:</b> ${mz.ospedale||"—"}</div>
      <div class="kv"><b>Paziente a bordo:</b> ${(mz.trasportaPz&&mz.pazIdx!=null&&iv)?("P"+(mz.pazIdx+1)+" \u2192 "+(mz.ospedale||"PS")+codQuad(iv.prio)):"— occupato: no"}</div>
      <div style="margin-top:4px; display:flex; gap:4px;">
        <button class="lstBtn small" id="mzReBtn">↩️ Rientra</button>
        ${mz.stato==="disponibile"&&mz.interventoId==null?`<button class="lstBtn small" id="mzFsBtn" title="Stato FMS 6: non riceve più missioni">🔧 6 Fuori servizio</button>`:""}
        ${mz.stato==="fuori_servizio"?`<button class="lstBtn small" id="mzFsBtn" title="Torna disponibile (FMS 1)">✅ 1 In servizio</button>`:""}
      </div>
      ${["viaggio","rientro","sul_posto"].includes(mz.stato)&&interventi.length?`<div style="margin-top:4px; display:flex; gap:4px;"><select id="mzDivSel" style="flex:1;min-width:0;font-size:11px;" title="Intervento di destinazione (anche la sua scena, se sta rientrando dal PS)">${interventi.filter(iv=>iv.id!==mz.interventoId).map(iv=>`<option value="${iv.id}">#${iv.id} — ${iv.comune} (${statoLabel(iv.stato)})</option>`).join("")}${(()=>{const same=interventi.find(iv=>iv.id===mz.interventoId); return same?`<option value="${same.id}">#${same.id} — ${same.comune} (${statoLabel(same.stato)}) ↩️ torna sulla scena</option>`:"";})()}</select><button class="lstBtn small" id="mzDivBtn" title="Dirotta subito: riparte da dove si trova">➡️ Dirotta</button></div>`:""}`;
    const rb = $("mzReBtn"), db = $("mzDivBtn"), fsb = $("mzFsBtn");
    if(rb) rb.onclick=()=>rientraMezzo(mz.codice);
    if(fsb) fsb.onclick=()=>{ fuoriServizio(mz.codice, mz.stato==="disponibile"); showMzDetail(mz.codice); };
    if(db) db.onclick=()=>{ const sel=$("mzDivSel"); if(sel && assegnaMezzo(mz.codice, +sel.value)) showMzDetail(mz.codice); };
  }

  function renderDetail(){
    // lo spazio sotto la lista resta vuoto: i dettagli si aprono a tendina sotto l'indirizzo
    const dbx = $("detailBox");
    if(dbx) dbx.innerHTML = "";
    const box = $("detDrop");
    if(!box) return;
    const iv = interventi.find(x=>x.id===selectedId);
    if(!iv) return;
    const waitS = Math.max(0, Math.round((clockMin-iv.t0)*60));
    box.innerHTML = `
      <div class="detTitle" style="display:flex;justify-content:space-between;align-items:baseline;gap:6px;"><span>${luogoIV(iv,false)}</span><span class="small">${Math.floor(waitS/60)}m</span></div>
      <div class="detBtns">
        <button class="lstBtn" id="mapBtn">Mostra sulla mappa</button>
        <button class="lstBtn" id="assistBtn">🆘 Richiedi assistenza</button>
        <button class="lstBtn" id="editBtn">Chiudi intervento</button>
      </div>
      <div class="kv"><b>Luogo:</b> ${luogoIV(iv,false)}</div>
      ${iv.reportFatto&&iv.trasporto&&!iv.stabilizzato?`<div class="kv">🩺 Stabilizzazione in corso: trasporto al 100% di salute</div>`:""}
      ${msaAtteso(iv)?`<div class="kv">⏳ In attesa di MSA</div>`:""}
      ${iv.reportFatto&&iv.trasporto&&iv.stabilizzato&&(iv.daTrasportare||0)>0?`<div class="kv">💚 Pazienti stabili al 100%: pronti per il trasporto</div>`:""}
      <div class="kv"><b>Veicoli assegnati:</b></div>
      <div id="onScene"></div>
      <div class="kv"><b>Registrazione della conversazione:</b><br>${hhmm(iv.t0)} — chiamante: “${iv.dialogo||"—"}”</div>
      ${iv.reportFatto?`<div class="kv"><b>Situazione:</b> ${iv.emoji||""} ${iv.tipoNome||""}. ${iv.desc||""}<br>${pazientiHTML(iv)}</div>`:""}
    `;
    if($("incTimer")) $("incTimer").textContent = Math.floor(waitS/60)+"m";
    const asb=$("assistBtn"), eb=$("editBtn"), mb=$("mapBtn");
    if(asb) asb.onclick=()=>{ openAssist(iv.id); };
    if(eb) eb.onclick=()=>{
      if(iv.stato==="chiuso") return; // già chiusa: niente doppi
      // niente chiusure in anticipo: paziente a bordo o feriti non consegnati (118 o VVF)
      if(mezziConPaziente(iv).length>0){ toast("\uD83C\uDFE5 C\u2019\u00e8 un paziente a bordo: prima la consegna in PS"); return; }
      if(pazientiInSospeso(iv)>0 && (iv.trasporto||iv.vvf)){ toast(iv.vvf && !iv.trasporto ? "\uD83D\uDE92 Ci sono feriti senza ambulanza: mandane una prima di chiudere" : "\uD83C\uDFE5 Ci sono pazienti non ancora consegnati: completa i trasporti prima di chiudere"); return; }
      chiudiPazientiMissione(iv,"manuale");
      iv.stato="chiuso"; iv.gestito=true; chiusi++; score+=50;
      for(const c of [...iv.mezziIds]){ const m=mezzi.find(x=>x.codice===c); if(m){ vaiA(m, m.baseLat, m.baseLng, "rientro"); } }
      iv.mezziIds=[];
      log(`\u2705 Chiuso a <b>${iv.comune}</b>`, "ok");
      statChiudi(iv, "manuale"); // statistiche: chiusura in archivio
      interventi = interventi.filter(x=>x.id!==iv.id);
      selectedId=null;
      refreshMarkers(); renderListe(); updateStats();
    };
    if(mb) mb.onclick=()=>{ if(map) map.panTo([iv.lat,iv.lng]); };
    { const _dd = $("detDrop"); if(_dd) _dd.querySelectorAll("[data-rif]").forEach(b=>{ b.onclick=()=>{ registraRifiuto(iv.id, +b.getAttribute("data-rif")); }; }); }
    const os=$("onScene");
    os.innerHTML="";
    for(const c of iv.mezziIds){
      const mz=mezzi.find(x=>x.codice===c);
      if(!mz) continue;
      const row=document.createElement("div"); row.className="onSceneRow";
      const htag = (mz.ospedale&&(mz.stato==="trasporto"||mz.stato==="ospedale"))?` <span class="small" style="color:#0645ad">${ospShort(mz.ospedale)}${codQuad(iv.prio)}</span>`:"";
      const ptag = (mz.trasportaPz&&mz.pazIdx!=null&&iv) ? ` <span class="small" style="color:#d00000">🚑 P${mz.pazIdx+1}</span>` : "";
      const mcol = mz.tipo==="CNSAS" ? "#e6a100" : mz.tipo==="PMA" ? "#0e7c86" : mz.cat==="VVF" ? "#555" : (mz.cat==="AMBULANZA" ? "#0645ad" : "#d00000");
      row.innerHTML=`<span style="flex:1"><span style="color:${mcol}">${nomem(mz)}</span>${htag}${ptag}</span><span class="stBox st-${mz.stato}">${stNum(mz.stato)}</span>`;
      os.appendChild(row);
      // il trasporto parte da solo appena il paziente è a bordo: niente tasti, niente rientro manuale
    }
    if(!os.children.length) os.innerHTML = `<div class="small">—</div>`;
  }

  // ---------- UI helpers ----------
  // Radio disciplinata: mostra solo arrivi sul posto, trasporti in PS e richieste di medicalizzato.
  // log() resta per compatibilita ma mostra solo l'avvio turno; i messaggi operativi passano da logRadio().
  function log(msg, cls){
    if(!msg) return;
    if(msg.includes("Centrale COEU SIM")||msg.includes("Premi 'Nuova chiamata'")) logRadio(msg, cls);
  }
  function logRadio(msg, cls){
    const el=$("logBox"); if(!el) return;
    const hh=String(Math.floor(clockMin/60)).padStart(2,"0"), mm=String(Math.floor(clockMin%60)).padStart(2,"0");
    const div=document.createElement("div");
    div.className = cls || "";
    div.innerHTML="<span class=\"lt\">"+hh+":"+mm+"</span> "+msg;
    el.prepend(div);
    while(el.children.length>120) el.lastChild.remove();
  }
  function toast(msg){
    const el=$("toast"); if(!el) return;
    el.textContent=msg; el.hidden=false;
    clearTimeout(el._t); el._t=setTimeout(()=>el.hidden=true,2200);
  }
  function blip(){
    // squillo da ~1 secondo all'arrivo di una chiamata (alternanza 440/480 Hz stile telefono)
    try{
      const AC = window.AudioContext||window.webkitAudioContext; if(!AC) return;
      const ctx = window._ac || (window._ac = new AC());
      if(ctx.state==="suspended") ctx.resume(); // parte al primo gesto dell'operatore (policy autoplay browser)
      const t0 = ctx.currentTime + 0.01;
      const o=ctx.createOscillator(), g=ctx.createGain();
      o.type="sine";
      for(let k=0;k<4;k++) o.frequency.setValueAtTime(k%2?480:440, t0+k*0.25);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.09, t0+0.03);
      g.gain.setValueAtTime(0.09, t0+0.94);
      g.gain.exponentialRampToValueAtTime(0.0001, t0+1.0);
      o.connect(g); g.connect(ctx.destination);
      o.start(t0); o.stop(t0+1.05);
    }catch(e){}
  }
  let _invioN = 0, _invioT = null;
  function invioBatch(){
    // conta gli invii in una finestra di 400ms: i batch (incarico, assistenza) sono
    // sincroni e finiscono tutti dentro; sotto i 5 mezzi resta tutto silenzioso
    _invioN++;
    if(_invioT) return;
    _invioT = setTimeout(()=>{ const n=_invioN; _invioN=0; _invioT=null; if(n>=5) invioBeep(); else if(n>=2) invioBip(); }, 400);
  }
  function invioBip(){
    // conferma invio ridotto (2-4 mezzi): due bip acuti, diverso da squillo e tripletta
    try{
      const AC = window.AudioContext||window.webkitAudioContext; if(!AC) return;
      const ctx = window._ac || (window._ac = new AC());
      if(ctx.state==="suspended") ctx.resume();
      const t0 = ctx.currentTime + 0.01;
      const o=ctx.createOscillator(), g=ctx.createGain();
      o.type="sine";
      o.frequency.setValueAtTime(660, t0);
      o.frequency.setValueAtTime(880, t0+0.12);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.05, t0+0.02);
      g.gain.setValueAtTime(0.05, t0+0.22);
      g.gain.exponentialRampToValueAtTime(0.0001, t0+0.26);
      o.connect(g); g.connect(ctx.destination);
      o.start(t0); o.stop(t0+0.3);
    }catch(e){}
  }
  function invioBeep(){
    // conferma invio massiccio (5+ mezzi): SONAGLIO — raffica di rintocchi metallici acuti (~0,8s)
    try{
      const AC = window.AudioContext||window.webkitAudioContext; if(!AC) return;
      const ctx = window._ac || (window._ac = new AC());
      if(ctx.state==="suspended") ctx.resume();
      const t0 = ctx.currentTime + 0.01;
      const notes = [2489, 2960, 3520, 2960, 3520, 4186, 3520]; // 7 rintocchi acuti alternati
      notes.forEach((f, k)=>{
        const t = t0 + k*0.115;
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = "triangle";
        o.frequency.setValueAtTime(f, t);
        const o2 = ctx.createOscillator(), g2 = ctx.createGain(); // parziale metallica scordata
        o2.type = "sine";
        o2.frequency.setValueAtTime(f*2.76, t);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.07, t+0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t+0.1);
        g2.gain.setValueAtTime(0.0001, t);
        g2.gain.exponentialRampToValueAtTime(0.025, t+0.01);
        g2.gain.exponentialRampToValueAtTime(0.0001, t+0.07);
        o.connect(g); g.connect(ctx.destination);
        o2.connect(g2); g2.connect(ctx.destination);
        o.start(t); o.stop(t+0.12);
        o2.start(t); o2.stop(t+0.09);
      });
    }catch(e){}
  }
  function updateClock(){
    const t=`${String(Math.floor(clockMin/60)).padStart(2,"0")}:${String(Math.floor(clockMin%60)).padStart(2,"0")}`;
    if($("clockEl")) $("clockEl").textContent=t;
    if($("icoClock")) $("icoClock").textContent=t;
    if($("funkClock")) $("funkClock").textContent=t;
  }
  function updateStats(){
    const aperti = interventi.filter(i=>i.stato!=="chiuso").length;
    const attesa = interventi.filter(i=>i.stato==="attesa").length;
    const disp = mezzi.filter(m=>m.stato==="disponibile"&&m.corpo!=="VVF").length;
    const tot118 = mezzi.filter(m=>m.corpo!=="VVF").length;
    if($("statAperti")) $("statAperti").textContent=aperti;
    if($("statAttesa")) $("statAttesa").textContent=attesa;
    if($("statMezzi")) $("statMezzi").textContent=`${disp}/${tot118}`;
    if($("statScore")) $("statScore").textContent=score;
    if($("statChiusi")) $("statChiusi").textContent=chiusi;
    if($("statC1")) $("statC1").textContent=contaColori[1]||0;
    if($("statC2")) $("statC2").textContent=contaColori[2]||0;
    if($("statC3")) $("statC3").textContent=contaColori[3]||0;
    if($("statC4")) $("statC4").textContent=contaColori[4]||0;
    if($("icoMz")) $("icoMz").textContent=disp;
    if($("icoInt")) $("icoInt").textContent=attesa;
    updateClock(); meteoUpdate();
  }

  // ---------- BOOT ----------
  function boot(){
    statsLoad(); // statistiche: ripristina lo storico del reload (se c'è)
    try{ if(window.COEUGLOB) COEUGLOB.boot(); }catch(_){} // statistiche globali: visitatore + presenza
    initMezzi();
    preloadVeh(); // grafiche PNG mezzi stile LSTSim
    try{ if(window.COEUIA) console.info('[COEU] Livello 3 IA attivo, modo='+window.COEUIA.modo()); }catch(_){}
    const _pzCfgErr = validaPZConfig(); // probabilità pazienti su 100, tetti, piscine quadri
    if(_pzCfgErr.length) console.warn("[COEU] config pazienti da rivedere:", _pzCfgErr.join(" | "));
    const _tipiErr = validaTipi(); // schema + coerenza dinamica/mezzi/pazienti di tutti i TIPI
    if(_tipiErr.length) console.warn("[COEU] tipi da rivedere ("+_tipiErr.length+"):", _tipiErr.join(" | "));
    initMap();
    renderCalls(); renderListe(); updateStats(); updateClock();
    wireMeteo(); // il riquadro meteo e un tasto con scelta manuale
    wireOra(); // l’orologio e un tasto con scelta manuale dell’ora
    try{ setTimeout(()=>{ try{ map.invalidateSize(); }catch(e){} },300); }catch(e){}
    try{ window.addEventListener("resize", ()=>{ try{ map.invalidateSize(); }catch(e){} }); }catch(e){}
    log("Centrale COEU SIM VA/CO/LC — inizio turno. Mezzi pronti.");
    log("📞 Premi 'Nuova chiamata' per far squillare il telefono (o attiva l'Afflusso).");
    let last=performance.now();
    setInterval(()=>{
      const now=performance.now();
      const dt=(now-last)/1000; last=now;
      tick(Math.min(2,dt));
      // refresh marker mezzi ogni ~1s (posizioni già aggiornate in tick)
      if(!paused) refreshMezziOnly();
    },1000);
    // refresh completo marker interventi ogni 5s (nuovi/priorità)
    setInterval(()=>{ if(!paused) refreshMarkers(); },5000);
  }

  function refreshMezziOnly(){
    if(!map) return;
    // aggiorna solo posizioni per fluidità senza ricreare tutto
    for(const mz of mezzi) moveMarkerMz(mz);
  }

  function switchBase(which){
    if(!map) return;
    try{
      if(which==="sat"){ map.removeLayer(map._karte); map._sat.addTo(map); }
      else { map.removeLayer(map._sat); map._karte.addTo(map); }
      // la rete completa (STRADE_ALL) si vede solo col Satellite, la Mappa resta come prima
      const showR = (which==="sat");
      for(const Lr of [layerStradeMP, layerStradeT, layerStradeR]){
        if(!Lr) continue;
        if(showR){ if(!map.hasLayer(Lr)) Lr.addTo(map); }
        else if(map.hasLayer(Lr)) map.removeLayer(Lr);
      }
      setTimeout(()=>{ try{ map.invalidateSize(); }catch(e){} },200);
    }catch(e){}
  }

  return {
    boot, generaN, nuovaChiamata, makeChiamataTipo, accettaChiamata, rifiutaChiamata, fuocoStato, fuocoClasse,
    creaChiamataQui, debugZone, statistiche, statsCSV, statsSave, statsLoad, statsReset,
    autoAssegna, assegnaMezzo, rientraMezzo, mandaOspedale, selectIntervento,
    bisognoPaziente, ospedaliPerBisogno, mostraOspedale, togglePMA, piazzaPMA, rimuoviPMA, pmaStato, maxiAperta,
    pazCat, pzvBucket, tipoRandom, categoriaMissione, categorieMissioni, notaTipo,
    switchBase, toggleVVF, supportoStato,
    get filters(){return filters;},
    setFilter(k,v){filters[k]=v; refreshMarkers(); renderListe();},
    setSearch(s){filters.search=s; renderListe(); refreshMarkers();},
    togglePause(){paused=!paused; return paused;},
    isPaused(){return paused;},
    setSpeed(v){speed=v;},
    getSpeed(){return speed;},
    boostMoto,
    toggleInflow(){ autoInflow=!autoInflow; if(autoInflow) programmaFlusso(); return autoInflow; },
    isInflow(){return autoInflow;},
    setRitmo(v){ if(RITMI[v]){ flusso.ritmo=v; programmaFlusso(); } return flusso.ritmo; },
    getRitmo(){ return flusso.ritmo; },
    flussoStato(){ const c=caricoCentrale(); return {ritmo:flusso.ritmo, auto:autoInflow, attesa:Math.round(flusso.attesa*100)/100, aperti:c.aperti, coda:c.coda, fuochi:flusso.fuochi.slice(), ora:Math.floor(clockMin/60)+":"+String(Math.floor(clockMin%60)).padStart(2,"0")}; },
    setMeteo(c){ return impostaMeteo(c); },
    setOrario(h,m){ return impostaOrario(h,m); },
    setFascia(i,k,v){ setFascia(i,k,v); },
    applicaFasce(){ applicaFasce(); },
    syncFasce(){ syncFasce(); },
    getMeteo(){ return meteo.cond+", "+Math.round(meteo.temp)+" °C"; },
    chiudiChiusi(){ interventi=interventi.filter(i=>i.stato!=="chiuso"); refreshMarkers(); renderListe(); updateStats(); },
    reset(){ pmaReset(); fuocoReset(); interventi=[]; chiamate=[]; ultimiTipi=[]; ultimeChiamate=[]; storicoPazienti=[]; idCounter=1; callCounter=1; selectedId=null; selMz=null; highlightCall=null; chiusi=0; score=0; contaColori={1:0,2:0,3:0,4:0}; clockMin=8*60; flusso.fuochi=[]; programmaFlusso(); statsReset(); try{ if(window.COEUGLOB) COEUGLOB.resetSession(); }catch(_){} initMezzi(); refreshCallMarkers(); refreshMarkers(); renderCalls(); renderListe(); updateStats(); },
    listMezziCodici(){ return mezzi.map(m=>m.codice); },
    // test generazioni: debugPazienti("Incidente stradale", 8) → 8 possibili equipaggi di feriti
    debugPazienti(nome, n){
      const t = D().TIPI.find(x=>x.nome===nome) || D().TIPI[rndi(0,D().TIPI.length-1)];
      const out = [];
      for(let k=0;k<(n||5);k++){ const g = generaPazienti(prioDaTipo(t), t); out.push({n: g.salute.length, salute: g.salute.map(Math.round), profili: g.profili, illesi: g.illesi, evac: g.evac, variante: g.variante}); }
      const c0 = pazCat(t.nome);
      return {tipo: t.nome, cat: c0, pz: t.pz, pzv: (t.vvf ? pzvBucket(t.nome, t.desc) : null), prove: out};
    },
    // ispezione configurazione probabilità (tutte le distribuzioni devono sommare a 100)
    debugPZConfig(){
      return { errori: validaPZConfig(), varianti: PZ_VAR, categorie: Object.keys(PZ_QUADRI), pzv: Object.keys(PZV_TAB) };
    },
    // ispezione rete ospedaliera: debugOspedali("USTIONI", 45.8, 9.0) → proposte ordinate
    debugOspedali(bisogno, lat, lng){
      const r = ospedaliPerBisogno(bisogno||"GENERICO", lat||45.81, lng||9.08, null);
      return {bisogno: r.bisogno, ripiego: r.ripiego, proposte: r.proposte.map(p=>({nome:p.o.nome, km:+p.km.toFixed(1), min:Math.round(p.min), motivo:p.motivo}))};
    },
    // ispezione mezzo: categoria esplicita, capacità, trasporto, gruppo supporti
    debugMezzo(codice){
      const m = mezzi.find(x=>x.codice===codice);
      if(!m) return null;
      return {codice:m.codice, interventoId:m.interventoId, cat:m.cat, tipo:m.tipo, corpo:m.corpo, cap:m.cap, trasporto:m.trasporto, clinica:m.clinica, gruppo:gruppoSupporto(m), stato:m.stato, interventoId:m.interventoId, vel:(m.velKmh||null), vmax:(m.segVel&&m.segVel.length?Math.max.apply(null,m.segVel):null), uscita:Math.round((m.uscita||0)*100)/100, velEff:velEff(m)};
    },
    // audit missioni: debugValidazione() -> {errori[], erroriPazienti[], nTipi}
    debugValidazione(){
      return {errori: validaTipi(), erroriPazienti: validaPZConfig(), nTipi: (D().TIPI||[]).length};
    },
    // stato operativo per ente: statoEnti(id) -> {m118, vvf, fine118, fineVVF, inSospeso}
    statoEnti(id){
      const iv = interventi.find(x=>x.id===id);
      if(!iv) return null;
      const s = contaEnti(iv);
      return {id: iv.id, comune: iv.comune, stato: iv.stato, m118: s.m118, vvf: s.vvf, fine118: !!iv.fine118, fineVVF: !!iv.fineVVF, inSospeso: pazientiInSospeso(iv)};
    },
    pazientiStato(id){
      const iv = interventi.find(x=>x.id===id);
      if(!iv) return null;
      return (iv.pazienti||[]).map((s,k)=>({uid:pazUid(iv,k), idx:k, salute:(s==null?null:Math.round(s*10)/10), st:statoPaziente(iv,k), stato:ST_PAZ[statoPaziente(iv,k)], dal:(((iv.pazS||{})[k]||{}).dal!=null?((iv.pazS||{})[k]||{}).dal:null), intr:!!((iv.profili||[])[k]&&iv.profili[k].intr), liberato:!!((iv.liberati||{})[k]), consegnato:!!(iv.pazConsegnati&&iv.pazConsegnati[k]), resp:((iv.pazMezzo&&iv.pazMezzo[k])||(iv.affidi&&iv.affidi[k])||(mezzi.find(m=>m.interventoId===id&&m.pazIdx===k&&m.trasportaPz)||{}).codice||null), mezzo:((iv.pazMezzo&&iv.pazMezzo[k])||(iv.affidi&&iv.affidi[k])||(mezzi.find(m=>m.interventoId===id&&m.pazIdx===k&&m.trasportaPz)||{}).codice||null), log:(((iv.pazS||{})[k]||{}).log||[]).slice(-12)}));
    },
    interventiIds(){ return interventi.map(x=>x.id); },
    // snapshot missioni per la pagina live pubblica (solo lettura, nessuna logica di gioco)
    missioniLive(){
      return interventi.filter(iv=>iv&&iv.stato!=="chiuso").map(iv=>({
        id: iv.id,
        tipo: iv.tipoNome||"?",
        indirizzo: iv.indirizzo||"",
        comune: iv.comune||"",
        prov: iv.prov||"",
        nPaz: (iv.pazienti||[]).length,
        stato: iv.stato||"attesa"
      }));
    },
    chiamateIds(){ return chiamate.map(c=>c.callId); },
    stPaz: statoPaziente,
    verificaStati,
    archivioPazienti(){ return storicoPazienti.slice(); },
    registraRifiuto,
    forzaStatoPaziente,
    debugStatiPazienti(id){ const iv = interventi.find(x=>x.id===id); if(!iv) return null; return {id, comune:iv.comune, valutato:!!iv.valutato, stabilizzato:!!iv.stabilizzato, trasporto:!!iv.trasporto, daTrasportare:iv.daTrasportare||0, avvisi:iv.avvisi||{}, pazienti:(iv.pazienti||[]).map((s,k)=>({uid:pazUid(iv,k), idx:k, st:statoPaziente(iv,k), stato:ST_PAZ[statoPaziente(iv,k)]}))}; },
    // validatore bozze (puro sulla bozza passata): per i test
    validaBozza,
    pazCat, intrAmmesso, dinamicaViolenta, nearestMezzo, pzvBucket,
    // formula velocita contenuta per i test: velLST(50,{tipo:"MSB"}) -> 45
    velLST(kmh, tipo){ return lstSegVel(kmh, {tipo:tipo||"MSB"}); },
    // intervallo pazienti atteso per un tipo VVF (dinamico per tipologia; null per le sanitarie che restano esatte)
    pzvRange(nome){ const t = D().TIPI.find(x=>x.nome===nome); if(!t || !t.vvf) return null; const tab = PZV_TAB[pzvBucket(t.nome, t.desc)] || PZV_TAB.tecnico; return [tab.w[0][0], tab.w[tab.w.length-1][0]]; },
    // bozza validata senza effetti (niente memoria anti-ripetizione): per i test    // bozza validata senza effetti (niente memoria anti-ripetizione): per i test
    debugTira(n){ const a = {}, b = {}; const N = n||20000; for(let k=0;k<N;k++){ const x = tiraNManv(); a[x]=(a[x]||0)+1; const y = tiraConteggioMaxi(); b[y]=(b[y]||0)+1; } return {N, manv:a, maxi:b}; },
    bozzaProva(){
      const b = creaBozzaUna();
      const v = validaBozza(b);
      const t0 = D().TIPI.find(x=>x.nome===b.tipoNome) || {};
      return {tipo: b.tipoNome, zona: t0.zona||"misto", lat: b.lat, lng: b.lng, comune: b.comune, indirizzo: b.indirizzo, nPaz: (b.pazienti||[]).length, nTot: (b.pazienti||[]).length+(b.pazientiNascosti||[]).length, nNascosti: (b.pazientiNascosti||[]).length, ignoti: !!b.pazIgnoti, verifica: !!b.pazDaVerificare, maxi: !!b.maxi, manv: !!b.manv, visto: (b.visto||[]).slice(), vvf: !!b.vvf, trasporto: !!b.trasporto, richiesti: b.richiesti, ok: v.ok, correzioni: v.correzioni};
    },
    // distribuzione danni maltempo (per i test): debugStorm("Temporale", 20000) -> conteggi per tipo
    debugStorm(cond, n){
      const lista = STORM_TIPI[cond] || [];
      const c = {};
      for(let k=0;k<(n||5000);k++){ const t = pescaStorm(lista, cond); c[t]=(c[t]||0)+1; }
      return {cond, N:n||5000, conteggi:c};
    },
    // tipi alpini agganciati alle montagne vere (per verifica): montagnaLista() -> nomi
    montagnaLista(){ return (D().TIPI||[]).filter(t=>isMontagna(t)).map(t=>t.nome); },
    // incidente esplicito a 3+ veicoli (per i test): meno probabile + 0-6 feriti di qualsiasi gravita
    isTreVeicoli(nome){ return TRE_VEICOLI_RE.test(nome||""); },
    // bozza di un tipo preciso (per i test): come bozzaProva ma con tipo forzato
    bozzaTipo(nome){      const b = creaBozzaUna(null, nome);
      const v = validaBozza(b);
      const t0 = D().TIPI.find(x=>x.nome===b.tipoNome) || {};
      const outTipo = {tipo: b.tipoNome, zona: t0.zona||"misto", lat: b.lat, lng: b.lng, comune: b.comune, indirizzo: b.indirizzo, nPaz: (b.pazienti||[]).length, nTot: (b.pazienti||[]).length+(b.pazientiNascosti||[]).length, nNascosti: (b.pazientiNascosti||[]).length, ignoti: !!b.pazIgnoti, verifica: !!b.pazDaVerificare, maxi: !!b.maxi, manv: !!b.manv, visto: (b.visto||[]).slice(), vvf: !!b.vvf, trasporto: !!b.trasporto, richiesti: b.richiesti, ok: v.ok, correzioni: v.correzioni};
      return outTipo;
    },
    // bozza di un maxi/MANV di un tipo preciso (per i test): pesca pura finché
    // tiraEventoGrande non estrae quel tipo come maxi/MANV (niente memoria/pubblicazione)
    bozzaEvento(nome, n){
      const out = [];
      const want = n||3;
      let guard = 0;
      while(out.length<want && guard++<40000){
        const b = creaBozzaUna();
        if(b.tipoNome!==nome || !(b.manv||b.maxi)) continue;
        const v = validaBozza(b);
        out.push({tipo:b.tipoNome, evento:b.manv?"MANV":"maxi", dialogo:b.dialogo, indirizzo:b.indirizzo, comune:b.comune, prov:b.prov, nTot:(b.pazienti||[]).length+(b.pazientiNascosti||[]).length, salute:(b.pazienti||[]).map(s=>Math.round(s)), visto:(b.visto||[]).slice(0,4), ok:v.ok});
      }
      return out;
    },
    psEliLista(){ return (D().OSPEDALI||[]).filter(o=>o.eli).map(o=>o.nome); },
    psEli(lat, lng){ const o = nearestOspedale(lat, lng, true); return o ? {nome:o.nome, km:Math.round(haversineKm(lat,lng,o.lat,o.lng)*10)/10} : null; },
    // stato di un mezzo (per i test): stato + destinazione + intervento
    statoMezzo(cod){ const m = mezzi.find(x=>x.codice===cod); return m ? {codice:m.codice, tipo:m.tipo, stato:m.stato, ospedale:m.ospedale||null, iv:m.interventoId} : null; },
    // punto su rete infrastrutturale vera (per i test): infraPunto("ELET") -> {lat,lng,luogo,etich,cat}
    infraPunto(spec){ return puntoSuInfra(spec); },
    // distanza km dalla rete vera più vicina (per i test): infraVicino(lat,lng,"ELET") -> km
    infraVicino(la, ln, spec){ const p = puntoSuInfraVicino(la, ln, spec, 50); return p ? {km: haversineKm(la, ln, p.lat, p.lng), luogo: p.luogo, etich: p.etich, cat: p.cat} : null; },
    // regola di stima iniziale per un tipo (pura, per i test): quanti noti/ignoti/verifiche
    // a verità N (noti+verifica deterministici dalla categoria, mai casuali)
    stimaPerN(nome, N, grande){
      const t = D().TIPI.find(x=>x.nome===nome);
      if(!t) return null;
      const st = stimaInizialePazienti(t, N, !!grande);
      return {tipo: t.nome, N, vvf: !!t.vvf, cat: pazCat(t.nome), noti: st.noti, ignoti: st.ignoti, verifica: st.verifica};
    },
    // stato della scoperta progressiva su una missione aperta (per i test)
    scopertaStato(id){
      const iv = interventi.find(x=>x.id===id);
      if(!iv) return null;
      return {id, comune: iv.comune, noti: (iv.pazienti||[]).length, nascosti: (iv.pazientiNascosti||[]).length, verifica: !!iv.pazDaVerificare, ignoti: !!iv.pazIgnoti, valutato: !!iv.valutato, daTrasportare: iv.daTrasportare||0, supportoALTRO: (iv.supporti&&iv.supporti.ALTRO&&iv.supporti.ALTRO.richiesti)||0};
    },
    // gestione avanzata MSA/MSI su una missione aperta (per i test): flag per paziente,
    // presa in carico effettiva per mezzo (mai doppia), coda in attesa dal più critico
    msaStato(id){
      const iv = interventi.find(x=>x.id===id);
      if(!iv) return null;
      const L = iv.pazienti||[];
      const per = [];
      for(let k=0;k<L.length;k++){
        if(L[k]==null) continue;
        per.push({idx:k, salute:Math.round(L[k]*10)/10, flag:!!(iv.pazMSA&&iv.pazMSA[k]), attivo:pazAttivo(iv,k), st:statoPaziente(iv,k), assegnatoA:msaAssegnatoA(iv,k), curaDa:(iv.curaDi?Object.keys(iv.curaDi).filter(c=>iv.curaDi[c]===k):[])});
      }
      const ass = {};
      for(const cod in (iv.msaDi||{})) ass[cod] = iv.msaDi[cod];
      return {id, comune:iv.comune, valutato:!!iv.valutato, attesaMSA:!!iv.attesaMSA, msaSulPosto:msaSulPosto(iv), richiestiMSA:(iv.supporti&&iv.supporti.MSA&&iv.supporti.MSA.richiesti)||0, pazienti:per, assegnazioni:ass, inAttesa:msaInAttesa(iv)};
    },
    // supporto test: imposta la salute di un paziente (3-99%, solo missioni aperte)
    debugForzaSalute(id,k,val){
      const iv = interventi.find(x=>x.id===id);
      if(!iv || iv.stato==="chiuso") return false;
      if((iv.pazienti||[])[k]==null) return false;
      iv.pazienti[k] = Math.max(3, Math.min(99, +val));
      if(iv.trasporto) iv.stabilizzato = !(iv.pazienti||[]).some((x,j)=>x!=null&&x<100&&pazAttivo(iv,j));
      renderListe();
      return true;
    },
    __dbg(){ return {cache: routeCache.size, roadPaths: mezzi.filter(m=>m.path&&m.path.length>2).map(m=>m.codice+":"+m.path.length)}; },
  };
})();
