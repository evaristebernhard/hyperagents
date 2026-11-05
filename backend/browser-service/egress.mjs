import http from "node:http";
import net from "node:net";
import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { pathToFileURL } from "node:url";
// Resolve once, reject every non-public answer, connect to the checked numeric address.
// This also covers redirects, subresources, WebSockets, IPv4-mapped IPv6 and DNS rebinding.
export async function publicAddress(host, resolver = lookup) {
  const name = host.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(name)
    ? [{ address: name, family: net.isIP(name) }]
    : await resolver(name, { all: true, verbatim: true });
  if (
    !addresses.length ||
    addresses.some((a) => {
      let ip = ipaddr.parse(a.address);
      if (ip.kind() === "ipv6" && ip.isIPv4MappedAddress())
        ip = ip.toIPv4Address();
      return ip.range() !== "unicast";
    })
  )
    throw new Error("EGRESS_DENIED");
  return addresses[0];
}
export function createEgressProxy() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url);
      if (
        url.protocol !== "http:" ||
        (url.port && url.port !== "80") ||
        url.username ||
        url.password
      )
        throw new Error("EGRESS_DENIED");
      const addr = await publicAddress(url.hostname);
      const headers = { ...req.headers, host: url.host };
      delete headers["proxy-authorization"];
      delete headers["proxy-connection"];
      const upstream = http.request(
        {
          host: addr.address,
          family: addr.family,
          port: 80,
          path: url.pathname + url.search,
          method: req.method,
          headers,
          timeout: 30000,
        },
        (reply) => {
          res.writeHead(reply.statusCode, reply.headers);
          reply.pipe(res);
        },
      );
      upstream.on("timeout", () => upstream.destroy());
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
      req.on("aborted", () => upstream.destroy());
      res.on("close", () => upstream.destroy());
    } catch {
      res.writeHead(403);
      res.end("EGRESS_DENIED");
    }
  });
  server.on("connect", async (req, socket, head) => {
    try {
      const url = new URL("https://" + req.url);
      if (
        (url.port && url.port !== "443") ||
        url.username ||
        url.password ||
        url.pathname !== "/"
      )
        throw new Error("EGRESS_DENIED");
      const addr = await publicAddress(url.hostname),
        upstream = net.connect({
          host: addr.address,
          family: addr.family,
          port: 443,
        });
      upstream.setTimeout(300000, () => upstream.destroy());
      upstream.on("connect", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      socket.on("close", () => upstream.destroy());
      upstream.on("close", () => socket.destroy());
    } catch {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    }
  });
  server.on("upgrade", async (req, socket, head) => {
    try {
      const url = new URL(req.url);
      if (
        !["http:", "ws:"].includes(url.protocol) ||
        (url.port && url.port !== "80") ||
        url.username ||
        url.password
      )
        throw new Error("EGRESS_DENIED");
      const addr = await publicAddress(url.hostname),
        upstream = net.connect({
          host: addr.address,
          family: addr.family,
          port: 80,
        });
      upstream.on("connect", () => {
        const headers = { ...req.headers, host: url.host };
        delete headers["proxy-authorization"];
        upstream.write(
          `${req.method} ${url.pathname + url.search} HTTP/1.1\r\n` +
            Object.entries(headers)
              .map(([k, v]) => `${k}: ${v}\r\n`)
              .join("") +
            "\r\n",
        );
        if (head.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      socket.on("close", () => upstream.destroy());
    } catch {
      socket.destroy();
    }
  });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  createEgressProxy().listen(3128, "0.0.0.0");
