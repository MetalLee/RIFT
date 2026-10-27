import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({ resolve: { alias: { '@': fileURLToPath(new URL('./ui/src', import.meta.url)) } }, test: { include: ['tests/**/*.test.{ts,tsx}', 'ui/src/**/*.test.{ts,tsx}'], testTimeout: 30000, hookTimeout: 30000, maxWorkers: 3 } });
