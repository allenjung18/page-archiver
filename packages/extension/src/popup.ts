// The toolbar popup: Save (with tags), the tab's last result (saved, downloaded instead, or
// failed), "Open in library", and the server's address. The save itself runs in the service
// worker, so closing the popup does not stop it. `popup.html?tab=<id>` targets that tab instead
// of the active one (how the end-to-end test opens it in a tab of its own).
import type { Chrome, Tab } from "./chrome.ts";
import { resultKey, SERVER_KEY, type SaveMessage, type SaveResult } from "./protocol.ts";
import { DEFAULT_SERVER, normalizeServer } from "./server.ts";

declare const chrome: Chrome;

/** Tags typed as "a, b c" (commas or spaces), trimmed, without empties or repeats. */
export function parseTags(text: string): string[] {
  return [...new Set(text.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean))];
}

/** What the status line says about a result. */
export function describe(result: SaveResult): string {
  const notes = result.kind !== "failed" && result.warnings.length ? ` (${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"})` : "";
  switch (result.kind) {
    case "saved":
      return `Saved ✓${notes}`;
    case "downloaded":
      return `Downloaded ${result.filename.split("/").pop()} instead: ${result.reason}${notes}`;
    case "failed":
      return `Not saved: ${result.error}`;
  }
}

async function targetTab(): Promise<Tab | undefined> {
  const param = new URLSearchParams(location.search).get("tab");
  if (param && /^\d+$/.test(param)) return chrome.tabs.get(Number(param));
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function main(): Promise<void> {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const page = $<HTMLParagraphElement>("page");
  const tagsInput = $<HTMLInputElement>("tags");
  const saveButton = $<HTMLButtonElement>("save");
  const status = $<HTMLParagraphElement>("status");
  const open = $<HTMLButtonElement>("open");
  const server = $<HTMLInputElement>("server");

  const tab = await targetTab();
  const savable = tab?.id !== undefined && /^https?:\/\//i.test(tab.url ?? "");
  page.textContent = tab?.title || tab?.url || "";
  page.title = tab?.url ?? "";
  if (!savable) {
    saveButton.disabled = true;
    status.textContent = "Only http and https pages can be saved.";
  }

  const show = (result: SaveResult) => {
    status.dataset["kind"] = result.kind;
    status.textContent = describe(result);
    open.hidden = result.kind !== "saved";
    if (result.kind === "saved") open.onclick = () => void chrome.tabs.create({ url: result.libraryUrl });
  };

  if (savable) {
    const last = (await chrome.storage.session.get(resultKey(tab.id!)))[resultKey(tab.id!)] as SaveResult | undefined;
    if (last && last.url === tab.url) show(last);
  }

  const stored = (await chrome.storage.local.get(SERVER_KEY))[SERVER_KEY];
  server.value = typeof stored === "string" && stored ? stored : DEFAULT_SERVER;
  $<HTMLFormElement>("server-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const value = normalizeServer(server.value);
    if (!value) {
      server.setCustomValidity("An http:// address, such as " + DEFAULT_SERVER);
      server.reportValidity();
      return;
    }
    server.setCustomValidity("");
    server.value = value;
    void chrome.storage.local.set({ [SERVER_KEY]: value });
  });

  saveButton.addEventListener("click", async () => {
    if (!savable) return;
    saveButton.disabled = true;
    open.hidden = true;
    delete status.dataset["kind"];
    status.textContent = "Saving…";
    const message: SaveMessage = { type: "page-archiver:save", tabId: tab.id!, tags: parseTags(tagsInput.value) };
    try {
      const result = (await chrome.runtime.sendMessage(message)) as SaveResult | undefined;
      show(result ?? { kind: "failed", url: tab.url ?? "", error: "the extension's service worker did not answer" });
    } catch (err) {
      show({ kind: "failed", url: tab.url ?? "", error: (err as Error).message });
    } finally {
      saveButton.disabled = false;
    }
  });
}

if (typeof chrome !== "undefined" && chrome.runtime?.id) void main();
