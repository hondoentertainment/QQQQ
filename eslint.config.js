// Flat ESLint config. The frontend (app.js) runs in the browser; everything
// else (server, lib, scripts, tests, this config) runs in Node.
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', '_site/**', 'data/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      // quotes.js intentionally swallows a fetch error to fall through to Yahoo.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['app.js'],
    languageOptions: {
      globals: globals.browser,
    },
  },
];
