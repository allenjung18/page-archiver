// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { canvasToImage, CANVAS_ATTRIBUTE, readCanvas } from "./canvas.ts";
import { snapshot } from "./snapshot.ts";
import { freezeFormState } from "./state.ts";
import { ADOPTED_ATTRIBUTE, adoptedStyles, styleElementText } from "./styles.ts";

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  (document as { adoptedStyleSheets: CSSStyleSheet[] }).adoptedStyleSheets = [];
});

function parsed(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("form state", () => {
  it("writes typed values, checks, choices and open details as attributes; never a password", () => {
    document.body.innerHTML = `<form>
      <input id="t" value="old"><input id="p" type="password" value="pw"><input id="c" type="checkbox" checked>
      <input id="r" type="radio"><input id="b" type="submit" value="Send"><textarea id="a">old</textarea>
      <select id="s"><option>one</option><option>two</option></select><details id="d"><summary>x</summary>y</details></form>`;
    const $ = <T extends Element>(id: string) => document.getElementById(id) as unknown as T;
    $<HTMLInputElement>("t").value = "typed";
    $<HTMLInputElement>("c").checked = false;
    $<HTMLInputElement>("r").checked = true;
    $<HTMLTextAreaElement>("a").value = "new <text>";
    $<HTMLSelectElement>("s").selectedIndex = 1;
    $<HTMLDetailsElement>("d").open = true;
    const out = parsed(snapshot().html);
    const o = (id: string) => out.getElementById(id)!;
    expect(o("t").getAttribute("value")).toBe("typed");
    expect(o("p").hasAttribute("value")).toBe(false);
    expect(o("c").hasAttribute("checked")).toBe(false);
    expect(o("r").hasAttribute("checked")).toBe(true);
    expect(o("b").getAttribute("value")).toBe("Send");
    expect(o("a").textContent).toBe("new <text>");
    expect(Array.from(o("s").querySelectorAll("option")).map((x) => x.hasAttribute("selected"))).toEqual([false, true]);
    expect(o("d").hasAttribute("open")).toBe(true);
    // the live page is untouched
    expect($<HTMLInputElement>("t").getAttribute("value")).toBe("old");
  });

  it("leaves elements that are not form controls alone", () => {
    const live = document.createElement("div");
    const clone = live.cloneNode() as Element;
    freezeFormState(live, clone);
    expect(clone.attributes.length).toBe(0);
  });
});

describe("canvas", () => {
  it("reads a bitmap, reports a tainted canvas, and skips an empty one", () => {
    const c = document.createElement("canvas");
    c.width = 4;
    c.height = 4;
    c.toDataURL = () => "data:image/png;base64,AAAA";
    expect(readCanvas(c)).toEqual({ kind: "image", dataUrl: "data:image/png;base64,AAAA" });
    c.toDataURL = () => {
      throw new DOMException("Tainted canvases may not be exported.", "SecurityError");
    };
    expect(readCanvas(c)).toEqual({ kind: "tainted" });
    c.width = 0;
    expect(readCanvas(c)).toEqual({ kind: "empty" });
  });

  it("tells a cleared WebGL canvas (blank, no 2D context) from a blank 2D one", () => {
    const BLANK = "data:image/png;base64,BLANK";
    const proto = HTMLCanvasElement.prototype;
    const original = proto.toDataURL;
    proto.toDataURL = () => BLANK; // every fresh canvas of this size encodes to the same PNG
    try {
      const c = document.createElement("canvas");
      c.width = 300;
      c.height = 150;
      c.getContext = (() => ({})) as unknown as HTMLCanvasElement["getContext"];
      expect(readCanvas(c)).toEqual({ kind: "empty" });
      c.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];
      expect(readCanvas(c)).toEqual({ kind: "cleared" });
      c.toDataURL = () => "data:image/png;base64,DRAWN";
      expect(readCanvas(c)).toEqual({ kind: "image", dataUrl: "data:image/png;base64,DRAWN" });
    } finally {
      proto.toDataURL = original;
    }
  });

  it("swaps the clone for an <img> keeping its attributes, and warns for a tainted one", () => {
    document.body.innerHTML = `<canvas id="ok" class="k" width="10" height="5">fallback</canvas><canvas id="bad" width="3" height="3"></canvas>`;
    (document.getElementById("ok") as HTMLCanvasElement).toDataURL = () => "data:image/png;base64,QUJD";
    (document.getElementById("bad") as HTMLCanvasElement).toDataURL = () => {
      throw new DOMException("tainted", "SecurityError");
    };
    const snap = snapshot();
    const out = parsed(snap.html);
    const img = out.getElementById("ok")!;
    expect(img.localName).toBe("img");
    expect(img.getAttribute("src")).toBe("data:image/png;base64,QUJD");
    expect([img.getAttribute("class"), img.getAttribute("width"), img.getAttribute("height")]).toEqual(["k", "10", "5"]);
    expect(img.hasAttribute(CANVAS_ATTRIBUTE)).toBe(true);
    expect(out.getElementById("bad")!.localName).toBe("canvas");
    expect(snap.warnings).toEqual(["canvas #bad is tainted by a cross-origin image and cannot be read; it is empty in the archive"]);
  });

  it("keeps an alt the canvas carried", () => {
    const c = document.createElement("canvas");
    c.setAttribute("alt", "chart");
    document.body.append(c);
    expect(canvasToImage(c, "data:image/png;base64,AA").getAttribute("alt")).toBe("chart");
  });
});

