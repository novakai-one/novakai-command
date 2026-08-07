import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Shell's own vite config for the demo (shell is self-contained).
export default defineConfig({
  plugins: [react()],
  server: { port: 5180, host: '127.0.0.1' },
});
