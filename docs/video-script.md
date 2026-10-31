# Hackathon demo video script

**Runtime:** exactly 180 seconds, from 0:00 to 3:00. **Presenter narration:** 354 words. One presenter, browser screen recording, no face camera. The fixed edit durations include clicks, reading pauses, and brief game audio; narration does not fill every second.

## Capture plan

Use one real Meta-powered bug hunt and one matching feature experiment throughout. Record the complete sessions before editing. Show live starts, label accelerated recordings, and keep run, patch, and experiment identities consistent. Never substitute a previous experiment's report for the experiment shown starting.

The script does not assert a win or invent numerical results. Actual counts and verdict remain readable on screen. A legitimate inconclusive result completes the story: the tool prevents an unsupported decision.

**Prepared Forge text:** “Add a Supply Cache during the Rural Farm onboarding step. It costs 5 food and grants 20 wood, with a 120-second cooldown. Use a wooden supply-crate emblem.”

This intervention uses the existing feature-plugin model: unlock step, resource cost, reward, cooldown, and emblem. It is a testable idea, not a demonstrated fix for navigation or placement failure. Inspect the generated values before approval; do not claim the model produced requested values if it did not. Do not present this feature as a code-level UI repair.

The inspected saved farm-step report contains a Research diagnosis that conflicts with its farm-related commentary. The script therefore states the observed stall and explicitly treats the analyst's explanation as a hypothesis. Use the captured source evidence, not a polished but unsupported root-cause claim.

Model names, approval controls, and experiment verdict handling were checked against the supplied repository. This was a source review, not a successful end-to-end runtime test. Screen beats showing transcripts, observation payloads, and cost records can use existing saved artifacts opened in the browser if the app does not expose a dedicated view. Do not build a new dashboard for filming.

The approximately $0.15-per-twenty-minute-hunt claim is intentionally not spoken: it requires a matching duration and complete cost record. The default narration shows recorded spend without treating one estimate as a general price.

## Timed script

