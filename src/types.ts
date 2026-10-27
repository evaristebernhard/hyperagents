import type { ReactNode } from "react";
export type Navigate = (path: string) => void;
export type DemoThread = {
  id: string;
  title: string;
  summary: string;
  time: string;
  project?: string;
  starred?: boolean;
  archived?: boolean;
  excluded?: boolean;
  roomId?: string;
  notes?: string;
  messages?: { role: "user" | "assistant"; text: string }[];
};
export type DemoProject = {
  id: string;
  name: string;
  description: string;
  goal: string;
  archived?: boolean;
};
export type DemoAgent = {
  id: string;
  name: string;
  description: string;
  prompt: string;
  model?: string;
  provider?: string;
  reasoning?: string;
  tools?: string[];
  skillIds?: string[];
  memoryMode?: string;
  learning?: Record<string, string>;
  libraryEnabled?: boolean;
  archived?: boolean;
  starred?: boolean;
};
export type DemoMemory = {
  id: string;
  content: string;
  category: string;
  importance: number;
  pinned: boolean;
  whenToUse?: string;
  tags?: string[];
  scope?: string;
};
export type PageProps = {
  path: string;
  navigate: Navigate;
  notify: (message: string) => void;
};
export type ResourceProps = PageProps & {
  threads: DemoThread[];
  setThreads: (items: DemoThread[]) => void;
  projects: DemoProject[];
  setProjects: (items: DemoProject[]) => void;
  memories: DemoMemory[];
  setMemories: (items: DemoMemory[]) => void;
  openThread: (id: string) => void;
  onCreateThread: (text: string, project?: string) => void;
};
export type SettingsProps = {
  section: string;
  navigateSection: (section: string) => void;
  onClose: () => void;
  notify: (message: string) => void;
  theme: string;
  setTheme: (theme: string) => void;
};
export type Children = { children: ReactNode };
