# Workspace integration verification — 2026-11-03

## Result

The original sidebar, composer, conversation and artifact canvas now use the v1 workspace resources and task runtime. No separate Tasks page was added. The reference is the repository's earlier original-UI observations and Hyperagent's public featured thread; this run did not inspect its authenticated private UI.

| Check                                                   | Result                                                                                                                                                          |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test --prefix backend`                             | 64/64 passed; includes type checks and deterministic integration tests                                                                                          |
| `npm run build:v1`                                      | Type check and production build passed; existing large-bundle advisory remains                                                                                  |
| `npm run test:v1-adapter`                               | Passed: lost-response idempotency, 105-event pagination, reconnect/refresh, follow-up, cancel, session teardown                                                 |
| `node --test server/frontend-safety.test.mjs`           | 3/3 passed                                                                                                                                                      |
| Original UI browser fixtures                            | Initial run: 89/90 passed. The schedule preview wording was fixed; the failing case passed on rerun. All 90 cases have passing coverage across those two runs.  |
| Live browser + real model/sandbox                       | Passed: calculation, three downloadable files, revision history, Memory context, confirmed Learning, Library, team Room persistence and personal/team isolation |
| Browser errors / legacy API calls in the final live run | None                                                                                                                                                            |
| Public HTTPS authentication | Browser sign-in and workspace load passed at `https://hyper.chayu123.me` |
| Local and public UI                                     | HTTP 200 at `http://localhost:5173` and `https://hyper.chayu123.me`                                                                                             |
| Live private-file request                               | HTTP 403 for `/backend/.data-v1/interactive/access.json`                                                                                                        |

## Live evidence

The initial task calculated 1 through 1000 by both a Python loop and formula: **500500**. It produced `sum.py`, `result.md` and a Chinese `result.pdf`. The report included a unique verification marker from a saved Memory. The agent proposed a new preference, which remained pending until explicit acceptance in Learning.

The follow-up changed the calculation to 1 through 100: **5050**. Each file retained the same artifact ID and received a second version. Browser refresh restored the conversation and activities; downloading the selected historical Markdown version returned the original 500500 result. Library listed all three real artifacts. A separately created team workspace did not inherit the personal files, and its shared Room survived refresh.

The live model service returned HTTP 503 / `MODEL_UNAVAILABLE` during the follow-up's review. Clicking **Resume saved run** completed it using the saved execution. This was a recovered run, not an uninterrupted model success. The provider can still fail or time out; the UI now distinguishes those failures from cancellation and successful computation with failed file delivery. Uncertain executions are not replayed automatically.

`result.json` records task/artifact identifiers, retained error codes and final browser assertions. Screenshots show [conversation activity](calculation.png), [historical version selection](versions.png), [Library](library.png) and [team workspace](workspaces.png). All screenshots and model tasks use an isolated verification account. Existing user data and historical evaluation reports were retained.

## Deterministic coverage

Backend tests exercise workspace isolation, email-bound invitations, new-member registration, viewer restrictions and member revocation; stale resource revisions; task context snapshots; Agent tool restrictions; isolated Agent memories; confirmed Learning writes; idempotent daily schedule claims; source-file output, calculation/file-delivery separation, artifact versions and timeout classification. Existing authentication, CSRF, filesystem and execution-isolation tests remain included.

The browser adapter checks unavailable capabilities, uncertain POST response recovery without duplicate tasks, paginated event recovery, refresh deduplication, follow-up, bodyless cancellation and clearing the workspace after session expiration. The original fixture suite ran on isolated port 5185 so it did not replace the live service on 5173.

## Reproduction

```sh
npm test --prefix backend
npm run build:v1
node --test server/frontend-safety.test.mjs
npm run test:v1-adapter
npm run dev:v1
```

With the dev service and existing runner available, run `node scripts/smoke-v1-resources.mjs` from another terminal. It uses the private local bootstrap access file to invite a new verification account; it does not reset an existing account. Credentials remain under ignored `.data-v1`. It calls the existing configured model and can incur that model's normal inference cost. To recheck the saved result without creating another model task, use `V1_RESUME_TASK=<firstTask from result.json> V1_RESUME_PHASE=revision node scripts/smoke-v1-resources.mjs` with the matching private verification access file.

The regular original-UI fixture command is `npm run test:fixtures`; use a separate checkout or free port 5173 first, because its default configuration uses that port. For this run a temporary equivalent Playwright configuration set the fixture Vite server and base URL to 5185, with `VITE_STORAGE_MODE=fixture` and `reuseExistingServer: false`.

## Public services and limits

Live probes confirmed keyless public web search, a separate Python documentation read, and Wikimedia Commons image lookup with attribution/license metadata. Search uses locally implemented Bing RSS / DuckDuckGo HTML parsers, not a paid search API. Automated tests cover result parsing and source safety. Public sites can block or change these interfaces.

Image lookup finds existing images. Image/audio/video generation, generic map lookup and external account actions remain explicitly unavailable. Marketplace entries are local instruction templates; arbitrary ZIP/code installation is unavailable. Team invitations are shared manually, without an email service. Daily schedules do not backfill completely missed downtime slots. See [the integration guide](../V1-WORKSPACE-INTEGRATION.md) for behavior and boundaries.

Historical full-model and sandbox evaluation reports remain historical evidence; they were not rerun or relabeled as current results.
