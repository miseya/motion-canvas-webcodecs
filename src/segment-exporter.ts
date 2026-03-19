import type {
  Exporter,
  Project,
  RendererResult,
  RendererSettings,
} from "@motion-canvas/core/lib/app";
import {
  Output,
  Mp4OutputFormat,
  BufferTarget,
  AudioBufferSource,
  CanvasSource,
} from "mediabunny";
import * as mb from "mediabunny";

/**
 * Taken from motion-canvas alpha for compatibility
 */
interface Sound {
  audio: string;
  start?: number;
  end?: number;
  gain?: number;
  detune?: number;
  playbackRate?: number;
  offset: number;
  realPlaybackRate: number;
}

export interface SegmentExporterOptions {
  videoCodec: mb.VideoCodec;
  videoQuality: number | null;
  videoBitrate: number;
  audioCodec: mb.AudioCodec;
  audioQuality: number | null;
  audioBitrate: number;
  /** Whether to mix audio into this segment. */
  includeAudio: boolean;
  /** Volume multiplier (0–200). */
  audioVolume: number;
  /** Set to true to finalize even when the render was aborted. */
  renderOnAbort: boolean;
}

/**
 * A headless exporter that captures a single render segment as an in-memory
 * MP4 ArrayBuffer instead of triggering a browser download.
 *
 * This is the per-segment counterpart of {@link WebCodecsExporter}. It is
 * designed to be instantiated once per batch job and is not registered as a
 * plugin exporter.
 */
export class SegmentExporter implements Exporter {
  /** The encoded MP4 segment. Set after {@link stop} completes successfully. */
  public resultBuffer: ArrayBuffer | null = null;

  private output: Output<Mp4OutputFormat, BufferTarget> | null = null;
  private canvasSource: CanvasSource | null = null;
  private audioSource: AudioBufferSource | null = null;
  private internalCanvas: HTMLCanvasElement | null = null;
  private internalCtx: CanvasRenderingContext2D | null = null;

  private abortSignal: AbortSignal | null = null;
  private sounds: Sound[] = [];
  private renderDuration = 0;

  /** Absolute frame at which this segment starts (used for timestamp offsetting). */
  private readonly startFrame: number;
  private frameEnd = 0;

  public constructor(
    private readonly project: Project,
    private readonly settings: RendererSettings,
    private readonly options: SegmentExporterOptions,
  ) {
    // settings.range is in seconds; convert to frames for timestamp calc
    this.startFrame = (settings.range[0] ?? 0) * settings.fps;
  }

  private qualityOrBitrate(
    quality: number | null,
    bitrate: number,
  ): mb.Quality | number {
    switch (quality) {
      case 0: return mb.QUALITY_VERY_LOW;
      case 1: return mb.QUALITY_LOW;
      case 2: return mb.QUALITY_MEDIUM;
      case 3: return mb.QUALITY_HIGH;
      case 4: return mb.QUALITY_VERY_HIGH;
    }
    return bitrate;
  }

  public async start(sounds: Sound[] = [], duration = 0): Promise<void> {
    this.sounds = sounds;
    this.renderDuration = duration;

    const resolution = this.settings.size.mul(this.settings.resolutionScale);

    this.internalCanvas = document.createElement("canvas");
    this.internalCanvas.width = resolution.width;
    this.internalCanvas.height = resolution.height;
    this.internalCtx = this.internalCanvas.getContext("2d")!;

    const videoBitrate = this.qualityOrBitrate(
      this.options.videoQuality,
      this.options.videoBitrate,
    );

    if (!(await mb.canEncodeVideo(this.options.videoCodec, {bitrate: videoBitrate as number}))) {
      throw new Error(
        `SegmentExporter: video codec "${this.options.videoCodec}" is not supported.`,
      );
    }

    this.canvasSource = new CanvasSource(this.internalCanvas, {
      codec: this.options.videoCodec,
      bitrate: videoBitrate,
    });

    this.output = new Output({
      format: new Mp4OutputFormat({fastStart: "in-memory"}),
      target: new BufferTarget(),
    });

    this.output.addVideoTrack(this.canvasSource, {
      frameRate: this.settings.fps,
    });

    const hasProjectAudio = !!this.project.audio;
    const hasProgrammaticSounds = sounds.length > 0;
    const shouldIncludeProjectAudio =
      this.options.includeAudio && hasProjectAudio;
    const hasAnyAudio = shouldIncludeProjectAudio || hasProgrammaticSounds;

    if (hasAnyAudio) {
      const audioBitrate = this.qualityOrBitrate(
        this.options.audioQuality,
        this.options.audioBitrate,
      );

      if (!(await mb.canEncodeAudio(this.options.audioCodec, {bitrate: audioBitrate as number}))) {
        throw new Error(
          `SegmentExporter: audio codec "${this.options.audioCodec}" is not supported.`,
        );
      }

      this.audioSource = new AudioBufferSource({
        codec: this.options.audioCodec,
        bitrate: audioBitrate,
      });

      this.output.addAudioTrack(this.audioSource);
    }

    await this.output.start();
  }

