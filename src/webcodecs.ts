import type {
  ExporterClass,
  Logger,
  RendererSettings,
} from "@motion-canvas/core/lib/app";
import { makePlugin } from "@motion-canvas/core/lib/plugin";
import {
  BoolMetaField,
  EnumMetaField,
  NumberMetaField,
  ObjectMetaField,
  ValueOf,
  Project,
} from "@motion-canvas/core";
import { Exporter } from "@motion-canvas/core/lib/app";
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
};

type WebCodecsExportOptions = ValueOf<
  ReturnType<typeof WebCodecsExporter.meta>
>;

// TODO: video format selection, chunked or maybe streaming video output?
class WebCodecsExporter implements Exporter {
  public static readonly id = "motion-canvas-webcodecs-exporter";
  public static readonly displayName = "WebCodecs";

  public static meta() {
    const qualityEnum = [
      { text: "very high", value: 4 },
      { text: "high", value: 3 },
      { text: "medium", value: 2 },
      { text: "low", value: 1 },
      { text: "very low", value: 0 },
      { text: "custom", value: null },
    ];

    const supportedVideoCodecs = mb.VIDEO_CODECS.filter((codec) =>
      mb.canEncodeVideo(codec),
    );

    const videoCodec = new EnumMetaField<mb.VideoCodec>(
      "video codec",
      supportedVideoCodecs.map((codec) => ({ text: codec, value: codec })),
      "avc",
    );

    const videoQuality = new EnumMetaField(
      "video quality",
      qualityEnum,
      2,
    );

    const videoBitrate = new NumberMetaField("video bitrate", 0)
      .describe("in bits, obviously")
      .disable(true);

    const includeAudio = new BoolMetaField("include project audio", true);

    const audioVolume = new NumberMetaField("audio volume", 100).setRange(
      0,
      200,
    );

    const supportedAudioCodecs = mb.AUDIO_CODECS.filter((codec) =>
      mb.canEncodeAudio(codec),
    );

    const audioCodec = new EnumMetaField<mb.AudioCodec>(
      "audio codec",
      supportedAudioCodecs.map((codec) => ({ text: codec, value: codec })),
      "opus",
    );

    const audioQuality = new EnumMetaField(
      "audio quality",
      qualityEnum,
      2,
    );

    const audioBitrate = new NumberMetaField("audio bitrate", 0)
      .describe("in bits, obviously")
      .disable(true);

    const renderOnAbort = new BoolMetaField("render on abort", true);

    videoQuality.onChanged.subscribe((v) => videoBitrate.disable(v !== null));

    // Audio codec/quality options are always enabled since sound effects may be present\n    // even when project audio is not included

    audioQuality.onChanged.subscribe((v) => audioBitrate.disable(v !== null));

    return new ObjectMetaField(this.displayName, {
      videoCodec,
      videoQuality,
      videoBitrate,
      includeAudio,
      audioVolume,
      audioCodec,
      audioQuality,
      audioBitrate,
      renderOnAbort,
    });
  }

  private qualityOrBitrate(quality: number | null, bitrate: number): mb.Quality | number {
    switch (quality) {
      case 0: return mb.QUALITY_VERY_LOW
      case 1: return mb.QUALITY_LOW
      case 2: return mb.QUALITY_MEDIUM
      case 3: return mb.QUALITY_HIGH
      case 4: return mb.QUALITY_VERY_HIGH
    }

    return bitrate
  }

  public static async create(
    project: Project,
    settings: RendererSettings,
  ): Promise<WebCodecsExporter> {
    return new WebCodecsExporter(project, settings);
  }

  private readonly logger: Logger;
  private readonly options: WebCodecsExportOptions;

  public constructor(
    private readonly project: Project,
    private readonly settings: RendererSettings,
  ) {
    this.logger = project.logger;
    this.options = settings.exporter.options as WebCodecsExportOptions;
  }

  public abortSignal?: AbortSignal;
  public myCanvas?: HTMLCanvasElement;
  public canvasCtx?: CanvasRenderingContext2D;
  public canvasSource?: CanvasSource;
  public audioSource?: AudioBufferSource;
  public output?: Output<Mp4OutputFormat, BufferTarget>;
  public frameDuration: number = 0;
  public frameStart: number = 0;
  public frameEnd: number = 0;

  // Programmatic sounds support
  private sounds: Sound[] = [];
  private renderDuration: number = 0;

