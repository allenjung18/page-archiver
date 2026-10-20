// Argument parsing for `pa`, kept apart from index.ts so it can be tested without running.
import { parseArgs } from "node:util";

export interface SaveArgs {
  url: string;
  out: string;
  profile?: string;
  waitFor?: string;
  dismiss: string[];
  /** Click the common consent-manager buttons too (default; --no-default-dismiss turns it off). */
  defaultDismiss: boolean;
  headed: boolean;
}

export class UsageError extends Error {}

export const SAVE_USAGE = `usage: pa save <url> -o <file> [--profile <dir>] [--wait-for <selector>] [--dismiss <selector>]... [--no-default-dismiss] [--headed]`;

export function parseSaveArgs(argv: string[]): SaveArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        out: { type: "string", short: "o" },
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
  if (!values.out) throw new UsageError(`save needs -o <file> (the library arrives later)\n${SAVE_USAGE}`);
  const url = positionals[0]!;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new UsageError(`not a URL: ${url}`);
  }
  if (!/^https?:$/.test(parsedUrl.protocol)) throw new UsageError(`only http and https URLs: ${url}`);
  const args: SaveArgs = { url, out: values.out, dismiss: values.dismiss ?? [], defaultDismiss: !values["no-default-dismiss"], headed: values.headed ?? false };
  if (values.profile) args.profile = values.profile;
  if (values["wait-for"]) args.waitFor = values["wait-for"];
  return args;
}
