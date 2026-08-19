/*
 * OTTIMIZZATORE D'ASTA — algoritmo di "prezzo consigliato" (value over replacement)
 * ==================================================================================
 *
 * ATTENZIONE: questa e' una COPIA usata dal sito (caricata da asta.html). La
 * versione originale, quella da leggere e modificare, e' in
 * FANTA_AI/Optimizer/prezzo_consigliato.js — dopo ogni modifica li', ricopiarla
 * anche qui prima di pubblicare (il sito e' un repository git separato).
 *
 * IDEA DI BASE
 * ------------
 * Non esiste un "prezzo giusto" assoluto per un giocatore: dipende da quanto e'
 * migliore rispetto all'alternativa che troveresti comunque gratis (o quasi) sul
 * mercato. Questo e' il principio "Value Over Replacement" (VOR), lo stesso usato
 * nei calcolatori d'asta fantasy sportivi seri (es. fantasy football americano).
 *
 * In 4 passi:
 *
 *  1) VALORE ATTESO di ogni giocatore = quanti punti fantacalcio produrra' in
 *     stagione secondo il nostro modello AI: media_fantavoto_prevista x presenze_previste.
 *     (arriva gia' calcolato da chi chiama questo file — vedi INPUT sotto)
 *
 *  2) LIVELLO DI RIMPIAZZO per ruolo = il valore atteso dell'ultimo giocatore che
 *     una squadra sarebbe comunque costretta a schierare come titolare in quel
 *     ruolo, a livello dell'intera lega. Es: 8 squadre x 8 centrocampisti a testa
 *     = il 64esimo centrocampista per valore atteso e' "quello che prendi comunque,
 *     anche gratis, perche' devi riempire la rosa". Tutti i centrocampisti sotto
 *     quel livello non valgono nulla di piu' del minimo; quelli sopra si, in
 *     proporzione a quanto lo superano.
 *
 *  3) VOR di ogni giocatore = max(0, valore_atteso - livello_di_rimpiazzo_del_suo_ruolo)
 *
 *  4) PREZZO = il budget di mercato ancora disponibile in tutta la lega (crediti
 *     rimasti a tutte le squadre, meno una riserva di 1 credito per ogni slot di
 *     rosa ancora da riempire — altrimenti nessuno potrebbe completare la squadra)
 *     viene prima SPEZZATO in 4 fette secondo le percentuali per ruolo scelte
 *     dall'utente (es. 40% agli attaccanti), poi ogni fetta viene distribuita ai
 *     giocatori di quel ruolo in proporzione al VOR: chi ha il doppio del VOR si
 *     merita il doppio del budget "di lusso" della fetta del suo ruolo, oltre al
 *     credito minimo di base.
 *
 * Si ricalcola da zero ogni volta che qualcosa cambia (un giocatore viene comprato,
 * il budget o la composizione rosa cambiano, entra/esce un avversario) — per questo
 * e' una funzione pura: stesso input, stesso output, nessuno stato nascosto.
 *
 *
 * I "PESI" DELL'ALGORITMO
 * ------------------------
 * A differenza dei modelli di previsione (Gradient Boosting / Bayesiano gerarchico,
 * che hanno centinaia di pesi imparati dai dati), questo e' un algoritmo di
 * allocazione economica: non "impara" pesi, applica una formula matematica diretta.
 * Due cose sono regolabili dall'esterno:
 *  - `percentualiBudget` (parametro di input, sezione "Pesi per ruolo" del sito):
 *    quanto del budget di lega va a ciascun reparto.
 *  - la costante qui sotto.
 */
