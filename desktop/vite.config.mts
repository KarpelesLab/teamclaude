import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

// The renderer is loaded from disk (file://), so asset paths are relative.
export default defineConfig({
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)),
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL('./out/renderer', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
  },
});
