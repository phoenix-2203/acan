# ACAN demo film

A 2:50 technical product film for the hackathon submission, built from ACAN's real interface and verified testnet results.

| File | What it is |
|---|---|
| `BRIEF.md` | Audience, message, rules |
| `FACTS.md` | Every claim in the film, its status and evidence |
| `CAPABILITIES.md` | What the film shows and why |
| `STORYBOARD.md` | Scene by scene: time, visual, text, voiceover, facts |
| `VOICEOVER.md` | The narration with its timings |
| `captures/` | Real ACAN components, captured at 2x (see below) |
| `renderer/` | The film (`film.html`), capture, still and render scripts, voice and mix |
| `renders/` | Output (not committed): MP4s, stills, audio |
| `recordings/` | Your own screen recordings (not committed) |

## How the UI captures are made

`renderer/capture-dashboard.mjs` and `renderer/capture-site.mjs` render the real React components from `apps/web` and `apps/site` in Chromium, with ACAN's fonts, in the dark theme. Copy the harness files first:

```sh
cp video/renderer/harness/web/harness-video.html apps/web/ && cp video/renderer/harness/web/harness-video.tsx apps/web/src/
cp video/renderer/harness/site/harness-video.html apps/site/
(cd apps/web && npx vite --port 5199) & (cd apps/site && npx vite --port 5198) &
cd video/renderer && node capture-dashboard.mjs && node capture-site.mjs
```

What is real and what is staged in the captures:

- **Real:** the components, their layout and wording; rule #12's numbers; the refusal code and text (#3401, from `explainRefusal`); transaction `4394246d…`; the `npm run status` and `receipt:verify` output (copied from actual runs).
- **Staged:** the AI's own sentences in the chat bubbles (a scripted model stands in, because the chain and the live model are not reachable from the build machine). The outcomes they lead to (paid 0.8 XLM to Southgate; blocked #3401) are the ones observed on testnet on 8 Oct 2026.

## Render

```sh
cd video/renderer
npm install                                   # Playwright and the brand fonts
node stills.mjs 5 9.5 46 82 95                # check frames first
node render.mjs 30 0 170                      # silent film → renders/film-silent.mp4
python3 voice/synth.py af_heart <dir>         # narration (Kokoro TTS; model files not included)
python3 voice/mix.py <dir> voice/timing.json ../renders/soundtrack.wav
ffmpeg -i ../renders/film-silent.mp4 -i ../renders/soundtrack.wav -c:v copy -c:a aac -b:a 192k -shortest ../renders/ACAN_2m50_Hackathon_Master.mp4
```

`film.html` is a pure timeline: `seek(t)` draws the frame for time `t` from nothing else, so every render is identical. Open it in a browser with `?t=95` to look at any moment.

## Swapping in your own recordings

The strongest proof is a real screen recording of the same moments. Put clips in `recordings/` and replace a capture `<img>` in `film.html` with a `<video>` whose `currentTime` is set from `t` in `seek`.
