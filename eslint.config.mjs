import eslint from "@eslint/js"
import tseslint from "typescript-eslint"
import jestPlugin from "eslint-plugin-jest"
import prettierPlugin from "eslint-plugin-prettier/recommended"
import nPlugin from "eslint-plugin-n"
import globals from "globals"

export default tseslint.config(
  {
    ignores: ["build/**", "generated/**", "dist/**", ".yarn/**"]
  },
  eslint.configs.recommended,
  nPlugin.configs["flat/recommended"],
  prettierPlugin,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest
      }
    },
    rules: {
      "block-scoped-var": "error",
      eqeqeq: "error",
      "no-var": "error",
      "prefer-const": "error",
      "eol-last": "error",
      "prefer-arrow-callback": "error",
      "no-trailing-spaces": "error",
      quotes: ["warn", "double", {avoidEscape: true}],
      "no-restricted-properties": [
        "error",
        {
          object: "describe",
          property: "only"
        },
        {
          object: "it",
          property: "only"
        }
      ]
    }
  },
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.mjs", "**/*.cjs"],
    extends: [...tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-warning-comments": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-var-requires": "off",
      "n/no-missing-import": "off",
      "n/no-empty-function": "off",
      "n/no-unsupported-features/es-syntax": "off",
      "n/no-missing-require": "off",
      "no-dupe-class-members": "off"
    }
  },
  {
    files: ["**/*.test.ts", "**/test/**/*.ts", "scripts/**/*.ts", "app/utils/src/matchers.ts", "eslint.config.mjs"],
    ...jestPlugin.configs["flat/recommended"],
    rules: {
      ...jestPlugin.configs["flat/recommended"].rules,
      "jest/no-disabled-tests": "warn",
      "jest/no-focused-tests": "error",
      "jest/no-identical-title": "error",
      "jest/prefer-to-have-length": "warn",
      "jest/valid-expect": "error",
      "jest/prefer-expect-assertions": "off",
      "n/no-unpublished-require": "off",
      "n/no-unpublished-import": "off",
      "n/no-extraneous-import": "off"
    }
  }
)
