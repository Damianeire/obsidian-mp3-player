import {
	App,
	MarkdownPostProcessorContext,
	MarkdownView,
	normalizePath,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	setIcon,
	TFile,
} from "obsidian";
import {
	CENTS_PER_TONE,
	formatPitch,
	MAX_PITCH_CENTS,
	MIN_PITCH_CENTS,
	PITCH_FINE_STEP,
	PitchEngine,
} from "./pitch";

const AUDIO_EXTENSIONS = ["mp3", "m4a", "wav"];

// Non-linear speed scale: fine-grained steps around normal speed, coarser further out.
const SPEED_STEPS = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1, 1.1, 1.2, 1.3, 1.4, 1.5];
const DEFAULT_SPEED_INDEX = SPEED_STEPS.indexOf(1);

/** How long a note's `select:` waits for its player to appear before giving up. */
const SELECT_WAIT_MS = 5000;
const SELECT_RETRY_MS = 200;

const MIN_PAUSE_SECONDS = 0.1;
const MAX_PAUSE_SECONDS = 5;

/** One A–B range. Either end may be unset while the user is still marking it. */
interface LoopSection {
	name: string;
	start: number | null;
	end: number | null;
}

/** Everything remembered about one audio file's sections. */
interface FileLoopState {
	sections: LoopSection[];
	/** Indices of the sections that loop together (shift+click), ascending. */
	selected: number[];
	/** The one section Set A / Set B / jump act on; always a member of `selected`. */
	primary: number;
	/**
	 * The sections last loaded from a `loops` block in a note. Comparing against this
	 * tells a note update (safe to apply) apart from the user's own edits in the player.
	 */
	noteSections?: LoopSection[];
}

interface AudioLoopPlayerSettings {
	defaultSpeed: number;
	enhanceEmbeds: boolean;
	pauseBetweenLoops: boolean;
	pauseSeconds: number;
	/** Saved sections keyed by vault path of the audio file. */
	fileLoops: Record<string, FileLoopState>;
	/** Pitch shift in cents keyed by vault path, for files not left at 0. */
	filePitch: Record<string, number>;
	/** Players start as a compact mini-player (play, seek bar, time) unless expanded. */
	collapseByDefault: boolean;
	/** Collapsed/expanded choice keyed by vault path, for files the user has toggled. */
	fileCollapsed: Record<string, boolean>;
}

const DEFAULT_SETTINGS: AudioLoopPlayerSettings = {
	defaultSpeed: 1,
	enhanceEmbeds: true,
	pauseBetweenLoops: false,
	pauseSeconds: 1,
	fileLoops: {},
	filePitch: {},
	collapseByDefault: false,
	fileCollapsed: {},
};

type CompleteSection = LoopSection & { start: number; end: number };

function isComplete(section: LoopSection): section is CompleteSection {
	return section.start !== null && section.end !== null;
}

function formatTime(seconds: number): string {
	if (!isFinite(seconds) || seconds < 0) return "0:00";
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60)
		.toString()
		.padStart(2, "0");
	return `${m}:${s}`;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

function speedIndexFor(speed: number): number {
	const idx = SPEED_STEPS.indexOf(speed);
	return idx === -1 ? DEFAULT_SPEED_INDEX : idx;
}

const AUDIO_MIME: Record<string, string> = { mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav" };

/** True when Web Audio may read this source as is (e.g. mobile, where vault files share the page's origin). */
function isSameOriginSource(src: string): boolean {
	try {
		const url = new URL(src, window.location.href);
		if (url.protocol === "blob:" || url.protocol === "data:") return true;
		// Custom schemes such as desktop's app:// can report a "null" origin on both sides.
		return (url.protocol === "http:" || url.protocol === "https:") && url.origin === window.location.origin;
	} catch {
		return false;
	}
}

function isAudioSource(src: string): boolean {
	const clean = src.split("?")[0].toLowerCase();
	return AUDIO_EXTENSIONS.some((ext) => clean.endsWith(`.${ext}`));
}

// Formats with one decimal place of seconds (e.g. "1:05.5") so loop points can be typed precisely.
function formatTimeInput(seconds: number): string {
	if (!isFinite(seconds) || seconds < 0) return "0:00.0";
	const m = Math.floor(seconds / 60);
	const s = (seconds % 60).toFixed(1).padStart(4, "0");
	return `${m}:${s}`;
}

// Accepts "M:SS", "M:SS.s", "H:MM:SS(.s)" or a plain number of seconds.
function parseTimeInput(value: string): number | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	const match = trimmed.match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
	if (match) return parseInt(match[1] ?? "0", 10) * 3600 + parseInt(match[2], 10) * 60 + parseFloat(match[3]);
	if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return null;
	return parseFloat(trimmed);
}

/** A start time, or a start and end, given in an embed's alias: `![[tune.mp3|1:23-1:45]]`. */
interface EmbedSpec {
	start: number;
	end: number | null;
}

const EMBED_TIME = String.raw`\d+(?::\d+){0,2}(?:\.\d+)?`;
const EMBED_SPEC_RE = new RegExp(`^(?:t=)?(${EMBED_TIME})(?:\\s*(?:-|\u2013|to)\\s*(${EMBED_TIME}))?$`, "i");

/**
 * Reads an embed alias as a time: `1:23`, `83`, `t=1:23`, `1:23-1:45`, `1:23 to 1:45`.
 * Anything else (an ordinary alias such as a file name) gives null, so it is ignored.
 */
function parseEmbedSpec(raw: string | null | undefined): EmbedSpec | null {
	if (!raw) return null;
	const match = EMBED_SPEC_RE.exec(raw.trim());
	if (!match) return null;
	const start = parseTimeInput(match[1]);
	if (start === null) return null;
	const end = match[2] ? parseTimeInput(match[2]) : null;
	if (match[2] && (end === null || end <= start)) return null;
	return { start, end };
}

/** Identity of a section list, for telling whether two lists are the same. */
function sectionsKey(sections: LoopSection[]): string {
	return JSON.stringify(sections.map((s) => [s.name, s.start, s.end]));
}

function copySections(sections: LoopSection[]): LoopSection[] {
	return sections.map((s) => ({ name: s.name, start: s.start, end: s.end }));
}

/**
 * What happens when a note-selected section reaches its end:
 * - once: pause and go back to its start;
 * - loop: repeat it (Loop on);
 * - continue: play on into the rest of the file.
 */
type SelectMode = "once" | "loop" | "continue";

interface NoteSelection {
	/** Zero-based section index. */
	index: number;
	mode: SelectMode;
}

interface LoopsBlock {
	/** Vault-relative path from the `file:` line, if there was one. */
	file: string | null;
	/** From a `select:` line: the section the note is about. */
	select: NoteSelection | null;
	sections: LoopSection[];
	errors: string[];
}

/**
 * Parses a `loops` code block:
 *
 *     file: Sessions/Set 1.m4a
 *     select: 2 loop
 *     0:00 - 2:18 | Tune 1
 *     2:18 - 4:34.3 | Tune 2 ?
 *
 * The name (after `|`) and the end time are optional. `select:` takes a section
 * number and optionally `once` (the default), `loop` or `continue`.
 */
function parseLoopsBlock(source: string): LoopsBlock {
	const block: LoopsBlock = { file: null, select: null, sections: [], errors: [] };
	let selectLine = 0;
	source.split("\n").forEach((raw, i) => {
		const line = raw.trim();
		if (!line) return;
		const fileMatch = line.match(/^file\s*:\s*(.+)$/i);
		if (fileMatch) {
			block.file = fileMatch[1].trim();
			return;
		}
		if (/^select\s*:/i.test(line)) {
			const selectMatch = line.match(/^select\s*:\s*(\d+)(?:\s+(once|loop|continue))?$/i);
			if (!selectMatch || parseInt(selectMatch[1], 10) < 1) {
				block.errors.push(`Line ${i + 1}: can't read "${line}" (use e.g. "select: 2", "select: 2 loop" or "select: 2 continue")`);
				return;
			}
			block.select = {
				index: parseInt(selectMatch[1], 10) - 1,
				mode: (selectMatch[2]?.toLowerCase() ?? "once") as SelectMode,
			};
			selectLine = i + 1;
			return;
		}
		const match = line.match(/^([\d:.]+)\s*[-–—]\s*([\d:.]*)\s*(?:\|(.*))?$/);
		const start = match ? parseTimeInput(match[1]) : null;
		const end = match && match[2] ? parseTimeInput(match[2]) : null;
		if (!match || start === null || (match[2] && end === null)) {
			block.errors.push(`Line ${i + 1}: can't read "${line}"`);
			return;
		}
		if (end !== null && end <= start) {
			block.errors.push(`Line ${i + 1}: end is not after start`);
			return;
		}
		block.sections.push({ name: (match[3] ?? "").trim(), start, end });
	});
	if (block.select) {
		const section = block.sections[block.select.index];
		if (!section) {
			block.errors.push(`Line ${selectLine}: there is no section ${block.select.index + 1}`);
			block.select = null;
		} else if (block.select.mode !== "continue" && section.end === null) {
			block.errors.push(`Line ${selectLine}: section ${block.select.index + 1} needs an end time to play once or loop`);
			block.select = null;
		}
	}
	return block;
}

