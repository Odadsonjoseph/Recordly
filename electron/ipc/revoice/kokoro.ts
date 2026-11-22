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

import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { app } from "electron";
import type { RevoiceModelDownloadState } from "../../../src/shared/revoice";
import { receiveCaptionDownload } from "../captions/modelDownloadTransport";

// sherpa-onnx-node is already in Recordly package.json (2.0.1).
// Import lazily so a missing native binding fails only when Re-voice
// is used, never at app startup.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SherpaOnnx = any;

const execFileAsync = promisify(execFile);

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
	// sherpa-onnx-node ships no type declarations, so a static/dynamic
	// import fails TS7016. Same pattern as electron/ipc/captions/parakeet.ts:
	// load it lazily via createRequire so a missing native binding fails
	// only when Re-voice is used, never at app startup.
	const nodeRequire = createRequire(import.meta.url);
	return nodeRequire("sherpa-onnx-node") as SherpaOnnx;
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

let activeKokoroDownload: Promise<void> | null = null;

/** Find the extracted directory that holds model.onnx (the tar's top level
 * is kokoro-en-v0_19, but its name is not assumed). */
async function findKokoroDir(root: string): Promise<string | null> {
	try {
		await fs.access(path.join(root, "model.onnx"));
		return root;
	} catch {
		// Not at this level — look one level down.
	}
	const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const found = await findKokoroDir(path.join(root, entry.name));
		if (found) return found;
	}
	return null;
}

/**
 * Download the Kokoro voice model once (~300 MB) and install it into
 * userData/revoice/kokoro-en-v0_19. Reuses Recordly's own caption-model
 * download transport (HTTPS-only, redirect-capped, proxy-aware), then
 * extracts the tar.bz2 with the system tar and verifies the files.
 * A second call while one is running joins the same download.
 */
export function downloadKokoroModel(
	onProgress?: (state: RevoiceModelDownloadState) => void,
): Promise<void> {
	if (!activeKokoroDownload) {
		activeKokoroDownload = (async () => {
			if (await isKokoroInstalled()) {
				onProgress?.({ status: "downloaded", progress: 100 });
				return;
			}
			const staging = await fs.mkdtemp(path.join(app.getPath("temp"), "recordly-kokoro-"));
			const archivePath = path.join(staging, "kokoro-en-v0_19.tar.bz2");
			try {
				let received = 0;
				let total: number | null = null;
				await receiveCaptionDownload(KOKORO_MODEL_URL, 8, async (response) => {
					if (response.statusCode !== 200) {
						throw new Error(`Voice model download failed (HTTP ${response.statusCode}).`);
					}
					const length = Number(response.headers["content-length"]);
					if (Number.isFinite(length) && length > 0) total = length;
					const count = new Transform({
						transform(chunk: Buffer, _encoding, callback) {
							received += chunk.length;
							onProgress?.({
								status: "downloading",
								progress: total ? Math.min(99, Math.floor((received / total) * 100)) : 0,
							});
							callback(null, chunk);
						},
					});
					await pipeline(response, count, createWriteStream(archivePath, { flags: "wx" }));
				});
				onProgress?.({ status: "extracting", progress: 100 });
				const extractDir = path.join(staging, "extracted");
				await fs.mkdir(extractDir, { recursive: true });
				await execFileAsync("tar", ["-xjf", archivePath, "-C", extractDir]);
				const found = await findKokoroDir(extractDir);
				if (!found) {
					throw new Error("Voice model download was incomplete — model.onnx is missing.");
				}
				const dest = getKokoroDir();
				await fs.mkdir(path.dirname(dest), { recursive: true });
				await fs.rm(dest, { recursive: true, force: true });
				await fs.rename(found, dest);
				if (!(await isKokoroInstalled())) {
					throw new Error("Voice model download was incomplete — files are missing.");
				}
				onProgress?.({ status: "downloaded", progress: 100 });
			} finally {
				await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
				activeKokoroDownload = null;
			}
		})();
	}
	return activeKokoroDownload;
}
