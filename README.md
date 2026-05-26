<p align="center">
  <img src="https://img.shields.io/endpoint?url=https://foundryshields.com/version?url=https://raw.githubusercontent.com/Arga-Mods/argas-dice-roller/main/module.json" alt="Foundry Version">
  <a href="https://github.com/Arga-Mods/argas-dice-roller/releases/latest"><img src="https://img.shields.io/github/v/release/Arga-Mods/argas-dice-roller?display_name=tag&sort=semver&label=Latest%20Release&color=4287f5" alt="Latest Release"></a>
  <a href="https://forge-vtt.com/bazaar#package=argas-dice-roller"><img src="https://img.shields.io/badge/dynamic/json?label=Forge%20Installs&query=package.installs&suffix=%25&url=https://forge-vtt.com/api/bazaar/package/argas-dice-roller&colorB=4aa94a" alt="Forge Installs"></a>
  <a href="https://github.com/Arga-Mods/argas-dice-roller/releases"><img src="https://img.shields.io/github/downloads/Arga-Mods/argas-dice-roller/total?label=Downloads%20%28Total%29&color=4aa94a" alt="Downloads Total"></a>
  <a href="https://github.com/Arga-Mods/argas-dice-roller/releases/latest"><img src="https://img.shields.io/github/downloads/Arga-Mods/argas-dice-roller/latest/total?label=Downloads%20%28Latest%29&color=f5a623" alt="Downloads Latest"></a>
</p>

# Arga's Dice Roller

ADR ist in seiner Grundfunktion ein systemagnostisches Würfelmodul für Foundry VTT, welches dem GM zudem die Möglichkeit bietet, mittels Schicksalswurf einen zufälligen Spieler auszuwählen. 

Des Weiteren können im ADR umfangreiche Funktionen und Würfelmechaniken für das Spielsystem **Savage Worlds Adventure Edition (SWADE)** zugeschaltet werden, wie z.B. Kritische Fehlschläge, Benny-Reroll, Probenanforderungen und Dramatische Aufgaben.

<table align="center">
  <tr>
    <td align="center"><img src="screenshots/dice-roller_default.png" height="500"></td>
    <td align="center"><img src="screenshots/dice-roller_swade.png" height="500"></td>
  </tr>
  <tr>
    <td align="center"><em>Dice Roller Default (GM)</em></td>
    <td align="center"><em>Dice Roller SWADE (GM)</em></td>
  </tr>
</table>

<br>

Und für die Darstellung im Chat stehen die Themengrafiken *Fantasy* und *Modern* zur Verfügung. Es kann aber auch der Foundry-Standad genutzt werden.

<table align="center">
  <tr>
    <td align="center"><img src="screenshots/chat_fantasy.png" height="260"></td>
    <td align="center"><img src="screenshots/chat_modern.png" height="260"></td>
  </tr>
  <tr>
    <td align="center"><em>Fantasy Theme (SWADE)</em></td>
    <td align="center"><em>Modern Theme (default)</em></td>
  </tr>
</table>

<br>

## Allgemeine Features
Unabhängig vom Spielsystem hat ***Arga's Dice Roller***  folgende Funktionen: 
- ***Würfelfenster:*** Durch klicken des orangen W20-Icons im linken Control Panel öffnet sich das Würfelfenster mit den Standardwürfeln W4, W6, W8, W10, W12 und W20. Optional zuschaltbar sind: W2, W100 und Münzwürfe.

<table align="center">
  <tr>
    <td align="center"><img src="screenshots/coin_f.png" height="240"></td>
    <td align="center"><img src="screenshots/coin_m.png" height="250"></td>
  </tr>
  <tr>
    <td align="center"><em>Coin Toss (Theme: Fantasy)</em></td>
    <td align="center"><em>Coin Toss (Theme: Modern)</em></td>
  </tr>
</table>

<br>
  
