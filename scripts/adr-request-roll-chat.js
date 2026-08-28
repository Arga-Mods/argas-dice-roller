/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright (C) 2026 Arga-Mods */

import { ADR } from "./adr-constants.js";
import { calculateDramaticTaskState, advanceDramaticRound, dealDramaticRound, createShuffledDeck } from "./adr-dramatic-task.js";
import { SupportDialogForm } from "./adr-support-dialog-form.js";
import { ChangeTraitDialogForm } from "./adr-change-trait-dialog-form.js";
import { UNTRAINED_SKILL_NAMES } from "./adr-request-roll-form.js";
import {
  requestRollSubject,
  subjectBennies,
  subjectSpendBenny,
  subjectRefundBenny,
  requireActiveGM,
} from "./adr-benny-helpers.js";

/**
 * adr-request-roll-chat.js
 *
 * Behandelt Klicks auf "Würfeln"- und "Benny"-Buttons in Probenanforderungs-Nachrichten.
 * Stellt den Hook `argas-dice-roller:onTraitRoll` bereit.
 */

/** Actor über ID auflösen — PCs via game.actors, NPCs via Canvas-Token. */
export function _resolveActor(actorId) {
  return game.actors.get(actorId) ?? canvas.scene?.tokens.get(actorId)?.actor ?? null;
}

/* ================================================================ */
/*  Hilfsfunktion: Ergebnis-HTML mit Erfolgsstufen                   */
/* ================================================================ */

function _buildResultHTML(result, isFumble = false, pending = false) {
  const val = Number(result);
  if (pending) {
    return `<span class="adr-result-pending">${game.i18n.localize(`${ADR.ID}.requestRoll.dramaticNoSuccess`)}</span>`;
  }
  if (isFumble) {
    return `<span class="adr-result-value adr-result-fumble">${val}</span>`;
  }
  let cssClass, raises = "";
  if (val < 4) {
    cssClass = "adr-result-fail";
  } else if (val < 8) {
    cssClass = "adr-result-success";
    raises = '<span class="adr-result-raises">✓</span>';
  } else {
    cssClass = "adr-result-success";
    raises = '<span class="adr-result-raises">✓<br>✓</span>';
  }
  return `<span class="adr-result-value ${cssClass}">${val}</span>${raises}`;
}

/* ================================================================ */
/*  Hilfsfunktion: Einzelergebnisse aus Roll-Objekt extrahieren      */
/* ================================================================ */

export function _extractDiceDetails(roll) {
  if (!roll?.dice?.length) return null;
  const details = { main: [], wild: [], appliedModifier: 0 };

  // SWADE Wildcard-Rolls: letzter Würfel ist Wild Die (d6),
  // davor der Trait Die. Extras haben nur 1 Würfel.
  const dice = roll.dice;
  for (let i = 0; i < dice.length; i++) {
    const isWild = dice.length > 1 && i === dice.length - 1;
    const target = isWild ? details.wild : details.main;
    for (const r of dice[i].results) {
      target.push({ value: r.result, exploded: !!r.exploded, faces: dice[i].faces });
    }
  }

  // Tatsächlich angewandter Modifikator (nach SWADE-Dialog des Spielers).
  // SWADE: Trait-Wurf nimmt den höheren von Trait-Die und Wild-Die,
  // dann werden numerische Modifikatoren addiert. Wir rechnen den Modifier
  // rückwärts aus dem Roll-Total und dem höchsten Würfel-Total.
  const totalRaw = Number(roll.total);
  const total = Number.isFinite(totalRaw) ? totalRaw : 0;
  let bestDie;
  if (dice.length === 1) {
    const d0 = Number(dice[0].total);
    bestDie = Number.isFinite(d0) ? d0 : 0;
  } else {
    const d0 = Number(dice[0].total);
    const dN = Number(dice[dice.length - 1].total);
    bestDie = Math.max(
      Number.isFinite(d0) ? d0 : 0,
      Number.isFinite(dN) ? dN : 0
    );
  }
  details.appliedModifier = total - bestDie;
  if (!Number.isFinite(details.appliedModifier)) details.appliedModifier = 0;

  return details;
}

/**
 * Ersten Wert jeder Würfelkette extrahieren (vor Explosion).
 */
function _getFirstDiceValues(arr) {
  const firsts = [];
  let isStart = true;
  for (const d of arr) {
    if (isStart) firsts.push(d.value);
    isStart = !d.exploded;
  }
  return firsts;
}

/**
 * Patzer-Klassifizierung:
 * - "none":       Kein Patzer möglich
 * - "confirmed":  Automatisch bestätigter Patzer (SC Wildcard-Regeln)
 * - "needs-check": GM muss mit W6 prüfen (Nicht-SC, einzelner Würfel = 1)
 *
 * Spielercharaktere (isNPC=false):
 *   – Ohne Wild Die → kein Patzer möglich (kein Eigenschaftswurf)
 *   – Mit Wild Die  → Wildcard-Regeln (Wild Die = 1 UND > Hälfte = 1)
 *
 * Nicht-SC (isNPC=true):
 *   – Nur bei exakt einem Würfel mit Ergebnis 1 → GM-Prüfung nötig
 *   – Mehrere Würfel → kein Patzer möglich
 */
/**
 * Prüft, ob der Benny-Button für einen Entry gesperrt sein muss (= "kein Reroll
 * nach Patzer"-Hausregel). Berücksichtigt sowohl den aktuell geltenden Wurf als
 * auch den zuletzt verworfenen Reroll, falls der Schutz aktiv war.
 *
 * Hintergrund: Wenn ein Benny-Reroll einen bestätigten Patzer ergibt UND der
 * alte Wurf besser war, greift der Verschlechterungsschutz — der alte gute
 * Wurf bleibt geltend, aber der Spieler HAT einen Patzer geworfen. Nach
 * Hausregel ist damit kein weiterer Benny-Reroll auf diesen Wurf erlaubt.
 *
 * @param {object} entry – {diceDetails, isNPC, fumbleCheckResult, lastRerollProtected, previousRolls}
 * @returns {boolean}
 */
function _isEntryBennyLocked(entry) {
  if (!entry) return false;
  // 1) Aktuell geltender Wurf ist bestätigter Patzer
  if (entry.fumbleCheckResult === true) return true;
  if (_classifyFumble(entry.diceDetails, entry.isNPC) === "confirmed") return true;
  // 2) Zuletzt verworfener Reroll (Schutz-Pfad) war bestätigter Patzer
  if (entry.lastRerollProtected && Array.isArray(entry.previousRolls) && entry.previousRolls.length > 0) {
    const last = entry.previousRolls[entry.previousRolls.length - 1];
    if (last?.fumbleCheckResult === true) return true;
    if (last?.diceDetails && _classifyFumble(last.diceDetails, entry.isNPC) === "confirmed") return true;
  }
  return false;
}

export function _classifyFumble(diceDetails, isNPC) {
  if (!diceDetails) return "none";

  const mainFirsts = _getFirstDiceValues(diceDetails.main);
  const wildFirsts = _getFirstDiceValues(diceDetails.wild);
  const hasWild = wildFirsts.length > 0;

  if (!isNPC) {
    // Spielercharakter: Patzer nur mit Wild Die möglich
    if (!hasWild) return "none";
    const allFirsts = [...mainFirsts, ...wildFirsts];
    const totalDice = allFirsts.length;
    const onesCount = allFirsts.filter(v => v === 1).length;
    return (wildFirsts[0] === 1 && onesCount > totalDice / 2) ? "confirmed" : "none";
  } else {
    // Nicht-SC: Patzer nur bei einzelnem Würfel mit Ergebnis 1
    if (hasWild) return "none";
    if (mainFirsts.length !== 1) return "none";
    return mainFirsts[0] === 1 ? "needs-check" : "none";
  }
}

/**
 * Einzelergebnisse als HTML rendern (gleicher Stil wie Hauptmodul).
 */
function _appliedModifierParts(appliedMod) {
  // Robuste Number-Konvertierung: NaN, undefined, null, leere Strings → 0
  const raw = Number(appliedMod);
  const m = Number.isFinite(raw) ? raw : 0;
  if (m === 0) return { str: "\u00b10", cls: "adr-applied-mod-zero" };
  if (m > 0)   return { str: `+${m}`, cls: "adr-applied-mod-pos" };
  return { str: `\u2212${Math.abs(m)}`, cls: "adr-applied-mod-neg" };
}

function _buildAppliedModifierHTML(appliedMod, short = false) {
  const { str, cls } = _appliedModifierParts(appliedMod);
  if (short) {
    // Kurzform für Gruppenprobe und Dramatische Aufgabe: "Mod. +2" (ohne Doppelpunkt).
    const labelShort = game.i18n.localize(`${ADR.ID}.individualResults.appliedModifierLabelShort`);
    return ` <span class="adr-applied-mod">(${labelShort} <span class="${cls}">${str}</span>)</span>`;
  }
  const label = game.i18n.localize(`${ADR.ID}.individualResults.appliedModifierLabel`);
  return ` <span class="adr-applied-mod">(${label}: <span class="${cls}">${str}</span>)</span>`;
}

/* ================================================================ */
/*  Konsolidierte Einzelergebnis-Darstellung                         */
/* ================================================================ */

/**
 * Rendert ein Array von Würfel-Einzelwerten (Format aus `_extractDiceDetails`)
 * als HTML-Span-Liste mit Exploding-Chains und min/max-Highlight-Klassen.
 *
 * Eingabe: `[{ value, exploded, faces }, …]`
 * Ausgabe: `<span class="min">1<sup class="adr-ex">ex</sup>5</span>, <span class="max">6</span>`
 *
 * Exploding-Chain-Logik: aufeinanderfolgende Würfel mit `exploded:true` werden
 * als ein Wurf mit hochgestelltem „ex"-Marker zusammengefasst; eine 1 oder
 * eine Höchstzahl in der Chain färbt den ganzen Span rot bzw. grün.
 */
export function _renderDiceArr(arr) {
  const parts = [];
  let chain = [];
  for (const d of arr ?? []) {
    chain.push(d);
    if (!d.exploded) {
      let cssClass = "";
      const vals = chain.map(c => c.value);
      if (vals.includes(1)) cssClass = "min";
      if (chain.some(c => c.value === c.faces)) cssClass = "max";
      const display = vals.join(`<sup class='adr-ex'>ex</sup>`);
      parts.push(`<span class="${cssClass}">${display}</span>`);
      chain = [];
    }
  }
  return parts.join(", ");
}

/**
 * Rendert vorgekochte Einzelergebnis-Arrays (Format des freien Wurfs,
 * gespeichert in `flags.mainIndividualResults` / `wildIndividualResults`):
 * `[{ display, class, value }, …]`. Anders als bei `_renderDiceArr` liegt
 * die Exploding-Chain-Logik schon im `display`-Feld vor, wir müssen nur die
 * Spans bauen.
 */
export function _renderDicePrecomputed(arr) {
  if (!Array.isArray(arr) || !arr.length) return "";
  return arr.map((r, idx) =>
    `<span class="${r.class || ''}">${r.display ?? r.value}</span>${idx < arr.length - 1 ? ", " : ""}`
  ).join("");
}

/**
 * Baut den **Inhalt** einer kompakten Einzelergebnis-Zeile zusammen:
 *   "<mainHTML> (WD: <wildHTML>) (Mod. ±N) <inlineCheckHTML>"
 *
 * Liefert NUR die Spans/Texte — der äußere Wrapper (z. B. `<div class="adr-individual">`,
 * Block mit Akteurname-Kopfzeile in Opposed, `<span>` im Dramatic-History-Body)
 * wird vom Aufrufer gebaut, damit Layout-Unterschiede erhalten bleiben.
 *
 * Parameter:
 *   - mainHTML         (string)  bereits gerendertes Main-Würfel-Markup
 *   - wildHTML         (string)  Wild-Würfel-Markup (leer = kein WD)
 *   - appliedModifier  (number|null)  null/undefined → kein Mod-Span
 *   - inlineCheckHTML  (string)  optionaler W6-Prüfwürfel-Span am Ende
 *   - wdClass          (string)  CSS-Klasse für den WD-Wrapper-Span
 */
export function _buildInlineRollContent({
  mainHTML = "",
  wildHTML = "",
  appliedModifier = null,
  inlineCheckHTML = "",
  wdClass = "adr-group-detail-wild",
} = {}) {
  const wildPart = wildHTML
    ? ` <span class="${wdClass}">(WD: ${wildHTML})</span>`
    : "";
  const modPart = (appliedModifier !== null && appliedModifier !== undefined)
    ? _buildAppliedModifierHTML(appliedModifier, true)
    : "";
  return `${mainHTML}${wildPart}${modPart}${inlineCheckHTML}`;
}

/**
 * Berechnet die Anzeige-Daten für einen Probenanforderungs-Modifikator.
 * Robust gegen NaN, undefined, null, Strings, Objekte. Gibt immer ein
 * konsistentes Ergebnis-Objekt zurück, das direkt im Template verwendet
 * werden kann — ohne `gt`-Helper-Logik.
 *
 * @param {*} modifier  Roher Modifikator-Wert.
 * @returns {{ show: boolean, str: string, cls: string, value: number }}
 */
export function _getModifierDisplay(modifier) {
  const raw = Number(modifier);
  const m = Number.isFinite(raw) ? raw : 0;
  if (m === 0) return { show: false, str: "",       cls: "",                          value: 0 };
  if (m > 0)   return { show: true,  str: `+${m}`,  cls: "adr-request-modifier-pos",  value: m };
  return              { show: true,  str: `${m}`,   cls: "adr-request-modifier-neg",  value: m };
}

/**
 * Repariert eine bereits gerenderte Probenanforderungs-Nachricht, falls die
 * Modifikator-Anzeige im DOM "NaN" enthält (z. B. weil die Nachricht vor einem
 * Code-Fix mit einem korrupten Wert erstellt wurde). Baut die Anzeige aus
 * `flags.modifier` neu auf.
 *
 * Greift nur bei nicht-dramatischen Modi (single, group, opposed). Im
 * Dramatic-Modus wird die Anzeige beim Rendern dynamisch von _enhanceDramaticRequestChat
 * aufgebaut, dort gibt es separate Mechanik.
 *
 * @param {HTMLElement} li      Das <li>-Element der Chat-Nachricht.
 * @param {Object}      flags   Flags-Objekt aus message.flags[ADR.ID].
 */
function _selfHealModifierDisplay(li, flags) {
  if (!li || !flags) return;
  if (flags.mode === "dramatic") return; // Dramatic hat eigene Render-Logik

  const fmt = _getModifierDisplay(flags.modifier);

  // Alle Modifikator-Spans (Group-Top, Single, Opposed, Group-Detail, Single-Detail)
  li.querySelectorAll(".adr-request-modifier").forEach(span => {
    const txt = span.textContent || "";
    // Nur eingreifen wenn die Anzeige korrupt ist ("NaN", leer trotz Modifier, oder unsichtbares Sonderzeichen)
    const looksCorrupt = /NaN/i.test(txt) || txt.trim() === "" || txt.includes("undefined");
    if (!looksCorrupt && fmt.show) return; // ok wie es ist
    if (!looksCorrupt && !fmt.show) {
      // Kein Modifikator vorhanden, aber span existiert — ausblenden
      span.style.display = "none";
      return;
    }
    if (fmt.show) {
      span.textContent = fmt.str;
      span.classList.remove("adr-request-modifier-pos", "adr-request-modifier-neg");
      if (fmt.cls) span.classList.add(fmt.cls);
      span.style.display = ""; // falls vorher ausgeblendet
    } else {
      span.style.display = "none";
      // Container `.adr-request-trait-die` mit dazugehörigem Mod-Label ebenfalls ausblenden
      const wrapper = span.closest(".adr-request-trait-die");
      if (wrapper && wrapper.querySelector(".adr-request-mod-label")) {
        wrapper.style.display = "none";
      }
    }
  });

  // Falls der Modifikator nicht angezeigt werden sollte, aber der Container noch da ist (z. B. weil
  // span schon entfernt wurde), Container ebenfalls ausblenden.
  if (!fmt.show) {
    li.querySelectorAll(".adr-request-trait-die").forEach(div => {
      if (div.querySelector(".adr-request-mod-label") && !div.querySelector(".adr-request-modifier")) {
        div.style.display = "none";
      }
    });
  }
}

/**
 * Liefert die chronologisch sortierten Wurf-Zeilen für einen Entry als HTML-String:
 * verworfene Würfe (mit `adr-individual-discarded`) gefolgt vom aktuell geltenden Wurf.
 *
 * Pro Wurf wird `_buildInlineRollContent` aufgerufen und in einen
 * `<div class="adr-individual${discardCls}">` gewickelt. Für Statisten-Würfe mit
 * Wert 1 und vorhandenem W6-Prüfergebnis wird der Prüfwürfel inline angehängt.
 *
 * Datenquellen am Entry-Objekt: `diceDetails`, `previousRolls`, `rollSeq`,
 * `fumbleCheckDie`. Funktioniert für Single/Group/Opposed-Entry-Format.
 */
export function _buildRollHistoryHTML(entry) {
  if (!entry?.diceDetails) return "";

  const dieLabel = game.i18n.localize(`${ADR.ID}.requestRoll.fumbleCheckDieLabel`);
  const buildInlineCheck = (dd, fumbleCheckDie) => {
    if (fumbleCheckDie == null) return "";
    if (!dd?.main || dd.main.length !== 1) return "";
    if (Number(dd.main[0]?.value) !== 1) return "";
    const dieCss = fumbleCheckDie === 1 ? "min" : "";
    return ` <span class="adr-fumble-check-inline">`
      + `<span class="adr-label">( ${dieLabel}:</span> `
      + `<span class="${dieCss}">${fumbleCheckDie}</span>`
      + `<span class="adr-label"> )</span></span>`;
  };

  // Chronologisch sammeln (Legacy-Fallback: Array-Index als Seq).
  const all = [];
  const prevList = Array.isArray(entry.previousRolls) ? entry.previousRolls : [];
  prevList.forEach((pr, i) => {
    if (!pr?.diceDetails) return;
    all.push({
      diceDetails: pr.diceDetails,
      fumbleCheckDie: pr.fumbleCheckDie,
      seq: (pr.seq != null) ? pr.seq : (i + 1),
      isCurrent: false,
    });
  });
  all.push({
    diceDetails: entry.diceDetails,
    fumbleCheckDie: entry.fumbleCheckDie,
    seq: (entry.rollSeq != null) ? entry.rollSeq : (prevList.length + 1),
    isCurrent: true,
  });
  all.sort((a, b) => a.seq - b.seq);

  let html = "";
  for (const w of all) {
    const dd = w.diceDetails;
    const discardCls = w.isCurrent ? "" : " adr-individual-discarded";
    const content = _buildInlineRollContent({
      mainHTML: _renderDiceArr(dd.main),
      wildHTML: dd.wild?.length ? _renderDiceArr(dd.wild) : "",
      appliedModifier: dd.appliedModifier,
      inlineCheckHTML: buildInlineCheck(dd, w.fumbleCheckDie),
    });
    html += `<div class="adr-individual${discardCls}">${content}</div>`;
  }
  return html;
}

function _buildDiceDetailsHTML(diceDetails, previousRolls = null, currentFumbleCheckDie = null, currentRollSeq = null) {
  if (!diceDetails) return "";

  const inner = _buildRollHistoryHTML({
    diceDetails,
    previousRolls,
    fumbleCheckDie: currentFumbleCheckDie,
    rollSeq: currentRollSeq,
  });

  const toggleLabel = game.i18n.localize(`${ADR.ID}.individualResults.toggle`);
  return `<div class="adr-individual-toggle-container">`
    + `<div class="adr-individual-toggle">${toggleLabel}</div>`
    + `<div class="adr-individual-details adr-individual-hidden">`
    + inner
    + `</div></div>`;
}

function _getDramaticEntryStatus(entry) {
  const rs = entry.roundState ?? {};

  if (rs.skipped) {
    return {
      text: game.i18n.localize(`${ADR.ID}.requestRoll.dramaticSkippedLabel`),
      className: "adr-dramatic-status-skip",
    };
  }
  if (rs.pendingFumbleCheck) {
    return {
      text: game.i18n.localize(`${ADR.ID}.requestRoll.dramaticPendingCheckLabel`),
      className: "adr-dramatic-status-pending",
    };
  }
  if (rs.complicationFailure) {
    return {
      text: game.i18n.localize(`${ADR.ID}.requestRoll.dramaticComplicationFailedLabel`),
      className: "adr-dramatic-status-loss",
    };
  }
  if ((rs.markersDelta ?? null) === -1) {
    return {
      text: game.i18n.localize(`${ADR.ID}.requestRoll.dramaticLostMarkerLabelTitle`),
      className: "adr-dramatic-status-loss",
    };
  }
  if (Number(rs.markersDelta ?? 0) > 0) {
    return {
      text: game.i18n.format(`${ADR.ID}.requestRoll.dramaticGainedMarkerLabel`, {
        count: Number(rs.markersDelta ?? 0),
      }),
      className: "adr-dramatic-status-gain",
    };
  }
  if (rs.result !== null && rs.result !== undefined) {
    return {
      text: game.i18n.localize(`${ADR.ID}.requestRoll.dramaticNoMarkerLabel`),
      className: "adr-dramatic-status-none",
    };
  }
  return { text: null, className: "" };
}

function _sortDramaticEntries(entries) {
  return [...(entries ?? [])].sort((a, b) => {
    const aSort = a.roundState?.card?.sortValue ?? 0;
    const bSort = b.roundState?.card?.sortValue ?? 0;
    if (bSort !== aSort) return bSort - aSort;
    return (a.actorName ?? "").localeCompare(b.actorName ?? "", game.i18n.lang);
  });
}

function _buildDramaticHistoryDiceHTML(diceDetails) {
  if (!diceDetails) return "";

  // Dramatic-History behält bewusst `adr-dramatic-history-label` für den WD-Span
  // (eigenes Layout-Pattern, eingebettet in adr-dramatic-history-body), darüber
  // hinaus identisches Inline-Schema wie Single/Group/Opposed.
  const mainHTML = _renderDiceArr(diceDetails.main);
  const content = _buildInlineRollContent({
    mainHTML: `<span class="adr-individual">${mainHTML}</span>`,
    wildHTML: diceDetails.wild?.length ? _renderDiceArr(diceDetails.wild) : "",
    appliedModifier: diceDetails.appliedModifier,
    wdClass: "adr-dramatic-history-label",
  });
  return content;
}