const RISERVA_CREDITI_PER_SLOT_LIBERO = 1;
/*
 * Quanti crediti si mettono sempre da parte per ogni slot di rosa ancora vuoto
 * (nel fantacalcio reale, all'asta il prezzo minimo per un giocatore e' sempre 1
 * credito). Aumentarlo renderebbe l'ottimizzatore piu' "prudente" (distribuisce
 * meno budget ai big, tenendone di riserva per il resto della rosa); diminuirlo
 * (es. a 0, teoricamente) spingerebbe piu' budget sui migliori giocatori.
 * Con 1 si replica esattamente la regola reale del fantacalcio, quindi non c'e'
 * motivo per cambiarlo a meno di regole di lega diverse.
 */


/**
 * Calcola il prezzo consigliato per ogni giocatore ancora libero.
 *
 * @param {Object} input
 * @param {Array<{id: string, ruolo: 'P'|'D'|'C'|'A', valoreAtteso: number|null, fvm: number}>} input.liberi
 *        Giocatori ancora sul mercato. valoreAtteso e' gia' calcolato da chi chiama
 *        (media_fantavoto_prevista x presenze_previste dalle previsioni AI), oppure
 *        null se il giocatore non e' stato abbinato a nessuna previsione (in quel
 *        caso si usa l'fvm ufficiale come unica base, con un prezzo minimo).
 * @param {number} input.teamBudget - Crediti che ogni squadra riceve a inizio asta.
 * @param {number} input.numSquadre - Numero di squadre partecipanti (inclusa la propria).
 * @param {{P: number, D: number, C: number, A: number}} input.composizioneRosa
 *        Quanti giocatori di ogni ruolo prende OGNI squadra (es. {P:3,D:8,C:8,A:6}).
 * @param {{[squadra: string]: number}} input.creditiSpesiPerSquadra
 *        Quanto ha speso finora ogni squadra (nomi coerenti con quelli usati altrove).
 * @param {{[squadra: string]: number}} input.slotOccupatiPerSquadra
 *        Quanti giocatori ha gia' preso ogni squadra (qualsiasi ruolo).
 * @param {{P: number, D: number, C: number, A: number}} [input.percentualiBudget]
 *        Quanto del budget di mercato destinare a ciascun ruolo (non serve che
 *        sommino a 100: vengono normalizzate qui dentro). Se omesso, 25% a testa.
 *
 * @returns {{
 *   prezzi: Map<string, number>,               // id giocatore -> prezzo consigliato
 *   diagnostica: {
 *     livelloRimpiazzo: {P:number,D:number,C:number,A:number},
 *     budgetDistribuibile: number,
 *     budgetPerRuolo: {P:number,D:number,C:number,A:number},
 *     prezzoMassimoPagabile: number,
 *   }
 * }}
 */