  public async start(sounds: Sound[] = [], duration: number = 0) {
    // Store sounds for later mixing
    this.sounds = sounds;
    this.renderDuration = duration;

    const resolution = this.settings.size.mul(this.settings.resolutionScale);

    this.myCanvas = document.createElement("canvas");
    this.myCanvas.width = resolution.width;
    this.myCanvas.height = resolution.height;

    this.canvasCtx = this.myCanvas.getContext("2d")!;

    const videoCodec = this.options.videoCodec;
    const bitrate = this.qualityOrBitrate(this.options.videoQuality, this.options.videoBitrate)

    this.canvasSource = new CanvasSource(this.myCanvas, {
      codec: videoCodec,
      bitrate,
    });

    if (!(await mb.canEncodeVideo(videoCodec, { bitrate }))) {
      throw "The exporter does not support the current video codec settings!";
    }

    this.output = new Output({
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      target: new BufferTarget(),
    });

    this.output.addVideoTrack(this.canvasSource, {
      frameRate: this.settings.fps,
    });

    // Check if we have any audio to include (project audio or programmatic sounds)
    const hasProjectAudio = !!this.project.audio;
    const hasProgrammaticSounds = this.sounds.length > 0;
    const shouldIncludeProjectAudio =
      this.options.includeAudio && hasProjectAudio;
    const hasAnyAudio = shouldIncludeProjectAudio || hasProgrammaticSounds;

    if (hasAnyAudio) {
      const codec = this.options.audioCodec;
      const bitrate = this.qualityOrBitrate(this.options.audioQuality, this.options.audioBitrate);

      if (!(await mb.canEncodeAudio(codec, { bitrate }))) {
        throw "The exporter does not support the current audio codec settings!";
      }

      this.audioSource = new AudioBufferSource({
        codec,
        bitrate,
      });

      this.output.addAudioTrack(this.audioSource);
    }

    this.frameDuration = 1 / this.settings.fps;
    this.frameStart = (this.settings.range[0] ?? 0) * this.settings.fps;

    await this.output.start();

    this.logger.info({
      message: "Starting render...",
      object: {
        duration: this.frameDuration,
        fps: this.settings.fps,
        range: this.settings.range,
        frameStart: this.frameStart,
      },
    });
  }

  public async handleFrame(
    canvas: HTMLCanvasElement,
    frame: number,
    _sceneFrame: number,
    _sceneName: string,
    signal: AbortSignal,
  ) {
    if (!this.abortSignal) this.abortSignal = signal;

    if (!this.output) return this.logger.error("Output is lost somehow");

    if (!this.canvasCtx || !this.canvasSource) {
      console.error("Canvas context and source is lost somehow");
      await this.output.cancel();
      return;
    }

    const timestampInSecs = (frame - this.frameStart) / this.settings.fps;

    this.canvasCtx.drawImage(canvas, 0, 0);
    await this.canvasSource.add(timestampInSecs, this.frameDuration);

    // Save frame end to get project's duration
    this.frameEnd = frame;
  }

  /**
   * Fetch and decode an audio file to an AudioBuffer
   */
  private async fetchAudioBuffer(
    url: string,
    context: BaseAudioContext,
  ): Promise<AudioBuffer> {
    const res = await fetch(url);
    const buffer = await res.arrayBuffer();
    return await context.decodeAudioData(buffer);
  }

