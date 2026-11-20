import type { Server } from "node:http";
export function publicAddress(
  host: string,
  resolver?: (
    host: string,
    options: unknown,
  ) => Promise<{ address: string; family: number }[]>,
): Promise<{ address: string; family: number }>;
export function createEgressProxy(): Server;
