/**
 * Batch rendering orchestrator for Motion Canvas.
 *
 * Splits a full animation into automatically planned frame segments, renders
 * them in
 * parallel using isolated {@link Renderer} instances, then stitches the
 * segments into a single final MP4.
 */
import {
  bootstrap,
  Logger,
  MetaFile,
  PlaybackManager,
  PlaybackStatus,
  Renderer,
  SharedWebGLContext,
  Vector2,
} from "@motion-canvas/core";
import {ReadOnlyTimeEvents} from "@motion-canvas/core/lib/scenes/timeEvents";
import type {ProjectSettings, Plugin} from "@motion-canvas/core";
import type {Project, RendererSettings} from "@motion-canvas/core/lib/app";
import {
  Output,
  Mp4OutputFormat,
  BufferTarget,
  AudioBufferSource,
  BufferSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
} from "mediabunny";
import * as mb from "mediabunny";
import type {
  BatchRenderJob,
  BatchRenderResult,
  BatchRenderSegmentResult,
  BatchWorkerBootstrap,
} from "./batch-types";
import {SegmentExporter, type SegmentExporterOptions} from "./segment-exporter";
import {splitIntoSegments, validateAndOrderSegments} from "./segment-utils";
import {RenderWorkerClient} from "./worker-runner";

// ---------------------------------------------------------------------------
// Public options
// ---------------------------------------------------------------------------

