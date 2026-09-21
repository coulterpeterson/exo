import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      "out/**",
      "dist/**",
      "release/**",
      "node_modules/**",
      "**/*.js",
      "**/*.mjs",
      "**/*.cjs",
      "**/*.d.ts",
    ],
  },

  // Base TypeScript config for all src/ files
  ...tseslint.configs.recommended,

  // Prettier compat (disables formatting rules that conflict)
  eslintConfigPrettier,

  // Shared rules for all TypeScript files
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          fixStyle: "inline-type-imports",
        },
      ],
      "no-restricted-syntax": "off",
    },
  },

  // Main process: Node globals + no-console
  {
    files: ["src/main/**/*.ts"],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      "no-console": "error",
    },
  },

  // Preload: Node globals + no-console
  {
    files: ["src/preload/**/*.ts"],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      "no-console": "error",
    },
  },

  // Renderer: browser globals (console is fine for browser DevTools)
  {
    files: ["src/renderer/**/*.ts", "src/renderer/**/*.tsx"],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      // A hook after an early return changes the hook count between renders
      // and crashes the component at runtime (React #310) — catch it in lint.
      // exhaustive-deps is deliberately not enabled; the codebase relies on
      // intentionally narrow dependency arrays in places.
      "react-hooks/rules-of-hooks": "error",
    },
  },

  // Extensions & agents: Node globals
  {
    files: [
      "src/extensions/**/*.ts",
      "src/extensions/**/*.tsx",
      "src/extensions-private/**/*.ts",
      "src/extensions-private/**/*.tsx",
      "src/agents-private/**/*.ts",
    ],
    languageOptions: {
      globals: globals.node,
    },
  },

  // Shared: no environment-specific globals
  {
    files: ["src/shared/**/*.ts"],
  },
);
