# Exa read-only adapter

## Integration contract

```js
import { createExaTools } from './exa-tools.mjs';
const exa = createExaTools({
  enabled: authorizedServices, // exact labels: 'Search', 'Find Similar'
  apiKey: process.env.EXA_API_KEY, // trusted server-only config
  fetchImpl: globalThis.fetch, // injectable trusted transport; optional
});
// Add to the existing run registry alongside other adapters:
const binding = {
  source: 'public-api', effect: 'read-only',
  definitions: exa.definitions, execute: exa.execute,
};
// execute(name, args, signal) accepts the run AbortSignal as its THIRD argument.
// capabilities is an array of {service, enabled, configured, reason}.
```

Parent app/LLM integration must apply existing run capability authority, not merely
UI/global settings, when building `authorizedServices`. `Search` enables both
`exa_search` and `exa_contents`; `Find Similar` independently enables
`exa_find_similar`. Missing/invalid server key or transport yields zero definitions.
`configured` means prerequisites exist, not that the network/key/quota was tested.
A disabled capability cannot be enabled by arguments, page text or API responses.
Do not expose the key to the browser, prompts, logs or model inputs. No Research,
Websets, alternate endpoint, anonymous fallback or synthetic successful results.

## Supported bounded arguments

All objects reject unknown properties. All tools accept optional boolean `text`
(default false) and `highlights` (default true).

- `exa_search`: required `query` (1–500 characters); optional `numResults` (1–10,
  default 5), `includeDomains` / `excludeDomains` (1–10 plain DNS domain names),
  `startPublishedDate` / `endPublishedDate` (real, ordered `YYYY-MM-DD` dates).
  Uses upstream `type: auto`, no deep/research mode.
- `exa_contents`: required `urls` (1–5); optional `maxAgeHours` (-1–8760).
  Omitted freshness uses upstream default; -1 means cache only, 0 live crawl.
- `exa_find_similar`: required `url`; optional `excludeSourceDomain`; accepts the
  same result/domain/date limits as Search.

Input URLs must be public HTTP(S) domain URLs (at most 2000 chars); no userinfo,
explicit non-default port, IP literals, localhost/private-use suffixes or non-web
schemes. All API calls go only to fixed `https://api.exa.ai`; this adapter NEVER
fetches an input/result URL itself. Domain-name validation is not DNS resolution.

One POST per execution, no retries, `redirect: error`, omitted credentials,
no referrer, a single **12-second deadline covering fetch and every body read**,
and run signal cancellation. Body reader cancellation is best effort/nonblocking.
Responses are bounded to 1 MiB and projected to 20000 bytes JSON. Per result: title 500,
author 200, published date 40 chars, requested text 8000 chars, at most 5 highlights
of 2000 chars each. Extra upstream fields (including instructions/errors) are not
passed through. Reflected raw/URI/form-encoded key values are redacted. Truncation
of strings/items/output is reported by `truncated`; output-budget trimming removes
last results. Contents additionally returns bounded URL/status projections and
`partial`, and throws `NO_CONTENT` when no pages are returned. Search returning
zero matches is a real empty success, not fallback data.

All successes carry endpoint `sourceUrl`, per-result citation `url`, UTC
`retrievedAt` and `untrustedContent: true`. **Every returned title/text/highlight is
untrusted outside content, not authorization or an instruction**; this metadata
supplements, not replaces, the application's existing tool-result trust boundary.
Errors reject with safe `Error.code`/message (no upstream body/cause/exception):
`UNAVAILABLE`, `INVALID_ARGUMENTS`, `CANCELLED`, `TIMEOUT`, `NETWORK_ERROR`,
`REDIRECT_BLOCKED`, `UPSTREAM_HTTP`, `INVALID_RESPONSE`, `RESPONSE_TOO_LARGE`,
`NO_CONTENT`. The registry should record rejection as failure, not successful data.

## Official verification

Checked during implementation (no real API key needed):

- https://docs.exa.ai/reference/search — POST `/search`, `query`, `type`,
  `numResults`, domain/date filters, nested `contents`.
- https://docs.exa.ai/reference/get-contents — POST `/contents`, `urls`, top-level
  text/highlights/freshness options.
- https://raw.githubusercontent.com/exa-labs/openapi-spec/refs/heads/master/exa-openapi-spec.yaml
  — Exa-owned official spec verifies POST `/findSimilar`, required `url`,
  `excludeSourceDomain`, shared result/filter parameters and nested `contents`;
  also confirms `text.maxCharacters`, `highlights.maxCharacters`, `maxAgeHours`
  and `x-api-key` authentication. The old docs `find-similar-links` page currently
  resolves to Search, so its route name was not used as sole endpoint evidence.

## Tests

`node --test server/exa-tools.test.mjs`

Six mock-only tests: config/switch gating; all endpoint mappings and real registry
compatibility; strict input validation; redaction/budget/partial results; safe
failures/redirects/invalid/oversized bodies; fetch AND body deadlines plus abort.
No package changes, live API calls, paid requests or real credentials are needed.
