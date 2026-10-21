import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createRecorder, type ResponseLike, type ResponseSource } from "./recorder.ts";
import { createResolver } from "./resources.ts";

interface FakeOpts {
  status?: number;
  type?: string;
  body?: Buffer | Error;
  length?: number;
  from?: string[];
}

function response(url: string, o: FakeOpts = {}): ResponseLike {
  const body = o.body ?? Buffer.from(`body of ${url}`);
  const chain = (o.from ?? []).reduceRight<{ url(): string; redirectedFrom(): unknown } | null>(
    (prev, u) => ({ url: () => u, redirectedFrom: () => prev }),
    null,
  );
  const headers: Record<string, string> = { "content-type": o.type ?? "image/png" };
  if (o.length !== undefined) headers["content-length"] = String(o.length);
  return {
    url: () => url,
    status: () => o.status ?? 200,
    headers: () => headers,
    body: async () => {
      if (body instanceof Error) throw body;
      return body;
    },
    request: () => ({ redirectedFrom: () => chain as never }),
  };
}

function fakePage() {
  const em = new EventEmitter();
  const page: ResponseSource = {
    on: (e, fn) => em.on(e, fn as never),
    off: (e, fn) => em.off(e, fn as never),
  };
  return { page, emit: (r: ResponseLike) => em.emit("response", r) };
}

describe("recorder", () => {
  it("returns the recorded body, status and type, ignoring the fragment", async () => {
    const { page, emit } = fakePage();
    const rec = createRecorder(page);
    emit(response("http://a.test/x.png", { type: "image/png" }));
    const got = await rec.get("http://a.test/x.png#frag");
    expect(got).toMatchObject({ kind: "hit", status: 200, mime: "image/png" });
    expect(got.kind === "hit" && got.bytes.toString()).toBe("body of http://a.test/x.png");
  });

  it("says whether a URL was recorded successfully, without reading a body", () => {
    const { page, emit } = fakePage();
    const rec = createRecorder(page);
    emit(response("http://a.test/f.woff2", { body: new Error("never read") }));
    emit(response("http://a.test/missing.woff", { status: 404 }));
    emit(response("http://a.test/final.woff2", { from: ["http://a.test/start.woff2"] }));
    expect(rec.has("http://a.test/f.woff2#x")).toBe(true);
    expect(rec.has("http://a.test/missing.woff")).toBe(false);
    expect(rec.has("http://a.test/start.woff2")).toBe(true);
    expect(rec.has("http://a.test/never")).toBe(false);
    // saw: any response, an HTTP error too
    expect(rec.saw("http://a.test/missing.woff")).toBe(true);
    expect(rec.saw("http://a.test/start.woff2#y")).toBe(true);
    expect(rec.saw("http://a.test/never")).toBe(false);
  });

  it("is a miss for a URL it never saw, and ignores data: and redirects", async () => {
    const { page, emit } = fakePage();
    const rec = createRecorder(page);
    emit(response("data:image/png;base64,AA"));
    emit(response("http://a.test/old", { status: 301 }));
    expect((await rec.get("http://a.test/nope")).kind).toBe("miss");
    expect(rec.urls()).toEqual([]);
  });

  it("follows a redirect chain to the final response", async () => {
    const { page, emit } = fakePage();
    const rec = createRecorder(page);
    emit(response("http://a.test/final.png", { from: ["http://a.test/one", "http://a.test/two"] }));
    expect((await rec.get("http://a.test/one")).kind).toBe("hit");
    expect((await rec.get("http://a.test/two")).kind).toBe("hit");
  });

  it("never lets an error replace a success, but a success replaces an error", async () => {
    const { page, emit } = fakePage();
    const rec = createRecorder(page);
    emit(response("http://a.test/a", { body: Buffer.from("good") }));
    emit(response("http://a.test/a", { status: 500 }));
    emit(response("http://a.test/b", { status: 404 }));
    expect((await rec.get("http://a.test/b"))).toMatchObject({ kind: "unusable", reason: "HTTP 404", refetch: false });
    emit(response("http://a.test/b", { body: Buffer.from("later") }));
    const a = await rec.get("http://a.test/a");
    const b = await rec.get("http://a.test/b");
    expect(a.kind === "hit" && a.bytes.toString()).toBe("good");
    expect(b.kind === "hit" && b.bytes.toString()).toBe("later");
  });

  it("refuses a resource over the per-resource cap, by header and by body", async () => {
    const { page, emit } = fakePage();
    const rec = createRecorder(page, { resourceCap: 10 });
    emit(response("http://a.test/big-header", { length: 11, body: Buffer.alloc(5) }));
    emit(response("http://a.test/big-body", { body: Buffer.alloc(11) }));
    emit(response("http://a.test/fits", { body: Buffer.alloc(10) }));
    expect(await rec.get("http://a.test/big-header")).toMatchObject({ kind: "unusable", refetch: false });
    expect(await rec.get("http://a.test/big-body")).toMatchObject({ kind: "unusable", refetch: false });
    expect((await rec.get("http://a.test/fits")).kind).toBe("hit");
  });

  it("stops handing out bodies at the total cap", async () => {
    const { page, emit } = fakePage();
    const rec = createRecorder(page, { totalCap: 15 });
    emit(response("http://a.test/1", { body: Buffer.alloc(10) }));
    emit(response("http://a.test/2", { body: Buffer.alloc(10) }));
    emit(response("http://a.test/3", { body: Buffer.alloc(5) }));
    expect((await rec.get("http://a.test/1")).kind).toBe("hit");
    expect(await rec.get("http://a.test/2")).toMatchObject({ kind: "unusable", reason: expect.stringContaining("total cap") });
    expect((await rec.get("http://a.test/3")).kind).toBe("hit");
    expect(rec.bytesRead()).toBe(15);
  });

  it("marks a body Chromium no longer holds as refetchable", async () => {
    const { page, emit } = fakePage();
    const rec = createRecorder(page);
    emit(response("http://a.test/gone", { body: new Error("No resource with given identifier") }));
    expect(await rec.get("http://a.test/gone")).toMatchObject({ kind: "unusable", refetch: true });
  });

  it("stops recording after stop()", async () => {
    const { page, emit } = fakePage();
    const rec = createRecorder(page);
    rec.stop();
    emit(response("http://a.test/late"));
    expect((await rec.get("http://a.test/late")).kind).toBe("miss");
  });
});