function _buildDramaticHistoryGroups(entries, currentRound) {
  const roundMap = new Map();

  const addEntry = (entry, roundState) => {
    if (!roundState) return;

    // ── Helfer-Eintrag (hat unterstützt statt selbst gewürfelt) ──
    if (roundState.supportGiven) {
      const sg = roundState.supportGiven;
      let supportClass;

      if (sg.tooLate || sg.capExceeded) {
        supportClass = "adr-dramatic-history-skipped";
      } else if (sg.critFail) {
        supportClass = "adr-dramatic-history-failure";
      } else if (Number(sg.delta) === 0) {
        supportClass = "adr-dramatic-history-none";
      } else {
        supportClass = "adr-dramatic-history-gained";
      }

      const roundNum = roundState.round ?? currentRound;
      if (!roundMap.has(roundNum)) roundMap.set(roundNum, []);

      roundMap.get(roundNum).push({
        sortValue: roundState.card?.sortValue ?? 0,
        actorName: entry.actorName ?? "",
        cardRank: roundState.card?.rankLabel ?? "?",
        cardSuit: roundState.card?.suitSymbol ?? "",
        cardIsJoker: !!roundState.card?.isJoker,
        diceHTML: _buildDramaticHistoryDiceHTML(sg.diceDetails),
        resultText: "",
        resultClass: supportClass,
      });
      return;
    }

    let resultText = "";
    let resultClass = "";
    if (roundState.skipped) {
      resultText = game.i18n.localize(`${ADR.ID}.requestRoll.dramaticSkippedLabel`);
      resultClass = "adr-dramatic-history-skipped";
    } else if (roundState.complicationFailure) {
      resultClass = "adr-dramatic-history-failure";
    } else if ((roundState.markersDelta ?? null) === -1) {
      resultClass = "adr-dramatic-history-lost";
    } else if (Number(roundState.markersDelta ?? 0) > 0) {
      resultClass = "adr-dramatic-history-gained";
    } else if (roundState.pendingFumbleCheck) {
      resultClass = "adr-dramatic-history-pending";
    } else if (roundState.result !== null && roundState.result !== undefined) {
      resultClass = "adr-dramatic-history-none";
    } else {
      return; // nicht würfelnder Eintrag ohne Status — nicht in Historie aufnehmen
    }

    const roundNum = roundState.round ?? currentRound;
    if (!roundMap.has(roundNum)) roundMap.set(roundNum, []);

    roundMap.get(roundNum).push({
      sortValue: roundState.card?.sortValue ?? 0,
      actorName: entry.actorName ?? "",
      cardRank: roundState.card?.rankLabel ?? "?",
      cardSuit: roundState.card?.suitSymbol ?? "",
      cardIsJoker: !!roundState.card?.isJoker,
      diceHTML: _buildDramaticHistoryDiceHTML(roundState.diceDetails),
      resultText,
      resultClass,
    });
  };

  for (const entry of entries ?? []) {
    for (const hist of entry.history ?? []) addEntry(entry, hist);
    const current = entry.roundState;
    if (current && (current.skipped || current.acted)) addEntry(entry, current);
  }

  const groups = [];
  for (const roundNum of [...roundMap.keys()].sort((a, b) => a - b)) {
    const sorted = roundMap.get(roundNum)
      .sort((a, b) => (a.actorName ?? "").localeCompare(b.actorName ?? "", game.i18n.lang));
    groups.push({ round: roundNum, entries: sorted });
  }
  return groups;
}

function _buildDramaticStatusText(flags) {
  // Altes Plain-Text-API (noch für entry-Status genutzt) — eine Zeile, kein HTML
  if (flags.outcome === "success") {
    const l1 = game.i18n.localize(`${ADR.ID}.requestRoll.dramaticTaskSuccessLine1`);
    const l2 = game.i18n.localize(`${ADR.ID}.requestRoll.dramaticTaskSuccessLine2`);
    return `${l1} — ${l2}`;
  }
  if (flags.outcome === "failure") {
    const keyL1 = flags.failureReason === "complication"
      ? `${ADR.ID}.requestRoll.dramaticTaskFailureComplicationLine1`
      : `${ADR.ID}.requestRoll.dramaticTaskFailureRoundsLine1`;
    const keyL2 = flags.failureReason === "complication"
      ? `${ADR.ID}.requestRoll.dramaticTaskFailureComplicationLine2`
      : `${ADR.ID}.requestRoll.dramaticTaskFailureRoundsLine2`;
    return `${game.i18n.localize(keyL1)} — ${game.i18n.localize(keyL2)}`;
  }

  switch (flags.pendingOutcome) {
    case "readyNextRound": {
      const round = Number(flags.currentRound ?? 1);
      return `${game.i18n.format(`${ADR.ID}.requestRoll.dramaticRoundReadyLine1`, { round })} ${game.i18n.format(`${ADR.ID}.requestRoll.dramaticRoundReadyLine2`, { nextRound: round + 1 })}`;
    }
    case "roundFailure":
      return `${game.i18n.localize(`${ADR.ID}.requestRoll.dramaticRoundFailurePendingLine1`)} — ${game.i18n.localize(`${ADR.ID}.requestRoll.dramaticRoundFailurePendingLine2`)}`;
    case "complicationFailure":
      return `${game.i18n.localize(`${ADR.ID}.requestRoll.dramaticComplicationFailurePendingLine1`)} — ${game.i18n.localize(`${ADR.ID}.requestRoll.dramaticComplicationFailurePendingLine2`)}`;
    default:
      return game.i18n.localize(`${ADR.ID}.requestRoll.chatPending`);
  }
}

/**
 * HTML-Variante des Status mit zweizeiligem Layout und Farb-/Fett-Klassen.
 * Zeile 1: neutraler Erklärungstext. Zeile 2 (falls vorhanden): farbig+fett.
 */
function _buildDramaticStatusHTML(flags) {
  const esc = foundry.utils.escapeHTML ?? (s => String(s ?? ""));

  if (flags.outcome === "success") {
    const l1 = esc(game.i18n.localize(`${ADR.ID}.requestRoll.dramaticTaskSuccessLine1`));
    const l2 = esc(game.i18n.localize(`${ADR.ID}.requestRoll.dramaticTaskSuccessLine2`));
    return `<div class="adr-dramatic-status-line">${l1}</div>`
      + `<div class="adr-dramatic-status-line adr-dramatic-status-success">${l2}</div>`;
  }
  if (flags.outcome === "failure") {
    const keyL1 = flags.failureReason === "complication"
      ? `${ADR.ID}.requestRoll.dramaticTaskFailureComplicationLine1`
      : `${ADR.ID}.requestRoll.dramaticTaskFailureRoundsLine1`;
    const keyL2 = flags.failureReason === "complication"
      ? `${ADR.ID}.requestRoll.dramaticTaskFailureComplicationLine2`
      : `${ADR.ID}.requestRoll.dramaticTaskFailureRoundsLine2`;
    return `<div class="adr-dramatic-status-line">${esc(game.i18n.localize(keyL1))}</div>`
      + `<div class="adr-dramatic-status-line adr-dramatic-status-failure">${esc(game.i18n.localize(keyL2))}</div>`;
  }

  switch (flags.pendingOutcome) {
    case "readyNextRound": {
      const round = Number(flags.currentRound ?? 1);
      const l1 = game.i18n.format(`${ADR.ID}.requestRoll.dramaticRoundReadyLine1`, { round });
      const l2 = game.i18n.format(`${ADR.ID}.requestRoll.dramaticRoundReadyLine2`, { nextRound: round + 1 });
      return `<div class="adr-dramatic-status-line">${esc(l1)}</div>`
        + `<div class="adr-dramatic-status-line">${esc(l2)}</div>`;
    }
    case "roundFailure": {
      const l1 = game.i18n.localize(`${ADR.ID}.requestRoll.dramaticRoundFailurePendingLine1`);
      const l2 = game.i18n.localize(`${ADR.ID}.requestRoll.dramaticRoundFailurePendingLine2`);
      return `<div class="adr-dramatic-status-line">${esc(l1)}</div>`
        + `<div class="adr-dramatic-status-line adr-dramatic-status-failure">${esc(l2)}</div>`;
    }
    case "complicationFailure": {
      const l1 = game.i18n.localize(`${ADR.ID}.requestRoll.dramaticComplicationFailurePendingLine1`);
      const l2 = game.i18n.localize(`${ADR.ID}.requestRoll.dramaticComplicationFailurePendingLine2`);
      return `<div class="adr-dramatic-status-line">${esc(l1)}</div>`
        + `<div class="adr-dramatic-status-line adr-dramatic-status-failure">${esc(l2)}</div>`;
    }
    default:
      return `<div class="adr-dramatic-status-line">${esc(game.i18n.localize(`${ADR.ID}.requestRoll.chatPending`))}</div>`;
  }
}

function _recalculateDramaticFlags(flags) {
  const calc = calculateDramaticTaskState(flags);
  flags.totalMarkers = calc.totalMarkers;

  if (flags.outcome === "failure" || flags.outcome === "success") {
    flags.pendingOutcome = null;
    return flags;
  }

  if (calc.success) {
    flags.outcome = "success";
    flags.pendingOutcome = null;
    return flags;
  }

  flags.pendingOutcome = calc.pendingOutcome;
  return flags;
}

/**
 * Liefert für einen Dramatic-Entry die effektiv zu nutzenden Trait-Daten.
 * Berücksichtigt einen ggf. vom Spieler gesetzten `dramaticTraitOverride`.
 *
 * Felder:
 *   type            "attribute" | "skill" | "untrained"
 *   key             Skill-Item-ID oder Attribut-Key
 *   name            Anzeigename
 *   die             Würfel-Seitenzahl (4/6/8/10/12)
 *   dieLabel        z.B. "W6" / "d6" abhängig von flags.diePrefix? — siehe unten
 *   isUntrained     true, wenn Untrained-Malus greift (-2)
 *
 * Achtung: `die`/`dieLabel` werden aus dem aktuellen Actor neu gelesen, weil
 * der Override eine andere Eigenschaft sein kann als der Original-Trait.
 *
 * @param {object} entry  Dramatic-Entry aus flags.entries
 * @returns {{type:string,key:string,name:string,die:number,dieLabel:string,isUntrained:boolean}}
 */
function _resolveDramaticTrait(entry) {
  const ovr = entry?.dramaticTraitOverride;
  const useOverride = !!(ovr && ovr.type && ovr.key);

  const type = useOverride ? ovr.type : entry?.traitType;
  const key  = useOverride ? ovr.key  : entry?.traitKey;
  const name = useOverride ? ovr.name : entry?.traitName;

  // Wenn kein Override: Entry-Felder direkt zurückgeben (so wie sie beim
  // Anlegen der Aufgabe geschrieben wurden).
  if (!useOverride) {
    return {
      type,
      key,
      name,
      die: entry?.traitDie ?? 4,
      dieLabel: entry?.traitDieLabel ?? `W${entry?.traitDie ?? 4}`,
      isUntrained: !!entry?.isUntrained,
    };
  }

  // Override: Würfel + Untrained-Status aus dem aktuellen Actor frisch ableiten.
  const actor = _resolveActor(entry.actorId);
  let die = 4;
  if (actor) {
    if (type === "attribute") {
      die = actor.system?.attributes?.[key]?.die?.sides ?? 4;
    } else if (type === "skill") {
      die = actor.items.get(key)?.system?.die?.sides ?? 4;
    }
  }

  // Präfix aus Original-Label rekonstruieren (z.B. "W" oder "d"), Fallback "W".
  let prefix = "W";
  const orig = entry?.traitDieLabel;
  if (typeof orig === "string") {
    const m = orig.match(/^([^\d]+)/);
    if (m && m[1]) prefix = m[1];
  }

  const isUntrained = type === "untrained"
    || UNTRAINED_SKILL_NAMES.has((name ?? "").toLowerCase());

  return {
    type,
    key,
    name,
    die,
    dieLabel: `${prefix}${die}`,
    isUntrained,
  };
}

/**
 * Wendet einen Trait-Override auf einen Dramatic-Eintrag an. Bleibt über
 * Runden hinweg bestehen, bis der Spieler ihn ändert oder zurücksetzt.
 *
 * @param {ChatMessage} message
 * @param {object} payload
 * @param {string} payload.actorId
 * @param {boolean} [payload.reset]      Wenn true: Override löschen.
 * @param {string}  [payload.traitType]
 * @param {string}  [payload.traitKey]
 * @param {string}  [payload.traitName]
 */
export async function _applyDramaticTraitOverride(message, payload) {
  const flags = foundry.utils.deepClone(message.flags[ADR.ID] || {});
  if (flags.mode !== "dramatic") return;
  if (flags.outcome) return;
  if (flags.pendingOutcome === "complicationFailure") return;

  const entry = flags.entries?.find(e => e.actorId === payload.actorId);
  const rs = entry?.roundState;
  if (!entry || !rs) return;
  if (rs.acted || rs.skipped) return;
  if (rs.result !== null && rs.result !== undefined) return;

  if (payload.reset) {
    delete entry.dramaticTraitOverride;
  } else {
    entry.dramaticTraitOverride = {
      type: payload.traitType,
      key: payload.traitKey,
      name: payload.traitName,
    };
  }

  await _updateDramaticTaskMessage(message, flags);
}

function _buildDramaticEntryViews(flags) {
  const taskLocked = !!flags.outcome;
  const freezeNewActions = flags.pendingOutcome === "complicationFailure";
  const esc = foundry.utils.escapeHTML ?? (s => String(s ?? ""));

  return _sortDramaticEntries(flags.entries).map(entry => {
    const roundState = entry.roundState ?? {};
    const status = _getDramaticEntryStatus(entry);
    const resolvedTrait = _resolveDramaticTrait(entry);
    const hasTraitOverride = !!(entry.dramaticTraitOverride && (
      entry.dramaticTraitOverride.type !== entry.traitType ||
      entry.dramaticTraitOverride.key !== entry.traitKey
    ));

    const markersDelta = Number(roundState.markersDelta ?? 0);
    let dramaticResultClass = "";
    let dramaticResultRaisesHTML = "";
    if (roundState.result !== null && roundState.result !== undefined) {
      const val = Number(roundState.result);
      const isFail = markersDelta === -1 || roundState.complicationFailure || roundState.wasFumble;
      if (isFail) {
        dramaticResultClass = "adr-dramatic-result-fail";
      } else if (val < 4) {
        dramaticResultClass = "adr-result-fail";
      } else if (val < 8) {
        dramaticResultClass = "adr-result-success";
        dramaticResultRaisesHTML = '<span class="adr-result-raises">✓</span>';
      } else {
        dramaticResultClass = "adr-result-success";
        dramaticResultRaisesHTML = '<span class="adr-result-raises">✓<br>✓</span>';
      }
    }

    const mod = Number(flags.modifier ?? 0);
    let dramaticModClass = "adr-dramatic-mod-zero";
    if (mod > 0) dramaticModClass = "adr-dramatic-mod-pos";
    else if (mod < 0) dramaticModClass = "adr-dramatic-mod-neg";

    // ── Helfer-Sub-Zeile (dieser Eintrag hat unterstützt) ──
    let dramaticIsSupporter = false;
    let dramaticSupportLineHTML = "";
    let dramaticSupporterShowResult = false;
    let dramaticSupporterResult = "";
    let dramaticSupporterResultClass = "";
    let dramaticSupporterResultRaisesHTML = "";
    let dramaticSupporterShowBenny = false;
    let dramaticSupporterBennyUsed = false;
    let dramaticSupporterBennyFumble = false;
    let dramaticSupporterShowFumbleCheck = false;
    let dramaticSupporterFumbleCheckHTML = "";
    if (roundState.supportGiven) {
      dramaticIsSupporter = true;
      const sg = roundState.supportGiven;
      dramaticSupportLineHTML = _buildDramaticSupportLineHTML(sg);

      // Patzer-Prüfung läuft noch — Patzer-Button anzeigen, aber das Ergebnis
      // ebenfalls regulär darstellen (kein "ausstehend"-Sonderlayout mehr).
      if (sg.pendingFumbleCheck) {
        dramaticSupporterShowFumbleCheck = true;
      }
      if (!sg.tooLate && !sg.capExceeded) {
        // Wenn die Patzer-Prüfung "kein Patzer" ergab, "kein Patzer"-Text anzeigen
        if (sg.fumbleCheckDie != null && !sg.critFail) {
          const keyword = game.i18n.localize(`${ADR.ID}.requestRoll.fumbleCheckNone`);
          const template = game.i18n.localize(`${ADR.ID}.requestRoll.fumbleCheckTextNo`);
          dramaticSupporterFumbleCheckHTML = template.replace(
            "{result}",
            `<span class="adr-fumble-denied-text">${keyword}</span>`
          );
        }

        dramaticSupporterShowResult = true;
        const total = Number(sg.resultTotal ?? 0);
        dramaticSupporterResult = total;
        if (sg.critFail) {
          dramaticSupporterResultClass = "adr-dramatic-result-fail";
        } else if (total < 4) {
          dramaticSupporterResultClass = "adr-result-fail";
        } else if (total < 8) {
          dramaticSupporterResultClass = "adr-result-success";
          dramaticSupporterResultRaisesHTML = '<span class="adr-result-raises">✓</span>';
        } else {
          dramaticSupporterResultClass = "adr-result-success";
          dramaticSupporterResultRaisesHTML = '<span class="adr-result-raises">✓<br>✓</span>';
        }
        dramaticSupporterBennyFumble = !!sg.critFail;
        dramaticSupporterBennyUsed = !!sg.bennyUsed;
        // Button bleibt sichtbar wie bei normaler Probe, damit der Spieler
        // bei Bedarf weitere Bennies investieren kann (jeder Reroll verbraucht
        // einen Benny). adr-benny-used markiert nur visuell, dass bereits ein
        // Benny eingesetzt wurde.
        dramaticSupporterShowBenny = !taskLocked;
      }
    }

    // ── Empfangene Support-Zeilen (dieser Eintrag IST das Ziel) ──
    const dramaticReceivedSupportLines = _buildDramaticReceivedSupportLines(
      roundState.supportBonuses
    );

    // ── Patzer-Prüfung: "kein Patzer"-Bestätigungstext ──
    let dramaticFumbleCheckPassed = false;
    let dramaticFumbleCheckPassedHTML = "";
    if (roundState.fumbleCheckResult === false && roundState.fumbleCheckDie != null) {
      dramaticFumbleCheckPassed = true;
      const keyword = game.i18n.localize(`${ADR.ID}.requestRoll.fumbleCheckNone`);
      const template = game.i18n.localize(`${ADR.ID}.requestRoll.fumbleCheckTextNo`);
      dramaticFumbleCheckPassedHTML = template.replace(
        "{result}",
        `<span class="adr-fumble-denied-text">${keyword}</span>`
      );
    }

    return {
      ...entry,
      // Trait-Felder mit Override-Auflösung überschreiben (greift, wenn ein
      // dramaticTraitOverride gesetzt ist; sonst identisch zum Entry).
      traitType: resolvedTrait.type,
      traitKey: resolvedTrait.key,
      traitName: resolvedTrait.name,
      traitDie: resolvedTrait.die,
      traitDieLabel: resolvedTrait.dieLabel,
      isUntrained: resolvedTrait.isUntrained,
      hasTraitOverride,
      roundState,
      dramaticShowResult: roundState.result !== null && roundState.result !== undefined,
      dramaticResultPending: !!roundState.pendingFumbleCheck,
      dramaticNoSuccessLabel: game.i18n.localize(`${ADR.ID}.requestRoll.dramaticNoSuccess`),
      dramaticShowBenny: !taskLocked && roundState.result !== null && roundState.result !== undefined && !roundState.skipped,
      dramaticShowFumbleCheck: !!roundState.pendingFumbleCheck,
      dramaticStatusText: status.text,
      dramaticStatusClass: status.className,
      dramaticCanRoll: !taskLocked && !freezeNewActions && !roundState.acted && !roundState.skipped,
      dramaticCanSkip: !taskLocked && !freezeNewActions && !roundState.acted && !roundState.skipped,
      dramaticResultClass,
      dramaticResultRaisesHTML,
      dramaticModClass,
      dramaticBennyFumble: !!(roundState.wasFumble || roundState.fumbleCheckResult === true),
      dramaticBennyUsed: !!(roundState.bennyUsed && !(roundState.wasFumble || roundState.fumbleCheckResult === true)),
      dramaticIsSupporter,
      dramaticSupportLineHTML,
      dramaticSupporterShowResult,
      dramaticSupporterResult,
      dramaticSupporterResultClass,
      dramaticSupporterResultRaisesHTML,
      dramaticSupporterShowBenny,
      dramaticSupporterBennyUsed,
      dramaticSupporterBennyFumble,
      dramaticSupporterShowFumbleCheck,
      dramaticSupporterFumbleCheckHTML,
      dramaticReceivedSupportLines,
      dramaticHasReceivedSupport: dramaticReceivedSupportLines.length > 0,
      dramaticFumbleCheckPassed,
      dramaticFumbleCheckPassedHTML,
      dramaticCardClass: [
        "adr-dramatic-card",
        roundState.card?.isJoker ? "adr-dramatic-card-joker" : "",
        roundState.card?.isComplication ? "adr-dramatic-card-complication" : "",
      ].filter(Boolean).join(" "),
      dramaticCardModifierLabel: roundState.card?.modifier
        ? `${roundState.card.modifier > 0 ? "+" : ""}${roundState.card.modifier}`
        : "",
    };
  });
}

function _buildDramaticTemplateData(flags) {
  const modRaw = Number(flags.modifier);
  const modSafe = Number.isFinite(modRaw) ? modRaw : 0;
  const modDisplay = _getModifierDisplay(modSafe);
  return {
    requestId: flags.requestId,
    mode: "dramatic",
    modifier: modSafe,
    modifierStr: modDisplay.str,
    modifierClass: modDisplay.cls,
    showModifier: modDisplay.show,
    entries: _buildDramaticEntryViews(flags),
    modeLabel: game.i18n.localize(`${ADR.ID}.requestRoll.modeDramatic`),
    currentRound: flags.currentRound,
    roundsTotal: flags.roundsTotal,
    targetMarkers: flags.targetMarkers,
    totalMarkers: flags.totalMarkers ?? 0,
    pendingOutcome: flags.pendingOutcome ?? null,
    outcome: flags.outcome ?? null,
    failureReason: flags.failureReason ?? null,
    dramaticStatusText: _buildDramaticStatusText(flags),
    dramaticStatusHTML: _buildDramaticStatusHTML(flags),
    dramaticHistoryGroups: _buildDramaticHistoryGroups(flags.entries, flags.currentRound),
  };
}

async function _updateDramaticTaskMessage(message, flags) {
  _recalculateDramaticFlags(flags);
  const content = await foundry.applications.handlebars.renderTemplate(
    ADR.REQUEST_ROLL_CHAT_PATH,
    _buildDramaticTemplateData(flags)
  );

  await message.update({
    content,
    [`flags.${ADR.ID}`]: flags,
  });
}

function _getDramaticMarkersFromResult(resultTotal) {
  const total = Number(resultTotal ?? 0);
  if (total < 4) return 0;
  return 1 + Math.floor((total - 4) / 4);
}

