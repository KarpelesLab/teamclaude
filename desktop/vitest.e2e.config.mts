import { defineConfig } from 'vitest/config';

// End-to-end tests drive the built app (`npm run build` first) through
// Playwright's Electron support. Kept out of `npm test`: they need a display
// (Xvfb on Linux CI) and take tens of seconds.
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.e2e.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