- ***Mischwürfe:*** Hält man beim Klick auf ein Würfelfeld die SHIFT-Taste gedrückt, können mehrere Würfelarten miteinander kombiniert werden (z.B. 2x W8 und 1x W6). Das Loslassen der SHIFT-Taste löst dann den Würfelwurf aus. 
- ***Explodierende Würfel:*** Erreicht ein Würfel sein Maximum, wird er erneut geworfen und die Ergebnisse werden addiert. Es kann eingestellt werden, ob Würfel mehrfach oder nur 1x explodieren können. Im Chat werden Würfel mit der Möglichkeit zum Explodieren mit einem hochgestellten "EX" gekennzeichnet. 
- ***Modifikatoren:**** Die optionalen Modifikator-Buttons gehen von -6 bis +6 und können additiv gedrückt werden. Alternativ kann man den Modifikator auch frei eingeben (maximal zweistellig). Der Modifikator beeinflussen nicht die einzelnen Würfel, sondern nur das Gesamtergebnis (und das Ergebnis des SWADE Wild Die). Die jeweils geltenden Modifikationen werden in der Chat Card farbig hervorgehoben.
- ***Einzelergebnisse:*** Jede Chat Card mit einem Würfelereignis hat einen Button zur Darstellung der Einzelergebnisse. Wurden z.B. mehrere verschiedene Würfel geworfen, oder wurde bei SWADE ein Wurf mittels Benny wiederholt, mag es manchmal wichtig sein, welcher Würfel welches Ergebnis erzielt hat. 
- ***Schicksalswurf (GM only):*** Der GM wählt auf dem Canvas all diejenigen Token aus, zwischen denen zufällig gewählt werden soll. Nach Drücken des Buttons "Schicksalswurf" wird aus den markierten Token zufällig einer ausgewählt und sein Name wird im Chat verkündet.

<table align="center">
  <tr>
    <td align="center"><img src="screenshots/fate_roll.png" height="400"></td>
  </tr>
  <tr>
    <td align="center"><em>Fate Roll</em></td>
  </tr>
</table>

<br>

## Features für Savage Worlds (SWADE)
Bei aktivem SWADE-System werden automatisch zusätzliche Buttons freigeschaltet sowie die Würfelmechaniken von Savage Worlds angewandt: 
- ***Wild Die:*** Ein zusätzlicher W6, der immer explodieren kann. Er wird parallel zu den Eigenschaftwürfeln geworfen und erzielt sein eigenes Ergebnis. Das bessere Ergebnis wird für den Wurf gezählt. Beide Würfel werden im Chat separat ausgewiesen.
- ***Benny-Reroll:*** Akteure können ihren Würfelwurf mit einem Benny wiederholen. Das neue Ergebnis kann aber gemäß den Regeln nicht schlechter sein als das alte, es sei denn, der neue Wurf war ein Kritischer Fehlschlag. Wenn ein Reroll mittels Benny stattgefnden hat, wird dies im Chat dokumentiert und der Benny-Button bekommt eine grüne Umrandung. 
- ***Patzer-Erkennung:*** Erkennt das Modul einen Kritischen Fehlschlag, wird der Benny-Reroll deaktiviert. (GM only:) Hat ein Extra bei einer Probe eine 1 gewürfelt, dann hat der GM die Auswahloption, ob er den Wurf annehmen oder mit einem W6 auf einen kritischen Fehlschlag prüfen möchte. ***HINWEIS:*** Aus Platzgründen wurde der SWADE-Begriff "Kritischer Fehlschlag" an einigen Stellen durch "Fumble" ersetzt". 

<table align="center">
  <tr>
    <td align="center"><img src="screenshots/extra_fumble.png" height="300"></td>
  </tr>
  <tr>
    <td align="center"><em>GM-Check for fumble (Theme: Fantasy)</em></td>
  </tr>
</table>

<br>

### Request Roll (GM only): 
Der GM sendet Probenanforderungen an einen oder mehrere Akteure (an Spieler oder auch an auf dem Canvas befindliche NSC):

- ***Individual Rolls:*** Jeder Akteur würfelt mit einer individuellen Eigenschaft. Es können vom GM auch Proben von mehreren Akteuern gleichzeitig angefordert werden. Sobald ein Akteur ausgewählt wird, werden alle Eigenschaften angezeigt, über die dieser Token verfügt.

 <table align="center">
  <tr>
    <td align="center"><img src="screenshots/request_f.png" height="300"></td>
  </tr>
  <tr>
    <td align="center"><em>Requested Roll (Theme: Fantasy)</em></td>
  </tr>
</table>

