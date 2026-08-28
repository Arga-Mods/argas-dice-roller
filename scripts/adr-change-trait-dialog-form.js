/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright (C) 2026 Arga-Mods */

import { ADR } from "./adr-constants.js";
import { requireActiveGM } from "./adr-benny-helpers.js";
import {
  collectActorTraits,
  resolveActorById,
} from "./adr-request-roll-form.js";
import {
  _applyDramaticTraitOverride,
} from "./adr-request-roll-chat.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * ChangeTraitDialogForm — Popup, mit dem der Spieler in der Dramatischen
 * Aufgabe eine andere Eigenschaft (Attribut oder Fertigkeit) für die aktuelle
 * Runde wählen kann.
 *
 * Verhalten:
 *  - Solange der Spieler in der aktuellen Runde noch nicht gewürfelt/ausgesetzt/
 *    unterstützt hat, kann er die Wahl beliebig oft ändern.
 *  - Die getroffene Wahl bleibt als `entry.dramaticTraitOverride` erhalten und
 *    wirkt als Default für die nächste Runde (kann dort wieder geändert werden).
 *  - Reset-Button setzt den Override zurück → ursprünglich vom GM angeforderte
 *    Eigenschaft greift wieder.
 *
 * Persistenz:
 *  - Spieler:  Socket-Action "dramaticTraitOverride" → GM schreibt Flag.
 *  - GM:       schreibt Flag direkt via _applyDramaticTraitOverride.
 */
