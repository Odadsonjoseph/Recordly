// AI Re-voice — main-process orchestration. v2, HEAD 8f2491dc.
// Reuses Recordly's existing pieces, it does not fork them:
//   - Transcription: electron/ipc/captions/generate.ts
//     generateAutoCaptionsFromVideo({ videoPath, captionModelId, engine })
//     returns { cues: CaptionCue[], audioSourceLabel }. CaptionCue is
//     { id, startMs, endMs, text } — see src/components/video-editor/types.ts.
//     The register layer (electron/ipc/register/revoice.ts) calls it
//     when the renderer sends no cues. There is no
//     getCurrentProjectCaptionCues() in Recordly — v1 invented it.
//   - Audio extraction: ffmpeg, already bundled (getFfmpegBinaryPath)
//   - Cleanup: src/lib/revoice/cleanTranscript.ts (pure, offline)
//   - TTS: ./kokoro.ts (Kokoro via sherpa-onnx-node, offline)
//   - Timeline audio: a new .wav is written next to the project as
//     `<name>.revoice.wav` and registered as an extra audio region.
//     The original mic track is muted, not deleted, so you can A/B.
//
// Timing rule (v1, keeps video in sync):
//   Each cleaned phrase is placed at its original Whisper cue start.
//   If the spoken phrase is longer than its slot, ffmpeg atempo
//   stretches it to fit only within 0.85–1.25x. Outside that range
//   the phrase is allowed to spill into the next pause — never cut
//   mid-word. Long silences in the original are kept as silence.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { app } from "electron";
import { cleanTranscript } from "../../../src/lib/revoice/cleanTranscript";
import type {
	RevoiceOptions,
	RevoicePhrase,
	RevoiceResult,
} from "../../../src/shared/revoice";
import { REVOICE_VOICES } from "../../../src/shared/revoice";
import { getFfmpegBinaryPath } from "../ffmpeg/binary";
import { synthesizeKokoro } from "./kokoro";

const execFileAsync = promisify(execFile);

export interface RevoiceCue {
	text: string;
	startMs: number;
	endMs: number;
}

export interface GenerateRevoiceOptions extends RevoiceOptions {
	videoPath: string;
	/** CaptionCue[] from the renderer, or from generateAutoCaptionsFromVideo
	 * in the register layer. generateRevoice itself never transcribes. */
	cues: RevoiceCue[];
	onProgress?: (stage: string, done: number, total: number) => void;
}

function wavHeader(sampleRate: number, dataBytes: number): Buffer {
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + dataBytes, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20); // PCM
	header.writeUInt16LE(1, 22); // mono
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(dataBytes, 40);
	return header;
}

async function writeWavMono16(filePath: string, samples: Float32Array, sampleRate: number): Promise<void> {
	const pcm = Buffer.alloc(samples.length * 2);
	for (let i = 0; i < samples.length; i += 1) {
		const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
		pcm.writeInt16LE(Math.round(clamped * 32767), i * 2);
	}
	await fs.writeFile(filePath, Buffer.concat([wavHeader(sampleRate, pcm.length), pcm]));
}

function atempoFor(slotMs: number, audioMs: number): number | null {
	if (slotMs <= 0 || audioMs <= 0) return null;
	const ratio = audioMs / slotMs;
	// Only stretch if it is close. Otherwise let it spill into a pause.
	if (ratio < 0.85 || ratio > 1.25) return null;
	return 1 / ratio;
}

