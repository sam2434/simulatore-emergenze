/* =====================================================================
 * IA-CENTRALE — motore puro della centrale autonoma (niente I/O, niente
 * Deno, niente Supabase qui dentro: solo logica testabile).
 *
 * Uso (Edge Function):
 *   const out = iaTick({ aperte, stato, dati, now, cfg, rnd });
 *   // out.upsert  -> righe complete da scrivere su missioni_live
 *   // out.stato   -> nuovo stato da salvare su ia_stato (ultimo/prossimo spawn)
 *
 * Tempi in millisecondi (epoch). rnd() -> [0,1).
 * ===================================================================== */

function iaRndi(rnd, a, b){ return a + Math.floor(rnd() * (b - a + 1)); }
function iaPick(rnd, arr){ return arr[Math.floor(rnd() * arr.length)]; }

function iaCodiceDaSalute(worst){
  if(worst < 25) return "ROSSO";
  if(worst < 50) return "GIALLO";
  if(worst >= 80) return "BIANCO";
  return "VERDE";
}
function iaTriage(s){
  return s < 10 ? 1 : s < 50 ? 2 : 3;
}
function iaColoreTriage(t){
  return t === 1 ? "ROSSO" : t === 2 ? "GIALLO" : "VERDE";
}

function iaDistKm(la1, ln1, la2, ln2){
  const R = 6371, dLa = (la2 - la1) * Math.PI / 180, dLn = (ln2 - ln1) * Math.PI / 180;
  const a = Math.sin(dLa / 2) * Math.sin(dLa / 2) +
    Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) *
    Math.sin(dLn / 2) * Math.sin(dLn / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}

// comuni pesati, solo province servite dalla centrale autonoma
function iaScegliComune(dati, rnd){
  const pool = dati.comuni.filter(c => c.p === "VA" || c.p === "CO" || c.p === "LC");
  const src = pool.length ? pool : dati.comuni;
  let tot = 0;
  for(const c of src) tot += (c.w || 1);
  let x = rnd() * tot;
  for(const c of src){ x -= (c.w || 1); if(x <= 0) return c; }
  return src[src.length - 1];
}

function iaViaPer(comune, rnd, dati){
  const vie = (dati.vie && dati.vie[comune]) || null;
  if(vie && vie.length) return iaPick(rnd, vie);
  return iaPick(rnd, ["Via Roma", "Via Garibaldi", "Via Verdi", "Via Mazzini", "Via Volta", "Viale Libertà"]);
}

const IA_DESCR = {
  cardio: ["Uomo a terra incosciente, possibile arresto.", "Persona con forte dolore al petto e affanno."],
  neuro: ["Persona con emiparesi improvvisa, sospetto ictus.", "Anziano caduto, confuso e disorientato."],
  resp: ["Persona con grave difficoltà respiratoria.", "Crisi asmatica in bambino, genitori in allarme."],
  strada: ["Scontro tra due auto, conducenti incastrati.", "Auto fuori strada contro il guardrail, feriti a bordo.", "Investimento di pedone sulle strisce."],
  moto: ["Motociclista a terra dopo scivolata, casco danneggiato.", "Scontro moto-auto in incrocio."],
  bici: ["Ciclista caduto in discesa, trauma cranico.", "Bici contro auto in rotatoria."],
  caduta: ["Anziano caduto in casa, probabile frattura femore.", "Caduta da scala domestica."],
  medico: ["Malore in strada, passanti prestano soccorso.", "Persona con febbre alta e stato confusionale."],
  trauma: ["Infortunio con emorragia da attrezzo da lavoro.", "Ferita lacero-contusa, copiosa fuoriuscita di sangue."],
  incendio: ["Fumo denso dal vano scale, possibili intossicati.", "Incendio in appartamento al secondo piano.", "Rogo di sterpaglie vicino alle abitazioni."],
  aggr: ["Persona minacciosa in strada, passanti spaventati.", "Lite familiare degenerata, un ferito."],
  parto: ["Donna in travaglio a domicilio.", "Parto imminente in auto accostata."],
  acqua: ["Persona in difficoltà in acqua, bagnino in intervento.", "Imbarcazione in avaria con persone a bordo."],
  folgor: ["Persona folgorata da linea elettrica, cavi a terra.", "Incendio da corto circuito in garage."],
  crollo: ["Crollo di porzione di tetto, possibili sepolti.", "Muro di contenimento crollato sulla carreggiata."],
  lavoro: ["Operaio caduto da impalcatura in cantiere.", "Infortunio con macchinario agricolo."],
  api: ["Sciame d'api in giardino pubblico.", "Nido di vespe in cassonetto."],
  casa: ["Fuga di gas in cucina, occupanti evacuati.", "Allagamento da rottura tubatura, anziano solo in casa."],
  autol: ["Camion contro spartitraffico, gasolio in carreggiata.", "Autoarticolato di traverso, traffico bloccato."],
  morsi: ["Morso di cane randagio a passante.", "Bambino punto da insetto, reazione allergica."],
  tossAlim: ["Sospetta intossicazione alimentare in mensa.", "Bambino ha ingerito detersivo."],
  pesante: ["Scontro tra camion e auto, cabina deformata.", "Mezzo pesante ribaltato in rotatoria."],
  treno: ["Investimento sui binari in stazione.", "Malore a bordo treno fermo in stazione."],
  ped: ["Bambino con febbre alta e convulsioni.", "Neonato con difficoltà respiratorie."],
  bus: ["Tamponamento scuolabus, bambini spaventati.", "Malore passeggero su autobus di linea."],
  sport: ["Trauma distorsivo in campo da calcio.", "Ciclista caduto in gara amatoriale."],
  folla: ["Malori tra la folla all'evento pubblico.", "Ressa con contusi lievi al concerto."]
};