export class ChangeTraitDialogForm extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: "adr-change-trait-dialog",
    classes: [
      "argas-dice-roller-window",
      "adr-request-roll-window",
      "adr-support-dialog-window",
      "adr-change-trait-dialog-window",
    ],
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
      template: ADR.CHANGE_TRAIT_DIALOG_FORM_PATH,
    },
  };

  /* -------------------------------------------------------------- */
  /*  Konstruktor                                                    */
  /* -------------------------------------------------------------- */

  /**
   * @param {object} opts
   * @param {string} opts.messageId   ID der Dramatic-Task-Chat-Message
   * @param {string} opts.actorId     Actor-/Token-ID des Spielers
   */
  constructor(opts = {}) {
    // Dynamische Positionierung wie beim Support-Dialog: links neben dem
    // Foundry-Chat-Panel, vertikal mittig.
    const width = 760;
    const estimatedHeight = 420;

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
    this.actorId = opts.actorId ?? null;

    // Aktuelle Auswahl im Dialog. Initial = aktueller Override (falls vorhanden),
    // sonst der ursprünglich angeforderte Trait.
    const message = game.messages.get(this.messageId);
    const flags = message?.flags?.[ADR.ID];
    const entry = flags?.entries?.find(e => e.actorId === this.actorId);
    const ovr = entry?.dramaticTraitOverride;
    const initType = ovr?.type ?? entry?.traitType ?? null;
    const initKey  = ovr?.key  ?? entry?.traitKey  ?? null;
    const initName = ovr?.name ?? entry?.traitName ?? null;

    this.selectedTraitType = initType;
    this.selectedTraitKey = initKey;
    this.selectedTraitName = initName;
  }

  /* -------------------------------------------------------------- */
  /*  Titel                                                           */
  /* -------------------------------------------------------------- */

  get title() {
    return game.i18n.localize(`${ADR.ID}.requestRoll.dramaticChangeTrait.title`);
  }

  /* -------------------------------------------------------------- */
  /*  Daten-Aufbereitung                                              */
  /* -------------------------------------------------------------- */

  async _prepareContext() {
    const message = game.messages.get(this.messageId);
    const flags = message?.flags?.[ADR.ID];
    const entry = flags?.entries?.find(e => e.actorId === this.actorId);
    const actorObj = resolveActorById(this.actorId);

    const actor = {
      actorId: this.actorId,
      actorName: entry?.actorName ?? actorObj?.name ?? "?",
      actorImg: entry?.actorImg ?? actorObj?.img ?? "",
    };

    // Original-Trait (vom GM angefordert) — für die Info-Zeile und den Reset-Button
    const originalTraitName = entry?.traitName ?? "?";
    const escFn = foundry.utils.escapeHTML ?? (s => String(s ?? ""));
    const originalTraitLineHTML = game.i18n.format(
      `${ADR.ID}.requestRoll.dramaticChangeTrait.originalTraitLine`,
      { trait: escFn(originalTraitName) }
    );

    // Override aktiv?
    const ovr = entry?.dramaticTraitOverride;
    const hasOverride = !!(ovr && (
      ovr.type !== entry.traitType ||
      ovr.key !== entry.traitKey
    ));

    // Traits des Akteurs (Attribute + Fertigkeiten)
    const traits = actorObj ? collectActorTraits(actorObj) : {
      attributes: [], skills: [], coreSkills: [], otherSkills: [],
    };

    // Bestätigen ist erlaubt, sobald ein Trait ausgewählt ist UND er sich vom
    // aktuell aktiven Trait unterscheidet. (Aktiv = Override falls vorhanden,
    // sonst Original.)
    const activeType = ovr?.type ?? entry?.traitType;
    const activeKey  = ovr?.key  ?? entry?.traitKey;
    const isSameAsActive = (
      this.selectedTraitType === activeType &&
      this.selectedTraitKey === activeKey
    );
    const canConfirm = !!(this.selectedTraitKey && !isSameAsActive);

    return {
      actor,
      traits,
      selectedTraitType: this.selectedTraitType,
      selectedTraitKey: this.selectedTraitKey,
      originalTraitLineHTML,
      canReset: hasOverride,
      canConfirm,
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
    const winHeader = root.querySelector(".window-header");
    if (winHeader && !winHeader.querySelector(".adrgs-title-extra")) {
      const span = document.createElement("span");
      span.className = "adrgs-title-extra";
      span.textContent = game.i18n.localize(`${ADR.ID}.requestRoll.dramaticChangeTrait.title`);
      winHeader.appendChild(span);
    }

    root.addEventListener("click", (ev) => {
      const traitBtn = ev.target.closest("[data-action='adr-change-trait-select-trait']");
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

      if (ev.target.closest("[data-action='adr-change-trait-cancel']")) {
        this.close();
        return;
      }

      if (ev.target.closest("[data-action='adr-change-trait-reset']")) {
        this._onReset();
        return;
      }

      if (ev.target.closest("[data-action='adr-change-trait-confirm']")) {
        this._onConfirm();
        return;
      }
    });
  }

  /* -------------------------------------------------------------- */
  /*  Confirm / Reset                                                 */
  /* -------------------------------------------------------------- */

  /** Round-Open-Check: Ist die aktuelle Runde noch offen für diesen Akteur? */
  _isRoundStillOpen() {
    const message = game.messages.get(this.messageId);
    const flags = message?.flags?.[ADR.ID];
    const entry = flags?.entries?.find(e => e.actorId === this.actorId);
    const rs = entry?.roundState;
    if (!entry || !rs) return false;
    if (flags.outcome) return false;
    if (flags.pendingOutcome === "complicationFailure") return false;
    if (rs.acted) return false;
    if (rs.skipped) return false;
    if (rs.result !== null && rs.result !== undefined) return false;
    return true;
  }

  async _onConfirm() {
    // Ohne verbundenen GM kann die Änderung nicht gespeichert werden
    if (!requireActiveGM()) return;
    if (!this._isRoundStillOpen()) {
      ui.notifications.warn(game.i18n.localize(`${ADR.ID}.requestRoll.dramaticChangeTrait.noLongerPossible`));
      this.close();
      return;
    }
    if (!this.selectedTraitKey) return;

    const payload = {
      actorId: this.actorId,
      traitType: this.selectedTraitType,
      traitKey: this.selectedTraitKey,
      traitName: this.selectedTraitName,
    };

    if (game.user.isGM) {
      const message = game.messages.get(this.messageId);
      await _applyDramaticTraitOverride(message, payload);
    } else {
      game.socket.emit(ADR.SOCKET, {
        action: "dramaticTraitOverride",
        messageId: this.messageId,
        payload,
      });
    }

    this.close();
  }

  async _onReset() {
    // Ohne verbundenen GM kann die Änderung nicht gespeichert werden
    if (!requireActiveGM()) return;
    if (!this._isRoundStillOpen()) {
      ui.notifications.warn(game.i18n.localize(`${ADR.ID}.requestRoll.dramaticChangeTrait.noLongerPossible`));
      this.close();
      return;
    }

    const payload = {
      actorId: this.actorId,
      reset: true,
    };

    if (game.user.isGM) {
      const message = game.messages.get(this.messageId);
      await _applyDramaticTraitOverride(message, payload);
    } else {
      game.socket.emit(ADR.SOCKET, {
        action: "dramaticTraitOverride",
        messageId: this.messageId,
        payload,
      });
    }

    this.close();
  }
}
