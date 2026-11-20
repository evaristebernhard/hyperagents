import { randomUUID } from "node:crypto";
import { pool, claim, Storage } from "@hyper/runtime";
const db = pool(process.env.TEST_CRASH_DATABASE_URL!);
const task = await claim(db);
if (!task || task.id !== process.env.TEST_CRASH_TASK_ID)
  throw new Error("wrong task");
const id = randomUUID(),
  args = {
    name: "crash.md",
    format: "md" as const,
    content: "Persisted before SIGKILL",
    sourceIds: [],
  };
await db.query(
  "INSERT INTO operations(id,task_id,step,call_id,name,args,status,replay) VALUES($1,$2,1,'saved-before-kill','artifact_write',$3,'running','safe')",
  [id, task.id, JSON.stringify(args)],
);
await db.query("UPDATE tasks SET step=1,checkpoint=$2 WHERE id=$1", [
  task.id,
  JSON.stringify({
    messages: [
      { role: "system", content: "Complete the requested artifact." },
      { role: "user", content: task.prompt },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "saved-before-kill",
            name: "artifact_write",
            arguments: JSON.stringify(args),
          },
        ],
      },
    ],
  }),
]);
await new Storage(process.env.TEST_CRASH_DATA_DIR!, db).artifact(
  task,
  id,
  { ...args, bytes: Buffer.from(args.content) },
  task.lease_owner!,
);
console.log("CRASH_WINDOW_READY");
setInterval(() => {}, 1000);