const IA_ESITI = {
  incendio: ["Incendio spento e area bonificata.", "Fiamme domate, locali ventilati e messi in sicurezza."],
  strada: ["Veicoli rimossi, carreggiata riaperta.", "Feriti affidati al PS, scena in sicurezza."],
  acqua: ["Persona tratta in salvo e affidata ai sanitari.", "Area transennata, ricerche concluse."],
  crollo: ["Area puntellata e messa in sicurezza.", "Verifiche concluse, nessun altro coinvolto."],
  lavoro: ["Infortunato stabilizzato e trasportato in PS.", "Cantiere in sicurezza, intervento concluso."]
};

const IA_RICERCA = ["ricerca persona", "persona dispersa", "persona scomparsa", "escursionista disperso"];

function iaTipoDisperso(){ return "Persona dispersa nei boschi"; }

function iaMezziLiberi(dati, aperte){
  const busy = {};
  for(const r of (aperte || [])){
    const mz = r.mezzi || r.MEZZI || [];
    const arr = Array.isArray(mz) ? mz : [];
    for(const v of arr) if(v && v.c) busy[v.c] = true;
  }
  return (dati.mezzi || []).filter(m => !busy[m.c]);
}

function iaSediVicine(dati, lat, lng, n){
  return (dati.sedi || []).map(s => ({
    s, km: iaDistKm(lat, lng, s.la, s.ln)
  })).sort((a, b) => a.km - b.km).slice(0, n || 4);
}

