// Clean a Whisper transcript for re-voicing. Pure function, no I/O,
// no LLM, no network — so it runs offline and is unit-testable.
// It does NOT rewrite meaning. It removes speech disfluency and tidies
// punctuation, and keeps numbers, names, file paths, URLs and tech terms.

const FILLER_RE = /\b(um+|uh+|er+|erm+|ah+|hmm+)\b/gi;

export interface CleanStats {
	removedFillers: number;
	removedRepeats: number;
	originalWordCount: number;
	cleanedWordCount: number;
}

export interface CleanedTranscript {
	text: string;
	stats: CleanStats;
	changed: boolean;
}

function countWords(text: string): number {
	const words = text.trim().split(/\s+/).filter(Boolean);
	return text.trim() ? words.length : 0;
}

// "I I I want to to show you" -> "I want to show you"
// "the the button" -> "the button"
function dropImmediateRepeats(text: string): { text: string; removed: number } {
	let removed = 0;
	const cleaned = text.replace(
		/\b(\w+)(\s+\1\b)+/gi,
		(_m, word: string) => {
			removed += 1;
			return word;
		},
	);
	return { text: cleaned, removed };
}

// "I went to, I went to the settings" — false start: a short clause
// repeated with a small extension. Only collapse when the repeat is
// at the start of a phrase and the second copy is longer.
function dropFalseStarts(text: string): string {
	// Keep this conservative: only handle "X, X Y" where X is <= 4 words.
	return text.replace(
		/\b((?:\w+\s+){1,4}\w+),\s+\1\s+(\w+)/gi,
		(_m, head: string, next: string) => `${head} ${next}`,
	);
}

function tidyPunctuation(text: string): string {
	let out = text
		.replace(/\s+([,.!?;:])/g, "$1")
		.replace(/([,.!?]){2,}/g, "$1")
		.replace(/\s{2,}/g, " ")
		.trim();
	if (out && !/[.!?]$/.test(out)) out += ".";
	// Capitalise first letter and letters after sentence ends.
	out = out.replace(/(^\s*\w|[.!?]\s+\w)/g, (c) => c.toUpperCase());
	return out;
}

export function cleanTranscript(raw: string): CleanedTranscript {
	const originalWordCount = countWords(raw);
	if (!raw.trim()) {
		return {
			text: "",
			stats: { removedFillers: 0, removedRepeats: 0, originalWordCount, cleanedWordCount: 0 },
			changed: false,
		};
	}

	let text = raw.trim();
	let removedFillers = 0;

	// 1. Multi-word fillers first ("you know", "sort of"), then single words.
	for (const filler of ["you know", "i mean", "sort of", "kind of", "okay so", "so yeah"]) {
		const re = new RegExp(`\\b${filler}\\b[,]?`, "gi");
		text = text.replace(re, () => {
			removedFillers += 1;
			return "";
		});
	}
	text = text.replace(FILLER_RE, () => {
		removedFillers += 1;
		return "";
	});
	// Lone "like" as a filler is ambiguous ("like this button" is real),
	// so only drop it when it is between commas or at a clause edge.
	text = text.replace(/,\s*like\s*,/gi, ",");
	text = text.replace(/\s+/g, " ").trim();
	// Removing a leading filler leaves a stray comma: "Um, click" -> ", click".
	// Collapse doubled commas, strip leading/trailing commas, and drop a
	// leading discourse "so" ("So, click the button" -> "Click the button").
	text = text.replace(/,\s*,/g, ",").replace(/^[,\s]+/, "").replace(/,\s*$/, "");
	text = text.replace(/^so\s+/i, "");
	text = text.replace(/,\s*so\s*,/gi, ",").replace(/,\s*,/g, ",");
	text = text.replace(/\s+/g, " ").trim().replace(/^[,\s]+/, "");

	// 2. Stutters and immediate repeats.
	const repeats = dropImmediateRepeats(text);
	text = repeats.text;

	// 3. False starts.
	text = dropFalseStarts(text);

	// 4. Long pauses in text form ("...") collapse to a comma or nothing.
	text = text.replace(/\.{3,}/g, ",").replace(/\s+,/g, ",");

	// 5. Tidy punctuation / capitalisation. Keep tech tokens intact:
	// this step does not touch words, only spacing and sentence ends.
	text = tidyPunctuation(text);

	const cleanedWordCount = countWords(text);
	return {
		text,
		stats: {
			removedFillers,
			removedRepeats: repeats.removed,
			originalWordCount,
			cleanedWordCount,
		},
		changed: text !== raw.trim(),
	};
}

// Split a cleaned transcript back into phrases that line up with the
// original Whisper cues, so each phrase can be synthesised separately
// and placed at its original start time.
export function splitIntoPhrases(cleaned: string, maxWordsPerPhrase = 22): string[] {
	const sentences = cleaned
		.split(/(?<=[.!?])\s+/)
		.map((s) => s.trim())
		.filter(Boolean);
	const phrases: string[] = [];
	for (const sentence of sentences) {
		const words = sentence.split(/\s+/);
		if (words.length <= maxWordsPerPhrase) {
			phrases.push(sentence);
			continue;
		}
		for (let i = 0; i < words.length; i += maxWordsPerPhrase) {
			phrases.push(words.slice(i, i + maxWordsPerPhrase).join(" "));
		}
	}
	return phrases;
}
