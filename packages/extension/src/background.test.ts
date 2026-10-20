import { describe, expect, it, vi } from "vitest";
import { fromOwnPage, install, MENU_ID } from "./background.ts";
import type { Chrome } from "./chrome.ts";
import { memoryStore } from "./testing.ts";

vi.mock("./save.ts", () => ({
  saveTab: vi.fn(async (_env: unknown, tabId: number, tags: string[]) => ({ kind: "saved", url: `https://t.test/${tabId}`, title: "T", pageId: "p", libraryUrl: "http://127.0.0.1:47320/", warnings: tags })),
}));

function fakeChrome() {
  const listeners: Record<string, Array<(...a: never[]) => unknown>> = {};
  const on = (name: string) => ({ addListener: (f: (...a: never[]) => unknown) => (listeners[name] ??= []).push(f) });
  const menus: unknown[] = [];
  const badges: unknown[] = [];
  const c = {
    runtime: { id: "extid", onInstalled: on("installed"), onMessage: on("message"), sendMessage: async () => undefined },
    contextMenus: { create: (p: unknown) => menus.push(p), removeAll: (cb: () => void) => cb(), onClicked: on("clicked") },
    action: { setBadgeText: async (p: unknown) => void badges.push(p), setBadgeBackgroundColor: async () => undefined },
    storage: { local: memoryStore(), session: memoryStore() },
  } as unknown as Chrome;
  const fire = (name: string, ...args: unknown[]) => (listeners[name] ?? []).map((f) => (f as (...a: unknown[]) => unknown)(...args));
  return { c, fire, menus, badges };
}

describe("the service worker", () => {
  it("adds the context menu item on install, and saves the tab it is clicked in", async () => {
    const f = fakeChrome();
    install(f.c, {} as never);
    f.fire("installed");
    expect(f.menus).toEqual([{ id: MENU_ID, title: "Save page to archive", contexts: ["page"] }]);
    f.fire("clicked", { menuItemId: MENU_ID }, { id: 9 });
    await vi.waitFor(() => expect((f.c.storage.session as ReturnType<typeof memoryStore>).data["result:9"]).toMatchObject({ kind: "saved", url: "https://t.test/9" }));
    expect(f.badges.at(-1)).toEqual({ tabId: 9, text: "✓" });
    f.fire("clicked", { menuItemId: "something-else" }, { id: 10 });
    expect((f.c.storage.session as ReturnType<typeof memoryStore>).data["result:10"]).toBeUndefined();
  });

  it("answers the popup's save request, and nobody else's", async () => {
    const f = fakeChrome();
    install(f.c, {} as never);
    const msg = { type: "page-archiver:save", tabId: 3, tags: ["x"] };
    const answer = await new Promise((resolve) => expect(f.fire("message", msg, { id: "extid", url: "chrome-extension://extid/popup.html?tab=3" }, resolve)).toEqual([true]));
    expect(answer).toMatchObject({ kind: "saved", warnings: ["x"] });
    // a content script (its sender is the page) and another extension get no answer
    expect(f.fire("message", msg, { id: "extid", url: "https://evil.test/", tab: { id: 1 } }, () => undefined)).toEqual([undefined]);
    expect(f.fire("message", msg, { id: "other", url: "chrome-extension://other/x.html" }, () => undefined)).toEqual([undefined]);
    expect(f.fire("message", { type: "page-archiver:save", tabId: "3", tags: [] }, { id: "extid", url: "chrome-extension://extid/popup.html" }, () => undefined)).toEqual([undefined]);
  });

  it("fromOwnPage wants the extension's id and one of its own pages", () => {
    const c = { runtime: { id: "extid" } } as Chrome;
    expect(fromOwnPage(c, { id: "extid", url: "chrome-extension://extid/popup.html" })).toBe(true);
    expect(fromOwnPage(c, { id: "extid", url: "chrome-extension://extidx/popup.html" })).toBe(false);
    expect(fromOwnPage(c, { id: "extid" })).toBe(false);
  });
});
