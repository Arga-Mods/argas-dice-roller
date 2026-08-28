/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright (C) 2026 Arga-Mods */

const DRAMATIC_SUITS = [
  { key: "spades", symbol: "♠", order: 4 },
  { key: "hearts", symbol: "♥", order: 3 },
  { key: "diamonds", symbol: "♦", order: 2 },
  { key: "clubs", symbol: "♣", order: 1 },
];

const DRAMATIC_RANKS = [
  { key: "2", label: "2", value: 2 },
  { key: "3", label: "3", value: 3 },
  { key: "4", label: "4", value: 4 },
  { key: "5", label: "5", value: 5 },
  { key: "6", label: "6", value: 6 },
  { key: "7", label: "7", value: 7 },
  { key: "8", label: "8", value: 8 },
  { key: "9", label: "9", value: 9 },
  { key: "10", label: "10", value: 10 },
  { key: "J", label: "J", value: 11 },
  { key: "Q", label: "Q", value: 12 },
  { key: "K", label: "K", value: 13 },
  { key: "A", label: "A", value: 14 },
];

function _shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function _buildDeck() {
  const deck = [];
  for (const suit of DRAMATIC_SUITS) {
    for (const rank of DRAMATIC_RANKS) {
      deck.push({
        id: `${rank.key}-${suit.key}`,
        rank: rank.key,
        rankLabel: rank.label,
        suit: suit.key,
        suitSymbol: suit.symbol,
        shortLabel: `${rank.label}${suit.symbol}`,
        isJoker: false,
        isComplication: suit.key === "clubs",
        modifier: suit.key === "clubs" ? -2 : 0,
        sortValue: rank.value * 10 + suit.order,
      });
    }
  }

  deck.push({
    id: "joker-red",
    rank: "joker",
    rankLabel: "Joker",
    suit: "joker-red",
    suitSymbol: "🃏",
    shortLabel: "🃏",
    isJoker: true,
    isComplication: false,
    modifier: 2,
    sortValue: 1001,
  });

  deck.push({
    id: "joker-black",
    rank: "joker",
    rankLabel: "Joker",
    suit: "joker-black",
    suitSymbol: "🃏",
    shortLabel: "🃏",
    isJoker: true,
    isComplication: false,
    modifier: 2,
    sortValue: 1000,
  });

  return deck;
}

function _createRoundState(card, round) {
  return {
    round,
    card,
    acted: false,
    skipped: false,
    result: null,
    diceDetails: null,
    bennyUsed: false,
    normalMarkersDelta: 0,
    markersDelta: null,
    needsFumbleCheck: false,
    pendingFumbleCheck: false,
    fumbleCheckResult: undefined,
    fumbleCheckDie: undefined,
    wasFumble: false,
    complicationFailure: false,
  };
}

function _getResolvedRoundState(entry) {
  const rs = entry?.roundState;
  if (!rs) return null;
  if (rs.skipped) return rs;
  if (!rs.acted) return null;
  if (rs.pendingFumbleCheck) return null;
  return rs;
}

function _collectRoundActions(entries, round) {
  const actions = [];
  for (const entry of entries ?? []) {
    for (const hist of entry.history ?? []) {
      if (hist?.round === round) actions.push(hist);
    }
    const rs = _getResolvedRoundState(entry);
    if (rs?.round === round) actions.push(rs);
  }
  return actions.sort((a, b) => (b.card?.sortValue ?? 0) - (a.card?.sortValue ?? 0));
}

/**
 * Zieht N Karten vom Deck. Ist das Deck leer oder reicht es nicht,
 * wird kommentarlos ein frisches Deck nachgelegt — allerdings OHNE die in
 * diesem Zug bereits ausgeteilten Karten, damit dieselbe Karte nicht
 * zweimal in derselben Runde erscheinen kann (mit einem physischen Deck
 * wäre das unmöglich).
 * Mutiert den übergebenen deck-Array (pop von oben), gibt gezogene Karten zurück.
 */
