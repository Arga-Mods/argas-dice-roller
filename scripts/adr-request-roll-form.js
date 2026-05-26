/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright (C) 2026 Arga-Mods */

import { ADR } from "./adr-constants.js";
import { createDramaticTaskMessageData, _getModifierDisplay } from "./adr-request-roll-chat.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * SWADE Attribute Keys — Reihenfolge wie im Regelwerk.
 */
export const SWADE_ATTRIBUTES = ["agility", "smarts", "spirit", "strength", "vigor"];

/**
 * SWADE Kernfertigkeiten — Erkennung über Name (lowercase).
 * Enthält EN-Originale + DE-Babele-Übersetzung.
 */
export const CORE_SKILL_NAMES = new Set([
  "athletics", "common knowledge", "notice", "persuasion", "stealth",
  "athletik", "allgemeinwissen", "wahrnehmung", "überreden", "heimlichkeit",
]);

/**
 * Ungeübt-Fertigkeiten — werden im UI gelb hervorgehoben.
 */
export const UNTRAINED_SKILL_NAMES = new Set([
  "unskilled attempt", "untrained",
  "ungeübt", "ungeübter versuch",
]);

/**
 * Erlaubter Modifikator-Bereich für die Probenanforderung.
 * Bereich -99..+99 (zweistellig + Vorzeichen) — identisch zum händischen
 * Feld im Würfelfenster.
 */
const MODIFIER_MIN = -99;
const MODIFIER_MAX = 99;

/**
 * Akteur per ID auflösen — PCs direkt, NPCs über Token-Dokumente in der Szene.
 * Wird u.a. aus dem Support-Dialog genutzt, der keine eigene NPC-Map hält.
 */
export function resolveActorById(id) {
  if (!id) return null;
  const pc = game.actors.get(id);
  if (pc) return pc;
  const tokenDoc = canvas?.scene?.tokens?.get?.(id);
  if (tokenDoc?.actor) return tokenDoc.actor;
  for (const t of canvas?.tokens?.placeables ?? []) {
    if (t.document?.id === id && t.actor) return t.actor;
  }
  return null;
}

/**
 * Attribute + Fertigkeiten eines Akteurs aufbereiten (Template-tauglich).
 * Identisch zur Instanzmethode _getActorTraits, nur als freistehende Funktion,
 * damit sie aus dem Support-Dialog wiederverwendet werden kann.
 */
