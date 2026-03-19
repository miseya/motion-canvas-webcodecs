/**
 * Batch rendering orchestrator for Motion Canvas.
 *
 * Splits a full animation into fixed-size frame segments, renders them in
 * parallel using isolated {@link Renderer} instances, then stitches the
 * segments into a single final MP4.
 */
import {
  bootstrap,
  Logger,
  PlaybackManager,
  PlaybackStatus,
  Renderer,
  SharedWebGLContext,
} from "@motion-canvas/core";
import type {Scene} from "@motion-canvas/core";
import {ReadOnlyTimeEvents} from "@motion-canvas/core/lib/scenes/timeEvents";
import {Vector2} from "@motion-canvas/core";
import type {ProjectSettings, MetaFile, Plugin} from "@motion-canvas/core";
import {
  Output,
  Mp4OutputFormat,
  BufferTarget,
  AudioBufferSource,
  CanvasSource,
} from "mediabunny";
import * as mb from "mediabunny";
import type {BatchRenderJob, BatchRenderResult, BatchRenderSegmentResult} from "./batch-types";
import {SegmentExporter, type SegmentExporterOptions} from "./segment-exporter";

// ---------------------------------------------------------------------------
// Public options
// ---------------------------------------------------------------------------

export interface BatchRendererOptions {
  /**
   * Number of frames to render per segment.
   * @default 150
   */
  segmentSize?: number;
  /**
   * Maximum number of segment renderers to run in parallel.
   * Defaults to `min(navigator.hardwareConcurrency, 4)`.
   */
  maxConcurrency?: number;
  /** Called after each segment completes (for progress reporting). */
  onSegmentComplete?: (result: BatchRenderSegmentResult, remaining: number) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Splits a total frame count into fixed-size segments.
 * Returns pairs [startFrame, endFrame) where endFrame is exclusive.
 */
export function splitIntoSegments(
  totalFrames: number,
  segmentSize: number,
): Array<[number, number]> {
  if (segmentSize <= 0) throw new Error("segmentSize must be > 0");
  const segs: Array<[number, number]> = [];
  for (let start = 0; start < totalFrames; start += segmentSize) {
    segs.push([start, Math.min(start + segmentSize, totalFrames)]);
  }
  return segs;
}

/** Run an array of async tasks with bounded parallelism. */
async function runPool<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
  onDone?: (result: T, remaining: number) => void,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let index = 0;
  let completed = 0;

  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]!();
      completed++;
      onDone?.(results[i]!, tasks.length - completed);
    }
  }

  await Promise.all(
    Array.from({length: Math.min(concurrency, tasks.length)}, worker),
  );
  return results;
}

// ---------------------------------------------------------------------------
// Single-segment render
// ---------------------------------------------------------------------------

/**
 * Bootstrap an isolated project instance and render the given frame range via
 * a {@link SegmentExporter}.  No state is shared with other segments.
 */
async function renderSegment(
  job: BatchRenderJob,
  projectConfig: ProjectSettings,
  metaFile: MetaFile<any>,
  settingsFile: MetaFile<any>,
  plugins: Plugin[],
  exporterOptions: SegmentExporterOptions,
): Promise<BatchRenderSegmentResult> {
  const [startFrame, endFrame] = job.frameRange;
  const startSec = startFrame / job.fps;
  const endSec = endFrame / job.fps;

  const logger = new Logger();
  const project = bootstrap(
    projectConfig.name ?? "project",
    {core: "0.0.0", two: null, ui: null, vitePlugin: null},
    plugins,
    projectConfig,
    metaFile,
    settingsFile,
    logger,
  );

  const rendererSettings = {
    name: project.name,
    range: [startSec, endSec] as [number, number],
    fps: job.fps,
    size: new Vector2(job.resolution.width, job.resolution.height),
    resolutionScale: job.resolutionScale,
    colorSpace: "srgb" as const,
    background: null,
    exporter: {name: "batch-segment", options: exporterOptions},
  };

  const segmentExporter = new SegmentExporter(project, rendererSettings, exporterOptions);

  // Inject the exporter shim so Renderer.run() can resolve it by name.
  const exporterShim = {
    id: "batch-segment" as const,
    displayName: "Batch Segment",
    meta: () => { throw new Error("unreachable"); },
    create: async () => segmentExporter,
  };
  (project.meta.rendering.exporter as any).exporters ??= [];
  (project.meta.rendering.exporter as any).exporters.push(exporterShim);

  const renderer = new Renderer(project);

  let error: string | undefined;
  try {
    await renderer.render(rendererSettings);
  } catch (e: any) {
    error = e?.message ?? String(e);
  }

  const buffer = segmentExporter.resultBuffer;

  return {
    jobIndex: job.jobIndex,
    frameRange: job.frameRange,
    buffer: buffer ?? new ArrayBuffer(0),
    durationFrames: endFrame - startFrame,
    error: error ?? (!buffer ? "Segment produced no output" : undefined),
  };
}

