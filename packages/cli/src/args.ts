// Argument parsing for `pa`, kept apart from index.ts so it can be tested without running.
import { parseArgs } from "node:util";

export interface SaveArgs {
  url: string;
  /** -o: the archive alone, to this file. */
  out?: string;
  /** -d: the capture folder (archive, reader copy, MHTML, PNG, PDF, meta.json). */
  dir?: string;
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

export const SAVE_USAGE = `usage: pa save <url> (-o <file> | -d <dir>) [--profile <dir>] [--wait-for <selector>] [--dismiss <selector>]... [--no-default-dismiss] [--headed]
       with -d: [--tag <tag>]... [--no-reader] [--no-mhtml] [--no-shot] [--no-pdf]`;

export function parseSaveArgs(argv: string[]): SaveArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        out: { type: "string", short: "o" },
        dir: { type: "string", short: "d" },
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
  if (!values.out && !values.dir) throw new UsageError(`save needs -o <file> or -d <dir> (the library arrives later)\n${SAVE_USAGE}`);
  if (values.out && values.dir) throw new UsageError(`save takes -o <file> or -d <dir>, not both\n${SAVE_USAGE}`);
  const folderOnly = ["tag", "no-reader", "no-mhtml", "no-shot", "no-pdf"].filter((k) => values[k as keyof typeof values] !== undefined);
  if (values.out && folderOnly.length) throw new UsageError(`--${folderOnly[0]} needs -d <dir>: -o writes the archive alone\n${SAVE_USAGE}`);
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
  if (values.profile) args.profile = values.profile;
  if (values["wait-for"]) args.waitFor = values["wait-for"];
  return args;
}
