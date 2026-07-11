import { defineConfig } from 'vite';

// base './' → relative asset URLs so the build works under any GitHub
// Pages subpath (https://user.github.io/repo/).
export default defineConfig({
  base: './',
});