/**
 * Builds a play/seek/loop/speed control bar around an existing <audio> element.
 * Used by both the full-tab file view and the enhanced markdown embed.
 */
class AudioControls {
	/** The player most recently created or interacted with; commands/hotkeys are routed here. */
	static active: AudioControls | null = null;
	/** Every player on screen, so sections loaded from a note can reach one that is already open. */
	static instances = new Set<AudioControls>();

	private audio: HTMLAudioElement;
	private state: FileLoopState;
	private loopEnabled = false;
	private seekDragging = false;
	/** Last playhead position we saw, used to detect crossing the loop end from inside the section. */
	private lastTime = 0;
	/** True while we are in the optional silent gap between loop repeats. */
	private inGap = false;
	private gapTimer: number | null = null;
	private rafId: number | null = null;

	private root: HTMLElement;
	private timeLabel: HTMLElement;
	private seek: HTMLInputElement;
	private seekMarks: HTMLElement;
	/** Index of the section the multi-section loop is currently playing through. */
	private activeLoop = -1;
	/** Section to play once and then stop at (a note's `select:`), or -1. */
	private onceSection = -1;
	/**
	 * The 0:00-to-end section put in a file that has none, so Loop is one click away.
	 * Not saved until the user changes it or adds to it, so a `loops` block written
	 * later still loads cleanly.
	 */
	private autoSection: LoopSection | null = null;
	/** The end it was given, to tell it apart from an edited one. */
	private autoEnd = 0;
	private playBtn: HTMLButtonElement;
	private collapseBtn: HTMLButtonElement;
	private loopToggleBtn: HTMLButtonElement;
	private sectionList: HTMLElement;
	private speedLabel: HTMLElement;
	/** Pitch shift in cents; 0 leaves the audio untouched. */
	private pitchCents: number;
	private pitchInput: HTMLInputElement;
	private pitchLabel: HTMLElement;
	private pitchResetBtn: HTMLButtonElement;
	private pitchNode: AudioWorkletNode | null = null;
	/** In-memory copy of the file the audio plays from once routed through the pitch shifter. */
	private blobUrl: string | null = null;

	constructor(
		container: HTMLElement,
		audio: HTMLAudioElement,
		private plugin: AudioLoopPlayerPlugin,
		readonly storageKey: string
	) {
		this.root = container;
		this.audio = audio;
		this.audio.playbackRate = plugin.settings.defaultSpeed;

		this.state = AudioControls.loadState(plugin.settings.fileLoops[storageKey]);
		this.pitchCents = plugin.settings.filePitch[storageKey] ?? 0;

		this.build();
		this.renderSections();
		this.syncLoopUi();
		this.syncPitchUi();
		this.setCollapsed(plugin.settings.fileCollapsed[storageKey] ?? plugin.settings.collapseByDefault, false);
		// Route it now rather than on play, so swapping in the local copy can't interrupt playback.
		if (this.pitchCents !== 0) void this.applyPitch();
		AudioControls.active = this;
		AudioControls.instances.add(this);
	}

	/** Re-reads this file's sections from settings after something else replaced them. */
	static reloadAll(storageKey: string) {
		for (const player of AudioControls.instances) {
			if (!player.isConnected()) {
				AudioControls.instances.delete(player);
			} else if (player.storageKey === storageKey) {
				player.reloadState();
			}
		}
	}

	private reloadState() {
		this.cancelGap(true);
		this.loopEnabled = false;
		this.activeLoop = -1;
		this.onceSection = -1;
		this.state = AudioControls.loadState(this.plugin.settings.fileLoops[this.storageKey]);
		this.autoSection = null;
		this.addWholeFileSection();
		this.renderSections();
		this.syncLoopUi();
	}

	/** Gives a file with no sections one spanning the whole file, once its duration is known. */
	private addWholeFileSection() {
		const duration = this.audio.duration;
		if (this.state.sections.length > 0 || !isFinite(duration) || duration <= 0) return;
		this.autoEnd = duration;
		this.autoSection = { name: "", start: 0, end: duration };
		this.state.sections.push(this.autoSection);
		this.state.selected = [0];
		this.state.primary = 0;
	}

	/** True while the only section is the automatic whole-file one, unchanged. */
	private onlyAutoSection(): boolean {
		const auto = this.autoSection;
		return (
			auto !== null &&
			this.state.sections.length === 1 &&
			this.state.sections[0] === auto &&
			auto.name === "" &&
			auto.start === 0 &&
			auto.end === this.autoEnd
		);
	}

	isConnected(): boolean {
		return this.root.isConnected;
	}

	/** True when the player is drawn somewhere inside `el`. */
	isInside(el: Element): boolean {
		return el.contains(this.root);
	}

	/** Every player on screen for one audio file. */
	static playersFor(storageKey: string): AudioControls[] {
		return Array.from(AudioControls.instances).filter((p) => p.isConnected() && p.storageKey === storageKey);
	}

	/** Copies saved state, migrating the 0.2.0 shape where `selected` was a single index. */
	private static loadState(saved: FileLoopState | undefined): FileLoopState {
		if (!saved) return { sections: [], selected: [], primary: -1 };
		const sections = saved.sections.map((s) => ({ ...s }));
		const rawSelected: unknown = saved.selected;
		let selected: number[] = Array.isArray(rawSelected)
			? rawSelected.filter((i): i is number => typeof i === "number")
			: typeof rawSelected === "number"
			? [rawSelected]
			: [];
		selected = selected.filter((i) => i >= 0 && i < sections.length).sort((a, b) => a - b);
		let primary = typeof saved.primary === "number" ? saved.primary : selected[0] ?? -1;
		if (!selected.includes(primary)) primary = selected[0] ?? -1;
		return { sections, selected, primary };
	}

	destroy() {
		AudioControls.instances.delete(this);
		this.stopTicking();
		this.clearGapState();
		this.audio.pause();
		if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
	}

	// ---------------------------------------------------------------- UI construction

