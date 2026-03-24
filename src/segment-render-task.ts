import {
  bootstrap,
  Logger,
  MetaFile,
  Renderer,
  Vector2,
} from "@motion-canvas/core";
import type {ProjectSettings, Plugin} from "@motion-canvas/core";
import type {
  BatchRenderJob,
  BatchRenderSegmentResult,
} from "./batch-types";
import {SegmentExporter, type SegmentExporterOptions} from "./segment-exporter";

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

export interface SegmentRenderTaskEnvironment {
  projectConfig: ProjectSettings;
  plugins: Plugin[];
  exporterOptions: SegmentExporterOptions;
  projectMetaData: unknown;
  settingsMetaData: unknown;
}

/**
 * Render a single frame-range segment into an in-memory MP4 buffer.
 */
export async function renderSegmentTask(
  job: BatchRenderJob,
  env: SegmentRenderTaskEnvironment,
): Promise<BatchRenderSegmentResult> {
  const [startFrame, endFrame] = job.frameRange;
  const startSec = startFrame / job.fps;
  const endSec = endFrame / job.fps;

  const {metaFile, settingsFile} = createDetachedMetaFiles(
    `batch-segment-${job.jobIndex}`,
    env.projectMetaData,
    env.settingsMetaData,
  );

  const logger = new Logger();
  const project = bootstrap(
    env.projectConfig.name ?? "project",
    {core: "0.0.0", two: null, ui: null, vitePlugin: null},
    env.plugins,
    env.projectConfig,
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
    exporter: {name: "batch-segment", options: env.exporterOptions},
  };

  const segmentExporter = new SegmentExporter(
    project,
    rendererSettings,
    env.exporterOptions,
  );

  // Inject exporter shim so Renderer.run() can resolve by name.
  const exporterShim = {
    id: "batch-segment" as const,
    displayName: "Batch Segment",
    meta: () => {
      throw new Error("unreachable");
    },
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
