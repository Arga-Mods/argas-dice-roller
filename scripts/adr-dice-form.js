/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright (C) 2026 Arga-Mods */

import { ADR, adrIsFudge, adrSignedNumber, adrBuildFudgeResults, adrKeepModifier, adrCthulhuMode, adrEvalCthulhu } from "./adr-constants.js";
import {
  _fireTraitRollHook,
  _renderDicePrecomputed,
  _buildInlineRollContent,
} from "./adr-request-roll-chat.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * HTML für den Hinweistext eines verdeckten Wurfs. Jede Zeile (\n im
 * i18n-String) wird als eigenes <div> mit Inline-Styles gerendert, damit der
 * Umbruch unabhängig von kollidierenden CSS-Regeln anderer Module wirkt.
 * Die erste Zeile (`~ Label ~`) erhält `white-space: nowrap`.
 *
 * @param {string} key  hiddenInfo-Key, z.B. "gmRoll", "blindRoll", "selfRoll"
 * @returns {string}    HTML-Fragment
 */
export function buildHiddenInfoHTML(key) {
  const raw = game.i18n.localize(`${ADR.ID}.hiddenInfo.${key}`);
  const escape = foundry.utils.escapeHTML ?? ((s) => s);
  return raw.split("\n").map((line, i) => {
    const labelStyle = i === 0 ? "white-space:nowrap;" : "";
    const cls = i === 0 ? "adr-hidden-info-line adr-hidden-info-label" : "adr-hidden-info-line";
    return `<div class="${cls}" style="display:block;text-align:center;${labelStyle}">${escape(line)}</div>`;
  }).join("");
}

/**
 * Foundry-Würfelmodifikator zum Setting `explodingMode`: "xo" (genau einmal
 * explodieren) bzw. "x" (rekursiv). Einzige Quelle für Erstwurf und
 * Reroll-Rebuild.
 */
export function adrExplodingModifier() {
  return game.settings.get(ADR.ID, ADR.CONFIG_EXPLODING_MODE) === "once" ? "xo" : "x";
}

/**
 * Einzelergebnis-Anzeige eines Würfel-Terms: pro Original-Würfel eine mit
 * <sup>ex</sup> verkettete Explosionskette plus min/max-CSS-Klasse.
 *
 * Foundry hängt Explosionswürfel ans Ende des `results`-Arrays an, nicht
 * hinter ihren Elternwürfel. Da die Explosionsschleife in Array-Reihenfolge
 * läuft und pro Explosion genau einen Würfel anhängt, gehört der k-te
 * explodierte Würfel zum k-ten angehängten Explosionswürfel (gilt für
 * einmaliges wie mehrfaches Explodieren).
 *
 * @param {object} dieTerm  Foundry-Würfel-Term (mit .number, .faces, .results)
 * @returns {{value:string, display:string, class:string}[]}
 */
export function adrBuildDieResults(dieTerm) {
  if (!dieTerm?.results?.length) return [];
  const results = dieTerm.results;
  const faces = dieTerm.faces;
  const n = dieTerm.number;

  // Jeder explodierte Würfel bekommt in Array-Reihenfolge den nächsten
  // angehängten Explosionswürfel als Kind.
  let childPtr = n;
  const childOf = new Map();
  for (let i = 0; i < results.length; i++) {
    if (results[i].exploded) childOf.set(i, childPtr++);
  }

  const out = [];
  for (let i = 0; i < n; i++) {
    const chain = [];
    let idx = i;
    while (idx !== undefined) {
      chain.push(results[idx].result);
      idx = childOf.get(idx);
    }
    let cssClass = "";
    if (chain.includes(1)) cssClass = "min";
    if (chain.includes(faces)) cssClass = "max";
    const display = chain.join("<sup class='adr-ex'>ex</sup>");
    // kh/kl: Foundry markiert nicht gewertete Würfel mit discarded=true
    // (im Chat durchgestrichen, bei der Einsen-Regel nicht mitgezählt).
    const discarded = !!results[i].discarded;
    if (discarded) cssClass = `${cssClass} adr-discarded`.trim();
    out.push({ value: display, display, class: cssClass, discarded });
  }
  return out;
}

export class DiceForm extends HandlebarsApplicationMixin(ApplicationV2) {

  static GM_ROLL = "makeGMRoll";
  static BLIND_ROLL = "makeBlindRoll";
  static SELF_ROLL = "makeSelfRoll";
  static STANDARD_DICE = ["d2","d4","d6","d8","d10","d12","d20"];

  // Muss mit den Grenzen im Probenanforderungsfenster (adr-request-roll-form.js) übereinstimmen.
  static MODIFIER_MIN = -99;
  static MODIFIER_MAX = 99;


  /** @override */
  static DEFAULT_OPTIONS = {
    // Modul-Präfix in der Element-ID: eine generische ID wie "dice-form"
    // kollidiert mit CSS-Regeln anderer Module.
    id: "adr-dice-form",
    classes: ["argas-dice-roller-window"],
    window: {
      frame: true,
      positioned: true,
      title: "",
      resizable: false,
    },
    position: {
      width: "auto",
      height: "auto",
      top: 70,
      left: 120,
    },
  };

  /** @override */
  static PARTS = {
    form: {
      template: ADR.DICE_FORM_PATH,
    },
  };

  constructor(opts = {}) {
    super(opts);
    this.hiddenType = null;
    this.isExploding = false;
    this.isWildDie = false;
    // „Höchster"/„Niedrigster": null | "kh" | "kl".
    this.keepMode = null;
    this.showKeepToggle = game.settings.get(ADR.ID, ADR.CONFIG_KEEP_DICE);
    // Bonus-/Strafwurf (Call of Cthulhu): null | "bonus" | "penalty", Zusatzwürfel 1 oder 2.
    this.cthulhuMode = null;
    this.cthulhuCount = 1;
    this.showCthulhuToggle = game.settings.get(ADR.ID, ADR.CONFIG_CTHULHU_DICE);
    this.enableHiddenRolls = game.settings.get(ADR.ID, ADR.CONFIG_HIDDEN_ROLLS);
    this.explodingMode = game.settings.get(ADR.ID, ADR.CONFIG_EXPLODING_MODE);
    this.showExplodingToggle = (this.explodingMode !== "off");
    this.explodingDefault = game.settings.get(ADR.ID, ADR.CONFIG_EXPLODING_DEFAULT);
    if (this.showExplodingToggle && this.explodingDefault) this.isExploding = true;
    this.enableFirstColumn = game.settings.get(ADR.ID, ADR.CONFIG_1ST_COLUMN);
    this.closeFormOnRoll = game.settings.get(ADR.ID, ADR.CONFIG_CLOSE_FORM);
    this.diceTypes = game.settings.get(ADR.ID, ADR.CONFIG_DICE_TYPES);
    // Wild-Die-Schaltfläche ist in jedem System verfügbar (Standard nur in SWADE an).
    this.showWildToggle = game.settings.get(ADR.ID, ADR.CONFIG_WILD_DIE);
    this.showModifiers = game.settings.get(ADR.ID, ADR.CONFIG_MODIFIERS);
    // Über Buttons gewählte Modifikatoren – nur für Button-Optik und Toggle-
    // Logik. Alleinige Quelle für den Wurf ist manualModifier (Wert des
    // händischen Eingabefelds, bei Button-Klicks aus der Button-Summe gespiegelt).
    this.modifiers = [];
    this.manualModifier = 0;
    // true, solange eine händische Eingabe im Feld steht; sperrt die Buttons.
    this.modifierLocked = false;

    // ── Multi-Würfel-Auswahl (Strg+Klick) ──
    // Map mit Key "type|count" statt Set<HTMLElement>: die Auswahl muss
    // Re-Renders (z. B. nach Maximize) überleben, die Elemente werden dabei
    // ausgetauscht.
    this._multiSelection = new Map();
    this._ctrlActive = false;
    this._onCtrlKeydown = null;
    this._onCtrlKeyup = null;
    this._onCtrlBlur = null;
  }

