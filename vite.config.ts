import { defineConfig } from 'vite';

// Project Pages are served from /<repo>/, so assets need that base.
// Override with BASE_PATH=/ when serving from a custom domain.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/math_playground/',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
