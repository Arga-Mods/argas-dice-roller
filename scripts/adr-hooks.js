/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright (C) 2026 Arga-Mods */

import { ADR } from "./adr-constants.js";
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
  subjectCanClick,
} from "./adr-benny-helpers.js";

let globalDiceForm;
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
 * Hält den ADR-Eintrag als letztes Element der Steuerungsleiste.
 * Endlosschleifen-Schutz: zählt Repositionierungen pro Render-Zyklus —
 * wird das Limit überschritten (ein anderes Modul kämpft ebenfalls um den
 * letzten Platz), trennt ADR seinen eigenen Observer und gibt den Platz auf.
 * Das Spiel bleibt so in jedem Fall flüssig.
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

/** Würfelfenster öffnen bzw. schließen. */
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

/* Manueller DOM-Injection-Fallback: erzeugt den ADR-Eintrag als eigenes
 * <li> in der Szenen-Steuerungsleiste (dem <menu>), unten links, außerhalb
 * der Figurensteuerung.
 * Robustes Unten-Halten in drei Stufen:
 *   - order:9999 inline (am <li>)        — CSS-Flex-Reihenfolge
 *   - Stufe 1: verzögertes Nach-Anhängen — gewinnt gegen denselben Render
 *   - Stufe 2: MutationObserver          — gewinnt auch gegen späte Einschübe
 */
Hooks.on("renderSceneControls", (_app, html) => {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;

  // ADR-Eintrag holen oder neu erzeugen. `item` ist das <li> der Leiste
  // (im Struktur-Fallback der Button selbst).
  const existingBtn = root.querySelector(`[data-control="${ADR_CONTROL_KEY}"]`);
  const item = existingBtn ? (existingBtn.closest("li") ?? existingBtn)
                           : _adrInjectControlButton(root);
  if (!item) return;

  const container = item.parentElement;   // die echte Steuerungsleiste (<menu>/<ol>)
  if (!container) return;

  // Neuer Render-Zyklus: Tauzieh-Zähler zurücksetzen, alten Observer trennen.
  _adrReorderCount = 0;
  _adrControlObserver?.disconnect();

  // Stufe 1: nach allen synchronen Render-Hooks der anderen Module einmal
  // ans Ende schieben — gewinnt gegen alles aus diesem Render-Durchlauf.
  requestAnimationFrame(() => _adrEnsureControlLast(container, item));

  // Stufe 2: Observer hält den Eintrag dauerhaft als letztes Element,
  // auch gegen Module, die ihren Eintrag erst deutlich später einschieben.
  _adrControlObserver = new MutationObserver(() => _adrEnsureControlLast(container, item));
  _adrControlObserver.observe(container, { childList: true });
});

/**
 * Erzeugt den ADR-Eintrag für die Szenen-Steuerungsleiste.
 *
 * Foundry v14 baut jedes Steuerungs-Symbol als
 *   <li><button data-control="…">…</button></li>.
 * Diese Funktion klont das <li>-Wrapper eines vorhandenen Controls (Notes)
 * als Vorlage, baut es auf die ADR-Identität um und hängt es als
 * EIGENSTÄNDIGES <li> an die echte Leiste (das <menu>/<ol>) an — NICHT in
 * das <li> eines fremden Controls hinein.
 *
 * Fallback: Findet sich kein <li>-Wrapper (abweichende Struktur), wird wie
 * früher der Button selbst geklont und an dessen Elternelement gehängt.
 *
 * @returns {HTMLElement|null} das eingehängte äußere Element (<li> bzw. Button)
 */
function _adrInjectControlButton(root) {
  // 1) Vorlage-Button eines vorhandenen Controls finden.
  const tplButton =
    root.querySelector(`[data-control="notes"]`) ??
    root.querySelector(`[data-control]`);

  if (!tplButton) {
    console.warn(`[${ADR_CONTROL_KEY}] kein Vorlage-Control für Injection gefunden`);
    return null;
  }

  // 2) <li>-Wrapper bestimmen; Fallback auf den Button selbst.
  const tplItem = tplButton.closest("li") ?? tplButton;
  const hasLiWrapper = tplItem !== tplButton;

  // 3) Zielcontainer = Elternelement des Wrappers = die echte Leiste.
  const container = tplItem.parentElement;
  if (!container) return null;

  // 4) Vorlage tief klonen (Event-Listener werden dabei NICHT mitkopiert).
  const outer = tplItem.cloneNode(true);

  // 5) Inneren Button bestimmen. Falls das Vorlage-<li> durch frühere
  //    (Fremd-)Injektionen mehrere Buttons enthält, nur den ersten behalten.
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

  // 6) Active/Selected-Zustand rekursiv entfernen.
  const stripState = (el) => {
    el.classList?.remove?.("active", "selected", "control-active", "ui-active",
                           "control-tool-active", "active-tool");
    el.removeAttribute?.("aria-pressed");
    el.removeAttribute?.("aria-current");
  };
  stripState(outer);
  outer.querySelectorAll("*").forEach(stripState);

  // 7) Alle Icon-Träger entfernen — V13/V14 kann <i>, <svg>, <img>, <picture> nutzen.
  outer.querySelectorAll("i, svg, img, picture").forEach(el => el.remove());

  // 8) FontAwesome-Klassen strippen, sonst erscheint das Vorlage-Icon
  //    (z.B. Bookmark) zusätzlich per ::before-Pseudoelement.
  const stripFa = (el) => {
    if (!el.classList) return;
    Array.from(el.classList)
      .filter(c => c.startsWith("fa-") || c === "fas" || c === "far" || c === "fab")
      .forEach(c => el.classList.remove(c));
  };
  stripFa(outer);
  outer.querySelectorAll("*").forEach(stripFa);

  // 9) Fremd-Identität (data-control/-action/-tool) von ALLEN Elementen des
  //    Klons entfernen …
  const stripIdentity = (el) => {
    if (!el.dataset) return;
    delete el.dataset.control;
    delete el.dataset.action;
    delete el.dataset.tool;
  };
  stripIdentity(outer);
  outer.querySelectorAll("*").forEach(stripIdentity);

  // 10) … und ausschließlich auf dem inneren Button die ADR-Identität setzen.
  inner.dataset.control = ADR_CONTROL_KEY;

  // 11) Tooltip/ARIA auf Wrapper und Button setzen, altes title-Attribut weg.
  const titleStr = game.i18n.localize("argas-dice-roller.controlTitle");
  for (const el of (outer === inner ? [outer] : [outer, inner])) {
    el.setAttribute("aria-label", titleStr);
    el.setAttribute("data-tooltip", titleStr);
    el.removeAttribute("title");
  }

  // 12) ADR-eigenes Icon einsetzen.
  const newIcon = document.createElement("i");
  newIcon.className = "fas fa-dice-d20";
  newIcon.setAttribute("aria-hidden", "true");
  inner.appendChild(newIcon);

  // 13) CSS-Flex-Reihenfolge: maximaler order-Wert schiebt den Eintrag im
  //     Flex-Layout der Leiste ganz nach unten (harmlos, falls kein Flex).
  outer.style.setProperty("order", "9999", "important");

  // 14) Als eigenständigen Eintrag an die echte Leiste anhängen.
  container.appendChild(outer);
  return outer;
}