// Assegna mezzi reali (codici veri del simulatore) dalle sedi più vicine
function iaAssegnaMezzi(tipo, nPaz, worst, lat, lng, dati, aperte, rnd, maxi){
  const liberi = iaMezziLiberi(dati, aperte);
  const vicine = iaSediVicine(dati, lat, lng, 6);
  const nomiSedi = {};
  for(const v of vicine) nomiSedi[v.s.n] = true;
  const pool = liberi.filter(m => nomiSedi[m.s]);
  const scelti = [];
  const prendi = (tipoMezzo, maxN) => {
    let n = 0;
    for(const m of pool){
      if(n >= maxN) break;
      if(scelti.indexOf(m) >= 0) continue;
      if(m.t === tipoMezzo){ scelti.push(m); n++; }
    }
    return n;
  };
  const out = [];
  const push = (m, tr) => out.push({ c: m.c, n: m.c, t: m.t, tr: !!tr, s: "viaggio", tpaz: "" });
  if(maxi){
    prendi("MSB", Math.min(4, Math.max(2, nPaz)));
    if(!prendi("MSA", 1)) prendi("MSB", 1);
    if(rnd() < 0.4) prendi("ELI", 1);
    if(tipo.v) prendi("VVF", 2);
    for(const m of scelti) push(m, false);
    return out;
  }
  if(nPaz > 0){
    const nAmb = Math.min(nPaz, 3);
    let presi = prendi("MSB", nAmb);
    if(presi < nAmb) prendi("MSA", nAmb - presi); // MSA come ambulanza se mancano MSB
    if(worst < 35) prendi("MSA", 1);
    if(rnd() < 0.06 && worst < 25) prendi("ELI", 1);
    for(const m of scelti) push(m, false);
  }
  if(tipo.v){
    const prima = scelti.length;
    prendi("VVF", rnd() < 0.5 ? 1 : 2);
    if(scelti.length === prima){
      // nessuna VVF libera vicina: prendi la prima VVF libera ovunque
      for(const m of liberi){
        if(m.t === "VVF" && scelti.indexOf(m) < 0){ scelti.push(m); break; }
      }
    }
    for(let i = prima; i < scelti.length; i++) push(scelti[i], false);
  }
  if(!out.length){
    // ultima spiaggia: primo mezzo sanitario libero qualsiasi
    for(const m of liberi){
      if(m.t === "MSB" || m.t === "MSA"){ push(m, false); break; }
    }
  }
  return out;
}

function iaStatoMezzoIT(s){
  return { viaggio: "IN VIAGGIO", sul_posto: "SUL POSTO", pronto: "PRONTO", trasporto: "TRASPORTO", ospedale: "IN PS", rientro: "RIENTRO", disponibile: "LIBERO" }[s] || String(s || "?").toUpperCase();
}

function iaNuovaMissione(dati, now, rnd, aperte, cfg){
  const tipiAperti = {};
  for(const r of (aperte || [])) if(r.tipologia) tipiAperti[r.tipologia] = true;
  // maxi-emergenza rara (ricerca estesa o evento multi-feriti)
  const maxi = rnd() < (cfg.maxiProb != null ? cfg.maxiProb : 0.04);
  let tipo;
  if(maxi && rnd() < 0.5){
    tipo = { n: iaPick(rnd, IA_RICERCA), c: "ricerca", pz: 0, s: null, v: false, ricerca: true };
  }else{
    const cand = (dati.tipi || []).filter(t => !tipiAperti[t.n]);
    const pool = cand.length ? cand : (dati.tipi || []);
    if(!pool.length) return null;
    if(maxi){
      const grossi = pool.filter(t => (t.pz || 1) >= 3);
      tipo = iaPick(rnd, grossi.length ? grossi : pool);
    }else{
      tipo = iaPick(rnd, pool);
    }
  }
  const com = iaScegliComune(dati, rnd);
  const via = iaViaPer(com.n, rnd, dati);
  const lat = +(com.la + (rnd() - 0.5) * 0.008).toFixed(6);
  const lng = +(com.ln + (rnd() - 0.5) * 0.008).toFixed(6);
  const isRicerca = !!tipo.ricerca || /dispers|ricerca|scompars/i.test(tipo.n);
  let nPaz;
  if(maxi && !isRicerca) nPaz = iaRndi(rnd, 5, 10);
  else if(isRicerca) nPaz = 1;
  else if(tipo.pz === 0) nPaz = (rnd() < 0.3 && tipo.v) ? iaRndi(rnd, 1, 2) : 0;
  else if(tipo.pz === 1) nPaz = rnd() < 0.85 ? 1 : 2;
  else nPaz = Math.max(1, Math.min(tipo.pz, iaRndi(rnd, 1, tipo.pz + 1)));
  const range = tipo.s || [40, 85];
  const pazienti = [];
  for(let i = 0; i < nPaz; i++){
    const s = iaRndi(rnd, range[0], range[1]);
    pazienti.push({ s, t: iaTriage(s) });
  }
  pazienti.sort((a, b) => a.s - b.s);
  const worst = pazienti.length ? pazienti[0].s : 100;
  const codice = maxi ? "ROSSO" : (nPaz ? iaCodiceDaSalute(worst) : (tipo.v ? "VERDE" : "BIANCO"));
  const descrPool = IA_DESCR[tipo.c] || ["Segnalazione in verifica sul posto."];
  const mezzi = iaAssegnaMezzi(tipo, nPaz, worst, lat, lng, dati, aperte, rnd, maxi);
  const hh = String(new Date(now).getHours()).padStart(2, "0");
  const mm = String(new Date(now).getMinutes()).padStart(2, "0");
  const id = "IA-" + now.toString(36).toUpperCase() + "-" + iaRndi(rnd, 10, 99);
  return {
    missione_id: id,
    tipologia: tipo.n,
    descrizione: isRicerca
      ? "Ricerca persona in zona boschiva, squadre al lavoro con unità cinofile."
      : iaPick(rnd, descrPool),
    localita: via + " - " + com.n + " (" + com.p + ")",
    comune: com.n,
    provincia: com.p,
    lat, lng,
    num_pazienti: nPaz,
    pazienti,
    stato: "attiva",
    codice,
    mezzi,
    cronologia: [{ t: now, e: "🚨 " + hh + ":" + mm + " centrale IA: missione aperta (" + codice + "), inviati " + (mezzi.length ? mezzi.map(m => m.c).join(", ") : "in attesa di mezzi liberi") + "." }],
    origine: "ia",
    gestita_da: "ia",
    pubblica: true,
    ia_fase: "inviati",
    ia_scade: now + iaRndi(rnd, 8, 15) * 60000,
    maxi: !!maxi
  };
}

