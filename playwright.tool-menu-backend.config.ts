import {defineConfig,devices} from "@playwright/test";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
const dataDir=mkdtempSync(path.join(tmpdir(),"hyperagents-menu-backend-"));
export default defineConfig({testDir:"./tests-backend",testMatch:"tool-menu-capabilities.spec.ts",workers:1,timeout:45000,
 use:{...devices["Desktop Chrome"],baseURL:"http://127.0.0.1:21988",viewport:{width:1280,height:900},trace:"off",screenshot:"off"},
 outputDir:path.join(dataDir,"results"),reporter:[["list"]],
 webServer:{command:"npm run dev -- --host 127.0.0.1 --port 21988 --strictPort",url:"http://127.0.0.1:21988",reuseExistingServer:false,timeout:30000,
  env:{APP_DATA_DIR:dataDir,APP_PORT:"21989",APP_HOST:"127.0.0.1",APP_DEV_ORIGIN:"http://127.0.0.1:21988",APP_ENV_FILE:"none"}}
});