export function collectActorTraits(actor) {
  const attributes = SWADE_ATTRIBUTES.map(key => {
    const attr = actor.system.attributes?.[key];
    if (!attr) return null;
    const label = resolveAttributeLabel(key);
    const dieSides = attr.die?.sides ?? 4;
    return { type: "attribute", key, name: label, dieSides };
  }).filter(Boolean);

  const allSkills = actor.items
    .filter(i => i.type === "skill")
    .map(i => ({
      type: "skill",
      key: i.id,
      name: i.name,
      dieSides: i.system.die?.sides ?? 4,
      isCore: CORE_SKILL_NAMES.has(i.name.toLowerCase()),
      isUntrained: UNTRAINED_SKILL_NAMES.has(i.name.toLowerCase()),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));

  const coreSkills = allSkills.filter(s => s.isCore);
  const otherSkills = allSkills.filter(s => !s.isCore);

  return { attributes, skills: allSkills, coreSkills, otherSkills };
}

/**
 * Chip-Grid-Spalten basierend auf Akteurszahl:
 *  1–4 → Spalten = Anzahl (1 Zeile, max 4)
 *  5–6 → 3 Spalten (also 3+2 bzw. 3+3)
 *  7+  → 4 Spalten (also 4+3, 4+4, 4+4+2, …)
 */
function _actorGridColumns(count) {
  if (count <= 1) return 1;
  if (count <= 4) return count;
  if (count <= 6) return 3;
  return 4;
}

const DRAMATIC_TASK_PRESETS = {
  standard: { key: "standard", markers: 3, rounds: 3 },
  challenging: { key: "challenging", markers: 4, rounds: 3 },
  hard: { key: "hard", markers: 6, rounds: 4 },
  complex: { key: "complex", markers: 8, rounds: 5 },
};

function _matchDramaticPreset(markers, rounds) {
  return Object.values(DRAMATIC_TASK_PRESETS).find(p => p.markers === markers && p.rounds === rounds)?.key ?? "custom";
}

/**
 * Attribut-Label aus SWADE-Lokalisierung auflösen.
 * Versucht verschiedene bekannte Key-Formate + CONFIG + Fallback-Map.
 */
const ATTR_FALLBACK = {
  agility:  { de: "Geschicklichkeit", en: "Agility" },
  smarts:   { de: "Verstand",         en: "Smarts" },
  spirit:   { de: "Willenskraft",     en: "Spirit" },
  strength: { de: "Stärke",           en: "Strength" },
  vigor:    { de: "Konstitution",     en: "Vigor" },
};

export function resolveAttributeLabel(key) {
  const cap = key.charAt(0).toUpperCase() + key.slice(1);

  // Versuch 0: SWADE-Config (wenn vorhanden)
  const cfgLabel = CONFIG.SWADE?.attributes?.[key]?.long
                ?? CONFIG.SWADE?.attributes?.[key]?.label;
  if (cfgLabel) {
    const resolved = game.i18n.localize(cfgLabel);
    if (resolved !== cfgLabel) return resolved;
    // cfgLabel könnte direkt ein fertiger String sein
    if (!cfgLabel.includes(".")) return cfgLabel;
  }

  // Versuch 1: Langer Name  "SWADE.AttrAgility"
  const longKey = `SWADE.Attr${cap}`;
  let label = game.i18n.localize(longKey);
  if (label !== longKey) return label;
  // Versuch 2: Kurzer Name  "SWADE.AttrAgi"
  const shortKey = `SWADE.Attr${cap.slice(0, 3)}`;
  label = game.i18n.localize(shortKey);
  if (label !== shortKey) return label;
  // Versuch 3: "SWADE.AttrShort.Agility"
  const dotKey = `SWADE.AttrShort.${cap}`;
  label = game.i18n.localize(dotKey);
  if (label !== dotKey) return label;
  // Versuch 4: "SWADE.Attributes.spirit" (Kleinbuchstaben)
  const lowerKey = `SWADE.Attributes.${key}`;
  label = game.i18n.localize(lowerKey);
  if (label !== lowerKey) return label;

  // Fallback: Hardcoded Map
  const lang = game.i18n.lang?.toLowerCase() ?? "en";
  const fb = ATTR_FALLBACK[key];
  if (fb) return fb[lang] ?? fb.en ?? cap;

  return cap;
}

/**
 * RequestRollForm — GM-Fenster für Probenanforderungen (SWADE only).
 *
 * Modi:
 *   single   – Ein Akteur, ein Trait
 *   group    – Mehrere Akteure, ein Trait (Sammel-Ergebnis)
 *   opposed  – Zwei Akteure, je ein Trait (gegeneinander)
 */
export class RequestRollForm extends HandlebarsApplicationMixin(ApplicationV2) {

  /* -------------------------------------------------------------- */
  /*  Statische Konfiguration                                        */
  /* -------------------------------------------------------------- */

  static DEFAULT_OPTIONS = {
    id: "adr-request-roll",
    classes: ["argas-dice-roller-window", "adr-request-roll-window"],
    window: {
      frame: true,
      positioned: true,
      title: "",
      resizable: false,
    },
    position: {
      width: 760,
      top: 70,
      left: 120,
    },
  };

  static PARTS = {
    form: {
      template: ADR.REQUEST_ROLL_FORM_PATH,
    },
  };

  /* -------------------------------------------------------------- */
  /*  Konstruktor                                                    */
  /* -------------------------------------------------------------- */

  constructor(opts = {}) {
    super(opts);
    this.mode = "single";            // "single" | "group" | "opposed"
    this.selectedActors = new Set();  // IDs: actor-ID (PCs) oder token-doc-ID (NPCs)
    this.activeActorId = null;        // Currently viewing traits (single/opposed only)
    this.highlightedGroupActors = new Set(); // Vorgemerkte Akteure (Gruppenprobe, grün ohne Haken)
    this.selectedTraits = new Map();  // id → { type, key, name }
    this.modifier = 0;                 // Freitext-Modifikator
    this._npcTokenData = new Map();   // tokenDocId → { actor, name, img }
    this.dramaticPresetKey = "standard";
    this.dramaticMarkers = 3;
    this.dramaticRounds = 3;
    this.dramaticTargetOverride = null; // null = berechne aus dramaticMarkers × Teilnehmer; sonst fester Gesamtwert (1er-Schritte)
  }

  /* -------------------------------------------------------------- */
  /*  Datenquellen: Akteure und deren Traits                        */
  /* -------------------------------------------------------------- */

  _getPlayerActors() {
    return game.actors.filter(a => a.hasPlayerOwner && a.type === "character");
  }

  _getCanvasNPCTokens() {
    if (!canvas.scene) return [];
    const tokens = canvas.tokens.placeables
      .filter(t => {
        const actor = t.actor;
        if (!actor) return false;
        if (actor.hasPlayerOwner) return false;
        if (actor.type === "vehicle" || actor.type === "group") return false;
        return true;
      })
      .map(t => ({
        id: t.document.id,
        actor: t.actor,
        name: t.name,
        img: t.document.texture?.src || t.actor?.img || "",
      }));

    // Lookup-Map für spätere Actor-Auflösung (Submit, Traits)
    this._npcTokenData.clear();
    for (const t of tokens) {
      this._npcTokenData.set(t.id, t);
    }
    return tokens;
  }

  /**
   * Actor über ID auflösen — PCs via game.actors, NPCs via Token-Lookup.
   */
  _resolveActor(id) {
    return game.actors.get(id) ?? this._npcTokenData.get(id)?.actor ?? null;
  }

  _getActorTraits(actor) {
    return collectActorTraits(actor);
  }

  /**
   * Vereinigte Trait-Liste ALLER Spielercharaktere (für Gruppenprobe).
   * Zeigt alle verfügbaren Traits; markiert "allHave" basierend auf angehakten Akteuren.
   *
   * Pro Trait wird zusätzlich ein `tooltipText` vorberechnet, der im Template
   * direkt als title-Attribut benutzt wird. Format (Komma-getrennt):
   *   „Aragorn: W8, Boromir: W10, Gimli: W12"
   * Diprefix ("W" / "D") aus Lokalisierung (requestRoll.diePrefix).
   */
  _buildUnifiedTraitsAllPCs() {
    const allPCs = this._getPlayerActors();
    if (allPCs.length === 0) return { attributes: [], skills: [] };

    // Für Partial-Berechnung: angehakte ODER vorgemerkte Akteure
    const checkedIds = [...this.selectedActors];
    const effectiveIds = checkedIds;
    const effectiveCount = effectiveIds.length;
    const totalPCs = allPCs.length;

    // Akteur-Namen für die Tooltip-Aufbereitung. Token-Name bevorzugt
    // (Konsistenz mit dem restlichen UI, das Token-Namen für Akteur-Chips
    // benutzt), Fallback auf Akteur-Name.
    const actorNamesMap = new Map();
    for (const actor of allPCs) {
      actorNamesMap.set(actor.id, actor.prototypeToken?.name || actor.name);
    }
    const diePrefix = game.i18n.localize(`${ADR.ID}.requestRoll.diePrefix`);

    // Alle Traits von ALLEN PCs sammeln
    const allTraitsMap = new Map();
    for (const actor of allPCs) {
      allTraitsMap.set(actor.id, this._getActorTraits(actor));
    }

    // Attribute: Vereinigung aller PCs
    const attrSet = new Map();
    for (const [actorId, traits] of allTraitsMap) {
      const actorName = actorNamesMap.get(actorId);
      for (const attr of traits.attributes) {
        if (!attrSet.has(attr.key)) {
          attrSet.set(attr.key, { ...attr, totalCount: 0, selectedCount: 0, bearers: [] });
        }
        const entry = attrSet.get(attr.key);
        entry.totalCount++;
        entry.bearers.push({ name: actorName, dieSides: attr.dieSides });
      }
    }
    // Zähle wie viele ANGEHAKTE Akteure das Attribut haben
    for (const id of effectiveIds) {
      const traits = allTraitsMap.get(id);
      if (!traits) continue;
      for (const attr of traits.attributes) {
        if (attrSet.has(attr.key)) attrSet.get(attr.key).selectedCount++;
      }
    }
    const attributes = SWADE_ATTRIBUTES
      .filter(key => attrSet.has(key))
      .map(key => {
        const a = attrSet.get(key);
        const tooltipText = a.bearers
          .slice()
          .sort((x, y) => x.name.localeCompare(y.name, game.i18n.lang))
          .map(b => `${b.name} (${diePrefix}${b.dieSides})`)
          .join(" -- ");
        return {
          ...a,
          tooltipText,
          allHave: effectiveCount === 0 || a.selectedCount === effectiveCount,
          warnNotAll: effectiveCount === 0 && a.totalCount < totalPCs,
        };
      });

    // Fertigkeiten: Vereinigung aller PCs
    const skillSet = new Map();
    for (const [actorId, traits] of allTraitsMap) {
      const actorName = actorNamesMap.get(actorId);
      for (const skill of traits.skills) {
        if (!skillSet.has(skill.name)) {
          skillSet.set(skill.name, { ...skill, totalCount: 0, selectedCount: 0, bearers: [] });
        }
        const entry = skillSet.get(skill.name);
        entry.totalCount++;
        entry.bearers.push({ name: actorName, dieSides: skill.dieSides });
      }
    }
    for (const id of effectiveIds) {
      const traits = allTraitsMap.get(id);
      if (!traits) continue;
      for (const skill of traits.skills) {
        if (skillSet.has(skill.name)) skillSet.get(skill.name).selectedCount++;
      }
    }
    const skills = [...skillSet.values()]
      .map(s => {
        const tooltipText = s.bearers
          .slice()
          .sort((x, y) => x.name.localeCompare(y.name, game.i18n.lang))
          .map(b => `${b.name} (${diePrefix}${b.dieSides})`)
          .join(" -- ");
        return {
          ...s,
          tooltipText,
          allHave: effectiveCount === 0 || s.selectedCount === effectiveCount,
          warnNotAll: effectiveCount === 0 && s.totalCount < totalPCs,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));

    const coreSkills = skills.filter(s => s.isCore);
    const otherSkills = skills.filter(s => !s.isCore);

    return { attributes, skills, coreSkills, otherSkills };
  }

  _getDramaticPresets() {
    return [
      { key: "standard", label: game.i18n.localize(`${ADR.ID}.requestRoll.dramatic.presetStandard`), markers: 3, rounds: 3 },
      { key: "challenging", label: game.i18n.localize(`${ADR.ID}.requestRoll.dramatic.presetChallenging`), markers: 4, rounds: 3 },
      { key: "hard", label: game.i18n.localize(`${ADR.ID}.requestRoll.dramatic.presetHard`), markers: 6, rounds: 4 },
      { key: "complex", label: game.i18n.localize(`${ADR.ID}.requestRoll.dramatic.presetComplex`), markers: 8, rounds: 5 },
    ];
  }

  _setDramaticPreset(key) {
    const preset = DRAMATIC_TASK_PRESETS[key];
    if (!preset) return;
    this.dramaticPresetKey = key;
    this.dramaticMarkers = preset.markers;
    this.dramaticRounds = preset.rounds;
    this.dramaticTargetOverride = null;
  }

  _adjustDramaticValue(field, delta) {
    if (!["markers", "rounds"].includes(field)) return;

    if (field === "rounds") {
      const next = Math.min(10, Math.max(1, this.dramaticRounds + delta));
      this.dramaticRounds = next;
      this.dramaticPresetKey = this.dramaticTargetOverride === null
        ? _matchDramaticPreset(this.dramaticMarkers, this.dramaticRounds)
        : "custom";
      return;
    }

    // field === "markers": 1er-Schritte auf dem Gesamtwert (targetMarkers),
    // unabhängig von der Teilnehmerzahl.
    const participantCount = Math.max(1, this.selectedActors.size);
    const currentTotal = this.dramaticTargetOverride ?? (this.dramaticMarkers * participantCount);
    const minTotal = 1;
    const maxTotal = 20 * participantCount;
    const nextTotal = Math.min(maxTotal, Math.max(minTotal, currentTotal + delta));
    this.dramaticTargetOverride = nextTotal;
    this.dramaticPresetKey = "custom";
  }

  /* -------------------------------------------------------------- */
  /*  Template-Kontext                                               */
  /* -------------------------------------------------------------- */

  /** @override */
  async _prepareContext(options) {
    const isGroupMode = this.mode === "group";
    const isSingleMode = this.mode === "single";
    const isDramaticMode = this.mode === "dramatic";

    const playerActors = this._getPlayerActors().map(actor => {
      const checked = this.selectedActors.has(actor.id);
      const highlighted = isGroupMode && this.highlightedGroupActors.has(actor.id);
      const active = (!isGroupMode) ? (this.activeActorId === actor.id) : checked;
      const data = {
        id: actor.id,
        name: actor.prototypeToken?.name || actor.name,
        img: actor.prototypeToken?.texture?.src || actor.img || "",
        checked,
        highlighted,
        active,
        selected: checked,  // backward compat for group template
      };
      // Per-Akteur Traits nur für den aktiven Akteur (single/opposed)
      if (!isGroupMode && active) {
        data.traits = this._getActorTraits(actor);
        data.selectedTrait = this.selectedTraits.get(actor.id) ?? null;
      }
      return data;
    });

    // NPCs bei Individual, Vergleich UND Dramatisch anzeigen (Token-basiert)
    const showNPCs = this.mode === "single" || this.mode === "opposed" || this.mode === "dramatic";
    const npcActors = showNPCs ? this._getCanvasNPCTokens().map(npcToken => {
      const checked = this.selectedActors.has(npcToken.id);
      const active = this.activeActorId === npcToken.id;
      const data = {
        id: npcToken.id,
        name: npcToken.name,
        img: npcToken.img,
        checked,
        active,
        selected: checked,
        isNPC: true,
      };
      if (active) {
        data.traits = this._getActorTraits(npcToken.actor);
        data.selectedTrait = this.selectedTraits.get(npcToken.id) ?? null;
      }
      return data;
    }) : [];

    // Vereinigte Trait-Liste nur für Gruppenprobe
    let unified = { attributes: [], skills: [], coreSkills: [], otherSkills: [] };
    if (isGroupMode) {
      unified = this._buildUnifiedTraitsAllPCs();
    }

    // Aktuell gewählter Trait (bei group: einer für alle)
    let selectedTraitKey = null;
    let selectedTraitType = null;
    if (isGroupMode) {
      const first = this.selectedTraits.values().next().value;
      if (first) {
        selectedTraitKey = first.key;
        selectedTraitType = first.type;
      }
    }

    const dramaticPresets = this._getDramaticPresets().map(preset => ({
      ...preset,
      selected: preset.key === this.dramaticPresetKey,
    }));
    const dramaticParticipantCount = this.selectedActors.size;
    const dramaticTargetMarkers = this.dramaticTargetOverride
      ?? (this.dramaticMarkers * dramaticParticipantCount);
    const isCustomPreset = this.dramaticPresetKey === "custom" || !dramaticPresets.find(p => p.selected);
    const currentPresetLabel = dramaticPresets.find(p => p.selected)?.label
      ?? game.i18n.localize(`${ADR.ID}.requestRoll.dramatic.customPreset`);
    const dramaticDescription = isCustomPreset
      ? `${currentPresetLabel}:`
      : game.i18n.format(`${ADR.ID}.requestRoll.dramatic.description`, {
          preset: currentPresetLabel,
          markers: this.dramaticMarkers,
          rounds: this.dramaticRounds,
        });
    const dramaticPreview = game.i18n.format(`${ADR.ID}.requestRoll.dramatic.preview`, {
      participants: dramaticParticipantCount,
      target: dramaticTargetMarkers,
      rounds: this.dramaticRounds,
    });

    const safeModifier = Number.isFinite(this.modifier) ? this.modifier : 0;
    // String-Repräsentation für value-Attribut:
    //   0           → "" (Placeholder "0" wird sichtbar)
    //   positiv N   → "+N" (explizites Vorzeichen)
    //   negativ N   → "-N"
    // text-Input macht das Plus-Zeichen anzeigbar (number-Input würde es schlucken).
    const modifierValue = safeModifier === 0
      ? ""
      : (safeModifier > 0 ? `+${safeModifier}` : String(safeModifier));

    return {
      mode: this.mode,
      isGroupMode,
      isSingleMode,
      isDramaticMode,
      playerActors,
      npcActors,
      showNPCs,
      playerCols: _actorGridColumns(playerActors.length),
      npcCols: _actorGridColumns(npcActors.length),
      unifiedAttributes: unified.attributes,
      unifiedCoreSkills: unified.coreSkills,
      unifiedOtherSkills: unified.otherSkills,
      unifiedSkills: unified.skills,
      hasSelectedActors: this.selectedActors.size > 0,
      modifier: safeModifier,
      modifierValue,
      dramaticPresets,
      dramaticPresetKey: this.dramaticPresetKey,
      dramaticMarkers: this.dramaticMarkers,
      dramaticRounds: this.dramaticRounds,
      dramaticDescription,
      dramaticPreview,
      dramaticParticipantCount,
      dramaticTargetMarkers,
      modulePath: game.modules.get(ADR.ID)?.path || `modules/${ADR.ID}`,
      selectedTraitKey,
      selectedTraitType,
      untrainedLabel: game.i18n.localize(`${ADR.ID}.requestRoll.untrained`),
    };
  }

  /* -------------------------------------------------------------- */
  /*  Lifecycle                                                      */
  /* -------------------------------------------------------------- */

  /** @override */
  _onFirstRender(context, options) {
    super._onFirstRender(context, options);

    const winHeader = this.element.querySelector(".window-header");
    if (winHeader && !winHeader.querySelector(".adrgs-title-extra")) {
      const span = document.createElement("span");
      span.className = "adrgs-title-extra";
      span.textContent = "~ " + game.i18n.localize(`${ADR.ID}.requestRoll.windowTitle`) + " ~";
      winHeader.appendChild(span);
    }

    this._applyUiScale();
    this._setupUiScaleObserver();

    // ── Delegierte Events auf this.element (überlebt DOM-Austausch durch Foundry) ──
    const el = this.element;

    // Gruppenprobe: Akteur-Chip Klick → Vormerken (grün, kein Haken)
    el.addEventListener("click", ev => {
      const chip = ev.target.closest("[data-action='highlight-group-actor']");
      if (!chip) return;
      const actorId = chip.dataset.actorId;
      if (this.selectedActors.has(actorId)) {
        // War angehakt → Haken + Trait entfernen
        this.selectedActors.delete(actorId);
        this.selectedTraits.delete(actorId);
      } else if (this.highlightedGroupActors.has(actorId)) {
        // War vorgemerkt → Vormerkung entfernen
        this.highlightedGroupActors.delete(actorId);
      } else {
        // Neu angeklickt: Wenn bereits ein Trait gewählt ist → direkt abhaken + Trait setzen
        const currentTrait = this.selectedTraits.values().next().value;
        if (currentTrait) {
          this.selectedActors.add(actorId);
          this.selectedTraits.set(actorId, { ...currentTrait });
        } else {
          this.highlightedGroupActors.add(actorId);
        }
      }
      this.render();
    });

    // Gruppenprobe: Mouseover → fehlende Traits rot markieren
    el.addEventListener("mouseover", ev => {
      const chip = ev.target.closest("[data-action='highlight-group-actor']");
      if (!chip || chip._adrHovered) return;
      chip._adrHovered = true;

      // Vorherige Rot-Markierungen aufräumen (können nach render() verwaist sein)
      el.querySelectorAll(".adr-trait-hover-missing").forEach(btn => {
        btn.classList.remove("adr-trait-hover-missing");
      });

      // Gelbe/rötliche Warn-Farben während Hover unterdrücken (nur dieser Akteur zählt)
      el.classList.add("adr-trait-hover-active");

      const actorId = chip.dataset.actorId;
      const actor = this._resolveActor(actorId);
      if (!actor) return;

      const traits = this._getActorTraits(actor);
      const attrKeys = new Set(traits.attributes.map(a => a.key));
      const skillNames = new Set(traits.skills.map(s => s.name));

      el.querySelectorAll("[data-action='select-trait']").forEach(btn => {
        const type = btn.dataset.traitType;
        const key = btn.dataset.traitKey;
        const name = btn.dataset.traitName;
        const hasTrait = (type === "attribute")
          ? attrKeys.has(key)
          : skillNames.has(name);
        if (!hasTrait) btn.classList.add("adr-trait-hover-missing");
      });
    });
    el.addEventListener("mouseout", ev => {
      const chip = ev.target.closest("[data-action='highlight-group-actor']");
      if (!chip) return;
      if (chip.contains(ev.relatedTarget)) return;
      chip._adrHovered = false;
      el.classList.remove("adr-trait-hover-active");
      el.querySelectorAll(".adr-trait-hover-missing").forEach(btn => {
        btn.classList.remove("adr-trait-hover-missing");
      });
    });
  }

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);
    const el = this.element;

    // Hover-State aufräumen (render() tauscht DOM aus, alte Markierungen sind verwaist)
    el.classList.remove("adr-trait-hover-active");

    // ── Modus-Buttons ──
    el.querySelectorAll("[data-action='set-mode']").forEach(btn => {
      btn.addEventListener("click", ev => {
        this.mode = ev.currentTarget.dataset.mode;
        this.selectedActors.clear();
        this.selectedTraits.clear();
        this.highlightedGroupActors.clear();
        this.activeActorId = null;
        this.render();
      });
    });

    // ── Akteur-Chip: Haken-Bereich klicken ──
    //   Wenn angehakt → Akteur entfernen (bisheriges Verhalten).
    //   Wenn nicht angehakt → Akteur aktivieren (grün unterlegen), analog Label-Klick.
    el.querySelectorAll("[data-action='uncheck-actor']").forEach(slot => {
      slot.addEventListener("click", ev => {
        ev.stopPropagation();
        const actorId = ev.currentTarget.dataset.actorId;
        if (this.selectedActors.has(actorId)) {
          this.selectedActors.delete(actorId);
          this.selectedTraits.delete(actorId);
          if (this.activeActorId === actorId) this.activeActorId = null;
        } else {
          this.activeActorId = (this.activeActorId === actorId) ? null : actorId;
        }
        this.render();
      });
    });

    // ── Akteur-Chip Klick (Name/Bild → Traits anzeigen, kein Haken) ──
    el.querySelectorAll("[data-action='activate-actor']").forEach(chip => {
      chip.addEventListener("click", ev => {
        const actorId = ev.currentTarget.dataset.actorId;
        this.activeActorId = (this.activeActorId === actorId) ? null : actorId;
        this.render();
      });
    });

    // ── Trait-Buttons ──
    el.querySelectorAll("[data-action='select-trait']").forEach(btn => {
      btn.addEventListener("click", ev => {
        const traitType = ev.currentTarget.dataset.traitType;
        const traitKey = ev.currentTarget.dataset.traitKey;
        const traitName = ev.currentTarget.dataset.traitName;
        const actorId = ev.currentTarget.dataset.actorId || null;

        if (this.mode === "group") {
          // Gruppenprobe: gleicher Trait für alle
          const current = this.selectedTraits.values().next().value;
          if (current && current.key === traitKey && current.type === traitType) {
            // Gleichen Trait erneut geklickt → komplett abwählen (Haken + Vormerkung)
            this.selectedTraits.clear();
            this.selectedActors.clear();
            this.highlightedGroupActors.clear();
          } else {
            // Neuen Trait gewählt:
            // Wenn bereits Akteure vorgemerkt oder angehakt → nur diese bekommen Haken
            // Wenn niemand ausgewählt → ALLE Spielercharaktere bekommen Haken
            const hasSelection = this.highlightedGroupActors.size > 0 || this.selectedActors.size > 0;
            if (hasSelection) {
              for (const id of this.highlightedGroupActors) {
                this.selectedActors.add(id);
              }
              this.highlightedGroupActors.clear();
            } else {
              this.selectedActors.clear();
              for (const actor of this._getPlayerActors()) {
                this.selectedActors.add(actor.id);
              }
            }
            // Trait für alle angehakten setzen
            this.selectedTraits.clear();
            for (const id of this.selectedActors) {
              this.selectedTraits.set(id, { type: traitType, key: traitKey, name: traitName });
            }
          }
        } else {
          // Single/Opposed: Trait pro Akteur
          if (!actorId) return;
          const current = this.selectedTraits.get(actorId);
          if (current && current.key === traitKey && current.type === traitType) {
            this.selectedTraits.delete(actorId);
            // Haken entfernen wenn kein Trait mehr gewählt
            this.selectedActors.delete(actorId);
          } else {
            this.selectedTraits.set(actorId, { type: traitType, key: traitKey, name: traitName });
            // Haken setzen wenn Trait gewählt
            if (!this.selectedActors.has(actorId)) {
              if (this.mode === "opposed" && this.selectedActors.size >= 2) {
                const first = this.selectedActors.values().next().value;
                this.selectedActors.delete(first);
                this.selectedTraits.delete(first);
              }
              this.selectedActors.add(actorId);
            }
          }
        }
        this.render();
      });
    });

    // ── Dramatische Aufgabe: Presets ──
    el.querySelectorAll("[data-action='set-dramatic-preset']").forEach(btn => {
      btn.addEventListener("click", ev => {
        this._setDramaticPreset(ev.currentTarget.dataset.preset);
        this.render();
      });
    });

    // ── Dramatische Aufgabe: +/- ──
    el.querySelectorAll("[data-action='dramatic-adjust']").forEach(btn => {
      btn.addEventListener("click", ev => {
        const field = ev.currentTarget.dataset.field;
        const delta = Number(ev.currentTarget.dataset.delta) || 0;
        this._adjustDramaticValue(field, delta);
        this.render();
      });
    });

    // ── Modifikator-Eingabe + Stepper-Buttons ──
    const modInput = el.querySelector("[data-action='set-modifier']");

    // Hilfsfunktion: Wert ins Anzeigeformat normalisieren ("", "+N", "-N").
    const formatModifierForInput = (n) => {
      if (!Number.isFinite(n) || n === 0) return "";
      return n > 0 ? `+${n}` : String(n);
    };

    if (modInput) {
      // Beim Tippen: silent State aktualisieren (keine Warnung pro Tastenanschlag).
      // Die sichtbare Warnung + Submit-Block erfolgt erst in _validateModifierInput()
      // beim Submit-Versuch. So gibt's GENAU eine eindeutige Warnung pro Submit-Klick,
      // ohne Race-Condition mit dem Blur/Change-Event des Inputs.
      modInput.addEventListener("input", ev => {
        const inp = ev.currentTarget;
        const v = inp.value.trim();
        if (v === "" || v === "+" || v === "-") {
          // Leeres Feld oder isoliertes Vorzeichen während des Tippens: State auf 0,
          // Anzeige NICHT erzwingen (User tippt evtl. gerade weiter).
          this.modifier = 0;
          return;
        }
        const raw = Number(v);
        if (Number.isFinite(raw) && raw >= MODIFIER_MIN && raw <= MODIFIER_MAX) {
          this.modifier = raw;
        } else {
          // Ungültiger Wert (außerhalb Range / nicht parsbar) → State auf 0,
          // aber Feld behält den sichtbaren Wert, damit der User korrigieren kann.
          this.modifier = 0;
        }
      });

      // Beim Blur: Anzeige aufs kanonische Format normalisieren — auch wenn der
      // GM nur "2" getippt hat, wird "+2" daraus.
      modInput.addEventListener("blur", ev => {
        ev.currentTarget.value = formatModifierForInput(this.modifier);
      });
    }

    // Stepper-Buttons (−/+): Modifier in 1er-Schritten ändern, auf [MIN, MAX] geclampt.
    el.querySelectorAll("[data-action='modifier-step']").forEach(btn => {
      btn.addEventListener("click", ev => {
        const step = Number(ev.currentTarget.dataset.step) || 0;
        const cur = Number.isFinite(this.modifier) ? this.modifier : 0;
        const next = Math.max(MODIFIER_MIN, Math.min(MODIFIER_MAX, cur + step));
        this.modifier = next;
        if (modInput) modInput.value = formatModifierForInput(next);
      });
    });

    // ── Submit-Button ──
    el.querySelector("[data-action='submit-request']")?.addEventListener("click", () => {
      this._submitRequest();
    });
  }

  _onClose(options) {
    if (this._uiScaleObserver) {
      this._uiScaleObserver.disconnect();
      this._uiScaleObserver = null;
    }
    this._uiScaleEl = null;

    // State zurücksetzen für frischen Start beim nächsten Öffnen
    this.mode = "single";
    this.selectedActors.clear();
    this.activeActorId = null;
    this.highlightedGroupActors.clear();
    this.selectedTraits.clear();
    this.modifier = 0;
    this.dramaticPresetKey = "standard";
    this.dramaticMarkers = 3;
    this.dramaticRounds = 3;
    this.dramaticTargetOverride = null;

    super._onClose(options);
  }

  /* -------------------------------------------------------------- */
  /*  UI-Scaling                                                     */
  /* -------------------------------------------------------------- */

  _applyUiScale() {
    const scaleEl = this._uiScaleEl ?? document.documentElement;
    let scale = parseFloat(getComputedStyle(scaleEl).getPropertyValue("--ui-scale")) || 0;
    if (!scale) scale = game.settings.get("core", "uiConfig")?.uiScale ?? 1;

    const el = this.element;
    el.style.setProperty("--adr-ui-scale", scale);
    if (scale !== 1) el.classList.add("adr-scaled");
    else el.classList.remove("adr-scaled");

    const toolbar = document.querySelector("#ui-left > *:first-child");
    if (toolbar) {
      const rect = toolbar.getBoundingClientRect();
      this.setPosition({ left: rect.right + 18 * scale, top: rect.top + 42 * scale });
    }
  }

  _setupUiScaleObserver() {
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

  /* -------------------------------------------------------------- */
  /*  Probenanforderung absenden                                     */
  /* -------------------------------------------------------------- */

  /**
   * Prüft das Modifikator-Eingabefeld auf Gültigkeit. Gibt eine Warnung aus
   * und liefert false zurück, wenn der aktuell sichtbare Wert ungültig ist.
   *
   * Ungültig ist:
   *  - badInput (Browser hat Inhalt nicht als Zahl akzeptiert: "1-20", "abc", ...)
   *  - Eine Zahl, die nicht endlich ist oder außerhalb [MODIFIER_MIN .. MODIFIER_MAX] liegt
   *  - Ein nicht-leerer Text, der nicht in eine Zahl konvertierbar ist
   *
   * Bei leerem Feld (Placeholder "0" sichtbar) → modifier = 0, return true.
   *
   * Wird aus _submitRequest (single/group/opposed) und _submitDramaticTask
   * aufgerufen, damit alle 4 Modi konsistent validieren.
   */
  _validateModifierInput() {
    const inp = this.element?.querySelector("[data-action='set-modifier']");
    if (!inp) return true; // Feld nicht im DOM → nichts zu prüfen

    const warn = () => {
      ui.notifications.warn(game.i18n.format(`${ADR.ID}.requestRoll.warn.invalidModifier`, {
        min: MODIFIER_MIN, max: MODIFIER_MAX,
      }));
      // Fokus zurück ins Feld, damit der User direkt korrigieren kann
      try { inp.focus(); inp.select(); } catch (_) { /* ignore */ }
    };

    // 1) Browser-seitig als ungültig markiert (z. B. "1-20", "abc")
    if (inp.validity?.badInput) {
      warn();
      return false;
    }

    // 2) Sichtbarer Text holen — robust gegen Edge-Cases:
    //    Bei type="number" liefert .value leer wenn ungültig, aber wir prüfen
    //    zusätzlich .value sowie das Roh-DOM-Attribut, um nichts zu übersehen.
    const rawText = (inp.value ?? "").trim();

    // 3) Leeres Feld → 0, kein Modifier, gültig
    if (rawText === "") {
      this.modifier = 0;
      return true;
    }

    // 4) Reine Zahl prüfen (keine "1-20"-Konstrukte, keine Buchstaben).
    //    Erlaubt: optionales Vorzeichen, dann ausschließlich Ziffern.
    if (!/^[+\-]?\d+$/.test(rawText)) {
      warn();
      return false;
    }

    // 5) Konvertieren und Range prüfen
    const raw = Number(rawText);
    if (!Number.isFinite(raw) || raw < MODIFIER_MIN || raw > MODIFIER_MAX) {
      warn();
      return false;
    }

    this.modifier = raw;
    return true;
  }

  async _submitDramaticTask() {
    if (!this._validateModifierInput()) return;

    const allTraitsSetD = [...this.selectedActors].every(id => this.selectedTraits.has(id));
    if (this.selectedActors.size < 1 || !allTraitsSetD) {
      ui.notifications.warn(game.i18n.localize(`${ADR.ID}.requestRoll.warn.dramaticNeed`));
      return;
    }

    const diePrefix = game.i18n.localize(`${ADR.ID}.requestRoll.diePrefix`);
    const participants = [];

    for (const actorId of this.selectedActors) {
      const actor = this._resolveActor(actorId);
      if (!actor) continue;
      const npcData = this._npcTokenData.get(actorId);
      const trait = { ...this.selectedTraits.get(actorId) };

      const ownerIds = game.users
        .filter(u => !u.isGM && actor.testUserPermission(u, "OWNER"))
        .map(u => u.id);
      const isNPC = !actor.hasPlayerOwner;
      const isWildcard = !!actor.system?.wildcard;

      let traitDie = 4;
      if (trait.type === "attribute") traitDie = actor.system.attributes?.[trait.key]?.die?.sides ?? 4;
      else if (trait.type === "skill") traitDie = actor.items.get(trait.key)?.system?.die?.sides ?? 4;

      participants.push({
        actorId,
        actorName: npcData?.name ?? actor.prototypeToken?.name ?? actor.name,
        actorImg: npcData?.img ?? actor.prototypeToken?.texture?.src ?? actor.img ?? "",
        traitType: trait.type,
        traitKey: trait.key,
        traitName: trait.name,
        traitDie,
        traitDieLabel: `${diePrefix}${traitDie}`,
        isUntrained: trait.type === "untrained" || UNTRAINED_SKILL_NAMES.has((trait.name ?? "").toLowerCase()),
        ownerIds: isNPC ? game.users.filter(u => u.isGM).map(u => u.id) : ownerIds,
        isNPC,
        isWildcard,
      });
    }

    if (participants.length === 0) {
      ui.notifications.warn(game.i18n.localize(`${ADR.ID}.requestRoll.warn.dramaticNeed`));
      return;
    }

    const presetLabel = this._getDramaticPresets().find(p => p.key === this.dramaticPresetKey)?.label
      ?? game.i18n.localize(`${ADR.ID}.requestRoll.dramatic.customPreset`);

    const { flags, chatContent } = await createDramaticTaskMessageData(participants, {
      markersPerParticipant: this.dramaticMarkers,
      targetMarkers: this.dramaticTargetOverride ?? undefined,
      roundsTotal: this.dramaticRounds,
      modifier: Number.isFinite(this.modifier) ? this.modifier : 0,
      presetKey: this.dramaticPresetKey,
      presetLabel,
    });

    const speaker = ChatMessage.getSpeaker({
      alias: game.i18n.localize(`${ADR.ID}.requestRoll.modeDramatic`),
    });

    await ChatMessage.create({
      content: chatContent,
      speaker,
      flavor: game.i18n.localize(`${ADR.ID}.requestRoll.modeDramatic`),
      flags,
    });

    this.close();
  }

  async _submitRequest() {
    if (this.mode === "dramatic") {
      return this._submitDramaticTask();
    }

    if (!this._validateModifierInput()) return;

    // ── Per-Modus-Validierung (Akteur(e) + Eigenschaft(en)) ──
    const allTraitsSet = [...this.selectedActors].every(id => this.selectedTraits.has(id));
    if (this.mode === "single") {
      if (this.selectedActors.size < 1 || !allTraitsSet) {
        ui.notifications.warn(game.i18n.localize(`${ADR.ID}.requestRoll.warn.singleNeed`));
        return;
      }
    } else if (this.mode === "group") {
      if (this.selectedActors.size < 2 || !allTraitsSet) {
        ui.notifications.warn(game.i18n.localize(`${ADR.ID}.requestRoll.warn.groupNeed`));
        return;
      }
    } else if (this.mode === "opposed") {
      if (this.selectedActors.size !== 2 || !allTraitsSet) {
        ui.notifications.warn(game.i18n.localize(`${ADR.ID}.requestRoll.warn.opposedNeed`));
        return;
      }
    }

    const requestId = foundry.utils.randomID();
    const sumMod = Number.isFinite(this.modifier) ? this.modifier : 0;
    const modDisplay = _getModifierDisplay(sumMod);
    const modeLabel = game.i18n.localize(
      `${ADR.ID}.requestRoll.mode${this.mode.charAt(0).toUpperCase() + this.mode.slice(1)}`
    );

    // ── Entries aufbauen ──
    const diePrefix = game.i18n.localize(`${ADR.ID}.requestRoll.diePrefix`);
    // Bei Gruppenprobe: Original-Traitname vor Untrained-Überschreibung merken
    let groupTraitName = "";
    if (this.mode === "group") {
      const firstTrait = this.selectedTraits.values().next().value;
      if (firstTrait) groupTraitName = firstTrait.name;
    }
    const entries = [];
    for (const actorId of this.selectedActors) {
      const actor = this._resolveActor(actorId);
      if (!actor) continue;
      const npcData = this._npcTokenData.get(actorId);
      let trait = { ...this.selectedTraits.get(actorId) };

      // Bei Gruppenprobe: prüfe ob Akteur den Trait tatsächlich hat
      if (this.mode === "group" && trait.type === "skill") {
        const hasSkill = actor.items.some(i => i.type === "skill" && i.name === trait.name);
        if (!hasSkill) {
          trait = {
            type: "untrained",
            key: "untrained",
            name: game.i18n.localize(`${ADR.ID}.requestRoll.untrained`),
          };
        }
      }
      if (this.mode === "group" && trait.type === "attribute") {
        const hasAttr = !!actor.system.attributes?.[trait.key];
        if (!hasAttr) {
          trait = {
            type: "untrained",
            key: "untrained",
            name: game.i18n.localize(`${ADR.ID}.requestRoll.untrained`),
          };
        }
      }

      const ownerIds = game.users
        .filter(u => !u.isGM && actor.testUserPermission(u, "OWNER"))
        .map(u => u.id);
      const isNPC = !actor.hasPlayerOwner;
      const isWildcard = !!actor.system?.wildcard;

      // Würfelgröße bestimmen
      let traitDie = 4;
      if (trait.type === "attribute") {
        traitDie = actor.system.attributes?.[trait.key]?.die?.sides ?? 4;
      } else if (trait.type === "skill") {
        const skillItem = actor.items.get(trait.key);
        traitDie = skillItem?.system?.die?.sides ?? 4;
      }

      entries.push({
        actorId,
        actorName: npcData?.name ?? actor.prototypeToken?.name ?? actor.name,
        actorImg: npcData?.img ?? actor.prototypeToken?.texture?.src ?? actor.img ?? "",
        traitType: trait.type,
        traitKey: trait.key,
        traitName: trait.name,
        traitDie,
        traitDieLabel: `${diePrefix}${traitDie}`,
        isUntrained: trait.type === "untrained" || UNTRAINED_SKILL_NAMES.has((trait.name ?? "").toLowerCase()),
        ownerIds: isNPC ? game.users.filter(u => u.isGM).map(u => u.id) : ownerIds,
        isNPC,
        isWildcard,
        result: null,
      });
    }

    const speaker = ChatMessage.getSpeaker({
      alias: game.i18n.localize(`${ADR.ID}.requestRoll.chatTitle`),
    });

    // ── Individual Mode: pro Akteur eine eigene Nachricht ──
    // Anforderungen sind öffentlich (alle Spieler sehen Anforderung + Wurfergebnis).
    // Bei NSCs sieht nur der SL den "Würfeln"-Button — siehe ownerIds-Behandlung oben.
    if (this.mode === "single") {
      for (const entry of entries) {
        const perEntryId = foundry.utils.randomID();

        const flags = {
          [ADR.ID]: {
            requestRoll: true,
            requestId: perEntryId,
            mode: this.mode,
            modifier: sumMod,
            entries: [entry],
            completedCount: 0,
          }
        };

        const templateData = {
          requestId: perEntryId,
          mode: this.mode,
          modifier: sumMod,
          modifierStr: modDisplay.str,
          modifierClass: modDisplay.cls,
          showModifier: modDisplay.show,
          entries: [entry],
          modeLabel,
        };
        const chatContent = await foundry.applications.handlebars.renderTemplate(ADR.REQUEST_ROLL_CHAT_PATH, templateData);

        const msgData = {
          content: chatContent,
          speaker,
          flavor: modeLabel,
          flags,
        };
        await ChatMessage.create(msgData);
      }
    } else {
      // ── Group / Opposed: eine gemeinsame Nachricht ──
      const flags = {
        [ADR.ID]: {
          requestRoll: true,
          requestId,
          mode: this.mode,
          modifier: sumMod,
          groupTraitName,
          entries,
          completedCount: 0,
        }
      };

      const templateData = {
        requestId,
        mode: this.mode,
        modifier: sumMod,
        modifierStr: modDisplay.str,
        modifierClass: modDisplay.cls,
        showModifier: modDisplay.show,
        groupTraitName,
        entries,
        modeLabel,
      };
      const chatContent = await foundry.applications.handlebars.renderTemplate(ADR.REQUEST_ROLL_CHAT_PATH, templateData);

      await ChatMessage.create({
        content: chatContent,
        speaker,
        flavor: modeLabel,
        flags,
      });
    }

    this.close();
  }
}
