import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  config,
  pool,
  migrate,
  bootstrap,
  invite,
  RunnerClient,
} from "@hyper/runtime";
const c = config(),
  command = process.argv[2];
if (["migrate", "bootstrap", "invite", "doctor"].includes(command ?? "")) {
  const db = pool(c.DATABASE_URL);
  try {
    if (command === "migrate") {
      await migrate(db);
      console.log("Migrations applied.");
    }
    if (command === "bootstrap") {
      if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD)
        throw new Error(
          "Set ADMIN_EMAIL and ADMIN_PASSWORD (never command-line password arguments).",
        );
      console.log(
        await bootstrap(db, {
          email: process.env.ADMIN_EMAIL,
          password: process.env.ADMIN_PASSWORD,
        }),
      );
    }
    if (command === "invite") {
      const r = await db.query<{ id: string }>(
        "SELECT id FROM users WHERE admin=true ORDER BY created_at LIMIT 1",
      );
      if (!r.rows[0]) throw new Error("Bootstrap first.");
      console.log(JSON.stringify({ invite: await invite(db, r.rows[0].id) }));
    }
    if (command === "doctor") {
      let database = false;
      try {
        await db.query("SELECT 1");
        database = true;
      } catch {}
      const sandbox = await new RunnerClient(c).health();
      console.log(
        JSON.stringify(
          {
            node: process.version,
            database,
            modelConfigured: !!c.DEEPSEEK_API_KEY,
            model: c.DEEPSEEK_MODEL,
            sandbox,
          },
          null,
          2,
        ),
      );
      if (!database || !sandbox.available) process.exitCode = 1;
    }
  } finally {
    await db.end();
  }
} else {
  const origin = c.PUBLIC_ORIGIN,
    sessionPath = join(c.DATA_DIR, "cli-session.json");
  let session: { cookie: string; csrf: string } | undefined;
  try {
    session = JSON.parse(await readFile(sessionPath, "utf8"));
  } catch {}
  async function request(
    path: string,
    method = "GET",
    body?: unknown,
    extra: Record<string, string> = {},
  ) {
    const r = await fetch(origin + "/api/v1" + path, {
      method,
      headers: {
        origin,
        "content-type": "application/json",
        ...(session
          ? { cookie: session.cookie, "x-csrf-token": session.csrf }
          : {}),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!r.ok) throw new Error("HTTP " + r.status + ": " + (await r.text()));
    return r;
  }
  if (command === "login") {
    const r = await request("/auth/login", "POST", {
      email: process.env.AGENT_EMAIL,
      password: process.env.AGENT_PASSWORD,
    });
    const data = (await r.json()) as { csrfToken: string };
    session = {
      cookie: r.headers.get("set-cookie")!.split(";")[0]!,
      csrf: data.csrfToken,
    };
    await mkdir(c.DATA_DIR, { recursive: true, mode: 0o700 });
    await writeFile(sessionPath, JSON.stringify(session), { mode: 0o600 });
    console.log("Session saved.");
  } else if (command === "register") {
    await request("/auth/register", "POST", {
      email: process.env.AGENT_EMAIL,
      password: process.env.AGENT_PASSWORD,
      invite: process.env.AGENT_INVITE,
    });
    console.log("Registered.");
  } else if (command === "task") {
    const input = JSON.parse(
      await readFile(process.argv[3] ?? "-", "utf8"),
    ) as unknown;
    console.log(
      await (
        await request("/tasks", "POST", input, {
          "idempotency-key": process.argv[4] ?? randomUUID(),
        })
      ).json(),
    );
  } else if (command === "get") {
    console.log(
      JSON.stringify(
        await (await request("/tasks/" + process.argv[3])).json(),
        null,
        2,
      ),
    );
  } else if (command === "events") {
    console.log(
      JSON.stringify(
        await (
          await request(
            "/tasks/" +
              process.argv[3] +
              "/events?after=" +
              (process.argv[4] ?? "0"),
          )
        ).json(),
        null,
        2,
      ),
    );
  } else if (command === "cancel" || command === "retry") {
    console.log(
      await (
        await request("/tasks/" + process.argv[3] + "/" + command, "POST")
      ).json(),
    );
  } else if (command === "instruct") {
    console.log(
      await (
        await request("/tasks/" + process.argv[3] + "/instructions", "POST", {
          message: await readFile(process.argv[4]!, "utf8"),
        })
      ).json(),
    );
  } else if (command === "upload") {
    const name = process.argv[3]!;
    const { basename } = await import("node:path");
    const form = new FormData();
    form.set("file", new Blob([await readFile(name)]), basename(name));
    const r = await fetch(origin + "/api/v1/files", {
      method: "POST",
      headers: {
        origin,
        cookie: session?.cookie ?? "",
        "x-csrf-token": session?.csrf ?? "",
      },
      body: form,
    });
    if (!r.ok) throw new Error("Upload HTTP " + r.status);
    console.log(await r.json());
  } else if (command === "download") {
    const r = await request("/files/" + process.argv[3] + "/download");
    await writeFile(process.argv[4]!, Buffer.from(await r.arrayBuffer()), {
      flag: "wx",
      mode: 0o600,
    });
    console.log("Downloaded.");
  } else {
    console.log(
      "Commands: migrate | bootstrap | invite | doctor | register | login | task <request.json> [idempotency-key] | get <taskId> | events <taskId> [cursor] | cancel/retry <taskId> | instruct <taskId> <message.txt> | upload <file> | download <fileId> <destination>",
    );
  }
}
