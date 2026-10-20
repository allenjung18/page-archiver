#!/usr/bin/env node
// pa: save | list | search | open | tag | reindex | import | serve.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, relative } from "node:path";
import { capture, READER_FILE, serializeMeta, type Archive } from "@page-archiver/core";
import { openLibrary, QueryError, resolveLibraryDir, type Library, type PageRecord, type SearchHit } from "@page-archiver/library";
import { startServer } from "@page-archiver/server";
import { parseLibraryArgs, parseSaveArgs, parseServeArgs, UsageError, type LibraryArgs, type SaveArgs, type ServeArgs } from "./args.ts";

const USAGE = `usage: pa <command> [args]

commands:
  save <url>             capture a page into the library (a new version when it holds the URL already)
                         [--tag <tag>]... [--no-reader] [--no-mhtml] [--no-shot] [--no-pdf]
  save <url> -d <dir>    capture a page into a folder: archive.html, reader.html, archive.mhtml,
                         shot.png, shot.pdf and meta.json (same options)
  save <url> -o <file>   capture a page into one self-contained HTML file
                         any save: [--profile <dir>] [--wait-for <selector>] [--dismiss <selector>]...
                         [--no-default-dismiss] [--headed]
  list                   the library's pages, newest first; --all shows every version
  search <words>...      full-text search: title, byline, site and the article's text
                         list and search: [--site <site>] [--tag <tag>]... [--since YYYY-MM-DD]
                         [--until YYYY-MM-DD] [--limit <n>] [--json]; search: [--raw] (FTS5 syntax)
  tag <id> [<tag>...]    add tags to a page (--remove <tag> to take one off); no tags: show them
  open <id>              open a page's archive in the browser (--reader: the reader copy;
                         --print: print the path instead)
  reindex                rebuild library.db from the library's folders
  import <file.html>...  bring in pages saved by SingleFile [--url <url>] [--tag <tag>]...
  serve                  the reader UI and the local API on http://127.0.0.1:47320/, opened in the
                         browser; prints the write token [--port <n>] [--no-open]

The library is --library <dir>, else $PA_LIBRARY, else ~/Archive/pages.
PA_NO_OPEN=1 stops serve from opening a browser.`;

const LIBRARY_COMMANDS = new Set(["list", "search", "tag", "open", "reindex", "import"]);

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
  const options = {
    tags: args.tags,
    profileDir: args.profile,
    headed: args.headed,
    waitFor: args.waitFor,
    dismiss: args.dismiss,
    dismissDefaults: args.defaultDismiss,
  };
  if (!args.out && !args.dir) return saveToLibrary(args, options);
  const archive = await capture(args.url, {
    ...options,
    outFile: args.out,
    outDir: args.dir,
    extras: args.dir ? extrasOf(args) : undefined,
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

function extrasOf(args: SaveArgs) {
  return { reader: !args.skip.reader, mhtml: !args.skip.mhtml, png: !args.skip.png, pdf: !args.skip.pdf };
}

async function saveToLibrary(args: SaveArgs, options: Parameters<Library["save"]>[1]): Promise<number> {
  const lib = openLibrary(resolveLibraryDir(args.library));
  try {
    const { archive, page } = await lib.save(args.url, { ...options, extras: extrasOf(args) });
    console.log(`saved ${page.id} (version ${page.version} of ${page.versions}) ${lib.pathOf(page, "")}`);
    for (const f of listFiles(archive)) console.log(`  ${basename(f.path)} (${size(f.bytes)})`);
    for (const w of archive.warnings) console.error(`warning: ${w}`);
    return 0;
  } finally {
    lib.close();
  }
}

/** One line per page: id, day captured, version, site, title, tags. */
function pageLine(p: PageRecord): string {
  const tags = p.tags.length ? `  ${p.tags.map((t) => `#${t}`).join(" ")}` : "";
  return `${p.id}  ${p.capturedAt.slice(0, 10)}  v${p.version}/${p.versions}  ${p.site ?? "-"}  ${p.title}${tags}`;
}

function openInBrowser(path: string): void {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(opener, [path], { detached: true, stdio: "ignore" }).unref();
}

async function libraryCommand(args: LibraryArgs): Promise<number> {
  const lib = openLibrary(resolveLibraryDir(args.library));
  try {
    switch (args.command) {
      case "list": {
        const pages = lib.list(args);
        if (args.json) console.log(JSON.stringify(pages, null, 2));
        else if (!pages.length) console.error(`no pages in ${lib.root}`);
        else for (const p of pages) console.log(pageLine(p));
        return 0;
      }
      case "search": {
        const hits: SearchHit[] = lib.search(args.query, args);
        if (args.json) console.log(JSON.stringify(hits, null, 2));
        else for (const h of hits) console.log(`${pageLine(h)}\n    ${h.snippet}`);
        if (!hits.length && !args.json) console.error(`no matches for ${args.query}`);
        return hits.length ? 0 : 1;
      }
      case "tag": {
        const page = args.add.length || args.remove.length ? lib.tag(args.id, args.add, args.remove) : lib.get(args.id);
        console.log(`${page.id}  ${page.tags.length ? page.tags.join(", ") : "(no tags)"}`);
        return 0;
      }
      case "open": {
        const page = lib.get(args.id);
        const path = lib.pathOf(page, args.reader ? READER_FILE : undefined);
        if (!existsSync(path)) throw new QueryError(`${page.id} has no ${basename(path)}`);
        if (args.print) console.log(path);
        else {
          openInBrowser(path);
          console.log(`opened ${path}`);
        }
        return 0;
      }
      case "reindex": {
        const report = lib.reindex();
        console.log(`indexed ${report.indexed} ${report.indexed === 1 ? "page" : "pages"} in ${lib.root}`);
        for (const s of report.skipped) console.error(`skipped ${s.dir}: ${s.reason}`);
        return 0;
      }
      case "import": {
        let failed = 0;
        for (const file of args.files) {
          try {
            const page = await lib.importFile(file, { url: args.url, tags: args.tags });
            console.log(`imported ${file} as ${page.id} (version ${page.version} of ${page.versions}) ${relative(lib.root, lib.pathOf(page, "")) || "."}`);
          } catch (err) {
            failed++;
            console.error(`pa: ${file}: ${(err as Error).message}`);
          }
        }
        return failed ? 1 : 0;
      }
    }
  } finally {
    lib.close();
  }
}

async function serve(args: ServeArgs): Promise<number> {
  const root = resolveLibraryDir(args.library);
  const server = await startServer({ library: root, port: args.port });
  const count = server.library.list().length;
  console.log(`page-archiver: serving ${root} (${count} ${count === 1 ? "page" : "pages"}) at ${server.url}`);
  console.log(`write token: ${server.token}`);
  if (args.open && !process.env["PA_NO_OPEN"]) openInBrowser(server.url);
  await new Promise<void>((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => resolve());
  });
  await server.close();
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
    if (command === "serve") return await serve(parseServeArgs(rest));
    if (LIBRARY_COMMANDS.has(command)) return await libraryCommand(parseLibraryArgs(command as LibraryArgs["command"], rest));
  } catch (err) {
    if (err instanceof UsageError || err instanceof QueryError) {
      console.error(`pa: ${err.message}`);
      return 2;
    }
    console.error(`pa: ${(err as Error).message}`);
    return 1;
  }
  console.error(`pa: unknown command '${command}' (pa help lists them)`);
  return 2;
}

process.exitCode = await main(process.argv.slice(2));
