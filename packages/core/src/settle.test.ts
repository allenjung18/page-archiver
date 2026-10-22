import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import { settle, trackNetwork, type NetworkTracker } from "./settle.ts";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const em = new EventEmitter();
  const net = trackNetwork(em, () => Date.now());
  return { em, net };
}

describe("trackNetwork", () => {
  it("is idle after the quiet period with nothing in flight", async () => {
    const { net } = setup();
    let done: boolean | undefined;
    void net.waitForIdle(500, 15_000).then((v) => (done = v));
    await vi.advanceTimersByTimeAsync(499);
    expect(done).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2);
    expect(done).toBe(true);
  });

  it("waits for in-flight requests, then the quiet period after the last one", async () => {
    const { em, net } = setup();
    const a = {};
    em.emit("request", a);
    let done: boolean | undefined;
    void net.waitForIdle(500, 15_000).then((v) => (done = v));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(done).toBeUndefined();
    expect(net.inflight()).toBe(1);
    em.emit("requestfinished", a);
    await vi.advanceTimersByTimeAsync(400);
    expect(done).toBeUndefined();
    await vi.advanceTimersByTimeAsync(101);
    expect(done).toBe(true);
  });

  it("a request that starts during the quiet period restarts it", async () => {
    const { em, net } = setup();
    let done: boolean | undefined;
    void net.waitForIdle(500, 15_000).then((v) => (done = v));
    await vi.advanceTimersByTimeAsync(300);
    const b = {};
    em.emit("request", b);
    em.emit("requestfailed", b);
    await vi.advanceTimersByTimeAsync(300);
    expect(done).toBeUndefined();
    await vi.advanceTimersByTimeAsync(201);
    expect(done).toBe(true);
  });

  it("gives up at the cap when a request never finishes", async () => {
    const { em, net } = setup();
    em.emit("request", {});
    let done: boolean | undefined;
    void net.waitForIdle(500, 15_000).then((v) => (done = v));
    await vi.advanceTimersByTimeAsync(14_999);
    expect(done).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2);
    expect(done).toBe(false);
  });

  it("a finish it never saw start does not restart the quiet period", async () => {
    const { em, net } = setup();
    let done: boolean | undefined;
    void net.waitForIdle(500, 15_000).then((v) => (done = v));
    await vi.advanceTimersByTimeAsync(300);
    em.emit("requestfinished", {});
    em.emit("requestfailed", {});
    await vi.advanceTimersByTimeAsync(201);
    expect(done, "idle 500 ms after the start, not 500 ms after the stray finish").toBe(true);
  });

  it("ignores a finish it never saw start, and stops counting after dispose", () => {
    const { em, net } = setup();
    em.emit("requestfinished", {});
    expect(net.inflight()).toBe(0);
    net.dispose();
    em.emit("request", {});
    expect(net.inflight()).toBe(0);
  });
});

describe("settle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("goes ahead with a warning when a web font starts loading and never answers", async () => {
    // the page's own globals, for the functions settle runs in it: one screen, no images, and a
    // font whose request never ends, so document.fonts.ready never settles
    vi.stubGlobal("window", { innerHeight: 800, scrollTo: () => undefined });
    vi.stubGlobal("document", { documentElement: { scrollHeight: 800 }, fonts: { ready: new Promise(() => undefined) }, images: [] });
    vi.stubGlobal("requestAnimationFrame", (f: () => void) => setTimeout(f, 16));
    const page = { evaluate: (fn: (arg: unknown) => unknown, arg: unknown) => Promise.resolve(fn(arg)) } as unknown as Page;
    const network: NetworkTracker = { inflight: () => 0, waitForIdle: async () => true, dispose: () => undefined };
    let warnings: string[] | undefined;
    void settle(page, network, { dismissDefaults: false }).then((w) => (warnings = w));
    await vi.advanceTimersByTimeAsync(4_900);
    expect(warnings, "the fonts wait is bounded, not skipped").toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(warnings, "settle still waiting on document.fonts.ready").toEqual(["web fonts not ready after 5 s; captured anyway"]);
  });
});
