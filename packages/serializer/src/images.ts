// Images as the browser shows them now: the candidate it chose from srcset/<picture>
// (img.currentSrc), with every attribute that would make a reader pick again removed.

/** Attributes lazy-loading scripts commonly keep the real URL in, in the order tried. */
export const LAZY_SRC_ATTRIBUTES = ["data-src", "data-lazy-src", "data-original", "data-lazyload"] as const;

/** Attributes that would make the archived <img> choose or defer again. */
const CHOOSER_ATTRIBUTES = ["srcset", "sizes", "loading"] as const;

/**
 * Writes the URL the live image is showing into the clone's src and strips srcset, sizes and
 * loading. When the live image never got a URL (a lazy image that was never scrolled to) the
 * first common data-src pattern is used instead. Returns the absolute URL written, or null when
 * the image has none.
 */
export function freezeImage(live: HTMLImageElement, clone: Element): string | null {
  let url = live.currentSrc || (live.getAttribute("src") ? live.src : "");
  if (!url) {
    for (const name of LAZY_SRC_ATTRIBUTES) {
      const value = live.getAttribute(name);
      if (value && value.trim()) {
        url = absolute(value.trim(), live.baseURI);
        break;
      }
    }
  }
  for (const name of CHOOSER_ATTRIBUTES) clone.removeAttribute(name);
  if (!url) return null;
  clone.setAttribute("src", url);
  return url;
}

/**
 * Replaces a cloned <picture> with its <img> (whose src is already the chosen candidate), so the
 * archive has no <source> to choose from. A picture without an img is left alone.
 */
export function collapsePicture(clonePicture: Element): void {
  const img = [...clonePicture.children].find((c) => c.localName === "img");
  if (!img) return;
  clonePicture.replaceWith(img);
}

function absolute(url: string, base: string): string {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}
