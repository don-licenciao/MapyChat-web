import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'jsdom',
    alias: {
      '@': path.resolve(__dirname, './'),
    },
    globals: false,
    setupFiles: [path.resolve(__dirname, 'vitest.setup.ts')],
  },
});
