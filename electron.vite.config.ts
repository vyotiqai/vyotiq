import { resolve } from 'path'
import { defineConfig, loadEnv } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const sentryDsn = env.SENTRY_DSN || env.VITE_SENTRY_DSN || ''

  const dsnDefine = {
    'process.env.SENTRY_DSN': JSON.stringify(sentryDsn),
    'process.env.VITE_SENTRY_DSN': JSON.stringify(sentryDsn)
  }

  return {
    main: {
      envPrefix: ['VITE_', 'SENTRY_'],
      // Bake DSN into packaged main (runtime process.env is empty in production).
      define: dsnDefine,
      resolve: {
        alias: {
          '@main': resolve('src/main'),
          '@shared': resolve('src/shared')
        }
      },
      build: {
        rollupOptions: {
          input: {
            index: resolve('src/main/index.ts'),
            'tokenizer.worker': resolve('src/main/agent/context/tokenizer.worker.ts'),
            embedUtility: resolve('src/main/agent/codeindex/embedUtility.ts'),
            dictationUtility: resolve('src/main/dictation/whisperUtility.ts')
          }
        }
      }
    },
    preload: {
      envPrefix: ['VITE_', 'SENTRY_'],
      resolve: {
        alias: {
          '@main': resolve('src/main'),
          '@shared': resolve('src/shared')
        }
      },
      // Sandboxed preload cannot require() node_modules — bundle everything in.
      build: {
        externalizeDeps: false,
        rollupOptions: {
          input: {
            index: resolve('src/preload/index.ts')
          }
        }
      },
      define: dsnDefine
    },
    renderer: {
      envPrefix: ['VITE_'],
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer/src'),
          '@shared': resolve('src/shared')
        }
      },
      plugins: [
        react({
          babel: {
            plugins: [['babel-plugin-react-compiler', { compilationMode: 'annotation' }]]
          }
        }),
        tailwindcss()
      ],
      define: {
        'import.meta.env.VITE_SENTRY_DSN': JSON.stringify(sentryDsn)
      },
      build: {
        rollupOptions: {
          output: {
            manualChunks(id) {
              if (
                id.includes('node_modules/react-markdown') ||
                id.includes('node_modules/remark-gfm') ||
                id.includes('node_modules/rehype-sanitize')
              ) {
                return 'markdown'
              }
              if (id.includes('node_modules/shiki')) return 'shiki'
              if (id.includes('node_modules/@lobehub/icons')) return 'lobehub'
              return undefined
            }
          }
        }
      }
    }
  }
})