describe("resolver", () => {
  it("uses the recorder, falls back to a fetch on a miss, and warns on failure", async () => {
    const { page, emit } = fakePage();
    const rec = createRecorder(page);
    emit(response("http://a.test/rec.png"));
    emit(response("http://a.test/404.png", { status: 404 }));
    const fetched: string[] = [];
    const res = createResolver({
      recorder: rec,
      fallback: async (url) => {
        fetched.push(url);
        if (url.endsWith("down.png")) throw new Error("ECONNREFUSED");
        return { status: 200, mime: "image/gif", bytes: Buffer.from("GIF89a") };
      },
    });
    expect((await res.get("http://a.test/rec.png"))?.bytes.toString()).toBe("body of http://a.test/rec.png");
    expect((await res.get("http://a.test/miss.png"))?.mime).toBe("image/gif");
    expect(await res.get("http://a.test/404.png")).toBeNull();
    expect(await res.get("http://a.test/down.png")).toBeNull();
    expect(fetched).toEqual(["http://a.test/miss.png", "http://a.test/down.png"]); // never re-fetches a 404
    expect(res.warnings).toHaveLength(2);
    expect(res.warnings.join("\n")).toMatch(/404\.png: HTTP 404; set aside/);
    expect(res.warnings.join("\n")).toMatch(/down\.png: fetch failed \(ECONNREFUSED\)/);
  });

  it("reads a URL once however often it is asked for", async () => {
    let calls = 0;
    const res = createResolver({
      recorder: { get: async (url) => (calls++, { kind: "hit", url, status: 200, mime: "image/png", bytes: Buffer.from("x") }) },
    });
    await Promise.all([res.get("http://a.test/x"), res.get("http://a.test/x"), res.get("http://a.test/x")]);
    expect(calls).toBe(1);
    expect(res.stats).toMatchObject({ recorded: 1, reused: 2 });
  });

  it("applies the total cap across recorded and fetched bytes", async () => {
    const res = createResolver({
      recorder: { get: async (url) => ({ kind: "miss", url }) },
      fallback: async () => ({ status: 200, mime: "image/png", bytes: Buffer.alloc(6) }),
      totalCap: 10,
    });
    expect(await res.get("http://a.test/1")).not.toBeNull();
    expect(await res.get("http://a.test/2")).toBeNull();
    expect(res.warnings[0]).toMatch(/total cap/);
  });
});
