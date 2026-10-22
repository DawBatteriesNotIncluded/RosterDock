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
  {
    // The browser takes only types from the shared package's index: its code carries zod and node:crypto,
    // and a value imported from it left the page blank. Browser-safe modules have entries of their own.
    files: ["apps/web/src/**"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@rosterdock/shared",
              allowTypeImports: true,
              message:
                "Import types only; take values from @rosterdock/shared/events, @rosterdock/shared/text, @rosterdock/shared/web or @rosterdock/shared/address.",
            },
          ],
        },
      ],
    },
  },
);
