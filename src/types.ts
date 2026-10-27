import type { ReactNode } from "react";
export type Navigate = (path: string) => void;
export type DemoThread = {
  id: string;
  title: string;
  summary: string;
  time: string;
  project?: string;
  starred?: boolean;
  messages?: { role: "user" | "assistant"; text: string }[];
};
export type DemoProject = {
  id: string;
  name: string;
  description: string;
  goal: string;
};
export type DemoAgent = {
  id: string;
  name: string;
  description: string;
  prompt: string;
};
export type DemoMemory = {
  id: string;
  content: string;
  category: string;
  importance: number;
  pinned: boolean;
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
