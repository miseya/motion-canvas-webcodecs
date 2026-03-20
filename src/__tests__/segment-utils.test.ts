import {describe, expect, it} from "vitest";
import type {BatchRenderSegmentResult} from "../batch-types";
import {splitIntoSegments, validateAndOrderSegments} from "../segment-utils";
import {calculateOptimalSegmentSize} from "../batch-renderer";

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

describe("calculateOptimalSegmentSize", () => {
  it("calculates segment size for 30fps animation", () => {
    // 240 frames at 30fps = 8 seconds
    const segmentSize = calculateOptimalSegmentSize(240, 30, 4);
    expect(segmentSize).toBeGreaterThanOrEqual(10);
    expect(segmentSize).toBeLessThanOrEqual(300);
  });

  it("never returns less than 10 frames", () => {
    // Very short animation: 10 frames at 30fps
    const segmentSize = calculateOptimalSegmentSize(10, 30, 4);
    expect(segmentSize).toBe(10);
  });

  it("respects maximum segment size of 300 frames", () => {
    // Very long animation: 10000 frames at 30fps
    const segmentSize = calculateOptimalSegmentSize(10000, 30);
    expect(segmentSize).toBeLessThanOrEqual(300);
  });

  it("rounds to nearest multiple of 10", () => {
    // Segment size should be divisible by 10 for cleaner splits
    const segmentSize = calculateOptimalSegmentSize(500, 30, 4);
    expect(segmentSize % 10).toBe(0);
  });

  it("handles 60fps animation", () => {
    // 600 frames at 60fps = 10 seconds
    const segmentSize = calculateOptimalSegmentSize(600, 60, 4);
    expect(segmentSize).toBeGreaterThanOrEqual(10);
    expect(segmentSize).toBeLessThanOrEqual(600);
  });

  it("uses smaller segments when higher concurrency is requested", () => {
    const lowConcurrency = calculateOptimalSegmentSize(1200, 30, 2);
    const highConcurrency = calculateOptimalSegmentSize(1200, 30, 8);

    expect(highConcurrency).toBeLessThanOrEqual(lowConcurrency);
  });
});
