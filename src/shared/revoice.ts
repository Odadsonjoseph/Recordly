// AI Re-voice — shared types.
// Recordly already has: Whisper on-device transcription with word timings
// (electron/ipc/captions/*), an editable captions timeline, source audio
// tracks (src/components/video-editor/audio/audioTypes.ts) and an exporter
// with audioEncoder (src/lib/exporter/audioEncoder.ts).
// This file adds no new dependency. TTS is Kokoro via sherpa-onnx-node,
// which Recordly already depends on (package.json: sherpa-onnx-node 2.0.1).
// Kokoro is Apache-2.0, 82M params, 24 kHz mono, offline, no API key.

export type RevoiceId = string;

export interface RevoiceVoice {
	id: string;
	label: string;
	// Kokoro v0_19 voice id. af_* = American female, am_* = American male,
	// bf_* = British female. af_heart is the default clean narrator.
	kokoroId: string;
	blurb: string;
}

export const REVOICE_VOICES: RevoiceVoice[] = [
	{ id: "heart", label: "Heart — warm narrator", kokoroId: "af_heart", blurb: "Default. Clear, warm, demo-friendly." },
	{ id: "bella", label: "Bella — bright narrator", kokoroId: "af_bella", blurb: "Brighter, a little faster feel." },
	{ id: "sarah", label: "Sarah — calm narrator", kokoroId: "af_sarah", blurb: "Calm, steady, tutorial-friendly." },
	{ id: "adam", label: "Adam — warm male narrator", kokoroId: "am_adam", blurb: "Warm male narrator." },
	{ id: "michael", label: "Michael — steady male narrator", kokoroId: "am_michael", blurb: "Steady, lower register." },
	{ id: "emma", label: "Emma — British narrator", kokoroId: "bf_emma", blurb: "British accent, clean." },
];

export const DEFAULT_REVOICE_VOICE_ID = "heart";

export interface RevoiceOptions {
	voiceId: string;
	/** 0.9–1.1 is the safe range. 1.0 = natural Kokoro pace. */
	speed: number;
	/** Remove um/uh/er, stutters, repeats and false starts. Always on in v1. */
	cleanFillers: boolean;
	/** Light grammar / punctuation tidy, keeps meaning and tech terms. */
	cleanGrammar: boolean;
	/** Keep the original mic track muted but present, so you can A/B. */
	muteOriginal: boolean;
}

export const DEFAULT_REVOICE_OPTIONS: RevoiceOptions = {
	voiceId: DEFAULT_REVOICE_VOICE_ID,
	speed: 1.0,
	cleanFillers: true,
	cleanGrammar: true,
	muteOriginal: true,
};

// One cleaned phrase, aligned to the original Whisper cue it came from.
// Phrase-aligned synthesis is what keeps the new voice in sync with the
// screen: each phrase is spoken at its original start time, and only
// time-stretched (0.85–1.25x via ffmpeg atempo) if it does not fit.
export interface RevoicePhrase {
	id: string;
	originalText: string;
	cleanedText: string;
	startMs: number;
	endMs: number;
	/** Path to the synthesized .wav for this phrase, written by main. */
	audioPath?: string;
	/** Duration of the synthesized audio, ms. */
	audioDurationMs?: number;
	wasChanged: boolean;
}

export interface RevoiceResult {
	id: RevoiceId;
	videoPath: string;
	/** Merged clean narration, 24 kHz mono wav, same timeline as the video. */
	audioPath: string;
	durationMs: number;
	phrases: RevoicePhrase[];
	originalWordCount: number;
	cleanedWordCount: number;
	removedFillers: number;
	voiceId: string;
	createdAt: string;
}

export interface RevoiceProgress {
	stage: "transcribing" | "cleaning" | "synthesizing" | "aligning" | "done" | "error";
	phraseIndex?: number;
	phraseCount?: number;
	message: string;
}