function calcolaPrezziConsigliati({ liberi, teamBudget, numSquadre, composizioneRosa, creditiSpesiPerSquadra, slotOccupatiPerSquadra, percentualiBudget }) {
  numSquadre = Math.max(numSquadre, 1);
  const slotTotaliPerSquadra = composizioneRosa.P + composizioneRosa.D + composizioneRosa.C + composizioneRosa.A;

  // --- passo 4a: quanto budget di mercato resta ancora da distribuire in tutta la lega ---
  let creditiResiduiTotali = 0;
  let slotLiberiTotali = 0;
  Object.keys(creditiSpesiPerSquadra || {}).length; // (nessuna azione: solo per chiarezza che le due mappe vanno lette insieme)
  const squadre = new Set([...Object.keys(creditiSpesiPerSquadra || {}), ...Object.keys(slotOccupatiPerSquadra || {})]);
  if (squadre.size === 0) {
    // nessuna squadra tracciata ancora: assume tutte le squadre intatte
    creditiResiduiTotali = teamBudget * numSquadre;
    slotLiberiTotali = slotTotaliPerSquadra * numSquadre;
  } else {
    squadre.forEach(nome => {
      const speso = creditiSpesiPerSquadra[nome] || 0;
      const occupati = slotOccupatiPerSquadra[nome] || 0;
      creditiResiduiTotali += Math.max(0, teamBudget - speso);
      slotLiberiTotali += Math.max(0, slotTotaliPerSquadra - occupati);
    });
  }
  const budgetDistribuibile = Math.max(0, creditiResiduiTotali - slotLiberiTotali * RISERVA_CREDITI_PER_SLOT_LIBERO);

  // nessun prezzo puo' superare quanto una squadra potrebbe mai pagare per UN SOLO
  // giocatore: tutto il proprio budget, meno la riserva minima per ogni altro slot
  const prezzoMassimoPagabile = Math.max(1, teamBudget - (slotTotaliPerSquadra - 1) * RISERVA_CREDITI_PER_SLOT_LIBERO);

  // --- fetta di budget per ruolo: normalizza le percentuali (non serve che sommino a 100) ---
  const pct = Object.assign({ P: 25, D: 25, C: 25, A: 25 }, percentualiBudget || {});
  const sommaPct = ['P', 'D', 'C', 'A'].reduce((s, r) => s + Math.max(0, pct[r] || 0), 0);
  const budgetPerRuolo = {};
  ['P', 'D', 'C', 'A'].forEach(ruolo => {
    const quota = sommaPct > 0 ? Math.max(0, pct[ruolo] || 0) / sommaPct : 0.25;
    budgetPerRuolo[ruolo] = budgetDistribuibile * quota;
  });

  // --- passo 2: livello di rimpiazzo per ruolo ---
  const livelloRimpiazzo = {};
  ['P', 'D', 'C', 'A'].forEach(ruolo => {
    const valori = liberi
      .filter(g => g.ruolo === ruolo && g.valoreAtteso !== null && g.valoreAtteso !== undefined)
      .map(g => g.valoreAtteso)
      .sort((a, b) => b - a);
    const slotRuoloInLega = (composizioneRosa[ruolo] || 0) * numSquadre;
    livelloRimpiazzo[ruolo] = valori.length
      ? (valori[Math.min(slotRuoloInLega, valori.length) - 1] ?? valori[valori.length - 1])
      : 0;
  });

  // --- passo 3: VOR di ogni giocatore, sommato PER RUOLO (ogni ruolo si spartisce solo la propria fetta) ---
  const sumVORPerRuolo = { P: 0, D: 0, C: 0, A: 0 };
  const vor = new Map();
  liberi.forEach(g => {
    if (g.valoreAtteso === null || g.valoreAtteso === undefined) return;
    const v = Math.max(0, g.valoreAtteso - livelloRimpiazzo[g.ruolo]);
    vor.set(g.id, v);
    sumVORPerRuolo[g.ruolo] = (sumVORPerRuolo[g.ruolo] || 0) + v;
  });

  // --- passo 4b: prezzo finale, proporzionale al VOR dentro la fetta di budget del proprio ruolo ---
  const prezzi = new Map();
  liberi.forEach(g => {
    let prezzo;
    const v = vor.get(g.id);
    const sumVORRuolo = sumVORPerRuolo[g.ruolo];
    if (v !== undefined && sumVORRuolo > 0) {
      prezzo = RISERVA_CREDITI_PER_SLOT_LIBERO + Math.round(budgetPerRuolo[g.ruolo] * v / sumVORRuolo);
    } else {
      // nessun abbinamento a una previsione AI: riserva minima, base solo sull'FVM ufficiale
      prezzo = Math.max(RISERVA_CREDITI_PER_SLOT_LIBERO, Math.round(g.fvm || RISERVA_CREDITI_PER_SLOT_LIBERO));
    }
    prezzi.set(g.id, Math.min(prezzo, prezzoMassimoPagabile));
  });

  return { prezzi, diagnostica: { livelloRimpiazzo, budgetDistribuibile, budgetPerRuolo, prezzoMassimoPagabile } };
}

// esposto come global (nessun sistema di moduli sul sito, per coerenza col resto del codice)
window.FantaAIOptimizer = { calcolaPrezziConsigliati, RISERVA_CREDITI_PER_SLOT_LIBERO };
