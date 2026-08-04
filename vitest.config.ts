import { defineConfig } from 'vitest/config'
import { resolve } from 'path'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@main': resolve(__dirname, 'src/main')
    },
    extensions: ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json']
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/gui-e2e/**'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30_000,
    pool: 'forks',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/main/**', 'src/shared/**', 'src/renderer/src/**'],
      exclude: [
        'src/main/types/**',
        '**/*.d.ts',
        'src/renderer/src/assets/**',
        'src/renderer/src/lib/icons/**',
        'src/renderer/src/lib/fileIcons/**'
      ]
    }
  }
})
