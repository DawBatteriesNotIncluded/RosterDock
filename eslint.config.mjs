// Flat config. Type-aware rules are off to keep lint fast; turning them on per
// package, and linting deploy/scripts, is in docs/backlog.md.
import { builtinModules } from "node:module";
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
      // `import { type X } from "m"` keeps `import "m"` under verbatimModuleSyntax, so the module still loads
      // in the browser; only `import type { X }` leaves nothing behind.
      "@typescript-eslint/no-import-type-side-effects": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ImportExpression[source.value=/^@rosterdock\\/shared(\\/(?!(events|text|web|address)$).*)?$/]",
          message: "Only events, text, web and address are kept browser-safe, loaded late or not.",
        },
      ],
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
          patterns: [
            {
              group: [
                "@rosterdock/shared/*",
                "!@rosterdock/shared/events",
                "!@rosterdock/shared/text",
                "!@rosterdock/shared/web",
                "!@rosterdock/shared/address",
              ],
              allowTypeImports: true,
              message:
                "Only events, text, web and address are kept browser-safe; take types only from the rest.",
            },
            {
              group: ["**/packages/shared/**", "**/node_modules/@rosterdock/**"],
              message: "Import the shared package by its name, @rosterdock/shared/<entry>.",
            },
          ],
        },
      ],
    },
  },
  {
    // The modules the browser takes values from run without node: no node module, no value from another
    // shared module (those may use node), no node global. The web's own tests run under node and would not tell.
    files: [
      "packages/shared/src/events.ts",
      "packages/shared/src/text.ts",
      "packages/shared/src/web.ts",
      "packages/shared/src/address.ts",
    ],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "node:*",
                ...builtinModules,
                "./*",
                "../*",
                "zod",
                "@rosterdock/shared",
                "@rosterdock/shared/*",
              ],
              allowTypeImports: true,
              message: "This module runs in the browser too: import types only, or nothing that needs node.",
            },
          ],
        },
      ],
      "@typescript-eslint/no-import-type-side-effects": "error",
      "no-restricted-globals": [
        "error",
        ...[
          "Buffer",
          "process",
          "require",
          "global",
          "setImmediate",
          "clearImmediate",
          "__dirname",
          "__filename",
        ].map((name) => ({ name, message: "This module runs in the browser too." })),
      ],
      "no-restricted-properties": [
        "error",
        ...["Buffer", "process", "require", "setImmediate", "clearImmediate"].map((property) => ({
          object: "globalThis",
          property,
          message: "This module runs in the browser too.",
        })),
      ],
      // What the two rules above cannot see: a module loaded later, globalThis behind a cast or a name of
      // its own, and node's import.meta.
      "no-restricted-syntax": [
        "error",
        { selector: "ImportExpression", message: "This module runs in the browser too: no dynamic import." },
        {
          selector:
            "TSAsExpression[expression.name='globalThis'], TSNonNullExpression[expression.name='globalThis']",
          message: "This module runs in the browser too: globalThis as it is.",
        },
        {
          selector:
            "VariableDeclarator[init.name='globalThis'], CallExpression[callee.object.name='Reflect'] > Identifier[name='globalThis']",
          message: "This module runs in the browser too: globalThis as it is.",
        },
        {
          selector:
            "MemberExpression[object.type='MetaProperty'][property.name=/^(dirname|filename|resolve)$/]",
          message: "This module runs in the browser too: no node import.meta.",
        },
      ],
    },
  },
);
