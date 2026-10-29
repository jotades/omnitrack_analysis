import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    watch: {
      ignored: ['**/.venv/**', '**/dist/**'],
      // Poll for file changes instead of using the system file watchers:
      // VS Code keeps the system limit (fs.inotify.max_user_watches) almost
      // full, and vite then crashes with "ENOSPC: System limit for number of
      // file watchers reached". Set VITE_NO_POLLING=1 to use the watchers.
      usePolling: process.env.VITE_NO_POLLING !== '1',
      interval: 500,
    },
    // 8020, not the usual 8000: that port is taken by the PhiCube dashboard.
    proxy: {
      '/api': process.env.VITE_API_PROXY ?? 'http://127.0.0.1:8020'
    }
  }
});