// Delegierter Klick-Handler (Capture-Phase, einmalig registriert): fängt
// Klicks auf den injizierten Button ab und schaltet das Würfelfenster.
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

    // Würfelfenster schließen
    if (globalDiceForm?.rendered) globalDiceForm.close();

    // RequestRollForm öffnen (Singleton)
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

    // W6 würfeln
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

    // Dice So Nice 3D-Animation
    if (game.dice3d) {
      await game.dice3d.showForRoll(roll, game.user, true);
    }

    // Flags setzen → löst renderChatMessageHTML erneut aus
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

    // Subject + Berechtigungs-Check
    const subject = freeRollSubject(message);
    if (!subject) return;
    if (!subjectCanClick(subject)) {
      ui.notifications.warn(game.i18n.localize(`${ADR.ID}.requestRoll.chatNoPermission`));
      return;
    }

    // Bennies prüfen
    if (subjectBennies(subject) <= 0) {
      ui.notifications.warn(game.i18n.localize(
        subject.forNPC ? `${ADR.ID}.requestRoll.warn.noGMBennies`
                       : `${ADR.ID}.requestRoll.warn.noBennies`
      ));
      return;
    }

    // Benny abziehen (SWADE-Animation + Counter-Update)
    const spent = await subjectSpendBenny(subject);
    if (!spent) {
      ui.notifications.warn(game.i18n.localize(
        subject.forNPC ? `${ADR.ID}.requestRoll.warn.noGMBennies`
                       : `${ADR.ID}.requestRoll.warn.noBennies`
      ));
      return;
    }

    // Neu würfeln (gleiche Parameter wie Ursprungswurf)
    let mainRoll, wildRoll, sumMod, type, hasWildDie, isExploding, pool;
    try {
      ({ mainRoll, wildRoll, sumMod, type, hasWildDie, isExploding, pool } = await _adrFreshFreeRoll(message));
    } catch (err) {
      console.error(`${ADR.ID} | Benny-Reroll (freier Wurf) Wurf-Fehler:`, err);
      return;
    }
    if (!mainRoll) return;

    // Patzer-Mechanik-Schalter für die Anzeige-Datenextraktion (Highlights).
    // Wird auch unten für den Tweaks-Hook ausgewertet.
    let fumbleMechanic = false;
    try { fumbleMechanic = !!game.settings.get(ADR.ID, "highlightNaturalOnes"); } catch (e) { /* */ }

    // Multi-Pool: Tweaks-Hook + dice[0]-basierte Total-Neuberechnung
    // ÜBERSPRINGEN (Spec — der Tweaks-Dialog ist auf Mehrkategorien-Pools nicht
    // ausgelegt, und die dice[0]-Total-Logik würde nur den ersten Pool-Eintrag
    // berücksichtigen). DSN-Animation läuft trotzdem.
    const isMultiReroll = Array.isArray(pool) && pool.length > 0;

    if (!isMultiReroll) {
      // Hook für Tweaks-Integration feuern (rollKind: "free", isBennyReroll: true)
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
      if (finalRoll === false) return;  // Hook hat abgebrochen

      // Totals neu berechnen (Hook könnte Würfel-Werte manipuliert haben)
      if (mainRoll?.dice?.length) {
        const sum = mainRoll.dice[0].results.reduce((a, r) => a + (r.result || 0), 0);
        mainRoll._total = sum + sumMod;
      }
      if (wildRoll?.dice?.length) {
        const sum = wildRoll.dice[0].results.reduce((a, r) => a + (r.result || 0), 0);
        wildRoll._total = sum + sumMod;
      }
    }

    // DSN-Animation für den Reroll-Wurf (zeigt finale Werte nach Hook).
    // Roll-Sound manuell triggern — Foundry spielt den Würfelsound nur
    // bei ChatMessage.create(), wir machen aber update(), daher fehlt
    // er sonst beim Benny-Reroll.
    try { foundry.audio.AudioHelper.play({ src: CONFIG.sounds.dice }, true); } catch (e) { /* */ }
    if (game.dice3d) {
      try { await game.dice3d.showForRoll(mainRoll, game.user, true); } catch (e) { /* */ }
      if (wildRoll) {
        try { await game.dice3d.showForRoll(wildRoll, game.user, true); } catch (e) { /* */ }
      }
    }

    // Anzeigedaten extrahieren (pool durchreichen für Multi-Kategorisierung)
    const newData = _adrExtractFreeRollData(mainRoll, wildRoll, fumbleMechanic, pool);

    // Schutz-/Overwrite-Logik anwenden + Message updaten. Foundry merget
    // Flag-Sub-Objekte rekursiv, deshalb müssen Flags, die wir aus der
    // DB entfernen wollen, explizit gelöscht werden (siehe
    // _adrWriteFlags) — sonst bleibt z. B. ein altes
    // `lastRerollFumbleOverwrite=true` aus einem früheren Reroll hängen.
    const newFlags = foundry.utils.deepClone(message.flags[ADR.ID]);
    const isWildcardSpeaker = !!newFlags.isWildcard;
    const removals = _adrApplyBennyRerollFree(newFlags, newData, isWildcardSpeaker);
    await _adrWriteFlags(message, newFlags, removals);
  });

  // ── Discarded-Patzer-Check im freien Wurf (GM-Button) ──
  // Prüft den verworfenen Statisten-Wurf nachträglich auf Patzer-Bestätigung.
  // Greift, wenn der alte Wurf bei einem Benny-Reroll mit einer einzelnen 1
  // geschützt wurde und der GM den Status doch noch klären will.
  document.body.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-action='adr-fumble-check-discarded-free']");
    if (!btn || !game.user.isGM) return;

    const messageId = btn.dataset.messageId;
    const message = game.messages.get(messageId);
    if (!message) return;

    const flags = message.flags?.[ADR.ID];
    if (!Array.isArray(flags?.previousRolls) || flags.previousRolls.length === 0) return;
    const lastIdx = flags.previousRolls.length - 1;

    // W6 würfeln
    const roll = new Roll("1d6");
    await roll.evaluate();

    // Hook für Tweaks-Integration feuern (gleiches Pattern wie adr-fumble-check-main)
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

    // Total neu berechnen (Tweaks könnte den Würfel-Wert manipuliert haben)
    if (roll?.dice?.length) {
      const sum = roll.dice[0].results.reduce((a, r) => a + (r.result || 0), 0);
      roll._total = sum;
    }

    // Dice So Nice 3D-Animation
    if (game.dice3d) {
      await game.dice3d.showForRoll(roll, game.user, true);
    }

    // Letzten verworfenen Eintrag updaten → renderChatMessageHTML zeigt das Ergebnis
    const newFlags = foundry.utils.deepClone(flags);
    newFlags.previousRolls[lastIdx].fumbleCheckResult = roll.total === 1;
    newFlags.previousRolls[lastIdx].fumbleCheckDie = roll.total;
    await message.update({ [`flags.${ADR.ID}`]: newFlags });
  });

  // ── Initial-Wurf: GM nimmt die 1 ohne Patzer-Check an ──
  // Setzt nur das Akzeptiert-Flag; die Render-Logik blendet Buttons aus.
  document.body.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-action='adr-fumble-accept-main']");
    if (!btn || !game.user.isGM) return;

    const messageId = btn.dataset.messageId;
    const message = game.messages.get(messageId);
    if (!message) return;

    await message.update({ [`flags.${ADR.ID}.fumbleCheckAccepted`]: true });
  });

  // ── Pending-Reroll: GM nimmt das Reroll-Ergebnis an (kein Patzer-Check) ──
  // Der neue Wurf war eine 1, ist aber nicht zwangsläufig ein Patzer.
  // „Annehmen" lässt die 1 als Reroll-Ergebnis stehen, der Benny-Schutz
  // greift, und das alte Ergebnis bleibt sichtbar — analog dem klassischen
  // Schutz-Pfad. Der Discarded wird mit `fumbleCheckSkipped` markiert,
  // damit der „Allerdings war eine 1"-Zusatz und der Check-Button entfallen.
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
    // Im invertierten Pending-Datenmodell ist der alte (gute) Wurf bereits
    // mainResult, der Reroll-1 liegt im letzten previousRolls-Eintrag.
    // „Besseres Ergebnis behalten" heißt deshalb: kein Swap nötig, nur den
    // verworfenen Reroll-1 mit fumbleCheckSkipped markieren — das unterdrückt
    // im Schutz-Hint den „Allerdings war eine 1"-Zusatz und den nachträglichen
    // Discarded-Check-Button.
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

    // W6 würfeln + Tweaks-Hook (selber Pfad wie adr-fumble-check-main)
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

    if (game.dice3d) {
      try { await game.dice3d.showForRoll(roll, game.user, true); } catch (e) { /* */ }
    }

    const dieValue = roll.total;
    const isFumble = dieValue === 1;

    const newFlags = foundry.utils.deepClone(flags);

    if (isFumble) {
      // Patzer bestätigt: der alte (gute) Wurf wandert in previousRolls, der
      // Reroll-1 wird zum geltenden mainResult mit Patzer-Vorrang. Im neuen
      // Pending-Datenmodell ist die 1 noch im letzten previousRolls-Eintrag;
      // _adrPendingDecisionSwap tauscht sie mit dem aktuellen mainResult.
      _adrPendingDecisionSwap(newFlags);
      newFlags.lastRerollFumbleOverwrite = true;
      newFlags.fumbleCheckResult = true;
      newFlags.fumbleCheckDie = dieValue;
    } else {
      // Kein Patzer: alter Wurf bleibt geltend (= mainResult bleibt unverändert),
      // verworfener Reroll-1 im letzten previousRolls-Eintrag wird mit Check-
      // Ergebnis markiert (Schutz-Hint zeigt damit „Allerdings war eine 1" +
      // „zusätzliche Prüfung ergab: kein kritischer Fehlschlag").
      const lastIdx = newFlags.previousRolls.length - 1;
      newFlags.previousRolls[lastIdx].fumbleCheckResult = false;
      newFlags.previousRolls[lastIdx].fumbleCheckDie = dieValue;
      newFlags.lastRerollProtected = true;
    }
    delete newFlags.pendingRerollFumbleDecision;

    await _adrWriteFlags(message, newFlags, ["pendingRerollFumbleDecision"]);
  });

  // ── Klick auf Akteur-Bild im freien Wurf: Token zentrieren + auswählen ──
  // Kein Sheet öffnen — analog zum Verhalten in der Probenanforderung.
  // Funktioniert nur, wenn ein Token in der aktuellen Szene zum Speaker existiert.
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
    // Kein Token in aktueller Szene → still bleiben (keine Sheet-Öffnung).
  });
});

/* ================================================================ */
/*  Verdeckte-Würfe-Toggle: eigenständiger Fenster-Zustand            */
/* ================================================================ */

/*
 * Der ADR-Toggle (Privater SL-Wurf / Blindwurf / Eigenwurf) ist reiner
 * Fenster-Zustand in `DiceForm.hiddenType` — gesetzt vom Klick im
 * Würfelfenster, beim Öffnen über _resetVolatileSettings() auf
 * "öffentlich" zurückgesetzt. ADR liest und schreibt bewusst KEIN
 * Foundry-Würfelmodus-Setting: `core.rollMode` ist seit v14 zugunsten
 * von `core.messageMode` deprecatet, die Kompatibilität fällt mit v16
 * weg. Eine Sync mit dem nativen Chat-Selektor findet daher nicht
 * statt; den verdeckten Wurf setzt _rollDie direkt über whisper/blind.
 */

/* ================================================================ */
/*  renderChatMessageHTML – komplett vanilla DOM (kein jQuery)       */
/* ================================================================ */

/**
 * Maximaldefensives Verstecken einer Chat-LI.
 * Gleiche Behandlung für selfRoll / gmRoll / blindRoll-Nachrichten,
 * die ungewollt auf einem Client sichtbar werden würden.
 * Setzt mehrere CSS-Werte mit !important, plus hidden-Attribut und
 * leert den Inhalt — falls ein anderes Modul display:none überschreibt,
 * ist immer noch nichts zu sehen.
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
/*  Werden vom Render-Hook UND von _adrInjectFreeRollDiscardedHistory */
/*  genutzt — daher als top-level Funktionen.                         */
/* ---------------------------------------------------------------- */

