import { defineConfig, normalizePath } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import privateDataPlugin, { privateFsDeny } from "./scripts/private-data.mjs";
const apiPort = process.env.APP_PORT || "8787";
const publicHost = process.env.APP_PUBLIC_ORIGIN ? new URL(process.env.APP_PUBLIC_ORIGIN).hostname : "";
// These independent reference checkouts are not application sources. Watching
// their very large trees exhausts inotify and repeatedly crashes the dev server.
const referenceRoots = ["OpenMausBot", "browser", "macro", ".data", ".runtime-v1-backup-20261029"].map(
  name => normalizePath(fileURLToPath(new URL(`./${name}`, import.meta.url))),
);
export default defineConfig({
  plugins: [privateDataPlugin(), react()],
  base: "/",
  server: {
    host: "127.0.0.1",
    fs: { strict: true, deny: privateFsDeny },
    watch: {
      ignored: (watchedPath: string) => {
        const normalized = normalizePath(watchedPath);
        return referenceRoots.some(root => normalized === root || normalized.startsWith(root + "/"));
      },
    },
    headers: { "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" },
    allowedHosts: ["localhost", "127.0.0.1", "lp.chayu123.me", "hyper.chayu123.me", ...(publicHost ? [publicHost] : [])],
    proxy: { "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } },
  },
  preview: {
    host: "127.0.0.1",
    allowedHosts: ["localhost", "127.0.0.1", "lp.chayu123.me", "hyper.chayu123.me", ...(publicHost ? [publicHost] : [])],
  },
});