  /**
   * Mix all sounds (project audio + programmatic sounds) using OfflineAudioContext
   */
  public async mixAndIncludeAudio() {
    if (!this.audioSource) {
      this.logger.error("Audio source is lost somehow");
      return;
    }

    // Use renderDuration (frames) / fps for total duration, like FFmpeg does
    const startSec = this.settings.range[0] ?? 0;
    let totalDuration: number;

    // Derive from start's duration on alpha version, else count manually on stable version
    if (this.renderDuration > 0) {
      totalDuration = this.renderDuration / this.settings.fps;
    } else {
      totalDuration = (this.frameEnd - this.frameStart) / this.settings.fps;
    }

    if (totalDuration <= 0) {
      this.logger.error({
        message: "Invalid audio duration",
        object: {
          renderDuration: this.renderDuration,
          fps: this.settings.fps,
          range: this.settings.range,
          frameStart: this.frameStart,
        },
      });

      return;
    }

    // Collect all sounds to mix
    const allSounds: Sound[] = [...this.sounds];

    // Add project audio as a sound only if "include project audio" is enabled
    if (this.project.audio && this.options.includeAudio) {
      const audioOffset = this.project.meta.shared.audioOffset.get() ?? 0;
      allSounds.push({
        audio: this.project.audio,
        offset: audioOffset, // Absolute offset, will be adjusted for startSec below
        realPlaybackRate: 1,
      });
    }

    if (allSounds.length === 0) {
      this.logger.warn("No audio to include, skipping...");
      return;
    }

    // Use a standard sample rate
    const sampleRate = 48_000;
    const frameCount = Math.ceil(totalDuration * sampleRate);

    this.logger.info({
      message: "Mixing audio...",
      object: {
        allSounds,
        audioVolume: this.options.audioVolume,
        sampleRate,
        frameCount,
      },
    });

    // Create offline context for mixing
    const offlineContext = new OfflineAudioContext(2, frameCount, sampleRate);

    // Fetch and decode all audio files
    const audioBuffers: Map<string, AudioBuffer> = new Map();
    for (const sound of allSounds) {
      if (!audioBuffers.has(sound.audio)) {
        try {
          const buffer = await this.fetchAudioBuffer(sound.audio, offlineContext);
          audioBuffers.set(sound.audio, buffer);
        } catch (error) {
          const object = error as Error;
          this.logger.warn({
            message: `Failed to load audio ${sound.audio}: ${object?.message}`,
            stack: object?.stack,
            object,
          });
        }
      }
    }

    // Schedule each sound in the offline context
    const globalVolume = this.options.audioVolume / 100;

    for (const sound of allSounds) {
      const buffer = audioBuffers.get(sound.audio);
      if (!buffer) continue;

      // Create source node
      const sourceNode = offlineContext.createBufferSource();
      sourceNode.buffer = buffer;

      // Apply playback rate (combines detune and playbackRate)
      const playbackRate =
        sound.realPlaybackRate ??
        Math.pow(2, (sound.detune ?? 0) / 1200) * (sound.playbackRate ?? 1);
      sourceNode.playbackRate.value = playbackRate;

      // Create gain node for volume control
      const gainNode = offlineContext.createGain();

      // Apply gain (convert dB to linear, then apply global volume)
      const gainDb = sound.gain ?? 0;
      const gainLinear = Math.pow(10, gainDb / 20);
      gainNode.gain.value = gainLinear * globalVolume;

      // Connect nodes: source -> gain -> destination
      sourceNode.connect(gainNode);
      gainNode.connect(offlineContext.destination);

      // Calculate when and how to play this sound
      // Sound offset is relative to animation start, but we need to adjust for render range
      const soundOffset = sound.offset - startSec;

      // Trim parameters
      const trimStart = sound.start ?? 0;
      const trimEnd = sound.end;
      const trimDuration =
        trimEnd !== undefined
          ? (trimEnd - trimStart) / playbackRate
          : undefined;

      // Schedule the sound
      if (soundOffset >= 0) {
        // Sound starts after or at render start
        sourceNode.start(soundOffset, trimStart, trimDuration);
      } else {
        // Sound started before render start - need to skip into it
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

    // Render the mixed audio
    let mixedBuffer: AudioBuffer

    try {
      this.logger.info("Rendering mixed audio...");
      mixedBuffer = await offlineContext.startRendering();
    } catch (error) {
      const object = error as Error;
      this.logger.error({
        message: `Failed to render mixed audio: ${object?.message}`,
        stack: object?.stack,
        object,
      });
      return;
    }

    // Add the mixed buffer to mediabunny
    try {
      await this.audioSource.add(mixedBuffer);
    } catch (error) {
      const object = error as Error;
      this.logger.error({
        message: `Failed to include audio: ${object?.message}`,
        stack: object?.stack,
        object,
      });
    }
  }

  public async stop() {
    if (!this.output) {
      this.logger.error("Output is lost before finalizing somehow");
      return;
    }

    if (
      (!this.options.renderOnAbort && this.abortSignal?.aborted) ||
      this.output.state === "canceled"
    )
      return;

    // Include audio if there are sounds OR if project audio is enabled
    if (this.audioSource) {
      await this.mixAndIncludeAudio();
    }

    this.logger.info("Finalizing render...");
    await this.output.finalize();

    if (!this.output.target.buffer) {
      this.logger.error("Output buffer is lost after finalizing somehow");
      return;
    }

    const blob = new Blob([this.output.target.buffer!], { type: "video/mp4" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");

    a.href = url;
    a.download = `${this.settings.name}.mp4`;
    a.click();

    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1);
  }
}

const WebCodecsExport = makePlugin({
  name: "WebCodecsExporter-plugin",
  exporters(): ExporterClass[] {
    return [WebCodecsExporter];
  },
});

export default WebCodecsExport;
