import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.test.{ts,tsx}', 'ui/src/**/*.test.{ts,tsx}'], testTimeout: 30000, hookTimeout: 30000, maxWorkers: 3 } });
