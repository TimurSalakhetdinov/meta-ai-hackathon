# Elder Kaelen: Chapter II to VI announcements (draft for Astra)

Status: applied. Astra returned the final lines in this shape; the game
uses them as chapter opening and task announcements, with ElevenLabs voice
files generated from them. `kaelen_ch6_bronze` was dropped on Astra's
advice (researching Bronze enters the era at once). The lines below are
the original drafts; the applied text matches Astra's table.
Purpose: one Elder Kaelen announcement per chapter opening and per task,
for Chapters II to VI. Chapter I already has recorded lines
(`kaelen_onb_03_handoff`, `kaelen_build_woodcutter`, `kaelen_claim_reward`).

How the game uses them:

- The chapter opening line is spoken once when the chapter starts.
- A task line is spoken once when that task becomes the current task
  (and only when the player can act on it, same rule as the Woodcutter line).
- The existing Claim line covers every chapter completion.
- Voice: ElevenLabs, Elder Kaelen voice `B52raBK48m23qWYbwchQ`,
  `eleven_v4`, stability 0.5, similarity 0.75. Same as the recorded set.

Existing lines, for style (match this voice exactly):

- "There you are, Chief. Raise a Small Home before supper; wet grass makes a poor bed, especially at my age."
- "We have shelter and supper, Chief. Now open Research and learn Basic Toolmaking; after that, you can spare yourself an old man's lessons."
- "Now raise a Woodcutter, Chief. Axes in the greenwood will fill our woodpile, and a full woodpile builds a village."
- "Well worked, Chief. The chapter is complete. Claim your reward; the tribe has earned every bit of it."

Style rules used in this draft:

- One or two sentences, about 90 to 140 characters each.
- Always addresses the player as "Chief".
- Warm old-man humour, valley and hearth imagery, no numbers, no UI words
  like "click" or "button". Game terms allowed: Research, Campaign, hero names.
- No line repeats the meaning of another line.

## Chapter II: Into the Stone Age

Opening (`kaelen_ch2_open`):
"Foundations stand, Chief. Now we learn to work stone; a village that masters stone stops fearing the winter."

Tasks:

- Research Masonry (`kaelen_ch2_masonry`):
  "Open Research and learn Masonry, Chief. Stone laid true lasts longer than any of us."
- Build a Stone Quarry (`kaelen_ch2_quarry`):
  "Raise a Stone Quarry on the ridge, Chief. The mountain has kept its bones long enough; time it shared."
- Awaken the Stone Age (`kaelen_ch2_stone_age`):
  "The Stone Age waits in Research, Chief. Awaken it, and watch this camp become a village before my eyes."

## Chapter III: The Hero's Journey

Opening (`kaelen_ch3_open`):
"Stone under our feet, Chief. Now the tribe needs fire, craft, and heroes worth singing about."

Tasks:

- Build a Copper Smelter (`kaelen_ch3_smelter`):
  "Build a Copper Smelter, Chief. When copper runs like honey, our tools will stop snapping like twigs."
- Upgrade a building to Lv.2 (`kaelen_ch3_upgrade`):
  "Raise one of our buildings higher, Chief. A taller roof keeps more rain out and more pride in."
- Enter the Bronze Age (`kaelen_ch3_bronze`):
  "Bronze glimmers at the end of Research, Chief. Lead us into the Bronze Age, and let the neighbours whisper."

## Chapter IV: Rise of Culture & Prosperity

Opening (`kaelen_ch4_open`):
"We endure, Chief. Now we prosper: full stores, strong walls, and water where we want it."

Tasks:

- Build a Granary (`kaelen_ch4_granary`):
  "Raise a Granary down by the river, Chief. Full bellies in winter are the oldest magic I know."
- Upgrade 2 buildings to Lv.2 (`kaelen_ch4_upgrade2`):
  "Two buildings raised higher, Chief. Prosperity is just good roofs, repeated."
- Research Irrigation (`kaelen_ch4_irrigation`):
  "Learn Irrigation in Research, Chief. Persuade the river to visit our fields, and the fields will thank us."

## Chapter V: Breaking the Sabertooth Wall

Opening (`kaelen_ch5_open`):
"The valley grows, Chief, but the Sabertooth Wall stands. Time our heroes earned their songs."

Tasks:

- Level Tor to Lv.3+ (`kaelen_ch5_tor`):
  "Raise Tor's level through training, Chief. Let him sharpen his skills here before the canyon beasts offer their own lessons."
- Conquer Stage 6: Sabertooth Canyon (`kaelen_ch5_stage6`):
  "Saber-tooths hold the canyon, Chief. Take the Campaign road and break that wall for good."
- Build Barracks or Smelter (`kaelen_ch5_barracks`):
  "Raise a Barracks, or another Smelter, Chief. Songs need soldiers, and soldiers need sharp iron."

## Chapter VI: Dawn of the Bronze Empire

Opening (`kaelen_ch6_open`):
"One last climb, Chief. Shadowclaw waits, and beyond him, an empire with our name on it."

Tasks:

- Enter the Bronze Age (`kaelen_ch6_bronze`):
  "The Bronze Age is ours to claim in Research, Chief. Gleaming spears, at my age. Imagine that."
- Conquer Stage 8 Boss: Shadowclaw (`kaelen_ch6_boss`):
  "Shadowclaw himself, Chief. Take your best into the Campaign and end his reign over these hills."
- Reach 250+ Empire Score (`kaelen_ch6_score`):
  "Grow the village until every valley path leads here, Chief. Build, research, conquer; the score will sing."

Note: `kaelen_ch3_bronze` and `kaelen_ch6_bronze` both point at the Bronze
Age research. Chapter III asks for the research, Chapter VI for entering
the era. Astra: sharpen the difference, or merge into one line.

## Prompt for Astra (paste the whole block)

```text
You are Astra, a dialogue editor for a cozy Viking valley city-builder game.
Below are draft voice lines for Elder Kaelen, the tribe's old advisor.
He speaks to the player, always called "Chief".

Existing recorded lines (match this voice, humour and length exactly):
- "There you are, Chief. Raise a Small Home before supper; wet grass makes a poor bed, especially at my age."
- "We have shelter and supper, Chief. Now open Research and learn Basic Toolmaking; after that, you can spare yourself an old man's lessons."
- "Now raise a Woodcutter, Chief. Axes in the greenwood will fill our woodpile, and a full woodpile builds a village."
- "Well worked, Chief. The chapter is complete. Claim your reward; the tribe has earned every bit of it."

Rules for every rewritten line:
- One or two sentences, 90 to 140 characters.
- Warm old-man humour, hearth, valley, weather and seasons imagery.
- No numbers, no UI words ("click", "tap", "button", "menu").
- Game terms allowed: Research, Campaign, and the hero name Bera.
- Each line must name its task plainly enough that a player who only hears
  the voice knows what to do next.
- Do not make two lines mean the same thing. In particular, the two Bronze
  Age lines (Chapter III "Enter the Bronze Age" = finish the research,
  Chapter VI "Enter the Bronze Age" = be in the era) must feel different,
  or propose one merged replacement.
- Keep the speaker consistent: an old man who has seen everything, is fond
  of the young Chief, and never panics.

Rewrite each draft line below. Return only a table:
| id | final line | characters |
Then one short section: "Cuts and merges", listing any line you would drop
or merge, with the reason.

[PASTE THE CHAPTER II TO VI DRAFT LINES FROM THIS FILE HERE]
```
