import type {
  BatchRenderJob,
  BatchRenderSegmentResult,
  BatchWorkerBootstrap,
  RenderWorkerRequest,
  RenderWorkerResponse,
} from "./batch-types";

export interface WorkerRunnerOptions {
  workerFactory?: () => Worker;
}

type PendingRequest = {
  resolve: (message: RenderWorkerResponse) => void;
  reject: (error: Error) => void;
};

export class RenderWorkerClient {
  private worker: Worker | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private sequence = 0;

  public constructor(private readonly options: WorkerRunnerOptions = {}) {}

  public async init(bootstrap: BatchWorkerBootstrap): Promise<void> {
    this.ensureWorker();

    const message = await this.send({
      type: "init",
      requestId: this.nextRequestId(),
      payload: bootstrap,
    });

    if (message.type !== "ready") {
      throw new Error(`RenderWorkerClient: unexpected init response ${message.type}`);
    }
  }

  public async renderSegment(
    job: BatchRenderJob,
  ): Promise<BatchRenderSegmentResult> {
    this.ensureWorker();

    const message = await this.send({
      type: "render-segment",
      requestId: this.nextRequestId(),
      payload: {job},
    });

    if (message.type !== "segment-result") {
      throw new Error(
        `RenderWorkerClient: unexpected render response ${message.type}`,
      );
    }

    return message.payload;
  }

  public async dispose(): Promise<void> {
    if (!this.worker) return;

    try {
      await this.send({
        type: "dispose",
        requestId: this.nextRequestId(),
      });
    } finally {
      this.worker.terminate();
      this.worker = null;
      this.pending.clear();
    }
  }

  private ensureWorker(): void {
    if (this.worker) return;

    this.worker = this.options.workerFactory?.() ??
      new Worker(new URL("./render-worker.ts", import.meta.url), {
        type: "module",
      });

    this.worker.addEventListener("message", event => {
      const data = event.data as RenderWorkerResponse;
      const request = this.pending.get(data.requestId);
      if (!request) return;

      this.pending.delete(data.requestId);
      if (data.type === "error") {
        request.reject(new Error(data.error));
        return;
      }

      request.resolve(data);
    });

    this.worker.addEventListener("error", event => {
      const err = new Error(event.message || "Render worker failed.");
      for (const [, pending] of this.pending) {
        pending.reject(err);
      }
      this.pending.clear();
    });
  }

  private nextRequestId(): string {
    this.sequence += 1;
    return `req-${this.sequence}`;
  }

  private send(request: RenderWorkerRequest): Promise<RenderWorkerResponse> {
    if (!this.worker) {
      return Promise.reject(new Error("RenderWorkerClient: worker not initialized."));
    }

    return new Promise((resolve, reject) => {
      this.pending.set(request.requestId, {resolve, reject});
      this.worker!.postMessage(request);
    });
  }
}
