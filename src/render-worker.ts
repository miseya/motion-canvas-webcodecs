import type {ProjectSettings} from "@motion-canvas/core";
import type {
  BatchRenderSegmentResult,
  BatchWorkerBootstrap,
  RenderWorkerRequest,
  RenderWorkerResponse,
} from "./batch-types";

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

async function handleInit(requestId: string, payload: BatchWorkerBootstrap): Promise<void> {
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
  payload: {job: {jobIndex: number; frameRange: [number, number]}},
): Promise<void> {
  if (!state.initialized || !state.projectConfig) {
    postMessage({
      type: "error",
      requestId,
      error: "RenderWorker: init must be called before render-segment.",
    });
    return;
  }

  const [startFrame, endFrame] = payload.job.frameRange;

  // Current worker scaffold intentionally reports a descriptive error because
  // Motion Canvas Stage/WebGL still requires document-backed canvas creation.
  const result: BatchRenderSegmentResult = {
    jobIndex: payload.job.jobIndex,
    frameRange: [startFrame, endFrame],
    buffer: new ArrayBuffer(0),
    durationFrames: endFrame - startFrame,
    error:
      "RenderWorker scaffold is active, but worker rendering is not yet supported without OffscreenCanvas-compatible Stage/WebGL abstractions.",
  };

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
