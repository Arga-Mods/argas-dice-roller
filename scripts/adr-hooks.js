/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright (C) 2026 Arga-Mods */

import { ADR, adrSwadeMechanicsOffered, adrDieTypeLabel, adrIsFudge, adrSignedNumber, adrKeepModifier, adrCthulhuMode } from "./adr-constants.js";
import { DiceForm, buildHiddenInfoHTML, adrExplodingModifier, adrBuildDieResults } from "./adr-dice-form.js";
import { RequestRollForm } from "./adr-request-roll-form.js";
import {
  _fireTraitRollHook,
  _renderDicePrecomputed,
  _buildInlineRollContent,
} from "./adr-request-roll-chat.js";
import {
  freeRollSubject,
  subjectBennies,
  subjectSpendBenny,
  subjectRefundBenny,
  subjectCanClick,
} from "./adr-benny-helpers.js";

let globalDiceForm;

/**
 * Dice-So-Nice-Animation unter Wahrung des Sichtbarkeits-Modus: Bei Whisper-/
 * Blind-Nachrichten sehen nur die Empfänger die 3D-Würfel, sonst leakt die
 * Animation verdeckte Würfe an alle Clients.
 */
async function _adrShowRoll3d(roll, message) {
  if (!game.dice3d || !roll) return;
  const whisperUsers = (message?.whisper ?? [])
    .map(id => game.users.get(id))
    .filter(Boolean);
  try {
    // DSNs blind-Parameter heißt "auf dem AUSLÖSENDEN Client nicht anzeigen" —
    // bewusst false: Der Klicker ist bei verdeckten Würfen stets legitimer
    // Empfänger, die Whisper-Liste beschränkt die übrigen Clients bereits.
    await game.dice3d.showForRoll(
      roll, game.user, true,
      whisperUsers.length ? whisperUsers : null,
      false
    );
  } catch (e) { /* */ }
}

/** true, wenn die Nachricht nicht öffentlich ist (Whisper oder Blind). */
function _adrIsHiddenMessage(message) {
  return !!message && ((message.whisper ?? []).length > 0 || !!message.blind);
}
let globalRequestRollForm;

Hooks.once("init", async () => {
  await _loadHandlebarTemplates();
  _registerGameSettings();
});

/* ================================================================ */
/*  Würfelfenster-Button als eigenständiger Top-Level-Scene-Control  */
/*  (unten in der Steuerungsspalte, NICHT im Figurensteuerungsmenü)  */
/* ================================================================ */

const ADR_CONTROL_KEY = "argas-dice-roller";

/* Zustand für das robuste Unten-Halten des Buttons (Stufe 2). */
let _adrControlObserver = null;   // aktiver MutationObserver auf der Steuerungsspalte
let _adrReorderCount = 0;         // Repositionierungen im aktuellen Render-Zyklus
const ADR_REORDER_LIMIT = 20;     // > Limit pro Render-Zyklus => Tauziehen => Observer trennen

/**
 * Hält den ADR-Eintrag als letztes Element der Steuerungsleiste. Überschreitet
 * die Zahl der Repositionierungen pro Render-Zyklus das Limit (ein anderes
 * Modul kämpft um denselben Platz), wird der Observer getrennt — kein Endlos-Tauziehen.
 */
function _adrEnsureControlLast(container, node) {
  if (!container || !node) return;
  if (container.lastElementChild === node) return;   // schon Letzter -> nichts tun (kein Selbst-Loop)

  if (++_adrReorderCount > ADR_REORDER_LIMIT) {
    console.warn(`[${ADR_CONTROL_KEY}] Reposition-Tauziehen erkannt — Observer wird getrennt, Eintrag bleibt stehen.`);
    _adrControlObserver?.disconnect();
    _adrControlObserver = null;
    return;
  }
  container.appendChild(node);
}

function _adrToggleDiceForm() {
  if (!globalDiceForm) globalDiceForm = new DiceForm();
  if (globalDiceForm.rendered) globalDiceForm.close();
  else globalDiceForm.render(true);
}

/* V13-API-Pfad: Foundry filtert Custom-Top-Level-Controls aus dem
 * Render-Pfad heraus — der Eintrag bleibt nur für Update-Festigkeit.
 * Die sichtbare Schaltfläche entsteht über renderSceneControls. */
Hooks.on("getSceneControlButtons", (controls) => {
  const isArray = Array.isArray(controls);

  const dummyTool = {
    name: "open",
    title: "",
    icon: "fas fa-dice-d20",
    visible: false,
    button: true,
    onChange: () => {}
  };

  const entry = {
    name: ADR_CONTROL_KEY,
    title: game.i18n.localize("argas-dice-roller.controlTitle"),
    icon: "fas fa-dice-d20",
    visible: true,
    order: 1000,
    tools: isArray ? [dummyTool] : { open: dummyTool },
    activeTool: "open",
    onChange: () => _adrToggleDiceForm()
  };

  if (isArray) {
    if (!controls.some(c => c?.name === ADR_CONTROL_KEY)) controls.push(entry);
  } else {
    if (!controls[ADR_CONTROL_KEY]) controls[ADR_CONTROL_KEY] = entry;
  }
});

/* DOM-Injection: eigenes <li> in der Szenen-Steuerungsleiste, außerhalb der
 * Figurensteuerung. Unten-Halten in drei Stufen:
 *   - order:9999 inline (am <li>)        — CSS-Flex-Reihenfolge
 *   - Stufe 1: verzögertes Nach-Anhängen — gewinnt gegen denselben Render
 *   - Stufe 2: MutationObserver          — gewinnt auch gegen späte Einschübe
 */
Hooks.on("renderSceneControls", (_app, html) => {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;

  // `item` ist das <li> der Leiste (im Struktur-Fallback der Button selbst).
  const existingBtn = root.querySelector(`[data-control="${ADR_CONTROL_KEY}"]`);
  const item = existingBtn ? (existingBtn.closest("li") ?? existingBtn)
                           : _adrInjectControlButton(root);
  if (!item) return;

  const container = item.parentElement;   // die echte Steuerungsleiste (<menu>/<ol>)
  if (!container) return;

  _adrReorderCount = 0;
  _adrControlObserver?.disconnect();

  // Stufe 1: nach den synchronen Render-Hooks der anderen Module ans Ende schieben.
  requestAnimationFrame(() => _adrEnsureControlLast(container, item));

  // Stufe 2: Observer gegen Module, die ihren Eintrag erst später einschieben.
  _adrControlObserver = new MutationObserver(() => _adrEnsureControlLast(container, item));
  _adrControlObserver.observe(container, { childList: true });
});

/**
 * Erzeugt den ADR-Eintrag der Szenen-Steuerungsleiste: klont das <li> eines
 * vorhandenen Controls (Foundry v14: <li><button data-control>), baut es auf
 * die ADR-Identität um und hängt es als EIGENES <li> an die Leiste — nie in
 * das <li> eines fremden Controls. Ohne <li>-Wrapper wird der Button selbst geklont.
 * @returns {HTMLElement|null} das eingehängte äußere Element (<li> bzw. Button)
 */
function _adrInjectControlButton(root) {
  const tplButton =
    root.querySelector(`[data-control="notes"]`) ??
    root.querySelector(`[data-control]`);

  if (!tplButton) {
    console.warn(`[${ADR_CONTROL_KEY}] kein Vorlage-Control für Injection gefunden`);
    return null;
  }

  const tplItem = tplButton.closest("li") ?? tplButton;
  const hasLiWrapper = tplItem !== tplButton;

  const container = tplItem.parentElement;
  if (!container) return null;

  // cloneNode kopiert keine Event-Listener mit.
  const outer = tplItem.cloneNode(true);

  // Enthält das Vorlage-<li> durch fremde Injektionen mehrere Buttons,
  // bleibt nur der erste.
  let inner;
  if (hasLiWrapper) {
    const buttons = outer.querySelectorAll("button");
    for (let i = 1; i < buttons.length; i++) buttons[i].remove();
    inner = outer.querySelector("button");
  } else {
    inner = outer;
  }
  if (!inner) {
    console.warn(`[${ADR_CONTROL_KEY}] Vorlage-Control enthält keinen Button — Injection abgebrochen`);
    return null;
  }

  const stripState = (el) => {
    el.classList?.remove?.("active", "selected", "control-active", "ui-active",
                           "control-tool-active", "active-tool");
    el.removeAttribute?.("aria-pressed");
    el.removeAttribute?.("aria-current");
  };
  stripState(outer);
  outer.querySelectorAll("*").forEach(stripState);

  // V13/V14 kann <i>, <svg>, <img>, <picture> als Icon-Träger nutzen.
  outer.querySelectorAll("i, svg, img, picture").forEach(el => el.remove());

  // Ohne Strippen der FontAwesome-Klassen erscheint das Vorlage-Icon
  // (z.B. Bookmark) zusätzlich per ::before-Pseudoelement.
  const stripFa = (el) => {
    if (!el.classList) return;
    Array.from(el.classList)
      .filter(c => c.startsWith("fa-") || c === "fas" || c === "far" || c === "fab")
      .forEach(c => el.classList.remove(c));
  };
  stripFa(outer);
  outer.querySelectorAll("*").forEach(stripFa);

  const stripIdentity = (el) => {
    if (!el.dataset) return;
    delete el.dataset.control;
    delete el.dataset.action;
    delete el.dataset.tool;
  };
  stripIdentity(outer);
  outer.querySelectorAll("*").forEach(stripIdentity);

  // ADR-Identität ausschließlich auf dem inneren Button.
  inner.dataset.control = ADR_CONTROL_KEY;

  const titleStr = game.i18n.localize("argas-dice-roller.controlTitle");
  for (const el of (outer === inner ? [outer] : [outer, inner])) {
    el.setAttribute("aria-label", titleStr);
    el.setAttribute("data-tooltip", titleStr);
    el.removeAttribute("title");
  }

  // Icon als CSS-Maske (.adr-control-icon, assets/icons/d20.svg), damit die
  // Farbe per CSS gesetzt werden kann.
  const newIcon = document.createElement("span");
  newIcon.className = "adr-control-icon";
  newIcon.setAttribute("aria-hidden", "true");
  inner.appendChild(newIcon);

  // order schiebt den Eintrag im Flex-Layout ganz nach unten (harmlos ohne Flex).
  outer.style.setProperty("order", "9999", "important");

  container.appendChild(outer);
  return outer;
}

// Delegierter Klick-Handler (Capture-Phase) für den injizierten Button.
document.addEventListener("click", (ev) => {
  const btn = ev.target?.closest?.(`[data-control="${ADR_CONTROL_KEY}"]`);
  if (!btn) return;
  ev.preventDefault();
  ev.stopImmediatePropagation();
  _adrToggleDiceForm();
}, true);

Hooks.on("renderDiceForm", (app) => {
  globalDiceForm = app;
});

/* ================================================================ */
/*  Request Roll: Button im Würfelfenster → RequestRollForm öffnen   */
/* ================================================================ */

