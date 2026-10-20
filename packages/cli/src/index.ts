#!/usr/bin/env node
// pa: save | list | search | open | tag | reindex | serve | import. Commands land chunk by chunk.
import { capture } from "@page-archiver/core";
import { parseSaveArgs, UsageError } from "./args.ts";

const USAGE = `usage: pa <command> [args]

commands:
  save <url> -o <file>   capture a page into one self-contained HTML file
                         [--profile <dir>] [--wait-for <selector>] [--dismiss <selector>]... [--no-default-dismiss] [--headed]
not implemented yet: list, search, open, tag, reindex, serve, import`;

function size(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

async function save(argv: string[]): Promise<number> {
  const args = parseSaveArgs(argv);
  const archive = await capture(args.url, {
    outFile: args.out,
    profileDir: args.profile,
    headed: args.headed,
    waitFor: args.waitFor,
    dismiss: args.dismiss,
    dismissDefaults: args.defaultDismiss,
  });
  console.log(`saved ${archive.file} (${size(Buffer.byteLength(archive.html))})`);
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
