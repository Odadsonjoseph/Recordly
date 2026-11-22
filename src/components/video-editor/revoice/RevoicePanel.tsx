// AI Re-voice + dead-space removal, merged into one "Clean up" button — v7.
// One tap does everything, in order:
//   1. Downloads the Kokoro voice model first if it is missing (~300 MB, once).
//   2. Finds silent gaps over 2 s and cuts them out of the video.
//   3. Cleans the script (fillers, stutters, false starts) and re-speaks it
//      in the chosen AI narrator voice, at the same spots in the video.
// The new voice track is cut by the same spans as the video, so the two stay
// in sync: main cuts the spans out of the merged wav (generate.ts cutSpans),
// and the panel cuts the same spans out of the timeline via
// onRemoveDeadSpaces. Your original mic audio stays muted underneath —
// nothing is deleted, tap "Use original voice" to A/B.
//
// Placement: this panel renders at the TOP of both caption views — the
// per-caption view (CaptionItemSettings) and the Captions home
// (CaptionGenerationSettings) — so it is visible as soon as Captions opens.

import { useEffect, useState } from "react";
import {
	DEFAULT_REVOICE_OPTIONS,
	REVOICE_VOICES,
	type RevoiceModelDownloadState,
	type RevoiceResult,
} from "@/shared/revoice";
import type { CaptionCue } from "@/components/video-editor/types";
import type { DeadSpaceSpan } from "@/lib/revoice/deadSpace";

interface RevoicePanelProps {
	videoPath: string;
	/** CaptionCue[] from the editor. May be [] — main will transcribe then. */
	cues: CaptionCue[];
	onRevoiceDone: (result: RevoiceResult) => void;
	onUseOriginal: () => void;
	/** v4 — cuts the given spans out of the timeline (ripple delete). */
	onRemoveDeadSpaces?: (spans: DeadSpaceSpan[]) => void;
}