/**
 * Patzer-Override-Pfad (Dramatic): Der Benny-Reroll war ein bestätigter Patzer
 * und überschreibt das alte Ergebnis. Alter rs-Wurf wandert in previousRolls,
 * `newRollData` (= der Patzer-Wurf) wird zum geltenden rs mit −1 Marker und
 * Patzer-Konsequenzen.
 *
 * Wird aufgerufen
 *   • aus `_applyDramaticRollResult`, wenn der Reroll sofort als "confirmed"
 *     klassifiziert wird (Wildcard-Patzer-Konstellation), und
 *   • aus dem Discarded-Check-Handler, wenn ein Statisten-1-Reroll per W6
 *     nachträglich als Patzer bestätigt wird.
 *
 * Hinweis zur Schutz-Hausregel: Der Verschlechterungsschutz greift NICHT bei
 * einem Patzer-Reroll — die Patzer-Strafe (−1 Marker, ggf. Komplikations-
 * Fehlschlag) ist eine eigenständige Konsequenz und überschreibt den alten,
 * positiven Wurf vollständig.
 *
 * @param {object} rs           – roundState (wird mutiert)
 * @param {object} entry        – Eintrag (für card-Lookup)
 * @param {object} newRollData  – {result, diceDetails, fumbleCheckResult?, fumbleCheckDie?, seq?}
 */
function _applyDramaticFumbleOverride(rs, entry, newRollData) {
  if (!Array.isArray(rs.previousRolls)) rs.previousRolls = [];

  // Alter rs-Wurf in previousRolls schieben (mit seiner Seq)
  const currentSeq = rs.rollSeq ?? 1;
  const histEntry = { result: Number(rs.result) || 0, diceDetails: rs.diceDetails, seq: currentSeq };
  if (rs.fumbleCheckResult !== undefined) histEntry.fumbleCheckResult = rs.fumbleCheckResult;
  if (rs.fumbleCheckDie !== undefined) histEntry.fumbleCheckDie = rs.fumbleCheckDie;
  rs.previousRolls.push(histEntry);

  // Seq-Tracking für den neuen geltenden Wurf
  const newSeq = newRollData.seq ?? (rs.nextRollSeq ?? (rs.previousRolls.length + 1));
  rs.rollSeq = newSeq;
  rs.nextRollSeq = Math.max(rs.nextRollSeq ?? 0, newSeq + 1);

  // Patzer-Werte übernehmen
  rs.result = newRollData.result;
  rs.diceDetails = newRollData.diceDetails;
  rs.fumbleCheckResult = newRollData.fumbleCheckResult ?? true;
  rs.fumbleCheckDie = newRollData.fumbleCheckDie ?? rs.fumbleCheckDie;
  rs.wasFumble = true;
  rs.normalMarkersDelta = _getDramaticMarkersFromResult(newRollData.result);
  rs.markersDelta = -1;
  rs.complicationFailure = !!rs.card?.isComplication;
  rs.needsFumbleCheck = false;
  rs.pendingFumbleCheck = false;
  rs.fumbleCheckAccepted = false;
  rs.acted = true;
  rs.skipped = false;
  rs.bennyUsed = true;
  rs.lastRerollProtected = false;
  rs.lastRerollFumbleOverwrite = true;
}

async function _applyDramaticRollResult(message, actorId, resultTotal, diceDetails, { bennyUsed = false } = {}) {
  const flags = foundry.utils.deepClone(message.flags[ADR.ID] || {});
  if (flags.mode !== "dramatic") return;

  const entry = flags.entries?.find(e => e.actorId === actorId);
  const rs = entry?.roundState;
  if (!entry || !rs) return;
  if (flags.outcome) return;
  if (!bennyUsed && (rs.acted || rs.skipped || flags.pendingOutcome === "complicationFailure")) return;
  if (bennyUsed && (rs.result === null || rs.result === undefined)) return;

  // ── Benny-Schutz (Verschlechterungsschutz) ──
  // Analog zu _applyBennyRerollSingle, aber auf dem roundState (rs) statt
  // direkt auf entry. previousRolls/lastRerollProtected/rollSeq/nextRollSeq
  // werden runden-lokal auf rs gehalten — beim Runden-Wechsel automatisch
  // zurückgesetzt (advanceDramaticRound delete entry.roundState).
  if (bennyUsed) {
    // Wichtig: Reroll-Patzer (bestätigt) übersteuert den Schutz. Klassifizieren
    // BEVOR der Schutz-Vergleich gemacht wird.
    const newClassification = _classifyFumble(diceDetails, entry.isNPC);
    if (newClassification === "confirmed") {
      // Bestätigter Patzer im Reroll → Override-Pfad (alter Wurf wird verworfen,
      // Patzer gilt mit −1 Marker).
      _applyDramaticFumbleOverride(rs, entry, { result: resultTotal, diceDetails });
      await _updateDramaticTaskMessage(message, flags);
      return;
    }

    const oldResult = Number(rs.result) || 0;
    if (!Array.isArray(rs.previousRolls)) rs.previousRolls = [];
    const currentSeq = rs.rollSeq ?? 1;
    const newSeq = rs.nextRollSeq ?? (rs.previousRolls.length + 2);
    rs.nextRollSeq = newSeq + 1;

    if (resultTotal <= oldResult) {
      // Schutz greift: rs.result/diceDetails/markersDelta/wasFumble/etc.
      // bleiben unverändert. Neuer Wurf wandert mit eigener seq in History.
      rs.previousRolls.push({ result: resultTotal, diceDetails, seq: newSeq });
      rs.lastRerollProtected = true;
      rs.lastRerollFumbleOverwrite = false;
      rs.bennyUsed = true;
      await _updateDramaticTaskMessage(message, flags);
      return;
    }
    // Verbesserung: alter rs-Wurf geht mit eigener seq in History; danach
    // läuft der normale Apply-Pfad mit neuen Werten.
    const histEntry = { result: oldResult, diceDetails: rs.diceDetails, seq: currentSeq };
    if (rs.fumbleCheckResult !== undefined) histEntry.fumbleCheckResult = rs.fumbleCheckResult;
    if (rs.fumbleCheckDie !== undefined) histEntry.fumbleCheckDie = rs.fumbleCheckDie;
    rs.previousRolls.push(histEntry);
    rs.rollSeq = newSeq;
    rs.lastRerollProtected = false;
    rs.lastRerollFumbleOverwrite = false;
  } else {
    // Initialwurf: Sequenz-Tracking starten (Fallback in
    // _applyBennyRerollSingle würde auch greifen, hier explizit für Klarheit).
    rs.rollSeq = 1;
    rs.nextRollSeq = 2;
  }

  const normalMarkers = _getDramaticMarkersFromResult(resultTotal);
  Object.assign(rs, {
    acted: true,
    skipped: false,
    result: resultTotal,
    diceDetails,
    bennyUsed: rs.bennyUsed || bennyUsed,
    normalMarkersDelta: normalMarkers,
    markersDelta: normalMarkers,
    needsFumbleCheck: false,
    pendingFumbleCheck: false,
    fumbleCheckResult: undefined,
    fumbleCheckDie: undefined,
    wasFumble: false,
    complicationFailure: !!rs.card?.isComplication && Number(resultTotal ?? 0) < 4,
  });

  const classification = _classifyFumble(diceDetails, entry.isNPC);
  if (classification === "confirmed") {
    rs.wasFumble = true;
    rs.markersDelta = -1;
    rs.complicationFailure = !!rs.card?.isComplication;
  } else if (classification === "needs-check") {
    rs.needsFumbleCheck = true;
    rs.pendingFumbleCheck = true;
    rs.markersDelta = null;
  }

  await _updateDramaticTaskMessage(message, flags);
}

async function _applyDramaticSkip(message, actorId) {
  const flags = foundry.utils.deepClone(message.flags[ADR.ID] || {});
  if (flags.mode !== "dramatic") return;
  if (flags.outcome || flags.pendingOutcome === "complicationFailure") return;

  const entry = flags.entries?.find(e => e.actorId === actorId);
  const rs = entry?.roundState;
  if (!entry || !rs || rs.acted || rs.skipped) return;

  Object.assign(rs, {
    acted: false,
    skipped: true,
    result: null,
    diceDetails: null,
    bennyUsed: false,
    normalMarkersDelta: 0,
    markersDelta: 0,
    needsFumbleCheck: false,
    pendingFumbleCheck: false,
    fumbleCheckResult: undefined,
    fumbleCheckDie: undefined,
    wasFumble: false,
    complicationFailure: false,
  });

  await _updateDramaticTaskMessage(message, flags);
}

async function _applyDramaticFumbleCheck(message, actorId, dieTotal) {
  const flags = foundry.utils.deepClone(message.flags[ADR.ID] || {});
  if (flags.mode !== "dramatic") return;

  const entry = flags.entries?.find(e => e.actorId === actorId);
  const rs = entry?.roundState;
  if (!entry || !rs || !rs.pendingFumbleCheck) return;

  rs.needsFumbleCheck = false;
  rs.pendingFumbleCheck = false;
  rs.fumbleCheckDie = dieTotal;
  rs.fumbleCheckResult = dieTotal === 1;
  rs.wasFumble = dieTotal === 1;
  rs.markersDelta = dieTotal === 1 ? -1 : (rs.normalMarkersDelta ?? 0);
  if (dieTotal === 1 && rs.card?.isComplication) {
    rs.complicationFailure = true;
  }

  await _updateDramaticTaskMessage(message, flags);
}

/**
 * Wendet einen Unterstützungs-Wurf auf Helfer und Ziel an.
 *
 * Helfer-State: acted=true, markersDelta=0 (Helfer kann nie Marker bewegen),
 *               supportGiven enthält die kompletten Wurfdaten.
 * Ziel-State:   supportBonuses-Array bekommt einen neuen Eintrag mit dem Delta.
 *
 * Patzer-Mapping (nur natürliche 1en, Modifier irrelevant):
 *   - Wildcard-SC mit Wild Die = 1 UND Mehrheit = 1 → critFail bestätigt
 *   - NSC mit einzelnem Würfel = 1 → bereits per W6 verifizierter critFail
 *   - critFail → delta = -2 am Ziel (Helfer markersDelta bleibt 0)
 * Erfolgs-Mapping aus Total (mit Modifikatoren):
 *   - total < 4   → delta = 0  (Probe scheitert, kein Effekt)
 *   - total 4-7   → delta = +1
 *   - total >= 8  → delta = +2
 * Cap am Ziel: Summe positiver Deltas auf maximal +4 begrenzt.
 *
 * @param {ChatMessage} message
 * @param {object} payload
 * @param {string}  payload.helperId
 * @param {string}  payload.helperName
 * @param {string}  payload.targetId
 * @param {string}  payload.targetName
 * @param {string}  payload.traitType   "attribute" | "skill" | "untrained"
 * @param {string}  payload.traitKey
 * @param {string}  payload.traitName
 * @param {number}  payload.resultTotal
 * @param {object}  payload.diceDetails
 * @param {boolean} payload.critFail
 * @param {number} [payload.fumbleCheckDie]
 */
export async function _applyDramaticSupportRoll(message, payload) {
  const flags = foundry.utils.deepClone(message.flags[ADR.ID] || {});
  if (flags.mode !== "dramatic") return;
  if (flags.outcome || flags.pendingOutcome === "complicationFailure") return;

  const helper = flags.entries?.find(e => e.actorId === payload.helperId);
  const helperRs = helper?.roundState;
  if (!helper || !helperRs) return;

  const isBennyReroll = !!payload.isBennyReroll;
  // Bei Benny-Reroll: Helfer hat schon gehandelt (supportGiven existiert), das ist gewollt.
  // Beim Erstwurf: helperRs darf nicht bereits gehandelt haben.
  if (!isBennyReroll) {
    if (helperRs.acted || helperRs.skipped) return;
  } else {
    if (!helperRs.supportGiven) return;
  }

  const target = flags.entries?.find(e => e.actorId === payload.targetId);
  const targetRs = target?.roundState;
  if (!target || !targetRs) return;

  // Patzer-Klassifizierung führt zu Delta -2 (nur Ziel)
  // Erfolg/Misserfolg führt zu Delta 0 / +1 / +2
  // pendingFumbleCheck: Patzer-Prüfung läuft noch — vorläufig delta nach resultTotal,
  //                     der Bonus wird am Ziel mit Skip-Flag belegt (wirkungslos).
  const pendingFumbleCheck = !!payload.pendingFumbleCheck;
  let delta;
  if (payload.critFail) {
    delta = -2;
  } else {
    const total = Number(payload.resultTotal ?? 0);
    if (total < 4) delta = 0;
    else if (total < 8) delta = 1;
    else delta = 2;
  }

  // Bei Benny-Reroll: alten Bonus dieses Helfers aus Ziel-Liste entfernen,
  // bevor Cap-Berechnung läuft.
  const existingBonusesRaw = Array.isArray(targetRs.supportBonuses) ? targetRs.supportBonuses : [];
  const existingBonuses = isBennyReroll
    ? existingBonusesRaw.filter(b => b.helperId !== payload.helperId)
    : existingBonusesRaw;

  // Cap-Berechnung am Ziel: Summe der positiven Deltas <= +4
  const positiveSoFar = existingBonuses.reduce((sum, b) => sum + (b.delta > 0 ? b.delta : 0), 0);
  const newPositive = delta > 0 ? delta : 0;
  const capExceeded = (positiveSoFar + newPositive) > 4;

  // Race-Detection: Hat das Ziel bereits gewürfelt?
  const tooLate = !!(targetRs.acted || targetRs.skipped);

  // ── Benny-Reroll-Schutz (Verschlechterungsschutz für Support-Würfe) ──
  // Analog zu _applyDramaticRollResult (Hauptwurf), aber auf supportGiven (sg).
  // Vergleichsbasis: delta (höher = besser für Ziel).
  //   1. Bestätigter Patzer im Reroll (critFail ohne pendingFumbleCheck) →
  //      Override-Pfad: alter sg-Snapshot in sg.previousRolls, Patzer gilt
  //      (analog _applyDramaticFumbleOverride beim Hauptwurf).
  //   2. newDelta > oldDelta → Verbesserung: alter sg-Snapshot in History,
  //      neuer sg wird unten regulär gebaut.
  //   3. Sonst → Schutz greift: neuer Wurf in sg.previousRolls, alter sg
  //      bleibt unverändert (inkl. targetRs.supportBonuses + capExceeded).
  // Eine Statisten-1 im Reroll (pendingFumbleCheck=true, delta=0) fällt in
  // den Schutz-Pfad. Kein Discarded-Check-Button: der Helfer-Hint wird mit
  // allowDiscardedCheckBtn=false gerendert (siehe Hint-Loop in
  // _enhanceDramaticRequestChat), weil der globale Discarded-Check-Handler
  // nur Hauptwurf-previousRolls am roundState kennt.
  let nextHistoryRolls = [];
  let nextRollSeq = 1;
  let nextNextRollSeq = 2;
  let nextLastRerollProtected = false;
  let nextLastRerollFumbleOverwrite = false;
  if (isBennyReroll) {
    const oldSg = helperRs.supportGiven;
    const oldDelta = Number(oldSg?.delta ?? 0);
    const newDelta = delta;
    const isFumbleOverride = !!payload.critFail && !pendingFumbleCheck;
    nextHistoryRolls = Array.isArray(oldSg?.previousRolls)
      ? [...oldSg.previousRolls]
      : [];
    const currentSeq = oldSg?.rollSeq ?? 1;
    const newSeq = oldSg?.nextRollSeq ?? (nextHistoryRolls.length + 2);

    if (!isFumbleOverride && newDelta <= oldDelta) {
      // ── Schutz greift ──
      // Neuer Wurf wandert in History, alter sg bleibt geltend.
      // targetRs.supportBonuses bleibt komplett unverändert — auch capExceeded,
      // tooLate, delta des alten Bonus behalten ihre Werte.
      nextHistoryRolls.push({
        resultTotal: Number(payload.resultTotal ?? 0),
        diceDetails: payload.diceDetails,
        delta: newDelta,
        critFail: !!payload.critFail,
        pendingFumbleCheck,
        seq: newSeq,
      });
      Object.assign(oldSg, {
        previousRolls: nextHistoryRolls,
        rollSeq: currentSeq,
        nextRollSeq: newSeq + 1,
        lastRerollProtected: true,
        lastRerollFumbleOverwrite: false,
        bennyUsed: true,
      });
      await _updateDramaticTaskMessage(message, flags);
      return;
    }

    // ── Override oder Verbesserung: alter sg-Snapshot in History ──
    // Der neue sg wird im Object.assign-Block unten regulär gebaut; die
    // History-Felder werden über die nextX-Variablen übergeben.
    nextHistoryRolls.push({
      resultTotal: Number(oldSg?.resultTotal ?? 0),
      diceDetails: oldSg?.diceDetails ?? null,
      delta: oldDelta,
      critFail: !!oldSg?.critFail,
      pendingFumbleCheck: !!oldSg?.pendingFumbleCheck,
      seq: currentSeq,
    });
    nextRollSeq = newSeq;
    nextNextRollSeq = newSeq + 1;
    nextLastRerollProtected = false;
    nextLastRerollFumbleOverwrite = isFumbleOverride;
  }

  // Helfer-State setzen
  Object.assign(helperRs, {
    acted: true,
    skipped: false,
    result: null,
    diceDetails: null,
    bennyUsed: false,
    normalMarkersDelta: 0,
    markersDelta: 0,         // Helfer bewegt nie Aufgaben-Marker
    needsFumbleCheck: false,
    pendingFumbleCheck: false,
    fumbleCheckResult: undefined,
    fumbleCheckDie: undefined,
    wasFumble: false,
    complicationFailure: false,
    supportGiven: {
      targetId: payload.targetId,
      targetName: payload.targetName,
      traitType: payload.traitType,
      traitKey: payload.traitKey,
      traitName: payload.traitName,
      resultTotal: Number(payload.resultTotal ?? 0),
      diceDetails: payload.diceDetails,
      critFail: !!payload.critFail,
      fumbleCheckDie: payload.fumbleCheckDie ?? null,
      pendingFumbleCheck,
      delta,
      capExceeded,
      tooLate,
      bennyUsed: isBennyReroll,
      // History-Felder für Verschlechterungsschutz (analog zu Hauptwurf am
      // roundState). Beim Erstwurf leer/initial, bei Override/Verbesserung
      // mit altem sg-Snapshot vorbefüllt (siehe Schutz-Block oben).
      previousRolls: nextHistoryRolls,
      rollSeq: nextRollSeq,
      nextRollSeq: nextNextRollSeq,
      lastRerollProtected: nextLastRerollProtected,
      lastRerollFumbleOverwrite: nextLastRerollFumbleOverwrite,
    },
  });

  // Ziel-State: Bonus anhängen (bei Benny-Reroll: ohne den alten dieses Helfers)
  targetRs.supportBonuses = [
    ...existingBonuses,
    {
      helperId: payload.helperId,
      helperName: payload.helperName,
      traitName: payload.traitName,
      delta,
      critFail: !!payload.critFail,
      pendingFumbleCheck,
      capExceeded,
      tooLate,
    },
  ];

  await _updateDramaticTaskMessage(message, flags);
}

/**
 * Löst eine ausstehende Patzer-Prüfung eines Helfers auf:
 * - Setzt pendingFumbleCheck=false in supportGiven (Helfer) UND supportBonuses (Ziel)
 * - Bei W6=1: critFail=true, delta=-2 (am Ziel)
 * - Bei W6≠1: critFail=false, delta bleibt wie ursprünglich nach resultTotal
 * - Cap-Berechnung am Ziel wird neu gemacht
 */
async function _applyDramaticSupportFumbleCheck(message, helperId, dieTotal) {
  const flags = foundry.utils.deepClone(message.flags[ADR.ID] || {});
  if (flags.mode !== "dramatic") return;

  const helper = flags.entries?.find(e => e.actorId === helperId);
  const helperRs = helper?.roundState;
  const sg = helperRs?.supportGiven;
  if (!sg || !sg.pendingFumbleCheck) return;

  const target = flags.entries?.find(e => e.actorId === sg.targetId);
  const targetRs = target?.roundState;
  if (!target || !targetRs) return;

  const isCritFail = dieTotal === 1;

  // Neues delta — bei critFail -2, sonst aus resultTotal
  let newDelta;
  if (isCritFail) {
    newDelta = -2;
  } else {
    const total = Number(sg.resultTotal ?? 0);
    if (total < 4) newDelta = 0;
    else if (total < 8) newDelta = 1;
    else newDelta = 2;
  }

  // sg aktualisieren
  sg.pendingFumbleCheck = false;
  sg.fumbleCheckDie = dieTotal;
  sg.critFail = isCritFail;
  sg.delta = newDelta;

  // Bonus-Eintrag am Ziel updaten (nur dieser Helfer-Eintrag)
  const bonuses = Array.isArray(targetRs.supportBonuses) ? targetRs.supportBonuses : [];
  const otherBonuses = bonuses.filter(b => b.helperId !== helperId);
  const myBonus = bonuses.find(b => b.helperId === helperId);

  // Cap neu berechnen ohne diesen Eintrag
  const positiveSoFar = otherBonuses.reduce((sum, b) => sum + (b.delta > 0 ? b.delta : 0), 0);
  const newPositive = newDelta > 0 ? newDelta : 0;
  const capExceeded = (positiveSoFar + newPositive) > 4;

  // tooLate: Hat das Ziel schon gewürfelt?
  const tooLate = !!(targetRs.acted || targetRs.skipped);

  const updatedBonus = {
    helperId,
    helperName: myBonus?.helperName ?? helper.actorName ?? "?",
    traitName: myBonus?.traitName ?? sg.traitName,
    delta: newDelta,
    critFail: isCritFail,
    pendingFumbleCheck: false,
    capExceeded,
    tooLate,
  };

  targetRs.supportBonuses = [...otherBonuses, updatedBonus];

  // Auch im sg die finalen Cap/tooLate-Werte spiegeln
  sg.capExceeded = capExceeded;
  sg.tooLate = tooLate;

  await _updateDramaticTaskMessage(message, flags);
}

async function _advanceDramaticTask(message) {
  const flags = foundry.utils.deepClone(message.flags[ADR.ID] || {});
  if (flags.mode !== "dramatic" || flags.outcome) return;

  _recalculateDramaticFlags(flags);

  if (flags.pendingOutcome === "readyNextRound") {
    const nextRound = Number(flags.currentRound ?? 1) + 1;
    // Deck aus flags nehmen (falls vorhanden) — für Bestandsnachrichten ohne Deck
    // fällt advance auf altes Verhalten zurück (frisch mischen pro Runde).
    if (!Array.isArray(flags.deck)) flags.deck = createShuffledDeck();
    flags.entries = advanceDramaticRound(flags.entries, nextRound, flags.deck);
    flags.currentRound = nextRound;
    flags.pendingOutcome = null;
  } else if (flags.pendingOutcome === "complicationFailure" || flags.pendingOutcome === "roundFailure") {
    flags.outcome = "failure";
    flags.failureReason = flags.pendingOutcome === "complicationFailure" ? "complication" : "rounds";
    flags.pendingOutcome = null;
  } else {
    return;
  }

  await _updateDramaticTaskMessage(message, flags);
}

