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
      // properties: 'never' — property names are contract shapes ({ok}, {to}),
      // not identifiers a writer chooses; the rule governs chosen names only.
      'id-length': ['warn', { min: 4, exceptions: ['id', 'el', 'cwd', 'env'], properties: 'never' }],
      'sonarjs/cognitive-complexity': ['warn', 10],
      'no-restricted-syntax': ['warn', {
        selector: "JSXAttribute[name.name='style']",
        message: 'Use a class in the module .css file, not an inline style.',
      }],
    },
  },
  {
    // Bench migration M1-03: these trees are byte-identical ports of the
    // sandbox prototype (main 9df2842, import lines excepted) — the sandbox is
    // their source of truth, so this repo's naming/size ratchet does not
    // govern them. Editing them to satisfy it would break the identity law.
    files: [
      'packages/shell/ui/canvas/**/*.{ts,tsx}',
      'packages/shell/ui/messages-designs/**/*.{ts,tsx}',
    ],
    rules: {
      'id-length': 'off',
      'max-lines': 'off',
      'sonarjs/cognitive-complexity': 'off',
      'no-restricted-syntax': 'off',
      'max-statements-per-line': 'off',
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