Hooks.once("ready", () => {
  document.body.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-action='open-request-roll']");
    if (!btn) return;

    if (globalDiceForm?.rendered) globalDiceForm.close();

    if (!globalRequestRollForm) globalRequestRollForm = new RequestRollForm();
    if (globalRequestRollForm.rendered) {
      globalRequestRollForm.bringToFront();
    } else {
      globalRequestRollForm.render(true);
    }
  });

  // ── Patzer-Prüfung (GM-Button im Hauptwürfelfenster) ──
  document.body.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-action='adr-fumble-check-main']");
    if (!btn || !game.user.isGM) return;

    const messageId = btn.dataset.messageId;
    const message = game.messages.get(messageId);
    if (!message) return;

    const roll = new Roll("1d6");
    await roll.evaluate();

    // Hook für Tweaks-Integration feuern (Patzer-Check ist ein W6 ohne Trait-Charakter)
    const speakerAlias = message.speaker?.alias || message.flags?.[ADR.ID]?.actorName || "";
    const hookData = {
      roll,
      actor: { name: speakerAlias },
      traitName: game.i18n.localize(`${ADR.ID}.chat.fumbleCheckName`),
      traitType: "w6",
      modifier: 0,
      requestId: null,
      messageId: message.id,
      entryIndex: null,
      rollKind: "free",
      exploding: false,
      hasWildDie: false,
      fumbleMechanic: false,
    };
    const finalRoll = await _fireTraitRollHook(hookData);
    if (finalRoll === false) return;  // Hook hat abgebrochen

    // Total neu berechnen (Tweaks könnte den Würfel-Wert manipuliert haben)
    if (roll?.dice?.length) {
      const sum = roll.dice[0].results.reduce((a, r) => a + (r.result || 0), 0);
      roll._total = sum;
    }

    await _adrShowRoll3d(roll, message);

    // Flag-Update löst renderChatMessageHTML erneut aus.
    await message.update({
      [`flags.${ADR.ID}.fumbleCheckResult`]: roll.total === 1,
      [`flags.${ADR.ID}.fumbleCheckDie`]: roll.total,
    });
  });

  // ── Benny-Button im freien Wurf (echte Reroll-Mechanik) ──
  document.body.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-action='adr-use-benny-free']");
    if (!btn) return;
    if (btn.classList.contains("adr-benny-fumble")) return;  // CSS-seitige Patzer-Sperre
    if (btn.classList.contains("adr-not-mine")) return;      // Nicht-Owner

    const messageId = btn.dataset.messageId;
    const message = game.messages.get(messageId);
    if (!message) return;

    // Patzer-Sperre (server-seitig redundant, falls DOM veraltet)
    if (_adrFreeRollFumbleStatus(message) === "confirmed") {
      ui.notifications.warn(game.i18n.localize(`${ADR.ID}.chat.critical-failure-no-benny`));
      return;
    }

    const subject = freeRollSubject(message);
    if (!subject) return;
    if (!subjectCanClick(subject, message)) {
      ui.notifications.warn(game.i18n.localize(`${ADR.ID}.requestRoll.chatNoPermission`));
      return;
    }

    if (subjectBennies(subject) <= 0) {
      ui.notifications.warn(game.i18n.localize(
        subject.forNPC ? `${ADR.ID}.requestRoll.warn.noGMBennies`
                       : `${ADR.ID}.requestRoll.warn.noBennies`
      ));
      return;
    }

    // Abzug vor dem Wurf; jeder spätere Abbruchpfad muss subjectRefundBenny(subject) aufrufen.
    const spent = await subjectSpendBenny(subject);
    if (!spent) {
      ui.notifications.warn(game.i18n.localize(
        subject.forNPC ? `${ADR.ID}.requestRoll.warn.noGMBennies`
                       : `${ADR.ID}.requestRoll.warn.noBennies`
      ));
      return;
    }

    let mainRoll, wildRoll, sumMod, type, hasWildDie, isExploding, pool;
    try {
      ({ mainRoll, wildRoll, sumMod, type, hasWildDie, isExploding, pool } = await _adrFreshFreeRoll(message));
    } catch (err) {
      console.error(`${ADR.ID} | Benny-Reroll (freier Wurf) Wurf-Fehler:`, err);
      await subjectRefundBenny(subject);
      return;
    }
    if (!mainRoll) {
      await subjectRefundBenny(subject);
      return;
    }

    let fumbleMechanic = false;
    try { fumbleMechanic = !!game.settings.get(ADR.ID, "highlightNaturalOnes"); } catch (e) { /* */ }

    // Multi-Pool: Tweaks-Hook und dice[0]-Total-Neuberechnung überspringen —
    // der Tweaks-Dialog kennt keine Mehrkategorien-Pools, und die dice[0]-Logik
    // sähe nur den ersten Pool-Eintrag.
    const isMultiReroll = Array.isArray(pool) && pool.length > 0;

    if (!isMultiReroll) {
      const combinedDice = [mainRoll.dice[0]];
      if (wildRoll?.dice?.length) combinedDice.push(wildRoll.dice[0]);
      const combinedRoll = {
        dice: combinedDice,
        total: hasWildDie ? Math.max(mainRoll.total, wildRoll.total) : mainRoll.total,
      };
      const hookActor = (subject.kind === "actor")
        ? subject.actor
        : { name: subject.name };
      const hookData = {
        roll: combinedRoll,
        actor: hookActor,
        traitName: game.i18n.localize(`${ADR.ID}.chat.rollName`),
        traitType: type,
        modifier: sumMod,
        requestId: null,
        messageId: message.id,
        entryIndex: null,
        rollKind: "free",
        isBennyReroll: true,
        exploding: isExploding,
        hasWildDie,
        fumbleMechanic,
      };
      const finalRoll = await _fireTraitRollHook(hookData);
      if (finalRoll === false) {
        await subjectRefundBenny(subject);
        return;
      }

      // Totals neu berechnen — der Hook kann Würfelwerte verändert haben.
      if (mainRoll?.dice?.length) {
        const sum = mainRoll.dice[0].results.reduce((a, r) => a + (r.result || 0), 0);
        mainRoll._total = sum + sumMod;
      }
      if (wildRoll?.dice?.length) {
        const sum = wildRoll.dice[0].results.reduce((a, r) => a + (r.result || 0), 0);
        wildRoll._total = sum + sumMod;
      }
    }

    // Würfelsound manuell: Foundry spielt ihn nur bei ChatMessage.create(), hier
    // erfolgt update(). Bei verdeckten Würfen nur lokal, sonst verrät er den Wurf.
    try { foundry.audio.AudioHelper.play({ src: CONFIG.sounds.dice }, !_adrIsHiddenMessage(message)); } catch (e) { /* */ }
    await _adrShowRoll3d(mainRoll, message);
    if (wildRoll) await _adrShowRoll3d(wildRoll, message);

    const newData = _adrExtractFreeRollData(mainRoll, wildRoll, fumbleMechanic, pool);

    // Foundry merget Flag-Objekte rekursiv: zu entfernende Flags müssen explizit
    // gelöscht werden (_adrWriteFlags), sonst bleibt z. B. ein altes
    // `lastRerollFumbleOverwrite=true` hängen.
    const newFlags = foundry.utils.deepClone(message.flags[ADR.ID]);
    const isWildcardSpeaker = !!newFlags.isWildcard;
    const removals = _adrApplyBennyRerollFree(newFlags, newData, isWildcardSpeaker);
    await _adrWriteFlags(message, newFlags, removals);
  });

  // ── Discarded-Patzer-Check im freien Wurf (GM-Button) ──
  // Nachträglicher Patzer-Check des verworfenen Wurfs, wenn dieser beim
  // Benny-Reroll mit einer einzelnen 1 geschützt wurde.
  document.body.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-action='adr-fumble-check-discarded-free']");
    if (!btn || !game.user.isGM) return;

    const messageId = btn.dataset.messageId;
    const message = game.messages.get(messageId);
    if (!message) return;

    const flags = message.flags?.[ADR.ID];
    if (!Array.isArray(flags?.previousRolls) || flags.previousRolls.length === 0) return;
    const lastIdx = flags.previousRolls.length - 1;

    const roll = new Roll("1d6");
    await roll.evaluate();

    const speakerAlias = message.speaker?.alias || flags.actorName || "";
    const hookData = {
      roll,
      actor: { name: speakerAlias },
      traitName: game.i18n.localize(`${ADR.ID}.chat.fumbleCheckName`),
      traitType: "w6",
      modifier: 0,
      requestId: null,
      messageId: message.id,
      entryIndex: null,
      rollKind: "free",
      exploding: false,
      hasWildDie: false,
      fumbleMechanic: false,
    };
    const finalRoll = await _fireTraitRollHook(hookData);
    if (finalRoll === false) return;

    // Total neu berechnen — Tweaks kann den Würfelwert verändert haben.
    if (roll?.dice?.length) {
      const sum = roll.dice[0].results.reduce((a, r) => a + (r.result || 0), 0);
      roll._total = sum;
    }

    await _adrShowRoll3d(roll, message);

    const newFlags = foundry.utils.deepClone(flags);
    newFlags.previousRolls[lastIdx].fumbleCheckResult = roll.total === 1;
    newFlags.previousRolls[lastIdx].fumbleCheckDie = roll.total;
    await message.update({ [`flags.${ADR.ID}`]: newFlags });
  });

  // ── Initial-Wurf: GM nimmt die 1 ohne Patzer-Check an ──
  document.body.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-action='adr-fumble-accept-main']");
    if (!btn || !game.user.isGM) return;

    const messageId = btn.dataset.messageId;
    const message = game.messages.get(messageId);
    if (!message) return;

    await message.update({ [`flags.${ADR.ID}.fumbleCheckAccepted`]: true });
  });

  // ── Pending-Reroll: GM nimmt das Reroll-Ergebnis an (kein Patzer-Check) ──
  // Der Reroll war eine 1, aber kein bestätigter Patzer: Benny-Schutz greift,
  // das alte Ergebnis bleibt geltend.
  document.body.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-action='adr-fumble-pending-accept-free']");
    if (!btn || !game.user.isGM) return;

    const messageId = btn.dataset.messageId;
    const message = game.messages.get(messageId);
    if (!message) return;

    const flags = message.flags?.[ADR.ID];
    if (!flags?.pendingRerollFumbleDecision) return;
    if (!Array.isArray(flags.previousRolls) || flags.previousRolls.length === 0) return;

    const newFlags = foundry.utils.deepClone(flags);
    // Pending-Datenmodell: der alte Wurf ist bereits mainResult, die Reroll-1
    // liegt im letzten previousRolls-Eintrag — kein Swap nötig. fumbleCheckSkipped
    // unterdrückt im Schutz-Hint den „Allerdings war eine 1"-Zusatz und den Check-Button.
    const lastIdx = newFlags.previousRolls.length - 1;
    newFlags.previousRolls[lastIdx].fumbleCheckSkipped = true;
    newFlags.lastRerollProtected = true;
    delete newFlags.pendingRerollFumbleDecision;

    await _adrWriteFlags(message, newFlags, ["pendingRerollFumbleDecision"]);
  });

  // ── Pending-Reroll: GM prüft das Reroll-1 auf Patzer (W6) ──
  // W6=1 → Patzer bestätigt, die 1 bleibt das geltende Ergebnis
  //        (NSC-Patzer-Vorrang via `lastRerollFumbleOverwrite`).
  // W6=2-6 → kein Patzer, die 1 ist nur das schlechtere Ergebnis,
  //          Benny-Schutz greift, altes Ergebnis kommt zurück.
  document.body.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-action='adr-fumble-pending-check-free']");
    if (!btn || !game.user.isGM) return;

    const messageId = btn.dataset.messageId;
    const message = game.messages.get(messageId);
    if (!message) return;

    const flags = message.flags?.[ADR.ID];
    if (!flags?.pendingRerollFumbleDecision) return;
    if (!Array.isArray(flags.previousRolls) || flags.previousRolls.length === 0) return;

    const roll = new Roll("1d6");
    await roll.evaluate();

    const speakerAlias = message.speaker?.alias || flags.actorName || "";
    const hookData = {
      roll,
      actor: { name: speakerAlias },
      traitName: game.i18n.localize(`${ADR.ID}.chat.fumbleCheckName`),
      traitType: "w6",
      modifier: 0,
      requestId: null,
      messageId: message.id,
      entryIndex: null,
      rollKind: "free",
      exploding: false,
      hasWildDie: false,
      fumbleMechanic: false,
    };
    const finalRoll = await _fireTraitRollHook(hookData);
    if (finalRoll === false) return;  // Hook hat abgebrochen

    if (roll?.dice?.length) {
      const sum = roll.dice[0].results.reduce((a, r) => a + (r.result || 0), 0);
      roll._total = sum;
    }

    await _adrShowRoll3d(roll, message);

    const dieValue = roll.total;
    const isFumble = dieValue === 1;

    const newFlags = foundry.utils.deepClone(flags);

    if (isFumble) {
      // Patzer bestätigt: die Reroll-1 (noch im letzten previousRolls-Eintrag)
      // wird per Swap zum geltenden mainResult mit Patzer-Vorrang.
      _adrPendingDecisionSwap(newFlags);
      newFlags.lastRerollFumbleOverwrite = true;
      newFlags.fumbleCheckResult = true;
      newFlags.fumbleCheckDie = dieValue;
    } else {
      // Kein Patzer: mainResult bleibt, die verworfene Reroll-1 erhält das
      // Check-Ergebnis für den Schutz-Hint.
      const lastIdx = newFlags.previousRolls.length - 1;
      newFlags.previousRolls[lastIdx].fumbleCheckResult = false;
      newFlags.previousRolls[lastIdx].fumbleCheckDie = dieValue;
      newFlags.lastRerollProtected = true;
    }
    delete newFlags.pendingRerollFumbleDecision;

    await _adrWriteFlags(message, newFlags, ["pendingRerollFumbleDecision"]);
  });

  // ── Klick auf Akteur-Bild im freien Wurf: Token zentrieren + auswählen ──
  // Bewusst kein Sheet öffnen (wie in der Probenanforderung).
  document.body.addEventListener("click", async (ev) => {
    const img = ev.target.closest(".adr-actor-img");
    if (!img) return;
    const messageEl = img.closest("li.chat-message");
    if (!messageEl) return;
    const messageId = messageEl.dataset.messageId;
    const message = game.messages.get(messageId);
    if (!message) return;

    ev.preventDefault();
    ev.stopPropagation();

    const tokenId = message.speaker?.token;
    const actorId = message.speaker?.actor;
    let token = null;
    if (tokenId) {
      token = canvas?.tokens?.placeables?.find(t => t.document?.id === tokenId);
    }
    if (!token && actorId) {
      token = canvas?.tokens?.placeables?.find(t => t.actor?.id === actorId);
    }
    if (token) {
      token.control({ releaseOthers: true });
      await canvas.animatePan({ x: token.center.x, y: token.center.y, duration: 250 });
    }
  });
});

/* ================================================================ */
/*  Verdeckte-Würfe-Toggle: eigenständiger Fenster-Zustand            */
/* ================================================================ */

/*
 * Der Toggle (SL-/Blind-/Eigenwurf) ist reiner Fenster-Zustand in
 * `DiceForm.hiddenType`. Bewusst KEIN Foundry-Würfelmodus-Setting:
 * `core.rollMode` ist seit v14 zugunsten von `core.messageMode` deprecatet
 * (Wegfall mit v16). Keine Sync mit dem Chat-Selektor; _rollDie setzt
 * whisper/blind direkt.
 */

/* ================================================================ */
/*  renderChatMessageHTML – komplett vanilla DOM (kein jQuery)       */
/* ================================================================ */

/**
 * Defensives Verstecken einer Chat-LI: mehrere !important-Werte plus geleerter
 * Inhalt, damit auch bei fremdem Überschreiben von display:none nichts zu sehen ist.
 */
function _adrHideMessage(li) {
  if (!li) return;
  li.style.setProperty("display", "none", "important");
  li.style.setProperty("visibility", "hidden", "important");
  li.style.setProperty("height", "0", "important");
  li.style.setProperty("min-height", "0", "important");
  li.style.setProperty("margin", "0", "important");
  li.style.setProperty("padding", "0", "important");
  li.style.setProperty("border", "0", "important");
  li.style.setProperty("overflow", "hidden", "important");
  li.setAttribute("hidden", "");
  li.setAttribute("aria-hidden", "true");
  while (li.firstChild) li.removeChild(li.firstChild);
}

/* ---------------------------------------------------------------- */
/*  Multi-Pool-Render-Helper (Mehrfach-Würfel-Auswahl per Strg+Klick) */
/* ---------------------------------------------------------------- */

/**
 * Display-Text der Hauptzeile eines Multi-Pool-Wurfs: mit Wild Die oder
 * ≥ 4 Kategorien „div. Würfel", sonst „2x W4 + 3x W20".
 */
function _adrBuildMultiPoolDisplayHTML(pool, hasWild, exploding) {
  const useDiv = hasWild || pool.length >= 4;
  const exSup = exploding ? "<sup class='adr-ex'>ex</sup>" : "";
  if (useDiv) {
    return game.i18n.localize(`${ADR.ID}.chat.multiDiceMixed`) + exSup;
  }
  const plus = game.i18n.localize(`${ADR.ID}.chat.multiDicePlus`);
  const isGerman = String(game.i18n.lang || "").startsWith("de");
  const parts = pool.map(p => {
    const label = isGerman ? String(p.type).replace(/^[dD]/, "W") : String(p.type);
    return `${p.count}x ${label}`;
  });
  return parts.join(` ${plus} `) + exSup;
}

/** Detail-Anzeige (Toggle-Inhalt) eines Multi-Pool-Wurfs: eine Zeile je Kategorie. */
function _adrBuildMultiPoolDetailsHTML(multiPoolResults, wildResult, wildIndRes, appliedMod) {
  const isGerman = String(game.i18n.lang || "").startsWith("de");
  let html = "";
  for (const cat of (multiPoolResults || [])) {
    const label = isGerman ? String(cat.type).replace(/^[dD]/, "W") : String(cat.type);
    const valuesHTML = (cat.results || []).map(r => {
      const cls = r.class ? ` class="${r.class}"` : "";
      return `<span${cls}>${r.display}</span>`;
    }).join(", ");
    html += `<div class="adr-multi-line">`
      + `<span class="adr-multi-cat-label">${cat.count}x ${label}:</span> `
      + valuesHTML
      + `</div>`;
  }
  const extras = [];
  if (wildResult != null && Array.isArray(wildIndRes) && wildIndRes.length) {
    const wdLabel = game.i18n.localize(`${ADR.ID}.legend.wildDieChat`);
    const wdValues = wildIndRes.map(r => {
      const cls = r.class ? ` class="${r.class}"` : "";
      return `<span${cls}>${r.display}</span>`;
    }).join(", ");
    extras.push(`<span class="adr-group-detail-wild">(${wdLabel}: ${wdValues})</span>`);
  }
  if (appliedMod != null && Number(appliedMod) !== 0) {
    const mLabel = game.i18n.localize(`${ADR.ID}.individualResults.appliedModifierLabelShort`);
    const m = Number(appliedMod);
    const sign = m > 0 ? "+" : "";
    const cls = m > 0 ? "adr-applied-mod-pos" : "adr-applied-mod-neg";
    extras.push(`<span class="adr-applied-mod">(${mLabel} <span class="${cls}">${sign}${m}</span>)</span>`);
  }
  if (extras.length) {
    html += `<div class="adr-multi-line adr-multi-line-extras">${extras.join(" ")}</div>`;
  }
  return html;
}