function iaEvolvi(r, now, rnd, dati, aperte){
  const ev = [];
  const fase = r.ia_fase || "inviati";
  const crono = Array.isArray(r.cronologia) ? r.cronologia.slice() : [];
  const mezzi = (Array.isArray(r.mezzi) ? r.mezzi : []).map(m => Object.assign({}, m));
  const isRicerca = /dispers|ricerca|scompars/i.test(r.tipologia || "");
  const hh = String(new Date(now).getHours()).padStart(2, "0");
  const mm = String(new Date(now).getMinutes()).padStart(2, "0");
  const push = (e) => { crono.push({ t: now, e: "🕐 " + hh + ":" + mm + " " + e }); ev.push(e); };
  let chiudi = false, esito = "";

  if(fase === "inviati"){
    for(const m of mezzi) if(m.s === "viaggio") m.s = "sul_posto";
    r.stato = "in_corso";
    push("prime squadre sul posto, inizia la " + (isRicerca ? "perlustrazione a settori" : "valutazione dello scenario") + ".");
    r.ia_fase = "lavoro";
    r.ia_scade = now + iaRndi(rnd, 10, 20) * 60000;
  }else if(fase === "lavoro"){
    if(isRicerca){
      const settore = iaRndi(rnd, 1, 6);
      if(rnd() < 0.3){
        // ritrovamento: chiude con esito coerente
        push("persona ritrovata nel settore " + settore + ", in buone condizioni: affidata ai sanitari per controlli.");
        chiudi = true; esito = "Persona ritrovata e affidata ai sanitari.";
      }else{
        push("perlustrazione settore " + settore + " senza esito, si allarga l'area di ricerca.");
        if(rnd() < 0.35){
          // rinforzi: un mezzo libero in più
          const liberi = iaMezziLiberi(dati, aperte).filter(m => mezzi.every(x => x.c !== m.c));
          const rinforzo = liberi.find(m => m.t === "VVF") || liberi.find(m => m.t === "MSB") || liberi[0];
          if(rinforzo){
            mezzi.push({ c: rinforzo.c, n: rinforzo.c, t: rinforzo.t, tr: false, s: "viaggio", tpaz: "" });
            push("richiesti rinforzi: inviato " + rinforzo.c + ".");
          }
        }
        r.ia_scade = now + iaRndi(rnd, 12, 22) * 60000;
      }
    }else if((r.pazienti || []).length > 0){
      // pazienti a bordo: i mezzi sanitari vanno in trasporto col codice paziente
      const paz = r.pazienti;
      let k = 0;
      for(const m of mezzi){
        if((m.t === "MSB" || m.t === "MSA" || m.t === "ELI") && m.s !== "trasporto" && k < paz.length){
          m.s = "trasporto"; m.tr = true;
          m.tpaz = iaColoreTriage(paz[k].t);
          k++;
        }
      }
      push("pazienti stabilizzati e caricati (" + k + " in trasporto verso il PS).");
      r.ia_fase = "chiusura";
      r.ia_scade = now + iaRndi(rnd, 15, 30) * 60000;
    }else{
      // solo VVF/tecnico: evoluzione scenario poi chiusura
      const pool = IA_ESITI[r.tipologia && /incendio|fiamme|rogo/i.test(r.tipologia) ? "incendio" : "strada"] || null;
      push(iaPick(rnd, ["lavoro in corso, scenario sotto controllo.", "bonifica in corso, nessun altro coinvolto."]));
      r.ia_fase = "chiusura";
      r.ia_scade = now + iaRndi(rnd, 12, 25) * 60000;
      if(pool && rnd() < 0.5){ push(pool[0]); chiudi = true; esito = pool[0]; }
    }
  }else{
    // fase chiusura (o ignota): esito finale
    chiudi = true;
  }

  if(chiudi){
    if(!esito){
      if((r.pazienti || []).length > 0) esito = "Pazienti consegnati al PS, intervento concluso.";
      else if(/incendio|fiamme|rogo/i.test(r.tipologia || "")) esito = iaPick(rnd, IA_ESITI.incendio);
      else if(isRicerca) esito = "Ricerca conclusa.";
      else esito = "Intervento concluso, scena in sicurezza.";
    }
    push("✅ " + esito);
    for(const m of mezzi) m.s = "rientro"; // a missione chiusa tutti rientrano
    r.stato = "chiusa";
    r.chiusa_il = now;
    r.ia_fase = "conclusa";
  }
  // storico limitato alle ultime 100 voci
  r.cronologia = crono.slice(-100);
  r.mezzi = mezzi;
  return { row: r, eventi: ev, chiusa: chiudi };
}

