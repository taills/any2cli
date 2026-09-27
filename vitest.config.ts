import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/cli.ts'],
      reporter: ['text-summary', 'text'],
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 70 },
    },
  },
});
