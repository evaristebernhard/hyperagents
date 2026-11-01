# Thread UI parity batch — 2026-10-31

Two parallel implementation tasks cover tool activity rendering and conversation layout. Tool results use friendly expandable status chips, projected result titles/domains and safe links; raw bounded details remain available. Empty canvases default to closed; existing explicit canvas preferences and approval/stop/error flows remain operational. Finished execution metadata is collapsible rather than monopolizing the page.

Server tool previews preserve valid bounded JSON instead of cutting arbitrary JSON mid-string. Historical clipped previews cannot be reconstructed and remain a bounded fallback; this does not rerun tools.

This batch does not configure Exa, install provider credentials, add automatic follow-up suggestions, fabricate knowledge hint counts or reasoning times, enable Live mode, or replicate browser identity settings. UI labels are not evidence of provider reachability. Browser tests use synthetic results and temporary workspaces. The production thread was only viewed, not rerun or mutated.

Verified: 337 backend tests passed; 12 existing canvas/thread browser flows passed; 1 combined parity browser test passed (source rendering, empty canvas, pending approval remains open, stop visible, failed-run error visible). Tests use temporary data, synthetic outputs and no production provider calls. Explicit saved canvas collapse preferences still persist for existing artifact threads. Frontend change observed on the actual domain through development reload; no service restart. New server preview serializer requires service reload before live requests use it.
