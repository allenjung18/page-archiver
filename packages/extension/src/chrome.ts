// The slice of the Chrome extension API this extension uses, typed here instead of pulling in
// the whole of @types/chrome. save.ts takes these as parameters, so its tests pass fakes.

export interface Tab {
  id?: number;
  url?: string;
  title?: string;
}

export interface InjectionResult<T> {
  frameId: number;
  result?: T;
}

export interface ScriptTarget {
  tabId: number;
  allFrames?: boolean;
}

export interface Scripting {
  executeScript(details: { target: ScriptTarget; files: string[] }): Promise<InjectionResult<unknown>[]>;
  executeScript<A extends unknown[], R>(details: { target: ScriptTarget; func: (...args: A) => R; args?: A }): Promise<InjectionResult<Awaited<R>>[]>;
}

export interface StorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface Downloads {
  download(options: { url: string; filename: string; conflictAction?: "uniquify" | "overwrite" | "prompt"; saveAs?: boolean }): Promise<number>;
}

export interface Event<F> {
  addListener(listener: F): void;
}

export interface MessageSender {
  id?: string;
  /** The sending page's or frame's URL. */
  url?: string;
  tab?: Tab;
}

export interface Chrome {
  runtime: {
    id: string;
    onInstalled: Event<() => void>;
    onMessage: Event<(message: unknown, sender: MessageSender, sendResponse: (response: unknown) => void) => boolean | undefined>;
    sendMessage(message: unknown): Promise<unknown>;
  };
  tabs: {
    get(tabId: number): Promise<Tab>;
    query(q: { active?: boolean; currentWindow?: boolean }): Promise<Tab[]>;
    create(p: { url: string }): Promise<Tab>;
  };
  scripting: Scripting;
  storage: { local: StorageArea; session: StorageArea };
  downloads: Downloads;
  contextMenus: {
    create(p: { id: string; title: string; contexts: string[] }, callback?: () => void): void;
    removeAll(callback?: () => void): void;
    onClicked: Event<(info: { menuItemId: string | number }, tab?: Tab) => void>;
  };
  action: {
    setBadgeText(p: { tabId?: number; text: string }): Promise<void>;
    setBadgeBackgroundColor(p: { tabId?: number; color: string }): Promise<void>;
  };
}
