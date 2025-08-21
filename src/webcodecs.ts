import type { ExporterClass, Logger, RendererSettings } from '@motion-canvas/core/lib/app'
import { makePlugin } from '@motion-canvas/core/lib/plugin'
import { BoolMetaField, EnumMetaField, NumberMetaField, ObjectMetaField, ValueOf, Project } from '@motion-canvas/core'
import { Exporter } from '@motion-canvas/core/lib/app'
import { Output, Mp4OutputFormat, BufferTarget, AudioBufferSource, CanvasSource } from 'mediabunny'
import * as mb from 'mediabunny'

type WebCodecsExportOptions = ValueOf<ReturnType<typeof WebCodecsExporter.meta>>

class WebCodecsExporter implements Exporter {
  public static readonly id = 'motion-canvas-webcodecs-exporter'
  public static readonly displayName = 'WebCodecs'

  public static meta() {
    const qualityEnum = [
      { text: 'very high', value: mb.QUALITY_VERY_HIGH },
      { text: 'high', value: mb.QUALITY_HIGH },
      { text: 'medium', value: mb.QUALITY_MEDIUM },
      { text: 'low', value: mb.QUALITY_LOW },
      { text: 'very low', value: mb.QUALITY_VERY_LOW },
      { text: 'custom', value: 0 }
    ]

    const videoCodec = new EnumMetaField<mb.VideoCodec>(
      'video codec',
      mb.VIDEO_CODECS.map((codec) => ({ text: codec, value: codec })),
      'av1'
    )

    const videoQuality = new EnumMetaField('video quality', qualityEnum, mb.QUALITY_HIGH)

    const videoBitrate = new NumberMetaField('video bitrate', 0)
      .describe('in bits, obviously')
      .disable(true)

    const includeAudio = new BoolMetaField('include audio', true)

    const audioCodec = new EnumMetaField<mb.AudioCodec>(
      'audio codec',
      mb.AUDIO_CODECS.map((codec) => ({ text: codec, value: codec })),
      'opus'
    )

    const audioQuality = new EnumMetaField('audio quality', qualityEnum, mb.QUALITY_HIGH)

    const audioBitrate = new NumberMetaField('audio bitrate', 24000)
      .describe('in bits, obviously')
      .disable(true)

    const renderOnAbort = new BoolMetaField('render on abort', true)

    videoQuality.onChanged.subscribe((v) => videoBitrate.disable(v !== 0))

    includeAudio.onChanged.subscribe((v) => {
      audioCodec.disable(!v)
      audioQuality.disable(!v)
      audioBitrate.disable(audioQuality.get() !== 0)
    })

    audioQuality.onChanged.subscribe((v) => audioBitrate.disable(v !== 0))

    return new ObjectMetaField(this.displayName, {
      videoCodec,
      videoQuality,
      videoBitrate,
      includeAudio,
      audioCodec,
      audioQuality,
      audioBitrate,
      renderOnAbort,
    })
  }

  public static async create(
    project: Project,
    settings: RendererSettings,
  ): Promise<WebCodecsExporter> {
    return new WebCodecsExporter(project, settings)
  }

  private readonly logger: Logger
  private readonly options: WebCodecsExportOptions

  public constructor(
    private readonly project: Project,
    private readonly settings: RendererSettings,
  ) {
    this.logger = project.logger
    this.options = settings.exporter.options as WebCodecsExportOptions
  }

  public myCanvas?: HTMLCanvasElement
  public canvasCtx?: CanvasRenderingContext2D
  public canvasSource?: CanvasSource
  public audioSource?: AudioBufferSource
  public output?: Output<Mp4OutputFormat, BufferTarget>
  public frameDuration: number = 0
  public frameStart: number = 0

  public async start() {
    const resolution = this.settings.size.mul(this.settings.resolutionScale)

    this.myCanvas = document.createElement('canvas')
    this.myCanvas.width = resolution.width
    this.myCanvas.height = resolution.height

    this.canvasCtx = this.myCanvas.getContext('2d')!

    this.canvasSource = new CanvasSource(this.myCanvas, {
      codec: this.options.videoCodec,
      bitrate: this.options.videoBitrate || this.options.videoQuality,
    })

    this.output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
      target: new BufferTarget(),
    })

    this.output.addVideoTrack(this.canvasSource, {
      frameRate: this.settings.fps
    })

    if (this.options.includeAudio) {
      this.audioSource = new AudioBufferSource({
        codec: this.options.audioCodec,
        bitrate: this.options.audioBitrate || this.options.audioQuality,
      })

      this.output.addAudioTrack(this.audioSource)
    }

    this.frameDuration = 1 / this.settings.fps
    this.frameStart = this.settings.range[0] * this.settings.fps

    await this.output.start()
    this.logger.info('Starting render...')
  }

  public async handleFrame(
    canvas: HTMLCanvasElement,
    frame: number,
    _sceneFrame: number,
    _sceneName: string,
    signal: AbortSignal,
  ) {
    if (!this.output) return this.logger.error('Output is lost somehow')

    if (!this.canvasCtx || !this.canvasSource) {
      console.error('Canvas context and source is lost somehow')
      await this.output.cancel()
      return
    }

    if (signal.aborted) return

    const timestampInSecs = (frame - this.frameStart) / this.settings.fps

    this.canvasCtx.drawImage(canvas, 0, 0)
    await this.canvasSource.add(timestampInSecs, this.frameDuration)
  }

  public async stop() {
    if (!this.output) {
      this.logger.error('Output is lost before finalizing somehow')
      return
    }

    if (!this.options.renderOnAbort && this.output.state === 'canceled') return

    if (this.options.includeAudio && this.project.audio && this.audioSource) {
      this.logger.info('Including audio...')

      // TODO: trim based on time
      const context = new AudioContext()
      const res = await fetch(this.project.audio!)
      const buffer = await res.arrayBuffer()
      const audio = await context.decodeAudioData(buffer)

      await this.audioSource.add(audio)
    }

    this.logger.info('Finalizing render...')
    await this.output.finalize()

    if (!this.output.target.buffer) {
      this.logger.error('Output buffer is lost after finalizing somehow')
      return
    }

    const blob = new Blob([this.output.target.buffer!], { type: 'video/mp4' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')

    a.href = url
    a.download = `${this.settings.name}.mp4`
    a.click()

    setTimeout(() => {
      URL.revokeObjectURL(url)
      a.remove()
    }, 1)
  }
}

const WebCodecsExport = makePlugin({
  name: 'WebCodecsExporter-plugin',
  exporters(): ExporterClass[] {
    return [WebCodecsExporter]
  },
})

export default WebCodecsExport