export function RevoicePanel({ videoPath, cues, onRevoiceDone, onUseOriginal, onRemoveDeadSpaces }: RevoicePanelProps) {
	const [voiceId, setVoiceId] = useState(DEFAULT_REVOICE_OPTIONS.voiceId);
	const [speed, setSpeed] = useState(DEFAULT_REVOICE_OPTIONS.speed);
	const [status, setStatus] = useState<string>("");
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<RevoiceResult | null>(null);
	const [modelInstalled, setModelInstalled] = useState<boolean | null>(null);
	const [download, setDownload] = useState<RevoiceModelDownloadState>({ status: "idle", progress: 0 });

	useEffect(() => {
		let cancelled = false;
		window.electronAPI
			.getRevoiceModelStatus()
			.then((res) => {
				if (!cancelled) setModelInstalled(res.success ? res.installed : false);
			})
			.catch(() => {
				if (!cancelled) setModelInstalled(false);
			});
		const unsubscribe = window.electronAPI.onRevoiceModelDownloadProgress((state) => {
			if (cancelled) return;
			setDownload(state);
			if (state.status === "downloaded") setModelInstalled(true);
		});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, []);

	async function ensureModel(): Promise<void> {
		if (modelInstalled) return;
		setDownload({ status: "downloading", progress: 0 });
		const response = await window.electronAPI.downloadRevoiceModel();
		if (!response.success) {
			setDownload({ status: "error", progress: 0, error: response.error });
			throw new Error(response.error ?? "Voice model download failed.");
		}
		setModelInstalled(true);
		setDownload({ status: "downloaded", progress: 100 });
	}

	async function downloadModel(): Promise<void> {
		setBusy(true);
		try {
			setStatus("Downloading the voice model (~300 MB, one time)…");
			await ensureModel();
			setStatus("Voice model ready — tap Clean up my video when you're ready.");
		} catch (error) {
			setStatus(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	}

	async function cleanUp(): Promise<void> {
		setBusy(true);
		setResult(null);
		try {
			// 1. Voice model first — the re-voice cannot run without it, and
			// the old error gave no way to get it. Now the download is here.
			if (!modelInstalled) {
				setStatus("Downloading the voice model (~300 MB, one time)…");
				await ensureModel();
			}
			// 2. Find the dead spaces. If detection fails, keep going and
			// re-voice without cutting — a failed listen should not block
			// the voice.
			let spans: DeadSpaceSpan[] = [];
			let cutNote = "";
			try {
				setStatus("Listening for silent gaps…");
				const det = await window.electronAPI.detectDeadSpaces({ videoPath });
				if (det.success && det.spans) spans = det.spans;
				else cutNote = " (gap detection failed, so nothing was cut)";
			} catch {
				cutNote = " (gap detection failed, so nothing was cut)";
			}
			// 3. Re-voice, with the same spans cut out of the new audio so
			// it matches the shorter video exactly.
			setStatus(
				cues.length
					? "Cleaning your script, then re-speaking it…"
					: "Transcribing first, then cleaning and re-speaking…",
			);
			const response = await window.electronAPI.generateRevoice({
				videoPath,
				voiceId,
				speed,
				cleanFillers: true,
				cleanGrammar: true,
				muteOriginal: true,
				cues: cues.map((c) => ({ text: c.text, startMs: c.startMs, endMs: c.endMs })),
				cutSpans: spans,
			});
			if (!response.success || !response.result) {
				throw new Error(response.error ?? "Clean up failed.");
			}
			const out = response.result;
			setResult(out);
			// 4. Place the (already shortened) voice, then cut the video
			// timeline by the same spans.
			onRevoiceDone(out);
			if (spans.length && onRemoveDeadSpaces) onRemoveDeadSpaces(spans);
			const seconds = (
				spans.reduce((sum, span) => sum + (span.endMs - span.startMs), 0) / 1000
			).toFixed(1);
			setStatus(
				`Cleaned up — ${out.removedFillers} fillers removed, ` +
					`${out.originalWordCount} → ${out.cleanedWordCount} words, ` +
					`${spans.length} gap${spans.length === 1 ? "" : "s"} cut, video ${seconds}s shorter${cutNote}. ` +
					`Original muted, tap "Use original" to A/B.`,
			);
		} catch (error) {
			setStatus(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	}

	const downloading = download.status === "downloading" || download.status === "extracting";

	return (
		<div className="flex flex-col gap-3 rounded-xl border border-border p-3">
			<h3 className="text-sm font-semibold">Clean up</h3>
			<p className="text-xs opacity-70">
				One tap: cuts the dead air, cleans up ums and stutters, and re-speaks
				your narration in a clean AI voice. Your original stays muted
				underneath — nothing is deleted.
			</p>
			<label className="text-xs">
				Voice
				<select
					className="mt-1 w-full rounded border p-2"
					value={voiceId}
					onChange={(e) => setVoiceId(e.target.value)}
					disabled={busy}
				>
					{REVOICE_VOICES.map((v) => (
						<option key={v.id} value={v.id}>
							{v.label}
						</option>
					))}
				</select>
			</label>
			<label className="text-xs">
				Speed — {speed.toFixed(2)}x
				<input
					type="range"
					min={0.9}
					max={1.1}
					step={0.05}
					value={speed}
					onChange={(e) => setSpeed(Number(e.target.value))}
					disabled={busy}
					className="w-full"
				/>
			</label>
			{modelInstalled === false ? (
				<div className="flex flex-col gap-2">
					<p className="text-xs opacity-70">
						The voice model is not downloaded yet — one-time download, about
						300 MB, then it works offline.
					</p>
					<button
						type="button"
						onClick={downloadModel}
						disabled={busy}
						className="rounded border px-3 py-2 text-sm disabled:opacity-40"
					>
						{downloading ? `Downloading voice… ${download.progress}%` : "Download voice model"}
					</button>
				</div>
			) : null}
			<button
				type="button"
				onClick={cleanUp}
				disabled={busy}
				className="rounded bg-black px-3 py-2 text-sm text-white disabled:opacity-40"
			>
				{busy ? "Cleaning up…" : "Clean up my video"}
			</button>
			{result ? (
				<button type="button" onClick={onUseOriginal} className="rounded border px-3 py-2 text-sm">
					Use original voice
				</button>
			) : null}
			{downloading ? (
				<p className="text-xs opacity-80">Downloading voice… {download.progress}%</p>
			) : null}
			{status ? <p className="text-xs opacity-80">{status}</p> : null}
			<p className="text-[11px] opacity-50">
				Free and offline after a one-time voice download (~300 MB). No API key.
			</p>
		</div>
	);
}
