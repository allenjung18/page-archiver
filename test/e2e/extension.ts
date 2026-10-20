// The Chrome extension in a real Chromium: a persistent context in a throwaway profile under the
// system temp folder, with only the built extension (packages/extension/dist/unpacked) loaded.
// Downloads go to a folder inside that profile, never to the user's own Downloads.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";
import type { Chrome } from "../../packages/extension/src/chrome.ts";
import { VIEWPORT } from "./env.ts";

/** The extension API as the service worker sees it (evaluate() runs these functions there). */
export interface DownloadItem {
  id: number;
  state: "in_progress" | "interrupted" | "complete";
  filename: string;
  error?: string;
}
declare const chrome: Chrome & { downloads: { search(q: { id?: number }): Promise<DownloadItem[]> } };

export const EXTENSION_DIR = fileURLToPath(new URL("../../packages/extension/dist/unpacked/", import.meta.url));

export interface ExtensionBrowser {
  context: BrowserContext;
  /** The extension's service worker. */
  worker: Worker;
  extensionId: string;
  /** Where the profile sends downloads. */
  downloads: string;
  /** The tab id Chrome gave a page of this context. */
  tabId(page: Page): Promise<number>;
  /** Opens the popup in a tab of its own, aimed at tabId. */
  openPopup(tabId: number): Promise<Page>;
  /** Points the extension at a library server (an origin with a trailing slash). */
  setServer(url: string): Promise<void>;
  /** Waits for a download the extension started to finish; its file's absolute path. */
  downloaded(downloadId: number): Promise<string>;
  close(): Promise<void>;
}

export async function launchWithExtension(): Promise<ExtensionBrowser> {
  const root = mkdtempSync(join(tmpdir(), "pa-extension-"));
  const profile = join(root, "profile");
  const downloads = join(root, "downloads");
  mkdirSync(join(profile, "Default"), { recursive: true });
  mkdirSync(downloads, { recursive: true });
  writeFileSync(
    join(profile, "Default", "Preferences"),
    JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true }, savefile: { default_directory: downloads } }),
  );
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, {
      // the full Chromium build: the headless shell cannot load extensions
      channel: "chromium",
      headless: true,
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      acceptDownloads: true,
      downloadsPath: downloads,
      args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
    });
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(worker.url()).host;
    const ctx = context;
    return {
      context: ctx,
      worker,
      extensionId,
      downloads,
      async tabId(page) {
        const url = page.url();
        const id = await worker.evaluate(async (u) => {
          const tabs = await chrome.tabs.query({});
          return tabs.find((t) => t.url === u)?.id ?? null;
        }, url);
        if (id === null) throw new Error(`no tab for ${url}`);
        return id;
      },
      async openPopup(tabId) {
        const popup = await ctx.newPage();
        await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${tabId}`);
        return popup;
      },
      async setServer(url) {
        await worker.evaluate((u) => chrome.storage.local.set({ server: u }), url);
      },
      async downloaded(downloadId) {
        for (let i = 0; i < 200; i++) {
          const [item] = await worker.evaluate((id) => chrome.downloads.search({ id }), downloadId);
          if (item?.state === "complete") return item.filename;
          if (item?.state === "interrupted") throw new Error(`download ${downloadId} failed: ${item.error}`);
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error(`download ${downloadId} did not finish in 20 s`);
      },
      async close() {
        await ctx.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (err) {
    await context?.close();
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
}
