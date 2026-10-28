export class SnapshotLock {
  private busy = false;
  get locked() { return this.busy; }
  assertMutable() {
    if (this.busy) throw new Error("Workspace replacement is in progress. Wait for import or reload to finish.");
  }
  async run<T>(settle: () => Promise<unknown>, operation: () => Promise<T>): Promise<T> {
    this.assertMutable();
    this.busy = true;
    try { await settle(); return await operation(); }
    finally { this.busy = false; }
  }
}