  /* --------------------------------------------------------- */
  /*  Dice-Typ-Liste                                           */
  /* --------------------------------------------------------- */

  _getDiceTypes() {
    return ADR.DICE_TYPES.filter(t => this.diceTypes?.[t] ?? ADR.DICE_TYPES_DEFAULT[t]);
  }

  /* --------------------------------------------------------- */
  /*  Template-Kontext                                         */
  /* --------------------------------------------------------- */

  /** @override */
  async _prepareContext(options) {
    const maxCount = game.settings.get(ADR.ID, ADR.CONFIG_MAXDICE_COUNT);
    const offset = this.enableFirstColumn ? 0 : 1;
    const totalCols = maxCount - offset;

    // hiddenType ist reiner Fenster-Zustand ohne Bezug zu einem Foundry-
    // Würfelmodus-Setting (core.rollMode ist seit v14 deprecatet).

    return {
      enableHiddenRolls: this.enableHiddenRolls,
      showExplodingToggle: this.showExplodingToggle,
      showWildToggle: this.showWildToggle,
      showKeepToggle: this.showKeepToggle,
      showCthulhuToggle: this.showCthulhuToggle,
      showModifiers: this.showModifiers,
      modifierDisplay: this._formatModifierForInput(this.manualModifier),
      user: game.user,
      enableFateRollButton: game.settings.get(ADR.ID, "enableFateRollButton"),
      enableRequestRoll: game.system.id === "swade" && game.settings.get(ADR.ID, ADR.CONFIG_REQUEST_ROLL),
      showFirstColumn: this.enableFirstColumn,
      modulePath: `modules/${ADR.ID}`,

      // Toggle-Zustände für State-Erhalt bei Re-Render
      isExploding: this.isExploding,
      isWildDie: this.isWildDie,
      isKeepHighest: this.keepMode === "kh",
      isKeepLowest: this.keepMode === "kl",
      isBonusDie: this.cthulhuMode === "bonus",
      isPenaltyDie: this.cthulhuMode === "penalty",
      cthulhuCount: this.cthulhuCount,
      isGMRoll: this.hiddenType === DiceForm.GM_ROLL,
      isBlindRoll: this.hiddenType === DiceForm.BLIND_ROLL,
      isSelfRoll: this.hiddenType === DiceForm.SELF_ROLL,

      diceRows: this._getDiceTypes().map(die => {
        const isGerman = game.i18n.lang.startsWith("de");
        const label = die === "dc"
          ? game.i18n.localize("argas-dice-roller.legend.coin")
          : (adrIsFudge(die) ? "Fudge" : (isGerman ? die.replace(/^d/, "W") : die));

        const isCoin = (die === "dc");
        const rolls = isCoin
          ? (this.enableFirstColumn ? [1] : [])
          : Array.from({ length: totalCols }, (_, i) => i + offset + 1);

        const placeholders = isCoin
          ? Array.from({ length: Math.max(totalCols - rolls.length, 0) }, () => null)
          : [];

        return { diceType: die, diceLabel: label, rolls, placeholders };
      })
    };
  }

  /* --------------------------------------------------------- */
  /*  Lifecycle: Erster Render (Window-Frame, Titel)           */
  /* --------------------------------------------------------- */

  /** @override */
  _onFirstRender(context, options) {
    super._onFirstRender(context, options);
    const winHeader = this.element.querySelector(".window-header");
    if (winHeader && !winHeader.querySelector(".adrgs-title-extra")) {
      const span = document.createElement("span");
      span.className = "adrgs-title-extra";
      span.textContent = "~ Arga's Dice Roller ~";
      winHeader.appendChild(span);
    }

    this._applyUiScale();
    this._setupUiScaleObserver();

    // Strg-Listener auf window statt auf dem Formular, damit Strg auch ohne
    // Fokus im Würfelfenster erkannt wird.
    this._setupCtrlListeners();
  }

  /* --------------------------------------------------------- */
  /*  UI-Scaling: CSS-Klasse mit !important (nötig wegen       */
  /*  ApplicationV2) + MutationObserver auf dem --ui-scale-    */
  /*  Element für Live-Updates                                 */
  /* --------------------------------------------------------- */

  /** Scale lesen und per CSS-Variable + Klasse anwenden */
  _applyUiScale() {
    const scaleEl = this._uiScaleEl ?? document.documentElement;
    let scale = parseFloat(getComputedStyle(scaleEl).getPropertyValue("--ui-scale")) || 0;
    if (!scale) scale = game.settings.get("core", "uiConfig")?.uiScale ?? 1;

    const el = this.element;
    // Die Klasse greift per !important-Regel (übertrumpft ApplicationV2).
    el.style.setProperty("--adr-ui-scale", scale);
    if (scale !== 1) {
      el.classList.add("adr-scaled");
    } else {
      el.classList.remove("adr-scaled");
    }

    // Position rechts neben der Toolbar. getBoundingClientRect liefert
    // post-transform-Koordinaten; die Offsets werden mitskaliert.
    const toolbar = document.querySelector("#ui-left > *:first-child");
    if (toolbar) {
      const rect = toolbar.getBoundingClientRect();
      this.setPosition({ left: rect.right + 18 * scale, top: rect.top + 42 * scale });
    }
  }

  /** Elternelement mit --ui-scale finden und MutationObserver starten */
  _setupUiScaleObserver() {
    // Nächstes Elternelement von #ui-top, das --ui-scale im style-Attribut setzt.
    this._uiScaleEl = document.getElementById("ui-top")
      ?.closest('[style*="--ui-scale"]') ?? null;

    if (this._uiScaleEl && !this._uiScaleObserver) {
      this._uiScaleObserver = new MutationObserver(() => this._applyUiScale());
      this._uiScaleObserver.observe(this._uiScaleEl, {
        attributes: true,
        attributeFilter: ["style"]
      });
    }
  }

  /**
   * Beim Minimieren flüchtige Einstellungen zurücksetzen (greift bei
   * Doppelklick auf die Titelleiste, Minimize-Button und API).
   */
  async minimize() {
    this._resetVolatileSettings();
    return super.minimize();
  }

  /**
   * Erst Foundrys Restore-Animation abwarten, dann neu rendern: ein render()
   * während der Animation tauscht das Element aus und bricht den Übergang ab.
   */
  async maximize() {
    const result = await super.maximize();
    this.render();
    return result;
  }

  /**
   * Flüchtige Einstellungen nur beim Öffnen aus geschlossenem Zustand
   * zurücksetzen. Re-Renders eines offenen Fensters (Maximize, Setting-
   * Änderung) behalten den Zustand.
   * @override
   */
  async render(...args) {
    if (!this.rendered) this._resetVolatileSettings();
    return super.render(...args);
  }

  /**
   * Setzt die flüchtigen Würfel-Einstellungen auf ihre Defaults zurück
   * (beim Öffnen, Minimieren und Schließen).
   */
  _resetVolatileSettings() {
    // Verdeckte Würfe haben kein Setting; ein Zurücklesen aus core.rollMode
    // wäre unter Foundry v14 unzuverlässig.
    this.hiddenType = null;
    // Frisch aus dem Setting gelesen, damit der aktuell konfigurierte Wert
    // greift. Bei ausgeblendeter Schaltfläche bleibt isExploding aus.
    this.isExploding = this.showExplodingToggle
      && !!game.settings.get(ADR.ID, ADR.CONFIG_EXPLODING_DEFAULT);
    this.isWildDie = false;
    this.keepMode = null;
    this.cthulhuMode = null;
    this.cthulhuCount = 1;
    this.modifiers = [];
    this.manualModifier = 0;
    this.modifierLocked = false;
    this._clearMultiSelection();
  }

  _onClose(options) {
    this._teardownCtrlListeners();
    this._resetVolatileSettings();
    if (this._uiScaleObserver) {
      this._uiScaleObserver.disconnect();
      this._uiScaleObserver = null;
    }
    this._uiScaleEl = null;
    super._onClose(options);
  }