	private build() {
		const root = this.root;
		const settings = this.plugin.settings;
		root.addClass("alp-controls");
		root.addEventListener("pointerdown", () => {
			AudioControls.active = this;
		});
		// In Live Preview the embed sits inside a draggable widget in the CodeMirror
		// editor: a mouse drag on a slider would otherwise start dragging the whole
		// embed (or a text selection) instead of moving the thumb. dragstart fires on
		// the draggable ancestor itself, so it cannot be intercepted here; instead the
		// ancestors are made non-draggable for the duration of the press.
		for (const type of ["pointerdown", "touchstart"]) {
			root.addEventListener(type, (e) => e.stopPropagation());
		}
		root.addEventListener("mousedown", (e) => {
			e.stopPropagation();
			const suspended: HTMLElement[] = [];
			for (let el = root.parentElement; el; el = el.parentElement) {
				if (el.draggable) {
					el.draggable = false;
					suspended.push(el);
				}
			}
			if (suspended.length === 0) return;
			const restore = () => suspended.forEach((el) => (el.draggable = true));
			window.addEventListener("mouseup", restore, { once: true });
		});

		// --- Transport row: play/pause, seek bar, time ---
		const transport = root.createDiv({ cls: "alp-row alp-transport" });
		this.playBtn = transport.createEl("button", {
			cls: "alp-play-btn",
			attr: { "aria-label": "Play" },
		});
		setIcon(this.playBtn, "play");
		const seekWrap = transport.createDiv({ cls: "alp-slider-wrap alp-seek-wrap" });
		this.seekMarks = seekWrap.createDiv({ cls: "alp-seek-marks" });
		this.seek = seekWrap.createEl("input", { cls: "alp-seek" }) as HTMLInputElement;
		this.seek.type = "range";
		this.seek.min = "0";
		this.seek.max = "0";
		this.seek.step = "0.01";
		this.seek.value = "0";
		this.timeLabel = transport.createSpan({ cls: "alp-time", text: "0:00 / 0:00" });
		this.collapseBtn = transport.createEl("button", { cls: "alp-btn alp-icon-btn alp-collapse-btn" });
		this.collapseBtn.addEventListener("click", () => this.setCollapsed(!this.isCollapsed(), true));

		// --- Loop row: mark A/B on the selected section, jump to either end, toggle looping ---
		const loopRow = root.createDiv({ cls: "alp-row alp-loop-row" });
		const setStartBtn = loopRow.createEl("button", {
			cls: "alp-btn",
			text: "Set A",
			attr: { title: "Set the selected section's start to the playhead" },
		});
		const setEndBtn = loopRow.createEl("button", {
			cls: "alp-btn",
			text: "Set B",
			attr: { title: "Set the selected section's end to the playhead" },
		});
		const jumpStartBtn = this.iconButton(loopRow, "skip-back", "Jump to loop start (A)");
		const jumpEndBtn = this.iconButton(loopRow, "skip-forward", "Jump to loop end (B)");
		this.loopToggleBtn = loopRow.createEl("button", {
			cls: "alp-btn alp-loop-toggle",
			text: "Loop off",
		});

		// --- Pause row: optional silent gap between repeats ---
		const pauseRow = root.createDiv({ cls: "alp-row alp-pause-row" });
		const pauseLabel = pauseRow.createEl("label", { cls: "alp-pause-label" });
		const pauseToggle = pauseLabel.createEl("input", { attr: { type: "checkbox" } }) as HTMLInputElement;
		pauseToggle.checked = settings.pauseBetweenLoops;
		pauseLabel.createSpan({ text: "Pause between loops" });
		const pauseInput = pauseRow.createEl("input", {
			cls: "alp-number-input",
			attr: {
				type: "number",
				min: String(MIN_PAUSE_SECONDS),
				max: String(MAX_PAUSE_SECONDS),
				step: "0.1",
				title: `${MIN_PAUSE_SECONDS}–${MAX_PAUSE_SECONDS} seconds`,
			},
		}) as HTMLInputElement;
		pauseInput.value = String(settings.pauseSeconds);
		pauseInput.disabled = !settings.pauseBetweenLoops;
		pauseRow.createSpan({ cls: "alp-unit", text: "s" });

		// --- Sections: numbered list of saved A–B ranges for this file ---
		const sections = root.createDiv({ cls: "alp-sections" });
		const header = sections.createDiv({ cls: "alp-sections-header" });
		header.createSpan({ cls: "alp-sections-title", text: "Sections" });
		const headerBtns = header.createDiv({ cls: "alp-sections-header-btns" });
		const sortBtn = this.iconButton(headerBtns, "arrow-down-narrow-wide", "Sort sections by start time");
		const addBtn = this.iconButton(headerBtns, "plus", "Add a new section");
		this.sectionList = sections.createDiv({ cls: "alp-section-list" });

		// --- Speed row: draggable, no click-to-edit ---
		const speedRow = root.createDiv({ cls: "alp-row alp-speed-row" });
		speedRow.createSpan({ cls: "alp-speed-icon", text: "Speed" });
		const speedWrap = speedRow.createDiv({ cls: "alp-slider-wrap alp-speed-wrap" });
		const speedSlider = speedWrap.createEl("input", { cls: "alp-speed-slider" }) as HTMLInputElement;
		speedSlider.type = "range";
		speedSlider.min = "0";
		speedSlider.max = String(SPEED_STEPS.length - 1);
		speedSlider.step = "1";
		const startIndex = speedIndexFor(settings.defaultSpeed);
		speedSlider.value = String(startIndex);

		// Tick marks under the slider, one per step; the round numbers get a label
		// and can be clicked to jump straight to that speed.
		const ticks = speedWrap.createDiv({ cls: "alp-ticks" });
		const labelled = [0.5, 0.75, 1, 1.5];
		SPEED_STEPS.forEach((speed, i) => {
			const tick = ticks.createDiv({ cls: "alp-tick" });
			tick.style.left = `calc(var(--alp-thumb) / 2 + (100% - var(--alp-thumb)) * ${i / (SPEED_STEPS.length - 1)})`;
			if (labelled.includes(speed)) {
				tick.addClass("is-major");
				const label = tick.createSpan({ cls: "alp-tick-label", text: `${speed}×` });
				label.addEventListener("click", () => {
					speedSlider.value = String(i);
					speedSlider.dispatchEvent(new Event("input"));
				});
			}
		});

		this.speedLabel = speedRow.createSpan({
			cls: "alp-speed-label",
			text: `${SPEED_STEPS[startIndex]}×`,
		});

		// --- Pitch row: shift by a tone, or by cents for fine tuning to a recording ---
		const pitchRow = root.createDiv({ cls: "alp-row alp-pitch-row" });
		pitchRow.createSpan({ cls: "alp-speed-icon", text: "Pitch" });
		const pitchButton = (text: string, title: string, delta: number) => {
			const btn = pitchRow.createEl("button", { cls: "alp-btn alp-pitch-btn", text, attr: { title } });
			btn.addEventListener("click", () => this.shiftPitch(delta));
		};
		pitchButton("\u22121 tone", "Lower the pitch by a tone", -CENTS_PER_TONE);
		pitchButton(`\u2212${PITCH_FINE_STEP}¢`, `Lower the pitch by ${PITCH_FINE_STEP} cents`, -PITCH_FINE_STEP);
		this.pitchInput = pitchRow.createEl("input", {
			cls: "alp-number-input alp-pitch-input",
			attr: {
				type: "number",
				min: String(MIN_PITCH_CENTS),
				max: String(MAX_PITCH_CENTS),
				step: "1",
				title: "Pitch shift in cents (100 = a semitone, 200 = a tone)",
			},
		}) as HTMLInputElement;
		pitchRow.createSpan({ cls: "alp-unit", text: "¢" });
		pitchButton(`+${PITCH_FINE_STEP}¢`, `Raise the pitch by ${PITCH_FINE_STEP} cents`, PITCH_FINE_STEP);
		pitchButton("+1 tone", "Raise the pitch by a tone", CENTS_PER_TONE);
		const pitchStatus = pitchRow.createSpan({ cls: "alp-pitch-status" });
		this.pitchLabel = pitchStatus.createSpan({ cls: "alp-pitch-label" });
		this.pitchResetBtn = this.iconButton(pitchStatus, "rotate-ccw", "Reset pitch");

		// --- Wire events ---
		this.playBtn.addEventListener("click", () => this.togglePlay());
		this.audio.addEventListener("play", () => {
			AudioControls.active = this;
			this.plugin.pitch.resume();
			this.clearGapState();
			this.setPlayUi(true);
			this.startTicking();
		});
		this.audio.addEventListener("pause", () => {
			this.stopTicking();
			// A gap pause is part of looping; keep showing the "playing" state during it.
			if (!this.inGap) this.setPlayUi(false);
		});
		this.audio.addEventListener("ended", () => this.checkLoop());

		// The audio may already be loaded when we attach (e.g. the plugin was reloaded
		// onto an existing embed), in which case loadedmetadata will never fire again,
		// so read the duration now as well as on the events.
		this.audio.addEventListener("loadedmetadata", () => this.syncDuration());
		this.audio.addEventListener("durationchange", () => this.syncDuration());
		this.syncDuration();

		// timeupdate (~4×/s) is the fallback for when requestAnimationFrame is throttled
		// (hidden window); the rAF tick does the precise work while visible.
		this.audio.addEventListener("timeupdate", () => {
			this.syncPlayhead();
			this.checkLoop();
		});

		this.seek.addEventListener("input", () => {
			this.seekDragging = true;
			const t = parseFloat(this.seek.value);
			this.cancelGap(true);
			const once = this.state.sections[this.onceSection];
			if (once && !this.contains(once, t)) this.onceSection = -1;
			this.audio.currentTime = t;
			this.lastTime = t;
			this.updateTimeLabel();
		});
		this.seek.addEventListener("change", () => {
			this.seekDragging = false;
		});

		setStartBtn.addEventListener("click", () => this.setLoopStart());
		setEndBtn.addEventListener("click", () => this.setLoopEnd());
		jumpStartBtn.addEventListener("click", () => this.jumpToStart());
		jumpEndBtn.addEventListener("click", () => this.jumpToEnd());
		this.loopToggleBtn.addEventListener("click", () => this.toggleLoop());

		pauseToggle.addEventListener("change", () => {
			settings.pauseBetweenLoops = pauseToggle.checked;
			pauseInput.disabled = !pauseToggle.checked;
			void this.plugin.saveSettings();
		});
		const commitPauseInput = () => {
			const parsed = parseFloat(pauseInput.value);
			const value = isNaN(parsed)
				? settings.pauseSeconds
				: Math.round(clamp(parsed, MIN_PAUSE_SECONDS, MAX_PAUSE_SECONDS) * 10) / 10;
			pauseInput.value = String(value);
			settings.pauseSeconds = value;
			void this.plugin.saveSettings();
		};
		pauseInput.addEventListener("change", commitPauseInput);
		pauseInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") pauseInput.blur();
		});

		addBtn.addEventListener("click", () => this.addSection());
		sortBtn.addEventListener("click", () => this.sortSectionsByTime());

		// Dragging the slider alone changes speed live — no click-into-field needed.
		speedSlider.addEventListener("input", () => {
			const idx = parseInt(speedSlider.value, 10);
			const speed = SPEED_STEPS[idx];
			this.audio.playbackRate = speed;
			this.speedLabel.setText(`${speed}×`);
		});

		const commitPitchInput = () => {
			const parsed = parseFloat(this.pitchInput.value);
			this.setPitch(isNaN(parsed) ? this.pitchCents : parsed);
		};
		this.pitchInput.addEventListener("change", commitPitchInput);
		this.pitchInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") this.pitchInput.blur();
		});
		this.pitchResetBtn.addEventListener("click", () => this.setPitch(0));
	}

	private iconButton(parent: HTMLElement, icon: string, label: string): HTMLButtonElement {
		const btn = parent.createEl("button", {
			cls: "alp-btn alp-icon-btn",
			attr: { "aria-label": label, title: label },
		});
		setIcon(btn, icon);
		return btn;
	}

	private timeInput(parent: HTMLElement, value: number | null): HTMLInputElement {
		const input = parent.createEl("input", {
			cls: "alp-time-input",
			attr: { type: "text", spellcheck: "false", placeholder: "0:00.0" },
		}) as HTMLInputElement;
		input.value = value !== null ? formatTimeInput(value) : "";
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") input.blur();
		});
		return input;
	}

	private renderSections() {
		this.sectionList.empty();
		const { sections, selected, primary } = this.state;
		this.renderSeekMarks();

		if (sections.length === 0) {
			this.sectionList.createDiv({
				cls: "alp-sections-empty",
				text: "Press Set A and Set B to mark a section, or + to add one. Shift+click section numbers to loop several in turn.",
			});
			return;
		}

		sections.forEach((section, i) => {
			const row = this.sectionList.createDiv({ cls: "alp-section" });
			row.toggleClass("is-selected", selected.includes(i));
			row.toggleClass("is-primary", i === primary);

			const badge = row.createEl("button", {
				cls: "alp-section-badge",
				text: String(i + 1),
				attr: { title: "Click: select and jump to its start. Shift+click: add to / remove from the loop." },
			});
			const startInput = this.timeInput(row, section.start);
			row.createSpan({ cls: "alp-section-dash", text: "–" });
			const endInput = this.timeInput(row, section.end);
			const nameInput = row.createEl("input", {
				cls: "alp-section-name",
				attr: { type: "text", spellcheck: "false", placeholder: `Section ${i + 1}` },
			}) as HTMLInputElement;
			nameInput.value = section.name;
			const upBtn = this.iconButton(row, "chevron-up", "Move up (plays earlier in the loop)");
			const downBtn = this.iconButton(row, "chevron-down", "Move down (plays later in the loop)");
			upBtn.disabled = i === 0;
			downBtn.disabled = i === sections.length - 1;
			const deleteBtn = this.iconButton(row, "x", "Delete section");

			// Focusing any field in a row makes it the selected section, without
			// re-rendering (which would steal focus) and without moving the playhead.
			row.addEventListener("focusin", (e) => {
				// Only typing into a row's fields selects it; the buttons handle themselves.
				if (!(e.target instanceof HTMLInputElement)) return;
				if (this.state.primary === i) return;
				if (!this.state.selected.includes(i)) this.state.selected = [i];
				this.state.primary = i;
				this.sectionList.querySelectorAll(".alp-section").forEach((el, j) => {
					(el as HTMLElement).toggleClass("is-selected", this.state.selected.includes(j));
					(el as HTMLElement).toggleClass("is-primary", j === i);
				});
				this.syncLoopUi();
				this.persist();
			});

			badge.addEventListener("click", (e) => {
				if (e.shiftKey || e.metaKey || e.ctrlKey) this.toggleInSelection(i);
				else this.selectSection(i, true);
			});
			startInput.addEventListener("change", () => {
				const parsed = parseTimeInput(startInput.value);
				if (parsed !== null) {
					section.start = this.clampToDuration(parsed);
					if (section.end !== null && section.start >= section.end) section.end = null;
				}
				this.commitState();
			});
			endInput.addEventListener("change", () => {
				const parsed = parseTimeInput(endInput.value);
				if (parsed !== null) {
					section.end = this.clampToDuration(parsed);
					if (section.start !== null && section.end <= section.start) section.start = null;
				}
				this.commitState();
			});
			nameInput.addEventListener("keydown", (e) => {
				if (e.key === "Enter") nameInput.blur();
			});
			nameInput.addEventListener("change", () => {
				section.name = nameInput.value.trim();
				this.commitState();
			});
			upBtn.addEventListener("click", () => this.moveSection(i, -1));
			downBtn.addEventListener("click", () => this.moveSection(i, 1));
			deleteBtn.addEventListener("click", () => this.deleteSection(i));
		});
	}

	// ---------------------------------------------------------------- Section model

	/** The section that Set A / Set B / jump act on. */
	private selectedSection(): LoopSection | null {
		const { sections, primary } = this.state;
		return primary >= 0 && primary < sections.length ? sections[primary] : null;
	}

	/** Indices of the selected sections that have both ends set, in play order. */
	private loopSections(): number[] {
		const { sections, selected } = this.state;
		return selected.filter((i) => i >= 0 && i < sections.length && isComplete(sections[i]));
	}

	/** Returns the primary section, creating a first one if the file has none yet. */
	private ensureSelected(): LoopSection {
		const { sections } = this.state;
		if (sections.length === 0) sections.push(this.newSection());
		if (this.state.primary < 0 || this.state.primary >= sections.length) {
			this.state.primary = sections.length - 1;
			this.state.selected = [this.state.primary];
		}
		return sections[this.state.primary];
	}

	private renderSeekMarks() {
		this.seekMarks.empty();
		const duration = this.audio.duration;
		if (!isFinite(duration) || duration <= 0) return;
		this.state.sections.forEach((section, i) => {
			if (!isComplete(section)) return;
			const mark = this.seekMarks.createDiv({ cls: "alp-seek-mark" });
			mark.toggleClass("is-selected", this.state.selected.includes(i));
			mark.style.left = `${(section.start / duration) * 100}%`;
			mark.style.width = `${((section.end - section.start) / duration) * 100}%`;
			mark.setAttr("title", section.name || `Section ${i + 1}`);
		});
	}

	private clampToDuration(time: number): number {
		return clamp(time, 0, this.audio.duration || time);
	}

	private commitState() {
		this.renderSections();
		this.syncLoopUi();
		this.persist();
	}

	// ---------------------------------------------------------------- pitch

	shiftPitch(delta: number) {
		this.setPitch(this.pitchCents + delta);
	}

	setPitch(cents: number) {
		this.pitchCents = Math.round(clamp(cents, MIN_PITCH_CENTS, MAX_PITCH_CENTS));
		const store = this.plugin.settings.filePitch;
		if (this.pitchCents === 0) delete store[this.storageKey];
		else store[this.storageKey] = this.pitchCents;
		void this.plugin.saveSettings();
		this.syncPitchUi();
		void this.applyPitch();
	}

	isCollapsed(): boolean {
		return this.root.hasClass("is-collapsed");
	}

	/** Shrinks the player to just the transport row, or brings back every control. */
	setCollapsed(collapsed: boolean, remember: boolean) {
		this.root.toggleClass("is-collapsed", collapsed);
		const label = collapsed ? "Show all controls" : "Collapse to mini-player";
		setIcon(this.collapseBtn, collapsed ? "chevron-down" : "chevron-up");
		this.collapseBtn.setAttr("aria-label", label);
		this.collapseBtn.setAttr("aria-expanded", String(!collapsed));
		if (!remember) return;
		const store = this.plugin.settings.fileCollapsed;
		if (collapsed === this.plugin.settings.collapseByDefault) delete store[this.storageKey];
		else store[this.storageKey] = collapsed;
		void this.plugin.saveSettings();
	}

	private syncPitchUi() {
		this.pitchInput.value = String(this.pitchCents);
		this.pitchLabel.setText(formatPitch(this.pitchCents));
		this.pitchLabel.toggleClass("is-shifted", this.pitchCents !== 0);
		this.pitchResetBtn.disabled = this.pitchCents === 0;
	}

	/** Sends the current pitch to the shifter, routing the audio through it first if needed. */
	private async applyPitch() {
		if (!this.pitchNode) {
			// Never shifted yet: nothing to do at 0, and the audio stays out of Web Audio.
			if (this.pitchCents === 0) return;
			try {
				this.pitchNode = await this.plugin.pitch.attach(this.audio, () => this.useLocalCopy());
			} catch (e) {
				console.error("Music Practice Player: pitch shifting unavailable", e);
				new Notice("Pitch shifting isn't available for this audio.");
				this.pitchCents = 0;
				delete this.plugin.settings.filePitch[this.storageKey];
				void this.plugin.saveSettings();
				this.syncPitchUi();
				return;
			}
		}
		this.pitchNode.port.postMessage({ cents: this.pitchCents });
	}

	/**
	 * Web Audio only hears audio from the page's own origin, and Obsidian serves vault
	 * files from a different one on desktop, so play from an in-memory copy instead.
	 */
	private async useLocalCopy() {
		const src = this.audio.currentSrc || this.audio.src;
		if (isSameOriginSource(src)) return;
		const file = this.plugin.app.vault.getAbstractFileByPath(this.storageKey);
		if (!(file instanceof TFile)) throw new Error(`Not a vault file: ${this.storageKey}`);
		const data = await this.plugin.app.vault.readBinary(file);
		this.blobUrl = URL.createObjectURL(new Blob([data], { type: AUDIO_MIME[file.extension.toLowerCase()] ?? "" }));

		const { currentTime, paused, playbackRate } = this.audio;
		const loaded = new Promise((resolve) => this.audio.addEventListener("loadedmetadata", resolve, { once: true }));
		this.audio.src = this.blobUrl;
		await loaded;
		// Loading a new source resets the rate.
		this.audio.defaultPlaybackRate = playbackRate;
		this.audio.playbackRate = playbackRate;
		this.audio.currentTime = currentTime;
		this.lastTime = currentTime;
		if (!paused) await this.audio.play();
	}

	private persist() {
		const store = this.plugin.settings.fileLoops;
		const noteSections = store[this.storageKey]?.noteSections;
		if (this.onlyAutoSection()) {
			if (!noteSections) delete store[this.storageKey];
			return;
		}
		this.autoSection = null;
		// Keep an emptied list if it came from a note, so the note doesn't reload it.
		if (this.state.sections.length === 0 && !noteSections) {
			delete store[this.storageKey];
		} else {
			store[this.storageKey] = {
				sections: this.state.sections.map((s) => ({ ...s })),
				selected: [...this.state.selected],
				primary: this.state.primary,
				...(noteSections ? { noteSections } : {}),
			};
		}
		void this.plugin.saveSettings();
	}

	setLoopStart(time: number = this.audio.currentTime) {
		const section = this.ensureSelected();
		section.start = this.clampToDuration(time);
		if (section.end !== null && section.start >= section.end) section.end = null;
		this.commitState();
	}

	setLoopEnd(time: number = this.audio.currentTime) {
		const section = this.ensureSelected();
		section.end = this.clampToDuration(time);
		if (section.start !== null && section.end <= section.start) section.start = null;
		this.commitState();
	}

	/**
	 * A fresh section, pre-filled so consecutive sections join up: the first one
	 * starts at 0:00 and each later one starts where the last one in the list ends
	 * (left blank if that end is not set yet). Either value can be overwritten.
	 */
	private newSection(): LoopSection {
		const { sections } = this.state;
		const start = sections.length === 0 || this.onlyAutoSection() ? 0 : sections[sections.length - 1].end;
		return { name: "", start, end: null };
	}

	addSection() {
		this.state.sections.push(this.newSection());
		this.state.primary = this.state.sections.length - 1;
		this.state.selected = [this.state.primary];
		this.commitState();
	}

	private deleteSection(index: number) {
		const { sections } = this.state;
		if (index < 0 || index >= sections.length) return;
		sections.splice(index, 1);
		this.onceSection = -1;
		const shift = (i: number) => (i > index ? i - 1 : i);
		this.state.selected = this.state.selected.filter((i) => i !== index).map(shift);
		if (sections.length === 0) {
			this.state.primary = -1;
		} else if (this.state.primary === index) {
			this.state.primary = Math.min(index, sections.length - 1);
			if (!this.state.selected.includes(this.state.primary)) this.state.selected.push(this.state.primary);
		} else {
			this.state.primary = shift(this.state.primary);
		}
		this.state.selected.sort((a, b) => a - b);
		this.commitState();
	}

	/**
	 * Reorders sections so that `order[k]` becomes section k. The selection,
	 * primary section and the section currently looping follow their sections.
	 * Loop play order is list order, so this is how the user controls it.
	 */
	private reorderSections(order: number[]) {
		const { sections } = this.state;
		const newIndex = new Map<number, number>();
		order.forEach((oldIndex, k) => newIndex.set(oldIndex, k));
		const remap = (i: number) => newIndex.get(i) ?? -1;
		this.state.sections = order.map((i) => sections[i]);
		this.state.selected = this.state.selected.map(remap).filter((i) => i >= 0).sort((a, b) => a - b);
		this.state.primary = remap(this.state.primary);
		this.activeLoop = remap(this.activeLoop);
		this.onceSection = remap(this.onceSection);
		this.commitState();
	}

	moveSection(index: number, delta: number) {
		const count = this.state.sections.length;
		const target = index + delta;
		if (index < 0 || index >= count || target < 0 || target >= count) return;
		const order = this.state.sections.map((_, i) => i);
		[order[index], order[target]] = [order[target], order[index]];
		this.reorderSections(order);
	}

	/** Puts sections in the order they occur in the tune; unset starts sink to the bottom. */
	sortSectionsByTime() {
		const order = this.state.sections
			.map((s, i) => ({ i, start: s.start ?? Number.POSITIVE_INFINITY }))
			.sort((a, b) => a.start - b.start || a.i - b.i)
			.map((x) => x.i);
		this.reorderSections(order);
	}

	/** Plain click: this section alone. */
	selectSection(index: number, seekToStart: boolean) {
		if (index < 0 || index >= this.state.sections.length) return;
		this.state.selected = [index];
		this.state.primary = index;
		this.activeLoop = index;
		if (index !== this.onceSection) this.onceSection = -1;
		const section = this.state.sections[index];
		if (seekToStart && section.start !== null) this.seekTo(section.start);
		this.commitState();
	}

	/** Shift+click: add the section to the loop set, or remove it if already there. */
	toggleInSelection(index: number) {
		if (index < 0 || index >= this.state.sections.length) return;
		const { selected } = this.state;
		if (selected.includes(index)) {
			if (selected.length === 1) return; // keep at least one selected
			this.state.selected = selected.filter((i) => i !== index);
			if (this.state.primary === index) this.state.primary = this.state.selected[0];
		} else {
			this.state.selected = [...selected, index].sort((a, b) => a - b);
			this.state.primary = index;
		}
		this.commitState();
	}

	selectRelative(delta: number) {
		const count = this.state.sections.length;
		if (count === 0) return;
		const current = this.state.primary < 0 ? 0 : this.state.primary;
		this.selectSection((current + delta + count) % count, true);
	}

	// ---------------------------------------------------------------- Transport & looping

	togglePlay() {
		if (this.inGap) {
			// Pressing pause during the gap stops the loop where it is.
			this.cancelGap(false);
			return;
		}
		if (this.audio.paused) this.safePlay();
		else this.audio.pause();
	}

	toggleLoop() {
		const loops = this.loopSections();
		if (loops.length === 0) return;
		this.loopEnabled = !this.loopEnabled;
		if (this.loopEnabled) {
			this.onceSection = -1;
			// Start from wherever the playhead already is inside the loop set, otherwise
			// from the first section (or the primary one if it is part of the set).
			const t = this.audio.currentTime;
			const inside = loops.find((i) => this.contains(this.state.sections[i], t));
			if (inside !== undefined) {
				this.activeLoop = inside;
			} else {
				this.activeLoop = loops.includes(this.state.primary) ? this.state.primary : loops[0];
				this.seekTo((this.state.sections[this.activeLoop] as CompleteSection).start);
			}
		} else {
			this.cancelGap(true);
		}
		this.syncLoopUi();
	}

	private contains(section: LoopSection, time: number): boolean {
		return isComplete(section) && time >= section.start && time < section.end;
	}

	jumpToStart() {
		const section = this.selectedSection();
		if (section && section.start !== null) this.seekTo(section.start);
	}

	jumpToEnd() {
		const section = this.selectedSection();
		if (section && section.end !== null) this.seekTo(section.end);
	}

	/**
	 * Applies a time given in the embed itself (`![[tune.mp3|1:23]]`): moves the playhead
	 * there, and for a range selects that section (creating it the first time) with Loop
	 * on. Never plays, and does nothing while audio is playing.
	 */
	applyEmbedSpec(spec: EmbedSpec) {
		if (this.audio.readyState < HTMLMediaElement.HAVE_METADATA) {
			this.audio.addEventListener("loadedmetadata", () => this.applyEmbedSpec(spec), { once: true });
			return;
		}
		if (!this.audio.paused || this.inGap) return;
		const start = this.clampToDuration(spec.start);
		if (spec.end === null) {
			this.seekTo(start);
			return;
		}
		const end = this.clampToDuration(spec.end);
		if (end <= start) {
			this.seekTo(start);
			return;
		}
		// The automatic whole-file section gives way to the embed's own range.
		if (this.onlyAutoSection()) {
			this.state.sections = [];
			this.autoSection = null;
		}
		// Reuse a matching section, so opening the note again does not add another.
		let index = this.state.sections.findIndex(
			(s) => isComplete(s) && Math.abs(s.start - start) < 0.25 && Math.abs(s.end - end) < 0.25
		);
		if (index < 0) {
			this.state.sections.push({ name: "", start, end });
			index = this.state.sections.length - 1;
		}
		this.selectSection(index, true);
		if (!this.loopEnabled) this.toggleLoop();
	}

	/**
	 * Readies the player on the section a note is about (its `select:` line) without
	 * playing: selects it, moves the playhead to its start and sets what happens at
	 * its end. Does nothing while audio is playing, so it never interrupts a tune.
	 */
	applyNoteSelection(selection: NoteSelection) {
		if (this.audio.readyState < HTMLMediaElement.HAVE_METADATA) {
			this.audio.addEventListener("loadedmetadata", () => this.applyNoteSelection(selection), { once: true });
			return;
		}
		if (!this.audio.paused || this.inGap) return;
		const { index, mode } = selection;
		if (index < 0 || index >= this.state.sections.length) return;
		this.selectSection(index, true);
		if (mode === "loop" ? !this.loopEnabled : this.loopEnabled) this.toggleLoop();
		this.onceSection = mode === "once" ? index : -1;
	}

	private seekTo(time: number) {
		this.cancelGap(true);
		this.audio.currentTime = time;
		// Treat this as a fresh position so the loop only restarts once we actually
		// play through B — jumping straight to B lets you hear what follows it.
		this.lastTime = time;
		this.syncPlayhead();
	}

	private safePlay() {
		const result = this.audio.play();
		if (result) result.catch(() => {});
	}

	private setPlayUi(playing: boolean) {
		setIcon(this.playBtn, playing ? "pause" : "play");
		this.playBtn.setAttr("aria-label", playing ? "Pause" : "Play");
	}

	private syncLoopUi() {
		const loops = this.loopSections();
		const ready = loops.length > 0;
		if (!ready && this.loopEnabled) {
			this.loopEnabled = false;
			this.cancelGap(true);
		}
		this.loopToggleBtn.disabled = !ready;
		const label = loops.length > 1 ? ` ${loops.map((i) => i + 1).join("+")}` : "";
		this.loopToggleBtn.setText((this.loopEnabled ? "Loop on" : "Loop off") + label);
		this.loopToggleBtn.setAttr(
			"title",
			loops.length > 1 ? `Loop sections ${loops.map((i) => i + 1).join(", ")} in turn` : "Loop the selected section"
		);
		this.loopToggleBtn.toggleClass("is-active", this.loopEnabled);
	}

	private startTicking() {
		if (this.rafId !== null) return;
		const tick = () => {
			if (this.audio.paused) {
				this.rafId = null;
				return;
			}
			this.syncPlayhead();
			this.checkLoop();
			this.rafId = requestAnimationFrame(tick);
		};
		this.rafId = requestAnimationFrame(tick);
	}

	private stopTicking() {
		if (this.rafId !== null) {
			cancelAnimationFrame(this.rafId);
			this.rafId = null;
		}
	}

	/** Sizes the seek bar to the file and redraws the section bands. Safe to call any time. */
	private syncDuration() {
		const duration = this.audio.duration;
		const max = isFinite(duration) && duration > 0 ? duration : 0;
		if (this.seek.max !== String(max)) this.seek.max = String(max);
		// Some files only settle on their exact length after loading; keep the automatic section in step.
		if (max > 0 && this.onlyAutoSection() && this.autoEnd !== max) {
			this.autoEnd = max;
			this.autoSection!.end = max;
			this.renderSections();
		}
		if (this.state.sections.length === 0 && max > 0) {
			this.addWholeFileSection();
			this.renderSections();
			this.syncLoopUi();
		}
		this.updateTimeLabel();
		this.renderSeekMarks();
		if (!this.seekDragging) this.seek.value = String(this.audio.currentTime);
	}

	private syncPlayhead() {
		if (this.seek.max === "0") this.syncDuration();
		if (!this.seekDragging) this.seek.value = String(this.audio.currentTime);
		this.updateTimeLabel();
	}

	private updateTimeLabel() {
		this.timeLabel.setText(`${formatTime(this.audio.currentTime)} / ${formatTime(this.audio.duration)}`);
	}

	/** Restart the loop when the playhead crosses the section end (or the file ends inside it). */
	private checkLoop() {
		const current = this.audio.currentTime;
		const previous = this.lastTime;
		this.lastTime = current;

		if (!this.loopEnabled && this.onceSection >= 0 && this.root.isConnected) {
			this.checkOnce(previous, current);
			return;
		}
		if (!this.loopEnabled || this.inGap || !this.root.isConnected) return;
		if (this.audio.paused && !this.audio.ended) return;
		const loops = this.loopSections();
		if (loops.length === 0) return;

		// The section we are playing through: whichever selected one contains the
		// playhead, else the last one we were in (e.g. after jumping past its end).
		const inside = loops.find((i) => this.contains(this.state.sections[i], current));
		if (inside !== undefined) this.activeLoop = inside;
		else if (!loops.includes(this.activeLoop)) this.activeLoop = loops[0];
		const section = this.state.sections[this.activeLoop] as CompleteSection;

		const crossedEnd = previous < section.end && current >= section.end;
		if (crossedEnd || (this.audio.ended && current >= section.end)) {
			const next = loops[(loops.indexOf(this.activeLoop) + 1) % loops.length];
			this.activeLoop = next;
			this.restartLoop((this.state.sections[next] as CompleteSection).start);
		}
	}

	/** Play-once mode: stop at the section's end and go back to its start, ready to play again. */
	private checkOnce(previous: number, current: number) {
		const section = this.state.sections[this.onceSection];
		if (!section || !isComplete(section)) return;
		const crossedEnd = previous < section.end && current >= section.end;
		if (crossedEnd || (this.audio.ended && current >= section.end)) {
			this.audio.pause();
			this.seekTo(section.start);
		}
	}

	/** Move to `start` (the next section's A, or our own), with the optional silent gap first. */
	private restartLoop(start: number) {
		const { pauseBetweenLoops, pauseSeconds } = this.plugin.settings;
		this.lastTime = start;
		if (pauseBetweenLoops && pauseSeconds > 0) {
			this.inGap = true;
			this.root.addClass("is-gap");
			this.audio.pause();
			this.audio.currentTime = start;
			this.syncPlayhead();
			this.setPlayUi(true);
			this.gapTimer = window.setTimeout(() => {
				this.gapTimer = null;
				if (this.inGap && this.root.isConnected) this.safePlay();
			}, pauseSeconds * 1000);
		} else {
			this.audio.currentTime = start;
			if (this.audio.paused) this.safePlay();
		}
	}

	private clearGapState() {
		if (this.gapTimer !== null) {
			clearTimeout(this.gapTimer);
			this.gapTimer = null;
		}
		this.inGap = false;
		this.root.removeClass("is-gap");
	}

	/** Leave the gap early: either carry on playing or settle into a real pause. */
	private cancelGap(resume: boolean) {
		if (!this.inGap) return;
		this.clearGapState();
		if (resume) this.safePlay();
		else this.setPlayUi(false);
	}
}

