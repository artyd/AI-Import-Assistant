import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests live next to the code they cover (…/__tests__/*.spec.ts).
    include: ['src/**/*.spec.ts', 'scripts/__tests__/*.spec.mjs'],
    environment: 'node',
  },
});
