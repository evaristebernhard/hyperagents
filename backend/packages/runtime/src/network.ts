import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, request } from "undici";
import { load } from "cheerio";
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
      await agent.destroy();
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
  // No paid search provider. Parse public search pages locally, then read the
  // underlying sources separately. Never treat a search snippet as a read source.
  const endpoints = [
    "https://www.bing.com/search",
    "https://cn.bing.com/search",
    "https://html.duckduckgo.com/html/",
  ];
  const errors: string[] = [];
  for (const endpoint of endpoints) {
    signal.throwIfAborted();
    const u = new URL(endpoint);
    u.searchParams.set("q", query);
    const rss = u.hostname.includes("bing.com");
    if (rss) u.searchParams.set("format", "rss");
    try {
      const r = await publicFetch(u.href, signal, { maxBytes: 512 * 1024 });
      const results = parseSearch(r.text, rss ? "bing" : "duckduckgo", limit);
      if (!results.length) throw new DomainError("SEARCH_EMPTY_OR_BLOCKED");
      return {
        provider: rss ? "public-bing-rss" : "public-duckduckgo-html",
        degraded: errors.length > 0,
        results,
      };
    } catch (e) {
      if (signal.aborted) throw e;
      errors.push(e instanceof DomainError ? e.code : "SEARCH_UNAVAILABLE");
    }
  }
  throw new DomainError("SEARCH_UNAVAILABLE", 503);
}
export function parseSearch(
  text: string,
  provider: "bing" | "duckduckgo",
  limit: number,
) {
  if (provider === "bing" && /<!\s*(DOCTYPE|ENTITY)/i.test(text))
    throw new DomainError("INVALID_RSS");
  const $ = load(text, provider === "bing" ? { xml: true } : undefined);
  const results: {
    url: string;
    title: string;
    excerpt: string;
    read: boolean;
  }[] = [];
  const seen = new Set<string>();
  $(provider === "bing" ? "rss > channel > item" : ".result").each((_, el) => {
    try {
      const raw =
        provider === "bing"
          ? $(el).find("link").text()
          : $(el).find(".result__a").attr("href");
      if (!raw) return;
      let u = new URL(raw, "https://duckduckgo.com");
      if (u.hostname.endsWith("duckduckgo.com") && u.searchParams.has("uddg"))
        u = new URL(u.searchParams.get("uddg")!);
      const url = publicUrl(u.href).href;
      if (seen.has(url) || results.length >= limit) return;
      seen.add(url);
      results.push({
        url,
        title: $(el)
          .find(provider === "bing" ? "title" : ".result__a")
          .text()
          .slice(0, 500),
        excerpt: $(el)
          .find(provider === "bing" ? "description" : ".result__snippet")
          .text()
          .slice(0, 1500),
        read: false,
      });
    } catch {
      /* Skip malformed and private-network results, not the entire page. */
    }
  });
  return results;
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

// Public, keyless Wikimedia Commons lookup. This finds existing media and
// attribution metadata; it does not claim to generate images.
export async function searchImages(
  query: string,
  limit: number,
  signal: AbortSignal,
) {
  const u = new URL("https://commons.wikimedia.org/w/api.php");
  u.search = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "search",
    gsrsearch: query + " filetype:bitmap",
    gsrnamespace: "6",
    gsrlimit: String(Math.min(limit, 5)),
    prop: "imageinfo",
    iiprop: "url|extmetadata",
    iiurlwidth: "640",
  }).toString();
  const r = await publicFetch(u.href, signal, { maxBytes: 512 * 1024 });
  return {
    provider: "wikimedia-commons",
    results: parseImages(JSON.parse(r.text)),
  };
}
export function parseImages(data: unknown) {
  const root = data as {
    query?: {
      pages?: Record<
        string,
        {
          title?: string;
          imageinfo?: {
            url?: string;
            descriptionurl?: string;
            extmetadata?: Record<string, { value?: string }>;
          }[];
        }
      >;
    };
  };
  const plain = (value: string) =>
    load(value).text().replace(/\s+/g, " ").trim().slice(0, 1500);
  return Object.values(root.query?.pages || {})
    .slice(0, 5)
    .flatMap((page) => {
      try {
        const info = page.imageinfo?.[0];
        if (!info?.url || !info.descriptionurl) return [];
        const metadata = info.extmetadata || {},
          license = plain(
            metadata.LicenseShortName?.value || "Check source license",
          ),
          artist = plain(metadata.Artist?.value || "See source credits");
        return [
          {
            url: publicUrl(info.descriptionurl).href,
            imageUrl: publicUrl(info.url).href,
            title: page.title || info.descriptionurl,
            license,
            artist,
            excerpt: `Image credit: ${artist}. License: ${license}. Verify attribution and reuse conditions on the source page.`,
            read: true,
          },
        ];
      } catch {
        return [];
      }
    });
}
