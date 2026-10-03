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
  mark it. The first section starts at 0:00, and each new section starts where
  the previous one ends, so you often only need Set B. Both can be overwritten. Click a section's number to select it and jump to its start.
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

## Sections from a note (`loops` code block)

A note can list sections for an audio file, e.g. as written by trad-split
under each embed:

````markdown
![[Sessions/Set 1.m4a]]

```loops
file: Sessions/Set 1.m4a
0:00 - 2:18 | Tune 1
2:18 - 4:34.3 | Tune 2 ?
```
````

- `file:` is the audio file's vault-relative path. Without it, the closest
  audio embed above the block is used.
- Each other line is `start - end | name`. Times count from the start of the
  file and may be `m:ss`, `m:ss.s`, `h:mm:ss` or plain seconds. The name and
  the end are optional. Names are shown exactly as written.
- The block is drawn as a one-line status; the sections appear in the player.
  If any line can't be read, nothing is loaded and the problems are listed.

The note's sections are loaded when the file has no saved sections, and are
reloaded whenever the note changes as long as the player's sections haven't
been edited since the last load. Once you edit sections in the player, the
note never overwrites them silently: the block says they differ and offers a
**Use the note's sections** button. The plugin never writes to the note.

### Starting on one section (`select:`)

When a note is about one tune in a longer file, add a `select:` line so the
player is ready on that tune when you open the note. Nothing plays until you
press play.

````markdown
```loops
file: Sessions/Set 1.m4a
select: 2
0:00 - 2:18 | Tune 1
2:18 - 4:34.3 | Tune 2
4:34.3 - 6:50 | Tune 3
```
````

- `select: 2` selects section 2, moves the playhead to its start, plays it
  **once** and stops at its end, back at its start, so play repeats it.
- `select: 2 loop` turns Loop on, so section 2 repeats.
- `select: 2 continue` starts at section 2 and plays on through the rest of
  the file.

The selection is applied each time you arrive at the note, not while you edit
it, and never while the audio is playing. Clicking another section, turning
Loop on or dragging the playhead out of the section ends the play-once
behaviour. Selection is saved per audio file, so a note without `select:`
shows whatever was last selected. `once` and `loop` need the section to have
an end time. An unreadable `select:` line counts as a problem like any other,
so nothing in the block is loaded until it is fixed.

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
