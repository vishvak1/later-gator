import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    ignores: [
      ".wrangler/**",
      "**/dist/**",
      "**/release-artifacts/**",
      "apps/chrome-extension/assets/**",
      "apps/chrome-extension/src/**",
      "extension/**",
      "node_modules/**",
      "**/web/public/**",
      "**/worker-configuration.d.ts",
      "eslint.config.js",
    ],
  },
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.js"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/consistent-type-imports": "error"
    },
  },
  {
    files: ["apps/runtime/web/**/*.ts", "apps/chrome-extension/test/**/*.ts"],
    rules: {
      "@typescript-eslint/array-type": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-unnecessary-type-conversion": "off",
      "@typescript-eslint/no-unnecessary-type-parameters": "off",
      "@typescript-eslint/prefer-nullish-coalescing": "off",
      "@typescript-eslint/prefer-regexp-exec": "off",
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { console: "readonly", process: "readonly", URL: "readonly" },
    },
    rules: {
      "@typescript-eslint/no-unnecessary-condition": "off",
    },
  },
);
