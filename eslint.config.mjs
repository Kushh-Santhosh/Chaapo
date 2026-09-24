import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FlatCompat } from '@eslint/eslintrc'
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) })

export default tseslint.config(
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'dist/**',
      'coverage/**',
      'db/migrations/**',
      'public/sw.js',
      'next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...compat.extends('next/core-web-vitals'),
  {
    // `consistent-type-imports` needs type information, which means this block must
    // name the TypeScript parser explicitly (`next/core-web-vitals` installs its own,
    // which does not forward `projectService`) and must apply to TypeScript only —
    // otherwise ESLint tries to type-check this config file, which no tsconfig covers.
    files: ['**/*.ts', '**/*.tsx', '**/*.mts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: dirname(fileURLToPath(import.meta.url)),
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
    },
  },
  {
    // The domain layer must stay framework-free so the worker (and any future
    // extraction) can import it without Next.js. IMPLEMENTATION_PLAN.md §2.
    files: [
      'src/server/domains/**/*.ts',
      'src/server/core/**/*.ts',
      'src/server/providers/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'next', message: 'The domain layer must not import Next.js.' },
            { name: 'next/headers', message: 'The domain layer must not import Next.js.' },
            { name: 'next/navigation', message: 'The domain layer must not import Next.js.' },
            { name: 'next/server', message: 'The domain layer must not import Next.js.' },
            { name: 'react', message: 'The domain layer must not import React.' },
            { name: 'server-only', message: 'The domain layer also runs in the worker process.' },
          ],
          patterns: [
            { group: ['next/*'], message: 'The domain layer must not import Next.js.' },
            {
              group: ['@/app/*', '@/components/*'],
              message: 'The domain layer must not import UI.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.ts', 'src/server/db/seed/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.itest.ts', 'src/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
)
