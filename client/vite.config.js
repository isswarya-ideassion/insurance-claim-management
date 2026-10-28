import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, transformWithOxc } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const here = path.dirname(fileURLToPath(import.meta.url))

// React components live in .js files (no .jsx), so JSX in project .js files is
// compiled before the React plugin runs.
function jsxInJs() {
  return {
    name: 'jsx-in-js',
    enforce: 'pre',
    async transform(code, id) {
      if (!/\/src\/.*\.js$/.test(id) || id.includes('/node_modules/')) return null
      return transformWithOxc(code, id, { lang: 'jsx', jsx: { runtime: 'automatic' } })
    },
  }
}

export default defineConfig({
  plugins: [jsxInJs(), react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(here, 'src'),
      '@shared': path.resolve(here, '../shared'),
    },
  },
  // Pages are lazy-loaded, so dependencies are declared up front to avoid a
  // mid-session re-optimisation that would load two copies of React.
  optimizeDeps: {
    rolldownOptions: { moduleTypes: { '.js': 'jsx' } },
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      'react-router-dom',
      'react-hook-form',
      '@hookform/resolvers/zod',
      'zod',
      'recharts',
      'framer-motion',
      'lucide-react',
      'sonner',
      'clsx',
      'tailwind-merge',
      'class-variance-authority',
      '@radix-ui/react-alert-dialog',
      '@radix-ui/react-avatar',
      '@radix-ui/react-checkbox',
      '@radix-ui/react-dialog',
      '@radix-ui/react-dropdown-menu',
      '@radix-ui/react-label',
      '@radix-ui/react-popover',
      '@radix-ui/react-progress',
      '@radix-ui/react-select',
      '@radix-ui/react-separator',
      '@radix-ui/react-slot',
      '@radix-ui/react-switch',
      '@radix-ui/react-tabs',
      '@radix-ui/react-tooltip',
    ],
  },
  server: {
    port: 5173,
    fs: { allow: [path.resolve(here, '..')] },
    proxy: {
      '/api': { target: process.env.VITE_DEV_API_PROXY || 'http://localhost:4000', changeOrigin: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 900,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    include: ['src/**/*.test.js'],
    css: false,
  },
})
