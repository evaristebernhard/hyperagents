import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import privateDataPlugin, { privateFsDeny } from "./scripts/private-data.mjs";
const apiPort = process.env.APP_PORT || "8787";
const publicHost = process.env.APP_PUBLIC_ORIGIN ? new URL(process.env.APP_PUBLIC_ORIGIN).hostname : "";
export default defineConfig({
  plugins: [privateDataPlugin(), react()],
  base: "/",
  server: {
    host: "127.0.0.1",
    fs: { strict: true, deny: privateFsDeny },
    headers: { "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" },
    allowedHosts: ["localhost", "127.0.0.1", ...(publicHost ? [publicHost] : [])],
    proxy: { "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } },
  },
  preview: { host: "127.0.0.1", allowedHosts: ["localhost", "127.0.0.1", ...(publicHost ? [publicHost] : [])] },
});
