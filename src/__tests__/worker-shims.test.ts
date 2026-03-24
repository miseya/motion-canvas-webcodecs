import {describe, it, expect, beforeEach, afterEach} from "vitest";
import {installWorkerCompatibilityShims} from "../worker-shims";

describe("installWorkerCompatibilityShims", () => {
  let originalDocument: any;
  let originalWindow: any;
  let originalGetComputedStyle: any;

  beforeEach(() => {
    originalDocument = (globalThis as any).document;
    originalWindow = (globalThis as any).window;
    originalGetComputedStyle = (globalThis as any).getComputedStyle;

    delete (globalThis as any).document;
    delete (globalThis as any).window;
    delete (globalThis as any).getComputedStyle;

    installWorkerCompatibilityShims({locationHref: "http://localhost/"});
  });

  afterEach(() => {
    (globalThis as any).document = originalDocument;
    (globalThis as any).window = originalWindow;
    (globalThis as any).getComputedStyle = originalGetComputedStyle;
  });

  describe("document.createElement", () => {
    it("creates a shimmed canvas", () => {
      if (typeof OffscreenCanvas === "undefined") {
        return; // OffscreenCanvas not available in test environment
      }
      const canvas = document.createElement("canvas");
      expect(canvas).toBeDefined();
      expect(typeof (canvas as any).getContext).toBe("function");
      expect(typeof (canvas as any).remove).toBe("function");
    });

    it("creates a shimmed div", () => {
      const div = document.createElement("div");
      expect(div).toBeDefined();
      expect((div as any).tagName).toBe("DIV");
      expect((div as any).style).toBeDefined();
      expect(typeof (div as any).remove).toBe("function");
      expect(typeof (div as any).appendChild).toBe("function");
      expect((div as any).offsetWidth).toBe(0);
    });

    it("creates a shimmed span", () => {
      const span = document.createElement("span");
      expect(span).toBeDefined();
      expect((span as any).tagName).toBe("SPAN");
      expect(typeof (span as any).appendChild).toBe("function");
    });

    it("creates a shimmed video", () => {
      const video = document.createElement("video");
      expect(video).toBeDefined();
      expect((video as any).tagName).toBe("VIDEO");
      expect(typeof (video as any).addEventListener).toBe("function");
      expect(typeof (video as any).load).toBe("function");
      expect(typeof (video as any).play).toBe("function");
    });

    it("handles unknown element types gracefully", () => {
      const el = document.createElement("unknown-element");
      expect(el).toBeDefined();
      expect(typeof (el as any).remove).toBe("function");
    });
  });

  describe("document.createElementNS", () => {
    it("creates SVG elements with getTotalLength", () => {
      const path = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "path",
      );
      expect(path).toBeDefined();
      expect(typeof (path as any).getTotalLength).toBe("function");
      expect((path as any).getTotalLength()).toBe(0);
      expect(typeof (path as any).getPointAtLength).toBe("function");
    });

    it("creates SVG root element", () => {
      const svg = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "svg",
      );
      expect(svg).toBeDefined();
      expect(typeof (svg as any).appendChild).toBe("function");
    });
  });

  describe("document.createTextNode", () => {
    it("creates a text node", () => {
      const node = document.createTextNode("hello");
      expect(node).toBeDefined();
      expect((node as any).textContent).toBe("hello");
      expect((node as any).nodeType).toBe(3);
    });
  });

  describe("document.createRange", () => {
    it("creates a range object", () => {
      const range = document.createRange();
      expect(range).toBeDefined();
      expect(typeof range.setStart).toBe("function");
      expect(typeof range.setEnd).toBe("function");
      expect(typeof range.getBoundingClientRect).toBe("function");

      const rect = range.getBoundingClientRect();
      expect(rect.width).toBe(0);
      expect(rect.height).toBe(0);
    });
  });

  describe("document.body", () => {
    it("has all expected methods", () => {
      expect(typeof (document.body as any).append).toBe("function");
      expect(typeof (document.body as any).prepend).toBe("function");
      expect(typeof (document.body as any).appendChild).toBe("function");
      expect(typeof (document.body as any).querySelector).toBe("function");
    });

    it("querySelector returns null", () => {
      expect((document.body as any).querySelector("#test")).toBeNull();
    });
  });

  describe("document.querySelector", () => {
    it("returns null for any query", () => {
      expect(document.querySelector("#test")).toBeNull();
    });
  });

  describe("getComputedStyle", () => {
    it("returns a style object for any element", () => {
      const div = document.createElement("div");
      const style = getComputedStyle(div as any);
      expect(style).toBeDefined();
      expect((style as any).display).toBe("");
      expect((style as any).getPropertyValue("color")).toBe("");
    });
  });

  describe("window shim", () => {
    it("sets window to scope", () => {
      expect(window).toBeDefined();
    });

    it("provides location on window", () => {
      expect(window.location).toBeDefined();
    });
  });

  describe("DOM element operations", () => {
    it("appendChild and removeChild work", () => {
      const parent = document.createElement("div") as any;
      const child = document.createElement("span") as any;

      parent.appendChild(child);
      expect(parent.firstChild).toBe(child);
      expect(child.parentNode).toBe(parent);

      parent.removeChild(child);
      expect(parent.firstChild).toBeNull();
    });

    it("getBoundingClientRect returns zero rect", () => {
      const div = document.createElement("div") as any;
      const rect = div.getBoundingClientRect();
      expect(rect.x).toBe(0);
      expect(rect.y).toBe(0);
      expect(rect.width).toBe(0);
      expect(rect.height).toBe(0);
    });

    it("style can be set and read", () => {
      const div = document.createElement("div") as any;
      div.style.width = "100px";
      div.style.display = "flex";
      expect(div.style.width).toBe("100px");
      expect(div.style.display).toBe("flex");
      expect(div.style.nonExistentProperty).toBe("");
    });
  });
});
