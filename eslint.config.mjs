import {fileURLToPath} from "node:url"
import path from "node:path"
import eslint from "@eslint/js"
import tseslint from "typescript-eslint"
import jestPlugin from "eslint-plugin-jest"
import prettierPlugin from "eslint-plugin-prettier/recommended"
import nPlugin from "eslint-plugin-n"
import globals from "globals"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default tseslint.config(
  {
    ignores: ["build/**", "generated/**", "dist/**", ".yarn/**", "load-tests/**", "coverage/**"]
  },
  eslint.configs.recommended,
  nPlugin.configs["flat/recommended"],
  prettierPlugin,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest
      },
      // https://typescript-eslint.io/getting-started/typed-linting/
      parserOptions: {
        tsconfigRootDir: __dirname,
        projectService: {
          allowDefaultProject: ["eslint.config.mjs", "webpack.config.js", "jest.config.js"]
        }
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
      ],
      curly: ["error", "multi"],
      // Using the modified variant to avoid flagging mappers that heavile rely on huge switch
      // statement.
      complexity: ["error", {max: 20, variant: "modified"}]
    }
  },
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.mjs", "**/*.cjs"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    rules: {
      "@typescript-eslint/no-warning-comments": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-var-requires": "off",
      "n/no-missing-import": "off",
      "n/no-empty-function": "off",
      "n/no-unsupported-features/es-syntax": "off",
      "n/no-missing-require": "off",
      "no-dupe-class-members": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      // https://typescript-eslint.io/rules/no-unused-vars/
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "all",
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true
        }
      ]
    }
  },
  {
    files: [
      "**/*.test.ts",
      "**/test/**/*.ts",
      "scripts/**/*.ts",
      "app/utils/src/matchers.ts",
      "eslint.config.mjs",
      "webpack.config.js"
    ],
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
      "n/no-extraneous-import": "off",
      "n/no-process-exit": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off"
    }
  },
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: __dirname,
        projectService: {
          allowDefaultProject: ["eslint.config.mjs", "webpack.config.js", "jest.config.js"]
        }
      }
    }
  }
)
