# Isolated tarball consumer

This is a standalone Vite + TypeScript consumer for the published `@skdy/avatar` shape. It imports only the public root entry:

```ts
import { createAvatar } from "@skdy/avatar";
```

It demonstrates a real Rive character, ready/error events, all five visual states, inline/floating mode, bottom-left/bottom-right positioning, and destroy/recreate. It has no Agent, voice, TTS, ASR, recording, audio, or lip-sync integration.

## Pack, install, build, preview

From `packages/avatar`:

```bash
npm run build
npm pack --dry-run
mkdir -p /tmp/skdy-avatar-b6
npm pack --pack-destination /tmp/skdy-avatar-b6
```

From this directory, using the generated tarball (not a workspace or source path):

```bash
rm -rf node_modules package-lock.json .avatar-tarball.tgz
npm run install:tarball -- /tmp/skdy-avatar-b6/skdy-avatar-0.1.0-alpha.0.tgz
npm ci
npm run build
npm run verify:boundaries
npm run preview -- --host 127.0.0.1
```

Open the printed Vite preview URL. The demo manifest is consumer-owned; its production Rive asset is loaded from the pinned upstream URL. Browser access to GitHub Raw and the Rive WASM CDN is required for the real character.
