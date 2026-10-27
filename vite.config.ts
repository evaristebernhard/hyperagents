import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  base: "/",
  server: {
    host: "0.0.0.0",
    allowedHosts: ["lp.chayu123.me"],
  },
  preview: {
    host: "0.0.0.0",
    allowedHosts: ["lp.chayu123.me"],
  },
});
