import type {SegmentExporterOptions} from "./segment-exporter";

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
  /** Total runtime spent rendering/encoding this segment in ms. */
  totalTimeMs?: number;
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

/**
 * Bootstrapping payload passed to a render worker.
 *
 * The worker imports the project module dynamically from `projectModuleUrl`.
 */
export interface BatchWorkerBootstrap {
  /** Protocol revision to detect incompatible worker/client payloads. */
  protocolVersion?: number;
  projectModuleUrl: string;
  projectMetaData?: unknown;
  settingsMetaData?: unknown;
  /** Segment exporter settings used by worker-rendered jobs. */
  segmentExporterOptions?: SegmentExporterOptions;
  /** Optional URL used by worker shims for location-dependent APIs. */
  locationHref?: string;
  /** Worker compatibility shims toggles. */
  shimOptions?: WorkerShimOptions;
}

export interface WorkerShimOptions {
  enableDocumentShim?: boolean;
  enableWindowShim?: boolean;
  enableImageShim?: boolean;
  enableAnimationFrameShim?: boolean;
  enableGetComputedStyleShim?: boolean;
}

export interface RenderWorkerInitRequest {
  type: "init";
  requestId: string;
  payload: BatchWorkerBootstrap;
}

export interface RenderWorkerSegmentRequest {
  type: "render-segment";
  requestId: string;
  payload: {
    job: BatchRenderJob;
  };
}

export interface RenderWorkerDisposeRequest {
  type: "dispose";
  requestId: string;
}

export type RenderWorkerRequest =
  | RenderWorkerInitRequest
  | RenderWorkerSegmentRequest
  | RenderWorkerDisposeRequest;

export interface RenderWorkerReadyResponse {
  type: "ready";
  requestId: string;
}

export interface RenderWorkerSegmentResponse {
  type: "segment-result";
  requestId: string;
  payload: BatchRenderSegmentResult;
}

export interface RenderWorkerErrorResponse {
  type: "error";
  requestId: string;
  error: string;
}

export type RenderWorkerResponse =
  | RenderWorkerReadyResponse
  | RenderWorkerSegmentResponse
  | RenderWorkerErrorResponse;
