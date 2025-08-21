/// <reference lib="DOM" />

import type { ExporterClass, Logger } from '@motion-canvas/core/lib/app'
import { makePlugin } from '@motion-canvas/core/lib/plugin'
import { ObjectMetaField, type Project } from '@motion-canvas/core'
import { Exporter } from '@motion-canvas/core/lib/app'

export class WebExport implements Exporter {
  public static readonly id = 'motion-canvas-web-exporter';
  public static readonly displayName = 'MediaRecorder';

  public static meta() {
    return new ObjectMetaField(this.name, {})
  }

  public static async create(project: Project): Promise<WebExport> {
    return new WebExport(project.logger);
  }

  private readonly frameLookup = new Set<number>();

  public constructor(private readonly logger: Logger) { }

  public async start() {
    console.log('started export')
  }

  public async handleFrame(
    canvas: HTMLCanvasElement,
    frame: number,
    sceneFrame: number,
    sceneName: string,
    signal: AbortSignal,
  ) {
    if (this.frameLookup.has(frame)) {
      this.logger.warn(`Frame no. ${frame} is already being exported.`);
      return;
    }

    // process frame here
    console.log('hello world frame', sceneFrame)
  }

  public async stop() {
    console.log('stoped export')
  }
}

const WebExporter = makePlugin({
  name: 'MultiExport-plugin',
  exporters(): ExporterClass[] {
    return [WebExport]
  },
})

export default WebExporter
