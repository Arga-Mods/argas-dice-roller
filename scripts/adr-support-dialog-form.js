/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright (C) 2026 Arga-Mods */

import { ADR } from "./adr-constants.js";
import {
  collectActorTraits,
  resolveActorById,
} from "./adr-request-roll-form.js";
import {
  _executeSWADERoll,
  _extractDiceDetails,
  _classifyFumble,
  _fireTraitRollHook,
  _applyDramaticSupportRoll,
  _swadeSuppressFlag,
} from "./adr-request-roll-chat.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Chip-Grid-Spalten für Zielauswahl (spiegelt _actorGridColumns aus
 * adr-request-roll-form.js — hier dupliziert, damit der Dialog autark bleibt).
 */
function _supportTargetCols(count) {
  if (count <= 1) return 1;
  if (count <= 4) return count;
  if (count <= 6) return 3;
  return 4;
}

/**
 * SupportDialogForm — Popup zum Anfordern eines Unterstützungs-Wurfs in der
 * Dramatischen Aufgabe.
 *
 * Auswahldialog (Ziel + Trait), anschließend die Wurfkette: SWADE-Wurf,
 * Patzer-Check (inkl. W6 für NSC), Hook-Aufruf, State-Update via
 * _applyDramaticSupportRoll. Helfer markersDelta=0; das Ziel bekommt einen
 * Bonus-Eintrag (-2 / 0 / +1 / +2). Cap +4 wird erkannt (capExceeded-Flag),
 * Race Conditions via tooLate-Flag markiert.
 */
