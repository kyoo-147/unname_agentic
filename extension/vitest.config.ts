import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['extension/tests/**/*.test.ts', 'extension/viewer/**/*.test.ts'], exclude: ['extension/tests/e2e/**'] },
});