/**
 * Baut den Display-Text für die Hauptzeile eines Multi-Pool-Wurfs.
 *
 * Regeln (per Spec):
 *   - Mit Wild Die ODER ≥ 4 Kategorien → "div. Würfel" (lokalisiert,
 *     i18n-Key: chat.multiDiceMixed).
 *   - Sonst 1–3 Kategorien → "2x W4 (+) 3x W20 (+) 1x W100"
 *     (Plus-Trenner aus i18n-Key chat.multiDicePlus, "W" bei deutsch,
 *     "d" bei englisch).
 *   - `ex`-Superscript bei mainExploding=true angehängt.
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

/**
 * Baut die Detail-Anzeige (Toggle-Inhalt) für einen Multi-Pool-Wurf.
 * Pro Kategorie eine Zeile mit Label „Nx Wn:" + Einzelwerte (min/max-
 * gefärbt). Optional Extras-Zeile mit (WD: …) und (Mod. ±N).
 */
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
  // Extras-Zeile: Wild Die + Modifikator
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
  // v14: html ist ein HTMLElement
  const li = html.closest("li.chat-message") ?? html;

  // ── Hilfsfunktion: H4-Titel im Header setzen oder erzeugen ──
  function _setHeaderLabel(container, label) {
    const header = container.querySelector(".message-header");
    if (!header) return;

    // Eigenes Label-Element erzeugen (oder aktualisieren)
    let adrLabel = header.querySelector(".adr-header-label");
    if (!adrLabel) {
      adrLabel = document.createElement("span");
      adrLabel.className = "adr-header-label";
      header.prepend(adrLabel);
    }
    adrLabel.textContent = label;

    // System-h4 verstecken
    const h4 = header.querySelector("h4");
    if (h4) h4.style.setProperty("display", "none", "important");
  }

  // ── Fate-Roll: Hintergrund per Overlay-Layer erzwingen ──
  if (message.getFlag(ADR.ID, "fate")) {
    li.classList.add("adr-chat", "adr-fate");

    const modulePath = game.modules.get(ADR.ID)?.path || `modules/${ADR.ID}`;
    const bgUrl = `${modulePath}/assets/layout/background_finger.webp`;

    // Host vorbereiten
    li.style.setProperty("position", "relative", "important");
    li.style.setProperty("background", "transparent", "important");
    li.style.setProperty("min-height", "260px", "important");
    li.style.setProperty("aspect-ratio", "1 / 1", "important");

    // vorhandenes Overlay ersetzen
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

    // Header-Label setzen (wie bei normalen Würfen)
    _setHeaderLabel(li, game.i18n.localize(`${ADR.ID}.chat.fateTitle`));

    // Kinder transparent + über das Overlay legen
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

  // ── Privater Wurf (selfRoll): Nur der Würfelnde sieht überhaupt etwas. ──
  // Foundry zeigt geflüsterte Nachrichten standardmäßig auch an SLs (und je nach
  // Setup/Modul-Konfiguration an weitere User). Bei einem privaten Wurf soll
  // wirklich NIEMAND außer dem Würfelnden eine Nachricht sehen — daher zusätzlich
  // zur korrekten Whisper-Liste hier defensiv mehrfach absichern.
  // Fallback-Erkennung: Whisper geht nur an einen einzigen User, der zugleich
  // der Autor ist (klassische selfRoll-Signatur), falls das Flag aus irgendeinem
  // Grund nicht gesetzt sein sollte (alte Nachrichten o.ä.).
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

  // ── Privater SL-Wurf / Verdeckter SL-Wurf: nur SLs (und der Autor) dürfen
  //    überhaupt etwas sehen. Wenn ein Nicht-SL aus irgendeinem Grund die
  //    Nachricht in seinem Chat hat, hier komplett verstecken.
  //    Erkennung: hideRecipients-Flag (gesetzt für GM_ROLL und BLIND_ROLL),
  //    plus Heuristik (Whisper geht ausschließlich an SL-User).
  const _hideRecipientsFlag = message.getFlag(ADR.ID, "hideRecipients") === true;
  const _looksLikeGMOnlyWhisper = _whisperList.length > 0
    && _whisperList.every(id => game.users.get(id)?.isGM);
  const _isGMOnlyMsg = _hideRecipientsFlag || _looksLikeGMOnlyWhisper;
  if (_isGMOnlyMsg && !game.user.isGM && message.author?.id !== game.user.id) {
    _adrHideMessage(li);
    return;
  }

  // ── Sprachmix-Schutz: Marker, die der Würfler-Client gesetzt hat,
  //    werden hier in der Interface-Sprache des Empfängers gefüllt.
  //    `data-adr-i18n="…"` → innerHTML = lokalisierter Key
  //      (innerHTML, weil i18n-Strings HTML-Tags enthalten dürfen, z.B. <i>(klick)</i>)
  //    `data-adr-hidden-key="gmRoll|blindRoll|selfRoll"` → innerHTML = buildHiddenInfoHTML(key)
  html.querySelectorAll("[data-adr-i18n]").forEach(el => {
    el.innerHTML = game.i18n.localize(el.dataset.adrI18n);
  });
  html.querySelectorAll("[data-adr-hidden-key]").forEach(el => {
    let key = el.dataset.adrHiddenKey;
    // Spezialfall: ein Spieler hat einen Privaten SL-Wurf (gmRoll) gemacht
    // und der GM sieht die Nachricht jetzt. Der gmRoll-Text ist aus
    // Sicht des Würflers formuliert ("…und für Dich") und klingt für den
    // GM als Empfänger schief. In dem Fall den GM-spezifischen Schlüssel
    // einsetzen, damit die zweite Zeile lautet "und den Würfelnden".
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
        // Beim Aufklappen: Chat-Log scrollen damit alles sichtbar ist
        if (!details.classList.contains("adr-individual-hidden")) {
          // Reflow erzwingen, dann scrollen
          void details.offsetHeight;
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
  const nameBox = html.querySelector(".adr-actor-name");
  if (nameBox) {
    html.classList.add(nameBox.offsetHeight > 40 ? "two-line" : "one-line");
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

    const actorName = message.getFlag(ADR.ID, "actorName") || "Unbekannt";
    const modulePath = game.modules.get(ADR.ID)?.path || `modules/${ADR.ID}`;
    const defaultSrc = `${modulePath}/assets/layout/default_token.webp`;
    const flagSrc = message.getFlag(ADR.ID, "actorImg") || "";
    const portraitSrc = flagSrc || defaultSrc;

    _setHeaderLabel(li, game.i18n.localize(`${ADR.ID}.legend.freeRollLabel`));

    li.querySelector(".message-header")?.insertAdjacentHTML("afterend",
      `<img class="adr-actor-img" src="${portraitSrc}" alt="Portrait">`);

    const msgContent = html.querySelector(".message-content");
    if (msgContent) {
      msgContent.innerHTML = `<div class="adr-actor-name"><span class="adr-actor-name-text">${actorName}</span></div><div class="adr-result-container"><div class="adr-dice-value">???</div><div class="adr-dice-content"></div></div>`;
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

  // .adr-chat Wrapper entfernen (Kinder nach oben heben)
  const adrChatWrap = html.querySelector(".message-content > .adr-chat");
  if (adrChatWrap) {
    const parent = adrChatWrap.parentNode;
    while (adrChatWrap.firstChild) parent.insertBefore(adrChatWrap.firstChild, adrChatWrap);
    adrChatWrap.remove();
  }

  li.classList.add("adr-chat");
  li.classList.remove("with-wild", "no-wild");
  if (message.getFlag(ADR.ID, "fate")) li.classList.add("adr-fate");

  // Theme aus dem "chatDesign"-Dropdown: "modern" → SciFi-Optik,
  // "fantasy" → klassische Optik. ("standard" erreicht diesen Hook
  // gar nicht erst — solche Würfe werden ohne ADR-Render erzeugt.)
  const scifi = game.settings.get(ADR.ID, "chatDesign") === "modern";
  if (scifi) li.classList.add("scifi");

  if (message.getFlag(ADR.ID, "wildResult") !== undefined) li.classList.add("with-wild");

  _setHeaderLabel(li, game.i18n.localize(`${ADR.ID}.legend.freeRollLabel`));

  const flagSrc = message.getFlag(ADR.ID, "actorImg") || "";
  const modulePath = game.modules.get(ADR.ID)?.path || `modules/${ADR.ID}`;
  const defaultSrc = `${modulePath}/assets/layout/default_token.webp`;
  const portraitSrc = flagSrc || defaultSrc;
  if (portraitSrc) {
    li.querySelector(".message-header")?.insertAdjacentHTML("afterend",
      `<img class="adr-actor-img" src="${portraitSrc}" alt="Portrait">`);
  }

  const actorName = message.getFlag(ADR.ID, "actorName") || "Unbekannt";
  li.querySelector(".adr-actor-name")?.remove();
  li.querySelector(".adr-body")?.insertAdjacentHTML("beforebegin",
    `<div class="adr-actor-name"><span class="adr-actor-name-text">${actorName}</span></div>`);

  const rawFormula = message.getFlag(ADR.ID, "mainFormula") || "";
  const clean = rawFormula.replace(/\s+/g, "");

  // ── Multi-Pool-Erkennung ──
  // Eine Multi-Pool-Nachricht hat ein Array-Flag `multiPool`. In diesem Fall
  // wird die normale parseDice/buildCell-Logik (die nur eine einzelne Würfel-
  // Formel kennt) übersprungen und durch einen eigenen Render-Pfad ersetzt.
  // `mainFormula` ist in solchen Nachrichten als Marker auf "_multi_pool"
  // gesetzt (für die ADR-Erkennung weiter oben), wird hier aber nicht geparst.
  const multiPool = message.getFlag(ADR.ID, "multiPool");
  const isMulti = Array.isArray(multiPool) && multiPool.length > 0;

  function parseDice(formula) {
    const m = formula.match(/^(?:([0-9]+))?(dc|d[0-9]+)(?:[x!]+)?([+\-][0-9]+)?/) || [];
    const cnt = m[1] || "";
    const raw = m[2] || "";
    const mod = m[3] || "";
    const die = raw === "dc"
      ? game.i18n.localize(`${ADR.ID}.legend.coin`)
      : (game.i18n.lang.startsWith("de") ? raw.replace(/^d/, "W") : raw);
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
    const isCoin = (die === game.i18n.localize(`${ADR.ID}.legend.coin`)) || (individualResults.length > 0 && individualResults.every(x => x.value === 0 || x.value === 1));
    if (highlightSetting && !isCoin) {
      if (individualResults.length === 1 && individualResults[0].value == 1) highlight = true;
      if (individualResults.length > 1) {
        const numOnes = individualResults.filter(x => x.value == 1).length;
        if (numOnes > individualResults.length / 2) highlight = true;
      }
    }
    const isWildCell = (die === game.i18n.localize(`${ADR.ID}.legend.wildDieChat`));
    const starFlag = isWildCell
      ? message.getFlag("argas-dice-roller", "wildExploding")
      : message.getFlag("argas-dice-roller", "mainExploding");
    // Echte Münzzelle (zur CSS-Sonderbehandlung des Vertikal-Abstands)
    const isCoinCell = (die === game.i18n.localize(`${ADR.ID}.legend.coin`));

    // Kopfzeile der Zelle: Münzzelle zeigt "Münzwurf" (kein "1x Münze"),
    // alle anderen Zellen unverändert "Nx Wn" + ex-Sup + Modifikator.
    const diceInfoHTML = isCoinCell
      ? game.i18n.localize(`${ADR.ID}.chat.coin-roll-label`)
      : `${(die === game.i18n.localize(`${ADR.ID}.legend.wildDieChat`) ? "" : (cnt ? `${cnt}x ` : ""))}${die}${(starFlag ? "<sup class=\"adr-ex\">ex</sup>" : "")}${mod ? `<span class="adr-dice-mod adr-dice-mod-${mod.startsWith("+") ? "pos" : "neg"}">(${mod})</span>` : ""}`;

    return `<div class="adr-dice-cell${isCoinCell ? " adr-coin-cell" : ""}">
    <div class="adr-dice-info">
      ${diceInfoHTML}
    </div>
    <div class="adr-summary-total${highlight ? ' adr-highlight-ones' : ''}">
      ${(die === game.i18n.localize(`${ADR.ID}.legend.coin`) && (!mod || mod === "0") && individualResults.length === 1)
        ? `~ ${game.i18n.localize(value == 1 ? `${ADR.ID}.chat.coin-tails` : `${ADR.ID}.chat.coin-heads`)} ~`
        : (value !== undefined && value !== null ? value : `<span class="adr-dice-value">???</span>`)}
      ${criticalHtml}
    </div>
  </div>`;
  };

  // Multi-Pool-spezifischer Zellbau (eigene Hauptzeile pro Pool, ohne
  // die parseDice-basierte Cnt/Die/Mod-Mechanik). Lokalisierungs- und
  // Exploding-Sup-Logik in _adrBuildMultiPoolDisplayHTML.
  const buildMultiCell = (displayHTML, value, modHTML = "") => {
    return `<div class="adr-dice-cell">
      <div class="adr-dice-info">${displayHTML}${modHTML}</div>
      <div class="adr-summary-total">${value !== undefined && value !== null ? value : `<span class="adr-dice-value">???</span>`}</div>
    </div>`;
  };

  // Ergebnisse für die Kritisch-Logik
  const mainIndRes = message.getFlag("argas-dice-roller", "mainIndividualResults") ?? [];
  const wildIndRes = message.getFlag("argas-dice-roller", "wildIndividualResults") ?? [];
  const hasWild = (wildResult != null);

  const onesMain = mainIndRes.filter(x => x?.value == 1).length;
  const totalMain = mainIndRes.length;
  const totalDiceForCritical = hasWild ? (totalMain + 1) : totalMain;
  const onesForCritical = hasWild ? (onesMain + (wildResult == 1 ? 1 : 0)) : onesMain;
  const isCoinRow = !isMulti && (die1 === game.i18n.localize(`${ADR.ID}.legend.coin`));
  // SWADE-Eigenschaftsproben werden IMMER mit explodierenden Würfeln gewürfelt.
  // Wenn der Spieler Exploding NICHT angehakt hat, ist's garantiert keine
  // Eigenschaftsprobe → kein Patzer-Verdacht (auch nicht weich).
  const mainExploding = !!message.getFlag("argas-dice-roller", "mainExploding");

  // Patzer-Anzeige bei Multi-Pool deaktiviert (Spec).
  let showCritical = !isMulti
    && mainExploding
    && hasWild && (wildResult == 1) && (onesForCritical > totalDiceForCritical / 2)
    && game.settings.get("argas-dice-roller", "highlightNaturalOnes");
  if (isCoinRow) showCritical = false;

  let cellsHtml;
  if (isMulti) {
    // Multi-Pool-Hauptzeile: eigener Display-Text + optionale WD-Zelle.
    // Modifikator wird einmalig (in der Main-Zelle) angezeigt — Wild Die
    // zeigt im Multi-Modus keinen separaten Mod-Block, da der Spec-Layout
    // mit „div. Würfel(+)" + WD-Zelle ohne Doppelung übersichtlicher ist.
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
        hasWild && game.settings.get("argas-dice-roller", "highlightNaturalOnes"), "")
    }${
      hasWild
        ? `<div class="adr-iron-bar"><img src="${modulePath}/assets/layout/bar_${scifi ? "sf" : "f"}.webp" alt="Separator" /></div>${
            buildCell(cnt2, game.i18n.localize(`${ADR.ID}.legend.wildDieChat`), mod2, wildResult,
              wildIndRes, game.settings.get("argas-dice-roller", "highlightNaturalOnes"), "")
          }`
        : ""
    }`;
  }

  // Ergebniszeile einfügen
  li.querySelector(".adr-actor-name")?.insertAdjacentHTML("afterend",
    `<div class="adr-dice-row">${cellsHtml}</div>`);

  // Hinweis separat UNTER die Ergebniszeile
  if (showCritical) {
    const rows = li.querySelectorAll(".adr-dice-row");
    const lastRow = rows[rows.length - 1];
    const prefix = game.i18n.localize(`${ADR.ID}.chat.critical-failure-prefix`);
    const label = game.i18n.localize(`${ADR.ID}.chat.critical-failure`);
    lastRow?.insertAdjacentHTML("afterend",
      `<div class="adr-fumble-check-result">${prefix}<br><span class="adr-fumble-confirmed-text" style="font-size:0.85rem;">${label}</span></div>`);
  }

  // ── Patzer-Prüfung: Einzelwürfel ohne Wild Die zeigt 1 → GM-Button ──
  // Bei Wildcards ist der Check sinnlos: Wildcards würden bei einer
  // Eigenschaftsprobe immer einen Wild Die mitwerfen. Ein Einzelwürfel
  // ohne Wild Die kann also keine Eigenschaftsprobe gewesen sein. Der
  // Patzer-Check ist nur bei Statisten relevant. Das `isWildcard`-Flag
  // wird beim Wurf in adr-dice-form.js gesetzt; bei alten Nachrichten
  // ohne Flag fällt es auf `false` zurück → Verhalten wie bisher.
  const isWildcardSpeaker = !!message.getFlag(ADR.ID, "isWildcard");
  // SWADE-Eigenschaftsproben sind immer explodierend. Ohne Explosion kein
  // Patzer-Verdacht → der Check-Button entfällt. Bei Multi-Pool ebenfalls
  // immer deaktiviert (Spec).
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
      // Patzer bestätigt — Ergebnis rot + Ergebnis-Text
      const summaryTotal = li.querySelector(".adr-summary-total");
      if (summaryTotal) summaryTotal.classList.add("adr-highlight-ones");
      // Im FumbleOverwrite-Pfad (W6=1 nach Reroll-1 beim Statisten) wird der
      // Ergebnistext nicht separat, sondern als zusammenhängender Satz in der
      // Hint-Region gerendert (siehe bennyFumbleOverwriteHintConfirmed).
      if (message.getFlag(ADR.ID, "lastRerollFumbleOverwrite") !== true) {
        const keyword = game.i18n.localize(`${ADR.ID}.requestRoll.fumbleCheckYes`);
        const template = game.i18n.localize(`${ADR.ID}.requestRoll.fumbleCheckTextYes`);
        lastRow?.insertAdjacentHTML("afterend",
          `<div class="adr-fumble-check-result">${template.replace("{result}", `<span class="adr-fumble-confirmed-text">${keyword}</span>`)}</div>`);
      }

    } else if (fumbleCheckResult === false) {
      // Kein Patzer — Ergebnis-Text
      const keyword = game.i18n.localize(`${ADR.ID}.requestRoll.fumbleCheckNone`);
      const template = game.i18n.localize(`${ADR.ID}.requestRoll.fumbleCheckTextNo`);
      lastRow?.insertAdjacentHTML("afterend",
        `<div class="adr-fumble-check-result">${template.replace("{result}", `<span class="adr-fumble-denied-text">${keyword}</span>`)}</div>`);

    } else if (message.getFlag(ADR.ID, "fumbleCheckAccepted") === true) {
      // GM hat die 1 als reguläres Ergebnis akzeptiert — kein Patzer-Check.

    } else if (message.getFlag(ADR.ID, "pendingRerollFumbleDecision") === true) {
      // Reroll-Pending-Fall: die Auswahl wird vom Pending-Hint unten gerendert.

    } else if (message.getFlag(ADR.ID, "bennyUsed") === true) {
      // Nach erfolgtem Benny-Reroll mit bereits getroffener Entscheidung —
      // die Hint-Region kümmert sich um die Anzeige.

    } else {
      // Auswahl-Container: GM klickbar, Nicht-GM sieht ausgegraute Buttons
      // (analog Benny-Button-Pattern via adr-not-mine + title-Tooltip).
      const isGM = game.user.isGM;
      const acceptLabel = game.i18n.localize(`${ADR.ID}.requestRoll.acceptResultBtn`);
      const orLabel = game.i18n.localize(`${ADR.ID}.requestRoll.orChoice`);
      const line1 = game.i18n.localize(`${ADR.ID}.requestRoll.fumbleCheckBtn1`);
      const line2 = game.i18n.localize(`${ADR.ID}.requestRoll.fumbleCheckBtn2`);
      const notMineCls = isGM ? "" : " adr-not-mine";
      // Inline-style mit !important: schlägt jede CSS-Regel, auch Foundry-
      // eigene !important-Defaults für button:hover-Cursor. Reines CSS reicht
      // hier nicht, weil das System-CSS höher spezifisch ist.
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

    // Scroll damit Ergebnis sichtbar ist (alle Clients)
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

  // ── Benny-Button im freien Wurf ──
  _adrInjectFreeRollBennyButton(li, message);
  _adrInjectFreeRollDiscardedHistory(li, message);
  _adrInjectFreeRollHint(li, message);
});

/* ================================================================ */
/*  Free-Roll Benny-Button: Helpers + Klick-Handler (Placeholder)    */
/* ================================================================ */

// Subjekt-Helfer wurden nach adr-benny-helpers.js ausgelagert, damit sie
// sowohl vom Free-Roll-Pfad (hier) als auch vom Probenanforderungs-Pfad
// (adr-request-roll-chat.js, NSC-Reroll → GM-Benny) benutzt werden können.
// Imports oben in der Datei.

/**
 * Patzer-Status für den freien Wurf. Analog zur Visualisierungs-Logik
 * in renderChatMessageHTML (showCritical) und zur Patzer-Sperre im
 * Single-Mode der Request-Roll. Bewusst NICHT über `_classifyFumble`
 * aus adr-request-roll-chat.js — der erwartet ein diceDetails-Schema,
 * das es im freien Wurf nicht gibt.
 *
 * Rückgabe:
 *   "confirmed"   — Patzer steht fest (Wildcard-Patzer ODER Statist mit
 *                   bestätigter Patzer-Prüfung). Reroll gesperrt.
 *   "needs-check" — Statist hat 1 gewürfelt, GM-W6-Check steht aus.
 *                   Reroll ist erlaubt (Patzer-Status noch nicht bestätigt).
 *   "none"        — kein Patzer-Verdacht.
 */
function _adrFreeRollFumbleStatus(message) {
  const f = message.flags?.[ADR.ID] || {};

  // Multi-Pool: Patzer-Mechanik komplett aus (Spec). Reroll bleibt erlaubt,
  // kein Patzer-Check, keine Bestätigungs-W6.
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

  // Münzwurf (dc): kein Patzer
  if (String(f.dieType || "").toLowerCase() === "dc") return "none";

  if (hasWild) {
    // Wildcard-Wurf mit Wild Die: Wenn Wild Die = 1 UND mehr als die
    // Hälfte aller Würfel = 1, sähe das nach einem Patzer aus —
    // ABER nur, wenn es eine Eigenschaftsprobe war. Da wir das nicht
    // wissen (auch Schadenswürfe, freie Mehrfach-Würfe etc. können
    // diese Konstellation ergeben), wird der Benny-Reroll NICHT
    // gesperrt. Der Spieler entscheidet selbst, ob er den Benny einsetzt.
    // Der weiche Hinweis „Falls der Wurf eine Eigenschaftsprobe war …"
    // wird unabhängig davon weiterhin angezeigt (siehe showCritical
    // in der Ergebnis-Rendering-Logik).
    return "none";
  }

  // Statisten-Pfad: nur bei genau einem Hauptwürfel = 1 ist ein
  // Patzer-Check sinnvoll. Wildcards ohne Wild Die können nie patzen
  // (sie hätten bei einer Eigenschaftsprobe einen Wild Die mitgewürfelt).
  // Zusätzlich: SWADE-Eigenschaftsproben sind immer explodierend — ohne
  // Explosion kein Patzer-Verdacht.
  if (f.isWildcard) return "none";
  if (!f.mainExploding) return "none";
  if (totalMain === 1 && mainIndRes[0]?.value == 1) return "needs-check";
  return "none";
}

/**
 * Benny-Button in die freie-Wurf-Karte injizieren. Wird im
 * renderChatMessageHTML aufgerufen, nachdem die Würfel-Anzeige + Patzer-
 * Bereich gerendert wurden.
 *
 * Layout: Toggle „Einzelergebnisse" links, Benny-Button mittig im
 * Restraum rechts. Realisiert über CSS-Grid in `.adr-toggle-row` (siehe
 * argas-dice-roller.css).
 *
 * Sichtbarkeit + Status:
 *   – Kein Akteur (GM-als-GM ohne Token) → Button ausgelassen.
 *   – Bestätigter Patzer → roter Ring + ✕, Klick gesperrt
 *     (SWADE-Regel: Patzer nicht reroll-bar).
 *   – Nicht-Owner-und-nicht-GM → ausgegraut.
 *   – Reroll bereits gemacht → grüner Ring (`bennyUsed`-Flag).
 *   – Sonst: aktiv.
 */
function _adrInjectFreeRollBennyButton(li, message) {
  // Bennies sind eine reine SWADE-Mechanik — in anderen Systemen darf
  // der Reroll-Button im freien Wurf gar nicht erst erscheinen.
  if (game.system.id !== "swade") return;

  const f = message.flags?.[ADR.ID] || {};
  if (!f.mainFormula) return;     // Kein freier Wurf
  if (f.fate) return;             // Schicksalswurf: kein Reroll
  if (f.requestRoll) return;      // Request-Roll: eigener Button-Pfad

  const toggleContainer = li.querySelector(".adr-individual-toggle-container");
  if (!toggleContainer) return;
  const toggle = toggleContainer.querySelector(".adr-individual-toggle");
  if (!toggle) return;

  // Idempotenz: alten Button-Wrapper aus Vorversion abräumen (kann als
  // Sibling neben dem Toggle-Container existieren, falls die Karte schon
  // mal mit dem alten Wrapper-Konzept gerendert wurde), und alten Benny-
  // Button im Container selbst.
  toggleContainer.querySelector(":scope > .adr-benny-btn")?.remove();
  toggleContainer.classList.remove("adr-has-benny");
  li.querySelector(":scope .adr-benny-btn-wrapper")?.remove();

  const subject = freeRollSubject(message);
  if (!subject) return;

  const fumbleStatus = _adrFreeRollFumbleStatus(message);
  const bennyUsed = !!f.bennyUsed;
  const canClick = subjectCanClick(subject);

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

  // Benny-Button als drittes Kind in den Toggle-Container — ans ENDE,
  // also NACH den Details. Grund: der Toggle-Klick-Handler ermittelt
  // den Details-Container über `this.nextElementSibling`. Würde der Button
  // direkt nach dem Toggle eingehängt, wäre nextElementSibling der Button
  // statt der Details und der Klick würde nicht mehr aufklappen.
  // Visuell platziert das Grid (CSS: `.adr-has-benny`) den Button
  // trotzdem in Spalte 3, Zeile 1 (rechts neben dem Toggle) — die DOM-
  // Reihenfolge ist davon unabhängig.
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

/**
 * Würfelt einen freien Wurf neu — gleiche Parameter wie der Ursprungs-
 * wurf (aus den Phase-0-Flags dieType/dieCount/appliedModifier +
 * mainExploding und implizitem hasWildDie aus wildResult).
 * Identische Logik wie in adr-dice-form.js `_rollDie`, nur ohne die
 * UI-Bindung des Würfelfensters.
 */
async function _adrFreshFreeRoll(message) {
  const f = message.flags?.[ADR.ID] || {};

  // Multi-Pool-Pfad: rekonstruiert den Pool aus den Flags und wirft alle
  // Kategorien gemeinsam neu. Tweaks und Patzer-Mechanik bleiben aus
  // (passend zum Initial-Wurf, Spec).
  if (Array.isArray(f.multiPool) && f.multiPool.length > 0) {
    return _adrFreshMultiPoolRoll(f);
  }

  const count = Number(f.dieCount) || 1;
  const type = String(f.dieType || "w6");
  const faces = (type === "dc") ? 2 : (Number(String(type).replace(/^[dDwW]/, "")) || 6);
  const isExploding = !!f.mainExploding && type !== "dc";
  const hasWildDie = (f.wildResult != null);
  const sumMod = Number(f.appliedModifier) || 0;

  // Haupt-Würfel
  const mainTerm = new foundry.dice.terms.Die({
    number: count, faces,
    modifiers: isExploding ? [adrExplodingModifier()] : [],
  });
  const mainTerms = [mainTerm];
  if (sumMod !== 0) {
    mainTerms.push(new foundry.dice.terms.OperatorTerm({ operator: sumMod > 0 ? "+" : "-" }));
    mainTerms.push(new foundry.dice.terms.NumericTerm({ number: Math.abs(sumMod) }));
  }
  const mainRoll = await Roll.fromTerms(mainTerms).evaluate();

  // Münzwurf (dc): Werte 1/2 zu 0/1 normalisieren (analog Ursprungswurf)
  if (type === "dc" && mainRoll?.dice?.length) {
    for (const r of mainRoll.dice[0].results) {
      r.result = (r.result === 2) ? 1 : 0;
    }
    mainRoll._total = mainRoll.dice[0].results.reduce((a, r) => a + r.result, 0);
  }

  // Wild Die (falls Ursprungswurf einen hatte) — immer 1W6 explodierend
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
      modifiers: (isExploding && p.faces !== 100) ? [adrExplodingModifier()] : [],
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
 * Extrahiert Anzeigedaten (Einzelergebnisse + Highlights) aus den
 * frisch-gerollten Roll-Objekten. Gleiche Auswertungslogik wie der
 * Einzelwurf in adr-dice-form.js (`_rollDie`).
 *
 * Bei Multi-Pool (`pool` gesetzt) werden alle Würfel-Terme abgegangen
 * (statt nur dice[0]) und zusätzlich kategorisierte `multiPoolResults`
 * zurückgegeben. Highlights bleiben false (Patzer-Mechanik aus, Spec).
 */
function _adrExtractFreeRollData(mainRoll, wildRoll, fumbleEnabled, pool = null) {
  function extractIndividual(roll) {
    if (!roll?.dice?.length) return [];
    // Über ALLE Würfel-Terme (bei Multi-Pool > 1, sonst genau 1). Die
    // Eltern-Kind-Zuordnung der Explosionen erledigt adrBuildDieResults.
    return roll.dice.flatMap(dieEntry => adrBuildDieResults(dieEntry));
  }
  const mainIndividualResults = extractIndividual(mainRoll);
  const wildIndividualResults = extractIndividual(wildRoll);

  // Kategorisierte Ergebnisse pro Pool-Kategorie (nur bei Multi-Pool gesetzt)
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
  // Bei Multi-Pool: keine Highlight-Setzung (Patzer-Mechanik per Spec aus).
  if (fumbleEnabled && !Array.isArray(pool)) {
    if (mainRoll?.dice?.length) {
      const vals = mainRoll.dice[0].results.map(r => r.result);
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

/**
 * Formatiert eine Reroll-Nummer als Ordinalzahl für die aktuelle Sprache.
 * Deutsch: "2", "3", "4" (Template enthält den Punkt selbst).
 * Englisch: "2nd", "3rd", "4th", ...
 */
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
 * Tauscht den aktuell geltenden Wurf (mainResult & Co.) mit dem letzten
 * Eintrag aus previousRolls. Mutiert das übergebene flags-Objekt.
 *
 * Wird im Pending-Patzer-Pfad benutzt: nach einer Pending-Entscheidung
 * „Patzer prüfen" mit W6=1 wird der bisher als verworfen gespeicherte
 * Reroll-1 zum geltenden mainResult, der bisher sichtbare alte (gute)
 * Wurf wandert in die History (mit Patzer-Vorrang).
 *
 * Bei „Besseres Ergebnis behalten" oder W6>1 gibt es keinen Swap mehr —
 * der alte Wurf war im invertierten Pending-Datenmodell ohnehin schon
 * mainResult. Die jeweiligen Handler markieren dort nur den letzten
 * previousRolls-Eintrag.
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
    // Seq des bisher aktuellen (alten, guten) Wurfs.
    seq: flags.rollSeq ?? null,
  };
  // FumbleCheck-Felder des bisher aktuellen Wurfs (falls vorhanden) mit
  // in die History übernehmen.
  if (flags.fumbleCheckResult !== undefined) newDiscarded.fumbleCheckResult = flags.fumbleCheckResult;
  if (flags.fumbleCheckDie !== undefined) newDiscarded.fumbleCheckDie = flags.fumbleCheckDie;
  flags.previousRolls.push(newDiscarded);

  flags.mainResult = oldData.mainResult;
  flags.mainIndividualResults = oldData.mainIndividualResults;
  flags.mainHighlight = oldData.mainHighlight;
  flags.wildResult = oldData.wildResult;
  flags.wildIndividualResults = oldData.wildIndividualResults;
  flags.wildHighlight = oldData.wildHighlight;
  // Seq des Reroll-1-Wurfs übernehmen (wird zum geltenden Wurf).
  if (oldData.seq != null) flags.rollSeq = oldData.seq;
  // Falls der alte Wurf einen Patzer-Check trug, mit zurückholen
  if (oldData.fumbleCheckResult !== undefined) flags.fumbleCheckResult = oldData.fumbleCheckResult;
  if (oldData.fumbleCheckDie !== undefined) flags.fumbleCheckDie = oldData.fumbleCheckDie;
}

/**
 * Schreibt das ADR-Flag-Objekt einer ChatMessage neu und entfernt dabei
 * die in `removals` genannten Schlüssel zuverlässig aus der DB.
 *
 * Foundry merget Flag-Sub-Objekte beim `update()` rekursiv — ein bloßes
 * Überschreiben von `flags[ADR.ID]` ließe entfernte Schlüssel also stehen.
 * Statt der `-=`-Lösch-Syntax (seit Foundry v14 deprecatet, Wegfall mit
 * v16) wird dafür die stabile `unsetFlag`-API genutzt: sie kapselt die
 * versionsabhängige Lösch-Mechanik und funktioniert unter v13 wie v14.
 *
 * @param {ChatMessage} message   Ziel-Nachricht.
 * @param {object}      newFlags  Neuer Inhalt von flags[ADR.ID].
 * @param {string[]}    removals  Schlüssel, die aus der DB entfernt werden.
 */
async function _adrWriteFlags(message, newFlags, removals = []) {
  await message.update({ [`flags.${ADR.ID}`]: newFlags });
  for (const key of removals) await message.unsetFlag(ADR.ID, key);
}

/**
 * Wendet einen Benny-Reroll auf die Message-Flags an. Mutiert das
 * übergebene Flag-Objekt analog zu `_applyBennyRerollSingle` aus
 * adr-request-roll-chat.js, aber auf Message-Flag-Ebene statt entry.
 *
 * Vergleichsbasis: max(mainResult, wildResult) — der „effektive" Wert
 * wie in SWADE. Bei Würfen ohne Wild Die: nur mainResult.
 *
 * Drei Ergebnis-Pfade:
 *   1. Reroll besser → Overwrite, lastRerollProtected=false
 *   2. NSC-Reroll mit einer 1 (Patzer-Verdacht) → Overwrite mit
 *      lastRerollFumbleOverwrite=true. SWADE-Regel: Patzer ist final,
 *      auch wenn er numerisch schlechter als der alte Wurf ist.
 *      Schutz greift bei Patzer-Verdacht nicht.
 *   3. Sonst → Schutz, alter Wurf bleibt, lastRerollProtected=true.
 *
 * Sonderfall Münzwurf (dieType === "dc"): kein Wertvergleich (Werte 0/1
 * sind symbolisch). Neuer Wurf gilt immer, alter Wurf in History.
 *
 * Returnt ein Array mit Flag-Schlüsseln (relativ zum ADR-Namespace), die
 * aus der DB entfernt werden müssen, weil Foundry beim message.update()
 * Flag-Sub-Objekte rekursiv merget — ein bloßes `delete flags.foo` im
 * Plain-Object würde nicht greifen, der alte Wert würde aus der DB
 * zurückgemergt. Das Entfernen übernimmt `_adrWriteFlags`.
 */
function _adrApplyBennyRerollFree(flags, newData, isWildcardSpeaker) {
  const removals = [];

  if (!Array.isArray(flags.previousRolls)) flags.previousRolls = [];

  // ── Sequenznummer-Tracking ──
  // currentSeq = Position des aktuell geltenden Wurfs in der chronologischen
  // Reihenfolge. Fallback 1 für Legacy-Nachrichten ohne rollSeq-Flag.
  // newSeq = Position des neuen Benny-Wurfs (immer höher als alle bisherigen).
  const currentSeq = flags.rollSeq ?? 1;
  const newSeq = flags.nextRollSeq ?? (flags.previousRolls.length + 2);
  flags.nextRollSeq = newSeq + 1;

  // Münzwurf: kein Wertvergleich → neuer Wurf gilt immer
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

  // ── Multi-Pool-Pfad ──
  // Spec: keine Patzer-Mechanik, kein Pending. Reine Wertvergleichs-Logik
  // mit max(main, wild). Verbesserung → alter Wurf in History, neuer
  // wird geltend; sonst Schutz greift. multiPoolResults wandert pro
  // Eintrag in die History, damit die kategorisierte Detail-Anzeige
  // auch für verworfene Würfe greift.
  if (Array.isArray(flags.multiPool) && flags.multiPool.length > 0) {
    const oldMain = Number(flags.mainResult) || 0;
    const oldWild = (flags.wildResult != null) ? Number(flags.wildResult) : null;
    const newMain = Number(newData.mainResult) || 0;
    const newWild = (newData.wildResult != null) ? Number(newData.wildResult) : null;
    const oldEffective = (oldWild != null) ? Math.max(oldMain, oldWild) : oldMain;
    const newEffective = (newWild != null) ? Math.max(newMain, newWild) : newMain;
    const overwriteByBetter = newEffective > oldEffective;

    if (overwriteByBetter) {
      // Alt → History, neu → aktuell
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
      // Schutz greift: alter Wurf bleibt, neuer wird verworfen → History
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

  // ── Patzer-Override-Pfad (SWADE-Regel) ──
  // Wildcard-Patzer-Konstellation im Reroll (Wild=1 + Mehrheit Einsen,
  // mainExploding) übersteuert den Verschlechterungsschutz: alter (guter) Wurf
  // wandert in previousRolls, der neue Patzer-Wurf wird geltend mit
  // lastRerollFumbleOverwrite=true. Eindeutig ohne W6-Check.
  // NSC-1 fällt NICHT hier rein (Klassifikation "needs-check") — das läuft
  // weiterhin über den Pending-Pfad mit GM-Entscheidung.
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

  // NSC-Patzer-Vorrang: Statisten-Reroll mit Wert 1 (potenzieller Patzer)
  // überschreibt den alten Wurf, auch wenn numerisch schlechter. Der GM
  // kann anschließend per W6-Check verifizieren.
  // SWADE-Eigenschaftsproben sind immer explodierend — ohne Explosion kein
  // Patzer-Verdacht, also auch kein Pending-Pfad.
  const newIsPotentialFumble = !!flags.mainExploding
    && !isWildcardSpeaker
    && newWild == null
    && Array.isArray(newData.mainIndividualResults)
    && newData.mainIndividualResults.length === 1
    && newData.mainIndividualResults[0]?.value == 1;

  const overwriteByBetter = newEffective > oldEffective;
  // SWADE-Regel: Statisten-Reroll mit Wert 1 ist potenzieller Patzer.
  // Statt automatisch den alten Wurf zu überschreiben, geht die Karte
  // in den Pending-Zustand: der neue Wurf ist sichtbar, aber die finale
  // Entscheidung (Annehmen → Benny-Schutz | Patzer prüfen → W6) trifft
  // der GM per Knopfdruck. Erst nach dem Klick wird der Stand fixiert.
  const goesPending = newIsPotentialFumble && !overwriteByBetter;

  if (overwriteByBetter) {
    // Alter Wurf in History (mit seiner ursprünglichen Seq)
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

    // Neuer Wurf als geltend (mit neuer Seq)
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
    // Pending-State (invertiertes Datenmodell): alter (guter) Wurf BLEIBT
    // geltend, der Reroll-1 wandert direkt in previousRolls. Der Hint
    // erklärt die Situation, zwei Buttons bieten dem GM die Entscheidung:
    //   • „Besseres Ergebnis behalten" → Schutz finalisieren (kein Swap),
    //     verworfener Reroll-1 wird mit fumbleCheckSkipped markiert.
    //   • „Patzer prüfen" → W6 würfeln. W6=1 → _adrPendingDecisionSwap
    //     macht den Reroll-1 nachträglich zum geltenden Wurf (Override);
    //     W6>1 → kein Swap, alter Wurf bleibt geltend, Reroll-1 in
    //     previousRolls bekommt fumbleCheckResult=false + fumbleCheckDie.
    // mainResult/rollSeq und fumbleCheckResult/Die des alten Wurfs werden
    // nicht angefasst — sie bleiben für die finale Entscheidung erhalten.
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
    // current bleibt, rollSeq bleibt unverändert
    flags.lastRerollProtected = true;
    delete flags.lastRerollFumbleOverwrite;
    removals.push("lastRerollFumbleOverwrite");
  }
  flags.bennyUsed = true;
  return removals;
}

/**
 * Klassifiziert einen einzelnen History-Eintrag aus `previousRolls`
 * nach SWADE-Patzer-Kategorien — analog `_classifyFumble` aus
 * adr-request-roll-chat.js, aber für das Free-Roll-Flag-Schema.
 *
 *   "confirmed"   — eindeutiger Patzer (Wildcard-Patzer oder geprüfter Statisten-1)
 *   "needs-check" — Statisten-1 ohne Prüfung
 *   "none"        — kein Patzer-Verdacht
 *
 * `mainExploding` ist eine Top-Level-Eigenschaft der Message (gilt für
 * alle Würfe der Serie, weil Rerolls mit identischer Konfiguration
 * laufen). Ohne Explosion kann es nach SWADE-Regeln keine
 * Eigenschaftsprobe gewesen sein → kein Patzer-Verdacht.
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
 * Voll-Rebuild des `.adr-individual-details`-Bereichs in chronologischer
 * Würfel-Reihenfolge. Alle Würfe (verworfene + aktuell geltender) werden
 * nach ihrer Sequenznummer (`seq` / `rollSeq`) sortiert und in dieser
 * Reihenfolge ausgegeben — von oben (frühester Wurf) nach unten
 * (jüngster Wurf). Der aktuell geltende Wurf bekommt KEINE
 * `adr-individual-discarded`-Klasse und steht damit ohne Durchstreichung
 * an seiner echten chronologischen Position (meist unten, aber bei
 * „Initialwurf war Top, Bennies schlechter"-Szenarien auch oben).
 *
 * Inline-Prüfwürfel: ist ein Wurf ein einzelner Würfel mit Wert 1 und
 * existiert ein W6-Prüfergebnis (`fumbleCheckDie`), wird dieser
 * Prüfwürfel als kompakter Span direkt rechts neben die 1 gehängt.
 *
 * Legacy-Fallback: fehlt das `seq`-Feld an einem Eintrag (z.B. bei alten
 * Chat-Nachrichten, die vor der Einführung erstellt wurden), wird der
 * Array-Index als Seq verwendet — das reproduziert das alte Verhalten
 * (Verwerfungs-Reihenfolge) für solche Nachrichten ohne Crash.
 */
function _adrInjectFreeRollDiscardedHistory(li, message) {
  const f = message.flags?.[ADR.ID] || {};
  const prev = Array.isArray(f.previousRolls) ? f.previousRolls : [];
  const details = li.querySelector(".adr-individual-details");
  if (!details) return;

  // Nichts zu rendern? Kein aktueller Wurf vorhanden → Details unverändert lassen.
  if (f.mainResult == null && prev.length === 0) return;

  // Einträge sammeln (Discarded + aktueller Wurf).
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

  // Chronologisch sortieren (kleinste seq oben).
  entries.sort((a, b) => a.seq - b.seq);

  // Details komplett neu aufbauen.
  details.innerHTML = "";

  const dieLabel = game.i18n.localize(`${ADR.ID}.requestRoll.fumbleCheckDieLabel`);
  // Modifikator ist im freien Wurf konstant über Reroll-Kette (gleiche Parameter
  // wie Ursprungswurf, siehe _adrFreshFreeRoll). Alle Einträge benutzen denselben
  // Wert. null/undefined → kein Mod-Span vom Helper.
  const appliedMod = (f.appliedModifier != null) ? Number(f.appliedModifier) : null;

  // ── Multi-Pool-Pfad ──
  // Bei Multi-Pool wird pro Eintrag eine kategorisierte Detail-Box gerendert
  // (statt der flachen Single-Die-Liste). Falls multiPoolResults im History-
  // Eintrag fehlen sollte (z. B. sehr alte Nachricht ohne das Feld), fällt
  // die Box auf den flachen Helper-Pfad zurück.
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
        // Fallback: flacher Pfad (alter Eintrag ohne multiPoolResults-Feld)
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

  // ── Single-Die-Pfad (unverändert) ──
  for (const e of entries) {
    const p = e.data;
    const discardCls = e.isCurrent ? "" : " adr-individual-discarded";

    const mainInd = Array.isArray(p.mainIndividualResults) ? p.mainIndividualResults : [];
    if (!mainInd.length && p.wildResult == null) continue;

    // Inline-Prüfwürfel: nur bei genau einem Würfel mit Wert 1 und
    // vorhandenem W6-Prüfwurf (Statisten-Patzer-Check-Kontext).
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
 * Hinweis-Element nach Benny-Reroll. Vier+Eins Varianten:
 *   – `pendingRerollFumbleDecision` → Pending: grün/rot-Auswahl
 *                                     (Annehmen → Schutz | W6-Patzer-Check)
 *   – `lastRerollFumbleOverwrite`   → NSC-Patzer-Vorrang-Hinweis
 *                                     (nur via Pending → roter Pfad bestätigt)
 *   – `lastRerollProtected`         → Schutz-Hinweis (mit Patzer-Sub-Logik
 *                                     analog Single-Mode). Hat der GM
 *                                     im Pending-Pfad ohne Check angenommen,
 *                                     markiert `fumbleCheckSkipped` den
 *                                     Discarded — dann nur Schutz-Text ohne
 *                                     „Allerdings war eine 1…"-Zusatz.
 *   – Münzwurf (dieType==="dc")     → eigene Hinweis-Zeile, keine Vergleichs-
 *                                     bewertung
 *   – sonst (bei `bennyUsed`)       → Verbesserungs-Hinweis
 *
 * Wird zwischen Wurf-Zeile (.adr-dice-row) und Toggle-Container
 * eingefügt, damit der Hinweis prominent oberhalb der Einzelergebnisse
 * sitzt.
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

  // Reroll-Zähler: prev.length === 1 → erster Reroll (alte Keys ohne {n}),
  // ab 2 → Keys mit {n}-Platzhalter.
  const rerollNum = prev.length;
  const useCounter = rerollNum >= 2;
  const ordinal = useCounter ? _adrFormatOrdinal(rerollNum) : null;
  const pickKey = (base) => useCounter ? `${base}N` : base;
  const localizeHint = (base) => {
    const tmpl = game.i18n.localize(`${ADR.ID}.requestRoll.${pickKey(base)}`);
    return useCounter ? tmpl.replace("{n}", ordinal) : tmpl;
  };

  if (f.pendingRerollFumbleDecision) {
    // Reroll ergab eine Statisten-1 → alter Wurf bleibt geltend, GM entscheidet.
    // Erklärungstext + Auswahl-Buttons unten.
    hintHTML = `<div class="adr-benny-protected-line">`
      + localizeHint("pendingFumblePotentialHint") + `</div>`;
    renderPendingChoice = true;
  } else if (f.lastRerollFumbleOverwrite) {
    // Patzer-Vorrang. Drei Sub-Fälle:
    //   a) NSC-1, W6-bestätigt → fumbleCheckResult=true → kombinierter Text
    //      „Reroll war 1 + Patzer bestätigt".
    //   b) Wildcard-Patzer im Reroll → eindeutig ohne W6 → Critical-Text
    //      „Reroll war kritischer Fehlschlag".
    //   c) Fallback (NSC-1 ohne fumbleCheckResult, sollte normalerweise nicht
    //      erreichbar sein): bisheriger 1er-Text.
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
    // Schutz-Pfad — letzten Discarded klassifizieren
    lastDiscarded = prev[prev.length - 1];
    const cls = _adrClassifyHistoryFumble(lastDiscarded, isWildcardSpeaker, !!f.mainExploding);
    const checkSkipped = !!lastDiscarded?.fumbleCheckSkipped;

    if (cls === "confirmed") {
      // Differenzierung: Statist mit W6-bestätigtem Patzer (fumbleCheckResult
      // === true) ist eindeutig — der bestehende harte Text + komplett rote
      // Zeile bleiben.
      // Wildcard-Patzer (Wild Die = 1, überwiegend 1en) ist dagegen nur eine
      // POTENZIELLE Patzer-Konstellation, weil unbekannt ist, ob's eine
      // Eigenschaftsprobe war. Hier den weicheren „Falls der Wurf …"-Text
      // verwenden und MARKUP analog zum Initial-Wurf-Hinweis:
      // grauer Prefix in .adr-fumble-check-result, eingebetteter
      // .adr-fumble-confirmed-text-Span in rot/fett/kursiv für den
      // „Kritischer Fehlschlag"-Label. Zeilenumbruch zwischen Prefix und
      // Label per <br>.
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
      // „Allerdings war eine 1"-Zusatz + Check-Button entfallen, wenn
      // der GM den Patzer-Check beim Pending bewusst übersprungen hat.
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
    // Münzwurf — kein Wertvergleich, neuer Wurf gilt immer
    hintHTML = `<div class="adr-benny-protected-line">`
      + localizeHint("bennyCoinHint") + `</div>`;
  } else {
    // Verbesserung
    hintHTML = `<div class="adr-benny-protected-line">`
      + localizeHint("bennyImprovedHint") + `</div>`;
  }

  hintEl.innerHTML = hintHTML;

  // Pending-Auswahl: grüner „Besseres behalten"-Button + „oder" + roter Patzer-Button
  if (renderPendingChoice) {
    const acceptLabel = game.i18n.localize(`${ADR.ID}.requestRoll.keepBetterResultBtn`);
    const orLabel = game.i18n.localize(`${ADR.ID}.requestRoll.orChoice`);
    const line1 = game.i18n.localize(`${ADR.ID}.requestRoll.fumbleCheckBtn1`);
    const line2 = game.i18n.localize(`${ADR.ID}.requestRoll.fumbleCheckBtn2`);
    const isGM = game.user.isGM;
    const notMineCls = isGM ? "" : " adr-not-mine";
    // Inline-style mit !important nötig (siehe Initial-1-Stelle oben).
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

  // Patzer-Check-Button für Discarded-Statisten-1 (Schutz-Pfad ohne Skip)
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

  // Platzieren: nach der letzten Wurfzeile und (ggf.) der Critical-Hinweis-Zeile
  const rows = li.querySelectorAll(".adr-dice-row");
  const lastRow = rows[rows.length - 1];
  let anchor = lastRow;
  const fcResult = li.querySelector(".adr-fumble-check-result");
  if (fcResult) anchor = fcResult;
  if (anchor) anchor.insertAdjacentElement("afterend", hintEl);

  // Auto-Scroll im Pending-Pfad: Hint-Text + zwei Buttons vergrößern die
  // Nachricht spürbar, Foundry scrollt nach `message.update()` nicht
  // automatisch nach. Analog zur Initial-Wurf-Patzer-Check-Stelle weiter
  // oben in renderChatMessageHTML. setTimeout, damit
  // Layout nach Insert berechnet ist.
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
  Handlebars.registerHelper("isD100", v => v === "d100");
  Handlebars.registerHelper("isD2",   v => v === "d2");
  Handlebars.registerHelper("eq", (a, b) => a === b);
  Handlebars.registerHelper("gt", (a, b) => a > b);
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
 * SwadeSettingsForm — Submenu-Fenster für die drei SWADE-spezifischen
 * Spielmechanik-Einstellungen (Wild Die, Patzer-Mechanik, Probenanforderung).
 *
 * Bewusst OHNE HandlebarsApplicationMixin und OHNE ADR-Theme: ein
 * Einstellungs-Untermenü wird aus den Foundry-Spieleinstellungen heraus
 * geöffnet und soll deshalb wie Foundrys eigene Einstellungen aussehen.
 * Der Inhalt wird in `_renderHTML` mit den Standard-Helfern aus
 * `foundry.applications.fields` (createFormGroup/createCheckboxInput)
 * aufgebaut — dadurch native Optik und kein eigenes CSS nötig. Reines
 * ApplicationV2 ist renderbar, sobald `_renderHTML` UND `_replaceHTML`
 * selbst definiert sind.
 *
 * Wird über `game.settings.registerMenu(...)` eingehängt; Foundry instanziiert
 * die Klasse beim Klick auf den Menü-Button selbst mit `new SwadeSettingsForm()`
 * — ohne Argumente, deshalb kein eigener Konstruktor.
 *
 * Die drei verwalteten Settings sind mit `config: false` registriert; dieses
 * Fenster ist die einzige UI dafür. Beim Speichern wird je Key
 * `game.settings.set(...)` aufgerufen — die bestehenden onChange-Handler
 * (enableWildDie, enableRequestRoll) feuern dann automatisch.
 */
class SwadeSettingsForm extends ApplicationV2 {

  /** Die drei verwalteten SWADE-Setting-Keys, in Anzeigereihenfolge. */
  static SETTING_KEYS = [
    ADR.CONFIG_WILD_DIE,
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

  /* -------------------------------------------------------------- */
  /*  Rendering — Standard-Foundry-form-groups (kein eigenes CSS)     */
  /* -------------------------------------------------------------- */

  /**
   * Baut den Fensterinhalt mit Foundrys Standard-Formularhelfern auf:
   * je Setting eine `form-group` (Checkbox + Name + Hint), darunter ein
   * Speichern-Button im Standard-Footer. Rückgabewert geht an `_replaceHTML`.
   */
  async _renderHTML(_context, _options) {
    const { createCheckboxInput, createFormGroup } = foundry.applications.fields;

    const root = document.createElement("div");
    root.className = "adr-swade-settings standard-form";

    // Je Setting eine Standard-form-group (Checkbox + Name + Hint)
    for (const key of SwadeSettingsForm.SETTING_KEYS) {
      const input = createCheckboxInput({
        name: key,
        value: !!game.settings.get(ADR.ID, key),
      });
      const group = createFormGroup({
        input,
        label: game.i18n.localize(`${ADR.ID}.settings.${key}.name`),
        hint: game.i18n.localize(`${ADR.ID}.settings.${key}.hint`),
      });
      root.append(group);
    }

    // Speichern-Button im Standard-Footer (speichert + schließt;
    // das native Schließen-X verwirft)
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

  /** Fügt das von `_renderHTML` gebaute Element in den Fensterinhalt ein. */
  _replaceHTML(result, content, _options) {
    content.replaceChildren(result);
  }

  /* -------------------------------------------------------------- */
  /*  Event-Handler (Event-Delegation auf this.element)              */
  /* -------------------------------------------------------------- */

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    const root = this.element;
    if (!root) return;

    // Klick-Delegation für den Speichern-Button
    root.addEventListener("click", (ev) => {
      if (ev.target.closest("[data-action='adr-swade-settings-save']")) {
        this._onSave();
      }
    });
  }

  /* -------------------------------------------------------------- */
  /*  Speichern                                                       */
  /* -------------------------------------------------------------- */

  /**
   * Liest die drei Checkboxen aus und schreibt nur tatsächlich geänderte
   * Werte per `game.settings.set(...)` zurück (damit onChange-Handler nicht
   * unnötig feuern). Schließt das Fenster danach.
   */
  async _onSave() {
    const root = this.element;
    if (!root) return;

    for (const key of SwadeSettingsForm.SETTING_KEYS) {
      const checkbox = root.querySelector(`input[type="checkbox"][name="${key}"]`);
      if (!checkbox) continue;
      const newValue = checkbox.checked;
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
  // Drei Settings sind ausschließlich SWADE-Funktionen (Wild Die,
  // Patzer-Mechanik, Probenanforderung). Sie sind `config: false` — also
  // nie direkt im Hauptpanel der Spieleinstellungen — und werden auf dem
  // SWADE-System über das Submenu `swadeSettings` (SwadeSettingsForm,
  // siehe oben) zugänglich gemacht. Auf Fremdsystemen weder Menü noch
  // Settings sichtbar, Default deaktiviert.
  const isSwade = game.system.id === "swade";

  // Chat-Design (Dropdown): Stil der Würfelergebnis-Darstellung im Chat.
  // "fantasy" → klassische ADR-Optik, "modern" → SciFi-Optik (.scifi-
  // Klasse), "standard" → generische Foundry-Würfelkarte ohne ADR-Grafik.
  game.settings.register(ADR.ID, "chatDesign", {
    name: game.i18n.localize("argas-dice-roller.settings.chatDesign.name"),
    hint: game.i18n.localize("argas-dice-roller.settings.chatDesign.hint"),
    scope: "world",
    config: true,
    default: "fantasy",
    type: String,
    choices: {
      fantasy: game.i18n.localize("argas-dice-roller.settings.chatDesign.choices.fantasy"),
      modern: game.i18n.localize("argas-dice-roller.settings.chatDesign.choices.modern"),
      standard: game.i18n.localize("argas-dice-roller.settings.chatDesign.choices.standard")
    }
  });

  game.settings.register(ADR.ID, ADR.CONFIG_CLOSE_FORM, {
    name: game.i18n.localize("argas-dice-roller.settings.closeFormOnRoll.name"),
    hint: game.i18n.localize("argas-dice-roller.settings.closeFormOnRoll.hint"),
    scope: "client",
    config: true,
    default: false,
    type: Boolean,
    onChange: v => _updateDiceForm(ADR.CONFIG_CLOSE_FORM, v)
  });

  game.settings.register(ADR.ID, ADR.CONFIG_HIDDEN_ROLLS, {
    name: game.i18n.localize("argas-dice-roller.settings.enableHiddenRolls.name"),
    hint: game.i18n.localize("argas-dice-roller.settings.enableHiddenRolls.hint"),
    scope: "world",
    config: true,
    default: true,
    type: Boolean,
    onChange: v => _updateDiceForm(ADR.CONFIG_HIDDEN_ROLLS, v)
  });

  // Dropdown-Steuerung des Exploding-Buttons: bestimmt Sichtbarkeit
  // ("off" = ausgeblendet) und Explosionsart ("multi" = rekursiv,
  // "once" = einmalig). Alleinige Quelle der Wahrheit für die
  // Explosionsmechanik.
  game.settings.register(ADR.ID, ADR.CONFIG_EXPLODING_MODE, {
    name: game.i18n.localize("argas-dice-roller.settings.explodingMode.name"),
    hint: game.i18n.localize("argas-dice-roller.settings.explodingMode.hint"),
    scope: "world",
    config: true,
    default: "multi",
    type: String,
    choices: {
      multi: game.i18n.localize("argas-dice-roller.settings.explodingMode.choices.multi"),
      once:  game.i18n.localize("argas-dice-roller.settings.explodingMode.choices.once"),
      off:   game.i18n.localize("argas-dice-roller.settings.explodingMode.choices.off")
    },
    onChange: v => _updateDiceForm(ADR.CONFIG_EXPLODING_MODE, v)
  });

  game.settings.register(ADR.ID, ADR.CONFIG_EXPLODING_DEFAULT, {
    name: game.i18n.localize("argas-dice-roller.settings.explodingDefault.name"),
    hint: game.i18n.localize("argas-dice-roller.settings.explodingDefault.hint"),
    scope: "client",
    config: true,
    default: false,
    type: Boolean,
    onChange: v => _updateDiceForm(ADR.CONFIG_EXPLODING_DEFAULT, v)
  });

  game.settings.register(ADR.ID, ADR.CONFIG_MODIFIERS, {
    name: game.i18n.localize("argas-dice-roller.settings.enableModifiers.name"),
    hint: game.i18n.localize("argas-dice-roller.settings.enableModifiers.hint"),
    scope: "world",
    config: true,
    default: true,
    type: Boolean,
    onChange: v => _updateDiceForm(ADR.CONFIG_MODIFIERS, v)
  });

  game.settings.register(ADR.ID, "enableFateRollButton", {
    name: game.i18n.localize("argas-dice-roller.settings.enableFateRollButton.name"),
    hint: game.i18n.localize("argas-dice-roller.settings.enableFateRollButton.hint"),
    scope: "world",
    config: true,
    default: true,
    type: Boolean,
    onChange: () => _updateDiceForm("enableFateRollButton", null)
  });

  game.settings.register(ADR.ID, ADR.CONFIG_MAXDICE_COUNT, {
    name: game.i18n.localize("argas-dice-roller.settings.maxDiceCount.name"),
    hint: game.i18n.localize("argas-dice-roller.settings.maxDiceCount.hint"),
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
    name: game.i18n.localize("argas-dice-roller.settings.enableFirstColumn.name"),
    hint: game.i18n.localize("argas-dice-roller.settings.enableFirstColumn.hint"),
    scope: "client",
    config: true,
    default: true,
    type: Boolean,
    onChange: v => _updateDiceForm(ADR.CONFIG_1ST_COLUMN, v)
  });

  game.settings.register(ADR.ID, ADR.CONFIG_COINS, {
    name: game.i18n.localize("argas-dice-roller.settings.enableCoins.name"),
    hint: game.i18n.localize("argas-dice-roller.settings.enableCoins.hint"),
    scope: "client",
    config: true,
    default: true,
    type: Boolean,
    onChange: v => _updateDiceForm(ADR.CONFIG_COINS, v)
  });

  game.settings.register(ADR.ID, ADR.CONFIG_D2, {
    name: game.i18n.localize("argas-dice-roller.settings.enableD2Rolls.name"),
    hint: game.i18n.localize("argas-dice-roller.settings.enableD2Rolls.hint"),
    scope: "client",
    config: true,
    default: false,
    type: Boolean,
    onChange: v => _updateDiceForm(ADR.CONFIG_D2, v)
  });

  game.settings.register(ADR.ID, ADR.CONFIG_D100, {
    name: game.i18n.localize("argas-dice-roller.settings.enableD100Rolls.name"),
    hint: game.i18n.localize("argas-dice-roller.settings.enableD100Rolls.hint"),
    scope: "client",
    config: true,
    default: true,
    type: Boolean,
    onChange: v => _updateDiceForm(ADR.CONFIG_D100, v)
  });

  game.settings.register(ADR.ID, ADR.CONFIG_WILD_DIE, {
    name: game.i18n.localize("argas-dice-roller.settings.enableWildDie.name"),
    hint: game.i18n.localize("argas-dice-roller.settings.enableWildDie.hint"),
    scope: "world",
    config: false,
    default: isSwade,
    type: Boolean,
    onChange: v => _updateDiceForm(ADR.CONFIG_WILD_DIE, v)
  });

  game.settings.register(ADR.ID, ADR.CONFIG_HIGHLIGHT_ONES, {
    name: game.i18n.localize("argas-dice-roller.settings.highlightNaturalOnes.name"),
    hint: game.i18n.localize("argas-dice-roller.settings.highlightNaturalOnes.hint"),
    scope: "world",
    config: false,
    default: isSwade,
    type: Boolean
  });

  game.settings.register(ADR.ID, ADR.CONFIG_REQUEST_ROLL, {
    name: game.i18n.localize("argas-dice-roller.settings.enableRequestRoll.name"),
    hint: game.i18n.localize("argas-dice-roller.settings.enableRequestRoll.hint"),
    scope: "world",
    config: false,
    default: isSwade,
    type: Boolean,
    onChange: () => _updateDiceForm(ADR.CONFIG_REQUEST_ROLL, null)
  });

  // SWADE-Submenu: bündelt die drei Settings oben hinter einem eigenen
  // Eintrag mit Button in den Spieleinstellungen. Nur auf dem SWADE-System
  // registriert — sonst gäbe es auf Fremdsystemen einen leeren Menüeintrag.
  // `restricted: true` → nur Spielleiter (entspricht „nur SL").
  if (isSwade) {
    game.settings.registerMenu(ADR.ID, "swadeSettings", {
      name: game.i18n.localize(`${ADR.ID}.swadeSettings.menuName`),
      label: game.i18n.localize(`${ADR.ID}.swadeSettings.menuLabel`),
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
    case ADR.CONFIG_1ST_COLUMN: globalDiceForm.enableFirstColumn = value; break;
    case ADR.CONFIG_CLOSE_FORM: globalDiceForm.closeFormOnRoll = value; break;
    case ADR.CONFIG_COINS: globalDiceForm.enableCoins = value; break;
    case ADR.CONFIG_D2: globalDiceForm.enableD2 = value; break;
    case ADR.CONFIG_D100: globalDiceForm.enableD100 = value; break;
  }
  globalDiceForm.render(true);
}

/** ADR: optionaler Reload nach Einstellungsänderung (lokalisiert)
 *
 * Hintergrund Z-Index: Der Reload-Dialog wird typischerweise getriggert,
 * während das ADR-Würfelfenster offen ist (Setting-Change passiert oft
 * direkt aus dem Workflow heraus). ApplicationV2 vergibt Z-Indices auf
 * Basis der Fokus-Reihenfolge — wenn das Würfelfenster zuletzt fokussiert
 * war, kann der neu geöffnete DialogV2 darunter landen und unsichtbar sein.
 *
 * Fix: Dialog-Instanz explizit erzeugen und nach dem Render einen
 * `bringToTop()`-Call ausführen. So liegt der Reload-Dialog garantiert
 * über dem Würfelfenster.
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
  // bringToTop nach Render — defensiv, falls API in Major-Versionen wechselt
  renderPromise.then(() => {
    try { dlg.bringToTop?.(); } catch (e) { /* */ }
  });
  return renderPromise;
}
