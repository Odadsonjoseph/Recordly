import { type Dispatch, type MutableRefObject, type SetStateAction, useCallback } from "react";
import { toast } from "@/components/ui/toast";
import type { SourceAudioTrackSettings } from "../audio/audioTypes";
import { planClipMerge } from "../clipMerge";
import {
	packClipSequence,
	reorderClipSequence,
	rippleRegionAnchors,
	rippleRegions,
} from "../clipSequence";
import { changeClipSpan } from "../clipSpanChange";
import { planClipSplit } from "../clipSplit";
import { mapDeadSpaceSpansToTimeline, type DeadSpaceSpan } from "@/lib/revoice/deadSpace";
import type { ClipSequenceSpan } from "../timeline/core/timelineTypes";
import type { ClipRegion, EditorEffectSection, ZoomRegion } from "../types";
import { type AnnotationRegion, type AudioRegion, getClipSourceStartMs } from "../types";
import { supportsPreviewPlaybackRate } from "../videoPlayback/playbackRate";

type Translator = (
	key: string,
	fallback?: string,
	params?: Record<string, string | number>,
) => string;

interface UseClipRegionCommandsParams {
	setAnnotationRegions: Dispatch<SetStateAction<AnnotationRegion[]>>;
	setAudioRegions: Dispatch<SetStateAction<AudioRegion[]>>;
	getSourceAudioTrackSettingsForClip: (id: string | null) => SourceAudioTrackSettings;
	sourceDurationMs: number;
	clipRegions: ClipRegion[];
	setClipRegions: Dispatch<SetStateAction<ClipRegion[]>>;
	setSourceAudioTrackSettingsByClip: Dispatch<
		SetStateAction<Record<string, SourceAudioTrackSettings>>
	>;
	zoomRegions: ZoomRegion[];
	setZoomRegions: Dispatch<SetStateAction<ZoomRegion[]>>;
	selectedClipId: string | null;
	setSelectedClipId: Dispatch<SetStateAction<string | null>>;
	setSelectedZoomId: Dispatch<SetStateAction<string | null>>;
	setSelectedAnnotationId: Dispatch<SetStateAction<string | null>>;
	setSelectedAudioId: Dispatch<SetStateAction<string | null>>;
	setSelectedCaptionId: Dispatch<SetStateAction<string | null>>;
	setActiveEffectSection: Dispatch<SetStateAction<EditorEffectSection>>;
	nextClipIdRef: MutableRefObject<number>;
	nextZoomIdRef: MutableRefObject<number>;
	t: Translator;
}