<br>

   - ***Group Check:*** Alle ausgewählten Spielercharaktere (diesmal nicht NSC) testen auf dieselbe Eigenschaft (z.B. Wahrnehmung). Solange noch kein Charakter ausgewählt wurde, werden unterhalb alle Eigenschaften angezeigt, über die zumindest einer der Charaktere verfügt. Dabei werden solche Eigenschaften gelb hervorgehoben, die nicht bei allen vorhanden sind. Bei Mouse over über einem Charakter werden solche Eigenschaften rot dargestellt, die dieser Charakter nicht hat. Und bei Mouse over über einer Eigenschaft wird ein Tooltipp mit allen Akteuren angezeigt, die diese Eigenschat haben. ***HINWEIS ZUR PROBENANFORDERUNG:*** Wenn nur die zu testenede Eigenschaft angeklickt wird, dann werden automatisch *alle* verfügbaren Spieler ausgewählt.

<table align="center">
  <tr>
    <td align="center"><img src="screenshots/check_all.png" height="500"></td>
  </tr>
  <tr>
    <td align="center"><em>Group Check</em></td>
  </tr>
</table>

<br>

<table align="center">
  <tr>
    <td align="center"><img src="screenshots/check_single.png" height="500"></td>
  </tr>
  <tr>
    <td align="center"><em>Group Check (Mouse over a Character)</em></td>
  </tr>
</table>

<br>

<table align="center">
  <tr>
    <td align="center"><img src="screenshots/check_stats.png" height="400"></td>
  </tr>
  <tr>
    <td align="center"><em>Group Check (Mouse over a Trait)</em></td>
  </tr>
</table>

 <br>
 
- ***Opposed Test:*** Zwei Akteure treten mit individuellen Eigenschaften gegeneinander an (z.B. Notice vs. Stealth). Der Gewinner wird farbig im Chat hervorgehoben.

<table align="center">
  <tr>
    <td align="center"><img src="screenshots/opposed_modern_pending.png" height="270"></td>
    <td align="center"><img src="screenshots/opposed_fantasy_complete.png" height="270"></td>
  </tr>
  <tr>
    <td align="center"><em>Opposed Test -Pending- (Theme: Modern)</em></td>
    <td align="center"><em>Opposed Test -Complete- (Theme: Fantasy)</em></td>
  </tr>
</table>

<br>
  
- ***Dramatische Aufgabe:*** Ein oder mehrere Akteure müssen in einer vom GM festgelegten Anzahl an Runden mit einer individuellen Eigenschaft eine bestimmte Anzahl an Erfolgen schaffen. Der GM kann die Rahmenbedingungen frei wählen, oder er legt über entsprechende Buttons die vom SWADE Regelsystem vorgeschlagenen Schwierigkeitgrade fest. Bei der Dramatischen Aufgabe verwaltet das Modul den Aufgabenfortschritt und führt den Spieler mit Buttons durch seine Optionen, wie z.B. das Unterstützen anderer Akteure. Das Modul simuliert jede Runde das Ziehen von Aktionskarten und berücksichtigt die regeltechnischen Auswirkungen von Joker-/ oder Kreuz-Karten.

<table align="center">
  <tr>
    <td align="center"><img src="screenshots/dramatic_window.png" height="600"></td>
    <td align="center"><img src="screenshots/dramatic_chat.png" height="600"></td>
  </tr>
  <tr>
    <td align="center"><em>Request a Dramatic Task</em></td>
    <td align="center"><em>Dramatic Task in Chat</em></td>
  </tr>
</table>

<br>
  
- ***Unskilled Attempts:*** Wenn das Modul erkennt, dass eine angeforderte Eigenschaft bei einem Akteur nicht verfügbar ist, wird automatisch eine "unskilled" Probe mit W4 -2 geworfen. 

<br>

## Sonstiges
- ***Lokalisierung:*** Das Modul ist derzeit in Englisch und in Deutsch verfügbar. 
- ***Dice So Nice:*** Wenn das Modul DSN installiert und aktiviert ist, werden alle Würfe – inklusive Wild Die, explodierender Würfel und Bennies – mit den gewohnten 3D-Animationen ausgegeben.
  
---

## Meine anderen Module
Wenn dir ***Arga's Dice Roller*** gefällt, dann schaue dir auch gerne meine anderen Module an:

* **[Arga's Day-Night Slider](https://github.com/Arga-Mods/argas-day-night-slider)** – Schieberegler für einen sanften Tag-/Nacht-Wechsel deiner Szenen.
* **[Arga's Benny & Wound Panel (SWADE)](https://github.com/Arga-Mods/argas-benny-and-wound-panel-swade)** – A panel for quick adjustment of Bennies, Wounds, and Fatigue on selected tokens. Designed for Savage Worlds.
---

<p align="center"><em>Enjoy — Arga</em></p>
