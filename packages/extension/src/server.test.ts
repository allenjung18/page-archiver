import { describe, expect, it, vi } from "vitest";
import { SERVER_KEY, TOKEN_KEY } from "./protocol.ts";
import { ANSWER_TIMEOUT_MS, DEFAULT_SERVER, deliver, normalizeServer, tokenFromPage, type Fetch } from "./server.ts";
import { memoryStore } from "./testing.ts";

const T1 = "a".repeat(48);
const T2 = "b".repeat(48);
const upload = { url: "https://site.test/p", html: "<!doctype html><p>x", tags: ["t"] };

/** A stand-in for `pa serve`: its page carries `token`; saves need it. */
function fakeServer(state: { token: string; down?: boolean; status?: number }) {
  const calls: Array<{ url: string; auth: string | null; body?: unknown }> = [];
  const fetchFn: Fetch = async (url, init) => {
    if (state.down) throw new TypeError("Failed to fetch");
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ url, auth, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (init?.method === "GET") return new Response(`<!doctype html><head><meta name="pa-token" content="${state.token}"></head>`);
    if (auth !== `Bearer ${state.token}`) return Response.json({ error: "a write needs the server's token" }, { status: 401 });
    if (state.status) return Response.json({ error: "disk full" }, { status: state.status });
    return Response.json({ page: { id: "abc123abc123" }, warnings: ["w"] }, { status: 201 });
  };
  return { fetchFn, calls };
}

describe("normalizeServer and tokenFromPage", () => {
  it("keeps an http(s) origin with a trailing slash, and nothing else", () => {
    expect(normalizeServer(" http://127.0.0.1:5000/x?y ")).toBe("http://127.0.0.1:5000/");
    expect(normalizeServer("ftp://a/")).toBeNull();
    expect(normalizeServer("nope")).toBeNull();
  });

  it("reads the token from the reader UI's page", () => {
    expect(tokenFromPage(`<meta name="pa-token" content="${T1}">`)).toBe(T1);
    expect(tokenFromPage(`<meta name="pa-token" content="">`)).toBeNull();
  });
});

describe("deliver", () => {
  it("pairs once, then posts with the token to the default server", async () => {
    const store = memoryStore();
    const s = fakeServer({ token: T1 });
    expect(await deliver(s.fetchFn, store, upload)).toEqual({ kind: "saved", pageId: "abc123abc123", libraryUrl: DEFAULT_SERVER, warnings: ["w"] });
    expect(s.calls.map((c) => c.url)).toEqual([DEFAULT_SERVER, `${DEFAULT_SERVER}api/save`]);
    expect(s.calls[1]!.body).toEqual(upload);
    expect(store.data[TOKEN_KEY]).toBe(T1);
    await deliver(s.fetchFn, store, upload);
    expect(s.calls.map((c) => c.url)).toHaveLength(3); // no second pairing
  });

  it("pairs again when the token is refused (the server restarted), and uses the server set", async () => {
    const store = memoryStore({ [TOKEN_KEY]: T1, [SERVER_KEY]: "http://127.0.0.1:5999" });
    const s = fakeServer({ token: T2 });
    expect((await deliver(s.fetchFn, store, upload)).kind).toBe("saved");
    expect(s.calls.map((c) => [c.url, c.auth])).toEqual([
      ["http://127.0.0.1:5999/api/save", `Bearer ${T1}`],
      ["http://127.0.0.1:5999/", null],
      ["http://127.0.0.1:5999/api/save", `Bearer ${T2}`],
    ]);
    expect(store.data[TOKEN_KEY]).toBe(T2);
  });

  it("says unreachable when nothing answers, and refused when the server says no", async () => {
    expect(await deliver(fakeServer({ token: T1, down: true }).fetchFn, memoryStore(), upload)).toMatchObject({ kind: "unreachable", reason: expect.stringMatching(/not running/) });
    expect(await deliver(fakeServer({ token: T1, status: 500 }).fetchFn, memoryStore(), upload)).toEqual({ kind: "refused", reason: "HTTP 500: disk full" });
  });

  it("aborts a request the server never answers after ANSWER_TIMEOUT_MS, and sends no credentials", async () => {
    const store = memoryStore({ [TOKEN_KEY]: T1 });
    const clock = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(clock.signal);
    let seen: RequestInit | undefined;
    // a server that never answers: the request ends only when its signal aborts
    const hung: Fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        seen = init;
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    try {
      const outcome = deliver(hung, store, upload);
      await new Promise((r) => setTimeout(r, 20));
      expect(timeout, "the bound is ANSWER_TIMEOUT_MS").toHaveBeenCalledWith(ANSWER_TIMEOUT_MS);
      expect(seen?.credentials).toBe("omit");
      clock.abort(new DOMException("The operation timed out.", "TimeoutError"));
      const result = await Promise.race([outcome, new Promise<string>((r) => setTimeout(() => r("still hanging"), 300))]);
      expect(result).toMatchObject({ kind: "unreachable", reason: expect.stringMatching(/did not answer in 120 s/) });
    } finally {
      timeout.mockRestore();
    }
  });

  it("says the server did not answer in time, not that it is not running, when the POST times out", async () => {
    const store = memoryStore({ [TOKEN_KEY]: T1 });
    const slow: Fetch = async (_url, init) => {
      if (init?.method === "POST") throw new DOMException("The operation timed out.", "TimeoutError");
      throw new Error("unexpected");
    };
    const res = await deliver(slow, store, upload);
    expect(res).toMatchObject({ kind: "unreachable", reason: expect.stringMatching(/^the library server did not answer in 120 s, so it may have saved the page as well/) });
    expect(res.kind === "unreachable" && res.reason).not.toMatch(/not running/);
  });
});