export function useClipRegionCommands({
	setAnnotationRegions,
	setAudioRegions,
	getSourceAudioTrackSettingsForClip,
	sourceDurationMs,
	clipRegions,
	setClipRegions,
	setSourceAudioTrackSettingsByClip,
	zoomRegions,
	setZoomRegions,
	selectedClipId,
	setSelectedClipId,
	setSelectedZoomId,
	setSelectedAnnotationId,
	setSelectedAudioId,
	setSelectedCaptionId,
	setActiveEffectSection,
	nextClipIdRef,
	nextZoomIdRef,
	t,
}: UseClipRegionCommandsParams) {
	const applySequence = useCallback(
		(edited: ClipRegion[]) => {
			const next = packClipSequence(edited);
			setClipRegions(next);
			setZoomRegions((current) => rippleRegions(current, clipRegions, next));
			setAnnotationRegions((current) => rippleRegions(current, clipRegions, next));
			setAudioRegions((current) => rippleRegionAnchors(current, clipRegions, next));
		},
		[clipRegions, setClipRegions, setZoomRegions, setAnnotationRegions, setAudioRegions],
	);

	const handleSelectClip = useCallback(
		(id: string | null) => {
			setSelectedClipId(id);
			if (id) {
				setActiveEffectSection("clip");
				setSelectedZoomId(null);
				setSelectedAnnotationId(null);
				setSelectedAudioId(null);
				setSelectedCaptionId(null);
			} else {
				setActiveEffectSection((section) => (section === "clip" ? "scene" : section));
			}
		},
		[
			setActiveEffectSection,
			setSelectedAnnotationId,
			setSelectedAudioId,
			setSelectedCaptionId,
			setSelectedClipId,
			setSelectedZoomId,
		],
	);

	const handleClipSplit = useCallback(
		(splitMs: number) => {
			const plan = planClipSplit({
				clipRegions,
				splitMs,
				createId: () => `clip-${nextClipIdRef.current++}`,
			});
			if (!plan) return;
			// Zooms use timeline time, including when the clip plays at another speed.
			// Allocate IDs outside the state updater so Strict Mode cannot consume them twice.
			const splitAtMs = plan.left.endMs;
			const splitZooms = zoomRegions.flatMap((zoom) =>
				zoom.startMs < splitAtMs && splitAtMs < zoom.endMs
					? [
							{ ...zoom, endMs: splitAtMs },
							{ ...zoom, id: `zoom-${nextZoomIdRef.current++}`, startMs: splitAtMs },
						]
					: [zoom],
			);
			if (splitZooms.length !== zoomRegions.length) setZoomRegions(splitZooms);
			setClipRegions((current) =>
				current.flatMap((clip) =>
					clip.id === plan.targetId ? [plan.left, plan.right] : [clip],
				),
			);
			setSourceAudioTrackSettingsByClip((current) => {
				const inherited = current[plan.targetId];
				const next = { ...current };
				delete next[plan.targetId];
				// Undo can reuse IDs; a new half must never inherit stale overrides.
				delete next[plan.left.id];
				delete next[plan.right.id];
				if (inherited) {
					next[plan.left.id] = structuredClone(inherited);
					next[plan.right.id] = structuredClone(inherited);
				}
				return next;
			});
			handleSelectClip(plan.left.id);
		},
		[
			clipRegions,
			nextClipIdRef,
			nextZoomIdRef,
			zoomRegions,
			setZoomRegions,
			handleSelectClip,
			setClipRegions,
			setSourceAudioTrackSettingsByClip,
		],
	);

	const handleClipSpanChange = useCallback(
		(id: string, span: ClipSequenceSpan) => {
			const oldClip = clipRegions.find((clip) => clip.id === id);
			const newStart = Math.round(span.start);
			const newEnd = Math.round(span.end);

			if (!oldClip) return;
			if (span.sequenceIndex !== undefined) {
				applySequence(reorderClipSequence(clipRegions, id, span.sequenceIndex));
				return;
			}
			applySequence(
				clipRegions.map((clip) =>
					clip.id === id
						? changeClipSpan(clip, newStart, newEnd, sourceDurationMs)
						: clip,
				),
			);
		},
		[clipRegions, applySequence, sourceDurationMs],
	);

	const handleClipSpeedChange = useCallback(
		(speed: number) => {
			if (!selectedClipId || !Number.isFinite(speed) || speed <= 0) return;
			if (!supportsPreviewPlaybackRate(speed)) {
				toast.error(
					t(
						"editor.timeline.unsupportedSpeed",
						"This speed is not supported for preview on this device.",
					),
				);
				return;
			}

			applySequence(
				clipRegions.map((clip) =>
					clip.id === selectedClipId
						? {
								...clip,
								sourceStartMs: getClipSourceStartMs(clip),
								speed,
								endMs:
									clip.startMs +
									Math.max(
										1,
										Math.round(
											((clip.endMs - clip.startMs) * clip.speed) / speed,
										),
									),
							}
						: clip,
				),
			);
		},
		[clipRegions, selectedClipId, applySequence, t],
	);

	const handleClipMutedChange = useCallback(
		(muted: boolean) => {
			if (!selectedClipId) return;
			setClipRegions((current) =>
				current.map((clip) => (clip.id === selectedClipId ? { ...clip, muted } : clip)),
			);
		},
		[selectedClipId, setClipRegions],
	);
	const handleClipShowSourceAudioChange = useCallback(
		(showSourceAudio: boolean) => {
			if (!selectedClipId) return;
			setClipRegions((current) =>
				current.map((clip) =>
					clip.id === selectedClipId ? { ...clip, showSourceAudio } : clip,
				),
			);
		},
		[selectedClipId, setClipRegions],
	);

	const handleClipDelete = useCallback(
		(id: string) => {
			const index = clipRegions.findIndex((clip) => clip.id === id);
			if (index < 0) return;
			applySequence(clipRegions.filter((clip) => clip.id !== id));
			setSourceAudioTrackSettingsByClip((current) => {
				if (!(id in current)) return current;
				const next = { ...current };
				delete next[id];
				return next;
			});
			if (selectedClipId === id) {
				const neighbor = clipRegions[index + 1] ?? clipRegions[index - 1];
				handleSelectClip(neighbor?.id ?? null);
			}
		},
		[
			clipRegions,
			selectedClipId,
			applySequence,
			handleSelectClip,
			setSourceAudioTrackSettingsByClip,
		],
	);

	// v4 — dead-space removal (AI Re-voice). Cut every span out of the clip
	// sequence with a ripple delete: split at each span edge, drop the middle
	// clip, applySequence packs the gap and ripples zooms/annotations/audio.
	// Captions are stored in source time and re-projected, so they follow.
	// Spans arrive in source time; map them to timeline time first.
	// NOTE: per-clip source-audio overrides on a cut clip are not inherited
	// by the halves (same as handleClipDelete) — acceptable for v4.
	const handleRemoveDeadSpaces = useCallback(
		(spans: DeadSpaceSpan[]) => {
			const timelineSpans = mapDeadSpaceSpansToTimeline(spans, clipRegions);
			if (timelineSpans.length === 0) return;
			// Latest first so earlier timeline positions stay valid while splitting.
			const edited = [...timelineSpans]
				.sort((a, b) => b.startMs - a.startMs)
				.reduce<ClipRegion[]>((current, span) => {
					const createId = () => `clip-${nextClipIdRef.current++}`;
					const first = planClipSplit({ clipRegions: current, splitMs: span.startMs, createId });
					if (!first) return current;
					const afterFirst = current.flatMap((clip) =>
						clip.id === first.targetId ? [first.left, first.right] : [clip],
					);
					const second = planClipSplit({ clipRegions: afterFirst, splitMs: span.endMs, createId });
					if (!second) return afterFirst;
					const afterSecond = afterFirst.flatMap((clip) =>
						clip.id === second.targetId ? [second.left, second.right] : [clip],
					);
					// second.left is the clip spanning [span.startMs, span.endMs).
					return afterSecond.filter((clip) => clip.id !== second.left.id);
				}, clipRegions);
			if (edited.length === clipRegions.length) return;
			applySequence(edited);
		},
		[clipRegions, applySequence, nextClipIdRef],
	);

	const canMergeClips = (ids: string[]) =>
		planClipMerge(clipRegions, ids, getSourceAudioTrackSettingsForClip) !== null;

	const handleClipMerge = (ids: string[]) => {
		const next = planClipMerge(clipRegions, ids, getSourceAudioTrackSettingsForClip);
		if (!next) return;
		const merged = next.find((clip) => ids.includes(clip.id));
		if (!merged) return;
		// The timeline duration and source mapping are unchanged: keep effects in place.
		setClipRegions(next);
		setSourceAudioTrackSettingsByClip((current) => {
			const updated = { ...current };
			for (const id of ids) if (id !== merged.id) delete updated[id];
			return updated;
		});
		handleSelectClip(merged.id);
	};

	return {
		canMergeClips,
		handleClipMerge,
		handleSelectClip,
		handleClipSplit,
		handleClipSpanChange,
		handleClipSpeedChange,
		handleClipMutedChange,
		handleClipShowSourceAudioChange,
		handleClipDelete,
		handleRemoveDeadSpaces,
	};
}