Hooks.on("renderChatMessageHTML", (message, html) => {
  const li = html.closest("li.chat-message") ?? html;

  function _setHeaderLabel(container, label) {
    const header = container.querySelector(".message-header");
    if (!header) return;

    let adrLabel = header.querySelector(".adr-header-label");
    if (!adrLabel) {
      adrLabel = document.createElement("span");
      adrLabel.className = "adr-header-label";
      header.prepend(adrLabel);
    }
    adrLabel.textContent = label;

    const h4 = header.querySelector("h4");
    if (h4) h4.style.setProperty("display", "none", "important");
  }

  // ── Fate-Roll: Hintergrund per Overlay-Layer erzwingen ──
  if (message.getFlag(ADR.ID, "fate")) {
    li.classList.add("adr-chat", "adr-fate");

    const bgUrl = `modules/${ADR.ID}/assets/layout/background_finger.webp`;

    li.style.setProperty("position", "relative", "important");
    li.style.setProperty("background", "transparent", "important");
    li.style.setProperty("min-height", "260px", "important");
    li.style.setProperty("aspect-ratio", "1 / 1", "important");

    li.querySelector(".adr-fate-bg")?.remove();
    const layer = document.createElement("div");
    layer.className = "adr-fate-bg";
    layer.style.position = "absolute";
    layer.style.inset = "0";
    layer.style.pointerEvents = "none";
    layer.style.zIndex = "0";
    layer.style.backgroundImage = `url("${bgUrl}")`;
    layer.style.backgroundRepeat = "no-repeat";
    layer.style.backgroundPosition = "center center";
    layer.style.backgroundSize = "contain";
    li.prepend(layer);

    _setHeaderLabel(li, game.i18n.localize(`${ADR.ID}.chat.fateTitle`));

    li.querySelectorAll(".message-content, .dice-result, .chat-card, .card-content, .message-header")
      .forEach(el => {
        el.style.setProperty("background", "transparent", "important");
        el.style.setProperty("background-image", "none", "important");
        el.style.setProperty("box-shadow", "none", "important");
        if (!el.style.position) el.style.position = "relative";
        el.style.zIndex = "1";
      });
    return;
  }

  // ── Nur ADR-Nachrichten weiter verarbeiten ──
  if (!message.flags?.["argas-dice-roller"]?.mainFormula) return;

  // ── Privater Wurf (selfRoll): nur der Würfelnde sieht etwas. ──
  // Foundry zeigt Whisper standardmäßig auch SLs — daher zusätzlich zur
  // Whisper-Liste hier verstecken. Heuristik (Whisper nur an den Autor) als
  // Fallback für Nachrichten ohne Flag.
  const _whisperList = message.whisper ?? [];
  const _isSelfRollFlag = message.getFlag(ADR.ID, "isSelfRoll") === true;
  const _looksLikeSelfRoll = _whisperList.length === 1 && _whisperList[0] === message.author?.id;
  const _isSelfRollMsg = _isSelfRollFlag || _looksLikeSelfRoll;
  if (_isSelfRollMsg) {
    if (message.author?.id !== game.user.id) {
      _adrHideMessage(li);
      return;
    }
  }

  // ── SL-/Blindwurf: nur SLs und der Autor sehen etwas. ──
  // Erkennung: hideRecipients-Flag (GM_ROLL, BLIND_ROLL) plus Heuristik
  // (Whisper ausschließlich an SL-User).
  const _hideRecipientsFlag = message.getFlag(ADR.ID, "hideRecipients") === true;
  const _looksLikeGMOnlyWhisper = _whisperList.length > 0
    && _whisperList.every(id => game.users.get(id)?.isGM);
  const _isGMOnlyMsg = _hideRecipientsFlag || _looksLikeGMOnlyWhisper;
  if (_isGMOnlyMsg && !game.user.isGM && message.author?.id !== game.user.id) {
    _adrHideMessage(li);
    return;
  }

  // ── Re-Lokalisierung: Marker des Würfler-Clients in der Sprache des
  //    Betrachters füllen (innerHTML, weil i18n-Strings HTML enthalten dürfen).
  html.querySelectorAll("[data-adr-i18n]").forEach(el => {
    el.innerHTML = game.i18n.localize(el.dataset.adrI18n);
  });
  html.querySelectorAll("[data-adr-hidden-key]").forEach(el => {
    let key = el.dataset.adrHiddenKey;
    // gmRoll eines Spielers aus GM-Sicht: der Text ist aus Würfler-Sicht
    // formuliert ("…und für Dich"), daher GM-spezifischer Schlüssel.
    if (key === "gmRoll" && game.user?.isGM && message.author && !message.author.isGM) {
      key = "gmRollViewedByGM";
    }
    el.innerHTML = buildHiddenInfoHTML(key);
  });

  // ── Einzelergebnis-Toggle (Aufklappbar) ──
  html.querySelectorAll(".adr-individual-toggle").forEach(toggle => {
    toggle.addEventListener("click", function () {
      const details = this.nextElementSibling;
      if (details?.classList.contains("adr-individual-details")) {
        details.classList.toggle("adr-individual-hidden");
        // Beim Aufklappen Chat-Log nachscrollen, damit alles sichtbar ist.
        if (!details.classList.contains("adr-individual-hidden")) {
          void details.offsetHeight;   // Reflow erzwingen
          setTimeout(() => {
            const li = this.closest("li.chat-message");
            if (li) {
              const scrollContainer = li.closest(".chat-scroll");
              if (scrollContainer) {
                const liRect = li.getBoundingClientRect();
                const containerRect = scrollContainer.getBoundingClientRect();
                const overflow = liRect.bottom - containerRect.bottom;
                if (overflow > 0) {
                  scrollContainer.scrollTop += overflow + 8;
                }
              }
            }
          }, 50);
        }
      }
    });
  });

  // ── Zweizeiliger Akteurname ──
  // Der Hook feuert vor dem Einhängen ins Dokument (offsetHeight = 0), daher
  // Messung auf den nächsten Frame verschieben.
  const nameBox = html.querySelector(".adr-actor-name");
  if (nameBox) {
    html.classList.add("one-line");
    requestAnimationFrame(() => {
      if (nameBox.isConnected && nameBox.offsetHeight > 40) {
        html.classList.remove("one-line");
        html.classList.add("two-line");
      }
    });
  }

  // ── Empfängerzeile ausblenden ──
  if (message.getFlag("argas-dice-roller", "hideRecipients")) {
    li.classList.add("adr-hide-recipients");
    li.querySelectorAll(".message-target, .whisper-to, .message-metadata .whisper, [data-tooltip='Recipients']")
      .forEach(el => el.remove());
  }

  // ── Blind-Roll für Nicht-GMs verstecken ──
  const isBlindForUser = message.blind && !game.user.isGM;

  if (!message.isContentVisible || isBlindForUser) {
    li.setAttribute("data-adr-hidden", "true");
    li.classList.add("adr-chat");
    li.classList.remove("with-wild", "no-wild");
    if (message.getFlag(ADR.ID, "fate")) li.classList.add("adr-fate");
    html.querySelectorAll(".flavor-text").forEach(el => el.remove());

    const actorName = message.getFlag(ADR.ID, "actorName")
      || game.i18n.localize(`${ADR.ID}.chat.unknownActor`);
    const defaultSrc = `modules/${ADR.ID}/assets/layout/default_token.webp`;
    const flagSrc = message.getFlag(ADR.ID, "actorImg") || "";
    // Akteurname/Bildpfad sind Nutzereingaben — vor dem Einfügen escapen.
    const esc = foundry.utils.escapeHTML;
    const portraitSrc = esc(flagSrc || defaultSrc);

    _setHeaderLabel(li, game.i18n.localize(`${ADR.ID}.legend.freeRollLabel`));

    li.querySelector(".message-header")?.insertAdjacentHTML("afterend",
      `<img class="adr-actor-img" src="${portraitSrc}" alt="Portrait">`);

    const msgContent = html.querySelector(".message-content");
    if (msgContent) {
      msgContent.innerHTML = `<div class="adr-actor-name"><span class="adr-actor-name-text">${esc(actorName)}</span></div><div class="adr-result-container"><div class="adr-dice-value">???</div><div class="adr-dice-content"></div></div>`;
    }

    let hiddenInfoKey;
    const sender = message.author;
    const whisperIds = message.whisper ?? [];
    const isBlind = message.blind;
    const isSelfRoll = whisperIds.length === 1 && whisperIds[0] === sender?.id;
    const isWhisperToGMOnly = whisperIds.length > 0 && whisperIds.every(id => game.users.get(id)?.isGM);
    const isSenderGM = sender?.isGM;
    const isCurrentUserGM = game.user?.isGM;

    if (isBlind) hiddenInfoKey = "blindRoll";
    else if (isSelfRoll) hiddenInfoKey = "selfRoll";
    else if (isWhisperToGMOnly) hiddenInfoKey = isSenderGM ? "gmRoll" : "gmToPlayerRoll";
    else hiddenInfoKey = "gmRoll";

    if (hiddenInfoKey === "gmRoll" && !isCurrentUserGM && isSenderGM && whisperIds.length === 1 && whisperIds[0] === game.users.find(u => u.isGM)?.id) {
      hiddenInfoKey = "gmToPlayerRoll";
    }

    const hiddenInfo = buildHiddenInfoHTML(hiddenInfoKey);
    html.querySelector(".adr-dice-content")?.insertAdjacentHTML("beforeend",
      `<div class="adr-dice-label adr-dice-hidden">${hiddenInfo}</div>`);
    return;
  }

  // ── Sichtbare Nachricht aufbereiten ──
  html.querySelectorAll(".flavor-text").forEach(el => el.remove());
  html.querySelectorAll(".dice-total").forEach(el => el.classList.remove("dice-total"));
  html.querySelectorAll(".dice-result").forEach(el => el.classList.remove("dice-result"));

  const adrChatWrap = html.querySelector(".message-content > .adr-chat");
  if (adrChatWrap) {
    const parent = adrChatWrap.parentNode;
    while (adrChatWrap.firstChild) parent.insertBefore(adrChatWrap.firstChild, adrChatWrap);
    adrChatWrap.remove();
  }

  li.classList.add("adr-chat");
  li.classList.remove("with-wild", "no-wild");
  if (message.getFlag(ADR.ID, "fate")) li.classList.add("adr-fate");

  // "standard" erreicht diesen Hook nicht — solche Würfe entstehen ohne ADR-Render.
  const scifi = game.settings.get(ADR.ID, "chatDesign") === "modern";
  if (scifi) li.classList.add("scifi");

  if (message.getFlag(ADR.ID, "wildResult") !== undefined) li.classList.add("with-wild");

  _setHeaderLabel(li, game.i18n.localize(`${ADR.ID}.legend.freeRollLabel`));

  const modulePath = `modules/${ADR.ID}`;
  const flagSrc = message.getFlag(ADR.ID, "actorImg") || "";
  const defaultSrc = `${modulePath}/assets/layout/default_token.webp`;
  const portraitSrc = foundry.utils.escapeHTML(flagSrc || defaultSrc);
  if (portraitSrc) {
    li.querySelector(".message-header")?.insertAdjacentHTML("afterend",
      `<img class="adr-actor-img" src="${portraitSrc}" alt="Portrait">`);
  }

  const actorName = message.getFlag(ADR.ID, "actorName")
    || game.i18n.localize(`${ADR.ID}.chat.unknownActor`);
  li.querySelector(".adr-actor-name")?.remove();
  li.querySelector(".adr-body")?.insertAdjacentHTML("beforebegin",
    `<div class="adr-actor-name"><span class="adr-actor-name-text">${foundry.utils.escapeHTML(actorName)}</span></div>`);

  const rawFormula = message.getFlag(ADR.ID, "mainFormula") || "";
  const clean = rawFormula.replace(/\s+/g, "");

  // ── Multi-Pool-Erkennung ──
  // Multi-Pool umgeht parseDice/buildCell (nur für Einzelformeln); `mainFormula`
  // ist dort nur der Marker "_multi_pool" für die ADR-Erkennung oben.
  const multiPool = message.getFlag(ADR.ID, "multiPool");
  const isMulti = Array.isArray(multiPool) && multiPool.length > 0;

  function parseDice(formula) {
    // Suffixe kh/kl (Höchster/Niedrigster), b1/p2 (Cthulhu) und x/! (Explodieren)
    // werden für die Anzeige überlesen.
    const m = formula.match(/^(?:([0-9]+))?(dc|df|d[0-9]+)(?:k[hl])?(?:[bp][12])?(?:[x!]+)?([+\-][0-9]+)?/) || [];
    const cnt = m[1] || "";
    const raw = m[2] || "";
    const mod = m[3] || "";
    const die = raw === "dc"
      ? game.i18n.localize(`${ADR.ID}.legend.coin`)
      : (adrIsFudge(raw) ? adrFudgeChatLabel() : (game.i18n.lang.startsWith("de") ? raw.replace(/^d/, "W") : raw));
    return { cnt, die, mod };
  }

  const { cnt: cnt1, die: die1, mod: mod1 } = isMulti
    ? { cnt: "", die: "", mod: "" }
    : parseDice(clean);
  const mainResult = message.getFlag(ADR.ID, "mainResult");
  const wildFormula = message.getFlag(ADR.ID, "wildFormula") || clean;
  const wildClean   = String(wildFormula).replace(/\s+/g, "");
  const { cnt: cnt2, die: die2, mod: mod2 } = isMulti
    ? { cnt: "", die: "", mod: "" }
    : parseDice(wildClean);
  const wildResult = message.getFlag(ADR.ID, "wildResult");

  const buildCell = (cnt, die, mod, value, individualResults = [], highlightSetting = false, criticalHtml = "") => {
    let highlight = false;
    // Münz-Erkennung NUR über das Label — eine Werte-Heuristik (alle 0/1) würde
    // jeden Einzelwürfel mit Ergebnis 1 als Münze einstufen und das Einsen-Highlight unterdrücken.
    const isCoin = (die === game.i18n.localize(`${ADR.ID}.legend.coin`));
    // Fudge: keine Einsen-Regel, stattdessen Extremfälle (alle +/alle −) markieren.
    const isFudgeCell = (die === adrFudgeChatLabel());
    let fudgeClass = "";
    if (isFudgeCell && individualResults.length) {
      if (individualResults.every(x => Number(x.value) === 1)) fudgeClass = " adr-fudge-all-plus";
      else if (individualResults.every(x => Number(x.value) === -1)) fudgeClass = " adr-fudge-all-minus";
    }
    if (highlightSetting && !isCoin && !isFudgeCell) {
      // Bei „Höchster/Niedrigster" nur die gewerteten Würfel betrachten.
      const counted = individualResults.filter(x => !x?.discarded);
      if (counted.length === 1 && counted[0].value == 1) highlight = true;
      if (counted.length > 1) {
        const numOnes = counted.filter(x => x.value == 1).length;
        if (numOnes > counted.length / 2) highlight = true;
      }
    }
    const isWildCell = (die === game.i18n.localize(`${ADR.ID}.legend.wildDieChat`));
    const starFlag = isWildCell
      ? message.getFlag("argas-dice-roller", "wildExploding")
      : message.getFlag("argas-dice-roller", "mainExploding");
    // Keep-Icon nur in der Hauptzelle.
    const keepMode = isWildCell ? null : adrKeepModifier(message.getFlag(ADR.ID, "keepMode"));
    let keepHTML = keepMode
      ? ` <i class="fa-regular ${keepMode === "kh" ? "fa-square-up" : "fa-square-down"} adr-keep-icon" title="${game.i18n.localize(`${ADR.ID}.chat.${keepMode === "kh" ? "keepHighest" : "keepLowest"}`)}"></i>`
      : "";
    const cth = isWildCell ? null : message.getFlag(ADR.ID, "cthulhu");
    const cthMode = adrCthulhuMode(cth?.mode);
    if (cthMode) {
      const n = Math.min(2, Math.max(1, Number(cth.extra) || 1));
      keepHTML = ` <span class="adr-cthulhu-mark" title="${game.i18n.localize(`${ADR.ID}.chat.${cthMode === "bonus" ? "bonusDie" : "penaltyDie"}`)}"><i class="fa-regular ${cthMode === "bonus" ? "fa-thumbs-up" : "fa-thumbs-down"} adr-keep-icon"></i>${n}</span>`;
    }
    const isCoinCell = (die === game.i18n.localize(`${ADR.ID}.legend.coin`));

    // Münzzelle zeigt "Münzwurf" statt "1x Münze".
    const diceInfoHTML = isCoinCell
      ? game.i18n.localize(`${ADR.ID}.chat.coin-roll-label`)
      : `${(die === game.i18n.localize(`${ADR.ID}.legend.wildDieChat`) ? "" : (cnt ? `${cnt}x ` : ""))}${die}${(starFlag ? "<sup class=\"adr-ex\">ex</sup>" : "")}${keepHTML}${mod ? `<span class="adr-dice-mod adr-dice-mod-${mod.startsWith("+") ? "pos" : "neg"}">(${mod})</span>` : ""}`;

    return `<div class="adr-dice-cell${isCoinCell ? " adr-coin-cell" : ""}${isFudgeCell ? " adr-fudge-cell" : ""}">
    <div class="adr-dice-info">
      ${diceInfoHTML}
    </div>
    <div class="adr-summary-total${highlight ? ' adr-highlight-ones' : ''}${fudgeClass}">
      ${(die === game.i18n.localize(`${ADR.ID}.legend.coin`) && (!mod || mod === "0") && individualResults.length === 1)
        ? `~ ${game.i18n.localize(value == 1 ? `${ADR.ID}.chat.coin-tails` : `${ADR.ID}.chat.coin-heads`)} ~`
        : (value !== undefined && value !== null ? (isFudgeCell ? adrSignedNumber(value) : value) : `<span class="adr-dice-value">???</span>`)}
      ${criticalHtml}
    </div>
  </div>`;
  };

  // Zellbau für Multi-Pool ohne die parseDice-Mechanik.
  const buildMultiCell = (displayHTML, value, modHTML = "") => {
    return `<div class="adr-dice-cell">
      <div class="adr-dice-info">${displayHTML}${modHTML}</div>
      <div class="adr-summary-total">${value !== undefined && value !== null ? value : `<span class="adr-dice-value">???</span>`}</div>
    </div>`;
  };

  const mainIndRes = message.getFlag("argas-dice-roller", "mainIndividualResults") ?? [];
  const wildIndRes = message.getFlag("argas-dice-roller", "wildIndividualResults") ?? [];
  const hasWild = (wildResult != null);

  const onesMain = mainIndRes.filter(x => x?.value == 1).length;
  const totalMain = mainIndRes.length;
  const totalDiceForCritical = hasWild ? (totalMain + 1) : totalMain;
  const onesForCritical = hasWild ? (onesMain + (wildResult == 1 ? 1 : 0)) : onesMain;
  const isCoinRow = !isMulti && (die1 === game.i18n.localize(`${ADR.ID}.legend.coin`));
  // SWADE-Eigenschaftsproben explodieren immer — ohne Explodieren ist es keine
  // Eigenschaftsprobe, also kein Patzer-Verdacht.
  const mainExploding = !!message.getFlag("argas-dice-roller", "mainExploding");

  // Patzer-Anzeige bei Multi-Pool deaktiviert.
  let showCritical = !isMulti
    && mainExploding
    && hasWild && (wildResult == 1) && (onesForCritical > totalDiceForCritical / 2)
    && game.settings.get("argas-dice-roller", "highlightNaturalOnes");
  if (isCoinRow) showCritical = false;

  let cellsHtml;
  if (isMulti) {
    // Modifikator nur einmal in der Hauptzelle, nicht an der WD-Zelle.
    const sumMod = Number(message.getFlag(ADR.ID, "appliedModifier")) || 0;
    const multiDisplayHTML = _adrBuildMultiPoolDisplayHTML(multiPool, hasWild, mainExploding);
    const modHTML = sumMod !== 0
      ? `<span class="adr-dice-mod adr-dice-mod-${sumMod > 0 ? "pos" : "neg"}">(${sumMod > 0 ? "+" : ""}${sumMod})</span>`
      : "";
    const wildExploding = !!message.getFlag(ADR.ID, "wildExploding");
    const wildLabel = game.i18n.localize(`${ADR.ID}.legend.wildDieChat`);
    const wildDisplayHTML = wildLabel + (wildExploding ? "<sup class='adr-ex'>ex</sup>" : "");

    cellsHtml = buildMultiCell(multiDisplayHTML, mainResult, modHTML);
    if (hasWild) {
      cellsHtml += `<div class="adr-iron-bar"><img src="${modulePath}/assets/layout/bar_${scifi ? "sf" : "f"}.webp" alt="Separator" /></div>`
        + buildMultiCell(wildDisplayHTML, wildResult, "");
    }
  } else {
    cellsHtml = `${
      buildCell(cnt1, die1, mod1, mainResult, mainIndRes,
        game.settings.get("argas-dice-roller", "highlightNaturalOnes") && !message.getFlag(ADR.ID, "cthulhu"), "")
    }${
      hasWild
        ? `<div class="adr-iron-bar"><img src="${modulePath}/assets/layout/bar_${scifi ? "sf" : "f"}.webp" alt="Separator" /></div>${
            buildCell(cnt2, game.i18n.localize(`${ADR.ID}.legend.wildDieChat`), mod2, wildResult,
              wildIndRes, game.settings.get("argas-dice-roller", "highlightNaturalOnes"), "")
          }`
        : ""
    }`;
  }

  li.querySelector(".adr-actor-name")?.insertAdjacentHTML("afterend",
    `<div class="adr-dice-row">${cellsHtml}</div>`);

  if (showCritical) {
    const rows = li.querySelectorAll(".adr-dice-row");
    const lastRow = rows[rows.length - 1];
    const prefix = game.i18n.localize(`${ADR.ID}.chat.critical-failure-prefix`);
    const label = game.i18n.localize(`${ADR.ID}.chat.critical-failure`);
    lastRow?.insertAdjacentHTML("afterend",
      `<div class="adr-fumble-check-result">${prefix}<br><span class="adr-fumble-confirmed-text" style="font-size:0.85rem;">${label}</span></div>`);
  }

  // ── Patzer-Prüfung: Einzelwürfel ohne Wild Die zeigt 1 → GM-Button ──
  // Nur bei Statisten: Wildcards werfen bei Eigenschaftsproben immer einen Wild
  // Die mit, ein Einzelwürfel ohne Wild Die ist bei ihnen keine Eigenschaftsprobe.
  const isWildcardSpeaker = !!message.getFlag(ADR.ID, "isWildcard");
  const fumbleCheckNeeded = !isMulti && mainExploding && !hasWild && !isCoinRow && totalMain === 1
    && mainIndRes[0]?.value == 1
    && !isWildcardSpeaker
    && game.settings.get("argas-dice-roller", "highlightNaturalOnes");

  if (fumbleCheckNeeded) {
    const fumbleCheckResult = message.getFlag(ADR.ID, "fumbleCheckResult");
    const fumbleCheckDie = message.getFlag(ADR.ID, "fumbleCheckDie");
    const rows = li.querySelectorAll(".adr-dice-row");
    const lastRow = rows[rows.length - 1];

    if (fumbleCheckResult === true) {
      const summaryTotal = li.querySelector(".adr-summary-total");
      if (summaryTotal) summaryTotal.classList.add("adr-highlight-ones");
      // Im FumbleOverwrite-Pfad rendert die Hint-Region den Ergebnistext
      // (bennyFumbleOverwriteHintConfirmed).
      if (message.getFlag(ADR.ID, "lastRerollFumbleOverwrite") !== true) {
        const keyword = game.i18n.localize(`${ADR.ID}.requestRoll.fumbleCheckYes`);
        const template = game.i18n.localize(`${ADR.ID}.requestRoll.fumbleCheckTextYes`);
        lastRow?.insertAdjacentHTML("afterend",
          `<div class="adr-fumble-check-result">${template.replace("{result}", `<span class="adr-fumble-confirmed-text">${keyword}</span>`)}</div>`);
      }

    } else if (fumbleCheckResult === false) {
      const keyword = game.i18n.localize(`${ADR.ID}.requestRoll.fumbleCheckNone`);
      const template = game.i18n.localize(`${ADR.ID}.requestRoll.fumbleCheckTextNo`);
      lastRow?.insertAdjacentHTML("afterend",
        `<div class="adr-fumble-check-result">${template.replace("{result}", `<span class="adr-fumble-denied-text">${keyword}</span>`)}</div>`);

    } else if (message.getFlag(ADR.ID, "fumbleCheckAccepted") === true) {
      // GM hat die 1 akzeptiert — kein Patzer-Check.

    } else if (message.getFlag(ADR.ID, "pendingRerollFumbleDecision") === true) {
      // Auswahl rendert der Pending-Hint unten.

    } else if (message.getFlag(ADR.ID, "bennyUsed") === true) {
      // Anzeige übernimmt die Hint-Region.

    } else {
      const isGM = game.user.isGM;
      const acceptLabel = game.i18n.localize(`${ADR.ID}.requestRoll.acceptResultBtn`);
      const orLabel = game.i18n.localize(`${ADR.ID}.requestRoll.orChoice`);
      const line1 = game.i18n.localize(`${ADR.ID}.requestRoll.fumbleCheckBtn1`);
      const line2 = game.i18n.localize(`${ADR.ID}.requestRoll.fumbleCheckBtn2`);
      const notMineCls = isGM ? "" : " adr-not-mine";
      // Inline !important nötig: das System-CSS für button:hover ist spezifischer.
      const notMineAttrs = isGM
        ? ""
        : ` title="${game.i18n.localize(`${ADR.ID}.requestRoll.chatNoPermission`)}" style="cursor: not-allowed !important"`;
      lastRow?.insertAdjacentHTML("afterend",
        `<div class="adr-fumble-choice-container">`
        + `<button type="button" class="adr-accept-result-btn${notMineCls}"${notMineAttrs} data-action="adr-fumble-accept-main" data-message-id="${message.id}">${acceptLabel}</button>`
        + `<span class="adr-fumble-choice-or">${orLabel}</span>`
        + `<button type="button" class="adr-fumble-check-btn${notMineCls}"${notMineAttrs} data-action="adr-fumble-check-main" data-message-id="${message.id}">${line1} ${line2}</button>`
        + `</div>`);
    }

    if (fumbleCheckResult != null) {
      setTimeout(() => {
        const scrollContainer = li.closest(".chat-scroll");
        if (scrollContainer) {
          const liRect = li.getBoundingClientRect();
          const containerRect = scrollContainer.getBoundingClientRect();
          const overflow = liRect.bottom - containerRect.bottom;
          if (overflow > 0) scrollContainer.scrollTop += overflow + 8;
        }
      }, 50);
    }
  }

  _adrInjectFreeRollBennyButton(li, message);
  _adrInjectFreeRollDiscardedHistory(li, message);
  _adrInjectFreeRollHint(li, message);
});

