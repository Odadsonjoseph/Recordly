import { describe, expect, it } from "vitest";
import { computeDeadSpaces, mapDeadSpaceSpansToTimeline } from "./deadSpace";

describe("computeDeadSpaces", () => {
	it("cuts long silences, keeps a natural pause at the end", () => {
		const spans = computeDeadSpaces([{ startMs: 5000, endMs: 9000 }]);
		expect(spans).toEqual([{ startMs: 5000, endMs: 8600 }]);
	});

	it("keeps short pauses untouched", () => {
		expect(computeDeadSpaces([{ startMs: 5000, endMs: 6500 }])).toEqual([]);
	});

	it("drops a span that leaves less than 100 ms after the keep", () => {
		expect(
			computeDeadSpaces([{ startMs: 5000, endMs: 7450 }], { thresholdMs: 2000, keepMs: 2400 }),
		).toEqual([]);
	});

	it("clips a trailing open-ended silence to the duration", () => {
		const spans = computeDeadSpaces(
			[{ startMs: 20000, endMs: Number.POSITIVE_INFINITY }],
			{ durationMs: 25000 },
		);
		expect(spans).toEqual([{ startMs: 20000, endMs: 24600 }]);
	});

	it("merges overlapping spans and sorts them", () => {
		const spans = computeDeadSpaces([
			{ startMs: 12000, endMs: 16000 },
			{ startMs: 5000, endMs: 9000 },
			{ startMs: 8500, endMs: 12500 },
		]);
		expect(spans).toEqual([{ startMs: 5000, endMs: 15600 }]);
	});
});

describe("mapDeadSpaceSpansToTimeline", () => {
	it("maps a source span through a single full clip", () => {
		const mapped = mapDeadSpaceSpansToTimeline([{ startMs: 5000, endMs: 8600 }], [
			{ startMs: 0, endMs: 60000, sourceStartMs: 0, speed: 1 },
		]);
		expect(mapped).toEqual([{ startMs: 5000, endMs: 8600 }]);
	});

	it("offsets through a trimmed clip", () => {
		const mapped = mapDeadSpaceSpansToTimeline([{ startMs: 15000, endMs: 18600 }], [
			{ startMs: 0, endMs: 50000, sourceStartMs: 10000, speed: 1 },
		]);
		expect(mapped).toEqual([{ startMs: 5000, endMs: 8600 }]);
	});

	it("drops a span that crosses a clip boundary", () => {
		const mapped = mapDeadSpaceSpansToTimeline([{ startMs: 9000, endMs: 12600 }], [
			{ startMs: 0, endMs: 10000, sourceStartMs: 0, speed: 1 },
			{ startMs: 10000, endMs: 20000, sourceStartMs: 10000, speed: 1 },
		]);
		expect(mapped).toEqual([]);
	});
});
