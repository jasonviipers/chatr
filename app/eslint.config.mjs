import { defineConfig, globalIgnores } from 'eslint/config';
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Flat-config port of the former .eslintrc (ESLint 9+ no longer reads it).
// The old file extended `airbnb` and `babel-eslint`, neither of which was
// installed, so linting could not run at all; the rule overrides are kept.
export default defineConfig(
  globalIgnores(['build/', 'android/', 'ios/', 'electron/', 'public/', 'node_modules/']),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.commonjs, ...globals.vitest },
    },
    rules: {
      'no-const-assign': 'warn',
      'no-this-before-super': 'warn',
      'no-unreachable': 'warn',
      'no-continue': 'off',
      'constructor-super': 'warn',
      'valid-typeof': 'warn',
      '@typescript-eslint/no-unused-vars': 'warn',
      '@typescript-eslint/no-explicit-any': 'off',
      // `interface Props extends RouteComponentProps {}` is how the existing class components declare their props
      '@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'with-single-extends' }],
    },
  },
);