/**
 * Baut den Helfer-Zeilen-HTML-Text aus einem supportGiven-Datensatz (sg).
 *
 * Sprach-neutral: holt die i18n-Keys zum Aufrufzeitpunkt. Wird sowohl
 * serverseitig beim Erstellen/Aktualisieren der Chat-Nachricht aufgerufen
 * (Build-Time) als auch clientseitig im Render-Hook beim Betrachten
 * (Re-Localize-Time). Dadurch sieht jeder Betrachter den Text in seiner
 * eigenen Sprache, statt der GM-Sprache zur Wurf-Zeit.
 */
function _buildDramaticSupportLineHTML(sg) {
  if (!sg) return "";
  const esc = foundry.utils.escapeHTML ?? (s => String(s ?? ""));
  const target = esc(sg.targetName ?? "?");
  const trait = esc(sg.traitName ?? "?");
  const KEY = `${ADR.ID}.requestRoll.dramaticSupport`;

  if (sg.tooLate) {
    return game.i18n.localize(`${KEY}.helperLineTooLate`);
  }
  if (sg.capExceeded) {
    return game.i18n.localize(`${KEY}.helperLineCapExceeded`);
  }
  if (sg.critFail) {
    return game.i18n.format(`${KEY}.helperLineFumble`, { target, trait });
  }
  if (Number(sg.delta) === 0) {
    // Greift auch im pendingFumbleCheck-Zustand (delta=0 bis Check entscheidet) —
    // die normale "erfolglos"-Zeile wird bevorzugt; der Patzer-Button erscheint
    // zusätzlich, damit der GM optional auf kritischen Fehlschlag prüfen kann.
    return game.i18n.format(`${KEY}.helperLineFailure`, { target, trait });
  }
  const d = Number(sg.delta);
  const deltaStr = d > 0 ? `+${d}` : `\u2212${Math.abs(d)}`;
  return game.i18n.format(`${KEY}.helperLineSuccess`, {
    target, trait, delta: deltaStr,
  });
}

/**
 * Baut die "empfangene Support-Zeilen" (Ziel-Sicht) aus dem supportBonuses-Array.
 * Skipped tooLate / capExceeded (werden am Ziel nicht angezeigt). Liefert
 * ein Array von { html, isFumble }. Gleiches Build/Re-Localize-Pattern wie
 * `_buildDramaticSupportLineHTML`.
 */
function _buildDramaticReceivedSupportLines(supportBonuses) {
  const esc = foundry.utils.escapeHTML ?? (s => String(s ?? ""));
  const KEY = `${ADR.ID}.requestRoll.dramaticSupport`;
  const lines = [];
  const arr = Array.isArray(supportBonuses) ? supportBonuses : [];
  for (const b of arr) {
    if (b.tooLate || b.capExceeded) continue;
    const helperName = esc(b.helperName ?? "?");
    if (b.critFail) {
      lines.push({
        html: game.i18n.format(`${KEY}.targetLineFumble`, { helper: helperName }),
        isFumble: true,
      });
    } else if (Number(b.delta) === 0) {
      // Greift auch im pendingFumbleCheck-Zustand: das Ziel sieht
      // "X schafft es nicht zu unterstützen", bis der GM optional einen
      // kritischen Fehlschlag bestätigt.
      lines.push({
        html: game.i18n.format(`${KEY}.targetLineFailure`, { helper: helperName }),
        isFumble: false,
      });
    } else {
      const d = Number(b.delta);
      const deltaStr = d > 0 ? `+${d}` : `\u2212${Math.abs(d)}`;
      lines.push({
        html: game.i18n.format(`${KEY}.targetLineSuccess`, { helper: helperName, delta: deltaStr }),
        isFumble: false,
      });
    }
  }
  return lines;
}

/**
 * Clientseitige Lokalisierung der Dramatischen Aufgabe.
 * 
 * Das HBS-Template wird beim Erstellen der Chat-Nachricht serverseitig vom GM
 * gerendert; alle `{{localize ...}}`-Aufrufe verwenden dabei die GM-Locale, und
 * das Ergebnis-HTML wird in der DB persistiert. Wenn ein Spieler die Nachricht
 * dann in einer anderen Sprache (z. B. EN) betrachtet, sieht er ohne Eingriff
 * die ursprüngliche GM-Sprache.
 *
 * Diese Funktion ersetzt alle statischen Template-Texte des Dramatic-Modus
 * auf dem Client mit der aktuell aktiven Sprache des Betrachters. Sie wird
 * von `_enhanceDramaticRequestChat` direkt aufgerufen.
 *
 * Parallele Funktion `_localizeRequestStrings` deckt die anderen Modi ab
 * (Trait-Die-Label, Roll-Button, Pending) — diese Funktion ergänzt sie
 * gezielt um die Dramatic-spezifischen statischen Texte.
 */
function _localizeDramaticStrings(li, flags) {
  const t = (key) => game.i18n.localize(`${ADR.ID}.requestRoll.${key}`);

  // ── Header: "~ Dramatische Aufgabe ~" ──
  const titleNameEl = li.querySelector(".adr-dramatic-title-line .adr-request-trait-name");
  if (titleNameEl) titleNameEl.textContent = `~ ${t("modeDramatic")} ~`;

  // ── Modifikator-Label im Header ──
  for (const modLabel of li.querySelectorAll(".adr-dramatic-title-line .adr-request-mod-label")) {
    modLabel.textContent = t("modifierLabel");
  }

  // ── Summary-Labels: Runde / Marker (in Reihenfolge) ──
  const summaryLabels = li.querySelectorAll(".adr-dramatic-summary-label");
  if (summaryLabels.length >= 1) summaryLabels[0].textContent = t("dramaticRoundLabel");
  if (summaryLabels.length >= 2) summaryLabels[1].textContent = t("dramaticMarkerLabel");

  // ── Pro Entry: Marker-Texte, Skip-Label, Options, Fumble-Btn, Benny-Tooltip ──
  const markerLabel = t("dramaticMarkerLabel");
  const fumbleBtnText = `${t("fumbleCheckBtn1")} ${t("fumbleCheckBtn2")}`;
  const bennyTip = t("bennyTooltip");
  const bennyNoBennyTip = game.i18n.localize(`${ADR.ID}.chat.critical-failure-no-benny`);

  for (const entry of flags.entries ?? []) {
    const entryEl = li.querySelector(`.adr-dramatic-entry[data-actor-id="${entry.actorId}"]`);
    if (!entryEl) continue;

    // "Kein Erfolg" (marker-zero) — kann mehrfach vorkommen (Fumble-Check-Pfad)
    for (const el of entryEl.querySelectorAll(".adr-dramatic-marker.adr-dramatic-marker-zero")) {
      el.textContent = t("dramaticNoSuccess");
    }

    // "Aufgabe gescheitert" oder "Marker verloren / Letzte Runde" (marker-negative).
    // Unterscheidung: enthält .adr-dramatic-marker-detail → zweizeilige Variante.
    for (const el of entryEl.querySelectorAll(".adr-dramatic-marker.adr-dramatic-marker-negative")) {
      const detailEl = el.querySelector(".adr-dramatic-marker-detail");
      if (detailEl) {
        const titleText = t("dramaticLostMarkerLabelTitle");
        const detailText = t("dramaticLostMarkerLabelDetail");
        el.innerHTML = `${titleText}<br><span class="adr-dramatic-marker-detail">${detailText}</span>`;
      } else {
        el.textContent = t("dramaticTaskFailedLabel");
      }
    }

    // "+N Marker" — .adr-dramatic-marker ohne -zero / -negative.
    // Zahl behalten, Wort dahinter durch lokalisiertes Marker-Label ersetzen.
    for (const el of entryEl.querySelectorAll(".adr-dramatic-marker")) {
      if (el.classList.contains("adr-dramatic-marker-zero")) continue;
      if (el.classList.contains("adr-dramatic-marker-negative")) continue;
      const txt = el.textContent || "";
      const m = txt.match(/^([+-]?\d+)\s+\S+/);
      if (m) el.textContent = `${m[1]} ${markerLabel}`;
    }

    // "Ausgesetzt"
    for (const el of entryEl.querySelectorAll(".adr-dramatic-skipped")) {
      el.textContent = t("dramaticSkippedLabel");
    }

    // Options-Label und Links
    for (const el of entryEl.querySelectorAll(".adr-dramatic-options-label")) {
      el.textContent = t("dramaticOptionsLabel");
    }
    for (const el of entryEl.querySelectorAll(".adr-dramatic-change-trait-link")) {
      el.textContent = t("dramaticChangeTraitButton");
    }
    for (const el of entryEl.querySelectorAll(".adr-dramatic-skip-link")) {
      el.textContent = t("dramaticSkipButton");
    }
    for (const el of entryEl.querySelectorAll(".adr-dramatic-support-link")) {
      el.textContent = t("dramaticSupportButton");
    }

    // Fumble-Check-Buttons im Entry
    for (const btn of entryEl.querySelectorAll(".adr-dramatic-fumble-check-btn")) {
      btn.textContent = fumbleBtnText;
    }

    // Benny-Tooltips. adr-not-mine-Buttons bekommen ihren Tooltip in
    // _enhanceDramaticRequestChat (chatNoPermission) und werden hier nicht
    // überschrieben.
    for (const btn of entryEl.querySelectorAll(".adr-benny-btn")) {
      if (btn.classList.contains("adr-not-mine")) continue;
      btn.title = btn.classList.contains("adr-benny-fumble") ? bennyNoBennyTip : bennyTip;
    }

    // ── Support-Texte (Helfer-Zeile + empfangene Boni) re-lokalisieren ──
    // Die Texte wurden serverseitig vom GM in seiner Sprache als fertiges HTML
    // gebaut und in der Chat-Nachricht persistiert. Hier werden sie aus den
    // strukturierten Daten (roundState.supportGiven / supportBonuses) neu in
    // der Sprache des Betrachters zusammengebaut.
    const rs = entry.roundState ?? {};
    if (rs.supportGiven) {
      const helperLineEl = entryEl.querySelector(".adr-dramatic-support-line");
      if (helperLineEl) {
        helperLineEl.innerHTML = _buildDramaticSupportLineHTML(rs.supportGiven);
      }
    }
    const recLineEls = entryEl.querySelectorAll(".adr-dramatic-received-support-line");
    if (recLineEls.length) {
      const rebuilt = _buildDramaticReceivedSupportLines(rs.supportBonuses);
      for (let i = 0; i < recLineEls.length && i < rebuilt.length; i++) {
        recLineEls[i].innerHTML = rebuilt[i].html;
      }
    }
  }

  // ── History-Bereich: Toggle-Label + Round-Header ──
  const historyContainer = li.querySelector(".adr-dramatic-history-container");
  if (historyContainer) {
    const historyToggle = historyContainer.querySelector(".adr-individual-toggle");
    if (historyToggle) historyToggle.innerHTML = t("dramaticHistoryToggle");

    const roundLabel = t("dramaticRoundLabel");
    for (const roundEl of historyContainer.querySelectorAll(".adr-dramatic-history-round")) {
      const txt = roundEl.textContent || "";
      const m = txt.match(/(\d+)/);
      if (m) roundEl.textContent = `${roundLabel} ${m[1]}`;
    }
  }

  // ── Status-Zeile: kompletter Rebuild über _buildDramaticStatusHTML ──
  const statusEl = li.querySelector(".adr-dramatic-task-status");
  if (statusEl) statusEl.innerHTML = _buildDramaticStatusHTML(flags);

  // ── Advance-Button: "Nächste Runde" oder "Misserfolg bestätigen" ──
  const advanceBtn = li.querySelector(".adr-dramatic-advance-btn");
  if (advanceBtn) {
    advanceBtn.textContent = (flags.pendingOutcome === "readyNextRound")
      ? t("dramaticNextRoundButton")
      : t("dramaticConfirmFailureButton");
  }
}

function _enhanceDramaticRequestChat(li, flags) {
  li.classList.add("adr-dramatic-task-chat");

  // Statische Template-Texte clientseitig in der Sprache des Betrachters
  // setzen (siehe Doc-Comment von _localizeDramaticStrings).
  _localizeDramaticStrings(li, flags);

  for (const entry of flags.entries ?? []) {
    const entryEl = li.querySelector(`.adr-dramatic-entry[data-actor-id="${entry.actorId}"]`);
    if (!entryEl) continue;

    const rs = entry.roundState ?? {};
    const sg = rs.supportGiven;
    const isSupporter = !!sg;
    const ownsActor = entry.ownerIds?.includes(game.user.id) || game.user.isGM;

    // Roll-Button: nur für Hauptwurf-Einträge ausgrauen.
    // Bei Supporter-Einträgen zeigt der Roll-Button das Support-Ergebnis an
    // und ist im Template bereits disabled — keine Berechtigungs-Logik nötig.
    const rollBtn = entryEl.querySelector("[data-action='adr-roll-trait']");
    if (!isSupporter && rollBtn && !ownsActor && (rs.result === null || rs.result === undefined)) {
      rollBtn.classList.add("adr-not-mine");
      rollBtn.title = game.i18n.localize(`${ADR.ID}.requestRoll.chatNoPermission`);
    }

    // Optionen-Container (Eigenschaft ändern, Aussetzen, Unterstützen) für
    // Nicht-Berechtigte ausgrauen — analog zu Roll/Benny-Buttons.
    const optionsEl = entryEl.querySelector(".adr-dramatic-options");
    if (optionsEl && !ownsActor) {
      optionsEl.classList.add("adr-not-mine");
      optionsEl.title = game.i18n.localize(`${ADR.ID}.requestRoll.chatNoPermission`);
    }

    // Benny-Button: berücksichtigt sowohl Hauptwurf-Patzer als auch Support-Patzer.
    const bennyBtn = entryEl.querySelector("[data-action='adr-use-benny']");
    if (bennyBtn) {
      const bennyFumble = rs.wasFumble || rs.fumbleCheckResult === true || (isSupporter && sg.critFail);
      const bennyUsed = isSupporter ? sg.bennyUsed : rs.bennyUsed;

      if (flags.outcome) {
        // Aufgabe abgeschlossen — Benny komplett verstecken (gilt für alle)
        bennyBtn.classList.add("adr-hidden");
      } else if (!ownsActor) {
        // Keine Berechtigung — sichtbar aber ausgegraut, analog zu normalen Proben
        bennyBtn.classList.remove("adr-hidden", "adr-benny-fumble");
        bennyBtn.classList.add("adr-not-mine");
        bennyBtn.disabled = false;
        bennyBtn.title = game.i18n.localize(`${ADR.ID}.requestRoll.chatNoPermission`);
      } else if (bennyFumble) {
        bennyBtn.classList.remove("adr-hidden", "adr-not-mine");
        bennyBtn.classList.add("adr-benny-fumble");
        bennyBtn.disabled = true;
        bennyBtn.title = game.i18n.localize(`${ADR.ID}.chat.critical-failure-no-benny`);
      } else {
        bennyBtn.classList.remove("adr-hidden", "adr-benny-fumble", "adr-not-mine");
        bennyBtn.disabled = false;
        bennyBtn.title = game.i18n.localize(
          entry.isNPC ? `${ADR.ID}.requestRoll.bennyTooltipNPC`
                      : `${ADR.ID}.requestRoll.bennyTooltip`
        );
        if (bennyUsed) bennyBtn.classList.add("adr-benny-used");
      }
    }

    const fumbleBtn = entryEl.querySelector("[data-action='adr-fumble-check-dramatic']");
    if (fumbleBtn && !game.user.isGM) fumbleBtn.classList.add("adr-hidden");

    const supportFumbleBtn = entryEl.querySelector("[data-action='adr-fumble-check-dramatic-support']");
    if (supportFumbleBtn && !game.user.isGM) supportFumbleBtn.classList.add("adr-hidden");

    if (rollBtn && rs.result !== null && rs.result !== undefined) {
      rollBtn.classList.add("adr-rolled");
      rollBtn.disabled = true;
      const isPending = !!rs.pendingFumbleCheck;
      rollBtn.innerHTML = _buildResultHTML(rs.result, rs.wasFumble || rs.fumbleCheckResult === true, isPending);
    }
  }

  const advanceBtn = li.querySelector("[data-action='adr-advance-dramatic-round']");
  if (advanceBtn && !game.user.isGM) advanceBtn.classList.add("adr-hidden");

  // ── Benny-Schutz-/Verbesserungs-Hinweise (Sammelsektion mit Akteurnamen) ──
  // Identisch zur Vergleichenden Probe: gleiche Textbausteine (Named-Varianten),
  // sortiert in der Reihenfolge der Akteure. Wird zwischen den Entries und der
  // History/Status-Section eingefügt. Idempotent: bei jedem Re-Render entfernen,
  // dann neu aufbauen falls Hints anliegen.
  const existingHints = li.querySelector(".adr-dramatic-benny-hints");
  if (existingHints) existingHints.remove();
  {
    const hintBoxes = [];
    for (const entry of flags.entries ?? []) {
      const rs = entry.roundState ?? {};
      const sg = rs.supportGiven;
      let hintEl;
      if (sg) {
        // Helfer-Eintrag: Hint aus supportGiven-History. allowDiscardedCheckBtn
        // ist false, weil der globale Discarded-Check-Handler nur Hauptwurf-
        // previousRolls am roundState kennt — ein Button hier würde ins Leere
        // gehen. Wenn der GM einen verworfenen Support-Reroll-1 nachträglich
        // prüfen will, ist das aktuell nicht vorgesehen (informativ ohnehin
        // belanglos, weil der alte gute Support-Bonus am Ziel bereits geltend).
        hintEl = _buildBennyHintEl(
          entry.actorId,
          entry.isNPC ?? false,
          sg.previousRolls ?? null,
          !!sg.lastRerollProtected,
          entry.actorName ?? null,
          !!sg.lastRerollFumbleOverwrite,
          { allowDiscardedCheckBtn: false },
        );
      } else {
        hintEl = _buildBennyHintEl(
          entry.actorId,
          entry.isNPC ?? false,
          rs.previousRolls ?? null,
          !!rs.lastRerollProtected,
          entry.actorName ?? null,
          !!rs.lastRerollFumbleOverwrite,
        );
      }
      if (hintEl) hintBoxes.push(hintEl);
    }
    if (hintBoxes.length > 0) {
      const wrap = document.createElement("div");
      wrap.className = "adr-dramatic-benny-hints";
      // Kein eigener Divider — der letzte .adr-dramatic-entry hat schon einen
      // `border-bottom` (s. CSS .adr-dramatic-entry:last-child). Doppelter
      // Trennstrich wäre redundant.
      for (const h of hintBoxes) wrap.appendChild(h);
      // Anker: vor History-Container, sonst vor Status-Zeile
      const anchor = li.querySelector(".adr-dramatic-history-container")
        ?? li.querySelector(".adr-request-status.adr-dramatic-task-status");
      if (anchor) anchor.insertAdjacentElement("beforebegin", wrap);
    }
  }

  li.querySelectorAll(".adr-individual-toggle").forEach(toggle => {
    if (!toggle.dataset.adrBound) {
      toggle.dataset.adrBound = "1";
      _attachToggleHandler(toggle);
    }
  });
}

/* ================================================================ */
/*  SWADE-Wurf ausführen (gemeinsam für Roll + Benny)                */
/* ================================================================ */

export async function _executeSWADERoll(actor, entry, modifier, { suppressChat = true } = {}) {
  const rollOptions = {
    additionalMods: modifier ? [{ label: game.i18n.localize(`${ADR.ID}.individualResults.appliedModifierLabel`), value: modifier }] : [],
  };
  if (suppressChat) rollOptions.chatMessage = false;

  let roll;
  if (entry.traitType === "attribute") {
    roll = await actor.rollAttribute(entry.traitKey, rollOptions);
  } else if (entry.traitType === "skill") {
    const skillItem = actor.items.get(entry.traitKey);
    if (skillItem) {
      roll = await actor.rollSkill(skillItem.id, rollOptions);
    } else {
      roll = await actor.makeUnskilledAttempt(rollOptions);
    }
  } else if (entry.traitType === "untrained") {
    roll = await actor.makeUnskilledAttempt(rollOptions);
  }

  // Dice So Nice 3D-Animation manuell auslösen (ChatMessage wird unterdrückt)
  if (roll && game.dice3d) {
    await game.dice3d.showForRoll(roll, game.user, true);
  }

  return roll;
}

/* ================================================================ */
/*  SWADE-Chat-Unterdrückung: Eigene Nachrichten statt SWADE-Default */
/* ================================================================ */

export const _swadeSuppressFlag = { active: false };

Hooks.on("preCreateChatMessage", (message) => {
  if (!_swadeSuppressFlag.active) return;
  // Nur die SWADE-Wurfkarte schlucken — die trägt immer Rolls. Andere
  // Nachrichten desselben Clients (z. B. eine getippte Chatzeile, während
  // der SWADE-Wurf-Dialog offen ist) passieren unverändert und verbrauchen
  // den Einmal-Unterdrücker nicht.
  if (!message.rolls?.length) return;
  _swadeSuppressFlag.active = false;
  return false;  // Nachricht blockieren
});

/* ================================================================ */
/*  Chat-Button Click Handler                                        */
/* ================================================================ */

