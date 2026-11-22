// Recordly AI Re-voice v4 — dead-space detection in main.
// Grounded to fork HEAD 8f2491dc (branch revoice-feature).
//
// Runs ffmpeg silencedetect on the video's audio track and turns the result
// into removable spans with computeDeadSpaces. Reuses Recordly's own silence
// parser (electron/ipc/captions/silence.ts: -30 dB floor, 0.5 s minimum) so
// detection matches what the caption pipeline already trusts.
//
// NOTE: spans are in SOURCE time (the video file's own clock). The renderer
// maps them to timeline time with mapDeadSpaceSpansToTimeline before cutting.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseSilenceIntervals, SILENCE_DETECT_MIN_S, SILENCE_NOISE_DB } from "../captions/silence";
import { getFfmpegBinaryPath } from "../ffmpeg/binary";
import { computeDeadSpaces, type DeadSpaceSpan } from "@/lib/revoice/deadSpace";

const execFileAsync = promisify(execFile);

export interface DetectDeadSpacesOptions {
	thresholdMs?: number;
	keepMs?: number;
	durationMs?: number;
}

export interface DetectDeadSpacesResult {
	spans: DeadSpaceSpan[];
	removedMs: number;
	silenceCount: number;
}

export async function detectDeadSpaces(
	videoPath: string,
	options: DetectDeadSpacesOptions = {},
): Promise<DetectDeadSpacesResult> {
	const ffmpegPath = getFfmpegBinaryPath();
	// silencedetect writes its report to stderr; stdout stays empty.
	// -vn: audio only. -f null -: decode and discard.
	const { stderr } = await execFileAsync(
		ffmpegPath,
		[
			"-i",
			videoPath,
			"-vn",
			"-af",
			`silencedetect=noise=${SILENCE_NOISE_DB}dB:d=${SILENCE_DETECT_MIN_S}`,
			"-f",
			"null",
			"-",
		],
		{ maxBuffer: 10 * 1024 * 1024 },
	);
	const intervals = parseSilenceIntervals(stderr);
	const spans = computeDeadSpaces(intervals, options);
	return {
		spans,
		removedMs: spans.reduce((sum, span) => sum + (span.endMs - span.startMs), 0),
		silenceCount: intervals.length,
	};
}
