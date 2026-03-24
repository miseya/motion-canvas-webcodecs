import type {Plugin, ProjectSettings} from "@motion-canvas/core";
import type {
  BatchRenderJob,
  BatchRenderSegmentResult,
  BatchWorkerBootstrap,
  RenderWorkerRequest,
  RenderWorkerResponse,
} from "./batch-types";
import type {SegmentExporterOptions} from "./segment-exporter";
import {
  renderSegmentTask,
  type SegmentRenderTaskEnvironment,
} from "./segment-render-task.js";
import {installWorkerCompatibilityShims} from "./worker-shims.js";

const WORKER_PROTOCOL_VERSION = 1;

interface RenderWorkerState {
  initialized: boolean;
  bootstrap?: BatchWorkerBootstrap;
  projectConfig?: ProjectSettings;
}

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<RenderWorkerRequest>) => void,
  ): void;
}

const scope = self as unknown as WorkerScope;
const state: RenderWorkerState = {initialized: false};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown worker error";
}

function postMessage(
  message: RenderWorkerResponse,
  transfer: Transferable[] = [],
): void {
  scope.postMessage(message, transfer);
}

async function loadProjectConfig(moduleUrl: string): Promise<ProjectSettings> {
  const module = await import(/* @vite-ignore */ moduleUrl);
  const candidate = module.default ?? module.project ?? module;

  if (!candidate || !Array.isArray(candidate.scenes)) {
    throw new Error(
      `RenderWorker: module ${moduleUrl} does not export a Motion Canvas project settings object.`,
    );
  }

  return candidate as ProjectSettings;
}

function fallbackSegmentExporterOptions(job: BatchRenderJob): SegmentExporterOptions {
  return {
    videoCodec: job.videoCodec as any,
    videoQuality: job.videoQuality,
    videoBitrate: job.videoBitrate,
    audioCodec: job.audioCodec as any,
    audioQuality: job.audioQuality,
    audioBitrate: job.audioBitrate,
    includeAudio: false,
    audioVolume: job.audioVolume,
    renderOnAbort: false,
  };
}

async function handleInit(requestId: string, payload: BatchWorkerBootstrap): Promise<void> {
  if (
    payload.protocolVersion !== undefined &&
    payload.protocolVersion !== WORKER_PROTOCOL_VERSION
  ) {
    throw new Error(
      `RenderWorker: protocol mismatch. Worker=${WORKER_PROTOCOL_VERSION}, caller=${payload.protocolVersion}.`,
    );
  }

  if (typeof OffscreenCanvas === "undefined") {
    throw new Error(
      "RenderWorker: OffscreenCanvas is unavailable in this environment.",
    );
  }

  installWorkerCompatibilityShims({
    locationHref: payload.locationHref,
    options: payload.shimOptions,
  });

  state.bootstrap = payload;
  state.projectConfig = await loadProjectConfig(payload.projectModuleUrl);
  state.initialized = true;

  postMessage({
    type: "ready",
    requestId,
  });
}

async function handleRenderSegment(
  requestId: string,
  payload: {job: BatchRenderJob},
): Promise<void> {
  if (!state.initialized || !state.projectConfig || !state.bootstrap) {
    postMessage({
      type: "error",
      requestId,
      error: "RenderWorker: init must be called before render-segment.",
    });
    return;
  }

  const environment: SegmentRenderTaskEnvironment = {
    projectConfig: state.projectConfig,
    plugins: (state.projectConfig.plugins ?? []).filter(
      (plugin): plugin is Plugin => typeof plugin !== "string",
    ),
    exporterOptions:
      state.bootstrap.segmentExporterOptions ??
      fallbackSegmentExporterOptions(payload.job),
    projectMetaData: state.bootstrap.projectMetaData ?? {},
    settingsMetaData: state.bootstrap.settingsMetaData ?? {},
  };

  const startedAt = performance.now();
  const result: BatchRenderSegmentResult = await renderSegmentTask(
    payload.job,
    environment,
  );
  result.totalTimeMs = Math.max(0, performance.now() - startedAt);

  postMessage(
    {
      type: "segment-result",
      requestId,
      payload: result,
    },
    [result.buffer],
  );
}

async function dispatch(request: RenderWorkerRequest): Promise<void> {
  switch (request.type) {
    case "init":
      await handleInit(request.requestId, request.payload);
      return;
    case "render-segment":
      await handleRenderSegment(request.requestId, request.payload);
      return;
    case "dispose":
      state.initialized = false;
      state.bootstrap = undefined;
      state.projectConfig = undefined;
      postMessage({
        type: "ready",
        requestId: request.requestId,
      });
      return;
  }
}

scope.addEventListener("message", (event: MessageEvent<RenderWorkerRequest>) => {
  void dispatch(event.data).catch(error => {
    postMessage({
      type: "error",
      requestId: event.data?.requestId ?? "unknown",
      error: toErrorMessage(error),
    });
  });
});

export {};