/* ================================================================ */
/*  Free-Roll Benny-Button: Helpers + Klick-Handler                  */
/* ================================================================ */

/**
 * Patzer-Status des freien Wurfs. Bewusst NICHT über `_classifyFumble` aus
 * adr-request-roll-chat.js — der erwartet ein diceDetails-Schema, das es im
 * freien Wurf nicht gibt.
 * @returns {"confirmed"|"needs-check"|"none"} confirmed = Reroll gesperrt,
 *   needs-check = GM-W6-Check steht aus (Reroll erlaubt).
 */
function _adrFreeRollFumbleStatus(message) {
  const f = message.flags?.[ADR.ID] || {};

  // Multi-Pool: Patzer-Mechanik aus, Reroll bleibt erlaubt.
  if (Array.isArray(f.multiPool) && f.multiPool.length > 0) return "none";

  if (f.fumbleCheckResult === true) return "confirmed";

  let fumbleEnabled = false;
  try { fumbleEnabled = game.settings.get(ADR.ID, "highlightNaturalOnes"); }
  catch (e) { /* Setting eventuell noch nicht registriert */ }
  if (!fumbleEnabled) return "none";

  const wildResult = f.wildResult;
  const hasWild = wildResult != null;
  const mainIndRes = Array.isArray(f.mainIndividualResults) ? f.mainIndividualResults : [];
  const totalMain = mainIndRes.length;
  const onesMain = mainIndRes.filter(x => x?.value == 1).length;

  if (String(f.dieType || "").toLowerCase() === "dc") return "none";

  if (hasWild) {
    // Mit Wild Die kann ein Patzer-Bild auch aus Schadens- oder Mehrfachwürfen
    // entstehen; ob es eine Eigenschaftsprobe war, ist unbekannt — Reroll bleibt
    // erlaubt, der weiche Hinweis (showCritical) erscheint trotzdem.
    return "none";
  }

  // Statisten: nur genau ein Hauptwürfel = 1 ist ein Patzer-Verdacht. Wildcards
  // ohne Wild Die und nicht explodierende Würfe sind keine Eigenschaftsproben.
  if (f.isWildcard) return "none";
  if (!f.mainExploding) return "none";
  if (totalMain === 1 && mainIndRes[0]?.value == 1) return "needs-check";
  return "none";
}

/**
 * Benny-Button in die Karte des freien Wurfs injizieren. Zustände: bestätigter
 * Patzer → gesperrt (SWADE: Patzer nicht reroll-bar), Nicht-Owner → ausgegraut,
 * Reroll erfolgt → grüner Ring.
 */
