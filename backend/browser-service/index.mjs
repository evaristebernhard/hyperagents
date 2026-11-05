import { config, pool } from "@hyper/runtime";
import { createBrowserService } from "./service.mjs";
const c = config(),
  db = pool(c.DATABASE_URL);
const app = await createBrowserService(db, c);
await app.listen({ host: c.HOST, port: c.BROWSER_PORT });
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, () => {
    void app
      .close()
      .then(() => db.end())
      .then(() => process.exit(0));
  });
