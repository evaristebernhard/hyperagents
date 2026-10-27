import type { DemoThread, DemoProject } from "./types";
export const initialThreads: DemoThread[] = [
  {
    id: "website-planning",
    title: "Website Navigation and UI Replication Planning",
    summary:
      "Mapped the website structure and captured interface references for a frontend-only recreation.",
    time: "just now",
  },
  {
    id: "velocity",
    title: "Velocity Theorem Explanation",
    summary:
      "Clarified foundational physics concepts, vector velocity addition, and Galilean velocity transformations.",
    time: "22h ago",
    project: "hello",
  },
  {
    id: "small-business",
    title: "Small Biz Website Builder Thread",
    summary:
      "Evaluated local businesses and built five interactive web redesign concepts using typography-focused layouts.",
    time: "yesterday",
  },
  {
    id: "greeting",
    title: "Initial Conversation Greeting",
    summary:
      "An introduction to research, coding, and creative work in your workspace.",
    time: "yesterday",
  },
  {
    id: "welcome",
    title: "Welcome to Hyperagent",
    summary:
      "Your workspace is ready. Explore the examples or start a new task.",
    time: "yesterday",
  },
];
export const initialProjects: DemoProject[] = [
  {
    id: "hello",
    name: "hello",
    description:
      "A collection of notes on foundational physics concepts and essential kinematic frameworks.",
    goal: "Keep research and related conversations in one place.",
  },
];
export const examples = [
  {
    slug: "out-of-home-campaign",
    title: "Out-of-home campaign",
    description:
      "Research billboard locations, develop creative strategy, and visualize a campaign in real-world settings.",
    duration: "8m 38s",
    image: "campaign",
  },
  {
    slug: "cinematic-real-estate-video",
    title: "Cinematic real estate video",
    description: "Turn any listing into a stunning marketing package.",
    duration: "29m 55s",
    image: "property",
  },
  {
    slug: "hiring-command-center",
    title: "Hiring command center",
    description:
      "Source and rank real candidates in a dashboard with skill sliders.",
    duration: "22m 11s",
    image: "hiring",
  },
  {
    slug: "small-business-rebrand",
    title: "Small business rebrand",
    description: "Redesign storefront, packaging, and web for a local bakery.",
    duration: "15m 7s",
    image: "brand",
  },
  {
    slug: "podcast-launch",
    title: "Podcast launch",
    description:
      "Plan studio layout, generate promo clips, and build the media kit.",
    duration: "25m 56s",
    image: "campaign",
  },
  {
    slug: "real-estate-listing-kit",
    title: "Real estate listing kit",
    description:
      "Generate a property listing kit with an editorial website and buyer’s handout.",
    duration: "9m 35s",
    image: "property",
  },
];
export function safeRead<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem("hyperagents-demo:" + key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
export const asset = (name: string) => "/examples/" + name + ".svg";
