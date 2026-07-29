import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

// Die .env liegt im Projektwurzelverzeichnis; Next.js sucht sie nur in
// apps/web. Ohne diese Zeile stünde DATABASE_URL zur Laufzeit nicht bereit.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
loadEnv({ path: path.join(repoRoot, ".env") });

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace-Pakete werden als TypeScript-Quelle eingebunden.
  transpilePackages: ["@lping/core", "@lping/db"],
  // Prisma darf nicht gebündelt werden (native Query-Engine).
  serverExternalPackages: ["@prisma/client", ".prisma/client"],
  env: {
    DATABASE_URL: process.env.DATABASE_URL ?? "",
  },
};

export default nextConfig;
