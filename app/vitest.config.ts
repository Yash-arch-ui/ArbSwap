import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Same `toml` alias as the Vite build (see vite.config.ts): the Anchor CLI
// toolchain's TOML parser is not part of the browser `Program` client.
export default defineConfig({
  resolve: {
    alias: {
      toml: fileURLToPath(new URL('./src/stubs/toml.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
