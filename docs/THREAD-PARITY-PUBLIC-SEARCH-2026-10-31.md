# Thread experience and keyless public search

## Search
Search does not require a paid API key. When no valid Exa configuration is present, enabling Search binds web_search to public Bing RSS at the fixed HTTPS cn.bing.com origin. The regional origin was chosen after the workstation returned a www-to-cn redirect; the adapter itself never follows redirects. It uses a descriptive reader User-Agent, no credentials/cookies, bounded response and timeout, cancellation, and strict RSS/URL validation. Find Similar still needs Exa. A configured Exa adapter is retained rather than silently replaced after an upstream failure.

A real WSL request returned HTTP 200 and genuine RSS results; the adapter returned three real source links. Public RSS relevance was weak for the English phrase hello world origin, so this proves connectivity and execution, not search-quality parity. Rate limits, blocking and future service changes remain possible. No CAPTCHA bypass or browser disguise is used.

## Genuine metadata
Optional suggest_follow_ups records 2–3 short model-generated prompts once per run; only success publishes them. They persist as assistant.followUps and buttons append to the existing draft without sending.

reasoningMs measures the observed server reasoning-stream interval, stops before tool execution and is absent when no reasoning chunks were observed. This is not a claim to know internal model thinking time; no new raw reasoning transcript is persisted.

knowledgeHints stores actual resolved skillIds and memoryIds (including eligible pinned memories); UI counts these specific run-context records, not all historical selections. Loaded context is not proof that the model relied on a record. Historical messages without metadata do not get invented hints or timings.

## Thread UI
Title dropdown/star, model/settings controls, rounded shell, quieter connection metadata, external timestamps, no You/Assistant headings, tools before prose, low-key answer actions, visible model/Execute labels, follow-up pills, and a real server integrations strip/settings entry. Pending approvals, errors, stop controls, canvas persistence and unsaved drafts remain protected. Existing stored output cannot reconstruct a perfectly interleaved original token/tool timeline.

## Verification and deployment
359 backend tests passed; 14 thread/canvas/browser tests passed, including actual saved metadata, append-only prefill, unchanged revision (no send), real settings navigation, source-link handling, pending approval visibility and errors. Tests use temporary workspaces and synthetic model data; no paid live DeepSeek request. The frontend was observed on the actual domain via development refresh. The production backend has not been restarted; it must reload before live search and new metadata events are available. No credentials, owner data, account settings or service configuration were changed.
