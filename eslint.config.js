'use strict';
// Minimal config — just the recommended ruleset (catches real bugs: unused
// vars, unreachable code, etc.), deliberately no opinionated style rules
// (quotes, semicolons, indentation) so this doesn't become a separate decision
// from the actual code review.
const js = require('@eslint/js');

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'readonly',
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
        Buffer: 'readonly',
        // @sap/cds injects these onto the global object as soon as it's required
        // (cds.ql's query-builder shorthand) — not undefined references, despite
        // never being explicitly imported anywhere in this codebase.
        SELECT: 'readonly',
        INSERT: 'readonly',
        UPDATE: 'readonly',
        DELETE: 'readonly',
        CREATE: 'readonly',
        DROP: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none' }],
    },
  },
];