function _adrInjectFreeRollBennyButton(li, message) {
  // Bennies sind reine SWADE-Mechanik.
  if (game.system.id !== "swade") return;

  const f = message.flags?.[ADR.ID] || {};
  if (!f.mainFormula) return;
  if (f.fate) return;
  if (f.requestRoll) return;      // eigener Button-Pfad
  if (adrIsFudge(f.dieType)) return;  // Fudge, Cthulhu, Keep: keine SWADE-Mechaniken — kein Benny
  if (f.cthulhu) return;
  if (adrKeepModifier(f.keepMode)) return;

  const toggleContainer = li.querySelector(".adr-individual-toggle-container");
  if (!toggleContainer) return;
  const toggle = toggleContainer.querySelector(".adr-individual-toggle");
  if (!toggle) return;

  // Idempotenz bei erneutem Rendern.
  toggleContainer.querySelector(":scope > .adr-benny-btn")?.remove();
  toggleContainer.classList.remove("adr-has-benny");
  li.querySelector(":scope .adr-benny-btn-wrapper")?.remove();

  const subject = freeRollSubject(message);
  if (!subject) return;

  const fumbleStatus = _adrFreeRollFumbleStatus(message);
  const bennyUsed = !!f.bennyUsed;
  const canClick = subjectCanClick(subject, message);

  const classes = ["adr-benny-btn"];
  let title;
  if (fumbleStatus === "confirmed") {
    classes.push("adr-benny-fumble");
    title = game.i18n.localize(`${ADR.ID}.chat.critical-failure-no-benny`);
  } else if (!canClick) {
    classes.push("adr-not-mine");
    title = game.i18n.localize(`${ADR.ID}.requestRoll.chatNoPermission`);
  } else {
    if (bennyUsed) classes.push("adr-benny-used");
    title = game.i18n.localize(
      subject.forNPC ? `${ADR.ID}.requestRoll.bennyTooltipNPC`
                     : `${ADR.ID}.requestRoll.bennyTooltip`
    );
  }

  // Button ans ENDE des Containers, NACH den Details: der Toggle-Handler
  // findet die Details über `this.nextElementSibling`. Die Position rechts
  // neben dem Toggle regelt das Grid (`.adr-has-benny`).
  toggleContainer.classList.add("adr-has-benny");

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = classes.join(" ");
  btn.dataset.action = "adr-use-benny-free";
  btn.dataset.messageId = message.id;
  btn.title = title;
  btn.innerHTML = `<img src="systems/swade/assets/benny/benny-chip-front.png" alt="Benny" />`;
  toggleContainer.appendChild(btn);
}

/** Chat-Kürzel des Fudge-Würfels: „WF" (de) bzw. „dF" (en). */
function adrFudgeChatLabel() {
  return String(game.i18n.lang || "").startsWith("de") ? "WF" : "dF";
}

/**
 * Würfelt einen freien Wurf mit den Parametern des Ursprungswurfs (aus den
 * Flags) neu. Muss mit `_rollDie` in adr-dice-form.js übereinstimmen.
 */
async function _adrFreshFreeRoll(message) {
  const f = message.flags?.[ADR.ID] || {};

  if (Array.isArray(f.multiPool) && f.multiPool.length > 0) {
    return _adrFreshMultiPoolRoll(f);
  }

  const count = Number(f.dieCount) || 1;
  const type = String(f.dieType || "w6");
  // Fudge/Cthulhu/Keep haben keinen Benny-Button; defensiv abfangen, damit
  // nie ein W6 als „Nachwurf" entsteht.
  if (adrIsFudge(type)) return null;
  if (f.cthulhu) return null;
  if (adrKeepModifier(f.keepMode)) return null;
  const faces = (type === "dc") ? 2 : (Number(String(type).replace(/^[dDwW]/, "")) || 6);
  // kh/kl schließt Explodieren aus (wie beim Ursprungswurf).
  const keep = (type !== "dc" && count > 1) ? adrKeepModifier(f.keepMode) : null;
  const isExploding = !!f.mainExploding && type !== "dc" && !keep;
  const hasWildDie = (f.wildResult != null);
  const sumMod = Number(f.appliedModifier) || 0;

  const mainTerm = new foundry.dice.terms.Die({
    number: count, faces,
    modifiers: keep ? [keep] : (isExploding ? [adrExplodingModifier()] : []),
  });
  const mainTerms = [mainTerm];
  if (sumMod !== 0) {
    mainTerms.push(new foundry.dice.terms.OperatorTerm({ operator: sumMod > 0 ? "+" : "-" }));
    mainTerms.push(new foundry.dice.terms.NumericTerm({ number: Math.abs(sumMod) }));
  }
  const mainRoll = await Roll.fromTerms(mainTerms).evaluate();

  // Münze: Werte 1/2 zu 0/1 normalisieren (wie beim Ursprungswurf).
  if (type === "dc" && mainRoll?.dice?.length) {
    for (const r of mainRoll.dice[0].results) {
      r.result = (r.result === 2) ? 1 : 0;
    }
    mainRoll._total = mainRoll.dice[0].results.reduce((a, r) => a + r.result, 0);
  }

  let wildRoll = null;
  if (hasWildDie) {
    const wildTerm = new foundry.dice.terms.Die({
      number: 1, faces: 6, modifiers: [adrExplodingModifier()],
    });
    const wildTerms = [wildTerm];
    if (sumMod !== 0) {
      wildTerms.push(new foundry.dice.terms.OperatorTerm({ operator: sumMod > 0 ? "+" : "-" }));
      wildTerms.push(new foundry.dice.terms.NumericTerm({ number: Math.abs(sumMod) }));
    }
    wildRoll = await Roll.fromTerms(wildTerms).evaluate();
  }

  return { mainRoll, wildRoll, sumMod, type, hasWildDie, isExploding, pool: null };
}

/**
 * Multi-Pool-Reroll: rekonstruiert den Pool aus den Flags und würfelt alle
 * Kategorien gemeinsam neu (analog `_rollMultiPool` in adr-dice-form.js).
 * Wild Die bleibt erhalten, Modifikator wird über den Pool addiert.
 */
async function _adrFreshMultiPoolRoll(f) {
  const sumMod = Number(f.appliedModifier) || 0;
  const isExploding = !!f.mainExploding;
  const hasWildDie = (f.wildResult != null);
  const pool = f.multiPool;

  const terms = [];
  for (let i = 0; i < pool.length; i++) {
    const p = pool[i];
    if (i > 0) terms.push(new foundry.dice.terms.OperatorTerm({ operator: "+" }));
    terms.push(new foundry.dice.terms.Die({
      number: p.count,
      faces: p.faces,
      modifiers: isExploding ? [adrExplodingModifier()] : [],
    }));
  }
  if (sumMod !== 0) {
    terms.push(new foundry.dice.terms.OperatorTerm({ operator: sumMod > 0 ? "+" : "-" }));
    terms.push(new foundry.dice.terms.NumericTerm({ number: Math.abs(sumMod) }));
  }
  const mainRoll = await Roll.fromTerms(terms).evaluate();

  let wildRoll = null;
  if (hasWildDie) {
    const wildTerms = [new foundry.dice.terms.Die({ number: 1, faces: 6, modifiers: [adrExplodingModifier()] })];
    if (sumMod !== 0) {
      wildTerms.push(new foundry.dice.terms.OperatorTerm({ operator: sumMod > 0 ? "+" : "-" }));
      wildTerms.push(new foundry.dice.terms.NumericTerm({ number: Math.abs(sumMod) }));
    }
    wildRoll = await Roll.fromTerms(wildTerms).evaluate();
  }

  return { mainRoll, wildRoll, sumMod, type: "_multi", hasWildDie, isExploding, pool };
}

/**
 * Extrahiert Anzeigedaten (Einzelergebnisse + Highlights) aus frischen
 * Roll-Objekten; muss mit `_rollDie` in adr-dice-form.js übereinstimmen.
 * Multi-Pool liefert zusätzlich `multiPoolResults`, Highlights bleiben aus.
 */
function _adrExtractFreeRollData(mainRoll, wildRoll, fumbleEnabled, pool = null) {
  function extractIndividual(roll) {
    if (!roll?.dice?.length) return [];
    return roll.dice.flatMap(dieEntry => adrBuildDieResults(dieEntry));
  }
  const mainIndividualResults = extractIndividual(mainRoll);
  const wildIndividualResults = extractIndividual(wildRoll);

  let multiPoolResults = null;
  if (Array.isArray(pool) && pool.length > 0) {
    multiPoolResults = [];
    for (let i = 0; i < pool.length; i++) {
      const p = pool[i];
      const dieEntry = mainRoll?.dice?.[i];
      multiPoolResults.push({
        type: p.type, count: p.count, faces: p.faces,
        results: dieEntry ? adrBuildDieResults(dieEntry) : []
      });
    }
  }

  let mainHighlight = false, wildHighlight = false;
  if (fumbleEnabled && !Array.isArray(pool)) {
    if (mainRoll?.dice?.length) {
      // Verworfene Würfel (kh/kl) zählen nicht mit.
      const vals = mainRoll.dice[0].results.filter(r => !r.discarded).map(r => r.result);
      const ones = vals.filter(x => x === 1).length;
      if (vals.length === 1 && ones === 1) mainHighlight = true;
      else if (vals.length > 1 && ones > (vals.length / 2)) mainHighlight = true;
    }
    if (wildRoll?.dice?.length) {
      const vals = wildRoll.dice[0].results.map(r => r.result);
      if (vals.includes(1)) wildHighlight = true;
    }
  }
  const out = {
    mainResult: mainRoll?.total ?? null,
    mainIndividualResults,
    wildResult: wildRoll?.total ?? null,
    wildIndividualResults,
    mainHighlight,
    wildHighlight,
  };
  if (multiPoolResults) out.multiPoolResults = multiPoolResults;
  return out;
}

/** Ordinalzahl der Reroll-Nummer: en "2nd"/"3rd", de nur die Zahl (Punkt steht im Template). */
function _adrFormatOrdinal(n) {
  const lang = game.i18n?.lang || "de";
  if (lang.startsWith("en")) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return `${n}st`;
    if (mod10 === 2 && mod100 !== 12) return `${n}nd`;
    if (mod10 === 3 && mod100 !== 13) return `${n}rd`;
    return `${n}th`;
  }
  return String(n);
}

/**
 * Tauscht den geltenden Wurf (mainResult & Co.) mit dem letzten Eintrag aus
 * previousRolls; mutiert `flags`. Nur im Pending-Pfad bei bestätigtem Patzer
 * (W6=1) nötig — sonst ist der alte Wurf im Pending-Datenmodell ohnehin mainResult.
 */
function _adrPendingDecisionSwap(flags) {
  const oldData = flags.previousRolls.pop();

  const newDiscarded = {
    mainResult: flags.mainResult,
    mainIndividualResults: flags.mainIndividualResults,
    mainHighlight: flags.mainHighlight,
    wildResult: flags.wildResult,
    wildIndividualResults: flags.wildIndividualResults,
    wildHighlight: flags.wildHighlight,
    seq: flags.rollSeq ?? null,
  };
  if (flags.fumbleCheckResult !== undefined) newDiscarded.fumbleCheckResult = flags.fumbleCheckResult;
  if (flags.fumbleCheckDie !== undefined) newDiscarded.fumbleCheckDie = flags.fumbleCheckDie;
  flags.previousRolls.push(newDiscarded);

  flags.mainResult = oldData.mainResult;
  flags.mainIndividualResults = oldData.mainIndividualResults;
  flags.mainHighlight = oldData.mainHighlight;
  flags.wildResult = oldData.wildResult;
  flags.wildIndividualResults = oldData.wildIndividualResults;
  flags.wildHighlight = oldData.wildHighlight;
  if (oldData.seq != null) flags.rollSeq = oldData.seq;
  if (oldData.fumbleCheckResult !== undefined) flags.fumbleCheckResult = oldData.fumbleCheckResult;
  if (oldData.fumbleCheckDie !== undefined) flags.fumbleCheckDie = oldData.fumbleCheckDie;
}

/**
 * Schreibt das ADR-Flag-Objekt neu und entfernt `removals` aus der DB.
 * Foundry merget Flag-Objekte bei `update()` rekursiv, entfernte Schlüssel
 * blieben sonst stehen; `unsetFlag` statt der `-=`-Syntax (seit v14 deprecatet).
 * @param {string[]} removals Schlüssel relativ zum ADR-Namespace.
 */
async function _adrWriteFlags(message, newFlags, removals = []) {
  await message.update({ [`flags.${ADR.ID}`]: newFlags });
  for (const key of removals) await message.unsetFlag(ADR.ID, key);
}

/**
 * Wendet einen Benny-Reroll auf die Message-Flags an (mutiert `flags`;
 * Gegenstück zu `_applyBennyRerollSingle` in adr-request-roll-chat.js).
 * Vergleichsbasis ist max(mainResult, wildResult). Pfade: besser → Overwrite;
 * Patzer → Overwrite trotz schlechterem Wert (SWADE: Patzer ist final);
 * sonst Schutz. Münzwurf: kein Wertvergleich, neuer Wurf gilt immer.
 * @returns {string[]} Flag-Schlüssel, die `_adrWriteFlags` aus der DB entfernen
 *   muss — ein `delete` im Plain-Object greift wegen des rekursiven Merges nicht.
 */
