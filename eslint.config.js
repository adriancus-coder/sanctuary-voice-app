// Flat ESLint config — SV-LINT-FORMAT.
//
// Policy: the existing ~30k lines are grandfathered (listed in
// .eslint-grandfathered.json) and NOT linted, so we never do a repo-wide
// reformat in one commit. Any NEW file authored from now on is linted with
// eslint:recommended plus no-unused-vars / no-undef as errors. When a
// grandfathered file is meaningfully rewritten in a later commit, drop it
// from .eslint-grandfathered.json in that same commit and clean it up.
const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');
const grandfathered = require('./.eslint-grandfathered.json');

module.exports = [
  {
    ignores: ['node_modules/**', 'data/**', 'logs/**', ...grandfathered],
  },
  js.configs.recommended,
  prettier,
  {
    rules: {
      'no-unused-vars': 'error',
      'no-undef': 'error',
    },
  },
  {
    // Browser-side scripts under public/.
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        io: 'readonly',
        QRCode: 'readonly',
        SpeechSDK: 'readonly',
      },
    },
  },
  {
    // Server-side CommonJS.
    files: ['server.js', 'routes/**/*.js', 'socket/**/*.js', 'lib/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },
  {
    // This config file itself.
    files: ['eslint.config.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
  },
];
