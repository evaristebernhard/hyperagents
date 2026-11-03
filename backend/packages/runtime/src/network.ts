import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, request } from "undici";
import { load } from "cheerio";
import { z } from "zod";
import { DomainError } from "@hyper/contracts";
export function publicAddress(address: string) {
  try {
    let ip = ipaddr.parse(address);
    if (ip.kind() === "ipv6" && (ip as ipaddr.IPv6).isIPv4MappedAddress())
      ip = (ip as ipaddr.IPv6).toIPv4Address();
    return ip.range() === "unicast";
  } catch {
    return false;
  }
}
export function publicUrl(raw: string) {
  const u = new URL(raw);
  const h = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    !["http:", "https:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    (u.port && !["80", "443"].includes(u.port)) ||
    h.endsWith(".") ||
    /(?:^|\.)(localhost|local|internal|onion|test|invalid)$/.test(h) ||
    (isIP(h) && !publicAddress(h))
  )
    throw new DomainError("PRIVATE_NETWORK_BLOCKED");
  return u;
}
async function fetchPublicRaw(
  raw: string,
  signal: AbortSignal,
  options: {
    method?: "GET" | "POST";
    headers?: Record<string, string>;
    body?: string;
    redirects?: number;
    maxBytes?: number;
  } = {},
): Promise<{ url: string; text: string; type: string }> {
  let u = publicUrl(raw);
  const max = options.maxBytes ?? 2 * 1024 * 1024;
  for (let redirects = 0; redirects <= 4; redirects++) {
    signal.throwIfAborted();
    const h = u.hostname.replace(/^\[|\]$/g, "");
    const addresses = await lookup(h, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
      throw new DomainError("PRIVATE_NETWORK_BLOCKED");
    const pinned = addresses[0]!;
    const agent = new Agent({
      connect: {
        lookup: (_host, opts, cb) => {
          if (opts.all) cb(null, [pinned]);
          else cb(null, pinned.address, pinned.family);
        },
      },
    });
    try {
      const r = await request(u, {
        dispatcher: agent,
        method: options.method ?? "GET",
        body: options.body,
        headers: {
          "user-agent": "Hyperagents/1.0 (research reader)",
          accept: "text/html,text/plain,application/json,application/rss+xml",
          ...options.headers,
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        headersTimeout: 15000,
        bodyTimeout: 15000,
      });
      if ([301, 302, 303, 307, 308].includes(r.statusCode)) {
        r.body.destroy();
        if (
          options.method === "POST" ||
          options.redirects === 0 ||
          redirects === 4
        )
          throw new DomainError("REDIRECT_BLOCKED");
        const location = r.headers.location;
        if (typeof location !== "string")
          throw new DomainError("INVALID_REDIRECT");
        u = publicUrl(new URL(location, u).href);
        continue;
      }
      if (r.statusCode !== 200) {
        r.body.destroy();
        throw new DomainError("WEB_HTTP_" + r.statusCode, 502);
      }
      const length = Number(r.headers["content-length"]);
      if (length > max) {
        r.body.destroy();
        throw new DomainError("WEB_TOO_LARGE");
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const b of r.body) {
        const chunk = Buffer.from(b);
        bytes += chunk.length;
        if (bytes > max) {
          r.body.destroy();
          throw new DomainError("WEB_TOO_LARGE");
        }
        chunks.push(chunk);
      }
      return {
        url: u.href,
        text: new TextDecoder("utf-8", { fatal: false }).decode(
          Buffer.concat(chunks),
        ),
        type: String(r.headers["content-type"] ?? ""),
      };
    } finally {
      await agent.close();
    }
  }
  throw new DomainError("REDIRECT_BLOCKED");
}
export async function search(
  query: string,
  limit: number,
  signal: AbortSignal,
  key?: string,
) {
  if (key) {
    const r = await publicFetch("https://api.exa.ai/search", signal, {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        query,
        numResults: limit,
        contents: { text: { maxCharacters: 8000 } },
      }),
    });
    const parsed = z
      .object({
        results: z.array(
          z.object({
            url: z.url(),
            title: z.string().nullish(),
            text: z.string().nullish(),
          }),
        ),
      })
      .parse(JSON.parse(r.text));
    return {
      provider: "exa",
      degraded: false,
      results: parsed.results.map((r) => ({
        url: publicUrl(r.url).href,
        title: r.title ?? r.url,
        excerpt: (r.text ?? "").slice(0, 8000),
        read: !!r.text,
      })),
    };
  }
  const u = new URL("https://cn.bing.com/search");
  u.search = new URLSearchParams({ q: query, format: "rss" }).toString();
  const r = await publicFetch(u.href, signal, {
    redirects: 0,
    maxBytes: 128 * 1024,
  });
  if (/<!\s*(DOCTYPE|ENTITY)/i.test(r.text))
    throw new DomainError("INVALID_RSS");
  const $ = load(r.text, { xml: true });
  if (!$("rss > channel").length) throw new DomainError("SEARCH_UNAVAILABLE");
  return {
    provider: "public-bing-rss",
    degraded: true,
    results: $("item")
      .slice(0, limit)
      .toArray()
      .map((el) => ({
        url: publicUrl($(el).find("link").text()).href,
        title: $(el).find("title").text().slice(0, 500),
        excerpt: $(el).find("description").text().slice(0, 1500),
        read: false,
      })),
  };
}
export async function readWeb(url: string, signal: AbortSignal) {
  const r = await publicFetch(url, signal);
  if (!/(text\/|application\/(xhtml\+xml|json))/i.test(r.type))
    throw new DomainError("UNSUPPORTED_WEB_FORMAT");
  const $ = load(r.text);
  $("script,style,nav,footer,iframe,form,noscript").remove();
  return {
    url: r.url,
    title: $("title").text().slice(0, 500) || r.url,
    excerpt: (r.type.includes("html") ? $("body").text() : r.text)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200000),
    read: true,
  };
}

export async function publicFetch(
  raw: string,
  signal: AbortSignal,
  options: Parameters<typeof fetchPublicRaw>[2] = {},
) {
  try {
    return await fetchPublicRaw(raw, signal, options);
  } catch (e) {
    if (e instanceof DomainError) throw e;
    const error = e as { code?: string; name?: string };
    throw new DomainError(
      signal.aborted
        ? "CANCELLED"
        : error.name === "TimeoutError" || error.code?.includes("TIMEOUT")
          ? "WEB_TIMEOUT"
          : "WEB_NETWORK",
      502,
    );
  }
}
