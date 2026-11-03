import { z } from "zod";
import { resolve } from "node:path";
export const Config = z.object({
  DATABASE_URL: z
    .string()
    .default("postgres://hyper:hyper@127.0.0.1:55432/hyper_v1"),
  DATA_DIR: z.string().default("./.data-v1"),
  PUBLIC_ORIGIN: z.url().default("http://localhost:8081"),
  ADDITIONAL_ORIGINS: z
    .array(
      z
        .url()
        .refine((value) =>
          ["http:", "https:"].includes(new URL(value).protocol),
        ),
    )
    .default([]),
  PORT: z.coerce.number().int().min(1).max(65535).default(8081),
  HOST: z.string().default("127.0.0.1"),
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_MODEL: z.string().default("deepseek-chat"),
  DEEPSEEK_BASE_URL: z.url().default("https://api.deepseek.com"),
  EXA_API_KEY: z.string().optional(),
  RUNNER_URL: z.url().optional(),
  RUNNER_TOKEN: z.string().min(32).optional(),
  RUNNER_PORT: z.coerce.number().default(8082),
  SANDBOX_IMAGE: z.string().default("hyperagents-sandbox:1"),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
});
export type Config = z.infer<typeof Config>;
export function config(env: NodeJS.ProcessEnv = process.env): Config {
  const c = Config.parse({
    ...env,
    ADDITIONAL_ORIGINS: env.ADDITIONAL_ORIGINS?.split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  });
  c.DATA_DIR = resolve(c.DATA_DIR);
  return c;
}
