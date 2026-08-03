import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// BUILD TOOLING ONLY. Production is a directory of static files served by `legion viewer`
// (src/cli/_viewer/server.mjs, node:http, zero runtime dependencies) — vite never runs in front of
// an operator. `base: './'` keeps every emitted asset URL relative so the bundle is servable from
// any mount point; `assetsInlineLimit: 0` keeps assets as real files so the server's own extension
// allowlist and CSP govern them rather than base64 blobs inside the JS.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist', assetsInlineLimit: 0 },
});
