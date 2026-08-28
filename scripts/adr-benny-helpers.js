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
    // SWADE liefert false, wenn keine Bennys mehr da sind (Race zwischen
    // Vorab-Check und Abzug) — nicht pauschal true melden.
    const result = await subject.actor.spendBenny();
    return result !== false;
  }
  if (subject.kind === "gm") {
    if (typeof subject.user.spendBenny === "function") {
      // SWADE liefert auch hier false bei 0 Bennys (analog Akteur-Zweig)
      const result = await subject.user.spendBenny();
      return result !== false;
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
 * Benny zurückerstatten — Gegenstück zu subjectSpendBenny für Abbruchpfade
 * (Wurf-Dialog abgebrochen, Wurf-Fehler, Hook-Abbruch). Ohne Rückerstattung
 * wäre der Benny verbraucht, obwohl kein Reroll stattgefunden hat.
 * Nutzt die SWADE-API (getBenny) wo vorhanden, sonst Direkt-Update analog
 * zum Spend-Fallback.
 */
export async function subjectRefundBenny(subject) {
  if (!subject) return;
  try {
    if (subject.kind === "actor") {
      if (typeof subject.actor.getBenny === "function") {
        await subject.actor.getBenny();
      } else {
        const cur = Number(subject.actor.system?.bennies?.value ?? 0);
        await subject.actor.update({ "system.bennies.value": cur + 1 });
      }
      return;
    }
    if (subject.kind === "gm") {
      if (typeof subject.user.getBenny === "function") {
        await subject.user.getBenny();
      } else {
        const cur = Number(subject.user.getFlag("swade", "bennies") ?? 0);
        await subject.user.setFlag("swade", "bennies", cur + 1);
      }
    }
  } catch (err) {
    console.error("argas-dice-roller | Benny-Rückerstattung fehlgeschlagen:", err);
  }
}

/**
 * Prüft, ob die Aktion beim GM ankommen kann: Spieler-Ergebnisse werden per
 * Socket an den GM-Client geschickt, der sie als Einziger in die Nachricht
 * schreibt. Ist kein GM verbunden, verpufft der Emit kommentarlos und das
 * Ergebnis geht beim nächsten Re-Render verloren — deshalb hier vorab
 * abbrechen und den Spieler warnen. Für GMs immer true.
 */
export function requireActiveGM() {
  if (game.user.isGM) return true;
  if (game.users.activeGM) return true;
  ui.notifications.warn(game.i18n.localize(`${ADR.ID}.requestRoll.warn.noActiveGM`));
  return false;
}

/**
 * Darf der aktuelle User den Reroll-Klick auslösen?
 *   – Akteur-Subjekt: Owner-Berechtigung am Akteur (Spieler-Owner oder GM).
 *   – GM-Subjekt:     nur der GM-User selbst (seine eigenen Bennies).
 *
 * Optional `message`: Wird der Reroll direkt per message.update() geschrieben
 * (freier Wurf — KEIN Socket-Pfad), muss der Klicker die Nachricht auch
 * ändern dürfen (Autor oder GM). Ein Akteur-Mitbesitzer, der nicht Autor
 * ist, würde sonst erst den Benny verlieren und dann am Update scheitern.
 */
export function subjectCanClick(subject, message = null) {
  if (!subject) return false;
  if (subject.kind === "actor") {
    if (!subject.actor.isOwner) return false;
    if (message && !game.user.isGM && !message.canUserModify(game.user, "update")) return false;
    return true;
  }
  if (subject.kind === "gm") return game.user.id === subject.user.id;
  return false;
}
