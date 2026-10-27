# UI fidelity — batch 1

Observed on 2026-10-27. This is a small, evidence-based frontend patch, not a claim of complete fidelity. LLM generation and real browser control are out of scope. No original-site settings or content were saved during inspection.

## Observed references

- Original: https://hyperagent.com/threads/new
- Original settings: https://hyperagent.com/threads/new?settings=appearance
- Replica inspected: https://lp.chayu123.me/threads/new
- Desktop measurement viewport: 1280 × 1280 CSS pixels.

### Measurements and interactions

- The original desktop settings dialog measured 1180 × 760 at x=50, y=260, with a 14px radius.
- Its navigation measured 240px wide, with 36px rows, 14px text and 20px line height. The content heading was 20px/28px; content padding was 32px, with 48px on the right.
- Appearance contains a Color mode row, the helper text “System follows this device's light or dark setting.” and a selector. The observed desktop layout does not include the replica's three large theme-preview cards.
- The original attachment menu includes Upload files…, Skills, Memories, Assets, Output as…, Integrations, and Add to a project, in that order.
- Plan first uses the helper text “Think through an approach and get user clarification before taking action”.
- The original uses Geist for body/UI and seasonSans for the homepage display heading. The replica currently has Geist and system fallbacks. This patch does not fetch or redistribute seasonSans, and does not claim the heading font is matched.

## Changes in this batch

1. Match the measured desktop settings shell and navigation geometry, retaining existing small-screen safeguards.
2. Replace the invented Appearance preview cards with the observed single setting row. Keep local theme selection/persistence; the selector remains a native accessible select, not an exact recreation of the original custom popover.
3. Tune the workspace switch offset, sidebar label sizing, homepage heading-to-composer gap, composer radius, desktop composer control typography and recent-thread card density.
4. Add the missing composer Integrations action. It opens the existing query-driven settings dialog over the current page; it does not connect to a service.
5. Match the observed Plan first helper text.
6. Update the existing theme navigation test and add four focused tests for settings geometry, theme persistence, the new Integrations entry and narrow-viewport usability.

## Verification status

- git diff --check: passed before submission.
- npm ci: blocked twice by HTTP 403 downloading https://registry.npmjs.org/yallist/-/yallist-3.1.1.tgz.
- Build, TypeScript and Playwright tests: NOT RUN locally because dependency installation failed. Do not interpret added tests as passing tests.
- The existing GitHub Actions workflow runs npm ci, build and Playwright for pull requests. Its result must be checked before merging.
- No new screenshot golden baseline is claimed. The new geometry assertions are narrower than full visual regression tests.

## Not changed / next batches

- Do not treat different account names, empty data, recommendation order or conditional integration banners as visual bugs without equivalent-state evidence.
- Keep the existing global 14px typography baseline for now rather than changing every unmeasured screen at once; typography outside the selected surfaces is still pending.
- Composer nested model/provider/tools menus and the starter-agent search picker need a dedicated batch. The observed Auto label is a nested execution control; the replica's flat Auto option is not corrected here.
- Agent creation needs the job-description-first identity flow, alternative import/marketplace paths and the summary column. Existing-agent states require further reference data.
- Resource batches: Skills creation paths and discovery cards; Memories scope/pin form; Inbox/Learning linkage; Library filters and real populated preview states.
- Rooms and Projects should be separate batches. Their local-first implementations must not be mistaken for verified original behavior.
- Remaining settings sections retain much of the old inner typography and controls. Correct them section by section after the shared shell.
- Thread/canvas precision remains pending; the original thread page became unresponsive during inspection. Do not infer details from that failed visit.
- LLM output, browser-control engine, live backend/OAuth/payment behavior remain outside this batch.