Hooks.once("ready", () => {

  // ── Socket: GM empfängt Würfelergebnisse von Spielern ──
  // Die Handler machen Read-Modify-Write auf den Message-Flags. Zwei fast
  // gleichzeitige Spieler-Ergebnisse dürfen deshalb nicht parallel laufen —
  // sonst liest der zweite Handler die Flags, bevor das Update des ersten
  // durch ist, und überschreibt dessen Ergebnis. Die Warteschlange
  // serialisiert alle eingehenden Socket-Nachrichten strikt nacheinander.
  let socketQueue = Promise.resolve();
  const handleSocketMessage = async (data) => {
    if (!game.user.isGM) return;

    const message = game.messages.get(data.messageId);
    if (!message) return;

    if (data.action === "dramaticRoll") {
      await _applyDramaticRollResult(message, data.actorId, data.resultTotal, data.diceDetails, { bennyUsed: !!data.bennyUsed });
      return;
    }

    if (data.action === "dramaticSkip") {
      await _applyDramaticSkip(message, data.actorId);
      return;
    }

    if (data.action === "dramaticFumbleCheck") {
      await _applyDramaticFumbleCheck(message, data.actorId, data.dieTotal);
      return;
    }

    if (data.action === "dramaticSupport") {
      await _applyDramaticSupportRoll(message, data.payload);
      return;
    }

    if (data.action === "dramaticTraitOverride") {
      await _applyDramaticTraitOverride(message, data.payload);
      return;
    }

    if (data.action !== "updateRequestRoll") return;

    const entries = foundry.utils.deepClone(message.getFlag(ADR.ID, "entries") || []);

    if (data.bennyUsed) {
      const entry = entries[data.entryIndex];
      // Schutz greift in Single, Group, Opposed (Dramatic kommt hier nie an,
      // s. dramaticRoll-Action oben).
      _applyBennyRerollSingle(entry, data.resultTotal, data.diceDetails);
      entry.bennyUsed = true;
    } else {
      entries[data.entryIndex].result = data.resultTotal;
      if (data.diceDetails) entries[data.entryIndex].diceDetails = data.diceDetails;
      // Sequenznummern für korrekte chronologische Sortierung bei
      // Mehrfach-Bennies. Initialer Wurf hat seq=1; jeder Benny bekommt
      // die nächste freie Nummer via entry.nextRollSeq.
      entries[data.entryIndex].rollSeq = 1;
      entries[data.entryIndex].nextRollSeq = 2;
      const completedCount = (message.getFlag(ADR.ID, "completedCount") || 0) + 1;
      await message.update({
        [`flags.${ADR.ID}.entries`]: entries,
        [`flags.${ADR.ID}.completedCount`]: completedCount,
      });
      setTimeout(() => _refreshRequestChatHTML(message), 150);
      return;
    }

    await message.update({
      [`flags.${ADR.ID}.entries`]: entries,
    });
    setTimeout(() => _refreshRequestChatHTML(message), 150);
  };
  game.socket.on(ADR.SOCKET, (data) => {
    socketQueue = socketQueue
      .then(() => handleSocketMessage(data))
      .catch(err => console.error(`${ADR.ID} | Socket-Handler-Fehler:`, err));
  });

  // ── Würfeln-Button ──
  document.body.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-action='adr-roll-trait']");
    if (!btn) return;

    const messageEl = btn.closest("li.chat-message");
    if (!messageEl) return;
    const messageId = messageEl.dataset.messageId;
    const message = game.messages.get(messageId);
    if (!message) return;

    const flags = message.getFlag(ADR.ID, "requestRoll") ? message.flags[ADR.ID] : null;
    if (!flags) return;

    const actorId = btn.dataset.actorId;
    const entryIndex = flags.entries.findIndex(e => e.actorId === actorId);
    if (entryIndex < 0) return;
    const entry = flags.entries[entryIndex];

    // ── Berechtigung prüfen ──
    if (!entry.ownerIds?.includes(game.user.id) && !game.user.isGM) {
      ui.notifications.warn(game.i18n.localize(`${ADR.ID}.requestRoll.warn.notOwner`));
      return;
    }

    // Ohne verbundenen GM kann das Ergebnis nicht gespeichert werden
    if (!requireActiveGM()) return;

    const isDramatic = flags.mode === "dramatic";
    const roundState = entry.roundState ?? null;

    // ── Bereits gewürfelt? ──
    if (isDramatic) {
      if (!roundState || roundState.acted || roundState.skipped || flags.outcome || flags.pendingOutcome === "complicationFailure") {
        ui.notifications.info(game.i18n.localize(`${ADR.ID}.requestRoll.warn.alreadyRolled`));
        return;
      }
    } else if (entry.result !== null) {
      ui.notifications.info(game.i18n.localize(`${ADR.ID}.requestRoll.warn.alreadyRolled`));
      return;
    }

    // ── SWADE-Wurf ausführen ──
    const actor = _resolveActor(actorId);
    if (!actor) return;

    // ── Effektiver Support-Bonus (nur wirksame Boni: nicht zu spät, nicht über Cap, nicht in Patzer-Prüfung) ──
    let supportBonus = 0;
    if (isDramatic) {
      const bonuses = Array.isArray(roundState?.supportBonuses) ? roundState.supportBonuses : [];
      for (const b of bonuses) {
        if (b.tooLate || b.capExceeded || b.pendingFumbleCheck) continue;
        supportBonus += Number(b.delta) || 0;
      }
    }
    const modifier = (flags.modifier || 0) + (isDramatic ? (roundState?.card?.modifier || 0) : 0) + supportBonus;

    // ── Im Dramatic-Mode: ggf. Trait-Override anwenden ──
    // Pseudo-Entry mit aufgelöstem Trait, damit _executeSWADERoll und der Hook
    // mit der vom Spieler gewählten Eigenschaft arbeiten. Außerhalb von
    // Dramatic bleibt entry unverändert.
    let rollEntry = entry;
    let rollTraitName = entry.traitName;
    let rollTraitType = entry.traitType;
    if (isDramatic) {
      const resolved = _resolveDramaticTrait(entry);
      rollEntry = {
        ...entry,
        traitType: resolved.type,
        traitKey: resolved.key,
        traitName: resolved.name,
      };
      rollTraitName = resolved.name;
      rollTraitType = resolved.type;
    }

    let roll;
    try {
      _swadeSuppressFlag.active = true;
      roll = await _executeSWADERoll(actor, rollEntry, modifier);
    } catch (err) {
      console.error(`${ADR.ID} | Request Roll error:`, err);
      ui.notifications.error(game.i18n.localize(`${ADR.ID}.requestRoll.warn.rollError`));
      return;
    } finally {
      _swadeSuppressFlag.active = false;
    }

    // Falls der Spieler den SWADE-Dialog abgebrochen hat
    if (!roll) return;

    // ── Hook: argas-dice-roller:onTraitRoll ──
    const hookData = {
      roll, actor,
      traitName: rollTraitName, traitType: rollTraitType,
      modifier, requestId: flags.requestId, messageId, entryIndex,
      rollKind: "trait",
    };

    const finalRoll = await _fireTraitRollHook(hookData);
    if (finalRoll === false) return;

    const usedRoll = finalRoll || roll;
    const resultTotal = usedRoll.total ?? roll.total;
    const diceDetails = _extractDiceDetails(usedRoll) || _extractDiceDetails(roll);

    // ── Ergebnis via Socket an GM senden (nur GM darf Nachricht updaten) ──
    if (isDramatic) {
      if (game.user.isGM) {
        await _applyDramaticRollResult(message, actorId, resultTotal, diceDetails);
      } else {
        game.socket.emit(ADR.SOCKET, {
          action: "dramaticRoll",
          messageId, actorId, resultTotal, diceDetails,
        });
      }
      return;
    }

    if (game.user.isGM) {
      await _updateRequestMessage(message, entryIndex, resultTotal, diceDetails);
    } else {
      game.socket.emit(ADR.SOCKET, {
        action: "updateRequestRoll",
        messageId, entryIndex, resultTotal, diceDetails,
      });
    }

    // Lokales visuelles Update
    const isGroup = flags.mode === "group";
    const isOpposed = flags.mode === "opposed";
    _updateEntryDOM(messageEl, actorId, resultTotal, false, diceDetails, isGroup, entry.isNPC ?? false);
    if (isGroup) _updateGroupToggle(messageEl, flags.entries.map((e, i) =>
      i === entryIndex ? { ...e, result: resultTotal, diceDetails } : e
    ));
    if (isOpposed) _updateOpposedToggle(messageEl, flags.entries.map((e, i) =>
      i === entryIndex ? { ...e, result: resultTotal, diceDetails } : e
    ));
    // Nach dem Wurf Chat nach unten scrollen, damit die expandierte Nachricht vollständig sichtbar bleibt
    _scrollChatToEntry(messageEl);
  });

  // ── Benny-Button ──
  document.body.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-action='adr-use-benny']");
    if (!btn) return;

    const messageEl = btn.closest("li.chat-message");
    if (!messageEl) return;
    const messageId = messageEl.dataset.messageId;
    const message = game.messages.get(messageId);
    if (!message) return;

    const flags = message.getFlag(ADR.ID, "requestRoll") ? message.flags[ADR.ID] : null;
    if (!flags) return;

    const actorId = btn.dataset.actorId;
    const entryIndex = flags.entries.findIndex(e => e.actorId === actorId);
    if (entryIndex < 0) return;
    const entry = flags.entries[entryIndex];

    // Berechtigung
    if (!entry.ownerIds?.includes(game.user.id) && !game.user.isGM) return;

    // Ohne verbundenen GM kann das Ergebnis nicht gespeichert werden
    if (!requireActiveGM()) return;

    const isDramatic = flags.mode === "dramatic";
    const dramaticRoundState = entry.roundState ?? null;

    // ── Supporter-Pfad: Helfer hat unterstützt → Support-Wurf neu würfeln ──
    const isSupporterReroll = isDramatic && !!dramaticRoundState?.supportGiven;
    if (isSupporterReroll) {
      const sg = dramaticRoundState.supportGiven;
      // Aufgabe abgeschlossen? Dann Reroll generell sperren.
      // (bennyUsed ist KEIN Blocker — analog zur normalen Probe sind weitere
      // Bennies erlaubt, jeder Reroll kostet einen.)
      if (flags.outcome) return;
      if (sg.critFail) {
        ui.notifications.warn(game.i18n.localize(`${ADR.ID}.chat.critical-failure-no-benny`));
        return;
      }

      const actor = _resolveActor(actorId);
      if (!actor) return;

      // Bennies prüfen via Subject (NSC → GM-Benny, SC → Akteur-Benny).
      const isNPC = !!entry.isNPC;
      const subject = requestRollSubject(actor, isNPC);
      if (!subject) return;
      if (subjectBennies(subject) <= 0) {
        ui.notifications.warn(game.i18n.localize(
          isNPC ? `${ADR.ID}.requestRoll.warn.noGMBennies`
                : `${ADR.ID}.requestRoll.warn.noBennies`
        ));
        return;
      }

      // Ziel + Modifikator wie beim Erstwurf zusammenstellen (Helfer-Karten-Mod
      // + Komplikation des Ziels, kumulativ; Aufgaben-Modifier NICHT auf Support).
      const target = flags.entries?.find(e => e.actorId === sg.targetId);
      const targetRs = target?.roundState;
      if (!target || !targetRs) return;
      const helperCardMod = Number(dramaticRoundState.card?.modifier ?? 0);
      const targetCardMod = targetRs.card?.isComplication
        ? Number(targetRs.card?.modifier ?? 0)
        : 0;
      const supportMod = helperCardMod + targetCardMod;

      const spent = await subjectSpendBenny(subject);
      if (!spent) {
        ui.notifications.warn(game.i18n.localize(
          isNPC ? `${ADR.ID}.requestRoll.warn.noGMBennies`
                : `${ADR.ID}.requestRoll.warn.noBennies`
        ));
        return;
      }

      const pseudoEntry = {
        traitType: sg.traitType,
        traitKey: sg.traitKey,
        traitName: sg.traitName,
      };

      let roll;
      try {
        _swadeSuppressFlag.active = true;
        roll = await _executeSWADERoll(actor, pseudoEntry, supportMod, { suppressChat: false });
      } catch (err) {
        console.error(`${ADR.ID} | Supporter Benny Re-Roll error:`, err);
        ui.notifications.error(game.i18n.localize(`${ADR.ID}.requestRoll.warn.rollError`));
        // Unterdrücker vor dem Refund entschärfen, sonst schluckt er die
        // "Benny erhalten"-Chatnachricht der Rückerstattung
        _swadeSuppressFlag.active = false;
        await subjectRefundBenny(subject);
        return;
      } finally {
        _swadeSuppressFlag.active = false;
      }
      if (!roll) {
        // Wurf-Dialog abgebrochen — Benny zurückerstatten
        await subjectRefundBenny(subject);
        return;
      }

      // Hook (Argas Tweaks etc.)
      const hookData = {
        roll, actor,
        traitName: sg.traitName, traitType: sg.traitType,
        modifier: supportMod, requestId: flags.requestId, messageId, entryIndex,
        isSupportRoll: true, supportTargetId: sg.targetId, isBennyReroll: true,
      };
      const finalRoll = await _fireTraitRollHook(hookData);
      if (finalRoll === false) {
        // Hook hat abgebrochen — Benny zurückerstatten
        await subjectRefundBenny(subject);
        return;
      }
      const usedRoll = finalRoll || roll;

      const resultTotal = usedRoll.total ?? roll.total ?? 0;
      const diceDetails = _extractDiceDetails(usedRoll) || _extractDiceDetails(roll);

      // Patzer-Klassifizierung wie im Erstwurf (isNPC weiter oben deklariert)
      const classification = _classifyFumble(diceDetails, isNPC);
      let critFail = false;
      let pendingFumbleCheck = false;
      let fumbleCheckDie = null;
      if (classification === "confirmed") {
        critFail = true;
      } else if (classification === "needs-check") {
        // GM klickt Button im Chat — hier nur Pending-Marker setzen
        pendingFumbleCheck = true;
      }

      const payload = {
        helperId: actorId,
        helperName: entry.actorName ?? actor.name,
        targetId: sg.targetId,
        targetName: sg.targetName,
        traitType: sg.traitType,
        traitKey: sg.traitKey,
        traitName: sg.traitName,
        resultTotal,
        diceDetails,
        critFail,
        pendingFumbleCheck,
        fumbleCheckDie,
        isBennyReroll: true,
      };

      if (game.user.isGM) {
        await _applyDramaticSupportRoll(message, payload);
      } else {
        game.socket.emit(ADR.SOCKET, {
          action: "dramaticSupport",
          messageId,
          payload,
        });
      }
      return;
    }

    // Noch kein Ergebnis?
    if (isDramatic) {
      if (!dramaticRoundState || dramaticRoundState.result === null || dramaticRoundState.result === undefined || flags.outcome) return;
    } else if (entry.result === null) return;

    // Patzer: kein Benny-Reroll erlaubt. Mechanik-relevant und immer aktiv
    // (analog zum Dramatic-Pfad; das globale Setting `highlightNaturalOnes`
    // steuert nur den freien Wurf-Pfad).
    if (isDramatic) {
      if (dramaticRoundState?.fumbleCheckResult === true || dramaticRoundState?.wasFumble) {
        ui.notifications.warn(game.i18n.localize(`${ADR.ID}.chat.critical-failure-no-benny`));
        return;
      }
    } else {
      // Single/Group/Opposed: Sperre auch wenn der zuletzt verworfene Reroll
      // ein bestätigter Patzer war (Schutz-Pfad). Vgl. _isEntryBennyLocked.
      if (_isEntryBennyLocked(entry)) {
        ui.notifications.warn(game.i18n.localize(`${ADR.ID}.chat.critical-failure-no-benny`));
        return;
      }
    }

    // Actor prüfen
    const actor = _resolveActor(actorId);
    if (!actor) return;

    // Bennies prüfen via Subject (NSC → GM-Benny, SC → Akteur-Benny).
    const isNPC = !!entry.isNPC;
    const subject = requestRollSubject(actor, isNPC);
    if (!subject) return;
    if (subjectBennies(subject) <= 0) {
      ui.notifications.warn(game.i18n.localize(
        isNPC ? `${ADR.ID}.requestRoll.warn.noGMBennies`
              : `${ADR.ID}.requestRoll.warn.noBennies`
      ));
      return;
    }

    // Benny abziehen (SWADE-API: Chat-Nachricht + Dice So Nice; bei GM-Benny
    // wird User.spendBenny() oder Flag-Fallback genutzt — siehe adr-benny-helpers.js).
    const spent = await subjectSpendBenny(subject);
    if (!spent) {
      ui.notifications.warn(game.i18n.localize(
        isNPC ? `${ADR.ID}.requestRoll.warn.noGMBennies`
              : `${ADR.ID}.requestRoll.warn.noBennies`
      ));
      return;
    }

    // Neu würfeln — Dialog anzeigen (Talente können Benny-Bonus geben)
    // ── Effektiver Support-Bonus (nur wirksame Boni) — analog zum Erstwurf ──
    let supportBonusReroll = 0;
    if (isDramatic) {
      const bonuses = Array.isArray(dramaticRoundState?.supportBonuses) ? dramaticRoundState.supportBonuses : [];
      for (const b of bonuses) {
        if (b.tooLate || b.capExceeded || b.pendingFumbleCheck) continue;
        supportBonusReroll += Number(b.delta) || 0;
      }
    }
    const modifier = (flags.modifier || 0) + (isDramatic ? (dramaticRoundState?.card?.modifier || 0) : 0) + supportBonusReroll;
    let roll;
    try {
      _swadeSuppressFlag.active = true;
      roll = await _executeSWADERoll(actor, entry, modifier, { suppressChat: false });
    } catch (err) {
      console.error(`${ADR.ID} | Benny Re-Roll error:`, err);
      ui.notifications.error(game.i18n.localize(`${ADR.ID}.requestRoll.warn.rollError`));
      // Unterdrücker vor dem Refund entschärfen, sonst schluckt er die
      // "Benny erhalten"-Chatnachricht der Rückerstattung
      _swadeSuppressFlag.active = false;
      await subjectRefundBenny(subject);
      return;
    } finally {
      _swadeSuppressFlag.active = false;
    }
    if (!roll) {
      // Wurf-Dialog abgebrochen — Benny zurückerstatten
      await subjectRefundBenny(subject);
      return;
    }

    // ── Hook: argas-dice-roller:onTraitRoll (Argas Tweaks etc.) ──
    const bennyHookData = {
      roll, actor,
      traitName: entry.traitName, traitType: entry.traitType,
      modifier, requestId: flags.requestId, messageId, entryIndex,
      isBennyReroll: true,
      rollKind: "trait",
    };
    const bennyFinalRoll = await _fireTraitRollHook(bennyHookData);
    if (bennyFinalRoll === false) {
      // Hook hat abgebrochen — Benny zurückerstatten
      await subjectRefundBenny(subject);
      return;
    }
    const bennyUsedRoll = bennyFinalRoll || roll;

    const resultTotal = bennyUsedRoll.total ?? roll.total ?? 0;
    const diceDetails = _extractDiceDetails(bennyUsedRoll) || _extractDiceDetails(roll);

    // Ergebnis + bennyUsed via Socket/direkt updaten
    if (isDramatic) {
      if (game.user.isGM) {
        await _applyDramaticRollResult(message, actorId, resultTotal, diceDetails, { bennyUsed: true });
      } else {
        game.socket.emit(ADR.SOCKET, {
          action: "dramaticRoll",
          messageId, actorId, resultTotal, bennyUsed: true, diceDetails,
        });
      }
      return;
    }

    if (game.user.isGM) {
      await _updateRequestMessageBenny(message, entryIndex, resultTotal, diceDetails);
    } else {
      game.socket.emit(ADR.SOCKET, {
        action: "updateRequestRoll",
        messageId, entryIndex, resultTotal, bennyUsed: true, diceDetails,
      });
    }

    // Lokales visuelles Update
    const isGroup = flags.mode === "group";
    const isOpposed = flags.mode === "opposed";

    // Benny-Schutz lokal nachbilden (für Single/Group/Opposed). Bei schlechterem
    // Reroll bleibt das alte Ergebnis geltend — damit nichts zwischen Roll und
    // Refresh auf dem falschen Wert flackert. Dramatic geht über einen eigenen
    // Pfad (return oberhalb) und ist hier nie aktiv.
    let appliedResult = resultTotal;
    let appliedDiceDetails = diceDetails;
    let appliedFumbleCheckResult = undefined;
    let appliedFumbleCheckDie = undefined;
    let appliedPreviousRolls = entry.previousRolls ?? null;
    let appliedLastRerollProtected = false;
    let appliedLastRerollFumbleOverwrite = false;
    {
      const oldResult = Number(entry.result) || 0;
      const newPrevList = Array.isArray(entry.previousRolls)
        ? entry.previousRolls.slice()
        : [];
      // Patzer-Override (Hausregel): bestätigter Patzer im Reroll → Patzer gilt
      const newClassification = _classifyFumble(diceDetails, entry.isNPC ?? false);
      if (newClassification === "confirmed") {
        const histEntry = { result: oldResult, diceDetails: entry.diceDetails };
        if (entry.fumbleCheckResult !== undefined) histEntry.fumbleCheckResult = entry.fumbleCheckResult;
        if (entry.fumbleCheckDie !== undefined) histEntry.fumbleCheckDie = entry.fumbleCheckDie;
        newPrevList.push(histEntry);
        appliedResult = resultTotal;
        appliedDiceDetails = diceDetails;
        appliedLastRerollProtected = false;
        appliedLastRerollFumbleOverwrite = true;
      } else if (resultTotal > oldResult) {
        // Reroll besser → gilt
        const histEntry = { result: oldResult, diceDetails: entry.diceDetails };
        if (entry.fumbleCheckResult !== undefined) histEntry.fumbleCheckResult = entry.fumbleCheckResult;
        if (entry.fumbleCheckDie !== undefined) histEntry.fumbleCheckDie = entry.fumbleCheckDie;
        newPrevList.push(histEntry);
        appliedResult = resultTotal;
        appliedDiceDetails = diceDetails;
        appliedLastRerollProtected = false;
        appliedLastRerollFumbleOverwrite = false;
      } else {
        // Schutz greift: alter Wurf bleibt geltend
        newPrevList.push({ result: resultTotal, diceDetails });
        appliedResult = oldResult;
        appliedDiceDetails = entry.diceDetails;
        // FumbleCheckResult/Die des alten geltenden Wurfs übernehmen, damit
        // _updateEntryDOM einen evtl. schon erfolgten Check nicht verwirft.
        appliedFumbleCheckResult = entry.fumbleCheckResult;
        appliedFumbleCheckDie = entry.fumbleCheckDie;
        appliedLastRerollProtected = true;
        appliedLastRerollFumbleOverwrite = false;
      }
      appliedPreviousRolls = newPrevList;
    }

    _updateEntryDOM(messageEl, actorId, appliedResult, true, appliedDiceDetails, isGroup, entry.isNPC ?? false, appliedFumbleCheckResult, appliedFumbleCheckDie, appliedPreviousRolls, appliedLastRerollProtected, null, false, appliedLastRerollFumbleOverwrite);
    // Toggle bekommt die geltenden Werte (= appliedResult/appliedDiceDetails),
    // plus previousRolls/lastRerollProtected/lastRerollFumbleOverwrite für die
    // Opposed-Sammelsektion.
    const toggleEntries = flags.entries.map((e, i) =>
      i === entryIndex
        ? { ...e, result: appliedResult, bennyUsed: true, diceDetails: appliedDiceDetails, previousRolls: appliedPreviousRolls, lastRerollProtected: appliedLastRerollProtected, lastRerollFumbleOverwrite: appliedLastRerollFumbleOverwrite, fumbleCheckResult: appliedFumbleCheckResult, fumbleCheckDie: appliedFumbleCheckDie }
        : e
    );
    if (isGroup) _updateGroupToggle(messageEl, toggleEntries);
    if (isOpposed) _updateOpposedToggle(messageEl, toggleEntries);
    // Nach Benny-Reroll Chat nach unten scrollen
    _scrollChatToEntry(messageEl);
  });

  // ── Dramatische Aufgabe: Runde aussetzen ──
  document.body.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-action='adr-skip-dramatic']");
    if (!btn) return;

    const messageEl = btn.closest("li.chat-message");
    if (!messageEl) return;
    const messageId = messageEl.dataset.messageId;
    const message = game.messages.get(messageId);
    if (!message) return;

    const flags = message.flags[ADR.ID];
    if (flags?.mode !== "dramatic") return;

    const actorId = btn.dataset.actorId;
    const entry = flags.entries?.find(e => e.actorId === actorId);
    if (!entry) return;
    if (!entry.ownerIds?.includes(game.user.id) && !game.user.isGM) return;
    if (!requireActiveGM()) return;

    if (game.user.isGM) {
      await _applyDramaticSkip(message, actorId);
    } else {
      game.socket.emit(ADR.SOCKET, {
        action: "dramaticSkip",
        messageId, actorId,
      });
    }
  });

  // ── Dramatische Aufgabe: Unterstützen-Dialog öffnen ──
  document.body.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-action='adr-open-support']");
    if (!btn) return;
    ev.preventDefault();

    const messageEl = btn.closest("li.chat-message");
    if (!messageEl) return;
    const messageId = messageEl.dataset.messageId;
    const message = game.messages.get(messageId);
    if (!message) return;

    const flags = message.flags[ADR.ID];
    if (flags?.mode !== "dramatic") return;

    const helperId = btn.dataset.actorId;
    const helperEntry = flags.entries?.find(e => e.actorId === helperId);
    if (!helperEntry) return;

    // Berechtigung: Nur Eigentümer des Helfer-Charakters (bzw. GM) darf unterstützen
    if (!helperEntry.ownerIds?.includes(game.user.id) && !game.user.isGM) {
      ui.notifications.warn(game.i18n.localize(`${ADR.ID}.requestRoll.warn.notOwner`));
      return;
    }

    // Prüfen, ob überhaupt ein Ziel zum Unterstützen offen ist
    const availableTargets = (flags.entries ?? []).filter(e => {
      if (e.actorId === helperId) return false;
      const rs = e.roundState;
      if (!rs) return false;
      if (rs.acted) return false;
      if (rs.skipped) return false;
      if (rs.result !== null && rs.result !== undefined) return false;
      return true;
    });

    if (availableTargets.length === 0) {
      ui.notifications.warn(game.i18n.localize(`${ADR.ID}.requestRoll.dramaticSupport.noLongerPossible`));
      return;
    }

    // Dialog öffnen
    const dialog = new SupportDialogForm({ messageId, helperId });
    dialog.render(true);
  });

  // ── Dramatische Aufgabe: Eigenschaft ändern ──
  document.body.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-action='adr-change-trait-dramatic']");
    if (!btn) return;
    ev.preventDefault();

    const messageEl = btn.closest("li.chat-message");
    if (!messageEl) return;
    const messageId = messageEl.dataset.messageId;
    const message = game.messages.get(messageId);
    if (!message) return;

    const flags = message.flags[ADR.ID];
    if (flags?.mode !== "dramatic") return;
    if (flags.outcome || flags.pendingOutcome === "complicationFailure") return;

    const actorId = btn.dataset.actorId;
    const entry = flags.entries?.find(e => e.actorId === actorId);
    if (!entry) return;

    // Berechtigung: Nur Eigentümer des Charakters (bzw. GM)
    if (!entry.ownerIds?.includes(game.user.id) && !game.user.isGM) {
      ui.notifications.warn(game.i18n.localize(`${ADR.ID}.requestRoll.warn.notOwner`));
      return;
    }

    // Runde noch offen?
    const rs = entry.roundState;
    if (!rs || rs.acted || rs.skipped || (rs.result !== null && rs.result !== undefined)) {
      ui.notifications.info(game.i18n.localize(`${ADR.ID}.requestRoll.dramaticChangeTrait.noLongerPossible`));
      return;
    }

    // Dialog öffnen
    const dialog = new ChangeTraitDialogForm({ messageId, actorId });
    dialog.render(true);
  });

  // ── Dramatische Aufgabe: Nächste Runde / Scheitern bestätigen ──
  document.body.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-action='adr-advance-dramatic-round']");
    if (!btn || !game.user.isGM) return;

    const messageEl = btn.closest("li.chat-message");
    if (!messageEl) return;
    const messageId = messageEl.dataset.messageId;
    const message = game.messages.get(messageId);
    if (!message) return;

    await _advanceDramaticTask(message);
  });

  // ── Patzer-Prüfung (GM-Button: W6 würfeln) ──
  document.body.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-action='adr-fumble-check'], [data-action='adr-fumble-check-discarded'], [data-action='adr-fumble-check-dramatic'], [data-action='adr-fumble-check-dramatic-support']");
    if (!btn) return;
    if (!game.user.isGM) return;

    const messageEl = btn.closest("li.chat-message");
    if (!messageEl) return;
    const messageId = messageEl.dataset.messageId;
    const message = game.messages.get(messageId);
    if (!message) return;

    const actorId = btn.dataset.actorId;
    const flags = message.flags[ADR.ID];
    if (!flags?.entries) return;

    // W6 würfeln
    const roll = new Roll("1d6");
    await roll.evaluate();

    // Hook für Tweaks-Integration feuern (analog freier Wurf). Greift für alle
    // vier Patzer-Check-Pfade (regulär, discarded, dramatic, dramatic-support).
    // Tweaks-GM-Dialog kann den W6 manipulieren, bevor wir das Ergebnis anwenden.
    const fumbleEntry = flags.entries.find(e => e.actorId === actorId);
    const fumbleEntryIndex = flags.entries.findIndex(e => e.actorId === actorId);
    const fumbleActorName = fumbleEntry?.actorName || "";
    const fumbleHookData = {
      roll,
      actor: { name: fumbleActorName },
      traitName: game.i18n.localize(`${ADR.ID}.chat.fumbleCheckName`),
      traitType: "w6",
      modifier: 0,
      requestId: flags.requestId ?? null,
      messageId: message.id,
      entryIndex: fumbleEntryIndex >= 0 ? fumbleEntryIndex : null,
      rollKind: "fumble-check",
      exploding: false,
      hasWildDie: false,
      fumbleMechanic: false,
    };
    const fumbleFinalRoll = await _fireTraitRollHook(fumbleHookData);
    if (fumbleFinalRoll === false) return;  // Hook hat abgebrochen

    // Total neu berechnen (Tweaks könnte den Würfel-Wert manipuliert haben)
    if (roll?.dice?.length) {
      const sum = roll.dice[0].results.reduce((a, r) => a + (r.result || 0), 0);
      roll._total = sum;
    }

    // Dice So Nice 3D-Animation
    if (game.dice3d) {
      await game.dice3d.showForRoll(roll, game.user, true);
    }

    // Support-Patzer-Check (Helfer): eigener Pfad
    if (btn.dataset.action === "adr-fumble-check-dramatic-support") {
      await _applyDramaticSupportFumbleCheck(message, actorId, roll.total);
      return;
    }

    // Patzer-Check für letzten verworfenen Wurf (Benny-Reroll-Schutz).
    // Muss VOR der Dramatic-Weiche stehen, weil der Discarded-Btn auch in
    // der Dramatischen Aufgabe vorkommt — der reguläre Dramatic-Fumble-Check-
    // Pfad gilt nur für `adr-fumble-check-dramatic`, nicht `…-discarded`.
    if (btn.dataset.action === "adr-fumble-check-discarded") {
      const entryIndex = flags.entries.findIndex(e => e.actorId === actorId);
      if (entryIndex < 0) return;
      const isDramatic = flags.mode === "dramatic";
      if (isDramatic) {
        // Dramatic: previousRolls hängt am roundState (runden-lokal).
        // Bei W6=1 (Patzer bestätigt) wird der verworfene Reroll-1 nachträglich
        // zum geltenden Wurf mit −1 Marker (Override-Swap, analog zu sofort-
        // confirmed Wildcard-Patzer). Bei W6>1 bleibt der alte Wurf geltend,
        // nur das Check-Ergebnis wird markiert.
        const flagsClone = foundry.utils.deepClone(message.flags[ADR.ID] || {});
        const entry = flagsClone.entries?.[entryIndex];
        const rs = entry?.roundState;
        if (!rs || !Array.isArray(rs.previousRolls) || rs.previousRolls.length === 0) return;
        const lastIdx = rs.previousRolls.length - 1;
        if (roll.total === 1) {
          // Override: verworfenen Reroll-1 aus previousRolls nehmen und als
          // geltenden Patzer-Wurf setzen. _applyDramaticFumbleOverride schiebt
          // den aktuellen rs (alter, positiver Wurf) in previousRolls.
          const confirmedRoll = rs.previousRolls.splice(lastIdx, 1)[0];
          confirmedRoll.fumbleCheckResult = true;
          confirmedRoll.fumbleCheckDie = roll.total;
          _applyDramaticFumbleOverride(rs, entry, confirmedRoll);
        } else {
          // Kein Patzer: alter Wurf bleibt, Check-Ergebnis informativ markieren.
          rs.previousRolls[lastIdx].fumbleCheckResult = false;
          rs.previousRolls[lastIdx].fumbleCheckDie = roll.total;
        }
        await _updateDramaticTaskMessage(message, flagsClone);
      } else {
        // Single/Group/Opposed: previousRolls direkt auf entry. Bei W6=1
        // (Patzer bestätigt) wird der verworfene Reroll nachträglich zum
        // geltenden Patzer-Wurf — analog zum sofort-confirmed Wildcard-Pfad
        // in _applyBennyRerollSingle. Bei W6>1 bleibt der alte Wurf geltend,
        // Check-Ergebnis wird nur informativ markiert.
        const entries = foundry.utils.deepClone(flags.entries);
        const entry = entries[entryIndex];
        if (!Array.isArray(entry.previousRolls) || entry.previousRolls.length === 0) return;
        const lastIdx = entry.previousRolls.length - 1;
        if (roll.total === 1) {
          // Override-Swap: verworfenen Reroll als geltenden Patzer-Wurf setzen,
          // alter geltender (guter) Wurf wandert mit seiner Seq in previousRolls.
          const confirmedRoll = entry.previousRolls.splice(lastIdx, 1)[0];
          const currentSeq = entry.rollSeq ?? 1;
          const histEntry = { result: Number(entry.result) || 0, diceDetails: entry.diceDetails, seq: currentSeq };
          if (entry.fumbleCheckResult !== undefined) histEntry.fumbleCheckResult = entry.fumbleCheckResult;
          if (entry.fumbleCheckDie !== undefined) histEntry.fumbleCheckDie = entry.fumbleCheckDie;
          entry.previousRolls.push(histEntry);

          // Patzer-Wurf übernimmt
          entry.result = confirmedRoll.result;
          entry.diceDetails = confirmedRoll.diceDetails;
          entry.rollSeq = confirmedRoll.seq ?? (entry.nextRollSeq ?? (entry.previousRolls.length + 1));
          entry.nextRollSeq = Math.max(entry.nextRollSeq ?? 0, (entry.rollSeq ?? 1) + 1);
          entry.fumbleCheckResult = true;
          entry.fumbleCheckDie = roll.total;
          entry.lastRerollProtected = false;
          entry.lastRerollFumbleOverwrite = true;
          delete entry.fumbleCheckAccepted;
        } else {
          // Kein Patzer: alter Wurf bleibt, Check-Ergebnis informativ markieren.
          entry.previousRolls[lastIdx].fumbleCheckResult = false;
          entry.previousRolls[lastIdx].fumbleCheckDie = roll.total;
        }
        await message.update({
          [`flags.${ADR.ID}.entries`]: entries,
        });
        setTimeout(() => _refreshRequestChatHTML(message), 150);
      }
      return;
    }

    if (flags.mode === "dramatic") {
      await _applyDramaticFumbleCheck(message, actorId, roll.total);
      return;
    }

    const entryIndex = flags.entries.findIndex(e => e.actorId === actorId);
    if (entryIndex < 0) return;

    // Entry-Flags aktualisieren
    const entries = foundry.utils.deepClone(flags.entries);
    entries[entryIndex].fumbleCheckResult = roll.total === 1;
    entries[entryIndex].fumbleCheckDie = roll.total;
    await message.update({
      [`flags.${ADR.ID}.entries`]: entries,
    });

    setTimeout(() => _refreshRequestChatHTML(message), 150);
  });

  // ── Patzer-Annahme (GM-Button: 1 als reguläres Ergebnis akzeptieren) ──
  // Pendant zu adr-fumble-accept-main im freien Wurf: GM entscheidet sich
  // gegen die W6-Patzer-Prüfung und nimmt die 1 als reguläres Würfelergebnis.
  // Folge-Render zeigt weder Patzer-Label noch „Kein Erfolg".
  document.body.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-action='adr-fumble-accept']");
    if (!btn || !game.user.isGM) return;

    const messageEl = btn.closest("li.chat-message");
    if (!messageEl) return;
    const messageId = messageEl.dataset.messageId;
    const message = game.messages.get(messageId);
    if (!message) return;

    const actorId = btn.dataset.actorId;
    const flags = message.flags[ADR.ID];
    if (!flags?.entries) return;

    // Dramatic-Mode hat eigenen Pfad (eigene DOM-Struktur, kein _updateEntryDOM).
    if (flags.mode === "dramatic") return;

    const entryIndex = flags.entries.findIndex(e => e.actorId === actorId);
    if (entryIndex < 0) return;

    const entries = foundry.utils.deepClone(flags.entries);
    entries[entryIndex].fumbleCheckAccepted = true;
    await message.update({
      [`flags.${ADR.ID}.entries`]: entries,
    });

    setTimeout(() => _refreshRequestChatHTML(message), 150);
  });

  // ── Klick auf Akteur-Bild im Chat: PC → Charakter-Sheet, NSC → Token-Sheet/Canvas ──
  document.body.addEventListener("click", async (ev) => {
    const img = ev.target.closest(".adr-request-actor-img, .adr-dramatic-entry-img");
    if (!img) return;

    const messageEl = img.closest("li.chat-message");
    if (!messageEl) return;
    const messageId = messageEl.dataset.messageId;
    const message = game.messages.get(messageId);
    if (!message) return;

    const flags = message.flags[ADR.ID];
    if (!flags?.entries) return;

    const entryEl = img.closest(".adr-request-entry, .adr-dramatic-entry");
    const actorId = entryEl?.dataset.actorId;
    if (!actorId) return;

    const entry = flags.entries.find(e => e.actorId === actorId);
    if (!entry) return;

    ev.preventDefault();
    ev.stopPropagation();

    // Nur Token-Auswahl + Canvas-Pan, kein Sheet öffnen.
    // Strategie: Token in der aktiven Szene zum Actor finden. Bei NSCs ist
    // actorId die Token-Document-ID (Szenen-Instanz), bei SCs die Actor-ID.
    let token = canvas?.tokens?.placeables?.find(t => t.document?.id === actorId);
    if (!token) {
      token = canvas?.tokens?.placeables?.find(t => t.actor?.id === actorId);
    }
    if (token) {
      token.control({ releaseOthers: true });
      await canvas.animatePan({ x: token.center.x, y: token.center.y, duration: 250 });
    }
    // Fallback: kein Token in aktueller Szene → still bleiben (keine Sheet-Öffnung).
  });
});

