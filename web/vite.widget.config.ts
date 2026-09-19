import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Builds the embeddable widget as one self-contained IIFE: dist-widget/widget.js.
// Separate from the app build — a host page loads only this file.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: 'dist-widget',
    emptyOutDir: true,
    lib: {
      entry: 'src/widget/main.tsx',
      formats: ['iife'],
      name: 'FrontdeskWidget',
      fileName: () => 'widget.js',
    },
  },
})
