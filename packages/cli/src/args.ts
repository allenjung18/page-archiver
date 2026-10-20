// Argument parsing for `pa`, kept apart from index.ts so it can be tested without running.
import { parseArgs } from "node:util";

export interface SaveArgs {
  url: string;
  /** -o: the archive alone, to this file. */
  out?: string;
  /** -d: the capture folder (archive, reader copy, MHTML, PNG, PDF, meta.json). */
  dir?: string;
  /** --library: the library to save into when neither -o nor -d is given (else $PA_LIBRARY, else ~/Archive/pages). */
  library?: string;
  /** The extras turned off with --no-reader, --no-mhtml, --no-shot (PNG and PDF), --no-pdf. */
  skip: { reader: boolean; mhtml: boolean; png: boolean; pdf: boolean };
  tags: string[];
  profile?: string;
  waitFor?: string;
  dismiss: string[];
  /** Click the common consent-manager buttons too (default; --no-default-dismiss turns it off). */
  defaultDismiss: boolean;
  headed: boolean;
}

export class UsageError extends Error {}

export const SAVE_USAGE = `usage: pa save <url> [--library <dir> | -d <dir> | -o <file>] [--profile <dir>] [--wait-for <selector>] [--dismiss <selector>]... [--no-default-dismiss] [--headed]
       into the library or -d: [--tag <tag>]... [--no-reader] [--no-mhtml] [--no-shot] [--no-pdf]`;

export function parseSaveArgs(argv: string[]): SaveArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        out: { type: "string", short: "o" },
        dir: { type: "string", short: "d" },
        library: { type: "string" },
        tag: { type: "string", multiple: true },
        "no-reader": { type: "boolean" },
        "no-mhtml": { type: "boolean" },
        "no-shot": { type: "boolean" },
        "no-pdf": { type: "boolean" },
        profile: { type: "string" },
        "wait-for": { type: "string" },
        dismiss: { type: "string", multiple: true },
        "no-default-dismiss": { type: "boolean" },
        headed: { type: "boolean" },
      },
    });
  } catch (err) {
    throw new UsageError(`${(err as Error).message}\n${SAVE_USAGE}`);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1) throw new UsageError(`save takes exactly one URL\n${SAVE_USAGE}`);
  // an empty -d "" or --library "" would quietly fall through to the default library
  const empty = (["out", "dir", "library", "profile", "wait-for"] as const).find((k) => values[k] === "");
  if (empty) throw new UsageError(`--${empty} needs a value, not an empty string\n${SAVE_USAGE}`);
  const targets = (["out", "dir", "library"] as const).filter((k) => values[k] !== undefined);
  if (targets.length > 1) throw new UsageError(`save takes one of --library <dir>, -d <dir> and -o <file>, not ${targets.map((t) => `--${t}`).join(" and ")}\n${SAVE_USAGE}`);
  const folderOnly = ["tag", "no-reader", "no-mhtml", "no-shot", "no-pdf"].filter((k) => values[k as keyof typeof values] !== undefined);
  if (values.out && folderOnly.length) throw new UsageError(`--${folderOnly[0]} needs -d <dir> or the library: -o writes the archive alone\n${SAVE_USAGE}`);
  const url = positionals[0]!;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new UsageError(`not a URL: ${url}`);
  }
  if (!/^https?:$/.test(parsedUrl.protocol)) throw new UsageError(`only http and https URLs: ${url}`);
  const noShot = values["no-shot"] ?? false;
  const args: SaveArgs = {
    url,
    skip: { reader: values["no-reader"] ?? false, mhtml: values["no-mhtml"] ?? false, png: noShot, pdf: noShot || (values["no-pdf"] ?? false) },
    tags: values.tag ?? [],
    dismiss: values.dismiss ?? [],
    defaultDismiss: !values["no-default-dismiss"],
    headed: values.headed ?? false,
  };
  if (values.out) args.out = values.out;
  if (values.dir) args.dir = values.dir;
  if (values.library) args.library = values.library;
  if (values.profile) args.profile = values.profile;
  if (values["wait-for"]) args.waitFor = values["wait-for"];
  return args;
}

