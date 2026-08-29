import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/.wrangler/**',
      '**/migrations/**',
      '**/.claude/skills/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Test fixtures and API-response stubs are deliberately loosely typed —
    // asserting on shapes is the test's job, not the type system's. Every
    // package lints with --max-warnings 0, so leaving these as warnings would
    // make the release gate permanently red.
    files: ['**/test/**', '**/e2e/**', '**/e2e-acceptance/**', '**/*.test.*', '**/*.spec.*'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
