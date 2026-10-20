// Poster frames. Video and audio files are not archived (inline/html.ts sets their sources
// aside), so an archived <video> shows its poster or nothing. Before the snapshot, each visible
// video in every frame is screenshotted as the page shows it (the picture a playing video was on,
// or the poster a paused one showed), and the PNG is set on the live element as
// POSTER_FRAME_ATTRIBUTE, with the video's own aspect ratio as VIDEO_RATIO_ATTRIBUTE; the
// snapshot copies both, and inline/html.ts makes them the poster and the box's aspect-ratio. A
// screenshot of the element, not a canvas drawImage(), so a cross-origin video, which taints a
// canvas, works as well.
import type { Frame, Page } from "playwright";
import { POSTER_FRAME_ATTRIBUTE, VIDEO_RATIO_ATTRIBUTE } from "./inline/html.ts";

/** At most this many videos per page get a poster frame. */
export const MAX_POSTER_FRAMES = 20;
/** How long the videos of a frame may take to show their first picture. */
export const VIDEO_READY_MS = 3_000;

/**
 * Waits (capped) until every video that is loading has a picture; returns how many videos the frame
 * has. Counted through the same locator that picks them one by one below, which reaches into open
 * shadow roots (a video inside a player component); querySelectorAll would not.
 */
async function videosReady(frame: Frame): Promise<number> {
  return frame.locator("video").evaluateAll(async (videos: HTMLVideoElement[], capMs: number) => {
    const loading = videos.filter((v) => v.readyState < 2 && v.preload !== "none" && (v.currentSrc || v.src));
    await Promise.race([
      Promise.all(loading.map((v) => new Promise((r) => v.addEventListener("loadeddata", r, { once: true })))),
      new Promise((r) => setTimeout(r, capMs)),
    ]);
    return videos.length;
  }, VIDEO_READY_MS);
}

/**
 * Sets POSTER_FRAME_ATTRIBUTE on every visible <video> of every frame (at most MAX_POSTER_FRAMES).
 * Returns how many videos got one. A video that cannot be screenshotted is a warning, never a
 * failed capture.
 */
export async function capturePosterFrames(page: Page, warn: (message: string) => void): Promise<number> {
  let done = 0;
  for (const frame of page.frames()) {
    if (frame.isDetached()) continue;
    let count: number;
    try {
      count = await videosReady(frame);
    } catch {
      continue; // a frame that navigated away or went with its parent
    }
    for (let i = 0; i < count && done < MAX_POSTER_FRAMES; i++) {
      const video = frame.locator("video").nth(i);
      try {
        if (!(await video.isVisible())) continue;
        const box = await video.boundingBox();
        if (!box || box.width < 2 || box.height < 2) continue;
        const shows = await video.evaluate((v: HTMLVideoElement) => v.readyState >= 2 || Boolean(v.poster));
        if (!shows) continue;
        // a screenshot scrolls its element into view, the window and every box around it (a
        // carousel on its video slide): put them all back, or the snapshot freezes them there
        const restore = await video.evaluateHandle((v: HTMLVideoElement) => {
          const saved: [Element, number, number][] = [];
          for (let e: Element | null = v; e; ) {
            const root = e.getRootNode();
            e = e.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
            if (e) saved.push([e, e.scrollLeft, e.scrollTop]);
          }
          const x = window.scrollX;
          const y = window.scrollY;
          return () => {
            for (const [e, left, top] of saved) e.scrollTo({ left, top, behavior: "instant" });
            window.scrollTo({ left: x, top: y, behavior: "instant" });
          };
        });
        let png: Buffer;
        try {
          png = await video.screenshot({ timeout: 5_000 });
        } finally {
          await restore.evaluate((put) => put()).catch(() => undefined);
          await restore.dispose().catch(() => undefined);
        }
        await video.evaluate(
          (v: HTMLVideoElement, [frameName, ratioName, uri]) => {
            v.setAttribute(frameName, uri);
            if (v.videoWidth > 0 && v.videoHeight > 0) v.setAttribute(ratioName, `${v.videoWidth} / ${v.videoHeight}`);
          },
          [POSTER_FRAME_ATTRIBUTE, VIDEO_RATIO_ATTRIBUTE, `data:image/png;base64,${png.toString("base64")}`] as const,
        );
        done++;
      } catch (err) {
        const src = await video.evaluate((v: HTMLVideoElement) => v.currentSrc || v.src).catch(() => "");
        warn(`video ${src || `#${i + 1}`}: no poster frame (${(err as Error).message.split("\n")[0]})`);
      }
    }
  }
  return done;
}
