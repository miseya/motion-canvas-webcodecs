/**
 * Input contract for a single batch render segment job.
 */
export interface BatchRenderJob {
  /** Index of this job in the overall batch (0-based). */
  jobIndex: number;
  /**
   * Absolute frame range [startFrame, endFrame] (inclusive on start,
   * exclusive on end) for this segment.
   */
  frameRange: [startFrame: number, endFrame: number];
  /** Frames per second for the render. */
  fps: number;
  /** Output resolution in pixels. */
  resolution: {width: number; height: number};
  /** Resolution scale multiplier (e.g. 1 = 100%). */
  resolutionScale: number;

  // --- Video encode settings ---
  videoCodec: string;
  /** Quality preset index (0–4) or null to use videoBitrate. */
  videoQuality: number | null;
  /** Video bitrate in bits/s (used when videoQuality is null). */
  videoBitrate: number;

  // --- Audio settings ---
  audioCodec: string;
  /** Quality preset index (0–4) or null to use audioBitrate. */
  audioQuality: number | null;
  /** Audio bitrate in bits/s (used when audioQuality is null). */
  audioBitrate: number;
  /** Whether to mix project audio and programmatic sounds into this segment. */
  includeAudio: boolean;
  /** Volume multiplier (0–200, defaults to 100). */
  audioVolume: number;
}

/**
 * Output produced by a single segment render job.
 */
export interface BatchRenderSegmentResult {
  /** Mirrors {@link BatchRenderJob.jobIndex}. */
  jobIndex: number;
  /** The frame range that was actually rendered. */
  frameRange: [number, number];
  /** Encoded MP4 segment. */
  buffer: ArrayBuffer;
  /** Number of frames rendered. */
  durationFrames: number;
  /** Set if the job failed. */
  error?: string;
}

/**
 * Final result returned by the batch orchestrator after all segments are done
 * and stitched together.
 */
export interface BatchRenderResult {
  /** The final stitched video blob. */
  blob: Blob;
  /** Total frames rendered across all segments. */
  totalFrames: number;
  fps: number;
}
