import type { Db, Config } from "@hyper/runtime";
import type { FastifyInstance } from "fastify";
export function createBrowserService(
  db: Db,
  config: Config,
  options?: { test?: boolean },
): Promise<FastifyInstance>;
