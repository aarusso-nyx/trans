// ESLint flat config (v9+)
export default [
  {
    ignores: ["node_modules", ".i18n-cache.json", "messages*.xlf", "package-lock.json"],
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      semi: ["error", "always"],
      quotes: ["error", "double", { avoidEscape: true }],
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-console": "off",
      indent: ["error", 2, { SwitchCase: 1 }],
    },
  },
];
