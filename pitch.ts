/**
 * Pitch shifting without changing speed, for the player's Pitch row.
 *
 * The <audio> element keeps doing playback, seeking and (pitch-preserving) speed
 * changes; its sound is routed through Web Audio into a phase-vocoder worklet that
 * moves every frequency by the chosen number of cents. The graph is only built the
 * first time a player needs it, since an element routed into Web Audio cannot be
 * routed back out.
 */

export const CENTS_PER_TONE = 200;
/** The small step of the − and + buttons. */
export const PITCH_FINE_STEP = 5;
export const MIN_PITCH_CENTS = -1200;
export const MAX_PITCH_CENTS = 1200;

const PROCESSOR_NAME = "alp-pitch-shifter";

// Runs on the audio thread, so it must be self-contained. Based on Stephan Bernsee's
// smbPitchShift: an STFT analysis finds each bin's true frequency from its phase
// advance, the bins are moved up or down by the pitch ratio, and the frames are
// resynthesised and overlap-added.
const WORKLET_SOURCE = `
const FRAME = 2048;
const OVERSAMPLE = 8;
const STEP = FRAME / OVERSAMPLE;
const LATENCY = FRAME - STEP;
const HALF = FRAME / 2;
const EXPECTED = (2 * Math.PI * STEP) / FRAME;
/** Samples of silent input after which frames are skipped (the tail has played out by then). */
const IDLE_AFTER = FRAME * 2;
/** Samples over which to crossfade when switching between shifted and unshifted. */
const FADE = 256;

const WINDOW = new Float32Array(FRAME);
for (let k = 0; k < FRAME; k++) WINDOW[k] = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / FRAME);

const BITS = Math.log2(FRAME);
const REVERSED = new Uint32Array(FRAME);
for (let i = 0; i < FRAME; i++) {
	let r = 0;
	for (let b = 0; b < BITS; b++) r |= ((i >> b) & 1) << (BITS - 1 - b);
	REVERSED[i] = r;
}
const COS = new Float64Array(HALF);
const SIN = new Float64Array(HALF);
for (let i = 0; i < HALF; i++) {
	COS[i] = Math.cos((2 * Math.PI * i) / FRAME);
	SIN[i] = Math.sin((2 * Math.PI * i) / FRAME);
}

/** In-place radix-2 FFT; sign -1 forward, +1 inverse (unscaled). */
function fft(re, im, sign) {
	for (let i = 0; i < FRAME; i++) {
		const j = REVERSED[i];
		if (j > i) {
			let t = re[i]; re[i] = re[j]; re[j] = t;
			t = im[i]; im[i] = im[j]; im[j] = t;
		}
	}
	for (let size = 2; size <= FRAME; size <<= 1) {
		const half = size >> 1;
		const stride = FRAME / size;
		for (let start = 0; start < FRAME; start += size) {
			for (let k = 0; k < half; k++) {
				const wr = COS[k * stride];
				const wi = sign * SIN[k * stride];
				const a = start + k;
				const b = a + half;
				const tr = re[b] * wr - im[b] * wi;
				const ti = re[b] * wi + im[b] * wr;
				re[b] = re[a] - tr; im[b] = im[a] - ti;
				re[a] += tr; im[a] += ti;
			}
		}
	}
}

class Channel {
	constructor() {
		this.inFifo = new Float32Array(FRAME);
		this.outFifo = new Float32Array(FRAME);
		this.accum = new Float32Array(FRAME * 2);
		this.re = new Float64Array(FRAME);
		this.im = new Float64Array(FRAME);
		this.lastPhase = new Float64Array(HALF + 1);
		this.anaPhase = new Float64Array(HALF + 1);
		this.anaMag = new Float64Array(HALF + 1);
		this.anaFreq = new Float64Array(HALF + 1);
		/** Output phase for each analysis bin, carried from frame to frame. */
		this.synPhase = new Float64Array(HALF + 1);
		/** The spectral peak each analysis bin belongs to. */
		this.peakOf = new Int32Array(HALF + 1);
		this.rover = LATENCY;
	}

	/** Takes one input sample and returns one shifted output sample, LATENCY samples late. */
	push(sample, ratio, idle) {
		this.inFifo[this.rover] = sample;
		const out = this.outFifo[this.rover - LATENCY];
		this.rover++;
		if (this.rover >= FRAME) {
			this.rover = LATENCY;
			if (idle) this.skipFrame();
			else this.frame(ratio);
		}
		return out;
	}

	skipFrame() {
		this.outFifo.fill(0, 0, STEP);
		this.inFifo.copyWithin(0, STEP, FRAME);
	}

	frame(ratio) {
		const { re, im, anaPhase, anaMag, anaFreq, synPhase, lastPhase, peakOf } = this;
		// Rotated so the window's centre sits at index 0: the spectrum then carries no
		// phase slope from the window's position, which would be distorted when it is moved.
		for (let k = 0; k < FRAME; k++) {
			const n = (k + HALF) % FRAME;
			re[k] = this.inFifo[n] * WINDOW[n];
			im[k] = 0;
		}
		fft(re, im, -1);

		// Each bin's true frequency (in bins) from how far its phase moved since the last frame.
		for (let k = 0; k <= HALF; k++) {
			const phase = Math.atan2(im[k], re[k]);
			let delta = phase - lastPhase[k] - k * EXPECTED;
			delta -= 2 * Math.PI * Math.round(delta / (2 * Math.PI));
			lastPhase[k] = phase;
			anaPhase[k] = phase;
			anaMag[k] = 2 * Math.hypot(re[k], im[k]);
			anaFreq[k] = k + delta / EXPECTED;
		}

		// Identity phase locking (Laroche & Dolson): only spectral peaks advance their phase
		// freely; the bins around each peak keep their phase relative to it. Without this
		// the bins of one partial drift apart and the sound turns phasey and uneven in level.
		let prevPeak = -1;
		for (let k = 1; k < HALF; k++) {
			if (anaMag[k] <= anaMag[k - 1] || anaMag[k] < anaMag[k + 1]) continue;
			if (prevPeak < 0) {
				for (let b = 0; b < k; b++) peakOf[b] = k;
			} else {
				let low = prevPeak;
				for (let b = prevPeak + 1; b < k; b++) if (anaMag[b] < anaMag[low]) low = b;
				for (let b = prevPeak + 1; b < k; b++) peakOf[b] = b <= low ? prevPeak : k;
			}
			peakOf[k] = k;
			prevPeak = k;
		}
		if (prevPeak < 0) {
			for (let k = 0; k <= HALF; k++) peakOf[k] = k;
		} else {
			for (let b = prevPeak + 1; b <= HALF; b++) peakOf[b] = prevPeak;
		}
		for (let k = 0; k <= HALF; k++) {
			if (peakOf[k] === k) synPhase[k] += ratio * anaFreq[k] * EXPECTED;
		}
		for (let k = 0; k <= HALF; k++) {
			const p = peakOf[k];
			if (p !== k) synPhase[k] = synPhase[p] + anaPhase[k] - anaPhase[p];
		}

		// Move the spectrum: output bin j takes what was at bin j / ratio.
		for (let j = 0; j <= HALF; j++) {
			const from = j / ratio;
			const k0 = Math.floor(from);
			if (k0 >= HALF) {
				re[j] = 0;
				im[j] = 0;
				continue;
			}
			const frac = from - k0;
			const mag = anaMag[k0] * (1 - frac) + anaMag[k0 + 1] * frac;
			const phase = synPhase[frac < 0.5 ? k0 : k0 + 1];
			re[j] = mag * Math.cos(phase);
			im[j] = mag * Math.sin(phase);
		}
		for (let k = HALF + 1; k < FRAME; k++) {
			re[k] = 0;
			im[k] = 0;
		}
		fft(re, im, 1);

		// Undoes the inverse FFT's factor of FRAME and the 3/8 per hop that overlapping Hann² windows add up to.
		const scale = 1 / (FRAME * (3 / 8) * OVERSAMPLE);
		for (let k = 0; k < FRAME; k++) this.accum[k] += scale * WINDOW[k] * re[(k + HALF) % FRAME];
		this.outFifo.set(this.accum.subarray(0, STEP));
		this.accum.copyWithin(0, STEP, FRAME * 2);
		this.accum.fill(0, FRAME * 2 - STEP);
		this.inFifo.copyWithin(0, STEP, FRAME);
	}
}

class PitchShifter extends AudioWorkletProcessor {
	constructor() {
		super();
		this.ratio = 1;
		this.channels = [];
		this.silent = 0;
		/** 0 = passing the input straight through, 1 = fully shifted. */
		this.mix = 0;
		this.port.onmessage = (e) => {
			this.ratio = Math.pow(2, e.data.cents / 1200);
		};
	}

	process(inputs, outputs) {
		const input = inputs[0];
		const output = outputs[0];
		if (!input || input.length === 0) {
			for (const ch of output) ch.fill(0);
			return true;
		}
		const frames = input[0].length;
		let quiet = true;
		for (const ch of input) {
			for (let i = 0; i < frames; i++) {
				if (ch[i] !== 0) { quiet = false; break; }
			}
			if (!quiet) break;
		}
		this.silent = quiet ? this.silent + frames : 0;
		const idle = this.silent > IDLE_AFTER;
		const target = this.ratio === 1 ? 0 : 1;

		for (let c = 0; c < output.length; c++) {
			const src = input[Math.min(c, input.length - 1)];
			const dst = output[c];
			const state = this.channels[c] || (this.channels[c] = new Channel());
			let mix = this.mix;
			for (let i = 0; i < frames; i++) {
				// The vocoder keeps running while bypassed, so switching back in is seamless.
				const shifted = state.push(src[i], this.ratio, idle);
				if (mix !== target) mix = target > mix ? Math.min(1, mix + 1 / FADE) : Math.max(0, mix - 1 / FADE);
				dst[i] = mix === 0 ? src[i] : mix === 1 ? shifted : mix * shifted + (1 - mix) * src[i];
			}
			if (c === output.length - 1) this.mix = mix;
		}
		return true;
	}
}

registerProcessor("${PROCESSOR_NAME}", PitchShifter);
`;

