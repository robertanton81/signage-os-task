// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier/flat';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  // `.local/` is the gitignored scratch directory (CLAUDE.md, "Local scratch"): study notes,
  // throwaway probes, downloaded reference material. None of it ships, so none of it is linted.
  // `.claude/worktrees/` holds git worktrees a Claude Code session opens for isolated work; each
  // is a whole checkout with its own tooling, outside the root TypeScript projects.
  globalIgnores([
    '**/dist/**',
    '**/node_modules/**',
    '**/coverage/**',
    '.local/**',
    '.claude/worktrees/**',
  ]),
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended],
    rules: {
      // Services log through the shared structured logger (CLAUDE.md "Conventions").
      'no-console': 'error',
    },
  },
  {
    files: ['**/*.{ts,mts,cts}'],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Services log through the shared structured logger (CLAUDE.md "Conventions").
      'no-console': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      // Three or more arguments take a single named object (shared-contract spec, decision 14).
      'max-params': ['error', 2],
      // pino resets any custom bindings formatter for a child created without an options object
      // (lib/proto.js), so a raw `.child()` bypasses the redaction in `logger.ts`. Bind identity
      // fields with `messageLogger` / `rejectedMessageLogger`, which redact before they call it.
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='child']",
          message:
            'Use messageLogger or rejectedMessageLogger from @telemetry/shared; a raw .child() does not redact its bindings.',
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // The one place allowed to call `.child()`: it redacts the bindings first.
    files: ['packages/shared/src/logger.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // Root config files are not part of any tsconfig; lint them without type information.
    files: ['*.config.{ts,mts}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
]);
