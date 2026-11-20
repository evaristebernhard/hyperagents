Infinity baseline: https://github.com/hydro-project/infinity/commit/1abc6fcff1f186124f924b56aa92c3a3684c90c5

Four crates are vendored under their original Apache-2.0 license. Workspace members
are narrowed to these crates. The integration changes HistoryManager::sync to
propagate processed-ID store failures. Other source files match the baseline.
The embedding stages every store/sender/tool write for one slice and commits the
entire write set under a PostgreSQL fencing check; staged child messages never
become visible to another worker before that transaction commits.
