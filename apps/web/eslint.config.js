import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

/**
 * Same restraint as the API config — `recommended` only — plus the two React plugins
 * that catch real bugs rather than style: rules-of-hooks (a conditional hook is a
 * genuine defect) and react-refresh (a mixed export silently breaks fast refresh).
 */
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        navigator: 'readonly',
        fetch: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        HTMLElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLDivElement: 'readonly',
        HTMLFormElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        HTMLSelectElement: 'readonly',
        HTMLButtonElement: 'readonly',
        HTMLAnchorElement: 'readonly',
        HTMLCanvasElement: 'readonly',
        KeyboardEvent: 'readonly',
        MouseEvent: 'readonly',
        Event: 'readonly',
        Blob: 'readonly',
        File: 'readonly',
        FormData: 'readonly',
        URL: 'readonly',
        AbortController: 'readonly',
        Image: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,

      // eslint-plugin-react-hooks v7 ships the React Compiler-era rules. Both of these
      // are worth *seeing*, but neither describes something currently broken here, so
      // they are warnings rather than build-breaking errors:
      //
      // purity — flags `Date.now()` during render. Almost every hit is a deliberate
      // time-relative display value ("overdue", "3 days quiet") that is *supposed* to
      // recompute on re-render. Making them pure means threading a clock through
      // several pages for no user-visible gain.
      //
      // set-state-in-effect — flags the derive-state-from-props effects in the
      // settings and editor forms. Real tech debt, but restructuring working,
      // browser-verified forms to satisfy it is a change with regression risk and no
      // behavioural benefit. Worth doing deliberately, not as lint cleanup.
      'react-hooks/purity': 'warn',
      'react-hooks/set-state-in-effect': 'warn',

      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
    },
  },
);
