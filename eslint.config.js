import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';

// All rules are 'warn': the ratchet gate (tools/gates/standards.mjs)
// owns pass/fail by comparing total counts to lint-baseline.json.
export default [
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.test.ts', '**/*.test.tsx'] },
  {
    files: ['src/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}'],
    languageOptions: { parser: tseslint.parser },
    plugins: { sonarjs },
    rules: {
      'max-lines': ['warn', { max: 300, skipBlankLines: true, skipComments: true }],
      'max-statements-per-line': ['warn', { max: 2 }],
      'id-length': ['warn', { min: 4, exceptions: ['id', 'el', 'cwd', 'env'] }],
      'sonarjs/cognitive-complexity': ['warn', 10],
      'no-restricted-syntax': ['warn', {
        selector: "JSXAttribute[name.name='style']",
        message: 'Use a class in the module .css file, not an inline style.',
      }],
    },
  },
  {
    // ponytail: max-lines-per-function is .ts-only — React components dominate
    // .tsx and are exempt by standard; add a tiny AST rule if lowercase
    // .tsx helpers start leaking past the 20-line bar.
    files: ['src/**/*.ts'],
    rules: {
      'max-lines-per-function': ['warn', { max: 20, skipBlankLines: true, skipComments: true }],
    },
  },
];
