/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright (C) 2026 Arga-Mods */

import { ADR } from "./adr-constants.js";
import {
  _fireTraitRollHook,
  _renderDicePrecomputed,
  _buildInlineRollContent,
} from "./adr-request-roll-chat.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Baut die HTML-Struktur für den "Versteckter Wurf"-Hinweistext.
 * Jede Zeile (durch \n im i18n-String getrennt) wird als eigenes <div>
 * (nativ Block-Level) mit Inline-Styles gerendert — damit der Umbruch
 * unabhängig von gecachten/kollidierenden CSS-Regeln immer wirkt.
 * Die erste Zeile (`~ Label ~`) bekommt zusätzlich `white-space: nowrap`,
 * damit sie nie mitten in der Beschriftung umbricht — auch nicht bei
 * kleiner Schriftart oder schmalem Chat. Folgezeilen können normal umbrechen.
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
 * Würfel-Modifikator passend zum „Explosionswürfel"-Dropdown (Setting
 * `explodingMode`):
 *   - "once" → "xo"  (Foundry: Würfel explodiert genau einmal)
 *   - sonst  → "x"   (mehrfach/rekursiv explodierend)
 * Einzige Quelle der Wahrheit für reguläre Würfe UND die Reroll-Rebuilds.
 */
export function adrExplodingModifier() {
  return game.settings.get(ADR.ID, ADR.CONFIG_EXPLODING_MODE) === "once" ? "xo" : "x";
}

/**
 * Baut die Einzelergebnis-Anzeige eines Würfel-Terms: pro Original-Würfel
 * eine via <sup>ex</sup> verkettete Explosionskette plus min/max-CSS-Klasse.
 *
 * Wichtig: Foundry hängt Explosionswürfel ans ENDE des `results`-Arrays an,
 * NICHT direkt hinter ihren Elternwürfel. Bei Würfen mit mehreren Würfeln
 * in einem Term (z. B. 6W4) ergäbe eine reine „aufeinanderfolgende
 * explodierte Würfel"-Verkettung daher falsche Gruppen. Da Foundrys
 * Explosionsschleife streng in Array-Reihenfolge läuft und pro Explosion
 * genau einen Würfel anhängt, entspricht der k-te explodierte Würfel
 * (in Array-Reihenfolge) dem k-ten angehängten Explosionswürfel — damit
 * lässt sich die Eltern-Kind-Zuordnung exakt rekonstruieren (gilt für
 * mehrfaches wie einmaliges Explodieren gleichermaßen).
 *
 * @param {object} dieTerm  Foundry-Würfel-Term (mit .number, .faces, .results)
 * @returns {{value:string, display:string, class:string}[]}
 */
export function adrBuildDieResults(dieTerm) {
  if (!dieTerm?.results?.length) return [];
  const results = dieTerm.results;
  const faces = dieTerm.faces;
  const n = dieTerm.number;

  // Eltern-Kind-Zuordnung: jeder explodierte Würfel bekommt – in
  // Array-Reihenfolge – den nächsten angehängten Explosionswürfel.
  let childPtr = n;
  const childOf = new Map();
  for (let i = 0; i < results.length; i++) {
    if (results[i].exploded) childOf.set(i, childPtr++);
  }

  // Pro Original-Würfel die Kette über die childOf-Verkettung einsammeln.
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
    out.push({ value: display, display, class: cssClass });
  }
  return out;
}

export class DiceForm extends HandlebarsApplicationMixin(ApplicationV2) {

  static GM_ROLL = "makeGMRoll";
  static BLIND_ROLL = "makeBlindRoll";
  static SELF_ROLL = "makeSelfRoll";
  static STANDARD_DICE = ["d2","d4","d6","d8","d10","d12","d20"];

  // Grenzen für den händischen Modifikator-Eingabewert (zweistellig + Vorzeichen).
  // Identisch zu den Werten im Probenanforderungsfenster (adr-request-roll-form.js).
  static MODIFIER_MIN = -99;
  static MODIFIER_MAX = 99;


  /** @override */
  static DEFAULT_OPTIONS = {
    id: "dice-form",
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
    // Verdeckte Würfe starten öffentlich. Beim Öffnen setzt
    // _resetVolatileSettings() ohnehin auf die Defaults zurück.
    this.hiddenType = null;
    this.isExploding = false;
    this.isWildDie = false;
    this.enableHiddenRolls = game.settings.get(ADR.ID, ADR.CONFIG_HIDDEN_ROLLS);
    this.explodingMode = game.settings.get(ADR.ID, ADR.CONFIG_EXPLODING_MODE);
    this.showExplodingToggle = (this.explodingMode !== "off");
    this.explodingDefault = game.settings.get(ADR.ID, ADR.CONFIG_EXPLODING_DEFAULT);
    if (this.showExplodingToggle && this.explodingDefault) this.isExploding = true;
    this.enableFirstColumn = game.settings.get(ADR.ID, ADR.CONFIG_1ST_COLUMN);
    this.closeFormOnRoll = game.settings.get(ADR.ID, ADR.CONFIG_CLOSE_FORM);
    this.enableCoins = game.settings.get(ADR.ID, ADR.CONFIG_COINS);
    this.enableD2 = game.settings.get(ADR.ID, ADR.CONFIG_D2);
    this.enableD100 = game.settings.get(ADR.ID, ADR.CONFIG_D100);
    // Wild Die ist eine reine SWADE-Mechanik. Zusätzlich zum
    // settings-seitigen Gate (config/default = isSwade in adr-hooks.js)
    // hier ein harter System-Check: ein in einer früheren SWADE-Welt
    // gespeicherter `true`-Wert darf in einem Nicht-SWADE-System weder
    // den Toggle anzeigen noch aktiv sein.
    this.showWildToggle = game.system.id === "swade"
      && game.settings.get(ADR.ID, ADR.CONFIG_WILD_DIE);
    this.showModifiers = game.settings.get(ADR.ID, ADR.CONFIG_MODIFIERS);
    // Über die Buttons ausgewählte Modifikatoren (nur für Button-Optik +
    // Toggle-Logik). Die effektive Wurfsumme liefert this.manualModifier.
    this.modifiers = [];
    // Effektiver Modifikator (Wert des händischen Eingabefelds). Wird bei
    // jedem Button-Klick aus der Button-Summe gespiegelt und ist die
    // alleinige Quelle für den Wurf (_getEffectiveModifier()).
    this.manualModifier = 0;
    // true, sobald der GM von Hand ins Feld tippt → Buttons werden gesperrt.
    // Wird wieder false, sobald das Feld geleert wird.
    this.modifierLocked = false;

    // ── Multi-Würfel-Auswahl (Strg+Klick) ──
    // Auswahl überlebt Re-Render (z. B. nach Maximize), daher als
    // stabile Map<string, {type, count}> mit Key "type|count" — nicht
    // als Set<HTMLElement>, denn die Elemente werden bei Re-Render
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
    const types = [];
    if (this.enableCoins) types.push("dc");
    if (this.enableD2) types.push("d2");
    types.push(...DiceForm.STANDARD_DICE.filter(d => d !== "d2"));
    if (this.enableD100) types.push("d100");
    return types;
  }