| Time | Screen | Action | Narration (exact words) |
|---|---|---|---|
| 0:00–0:08 | Recorded Rush-Clicker failure: Rural Farm objective and repeated attempts; think-aloud visible. | Start on actual gameplay, no title slate. Leave the recorded thought readable. | This player wants to build a farm. It keeps trying, but the village is going nowhere. |
| 0:08–0:20 | Same failure frame, then browser Game Manager; small editorial product-name caption. | Open the Playtest Menu; keep Bug hunting and A/B test visible. | For an indie developer, confusion in the first three minutes can lose a player. Meta Game Onboarding Optimizer helps us investigate before release. |
| 0:20–0:30 | Bug-hunt setup with persona, runner, recording, and Bot ears controls. | Choose Rush-Clicker, Muse Spark, Record video, and Bot ears; click Start bug hunt. | I choose Rush-Clicker and Muse Spark. Five personas test different temperaments, using the real browser rather than a scripted walkthrough. |
| 0:30–0:42 | Actual numbered segmentation frame, then the resulting browser action and commentary. | CUT POINT 1: insert a labelled accelerated recording of the same run; show run ID. Pause acceleration on one decision. | SAM 3.1 segments the screenshot into numbered regions. Muse Spark chooses an action, and the browser executes it. We save the decision and result. |
| 0:42–0:52 | Actual Elder audio event, its transcript, then bot response; placement ghost if captured. | Play a brief Elder phrase without presenter overlap; point to the corresponding transcript and action. | Muse Voice Transcribe supplies what the bot actually hears, not the script. Unclear audio can therefore affect its decision. |
| 0:52–1:05 | Saved same-run bug report: stuck frame, chapter/task, evidence, diagnosis, and proposed fixes. | Show the Stop bot click from the end of that same recorded run (the accelerated insert has covered its minutes); show saving, then Report. Point to farm-step evidence and the proposed explanation. | Stopping saves this run and opens its report. The farm step stalled. The analyst offers an explanation and proposed fixes; the evidence lets me challenge that diagnosis. |
| 1:05–1:18 | A/B setup and free-text idea field. | Open the separate A/B flow. Paste the prepared Supply Cache idea and click Ask Muse Wonder. | Now I test a possible intervention: a supply cache during the farm step. Muse Wonder turns that idea into a configuration patch, not an automatic change. |
| 1:18–1:30 | Actual validated patch card, unlock step, costs, rewards, and generated emblem. | Show the completed response after an honestly labelled elapsed-time edit; inspect each field and emblem. | Here are the proposed costs, rewards, and unlock point. Validation checks the configuration, and Muse Image creates its emblem. I review what would change. |
| 1:30–1:40 | Approve step, with approval control and resulting approved state clearly visible. | Click Approve at 1:35; hold the resulting state for two seconds. | Nothing ships without a human. I approve this candidate for testing; approval is not evidence that it helps. |
| 1:40–1:52 | Playtest setup: selected personas, paired seed set, fixed sample, Meta runner. | Select the prepared matching settings and click Run comparison or Run A/B Playtest, as labelled on this route. | The experiment compares the current game with the approved patch, pairing personas and seeds and fixing the sample before evaluating results. |
| 1:52–2:06 | Real A and B browser recordings, showing the same persona and seed; candidate visible only in B. | CUT POINT 2: insert labelled accelerated paired recordings, then open their completed experiment report. Preserve experiment and patch IDs. | These are recorded runs from that comparison, accelerated here. The patch might help, distract, or do nothing. The bots test it instead of trusting the proposal. |
| 2:06–2:17 | Report primary metric, actual A/B values, completed/planned pairs, and verdict. | Point first to sample count, then A, B, delta, and the actual verdict. Hold numbers legibly. | Here are the paired counts, onboarding completion, and the measured difference. The report gives the verdict supported by this sample, not a promised improvement. |
| 2:17–2:25 | Same report, with sample status and per-persona results visible. | Point to sample status and one persona row; do not imply all personas improve. | Incomplete samples never declare a winner. Even completed samples can be inconclusive. Bot evidence does not replace human playtesting. |
| 2:25–2:38 | Brief recaps of real model selector, numbered mask, audio transcript, and generated emblem. | Use browser captures from the preceding sequence; add small model-name captions only. | Muse Spark and Muse Wonder play and reason. SAM 3.1 segments the screen. Muse Voice Transcribe hears the Elder. Muse Image draws the emblem. |
| 2:38–2:50 | Browser-opened run evidence and actual API usage log with recorded costs; saved report list. | Show the bot's observation payload without secrets, then the matching cost record and latest-first reports. | The player agents receive only visible or audible information. Every Meta call has a cost record, so small teams can inspect both evidence and spending. |
| 2:50–3:00 | Actual game behind an editorial loop graphic; verified public repository link. | Hold the five-step loop and real repository URL; end precisely at 3:00. | Built for our indie world: a repeatable way to investigate onboarding before release. Play, diagnose, propose, approve, verify. |

## Filming checklist

1. Capture a real Meta bug hunt (Rush-Clicker, Muse Spark, Bot ears, Record video) and let it run long enough to reach the farm step before stopping it, with same-run screenshot, recorded commentary, Elder audio transcript, and saved report; redact credentials and keep provider provenance visible. Persona menus open on Story-Guided, so select Rush-Clicker deliberately on camera.
2. Prepare the actual Supply Cache proposal and matched A/B experiment; verify patch identity, approval state, counts, and verdict, and never manufacture a successful outcome or conceal an incomplete sample.
3. Record the full start-to-report flows first; use the two marked cut points for labelled accelerated playback, trim Forge waiting honestly, and keep the human Approve click continuous and unsped.
4. Record the 354-word narration separately, duck game audio, reserve the Elder pause, keep report numbers readable, and show only the verified public repository URL and actual usage records.
5. Edit to the exact interval boundaries, export constant 30 fps with exactly 5,400 frames, and verify a 180.000-second container duration with no extra end slate or audio tail.