  public async handleFrame(
    canvas: HTMLCanvasElement,
    frame: number,
    _sceneFrame: number,
    _sceneName: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.abortSignal) this.abortSignal = signal;
    if (!this.output || !this.canvasSource || !this.internalCtx) return;

    const frameDuration = 1 / this.settings.fps;
    const timestampInSecs = (frame - this.startFrame) / this.settings.fps;

    this.internalCtx.drawImage(canvas, 0, 0);
    await this.canvasSource.add(timestampInSecs, frameDuration);

    this.frameEnd = frame;
  }

  private async fetchAudioBuffer(
    url: string,
    context: BaseAudioContext,
  ): Promise<AudioBuffer> {
    const res = await fetch(url);
    const buffer = await res.arrayBuffer();
    return context.decodeAudioData(buffer);
  }

  private async mixAndIncludeAudio(): Promise<void> {
    if (!this.audioSource) return;

    const startSec = this.settings.range[0] ?? 0;
    const totalDuration =
      this.renderDuration > 0
        ? this.renderDuration / this.settings.fps
        : (this.frameEnd - this.startFrame) / this.settings.fps;

    if (totalDuration <= 0) return;

    const allSounds: Sound[] = [...this.sounds];

    if (this.project.audio && this.options.includeAudio) {
      const audioOffset = this.project.meta.shared.audioOffset.get() ?? 0;
      allSounds.push({
        audio: this.project.audio,
        offset: audioOffset,
        realPlaybackRate: 1,
      });
    }

    if (allSounds.length === 0) return;

    const sampleRate = 48_000;
    const frameCount = Math.ceil(totalDuration * sampleRate);
    const offlineContext = new OfflineAudioContext(2, frameCount, sampleRate);

    const audioBuffers = new Map<string, AudioBuffer>();
    for (const sound of allSounds) {
      if (!audioBuffers.has(sound.audio)) {
        try {
          const buf = await this.fetchAudioBuffer(sound.audio, offlineContext);
          audioBuffers.set(sound.audio, buf);
        } catch (_) {
          // skip unloadable audio
        }
      }
    }

    const globalVolume = this.options.audioVolume / 100;

    for (const sound of allSounds) {
      const buffer = audioBuffers.get(sound.audio);
      if (!buffer) continue;

      const sourceNode = offlineContext.createBufferSource();
      sourceNode.buffer = buffer;

      const playbackRate =
        sound.realPlaybackRate ??
        Math.pow(2, (sound.detune ?? 0) / 1200) * (sound.playbackRate ?? 1);
      sourceNode.playbackRate.value = playbackRate;

      const gainNode = offlineContext.createGain();
      const gainDb = sound.gain ?? 0;
      gainNode.gain.value = Math.pow(10, gainDb / 20) * globalVolume;

      sourceNode.connect(gainNode);
      gainNode.connect(offlineContext.destination);

      const soundOffset = sound.offset - startSec;
      const trimStart = sound.start ?? 0;
      const trimEnd = sound.end;
      const trimDuration =
        trimEnd !== undefined
          ? (trimEnd - trimStart) / playbackRate
          : undefined;

      if (soundOffset >= 0) {
        sourceNode.start(soundOffset, trimStart, trimDuration);
      } else {
        const skipAmount = -soundOffset * playbackRate;
        const newTrimStart = trimStart + skipAmount;
        const newTrimDuration =
          trimDuration !== undefined
            ? Math.max(0, trimDuration - skipAmount / playbackRate)
            : undefined;

        if (newTrimDuration === undefined || newTrimDuration > 0) {
          sourceNode.start(0, newTrimStart, newTrimDuration);
        }
      }
    }

    const mixedBuffer = await offlineContext.startRendering();
    await this.audioSource.add(mixedBuffer);
  }

  public async stop(result: RendererResult): Promise<void> {
    if (!this.output) return;

    if (!this.options.renderOnAbort && this.abortSignal?.aborted) {
      await this.output.cancel();
      return;
    }

    if (this.audioSource) {
      await this.mixAndIncludeAudio();
    }

    await this.output.finalize();

    if (this.output.target.buffer) {
      this.resultBuffer = this.output.target.buffer.slice(0);
    }

    // Clean up internal canvas so the GC can reclaim memory.
    this.internalCanvas?.remove();
    this.internalCanvas = null;
    this.internalCtx = null;
    this.canvasSource = null;
    this.audioSource = null;
    this.output = null;
  }
}