export async function generateRevoice(options: GenerateRevoiceOptions): Promise<RevoiceResult> {
	const voice = REVOICE_VOICES.find((v) => v.id === options.voiceId) ?? REVOICE_VOICES[0]!;
	if (!options.cues.length) {
		throw new Error("No captions to re-voice yet. Run Auto-captions first, then tap AI Re-voice.");
	}
	const ffmpegPath = getFfmpegBinaryPath();
	const baseName = path.basename(options.videoPath, path.extname(options.videoPath));
	const workDir = path.join(app.getPath("temp"), `recordly-revoice-${Date.now()}`);
	await fs.mkdir(workDir, { recursive: true });

	const phrases: RevoicePhrase[] = [];
	let removedFillers = 0;
	let originalWords = 0;
	let cleanedWords = 0;

	try {
		// 1. Clean each cue, keep its original timing.
		const cleanedCues = options.cues.map((cue, i) => {
			const cleaned = cleanTranscript(cue.text);
			removedFillers += cleaned.stats.removedFillers;
			originalWords += cleaned.stats.originalWordCount;
			cleanedWords += cleaned.stats.cleanedWordCount;
			return { cue, cleaned, index: i };
		}).filter((c) => c.cleaned.text.trim().length > 0);

		if (!cleanedCues.length) {
			throw new Error("The cleaned script is empty — nothing to re-speak.");
		}

		// 2. Synthesise phrase by phrase.
		for (let i = 0; i < cleanedCues.length; i += 1) {
			const { cue, cleaned, index } = cleanedCues[i]!;
			options.onProgress?.("synthesizing", i, cleanedCues.length);
			const audio = await synthesizeKokoro(cleaned.text, {
				voiceKokoroId: voice.kokoroId,
				speed: options.speed,
			});
			const phraseWav = path.join(workDir, `phrase-${index}.wav`);
			await writeWavMono16(phraseWav, audio.samples, audio.sampleRate);
			phrases.push({
				id: `revoice-${index}`,
				originalText: cue.text,
				cleanedText: cleaned.text,
				startMs: cue.startMs,
				endMs: cue.endMs,
				audioPath: phraseWav,
				audioDurationMs: audio.durationMs,
				wasChanged: cleaned.changed,
			});
		}

		// 3. Align: place each phrase wav at its original start, stretch
		// only inside the safe range, mix to one timeline wav.
		// Silence before the first phrase and between phrases is preserved
		// by adelay + amix. The output length matches the video timeline:
		// last cue end, or the last phrase end if it spills slightly.
		const lastEnd = Math.max(...phrases.map((p) => p.endMs));
		const outPath = path.join(
			path.dirname(options.videoPath),
			`${baseName}.revoice.wav`,
		);
		const inputs: string[] = [];
		const filters: string[] = [];
		phrases.forEach((phrase, i) => {
			inputs.push("-i", phrase.audioPath!);
			const slotMs = phrase.endMs - phrase.startMs;
			const tempo = atempoFor(slotMs, phrase.audioDurationMs ?? slotMs);
			const tempoFilter = tempo ? `atempo=${tempo.toFixed(3)},` : "";
			// adelay is in ms, per-channel (mono = one value).
			filters.push(
				`[${i}:a]${tempoFilter}adelay=${Math.max(0, phrase.startMs)}:all=1[a${i}]`,
			);
		});
		const mixInputs = phrases.map((_, i) => `[a${i}]`).join("");
		const filterComplex = `${filters.join(";")};${mixInputs}amix=inputs=${phrases.length}:normalize=0[aout]`;
		options.onProgress?.("aligning", phrases.length, phrases.length);
		await execFileAsync(
			ffmpegPath,
			[
				"-y",
				...inputs,
				"-filter_complex", filterComplex,
				"-map", "[aout]",
				"-t", `${Math.ceil(lastEnd / 1000)}`,
				"-ac", "1",
				"-ar", "24000",
				"-c:a", "pcm_s16le",
				outPath,
			],
			{ timeout: 10 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 },
		);

		return {
			id: `revoice-${Date.now()}`,
			videoPath: options.videoPath,
			audioPath: outPath,
			durationMs: lastEnd,
			phrases,
			originalWordCount: originalWords,
			cleanedWordCount: cleanedWords,
			removedFillers,
			voiceId: voice.id,
			createdAt: new Date().toISOString(),
		};
	} finally {
		// Phrase wavs are intermediates; the merged .revoice.wav is the keep.
		await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
	}
}
