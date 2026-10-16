// Flat config. Type-aware rules are deliberately off in M0 to keep lint fast;
// turn on `recommendedTypeChecked` per package when the tree settles.
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "docs/**", "deploy/**", "**/*.config.js", "**/*.config.ts"],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/test/**", "**/scripts/**"],
    rules: { "no-console": "off", "@typescript-eslint/no-explicit-any": "off" },
  },
);
