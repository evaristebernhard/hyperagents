import { pathToFileURL } from "node:url";
import { config, pool } from "@hyper/runtime";
import { buildApp } from "./app.js";
export { buildApp };
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const c = config(),
    db = pool(c.DATABASE_URL),
    app = await buildApp(db, c);
  await app.listen({ host: c.HOST, port: c.PORT });
  console.log(JSON.stringify({ service: "api", port: c.PORT }));
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => {
      void app
        .close()
        .then(() => db.end())
        .then(() => process.exit(0));
    });
}
