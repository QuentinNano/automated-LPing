/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace-Pakete werden als TypeScript-Quelle eingebunden.
  transpilePackages: ["@lping/core", "@lping/db"],
  // Prisma darf nicht gebündelt werden (native Query-Engine).
  serverExternalPackages: ["@prisma/client", ".prisma/client"],
};

export default nextConfig;
