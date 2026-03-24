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

function createDomElementShim(tagName: string): any {
  const children: any[] = [];
  const style: Record<string, string> = {};
  const styleProxy = new Proxy(style, {
    set(target, prop: string, value) {
      target[prop] = String(value);
      return true;
    },
    get(target, prop: string) {
      return target[prop] ?? "";
    },
  });

  const element: any = {
    tagName: tagName.toUpperCase(),
    style: styleProxy,
    childNodes: children,
    firstChild: null,
    lastChild: null,
    parentNode: null,
    textContent: "",
    innerHTML: "",
    outerHTML: "",
    offsetWidth: 0,
    offsetHeight: 0,
    offsetParent: null,
    clientWidth: 0,
    clientHeight: 0,
    scrollWidth: 0,
    scrollHeight: 0,
    getBoundingClientRect: () => ({
      x: 0, y: 0, width: 0, height: 0,
      top: 0, right: 0, bottom: 0, left: 0,
      toJSON: () => ({}),
    }),
    getClientRects: () => ({ length: 0, item: () => null }),
    appendChild(child: any) {
      children.push(child);
      child.parentNode = element;
      element.firstChild = children[0] ?? null;
      element.lastChild = children[children.length - 1] ?? null;
      return child;
    },
    removeChild(child: any) {
      const idx = children.indexOf(child);
      if (idx !== -1) children.splice(idx, 1);
      child.parentNode = null;
      element.firstChild = children[0] ?? null;
      element.lastChild = children[children.length - 1] ?? null;
      return child;
    },
    insertBefore(child: any, ref: any) {
      const idx = ref ? children.indexOf(ref) : children.length;
      if (idx === -1) children.push(child);
      else children.splice(idx, 0, child);
      child.parentNode = element;
      element.firstChild = children[0] ?? null;
      element.lastChild = children[children.length - 1] ?? null;
      return child;
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    setAttribute: () => {},
    getAttribute: () => null,
    removeAttribute: () => {},
    contains: () => false,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
    remove() {
      element.parentNode?.removeChild(element);
    },
    closest: () => null,
    matches: () => false,
    classList: {
      add: () => {},
      remove: () => {},
      contains: () => false,
      toggle: () => false,
    },
    dataset: {},
    id: "",
    className: "",
  };

  return element;
}

function installDocumentShim(scope: any): void {
  if (scope.document && typeof scope.document.createElement === "function") {
    return;
  }

  scope.document = {
    createElement(tagName: string) {
      const tag = tagName.toLowerCase();
      if (tag === "canvas") {
        return createShimCanvas();
      }
      if (tag === "div" || tag === "span" || tag === "p" || tag === "a") {
        return createDomElementShim(tag);
      }
      if (tag === "img") {
        return scope.Image ? new scope.Image() : createShimCanvas();
      }
      if (tag === "video" || tag === "audio") {
        return createMediaElementShim(tag);
      }
      return createDomElementShim(tag);
    },
    createElementNS(ns: string, tagName: string) {
      if (ns === "http://www.w3.org/2000/svg") {
        return createSvgElementShim(tagName);
      }
      return createDomElementShim(tagName);
    },
    createTextNode(data: string) {
      return {
        nodeType: 3,
        textContent: data ?? "",
        parentNode: null,
      };
    },
    createRange() {
      return {
        setStart: () => {},
        setEnd: () => {},
        collapse: () => {},
        selectNode: () => {},
        selectNodeContents: () => {},
        getBoundingClientRect: () => ({
          x: 0, y: 0, width: 0, height: 0,
          top: 0, right: 0, bottom: 0, left: 0,
          toJSON: () => ({}),
        }),
        getClientRects: () => ({ length: 0, item: () => null }),
        cloneRange: () => scope.document.createRange(),
      };
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    body: {
      append: () => {},
      prepend: () => {},
      appendChild: () => ({}),
      removeChild: () => ({}),
      querySelector: () => null,
      querySelectorAll: () => [],
      style: new Proxy({}, { get: () => "", set: () => true }),
    },
    head: {
      append: () => {},
      appendChild: () => ({}),
    },
    documentElement: {
      style: new Proxy({}, { get: () => "", set: () => true }),
    },
    implementation: {
      createHTMLDocument: () => scope.document,
    },
  };
}

function createMediaElementShim(tag: string): any {
  const listeners: Record<string, Function[]> = {};
  return {
    tagName: tag.toUpperCase(),
    style: new Proxy({}, { get: () => "", set: () => true }),
    addEventListener(event: string, fn: Function) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(fn);
    },
    removeEventListener(event: string, fn: Function) {
      listeners[event] = (listeners[event] ?? []).filter(f => f !== fn);
    },
    dispatchEvent(event: string) {
      for (const fn of listeners[event] ?? []) {
        fn();
      }
      return true;
    },
    load: () => {},
    play: () => Promise.resolve(),
    pause: () => {},
    remove: () => {},
    src: "",
    currentTime: 0,
    duration: 0,
    paused: true,
    readyState: 0,
    videoWidth: 0,
    videoHeight: 0,
  };
}

function createSvgElementShim(tagName: string): any {
  const element = createDomElementShim(tagName);
  element.getTotalLength = () => 0;
  element.getPointAtLength = () => ({ x: 0, y: 0 });
  element.setAttributeNS = () => {};
  element.getAttributeNS = () => null;
  return element;
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

function installComputedStyleShim(scope: any): void {
  if (typeof scope.getComputedStyle === "function") {
    return;
  }

  scope.getComputedStyle = (_element: any) => {
    return new Proxy(
      {},
      {
        get(_target, prop: string) {
          if (prop === "getPropertyValue") return () => "";
          if (prop === "getPropertyPriority") return () => "";
          if (prop === "item") return () => "";
          if (prop === "removeProperty") return () => "";
          if (prop === "setProperty") return () => {};
          if (prop === "length") return 0;
          if (prop === "cssText") return "";
          if (prop === "parentRule") return null;
          return "";
        },
      },
    );
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

  if (options.enableGetComputedStyleShim !== false) {
    installComputedStyleShim(scope);
  }
}