/* ================================================================ */
/*  Hook: argas-dice-roller:onTraitRoll                              */
/* ================================================================ */

export function _fireTraitRollHook(hookData) {
  return new Promise((resolve) => {
    let handled = false;

    const data = {
      ...hookData,
      resolve: (modifiedRoll) => { handled = true; resolve(modifiedRoll); },
      reject: () => { handled = true; resolve(false); },
    };

    const result = Hooks.call("argas-dice-roller:onTraitRoll", data);

    // Kein Listener hat den Hook abgefangen → sofort mit Original fortfahren.
    // Hat ein Listener abgefangen (Rückgabe false), wird so lange gewartet,
    // bis er `resolve`/`reject` ruft — kein Timeout, der Wurf wartet auf den GM.
    if (result !== false && !handled) {
      resolve(null);
    }
  });
}

/* ================================================================ */
/*  Hilfsfunktionen                                                  */
/* ================================================================ */

async function _updateRequestMessage(message, entryIndex, resultTotal, diceDetails) {
  const entries = foundry.utils.deepClone(message.getFlag(ADR.ID, "entries") || []);
  const completedCount = (message.getFlag(ADR.ID, "completedCount") || 0) + 1;
  entries[entryIndex].result = resultTotal;
  if (diceDetails) entries[entryIndex].diceDetails = diceDetails;

  await message.update({
    [`flags.${ADR.ID}.entries`]: entries,
    [`flags.${ADR.ID}.completedCount`]: completedCount,
  });

  _refreshRequestChatHTML(message);
}

/**
 * Wendet den Benny-Reroll-Schutz im Single-Mode an. Mutiert das entry-Objekt.
 *
 * SWADE-Regel (mit Argas Auslegung für individuelle Probe):
 * - Benny-Reroll kann das Ergebnis nicht verschlechtern.
 * - Schutz greift in der individuellen Probe IMMER bei schlechterem Reroll —
 *   auch bei Wildcard-Patzer (rein informativ).
 * - Bei Statisten ist eine 1 standardmässig nur ein Fehlschlag (kein Patzer);
 *   GM kann via W6 prüfen, ob's doch ein Patzer war (rein informativ, ändert
 *   das geltende Ergebnis nicht).
 * - Vergleichsbasis bei Mehrfach-Reroll: aktuell gehaltener (=bisher bester)
 *   Wert.
 *
 * Datenmodell:
 *   entry.previousRolls = [{ result, diceDetails, fumbleCheckResult?, fumbleCheckDie? }, ...]
 *     – chronologische Liste verworfener Würfe (in Reihenfolge der Verwerfung)
 *   entry.lastRerollProtected = boolean
 *     – true: letzter Reroll war schlechter, alter Wurf wurde gehalten
 *     – false: letzter Reroll hat verbessert, alter Wurf wandert in History
 *
 * @param {object} entry            – wird mutiert
 * @param {number} newResult        – Total des neuen Wurfs
 * @param {object} newDiceDetails   – Würfeldetails des neuen Wurfs
 */
function _applyBennyRerollSingle(entry, newResult, newDiceDetails) {
  const oldResult = Number(entry.result) || 0;
  const oldDiceDetails = entry.diceDetails;
  const oldFumbleCheckResult = entry.fumbleCheckResult;
  const oldFumbleCheckDie = entry.fumbleCheckDie;

  if (!Array.isArray(entry.previousRolls)) entry.previousRolls = [];

  // ── Sequenznummer-Tracking (für chronologische Sortierung) ──
  // Fallback: Legacy-Entries ohne rollSeq/nextRollSeq bekommen Standardwerte.
  const currentSeq = entry.rollSeq ?? 1;
  const newSeq = entry.nextRollSeq ?? (entry.previousRolls.length + 2);
  entry.nextRollSeq = newSeq + 1;

  // ── Patzer-Override-Pfad (Hausregel) ──
  // Reroll-Patzer übersteuert den Verschlechterungsschutz: alter (guter) Wurf
  // wandert in previousRolls, neuer Patzer-Wurf wird zum geltenden mit roter 1.
  // Greift sofort bei Wildcard-Patzer ("confirmed"). Bei Statist-1 ("needs-check")
  // erst nach W6-Discarded-Check (siehe Handler).
  const newClassification = _classifyFumble(newDiceDetails, entry.isNPC);
  if (newClassification === "confirmed") {
    // Alter (guter) Wurf in previousRolls
    const histEntry = { result: oldResult, diceDetails: oldDiceDetails, seq: currentSeq };
    if (oldFumbleCheckResult !== undefined) histEntry.fumbleCheckResult = oldFumbleCheckResult;
    if (oldFumbleCheckDie !== undefined) histEntry.fumbleCheckDie = oldFumbleCheckDie;
    entry.previousRolls.push(histEntry);

    // Patzer-Wurf wird zum geltenden
    entry.result = newResult;
    if (newDiceDetails) entry.diceDetails = newDiceDetails;
    entry.rollSeq = newSeq;
    entry.lastRerollProtected = false;
    entry.lastRerollFumbleOverwrite = true;
    delete entry.fumbleCheckResult;
    delete entry.fumbleCheckDie;
    delete entry.fumbleCheckAccepted;
    return;
  }

  if (newResult > oldResult) {
    // Reroll besser → gilt; alter Wurf wandert in History mit seiner Seq
    const histEntry = { result: oldResult, diceDetails: oldDiceDetails, seq: currentSeq };
    if (oldFumbleCheckResult !== undefined) histEntry.fumbleCheckResult = oldFumbleCheckResult;
    if (oldFumbleCheckDie !== undefined) histEntry.fumbleCheckDie = oldFumbleCheckDie;
    entry.previousRolls.push(histEntry);

    entry.result = newResult;
    if (newDiceDetails) entry.diceDetails = newDiceDetails;
    entry.rollSeq = newSeq;
    entry.lastRerollProtected = false;
    entry.lastRerollFumbleOverwrite = false;
    delete entry.fumbleCheckResult;
    delete entry.fumbleCheckDie;
    delete entry.fumbleCheckAccepted;
  } else {
    // Schutz greift: alter Wurf bleibt; neuer Wurf wandert in History mit neuer Seq
    entry.previousRolls.push({ result: newResult, diceDetails: newDiceDetails, seq: newSeq });
    entry.lastRerollProtected = true;
    entry.lastRerollFumbleOverwrite = false;
    // entry.result bleibt; entry.rollSeq bleibt
    // fumbleCheckResult/Die/Accepted für den geltenden Wurf bleiben (falls schon gesetzt)
  }
}

async function _updateRequestMessageBenny(message, entryIndex, resultTotal, diceDetails) {
  const entries = foundry.utils.deepClone(message.getFlag(ADR.ID, "entries") || []);
  const entry = entries[entryIndex];

  // Schutz greift in Single, Group, Opposed (Dramatic läuft NICHT durch diese
  // Funktion, sondern über _applyDramaticRollResult).
  _applyBennyRerollSingle(entry, resultTotal, diceDetails);
  entry.bennyUsed = true;

  await message.update({
    [`flags.${ADR.ID}.entries`]: entries,
  });

  _refreshRequestChatHTML(message);
}

/**
 * Baut die Benny-Hinweis-Zeile als DOM-Element (oder gibt `null` zurück, wenn
 * kein Hinweis nötig ist). Wird sowohl aus `_updateEntryDOM` (pro Entry,
 * Single/Group) als auch aus `_updateOpposedToggle` (Sammelsektion mit
 * Akteurname) aufgerufen.
 *
 * @param {string}   actorId             – data-actor-id für Discarded-Check-Btn
 * @param {boolean}  isNPC               – beeinflusst Patzer-Klassifikation
 * @param {Array}    previousRolls       – Liste verworfener Würfe
 * @param {boolean}  lastRerollProtected – Schutz hat zuletzt gegriffen
 * @param {string|null} namedActor       – wenn gesetzt: Named-Varianten der i18n-Keys
 *                                          nutzen und `{actor}` durch diesen Namen ersetzen
 * @param {boolean}  lastRerollFumbleOverwrite – Reroll war bestätigter Patzer und
 *                                          überschreibt das alte Ergebnis (Dramatic-spezifisch)
 * @returns {HTMLDivElement|null}
 */