function iaTick(input){
  const dati = input.dati, now = input.now, rnd = input.rnd || Math.random;
  const cfg = Object.assign({ minMinuti: 25, maxMinuti: 35, maxAperte: 5, maxiProb: 0.04 }, input.cfg || {});
  const statoIn = input.stato || {};
  const aperte = (input.aperte || []).map(r => Object.assign({}, r));
  const upsert = [];
  // 1) evoluzione missioni aperte scadute (solo quelle gestite dall'IA)
  for(const r of aperte){
    if(r.gestita_da && r.gestita_da !== "ia") continue; // presa in carico dal simulatore
    if(r.stato === "chiusa" || r.stato === "annullata") continue;
    if((r.ia_scade || 0) <= now){
      const out = iaEvolvi(r, now, rnd, dati, aperte);
      upsert.push(out.row);
    }
  }
  // 2) nuova chiamata se è ora (~1 ogni 30 min) e c'è posto
  let prossimo = statoIn.prossimo_spawn;
  if(prossimo == null) prossimo = now + iaRndi(rnd, cfg.minMinuti, cfg.maxMinuti) * 60000;
  let ultimo = statoIn.ultimo_spawn || null;
  if(now >= prossimo){
    const nAperte = aperte.filter(r => r.stato === "attiva" || r.stato === "in_corso").length;
    const tipiAperti = {};
    for(const r of aperte) if(r.tipologia) tipiAperti[r.tipologia] = true;
    const disp = (dati.tipi || []).filter(t => !tipiAperti[t.n]).length;
    if(nAperte < cfg.maxAperte && disp > 0){
      const nuova = iaNuovaMissione(dati, now, rnd, aperte, cfg);
      if(nuova) upsert.push(nuova);
      ultimo = now;
    }
    // anche se salta (troppe aperte), riprogramma: niente accumulo di arretrati
    prossimo = now + iaRndi(rnd, cfg.minMinuti, cfg.maxMinuti) * 60000;
  }
  return { upsert, stato: { ultimo_spawn: ultimo, prossimo_spawn: prossimo } };
}

export { iaTick, iaNuovaMissione, iaEvolvi, iaCodiceDaSalute, iaTriage, iaColoreTriage, iaAssegnaMezzi };
