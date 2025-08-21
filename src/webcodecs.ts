import type { ExporterClass, Logger, RendererSettings } from '@motion-canvas/core/lib/app'
import { makePlugin } from '@motion-canvas/core/lib/plugin'
import { BoolMetaField, EnumMetaField, NumberMetaField, ObjectMetaField, ValueOf, Project } from '@motion-canvas/core'
import { Exporter } from '@motion-canvas/core/lib/app'
import { Output, Mp4OutputFormat, BufferTarget, CanvasSource } from 'mediabunny'
import * as mb from 'mediabunny'

type WebCodecsExportOptions = ValueOf<ReturnType<typeof WebCodecsExporter.meta>>

class WebCodecsExporter implements Exporter {
  public static readonly id = 'motion-canvas-webcodecs-exporter'
  public static readonly displayName = 'WebCodecs'

  public static meta() {
    const videoCodec = new EnumMetaField<mb.VideoCodec>(
      'video codec',
      mb.VIDEO_CODECS.map((codec) => ({ text: codec, value: codec })),
      'av1'
    )

    const quality = new EnumMetaField('quality', [
      { text: 'very high', value: mb.QUALITY_VERY_HIGH },
      { text: 'high', value: mb.QUALITY_HIGH },
      { text: 'medium', value: mb.QUALITY_MEDIUM },
      { text: 'low', value: mb.QUALITY_LOW },
      { text: 'very low', value: mb.QUALITY_VERY_LOW },
      { text: 'custom', value: 0 }
    ], mb.QUALITY_HIGH)

    const bitrate = new NumberMetaField('bitrate', 0)
      .describe('in bits, obviously')
      .disable(true)

    const renderOnAbort = new BoolMetaField('render on abort', true)

    // define dynamic options
    quality.onChanged.subscribe((v) => bitrate.disable(v !== 0))

    return new ObjectMetaField(this.displayName, {
      videoCodec,
      quality,
      bitrate,
      renderOnAbort,
    })
  }

  public static async create(
    project: Project,
    settings: RendererSettings,
  ): Promise<WebCodecsExporter> {
    return new WebCodecsExporter(project.logger, settings)
  }

  private readonly options: WebCodecsExportOptions

  public constructor(
    private readonly logger: Logger,
    private readonly settings: RendererSettings,
  ) {
    this.options = settings.exporter.options as WebCodecsExportOptions
  }

  public myCanvas?: HTMLCanvasElement
  public canvasCtx?: CanvasRenderingContext2D
  public canvasSource?: CanvasSource
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
      bitrate: this.options.bitrate || this.options.quality,
    })

    this.output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
      target: new BufferTarget(),
    })

    this.output.addVideoTrack(this.canvasSource, {
      frameRate: this.settings.fps
    })

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

    if (signal.aborted) {
      if (this.options.renderOnAbort) await this.output.cancel()
      return
    }

    const timestampInSecs = (frame - this.frameStart) / this.settings.fps

    this.canvasCtx.drawImage(canvas, 0, 0)
    await this.canvasSource.add(timestampInSecs, this.frameDuration)
  }

  public async stop() {
    if (!this.output) {
      this.logger.error('Output is lost before finalizing somehow')
      return
    }

    this.logger.info('Finalizing render...')

    if (this.output.state !== 'canceled')
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
