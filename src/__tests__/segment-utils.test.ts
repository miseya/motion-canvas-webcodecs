import {describe, expect, it} from "vitest";
import type {BatchRenderSegmentResult} from "../batch-types";
import {splitIntoSegments, validateAndOrderSegments} from "../segment-utils";

function makeSegment(
  jobIndex: number,
  start: number,
  end: number,
  overrides: Partial<BatchRenderSegmentResult> = {},
): BatchRenderSegmentResult {
  return {
    jobIndex,
    frameRange: [start, end],
    buffer: new ArrayBuffer(1),
    durationFrames: end - start,
    ...overrides,
  };
}

describe("splitIntoSegments", () => {
  it("splits into fixed-size chunks with a tail segment", () => {
    expect(splitIntoSegments(10, 3)).toEqual([
      [0, 3],
      [3, 6],
      [6, 9],
      [9, 10],
    ]);
  });

  it("returns an empty list for zero total frames", () => {
    expect(splitIntoSegments(0, 10)).toEqual([]);
  });

  it("throws for non-positive segment size", () => {
    expect(() => splitIntoSegments(10, 0)).toThrow("segmentSize must be > 0");
  });
});

describe("validateAndOrderSegments", () => {
  it("orders segments by job index and validates contiguous coverage", () => {
    const ordered = validateAndOrderSegments(
      [
        makeSegment(1, 13, 16),
        makeSegment(0, 10, 13),
      ],
      {
        expectedStartFrame: 10,
        expectedTotalFrames: 6,
      },
    );

    expect(ordered.map(segment => segment.jobIndex)).toEqual([0, 1]);
  });

  it("throws when job indexes are duplicated", () => {
    expect(() =>
      validateAndOrderSegments(
        [
          makeSegment(0, 0, 3),
          makeSegment(0, 3, 6),
        ],
        {
          expectedStartFrame: 0,
          expectedTotalFrames: 6,
        },
      ),
    ).toThrow("duplicate segment job index");
  });

  it("throws when frame ranges are not contiguous", () => {
    expect(() =>
      validateAndOrderSegments(
        [
          makeSegment(0, 0, 3),
          makeSegment(1, 4, 6),
        ],
        {
          expectedStartFrame: 0,
          expectedTotalFrames: 6,
        },
      ),
    ).toThrow("non-contiguous segment ranges");
  });

  it("throws when durationFrames does not match frame range length", () => {
    expect(() =>
      validateAndOrderSegments(
        [
          makeSegment(0, 0, 3),
          makeSegment(1, 3, 6, {durationFrames: 1}),
        ],
        {
          expectedStartFrame: 0,
          expectedTotalFrames: 6,
        },
      ),
    ).toThrow("duration mismatch");
  });

  it("throws when final frame coverage does not match expected total", () => {
    expect(() =>
      validateAndOrderSegments(
        [
          makeSegment(0, 0, 3),
          makeSegment(1, 3, 5),
        ],
        {
          expectedStartFrame: 0,
          expectedTotalFrames: 6,
        },
      ),
    ).toThrow("frame coverage mismatch");
  });

  it("throws when any segment reports an error", () => {
    expect(() =>
      validateAndOrderSegments(
        [
          makeSegment(0, 0, 3),
          makeSegment(1, 3, 6, {error: "encoder failed"}),
        ],
        {
          expectedStartFrame: 0,
          expectedTotalFrames: 6,
        },
      ),
    ).toThrow("segment 1 failed");
  });
});
