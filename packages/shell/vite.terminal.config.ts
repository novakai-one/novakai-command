import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// The B3a terminal tab is built as its own page so it can be served by the
// background Runtime host and driven in a real browser before B3e folds it
// into the full shell frame.
export default defineConfig({
  plugins: [react()],
  root: path.resolve(import.meta.dirname, 'app/terminal'),
  build: { outDir: path.resolve(import.meta.dirname, 'dist-terminal'), emptyOutDir: true },
});