// ---------------------------------------------------------------------------
// Centralized sound collection
// ---------------------------------------------------------------------------

type SoundLike = {
  audio: string;
  offset: number;
  realPlaybackRate: number;
  start?: number;
  end?: number;
  gain?: number;
  detune?: number;
  playbackRate?: number;
};

/**
 * Performs a full recalculate pass on the project to collect all programmatic
 * sounds across all scenes.  Used by the stitcher for centralized audio mixing.
 */
async function collectAllSounds(
  projectConfig: ProjectSettings,
  metaFile: MetaFile<any>,
  settingsFile: MetaFile<any>,
  plugins: Plugin[],
  fps: number,
): Promise<SoundLike[]> {
  const project = bootstrap(
    projectConfig.name ?? "project",
    {core: "0.0.0", two: null, ui: null, vitePlugin: null},
    plugins,
    projectConfig,
    metaFile,
    settingsFile,
  );

  const playback = new PlaybackManager();
  const status = new PlaybackStatus(playback);
  const sharedGL = new SharedWebGLContext(project.logger);
  const size = new Vector2(1920, 1080);

  const scenes = project.scenes.map(desc =>
    new desc.klass({
      ...desc,
      meta: desc.meta.clone(),
      logger: project.logger,
      playback: status,
      size,
      resolutionScale: 1,
      timeEventsClass: ReadOnlyTimeEvents,
      sharedWebGLContext: sharedGL,
      experimentalFeatures: project.experimentalFeatures,
    }),
  );

  playback.setup(scenes);
  playback.fps = fps;
  await playback.recalculate();

  const sounds: SoundLike[] = [];
  for (const scene of playback.onScenesRecalculated.current) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sounds.push(...(scene as any).sounds.getSounds());
  }

  sharedGL.dispose();
  return sounds;
}

// ---------------------------------------------------------------------------
// Stitcher
// ---------------------------------------------------------------------------

function qualityOrBitrate(quality: number | null, bitrate: number): mb.Quality | number {
  const table = [
    mb.QUALITY_VERY_LOW,
    mb.QUALITY_LOW,
    mb.QUALITY_MEDIUM,
    mb.QUALITY_HIGH,
    mb.QUALITY_VERY_HIGH,
  ];
  return quality !== null ? table[quality]! : bitrate;
}

/**
 * Decode an MP4 segment using an off-screen video element and feed each frame
 * into the shared canvas source for re-encoding.
 *
 * This is a frame-accurate but simple approach. A future phase can replace
 * this with container-level fMP4 concat if codec + container constraints allow.
 */
async function decodeSegmentIntoCanvas(
  buffer: ArrayBuffer,
  ctx: CanvasRenderingContext2D,
  canvasSource: CanvasSource,
  fps: number,
  startAbsoluteFrame: number,
): Promise<void> {
  const blob = new Blob([buffer], {type: "video/mp4"});
  const url = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.src = url;
  video.muted = true;
  video.preload = "auto";

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("Failed to load segment for stitching"));
    });

    const frameCount = Math.round(video.duration * fps);
    const frameDuration = 1 / fps;

    for (let i = 0; i < frameCount; i++) {
      await new Promise<void>(resolve => {
        const onSeeked = () => {
          video.removeEventListener("seeked", onSeeked);
          resolve();
        };
        video.addEventListener("seeked", onSeeked);
        video.currentTime = i * frameDuration;
      });

      const absoluteFrame = startAbsoluteFrame + i;
      const timestampSecs = absoluteFrame * frameDuration;

      ctx.drawImage(video, 0, 0, ctx.canvas.width, ctx.canvas.height);
      await canvasSource.add(timestampSecs, frameDuration);
    }
  } finally {
    URL.revokeObjectURL(url);
    video.remove();
  }
}

/**
 * Mix and add audio for the full project timeline into an AudioBufferSource.
 */
