import { App, Plugin, PluginSettingTab, Setting } from "obsidian";

const AUDIO_EXTENSIONS = ["mp3", "m4a", "wav"];

// Non-linear speed scale: fine-grained steps around normal speed, coarser further out.
const SPEED_STEPS = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1, 1.1, 1.2, 1.3, 1.4, 1.5];
const DEFAULT_SPEED_INDEX = SPEED_STEPS.indexOf(1);

interface AudioLoopPlayerSettings {
	defaultSpeed: number;
	enhanceEmbeds: boolean;
}

const DEFAULT_SETTINGS: AudioLoopPlayerSettings = {
	defaultSpeed: 1,
	enhanceEmbeds: true,
};

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
	private audio: HTMLAudioElement;
	private loopStart: number | null = null;
	private loopEnd: number | null = null;
	private loopEnabled = false;
	private seekDragging = false;

	private timeLabel: HTMLElement;
	private seek: HTMLInputElement;
	private playBtn: HTMLButtonElement;
	private loopToggleBtn: HTMLButtonElement;
	private aInput: HTMLInputElement;
	private bInput: HTMLInputElement;
	private speedLabel: HTMLElement;

	constructor(
		private container: HTMLElement,
		audio: HTMLAudioElement,
		settings: AudioLoopPlayerSettings
	) {
		this.audio = audio;
		this.audio.playbackRate = settings.defaultSpeed;
		this.build(settings);
	}

	destroy() {
		this.audio.pause();
	}

	private build(settings: AudioLoopPlayerSettings) {
		const root = this.container;
		root.addClass("alp-controls");

		// --- Transport row: play/pause, seek bar, time ---
		const transport = root.createDiv({ cls: "alp-row alp-transport" });
		this.playBtn = transport.createEl("button", {
			cls: "alp-play-btn",
			text: "▶",
			attr: { "aria-label": "Play" },
		});
		this.seek = transport.createEl("input", { cls: "alp-seek" }) as HTMLInputElement;
		this.seek.type = "range";
		this.seek.min = "0";
		this.seek.max = "0";
		this.seek.step = "0.01";
		this.seek.value = "0";
		this.timeLabel = transport.createSpan({ cls: "alp-time", text: "0:00 / 0:00" });

		// --- Loop row: set A/B from playhead, or type an exact time (e.g. "0:05.5") ---
		const loopRow = root.createDiv({ cls: "alp-row alp-loop-row" });
		const setStartBtn = loopRow.createEl("button", { cls: "alp-btn", text: "Set A" });
		this.aInput = loopRow.createEl("input", {
			cls: "alp-time-input",
			attr: { type: "text", spellcheck: "false", placeholder: "0:00.0" },
		}) as HTMLInputElement;
		const setEndBtn = loopRow.createEl("button", { cls: "alp-btn", text: "Set B" });
		this.bInput = loopRow.createEl("input", {
			cls: "alp-time-input",
			attr: { type: "text", spellcheck: "false", placeholder: "0:00.0" },
		}) as HTMLInputElement;
		this.loopToggleBtn = loopRow.createEl("button", {
			cls: "alp-btn alp-loop-toggle",
			text: "Loop off",
		});
		const clearBtn = loopRow.createEl("button", { cls: "alp-btn alp-clear", text: "Clear" });

		// --- Speed row: draggable, no click-to-edit ---
		const speedRow = root.createDiv({ cls: "alp-row alp-speed-row" });
		speedRow.createSpan({ cls: "alp-speed-icon", text: "Speed" });
		const speedSlider = speedRow.createEl("input", { cls: "alp-speed-slider" }) as HTMLInputElement;
		speedSlider.type = "range";
		speedSlider.min = "0";
		speedSlider.max = String(SPEED_STEPS.length - 1);
		speedSlider.step = "1";
		const startIndex = speedIndexFor(settings.defaultSpeed);
		speedSlider.value = String(startIndex);

		const listId = `alp-speed-ticks-${Math.random().toString(36).slice(2)}`;
		const datalist = speedRow.createEl("datalist");
		datalist.id = listId;
		SPEED_STEPS.forEach((_, i) => datalist.createEl("option", { value: String(i) }));
		speedSlider.setAttr("list", listId);

		this.speedLabel = speedRow.createSpan({
			cls: "alp-speed-label",
			text: `${SPEED_STEPS[startIndex]}×`,
		});

		// --- Wire events ---
		this.playBtn.addEventListener("click", () => {
			if (this.audio.paused) this.audio.play();
			else this.audio.pause();
		});
		this.audio.addEventListener("play", () => {
			this.playBtn.setText("⏸");
			this.playBtn.setAttr("aria-label", "Pause");
		});
		this.audio.addEventListener("pause", () => {
			this.playBtn.setText("▶");
			this.playBtn.setAttr("aria-label", "Play");
		});

		this.audio.addEventListener("loadedmetadata", () => {
			this.seek.max = String(this.audio.duration || 0);
			this.updateTimeLabel();
		});

		this.audio.addEventListener("timeupdate", () => {
			if (!this.seekDragging) this.seek.value = String(this.audio.currentTime);
			this.updateTimeLabel();

			if (
				this.loopEnabled &&
				this.loopStart !== null &&
				this.loopEnd !== null &&
				this.audio.currentTime >= this.loopEnd
			) {
				this.audio.currentTime = this.loopStart;
			}
		});

		this.seek.addEventListener("input", () => {
			this.seekDragging = true;
			this.audio.currentTime = parseFloat(this.seek.value);
			this.updateTimeLabel();
		});
		this.seek.addEventListener("change", () => {
			this.seekDragging = false;
		});

		setStartBtn.addEventListener("click", () => {
			this.loopStart = this.audio.currentTime;
			if (this.loopEnd !== null && this.loopStart >= this.loopEnd) this.loopEnd = null;
			this.syncLoopInputs();
		});
		setEndBtn.addEventListener("click", () => {
			this.loopEnd = this.audio.currentTime;
			if (this.loopStart !== null && this.loopEnd <= this.loopStart) this.loopStart = null;
			this.syncLoopInputs();
		});
		clearBtn.addEventListener("click", () => {
			this.loopStart = null;
			this.loopEnd = null;
			this.loopEnabled = false;
			this.loopToggleBtn.setText("Loop off");
			this.loopToggleBtn.removeClass("is-active");
			this.syncLoopInputs();
		});

		const commitAInput = () => {
			const parsed = parseTimeInput(this.aInput.value);
			if (parsed === null) {
				this.syncLoopInputs();
				return;
			}
			this.loopStart = clamp(parsed, 0, this.audio.duration || parsed);
			if (this.loopEnd !== null && this.loopStart >= this.loopEnd) this.loopEnd = null;
			this.syncLoopInputs();
		};
		const commitBInput = () => {
			const parsed = parseTimeInput(this.bInput.value);
			if (parsed === null) {
				this.syncLoopInputs();
				return;
			}
			this.loopEnd = clamp(parsed, 0, this.audio.duration || parsed);
			if (this.loopStart !== null && this.loopEnd <= this.loopStart) this.loopStart = null;
			this.syncLoopInputs();
		};
		this.aInput.addEventListener("change", commitAInput);
		this.aInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") this.aInput.blur();
		});
		this.bInput.addEventListener("change", commitBInput);
		this.bInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") this.bInput.blur();
		});
		this.loopToggleBtn.addEventListener("click", () => {
			if (this.loopStart === null || this.loopEnd === null) return;
			this.loopEnabled = !this.loopEnabled;
			this.loopToggleBtn.setText(this.loopEnabled ? "Loop on" : "Loop off");
			this.loopToggleBtn.toggleClass("is-active", this.loopEnabled);
		});

		// Dragging the slider alone changes speed live — no click-into-field needed.
		speedSlider.addEventListener("input", () => {
			const idx = parseInt(speedSlider.value, 10);
			const speed = SPEED_STEPS[idx];
			this.audio.playbackRate = speed;
			this.speedLabel.setText(`${speed}×`);
		});
	}

	private updateTimeLabel() {
		this.timeLabel.setText(`${formatTime(this.audio.currentTime)} / ${formatTime(this.audio.duration)}`);
	}

	private syncLoopInputs() {
		this.aInput.value = this.loopStart !== null ? formatTimeInput(this.loopStart) : "";
		this.bInput.value = this.loopEnd !== null ? formatTimeInput(this.loopEnd) : "";
	}
}

export default class AudioLoopPlayerPlugin extends Plugin {
	settings: AudioLoopPlayerSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new AudioLoopPlayerSettingTab(this.app, this));

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
			new AudioControls(wrapper, audio, this.settings);
		});
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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
	}
}
