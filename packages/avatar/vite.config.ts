import { defineConfig } from "vite";

/**
 * ESM library build for @skdy/avatar (task B1 draft).
 *
 * Relationship to the TypeScript build:
 * - `tsc -p tsconfig.build.json` remains the source of `.d.ts` declarations
 *   (kept by task B1 requirement 1). This config only emits bundled ESM runtime.
 * - Both builds share the `dist/` directory; `emptyOutDir: false` keeps the
 *   declaration output intact while the entry `.js` files are replaced by the
 *   bundles produced here.
 *
 * Contract constraints honored here:
 * - Emits every JavaScript entry file referenced by package `exports`:
 *   `dist/index.js`, `dist/core/index.js`, `dist/web-component/index.js`,
 *   `dist/react/index.js`, `dist/testing/index.js`. Entry keys are the relative
 *   paths of those files. Building testing in the same Rollup graph preserves
 *   shared class identity (notably AvatarError) across package subpaths.
 * - React is an optional peer dependency; it is externalized (and not imported
 *   by the base entries anyway) so it never enters the base bundles.
 * - Vite library mode inlines imported assets regardless of assetsInlineLimit.
 *   Character/media assets therefore must be loaded from manifest URLs and
 *   must not be statically imported. The build contract test scans every JS
 *   chunk and fails if a media data URI is emitted.
 */
export default defineConfig({
  build: {
    target: "es2022",
    emptyOutDir: false,
    sourcemap: true,
    lib: {
      entry: {
        index: "src/index.ts",
        "core/index": "src/core/index.ts",
        "web-component/index": "src/web-component/index.ts",
        "react/index": "src/react/index.ts",
        "testing/index": "src/testing/index.ts",
      },
      formats: ["es"],
    },
    rollupOptions: {
      external: [/^react($|\/)/],
    },
  },
});
