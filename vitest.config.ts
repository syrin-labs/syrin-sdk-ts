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
    include: ['tests/**/*.test.ts'],
    exclude: ['.claude/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
    },
    testTimeout: 10000,
    hookTimeout: 10000,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@syrin/sdk/advanced': resolve(__dirname, 'src/advanced.ts'),
      '@syrin/sdk': resolve(__dirname, 'src/index.ts'),
    },
    extensions: ['.ts', '.mts', '.js', '.mjs'],
  },
});