function _buildBennyHintEl(actorId, isNPC, previousRolls, lastRerollProtected, namedActor = null, lastRerollFumbleOverwrite = false, opts = {}) {
  // opts.allowDiscardedCheckBtn (default true): wenn false, wird bei Statisten-1
  // im verworfenen Wurf KEIN nachträglicher Patzer-Check-Button gerendert. Nötig
  // für den Dramatic-Support-Hint, weil der Discarded-Check-Handler nur Haupt-
  // wurf-previousRolls am roundState kennt — ein Klick auf einen Support-Hint-
  // Button würde ins Leere laufen oder die falsche History anfassen.
  const allowDiscardedCheckBtn = opts.allowDiscardedCheckBtn !== false;
  if (!Array.isArray(previousRolls) || previousRolls.length === 0) return null;

  const rerollNum = previousRolls.length;
  const useCounter = rerollNum >= 2;
  const lang = game.i18n?.lang || "de";
  let ordinal = String(rerollNum);
  if (lang.startsWith("en")) {
    const m10 = rerollNum % 10, m100 = rerollNum % 100;
    if (m10 === 1 && m100 !== 11) ordinal = `${rerollNum}st`;
    else if (m10 === 2 && m100 !== 12) ordinal = `${rerollNum}nd`;
    else if (m10 === 3 && m100 !== 13) ordinal = `${rerollNum}rd`;
    else ordinal = `${rerollNum}th`;
  }

  // Key-Auflösung: ggf. Named-Variante + ggf. N-Suffix + Counter-/Actor-Substitution.
  // `allowNamed: false` erzwingt die generische Variante (ohne Akteur-Bezug) — nötig
  // für Sub-Texte, die als generischer Zusatz unter einer namedActor-Zeile stehen.
  const localizeHint = (base, { withCounter = true, allowNamed = true } = {}) => {
    const namedSuffix = (allowNamed && namedActor) ? "Named" : "";
    const counterSuffix = (withCounter && useCounter) ? "N" : "";
    const key = `${base}${namedSuffix}${counterSuffix}`;
    let tmpl = game.i18n.localize(`${ADR.ID}.requestRoll.${key}`);
    if (withCounter && useCounter) tmpl = tmpl.replace("{n}", ordinal);
    // Akteurname escapen — das Ergebnis landet per innerHTML im Chat
    if (allowNamed && namedActor) tmpl = tmpl.replace("{actor}", foundry.utils.escapeHTML(namedActor));
    return tmpl;
  };

  const hintEl = document.createElement("div");
  hintEl.className = "adr-benny-protected-hint";

  let hintHTML;
  let needsDiscardedCheckBtn = false;
  let lastDiscarded = null;

  if (lastRerollFumbleOverwrite) {
    // ── Patzer-Override-Pfad (Dramatic): Reroll war bestätigter Patzer.
    // Alter Wurf wurde verworfen, der Patzer gilt mit −1 Marker. Die Marker-
    // Strafe wird oben am Spieler-Block ohnehin als Marker-Zeile ausgegeben
    // (Template-Pfad: `roundState.markersDelta === -1` → "Marker verloren"),
    // hier daher KEINE separate Marker-Subzeile, nur der Patzer-Text.
    hintHTML = `<div class="adr-benny-protected-line adr-benny-protected-fumble">`
      + `${localizeHint("bennyProtectedHintFumble")}</div>`;
  } else if (lastRerollProtected) {
    // ── Schutz-Pfad ──
    lastDiscarded = previousRolls[previousRolls.length - 1];
    const discardedClass = lastDiscarded?.diceDetails
      ? _classifyFumble(lastDiscarded.diceDetails, isNPC)
      : "none";

    if (discardedClass === "confirmed") {
      // Wildcard-Patzer beim verworfenen Wurf: nur die rote Patzer-Zeile.
      hintHTML = `<div class="adr-benny-protected-line adr-benny-protected-fumble">`
        + `${localizeHint("bennyProtectedHintFumble")}</div>`;
    } else {
      // Standardfall (kein Patzer am verworfenen Wurf) oder Statisten-1:
      // Standardzeile + ggf. Zusatzzeile/Check.
      hintHTML = `<div class="adr-benny-protected-line">${localizeHint("bennyProtectedHint")}</div>`;

      if (discardedClass === "needs-check") {
        // Statisten-1 beim verworfenen Wurf — Check optional, Ergebnis (falls geprüft)
        const dcr = lastDiscarded.fumbleCheckResult;
        hintHTML += `<div class="adr-benny-protected-line adr-benny-protected-extra-one">`
          + `${localizeHint("bennyProtectedHintExtraOne", { withCounter: false })}</div>`;
        if (dcr === true || dcr === false) {
          const tmplKey = dcr
            ? `${ADR.ID}.requestRoll.fumbleCheckTextYes`
            : `${ADR.ID}.requestRoll.fumbleCheckTextNo`;
          const keyword = dcr
            ? game.i18n.localize(`${ADR.ID}.requestRoll.fumbleCheckYes`)
            : game.i18n.localize(`${ADR.ID}.requestRoll.fumbleCheckNone`);
          const cls = dcr ? "adr-fumble-confirmed-text" : "adr-fumble-denied-text";
          const tmpl = game.i18n.localize(tmplKey);
          hintHTML += `<div class="adr-benny-protected-check-result">`
            + tmpl.replace("{result}", `<span class="${cls}">${keyword}</span>`)
            + `</div>`;
        } else {
          needsDiscardedCheckBtn = true;
        }
      }
    }
  } else {
    // ── Verbesserungs-Pfad (neuer Wurf war besser) ──
    hintHTML = `<div class="adr-benny-protected-line">${localizeHint("bennyImprovedHint")}</div>`;
  }

  hintEl.innerHTML = hintHTML;

  // Patzer-Check-Button anhängen wenn Statisten-1 noch nicht geprüft.
  // Bei allowDiscardedCheckBtn=false (Support-Hint) Button unterdrücken.
  if (needsDiscardedCheckBtn && allowDiscardedCheckBtn) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "adr-fumble-check-btn adr-fumble-check-discarded-btn";
    btn.dataset.action = "adr-fumble-check-discarded";
    btn.dataset.actorId = actorId;
    const line1 = game.i18n.localize(`${ADR.ID}.requestRoll.fumbleCheckBtn1`);
    const line2 = game.i18n.localize(`${ADR.ID}.requestRoll.fumbleCheckBtn2`);
    btn.innerHTML = `${line1} ${line2}`;
    if (!game.user.isGM) {
      btn.classList.add("adr-not-mine");
      btn.title = game.i18n.localize(`${ADR.ID}.requestRoll.chatNoPermission`);
      btn.style.setProperty("cursor", "not-allowed", "important");
    }
    hintEl.appendChild(btn);
  }

  return hintEl;
}

/**
 * Ein einzelnes Entry im DOM aktualisieren (lokales visuelles Update).
 *
 * @param {HTMLElement} container      – li.chat-message
 * @param {string}      actorId
 * @param {number}      result
 * @param {boolean}     bennyUsed
 * @param {object}      diceDetails
 * @param {boolean}     isGroup
 * @param {boolean}     isNPC          – true = Nicht-SC
 * @param {boolean|undefined} fumbleCheckResult – true/false nach GM-Prüfung, undefined = nicht geprüft
 * @param {number|undefined}  fumbleCheckDie    – W6-Ergebnis der GM-Prüfung
 * @param {Array|null}        previousRolls     – Liste verworfener Würfe (Single-Mode-Reroll-Schutz)
 * @param {boolean}           lastRerollProtected – letzter Reroll wurde durch Schutz behalten
 */
function _updateEntryDOM(container, actorId, result, bennyUsed, diceDetails, isGroup = false, isNPC = false, fumbleCheckResult = undefined, fumbleCheckDie = undefined, previousRolls = null, lastRerollProtected = false, rollSeq = null, fumbleCheckAccepted = false, lastRerollFumbleOverwrite = false) {
  const entryEl = container.querySelector(`.adr-request-entry[data-actor-id="${actorId}"]`);
  if (!entryEl) return;

  // ── Patzer-Zustand bestimmen ──
  // Die Patzer-Mechanik in der Angeforderten Probe (rote 1, Benny gesperrt,
  // W6-Check für Statisten) ist mechanik-relevant und greift IMMER — analog
  // zum Dramatic-Pfad (`_applyDramaticRollResult`). Das globale Setting
  // `highlightNaturalOnes` steuert nur den freien Wurf-Pfad in adr-hooks.js,
  // nicht die Angeforderte Probe.
  let isFumble = false;
  let showCheckButton = false;
  let checkResultText = null; // "confirmed" | "denied" | null

  if (diceDetails) {
    if (fumbleCheckResult === true) {
      isFumble = true;
      checkResultText = "confirmed";
    } else if (fumbleCheckResult === false) {
      isFumble = false;
      checkResultText = "denied";
    } else if (fumbleCheckAccepted === true) {
      // GM hat die 1 als reguläres Ergebnis akzeptiert — kein Patzer-Check.
      // isFumble bleibt false, showCheckButton bleibt false → keine Auswahl-UI,
      // kein „Kein Erfolg", kein Patzer-Label. Der Wurfwert (z. B. 1) steht
      // einfach als reguläres Ergebnis. Analog zum freien Wurf (fumbleCheckAccepted-Flag).
    } else {
      const classification = _classifyFumble(diceDetails, isNPC);
      if (classification === "confirmed") {
        isFumble = true;
      } else if (classification === "needs-check") {
        showCheckButton = true;
      }
    }
  }

  // ── Würfel-Button → Ergebnis ──
  // Bei Opposed: enges Layout, im Wurf-Slot wird "Kein Erfolg" angezeigt (pending=true).
  // Bei Single/Group: Zahl bleibt, "Kein Erfolg" kommt als eigene Zeile darunter.
  const isOpposedMode = entryEl.classList.contains("adr-opposed-side");
  const rollBtn = entryEl.querySelector("[data-action='adr-roll-trait']");
  if (rollBtn) {
    rollBtn.classList.add("adr-rolled");
    rollBtn.disabled = true;
    rollBtn.innerHTML = _buildResultHTML(result, isFumble, isOpposedMode && showCheckButton);
  }

  // ── Benny-Button ──
  // Sperre auch wenn der ZULETZT VERWORFENE Reroll ein bestätigter Patzer war
  // (Schutz-Pfad). Der Würfelwert bleibt das alte gute Ergebnis (= keine rote 1),
  // aber kein weiterer Benny-Reroll mehr erlaubt — Hausregel.
  const bennyLocked = isFumble || _isEntryBennyLocked({
    diceDetails, isNPC, fumbleCheckResult,
    lastRerollProtected, previousRolls,
  });
  const bennyBtn = entryEl.querySelector("[data-action='adr-use-benny']");
  if (bennyBtn) {
    if (bennyLocked) {
      // Patzer (geltend ODER zuletzt verworfen): Benny gesperrt, rotes X
      bennyBtn.classList.remove("adr-hidden");
      bennyBtn.classList.add("adr-benny-fumble");
      bennyBtn.disabled = true;
      bennyBtn.title = game.i18n.localize(`${ADR.ID}.chat.critical-failure-no-benny`);
    } else {
      bennyBtn.classList.remove("adr-hidden", "adr-benny-fumble");
      bennyBtn.disabled = false;
      bennyBtn.title = game.i18n.localize(
        isNPC ? `${ADR.ID}.requestRoll.bennyTooltipNPC`
              : `${ADR.ID}.requestRoll.bennyTooltip`
      );
      if (bennyUsed) {
        bennyBtn.classList.add("adr-benny-used");
      }
    }
  }

  // ── Patzer-Bereich: Label / "Kein Erfolg" / Check-Button / Check-Ergebnis ──
  // Immer alles aufräumen, dann gezielt das Richtige einfügen
  const existingLabel = entryEl.querySelector(".adr-fumble-label");
  const existingCheckBtn = entryEl.querySelector(".adr-fumble-check-btn");
  const existingCheckResult = entryEl.querySelector(".adr-fumble-check-result");
  const existingNoSuccess = entryEl.querySelector(".adr-request-no-success");
  const existingProtectedHint = entryEl.querySelector(".adr-benny-protected-hint");
  if (existingLabel) existingLabel.remove();
  if (existingCheckBtn) {
    // Wenn der Check-Btn in einem Choice-Container (Accept-Btn + „oder" +
    // Check-Btn) liegt, entfernen wir den kompletten Container; sonst nur
    // den einzelnen Button. Discarded-Check-Btn liegt in protected-hint,
    // dort greift parentChoice nicht — die hint wird unten ohnehin entfernt.
    const parentChoice = existingCheckBtn.closest(".adr-fumble-choice-container");
    (parentChoice ?? existingCheckBtn).remove();
  }
  if (existingCheckResult) existingCheckResult.remove();
  if (existingNoSuccess) existingNoSuccess.remove();
  if (existingProtectedHint) existingProtectedHint.remove();

  const anchor = entryEl.querySelector(".adr-request-actor-row");
  let nextAnchor = anchor;

  // ── Benny-Schutz-/Verbesserungs-Hinweis (pro Entry) ──
  // Direkt nach der Wurf-Zeile, vor "Kein Erfolg" / Patzer-Indikatoren.
  // Für die Vergleichende Probe wird der Hinweis NICHT pro Entry gerendert
  // (Layout zu eng) — stattdessen baut `_updateOpposedToggle` eine Sammel-
  // sektion mit Akteurnamen unterhalb des Trennstrichs.
  if (!isOpposedMode) {
    const hintEl = _buildBennyHintEl(actorId, isNPC, previousRolls, lastRerollProtected, null, lastRerollFumbleOverwrite);
    if (hintEl) {
      if (nextAnchor) nextAnchor.insertAdjacentElement("afterend", hintEl);
      nextAnchor = hintEl;
    }
  }

  // „Kein Erfolg"-Zeile bewusst entfernt — die Patzer-/Auswahl-Buttons
  // und Patzer-Check-Ergebnis-Texte sprechen für sich, eine separate
  // Kommentierung des Würfelergebnisses passt hier nicht. Der Cleanup
  // weiter oben (existingNoSuccess.remove()) bleibt aktiv, damit alte
  // Chat-Nachrichten mit dem alten Markup automatisch aufgeräumt werden.

  if (isFumble && !checkResultText && !lastRerollFumbleOverwrite && !isOpposedMode) {
    // SC Auto-Patzer — kurzes Label
    // Bei Reroll-Override (`lastRerollFumbleOverwrite=true`) steht der Patzer-
    // Hinweis bereits im Benny-Hint darüber ("Der Benny-Wiederholungswurf war
    // ein kritischer Fehlschlag"); ein zusätzliches Label wäre redundant.
    // Im Opposed-Mode wird der Patzer-Text in die Sammelsektion verlagert
    // (s. _updateOpposedToggle), daher hier auch ausgespart.
    const label = document.createElement("div");
    label.className = "adr-fumble-label";
    label.textContent = game.i18n.localize(`${ADR.ID}.chat.${isGroup ? "critical-failure-short" : "critical-failure"}`);
    if (nextAnchor) nextAnchor.insertAdjacentElement("afterend", label);
    _scrollChatToEntry(entryEl);

  } else if (checkResultText === "confirmed" && !lastRerollFumbleOverwrite && !isOpposedMode) {
    // Nicht-SC: Patzer per W6 bestätigt — Ergebnis-Text.
    // Im Opposed wird der Patzer-Text in die Sammelsektion verlagert (s. o.).
    const div = document.createElement("div");
    div.className = "adr-fumble-check-result";
    const keyword = game.i18n.localize(`${ADR.ID}.requestRoll.fumbleCheckYes`);
    const template = game.i18n.localize(`${ADR.ID}.requestRoll.fumbleCheckTextYes`);
    div.innerHTML = template.replace("{result}", `<span class="adr-fumble-confirmed-text">${keyword}</span>`);
    if (nextAnchor) nextAnchor.insertAdjacentElement("afterend", div);
    _scrollChatToEntry(entryEl);

  } else if (showCheckButton) {
    // Nicht-SC: Einzelwürfel = 1 → Auswahl-Container „Würfelergebnis annehmen
    // / oder / mit W6 auf Patzer prüfen?" — analog zum freien Wurf.
    // GM klickbar, Nicht-GM sieht beide Buttons ausgegraut (adr-not-mine +
    // title-Tooltip + Inline-Cursor !important), konsistent mit Benny-Pattern.
    const isGM = game.user.isGM;
    const acceptLabel = game.i18n.localize(`${ADR.ID}.requestRoll.acceptResultBtn`);
    const orLabel = game.i18n.localize(`${ADR.ID}.requestRoll.orChoice`);
    const line1 = game.i18n.localize(`${ADR.ID}.requestRoll.fumbleCheckBtn1`);
    const line2 = game.i18n.localize(`${ADR.ID}.requestRoll.fumbleCheckBtn2`);
    const tooltip = game.i18n.localize(`${ADR.ID}.requestRoll.chatNoPermission`);

    const choice = document.createElement("div");
    choice.className = "adr-fumble-choice-container";
    // Opposed-Mode: enge Spalte, Buttons dürfen umbrechen.
    if (isOpposedMode) choice.classList.add("adr-fumble-choice-multiline");

    const acceptBtn = document.createElement("button");
    acceptBtn.type = "button";
    acceptBtn.className = "adr-accept-result-btn";
    acceptBtn.dataset.action = "adr-fumble-accept";
    acceptBtn.dataset.actorId = actorId;
    acceptBtn.textContent = acceptLabel;

    const orSpan = document.createElement("span");
    orSpan.className = "adr-fumble-choice-or";
    orSpan.textContent = orLabel;

    const checkBtn = document.createElement("button");
    checkBtn.type = "button";
    checkBtn.className = "adr-fumble-check-btn";
    if (isOpposedMode) checkBtn.classList.add("adr-fumble-check-btn-multiline");
    checkBtn.dataset.action = "adr-fumble-check";
    checkBtn.dataset.actorId = actorId;
    checkBtn.innerHTML = isOpposedMode ? `${line1}<br>${line2}` : `${line1} ${line2}`;

    if (!isGM) {
      // Inline-style mit !important: schlägt Foundry-Defaults für button-cursor
      // (siehe Initial-1-Stelle im freien Wurf, adr-hooks.js).
      acceptBtn.classList.add("adr-not-mine");
      acceptBtn.title = tooltip;
      acceptBtn.style.setProperty("cursor", "not-allowed", "important");
      checkBtn.classList.add("adr-not-mine");
      checkBtn.title = tooltip;
      checkBtn.style.setProperty("cursor", "not-allowed", "important");
    }

    choice.appendChild(acceptBtn);
    choice.appendChild(orSpan);
    choice.appendChild(checkBtn);

    if (nextAnchor) nextAnchor.insertAdjacentElement("afterend", choice);
    _scrollChatToEntry(entryEl);

  } else if (checkResultText === "denied") {
    // Nicht-SC: Kein Patzer per W6 bestätigt — Ergebnis-Text
    // Im Opposed: verkürzte Variante.
    const div = document.createElement("div");
    div.className = "adr-fumble-check-result";
    const keyword = game.i18n.localize(`${ADR.ID}.requestRoll.fumbleCheckNone`);
    const tmplKey = isOpposedMode
      ? `${ADR.ID}.requestRoll.fumbleCheckTextNoShort`
      : `${ADR.ID}.requestRoll.fumbleCheckTextNo`;
    const template = game.i18n.localize(tmplKey);
    div.innerHTML = template.replace("{result}", `<span class="adr-fumble-denied-text">${keyword}</span>`);
    if (nextAnchor) nextAnchor.insertAdjacentElement("afterend", div);
    _scrollChatToEntry(entryEl);
  }

  // ── Einzelergebnisse-Toggle (nicht für Gruppenprobe / Vergleichende Probe — dort gesammelt am Ende) ──
  if (diceDetails && !isGroup && !isOpposedMode) {
    const existing = entryEl.querySelector(".adr-individual-toggle-container");
    if (existing) existing.remove();
    const detailsHTML = _buildDiceDetailsHTML(diceDetails, previousRolls, fumbleCheckDie, rollSeq);
    if (detailsHTML) {
      const wrapper = document.createElement("div");
      wrapper.innerHTML = detailsHTML;
      entryEl.appendChild(wrapper.firstElementChild);

      // Toggle-Klick-Handler
      const toggle = entryEl.querySelector(".adr-individual-toggle");
      if (toggle) _attachToggleHandler(toggle);
    }
  }
}

/**
 * Chat-Container hochscrollen, damit die Nachricht vollständig sichtbar ist.
 * Scrollt nur, wenn die Nachricht aktuell mindestens teilweise im Viewport ist —
 * hat ein Nutzer zu älteren Nachrichten hochgescrollt, springt der Chat nicht
 * überraschend zurück.
 */
function _scrollChatToEntry(element) {
  setTimeout(() => {
    const li = element.closest("li.chat-message");
    if (li) {
      const scrollContainer = li.closest(".chat-scroll");
      if (scrollContainer) {
        const liRect = li.getBoundingClientRect();
        const containerRect = scrollContainer.getBoundingClientRect();
        // Nur scrollen, wenn die Nachricht aktuell (teilweise) sichtbar ist
        const isVisible = liRect.top < containerRect.bottom && liRect.bottom > containerRect.top;
        if (!isVisible) return;
        const overflow = liRect.bottom - containerRect.bottom;
        if (overflow > 0) scrollContainer.scrollTop += overflow + 8;
      }
    }
  }, 50);
}

/**
 * Toggle-Klick-Handler für Einzelergebnisse anhängen.
 */
function _attachToggleHandler(toggle) {
  toggle.addEventListener("click", function () {
    const details = this.nextElementSibling;
    if (details?.classList.contains("adr-individual-details")) {
      details.classList.toggle("adr-individual-hidden");
      if (!details.classList.contains("adr-individual-hidden")) {
        void details.offsetHeight;
        _scrollChatToEntry(this);
      }
    }
  });
}

/**
 * Gruppenprobe: Gesammelter Einzelergebnisse-Toggle am Ende der Nachricht.
 * Zeigt alle Spieler-Ergebnisse in einem einzigen aufklappbaren Block.
 */
function _updateGroupToggle(container, entries) {
  // Nur anzeigen wenn mindestens ein Ergebnis vorliegt
  const withResults = entries
    .filter(e => e.result !== null && e.diceDetails)
    .sort((a, b) => (a.actorName ?? "").localeCompare(b.actorName ?? "", game.i18n.lang));
  if (withResults.length === 0) return;

  // Bestehenden Toggle entfernen (für Updates bei Benny-Reroll)
  const existing = container.querySelector(".adr-group-toggle-container");
  if (existing) existing.remove();

  // Einzelergebnisse pro Spieler aufbauen — Blockstil pro Akteur: Akteurname
  // als Kopfzeile, darunter alle Würfe (verworfen + aktuell) chronologisch via
  // _buildRollHistoryHTML. Per Benny ersetzte, schlechtere Würfe erscheinen
  // durchgestrichen (adr-individual-discarded) — identisch zur Vergleichenden
  // Probe (_updateOpposedToggle).
  let detailsInner = "";
  for (const entry of withResults) {
    const historyHTML = _buildRollHistoryHTML(entry);
    detailsInner += `<div class="adr-group-detail-block">`
      + `<div class="adr-group-detail-name">${foundry.utils.escapeHTML(entry.actorName ?? "")}</div>`
      + `<div class="adr-group-detail-body">${historyHTML}</div>`
      + `</div>`;
  }

  const toggleLabel = game.i18n.localize(`${ADR.ID}.individualResults.toggle`);
  const html = `<div class="adr-group-toggle-container">`
    + `<div class="adr-group-divider"></div>`
    + `<div class="adr-individual-toggle-container">`
    + `<div class="adr-individual-toggle">${toggleLabel}</div>`
    + `<div class="adr-individual-details adr-individual-hidden">${detailsInner}</div>`
    + `</div></div>`;

  // Vor dem Status einfügen
  const statusEl = container.querySelector(".adr-request-status");
  if (statusEl) {
    statusEl.insertAdjacentHTML("beforebegin", html);
    const toggle = container.querySelector(".adr-group-toggle-container .adr-individual-toggle");
    if (toggle) _attachToggleHandler(toggle);
  }
}

