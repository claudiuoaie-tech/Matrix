import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // This project lives inside the Rota-Matrix repo alongside the Express backend
  // (which has its own lockfile). Pin the workspace root to this folder so Next
  // doesn't infer the parent directory.
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
