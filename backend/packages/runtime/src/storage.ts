import { mkdir, open, readFile, rename, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TextDecoder } from "node:util";
import { parse } from "csv-parse/sync";
import { PNG } from "pngjs";
import { PDFDocument } from "pdf-lib";
import { load } from "cheerio";
import { DomainError, Format, Id, Limits, mime } from "@hyper/contracts";
import { tx, fenced, type Db, type Queryable, type Task } from "./db.js";
import { hash } from "./auth.js";
const exec = promisify(execFile);
export interface FileRow {
  id: string;
  workspace_id: string;
  task_id: string | null;
  name: string;
  format: Format;
  mime: string;
  bytes: string;
  sha256: string;
  storage_key: string;
}
export interface Validation {
  passed: boolean;
  issues: string[];
  text: string;
  checks: string[];
}
interface SavedRow {
  artifact_id: string;
  file_id: string;
  version: number;
  validation: { passed: boolean; checks: string[] };
}
function savedArtifact(row: SavedRow) {
  return {
    artifactId: row.artifact_id,
    fileId: row.file_id,
    version: row.version,
    downloadUrl: "/api/v1/files/" + row.file_id + "/download",
    validation: row.validation,
  };
}
export async function validate(
  bytes: Buffer,
  format: Format,
): Promise<Validation> {
  const checks: string[] = [];
  let text = "";
  if (!bytes.length || bytes.length > Limits.fileBytes)
    throw new DomainError("FILE_SIZE");
  if (format === "png") {
    if (
      bytes.length < 24 ||
      !bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 20_000_000
    )
      throw new DomainError("INVALID_PNG");
    const png = PNG.sync.read(bytes, { checkCRC: true });
    if (!png.width || !png.height || png.width * png.height > 20_000_000)
      throw new DomainError("INVALID_PNG");
    checks.push("png-decoded");
  } else if (format === "pdf") {
    if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-")))
      throw new DomainError("MIME_MISMATCH");
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: false });
    if (pdf.getPageCount() < 1 || pdf.getPageCount() > 200)
      throw new DomainError("PDF_PAGE_LIMIT");
    const dir = await mkdtemp(join(tmpdir(), "hyper-pdf-"));
    try {
      await writeDurable(join(dir, "input.pdf"), bytes);
      const p = await exec(
        "pdftotext",
        ["-enc", "UTF-8", join(dir, "input.pdf"), "-"],
        { timeout: 15000, maxBuffer: 2 * 1024 * 1024 },
      );
      text = p.stdout;
      if (!text.trim()) throw new DomainError("OCR_REQUIRED");
      await exec(
        "pdftoppm",
        [
          "-scale-to",
          "800",
          "-png",
          join(dir, "input.pdf"),
          join(dir, "render"),
        ],
        { timeout: 30000, maxBuffer: 1024 * 1024 },
      );
      for (let page = 1; page <= pdf.getPageCount(); page++) {
        const suffix = String(page).padStart(
          String(pdf.getPageCount()).length,
          "0",
        );
        PNG.sync.read(await readFile(join(dir, `render-${suffix}.png`)));
      }
      if (/[\u3400-\u9fff]/.test(text)) {
        const fonts = await exec("pdffonts", [join(dir, "input.pdf")], {
          timeout: 10000,
          maxBuffer: 100000,
        });
        if (!/\byes\s+(yes|no)\s+(yes|no)\s+\d+\s+\d+/.test(fonts.stdout))
          throw new DomainError("PDF_CHINESE_FONT_NOT_EMBEDDED");
      }
      checks.push("pdf-parsed", "pdf-rendered", "pdf-text-extracted");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new DomainError("INVALID_UTF8");
    }
    if (text.includes("\0")) throw new DomainError("MIME_MISMATCH");
    if (
      format === "md" &&
      !text.includes("\n") &&
      /\\n(?:#|- |\d+\.)/.test(text)
    )
      throw new DomainError("ESCAPED_NEWLINES_USE_REAL_LINE_BREAKS");
    if (format === "json") {
      JSON.parse(text);
      checks.push("json-parsed");
    }
    if (format === "csv") {
      const rows: unknown[][] = parse(text, {
        bom: true,
        skip_empty_lines: true,
      });
      if (!rows.length || !rows[0]?.length)
        throw new DomainError("EMPTY_TABLE");
      checks.push("csv-parsed");
    }
    if (format === "html") {
      if (!/<html[\s>]/i.test(text) || !/<body[\s>]/i.test(text))
        throw new DomainError("INVALID_HTML");
      const $ = load(text);
      $("script,style").remove();
      if (!$("body").text().trim()) throw new DomainError("EMPTY_HTML");
      text = $("body").text();
      checks.push("html-parsed");
    }
    checks.push("utf8");
  }
  return { passed: true, issues: [], text, checks };
}
async function writeDurable(path: string, bytes: Buffer) {
  const f = await open(path, "wx", 0o600);
  try {
    await f.writeFile(bytes);
    await f.sync();
  } finally {
    await f.close();
  }
}
export class Storage {
  constructor(
    readonly root: string,
    readonly db: Db,
  ) {}
  async persist(workspace: string, bytes: Buffer) {
    Id.parse(workspace);
    const digest = hash(bytes),
      dir = join(this.root, "objects", workspace);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, digest),
      temp = join(dir, "." + randomUUID());
    await writeDurable(temp, bytes);
    await rename(temp, path);
    const d = await open(dir, "r");
    try {
      await d.sync();
    } finally {
      await d.close();
    }
    return { digest, key: workspace + "/" + digest };
  }
  async get(
    workspace: string,
    id: string,
    db: Queryable = this.db,
  ): Promise<FileRow> {
    const r = await db.query<FileRow>(
      "SELECT * FROM files WHERE id=$1 AND workspace_id=$2",
      [Id.parse(id), workspace],
    );
    if (!r.rows[0]) throw new DomainError("NOT_FOUND", 404);
    return r.rows[0];
  }
  async bytes(file: FileRow) {
    if (
      !/^[0-9a-f-]{36}\/[0-9a-f]{64}$/.test(file.storage_key) ||
      !file.storage_key.startsWith(file.workspace_id + "/")
    )
      throw new DomainError("STORAGE_CORRUPT", 500);
    const b = await readFile(join(this.root, "objects", file.storage_key));
    if (hash(b) !== file.sha256 || b.length !== Number(file.bytes))
      throw new DomainError("STORAGE_CORRUPT", 500);
    return b;
  }
  async upload(workspace: string, name: string, format: Format, bytes: Buffer) {
    if (/[\\/\x00-\x1f]/.test(name) || name.length > 160)
      throw new DomainError("INVALID_FILENAME");
    if (name.split(".").at(-1)?.toLowerCase() !== format)
      throw new DomainError("MIME_MISMATCH");
    await validate(bytes, format);
    const { digest, key } = await this.persist(workspace, bytes),
      id = randomUUID();
    await this.db.query(
      "INSERT INTO files(id,workspace_id,name,format,mime,bytes,sha256,storage_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [id, workspace, name, format, mime[format], bytes.length, digest, key],
    );
    return this.get(workspace, id);
  }
  async artifact(
    task: Task,
    operationKey: string,
    options: {
      name: string;
      format: Format;
      bytes: Buffer;
      artifactId?: string;
      sourceIds: string[];
    },
    owner: string,
  ) {
    const existing = await this.db.query<SavedRow>(
      "SELECT artifact_id,file_id,version,validation FROM artifact_versions WHERE operation_key=$1 AND workspace_id=$2",
      [operationKey, task.workspace_id],
    );
    if (existing.rows[0]) return savedArtifact(existing.rows[0]);
    if (options.name.split(".").at(-1)?.toLowerCase() !== options.format)
      throw new DomainError("MIME_MISMATCH");
    const validation = await validate(options.bytes, options.format);
    const { digest, key } = await this.persist(
      task.workspace_id,
      options.bytes,
    );
    return tx(this.db, async (c) => {
      await fenced(c, task.id, owner);
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        task.workspace_id,
      ]);
      const duplicate = await c.query<SavedRow>(
        "SELECT artifact_id,file_id,version,validation FROM artifact_versions WHERE operation_key=$1",
        [operationKey],
      );
      if (duplicate.rows[0]) return savedArtifact(duplicate.rows[0]);
      for (const id of options.sourceIds) {
        if (
          !(
            await c.query(
              "SELECT 1 FROM sources WHERE id=$1 AND workspace_id=$2",
              [id, task.workspace_id],
            )
          ).rowCount
        )
          throw new DomainError("INVALID_SOURCE");
      }
      // A same-name output in this conversation revises its existing artifact.
      // The workspace lock above serializes concurrent writers and operation keys
      // still make retries idempotent. Historical versions are never overwritten.
      const named = options.artifactId
        ? undefined
        : (
            await c.query<{ id: string }>(
              "SELECT a.id FROM artifacts a JOIN artifact_versions v ON v.artifact_id=a.id WHERE a.workspace_id=$1 AND a.conversation_id=$2 AND a.name=$3 GROUP BY a.id ORDER BY max(v.created_at) DESC LIMIT 1",
              [task.workspace_id, task.conversation_id, options.name],
            )
          ).rows[0]?.id;
      const artifactId = options.artifactId ?? named ?? randomUUID();
      let version = 1;
      if (options.artifactId || named) {
        const r = await c.query(
          "SELECT 1 FROM artifacts WHERE id=$1 AND workspace_id=$2 AND conversation_id=$3 FOR UPDATE",
          [artifactId, task.workspace_id, task.conversation_id],
        );
        if (!r.rowCount) throw new DomainError("NOT_FOUND", 404);
        const v = await c.query<{ v: number }>(
          "SELECT COALESCE(max(version),0)+1 v FROM artifact_versions WHERE artifact_id=$1",
          [artifactId],
        );
        version = v.rows[0]!.v;
      } else
        await c.query(
          "INSERT INTO artifacts(id,workspace_id,conversation_id,name) VALUES($1,$2,$3,$4)",
          [artifactId, task.workspace_id, task.conversation_id, options.name],
        );
      const reserved = await c.query(
        "UPDATE tasks SET artifact_bytes=artifact_bytes+$2 WHERE id=$1 AND artifact_bytes+$2<=$3 RETURNING id",
        [task.root_id, options.bytes.length, Limits.artifactBytes],
      );
      if (!reserved.rowCount) throw new DomainError("ARTIFACT_BUDGET");
      const fileId = randomUUID();
      await c.query(
        "INSERT INTO files(id,workspace_id,task_id,name,format,mime,bytes,sha256,storage_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          fileId,
          task.workspace_id,
          task.id,
          options.name,
          options.format,
          mime[options.format],
          options.bytes.length,
          digest,
          key,
        ],
      );
      await c.query(
        "INSERT INTO artifact_versions(id,artifact_id,workspace_id,task_id,file_id,version,operation_key,validation,source_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          randomUUID(),
          artifactId,
          task.workspace_id,
          task.id,
          fileId,
          version,
          operationKey,
          JSON.stringify({ ...validation, text: undefined }),
          JSON.stringify(options.sourceIds),
        ],
      );
      return {
        artifactId,
        fileId,
        version,
        downloadUrl: "/api/v1/files/" + fileId + "/download",
        validation: { passed: true, checks: validation.checks },
      };
    });
  }
  async readText(workspace: string, id: string) {
    const file = await this.get(workspace, id),
      bytes = await this.bytes(file);
    if (file.format === "png") throw new DomainError("UNSUPPORTED_FILE_READ");
    return file.format === "pdf"
      ? (await validate(bytes, file.format)).text
      : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
}