/** Converts cents to a label such as "+1 tone", "−35¢" or "+1 tone 20¢". */
export function formatPitch(cents: number): string {
	if (cents === 0) return "0¢";
	const sign = cents > 0 ? "+" : "−";
	const abs = Math.abs(cents);
	const tones = Math.floor(abs / CENTS_PER_TONE);
	const rest = abs % CENTS_PER_TONE;
	const parts: string[] = [];
	if (tones > 0) parts.push(`${tones} tone${tones === 1 ? "" : "s"}`);
	if (rest > 0) parts.push(`${rest}¢`);
	return sign + parts.join(" ");
}

/** One AudioContext shared by every player, created on first use. */
export class PitchEngine {
	private ctx: AudioContext | null = null;
	private moduleReady: Promise<void> | null = null;
	private nodes = new WeakMap<HTMLMediaElement, Promise<AudioWorkletNode>>();

	/** Whether this element has already been routed through the shifter. */
	isAttached(audio: HTMLMediaElement): boolean {
		return this.nodes.has(audio);
	}

	/**
	 * Routes `audio` through a shifter node (once) and returns it. `prepare` runs first
	 * and may swap the element's source, e.g. to one Web Audio is allowed to read.
	 */
	attach(audio: HTMLMediaElement, prepare: () => Promise<void>): Promise<AudioWorkletNode> {
		let node = this.nodes.get(audio);
		if (!node) {
			node = this.build(audio, prepare);
			this.nodes.set(audio, node);
			node.catch(() => this.nodes.delete(audio));
		}
		return node;
	}

	/** Audio contexts start suspended until a user gesture; call this from one (e.g. play). */
	resume() {
		if (this.ctx && this.ctx.state === "suspended") void this.ctx.resume();
	}

	close() {
		void this.ctx?.close();
		this.ctx = null;
		this.moduleReady = null;
	}

	private async build(audio: HTMLMediaElement, prepare: () => Promise<void>): Promise<AudioWorkletNode> {
		if (!this.ctx) this.ctx = new AudioContext();
		const ctx = this.ctx;
		if (!this.moduleReady) {
			const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
			this.moduleReady = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
		}
		await this.moduleReady;
		await prepare();
		const source = ctx.createMediaElementSource(audio);
		const node = new AudioWorkletNode(ctx, PROCESSOR_NAME);
		source.connect(node).connect(ctx.destination);
		this.resume();
		return node;
	}
}