async function mixFullAudio(
  audioSrc: AudioBufferSource,
  sounds: SoundLike[],
  projectAudio: string | undefined,
  projectAudioOffset: number,
  includeProjectAudio: boolean,
  totalDuration: number,
  globalVolume: number,
): Promise<void> {
  const allSounds = [...sounds];

  if (projectAudio && includeProjectAudio) {
    allSounds.push({
      audio: projectAudio,
      offset: projectAudioOffset,
      realPlaybackRate: 1,
    });
  }

  if (allSounds.length === 0) return;

  const sampleRate = 48_000;
  const frameCount = Math.ceil(totalDuration * sampleRate);
  const offlineCtx = new OfflineAudioContext(2, frameCount, sampleRate);
  const audioBuffers = new Map<string, AudioBuffer>();

  for (const sound of allSounds) {
    if (!audioBuffers.has(sound.audio)) {
      try {
        const res = await fetch(sound.audio);
        const ab = await res.arrayBuffer();
        audioBuffers.set(sound.audio, await offlineCtx.decodeAudioData(ab));
      } catch (_) {
        // skip unloadable assets
      }
    }

    const buf = audioBuffers.get(sound.audio);
    if (!buf) continue;

    const src = offlineCtx.createBufferSource();
    src.buffer = buf;
    const rate = sound.realPlaybackRate ??
      Math.pow(2, (sound.detune ?? 0) / 1200) * (sound.playbackRate ?? 1);
    src.playbackRate.value = rate;

    const gain = offlineCtx.createGain();
    gain.gain.value = Math.pow(10, (sound.gain ?? 0) / 20) * globalVolume;
    src.connect(gain);
    gain.connect(offlineCtx.destination);

    const soundOffset = sound.offset;
    const trimStart = sound.start ?? 0;
    const trimEnd = sound.end;
    const trimDuration = trimEnd !== undefined
      ? (trimEnd - trimStart) / rate
      : undefined;

    if (soundOffset >= 0) {
      src.start(soundOffset, trimStart, trimDuration);
    } else {
      const skip = -soundOffset * rate;
      const newStart = trimStart + skip;
      const newDur = trimDuration !== undefined
        ? Math.max(0, trimDuration - skip / rate)
        : undefined;
      if (newDur === undefined || newDur > 0) {
        src.start(0, newStart, newDur);
      }
    }
  }

  const mixed = await offlineCtx.startRendering();
  await audioSrc.add(mixed);
}

/**
 * Stitch all segment buffers into a single final MP4.
 * Uses per-segment video decoding + re-encode into a shared Output.
 * Audio is mixed centrally for the full timeline.
 */
async function stitchSegments(
  segments: BatchRenderSegmentResult[],
  totalFrames: number,
  fps: number,
  resolution: {width: number; height: number},
  resolutionScale: number,
  exporterOptions: SegmentExporterOptions,
  projectAudio: string | undefined,
  projectAudioOffset: number,
  sounds: SoundLike[],
): Promise<Blob> {
  const ordered = [...segments].sort((a, b) => a.jobIndex - b.jobIndex);
  const realWidth = resolution.width * resolutionScale;
  const realHeight = resolution.height * resolutionScale;

  const canvas = document.createElement("canvas");
  canvas.width = realWidth;
  canvas.height = realHeight;
  const ctx = canvas.getContext("2d")!;

  const videoBitrate = qualityOrBitrate(exporterOptions.videoQuality, exporterOptions.videoBitrate);
  const canvasSource = new CanvasSource(canvas, {
    codec: exporterOptions.videoCodec as mb.VideoCodec,
    bitrate: videoBitrate,
  });

  const output = new Output({
    format: new Mp4OutputFormat({fastStart: "in-memory"}),
    target: new BufferTarget(),
  });
  output.addVideoTrack(canvasSource, {frameRate: fps});

  const hasProjectAudio = !!projectAudio && exporterOptions.includeAudio;
  const hasSounds = sounds.length > 0;
  let audioSrc: AudioBufferSource | null = null;

  if (hasProjectAudio || hasSounds) {
    const audioBitrate = qualityOrBitrate(exporterOptions.audioQuality, exporterOptions.audioBitrate);
    audioSrc = new AudioBufferSource({
      codec: exporterOptions.audioCodec as mb.AudioCodec,
      bitrate: audioBitrate,
    });
    output.addAudioTrack(audioSrc);
  }

  await output.start();

  let absoluteFrame = 0;
  for (const segment of ordered) {
    if (!segment.buffer || segment.buffer.byteLength === 0) {
      absoluteFrame += segment.durationFrames;
      continue;
    }
    await decodeSegmentIntoCanvas(segment.buffer, ctx, canvasSource, fps, absoluteFrame);
    absoluteFrame += segment.durationFrames;
  }

  if (audioSrc) {
    await mixFullAudio(
      audioSrc,
      sounds,
      projectAudio,
      projectAudioOffset,
      exporterOptions.includeAudio,
      totalFrames / fps,
      exporterOptions.audioVolume / 100,
    );
  }

  await output.finalize();
  canvas.remove();

  if (!output.target.buffer) {
    throw new Error("Stitcher: output buffer is empty after finalization.");
  }

  return new Blob([output.target.buffer], {type: "video/mp4"});
}

