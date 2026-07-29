import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "packages/**/test/**/*.test.ts",
      "apps/**/test/**/*.test.ts",
    ],
  },
  resolve: {
    alias: {
      "@lping/core": path.resolve(root, "packages/core/src/index.ts"),
      "@lping/adapters": path.resolve(root, "packages/adapters/src/index.ts"),
      "@lping/db": path.resolve(root, "packages/db/src/index.ts"),
    },
  },
});
