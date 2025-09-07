import js from '@eslint/js';
import jsdoc from 'eslint-plugin-jsdoc';
import globals from 'globals';

export default [
  js.configs.recommended,
  jsdoc.configs['flat/recommended'],
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node
    },
    plugins: {
      jsdoc
    },
    rules: {
      'jsdoc/require-param-type': 'error',
      'jsdoc/require-returns-type': 'error',
      'jsdoc/no-undefined-types': 'error',
      'jsdoc/valid-types': 'error',
      'jsdoc/check-types': 'error',
      'jsdoc/no-defaults': 'off',
      "no-unused-vars": ["error", { "argsIgnorePattern": "^_" }]
    }
  }
];