import type {WorkerShimOptions} from "./batch-types";

interface WorkerShimConfig {
  locationHref?: string;
  options?: WorkerShimOptions;
}

type CanvasWithExtras = OffscreenCanvas & {
  remove?: () => void;
  complete?: boolean;
  onload?: ((event?: unknown) => void) | null;
  onerror?: ((event?: unknown) => void) | null;
  src?: string;
};

const DEFAULT_HREF = "http://localhost/";

function normalizeHref(href?: string): string {
  if (!href) return DEFAULT_HREF;

  try {
    return new URL(href).toString();
  } catch {
    return DEFAULT_HREF;
  }
}

function createShimCanvas(width = 1, height = 1): CanvasWithExtras {
  const canvas = new OffscreenCanvas(width, height) as CanvasWithExtras;
  if (typeof canvas.remove !== "function") {
    canvas.remove = () => {};
  }
  return canvas;
}

function installWindowShim(scope: any, locationHref: string): void {
  scope.window ??= scope;

  if (!scope.location) {
    scope.location = new URL(locationHref);
  }

  if (!scope.window.location) {
    scope.window.location = scope.location;
  }
}

function installDocumentShim(scope: any): void {
  if (scope.document && typeof scope.document.createElement === "function") {
    return;
  }

  scope.document = {
    createElement: (tagName: string) => {
      if (tagName.toLowerCase() === "canvas") {
        return createShimCanvas();
      }

      throw new Error(
        `Worker shim only supports document.createElement('canvas'). Requested: ${tagName}`,
      );
    },
    body: {
      append: () => {},
    },
  };
}

function installAnimationFrameShim(scope: any): void {
  if (
    typeof scope.requestAnimationFrame === "function" &&
    typeof scope.cancelAnimationFrame === "function"
  ) {
    return;
  }

  let handle = 0;
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  scope.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    handle += 1;
    const id = handle;
    const timeout = setTimeout(() => {
      timers.delete(id);
      callback(performance.now());
    }, 16);

    timers.set(id, timeout);
    return id;
  };

  scope.cancelAnimationFrame = (id: number): void => {
    const timeout = timers.get(id);
    if (timeout) {
      clearTimeout(timeout);
      timers.delete(id);
    }
  };
}

function installImageShim(scope: any): void {
  if (typeof scope.Image !== "undefined") {
    return;
  }

  if (
    typeof scope.OffscreenCanvas === "undefined" ||
    typeof scope.createImageBitmap !== "function"
  ) {
    return;
  }

  scope.Image = class WorkerImageShim {
    public constructor() {
      const canvas = createShimCanvas();
      let source = "";

      canvas.complete = false;
      canvas.onload = null;
      canvas.onerror = null;

      Object.defineProperty(canvas, "src", {
        configurable: true,
        enumerable: true,
        get: () => source,
        set: (value: string) => {
          source = value;
          canvas.complete = false;

          void (async () => {
            try {
              const response = await fetch(value);
              if (!response.ok) {
                throw new Error(
                  `Worker image shim failed to fetch ${value}: HTTP ${response.status}`,
                );
              }

              const blob = await response.blob();
              const bitmap = await createImageBitmap(blob);
              canvas.width = bitmap.width;
              canvas.height = bitmap.height;

              const context = canvas.getContext("2d");
              if (!context) {
                throw new Error("Worker image shim failed to create 2D context.");
              }

              context.clearRect(0, 0, canvas.width, canvas.height);
              context.drawImage(bitmap, 0, 0);
              if (typeof (bitmap as any).close === "function") {
                (bitmap as any).close();
              }

              canvas.complete = true;
              canvas.onload?.();
            } catch (error) {
              canvas.complete = false;
              canvas.onerror?.(error);
            }
          })();
        },
      });

      return canvas as unknown as HTMLImageElement;
    }
  };
}

export function installWorkerCompatibilityShims(
  config: WorkerShimConfig = {},
): void {
  const scope = globalThis as any;
  const options = config.options ?? {};
  const locationHref = normalizeHref(config.locationHref);

  if (options.enableWindowShim !== false) {
    installWindowShim(scope, locationHref);
  }

  if (options.enableDocumentShim !== false) {
    installDocumentShim(scope);
  }

  if (options.enableAnimationFrameShim !== false) {
    installAnimationFrameShim(scope);
  }

  if (options.enableImageShim !== false) {
    installImageShim(scope);
  }
}