  /* --------------------------------------------------------- */
  /*  Lifecycle: Jeder Render (Event-Listener binden)          */
  /* --------------------------------------------------------- */

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);
    const el = this.element;

    // Verdeckte Würfe
    el.querySelectorAll("input[name='hiddenRoll']").forEach(input => {
      input.addEventListener("change", this._setHiddenRoll.bind(this));
    });

    // Explosionswürfel
    const exploding = el.querySelector("#explodingDice");
    if (exploding) exploding.addEventListener("change", ev => {
      this.isExploding = ev.target.checked;
      if (this.isExploding) { this._setKeepMode(null); this._setCthulhu(null); }
    });

    // Wild Die
    const wildDie = el.querySelector("#wildDie");
    if (wildDie) wildDie.addEventListener("change", ev => {
      this.isWildDie = ev.target.checked;
      if (this.isWildDie) { this._setKeepMode(null); this._setCthulhu(null); }
    });

    // „Höchster"/„Niedrigster" schließt Explodieren und Wild Die aus
    // (in keinem Ursprungssystem kombiniert).
    el.querySelectorAll("input[name='keepMode']").forEach(input => {
      input.addEventListener("change", ev => {
        const t = ev.currentTarget;
        this._setKeepMode(t.checked ? t.value : null);
        if (t.checked) {
          this._setCthulhu(null);
          this._switchOffExplodingAndWild();
        }
      });
    });

    // Bonus-/Strafwurf (Call of Cthulhu): 1. Klick = ein Zusatzwürfel,
    // 2. Klick = zwei, 3. Klick = aus. Beim zweiten Klick hat der Browser die
    // Checkbox bereits abgewählt; _setCthulhu setzt sie wieder auf aktiv.
    el.querySelectorAll("input[name='cthulhuMode']").forEach(input => {
      input.addEventListener("change", ev => {
        const t = ev.currentTarget;
        if (t.checked) {
          this._setCthulhu(t.value, 1);
          this._setKeepMode(null);
          this._switchOffExplodingAndWild();
        } else if (this.cthulhuMode === t.value && this.cthulhuCount === 1) {
          this._setCthulhu(t.value, 2);
        } else {
          this._setCthulhu(null);
        }
      });
    });

    // Würfeln
    el.querySelectorAll(".rollable").forEach(btn => {
      btn.addEventListener("click", this._handleDiceClick.bind(this));
    });

    // Modifikatoren
    el.querySelectorAll(".adr-modifier").forEach(btn => {
      btn.addEventListener("click", this._onModifierClick.bind(this));
    });

    // Modifikator-Zustand nach Re-Render wiederherstellen
    el.querySelectorAll(".adr-modifier").forEach(btn => {
      const mod = Number(btn.dataset.modifier);
      if (this.modifiers.includes(mod)) btn.classList.add("selected");
    });

    // ── Händisches Modifikator-Eingabefeld ──
    // Verhält sich wie das Feld im Probenanforderungsfenster: eine Zahl ohne
    // Vorzeichen erhält beim Verlassen des Felds ein "+".
    const modInput = el.querySelector("[data-action='set-manual-modifier']");
    if (modInput) {
      modInput.addEventListener("input", (ev) => {
        const v = String(ev.currentTarget.value).trim();
        if (v === "") {
          this.modifierLocked = false;
          this.manualModifier = 0;
        } else {
          this.modifierLocked = true;
          this.modifiers = [];
          this.element?.querySelectorAll(".adr-modifier.selected")
            .forEach(b => b.classList.remove("selected"));
          // Zwischenstände wie "+" oder "-" sowie nicht parsbare Eingaben
          // ergeben 0; das Feld behält dabei seinen sichtbaren Text.
          const raw = Number(v);
          if (/^[+\-]?\d+$/.test(v) && Number.isFinite(raw)) {
            this.manualModifier = Math.max(
              DiceForm.MODIFIER_MIN,
              Math.min(DiceForm.MODIFIER_MAX, raw)
            );
          } else {
            this.manualModifier = 0;
          }
        }
        this._refreshModifierButtonsDisabled();
        this._syncModActiveClass();
      });
      // Beim Verlassen Anzeige normalisieren ("2" → "+2"); eine Begrenzung
      // wird hier sichtbar ("999" → "+99").
      modInput.addEventListener("blur", (ev) => {
        const formatted = this._formatModifierForInput(this.manualModifier);
        ev.currentTarget.value = formatted;
        // Leeres Feld (unparsbare Eingabe, "0") bedeutet immer: Buttons benutzbar.
        if (formatted === "" && this.modifierLocked) {
          this.modifierLocked = false;
          this._refreshModifierButtonsDisabled();
          this._syncModActiveClass();
        }
      });
    }

    this._refreshModifierButtonsDisabled();
    this._syncModActiveClass();

    // Multi-Auswahl nach Re-Render wiederherstellen
    el.querySelectorAll(".rollable").forEach(btn => {
      const key = `${btn.dataset.diceType}|${btn.dataset.diceRoll}`;
      if (this._multiSelection.has(key)) btn.classList.add("adr-multi-selected");
    });
  }

  /* --------------------------------------------------------- */
  /*  Event-Handler                                            */
  /* --------------------------------------------------------- */

  _setHiddenRoll(event) {
    const inputs = this.element.querySelectorAll("input[name='hiddenRoll']");
    const target = event.currentTarget;
    if (target.checked) {
      inputs.forEach(input => { if (input !== target) input.checked = false; });
      this.hiddenType = target.id;
    } else {
      this.hiddenType = null;
    }
    // hiddenType wird nicht in ein Foundry-Setting geschrieben: core.rollMode
    // ist seit v14 zugunsten von core.messageMode deprecatet (fällt mit v16
    // weg). Der verdeckte Wurf läuft direkt über whisper/blind.
  }

  /** Explodieren und Wild Die abschalten (State + Checkboxen) und Strg-Auswahl verwerfen. */
  _switchOffExplodingAndWild() {
    this.isExploding = false;
    this.isWildDie = false;
    const ex = this.element?.querySelector("#explodingDice"); if (ex) ex.checked = false;
    const wd = this.element?.querySelector("#wildDie"); if (wd) wd.checked = false;
    // Eine laufende Strg-Auswahl passt nicht zum Einzelwurf-Modus.
    this._clearMultiSelection();
  }

  /** Setzt Bonus-/Strafwurf (null/"bonus"/"penalty") samt Anzahl und gleicht Umschalter + Ziffer ab. */
  _setCthulhu(mode, count = 1) {
    this.cthulhuMode = adrCthulhuMode(mode);
    this.cthulhuCount = this.cthulhuMode ? Math.min(2, Math.max(1, count)) : 1;
    this.element?.querySelectorAll("input[name='cthulhuMode']").forEach(input => {
      const active = (input.value === this.cthulhuMode);
      input.checked = active;
      const badge = input.parentElement?.querySelector(".adr-cthulhu-count");
      if (badge) badge.textContent = active ? String(this.cthulhuCount) : "";
    });
  }

  /** Setzt keepMode (null/"kh"/"kl") und gleicht die beiden Umschalter ab. */
  _setKeepMode(mode) {
    this.keepMode = adrKeepModifier(mode);
    this.element?.querySelectorAll("input[name='keepMode']").forEach(input => {
      input.checked = (input.value === this.keepMode);
    });
  }

  _onModifierClick(event) {
    // CSS unterbindet den Klick bereits via pointer-events; zweite Absicherung.
    if (this.modifierLocked) return;

    const el = event.currentTarget;
    const mod = Number(el.dataset.modifier);
    if (el.classList.contains("selected")) {
      el.classList.remove("selected");
      this.modifiers = this.modifiers.filter(m => m !== mod);
    } else {
      el.classList.add("selected");
      this.modifiers.push(mod);
    }
    // Direktes Setzen von `.value` löst kein input-Event aus; die Buttons
    // bleiben entsperrt, anders als bei echter Tastatureingabe.
    this.manualModifier = this.modifiers.reduce((a, b) => a + b, 0);
    const inp = this.element?.querySelector("[data-action='set-manual-modifier']");
    if (inp) inp.value = this._formatModifierForInput(this.manualModifier);
    this._syncModActiveClass();
  }

  /**
   * Modifikator für das Eingabefeld: 0 oder ungültig → "" (Platzhalter
   * wird sichtbar), sonst mit Vorzeichen.
   */
  _formatModifierForInput(n) {
    if (!Number.isFinite(n) || n === 0) return "";
    return n > 0 ? `+${n}` : String(n);
  }

  /** Effektiver Modifikator für den Wurf, auf [MODIFIER_MIN .. MODIFIER_MAX] begrenzt. */
  _getEffectiveModifier() {
    const m = Number.isFinite(this.manualModifier) ? this.manualModifier : 0;
    return Math.max(DiceForm.MODIFIER_MIN, Math.min(DiceForm.MODIFIER_MAX, m));
  }

  /** Sperr-Optik der Modifikator-Buttons mit modifierLocked abgleichen. */
  _refreshModifierButtonsDisabled() {
    this.element?.querySelectorAll(".adr-modifier").forEach(btn => {
      btn.classList.toggle("adr-modifier-disabled", this.modifierLocked);
    });
  }

  /**
   * Window-Klasse `adr-mod-active` steuert die CSS-Sperroptik der Münzzelle,
   * solange ein Modifikator aktiv ist (Münzwürfe nehmen keine Modifikatoren an).
   */
  _syncModActiveClass() {
    this.element?.classList.toggle("adr-mod-active", this._getEffectiveModifier() !== 0);
  }

  /* --------------------------------------------------------- */
  /*  Multi-Würfel-Auswahl (Strg+Klick)                        */
  /* --------------------------------------------------------- */

  /**
   * Window-Listener für Strg (greift auch ohne Fokus im Würfelfenster):
   * keydown setzt `adr-ctrl-active` (orange Hover-Optik, CSS in
   * argas-dice-roller.css), keyup von "Control" löst den Multi-Pool-Wurf aus,
   * window.blur entfernt nur die Klasse und behält die Auswahl.
   */
  _setupCtrlListeners() {
    this._onCtrlKeydown = (ev) => {
      if (!ev.ctrlKey) return;
      if (!this.element || this._ctrlActive) return;
      this._ctrlActive = true;
      this.element.classList.add("adr-ctrl-active");
    };
    this._onCtrlKeyup = (ev) => {
      // Bei Tastenkombinationen (z. B. Strg+Shift) kann ein zweites keyup ohne
      // Control kommen; daher auf ev.key prüfen, nicht nur auf !ev.ctrlKey.
      if (ev.key !== "Control" && ev.ctrlKey) return;
      if (!this._ctrlActive) return;
      this._ctrlActive = false;
      this.element?.classList.remove("adr-ctrl-active");
      if (this._multiSelection.size > 0) {
        this._rollMultiPool().catch(err => {
          console.error(`${ADR.ID} | Multi-Pool-Wurf-Fehler:`, err);
        });
      }
    };
    this._onCtrlBlur = () => {
      // Fokusverlust bei gedrückter Strg-Taste (Alt-Tab o. ä.): nur die Optik
      // zurücksetzen, die Auswahl bleibt für erneutes Strg-Drücken erhalten.
      if (this._ctrlActive) {
        this._ctrlActive = false;
        this.element?.classList.remove("adr-ctrl-active");
      }
    };
    window.addEventListener("keydown", this._onCtrlKeydown);
    window.addEventListener("keyup", this._onCtrlKeyup);
    window.addEventListener("blur", this._onCtrlBlur);
  }

  _teardownCtrlListeners() {
    if (this._onCtrlKeydown) window.removeEventListener("keydown", this._onCtrlKeydown);
    if (this._onCtrlKeyup) window.removeEventListener("keyup", this._onCtrlKeyup);
    if (this._onCtrlBlur) window.removeEventListener("blur", this._onCtrlBlur);
    this._onCtrlKeydown = null;
    this._onCtrlKeyup = null;
    this._onCtrlBlur = null;
    this._ctrlActive = false;
  }

  /** Multi-Auswahl leeren (Map und `.adr-multi-selected`-Klassen). */
  _clearMultiSelection() {
    if (this._multiSelection) this._multiSelection.clear();
    this.element?.querySelectorAll(".adr-col.adr-multi-selected").forEach(el => {
      el.classList.remove("adr-multi-selected");
    });
  }

  /**
   * Klick auf einen Würfel-Button: ohne Strg Auswahl verwerfen und sofort
   * `_rollDie`, mit Strg die Auswahl umschalten. Münze ist im Multi-Modus
   * gesperrt (binär 0/1, passt nicht in eine Mischpool-Summe).
   */
  _handleDiceClick(event) {
    const ctrlPressed = !!event.ctrlKey;
    const btn = event.currentTarget;
    const type = String(btn.dataset.diceType);
    const count = Number(btn.dataset.diceRoll);

    if (!ctrlPressed) {
      // Münzwürfe nehmen keine Modifikatoren an; statt ihn still zu
      // schlucken, wird der Wurf blockiert.
      if (type === "dc" && this._getEffectiveModifier() !== 0) {
        ui.notifications.warn(game.i18n.localize(`${ADR.ID}.warn.coinNoModifier`));
        return;
      }
      // _clearMultiSelection vor dem Wurf, sonst zeigt der Button-Hover bis
      // zum nächsten Frame noch die orange Markierung.
      if (this._multiSelection.size > 0) this._clearMultiSelection();
      return this._rollDie(event);
    }

    event.preventDefault();
    event.stopPropagation();

    if (type === "dc") {
      ui.notifications.warn(game.i18n.localize(`${ADR.ID}.warn.coinNotInMulti`));
      return;
    }
    // Fudge-Würfel (−1/0/+1) passen nicht in eine Mischpool-Summe.
    if (adrIsFudge(type)) {
      ui.notifications.warn(game.i18n.localize(`${ADR.ID}.warn.fudgeNotInMulti`));
      return;
    }
    // „Höchster/Niedrigster" gilt nur für einen einzelnen Würfeltyp.
    if (this.keepMode) {
      ui.notifications.warn(game.i18n.localize(`${ADR.ID}.warn.keepNotInMulti`));
      return;
    }
    // Bonus-/Strafwurf gilt nur für einen einzelnen W100.
    if (this.cthulhuMode) {
      ui.notifications.warn(game.i18n.localize(`${ADR.ID}.warn.cthulhuNotInMulti`));
      return;
    }

    const key = `${type}|${count}`;
    if (this._multiSelection.has(key)) {
      this._multiSelection.delete(key);
      btn.classList.remove("adr-multi-selected");
    } else {
      this._multiSelection.set(key, { type, count });
      btn.classList.add("adr-multi-selected");
    }
  }

  /**
   * Einzelergebnisse pro Pool-Kategorie aus einem Roll mit mehreren
   * Würfel-Termen, in Pool-Reihenfolge:
   * `[{ type, count, faces, results: [{value,display,class}, …] }, …]`
   */
  _extractMultiPoolResults(roll, pool) {
    const out = [];
    for (let i = 0; i < pool.length; i++) {
      const p = pool[i];
      const dieEntry = roll?.dice?.[i];
      out.push({
        type: p.type, count: p.count, faces: p.faces,
        results: dieEntry ? adrBuildDieResults(dieEntry) : []
      });
    }
    return out;
  }

  /**
   * Multi-Pool-Wurf: Strg+Klick-Auswahl konsolidieren (gleiche Würfeltypen
   * aufaddieren) und den Pool auf einmal werfen.
   *
   * Bleibt nur eine Kategorie, läuft der Wurf über `_rollDie`, damit die volle
   * Pipeline (Tweaks-Hook, Patzer-Mechanik) greift. Bei mehreren Kategorien
   * werden Tweaks-Hook und Patzer-Mechanik übergangen: Mischpools sind keine
   * Eigenschaftsprobe, und der Tweaks-Dialog wäre unübersichtlich.
   */
  async _rollMultiPool() {
    // Auswahl vor dem ersten await leeren, damit ein zweiter Wurf in der
    // Zwischenzeit nicht dieselbe Auswahl erneut wirft.
    const rawEntries = Array.from(this._multiSelection.values());
    this._clearMultiSelection();
    if (rawEntries.length === 0) return;

    // Gruppen-/Fahrzeug-Akteure sind nicht wurffähig (wie in `_rollDie`).
    const _checkSpeaker = ChatMessage.getSpeaker();
    const _checkActor = game.actors.get(_checkSpeaker.actor);
    if (_checkActor && (_checkActor.type === "vehicle" || _checkActor.type === "group")) {
      ui.notifications.warn(game.i18n.localize(`${ADR.ID}.warn.cannotRollAsGroupOrVehicle`));
      return;
    }

    // Reihenfolge der Kategorien: nach erster Nennung.
    const consolidated = new Map();
    for (const { type, count } of rawEntries) {
      consolidated.set(type, (consolidated.get(type) || 0) + count);
    }
    const pool = Array.from(consolidated.entries()).map(([type, count]) => {
      const faces = Number(String(type).replace(/^[dDwW]/, "")) || 0;
      return { type, count, faces };
    });

    // Eine Kategorie: Pseudo-Event, damit `_rollDie` denselben Pfad nimmt
    // wie ein direkter Button-Klick.
    if (pool.length === 1) {
      const fakeBtn = document.createElement("div");
      fakeBtn.dataset.diceType = pool[0].type;
      fakeBtn.dataset.diceRoll = String(pool[0].count);
      return this._rollDie({
        preventDefault: () => {},
        currentTarget: fakeBtn,
      });
    }

    // ── Echter Multi-Pool-Wurf (≥ 2 Kategorien) ──
    const sumMod = this._getEffectiveModifier();
    const isExploding = !!this.isExploding;

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

    // Wild Die: ein einzelner W6 für den ganzen Pool
    let wildRoll = null;
    if (this.isWildDie) {
      const wildTerms = [new foundry.dice.terms.Die({ number: 1, faces: 6, modifiers: [adrExplodingModifier()] })];
      if (sumMod !== 0) {
        wildTerms.push(new foundry.dice.terms.OperatorTerm({ operator: sumMod > 0 ? "+" : "-" }));
        wildTerms.push(new foundry.dice.terms.NumericTerm({ number: Math.abs(sumMod) }));
      }
      wildRoll = await Roll.fromTerms(wildTerms).evaluate();
    }

    // Kein Tweaks-Hook bei Mischpools (siehe JSDoc).

    const multiPoolResults = this._extractMultiPoolResults(mainRoll, pool);
    // Flache Liste für Helfer, die `mainIndividualResults` als flaches Array erwarten.
    const mainIndividualResults = multiPoolResults.flatMap(c => c.results);

    let wildIndividualResults = [];
    if (wildRoll?.dice?.length) {
      wildIndividualResults = adrBuildDieResults(wildRoll.dice[0]);
    }

    let hiddenText = "";
    if (this.hiddenType === DiceForm.GM_ROLL)
      hiddenText = `<div class="adr-hidden-info" data-adr-hidden-key="gmRoll" style="font-size:0.9rem;margin:0;color:#e56917;font-weight:bold;text-align:center;"></div>`;
    else if (this.hiddenType === DiceForm.BLIND_ROLL)
      hiddenText = `<div class="adr-hidden-info" data-adr-hidden-key="blindRoll" style="font-size:0.9rem;margin:0;color:#e56917;font-weight:bold;text-align:center;"></div>`;
    else if (this.hiddenType === DiceForm.SELF_ROLL)
      hiddenText = `<div class="adr-hidden-info" data-adr-hidden-key="selfRoll" style="font-size:0.9rem;margin:0;color:#e56917;font-weight:bold;text-align:center;"></div>`;

    // Detail-Toggle nur als Marker; der Inhalt wird in `renderChatMessageHTML`
    // beim Betrachter aus `multiPoolResults` in dessen Sprache aufgebaut.
    const toggleLabelAttr = `data-adr-i18n="argas-dice-roller.individualResults.toggle"`;
    const resultLines = `<div class="adr-individual-toggle-container">`
      + `<div class="adr-individual-toggle" ${toggleLabelAttr}></div>`
      + `<div class="adr-individual-details adr-individual-hidden">`
      + `<div class="adr-individual adr-individual-multi" data-adr-multi-details="1"></div>`
      + `</div></div>`;

    const speaker = ChatMessage.getSpeaker();
    const flavor = wildRoll
      ? game.i18n.format(`${ADR.ID}.chat.flavorMultiWild`, { total: mainRoll.total, wild: wildRoll.total })
      : game.i18n.format(`${ADR.ID}.chat.flavorMulti`, { total: mainRoll.total });
    const actor = game.actors.get(speaker.actor);
    const actorImg = actor?.prototypeToken?.texture?.src || actor?.img || "";

    const flags = {
      "argas-dice-roller": {
        mainResult: mainRoll.total,
        // Truthiger Marker, damit die ADR-Erkennung in adr-hooks.js greift;
        // gerendert wird über multiPool / multiPoolResults.
        mainFormula: "_multi_pool",
        mainIndividualResults,
        mainExploding: isExploding,
        wildExploding: !!this.isWildDie,
        wildResult: wildRoll?.total,
        wildFormula: wildRoll?.formula,
        wildIndividualResults,
        actorName: speaker.alias,
        actorImg,
        // Keine Patzer-Auswertung bei Mischpools.
        mainHighlight: false,
        wildHighlight: false,
        hideRecipients: (this.hiddenType === DiceForm.GM_ROLL) || (this.hiddenType === DiceForm.BLIND_ROLL),
        isSelfRoll: this.hiddenType === DiceForm.SELF_ROLL,
        isWildcard: !!actor?.system?.wildcard,
        multiPool: pool.map(p => ({ type: p.type, count: p.count, faces: p.faces })),
        multiPoolResults,
        // Im Multi-Modus nicht eindeutig; null lässt Patzer-/Münzpfade defensiv defaulten.
        dieType: null,
        dieCount: null,
        appliedModifier: sumMod,
        rollSeq: 1,
        nextRollSeq: 2,
      }
    };

    const fullContent = `<div class="adr-body">${hiddenText}${resultLines}</div>`;
    const gmIds = game.users.filter(u => u.isGM).map(u => u.id);
    const rolls = [mainRoll];
    if (wildRoll) rolls.push(wildRoll);
    const msgData = { content: fullContent, speaker, flavor, flags, rolls };
    // Verdeckter Wurf nur über die Kern-Felder whisper/blind. Kein
    // msgData.rollMode: in v14 zugunsten von messageMode deprecatet, fällt
    // mit v16 weg. Ein nicht leeres whisper überschreibt Foundry nicht mit
    // dem globalen Modus.
    if (this.hiddenType === DiceForm.GM_ROLL) {
      msgData.whisper = gmIds;
    } else if (this.hiddenType === DiceForm.BLIND_ROLL) {
      msgData.whisper = gmIds;
      msgData.blind = true;
    } else if (this.hiddenType === DiceForm.SELF_ROLL) {
      msgData.whisper = [game.user.id];
    }

    DiceForm._emitChatMessage(msgData);
    if (this.closeFormOnRoll) this.close();
  }

  /* --------------------------------------------------------- */
  /*  Würfelwurf                                               */
  /* --------------------------------------------------------- */

  async _rollDie(event) {
    event.preventDefault();

    // SWADE-Akteure vom Typ "group"/"vehicle" haben keine Trait-Werte; ein
    // versehentlich selektiertes Token landete sonst mit irreführendem
    // Speaker im Chat.
    const _checkSpeaker = ChatMessage.getSpeaker();
    const _checkActor = game.actors.get(_checkSpeaker.actor);
    if (_checkActor && (_checkActor.type === "vehicle" || _checkActor.type === "group")) {
      ui.notifications.warn(game.i18n.localize(`${ADR.ID}.warn.cannotRollAsGroupOrVehicle`));
      return;
    }

    const count = Number(event.currentTarget.dataset.diceRoll);
    const type = String(event.currentTarget.dataset.diceType);
    const isFudge = adrIsFudge(type);
    // „Höchster"/„Niedrigster": Hinweis statt stillschweigend normalem Wurf.
    const keep = adrKeepModifier(this.keepMode);
    if (keep && (type === "dc" || isFudge)) {
      ui.notifications.warn(game.i18n.localize(`${ADR.ID}.warn.keepNoCoinFudge`));
      return;
    }
    if (keep && count < 2) {
      ui.notifications.warn(game.i18n.localize(`${ADR.ID}.warn.keepNeedsTwoDice`));
      return;
    }
    // Bonus-/Strafwurf (Call of Cthulhu): eigener Pfad, nur 1× W100.
    const cthulhu = adrCthulhuMode(this.cthulhuMode);
    if (cthulhu) {
      if (type !== "d100") {
        ui.notifications.warn(game.i18n.localize(`${ADR.ID}.warn.cthulhuOnlyD100`));
        return;
      }
      if (count !== 1) {
        ui.notifications.warn(game.i18n.localize(`${ADR.ID}.warn.cthulhuSingleRoll`));
        return;
      }
      return this._rollCthulhu(cthulhu, this.cthulhuCount);
    }
    let faces;
    if (type === "dc") {
      faces = 2;
    } else if (isFudge) {
      faces = 3;   // Foundry-FateDie: intern 3 Seiten (−1/0/+1)
    } else {
      faces = Number(String(type).replace(/^[dDwW]/, "")) || 0;
    }
    // Münzwürfe nehmen keine Modifikatoren an; Sicherheitsnetz, falls die
    // UI-Sperre umgangen wird.
    const sumMod = (type === "dc")
      ? 0
      : this._getEffectiveModifier();
    // Nie explodieren: Münze, Fudge, Höchster/Niedrigster (gleiche Liste wie
    // beim Reroll-Rebuild in adr-hooks.js).
    const canExplode = this.isExploding && type !== "dc" && !isFudge && !keep;
    const displayFormula = `${count}${type}${keep ?? ""}${canExplode ? "!" : ""}${sumMod !== 0 ? (sumMod > 0 ? `+${sumMod}` : `${sumMod}`) : ""}`;

    const dieTerm = isFudge
      ? new foundry.dice.terms.FateDie({ number: count })
      : new foundry.dice.terms.Die({
          number: count,
          faces,
          // "kh"/"kl" ohne Zahl = genau ein Würfel zählt (Foundry-Standard).
          modifiers: keep ? [keep] : (canExplode ? [adrExplodingModifier()] : [])
        });
    const terms = [dieTerm];
    if (sumMod !== 0) {
      terms.push(new foundry.dice.terms.OperatorTerm({ operator: sumMod > 0 ? "+" : "-" }));
      terms.push(new foundry.dice.terms.NumericTerm({ number: Math.abs(sumMod) }));
    }
    const mainRoll = await Roll.fromTerms(terms).evaluate();

    if (type === "dc" && mainRoll?.dice?.length) {
      for (const r of mainRoll.dice[0].results) {
        r.result = (r.result === 2) ? 1 : 0;
      }
      mainRoll._total = mainRoll.dice[0].results.reduce((a, r) => a + r.result, 0);
    }

    let wildRoll = null;
    if (this.isWildDie && type !== "dc" && !isFudge && !keep) {
      const wildTerms = [new foundry.dice.terms.Die({ number: 1, faces: 6, modifiers: [adrExplodingModifier()] })];
      if (sumMod !== 0) {
        wildTerms.push(new foundry.dice.terms.OperatorTerm({ operator: sumMod > 0 ? "+" : "-" }));
        wildTerms.push(new foundry.dice.terms.NumericTerm({ number: Math.abs(sumMod) }));
      }
      wildRoll = await Roll.fromTerms(wildTerms).evaluate();
    }

    /* --- Hook: argas-dice-roller:onTraitRoll (Argas Tweaks etc.) --- */
    // Ausgenommen: Münze (binär, nicht anpassbar), Fudge (keine
    // Eigenschaftsprobe) und Höchster/Niedrigster (Hook-Empfänger summieren
    // alle Würfel, hier zählt aber nur einer). Der Pseudo-Roll bündelt
    // Haupt- und Wild Die wie ein SWADE-Wildcard-Wurf; die `dice`-Einträge
    // referenzieren die echten Roll-Objekte, Hook-Änderungen wirken dort.
    if (type !== "dc" && !isFudge && !keep) {
      // Oberhalb der Würfel-Schwelle des Tweaks-Moduls (Wild Die nicht
      // mitgezählt) wird der Hook nicht gefeuert; ohne Tweaks keine Schwelle.
      const _tweaksActive = !!game.modules.get("argas-tweaks")?.active;
      let _tweaksTooMany = false;
      if (_tweaksActive) {
        // Foundry wirft bei nicht registrierten Setting-Keys; eine Tweaks-
        // Version ohne "maxDice" darf den Wurf nicht abbrechen.
        let _tweaksMaxDice = Infinity;
        try { _tweaksMaxDice = game.settings.get("argas-tweaks", "maxDice") ?? Infinity; } catch (e) { /* */ }
        const _mainDiceCount = mainRoll?.dice?.[0]?.number ?? 0;
        _tweaksTooMany = _mainDiceCount > _tweaksMaxDice;
      }

      if (!_tweaksTooMany) {
        const _hookSpeaker = ChatMessage.getSpeaker();
        const _hookActor = game.actors.get(_hookSpeaker.actor) ?? null;

        const _combinedDice = [mainRoll.dice[0]];
        if (wildRoll?.dice?.length) _combinedDice.push(wildRoll.dice[0]);
        const _combinedRoll = {
          dice: _combinedDice,
          total: wildRoll ? Math.max(mainRoll.total, wildRoll.total) : mainRoll.total,
        };

        const _hookData = {
          roll: _combinedRoll,
          actor: _hookActor ?? { name: _hookSpeaker.alias || "—" },
          traitName: game.i18n.localize(`${ADR.ID}.chat.rollName`),
          traitType: type,
          modifier: sumMod,
          requestId: null,
          messageId: null,
          entryIndex: null,
          // Freier Wurf: N-Würfel-Haupt-Term + optionaler Wild Die, keine
          // SWADE-Trait-`kh`-Struktur. Tweaks schaltet damit in den Pool-Modus.
          rollKind: "free",
          // exploding betrifft nur die Hauptwürfel; der Wild Die explodiert
          // immer. Bei aktiver Patzer-Mechanik darf ein vom Hook erzwungener
          // Niedrigwert keinen unbeabsichtigten Patzer erzeugen.
          exploding: canExplode,
          hasWildDie: !!wildRoll,
          fumbleMechanic: !!game.settings.get(ADR.ID, ADR.CONFIG_HIGHLIGHT_ONES),
        };

        const _finalRoll = await _fireTraitRollHook(_hookData);
        if (_finalRoll === false) return;

        // Foundry cacht `_total` nach evaluate(); nach Hook-Änderungen an den
        // Würfelergebnissen muss es für beide Rolls neu berechnet werden.
        if (mainRoll?.dice?.length) {
          const _sum = mainRoll.dice[0].results.reduce((a, r) => a + (r.result || 0), 0);
          mainRoll._total = _sum + sumMod;
        }
        if (wildRoll?.dice?.length) {
          const _sum = wildRoll.dice[0].results.reduce((a, r) => a + (r.result || 0), 0);
          wildRoll._total = _sum + sumMod;
        }
      }
    }

    /* --- Einzelergebnisse auswerten --- */

    let mainIndividualResults = [];
    if (mainRoll?.dice?.length) {
      // Fudge: Symbole statt Zahlen; die min/max-Logik von adrBuildDieResults
      // würde die +1 fälschlich rot färben.
      mainIndividualResults = isFudge
        ? adrBuildFudgeResults(mainRoll.dice[0])
        : adrBuildDieResults(mainRoll.dice[0]);
    }

    let wildIndividualResults = [];
    if (wildRoll?.dice?.length) {
      wildIndividualResults = adrBuildDieResults(wildRoll.dice[0]);
    }

    // Einsen-Regel gilt nicht für Fudge-Würfel (+1 ist dort das beste Ergebnis).
    let mainHighlight = false, wildHighlight = false;
    if (!isFudge && game.settings.get(ADR.ID, ADR.CONFIG_HIGHLIGHT_ONES)) {
      // Nur die natürlichen Würfel (erste `number` Einträge) zählen;
      // Explosions-Nachwürfe hängen hinten im results-Array und würden
      // Zähler wie Nenner verfälschen (2W6 [1, 6→1]: 2 von 3 statt 1 von 2).
      if (mainRoll?.dice?.length) {
        const term = mainRoll.dice[0];
        // Bei „Höchster/Niedrigster" zählen nur die gewerteten Würfel.
        const vals = term.results.slice(0, term.number).filter(r => !r.discarded).map(r => r.result);
        const ones = vals.filter(x => x === 1).length;
        if (vals.length === 1 && ones === 1) mainHighlight = true;
        else if (vals.length > 1 && ones > (vals.length / 2)) mainHighlight = true;
      }
      if (wildRoll?.dice?.length) {
        const term = wildRoll.dice[0];
        const vals = term.results.slice(0, term.number).map(r => r.result);
        if (vals.includes(1)) wildHighlight = true;
      }
    }

    /* --- Hidden-Info-Text --- */
    // Nur Marker (data-adr-hidden-key), kein Inhalt: renderChatMessageHTML
    // befüllt ihn beim Betrachter in dessen Sprache.
    let hiddenText = "";
    if (this.hiddenType === DiceForm.GM_ROLL)
      hiddenText = `<div class="adr-hidden-info" data-adr-hidden-key="gmRoll" style="font-size:0.9rem;margin:0;color:#e56917;font-weight:bold;text-align:center;"></div>`;
    else if (this.hiddenType === DiceForm.BLIND_ROLL)
      hiddenText = `<div class="adr-hidden-info" data-adr-hidden-key="blindRoll" style="font-size:0.9rem;margin:0;color:#e56917;font-weight:bold;text-align:center;"></div>`;
    else if (this.hiddenType === DiceForm.SELF_ROLL)
      hiddenText = `<div class="adr-hidden-info" data-adr-hidden-key="selfRoll" style="font-size:0.9rem;margin:0;color:#e56917;font-weight:bold;text-align:center;"></div>`;

    /* --- Einzelergebnis-Toggle --- */
    // Beschriftung als data-adr-i18n-Marker, lokalisiert beim Betrachter.

    let resultLines = "";
    // Münzwurf: kein Toggle-Container; damit steigt auch
    // _adrInjectFreeRollBennyButton aus und der Benny-Reroll-Button entfällt.
    if ((mainIndividualResults.length || wildIndividualResults.length) && type !== "dc") {
      // Einreihige Darstellung wie in der Probenanforderung ("3 (WD: 2) (Mod. +2)");
      // die Ergebnisse sind vorgerendert (display + class), daher _renderDicePrecomputed.
      const content = _buildInlineRollContent({
        mainHTML: _renderDicePrecomputed(mainIndividualResults),
        wildHTML: wildIndividualResults.length ? _renderDicePrecomputed(wildIndividualResults) : "",
        appliedModifier: sumMod,
      });
      const toggleLabelAttr = `data-adr-i18n="argas-dice-roller.individualResults.toggle"`;
      resultLines += `<div class="adr-individual-toggle-container">`
        + `<div class="adr-individual-toggle" ${toggleLabelAttr}></div>`
        + `<div class="adr-individual-details adr-individual-hidden">`
        + `<div class="adr-individual">${content}</div>`
        + `</div></div>`;
    }

    /* --- Chat-Nachricht erstellen --- */

    const speaker = ChatMessage.getSpeaker();
    const flavor = this.isWildDie && wildRoll
      ? game.i18n.format(`${ADR.ID}.chat.flavorMain`, { main: mainRoll.total, wild: wildRoll.total })
      : game.i18n.format(`${ADR.ID}.chat.flavorResult`, { total: isFudge ? adrSignedNumber(mainRoll.total) : mainRoll.total });

    const actor = game.actors.get(speaker.actor);
    const actorImg = actor?.prototypeToken?.texture?.src || actor?.img || "";

    const flags = {
      "argas-dice-roller": {
        mainResult: mainRoll.total,
        mainFormula: displayFormula,
        mainIndividualResults,
        // Steuert den Reroll-Rebuild in adr-hooks.js.
        mainExploding: canExplode,
        // Nur gesetzt, wenn ein Wild Die tatsächlich gewürfelt wurde (nicht bei Münze/Fudge).
        wildExploding: !!wildRoll,
        wildResult: wildRoll?.total,
        wildFormula: wildRoll?.formula,
        wildIndividualResults,
        actorName: speaker.alias,
        actorImg,
        mainHighlight,
        wildHighlight,
        hideRecipients: (this.hiddenType === DiceForm.GM_ROLL) || (this.hiddenType === DiceForm.BLIND_ROLL),
        isSelfRoll: this.hiddenType === DiceForm.SELF_ROLL,
        // Wildcard-Status zum Wurfzeitpunkt (nur SWADE). renderChatMessageHTML
        // unterdrückt damit den GM-Patzer-Check bei Wildcards: ein Einzelwürfel
        // ohne Wild Die kann bei einem Wildcard keine Eigenschaftsprobe sein.
        isWildcard: !!actor?.system?.wildcard,
        // Reroll-Kontext für den Benny-Button; aus `mainFormula` wären
        // type/count nur fragil parsbar. `wildExploding` steht zugleich für
        // „hasWildDie", da der Wild Die immer explodierend konstruiert wird.
        dieType: type,
        dieCount: count,
        // Steuert Chat-Kennzeichnung und Benny-Reroll-Rebuild in adr-hooks.js.
        keepMode: keep,
        appliedModifier: sumMod,
        // Sequenznummer für die Sortierung der Einzelergebnisse bei Mehrfach-
        // Bennies; Rerolls bekommen die nächste Nummer aus flags.nextRollSeq
        // (siehe _adrApplyBennyRerollFree).
        rollSeq: 1,
        nextRollSeq: 2
      }
    };

    const fullContent = `<div class="adr-body">${hiddenText}${resultLines}</div>`;
    const gmIds = game.users.filter(u => u.isGM).map(u => u.id);

    const rolls = [mainRoll];
    if (wildRoll) rolls.push(wildRoll);
    const msgData = { content: fullContent, speaker, flavor, flags, rolls };
    // Verdeckter Wurf nur über whisper/blind, kein msgData.rollMode
    // (Begründung in _rollMultiPool).
    if (this.hiddenType === DiceForm.GM_ROLL) {
      msgData.whisper = gmIds;
    } else if (this.hiddenType === DiceForm.BLIND_ROLL) {
      msgData.whisper = gmIds;
      msgData.blind = true;
    } else if (this.hiddenType === DiceForm.SELF_ROLL) {
      msgData.whisper = [game.user.id];
    }

    DiceForm._emitChatMessage(msgData);
    if (this.closeFormOnRoll) this.close();
  }

  /**
   * Bonus-/Strafwurf nach Call of Cthulhu 7e: ein W10 als Einerwürfel plus
   * (1 + n) W10 als Zehnerwürfel. Je Zehnerwürfel ergibt sich ein mögliches
   * Ergebnis (Zehner + Einer, 00+0 = 100); beim Bonuswurf zählt das
   * niedrigste, beim Strafwurf das höchste. Kein Explodieren, kein Wild Die,
   * kein Tweaks-Hook, keine Einsen-Regel, kein Benny (nicht SWADE).
   *
   * @param {"bonus"|"penalty"} mode
   * @param {number} extra  Anzahl Zusatz-Zehnerwürfel (1 oder 2)
   */
  async _rollCthulhu(mode, extra) {
    const sumMod = this._getEffectiveModifier();
    const tensTerm = new foundry.dice.terms.Die({ number: 1 + extra, faces: 10 });
    const onesTerm = new foundry.dice.terms.Die({ number: 1, faces: 10 });
    const roll = await Roll.fromTerms([
      tensTerm,
      new foundry.dice.terms.OperatorTerm({ operator: "+" }),
      onesTerm,
    ]).evaluate();
    const tensRaw = roll.dice[0].results.map(r => r.result);
    const onesRaw = roll.dice[1].results[0].result;
    const ev = adrEvalCthulhu(onesRaw, tensRaw, mode);
    // Die Foundry-Summe der W10 ist bedeutungslos; Gesamtwert selbst setzen.
    roll._total = ev.total + sumMod;

    // Je Zehnerwürfel ein mögliches Ergebnis, nicht gewertete durchgestrichen.
    // Keine min/max-Färbung (1 ist hier gut).
    const pad = v => (v === 100 ? "100" : String(v).padStart(2, "0"));
    const mainIndividualResults = ev.candidates.map((v, i) => ({
      value: v,
      display: pad(v),
      class: i === ev.chosenIndex ? "adr-cthulhu-chosen" : "adr-discarded",
      discarded: i !== ev.chosenIndex,
    }));

    let hiddenText = "";
    if (this.hiddenType === DiceForm.GM_ROLL)
      hiddenText = `<div class="adr-hidden-info" data-adr-hidden-key="gmRoll" style="font-size:0.9rem;margin:0;color:#e56917;font-weight:bold;text-align:center;"></div>`;
    else if (this.hiddenType === DiceForm.BLIND_ROLL)
      hiddenText = `<div class="adr-hidden-info" data-adr-hidden-key="blindRoll" style="font-size:0.9rem;margin:0;color:#e56917;font-weight:bold;text-align:center;"></div>`;
    else if (this.hiddenType === DiceForm.SELF_ROLL)
      hiddenText = `<div class="adr-hidden-info" data-adr-hidden-key="selfRoll" style="font-size:0.9rem;margin:0;color:#e56917;font-weight:bold;text-align:center;"></div>`;

    const content = _buildInlineRollContent({
      mainHTML: _renderDicePrecomputed(mainIndividualResults),
      wildHTML: "",
      appliedModifier: sumMod,
    });
    const resultLines = `<div class="adr-individual-toggle-container">`
      + `<div class="adr-individual-toggle" data-adr-i18n="argas-dice-roller.individualResults.toggle"></div>`
      + `<div class="adr-individual-details adr-individual-hidden">`
      + `<div class="adr-individual">${content}</div>`
      + `</div></div>`;

    const speaker = ChatMessage.getSpeaker();
    const flavor = game.i18n.format(`${ADR.ID}.chat.flavorResult`, { total: roll.total });
    const actor = game.actors.get(speaker.actor);
    const actorImg = actor?.prototypeToken?.texture?.src || actor?.img || "";
    const modStr = sumMod !== 0 ? (sumMod > 0 ? `+${sumMod}` : `${sumMod}`) : "";

    const flags = {
      "argas-dice-roller": {
        mainResult: roll.total,
        // Kennung in der Formel („b1"/„p2"), parseDice in adr-hooks.js überliest sie.
        mainFormula: `1d100${mode === "bonus" ? "b" : "p"}${extra}${modStr}`,
        mainIndividualResults,
        mainExploding: false,
        wildExploding: false,
        wildResult: undefined,
        wildFormula: undefined,
        wildIndividualResults: [],
        actorName: speaker.alias,
        actorImg,
        mainHighlight: false,
        wildHighlight: false,
        hideRecipients: (this.hiddenType === DiceForm.GM_ROLL) || (this.hiddenType === DiceForm.BLIND_ROLL),
        isSelfRoll: this.hiddenType === DiceForm.SELF_ROLL,
        isWildcard: !!actor?.system?.wildcard,
        dieType: "d100",
        dieCount: 1,
        keepMode: null,
        // Bonus-/Strafwurf-Daten (steuern Kopfzeilen-Icon und sperren Benny/Einsen-Regel).
        cthulhu: { mode, extra, ones: ev.ones, candidates: ev.candidates, chosenIndex: ev.chosenIndex },
        appliedModifier: sumMod,
        rollSeq: 1,
        nextRollSeq: 2,
      }
    };

    const fullContent = `<div class="adr-body">${hiddenText}${resultLines}</div>`;
    const gmIds = game.users.filter(u => u.isGM).map(u => u.id);
    const msgData = { content: fullContent, speaker, flavor, flags, rolls: [roll] };
    if (this.hiddenType === DiceForm.GM_ROLL) {
      msgData.whisper = gmIds;
    } else if (this.hiddenType === DiceForm.BLIND_ROLL) {
      msgData.whisper = gmIds;
      msgData.blind = true;
    } else if (this.hiddenType === DiceForm.SELF_ROLL) {
      msgData.whisper = [game.user.id];
    }
    DiceForm._emitChatMessage(msgData);
    if (this.closeFormOnRoll) this.close();
  }

  /**
   * Chat-Nachricht für einen Wurf aus dem Würfelfenster.
   *
   * Bei chatDesign "standard" werden content, ADR-Flags und flavor
   * weggelassen; Foundry rendert die generische Würfelkarte aus dem
   * rolls-Array, und der renderChatMessageHTML-Hook steigt ohne Flags früh
   * aus (kein ADR-Render, kein Benny-Button). Speaker, rolls (Dice So Nice)
   * und whisper/blind bleiben in beiden Fällen erhalten.
   *
   * @param {object} msgData  Voll aufgebautes ChatMessage-Datenobjekt.
   * @returns {Promise<ChatMessage>}
   */
  static _emitChatMessage(msgData) {
    const design = game.settings.get(ADR.ID, "chatDesign");
    if (design !== "standard") {
      return ChatMessage.create(msgData);
    }

    const stdData = {
      speaker: msgData.speaker,
      rolls: msgData.rolls
    };
    if (msgData.whisper) stdData.whisper = msgData.whisper;
    if (msgData.blind) stdData.blind = msgData.blind;
    return ChatMessage.create(stdData);
  }
}

