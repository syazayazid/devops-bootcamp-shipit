import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const r = (p) => fileURLToPath(new URL(p, import.meta.url));

// The client lives in client/; build it to board/dist, which the Node server
// serves static. base: './' so it works behind any path. Three pages: the
// projector spectator (index.html), the laptop cockpit (play.html), and the
// instructor operator console (operator.html).
export default defineConfig({
  root: 'client',
  base: './',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: { input: { main: r('client/index.html'), play: r('client/play.html'), operator: r('client/operator.html') } },
  },
});