function _drawFromDeck(deck, count) {
  const drawn = [];
  for (let i = 0; i < count; i++) {
    if (!deck.length) {
      const dealtIds = new Set(drawn.map(c => c.id));
      const fresh = _shuffle(_buildDeck().filter(c => !dealtIds.has(c.id)));
      deck.push(...fresh);
    }
    drawn.push(deck.pop());
  }
  return drawn;
}

export function dealDramaticRound(entries, round = 1, deck = null) {
  // Kein Deck übergeben (alte Aufrufe) → frisch mischen, wie bisher.
  const workingDeck = Array.isArray(deck) ? deck : _shuffle(_buildDeck());
  const cards = _drawFromDeck(workingDeck, (entries ?? []).length);
  return (entries ?? []).map((entry, index) => ({
    ...entry,
    history: Array.isArray(entry.history) ? entry.history : [],
    roundState: _createRoundState(cards[index], round),
  }));
}

export function advanceDramaticRound(entries, nextRound, deck = null) {
  const cloned = foundry.utils.deepClone(entries ?? []);
  // SWADE-Regel: Wurde in der soeben abgeschlossenen Runde ein Joker
  // ausgeteilt, wird das Deck vor der nächsten Runde komplett neu gemischt.
  // (In-place, weil der Aufrufer dieselbe Array-Referenz persistiert.)
  if (Array.isArray(deck) && cloned.some(e => e.roundState?.card?.isJoker)) {
    deck.length = 0;
    deck.push(..._shuffle(_buildDeck()));
  }
  const prepared = cloned.map(entry => {
    const history = Array.isArray(entry.history) ? entry.history : [];
    if (entry.roundState) history.push(foundry.utils.deepClone(entry.roundState));
    entry.history = history;
    delete entry.roundState;
    return entry;
  });
  return dealDramaticRound(prepared, nextRound, deck);
}

/**
 * Erzeugt und mischt ein frisches Deck. Wird beim Start einer
 * dramatischen Aufgabe aufgerufen und persistent in den flags abgelegt.
 */
export function createShuffledDeck() {
  return _shuffle(_buildDeck());
}

export function calculateDramaticTaskState(flags) {
  const entries = flags?.entries ?? [];
  const currentRound = Number(flags?.currentRound ?? 1);
  const roundsTotal = Number(flags?.roundsTotal ?? 1);
  const targetMarkers = Number(flags?.targetMarkers ?? 1);

  let totalMarkers = 0;
  let success = false;
  let pendingOutcome = null;

  for (let round = 1; round <= currentRound; round++) {
    const actions = _collectRoundActions(entries, round);
    for (const action of actions) {
      const delta = Number(action?.markersDelta ?? 0);
      if (delta) totalMarkers = Math.max(0, totalMarkers + delta);
      if (action?.complicationFailure) {
        pendingOutcome = "complicationFailure";
        return {
          totalMarkers,
          success: false,
          pendingOutcome,
          allCurrentRoundResolved: false,
        };
      }
      if (totalMarkers >= targetMarkers) {
        success = true;
        return {
          totalMarkers,
          success,
          pendingOutcome: null,
          allCurrentRoundResolved: false,
        };
      }
    }
  }

  // Ein ausstehender Patzer-Check (W6-Prüfung) blockiert den Rundenwechsel
  // bewusst NICHT — der GM entscheidet selbst, ob er die Prüfung durchführt.
  // Bei Wildcards mit Wild Die ist das Ergebnis ohnehin sofort eindeutig
  // (beide 1 = bestätigter Patzer, sonst kein Patzer); pendingFumbleCheck
  // tritt fast nur bei Einzelwürfeln auf (typischerweise NSCs).
  const allCurrentRoundResolved = (entries ?? []).every(entry => {
    const rs = entry?.roundState;
    if (!rs) return true;
    if (rs.round !== currentRound) return true;
    if (rs.skipped) return true;
    if (!rs.acted) return false;
    return true;
  });

  if (!success && allCurrentRoundResolved) {
    pendingOutcome = currentRound >= roundsTotal ? "roundFailure" : "readyNextRound";
  }

  return {
    totalMarkers,
    success,
    pendingOutcome,
    allCurrentRoundResolved,
  };
}
