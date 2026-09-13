# Audio Loop Player (Obsidian plugin)

Play mp3/m4a/wav files inside Obsidian with practice-friendly controls: named
A–B loop sections, an optional pause between repeats, and a draggable playback
speed slider. Works on audio embedded in notes (`![[tune.mp3]]`) and on audio
files opened in their own tab.

## Controls

- **Play / seek / time** — standard transport with a draggable seek bar. Each
  saved section is drawn on the bar as a band (accented when it is part of the loop).
- **Set A / Set B** — mark the start and end of the selected section at the playhead.
  Times can also be typed directly into a section row (`1:05.5` or plain seconds).
- **⏮ / ⏭** — jump to the start (A) or end (B) of the selected section.
  Jumping to B does not immediately loop; the loop only restarts when playback
  crosses B from inside the section, so you can listen to what follows.
- **Loop on/off** — repeat the selected section. Turning it on moves the
  playhead into the section if it is outside.
- **Pause between loops** — tick the box and choose 0.1–5 seconds of silence
  before each repeat. The play button pulses during the gap; pressing it
  cancels the loop and leaves playback paused.
- **Sections** — press **+** to add another section, then Set A / Set B to
  mark it. Click a section's number to select it and jump to its start.
  Sections can be named and deleted, and are saved per audio file so they are
  still there the next time you open it.
- **Looping several sections** — shift+click (or cmd/ctrl+click) section
  numbers to add them to the loop. The loop button shows which ones are in it
  (e.g. "Loop on 1+3") and playback runs through them **in list order**, top
  to bottom, with the pause between loops applied at every boundary. Set A /
  Set B and the jump buttons act on the last section you clicked (its number
  is ringed).
- **Reordering** — the ↑ / ↓ buttons on each row move it up or down the list,
  which is also the loop order. The ⇅ button in the Sections header sorts the
  list by start time, handy when sections were marked out of order.
- **Speed** — drag to change playback rate from 0.5× to 1.5× (pitch preserved).
  Tick marks show every step; click a label (0.5×, 0.75×, 1×, 1.5×) to jump to it.

## Commands (bind to hotkeys in Settings → Hotkeys)

All commands act on the player you most recently used:
Play / pause · Set loop start (A) · Set loop end (B) · Toggle loop ·
Jump to loop start · Jump to loop end · Add loop section · Sort loop sections by time ·
Select next / previous section.

## Settings

Default playback speed, whether to enhance audio at all, the default pause
between loops, and a button to forget all saved sections.

## Development

```
npm install
npm run dev      # rebuild on change
npm run build    # type-check and produce main.js
```

Copy `main.js`, `manifest.json` and `styles.css` into
`<vault>/.obsidian/plugins/audio-loop-player/` and reload Obsidian.
