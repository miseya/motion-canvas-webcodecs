/// <reference lib="DOM" />

import type { ExporterClass, Logger, RendererSettings } from '@motion-canvas/core/lib/app'
import { makePlugin } from '@motion-canvas/core/lib/plugin'
import { ObjectMetaField, type Project } from '@motion-canvas/core'
import { Exporter } from '@motion-canvas/core/lib/app'

export class WebExport implements Exporter {
  public static readonly id = 'motion-canvas-web-exporter';
  public static readonly displayName = 'MediaRecorder';

  public static meta() {
    return new ObjectMetaField(this.name, {})
  }

  public static async create(
    project: Project,
    settings: RendererSettings,
  ): Promise<WebExport> {
    return new WebExport(project.logger, settings);
  }

  public constructor(
    private readonly logger: Logger,
    private readonly settings: RendererSettings,
  ) { }

  public restart: boolean = false

  public async start() {
    // this.restart = true

    const canvas = document.querySelector("canvas");
    const stream = canvas.captureStream(60); // target FPS
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm; codecs=vp9" });
    const chunks: Blob[] = [];

    console.log(canvas)
    recorder.ondataavailable = e => chunks.push(e.data);
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: "video/webm" });
      const url = URL.createObjectURL(blob);
      console.log(url)
      const a = document.createElement("a");
      a.href = url;
      a.download = "animation.webm";
      a.click();
    };

    recorder.start()
    this.mediaRecorder = recorder
    console.log('started export')
  }

  // https://github.com/w3c/mediacapture-record/issues/213#issuecomment-1376264577
  public myCanvas?: HTMLCanvasElement
  public dataChunks: Blob[] = []
  public stream?: MediaStream
  public track?: CanvasCaptureMediaStreamTrack
  public mediaRecorder?: MediaRecorder

  public async handleFrame(
    canvas: HTMLCanvasElement,
    frame: number,
    sceneFrame: number,
    sceneName: string,
    signal: AbortSignal,
  ) {
    if (signal.aborted) return

    // if (this.restart) {
    //   this.myCanvas = document.createElement('canvas')
    //   this.myCanvas.width = 1920
    //   this.myCanvas.width = 1080
    //   document.body.appendChild(this.myCanvas)
    //   this.dataChunks = []
    //   this.stream = this.myCanvas.captureStream()
    //   this.track = this.stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack
    //
    //   // TODO: select codecs
    //   this.mediaRecorder = new MediaRecorder(this.stream, { mimeType: 'video/webm; codecs=vp9' })
    //   this.mediaRecorder.onerror = console.error
    //   this.mediaRecorder.ondataavailable = (e) => this.dataChunks.push(e.data)
    //   this.mediaRecorder.start()
    //   this.mediaRecorder.pause()
    //
    //   this.restart = false
    //   console.log('initialized variables')
    // }

    // this.mediaRecorder.resume()
    // this.track.requestFrame()
    // this.myCanvas.getContext('2d').drawImage(canvas, 0, 0)
    //
    // // wait for seconds per frame
    // await new Promise(r => setTimeout(r, 1000 / this.settings.fps))
    // this.mediaRecorder.pause()
    //
    // if (this.dataChunks.length)
    //   console.log('DONE processing frame', frame, this.dataChunks.length)
  }

  public async stop() {
    console.log('stoped export')

    this.mediaRecorder?.stop()
    // this.myCanvas?.remove()
    // this.stream?.getTracks().forEach(track => track.stop())
    //
    // const blob = new Blob(this.dataChunks, { type: 'video/webm' })
    // const url = URL.createObjectURL(blob)
    // const a = document.createElement('a')
    //
    // a.href = url
    // a.download = `${this.settings.name}.webm`
    // a.click()
    //
    // setTimeout(() => {
    //   a.remove()
    //   URL.revokeObjectURL(url)
    // }, 1)
  }
}

const WebExporter = makePlugin({
  name: 'MultiExport-plugin',
  exporters(): ExporterClass[] {
    return [WebExport]
  },
})

export default WebExporter