interface PendingSelect {
	selection: NoteSelection;
	/** The rendered `loops` block, used to find the player in the same pane. */
	el: HTMLElement;
	expires: number;
}

export default class AudioLoopPlayerPlugin extends Plugin {
	settings: AudioLoopPlayerSettings;
	readonly pitch = new PitchEngine();
	/**
	 * "note path\naudio path" for each `select:` already applied while its note has
	 * stayed open. Live Preview re-renders a block as you type in it, and the
	 * selection should only be applied on arriving at the note, not on every edit.
	 */
	private selectedNotes = new Set<string>();
	/** `select:` lines waiting for their player, keyed by audio file path. */
	private pendingSelect = new Map<string, PendingSelect>();

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new AudioLoopPlayerSettingTab(this.app, this));
		this.registerCommands();
		this.registerMarkdownCodeBlockProcessor("loops", (source, el, ctx) => this.renderLoopsBlock(source, el, ctx));

		// Forget a note's applied selection once it is no longer open, so coming back
		// to it applies the selection again. Deferred a tick so the pane has switched.
		const forgetClosedNotes = () => window.setTimeout(() => this.forgetClosedNotes(), 0);
		this.registerEvent(this.app.workspace.on("file-open", forgetClosedNotes));
		this.registerEvent(this.app.workspace.on("layout-change", forgetClosedNotes));

		// Enhance every mp3/m4a/wav <audio> element as it appears anywhere in the app —
		// embedded in Reading View, embedded in Live Preview, or the native audio view
		// opened in its own tab. These are three separate, only-partly-documented
		// rendering paths (Live Preview embeds in particular never go through
		// registerMarkdownPostProcessor), so watching the DOM directly is what actually
		// covers all of them. We don't hijack the file type via registerExtensions:
		// mp3/m4a/wav are already claimed by Obsidian's built-in audio view, and
		// re-registering them throws and prevents the plugin from loading at all.
		this.app.workspace.onLayoutReady(() => {
			this.enhanceAudioIn(document.body);

			const observer = new MutationObserver((mutations) => {
				if (!this.settings.enhanceEmbeds) return;
				for (const mutation of mutations) {
					mutation.addedNodes.forEach((node) => {
						if (!(node instanceof HTMLElement)) return;
						this.enhanceAudioIn(node);
					});
				}
			});
			observer.observe(document.body, { childList: true, subtree: true });
			this.register(() => observer.disconnect());
		});
		this.register(() => this.pitch.close());
	}

	/** Commands act on the most recently used player, so they can be bound to hotkeys. */
	private registerCommands() {
		const withActivePlayer = (id: string, name: string, run: (player: AudioControls) => void) => {
			this.addCommand({
				id,
				name,
				checkCallback: (checking) => {
					const player = AudioControls.active;
					if (!player || !player.isConnected()) return false;
					if (!checking) run(player);
					return true;
				},
			});
		};
		withActivePlayer("play-pause", "Play / pause", (p) => p.togglePlay());
		withActivePlayer("set-loop-start", "Set loop start (A) at playhead", (p) => p.setLoopStart());
		withActivePlayer("set-loop-end", "Set loop end (B) at playhead", (p) => p.setLoopEnd());
		withActivePlayer("toggle-loop", "Toggle loop", (p) => p.toggleLoop());
		withActivePlayer("jump-loop-start", "Jump to loop start (A)", (p) => p.jumpToStart());
		withActivePlayer("jump-loop-end", "Jump to loop end (B)", (p) => p.jumpToEnd());
		withActivePlayer("add-section", "Add loop section", (p) => p.addSection());
		withActivePlayer("sort-sections", "Sort loop sections by time", (p) => p.sortSectionsByTime());
		withActivePlayer("next-section", "Select next section", (p) => p.selectRelative(1));
		withActivePlayer("previous-section", "Select previous section", (p) => p.selectRelative(-1));
		withActivePlayer("pitch-up-tone", "Raise pitch by a tone", (p) => p.shiftPitch(CENTS_PER_TONE));
		withActivePlayer("pitch-down-tone", "Lower pitch by a tone", (p) => p.shiftPitch(-CENTS_PER_TONE));
		withActivePlayer("pitch-up-fine", `Raise pitch by ${PITCH_FINE_STEP} cents`, (p) => p.shiftPitch(PITCH_FINE_STEP));
		withActivePlayer("pitch-down-fine", `Lower pitch by ${PITCH_FINE_STEP} cents`, (p) =>
			p.shiftPitch(-PITCH_FINE_STEP)
		);
		withActivePlayer("pitch-reset", "Reset pitch", (p) => p.setPitch(0));
	}

	private enhanceAudioIn(root: HTMLElement) {
		if (!this.settings.enhanceEmbeds) return;

		const audios = root instanceof HTMLAudioElement ? [root] : Array.from(root.querySelectorAll("audio"));
		audios.forEach((node) => {
			const audio = node as HTMLAudioElement;
			if (audio.dataset.alpEnhanced) return;

			const src = audio.currentSrc || audio.getAttribute("src") || "";
			if (!isAudioSource(src)) return;

			audio.dataset.alpEnhanced = "true";
			audio.controls = false;
			audio.addClass("alp-hidden");

			const wrapper = createDiv({ cls: "alp-embed" });
			audio.insertAdjacentElement("afterend", wrapper);
			const player = new AudioControls(wrapper, audio, this, this.storageKeyFor(src));
			this.flushPendingSelect(player.storageKey);
			const spec = this.embedSpecFor(audio, player.storageKey);
			if (spec) player.applyEmbedSpec(spec);
		});
	}

	// ---------------------------------------------------------------- `loops` code blocks

	/**
	 * A `loops` block lists sections for an audio file (written by e.g. trad-split).
	 * It is shown as a one-line status instead of raw text; the sections themselves
	 * appear in the player. See `noteSectionsStatus` for when they are applied.
	 */
	private renderLoopsBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
		const box = el.createDiv({ cls: "alp-loops-block" });
		const block = parseLoopsBlock(source);
		const file = this.resolveLoopsFile(block.file, el, ctx);

		const problems = [...block.errors];
		if (!file) {
			problems.unshift(
				block.file ? `Can't find audio file "${block.file}"` : "No file: line and no audio embed above this block"
			);
		}
		if (problems.length > 0 || !file) {
			box.addClass("is-error");
			box.createDiv({ text: "Loop sections not loaded:" });
			const list = box.createEl("ul");
			problems.forEach((p) => list.createEl("li", { text: p }));
			return;
		}

		const count = `${block.sections.length} section${block.sections.length === 1 ? "" : "s"}`;
		const selected = block.select ? `, section ${block.select.index + 1} selected` : "";
		const status = this.noteSectionsStatus(file.path, block.sections);
		if (status === "applied") {
			box.createSpan({ text: `${count} from this note for ${file.name}${selected}` });
			if (block.select) this.queueNoteSelection(ctx.sourcePath, file.path, block.select, el, false);
			return;
		}
		box.addClass("is-conflict");
		box.createSpan({
			text:
				status === "edited"
					? `${file.name}: the player's sections were edited after loading the ${count} in this note.`
					: `${file.name}: this note lists ${count} that differ from the player's saved ones.`,
		});
		const button = box.createEl("button", { cls: "alp-btn", text: "Use the note's sections" });
		if (block.select) {
			box.createSpan({ text: ` Section ${block.select.index + 1} is selected once the note's sections are used.` });
		}
		button.addEventListener("click", () => {
			this.applyNoteSections(file.path, block.sections);
			box.empty();
			box.removeClass("is-conflict");
			box.createSpan({ text: `${count} from this note for ${file.name}${selected}` });
			if (block.select) this.queueNoteSelection(ctx.sourcePath, file.path, block.select, el, true);
		});
	}

	/**
	 * Readies the player for `audioPath` on the note's selected section. Applied once
	 * per visit to the note unless `force` (the user asked for the note's sections).
	 */
	private queueNoteSelection(
		notePath: string,
		audioPath: string,
		selection: NoteSelection,
		el: HTMLElement,
		force: boolean
	) {
		const key = `${notePath}\n${audioPath}`;
		if (this.selectedNotes.has(key) && !force) return;
		this.selectedNotes.add(key);
		this.pendingSelect.set(audioPath, { selection, el, expires: Date.now() + SELECT_WAIT_MS });
		// The block is not in the page yet while it is being rendered, and the embed's
		// player may not exist yet either; try once both have had a chance to appear.
		window.setTimeout(() => this.flushPendingSelect(audioPath), 0);
	}

	/**
	 * Applies a waiting `select:` to the player in the same pane as its block. Called
	 * after the block renders and whenever a player is created; retries until it
	 * finds the player or gives up.
	 */
	private flushPendingSelect(audioPath: string) {
		const pending = this.pendingSelect.get(audioPath);
		if (!pending) return;
		if (Date.now() > pending.expires) {
			this.pendingSelect.delete(audioPath);
			return;
		}
		const pane = pending.el.isConnected ? pending.el.closest(".workspace-leaf") : null;
		const player = pane ? AudioControls.playersFor(audioPath).find((p) => p.isInside(pane)) : undefined;
		if (!player) {
			window.setTimeout(() => this.flushPendingSelect(audioPath), SELECT_RETRY_MS);
			return;
		}
		this.pendingSelect.delete(audioPath);
		player.applyNoteSelection(pending.selection);
	}

	private forgetClosedNotes() {
		const open = new Set<string>();
		this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
			const path = leaf.view instanceof MarkdownView ? leaf.view.file?.path : undefined;
			if (path) open.add(path);
		});
		for (const key of this.selectedNotes) {
			if (!open.has(key.split("\n")[0])) this.selectedNotes.delete(key);
		}
	}

	/** The `file:` path, or failing that the closest audio embed above the block. */
	private resolveLoopsFile(path: string | null, el: HTMLElement, ctx: MarkdownPostProcessorContext): TFile | null {
		const isAudio = (f: unknown): f is TFile =>
			f instanceof TFile && AUDIO_EXTENSIONS.includes(f.extension.toLowerCase());

		if (path) {
			const exact = this.app.vault.getAbstractFileByPath(normalizePath(path));
			if (isAudio(exact)) return exact;
			const linked = this.app.metadataCache.getFirstLinkpathDest(path, ctx.sourcePath);
			return isAudio(linked) ? linked : null;
		}

		const embeds = (this.app.metadataCache.getCache(ctx.sourcePath)?.embeds ?? [])
			.map((e) => ({
				line: e.position.start.line,
				file: this.app.metadataCache.getFirstLinkpathDest(e.link.split("#")[0], ctx.sourcePath),
			}))
			.filter((e): e is { line: number; file: TFile } => isAudio(e.file));
		const blockLine = ctx.getSectionInfo(el)?.lineStart;
		if (blockLine === undefined) return embeds.length === 1 ? embeds[0].file : null;
		const above = embeds.filter((e) => e.line < blockLine);
		return above.length > 0 ? above[above.length - 1].file : null;
	}

	/**
	 * Applies a note's sections unless that would throw away the user's own edits:
	 * - nothing saved yet for the file → load them;
	 * - the player still has exactly what was last loaded from a note → the note
	 *   was updated, so load the new version;
	 * - otherwise leave the player alone and report "edited" (the note is unchanged
	 *   since it was loaded) or "conflict" (both differ), so the user can choose.
	 */
	private noteSectionsStatus(path: string, sections: LoopSection[]): "applied" | "edited" | "conflict" {
		const saved = this.settings.fileLoops[path];
		const note = sectionsKey(sections);
		if (!saved || (saved.sections.length === 0 && !saved.noteSections)) {
			this.applyNoteSections(path, sections);
			return "applied";
		}
		if (sectionsKey(saved.sections) === note) {
			if (!saved.noteSections || sectionsKey(saved.noteSections) !== note) {
				saved.noteSections = copySections(sections);
				void this.saveSettings();
			}
			return "applied";
		}
		if (saved.noteSections && sectionsKey(saved.sections) === sectionsKey(saved.noteSections)) {
			this.applyNoteSections(path, sections);
			return "applied";
		}
		return saved.noteSections && sectionsKey(saved.noteSections) === note ? "edited" : "conflict";
	}

	private applyNoteSections(path: string, sections: LoopSection[]) {
		const previous = this.settings.fileLoops[path];
		let selected = (previous?.selected ?? []).filter((i) => i < sections.length);
		let primary = previous?.primary ?? -1;
		if (sections.length === 0) {
			selected = [];
			primary = -1;
		} else if (selected.length === 0) {
			selected = [0];
			primary = 0;
		} else if (!selected.includes(primary)) {
			primary = selected[0];
		}
		this.settings.fileLoops[path] = {
			sections: copySections(sections),
			selected,
			primary,
			noteSections: copySections(sections),
		};
		void this.saveSettings();
		AudioControls.reloadAll(path);
	}

	/**
	 * Maps an <audio> src (an app:// resource URL) back to the vault path of the file,
	 * so saved sections follow the file wherever it is embedded or opened.
	 */
	/**
	 * The time in this audio element's embed alias, if any. Read from the embed's `alt`
	 * attribute, or failing that from the note's own link metadata, matched by order
	 * among the embeds of the same file.
	 */
	private embedSpecFor(audio: HTMLAudioElement, audioPath: string): EmbedSpec | null {
		const embed = audio.closest(".internal-embed");
		if (!embed) return null;
		const fromAlt = parseEmbedSpec(embed.getAttribute("alt"));
		if (fromAlt) return fromAlt;

		const src = embed.getAttribute("src");
		if (!src) return null;
		const note = this.noteContaining(embed);
		if (!note) return null;
		const cache = this.app.metadataCache.getFileCache(note);
		const mine = (cache?.embeds ?? []).filter((e) => {
			const target = this.app.metadataCache.getFirstLinkpathDest(e.link.split("#")[0], note.path);
			return target?.path === audioPath;
		});
		if (mine.length === 0) return null;
		const container = embed.closest(".workspace-leaf-content") ?? document.body;
		const sameSrc = Array.from(container.querySelectorAll(".internal-embed")).filter(
			(el) => el.getAttribute("src") === src
		);
		const nth = Math.max(0, sameSrc.indexOf(embed));
		const hit = mine[Math.min(nth, mine.length - 1)];
		return parseEmbedSpec(hit.displayText) ?? parseEmbedSpec(hit.original.match(/\|([^\]]*)\]\]$/)?.[1]);
	}

	/** The note whose view contains this element, falling back to the active note. */
	private noteContaining(el: Element): TFile | null {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.containerEl.contains(el) && view.file) return view.file;
		}
		return this.app.workspace.getActiveFile();
	}

	private storageKeyFor(src: string): string {
		const clean = src.split("?")[0];
		for (const file of this.app.vault.getFiles()) {
			if (!AUDIO_EXTENSIONS.includes(file.extension.toLowerCase())) continue;
			if (this.app.vault.getResourcePath(file).split("?")[0] === clean) return file.path;
		}
		try {
			return decodeURIComponent(new URL(clean).pathname);
		} catch {
			return clean;
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		if (!this.settings.fileLoops) this.settings.fileLoops = {};
		if (!this.settings.filePitch) this.settings.filePitch = {};
		if (!this.settings.fileCollapsed) this.settings.fileCollapsed = {};
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class AudioLoopPlayerSettingTab extends PluginSettingTab {
	plugin: AudioLoopPlayerPlugin;

	constructor(app: App, plugin: AudioLoopPlayerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Default playback speed")
			.setDesc("Applied to newly opened audio files and embeds.")
			.addDropdown((drop) => {
				SPEED_STEPS.forEach((speed) => drop.addOption(String(speed), `${speed}×`));
				drop.setValue(String(this.plugin.settings.defaultSpeed));
				drop.onChange(async (value) => {
					this.plugin.settings.defaultSpeed = parseFloat(value);
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Enhance audio playback")
			.setDesc(
				"Add play/loop/speed controls to mp3, m4a and wav files, both embedded inline in notes (e.g. ![[recording.mp3]]) and opened in their own tab."
			)
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.enhanceEmbeds);
				toggle.onChange(async (value) => {
					this.plugin.settings.enhanceEmbeds = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Start players collapsed")
			.setDesc(
				"Show new players as a mini-player (play, seek bar, time). Each player's collapse button still opens it, and files you've collapsed or expanded keep that choice."
			)
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.collapseByDefault);
				toggle.onChange(async (value) => {
					this.plugin.settings.collapseByDefault = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Pause between loops")
			.setDesc("Insert a short silence each time a loop restarts. Can also be toggled in the player.")
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.pauseBetweenLoops);
				toggle.onChange(async (value) => {
					this.plugin.settings.pauseBetweenLoops = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Pause length")
			.setDesc(`Seconds of silence between loops (${MIN_PAUSE_SECONDS}–${MAX_PAUSE_SECONDS}).`)
			.addSlider((slider) => {
				slider
					.setLimits(MIN_PAUSE_SECONDS, MAX_PAUSE_SECONDS, 0.1)
					.setValue(this.plugin.settings.pauseSeconds)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.pauseSeconds = Math.round(value * 10) / 10;
						await this.plugin.saveSettings();
					});
			});

		const savedCount = Object.keys(this.plugin.settings.fileLoops).length;
		new Setting(containerEl)
			.setName("Saved loop sections")
			.setDesc(
				`Sections are remembered per audio file. Currently saved for ${savedCount} file${savedCount === 1 ? "" : "s"}.`
			)
			.addButton((button) => {
				button
					.setButtonText("Forget all")
					.setWarning()
					.setDisabled(savedCount === 0)
					.onClick(async () => {
						this.plugin.settings.fileLoops = {};
						await this.plugin.saveSettings();
						this.display();
					});
			});
	}
}
