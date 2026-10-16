import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const BOARD_URL = process.env.ROSTERDOCK_BOARD_URL ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The licence of every package the bundle carries, its text included, beside the bundle: the web image
  // ships it and serves it at /third-party-licenses.txt.
  build: { license: { fileName: "third-party-licenses.txt" } },
  server: {
    proxy: {
      "/api": { target: BOARD_URL, changeOrigin: false },
    },
  },
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    environment: "node",
  },
});
