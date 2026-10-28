import data from "../shared/marketplace-catalog.json";
export type CatalogEntry = {
  sourceId: string; kind: "skill" | "agent"; name: string; creator: string; summary: string;
  sourceUrl: string; categories: string[]; dependencies: string[]; dependencyBasis: string;
  implementation?: { documentation: string; tools: string[]; limitations: string; coverage: "workflow" | "partial" };
};
export const marketplaceCatalog = data.entries as CatalogEntry[];
export const marketplaceCategories = data.categories;
export const catalogSkill = (sourceId?: string) => marketplaceCatalog.find(entry => entry.kind === "skill" && entry.sourceId === sourceId);
