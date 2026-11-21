// AI Re-voice — IPC registration for Recordly HEAD 8f2491dc (v2 fix).
// Follows the exact pattern in electron/ipc/register/captions.ts:
//   - export function registerRevoiceHandlers()
//   - called from electron/ipc/handlers.ts next to registerCaptionHandlers()
//   - handler names are kebab-case, like "generate-auto-captions"
//   - preload is FLAT: window.electronAPI.generateRevoice (see below)
//     NOT nested window.electronAPI.revoice.generate (v1 bug, fixed).
//
// Cues: the renderer already holds CaptionCue[] { id, startMs, endMs,
// text } in the editor (src/components/video-editor/types.ts).
// The panel passes those cues in. If cues are missing/empty, main
// falls back to generateAutoCaptionsFromVideo({ videoPath, ... })
// from ../captions/generate — the same function the captions handler
// uses. There is no getCurrentProjectCaptionCues() in Recordly;
// v1 PATCH-WIRING invented that name. Do not use it.

import { ipcMain } from "electron";
import type { AutoCaptionGenerationOptions } from "../captions/generate";
import { generateAutoCaptionsFromVideo } from "../captions/generate";
import { generateRevoice, type RevoiceCue } from "../revoice/generate";
import { isKokoroInstalled, KOKORO_MODEL_URL } from "../revoice/kokoro";

export interface GenerateRevoiceRequest {
	videoPath: string;
	voiceId: string;
	speed: number;
	cleanFillers?: boolean;
	cleanGrammar?: boolean;
	muteOriginal?: boolean;
	/** CaptionCue[] from the editor. Optional — main will transcribe if empty. */
	cues?: RevoiceCue[];
	/** Passed through when main has to transcribe itself. */
	captionModelId?: AutoCaptionGenerationOptions["captionModelId"];
	engine?: AutoCaptionGenerationOptions["engine"];
}

export function registerRevoiceHandlers() {
	let generatingRevoice = false;

	ipcMain.handle("generate-revoice", async (_, request: GenerateRevoiceRequest) => {
		if (generatingRevoice) {
			return { success: false, error: "Re-voice is already running." };
		}
		generatingRevoice = true;
		try {
			if (!request?.videoPath) {
				return { success: false, error: "Missing video path." };
			}
			let cues = (request.cues ?? []).filter((c) => c?.text?.trim());
			if (!cues.length) {
				// No cues in the editor yet — transcribe with the real
				// captions pipeline, then re-voice those cues.
				const captioned = await generateAutoCaptionsFromVideo({
					videoPath: request.videoPath,
					captionModelId: request.captionModelId,
					engine: request.engine,
				});
				cues = (captioned.cues ?? []).map((c) => ({
					text: c.text,
					startMs: c.startMs,
					endMs: c.endMs,
				}));
			}
			if (!cues.length) {
				return { success: false, error: "No captions to re-voice yet. Run Auto-captions first." };
			}
			const result = await generateRevoice({
				videoPath: request.videoPath,
				voiceId: request.voiceId,
				speed: request.speed,
				cleanFillers: request.cleanFillers ?? true,
				cleanGrammar: request.cleanGrammar ?? true,
				muteOriginal: request.muteOriginal ?? true,
				cues,
			});
			return { success: true, result };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		} finally {
			generatingRevoice = false;
		}
	});

	ipcMain.handle("get-revoice-model-status", async () => {
		try {
			return { success: true, installed: await isKokoroInstalled(), modelUrl: KOKORO_MODEL_URL };
		} catch (error) {
			return { success: false, installed: false, error: String(error) };
		}
	});
}
