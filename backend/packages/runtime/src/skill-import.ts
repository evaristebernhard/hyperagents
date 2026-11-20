import { spawn } from "node:child_process";
import { DomainError } from "@hyper/contracts";
// Parse without extracting. Refuse links, encrypted entries, traversal and zip bombs.
export async function readSkillZip(
  bytes: Buffer,
): Promise<Record<string, string>> {
  if (bytes.length > 2_000_000)
    throw new DomainError("SKILL_ARCHIVE_LIMIT", 413);
  return new Promise((resolve, reject) => {
    const p = spawn(
      "python3",
      [
        "-c",
        `
import sys,io,zipfile,json,stat
z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))
entries=z.infolist()
assert len(entries)<=250, 'ARCHIVE_FILE_LIMIT'
assert sum(e.file_size for e in entries)<=2000000, 'ARCHIVE_SIZE_LIMIT'
files={}
for e in entries:
 p=e.filename
 assert not p.startswith('/') and '\\\\' not in p and all(x not in ('.','..') for x in p.split('/')), 'ARCHIVE_PATH'
 assert not stat.S_ISLNK(e.external_attr>>16), 'ARCHIVE_LINK'
 assert not e.flag_bits & 1, 'ARCHIVE_ENCRYPTED'
 if e.is_dir(): continue
 assert p not in files, 'ARCHIVE_DUPLICATE'
 files[p]=z.read(e).decode('utf-8')
roots=[p[:-8] for p in files if p=='SKILL.md' or p.endswith('/SKILL.md')]
assert len(roots)==1, 'SELECT_ONE_SKILL_PACKAGE'
root=roots[0]
print(json.dumps({p[len(root):]:v for p,v in files.items() if p.startswith(root) and (p[len(root):]=='SKILL.md' or p[len(root):].startswith(('scripts/','references/','assets/')))}))
`,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let out = "",
      err = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), 10000);
    p.stdout.on("data", (b) => {
      out += b;
      if (out.length > 12_000_000) p.kill("SIGKILL");
    });
    p.stderr.on("data", (b) => {
      err += b;
      if (err.length > 8000) p.kill("SIGKILL");
    });
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new DomainError("INVALID_SKILL_ARCHIVE"));
      else {
        try {
          resolve(JSON.parse(out));
        } catch {
          reject(new DomainError("INVALID_SKILL_ARCHIVE"));
        }
      }
    });
    p.stdin.on("error", () => {});
    p.stdin.end(bytes);
  });
}
export async function githubSkill(repository: string, ref: string) {
  if (
    !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository) ||
    !ref ||
    ref.length > 100
  )
    throw new DomainError("INVALID_GITHUB_SOURCE");
  const response = await fetch(
    `https://api.github.com/repos/${repository}/commits/${encodeURIComponent(ref)}`,
    {
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: { Accept: "application/vnd.github+json" },
    },
  );
  if (!response.ok) throw new DomainError("GITHUB_IMPORT_FAILED");
  const data = (await response.json()) as { sha?: string };
  if (!data.sha || !/^[a-f0-9]{40}$/.test(data.sha))
    throw new DomainError("INVALID_GITHUB_COMMIT");
  const archive = await fetch(
    `https://codeload.github.com/${repository}/zip/${data.sha}`,
    { redirect: "error", signal: AbortSignal.timeout(20000) },
  );
  if (!archive.ok || !archive.body)
    throw new DomainError("GITHUB_IMPORT_FAILED");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of archive.body) {
    size += chunk.length;
    if (size > 2_000_000) {
      throw new DomainError("SKILL_ARCHIVE_LIMIT", 413);
    }
    chunks.push(chunk);
  }
  return {
    files: await readSkillZip(Buffer.concat(chunks)),
    source: {
      kind: "github" as const,
      url: `https://github.com/${repository}`,
      commit: data.sha,
    },
  };
}
