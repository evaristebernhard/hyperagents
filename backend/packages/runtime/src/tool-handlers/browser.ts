import { prepareBrowser } from "../browser.js";

import { DomainError, type ToolName } from "@hyper/contracts";

import type { ToolHandler } from "../tools.js";

export const browserHandlers = {
  browser: async function (task, op, signal) {
    const owner = task.lease_owner!;

    if (this.config.BROWSER_ENABLED !== "true")
      throw new DomainError("BROWSER_UNAVAILABLE");
    await prepareBrowser(this.db, task, op);
    return { data: null, deferred: true };
  },
} satisfies Partial<Record<ToolName, ToolHandler>>;
