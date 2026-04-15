import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    // Each test file gets a fresh module registry — critical for our dynamic imports
    isolate: true,
    pool: 'forks',
    // Longer timeout for rate-limit retry tests
    testTimeout: 15000,
  },
  resolve: {
    // Allow .js extension to resolve to .ts source in tests
    extensions: ['.ts', '.js'],
  },
});
