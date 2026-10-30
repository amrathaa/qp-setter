import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // Relative paths, so the built site works at any address (GitHub Pages serves it from /qp-setter/).
  base: './',
  plugins: [react()],
})