  /* --------------------------------------------------------- */
  /*  Template-Kontext  (ersetzt V1 getData)                   */
  /* --------------------------------------------------------- */

  /** @override */
  async _prepareContext(options) {
    const maxCount = game.settings.get(ADR.ID, ADR.CONFIG_MAXDICE_COUNT);
    const offset = this.enableFirstColumn ? 0 : 1;
    const totalCols = maxCount - offset;

    // hiddenType ist reiner Fenster-Zustand: gesetzt vom Klick
    // (_setHiddenRoll), beim Öffnen über _resetVolatileSettings() auf
    // "öffentlich" zurückgesetzt. Bewusst KEIN Bezug zu einem Foundry-
    // Würfelmodus-Setting — core.rollMode ist seit v14 deprecatet.

    return {
      enableHiddenRolls: this.enableHiddenRolls,
      showExplodingToggle: this.showExplodingToggle,
      showWildToggle: this.showWildToggle,
      showModifiers: this.showModifiers,
      // Anzeigewert für das händische Modifikator-Feld (State-Erhalt bei Re-Render).
      modifierDisplay: this._formatModifierForInput(this.manualModifier),
      user: game.user,
      enableFateRollButton: game.settings.get(ADR.ID, "enableFateRollButton"),
      enableRequestRoll: game.settings.get(ADR.ID, ADR.CONFIG_REQUEST_ROLL),
      showFirstColumn: this.enableFirstColumn,
      modulePath: game.modules.get(ADR.ID)?.path || `modules/${ADR.ID}`,

      // Toggle-Zustände für State-Erhalt bei Re-Render
      isExploding: this.isExploding,
      isWildDie: this.isWildDie,
      isGMRoll: this.hiddenType === DiceForm.GM_ROLL,
      isBlindRoll: this.hiddenType === DiceForm.BLIND_ROLL,
      isSelfRoll: this.hiddenType === DiceForm.SELF_ROLL,

      diceRows: this._getDiceTypes().map(die => {
        const isGerman = game.i18n.lang.startsWith("de");
        const label = die === "dc"
          ? game.i18n.localize("argas-dice-roller.legend.coin")
          : (isGerman ? die.replace(/^d/, "W") : die);

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

    // Scale + Position initial setzen, Observer für spätere Änderungen starten
    this._applyUiScale();
    this._setupUiScaleObserver();

    // Window-Level-Listener für Strg-Tastendruck einrichten (Multi-Würfel-
    // Auswahl). Window-Listener statt Form-Listener, damit Strg auch dann
    // detektiert wird, wenn der Fokus nicht im Würfelfenster liegt.
    this._setupCtrlListeners();
  }

  /* --------------------------------------------------------- */
  /*  UI-Scaling: CSS-Klasse mit !important (nötig wegen       */
  /*  ApplicationV2) + MutationObserver auf --ui-scale Element */
  /*  für Live-Updates (wie Day-Night Slider)                  */
  /* --------------------------------------------------------- */

  /** Scale lesen und per CSS-Variable + Klasse anwenden */
  _applyUiScale() {
    // Primär: CSS-Variable --ui-scale (wie Day-Night Slider)
    const scaleEl = this._uiScaleEl ?? document.documentElement;
    let scale = parseFloat(getComputedStyle(scaleEl).getPropertyValue("--ui-scale")) || 0;
    // Fallback: game.settings (falls CSS-Variable nicht verfügbar)
    if (!scale) scale = game.settings.get("core", "uiConfig")?.uiScale ?? 1;

    const el = this.element;
    // CSS-Klasse + Variable: wird per !important-Regel angewendet (übertrumpft ApplicationV2)
    el.style.setProperty("--adr-ui-scale", scale);
    if (scale !== 1) {
      el.classList.add("adr-scaled");
    } else {
      el.classList.remove("adr-scaled");
    }

    // Position rechts neben der Toolbar
    // getBoundingClientRect liefert visuelle (post-transform) Koordinaten
    // Offsets mitskalieren, damit der Abstand proportional bleibt
    const toolbar = document.querySelector("#ui-left > *:first-child");
    if (toolbar) {
      const rect = toolbar.getBoundingClientRect();
      this.setPosition({ left: rect.right + 18 * scale, top: rect.top + 42 * scale });
    }
  }

  /** Elternelement mit --ui-scale finden und MutationObserver starten */
  _setupUiScaleObserver() {
    // Dasselbe Element wie der Day-Night Slider:
    // ui-top → nächstes Elternelement das --ui-scale im style hat
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
   * Beim Minimieren flüchtige Einstellungen zurücksetzen.
   * Override greift bei Doppelklick auf Titelleiste, Minimize-Button und API.
   */
  async minimize() {
    this._resetVolatileSettings();
    return super.minimize();
  }

  /**
   * Beim Wiederherstellen erst Foundrys Restore-Animation komplett durchlaufen
   * lassen, dann das DOM neu rendern. Würde render() während der Animation
   * laufen, wird das Element unter der Animation ausgetauscht und der
   * Übergang bricht sichtbar ab.
   */
  async maximize() {
    const result = await super.maximize();
    this.render();
    return result;
  }

  /**
   * Beim Öffnen aus geschlossenem Zustand die flüchtigen Würfel-
   * Einstellungen auf die in den Spieleinstellungen festgelegten
   * Defaults zurücksetzen. Bei Re-Renders eines bereits offenen
   * Fensters (`rendered === true`, z. B. nach Maximize oder einer
   * Setting-Änderung) wird NICHT zurückgesetzt — sonst ginge der
   * Zustand mitten in der Bedienung verloren.
   * @override
   */
  async render(...args) {
    if (!this.rendered) this._resetVolatileSettings();
    return super.render(...args);
  }

  /**
   * Setzt die flüchtigen Würfel-Einstellungen (Modifikatoren, verdeckte
   * Würfe, Wild Die, Explosionswürfel) auf ihre Defaults zurück.
   * Wird beim Öffnen, Minimieren und Schließen aufgerufen.
   */
  _resetVolatileSettings() {
    // Verdeckte Würfe: zurück auf "öffentlich". Fester Default — es gibt
    // kein Game-Setting dafür; ein Zurücklesen aus core.rollMode wäre
    // unter Foundry v14 zudem unzuverlässig.
    this.hiddenType = null;
    // Explosionswürfel: auf den in den Spieleinstellungen festgelegten
    // Default. Frisch aus dem Setting gelesen, damit immer der aktuell
    // konfigurierte Wert greift. Ist die Schaltfläche ausgeblendet
    // (explodingMode === "off"), bleibt isExploding zwingend aus.
    this.isExploding = this.showExplodingToggle
      && !!game.settings.get(ADR.ID, ADR.CONFIG_EXPLODING_DEFAULT);
    // Modifikatoren und Wild Die haben keinen Setting-Default → aus.
    this.isWildDie = false;
    this.modifiers = [];
    this.manualModifier = 0;
    this.modifierLocked = false;
    // Multi-Auswahl ist flüchtig.
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

    // Verdeckte Würfe – Checkboxen
    el.querySelectorAll("input[name='hiddenRoll']").forEach(input => {
      input.addEventListener("change", this._setHiddenRoll.bind(this));
    });

    // Explosionswürfel
    const exploding = el.querySelector("#explodingDice");
    if (exploding) exploding.addEventListener("change", ev => { this.isExploding = ev.target.checked; });

    // Wild Die
    const wildDie = el.querySelector("#wildDie");
    if (wildDie) wildDie.addEventListener("change", ev => { this.isWildDie = ev.target.checked; });

    // Würfeln (mit Strg+Klick-Detection für Multi-Würfel-Auswahl)
    el.querySelectorAll(".rollable").forEach(btn => {
      btn.addEventListener("click", this._handleDiceClick.bind(this));
    });

    // Modifikatoren
    el.querySelectorAll(".adr-modifier").forEach(btn => {
      btn.addEventListener("click", this._onModifierClick.bind(this));
    });

    // Modifier-Zustand wiederherstellen (nach Re-Render)
    el.querySelectorAll(".adr-modifier").forEach(btn => {
      const mod = Number(btn.dataset.modifier);
      if (this.modifiers.includes(mod)) btn.classList.add("selected");
    });

    // ── Händisches Modifikator-Eingabefeld ──
    // Ersetzt die früheren ±8-Buttons. Funktioniert wie das Feld im
    // Probenanforderungsfenster: eine Zahl ohne Vorzeichen wird beim
    // Verlassen des Felds automatisch mit "+" versehen.
    const modInput = el.querySelector("[data-action='set-manual-modifier']");
    if (modInput) {
      // Tippen: State aktualisieren. Jede händische Eingabe sperrt die
      // Buttons; ein geleertes Feld gibt sie wieder frei.
      modInput.addEventListener("input", (ev) => {
        const v = String(ev.currentTarget.value).trim();
        if (v === "") {
          // Feld geleert → Buttons wieder freigeben, kein Modifikator.
          this.modifierLocked = false;
          this.manualModifier = 0;
        } else {
          // Händische Eingabe → Buttons sperren und ihre Auswahl verwerfen.
          this.modifierLocked = true;
          this.modifiers = [];
          this.element?.querySelectorAll(".adr-modifier.selected")
            .forEach(b => b.classList.remove("selected"));
          // Wert parsen und auf [MODIFIER_MIN .. MODIFIER_MAX] begrenzen.
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
      // Verlassen des Felds: Anzeige aufs kanonische Format normalisieren
      // ("2" → "+2"). Eine evtl. Begrenzung wird hier sichtbar ("999" → "+99").
      modInput.addEventListener("blur", (ev) => {
        const formatted = this._formatModifierForInput(this.manualModifier);
        ev.currentTarget.value = formatted;
        // Falls die Normalisierung das Feld leert (z. B. nach unparsbarer
        // Eingabe oder einer "0" → manualModifier 0), die Buttons wieder
        // freigeben — leeres Feld bedeutet immer "Buttons benutzbar".
        if (formatted === "" && this.modifierLocked) {
          this.modifierLocked = false;
          this._refreshModifierButtonsDisabled();
          this._syncModActiveClass();
        }
      });
    }

    // Gesperrt-Optik der Buttons nach (Re-)Render anwenden.
    this._refreshModifierButtonsDisabled();
    // Münz-Sperroptik mit dem wiederhergestellten Zustand abgleichen.
    this._syncModActiveClass();

    // Multi-Selection visuell wiederherstellen (nach Re-Render). State ist
    // in this._multiSelection (Map keyed nach "type|count") — buttons werden
    // anhand der data-Attribute abgeglichen.
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
    // hiddenType ist reiner Fenster-Zustand. Es wird bewusst NICHT in ein
    // Foundry-Setting geschrieben: core.rollMode ist seit v14 zugunsten
    // von core.messageMode deprecatet (Kompatibilität fällt mit v16 weg).
    // Den verdeckten Wurf setzt _rollDie ohnehin direkt über whisper/blind.
  }

  _onModifierClick(event) {
    // Bei händischer Eingabe sind die Buttons gesperrt — Klick ignorieren.
    // (CSS unterbindet den Klick bereits via pointer-events; dies ist die
    // zweite Absicherung auf JS-Ebene.)
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
    // Button-Summe ins händische Feld spiegeln. Das direkte Setzen von
    // `.value` löst KEIN input-Event aus — die Buttons bleiben also
    // entsperrt, anders als bei echter Tastatureingabe.
    this.manualModifier = this.modifiers.reduce((a, b) => a + b, 0);
    const inp = this.element?.querySelector("[data-action='set-manual-modifier']");
    if (inp) inp.value = this._formatModifierForInput(this.manualModifier);
    this._syncModActiveClass();
  }

  /**
   * Formatiert einen Modifikator-Zahlenwert für die Anzeige im Eingabefeld:
   * 0 (oder ungültig) → "" (Platzhalter "0" wird sichtbar), positive Werte
   * mit explizitem "+", negative mit "-".
   */
  _formatModifierForInput(n) {
    if (!Number.isFinite(n) || n === 0) return "";
    return n > 0 ? `+${n}` : String(n);
  }

  /**
   * Liefert den effektiven Modifikator für den Wurf — den händischen
   * Feldwert, der bei Button-Klicks aus der Button-Summe gespiegelt wird.
   * Defensiv auf [MODIFIER_MIN .. MODIFIER_MAX] begrenzt.
   */
  _getEffectiveModifier() {
    const m = Number.isFinite(this.manualModifier) ? this.manualModifier : 0;
    return Math.max(DiceForm.MODIFIER_MIN, Math.min(DiceForm.MODIFIER_MAX, m));
  }

  /**
   * Wendet die Sperr-Optik (`adr-modifier-disabled`) auf alle Modifikator-
   * Buttons an — abhängig davon, ob der GM von Hand ins Feld getippt hat.
   */
  _refreshModifierButtonsDisabled() {
    this.element?.querySelectorAll(".adr-modifier").forEach(btn => {
      btn.classList.toggle("adr-modifier-disabled", this.modifierLocked);
    });
  }

  /**
   * Hält die Window-Klasse `adr-mod-active` mit dem Modifikator-Zustand
   * synchron. Steuert die CSS-Sperroptik der Münzzelle (not-allowed-
   * Cursor + gedämpfte Optik beim Hover), solange ein Modifikator aktiv
   * ist — Münzwürfe nehmen keine Modifikatoren an.
   */
  _syncModActiveClass() {
    this.element?.classList.toggle("adr-mod-active", this._getEffectiveModifier() !== 0);
  }

  /* --------------------------------------------------------- */
  /*  Multi-Würfel-Auswahl (Strg+Klick)                        */
  /* --------------------------------------------------------- */

  /**
   * Registriert Window-Level-Listener für Strg-Tastendruck/-Loslassen.
   * Window statt Form, damit Strg auch ohne Fokus im Würfelfenster greift
   * (User kann z. B. Strg drücken während Maus über die Buttons fährt,
   * ohne vorher die Form-Titelleiste anzuklicken).
   *
   * Verhalten:
   *   - keydown mit ctrlKey → CSS-Klasse `adr-ctrl-active` an die Application-
   *     Root, Hover-Style wird damit orange (CSS-Regel in argas-dice-roller.css).
   *   - keyup mit Key "Control" → Klasse weg + Wurf auslösen, wenn Auswahl da.
   *   - window.blur → Klasse weg (Auswahl behalten, User kommt ggf. zurück).
   */
  _setupCtrlListeners() {
    this._onCtrlKeydown = (ev) => {
      if (!ev.ctrlKey) return;
      if (!this.element || this._ctrlActive) return;
      this._ctrlActive = true;
      this.element.classList.add("adr-ctrl-active");
    };
    this._onCtrlKeyup = (ev) => {
      // Reagiert auf das Loslassen der Strg-Taste. Bei Tastenkombinationen
      // (z. B. Strg+Shift) kann ein zweites keyup ohne Control kommen — daher
      // explizit auf ev.key prüfen, nicht nur auf !ev.ctrlKey.
      if (ev.key !== "Control" && ev.ctrlKey) return;
      if (!this._ctrlActive) return;
      this._ctrlActive = false;
      this.element?.classList.remove("adr-ctrl-active");
      // Auswahl vorhanden? → Multi-Pool-Wurf auslösen.
      if (this._multiSelection.size > 0) {
        // Fire-and-forget (async). Fehler werden intern geloggt.
        this._rollMultiPool().catch(err => {
          console.error(`${ADR.ID} | Multi-Pool-Wurf-Fehler:`, err);
        });
      }
    };
    this._onCtrlBlur = () => {
      // Fenster verliert den Fokus während Strg evtl. noch gedrückt ist
      // (Alt-Tab o. ä.). Visuell zurücksetzen, Auswahl behalten — User kann
      // beim Zurückkommen Strg neu drücken+loslassen, um zu würfeln.
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

  /**
   * Räumt die Multi-Auswahl auf — sowohl State (Map) als auch Visuals
   * (entfernt `.adr-multi-selected`-Klassen aus dem DOM). Wird bei normalem
   * (Nicht-Strg-)Klick aufgerufen, bei Reset/Minimize, und nach dem
   * Multi-Pool-Wurf selbst.
   */
  _clearMultiSelection() {
    if (this._multiSelection) this._multiSelection.clear();
    this.element?.querySelectorAll(".adr-col.adr-multi-selected").forEach(el => {
      el.classList.remove("adr-multi-selected");
    });
  }

  /**
   * Zentraler Dispatcher für Klicks auf Würfel-Buttons.
   *
   * Ohne Strg → bestehende Auswahl verwerfen, sofort `_rollDie` (alter Pfad).
   * Mit Strg → Toggle der Auswahl (orange Hervorhebung). Münze ist im Multi-
   *   Modus gesperrt (Spec: produziert binär 0/1, passt nicht in eine
   *   numerische Mischpool-Summe).
   */
  _handleDiceClick(event) {
    const ctrlPressed = !!event.ctrlKey;
    const btn = event.currentTarget;
    const type = String(btn.dataset.diceType);
    const count = Number(btn.dataset.diceRoll);

    if (!ctrlPressed) {
      // Münze + aktiver Modifikator: Münzwürfe nehmen keine
      // Modifikatoren an. Statt den Modifikator still zu schlucken,
      // wird der Wurf blockiert — die Münzzelle zeigt beim Hover bereits
      // den durchgestrichenen Cursor. Der User soll den Modifikator
      // bewusst entfernen, bevor er die Münze wirft.
      if (type === "dc" && this._getEffectiveModifier() !== 0) {
        ui.notifications.warn(game.i18n.localize(`${ADR.ID}.warn.coinNoModifier`));
        return;
      }
      // Bestehende Multi-Auswahl verwerfen + sofort werfen wie bisher.
      // _clearMultiSelection schon hier — sonst zeigt der Button-Hover bis
      // zum nächsten Frame noch die orange Markierung.
      if (this._multiSelection.size > 0) this._clearMultiSelection();
      return this._rollDie(event);
    }

    event.preventDefault();
    event.stopPropagation();

    // Münze: nicht selektierbar im Multi-Modus
    if (type === "dc") {
      ui.notifications.warn(game.i18n.localize(`${ADR.ID}.warn.coinNotInMulti`));
      return;
    }

    const key = `${type}|${count}`;
    if (this._multiSelection.has(key)) {
      // Toggle off — entfernt den Würfel aus der Auswahl
      this._multiSelection.delete(key);
      btn.classList.remove("adr-multi-selected");
    } else {
      // Hinzufügen
      this._multiSelection.set(key, { type, count });
      btn.classList.add("adr-multi-selected");
    }
  }

  /**
   * Extrahiert pro Pool-Kategorie die Einzelergebnisse aus einem Roll mit
   * mehreren Würfel-Termen. Exploding-Chain-Logik analog zu Einzelwurf:
   * aufeinanderfolgende explodierte Würfel werden zu einem `<sup>ex</sup>`-
   * verketteten Display zusammengefasst.
   *
   * Rückgabe: `[{ type, count, faces, results: [{value,display,class}, …] }, …]`
   * (gleiche Reihenfolge wie der Pool im Roll).
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
   * Multi-Pool-Wurf. Sammelt die aktuelle Strg+Klick-Auswahl, konsolidiert
   * gleiche Würfeltypen (z. B. "2x W4" + "3x W4" → "5x W4"), und wirft den
   * gesamten Pool auf einmal.
   *
   * Sonderfall: nach Konsolidierung nur 1 Kategorie → Pfad zurück in den
   * normalen Einzelwurf (`_rollDie`), damit die volle Pipeline inkl.
   * Tweaks-Hook und Patzer-Mechanik greift.
   *
   * Bei ≥ 2 Kategorien (echter Multi-Pool):
   *   - Roll wird als zusammengesetzter Term-Array gebaut (Würfel mit
   *     `+`-Operatoren dazwischen, dann Modifikator).
   *   - Wild Die: ein einzelner globaler W6 (explodierend) wie bei Einzelwurf,
   *     wenn Toggle aktiv.
   *   - Tweaks-Hook wird übergangen (Spec) — bei großen Mischpools wäre der
   *     Dialog unübersichtlich. GM bekommt einen Hinweis.
   *   - Patzer-Mechanik wird übergangen (Spec) — kein Eigenschaftsprobe-
   *     Charakter bei Mischpools.
   */
  async _rollMultiPool() {
    // Snapshot der Auswahl, dann clearen (vor await — Race-Conditions vermeiden,
    // falls währenddessen ein zweiter Wurf getriggert wird).
    const rawEntries = Array.from(this._multiSelection.values());
    this._clearMultiSelection();
    if (rawEntries.length === 0) return;

    // Speaker-Check (Gruppen/Fahrzeug nicht erlaubt) — analog `_rollDie`
    const _checkSpeaker = ChatMessage.getSpeaker();
    const _checkActor = game.actors.get(_checkSpeaker.actor);
    if (_checkActor && (_checkActor.type === "vehicle" || _checkActor.type === "group")) {
      ui.notifications.warn(game.i18n.localize(`${ADR.ID}.warn.cannotRollAsGroupOrVehicle`));
      return;
    }

    // Konsolidierung: gleiche Typen aufaddieren, Reihenfolge bleibt nach
    // erster Erwähnung erhalten.
    const consolidated = new Map();
    for (const { type, count } of rawEntries) {
      consolidated.set(type, (consolidated.get(type) || 0) + count);
    }
    const pool = Array.from(consolidated.entries()).map(([type, count]) => {
      const faces = Number(String(type).replace(/^[dDwW]/, "")) || 0;
      return { type, count, faces };
    });

    // Sonderfall: nach Konsolidierung nur 1 Kategorie → behandelt wie
    // normaler Einzelwurf (volle Pipeline). Pseudo-Event mit dataset
    // konstruieren, damit `_rollDie` denselben Pfad nimmt wie ein direkter
    // Button-Klick.
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

    // Term-Array: Würfel + Operator + Würfel + Operator + … + Modifikator
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

    // Wild Die (optional, ein einzelner globaler W6)
    let wildRoll = null;
    if (this.isWildDie) {
      const wildTerms = [new foundry.dice.terms.Die({ number: 1, faces: 6, modifiers: [adrExplodingModifier()] })];
      if (sumMod !== 0) {
        wildTerms.push(new foundry.dice.terms.OperatorTerm({ operator: sumMod > 0 ? "+" : "-" }));
        wildTerms.push(new foundry.dice.terms.NumericTerm({ number: Math.abs(sumMod) }));
      }
      wildRoll = await Roll.fromTerms(wildTerms).evaluate();
    }

    // Tweaks-Hook wird bei Multi-Pool übergangen (Spec): bei mehreren
    // Würfel-Kategorien wäre der Bearbeitungs-Dialog unübersichtlich.

    // Einzelergebnisse pro Kategorie (für Detail-Toggle)
    const multiPoolResults = this._extractMultiPoolResults(mainRoll, pool);
    // Flache Liste für Backward-Compat mit bestehenden Helpern, die
    // `mainIndividualResults` als flaches Array erwarten.
    const mainIndividualResults = multiPoolResults.flatMap(c => c.results);

    // Wild Die-Einzelergebnisse (identisch zur Einzelwurf-Logik)
    let wildIndividualResults = [];
    if (wildRoll?.dice?.length) {
      wildIndividualResults = adrBuildDieResults(wildRoll.dice[0]);
    }

    // Hidden-Roll-Info (analog Einzelwurf)
    let hiddenText = "";
    if (this.hiddenType === DiceForm.GM_ROLL)
      hiddenText = `<div class="adr-hidden-info" data-adr-hidden-key="gmRoll" style="font-size:0.9rem;margin:0;color:#e56917;font-weight:bold;text-align:center;"></div>`;
    else if (this.hiddenType === DiceForm.BLIND_ROLL)
      hiddenText = `<div class="adr-hidden-info" data-adr-hidden-key="blindRoll" style="font-size:0.9rem;margin:0;color:#e56917;font-weight:bold;text-align:center;"></div>`;
    else if (this.hiddenType === DiceForm.SELF_ROLL)
      hiddenText = `<div class="adr-hidden-info" data-adr-hidden-key="selfRoll" style="font-size:0.9rem;margin:0;color:#e56917;font-weight:bold;text-align:center;"></div>`;

    // Detail-Toggle: Marker für sprach-empfänger-korrekte client-seitige
    // Rendering (analog data-adr-i18n / data-adr-hidden-key). Der Inhalt
    // wird in `renderChatMessageHTML` aus `multiPoolResults` rekonstruiert.
    const toggleLabelAttr = `data-adr-i18n="argas-dice-roller.individualResults.toggle"`;
    const resultLines = `<div class="adr-individual-toggle-container">`
      + `<div class="adr-individual-toggle" ${toggleLabelAttr}></div>`
      + `<div class="adr-individual-details adr-individual-hidden">`
      + `<div class="adr-individual adr-individual-multi" data-adr-multi-details="1"></div>`
      + `</div></div>`;

    // Speaker + Flags + Chat-Nachricht
    const speaker = ChatMessage.getSpeaker();
    const flavor = wildRoll
      ? game.i18n.format(`${ADR.ID}.chat.flavorMultiWild`, { total: mainRoll.total, wild: wildRoll.total })
      : game.i18n.format(`${ADR.ID}.chat.flavorMulti`, { total: mainRoll.total });
    const actor = game.actors.get(speaker.actor);
    const actorImg = actor?.prototypeToken?.texture?.src || actor?.img || "";

    const flags = {
      "argas-dice-roller": {
        mainResult: mainRoll.total,
        // mainFormula als Marker (truthig), damit die ADR-Erkennungs-Checks
        // in adr-hooks.js greifen. Eigentlicher Render läuft über multiPool /
        // multiPoolResults.
        mainFormula: "_multi_pool",
        mainIndividualResults,
        mainExploding: isExploding,
        wildExploding: !!this.isWildDie,
        wildResult: wildRoll?.total,
        wildFormula: wildRoll?.formula,
        wildIndividualResults,
        actorName: speaker.alias,
        actorImg,
        // Highlights nicht gesetzt → kein Patzer-Render (Spec).
        mainHighlight: false,
        wildHighlight: false,
        hideRecipients: (this.hiddenType === DiceForm.GM_ROLL) || (this.hiddenType === DiceForm.BLIND_ROLL),
        isSelfRoll: this.hiddenType === DiceForm.SELF_ROLL,
        isWildcard: !!actor?.system?.wildcard,
        // Multi-Pool-spezifische Flags
        multiPool: pool.map(p => ({ type: p.type, count: p.count, faces: p.faces })),
        multiPoolResults,
        // dieType/dieCount im Multi-Modus nicht eindeutig — null setzen,
        // damit Patzer-/Münzpfade defensiv defaulten.
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
    // Verdeckter Wurf ausschließlich über die Kern-Felder whisper/blind —
    // diese sind nicht deprecatet. Kein msgData.rollMode: der rollMode-
    // Begriff wurde in v14 durch messageMode ersetzt und fällt mit v16
    // weg. whisper (nicht leer) genügt; Foundry überschreibt es dann auch
    // nicht mehr mit dem globalen Modus.
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

    // ── Block: Würfeln als Aktor-Typ "group" oder "vehicle" verhindern. ──
    // SWADE-Aktoren dieses Typs haben keine Trait-Werte und sind nicht
    // wurffähig. Ein versehentlich selektiertes Gruppen-/Fahrzeug-Token
    // würde sonst mit irreführendem Speaker im Chat landen.
    const _checkSpeaker = ChatMessage.getSpeaker();
    const _checkActor = game.actors.get(_checkSpeaker.actor);
    if (_checkActor && (_checkActor.type === "vehicle" || _checkActor.type === "group")) {
      ui.notifications.warn(game.i18n.localize(`${ADR.ID}.warn.cannotRollAsGroupOrVehicle`));
      return;
    }

    const count = Number(event.currentTarget.dataset.diceRoll);
    const type = String(event.currentTarget.dataset.diceType);
    let faces;
    if (type === "dc") {
      faces = 2;
    } else {
      faces = Number(String(type).replace(/^[dDwW]/, "")) || 0;
    }
    // Münzwürfe (dc) nehmen grundsätzlich keine Modifikatoren an —
    // sumMod hart auf 0, unabhängig vom UI-Zustand. Greift als
    // Sicherheitsnetz auch dann, falls die UI-Sperre umgangen würde.
    const sumMod = (type === "dc")
      ? 0
      : this._getEffectiveModifier();
    const displayFormula = `${count}${type}${(this.isExploding && faces !== 100 && type !== "dc") ? "!" : ""}${sumMod !== 0 ? (sumMod > 0 ? `+${sumMod}` : `${sumMod}`) : ""}`;

    const dieTerm = new foundry.dice.terms.Die({
      number: count,
      faces,
      modifiers: (this.isExploding && faces !== 100 && type !== "dc") ? [adrExplodingModifier()] : []
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
    if (this.isWildDie && type !== "dc") {
      const wildTerms = [new foundry.dice.terms.Die({ number: 1, faces: 6, modifiers: [adrExplodingModifier()] })];
      if (sumMod !== 0) {
        wildTerms.push(new foundry.dice.terms.OperatorTerm({ operator: sumMod > 0 ? "+" : "-" }));
        wildTerms.push(new foundry.dice.terms.NumericTerm({ number: Math.abs(sumMod) }));
      }
      wildRoll = await Roll.fromTerms(wildTerms).evaluate();
    }

    /* --- Hook: argas-dice-roller:onTraitRoll (Argas Tweaks etc.) --- */
    // Greift in freie ADR-Würfe — nicht bei DC (binär 0/1, nicht sinnvoll
    // anpassbar). Pseudo-Roll bündelt Trait-Würfel + Wild Die wie ein
    // SWADE-Wildcard-Wurf; die `dice`-Einträge sind References auf die echten
    // Roll-Objekte, also wirken Hook-Modifikationen automatisch dort.
    if (type !== "dc") {
      // Schwelle: bei zu vielen Würfeln (Wild Die nicht mitgezählt) wird der
      // Hook nicht gefeuert — Hook-Empfänger sind in der Regel auf einzelne
      // Trait-Würfel ausgelegt. Schwelle kommt aus dem Tweaks-Modul (sofern
      // installiert), sonst greift sie nicht.
      const _tweaksActive = !!game.modules.get("argas-tweaks")?.active;
      let _tweaksTooMany = false;
      if (_tweaksActive) {
        const _tweaksMaxDice = game.settings.get("argas-tweaks", "maxDice") ?? Infinity;
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
          // Kennzeichnet ADR-freie-Würfe gegenüber Hook-Empfängern: Roll-
          // Struktur ist ein Pseudo-Roll mit N-Würfel-Haupt-Term + optionalem
          // Wild Die, KEINE SWADE-Trait-`kh`-Struktur. Tweaks schaltet damit
          // den Pool-Modus statt Wildcard-Modus.
          rollKind: "free",
          // Wurf-Eigenschaften, die Hook-Empfänger brauchen können:
          //  - exploding: ob die Haupt-Würfel explodieren. Wild Die hat IMMER
          //    Exploding (unabhängig vom Toggle, vgl. wildTerms oben).
          //  - hasWildDie: ob ein Wild Die mitgewürfelt wurde.
          //  - fumbleMechanic: SWADE-Patzer-Mechanik aktiv (ADR-Setting). Bei
          //    aktiver Mechanik darf ein erzwungener Niedrigwert keinen
          //    unbeabsichtigten Patzer erzeugen.
          exploding: (this.isExploding && faces !== 100 && type !== "dc"),
          hasWildDie: !!wildRoll,
          fumbleMechanic: !!game.settings.get(ADR.ID, ADR.CONFIG_HIGHLIGHT_ONES),
        };

        const _finalRoll = await _fireTraitRollHook(_hookData);
        if (_finalRoll === false) return;  // Vom Hook abgebrochen

        // Falls der Hook die Würfel-Ergebnisse verändert hat, muss `_total`
        // beider echter Rolls neu berechnet werden — Foundry cacht es nach
        // evaluate() und mainRoll/wildRoll referenzieren denselben dice-Eintrag.
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
      mainIndividualResults = adrBuildDieResults(mainRoll.dice[0]);
    }

    let wildIndividualResults = [];
    if (wildRoll?.dice?.length) {
      wildIndividualResults = adrBuildDieResults(wildRoll.dice[0]);
    }

    let mainHighlight = false, wildHighlight = false;
    if (game.settings.get(ADR.ID, ADR.CONFIG_HIGHLIGHT_ONES)) {
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

    /* --- Hidden-Info-Text --- */
    // Inhalt bewusst leer lassen und nur einen Marker (data-adr-hidden-key)
    // setzen — das Befüllen passiert client-seitig in renderChatMessageHTML,
    // damit Empfänger den Text in IHRER Interface-Sprache sehen (kein Sprachmix).
    let hiddenText = "";
    if (this.hiddenType === DiceForm.GM_ROLL)
      hiddenText = `<div class="adr-hidden-info" data-adr-hidden-key="gmRoll" style="font-size:0.9rem;margin:0;color:#e56917;font-weight:bold;text-align:center;"></div>`;
    else if (this.hiddenType === DiceForm.BLIND_ROLL)
      hiddenText = `<div class="adr-hidden-info" data-adr-hidden-key="blindRoll" style="font-size:0.9rem;margin:0;color:#e56917;font-weight:bold;text-align:center;"></div>`;
    else if (this.hiddenType === DiceForm.SELF_ROLL)
      hiddenText = `<div class="adr-hidden-info" data-adr-hidden-key="selfRoll" style="font-size:0.9rem;margin:0;color:#e56917;font-weight:bold;text-align:center;"></div>`;

    /* --- Einzelergebnis-Toggle --- */
    // Toggle-Beschriftung als data-adr-i18n Marker — clientseitig im
    // renderChatMessageHTML-Hook lokalisiert, damit Empfänger den Text in
    // ihrer Interface-Sprache sehen.

    let resultLines = "";
    // Münzwurf (dc): keine Einzelergebnis-/Benny-Zeile. Ohne den
    // Toggle-Container steigt _adrInjectFreeRollBennyButton ohnehin aus,
    // also entfällt damit auch der Benny-Reroll-Button.
    if ((mainIndividualResults.length || wildIndividualResults.length) && type !== "dc") {
      // Einreihiges Detail-Rendering analog Probenanforderung:
      //   "3 (WD: 2) (Mod. +2)" via _buildInlineRollContent.
      // mainIndividualResults/wildIndividualResults sind vorgekocht (display + class),
      // also _renderDicePrecomputed statt _renderDiceArr.
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
      : game.i18n.format(`${ADR.ID}.chat.flavorResult`, { total: mainRoll.total });

    const actor = game.actors.get(speaker.actor);
    const actorImg = actor?.prototypeToken?.texture?.src || actor?.img || "";

    const flags = {
      "argas-dice-roller": {
        mainResult: mainRoll.total,
        mainFormula: displayFormula,
        mainIndividualResults,
        mainExploding: (type !== "dc") && this.isExploding,
        wildExploding: !!this.isWildDie,
        wildResult: wildRoll?.total,
        wildFormula: wildRoll?.formula,
        wildIndividualResults,
        actorName: speaker.alias,
        actorImg,
        mainHighlight,
        wildHighlight,
        hideRecipients: (this.hiddenType === DiceForm.GM_ROLL) || (this.hiddenType === DiceForm.BLIND_ROLL),
        isSelfRoll: this.hiddenType === DiceForm.SELF_ROLL,
        // Wildcard-Status zum Wurfzeitpunkt festhalten (nur SWADE liefert
        // dieses Flag). Wird im renderChatMessageHTML-Hook benutzt, um den
        // GM-Patzer-Check-Button bei Wildcards zu unterdrücken: ein
        // Wildcard hätte bei einer Eigenschaftsprobe immer einen Wild Die
        // mitgewürfelt — ein Einzelwürfel ohne Wild Die kann also keine
        // Eigenschaftsprobe gewesen sein, der Check macht nur bei
        // Statisten Sinn.
        isWildcard: !!actor?.system?.wildcard,
        // Reroll-Kontext für den Benny-Button im freien Wurf: type + count +
        // angewendeter Modifier werden hier explizit abgelegt, weil sie
        // beim Reroll-Klick sonst nur fragil aus `mainFormula` parsbar
        // wären. `wildExploding` doppelt sich semantisch als „hasWildDie"
        // (Wild Die wird in `adr-dice-form.js` immer mit dem
        // explodingMode-Modifikator konstruiert, also gleichbedeutend
        // mit „explodierend, wenn da").
        dieType: type,
        dieCount: count,
        appliedModifier: sumMod,
        // Chronologische Sequenznummer dieses Wurfs (für korrekte Sortierung
        // der Einzelergebnisse bei Mehrfach-Bennies). Der Initialwurf hat
        // immer seq=1; jeder folgende Benny-Reroll bekommt die nächste
        // freie Nummer via flags.nextRollSeq (siehe _adrApplyBennyRerollFree).
        rollSeq: 1,
        nextRollSeq: 2
      }
    };

    const fullContent = `<div class="adr-body">${hiddenText}${resultLines}</div>`;
    const gmIds = game.users.filter(u => u.isGM).map(u => u.id);

    const rolls = [mainRoll];
    if (wildRoll) rolls.push(wildRoll);
    const msgData = { content: fullContent, speaker, flavor, flags, rolls };
    // Verdeckter Wurf ausschließlich über whisper/blind (Kern-Felder, nicht
    // deprecatet) — kein msgData.rollMode, siehe Erläuterung im Einzelwurf-
    // Pfad oben.
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
   * Erstellt die Chat-Nachricht für einen Wurf aus dem Würfelfenster.
   *
   * Je nach Einstellung "chatDesign":
   *  - "fantasy" / "modern": ADR-Eigengrafik wie bisher — das volle
   *    msgData (Custom-content, argas-dice-roller-Flags, ADR-flavor)
   *    wird unverändert übergeben; der renderChatMessageHTML-Hook
   *    erkennt die Nachricht an den Flags und rendert die ADR-Karte.
   *  - "standard": KEINE ADR-Eigengrafik. Custom-content, ADR-Flags und
   *    ADR-flavor werden weggelassen; übrig bleibt das, was Foundry aus
   *    dem rolls-Array selbst rendert — die generische, systemneutrale
   *    Foundry-Würfelkarte. Da keine argas-dice-roller-Flags gesetzt
   *    sind, steigt der renderChatMessageHTML-Hook früh aus (kein
   *    ADR-Render, kein ADR-Benny-Button).
   *
   * In beiden Fällen erhalten bleiben die Foundry-Kernfelder speaker,
   * rolls (für korrekte Darstellung + Dice-So-Nice) sowie whisper/blind
   * (verdeckte Würfe) — das ist keine ADR-Grafik, sondern Basisverhalten.
   *
   * @param {object} msgData  Voll aufgebautes ChatMessage-Datenobjekt.
   * @returns {Promise<ChatMessage>}
   */
  static _emitChatMessage(msgData) {
    const design = game.settings.get(ADR.ID, "chatDesign");
    if (design !== "standard") {
      return ChatMessage.create(msgData);
    }

    // Standard (Foundry): auf die Kernfelder reduzieren.
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
