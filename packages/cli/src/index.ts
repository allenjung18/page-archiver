#!/usr/bin/env node
// pa: save | list | search | open | tag | reindex | serve | import. Commands land chunk by chunk.
import { basename } from "node:path";
import { capture, serializeMeta, type Archive } from "@page-archiver/core";
import { parseSaveArgs, UsageError } from "./args.ts";

const USAGE = `usage: pa <command> [args]

commands:
  save <url> -o <file>   capture a page into one self-contained HTML file
  save <url> -d <dir>    capture a page into a folder: archive.html, reader.html, archive.mhtml,
                         shot.png, shot.pdf and meta.json
                         [--tag <tag>]... [--no-reader] [--no-mhtml] [--no-shot] [--no-pdf]
                         either form: [--profile <dir>] [--wait-for <selector>] [--dismiss <selector>]...
                         [--no-default-dismiss] [--headed]
not implemented yet: list, search, open, tag, reindex, serve, import`;

function size(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The files a folder capture wrote, in the order they are listed. */
function listFiles(archive: Archive): Array<{ path: string; bytes: number }> {
  const f = archive.files!;
  const b = archive.meta.bytes;
  const out = [{ path: f.archive, bytes: b.archive }];
  if (f.reader) out.push({ path: f.reader, bytes: b.reader ?? 0 });
  if (f.mhtml) out.push({ path: f.mhtml, bytes: b.mhtml ?? 0 });
  if (f.png) out.push({ path: f.png, bytes: b.png ?? 0 });
  if (f.pdf) out.push({ path: f.pdf, bytes: b.pdf ?? 0 });
  out.push({ path: f.meta, bytes: Buffer.byteLength(serializeMeta(archive.meta)) });
  return out;
}

async function save(argv: string[]): Promise<number> {
  const args = parseSaveArgs(argv);
  const archive = await capture(args.url, {
    outFile: args.out,
    outDir: args.dir,
    extras: args.dir ? { reader: !args.skip.reader, mhtml: !args.skip.mhtml, png: !args.skip.png, pdf: !args.skip.pdf } : undefined,
    tags: args.tags,
    profileDir: args.profile,
    headed: args.headed,
    waitFor: args.waitFor,
    dismiss: args.dismiss,
    dismissDefaults: args.defaultDismiss,
  });
  if (archive.files) {
    console.log(`saved ${args.dir}`);
    for (const f of listFiles(archive)) console.log(`  ${basename(f.path)} (${size(f.bytes)})`);
  } else {
    console.log(`saved ${archive.file} (${size(Buffer.byteLength(archive.html))})`);
  }
  for (const w of archive.warnings) console.error(`warning: ${w}`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return 0;
  }
  try {
    if (command === "save") return await save(rest);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`pa: ${err.message}`);
      return 2;
    }
    console.error(`pa: ${(err as Error).message}`);
    return 1;
  }
  console.error(`pa: '${command}' is not implemented yet`);
  return 2;
}

process.exitCode = await main(process.argv.slice(2));