// ---------------------------------------------------------------------------
// Main Orchestrator
// ---------------------------------------------------------------------------

/**
 * High-level parallel batch rendering orchestrator.
 *
 * @example
 * ```ts
 * const batchRenderer = new BatchRenderer({segmentSize: 120, maxConcurrency: 4});
 * const {blob} = await batchRenderer.render(
 *   projectConfig, metaFile, settingsFile, plugins, baseJob, totalFrames
 * );
 * // Trigger download:
 * const a = Object.assign(document.createElement('a'), {
 *   href: URL.createObjectURL(blob),
 *   download: 'my-animation.mp4',
 * });
 * a.click();
 * ```
 */
export class BatchRenderer {
  private readonly segmentSize: number;
  private readonly maxConcurrency: number;
  private readonly onSegmentComplete?: BatchRendererOptions["onSegmentComplete"];

  public constructor(options: BatchRendererOptions = {}) {
    this.segmentSize = options.segmentSize ?? 150;
    this.maxConcurrency =
      options.maxConcurrency ??
      Math.min(
        typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? 4) : 4,
        4,
      );
    this.onSegmentComplete = options.onSegmentComplete;
  }

  /**
   * Render the full animation as parallel segments and stitch into one video.
   *
   * @param projectConfig - Output of `makeProject()`.
   * @param metaFile      - The project `.meta` file.
   * @param settingsFile  - The settings meta file (from vite-plugin).
   * @param plugins       - Resolved plugins array.
   * @param job           - Base render settings (resolution, fps, codecs…).
   * @param totalFrames   - Total duration of the animation in frames.
   */
  public async render(
    projectConfig: ProjectSettings,
    metaFile: MetaFile<any>,
    settingsFile: MetaFile<any>,
    plugins: Plugin[],
    job: Omit<BatchRenderJob, "jobIndex" | "frameRange">,
    totalFrames: number,
  ): Promise<BatchRenderResult> {
    const segmentRanges = splitIntoSegments(totalFrames, this.segmentSize);

    // Disable per-segment audio; audio is assembled centrally during stitch.
    const segmentExporterOptions: SegmentExporterOptions = {
      videoCodec: job.videoCodec as mb.VideoCodec,
      videoQuality: job.videoQuality,
      videoBitrate: job.videoBitrate,
      audioCodec: job.audioCodec as mb.AudioCodec,
      audioQuality: job.audioQuality,
      audioBitrate: job.audioBitrate,
      includeAudio: false, // centralized audio during stitch
      audioVolume: job.audioVolume,
      renderOnAbort: false,
    };

    const batchJobs: BatchRenderJob[] = segmentRanges.map(([start, end], i) => ({
      ...job,
      jobIndex: i,
      frameRange: [start, end] as [number, number],
    }));

    const tasks = batchJobs.map(j => () =>
      renderSegment(j, projectConfig, metaFile, settingsFile, plugins, segmentExporterOptions),
    );

    const segmentResults = await runPool(
      tasks,
      this.maxConcurrency,
      (result, remaining) => this.onSegmentComplete?.(result, remaining),
    );

    // Collect programmatic sounds for centralized audio assembly.
    const sounds = await collectAllSounds(
      projectConfig,
      metaFile,
      settingsFile,
      plugins,
      job.fps,
    );

    // Get the project audio offset from a bootstrapped project.
    const tempProject = bootstrap(
      projectConfig.name ?? "project",
      {core: "0.0.0", two: null, ui: null, vitePlugin: null},
      plugins,
      projectConfig,
      metaFile,
      settingsFile,
    );
    const audioOffset = tempProject.meta.shared.audioOffset.get() ?? 0;

    const finalExporterOptions: SegmentExporterOptions = {
      ...segmentExporterOptions,
      includeAudio: job.includeAudio,
    };

    const blob = await stitchSegments(
      segmentResults,
      totalFrames,
      job.fps,
      job.resolution,
      job.resolutionScale,
      finalExporterOptions,
      projectConfig.audio,
      audioOffset,
      sounds,
    );

    return {blob, totalFrames, fps: job.fps};
  }
}
