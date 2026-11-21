import { useState } from "react";
import CaptionListPanel from "@/components/video-editor/CaptionListPanel";
import { RevoicePanel } from "@/components/video-editor/revoice/RevoicePanel";

import type { ResolvedSettingsPanelProps } from "./settingsPanelDefaults";
import { useSettingsTranslations } from "./useSettingsTranslations";

export const captionItemSettingsKeys = [
	"videoPath",
	"audioRegions",
	"onAudioAdded",
	"onAudioDelete",
	"autoCaptions",
	"captionCurrentTimeMs",
	"selectedCaptionId",
	"onBeginCaptionEdit",
	"onCaptionTextEdit",
	"onCaptionRetime",
	"onCaptionSplit",
	"onCaptionMerge",
	"onCaptionDelete",
] as const;
type Props = Pick<ResolvedSettingsPanelProps, (typeof captionItemSettingsKeys)[number]>;
export function CaptionItemSettings(props: Props) {
	const {
		videoPath,
		audioRegions,
		onAudioAdded,
		onAudioDelete,
		autoCaptions,
		captionCurrentTimeMs,
		selectedCaptionId,
		onBeginCaptionEdit,
		onCaptionTextEdit,
		onCaptionRetime,
		onCaptionSplit,
		onCaptionMerge,
		onCaptionDelete,
	} = props;
	const { tSettings } = useSettingsTranslations();
	const [revoiceAudioPath, setRevoiceAudioPath] = useState<string | null>(null);

	return (
		<section className="flex flex-col gap-4">
			{selectedCaptionId !== null ? (
				<CaptionListPanel
					cues={autoCaptions}
					selectedCaptionId={selectedCaptionId}
					currentTimeMs={captionCurrentTimeMs}
					onBeginCaptionEdit={(id) => onBeginCaptionEdit?.(id)}
					onCaptionTextEdit={(id, text) => onCaptionTextEdit?.(id, text)}
					onCaptionRetime={(id, span) => onCaptionRetime?.(id, span)}
					onCaptionSplit={(id, atMs) => onCaptionSplit?.(id, atMs)}
					onCaptionMerge={(idA, idB) => onCaptionMerge?.(idA, idB)}
					onCaptionDelete={(id) => onCaptionDelete?.(id)}
				/>
			) : (
				<div className="rounded-lg bg-foreground/[0.03] px-2.5 py-6 text-center">
					<p className="text-xs text-muted-foreground">
						{tSettings(
							"captions.selectOnTimeline",
							"Select a caption on the timeline to edit it.",
						)}
					</p>
				</div>
			)}
			{videoPath ? (
				<RevoicePanel
					videoPath={videoPath}
					cues={autoCaptions}
					onRevoiceDone={(result) => {
						onAudioAdded?.({ start: 0, end: result.durationMs }, result.audioPath);
						setRevoiceAudioPath(result.audioPath);
					}}
					onUseOriginal={() => {
						const region = audioRegions?.find((r) => r.audioPath === revoiceAudioPath);
						if (region) onAudioDelete?.(region.id);
						setRevoiceAudioPath(null);
					}}
				/>
			) : null}
		</section>
	);
}
