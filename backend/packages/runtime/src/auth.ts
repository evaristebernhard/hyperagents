import {
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import argon2 from "argon2";
import { Credentials, DomainError, Register } from "@hyper/contracts";
import { tx, type Db } from "./db.js";
export const token = () => randomBytes(32).toString("base64url");
export const hash = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
export const equal = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export interface Identity {
  userId: string;
  workspaceId: string;
  admin: boolean;
  email: string;
  csrfHash: string;
  role: "admin" | "member" | "viewer";
}
const hashPassword = (s: string) =>
  argon2.hash(s, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  });
export async function bootstrap(db: Db, input: unknown) {
  const v = Credentials.parse(input),
    password = await hashPassword(v.password);
  return tx(db, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(730103)");
    if ((await c.query("SELECT 1 FROM users LIMIT 1")).rowCount)
      throw new DomainError("ALREADY_BOOTSTRAPPED", 409);
    const userId = randomUUID(),
      workspaceId = randomUUID();
    await c.query(
      "INSERT INTO users(id,email,password_hash,admin) VALUES($1,$2,$3,true)",
      [userId, v.email, password],
    );
    await c.query("INSERT INTO workspaces(id,user_id) VALUES($1,$2)", [
      workspaceId,
      userId,
    ]);
    return { userId, workspaceId };
  });
}
export async function invite(db: Db, userId: string) {
  const secret = token();
  await db.query(
    "INSERT INTO invites(id,token_hash,created_by,expires_at) VALUES($1,$2,$3,now()+interval '7 days')",
    [randomUUID(), hash(secret), userId],
  );
  return secret;
}
export async function register(db: Db, input: unknown) {
  const v = Register.parse(input),
    password = await hashPassword(v.password);
  await tx(db, async (c) => {
    const r = await c.query(
      "SELECT id FROM invites WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() FOR UPDATE",
      [hash(v.invite)],
    );
    const team = r.rowCount
      ? undefined
      : (
          await c.query(
            "SELECT * FROM team_invites WHERE token_hash=$1 AND email=$2 AND used_at IS NULL AND expires_at>now() FOR UPDATE",
            [hash(v.invite), v.email],
          )
        ).rows[0];
    if (!r.rowCount && !team) throw new DomainError("INVALID_INVITE", 400);
    const id = randomUUID();
    await c.query(
      "INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)",
      [id, v.email, password],
    );
    await c.query("INSERT INTO workspaces(id,user_id) VALUES($1,$2)", [
      randomUUID(),
      id,
    ]);
    if (team) {
      await c.query(
        "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,$3)",
        [team.workspace_id, id, team.role],
      );
      await c.query("UPDATE team_invites SET used_at=now() WHERE id=$1", [
        team.id,
      ]);
    }
    await c.query("UPDATE invites SET used_at=now() WHERE token_hash=$1", [
      hash(v.invite),
    ]);
  });
}
let dummy: Promise<string> | undefined;
export async function login(db: Db, input: unknown) {
  const v = Credentials.parse(input);
  const r = await db.query<{ id: string; password_hash: string }>(
    "SELECT id,password_hash FROM users WHERE email=$1",
    [v.email],
  );
  dummy ??= hashPassword(token());
  const valid = await argon2.verify(
    r.rows[0]?.password_hash ?? (await dummy),
    v.password,
  );
  if (!r.rows[0] || !valid) throw new DomainError("INVALID_CREDENTIALS", 401);
  const session = token(),
    csrf = token();
  await db.query(
    "INSERT INTO sessions(token_hash,user_id,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '7 days')",
    [hash(session), r.rows[0].id, hash(csrf)],
  );
  return { session, csrf };
}
export async function authenticate(
  db: Db,
  session?: string,
): Promise<Identity> {
  if (!session) throw new DomainError("UNAUTHENTICATED", 401);
  const r = await db.query<{
    id: string;
    workspace_id: string;
    email: string;
    admin: boolean;
    csrf_hash: string;
    role: "admin" | "member" | "viewer";
  }>(
    "SELECT u.id,u.email,u.admin,w.id workspace_id,s.csrf_hash,CASE WHEN w.user_id=u.id THEN 'admin' ELSE m.role END role FROM sessions s JOIN users u ON u.id=s.user_id JOIN workspaces personal ON personal.user_id=u.id AND personal.kind='personal' JOIN workspaces w ON w.id=COALESCE(s.active_workspace_id,personal.id) LEFT JOIN workspace_members m ON m.workspace_id=w.id AND m.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>now() AND (w.user_id=u.id OR m.user_id=u.id)",
    [hash(session)],
  );
  const u = r.rows[0];
  if (!u) throw new DomainError("UNAUTHENTICATED", 401);
  return {
    userId: u.id,
    workspaceId: u.workspace_id,
    email: u.email,
    admin: u.admin,
    csrfHash: u.csrf_hash,
    role: u.role,
  };
}