/** --library and the filters list and search share. */
const LIBRARY_OPTIONS = { library: { type: "string" } } as const;
const FILTER_OPTIONS = {
  site: { type: "string" },
  tag: { type: "string", multiple: true },
  since: { type: "string" },
  until: { type: "string" },
  all: { type: "boolean" },
  limit: { type: "string" },
  json: { type: "boolean" },
} as const;

export interface FilterArgs {
  library?: string;
  site?: string;
  tags: string[];
  since?: string;
  until?: string;
  allVersions: boolean;
  limit?: number;
  json: boolean;
}

export interface ListArgs extends FilterArgs {
  command: "list";
}
export interface SearchArgs extends FilterArgs {
  command: "search";
  query: string;
  raw: boolean;
}
export interface TagArgs {
  command: "tag";
  library?: string;
  id: string;
  add: string[];
  remove: string[];
}
export interface OpenArgs {
  command: "open";
  library?: string;
  id: string;
  reader: boolean;
  print: boolean;
}
export interface ReindexArgs {
  command: "reindex";
  library?: string;
}
export interface ImportArgs {
  command: "import";
  library?: string;
  files: string[];
  url?: string;
  tags: string[];
}
export type LibraryArgs = ListArgs | SearchArgs | TagArgs | OpenArgs | ReindexArgs | ImportArgs;

export const LIBRARY_USAGE: Record<LibraryArgs["command"], string> = {
  list: "usage: pa list [--all] [--site <site>] [--tag <tag>]... [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--limit <n>] [--json] [--library <dir>]",
  search: "usage: pa search <words>... [--raw] [--all] [--site <site>] [--tag <tag>]... [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--limit <n>] [--json] [--library <dir>]",
  tag: "usage: pa tag <id> [<tag>...] [--remove <tag>]... [--library <dir>]",
  open: "usage: pa open <id> [--reader] [--print] [--library <dir>]",
  reindex: "usage: pa reindex [--library <dir>]",
  import: "usage: pa import <file.html>... [--url <url>] [--tag <tag>]... [--library <dir>]",
};

function parse<O extends Record<string, { type: "string" | "boolean"; multiple?: boolean; short?: string }>>(command: LibraryArgs["command"], argv: string[], options: O) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options });
  } catch (err) {
    throw new UsageError(`${(err as Error).message}\n${LIBRARY_USAGE[command]}`);
  }
  // an empty --library "" would quietly fall through to $PA_LIBRARY or ~/Archive/pages
  const empty = Object.entries(parsed.values as Record<string, unknown>).find(([, v]) => v === "");
  if (empty) throw new UsageError(`--${empty[0]} needs a value, not an empty string\n${LIBRARY_USAGE[command]}`);
  return parsed;
}

function filters(command: "list" | "search", values: { [k: string]: string | boolean | string[] | undefined }): FilterArgs {
  const out: FilterArgs = { tags: (values["tag"] as string[] | undefined) ?? [], allVersions: values["all"] === true, json: values["json"] === true };
  if (typeof values["library"] === "string") out.library = values["library"];
  if (typeof values["site"] === "string") out.site = values["site"];
  if (typeof values["since"] === "string") out.since = values["since"];
  if (typeof values["until"] === "string") out.until = values["until"];
  if (typeof values["limit"] === "string") {
    if (!/^[1-9]\d*$/.test(values["limit"])) throw new UsageError(`--limit takes a whole number above 0: ${values["limit"]}\n${LIBRARY_USAGE[command]}`);
    out.limit = Number(values["limit"]);
  }
  return out;
}

