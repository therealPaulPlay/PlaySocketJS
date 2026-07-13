import js from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import unusedImports from "eslint-plugin-unused-imports";
import globals from "globals";

export default [
  { ignores: ["dist"] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.browser
      }
    },
    plugins: {
      "@stylistic": stylistic,
      "unused-imports": unusedImports
    },
    rules: {
      "@stylistic/quotes": ["error", "double"],
      "no-unused-vars": "off",
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": ["error", { argsIgnorePattern: "^_" }]
    }
  }
];