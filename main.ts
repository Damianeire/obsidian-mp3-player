import { App, Plugin, PluginSettingTab, Setting, setIcon } from "obsidian";

const AUDIO_EXTENSIONS = ["mp3", "m4a", "wav"];

// Non-linear speed scale: fine-grained steps around normal speed, coarser further out.
const SPEED_STEPS = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1, 1.1, 1.2, 1.3, 1.4, 1.5];
const DEFAULT_SPEED_INDEX = SPEED_STEPS.indexOf(1);

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
}

interface AudioLoopPlayerSettings {
	defaultSpeed: number;
	enhanceEmbeds: boolean;
	pauseBetweenLoops: boolean;
	pauseSeconds: number;
	/** Saved sections keyed by vault path of the audio file. */
	fileLoops: Record<string, FileLoopState>;
}

const DEFAULT_SETTINGS: AudioLoopPlayerSettings = {
	defaultSpeed: 1,
	enhanceEmbeds: true,
	pauseBetweenLoops: false,
	pauseSeconds: 1,
	fileLoops: {},
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

// Accepts "M:SS", "M:SS.s" or a plain number of seconds.
function parseTimeInput(value: string): number | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	const match = trimmed.match(/^(\d+):(\d+(?:\.\d+)?)$/);
	if (match) return parseInt(match[1], 10) * 60 + parseFloat(match[2]);
	const asSeconds = parseFloat(trimmed);
	return isNaN(asSeconds) ? null : asSeconds;
}

/**
 * Builds a play/seek/loop/speed control bar around an existing <audio> element.
 * Used by both the full-tab file view and the enhanced markdown embed.
 */
class AudioControls {
	/** The player most recently created or interacted with; commands/hotkeys are routed here. */
	static active: AudioControls | null = null;

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
	private playBtn: HTMLButtonElement;
	private loopToggleBtn: HTMLButtonElement;
	private sectionList: HTMLElement;
	private speedLabel: HTMLElement;

	constructor(
		container: HTMLElement,
		audio: HTMLAudioElement,
		private plugin: AudioLoopPlayerPlugin,
		private storageKey: string
	) {
		this.root = container;
		this.audio = audio;
		this.audio.playbackRate = plugin.settings.defaultSpeed;

		this.state = AudioControls.loadState(plugin.settings.fileLoops[storageKey]);

		this.build();
		this.renderSections();
		this.syncLoopUi();
		AudioControls.active = this;
	}

	isConnected(): boolean {
		return this.root.isConnected;
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
		this.stopTicking();
		this.clearGapState();
		this.audio.pause();
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

		// --- Wire events ---
		this.playBtn.addEventListener("click", () => this.togglePlay());
		this.audio.addEventListener("play", () => {
			AudioControls.active = this;
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
		if (sections.length === 0) sections.push({ name: "", start: null, end: null });
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

	private persist() {
		const store = this.plugin.settings.fileLoops;
		if (this.state.sections.length === 0) {
			delete store[this.storageKey];
		} else {
			store[this.storageKey] = {
				sections: this.state.sections.map((s) => ({ ...s })),
				selected: [...this.state.selected],
				primary: this.state.primary,
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

	addSection() {
		this.state.sections.push({ name: "", start: null, end: null });
		this.state.primary = this.state.sections.length - 1;
		this.state.selected = [this.state.primary];
		this.commitState();
	}

	private deleteSection(index: number) {
		const { sections } = this.state;
		if (index < 0 || index >= sections.length) return;
		sections.splice(index, 1);
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

export default class AudioLoopPlayerPlugin extends Plugin {
	settings: AudioLoopPlayerSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new AudioLoopPlayerSettingTab(this.app, this));
		this.registerCommands();

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
			audio.style.display = "none";

			const wrapper = createDiv({ cls: "alp-embed" });
			audio.insertAdjacentElement("afterend", wrapper);
			new AudioControls(wrapper, audio, this, this.storageKeyFor(src));
		});
	}

	/**
	 * Maps an <audio> src (an app:// resource URL) back to the vault path of the file,
	 * so saved sections follow the file wherever it is embedded or opened.
	 */
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
