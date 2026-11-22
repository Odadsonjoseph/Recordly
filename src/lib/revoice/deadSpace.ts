// Recordly AI Re-voice v4 — dead-space removal (pure helpers, no I/O).
// Grounded to fork HEAD 8f2491dc (branch revoice-feature).
//
// A "dead space" is a long silence in the source audio. Detection runs in
// main (electron/ipc/revoice/deadSpace.ts) with ffmpeg silencedetect and
// parseSilenceIntervals from electron/ipc/captions/silence.ts. This file
// turns those silence intervals into removable timeline spans and maps them
// onto the editor's clip sequence.
//
// Cutting itself is a ripple delete: split the clip at each span edge,
// remove the middle clip, packClipSequence closes the gap. Captions are
// stored in SOURCE time and projected by projectCaptionCues, so they follow
// the cut automatically. Zooms/annotations/audio ripple via applySequence.

export interface DeadSpaceSpan {
	startMs: number;
	endMs: number;
}

export interface SilenceIntervalLike {
	startMs: number;
	/** Number.POSITIVE_INFINITY for a trailing silence that runs to end-of-audio. */
	endMs: number;
}

export interface ComputeDeadSpacesOptions {
	/** A silence must be at least this long (ms) to be cut. Default 2000. */
	thresholdMs?: number;
	/** Natural pause (ms) kept at the end of each removed gap. Default 400. */
	keepMs?: number;
	/** Source duration (ms). Trailing open-ended silences are clipped to it. */
	durationMs?: number;
}

/**
 * Turn raw silence intervals into removable spans.
 * - Silences shorter than thresholdMs are kept (natural pauses).
 * - keepMs of pause is kept at the END of each removed gap, so speech never
 *   starts hard against the cut.
 * - Spans shorter than 100 ms after the keep are dropped.
 * - Result is sorted, non-overlapping, and clipped to [0, durationMs).
 */
export function computeDeadSpaces(
	silences: SilenceIntervalLike[],
	options: ComputeDeadSpacesOptions = {},
): DeadSpaceSpan[] {
	const thresholdMs = options.thresholdMs ?? 2000;
	const keepMs = options.keepMs ?? 400;
	const durationMs = options.durationMs ?? Number.POSITIVE_INFINITY;
	const spans: DeadSpaceSpan[] = [];
	for (const silence of silences) {
		const silenceEnd = Math.min(silence.endMs, durationMs);
		const length = silenceEnd - silence.startMs;
		if (!Number.isFinite(length) || length < thresholdMs) continue;
		const startMs = Math.max(0, Math.round(silence.startMs));
		const endMs = Math.min(Math.round(silenceEnd - keepMs), Math.round(durationMs));
		if (endMs - startMs < 100) continue;
		spans.push({ startMs, endMs });
	}
	spans.sort((a, b) => a.startMs - b.startMs);
	const merged: DeadSpaceSpan[] = [];
	for (const span of spans) {
		const prev = merged[merged.length - 1];
		if (prev && span.startMs <= prev.endMs) {
			prev.endMs = Math.max(prev.endMs, span.endMs);
		} else {
			merged.push({ ...span });
		}
	}
	return merged;
}

/** Minimal clip shape for source->timeline mapping (ClipRegion is compatible). */
export interface ClipLike {
	startMs: number;
	endMs: number;
	sourceStartMs?: number;
	speed?: number;
}

/**
 * Map source-time spans onto timeline time through the clip sequence.
 * A span that starts inside a clip maps by that clip's in-point and speed.
 * Spans crossing a clip boundary, or outside every clip, are dropped —
 * cutting across a manual split is out of scope for v4.
 */
export function mapDeadSpaceSpansToTimeline(
	spans: DeadSpaceSpan[],
	clips: ClipLike[],
): DeadSpaceSpan[] {
	const sorted = [...clips].sort((a, b) => a.startMs - b.startMs);
	const out: DeadSpaceSpan[] = [];
	for (const span of spans) {
		const owner = sorted.find((clip) => {
			const sourceStart = clip.sourceStartMs ?? clip.startMs;
			const sourceEnd = sourceStart + (clip.endMs - clip.startMs) * (clip.speed ?? 1);
			return span.startMs >= sourceStart && span.startMs < sourceEnd;
		});
		if (!owner) continue;
		const sourceStart = owner.sourceStartMs ?? owner.startMs;
		const speed = owner.speed ?? 1;
		const startMs = Math.round(owner.startMs + (span.startMs - sourceStart) / speed);
		const endMs = Math.round(owner.startMs + (span.endMs - sourceStart) / speed);
		if (endMs <= startMs || endMs > owner.endMs) continue;
		out.push({ startMs, endMs });
	}
	return out;
}