function _adrApplyBennyRerollFree(flags, newData, isWildcardSpeaker) {
  const removals = [];

  if (!Array.isArray(flags.previousRolls)) flags.previousRolls = [];

  // Sequenznummern: Fallback 1 für Nachrichten ohne rollSeq-Flag.
  const currentSeq = flags.rollSeq ?? 1;
  const newSeq = flags.nextRollSeq ?? (flags.previousRolls.length + 2);
  flags.nextRollSeq = newSeq + 1;

  // Münzwurf: kein Wertvergleich, neuer Wurf gilt immer.
  if (flags.dieType === "dc") {
    const histEntry = {
      mainResult: flags.mainResult,
      mainIndividualResults: flags.mainIndividualResults,
      mainHighlight: flags.mainHighlight,
      wildResult: flags.wildResult,
      wildIndividualResults: flags.wildIndividualResults,
      wildHighlight: flags.wildHighlight,
      seq: currentSeq,
    };
    flags.previousRolls.push(histEntry);

    flags.mainResult = newData.mainResult;
    flags.mainIndividualResults = newData.mainIndividualResults;
    flags.mainHighlight = newData.mainHighlight;
    flags.wildResult = newData.wildResult;
    flags.wildIndividualResults = newData.wildIndividualResults;
    flags.wildHighlight = newData.wildHighlight;
    flags.rollSeq = newSeq;
    flags.lastRerollProtected = false;
    delete flags.lastRerollFumbleOverwrite;
    removals.push("lastRerollFumbleOverwrite");
    flags.bennyUsed = true;
    return removals;
  }

  // ── Multi-Pool-Pfad: keine Patzer-Mechanik, kein Pending, nur Wertvergleich ──
  if (Array.isArray(flags.multiPool) && flags.multiPool.length > 0) {
    const oldMain = Number(flags.mainResult) || 0;
    const oldWild = (flags.wildResult != null) ? Number(flags.wildResult) : null;
    const newMain = Number(newData.mainResult) || 0;
    const newWild = (newData.wildResult != null) ? Number(newData.wildResult) : null;
    const oldEffective = (oldWild != null) ? Math.max(oldMain, oldWild) : oldMain;
    const newEffective = (newWild != null) ? Math.max(newMain, newWild) : newMain;
    const overwriteByBetter = newEffective > oldEffective;

    if (overwriteByBetter) {
      flags.previousRolls.push({
        mainResult: flags.mainResult,
        mainIndividualResults: flags.mainIndividualResults,
        multiPoolResults: flags.multiPoolResults,
        mainHighlight: flags.mainHighlight,
        wildResult: flags.wildResult,
        wildIndividualResults: flags.wildIndividualResults,
        wildHighlight: flags.wildHighlight,
        seq: currentSeq,
      });
      flags.mainResult = newData.mainResult;
      flags.mainIndividualResults = newData.mainIndividualResults;
      if (newData.multiPoolResults) flags.multiPoolResults = newData.multiPoolResults;
      flags.mainHighlight = newData.mainHighlight;
      flags.wildResult = newData.wildResult;
      flags.wildIndividualResults = newData.wildIndividualResults;
      flags.wildHighlight = newData.wildHighlight;
      flags.rollSeq = newSeq;
      flags.lastRerollProtected = false;
    } else {
      flags.previousRolls.push({
        mainResult: newData.mainResult,
        mainIndividualResults: newData.mainIndividualResults,
        multiPoolResults: newData.multiPoolResults,
        mainHighlight: newData.mainHighlight,
        wildResult: newData.wildResult,
        wildIndividualResults: newData.wildIndividualResults,
        wildHighlight: newData.wildHighlight,
        seq: newSeq,
      });
      flags.lastRerollProtected = true;
    }
    delete flags.lastRerollFumbleOverwrite;
    removals.push("lastRerollFumbleOverwrite");
    flags.bennyUsed = true;
    return removals;
  }

  // ── Patzer-Override (SWADE): Wildcard-Patzer im Reroll übersteuert den
  // Verschlechterungsschutz. NSC-1 ("needs-check") läuft über den Pending-Pfad. ──
  const newClassification = _adrClassifyHistoryFumble(newData, isWildcardSpeaker, !!flags.mainExploding);
  if (newClassification === "confirmed") {
    const histEntry = {
      mainResult: flags.mainResult,
      mainIndividualResults: flags.mainIndividualResults,
      mainHighlight: flags.mainHighlight,
      wildResult: flags.wildResult,
      wildIndividualResults: flags.wildIndividualResults,
      wildHighlight: flags.wildHighlight,
      seq: currentSeq,
    };
    if (flags.fumbleCheckResult !== undefined) histEntry.fumbleCheckResult = flags.fumbleCheckResult;
    if (flags.fumbleCheckDie !== undefined) histEntry.fumbleCheckDie = flags.fumbleCheckDie;
    flags.previousRolls.push(histEntry);

    flags.mainResult = newData.mainResult;
    flags.mainIndividualResults = newData.mainIndividualResults;
    flags.mainHighlight = newData.mainHighlight;
    flags.wildResult = newData.wildResult;
    flags.wildIndividualResults = newData.wildIndividualResults;
    flags.wildHighlight = newData.wildHighlight;
    flags.rollSeq = newSeq;
    flags.lastRerollProtected = false;
    flags.lastRerollFumbleOverwrite = true;
    delete flags.fumbleCheckResult;
    delete flags.fumbleCheckDie;
    removals.push("fumbleCheckResult", "fumbleCheckDie");
    flags.bennyUsed = true;
    return removals;
  }

  const oldMain = Number(flags.mainResult) || 0;
  const oldWild = (flags.wildResult != null) ? Number(flags.wildResult) : null;
  const newMain = Number(newData.mainResult) || 0;
  const newWild = (newData.wildResult != null) ? Number(newData.wildResult) : null;

  const oldEffective = (oldWild != null) ? Math.max(oldMain, oldWild) : oldMain;
  const newEffective = (newWild != null) ? Math.max(newMain, newWild) : newMain;

  // Statisten-Reroll mit 1 = potenzieller Patzer; ohne Explodieren keine
  // Eigenschaftsprobe, also kein Pending-Pfad.
  const newIsPotentialFumble = !!flags.mainExploding
    && !isWildcardSpeaker
    && newWild == null
    && Array.isArray(newData.mainIndividualResults)
    && newData.mainIndividualResults.length === 1
    && newData.mainIndividualResults[0]?.value == 1;

  const overwriteByBetter = newEffective > oldEffective;
  // Pending: die Entscheidung (Annehmen → Schutz | Patzer prüfen → W6) trifft der GM.
  const goesPending = newIsPotentialFumble && !overwriteByBetter;

  if (overwriteByBetter) {
    const histEntry = {
      mainResult: flags.mainResult,
      mainIndividualResults: flags.mainIndividualResults,
      mainHighlight: flags.mainHighlight,
      wildResult: flags.wildResult,
      wildIndividualResults: flags.wildIndividualResults,
      wildHighlight: flags.wildHighlight,
      seq: currentSeq,
    };
    if (flags.fumbleCheckResult !== undefined) histEntry.fumbleCheckResult = flags.fumbleCheckResult;
    if (flags.fumbleCheckDie !== undefined) histEntry.fumbleCheckDie = flags.fumbleCheckDie;
    flags.previousRolls.push(histEntry);

    flags.mainResult = newData.mainResult;
    flags.mainIndividualResults = newData.mainIndividualResults;
    flags.mainHighlight = newData.mainHighlight;
    flags.wildResult = newData.wildResult;
    flags.wildIndividualResults = newData.wildIndividualResults;
    flags.wildHighlight = newData.wildHighlight;
    flags.rollSeq = newSeq;
    flags.lastRerollProtected = false;
    delete flags.lastRerollFumbleOverwrite;
    removals.push("lastRerollFumbleOverwrite");
    delete flags.fumbleCheckResult;
    delete flags.fumbleCheckDie;
    removals.push("fumbleCheckResult", "fumbleCheckDie");
  } else if (goesPending) {
    // Pending-Datenmodell: der alte Wurf BLEIBT geltend, die Reroll-1 wandert
    // in previousRolls. mainResult/rollSeq/fumbleCheck* des alten Wurfs bleiben
    // für die GM-Entscheidung unangetastet (Annehmen → fumbleCheckSkipped;
    // W6=1 → _adrPendingDecisionSwap; W6>1 → fumbleCheckResult=false am Eintrag).
    flags.previousRolls.push({
      mainResult: newData.mainResult,
      mainIndividualResults: newData.mainIndividualResults,
      mainHighlight: newData.mainHighlight,
      wildResult: newData.wildResult,
      wildIndividualResults: newData.wildIndividualResults,
      wildHighlight: newData.wildHighlight,
      seq: newSeq,
    });
    flags.pendingRerollFumbleDecision = true;
    delete flags.lastRerollProtected;
    delete flags.lastRerollFumbleOverwrite;
    removals.push("lastRerollProtected", "lastRerollFumbleOverwrite");
  } else {
    // Schutz greift: alter Wurf bleibt; neuer in History mit neuer Seq
    flags.previousRolls.push({
      mainResult: newData.mainResult,
      mainIndividualResults: newData.mainIndividualResults,
      mainHighlight: newData.mainHighlight,
      wildResult: newData.wildResult,
      wildIndividualResults: newData.wildIndividualResults,
      wildHighlight: newData.wildHighlight,
      seq: newSeq,
    });
    flags.lastRerollProtected = true;
    delete flags.lastRerollFumbleOverwrite;
    removals.push("lastRerollFumbleOverwrite");
  }
  flags.bennyUsed = true;
  return removals;
}

/**
 * Klassifiziert einen History-Eintrag nach SWADE-Patzer-Kategorien (Gegenstück
 * zu `_classifyFumble` in adr-request-roll-chat.js für das Free-Roll-Schema).
 * `mainExploding` gilt für die ganze Reroll-Serie; ohne Explodieren keine
 * Eigenschaftsprobe, also kein Patzer-Verdacht.
 * @returns {"confirmed"|"needs-check"|"none"}
 */
function _adrClassifyHistoryFumble(entry, isWildcardSpeaker, mainExploding) {
  if (!entry) return "none";
  if (entry.fumbleCheckResult === true) return "confirmed";
  if (!mainExploding) return "none";

  const mainInd = Array.isArray(entry.mainIndividualResults) ? entry.mainIndividualResults : [];
  const totalMain = mainInd.length;
  const onesMain = mainInd.filter(x => x?.value == 1).length;
  const wildResult = entry.wildResult;
  const hasWild = wildResult != null;

  if (hasWild) {
    const totalDice = totalMain + 1;
    const onesAll = onesMain + (wildResult == 1 ? 1 : 0);
    if (wildResult == 1 && onesAll > totalDice / 2) return "confirmed";
    return "none";
  }
  if (isWildcardSpeaker) return "none";
  if (totalMain === 1 && mainInd[0]?.value == 1) return "needs-check";
  return "none";
}

/**
 * Voll-Rebuild von `.adr-individual-details`: alle Würfe (verworfene + geltender)
 * chronologisch nach `seq`/`rollSeq` sortiert; der geltende Wurf steht ohne
 * Durchstreichung an seiner echten Position. Fehlt `seq` (alte Nachrichten),
 * dient der Array-Index als Reihenfolge.
 */
function _adrInjectFreeRollDiscardedHistory(li, message) {
  const f = message.flags?.[ADR.ID] || {};
  const prev = Array.isArray(f.previousRolls) ? f.previousRolls : [];
  const details = li.querySelector(".adr-individual-details");
  if (!details) return;

  if (f.mainResult == null && prev.length === 0) return;

  const entries = [];
  prev.forEach((p, i) => {
    entries.push({
      data: p,
      seq: (p.seq != null) ? p.seq : (i + 1),
      isCurrent: false,
    });
  });
  entries.push({
    data: {
      mainResult: f.mainResult,
      mainIndividualResults: f.mainIndividualResults,
      multiPoolResults: f.multiPoolResults,
      mainHighlight: f.mainHighlight,
      wildResult: f.wildResult,
      wildIndividualResults: f.wildIndividualResults,
      wildHighlight: f.wildHighlight,
      fumbleCheckDie: f.fumbleCheckDie,
    },
    seq: (f.rollSeq != null) ? f.rollSeq : (prev.length + 1),
    isCurrent: true,
  });

  entries.sort((a, b) => a.seq - b.seq);

  details.innerHTML = "";

  const dieLabel = game.i18n.localize(`${ADR.ID}.requestRoll.fumbleCheckDieLabel`);
  // Modifikator ist über die ganze Reroll-Kette konstant.
  const appliedMod = (f.appliedModifier != null) ? Number(f.appliedModifier) : null;

  // ── Multi-Pool-Pfad ──
  const isMulti = Array.isArray(f.multiPool) && f.multiPool.length > 0;
  if (isMulti) {
    for (const e of entries) {
      const p = e.data;
      const discardCls = e.isCurrent ? "" : " adr-individual-discarded";
      const mpr = Array.isArray(p.multiPoolResults) ? p.multiPoolResults : [];
      const mainInd = Array.isArray(p.mainIndividualResults) ? p.mainIndividualResults : [];
      if (!mpr.length && !mainInd.length && p.wildResult == null) continue;

      const el = document.createElement("div");
      el.className = `adr-individual adr-individual-multi${discardCls}`;
      if (mpr.length) {
        el.innerHTML = _adrBuildMultiPoolDetailsHTML(mpr, p.wildResult, p.wildIndividualResults, appliedMod);
      } else {
        // Alte Einträge ohne multiPoolResults: flacher Pfad.
        const wildInd = Array.isArray(p.wildIndividualResults) ? p.wildIndividualResults : [];
        el.innerHTML = _buildInlineRollContent({
          mainHTML: _renderDicePrecomputed(mainInd),
          wildHTML: (p.wildResult != null && wildInd.length) ? _renderDicePrecomputed(wildInd) : "",
          appliedModifier: appliedMod,
        });
      }
      details.appendChild(el);
    }
    return;
  }

  // ── Single-Die-Pfad ──
  for (const e of entries) {
    const p = e.data;
    const discardCls = e.isCurrent ? "" : " adr-individual-discarded";

    const mainInd = Array.isArray(p.mainIndividualResults) ? p.mainIndividualResults : [];
    if (!mainInd.length && p.wildResult == null) continue;

    // W6-Prüfwürfel direkt neben der 1.
    let inlineCheckHTML = "";
    if (mainInd.length === 1 && Number(mainInd[0]?.value) === 1 && p.fumbleCheckDie != null) {
      const dieCss = p.fumbleCheckDie === 1 ? "min" : "";
      inlineCheckHTML = ` <span class="adr-fumble-check-inline">`
        + `<span class="adr-label">( ${dieLabel}:</span> `
        + `<span class="${dieCss}">${p.fumbleCheckDie}</span>`
        + `<span class="adr-label"> )</span></span>`;
    }

    const wildInd = Array.isArray(p.wildIndividualResults) ? p.wildIndividualResults : [];
    const content = _buildInlineRollContent({
      mainHTML: _renderDicePrecomputed(mainInd),
      wildHTML: (p.wildResult != null && wildInd.length) ? _renderDicePrecomputed(wildInd) : "",
      appliedModifier: appliedMod,
      inlineCheckHTML,
    });
    const el = document.createElement("div");
    el.className = `adr-individual${discardCls}`;
    el.innerHTML = content;
    details.appendChild(el);
  }
}

/**
 * Hinweis nach Benny-Reroll, je nach Flag: Pending-Auswahl, Patzer-Vorrang,
 * Schutz (ggf. mit „Allerdings war eine 1"-Zusatz), Münzwurf oder Verbesserung.
 * Sitzt zwischen Wurf-Zeile und Toggle-Container.
 */
