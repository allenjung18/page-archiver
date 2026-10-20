// The MHTML copy: Chromium's own single-file format (CDP Page.captureSnapshot) of the live page,
// a second, independent archive that Chromium opens directly. parseMhtml() reads one back into
// its MIME parts, which is how the tests check the file is well formed.
import type { Page } from "playwright";

/** The file name of the MHTML copy inside a capture's folder. */
export const MHTML_FILE = "archive.mhtml";

/** The live page as MHTML, from Chromium's DevTools protocol. */
export async function captureMhtml(page: Page): Promise<string> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { data } = await cdp.send("Page.captureSnapshot", { format: "mhtml" });
    return data;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

export interface MhtmlPart {
  /** Header names lower-cased. */
  headers: Record<string, string>;
  /** The part's media type without parameters, lower-cased (e.g. "text/html"). */
  type: string;
  /** Content-Location: the URL the part stands for. */
  location: string | null;
  /** The decoded body. */
  body: Buffer;
}

export interface Mhtml {
  headers: Record<string, string>;
  boundary: string;
  parts: MhtmlPart[];
}

export class MhtmlError extends Error {}

/** Headers of a MIME header block (folded lines unfolded), names lower-cased. */
function parseHeaders(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  let last: string | null = null;
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      if (last === null) throw new MhtmlError(`continuation line before any header: ${JSON.stringify(line.slice(0, 60))}`);
      out[last] += " " + line.trim();
      continue;
    }
    const m = /^([!-9;-~]+):\s*(.*)$/.exec(line);
    if (!m) throw new MhtmlError(`not a header line: ${JSON.stringify(line.slice(0, 60))}`);
    last = m[1]!.toLowerCase();
    out[last] = m[2]!.trim();
  }
  return out;
}

/** A parameter of a structured header value, e.g. boundary of a Content-Type. */
function param(value: string, name: string): string | null {
  const m = new RegExp(`;\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i").exec(value);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

/** Splits a header block from its body at the first empty line. */
function splitHead(text: string): [string, string] {
  const m = /\r?\n\r?\n/.exec(text);
  if (!m) throw new MhtmlError("no empty line after the headers");
  return [text.slice(0, m.index), text.slice(m.index + m[0].length)];
}

function decodeQuotedPrintable(text: string): Buffer {
  const bytes: number[] = [];
  const soft = text.replace(/=\r?\n/g, "");
  for (let i = 0; i < soft.length; i++) {
    const c = soft.charCodeAt(i);
    if (c === 0x3d) {
      const hex = soft.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) throw new MhtmlError(`bad quoted-printable escape =${hex}`);
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else if (c > 0xff) {
      bytes.push(...Buffer.from(soft[i]!, "utf8"));
    } else {
      bytes.push(c);
    }
  }
  return Buffer.from(bytes);
}

function decodeBody(body: string, encoding: string): Buffer {
  switch (encoding) {
    case "quoted-printable":
      return decodeQuotedPrintable(body);
    case "base64": {
      const compact = body.replace(/\s+/g, "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) throw new MhtmlError("bad base64 body");
      return Buffer.from(compact, "base64");
    }
    case "":
    case "7bit":
    case "8bit":
    case "binary":
      return Buffer.from(body, "latin1");
    default:
      throw new MhtmlError(`unknown Content-Transfer-Encoding ${encoding}`);
  }
}

/**
 * Parses an MHTML file (a multipart/related MIME message) into its parts. Throws MhtmlError
 * on anything malformed: no multipart Content-Type or boundary, a missing closing delimiter, a
 * part without a Content-Type, or a body that does not decode.
 */
export function parseMhtml(text: string): Mhtml {
  const [headBlock, rest] = splitHead(text);
  const headers = parseHeaders(headBlock);
  const contentType = headers["content-type"] ?? "";
  if (!/^multipart\/related\b/i.test(contentType)) throw new MhtmlError(`not multipart/related: ${contentType || "no Content-Type"}`);
  const boundary = param(contentType, "boundary");
  if (!boundary) throw new MhtmlError("no boundary in the Content-Type");

  const delimiter = `--${boundary}`;
  const lines = rest.split(/\r?\n/);
  const chunks: string[][] = [];
  let current: string[] | null = null;
  let closed = false;
  for (const line of lines) {
    if (closed) break;
    if (line === `${delimiter}--` || line.trimEnd() === `${delimiter}--`) {
      if (current) chunks.push(current);
      current = null;
      closed = true;
    } else if (line === delimiter || line.trimEnd() === delimiter) {
      if (current) chunks.push(current);
      current = [];
    } else if (current) {
      current.push(line);
    }
  }
  if (!closed) throw new MhtmlError(`no closing delimiter ${delimiter}--`);
  if (chunks.length === 0) throw new MhtmlError("no parts");

  const parts = chunks.map((chunkLines, i): MhtmlPart => {
    const [partHead, partBody] = splitHead(chunkLines.join("\r\n"));
    const h = parseHeaders(partHead);
    const type = (h["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (!type) throw new MhtmlError(`part ${i + 1} has no Content-Type`);
    let body: Buffer;
    try {
      body = decodeBody(partBody, (h["content-transfer-encoding"] ?? "").toLowerCase());
    } catch (err) {
      throw new MhtmlError(`part ${i + 1} (${h["content-location"] ?? type}): ${(err as Error).message}`);
    }
    return { headers: h, type, location: h["content-location"] ?? null, body };
  });
  return { headers, boundary, parts };
}
