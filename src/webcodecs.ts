import type { ExporterClass, Logger, RendererSettings } from '@motion-canvas/core/lib/app'
import { makePlugin } from '@motion-canvas/core/lib/plugin'
import { BoolMetaField, EnumMetaField, NumberMetaField, ObjectMetaField, ValueOf, Project } from '@motion-canvas/core'
import { Exporter } from '@motion-canvas/core/lib/app'
import { Output, Mp4OutputFormat, BufferTarget, AudioBufferSource, CanvasSource } from 'mediabunny'
import * as mb from 'mediabunny'

type WebCodecsExportOptions = ValueOf<ReturnType<typeof WebCodecsExporter.meta>>

// TODO: video format selection, chunked or maybe streaming video output?
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
      { text: 'custom', value: null }
    ]

    const supportedVideoCodecs = mb.VIDEO_CODECS.filter((codec) => mb.canEncodeVideo(codec))

    const videoCodec = new EnumMetaField<mb.VideoCodec>(
      'video codec',
      supportedVideoCodecs.map((codec) => ({ text: codec, value: codec })),
      'avc'
    )

    const videoQuality = new EnumMetaField('video quality', qualityEnum, mb.QUALITY_HIGH)

    const videoBitrate = new NumberMetaField('video bitrate', 0)
      .describe('in bits, obviously')
      .disable(true)

    const includeAudio = new BoolMetaField('include audio', true)

    const audioVolume = new NumberMetaField('audio volume', 100)
      .setRange(0, 200)

    const supportedAudioCodecs = mb.AUDIO_CODECS.filter((codec) => mb.canEncodeAudio(codec))

    const audioCodec = new EnumMetaField<mb.AudioCodec>(
      'audio codec',
      supportedAudioCodecs.map((codec) => ({ text: codec, value: codec })),
      'aac'
    )

    const audioQuality = new EnumMetaField('audio quality', qualityEnum, mb.QUALITY_HIGH)

    const audioBitrate = new NumberMetaField('audio bitrate', 0)
      .describe('in bits, obviously')
      .disable(true)

    const renderOnAbort = new BoolMetaField('render on abort', true)

    videoQuality.onChanged.subscribe((v) => videoBitrate.disable(v !== null))

    includeAudio.onChanged.subscribe((v) => {
      audioCodec.disable(!v)
      audioQuality.disable(!v)
      audioBitrate.disable(audioQuality.get() !== 0)
    })

    audioQuality.onChanged.subscribe((v) => audioBitrate.disable(v !== null))

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

    const videoCodec = this.options.videoCodec
    const bitrate = this.options.videoQuality || this.options.videoBitrate

    this.canvasSource = new CanvasSource(this.myCanvas, {
      codec: videoCodec,
      bitrate,
    })

    if (await mb.canEncodeVideo(videoCodec, { bitrate })) {
      this.logger.error('The exporter does not support the current video codec settings!')
      return
    }

    this.output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
      target: new BufferTarget(),
    })

    this.output.addVideoTrack(this.canvasSource, {
      frameRate: this.settings.fps
    })

    if (!this.project.audio) {
      this.options.includeAudio = false
    }

    if (this.options.includeAudio) {
      const codec = this.options.audioCodec
      const bitrate = this.options.audioQuality || this.options.audioBitrate

      if (await mb.canEncodeAudio(codec, { bitrate })) {
        this.logger.error('The exporter does not support the current audio codec settings!')
        return
      }

      this.audioSource = new AudioBufferSource({
        codec,
        bitrate,
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

  public async includeAudio() {
    if (!this.audioSource) {
      this.logger.error('Audio source is lost somehow')
      return
    }

    this.logger.info('Including audio...')

    // get original audio
    const context = new AudioContext()
    const res = await fetch(this.project.audio!)
    const buffer = await res.arrayBuffer()
    const audioBuffer = await context.decodeAudioData(buffer)

    // trim by start and end
    const audio = (() => {
      const audioOffset = this.project.meta.shared.audioOffset.get()
      const volume = this.options.audioVolume / 100
      const [startSec, endSec] = this.settings.range

      const duration = endSec - startSec
      if (duration <= 0) throw new Error("Invalid range")

      const sampleRate = audioBuffer.sampleRate
      const frameCount = Math.floor(duration * sampleRate)

      const outputBuffer = context.createBuffer(
        audioBuffer.numberOfChannels,
        frameCount,
        sampleRate
      )

      // shift requested range by offset
      const calibratedStart = startSec - audioOffset
      const calibratedEnd = endSec - audioOffset

      // source frame positions
      const srcStart = Math.max(0, Math.floor(calibratedStart * sampleRate))
      const srcEnd = Math.min(
        audioBuffer.length,
        Math.floor(calibratedEnd * sampleRate)
      )

      // destination frame positions inside the new buffer
      const dstStart = Math.max(0, -Math.floor(calibratedStart * sampleRate))

      for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
        const input = audioBuffer.getChannelData(channel)
        const output = outputBuffer.getChannelData(channel)
        const srcData = input.subarray(srcStart, srcEnd)

        for (let i = 0; i < srcData.length; i++) {
          output[dstStart + i] = srcData[i] * volume
        }
      }

      return outputBuffer
    })()

    try {
      await this.audioSource.add(audio)
    } catch (error) {
      this.logger.error('Failed including audio ' + String(error))
    }
  }

  public async stop() {
    if (!this.output) {
      this.logger.error('Output is lost before finalizing somehow')
      return
    }

    if (!this.options.renderOnAbort && this.output.state === 'canceled') return

    if (this.options.includeAudio) {
      await this.includeAudio()
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
