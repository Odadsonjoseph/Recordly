// Kokoro TTS via sherpa-onnx-node — the runtime Recordly already ships.
// Verified against sherpa-onnx 1.3 docs (k2-fsa.github.io/sherpa):
//   OfflineTts with config { kokoro: { model, voices, tokens, dataDir } }
//   generate({ text, sid, generationConfig }) -> { samples, sampleRate }
//   Kokoro en v0_19: 24 kHz mono float32, Apache-2.0, 82M params.
// Model bundle: kokoro-en-v0_19.tar.bz2 from
//   https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2
// It contains model.onnx, voices.bin, tokens.txt and espeak-ng-data.
// Download once to userData/revoice/kokoro-en-v0_19, reuse after that.
// No API key, no network at synthesis time, nothing leaves the Mac.

import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";

// sherpa-onnx-node is already in Recordly package.json (2.0.1).
// Import lazily so a missing native binding fails only when Re-voice
// is used, never at app startup.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SherpaOnnx = any;

export const KOKORO_MODEL_URL =
	"https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2";
export const KOKORO_SAMPLE_RATE = 24000;

export function getKokoroDir(): string {
	return path.join(app.getPath("userData"), "revoice", "kokoro-en-v0_19");
}

export function getKokoroModelPath(): string {
	return path.join(getKokoroDir(), "model.onnx");
}

export async function isKokoroInstalled(): Promise<boolean> {
	try {
		await fs.access(getKokoroModelPath());
		await fs.access(path.join(getKokoroDir(), "voices.bin"));
		await fs.access(path.join(getKokoroDir(), "tokens.txt"));
		return true;
	} catch {
		return false;
	}
}

async function loadSherpa(): Promise<SherpaOnnx> {
	// Dynamic import keeps the native module out of the startup path.
	const mod = await import("sherpa-onnx-node");
	return mod;
}

export interface KokoroSynthOptions {
	voiceKokoroId: string;
	/** 0.9–1.1. Kokoro speed is set via GenerationConfig in sherpa-onnx. */
	speed: number;
}

export interface KokoroAudio {
	samples: Float32Array;
	sampleRate: number;
	durationMs: number;
}

/**
 * Synthesise one phrase. Caller writes the returned float32 samples
 * to wav (24 kHz mono) with ffmpeg or a wav writer in generate.ts.
 * Throws a plain Error with a user-readable message on failure.
 */
export async function synthesizeKokoro(
	text: string,
	options: KokoroSynthOptions,
): Promise<KokoroAudio> {
	if (!text.trim()) throw new Error("Nothing to speak — the cleaned text is empty.");
	if (!(await isKokoroInstalled())) {
		throw new Error(
			"Kokoro voice model is not downloaded yet. Open AI Re-voice settings and tap Download voice model first (about 300 MB, once).",
		);
	}
	const sherpa = await loadSherpa();
	const dir = getKokoroDir();
	const config = {
		// sherpa-onnx-node OfflineTtsConfig shape, per docs.
		model: {
			kokoro: {
				model: path.join(dir, "model.onnx"),
				voices: path.join(dir, "voices.bin"),
				tokens: path.join(dir, "tokens.txt"),
				dataDir: path.join(dir, "espeak-ng-data"),
			},
			// No debug / provider overrides in v1. CPU is fine on Apple Silicon.
			numThreads: 2,
		},
	};
	const tts = new sherpa.OfflineTts(config);
	try {
		// sid selects the voice inside voices.bin (e.g. af_heart).
		// GenerationConfig carries speed in sherpa-onnx-node.
		const generationConfig = new sherpa.GenerationConfig({
			speed: options.speed,
		});
		const audio = tts.generate({
			text,
			sid: options.voiceKokoroId,
			generationConfig,
		});
		const samples = audio.samples as Float32Array;
		const sampleRate = (audio.sampleRate as number) || KOKORO_SAMPLE_RATE;
		return {
			samples,
			sampleRate,
			durationMs: Math.round((samples.length / sampleRate) * 1000),
		};
	} finally {
		// OfflineTts holds native resources; free them per phrase batch.
		try {
			tts.free?.();
		} catch {
			// Ignore — GC will collect the binding.
		}
	}
}