function _adrInjectFreeRollHint(li, message) {
  const f = message.flags?.[ADR.ID] || {};
  if (!f.bennyUsed && !f.pendingRerollFumbleDecision) return;

  // Idempotenz
  li.querySelector(".adr-benny-protected-hint")?.remove();

  const prev = Array.isArray(f.previousRolls) ? f.previousRolls : [];
  if (prev.length === 0) return;

  const isWildcardSpeaker = !!f.isWildcard;
  const hintEl = document.createElement("div");
  hintEl.className = "adr-benny-protected-hint";
  let hintHTML = "";
  let needsDiscardedCheckBtn = false;
  let lastDiscarded = null;
  let renderPendingChoice = false;

  // Ab dem zweiten Reroll Keys mit {n}-Platzhalter.
  const rerollNum = prev.length;
  const useCounter = rerollNum >= 2;
  const ordinal = useCounter ? _adrFormatOrdinal(rerollNum) : null;
  const pickKey = (base) => useCounter ? `${base}N` : base;
  const localizeHint = (base) => {
    const tmpl = game.i18n.localize(`${ADR.ID}.requestRoll.${pickKey(base)}`);
    return useCounter ? tmpl.replace("{n}", ordinal) : tmpl;
  };

  if (f.pendingRerollFumbleDecision) {
    hintHTML = `<div class="adr-benny-protected-line">`
      + localizeHint("pendingFumblePotentialHint") + `</div>`;
    renderPendingChoice = true;
  } else if (f.lastRerollFumbleOverwrite) {
    // Patzer-Vorrang: W6-bestätigte NSC-1, Wildcard-Patzer oder (normalerweise
    // unerreichbarer) Fallback ohne fumbleCheckResult.
    const currentClass = _adrClassifyHistoryFumble({
      mainIndividualResults: f.mainIndividualResults,
      wildResult: f.wildResult,
    }, isWildcardSpeaker, !!f.mainExploding);
    if (f.fumbleCheckResult === true) {
      const keyword = game.i18n.localize(`${ADR.ID}.requestRoll.fumbleCheckYes`);
      const tmpl = localizeHint("bennyFumbleOverwriteHintConfirmed");
      hintHTML = `<div class="adr-benny-protected-line">`
        + tmpl.replace("{result}", `<span class="adr-fumble-confirmed-text">${keyword}</span>`)
        + `</div>`;
    } else if (currentClass === "confirmed") {
      hintHTML = `<div class="adr-benny-protected-line">`
        + localizeHint("bennyFumbleOverwriteHintCritical") + `</div>`;
    } else {
      hintHTML = `<div class="adr-benny-protected-line">`
        + localizeHint("bennyFumbleOverwriteHint") + `</div>`;
    }
  } else if (f.lastRerollProtected) {
    lastDiscarded = prev[prev.length - 1];
    const cls = _adrClassifyHistoryFumble(lastDiscarded, isWildcardSpeaker, !!f.mainExploding);
    const checkSkipped = !!lastDiscarded?.fumbleCheckSkipped;

    if (cls === "confirmed") {
      // W6-bestätigter Statisten-Patzer ist eindeutig (harter Text); ein
      // Wildcard-Patzer nur POTENZIELL, weil unbekannt ist, ob es eine
      // Eigenschaftsprobe war — daher weicher Text im Markup des Initial-Hinweises.
      const isExtraConfirmed = lastDiscarded?.fumbleCheckResult === true;
      if (isExtraConfirmed) {
        hintHTML = `<div class="adr-benny-protected-line adr-benny-protected-fumble">`
          + localizeHint("bennyProtectedHintFumble") + `</div>`;
      } else {
        const prefix = localizeHint("bennyProtectedHintFumblePotential");
        const label = game.i18n.localize(`${ADR.ID}.chat.critical-failure`);
        hintHTML = `<div class="adr-fumble-check-result">${prefix}<br>`
          + `<span class="adr-fumble-confirmed-text" style="font-size:0.85rem;">${label}</span>`
          + `</div>`;
      }
    } else {
      hintHTML = `<div class="adr-benny-protected-line">`
        + localizeHint("bennyProtectedHint") + `</div>`;
      // Zusatz und Check-Button entfallen, wenn der GM den Check im Pending übersprungen hat.
      if (cls === "needs-check" && !checkSkipped) {
        hintHTML += `<div class="adr-benny-protected-line adr-benny-protected-extra-one">`
          + game.i18n.localize(`${ADR.ID}.requestRoll.bennyProtectedHintExtraOne`) + `</div>`;
        const dcr = lastDiscarded?.fumbleCheckResult;
        if (dcr === true || dcr === false) {
          const tmplKey = dcr ? `${ADR.ID}.requestRoll.fumbleCheckTextYes` : `${ADR.ID}.requestRoll.fumbleCheckTextNo`;
          const keyword = dcr
            ? game.i18n.localize(`${ADR.ID}.requestRoll.fumbleCheckYes`)
            : game.i18n.localize(`${ADR.ID}.requestRoll.fumbleCheckNone`);
          const cssCls = dcr ? "adr-fumble-confirmed-text" : "adr-fumble-denied-text";
          const tmpl = game.i18n.localize(tmplKey);
          hintHTML += `<div class="adr-benny-protected-check-result">`
            + tmpl.replace("{result}", `<span class="${cssCls}">${keyword}</span>`)
            + `</div>`;
        } else {
          needsDiscardedCheckBtn = true;
        }
      }
    }
  } else if (f.dieType === "dc") {
    hintHTML = `<div class="adr-benny-protected-line">`
      + localizeHint("bennyCoinHint") + `</div>`;
  } else {
    hintHTML = `<div class="adr-benny-protected-line">`
      + localizeHint("bennyImprovedHint") + `</div>`;
  }

  hintEl.innerHTML = hintHTML;

  if (renderPendingChoice) {
    const acceptLabel = game.i18n.localize(`${ADR.ID}.requestRoll.keepBetterResultBtn`);
    const orLabel = game.i18n.localize(`${ADR.ID}.requestRoll.orChoice`);
    const line1 = game.i18n.localize(`${ADR.ID}.requestRoll.fumbleCheckBtn1`);
    const line2 = game.i18n.localize(`${ADR.ID}.requestRoll.fumbleCheckBtn2`);
    const isGM = game.user.isGM;
    const notMineCls = isGM ? "" : " adr-not-mine";
    // Inline !important: das System-CSS für button:hover ist spezifischer.
    const notMineAttrs = isGM
      ? ""
      : ` title="${game.i18n.localize(`${ADR.ID}.requestRoll.chatNoPermission`)}" style="cursor: not-allowed !important"`;
    const choice = document.createElement("div");
    choice.className = "adr-fumble-choice-container";
    choice.innerHTML =
        `<button type="button" class="adr-accept-result-btn${notMineCls}"${notMineAttrs} data-action="adr-fumble-pending-accept-free" data-message-id="${message.id}">${acceptLabel}</button>`
      + `<span class="adr-fumble-choice-or">${orLabel}</span>`
      + `<button type="button" class="adr-fumble-check-btn${notMineCls}"${notMineAttrs} data-action="adr-fumble-pending-check-free" data-message-id="${message.id}">${line1} ${line2}</button>`;
    hintEl.appendChild(choice);
  }

  if (needsDiscardedCheckBtn && lastDiscarded) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "adr-fumble-check-btn adr-fumble-check-discarded-btn";
    btn.dataset.action = "adr-fumble-check-discarded-free";
    btn.dataset.messageId = message.id;
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

  // Nach der letzten Wurfzeile bzw. der Critical-Hinweis-Zeile platzieren.
  const rows = li.querySelectorAll(".adr-dice-row");
  const lastRow = rows[rows.length - 1];
  let anchor = lastRow;
  const fcResult = li.querySelector(".adr-fumble-check-result");
  if (fcResult) anchor = fcResult;
  if (anchor) anchor.insertAdjacentElement("afterend", hintEl);

  // Foundry scrollt nach `message.update()` nicht nach; setTimeout, damit das
  // Layout nach dem Insert berechnet ist.
  if (renderPendingChoice) {
    setTimeout(() => {
      const scrollContainer = li.closest(".chat-scroll");
      if (scrollContainer) {
        const liRect = li.getBoundingClientRect();
        const containerRect = scrollContainer.getBoundingClientRect();
        const overflow = liRect.bottom - containerRect.bottom;
        if (overflow > 0) scrollContainer.scrollTop += overflow + 8;
      }
    }, 50);
  }
}

/* ================================================================ */
/*  Handlebars-Templates & -Helpers                                 */
/* ================================================================ */

function _loadHandlebarTemplates() {
  Handlebars.registerHelper("isCoin", v => v === "dc");
  Handlebars.registerHelper("isFudge", v => v === "df");
  Handlebars.registerHelper("isD100", v => v === "d100");
  Handlebars.registerHelper("isD2",   v => v === "d2");
  Handlebars.registerHelper("eq", (a, b) => a === b);
  Handlebars.registerHelper("gt", (a, b) => a > b);
  Handlebars.registerHelper("adrDieLabel",
    sides => `${game.i18n.localize(`${ADR.ID}.requestRoll.diePrefix`)}${sides}`);
  return foundry.applications.handlebars.loadTemplates([
    ADR.DICE_FORM_PATH,
    ADR.REQUEST_ROLL_FORM_PATH,
    ADR.REQUEST_ROLL_CHAT_PATH,
  ]);
}

/* ================================================================ */
/*  SWADE-Einstellungen: Submenu-Fenster (registerMenu)             */
/* ================================================================ */

const { ApplicationV2 } = foundry.applications.api;

/**
 * Submenu-Fenster für die SWADE-Spielmechanik-Einstellungen (Settings mit
 * `config: false`; dieses Fenster ist die einzige UI dafür).
 * Bewusst reines ApplicationV2 ohne HandlebarsApplicationMixin und ADR-Theme:
 * das Untermenü soll wie Foundrys eigene Einstellungen aussehen, daher die
 * Standard-Helfer aus `foundry.applications.fields`. Foundry instanziiert die
 * Klasse per registerMenu ohne Argumente — kein eigener Konstruktor.
 */
class SwadeSettingsForm extends ApplicationV2 {

  /** In Anzeigereihenfolge; die Wild-Die-Schaltfläche liegt im Untermenü „Angezeigte Schaltflächen". */
  static SETTING_KEYS = [
    ADR.CONFIG_HIGHLIGHT_ONES,
    ADR.CONFIG_REQUEST_ROLL,
  ];

  static DEFAULT_OPTIONS = {
    id: "adr-swade-settings",
    classes: ["adr-swade-settings-window"],
    window: {
      frame: true,
      positioned: true,
      title: "",
      resizable: false,
    },
    position: {
      width: 760,
    },
  };

  get title() {
    return game.i18n.localize(`${ADR.ID}.swadeSettings.windowTitle`);
  }

  async _renderHTML(_context, _options) {
    const { createCheckboxInput, createFormGroup } = foundry.applications.fields;

    const root = document.createElement("div");
    root.className = "adr-swade-settings standard-form";

    const isSwade = game.system.id === "swade";
    if (!isSwade) root.append(this._buildWarning());

    // Probenanforderung nur auf SWADE, sonst ausgegraut und aus.
    for (const key of SwadeSettingsForm.SETTING_KEYS) {
      const locked = !isSwade && key === ADR.CONFIG_REQUEST_ROLL;
      const input = createCheckboxInput({
        name: key,
        value: !locked && !!game.settings.get(ADR.ID, key),
      });
      if (locked) input.disabled = true;
      const group = createFormGroup({
        input,
        label: game.i18n.localize(`${ADR.ID}.settings.${key}.name`),
        hint: game.i18n.localize(`${ADR.ID}.settings.${key}.hint`),
      });
      root.append(group);
    }

    // Speichern schließt; das native Schließen-X verwirft.
    const footer = document.createElement("footer");
    footer.className = "form-footer";

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.dataset.action = "adr-swade-settings-save";

    const icon = document.createElement("i");
    icon.className = "fa-solid fa-floppy-disk";
    saveBtn.append(icon, document.createTextNode(
      " " + game.i18n.localize(`${ADR.ID}.swadeSettings.save`)
    ));

    footer.append(saveBtn);
    root.append(footer);

    return root;
  }

  /** Warnhinweis für Fremdsysteme. */
  _buildWarning() {
    const wrap = document.createElement("div");
    wrap.className = "adr-swade-warning";

    const p = document.createElement("p");
    const label = document.createElement("strong");
    label.textContent = game.i18n.localize(`${ADR.ID}.swadeSettings.warningLabel`);
    p.append(label, " ");

    const text = game.i18n.localize(`${ADR.ID}.swadeSettings.warningText`);
    const [before, after] = text.split("{system}");
    const em = document.createElement("em");
    em.textContent = game.i18n.localize(`${ADR.ID}.swadeSettings.warningSystem`);
    p.append(before ?? "", em, after ?? "");

    wrap.append(p, document.createElement("hr"));
    return wrap;
  }

  _replaceHTML(result, content, _options) {
    content.replaceChildren(result);
  }

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    const root = this.element;
    if (!root) return;

    root.addEventListener("click", (ev) => {
      if (ev.target.closest("[data-action='adr-swade-settings-save']")) {
        this._onSave();
      }
    });
  }

  /** Schreibt nur geänderte Werte, damit onChange-Handler nicht unnötig feuern. */
  async _onSave() {
    const root = this.element;
    if (!root) return;

    for (const key of SwadeSettingsForm.SETTING_KEYS) {
      const checkbox = root.querySelector(`input[type="checkbox"][name="${key}"]`);
      if (!checkbox) continue;
      const newValue = checkbox.disabled ? false : checkbox.checked;
      if (game.settings.get(ADR.ID, key) !== newValue) {
        await game.settings.set(ADR.ID, key, newValue);
      }
    }

    this.close();
  }
}

/* ================================================================ */
/*  Angezeigte Würfeltypen: Submenu-Fenster (registerMenu)          */
/* ================================================================ */

/** Submenu-Fenster für `diceTypes` (angebotene Würfelzeilen); Aufbau wie SwadeSettingsForm. */
class DiceTypesForm extends ApplicationV2 {

  static DEFAULT_OPTIONS = {
    id: "adr-dice-types",
    classes: ["adr-dice-types-window"],
    window: {
      frame: true,
      positioned: true,
      title: "",
      resizable: false,
    },
    position: {
      width: 360,
    },
  };

  get title() {
    return game.i18n.localize(`${ADR.ID}.diceTypes.windowTitle`);
  }

  async _renderHTML(_context, _options) {
    const { createCheckboxInput } = foundry.applications.fields;
    const current = game.settings.get(ADR.ID, ADR.CONFIG_DICE_TYPES) ?? {};

    const root = document.createElement("div");
    root.className = "adr-dice-types standard-form";

    const intro = document.createElement("p");
    intro.className = "adr-dice-types-intro";
    intro.textContent = game.i18n.localize(`${ADR.ID}.diceTypes.intro`);
    root.append(intro, document.createElement("hr"));

    const list = document.createElement("div");
    list.className = "adr-dice-types-list";
    root.append(list);

    for (const type of ADR.DICE_TYPES) {
      const input = createCheckboxInput({
        name: type,
        value: !!(current[type] ?? ADR.DICE_TYPES_DEFAULT[type]),
      });
      const row = document.createElement("label");
      row.className = "adr-dice-types-row";
      const text = document.createElement("span");
      text.textContent = adrDieTypeLabel(type);
      row.append(input, text);
      list.append(row);
    }

    const footer = document.createElement("footer");
    footer.className = "form-footer";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.dataset.action = "adr-dice-types-save";
    const icon = document.createElement("i");
    icon.className = "fa-solid fa-floppy-disk";
    saveBtn.append(icon, document.createTextNode(
      " " + game.i18n.localize(`${ADR.ID}.swadeSettings.save`)
    ));
    footer.append(saveBtn);
    root.append(footer);
    return root;
  }

  _replaceHTML(result, content, _options) {
    content.replaceChildren(result);
  }

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    this.element?.addEventListener("click", (ev) => {
      if (ev.target.closest("[data-action='adr-dice-types-save']")) this._onSave();
    });
  }

  async _onSave() {
    const root = this.element;
    if (!root) return;
    const value = {};
    for (const type of ADR.DICE_TYPES) {
      value[type] = !!root.querySelector(`input[type="checkbox"][name="${type}"]`)?.checked;
    }
    await game.settings.set(ADR.ID, ADR.CONFIG_DICE_TYPES, value);
    this.close();
  }
}

/* ================================================================ */
/*  Angezeigte Schaltflächen: Submenu-Fenster (registerMenu)        */
/* ================================================================ */

/**
 * Submenu-Fenster für die Schaltflächen des Würfelfensters (Settings mit
 * `config: false`; einzige UI dafür). Settings mit `choices` als Auswahlliste.
 */
class ButtonsSettingsForm extends ApplicationV2 {

