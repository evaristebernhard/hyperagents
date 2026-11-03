// Opt-in real runtime acceptance. Missing gVisor is a failed preflight, never a mock pass.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config, validate } from "@hyper/runtime";
import { createRunner } from "@hyper/runner";
const exec = promisify(execFile),
  token = randomUUID() + randomUUID(),
  root = await mkdtemp(join(tmpdir(), "hyper-sandbox-test-"));
const runner = await createRunner(
  config({ ...process.env, DATA_DIR: root, RUNNER_TOKEN: token }),
);
const headers = { authorization: "Bearer " + token };
const ids: string[] = [];
async function run(
  code: string,
  outputs: string[] = [],
  language: "python" | "node" = "python",
) {
  const operationId = randomUUID();
  ids.push(operationId);
  const payload = {
    operationId,
    taskId: randomUUID(),
    language,
    code,
    inputs: [],
    outputs,
  };
  const response = await runner.inject({
    method: "POST",
    url: "/run",
    headers,
    payload,
  });
  return { response, payload, result: response.json() };
}
try {
  const health = (await runner.inject({ url: "/health", headers })).json();
  if (!health.available) {
    console.log(JSON.stringify({ status: "blocked", reason: health.reason }));
    process.exitCode = 1;
  } else {
    const python = await run(
      'import os,json\nprint(json.dumps({"answer":2+2,"keyPresent":"DEEPSEEK_API_KEY" in os.environ,"socket":os.path.exists("/var/run/docker.sock")}))',
    );
    assert.equal(python.result.status, "completed", JSON.stringify(python.result));
    assert.deepEqual(JSON.parse(python.result.stdout), {
      answer: 4,
      keyPresent: false,
      socket: false,
    });
    const repeated = await runner.inject({
      method: "POST",
      url: "/run",
      headers,
      payload: python.payload,
    });
    assert.deepEqual(repeated.json(), python.result);
    const changed = await runner.inject({
      method: "POST",
      url: "/run",
      headers,
      payload: { ...python.payload, code: "print(999)" },
    });
    assert.equal(changed.statusCode, 409);
    assert.equal(
      (await run("console.log(6*7)", [], "node")).result.stdout.trim(),
      "42",
    );
    const network = await run(
      'import socket\ns=socket.socket();s.settimeout(2)\ntry:\n s.connect(("8.8.8.8",53));print("UNSAFE")\nexcept OSError:\n print("BLOCKED")',
    );
    assert.equal(network.result.stdout.trim(), "BLOCKED");
    const outputs = await run(
      'from reportlab.pdfgen import canvas\nfrom reportlab.pdfbase import pdfmetrics\nfrom reportlab.pdfbase.ttfonts import TTFont\npdfmetrics.registerFont(TTFont("CN","/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"))\nc=canvas.Canvas("proof.pdf");c.setFont("CN",16);c.drawString(50,700,"中文验证：数学题与答案");c.save()\nimport matplotlib;matplotlib.use("Agg")\nimport matplotlib.pyplot as plt\nplt.bar(["A","B"],[20,20]);plt.savefig("chart.png")',
      ["proof.pdf", "chart.png"],
    );
    assert.equal(outputs.result.status, "completed");
    for (const output of outputs.result.outputs)
      await validate(
        Buffer.from(output.data, "base64"),
        output.path.endsWith(".pdf") ? "pdf" : "png",
      );
    const symlink = await run(
      'import os\nos.symlink("/inputs/program.py","escape.txt")',
      ["escape.txt"],
    );
    assert.notEqual(symlink.result.status, "completed");
    const memory = await run("a=bytearray(3*1024*1024*1024)\nfor i in range(0,len(a),4096): a[i]=1");
    assert.equal(memory.result.status, "failed", JSON.stringify(memory.result));
    const disk = await run(
      'import os\ntry:\n for i in range(90):\n  with open(str(i),"wb") as f:\n   for j in range(19): f.write(b"x"*1024*1024)\n print("UNSAFE")\nexcept OSError:\n print("LIMITED")',
    );
    assert.equal(disk.result.stdout.trim(), "LIMITED");
    const pids = await run(
      'import subprocess\nchildren=[]\ntry:\n for i in range(200): children.append(subprocess.Popen(["sleep","5"]))\n print("UNSAFE")\nexcept OSError:\n print("LIMITED")\nfinally:\n for p in children: p.terminate()\n for p in children: p.wait()',
    );
    assert.equal(pids.result.stdout.trim(), "LIMITED");
    const op = randomUUID();
    ids.push(op);
    const pending = runner.inject({
      method: "POST",
      url: "/run",
      headers,
      payload: {
        operationId: op,
        taskId: randomUUID(),
        language: "python",
        code: "import time\ntime.sleep(60)",
        inputs: [],
        outputs: [],
      },
    });
    await new Promise((r) => setTimeout(r, 1500));
    await runner.inject({
      method: "POST",
      url: "/operations/" + op + "/cancel",
      headers,
    });
    const cancelled = (await pending).json();
    assert.ok(cancelled.status === "cancelled" || cancelled.error);
    const timeout = await run("import time\ntime.sleep(300)");
    assert.equal(timeout.result.status, "failed");
    for (const id of ids) {
      const inspection = await exec("docker", [
        "ps",
        "-aq",
        "--filter",
        "name=hyper-v1-" + id,
      ]);
      assert.equal(inspection.stdout.trim(), "");
    }
    console.log(
      JSON.stringify({
        status: "passed",
        checks: [
          "python",
          "node",
          "no-secrets",
          "no-socket",
          "network-off",
          "idempotency",
          "chinese-pdf-render",
          "png",
          "symlink-rejection",
          "memory-limit",
          "workdir-limit",
          "pid-limit",
          "cancellation",
          "timeout",
          "no-residual-containers",
        ],
      }),
    );
  }
} finally {
  await runner.close();
}
