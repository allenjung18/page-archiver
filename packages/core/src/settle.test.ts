import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackNetwork } from "./settle.ts";

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

  it("ignores a finish it never saw start, and stops counting after dispose", () => {
    const { em, net } = setup();
    em.emit("requestfinished", {});
    expect(net.inflight()).toBe(0);
    net.dispose();
    em.emit("request", {});
    expect(net.inflight()).toBe(0);
  });
});
