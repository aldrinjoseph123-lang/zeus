import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Deliberately the `recommended` sets only — not `strict`, not `stylistic`. This
 * codebase went a long time without a linter, and a first pass that reports hundreds
 * of stylistic opinions gets switched off rather than fixed. What is here catches
 * genuine mistakes; formatting preferences are left alone.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'prisma/migrations/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        performance: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        __dirname: 'readonly',
      },
    },
    rules: {
      // An unused argument is often deliberate (destructuring a field out to drop it,
      // a required-by-signature parameter). Prefix with _ to say so on purpose.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
    },
  },
);
