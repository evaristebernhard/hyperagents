import type { DemoAgent, DemoMemory, DemoProject, DemoThread } from "./types";
export type Skill = {
  id: string;
  name: string;
  description: string;
  documentation: string;
  whenToUse: string;
  tags: string[];
  author: string;
  createdAt: string;
  updatedAt: string;
  sourceId?: string;
  archived?: boolean;
};
export type Schedule = {
  id: string;
  name: string;
  instructions: string;
  cadence: string;
  enabled: boolean;
  agentId?: string;
  roomId?: string;
};
export type Room = {
  id: string;
  name: string;
  topic: string;
  agentIds: string[];
  notes: { id: string; text: string; createdAt: string }[];
  archived?: boolean;
};
export type ArtifactVersion = {
  id: string;
  content: string;
  createdAt: string;
};
export type Artifact = {
  id: string;
  title: string;
  kind: "Document" | "Webpage" | "Image" | "File";
  content: string;
  threadId?: string;
  projectId?: string;
  archived?: boolean;
  versions: ArtifactVersion[];
  createdAt: string;
  updatedAt: string;
};
export type Rubric = { id: string; name: string; criteria: string[] };
export type LocalConnection = {
  id: string;
  provider: string;
  label: string;
  endpoint: string;
  enabled: boolean;
  createdAt: string;
};
export type WorkspaceData = {
  threads: DemoThread[];
  projects: DemoProject[];
  agents: DemoAgent[];
  memories: DemoMemory[];
  skills: Skill[];
  rooms: Room[];
  artifacts: Artifact[];
  schedules: Schedule[];
  rubrics: Rubric[];
  reviewedSuggestions: string[];
  connections: LocalConnection[];
};
export type WorkspaceState = {
  version: 1;
  active: string;
  workspaces: { id: string; name: string; data: WorkspaceData }[];
};
export const uid = (prefix: string) =>
  prefix + "-" + (crypto.randomUUID?.() || Math.random().toString(36).slice(2));
export const now = () => new Date().toISOString();
export const communitySkills: Skill[] = [
  {
    id: "nyt-data-viz",
    name: "NYT Data Viz",
    author: "Community sample",
    description:
      "Clear charts with disciplined color, annotation, and a useful hierarchy.",
    documentation:
      "# Data visualization\n\n## Understand the question\nIdentify the decision the chart should inform.\n\n## Choose a chart\nUse bars for comparisons, lines for time, and scatter plots for relationships.\n\n## Check the result\nLabel units, cite sources, and make important differences visible.\n\nThis is editable sample content, not a downloaded official skill.",
    whenToUse: "Charts, dashboards, and data-driven reports.",
    tags: ["data", "charts"],
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: "swiss-grid-design",
    name: "Swiss Grid Design",
    author: "Community sample",
    description:
      "A modular grid, clear typography, and restrained visual hierarchy.",
    documentation:
      "# Swiss grid design\n\n## Layout\nChoose a consistent column grid and align related information.\n\n## Typography\nUse a small type scale. Keep body copy readable and labels precise.\n\n## Review\nCheck spacing, alignment, and responsive behavior.\n\nSample instructions for a local UI demonstration.",
    whenToUse: "Editorial webpages, portfolios, and structured reports.",
    tags: ["design", "web"],
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: "roast-my-idea",
    name: "Roast My Idea",
    author: "Community sample",
    description:
      "Explore risks and opportunities before committing to an idea.",
    documentation:
      "# Review an idea\n\n## Context\nState the customer, problem, and proposed solution.\n\n## Evidence\nSeparate verified facts from assumptions.\n\n## Risks\nConsider demand, distribution, operations, and cost.\n\n## Next test\nDefine one low-cost experiment with a measurable outcome.",
    whenToUse: "Reviewing a concept or planning a small experiment.",
    tags: ["research", "strategy"],
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: "small-biz-builder",
    name: "Small Biz Website Builder",
    author: "Community sample",
    description:
      "Find strong local businesses, assess their web presence, and create clearly labelled redesign concepts.",
    documentation:
      "# Small Biz Website Builder\n\n## Discover\nFind independent businesses with a real review history.\n\n## Qualify\nCheck the current website and identify specific, observable gaps. Do not invent reviews, prices, or business details.\n\n## Design\nCreate distinct concepts appropriate to the business. Label every concept as an independent mockup.\n\n## Deliver\nKeep references and next steps together. Do not contact businesses or publish on their behalf without permission.\n\nThese are editable sample instructions. No code or tool execution is attached.",
    whenToUse: "Local business website research and redesign concept work.",
    tags: ["web-design", "research", "local-business"],
    createdAt: now(),
    updatedAt: now(),
  },
];
