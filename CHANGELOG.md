# Changelog — Arga's Dice Roller

## 14.2.1

### New

- **Fudge dice (dF)** — New row *Fudge* in the dice window (chat label dF, German WF) (off by default; the GM enables it under *Displayed dice types*). Each die shows +, blank or − (+1/0/−1); 4dF is one click on column 4. Modifiers apply (e.g. 4dF+3), exploding, Wild Die and multi-pool do not. The chat card shows the individual dice as + / ○ / − and the total with its sign; a result of all + is green, all − is red. No Benny reroll on Fudge rolls. Dice So Nice shows real Fudge dice.
- **Highest / Lowest (advantage / disadvantage, boon / bane)** — Two new buttons in the dice window (on by default on D&D 5e (2014 and 2024 rules), Level Up, SW5e and Dragonbane, off elsewhere; the GM toggles them under *Displayed buttons*): all dice are rolled, but only the highest or the lowest one counts, e.g. 2d20 keep highest. The chat card marks the roll with an up/down arrow and shows the discarded dice struck through; the natural-ones rule looks at the counted die only. Not combined with exploding dice, Wild Die or multi-pool rolls (switching one on switches the others off); needs at least two dice; not for coin and Fudge dice. A Benny reroll repeats the roll with the same rule.
- **Bonus / penalty die (Call of Cthulhu)** — Two new buttons (on by default on Call of Cthulhu 7e, off elsewhere; GM toggles them under *Displayed buttons*) for the d100 as in Call of Cthulhu 7th edition: thumbs up = bonus die, thumbs down = penalty die; first click adds one extra tens die, second click two, third click switches off (the small number on the button shows how many). The roll uses one ones die and 2–3 tens dice; the bonus die keeps the lowest tens, the penalty die the highest (00+0 = 100). The chat card shows a thumbs icon with the number of extra dice, and the individual results list every possible result with the discarded ones struck through. Only for a single d100; not combined with exploding dice, Wild Die, Highest/Lowest or multi-pool; no Benny reroll, no natural-ones rule.
- **SWADE mechanics on other systems** — The *SWADE System Mechanics* menu (fumble rule, roll requests) is now also offered on *Simple World-Building* and *Custom System Builder*. There the fumble rule starts disabled; roll requests are greyed out and unavailable, and the window says why.
- **SWADE menu hint** — The *SWADE System Mechanics* menu entry now carries the explanatory text "Additional settings for Savage Worlds." (German: "Zusätzliche Einstellungen für Savage Worlds."), like the other submenus.

### Changed

- **Sidebar button** — The scene-control button now shows the same d20 icon as the dice window (instead of the generic Font Awesome d20) and is drawn larger.
- **Displayed buttons** — The settings for hidden rolls, exploding dice (mode and default), modifiers and the Fate button moved from the main settings panel into one GM-only submenu *Displayed buttons*; the Wild Die button moved there from the SWADE mechanics menu and is now available on every system (on by default only in SWADE). "Exploding by default" is now a world setting instead of a per-user one.
- **Displayed dice types** — The three per-user switches for coin, d2 and d100 are replaced by one GM-only submenu *Displayed dice types* that lists every row of the dice window (coin flip, d2 … d100). The GM decides for the whole world which dice are offered — e.g. d6 only for Shadowrun.
- **Natural ones without Wild Die** — The total of a free roll is now highlighted red whenever the natural-ones rule applies (a single die showing 1, or more than half of the dice showing 1), with or without a Wild Die. Previously the total stayed black unless a Wild Die was rolled.
- **No fumble check on free rolls** — Free rolls no longer offer the GM the "accept result / check for fumble (d6)" choice, neither on the initial roll nor after a Benny reroll. A free roll may not be a trait roll at all, so what follows from a red result is left to the GM. Roll requests keep their fumble check.

### Bug fixes

- **Group roll** — Participants rolled untrained (d4−2) although they had the skill; the skill is now resolved per actor.
- **Natural ones** — The red highlight was suppressed for single dice showing a 1 (mistaken for a coin flip).
- **Exploding dice** — Follow-up dice from explosions no longer count as natural ones.
- **Benny refund** — Cancelled or failed rerolls (dialog closed, roll error, hook abort) no longer cost a Benny.
- **Benny button for co-owners** — Now greyed out for actor co-owners who did not make the roll (previously: Benny spent, result never saved).
- **d100 reroll** — A Benny reroll of a d100 no longer explodes.
- **Dramatic Task deck** — The same card can no longer appear twice in one round; the deck is reshuffled after a round containing a Joker (SWADE rule).

### Multiplayer and stability

- **No GM online** — Players now get a warning instead of silently losing their roll result.
- **Simultaneous rolls** — Two players' results can no longer overwrite each other (GM-side socket queue).
- **Chat suppression** — No longer swallows unrelated messages while the SWADE roll dialog is open.
- **Hidden rolls** — 3D dice animation (Dice So Nice) and dice sound are no longer sent to all clients.
- **Security** — Actor and token names are escaped in chat HTML (HTML injection).

### Interface and polish

- **Dice window** — No longer reopens by itself when a setting changes while it is closed.
- **Long actor names** — Two-line display in chat works again.
- **Tooltips** — Die labels localised: English users see "d8" instead of "W8".
- **CSS and window ID** — All selectors prefixed with the module ID (no more styling conflicts with other modules).
- **Robustness** — Settings registered following Foundry best practice (raw i18n keys), guarded access to third-party settings (Argas Tweaks), localised "Unknown" fallback, `bringToFront` fix for the reload dialog, dead code removed.

## 14.0.1

- Previous release.
