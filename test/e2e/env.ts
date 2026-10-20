// Shared by playwright.config.ts and the specs: where the fixture server listens and the
// viewport every capture and comparison uses. Override the ports with PAGES_PORT / ASSETS_PORT
// when another checkout already holds the defaults.
import { DEFAULT_ASSETS_PORT, DEFAULT_PAGES_PORT, HOST } from "../../fixtures/server.ts";

export const PAGES_PORT = Number(process.env["PAGES_PORT"] || DEFAULT_PAGES_PORT);
export const ASSETS_PORT = Number(process.env["ASSETS_PORT"] || DEFAULT_ASSETS_PORT);
export const PAGES_ORIGIN = `http://${HOST}:${PAGES_PORT}`;
export const ASSETS_ORIGIN = `http://${HOST}:${ASSETS_PORT}`;

export const VIEWPORT = { width: 1280, height: 900 } as const;

export function fixtureUrl(name: string): string {
  return `${PAGES_ORIGIN}/${name}.html`;
}
