// The pictures of a capture: a full-page PNG of the live page as it looked, and a PDF of it
// (Chromium prints PDFs only when headless; a headed capture skips it with a warning).
import type { Page } from "playwright";

/** File names inside a capture's folder. */
export const PNG_FILE = "shot.png";
export const PDF_FILE = "shot.pdf";

/** A full-page PNG of the page, animations stopped and the caret hidden. */
export function screenshotPng(page: Page): Promise<Buffer> {
  return page.screenshot({ fullPage: true, animations: "disabled", caret: "hide", type: "png" });
}

/** The page printed to PDF with its own backgrounds, at its own @page size or A4. */
export function printPdf(page: Page): Promise<Buffer> {
  return page.pdf({ printBackground: true, preferCSSPageSize: true, format: "A4" });
}
