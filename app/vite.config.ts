import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      include: ['buffer', 'crypto', 'stream', 'util'],
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
    }),
  ],
  resolve: {
    alias: {
      // Anchor's CLI toolchain imports `toml`; the browser `Program` client does
      // not. Alias it to a stub so the parser never enters the client bundle.
      toml: fileURLToPath(new URL('./src/stubs/toml.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    host: true,
  },
});
