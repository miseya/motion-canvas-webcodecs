/// <reference lib="DOM" />

import type { ExporterClass, Logger, RendererSettings } from '@motion-canvas/core/lib/app'
import { makePlugin } from '@motion-canvas/core/lib/plugin'
import { ObjectMetaField, type Project } from '@motion-canvas/core'
import { Exporter } from '@motion-canvas/core/lib/app'
import { Output, Mp4OutputFormat, BufferTarget, CanvasSource, QUALITY_HIGH } from 'mediabunny'

class WebCodecsExport implements Exporter {
  public static readonly id = 'motion-canvas-webcodecs-exporter';
  public static readonly displayName = 'WebCodecs';

  public static meta() {
    return new ObjectMetaField(this.name, {})
  }

  public static async create(
    project: Project,
    settings: RendererSettings,
  ): Promise<WebCodecsExport> {
    return new WebCodecsExport(project.logger, settings);
  }

  public constructor(
    private readonly logger: Logger,
    private readonly settings: RendererSettings,
  ) { }

  public myCanvas?: HTMLCanvasElement
  public canvasCtx?: CanvasRenderingContext2D
  public canvasSource?: CanvasSource
  public output?: Output<Mp4OutputFormat, BufferTarget>
  public frameDuration?: number

  public async start() {
    this.myCanvas = document.createElement('canvas')
    this.myCanvas.width = this.settings.size.width
    this.myCanvas.height = this.settings.size.height

    this.canvasCtx = this.myCanvas.getContext('2d')
    this.canvasSource = new CanvasSource(this.myCanvas, {
      codec: 'av1',
      bitrate: QUALITY_HIGH,
    })

    this.output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
      target: new BufferTarget(),
    })

    this.output.addVideoTrack(this.canvasSource, {
      frameRate: this.settings.fps
    })

    this.frameDuration = 1 / this.settings.fps

    await this.output.start()
    this.logger.info('Starting export...')
  }

  public async handleFrame(
    canvas: HTMLCanvasElement,
    frame: number,
    sceneFrame: number,
    sceneName: string,
    signal: AbortSignal,
  ) {
    if (signal.aborted) {
      // why cancel if we can preview a bit lol
      // await this.output.cancel()
      return
    }

    const timestampInSecs = frame / this.settings.fps

    this.canvasCtx.drawImage(canvas, 0, 0)
    await this.canvasSource.add(timestampInSecs, this.frameDuration)
  }

  public async stop() {
    this.logger.info('Finalizing render...')

    if (this.output.state !== 'canceled')
      await this.output.finalize()

    const blob = new Blob([this.output.target.buffer], { type: 'video/mp4' })
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

const WebCodecsExporter = makePlugin({
  name: 'WebCodecsExporter-plugin',
  exporters(): ExporterClass[] {
    return [WebCodecsExport]
  },
})

export default WebCodecsExporter