/** The arguments of list, search, tag, open, reindex and import. */
export function parseLibraryArgs(command: LibraryArgs["command"], argv: string[]): LibraryArgs {
  const usage = LIBRARY_USAGE[command];
  switch (command) {
    case "list": {
      const { values, positionals } = parse(command, argv, { ...LIBRARY_OPTIONS, ...FILTER_OPTIONS });
      if (positionals.length) throw new UsageError(`list takes no arguments: ${positionals.join(" ")}\n${usage}`);
      return { command, ...filters(command, values) };
    }
    case "search": {
      const { values, positionals } = parse(command, argv, { ...LIBRARY_OPTIONS, ...FILTER_OPTIONS, raw: { type: "boolean" } });
      const query = positionals.join(" ").trim();
      if (!query) throw new UsageError(`search needs words to search for\n${usage}`);
      return { command, query, raw: values.raw ?? false, ...filters(command, values) };
    }
    case "tag": {
      const { values, positionals } = parse(command, argv, { ...LIBRARY_OPTIONS, remove: { type: "string", multiple: true } });
      const [id, ...add] = positionals;
      if (!id) throw new UsageError(`tag needs a page id\n${usage}`);
      const out: TagArgs = { command, id, add, remove: values.remove ?? [] };
      if (values.library) out.library = values.library;
      return out;
    }
    case "open": {
      const { values, positionals } = parse(command, argv, { ...LIBRARY_OPTIONS, reader: { type: "boolean" }, print: { type: "boolean" } });
      if (positionals.length !== 1) throw new UsageError(`open takes exactly one page id\n${usage}`);
      const out: OpenArgs = { command, id: positionals[0]!, reader: values.reader ?? false, print: values.print ?? false };
      if (values.library) out.library = values.library;
      return out;
    }
    case "reindex": {
      const { values, positionals } = parse(command, argv, { ...LIBRARY_OPTIONS });
      if (positionals.length) throw new UsageError(`reindex takes no arguments: ${positionals.join(" ")}\n${usage}`);
      const out: ReindexArgs = { command };
      if (values.library) out.library = values.library;
      return out;
    }
    case "import": {
      const { values, positionals } = parse(command, argv, { ...LIBRARY_OPTIONS, url: { type: "string" }, tag: { type: "string", multiple: true } });
      if (!positionals.length) throw new UsageError(`import needs at least one HTML file\n${usage}`);
      if (values.url && positionals.length > 1) throw new UsageError(`--url names one page: import one file with it\n${usage}`);
      const out: ImportArgs = { command, files: positionals, tags: values.tag ?? [] };
      if (values.library) out.library = values.library;
      if (values.url) {
        let u: URL;
        try {
          u = new URL(values.url);
        } catch {
          throw new UsageError(`not a URL: ${values.url}`);
        }
        if (!/^https?:$/.test(u.protocol)) throw new UsageError(`only http and https URLs: ${values.url}`);
        out.url = values.url;
      }
      return out;
    }
  }
}

export interface ServeArgs {
  library?: string;
  /** 0: any free port. Unset: the server's default. */
  port?: number;
  /** Open the UI in the default browser once the server listens (--no-open: do not). */
  open: boolean;
}

export const SERVE_USAGE = "usage: pa serve [--port <n>] [--no-open] [--library <dir>]";

/** The arguments of serve. */
export function parseServeArgs(argv: string[]): ServeArgs {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { library: { type: "string" }, port: { type: "string" }, "no-open": { type: "boolean" } } });
  } catch (err) {
    throw new UsageError(`${(err as Error).message}\n${SERVE_USAGE}`);
  }
  const { values, positionals } = parsed;
  if (positionals.length) throw new UsageError(`serve takes no arguments: ${positionals.join(" ")}\n${SERVE_USAGE}`);
  const empty = (["library", "port"] as const).find((k) => values[k] === "");
  if (empty) throw new UsageError(`--${empty} needs a value, not an empty string\n${SERVE_USAGE}`);
  const out: ServeArgs = { open: !values["no-open"] };
  if (values.library) out.library = values.library;
  if (values.port !== undefined) {
    if (!/^\d{1,5}$/.test(values.port) || Number(values.port) > 65535) throw new UsageError(`--port takes a port number (0 for any free one): ${values.port}\n${SERVE_USAGE}`);
    out.port = Number(values.port);
  }
  return out;
}