export class SupportDialogForm extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: "adr-support-dialog",
    classes: ["argas-dice-roller-window", "adr-request-roll-window", "adr-support-dialog-window"],
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

  static PARTS = {
    form: {
      template: ADR.SUPPORT_DIALOG_FORM_PATH,
    },
  };

  /* -------------------------------------------------------------- */
  /*  Konstruktor                                                    */
  /* -------------------------------------------------------------- */

  /**
   * @param {object} opts
   * @param {string} opts.messageId   ID der Dramatic-Task-Chat-Message
   * @param {string} opts.helperId    Actor-/Token-ID des Unterstützers
   */
  constructor(opts = {}) {
    // Dynamische Positionierung: links neben dem Foundry-Chat-Panel,
    // vertikal mittig im Viewport. Fallback, falls Sidebar nicht
    // ermittelbar ist: rechte Bildschirmkante minus 320 px (Standard-Sidebar).
    const width = 760;
    const estimatedHeight = 480;

    const sidebar = document.querySelector("#sidebar")
                 ?? document.querySelector("aside#sidebar")
                 ?? document.querySelector("#interface aside");
    const sidebarRect = sidebar?.getBoundingClientRect();
    const sidebarLeft = (sidebarRect && sidebarRect.left > 0)
      ? sidebarRect.left
      : (window.innerWidth - 320);

    const left = Math.max(20, Math.round(sidebarLeft - width - 20));
    const top  = Math.max(60, Math.round((window.innerHeight - estimatedHeight) / 2));

    super({ ...opts, position: { width, left, top } });

    this.messageId = opts.messageId ?? null;
    this.helperId = opts.helperId ?? null;

    this.selectedTargetId = null;
    this.selectedTraitType = null;  // "attribute" | "skill"
    this.selectedTraitKey = null;
    this.selectedTraitName = null;
  }

  /* -------------------------------------------------------------- */
  /*  Titel                                                           */
  /* -------------------------------------------------------------- */

  get title() {
    return game.i18n.localize(`${ADR.ID}.requestRoll.dramaticSupport.title`);
  }

  /* -------------------------------------------------------------- */
  /*  Daten-Aufbereitung                                              */
  /* -------------------------------------------------------------- */

  async _prepareContext() {
    const message = game.messages.get(this.messageId);
    const flags = message?.flags?.[ADR.ID];

    // Helfer-Infos
    const helperEntry = flags?.entries?.find(e => e.actorId === this.helperId);
    const helperActor = resolveActorById(this.helperId);
    const helper = {
      actorId: this.helperId,
      actorName: helperEntry?.actorName ?? helperActor?.name ?? "?",
      actorImg: helperEntry?.actorImg ?? helperActor?.img ?? "",
    };

    // Verfügbare Ziele: alle anderen Teilnehmer, die in DIESER Runde noch
    // nicht gehandelt und nicht ausgesetzt haben und für die noch kein
    // Ergebnis vorliegt.
    //
    // checked = Ziel UND Trait gewählt (voller Haken, dunkleres Grün)
    // active  = Ziel gewählt, Trait noch nicht (grüne Vormerkung ohne Haken,
    //           analog zur Probenanforderung).
    const availableTargets = (flags?.entries ?? [])
      .filter(e => e.actorId !== this.helperId)
      .filter(e => {
        const rs = e.roundState;
        if (!rs) return false;
        if (rs.acted) return false;
        if (rs.skipped) return false;
        if (rs.result !== null && rs.result !== undefined) return false;
        return true;
      })
      .map(e => {
        const isSelected = e.actorId === this.selectedTargetId;
        return {
          actorId: e.actorId,
          actorName: e.actorName,
          actorImg: e.actorImg,
          checked: isSelected && !!this.selectedTraitKey,
          active:  isSelected && !this.selectedTraitKey,
        };
      });

    // Traits des Helfers (Attribute + Fertigkeiten)
    const traits = helperActor ? collectActorTraits(helperActor) : {
      attributes: [], skills: [], coreSkills: [], otherSkills: [],
    };

    // Falls das aktuell gewählte Ziel inzwischen weggefallen ist: Auswahl löschen
    if (this.selectedTargetId && !availableTargets.some(t => t.actorId === this.selectedTargetId)) {
      this.selectedTargetId = null;
      this.selectedTraitType = null;
      this.selectedTraitKey = null;
      this.selectedTraitName = null;
    }

    return {
      helper,
      availableTargets,
      targetCols: _supportTargetCols(availableTargets.length),
      traits,
      selectedTargetId: this.selectedTargetId,
      selectedTraitType: this.selectedTraitType,
      selectedTraitKey: this.selectedTraitKey,
      canConfirm: !!(this.selectedTargetId && this.selectedTraitKey),
    };
  }

  /* -------------------------------------------------------------- */
  /*  Event-Handler (Event-Delegation auf this.element)              */
  /* -------------------------------------------------------------- */

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    const root = this.element;
    if (!root) return;

    // ── Titel-Span in den Window-Header einhängen ──
    // ApplicationV2 zeigt den nativen `.window-title` nicht (per CSS auf
    // `visibility: hidden` für alle `argas-dice-roller-window`-Instanzen).
    // Wir injizieren stattdessen ein eigenes `.adrgs-title-extra`-Element,
    // analog zu adr-request-roll-form.js.
    const winHeader = root.querySelector(".window-header");
    if (winHeader && !winHeader.querySelector(".adrgs-title-extra")) {
      const span = document.createElement("span");
      span.className = "adrgs-title-extra";
      span.textContent = game.i18n.localize(`${ADR.ID}.requestRoll.dramaticSupport.title`);
      winHeader.appendChild(span);
    }

    root.addEventListener("click", (ev) => {
      const targetChip = ev.target.closest("[data-action='adr-support-select-target']");
      if (targetChip) {
        const id = targetChip.dataset.actorId;
        // Toggle-Verhalten: nochmaliges Klicken löscht die Auswahl
        if (this.selectedTargetId === id) {
          this.selectedTargetId = null;
          this.selectedTraitType = null;
          this.selectedTraitKey = null;
          this.selectedTraitName = null;
        } else {
          this.selectedTargetId = id;
        }
        this.render({ parts: ["form"] });
        return;
      }

      const traitBtn = ev.target.closest("[data-action='adr-support-select-trait']");
      if (traitBtn) {
        const type = traitBtn.dataset.traitType;
        const key = traitBtn.dataset.traitKey;
        const name = traitBtn.dataset.traitName;
        if (this.selectedTraitKey === key && this.selectedTraitType === type) {
          // Abwählen bei erneutem Klick
          this.selectedTraitType = null;
          this.selectedTraitKey = null;
          this.selectedTraitName = null;
        } else {
          this.selectedTraitType = type;
          this.selectedTraitKey = key;
          this.selectedTraitName = name;
        }
        this.render({ parts: ["form"] });
        return;
      }

      if (ev.target.closest("[data-action='adr-support-cancel']")) {
        this.close();
        return;
      }

      if (ev.target.closest("[data-action='adr-support-confirm']")) {
        this._onConfirm();
        return;
      }
    });
  }

  /* -------------------------------------------------------------- */
  /*  Confirm-Logik                                                   */
  /* -------------------------------------------------------------- */

  async _onConfirm() {
    // ── 1) Race-Check: Ist das Ziel überhaupt noch unterstützbar? ──
    const message = game.messages.get(this.messageId);
    const flags = message?.flags?.[ADR.ID];
    const targetEntry = flags?.entries?.find(e => e.actorId === this.selectedTargetId);
    const targetStillOpen =
      targetEntry &&
      targetEntry.roundState &&
      !targetEntry.roundState.acted &&
      !targetEntry.roundState.skipped &&
      (targetEntry.roundState.result === null || targetEntry.roundState.result === undefined);

    if (!targetStillOpen) {
      ui.notifications.warn(game.i18n.localize(`${ADR.ID}.requestRoll.dramaticSupport.noLongerPossible`));
      this.close();
      return;
    }

    // ── 2) Helfer-Entry holen für Karten-Modifikator und isNPC-Klassifizierung ──
    const helperEntry = flags?.entries?.find(e => e.actorId === this.helperId);
    if (!helperEntry || !helperEntry.roundState) {
      ui.notifications.error(game.i18n.localize(`${ADR.ID}.requestRoll.warn.rollError`));
      this.close();
      return;
    }
    const helperRs = helperEntry.roundState;
    if (helperRs.acted || helperRs.skipped) {
      ui.notifications.warn(game.i18n.localize(`${ADR.ID}.requestRoll.warn.alreadyRolled`));
      this.close();
      return;
    }

    // Helfer-Karten-Modifikator (Joker +2 / Komplikation -2). Globaler
    // flags.modifier (Aufgaben-Mod) wird auf Support-Würfe NICHT angewendet.
    // Die Komplikation des Ziels (Kreuz, -2) überträgt sich kumulativ auf
    // die Unterstützungsprobe. Joker-Bonus des Ziels bleibt personenbezogen
    // und überträgt sich nicht.
    const helperCardMod = Number(helperRs.card?.modifier ?? 0);
    const targetCardMod = targetEntry.roundState?.card?.isComplication
      ? Number(targetEntry.roundState.card?.modifier ?? 0)
      : 0;
    const supportMod = helperCardMod + targetCardMod;

    // ── 3) Helfer-Actor laden, Pseudo-Entry für _executeSWADERoll bauen ──
    const actor = resolveActorById(this.helperId);
    if (!actor) {
      ui.notifications.error(game.i18n.localize(`${ADR.ID}.requestRoll.warn.rollError`));
      this.close();
      return;
    }

    const pseudoEntry = {
      traitType: this.selectedTraitType,
      traitKey: this.selectedTraitKey,
      traitName: this.selectedTraitName,
    };

    // ── 4) SWADE-Wurf ausführen (mit System-Dialog für weitere Modifikatoren) ──
    let roll;
    try {
      _swadeSuppressFlag.active = true;
      roll = await _executeSWADERoll(actor, pseudoEntry, supportMod);
    } catch (err) {
      console.error(`${ADR.ID} | Support roll error:`, err);
      ui.notifications.error(game.i18n.localize(`${ADR.ID}.requestRoll.warn.rollError`));
      _swadeSuppressFlag.active = false;
      // Dialog offen lassen — Spieler kann nochmal versuchen
      return;
    } finally {
      _swadeSuppressFlag.active = false;
    }

    // SWADE-Dialog vom Spieler abgebrochen → Dialog offen lassen
    if (!roll) return;

    // ── 5) Hook: argas-dice-roller:onTraitRoll (Argas Tweaks etc.) ──
    const hookData = {
      roll, actor,
      traitName: this.selectedTraitName,
      traitType: this.selectedTraitType,
      modifier: supportMod,
      requestId: flags.requestId,
      messageId: this.messageId,
      entryIndex: flags.entries.findIndex(e => e.actorId === this.helperId),
      isSupportRoll: true,
      supportTargetId: this.selectedTargetId,
      rollKind: "trait",
    };
    const finalRoll = await _fireTraitRollHook(hookData);
    if (finalRoll === false) {
      // Hook hat den Wurf abgebrochen — Dialog offen lassen
      return;
    }
    const usedRoll = finalRoll || roll;

    // ── 6) Wurfdaten extrahieren ──
    const resultTotal = usedRoll.total ?? roll.total ?? 0;
    const diceDetails = _extractDiceDetails(usedRoll) || _extractDiceDetails(roll);

    // ── 7) Patzer-Klassifizierung (nur natürliche 1en, Modifier irrelevant) ──
    const isNPC = !!helperEntry.isNPC;
    const classification = _classifyFumble(diceDetails, isNPC);

    let critFail = false;
    let pendingFumbleCheck = false;
    let fumbleCheckDie = null;

    if (classification === "confirmed") {
      // Wildcard-SC mit Wild-Die-Patzer-Regel: bestätigt
      critFail = true;
    } else if (classification === "needs-check") {
      // NSC mit einzelner natürlicher 1 — GM klickt Button im Chat,
      // Würfeln passiert dort; hier nur Pending-Marker setzen.
      pendingFumbleCheck = true;
    }

    // ── 8) Payload bauen und dispatchen ──
    const payload = {
      helperId: this.helperId,
      helperName: helperEntry.actorName ?? actor.name,
      targetId: this.selectedTargetId,
      targetName: targetEntry.actorName,
      traitType: this.selectedTraitType,
      traitKey: this.selectedTraitKey,
      traitName: this.selectedTraitName,
      resultTotal,
      diceDetails,
      critFail,
      pendingFumbleCheck,
      fumbleCheckDie,
    };

    if (game.user.isGM) {
      await _applyDramaticSupportRoll(message, payload);
    } else {
      game.socket.emit(ADR.SOCKET, {
        action: "dramaticSupport",
        messageId: this.messageId,
        payload,
      });
    }

    // ── 9) Dialog schließen — Spieler muss bei Bedarf erneut auf "Unterstützen" klicken ──
    this.close();
  }
}
