# Changelog

## 14.2.1

### New features

- **Fudge dice** — Added a dice function for the *Fate* game system.
- **Bonus / penalty dice (*Call of Cthulhu*)** — Added a dice function for the *Call of Cthulhu* game system.
- **Highest / Lowest (advantage / disadvantage, boon / bane)** — Added a dice function for game systems in which sometimes only the highest or the lowest die result counts (e.g. *D&D*, *Level Up*, *SW5e* or *Dragonbane*).

### Changed

- **SWADE Wild Die** — The option to enable the Wild Card die is no longer restricted to *Savage Worlds*.
- **SWADE mechanics** — The SWADE fumble mechanic can now be enabled for the free-form game systems *Simple World-Building* and *Custom System Builder*.
- **Sidebar button** — The button in the scene controls has been slightly adjusted.
- **Game settings** — The menus in the game settings have been completely reworked and made clearer.

### Bug fixes

- **Group roll** — Participants rolled untrained (d4−2) although they had the skill; the skill is now resolved per actor.
- **Natural ones** — The red highlight now also works for single dice.
- **Exploding dice** — Follow-up dice from explosions no longer count as natural ones.
- **d100** — d100 now explode as well when the corresponding button is enabled.
- **Benny refund** — Cancelled rerolls no longer cost a Benny.
- **Multiple token owners** — When several players have rights to a token, only the player who triggered the roll can now reroll it with a Benny.
- **Dramatic Task deck** — Fixed a bug that could deal the same action card twice in one round. After a Joker, the deck is now shuffled correctly for the next round.
- **Tooltips in the SWADE windows** — In the dialogs of a requested roll, dice were labelled with "W" (e.g. W8) even on the English interface. This is now localised correctly ("d8").

### Multiplayer and stability

- **No GM online** — Players now get a warning instead of silently losing their roll result.
- **Simultaneous rolls** — Two players' results can no longer overwrite each other (GM-side socket queue).
- **Chat suppression** — No longer swallows messages while the SWADE roll dialog is open.
- **Hidden rolls** — On non-public rolls, other players could hear the dice sound or even see a Dice So Nice 3D animation. This has been fixed.
- **Security** — Actor and token names are escaped in chat HTML (protection against HTML injection).
- **CSS and window ID** — All selectors now carry a module prefix, which rules out styling conflicts with other modules.

## 14.0.1 (Initial release)

- System-agnostic dice roller with a configurable roll dialog
- Multi-die rolling via Ctrl + Click
- Dice So Nice integration
- Fate roll support
- Adjustable interface scaling
- Selectable visual themes (Fantasy and Modern)
- German and English localization
- Compatible with Foundry VTT v13 and v14
- Optional features for *Savage Worlds* (SWADE):
  - Wild Die, Benny reroll, fumble detection
  - Request Rolls (Individual, Group, Opposed)
  - Dramatic Tasks
