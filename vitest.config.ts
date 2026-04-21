import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  esbuild: {
    // Enable legacy decorator support for @tunable decorator syntax in tests
    target: 'es2022',
    keepNames: true,
  },
  test: {
    environment: 'node',
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
    },
    testTimeout: 10000,
    hookTimeout: 10000,
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
    extensions: ['.ts', '.mts', '.js', '.mjs'],
  },
});
