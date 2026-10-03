import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Use relative asset paths so the build works at any URL prefix
  // (e.g. GitHub Pages subpath or Render root).
  base: './',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
  },
});
