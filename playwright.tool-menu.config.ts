import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
export default defineConfig({
 testDir:"./tests", testMatch:["tool-menu-parity.spec.ts","menu-fidelity.spec.ts"], workers:1, timeout:30000,
 use:{baseURL:"http://127.0.0.1:21987", ...devices["Desktop Chrome"], viewport:{width:1280,height:900}, screenshot:"off",trace:"off"},
 outputDir:mkdtempSync(path.join(tmpdir(),"hyperagents-menu-results-")), reporter:[["list"]],
 webServer:{command:"npm run dev:fixtures -- --host 127.0.0.1 --port 21987",url:"http://127.0.0.1:21987",reuseExistingServer:false,timeout:30000}
});
