# Tool picker parity — 2026-10-31

Reference: user-authenticated Hyperagent new-thread composer and the user's local replica at the same screen size. The original grouped tool toggles into colored chips; the replica had an ungrouped scrolling list.

This batch groups research, browser, data, interactive, media and workspace tools, applies compact icon chips, and retains menu checkbox roles, focus/escape behavior and viewport containment. Workspace-specific local tools remain visible as a separate group. Server-backed mode derives availability from the existing capability endpoint; absent/unconfigured/unimplemented entries are disabled and have a reason, while a selected item can still be removed. A failed capability request fails closed rather than enabling every item. Selecting a tool does not bypass approval or configure a provider. Fixture mode stays a local interaction preview.

Visual verification observed the actual replica after its development frontend reloaded, with no service restart. Automated browser tests run against isolated fixture and temporary server-backed workspaces, not the owner's data. This does not replicate the original's residential-IP or CAPTCHA controls, integrations strip, provider backends or entire interface.

Tests: npx playwright test --config=playwright.tool-menu.config.ts and npx playwright test --config=playwright.tool-menu-backend.config.ts. Both configurations create fresh temporary results directories and use dedicated loopback ports; server mode uses a fresh temporary data directory.
