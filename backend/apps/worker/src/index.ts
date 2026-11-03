import { PgBoss } from "pg-boss";
import { config, pool, Engine, runSchedules } from "@hyper/runtime";
const c = config(),
  db = pool(c.DATABASE_URL),
  engine = new Engine(db, c),
  boss = new PgBoss(c.DATABASE_URL);
let stopping = false,
  scanning = false;
boss.on("error", () =>
  console.error(JSON.stringify({ service: "queue", code: "QUEUE_ERROR" })),
);
await boss.start();
await boss.createQueue("task-wake");
const running = new Set<Promise<void>>();
async function drain() {
  if (scanning || stopping) return;
  scanning = true;
  try {
    await runSchedules(db);
    while (running.size < 6) {
      const { claim, wakeParents } = await import("@hyper/runtime");
      await wakeParents(db);
      const task = await claim(db);
      if (!task) break;
      const p = engine
        .run(task)
        .catch(() => {
          console.error(
            JSON.stringify({ taskId: task.id, code: "WORKER_ERROR" }),
          );
        })
        .finally(() => running.delete(p));
      running.add(p);
    }
  } finally {
    scanning = false;
  }
}
await boss.work("task-wake", async () => {
  await drain();
});
// Queue deliveries are hints. This reconciliation also covers lost wakeups and DB outages.
const timer = setInterval(() => {
  void boss
    .send("task-wake", {}, { singletonKey: "scan", singletonSeconds: 2 })
    .catch(() => {});
  void drain().catch(() => {});
}, 2000);
await drain();
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, () => {
    stopping = true;
    clearInterval(timer);
    void boss
      .stop({ graceful: true, timeout: 5000 })
      .then(() => Promise.allSettled([...running]))
      .then(() => db.end())
      .then(() => process.exit(0));
  });
