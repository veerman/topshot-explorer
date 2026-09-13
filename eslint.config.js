import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // Build output, script working state, the vendored package
  globalIgnores(['dist', 'scratch', '**/.wrangler/', 'packages/']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
        // Build-time constants injected by vite.config.js define
        __APP_VERSION__: 'readonly',
        __BUILD_DATE__: 'readonly',
        __SEED_VERSION__: 'readonly',
        __OFFERS_VERSION__: 'readonly',
      },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  // Node maintenance scripts (.mjs): plain JS lint, node globals, no
  // React rules
  {
    files: ['scripts/**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
  },
])
