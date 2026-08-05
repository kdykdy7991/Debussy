/**
 * Public entry point for the Pi web server dev entry.
 *
 *   - `startWebServer(options)` returns a handle with `close()` for graceful
 *     shutdown; this is what tests and embedding callers should use.
 *   - `web/cli.ts` is a CLI script wired up in `package.json#bin` as
 *     `pi-web`; it parses flags and installs SIGINT/SIGTERM handlers.
 */

export type { StartWebServerOptions, WebServerHandle } from "./start.ts";
export { startWebServer } from "./start.ts";
