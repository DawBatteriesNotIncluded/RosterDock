// Flat config. Type-aware rules are off to keep lint fast; turning them on per
// package, and linting deploy/scripts, is in docs/backlog.md.
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      ".claude/worktrees/**",
      "docs/**",
      "deploy/**",
      "**/*.config.js",
      "**/*.config.ts",
    ],
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