/**
 * Vergleichende Probe: Gesammelter Einzelergebnisse-Toggle am Ende der Nachricht.
 * Pro Akteur: zentrierte, fette, unterstrichene Kopfzeile + Würfel darunter.
 * Analog zu _updateGroupToggle, aber mit Block-Layout (wie Dramatische Aufgabe).
 */
function _updateOpposedToggle(container, entries) {
  const withResults = entries.filter(e => e.result !== null && e.diceDetails);
  if (withResults.length === 0) return;

  // Bestehenden Toggle entfernen (für Updates bei Benny-Reroll)
  const existing = container.querySelector(".adr-group-toggle-container");
  if (existing) existing.remove();
  // Hint-Sammelsektion liegt jetzt außerhalb des toggle-containers (direkt nach
  // der Arena) — separat aufräumen, sonst stapelt sich der Hint bei Re-Render.
  const existingHints = container.querySelector(".adr-opposed-benny-hints");
  if (existingHints) existingHints.remove();

  // Pro Spielerblock: Akteurname als Kopfzeile + alle Würfe (verworfen + aktuell)
  // chronologisch darunter via _buildRollHistoryHTML — analog zur Einzelprobe.
  // Block-Layout (zentrierter Name + Body) bleibt erhalten.
  let detailsInner = "";
  for (const entry of withResults) {
    const historyHTML = _buildRollHistoryHTML(entry);
    detailsInner += `<div class="adr-opposed-detail-block">`
      + `<div class="adr-opposed-detail-name">${foundry.utils.escapeHTML(entry.actorName ?? "")}</div>`
      + `<div class="adr-opposed-detail-body">${historyHTML}</div>`
      + `</div>`;
  }

  const toggleLabel = game.i18n.localize(`${ADR.ID}.individualResults.toggle`);
  const html = `<div class="adr-group-toggle-container adr-opposed-toggle-container">`
    + `<div class="adr-group-divider"></div>`
    + `<div class="adr-individual-toggle-container">`
    + `<div class="adr-individual-toggle">${toggleLabel}</div>`
    + `<div class="adr-individual-details adr-individual-hidden">${detailsInner}</div>`
    + `</div></div>`;

  const statusEl = container.querySelector(".adr-request-status");
  if (statusEl) {
    statusEl.insertAdjacentHTML("beforebegin", html);
    const toggle = container.querySelector(".adr-opposed-toggle-container .adr-individual-toggle");
    if (toggle) _attachToggleHandler(toggle);
  }

  // ── Patzer-/Benny-Hint-Sammelsektion (mit Akteurnamen) ──
  // Die Vergleichende Probe rendert pro Entry KEINE Hint-Texte (Layout zu eng).
  // Stattdessen kommen alle Hints hier direkt nach der Arena (= unterhalb des
  // ::after-Trennstrichs) als eigene Sektion, in derselben Reihenfolge wie die
  // Akteure auf der Chat-Card. Pro Entry max. 1 Hint:
  //   1) Benny-Wiederholungswurf (Verschlechterung/Verbesserung/Patzer-Override)
  //   2) Erstwurf-Patzer (kein Reroll, aber bestätigter Patzer im Initial-Wurf)
  // Hint sitzt AUSSERHALB des toggle-containers (analog zur Einzelprobe, wo
  // der Hint direkt nach der actor-row sitzt) — sonst wäre der Abstand zum
  // Strich durch margin-top + padding-top des toggle-containers zu groß.
  const arenaEl = container.querySelector(".adr-opposed-arena");
  if (arenaEl) {
    const hintsWrap = document.createElement("div");
    hintsWrap.className = "adr-opposed-benny-hints";
    for (const entry of entries) {
      // Erstrangig: Benny-Hint (greift nur wenn previousRolls vorhanden)
      let hintEl = _buildBennyHintEl(
        entry.actorId,
        entry.isNPC ?? false,
        entry.previousRolls ?? null,
        !!entry.lastRerollProtected,
        entry.actorName ?? null,
        !!entry.lastRerollFumbleOverwrite,
      );

      // Fallback: Erstwurf-Patzer (kein Reroll, aber Patzer beim Initialwurf)
      if (!hintEl) {
        const hasFirstFumble = entry.diceDetails && (
          entry.fumbleCheckResult === true
          || _classifyFumble(entry.diceDetails, entry.isNPC ?? false) === "confirmed"
        );
        if (hasFirstFumble) {
          hintEl = document.createElement("div");
          hintEl.className = "adr-benny-protected-hint adr-first-fumble-hint";
          const tmpl = game.i18n.localize(`${ADR.ID}.requestRoll.firstRollFumbleNamed`);
          const text = tmpl.replace("{actor}", foundry.utils.escapeHTML(entry.actorName ?? ""));
          hintEl.innerHTML = `<div class="adr-benny-protected-line adr-benny-protected-fumble">${text}</div>`;
        }
      }

      if (hintEl) hintsWrap.appendChild(hintEl);
    }
    if (hintsWrap.childElementCount > 0) {
      arenaEl.insertAdjacentElement("afterend", hintsWrap);
    }
  }

  // Sieger/Verlierer/Gleichstand am Token-Bild markieren
  _updateOpposedRings(container, entries);
}

/**
 * Vergleichende Probe: Sieger-/Verlierer-/Gleichstand-Ring um das Token-Bild
 * im Chat-Output. Nur aktiv wenn beide (genau 2) Akteure gewürfelt haben.
 * Bei Benny-Reroll werden alte Klassen entfernt und neu gesetzt.
 */
function _updateOpposedRings(container, entries) {
  // Alle bestehenden Ring-Klassen erst mal entfernen (falls Reroll)
  container.querySelectorAll(".adr-opposed-portrait").forEach(img => {
    img.classList.remove("adr-opposed-winner", "adr-opposed-loser", "adr-opposed-tie");
  });

  const valid = entries.filter(e => e.result !== null && e.result !== undefined);
  if (valid.length !== 2) return;

  const [a, b] = valid;
  const aImg = container.querySelector(`.adr-opposed-side[data-actor-id="${a.actorId}"] .adr-opposed-portrait`);
  const bImg = container.querySelector(`.adr-opposed-side[data-actor-id="${b.actorId}"] .adr-opposed-portrait`);

  if (a.result > b.result) {
    aImg?.classList.add("adr-opposed-winner");
    bImg?.classList.add("adr-opposed-loser");
  } else if (a.result < b.result) {
    aImg?.classList.add("adr-opposed-loser");
    bImg?.classList.add("adr-opposed-winner");
  } else {
    aImg?.classList.add("adr-opposed-tie");
    bImg?.classList.add("adr-opposed-tie");
  }
}

/**
 * Clientseitige Lokalisierung der Chat-Nachricht.
 *
 * Hintergrund: Foundry rendert hbs-Templates beim Erzeugen der Chat-Message
 * EINMAL — in der Sprache des Erstellers (meist der GM). Das gerenderte HTML
 * wird mit der Nachricht gespeichert und allen Clients ausgeliefert. Spieler
 * mit anderer Sprache sehen daher Strings in der GM-Sprache.
 *
 * Dieser Helper läuft pro Client beim Rendern der Nachricht und überschreibt
 * die sichtbaren Infotexte mit der lokalen Sprache des Lesers:
 *
 *   1. Trait-Die-Label („W4" → „d4" oder umgekehrt) per
 *      `adr-request-die-label`/`adr-dramatic-die`-Span, anhand
 *      `entry.traitDie` aus den Flags + lokaler `diePrefix`.
 *   2. Roll-Button-Text (Würfel-Emoji bleibt vorne).
 *   3. Status-Element (Pending) — Complete wird unten separat behandelt,
 *      wenn alle gewürfelt haben.
 *
 * Skill-/Attribut-Namen werden NICHT lokalisiert (kommen aus den
 * Actor-Daten, sind kein Modul-Infotext).
 */
function _localizeRequestStrings(li, flags) {
  if (!flags?.entries) return;

  const localDiePrefix = game.i18n.localize(`${ADR.ID}.requestRoll.diePrefix`);
  const localRollText = game.i18n.localize(`${ADR.ID}.requestRoll.chatRollButton`);

  // ── Modifikator-Label (alle Modi, auch Dramatic-Header) ──
  // Template hat statisches "{{localize ... modifierLabel}}" an mehreren
  // Stellen (Dramatic-Header, Single/Group, Opposed) — alle verwenden die
  // Klasse .adr-request-mod-label.
  const localModLabel = game.i18n.localize(`${ADR.ID}.requestRoll.modifierLabel`);
  for (const el of li.querySelectorAll(".adr-request-mod-label")) {
    el.textContent = localModLabel;
  }

  // ── Benny-Tooltips (alle Modi) ──
  // Template setzt title abhängig von "Patzer"-Klasse statisch. Hier neu setzen
  // mit lokalisierten Strings. .adr-not-mine bekommt seinen Tooltip woanders
  // (chatNoPermission) und wird hier ausgespart.
  const localBennyTip = game.i18n.localize(`${ADR.ID}.requestRoll.bennyTooltip`);
  const localBennyTipNPC = game.i18n.localize(`${ADR.ID}.requestRoll.bennyTooltipNPC`);
  const localBennyNoTip = game.i18n.localize(`${ADR.ID}.chat.critical-failure-no-benny`);
  // Lookup actorId → isNPC für gezieltes Tooltip-Setzen
  const npcMap = new Map();
  for (const e of flags.entries) npcMap.set(e.actorId, !!e.isNPC);
  for (const btn of li.querySelectorAll(".adr-benny-btn")) {
    if (btn.classList.contains("adr-not-mine")) continue;
    if (btn.classList.contains("adr-benny-fumble")) {
      btn.title = localBennyNoTip;
    } else {
      const isNPC = npcMap.get(btn.dataset.actorId) ?? false;
      btn.title = isNPC ? localBennyTipNPC : localBennyTip;
    }
  }

  // ── Trait-Die-Label (Single/Group/Opposed + Dramatic) ──
  // Pro actorId: alle Span-Treffer mit `${prefix}${entry.traitDie}` neu setzen.
  for (const entry of flags.entries) {
    if (entry?.traitDie == null) continue;
    const newLabel = `${localDiePrefix}${entry.traitDie}`;
    const entryEls = li.querySelectorAll(
      `.adr-request-entry[data-actor-id="${entry.actorId}"], .adr-dramatic-entry[data-actor-id="${entry.actorId}"]`
    );
    for (const el of entryEls) {
      const labelSpans = el.querySelectorAll(".adr-request-die-label, .adr-dramatic-die");
      for (const span of labelSpans) {
        span.textContent = newLabel;
      }
    }
  }

  // ── Roll-Button-Text (nur ungerollte) ──
  // Gerollte Buttons haben `adr-rolled` und wurden von _updateEntryDOM /
  // _buildResultHTML mit dem Ergebnis befüllt — die NICHT anfassen.
  const rollBtns = li.querySelectorAll(".adr-roll-btn:not(.adr-rolled)");
  for (const btn of rollBtns) {
    btn.innerHTML = `🎲 ${localRollText}`;
  }

  // ── Status: Pending ──
  // Complete wird vom renderChatMessageHTML-Hook gesetzt wenn alle fertig.
  // Wenn noch nicht alle fertig: lokalen Pending-Text setzen. Bei Dramatic
  // entfällt das (eigene Statuszeile via dramaticStatusHTML).
  if (flags.mode !== "dramatic") {
    const allDone = flags.entries.every(e => e.result !== null);
    if (!allDone) {
      const statusEl = li.querySelector(".adr-request-status");
      if (statusEl && !statusEl.classList.contains("adr-complete")) {
        statusEl.textContent = game.i18n.localize(`${ADR.ID}.requestRoll.chatPending`);
      }
    }
  }
}

/**
 * Chat-Nachricht visuell aktualisieren (Buttons → Ergebnisse).
 */
function _refreshRequestChatHTML(message) {
  const li = document.querySelector(`li.chat-message[data-message-id="${message.id}"]`);
  if (!li) return;

  const flags = message.flags[ADR.ID];
  if (!flags?.entries) return;

  // Clientseitige Lokalisierung: Trait-Die-Label, Roll-Button-Text, Pending.
  // Muss VOR den Mode-spezifischen Updates laufen.
  _localizeRequestStrings(li, flags);

  if (flags.mode === "dramatic") {
    _enhanceDramaticRequestChat(li, flags);
    // Kein _scrollChatToEntry hier: würde bei jedem Update (Wurf, Benny etc.)
    // beim GM, der die DT-Nachricht im Viewport hat, Foundrys Auto-Scroll zur
    // letzten Chat-Nachricht durchbrechen. Aktive User-Aktionen scrollen
    // ohnehin in ihren eigenen Klick-Handlern.
    return;
  }

  const isGroup = flags.mode === "group";
  const isOpposed = flags.mode === "opposed";

  for (const entry of flags.entries) {
    if (entry.result !== null) {
      _updateEntryDOM(li, entry.actorId, entry.result, entry.bennyUsed ?? false, entry.diceDetails, isGroup, entry.isNPC ?? false, entry.fumbleCheckResult, entry.fumbleCheckDie, entry.previousRolls ?? null, !!entry.lastRerollProtected, entry.rollSeq ?? null, !!entry.fumbleCheckAccepted, !!entry.lastRerollFumbleOverwrite);
    }
  }

  // Gruppenprobe: gesammelter Toggle
  if (isGroup) {
    _updateGroupToggle(li, flags.entries);
  }

  // Vergleichende Probe: gesammelter Toggle
  if (isOpposed) {
    _updateOpposedToggle(li, flags.entries);
  }

  // Prüfe ob alle fertig
  const allDone = flags.entries.every(e => e.result !== null);
  if (allDone) {
    const statusEl = li.querySelector(".adr-request-status");
    if (statusEl) {
      statusEl.textContent = game.i18n.localize(`${ADR.ID}.requestRoll.chatComplete`);
      statusEl.classList.add("adr-complete");
      if (isGroup) statusEl.style.marginTop = "-0.7rem";
    }
  }

  // Nach jedem Update den Chat nachziehen, damit die expandierte Nachricht vollständig sichtbar bleibt
  _scrollChatToEntry(li);
}

/* ================================================================ */
/*  updateChatMessage: Visuelle Aktualisierung auf allen Clients      */
/* ================================================================ */

Hooks.on("updateChatMessage", (message, change) => {
  if (!message.getFlag(ADR.ID, "requestRoll")) return;
  setTimeout(() => _refreshRequestChatHTML(message), 150);
});

/* ================================================================ */
/*  renderChatMessageHTML: Probenanforderungen erkennen + stylen      */
/* ================================================================ */

Hooks.on("renderChatMessageHTML", (message, html) => {
  if (!message.getFlag(ADR.ID, "requestRoll")) return;

  const li = html.closest("li.chat-message") ?? html;
  li.classList.add("adr-chat", "adr-request-roll-chat");

  // ── Theme aus dem "chatDesign"-Dropdown ──
  // "modern" → SciFi-Optik, sonst klassische Optik. Probenanforderungs-
  // Karten sind eine ADR-Eigenfunktion ohne System-Pendant und werden
  // daher auch bei "standard" weiter als ADR-Karte gerendert (Fantasy-Optik).
  const scifi = game.settings.get(ADR.ID, "chatDesign") === "modern";
  if (scifi) li.classList.add("scifi");

  const flags = message.flags[ADR.ID];
  if (!flags?.entries) return;

  // ── Header-Label injizieren (gleicher Ansatz wie Hauptmodul) ──
  const header = li.querySelector(".message-header");
  if (header) {
    const flavor = header.querySelector(".flavor-text");
    if (flavor) flavor.style.setProperty("display", "none", "important");

    let label = header.querySelector(".adr-header-label");
    if (!label) {
      label = document.createElement("span");
      label.className = "adr-header-label";
      header.prepend(label);
    }
    label.textContent = game.i18n.localize(
      flags.mode === "dramatic"
        ? `${ADR.ID}.requestRoll.dramaticChatHeaderLabel`
        : flags.mode === "opposed"
          ? `${ADR.ID}.requestRoll.opposedChatHeaderLabel`
          : `${ADR.ID}.requestRoll.chatHeaderLabel`
    );

    const h4 = header.querySelector("h4");
    if (h4) h4.style.setProperty("display", "none", "important");
  }

  // Clientseitige Lokalisierung: Trait-Die-Label, Roll-Button-Text, Pending.
  // Muss VOR den Mode-spezifischen Updates laufen.
  _localizeRequestStrings(li, flags);

  if (flags.mode === "dramatic") {
    _enhanceDramaticRequestChat(li, flags);
    return;
  }

  const isGroup = flags.mode === "group";
  const isOpposed = flags.mode === "opposed";
  if (isGroup) {
    li.classList.add("adr-group-roll");
  }

  // ── Self-Heal: alte/gecachte Nachrichten mit fehlerhafter Modifikator-Anzeige reparieren ──
  // Foundry speichert den gerenderten Chat-Inhalt als HTML. Wenn eine Nachricht vor einem
  // Code-Fix erstellt wurde und der Modifikator damals als NaN/Sonderwert ins HTML kam,
  // bleibt das HTML erhalten — auch nach dem Fix. Hier wird die Anzeige beim erneuten
  // Rendern der Nachricht aus dem (sanitisierten) flags.modifier neu aufgebaut.
  _selfHealModifierDisplay(li, flags);

  for (const entry of flags.entries) {
    if (entry.result !== null) {
      _updateEntryDOM(li, entry.actorId, entry.result, entry.bennyUsed ?? false, entry.diceDetails, isGroup, entry.isNPC ?? false, entry.fumbleCheckResult, entry.fumbleCheckDie, entry.previousRolls ?? null, !!entry.lastRerollProtected, entry.rollSeq ?? null, !!entry.fumbleCheckAccepted, !!entry.lastRerollFumbleOverwrite);
    }

    const isMine = entry.ownerIds?.includes(game.user.id) || game.user.isGM;

    const rollBtn = li.querySelector(`[data-action="adr-roll-trait"][data-actor-id="${entry.actorId}"]`);
    if (rollBtn && !isMine && entry.result === null) {
      rollBtn.classList.add("adr-not-mine");
      rollBtn.title = game.i18n.localize(`${ADR.ID}.requestRoll.chatNoPermission`);
    }

    // Benny-Button für Nicht-Owner (und Nicht-SL) ausgrauen — gleiche Behandlung
    // wie der grüne Würfel-Button. Wird auch nach dem Wurf angewendet, damit der
    // Benny nicht plötzlich hervorgehoben dargestellt wird.
    const bennyBtn = li.querySelector(`[data-action="adr-use-benny"][data-actor-id="${entry.actorId}"]`);
    if (bennyBtn && !isMine) {
      bennyBtn.classList.add("adr-not-mine");
      bennyBtn.title = game.i18n.localize(`${ADR.ID}.requestRoll.chatNoPermission`);
    }
  }

  if (isGroup) {
    _updateGroupToggle(li, flags.entries);
  }

  if (isOpposed) {
    _updateOpposedToggle(li, flags.entries);
  }

  const allDone = flags.entries.every(e => e.result !== null);
  const statusEl = li.querySelector(".adr-request-status");
  if (statusEl && allDone) {
    statusEl.textContent = game.i18n.localize(`${ADR.ID}.requestRoll.chatComplete`);
    statusEl.classList.add("adr-complete");
    if (isGroup) statusEl.style.marginTop = "-0.7rem";
  }
});

/* ================================================================ */
/*  Export: Dramatische Aufgabe aus Form-Daten initialisieren         */
/* ================================================================ */

/**
 * Erzeugt die Flag-Struktur und den gerenderten Chat-Content für eine
 * neue Dramatische Aufgabe. Wird aus adr-request-roll-form.js aufgerufen.
 *
 * @param {Object[]} participants                  Teilnehmer-Liste (actorId, actorName, ..., ownerIds, isNPC).
 * @param {Object}   settings
 * @param {number}   settings.markersPerParticipant  Marker pro Teilnehmer (Preset-Wert).
 * @param {number}   settings.roundsTotal             Rundenanzahl (Preset-Wert).
 * @param {number}   [settings.modifier]              Globaler GM-Modifikator (optional, default 0).
 * @param {string}   [settings.presetKey]             Preset-Schlüssel (Info, z.B. "hard").
 * @param {string}   [settings.presetLabel]           Lokalisiertes Preset-Label (Info).
 * @returns {Promise<{flags:Object, chatContent:string}>}
 */
export async function createDramaticTaskMessageData(participants, settings) {
  const requestId = foundry.utils.randomID();
  const markersPerParticipant = Number(settings?.markersPerParticipant ?? 1);
  const roundsTotal = Number(settings?.roundsTotal ?? 1);
  const modifier = Number(settings?.modifier ?? 0);
  const targetMarkers = settings?.targetMarkers != null
    ? Number(settings.targetMarkers)
    : markersPerParticipant * participants.length;

  // Deck einmalig pro Dramatischer Aufgabe erstellen und persistent in flags ablegen.
  // Karten werden runde für runde gezogen; bei leerem Deck kommentarlos neu gemischt.
  const deck = createShuffledDeck();

  // entries mit leerer history + initialem roundState (Runde 1, Karten werden
  // von dealDramaticRound aus dem Deck gezogen).
  const baseEntries = participants.map(p => ({
    ...foundry.utils.deepClone(p),
    history: [],
  }));
  const entries = dealDramaticRound(baseEntries, 1, deck);

  const flags = {
    [ADR.ID]: {
      requestRoll: true,
      mode: "dramatic",
      requestId,
      modifier,
      entries,
      deck,
      currentRound: 1,
      roundsTotal,
      targetMarkers,
      totalMarkers: 0,
      outcome: null,
      pendingOutcome: null,
      failureReason: null,
      presetKey: settings?.presetKey ?? "custom",
      presetLabel: settings?.presetLabel ?? "",
      markersPerParticipant,
    },
  };

  const chatContent = await foundry.applications.handlebars.renderTemplate(
    ADR.REQUEST_ROLL_CHAT_PATH,
    _buildDramaticTemplateData(flags[ADR.ID])
  );

  return { flags, chatContent };
}