describe("styles", () => {
  it("keeps the author's text when the CSSOM matches it, and writes the CSSOM when script changed it", () => {
    document.head.innerHTML = `<style id="same">p { color: red; }</style><style id="grown">p { color: red; }</style><style id="empty"></style>`;
    const style = (id: string) => document.getElementById(id) as HTMLStyleElement;
    style("grown").sheet!.insertRule("em { color: blue; }", 1);
    style("empty").sheet!.insertRule("b { color: green; }", 0);
    expect(styleElementText(style("same"))).toBeNull();
    expect(styleElementText(style("grown"))).toMatch(/p \{ color: red; \}\nem \{ color: blue; \}/);
    expect(styleElementText(style("empty"))).toMatch(/^b \{ color: green; \}$/);
    const out = parsed(snapshot().html);
    expect(out.getElementById("empty")!.textContent).toMatch(/color: green/);
  });

  it("writes adopted sheets as <style> elements, a disabled one as media=not all", () => {
    const a = new CSSStyleSheet();
    a.replaceSync("h1 { color: purple; }");
    const b = new CSSStyleSheet();
    b.replaceSync("h2 { color: teal; }");
    b.disabled = true;
    const styles = adoptedStyles({ adoptedStyleSheets: [a, b] } as unknown as Document, document);
    expect(styles.map((s) => [s.hasAttribute(ADOPTED_ATTRIBUTE), s.getAttribute("media"), s.textContent])).toEqual([
      [true, null, "h1 { color: purple; }"],
      [true, "not all", "h2 { color: teal; }"],
    ]);
  });
});

describe("shadow DOM", () => {
  it("writes an open shadow root as a declarative template inside its host, frozen like the page", () => {
    document.body.innerHTML = `<my-card id="h"><span slot="t">light</span></my-card>`;
    const root = document.getElementById("h")!.attachShadow({ mode: "open", delegatesFocus: true });
    // happy-dom does not keep the init's delegatesFocus; a browser does
    Object.defineProperty(root, "delegatesFocus", { value: true });
    root.innerHTML = `<style>b { color: red; }</style><b>shadow</b><slot name="t"></slot><input id="in">`;
    (root.getElementById("in") as HTMLInputElement).value = "typed in shadow";
    const html = snapshot().html;
    const tpl = html.slice(html.indexOf("<my-card"), html.indexOf("</my-card>"));
    expect(tpl).toMatch(/^<my-card id="h"><template shadowrootmode="open" shadowrootdelegatesfocus(="")?>/);
    expect(tpl).toContain("<b>shadow</b>");
    expect(tpl).toContain(`value="typed in shadow"`);
    expect(tpl).toContain(`<span slot="t">light</span>`);
  });

  it("skips a closed shadow root", () => {
    document.body.innerHTML = `<x-closed id="h">light</x-closed>`;
    document.getElementById("h")!.attachShadow({ mode: "closed" }).innerHTML = "<b>hidden</b>";
    expect(snapshot().html).not.toContain("<template");
  });
});
