import { pathToFileURL } from "node:url";
import { config } from "@hyper/runtime";
import { createRunner } from "./service.js";
export { createRunner, containerArgs } from "./service.js";
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const c = config(),
    app = await createRunner(c);
  await app.listen({ host: c.HOST, port: c.RUNNER_PORT });
  for (const sig of ["SIGINT", "SIGTERM"])
    process.once(sig, () => {
      void app.close().then(() => process.exit(0));
    });
}
