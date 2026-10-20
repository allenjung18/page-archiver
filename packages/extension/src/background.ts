// The service worker: the "Save page to archive" context menu, the popup's save requests, and
// each tab's last result (for the popup to show again) and badge.
import type { Chrome, MessageSender } from "./chrome.ts";
import { isSaveMessage, resultKey, type SaveResult } from "./protocol.ts";
import { saveTab, type Env } from "./save.ts";

declare const chrome: Chrome;

export const MENU_ID = "page-archiver-save";

const BADGE: Record<SaveResult["kind"], { text: string; color: string }> = {
  saved: { text: "✓", color: "#2f7d32" },
  downloaded: { text: "↓", color: "#8a6d00" },
  failed: { text: "!", color: "#b3261e" },
};

/** True for a message from one of the extension's own pages, never from a content script. */
export function fromOwnPage(c: Pick<Chrome, "runtime">, sender: MessageSender): boolean {
  return sender.id === c.runtime.id && (sender.url ?? "").startsWith(`chrome-extension://${c.runtime.id}/`);
}

/** Wires the extension's events to saveTab; returns the save function (tests call it). */
export function install(c: Chrome, env: Env): (tabId: number, tags: readonly string[]) => Promise<SaveResult> {
  // one save per tab at a time: a second click while saving waits for the first's result
  const running = new Map<number, Promise<SaveResult>>();

  const save = (tabId: number, tags: readonly string[]): Promise<SaveResult> => {
    const busy = running.get(tabId);
    if (busy) return busy;
    const job = (async () => {
      await c.action.setBadgeText({ tabId, text: "…" }).catch(() => undefined);
      const result = await saveTab(env, tabId, tags);
      await c.storage.session.set({ [resultKey(tabId)]: result }).catch(() => undefined);
      const badge = BADGE[result.kind];
      await c.action.setBadgeBackgroundColor({ tabId, color: badge.color }).catch(() => undefined);
      await c.action.setBadgeText({ tabId, text: badge.text }).catch(() => undefined);
      return result;
    })().finally(() => running.delete(tabId));
    running.set(tabId, job);
    return job;
  };

  c.runtime.onInstalled.addListener(() => {
    c.contextMenus.removeAll(() => {
      c.contextMenus.create({ id: MENU_ID, title: "Save page to archive", contexts: ["page"] });
    });
  });

  c.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== MENU_ID || tab?.id === undefined) return;
    void save(tab.id, []);
  });

  c.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // only the extension's own pages (the popup) may ask; a content script's sender is the page
    if (!fromOwnPage(c, sender) || !isSaveMessage(message)) return undefined;
    save(message.tabId, message.tags).then(sendResponse, (err: Error) => sendResponse({ kind: "failed", url: "", error: err.message }));
    return true;
  });

  return save;
}

if (typeof chrome !== "undefined" && chrome.runtime?.id) {
  install(chrome, { tabs: chrome.tabs, scripting: chrome.scripting, storage: chrome.storage, downloads: chrome.downloads, fetch: (i, init) => fetch(i, init) });
}
