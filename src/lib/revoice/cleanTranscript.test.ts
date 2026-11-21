import { describe, expect, it } from "vitest";
import { cleanTranscript, splitIntoPhrases } from "./cleanTranscript";

describe("cleanTranscript", () => {
	it("removes um/uh and keeps meaning", () => {
		const out = cleanTranscript("Um, so uh, click the record button.");
		expect(out.text).toBe("Click the record button.");
		expect(out.stats.removedFillers).toBeGreaterThan(0);
		expect(out.changed).toBe(true);
	});

	it("removes stutters and immediate repeats", () => {
		const out = cleanTranscript("I I want to to show you the the timeline.");
		expect(out.text).toBe("I want to show you the timeline.");
	});

	it("removes you know / sort of", () => {
		const out = cleanTranscript("You know, it sort of just works.");
		expect(out.text).toBe("It just works.");
	});

	it("keeps numbers, names and tech terms", () => {
		const out = cleanTranscript("Um, open Recordly 2.0 and press Cmd Shift 5.");
		expect(out.text).toContain("Recordly 2.0");
		expect(out.text).toContain("Cmd Shift 5");
	});

	it("returns empty cleanly", () => {
		const out = cleanTranscript("   ");
		expect(out.text).toBe("");
		expect(out.stats.cleanedWordCount).toBe(0);
	});
});

describe("splitIntoPhrases", () => {
	it("splits long sentences at 22 words", () => {
		const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ") + ".";
		const phrases = splitIntoPhrases(long);
		expect(phrases.length).toBe(2);
	});
});