  /** Allgemeine Schaltflächen (für jedes Spielsystem). */
  static SETTING_KEYS = [
    ADR.CONFIG_HIDDEN_ROLLS,
    ADR.CONFIG_EXPLODING_MODE,
    ADR.CONFIG_EXPLODING_DEFAULT,
    ADR.CONFIG_MODIFIERS,
    "enableFateRollButton",
  ];

  /** Systemspezifische Schaltflächen (SWADE, Call of Cthulhu, D&D) unter einer Trennlinie. */
  static SYSTEM_SETTING_KEYS = [
    ADR.CONFIG_WILD_DIE,
    ADR.CONFIG_CTHULHU_DICE,
    ADR.CONFIG_KEEP_DICE,
  ];

  static DEFAULT_OPTIONS = {
    id: "adr-buttons-settings",
    classes: ["adr-buttons-settings-window"],
    window: {
      frame: true,
      positioned: true,
      title: "",
      resizable: false,
    },
    position: {
      width: 760,
    },
  };

  get title() {
    return game.i18n.localize(`${ADR.ID}.buttons.windowTitle`);
  }

  async _renderHTML(_context, _options) {
    const { createCheckboxInput, createSelectInput, createFormGroup } = foundry.applications.fields;

    const root = document.createElement("div");
    root.className = "adr-buttons-settings standard-form";

    const addGroup = (key) => {
      const value = game.settings.get(ADR.ID, key);
      const choices = game.settings.settings.get(`${ADR.ID}.${key}`)?.choices;
      const input = choices
        ? createSelectInput({
            name: key,
            value,
            options: Object.entries(choices).map(([v, l]) => ({ value: v, label: game.i18n.localize(l) })),
          })
        : createCheckboxInput({ name: key, value: !!value });
      root.append(createFormGroup({
        input,
        label: game.i18n.localize(`${ADR.ID}.settings.${key}.name`),
        hint: game.i18n.localize(`${ADR.ID}.settings.${key}.hint`),
      }));
    };

    ButtonsSettingsForm.SETTING_KEYS.forEach(addGroup);

    root.append(document.createElement("hr"));
    const note = document.createElement("p");
    note.className = "adr-buttons-system-note";
    note.textContent = game.i18n.localize(`${ADR.ID}.buttons.systemNote`);
    root.append(note);
    ButtonsSettingsForm.SYSTEM_SETTING_KEYS.forEach(addGroup);

    const footer = document.createElement("footer");
    footer.className = "form-footer";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.dataset.action = "adr-buttons-settings-save";
    const icon = document.createElement("i");
    icon.className = "fa-solid fa-floppy-disk";
    saveBtn.append(icon, document.createTextNode(
      " " + game.i18n.localize(`${ADR.ID}.swadeSettings.save`)
    ));
    footer.append(saveBtn);
    root.append(footer);
    return root;
  }

  _replaceHTML(result, content, _options) {
    content.replaceChildren(result);
  }

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    this.element?.addEventListener("click", (ev) => {
      if (ev.target.closest("[data-action='adr-buttons-settings-save']")) this._onSave();
    });
  }

  async _onSave() {
    const root = this.element;
    if (!root) return;
    for (const key of [...ButtonsSettingsForm.SETTING_KEYS, ...ButtonsSettingsForm.SYSTEM_SETTING_KEYS]) {
      const el = root.querySelector(`[name="${key}"]`);
      if (!el) continue;
      const newValue = el.type === "checkbox" ? el.checked : el.value;
      if (game.settings.get(ADR.ID, key) !== newValue) {
        await game.settings.set(ADR.ID, key, newValue);
      }
    }
    this.close();
  }
}

/* ================================================================ */
/*  Game Settings                                                   */
/* ================================================================ */

function _registerGameSettings() {
  // SWADE-Settings (Patzer-Mechanik, Probenanforderung, Wild Die) sind
  // `config: false` und nur über Submenüs erreichbar; per Default nur auf SWADE aktiv.
  const isSwade = game.system.id === "swade";

  // name/hint/choices als ROHE i18n-Keys: im init-Hook sind die Modul-
  // Übersetzungen noch nicht geladen (erst ab i18nInit), localize lieferte nur
  // den Key. Foundrys SettingsConfig lokalisiert beim Rendern selbst.

  // "standard" = generische Foundry-Würfelkarte ohne ADR-Render.
  game.settings.register(ADR.ID, "chatDesign", {
    name: "argas-dice-roller.settings.chatDesign.name",
    hint: "argas-dice-roller.settings.chatDesign.hint",
    scope: "world",
    config: true,
    default: "fantasy",
    type: String,
    choices: {
      fantasy: "argas-dice-roller.settings.chatDesign.choices.fantasy",
      modern: "argas-dice-roller.settings.chatDesign.choices.modern",
      standard: "argas-dice-roller.settings.chatDesign.choices.standard"
    }
  });

  game.settings.register(ADR.ID, ADR.CONFIG_CLOSE_FORM, {
    name: "argas-dice-roller.settings.closeFormOnRoll.name",
    hint: "argas-dice-roller.settings.closeFormOnRoll.hint",
    scope: "client",
    config: true,
    default: false,
    type: Boolean,
    onChange: v => _updateDiceForm(ADR.CONFIG_CLOSE_FORM, v)
  });

  game.settings.register(ADR.ID, ADR.CONFIG_HIDDEN_ROLLS, {
    name: "argas-dice-roller.settings.enableHiddenRolls.name",
    hint: "argas-dice-roller.settings.enableHiddenRolls.hint",
    scope: "world",
    config: false,
    default: true,
    type: Boolean,
    onChange: v => _updateDiceForm(ADR.CONFIG_HIDDEN_ROLLS, v)
  });

  // Alleinige Quelle der Wahrheit für die Explosionsmechanik ("off" blendet den Button aus).
  game.settings.register(ADR.ID, ADR.CONFIG_EXPLODING_MODE, {
    name: "argas-dice-roller.settings.explodingMode.name",
    hint: "argas-dice-roller.settings.explodingMode.hint",
    scope: "world",
    config: false,
    default: "multi",
    type: String,
    choices: {
      multi: "argas-dice-roller.settings.explodingMode.choices.multi",
      once:  "argas-dice-roller.settings.explodingMode.choices.once",
      off:   "argas-dice-roller.settings.explodingMode.choices.off"
    },
    onChange: v => _updateDiceForm(ADR.CONFIG_EXPLODING_MODE, v)
  });

  game.settings.register(ADR.ID, ADR.CONFIG_EXPLODING_DEFAULT, {
    name: "argas-dice-roller.settings.explodingDefault.name",
    hint: "argas-dice-roller.settings.explodingDefault.hint",
    scope: "world",
    config: false,
    default: false,
    type: Boolean,
    onChange: v => _updateDiceForm(ADR.CONFIG_EXPLODING_DEFAULT, v)
  });

  game.settings.register(ADR.ID, ADR.CONFIG_MODIFIERS, {
    name: "argas-dice-roller.settings.enableModifiers.name",
    hint: "argas-dice-roller.settings.enableModifiers.hint",
    scope: "world",
    config: false,
    default: true,
    type: Boolean,
    onChange: v => _updateDiceForm(ADR.CONFIG_MODIFIERS, v)
  });

  // „Höchster"/„Niedrigster" (Vorteil/Nachteil): Default systemabhängig.
  game.settings.register(ADR.ID, ADR.CONFIG_KEEP_DICE, {
    name: "argas-dice-roller.settings.enableKeepDice.name",
    hint: "argas-dice-roller.settings.enableKeepDice.hint",
    scope: "world",
    config: false,
    default: ADR.KEEP_DICE_SYSTEMS.includes(game.system.id),
    type: Boolean,
    onChange: v => _updateDiceForm(ADR.CONFIG_KEEP_DICE, v)
  });

  game.settings.register(ADR.ID, ADR.CONFIG_CTHULHU_DICE, {
    name: "argas-dice-roller.settings.enableCthulhuDice.name",
    hint: "argas-dice-roller.settings.enableCthulhuDice.hint",
    scope: "world",
    config: false,
    default: ADR.CTHULHU_DICE_SYSTEMS.includes(game.system.id),
    type: Boolean,
    onChange: v => _updateDiceForm(ADR.CONFIG_CTHULHU_DICE, v)
  });

  game.settings.register(ADR.ID, "enableFateRollButton", {
    name: "argas-dice-roller.settings.enableFateRollButton.name",
    hint: "argas-dice-roller.settings.enableFateRollButton.hint",
    scope: "world",
    config: false,
    default: true,
    type: Boolean,
    onChange: () => _updateDiceForm("enableFateRollButton", null)
  });

  game.settings.register(ADR.ID, ADR.CONFIG_MAXDICE_COUNT, {
    name: "argas-dice-roller.settings.maxDiceCount.name",
    hint: "argas-dice-roller.settings.maxDiceCount.hint",
    scope: "client",
    config: true,
    default: 6,
    type: Number,
    range: { min: 1, max: 30, step: 1 },
    onChange: (v) => {
      _updateDiceForm(ADR.CONFIG_MAXDICE_COUNT, v);
      ADR_confirmReload();
    }
  });

  game.settings.register(ADR.ID, ADR.CONFIG_1ST_COLUMN, {
    name: "argas-dice-roller.settings.enableFirstColumn.name",
    hint: "argas-dice-roller.settings.enableFirstColumn.hint",
    scope: "client",
    config: true,
    default: true,
    type: Boolean,
    onChange: v => _updateDiceForm(ADR.CONFIG_1ST_COLUMN, v)
  });

  game.settings.register(ADR.ID, ADR.CONFIG_DICE_TYPES, {
    scope: "world",
    config: false,
    default: { ...ADR.DICE_TYPES_DEFAULT },
    type: Object,
    onChange: v => _updateDiceForm(ADR.CONFIG_DICE_TYPES, v)
  });

  game.settings.registerMenu(ADR.ID, "diceTypes", {
    name: `${ADR.ID}.diceTypes.menuName`,
    hint: `${ADR.ID}.diceTypes.menuHint`,
    label: `${ADR.ID}.diceTypes.menuLabel`,
    icon: "fa-solid fa-dice-d20",
    type: DiceTypesForm,
    restricted: true,
  });

  game.settings.registerMenu(ADR.ID, "buttons", {
    name: `${ADR.ID}.buttons.menuName`,
    hint: `${ADR.ID}.buttons.menuHint`,
    label: `${ADR.ID}.buttons.menuLabel`,
    icon: "fa-solid fa-toggle-on",
    type: ButtonsSettingsForm,
    restricted: true,
  });

  game.settings.register(ADR.ID, ADR.CONFIG_WILD_DIE, {
    name: "argas-dice-roller.settings.enableWildDie.name",
    hint: "argas-dice-roller.settings.enableWildDie.hint",
    scope: "world",
    config: false,
    default: isSwade,
    type: Boolean,
    onChange: v => _updateDiceForm(ADR.CONFIG_WILD_DIE, v)
  });

  game.settings.register(ADR.ID, ADR.CONFIG_HIGHLIGHT_ONES, {
    name: "argas-dice-roller.settings.highlightNaturalOnes.name",
    hint: "argas-dice-roller.settings.highlightNaturalOnes.hint",
    scope: "world",
    config: false,
    default: isSwade,
    type: Boolean
  });

  game.settings.register(ADR.ID, ADR.CONFIG_REQUEST_ROLL, {
    name: "argas-dice-roller.settings.enableRequestRoll.name",
    hint: "argas-dice-roller.settings.enableRequestRoll.hint",
    scope: "world",
    config: false,
    default: isSwade,
    type: Boolean,
    onChange: () => _updateDiceForm(ADR.CONFIG_REQUEST_ROLL, null)
  });

  // SWADE-Submenu nur auf Systemen mit SWADE-Mechaniken — sonst wäre der
  // Menüeintrag funktionslos.
  if (adrSwadeMechanicsOffered()) {
    game.settings.registerMenu(ADR.ID, "swadeSettings", {
      name: `${ADR.ID}.swadeSettings.menuName`,
      hint: `${ADR.ID}.swadeSettings.menuHint`,
      label: `${ADR.ID}.swadeSettings.menuLabel`,
      icon: "fa-solid fa-dice",
      type: SwadeSettingsForm,
      restricted: true,
    });
  }
}

/* ================================================================ */
/*  Hilfsfunktionen                                                 */
/* ================================================================ */

function _updateDiceForm(key, value) {
  if (!globalDiceForm) return;
  switch (key) {
    case ADR.CONFIG_HIDDEN_ROLLS: globalDiceForm.enableHiddenRolls = value; break;
    case ADR.CONFIG_EXPLODING_MODE:
      globalDiceForm.explodingMode = value;
      globalDiceForm.showExplodingToggle = (value !== "off");
      if (value === "off") globalDiceForm.isExploding = false;
      break;
    case ADR.CONFIG_EXPLODING_DEFAULT:
      globalDiceForm.explodingDefault = value;
      globalDiceForm.isExploding = value && globalDiceForm.showExplodingToggle;
      break;
    case ADR.CONFIG_WILD_DIE: globalDiceForm.showWildToggle = value; break;
    case ADR.CONFIG_MODIFIERS: globalDiceForm.showModifiers = value; break;
    case ADR.CONFIG_KEEP_DICE:
      globalDiceForm.showKeepToggle = value;
      if (!value) globalDiceForm.keepMode = null;
      break;
    case ADR.CONFIG_CTHULHU_DICE:
      globalDiceForm.showCthulhuToggle = value;
      if (!value) { globalDiceForm.cthulhuMode = null; globalDiceForm.cthulhuCount = 1; }
      break;
    case ADR.CONFIG_1ST_COLUMN: globalDiceForm.enableFirstColumn = value; break;
    case ADR.CONFIG_CLOSE_FORM: globalDiceForm.closeFormOnRoll = value; break;
    case ADR.CONFIG_DICE_TYPES: globalDiceForm.diceTypes = value; break;
  }
  // Nur ein OFFENES Fenster neu rendern — render(true) würde ein geschlossenes
  // Würfelfenster wieder öffnen (bei World-Settings auf allen Clients).
  if (globalDiceForm.rendered) globalDiceForm.render(true);
}

/**
 * Optionaler Reload-Dialog nach Einstellungsänderung. ApplicationV2 vergibt
 * Z-Indices nach Fokus-Reihenfolge — bei offenem Würfelfenster kann der
 * DialogV2 darunter landen, daher explizite Instanz plus `bringToFront()`.
 */
function ADR_confirmReload() {
  const title   = game.i18n.localize(`${ADR.ID}.dialogs.reload.title`);
  const content = `<p>${game.i18n.localize(`${ADR.ID}.dialogs.reload.content`)}</p>`;

  const dlg = new foundry.applications.api.DialogV2({
    window: { title },
    content,
    buttons: [
      {
        action: "yes",
        label: game.i18n.localize("Yes"),
        default: true,
        callback: () => window.location.reload()
      },
      {
        action: "no",
        label: game.i18n.localize("No"),
        callback: () => {}
      }
    ],
    rejectClose: false
  });

  const renderPromise = dlg.render({ force: true });
  // Optional Chaining defensiv gegen API-Wechsel in Major-Versionen.
  renderPromise.then(() => {
    try { dlg.bringToFront?.(); } catch (e) { /* */ }
  });
  return renderPromise;
}
