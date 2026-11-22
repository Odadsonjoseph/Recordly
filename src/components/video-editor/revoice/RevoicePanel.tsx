// AI Re-voice panel — renderer side. v2, HEAD 8f2491dc.
// Place this next to the Captions / Audio panels in the video editor.
// It does NOT call Kokoro directly.
//
// v2 fix — flat preload API (was nested in v1, which does not match
// Recordly): electron/preload.ts exposes flat methods, like
//   generateAutoCaptions: (o) => ipcRenderer.invoke("generate-auto-captions", o)
// So this panel calls:
//   window.electronAPI.generateRevoice({ videoPath, voiceId, speed, cues })
//     -> { success: boolean, result?: RevoiceResult, error?: string }
//   window.electronAPI.getRevoiceModelStatus()
//     -> { success, installed, modelUrl }
//
// Cues: pass the editor's CaptionCue[] { id, startMs, endMs, text }
// (src/components/video-editor/types.ts) in. If you pass [], main
// transcribes first via generateAutoCaptionsFromVideo — see
// electron/ipc/register/revoice.ts. Either way the panel does not
// need to know how transcription works.
//
// On success, the caller must add an AudioRegion (same type as the
// existing extra-audio regions, src/components/video-editor/types.ts):
//   { id: result.id, startMs: 0, endMs: result.durationMs,
//     audioPath: result.audioPath, volume: 1 }
// and mute the original mic track in SourceAudioTrackSettings.
// Original stays muted, not deleted, so you can A/B in one tap.

import { useState } from "react";
import { DEFAULT_REVOICE_OPTIONS, REVOICE_VOICES, type RevoiceResult } from "@/shared/revoice";
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
	const [deadSpaceStatus, setDeadSpaceStatus] = useState<string>("");

	async function run() {
		setBusy(true);
		setStatus(cues.length ? "Cleaning your script, then re-speaking it…" : "Transcribing first, then cleaning and re-speaking…");
		try {
			const response: { success: boolean; result?: RevoiceResult; error?: string } =
				await window.electronAPI.generateRevoice({
					videoPath,
					voiceId,
					speed,
					cleanFillers: true,
					cleanGrammar: true,
					muteOriginal: true,
					cues: cues.map((c) => ({ text: c.text, startMs: c.startMs, endMs: c.endMs })),
				});
			if (!response.success || !response.result) {
				throw new Error(response.error ?? "Re-voice failed.");
			}
			const out = response.result;
			setResult(out);
			setStatus(
				`Done — ${out.phrases.length} phrases, ${out.removedFillers} fillers removed, ` +
					`${out.originalWordCount} → ${out.cleanedWordCount} words. Original muted, tap “Use original” to A/B.`,
			);
			onRevoiceDone(out);
		} catch (error) {
			setStatus(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="flex flex-col gap-3 p-3">
			<h3 className="text-sm font-semibold">AI Re-voice</h3>
			<p className="text-xs opacity-70">
				Takes what you said, cleans it up, and re-speaks it in a clean AI narrator voice.
				Your original stays muted underneath — nothing is deleted.
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
			<button
				type="button"
				onClick={run}
				disabled={busy}
				className="rounded bg-black px-3 py-2 text-sm text-white disabled:opacity-40"
			>
				{busy ? "Re-voicing…" : "Re-voice my narration"}
			</button>
			{result ? (
				<button type="button" onClick={onUseOriginal} className="rounded border px-3 py-2 text-sm">
					Use original voice
				</button>
			) : null}
			{status ? <p className="text-xs opacity-80">{status}</p> : null}
			{onRemoveDeadSpaces ? (
				<div className="flex flex-col gap-2 border-t pt-3">
					<h4 className="text-xs font-semibold">Dead spaces</h4>
					<p className="text-xs opacity-70">
						Finds silent gaps over 2 seconds and cuts them out of the video,
						keeping a short natural pause. Cut first, then re-voice — or re-voice
						again after cutting, so the new voice matches the shorter video.
					</p>
					<button
						type="button"
						disabled={busy}
						className="rounded border px-3 py-2 text-sm disabled:opacity-40"
						onClick={async () => {
							setBusy(true);
							setDeadSpaceStatus("Listening for silent gaps…");
							try {
								const response: {
									success: boolean;
									spans?: DeadSpaceSpan[];
									removedMs?: number;
									error?: string;
								} = await window.electronAPI.detectDeadSpaces({ videoPath });
								if (!response.success || !response.spans) {
									throw new Error(response.error ?? "Dead-space detection failed.");
								}
								if (!response.spans.length) {
									setDeadSpaceStatus("No silent gaps over 2 seconds found.");
								} else {
									const seconds = ((response.removedMs ?? 0) / 1000).toFixed(1);
									onRemoveDeadSpaces(response.spans);
									setDeadSpaceStatus(
										`Cut ${response.spans.length} gap${response.spans.length === 1 ? "" : "s"} — video is ${seconds}s shorter.`,
									);
								}
							} catch (error) {
								setDeadSpaceStatus(error instanceof Error ? error.message : String(error));
							} finally {
								setBusy(false);
							}
						}}
					>
						{busy ? "Cutting…" : "Cut dead spaces"}
					</button>
					{deadSpaceStatus ? <p className="text-xs opacity-80">{deadSpaceStatus}</p> : null}
				</div>
			) : null}
			<p className="text-[11px] opacity-50">
				Free and offline after a one-time voice download (~300 MB). No API key.
			</p>
		</div>
	);
}
