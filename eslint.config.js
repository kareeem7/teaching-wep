import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'public/assets/vendor/**',
      'test-results/**',
      'playwright-report/**',
      // حزم دوال Edge المُولَّدة (R-38): مبنية من مصدر مُفحوص، ولا تُراجع كملف يدوي
      'supabase/.bundles/**',
    ],
  },
  js.configs.recommended,
  {
    // واجهة المتصفح
    files: ['public/assets/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'no-var': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Edge Functions: بيئة Deno/Web (Response, crypto, fetch) — لا DOM ولا Node خاص
    files: ['supabase/functions/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node, Deno: 'readonly' },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'no-var': 'error',
      'no-console': 'off',
    },
  },
  {
    // اختبارات المتصفح: تعمل في Node لكن تُنفِّذ كودًا داخل الصفحة
    files: ['tests/e2e/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    // أدوات البناء المحلية (Node)
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: { 'no-console': 'off' },
  },
  {
    // اختبارات وحدات وملفات الإعداد (Node فقط)
    files: ['tests/unit/**/*.js', '*.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: { 'no-console': 'off' },
  },
];
