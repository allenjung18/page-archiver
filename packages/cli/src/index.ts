#!/usr/bin/env node
// pa: save | list | search | open | tag | reindex | serve | import. Commands land chunk by chunk.

const USAGE = `usage: pa <command> [args]

commands (none implemented yet):
  save <url...>      capture pages into the library
  list               list saved pages
  search <query>     full-text search
  serve              start the local reader`;

function main(argv: string[]): number {
  const [command] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return 0;
  }
  console.error(`pa: '${command}' is not implemented yet`);
  return 2;
}

process.exitCode = main(process.argv.slice(2));
