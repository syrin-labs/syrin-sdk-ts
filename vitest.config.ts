import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
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
  },
  resolve: {
    // Resolve .js extensions to .ts for ESM-style imports in tests
    extensions: ['.ts', '.mts', '.js', '.mjs'],
    alias: {
      // Allow tests to import from src without .js extension issues
    },
  },
  plugins: [
    {
      // Plugin to resolve .js -> .ts for TypeScript source files
      name: 'resolve-ts-extensions',
      resolveId(id, importer) {
        if (importer && id.endsWith('.js') && !id.includes('node_modules')) {
          const tsPath = id.replace(/\.js$/, '.ts');
          return null; // Let vite handle it with the extensions array
        }
        return null;
      },
    },
  ],
});
