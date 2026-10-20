// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { createContentApi, FRAME_ATTRIBUTE, frameElements, MESSAGE_KEY } from "./content.ts";

// <frame> elements stand in for iframes: happy-dom is set never to load a frame, and an
// attached <iframe> logs that refusal
const frame = (id: string) => Object.assign(document.createElement("frame"), { id });

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the content script", () => {
  it("finds frames in the document and in open shadow roots", () => {
    document.body.innerHTML = `<div id="host"></div>`;
    document.body.prepend(frame("one"));
    const root = document.getElementById("host")!.attachShadow({ mode: "open" });
    root.append(frame("two"));
    expect(frameElements(document).map((f) => f.id)).toEqual(["one", "two"]);
  });

  it("marks each child frame, posts it its id, and takes the marks off again", () => {
    const f = frame("f");
    f.setAttribute("src", "/inner.html");
    document.body.append(f);
    const posted: unknown[] = [];
    Object.defineProperty(f, "contentWindow", { value: { postMessage: (m: unknown) => posted.push(m) } });
    const api = createContentApi(window);
    const marked = api.mark("n1");
    expect(marked).toHaveLength(1);
    expect(marked[0]!.src).toBe("/inner.html");
    expect(f.getAttribute(FRAME_ATTRIBUTE)).toBe(marked[0]!.id);
    expect(posted).toEqual([{ [MESSAGE_KEY]: marked[0]!.id, nonce: "n1" }]);
    api.unmark();
    expect(f.hasAttribute(FRAME_ATTRIBUTE)).toBe(false);
  });

  it("takes its id only from its parent, and only for the nonce asked about", () => {
    const parent = {} as Window;
    const win = new EventTarget() as unknown as Window;
    Object.assign(win, { parent });
    const api = createContentApi(win);
    const send = (data: unknown, source: unknown) => win.dispatchEvent(Object.assign(new Event("message"), { data, source }));
    send({ [MESSAGE_KEY]: "evil", nonce: "n1" }, {} as Window);
    expect(api.frameId("n1")).toBeNull();
    send({ [MESSAGE_KEY]: "good", nonce: "n1" }, parent);
    expect(api.frameId("n1")).toBe("good");
    expect(api.frameId("n2")).toBeNull();
  });
});
