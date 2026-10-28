import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss(), {
    name: 'client-dependency-boundary',
    generateBundle() {
      const backendRoot = fileURLToPath(new URL('../src/', import.meta.url)).replaceAll('\\', '/');
      for (const moduleId of this.getModuleIds()) {
        const id = moduleId.replaceAll('\\', '/');
        if (id.startsWith(backendRoot) || id.includes('/@deepseek-ai/') || id.startsWith('node:') || id.includes('__vite-browser-external')) {
          this.error(`Server dependency in browser build: ${moduleId}`);
        }
      }
    },
  }],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  base: '/',
  build: { outDir: '../dist/ui', emptyOutDir: true },
  server: { host: '127.0.0.1' },
});
