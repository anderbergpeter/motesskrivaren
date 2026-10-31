import { defineConfig } from 'vite';

// Relative base so the same build works on GitHub Pages (/<repo>/) and on a custom domain.
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
  test: { environment: 'node' },
});
