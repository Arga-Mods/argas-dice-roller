/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright (C) 2026 Arga-Mods */

import { ADR } from "./adr-constants.js";

/**
 * adr-benny-helpers.js
 *
 * Zentrale Benny-Subjekt-Logik. Ein "Subjekt" ist die Entität, von der ein Benny
 * abgezogen wird — entweder ein Akteur (PC) oder der GM-User (für NSCs bzw.
 * GM-eigene Würfe ohne Token).
 */

/* ================================================================ */
/*  Subjekt-Konstruktion                                             */
/* ================================================================ */

/**
 * Subjekt für freien Wurf aus einer Chat-Nachricht ableiten.
 *
 *   – `kind: "actor"` — Token-/Charakter-Wurf, Bennies des Akteurs
 *   – `kind: "gm"`    — GM-als-GM-Wurf ohne Token-Auswahl, GM-User-Bennies
 *
 * Unterscheidung: GM-Author UND kein speaker.token → GM-Modus, sonst
 * Akteur-Modus. Bei Akteur-Modus muss speaker.actor existieren, sonst
 * null (kein Reroll-Ziel).
 *
 * NSC-Sonderfall: Ein Akteur ohne Player-Owner (hasPlayerOwner === false) hat
 * keine eigenen Bennys; in dem Fall wird das Subjekt zum GM-User umgeleitet.
 * Familiars/Begleiter eines Spielers haben einen Player-Owner und bleiben
 * im Akteur-Modus (Spieler-Benny).
 */
export function freeRollSubject(message) {
  const speaker = message.speaker || {};
  const author = game.users.get(message.author?.id);
  const authorIsGM = !!author?.isGM;

  if (authorIsGM && !speaker.token) {
    return { kind: "gm", user: author, name: speaker.alias || author?.name || "GM" };
  }

  if (!speaker.actor) return null;
  const actor = game.actors.get(speaker.actor);
  if (!actor) return null;
  // NSC-Akteur ohne Player-Owner → GM-Bennys nutzen (analog Probenanforderung)
  if (!actor.hasPlayerOwner) {
    const gmUser = authorIsGM ? author : game.user;
    return { kind: "gm", user: gmUser, name: gmUser?.name || "GM", forNPC: true, npcName: actor.name };
  }
  return { kind: "actor", actor, name: actor.name };
}

/**
 * Subjekt für Probenanforderung aus Entry + aufgelöstem Akteur.
 *
 * NSC → GM-Subjekt (Bennies des aktuell klickenden GM-Users).
 * SC  → Akteur-Subjekt (Bennies des Akteurs).
 *
 * Hinweis: Bei NSCs ist der aktive Benutzer faktisch immer der GM, weil nur
 * der GM den Reroll-Button für NSCs klicken kann (Berechtigungsfilter läuft
 * vorher in der UI-Schicht).
 */
export function requestRollSubject(actor, isNPC) {
  if (isNPC) {
    const gmUser = game.user;
    return { kind: "gm", user: gmUser, name: gmUser?.name || "GM" };
  }
  if (!actor) return null;
  return { kind: "actor", actor, name: actor.name };
}

/* ================================================================ */
/*  Subjekt-Operationen (generisch)                                  */
/* ================================================================ */

/**
 * Aktuelle Bennies-Anzahl für das Subjekt.
 */
export function subjectBennies(subject) {
  if (!subject) return 0;
  if (subject.kind === "actor") return Number(subject.actor.system?.bennies?.value ?? 0);
  if (subject.kind === "gm") {
    // SWADE 5.x: User-Klasse hat `bennies`-Getter
    const direct = subject.user?.bennies;
    if (typeof direct === "number") return direct;
    return Number(subject.user?.getFlag("swade", "bennies") ?? 0);
  }
  return 0;
}

/**
 * Benny abziehen — gibt true bei Erfolg zurück.
 * Fallback für ältere SWADE-Versionen ohne User.spendBenny().
 */
export async function subjectSpendBenny(subject) {
  if (!subject) return false;
  if (subject.kind === "actor") {
    await subject.actor.spendBenny();
    return true;
  }
  if (subject.kind === "gm") {
    if (typeof subject.user.spendBenny === "function") {
      await subject.user.spendBenny();
      return true;
    }
    // Fallback: Flag direkt manipulieren (ältere SWADE-Versionen)
    const cur = Number(subject.user.getFlag("swade", "bennies") ?? 0);
    if (cur <= 0) return false;
    await subject.user.setFlag("swade", "bennies", cur - 1);
    return true;
  }
  return false;
}

/**
 * Darf der aktuelle User den Reroll-Klick auslösen?
 *   – Akteur-Subjekt: Owner-Berechtigung am Akteur (Spieler-Owner oder GM).
 *   – GM-Subjekt:     nur der GM-User selbst (seine eigenen Bennies).
 */
export function subjectCanClick(subject) {
  if (!subject) return false;
  if (subject.kind === "actor") return !!subject.actor.isOwner;
  if (subject.kind === "gm") return game.user.id === subject.user.id;
  return false;
}