/* ----------------------------------------------------------- */
/*  Globale Event-Listener (Fate-Roll, Gruppen-Button)         */
/* ----------------------------------------------------------- */

Hooks.once("ready", () => {
  document.body.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".adr-group-button[data-value='yes']");
    if (!btn) return;
    btn.classList.toggle("selected");
  });

  document.body.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action=\"fate-roll\"]");
    if (!button) return;
    const selected = canvas.tokens.controlled;
    if (!selected.length) {
      ui.notifications.warn(game.i18n.localize(`${ADR.ID}.warn.selectToken`));
      return;
    }
    const formEl = button.closest(".application");
    const yesBtn = formEl?.querySelector(".adr-group-button[data-value='yes']");
    const showGroup = !!yesBtn?.classList.contains("selected");
    const chosen = selected[Math.floor(Math.random() * selected.length)];
    const chosenName = foundry.utils.escapeHTML(chosen?.name || "—");
    const candidates = selected.map(t => foundry.utils.escapeHTML(t?.name || "—"));
    const namesList = candidates.join(", ");
    const label = game.i18n.localize("argas-dice-roller.chat.fateTitle");
    const content = `
<div class="adr-fate">
  <div class="adr-fate-name">${chosenName}</div>
  <div class="adr-fate-sub">${game.i18n.localize("argas-dice-roller.chat.fateChosen")}</div>
  ${showGroup ? `<div class="adr-fate-sub adr-fate-candidates">${game.i18n.format("argas-dice-roller.chat.fateCandidates", { names: namesList })}</div>` : ""}
</div>`.trim();
    ChatMessage.create({
      user: game.user.id,
      content,
      speaker: { alias: label },
      flags: { [ADR.ID]: { fate: true } }
    });
  });
});
