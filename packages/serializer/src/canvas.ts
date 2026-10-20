// <canvas> keeps its picture only while a script holds it; the archive keeps it as an <img> of the
// bitmap (toDataURL), with the canvas's attributes, so it sits in the same box. A canvas that drew
// a cross-origin image without CORS is "tainted": the browser refuses to read it back, and the
// archive says so in a warning and keeps the canvas, which renders empty.

/** Marks an <img> that was a <canvas>. */
export const CANVAS_ATTRIBUTE = "data-page-archiver-canvas";

export type CanvasResult = { kind: "image"; dataUrl: string } | { kind: "tainted" } | { kind: "empty" };

/** Reads the live canvas's bitmap. A 0x0 canvas has none. */
export function readCanvas(canvas: HTMLCanvasElement): CanvasResult {
  if (!canvas.width || !canvas.height) return { kind: "empty" };
  try {
    const dataUrl = canvas.toDataURL("image/png");
    if (!dataUrl.startsWith("data:image/")) return { kind: "empty" };
    return { kind: "image", dataUrl };
  } catch {
    return { kind: "tainted" };
  }
}

/**
 * Replaces the cloned canvas with an <img> of the bitmap. The img keeps every attribute of the
 * canvas (id, class, style, and width/height, which size an img the way they size a canvas); the
 * canvas's fallback content goes, as it was never shown.
 */
export function canvasToImage(clone: Element, dataUrl: string): Element {
  const img = clone.ownerDocument.createElement("img");
  for (const a of Array.from(clone.attributes)) img.setAttribute(a.name, a.value);
  img.setAttribute("src", dataUrl);
  img.setAttribute(CANVAS_ATTRIBUTE, "");
  if (!img.hasAttribute("alt")) img.setAttribute("alt", "");
  clone.replaceWith(img);
  return img;
}