export interface BatchRendererOptions {
  /**
  * Deprecated. Segment sizing is now automatic and this option is ignored.
  *
  * Kept for compatibility with older serialized settings.
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

export interface BatchRenderRuntimeOptions {
  videoCodec: mb.VideoCodec;
  videoQuality: number | null;
  videoBitrate: number;
  audioCodec: mb.AudioCodec;
  audioQuality: number | null;
  audioBitrate: number;
  includeAudio: boolean;
  audioVolume: number;
  worker?: {
    enabled: boolean;
    bootstrap: BatchWorkerBootstrap;
  };
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Calculate a segment size that balances throughput and overhead.
 *
 * This planner aims to keep roughly 2x queue depth for the requested
 * concurrency (with a minimum of 4 segments for longer renders), while
 * avoiding very tiny segments.
 *
 * @param totalFrames Total number of frames to render
 * @param fps Frames per second (for duration calculation)
 * @param maxConcurrency Requested parallelism budget
 * @returns Suggested segment size in frames
 */
export function calculateOptimalSegmentSize(
  totalFrames: number,
  fps: number = 30,
  maxConcurrency: number = 4,
): number {
  const safeTotalFrames = Math.max(1, Math.floor(totalFrames));
  const safeFps = Math.max(1, Math.floor(fps));
  const safeConcurrency = Math.max(1, Math.floor(maxConcurrency));

  const minSegmentSize = Math.max(10, safeFps);
  const maxSegmentSize = Math.max(minSegmentSize, safeFps * 10);
  const targetSegmentCount = Math.max(safeConcurrency * 2, 4);

  let segmentSize = Math.ceil(safeTotalFrames / targetSegmentCount);
  segmentSize = Math.max(minSegmentSize, Math.min(segmentSize, maxSegmentSize));
  segmentSize = Math.min(segmentSize, safeTotalFrames);

  // Keep segment boundaries human-readable for logs/debugging.
  if (segmentSize >= 20) {
    segmentSize = Math.max(minSegmentSize, Math.round(segmentSize / 10) * 10);
  }

  return Math.max(10, segmentSize);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

async function runWorkerClientPool(
  jobs: BatchRenderJob[],
  concurrency: number,
  bootstrap: BatchWorkerBootstrap,
  onDone?: (result: BatchRenderSegmentResult, remaining: number) => void,
): Promise<BatchRenderSegmentResult[]> {
  if (typeof Worker === "undefined") {
    throw new Error(
      "BatchRenderer: worker mode requested but Worker API is unavailable in this environment.",
    );
  }

  const workerCount = Math.min(Math.max(1, concurrency), jobs.length);
  const clients = Array.from(
    {length: workerCount},
    () => new RenderWorkerClient(),
  );

  await Promise.all(clients.map(client => client.init(bootstrap)));

  const results: BatchRenderSegmentResult[] = new Array(jobs.length);
  let cursor = 0;
  let completed = 0;

  try {
    await Promise.all(
      clients.map(async client => {
        while (cursor < jobs.length) {
          const nextIndex = cursor++;
          const result = await client.renderSegment(jobs[nextIndex]!);
          results[nextIndex] = result;
          completed++;
          onDone?.(result, jobs.length - completed);
        }
      }),
    );

    return results;
  } finally {
    await Promise.allSettled(clients.map(client => client.dispose()));
  }
}

function createDetachedMetaFiles(
  name: string,
  projectMetaData: unknown,
  settingsMetaData: unknown,
) {
  const metaFile = new MetaFile<any>(`${name}-project-meta`, false);
  const settingsFile = new MetaFile<any>(`${name}-settings-meta`, false);

  metaFile.loadData(projectMetaData as any);
  settingsFile.loadData(settingsMetaData as any);

  return {metaFile, settingsFile};
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
  plugins: Plugin[],
  exporterOptions: SegmentExporterOptions,
  projectMetaData: unknown,
  settingsMetaData: unknown,
): Promise<BatchRenderSegmentResult> {
  const [startFrame, endFrame] = job.frameRange;
  const startSec = startFrame / job.fps;
  const endSec = endFrame / job.fps;

  const {metaFile, settingsFile} = createDetachedMetaFiles(
    `batch-segment-${job.jobIndex}`,
    projectMetaData,
    settingsMetaData,
  );

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

interface PlaybackInfo {
  fromFrame: number;
  toFrame: number;
  sounds: SoundLike[];
  audioOffset: number;
}

/**
 * Performs a full recalculate pass on the project to collect all programmatic
 * sounds across all scenes.  Used by the stitcher for centralized audio mixing.
 */
async function resolvePlaybackInfo(
  projectConfig: ProjectSettings,
  plugins: Plugin[],
  fps: number,
  range: [number, number],
  projectMetaData: unknown,
  settingsMetaData: unknown,
  logger: Logger,
): Promise<PlaybackInfo> {
  const {metaFile, settingsFile} = createDetachedMetaFiles(
    "batch-playback",
    projectMetaData,
    settingsMetaData,
  );

  const project = bootstrap(
    projectConfig.name ?? "project",
    {core: "0.0.0", two: null, ui: null, vitePlugin: null},
    plugins,
    projectConfig,
    metaFile,
    settingsFile,
    logger,
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

  try {
    playback.setup(scenes);
    playback.fps = fps;
    await playback.recalculate();

    const fromFrame = Math.min(
      playback.duration,
      Math.max(0, status.secondsToFrames(range[0])),
    );
    const requestedTo = Math.min(
      playback.duration,
      Math.max(0, status.secondsToFrames(range[1])),
    );
    const toFrame = Math.max(fromFrame, requestedTo);

    const sounds: SoundLike[] = [];
    let warnedAboutMissingSounds = false;

    for (const scene of playback.onScenesRecalculated.current) {
      const sceneSounds = (scene as any).sounds;

      if (!sceneSounds || typeof sceneSounds.getSounds !== "function") {
        if (!warnedAboutMissingSounds) {
          warnedAboutMissingSounds = true;
          logger.warn(
            "Batch audio fallback: scene sounds are unavailable on this Motion Canvas version. Continuing with project audio only.",
          );
        }
        continue;
      }

      try {
        const extracted = sceneSounds.getSounds();
        if (Array.isArray(extracted)) {
          sounds.push(...(extracted as SoundLike[]));
        }
      } catch (e: any) {
        logger.warn({
          message: "Batch audio fallback: failed to collect programmatic scene sounds.",
          object: e,
          stack: e?.stack,
        });
      }
    }

    return {
      fromFrame,
      toFrame,
      sounds,
      audioOffset: project.meta.shared.audioOffset.get() ?? 0,
    };
  } finally {
    sharedGL.dispose();
  }
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

interface SegmentVideoPackets {
  readonly jobIndex: number;
  readonly frameRange: [number, number];
  readonly codec: mb.VideoCodec;
  readonly decoderConfig: VideoDecoderConfig;
  readonly packets: mb.EncodedPacket[];
  readonly firstTimestamp: number;
  readonly timelineOffsetSeconds: number;
}

async function readSegmentVideoPackets(
  segment: BatchRenderSegmentResult,
  renderStartFrame: number,
  fps: number,
): Promise<SegmentVideoPackets> {
  if (!segment.buffer || segment.buffer.byteLength === 0) {
    throw new Error(`Stitcher: segment ${segment.jobIndex} is empty.`);
  }

  const input = new Input({
    formats: [mb.MP4],
    source: new BufferSource(segment.buffer),
  });

  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) {
      throw new Error(`Stitcher: segment ${segment.jobIndex} has no video track.`);
    }

    const codec = videoTrack.codec;
    if (!codec) {
      throw new Error(`Stitcher: segment ${segment.jobIndex} video codec is unknown.`);
    }

    const decoderConfig = await videoTrack.getDecoderConfig();
    if (!decoderConfig) {
      throw new Error(
        `Stitcher: segment ${segment.jobIndex} is missing decoder config metadata.`,
      );
    }

    const packetSink = new EncodedPacketSink(videoTrack);
    const packets: mb.EncodedPacket[] = [];

    for await (const packet of packetSink.packets()) {
      packets.push(packet);
    }

    if (packets.length === 0) {
      throw new Error(`Stitcher: segment ${segment.jobIndex} has no encoded packets.`);
    }

    const timelineOffsetFrames = segment.frameRange[0] - renderStartFrame;
    if (timelineOffsetFrames < 0) {
      throw new Error(
        `Stitcher: segment ${segment.jobIndex} starts before render range start.`,
      );
    }

    return {
      jobIndex: segment.jobIndex,
      frameRange: segment.frameRange,
      codec,
      decoderConfig,
      packets,
      firstTimestamp: packets[0]!.timestamp,
      timelineOffsetSeconds: timelineOffsetFrames / fps,
    };
  } finally {
    input.dispose();
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
  renderStartSec: number,
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

    const soundOffset = sound.offset - renderStartSec;
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
 * Uses packet-level video remux to avoid decode/re-encode overhead.
 * Audio is mixed centrally for the full timeline.
 */
async function stitchSegments(
  segments: BatchRenderSegmentResult[],
  totalFrames: number,
  fps: number,
  renderStartFrame: number,
  exporterOptions: SegmentExporterOptions,
  projectAudio: string | undefined,
  projectAudioOffset: number,
  sounds: SoundLike[],
  logger: Logger,
): Promise<Blob> {
  logger.info({
    message: "Batch: segment validation starting",
    object: {segmentCount: segments.length, expectedFrames: totalFrames},
  });

  const ordered = validateAndOrderSegments(segments, {
    expectedTotalFrames: totalFrames,
    expectedStartFrame: renderStartFrame,
  });

  const actualFrames = ordered.reduce((sum, s) => sum + s.durationFrames, 0);
  logger.info({
    message: "Batch: segment validation passed",
    object: {
      segmentCount: ordered.length,
      expectedFrames: totalFrames,
      actualFrames,
      coverage: actualFrames === totalFrames ? "complete" : "warning",
    },
  });

  logger.info({
    message: "Batch: preparing packet-level video remux",
    object: {segmentCount: ordered.length},
  });

  const remuxBundles: SegmentVideoPackets[] = [];
  let referenceCodec: mb.VideoCodec | null = null;
  let referenceDecoderCodec: string | null = null;

  for (const segment of ordered) {
    const bundle = await readSegmentVideoPackets(segment, renderStartFrame, fps);

    if (referenceCodec === null) {
      referenceCodec = bundle.codec;
      referenceDecoderCodec = bundle.decoderConfig.codec;
    } else {
      if (bundle.codec !== referenceCodec) {
        throw new Error(
          `Stitcher: segment ${bundle.jobIndex} codec mismatch. Expected ${referenceCodec}, got ${bundle.codec}.`,
        );
      }

      if (bundle.decoderConfig.codec !== referenceDecoderCodec) {
        throw new Error(
          `Stitcher: segment ${bundle.jobIndex} decoder config mismatch.`,
        );
      }
    }

    remuxBundles.push(bundle);
  }

  if (!referenceCodec || remuxBundles.length === 0) {
    throw new Error("Stitcher: no remuxable video segments were produced.");
  }

  const videoSource = new EncodedVideoPacketSource(referenceCodec);

  const output = new Output({
    format: new Mp4OutputFormat({fastStart: "in-memory"}),
    target: new BufferTarget(),
  });
  output.addVideoTrack(videoSource, {frameRate: fps});

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

  let packetCount = 0;
  let sequenceNumber = 0;
  let firstPacket = true;

  for (const bundle of remuxBundles) {
    for (const packet of bundle.packets) {
      const rebasedPacket = packet.clone({
        timestamp:
          packet.timestamp - bundle.firstTimestamp + bundle.timelineOffsetSeconds,
        sequenceNumber,
      });

      sequenceNumber += 1;
      packetCount += 1;

      if (firstPacket) {
        await videoSource.add(rebasedPacket, {
          decoderConfig: bundle.decoderConfig,
        });
        firstPacket = false;
      } else {
        await videoSource.add(rebasedPacket);
      }
    }
  }

  if (audioSrc) {
    logger.info({
      message: "Batch: starting audio mixing",
      object: {
        hasSounds: sounds.length > 0,
        soundCount: sounds.length,
        hasProjectAudio,
        totalDuration: (totalFrames / fps).toFixed(2),
      },
    });

    await mixFullAudio(
      audioSrc,
      sounds,
      projectAudio,
      projectAudioOffset,
      exporterOptions.includeAudio,
      totalFrames / fps,
      renderStartFrame / fps,
      exporterOptions.audioVolume / 100,
    );

    logger.info({
      message: "Batch: audio mixing complete",
      object: {
        framesRendered: totalFrames,
        durationSeconds: (totalFrames / fps).toFixed(2),
      },
    });
  }

  await output.finalize();

  if (!output.target.buffer) {
    throw new Error("Stitcher: output buffer is empty after finalization.");
  }

  const finalBlob = new Blob([output.target.buffer], {type: "video/mp4"});
  logger.info({
    message: "Batch: stitching complete",
    object: {
      outputBytes: finalBlob.size,
      durationFrames: totalFrames,
      fps,
      packetCount,
      estimatedDuration: (totalFrames / fps).toFixed(2),
    },
  });

  return finalBlob;
}

// ---------------------------------------------------------------------------
// Main Orchestrator
// ---------------------------------------------------------------------------

/**
 * High-level parallel batch rendering orchestrator.
 *
 * @example
 * ```ts
 * const batchRenderer = new BatchRenderer({maxConcurrency: 4});
 * const {blob} = await batchRenderer.render(
 *   project,
 *   rendererSettings,
 *   {
 *     videoCodec: "avc",
 *     videoQuality: 2,
 *     videoBitrate: 0,
 *     audioCodec: "opus",
 *     audioQuality: 2,
 *     audioBitrate: 0,
 *     includeAudio: true,
 *     audioVolume: 100,
 *   },
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
  private readonly legacySegmentSize?: number;
  private readonly maxConcurrency: number;
  private readonly onSegmentComplete?: BatchRendererOptions["onSegmentComplete"];

  public constructor(options: BatchRendererOptions = {}) {
    this.legacySegmentSize = options.segmentSize;
    this.maxConcurrency =
      options.maxConcurrency ??
      Math.min(
        typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? 4) : 4,
        4,
      );
    this.onSegmentComplete = options.onSegmentComplete;
  }

  /**
   * Render the current project as parallel segments and stitch into one video.
   */
  public async render(
    project: Project,
    settings: RendererSettings,
    options: BatchRenderRuntimeOptions,
  ): Promise<BatchRenderResult> {
    const projectConfig: ProjectSettings = {
      name: project.name,
      scenes: project.scenes,
      plugins: project.plugins,
      logger: project.logger,
      audio: project.audio,
      variables: project.variables,
      experimentalFeatures: project.experimentalFeatures,
    };

    const projectMetaData = project.meta.get();
    const settingsMetaData = project.settings.get();
    const playbackInfo = await resolvePlaybackInfo(
      projectConfig,
      project.plugins,
      settings.fps,
      settings.range,
      projectMetaData,
      settingsMetaData,
      project.logger,
    );

    const totalFrames = playbackInfo.toFrame - playbackInfo.fromFrame;
    if (totalFrames <= 0) {
      throw new Error("BatchRenderer: requested range produced no frames.");
    }

    if (this.legacySegmentSize !== undefined) {
      project.logger.warn({
        message: "Batch: segmentSize option is deprecated and ignored. Automatic segmentation is used.",
        object: {
          legacySegmentSize: this.legacySegmentSize,
        },
      });
    }

    const segmentSize = calculateOptimalSegmentSize(
      totalFrames,
      settings.fps,
      this.maxConcurrency,
    );

    const segmentRanges = splitIntoSegments(totalFrames, segmentSize);
    const segmentCount = segmentRanges.length;
    const effectiveConcurrency = Math.min(this.maxConcurrency, segmentCount);
    const renderPlan = {
      totalFrames,
      segmentSize,
      segmentCount,
      requestedConcurrency: this.maxConcurrency,
      effectiveConcurrency,
      executionMode: options.worker?.enabled ? "worker" : "main-thread",
      totalDuration: Number((totalFrames / settings.fps).toFixed(2)),
    };

    project.logger.info({
      message: "Batch render plan",
      object: renderPlan,
    });

    const resolution = {
      width: settings.size.width,
      height: settings.size.height,
    };
    const segmentRangesAbsolute = segmentRanges.map(([start, end]) => [
      start + playbackInfo.fromFrame,
      end + playbackInfo.fromFrame,
    ] as [number, number]);

    // Disable per-segment audio; audio is assembled centrally during stitch.
    const segmentExporterOptions: SegmentExporterOptions = {
      videoCodec: options.videoCodec,
      videoQuality: options.videoQuality,
      videoBitrate: options.videoBitrate,
      audioCodec: options.audioCodec,
      audioQuality: options.audioQuality,
      audioBitrate: options.audioBitrate,
      includeAudio: false, // centralized audio during stitch
      audioVolume: options.audioVolume,
      renderOnAbort: false,
    };

    const batchJobs: BatchRenderJob[] = segmentRangesAbsolute.map(([start, end], i) => ({
      fps: settings.fps,
      resolution,
      resolutionScale: settings.resolutionScale,
      videoCodec: options.videoCodec,
      videoQuality: options.videoQuality,
      videoBitrate: options.videoBitrate,
      audioCodec: options.audioCodec,
      audioQuality: options.audioQuality,
      audioBitrate: options.audioBitrate,
      includeAudio: options.includeAudio,
      audioVolume: options.audioVolume,
      jobIndex: i,
      frameRange: [start, end] as [number, number],
    }));

    const segmentResults = options.worker?.enabled
      ? await runWorkerClientPool(
        batchJobs,
        effectiveConcurrency,
        options.worker.bootstrap,
        (result, remaining) => this.onSegmentComplete?.(result, remaining),
      )
      : await runPool(
        batchJobs.map(j => () =>
          renderSegment(
            j,
            projectConfig,
            project.plugins,
            segmentExporterOptions,
            projectMetaData,
            settingsMetaData,
          ),
        ),
        effectiveConcurrency,
        (result, remaining) => this.onSegmentComplete?.(result, remaining),
      );

    const finalExporterOptions: SegmentExporterOptions = {
      ...segmentExporterOptions,
      includeAudio: options.includeAudio,
    };

    const blob = await stitchSegments(
      segmentResults,
      totalFrames,
      settings.fps,
      playbackInfo.fromFrame,
      finalExporterOptions,
      projectConfig.audio,
      playbackInfo.audioOffset,
      playbackInfo.sounds,
      project.logger,
    );

    return {blob, totalFrames, fps: settings.fps};
  }
}
