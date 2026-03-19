import type {BatchRenderSegmentResult} from "./batch-types";

export interface SegmentValidationOptions {
  expectedTotalFrames: number;
  expectedStartFrame: number;
}

/**
 * Splits a total frame count into fixed-size segments.
 * Returns pairs [startFrame, endFrame) where endFrame is exclusive.
 */
export function splitIntoSegments(
  totalFrames: number,
  segmentSize: number,
): Array<[number, number]> {
  if (segmentSize <= 0) throw new Error("segmentSize must be > 0");

  const segments: Array<[number, number]> = [];
  for (let start = 0; start < totalFrames; start += segmentSize) {
    segments.push([start, Math.min(start + segmentSize, totalFrames)]);
  }

  return segments;
}

export function validateAndOrderSegments(
  segments: BatchRenderSegmentResult[],
  options: SegmentValidationOptions,
): BatchRenderSegmentResult[] {
  if (segments.length === 0) {
    throw new Error("BatchRenderer: no segments were produced.");
  }

  const ordered = [...segments].sort((a, b) => a.jobIndex - b.jobIndex);
  const seen = new Set<number>();

  let expectedFrame = options.expectedStartFrame;

  for (let i = 0; i < ordered.length; i++) {
    const segment = ordered[i]!;

    if (seen.has(segment.jobIndex)) {
      throw new Error(
        `BatchRenderer: duplicate segment job index ${segment.jobIndex}.`,
      );
    }
    seen.add(segment.jobIndex);

    if (segment.jobIndex !== i) {
      throw new Error(
        `BatchRenderer: missing or out-of-order segment index at position ${i}. Expected ${i}, got ${segment.jobIndex}.`,
      );
    }

    if (segment.error) {
      throw new Error(
        `BatchRenderer: segment ${segment.jobIndex} failed: ${segment.error}`,
      );
    }

    const [start, end] = segment.frameRange;
    if (start !== expectedFrame) {
      throw new Error(
        `BatchRenderer: non-contiguous segment ranges. Expected start frame ${expectedFrame}, got ${start} for segment ${segment.jobIndex}.`,
      );
    }

    if (end < start) {
      throw new Error(
        `BatchRenderer: invalid frame range [${start}, ${end}) for segment ${segment.jobIndex}.`,
      );
    }

    const expectedDuration = end - start;
    if (segment.durationFrames !== expectedDuration) {
      throw new Error(
        `BatchRenderer: duration mismatch in segment ${segment.jobIndex}. Expected ${expectedDuration} frames, got ${segment.durationFrames}.`,
      );
    }

    expectedFrame = end;
  }

  if (expectedFrame !== options.expectedStartFrame + options.expectedTotalFrames) {
    throw new Error(
      `BatchRenderer: stitched segment frame coverage mismatch. Expected ${options.expectedTotalFrames} frames, got ${expectedFrame - options.expectedStartFrame}.`,
    );
  }

  return ordered;
}
