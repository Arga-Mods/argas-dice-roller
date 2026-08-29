/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright (C) 2026 Arga-Mods */

export const ADR = {
  ID: "argas-dice-roller",

  MENU_CONTROL: "argas-dice-roller",
  CONFIG_HIDDEN_ROLLS: "enableHiddenRolls",
  CONFIG_EXPLODING_DEFAULT: "explodingDefault",
  CONFIG_EXPLODING_MODE: "explodingMode",
  CONFIG_WILD_DIE: "enableWildDie",
  CONFIG_CLOSE_FORM: "closeFormOnRoll",
  CONFIG_MAXDICE_COUNT: "maxDiceCount",
  CONFIG_1ST_COLUMN: "enableFirstColumn",
  CONFIG_DICE_TYPES: "diceTypes",
  CONFIG_HIGHLIGHT_ONES: "highlightNaturalOnes",
  CONFIG_MODIFIERS: "enableModifiers",
  CONFIG_EXTRA_MODIFIERS: "enableExtraModifiers",
  CONFIG_REQUEST_ROLL: "enableRequestRoll",
  CONFIG_KEEP_DICE: "enableKeepDice",
  CONFIG_CTHULHU_DICE: "enableCthulhuDice",
  DICE_FORM_PATH:  "modules/argas-dice-roller/templates/dice-form.hbs",
  REQUEST_ROLL_FORM_PATH: "modules/argas-dice-roller/templates/request-roll-form.hbs",
  REQUEST_ROLL_CHAT_PATH: "modules/argas-dice-roller/templates/request-roll-chat.hbs",
  SUPPORT_DIALOG_FORM_PATH: "modules/argas-dice-roller/templates/support-dialog-form.hbs",
  CHANGE_TRAIT_DIALOG_FORM_PATH: "modules/argas-dice-roller/templates/change-trait-dialog-form.hbs",
  SOCKET: "module.argas-dice-roller",
  SWADE_MECHANICS_SYSTEMS: ["swade", "worldbuilding", "custom-system-builder"],
  // Systeme, in denen die jeweilige Schaltfläche standardmäßig eingeschaltet ist.
  KEEP_DICE_SYSTEMS: ["dnd5e", "a5e", "sw5e", "dragonbane", "shadowdark", "black-flag"],
  CTHULHU_DICE_SYSTEMS: ["CoC7"],
  FUDGE_DICE_SYSTEMS: ["fate-core-official", "fatex", "fudge-rpg"],
  // "dc" = Münze, "df" = Fudge-Würfel (Foundry-FateDie, Ergebnis −1/0/+1 je Würfel).
  DICE_TYPES: ["dc", "d2", "d4", "d6", "d8", "d10", "d12", "d20", "d100", "df"],
  DICE_TYPES_DEFAULT: { dc: true, d2: false, d4: true, d6: true, d8: true, d10: true, d12: true, d20: true, d100: true, df: false },
};

/** Voreinstellung der Würfeltypen; in Fate-/Fudge-Systemen sind Fudge-Würfel vorab aktiv. */
export function adrDiceTypesDefault() {
  return { ...ADR.DICE_TYPES_DEFAULT, df: ADR.FUDGE_DICE_SYSTEMS.includes(game.system.id) };
}

/** Anzeigename eines Würfeltyps: „Münzwurf", „Fudge-Würfel (dF)" bzw. „W6"/„d6". */
export function adrDieTypeLabel(type) {
  if (type === "dc") return game.i18n.localize(`${ADR.ID}.diceTypes.coin`);
  if (type === "df") return game.i18n.localize(`${ADR.ID}.diceTypes.fudge`);
  return game.i18n.localize(`${ADR.ID}.requestRoll.diePrefix`) + type.slice(1);
}

/** Fudge-Würfel (dF)? Sonderzeile wie die Münze: kein Explodieren, kein Wild Die, kein Multi-Pool. */
export function adrIsFudge(type) {
  return type === "df";
}

/** Zahl mit Vorzeichen („+2", „0", „−1") — für Fudge-Ergebnisse. */
export function adrSignedNumber(n) {
  n = Number(n) || 0;
  return n > 0 ? `+${n}` : String(n);
}

/**
 * Einzelergebnisse eines Fudge-Terms (FateDie) für die Chat-Anzeige:
 * value −1/0/+1, display „−" / Kreis-Icon / „+", CSS-Klasse adr-fudge-minus/-blank/-plus.
 */
export function adrBuildFudgeResults(dieTerm) {
  if (!dieTerm?.results?.length) return [];
  return dieTerm.results.slice(0, dieTerm.number).map(r => {
    const v = Number(r.result) || 0;
    const kind = v > 0 ? "plus" : (v < 0 ? "minus" : "blank");
    // Leere Seite als Kreis-Icon (Font Awesome) — ein Textzeichen wie „▢" fehlt in manchen Schriften.
    const display = v > 0 ? "+" : (v < 0 ? "−" : `<i class="fa-regular fa-circle"></i>`);
    return { value: v, display, class: `adr-fudge-die adr-fudge-${kind}` };
  });
}

/**
 * Foundry-Würfelmodifikator für „Höchster"/„Niedrigster" (Vorteil/Nachteil,
 * Dragonbane-Boon/Bane): alle Würfel werden geworfen, nur einer zählt.
 * Gültige Werte: "kh" (höchster zählt), "kl" (niedrigster zählt), sonst null.
 */
export function adrKeepModifier(mode) {
  return (mode === "kh" || mode === "kl") ? mode : null;
}

/**
 * Bonus-/Strafwurf (Call of Cthulhu 7e): W100 aus Einer- und Zehnerwürfel;
 * Zusatz-Zehnerwürfel, beim Bonuswurf zählt der niedrigste, beim Strafwurf
 * der höchste Zehner. Werte: "bonus" | "penalty" | null.
 */
export function adrCthulhuMode(mode) {
  return (mode === "bonus" || mode === "penalty") ? mode : null;
}

/**
 * Wertet einen Cthulhu-Wurf aus. `onesRaw` = W10-Ergebnis des Einerwürfels
 * (1–10), `tensRaw` = W10-Ergebnisse der Zehnerwürfel (1–10, 10 = „00").
 * Liefert je Zehnerwürfel den möglichen Gesamtwert (00+0 = 100) und den
 * Index des gewerteten Würfels.
 */
export function adrEvalCthulhu(onesRaw, tensRaw, mode) {
  const ones = onesRaw % 10;                       // 10 → 0
  const candidates = tensRaw.map(t => {
    const tens = (t % 10) * 10;                    // 10 → 00
    const v = tens + ones;
    return v === 0 ? 100 : v;
  });
  let idx = 0;
  for (let i = 1; i < candidates.length; i++) {
    const better = mode === "penalty" ? candidates[i] > candidates[idx] : candidates[i] < candidates[idx];
    if (better) idx = i;
  }
  return { ones, candidates, chosenIndex: idx, total: candidates[idx] };
}

/** Systeme, in denen die SWADE-Spielmechanik-Einstellungen angeboten werden. */
export function adrSwadeMechanicsOffered() {
  return ADR.SWADE_MECHANICS_SYSTEMS.includes(game.system.id);
}
