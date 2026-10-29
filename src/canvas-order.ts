/** Reorder displayed IDs only; filtered/docked items keep their full-order slots. */
export function moveVisibleArtifact(all: readonly string[], visible: readonly string[], source: string, destination: string): string[] | null {
  const fullSet = new Set(all), visibleSet = new Set(visible);
  if (fullSet.size !== all.length || visibleSet.size !== visible.length || visible.some(id => !fullSet.has(id))) return null;
  const from = visible.indexOf(source), to = visible.indexOf(destination);
  if (from < 0 || to < 0 || from === to) return null;
  const next = [...visible]; next.splice(from, 1); next.splice(to, 0, source);
  let index = 0;
  return all.map(id => visibleSet.has(id) ? next[index++] : id);
}
