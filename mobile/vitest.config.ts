/**
 * Unit tests for the API boundary only — `src/lib`, which is plain TypeScript
 * with no React Native imports and so needs no Metro, no jest-expo and no
 * native runtime. Screens are verified by running the app (spec §13).
 */

import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    environment: 'node',
    include: ['src/lib/__tests__/**/*.test.ts'],
  },
});
