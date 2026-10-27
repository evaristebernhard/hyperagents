import { useEffect, useRef, useState } from "react";
import {
  User,
  Palette,
  SlidersHorizontal,
  Shield,
  Bell,
  Plug,
  Link,
  Upload,
  FileArchive,
  CreditCard,
  Activity,
  Brain,
  Gift,
  X,
  RefreshCw,
  Search,
  Plus,
  ChevronDown,
  ArrowUpRight,
  Download,
  KeyRound,
  Monitor,
  Check,
  Folder,
  Mail,
  Globe,
  Users,
  FileText,
  Calendar,
  Database,
  MessageSquare,
} from "lucide-react";
import type { SettingsProps } from "./types";
import { IconButton, Modal } from "./ui";
import { safeRead } from "./data";
import { useWorkspace } from "./workspace";
import { uid, now } from "./local-model";
import "./settings-ui.css";
const groups = [
  {
    label: "Account",
    items: [
      ["personalization", "Profile", User],
      ["appearance", "Appearance", Palette],
      ["thread-defaults", "Thread defaults", SlidersHorizontal],
      ["security", "Security", Shield],
      ["notifications", "Notifications", Bell],
    ],
  },
  {
    label: "Data access",
    items: [
      ["integrations", "Integrations", Plug],
      ["mcp-access", "MCP access", Link],
      ["import-openclaw", "Import from OpenClaw", Upload],
      ["import-manus", "Import from Manus", FileArchive],
    ],
  },
  {
    label: "Subscription",
    items: [
      ["billing", "Plan & billing", CreditCard],
      ["usage", "Usage", Activity],
      ["ai-providers", "AI providers", Brain],
      ["referrals", "Referrals", Gift],
    ],
  },
];
const catalog = [
  ["Airtable", "MCP", "Database and applications", "A"],
  ["Gmail", "NATIVE", "Email sending and reading", "M"],
  ["Google Calendar", "NATIVE", "Event scheduling", "31"],
  ["Google Drive", "NATIVE", "File storage and sharing", "△"],
  ["Slack", "NATIVE", "Messaging and notifications", "✣"],
  ["Telegram", "NATIVE", "A bot for each agent — set up in Telegram", "➤"],
  ["AgentMail", "MCP", "Email inboxes built for agents", "✉"],
  ["Ahrefs", "MCP", "SEO backlinks, keywords, and rankings", "a"],
  ["Asana", "MCP", "Tasks, projects, and portfolios", "●"],
  ["Databricks", "NATIVE", "Cloud data warehouse", "D"],
  ["Google Sheets", "NATIVE", "Spreadsheets and data analysis", "▦"],
  ["Google Docs", "NATIVE", "Documents and word processing", "▤"],
  ["Linear", "MCP", "Issues, projects, and roadmaps", "◒"],
  ["Magic Patterns", "MCP", "AI UI mockups and prototypes", "✦"],
  ["Notion", "MCP", "Notes and documentation", "N"],
  ["QuickBooks", "NATIVE", "Invoices, customers, and accounting", "qb"],
  ["Stripe", "MCP", "Payments, customers, and invoices", "S"],
  ["Supabase", "MCP", "Database, auth, and edge functions", "⚡"],
  ["YouTube", "NATIVE", "Channels, videos, playlists, comments", "▶"],
];
export default function SettingsUI({
  section,
  navigateSection,
  onClose,
  notify,
  theme,
  setTheme,
}: SettingsProps) {
  const workspace = useWorkspace();
  const [connectionLabel, setConnectionLabel] = useState(""),
    [endpoint, setEndpoint] = useState(""),
    [connectionEnabled, setConnectionEnabled] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const [profile, setProfile] = useState(() =>
    safeRead("profile", { name: "Demo User", company: "" }),
  );
  const [defaults, setDefaults] = useState(() =>
    safeRead("defaults", {
      model: "Choose your model",
      reasoning: "Medium",
      mode: "Execute",
      subagent: "Auto",
      ask: true,
      tools: "17 tools",
    }),
  );
  const [search, setSearch] = useState(""),
    [dialog, setDialog] = useState(""),
    [photo, setPhoto] = useState(""),
    [file, setFile] = useState(""),
    [frequency, setFrequency] = useState("Monthly"),
    [push, setPush] = useState(() => safeRead("push-notifications", true));
  const fileInput = useRef<HTMLInputElement>(null);
  const existingConnection = dialog.startsWith("manage:")
    ? workspace.data.connections.find((c) => c.id === dialog.slice(7))
    : workspace.data.connections.find((c) => c.provider === dialog.slice(8));
  const connectionProvider =
    existingConnection?.provider ||
    (dialog === "custom"
      ? "Custom MCP"
      : dialog.startsWith("connect:")
        ? dialog.slice(8)
        : "");
  useEffect(() => {
    if (
      dialog === "custom" ||
      dialog.startsWith("connect:") ||
      dialog.startsWith("manage:")
    ) {
      setConnectionLabel(existingConnection?.label || connectionProvider);
      setEndpoint(existingConnection?.endpoint || "");
      setConnectionEnabled(existingConnection?.enabled ?? true);
    }
  }, [dialog]);
  const connectionForm = (
    <>
      <p className="demo-note">
        External authentication is not connected. Save labels and endpoints
        only; do not enter API keys, passwords, or tokens.
      </p>
      <label className="field">
        Connection label
        <input
          aria-label="Connection label"
          className="input"
          value={connectionLabel}
          onChange={(e) => setConnectionLabel(e.target.value)}
        />
      </label>
      <label className="field">
        Endpoint (optional)
        <input
          aria-label="Endpoint (optional)"
          className="input"
          type="url"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          placeholder="https://example.com/mcp"
        />
      </label>
      <label className="check-row">
        <input
          type="checkbox"
          checked={connectionEnabled}
          onChange={(e) => setConnectionEnabled(e.target.checked)}
        />
        Enable local UI binding
      </label>
      <div className="actions">
        <button
          className="btn primary"
          disabled={!connectionLabel.trim()}
          onClick={() => {
            if (endpoint) {
              try {
                const u = new URL(endpoint);
                if (
                  u.protocol !== "https:" ||
                  u.username ||
                  u.password ||
                  u.search ||
                  u.hash
                )
                  throw Error();
              } catch {
                notify(
                  "Use an HTTPS endpoint without credentials or query parameters.",
                );
                return;
              }
            }
            const value = {
              id: existingConnection?.id || uid("connection"),
              provider: connectionProvider,
              label: connectionLabel.trim(),
              endpoint,
              enabled: connectionEnabled,
              createdAt: existingConnection?.createdAt || now(),
            };
            workspace.set("connections", (cs) =>
              existingConnection
                ? cs.map((c) => (c.id === existingConnection.id ? value : c))
                : [...cs, value],
            );
            setDialog("");
            notify(
              "Connection metadata saved locally. No authentication or network connection was made.",
            );
          }}
        >
          Save configuration
        </button>
        {existingConnection && (
          <button
            className="btn danger-outline"
            onClick={() => {
              if (
                confirm(
                  "Remove this local configuration? This does not revoke any real service access.",
                )
              ) {
                workspace.set("connections", (cs) =>
                  cs.filter((c) => c.id !== existingConnection.id),
                );
                setDialog("");
              }
            }}
          >
            Remove configuration
          </button>
        )}
      </div>
    </>
  );
  const heading =
    (groups
      .flatMap((g) => g.items)
      .find((i) => i[0] === section)?.[1] as string) || "Settings";
  useEffect(() => {
    try {
      localStorage.setItem("hyperagents-demo:profile", JSON.stringify(profile));
      localStorage.setItem(
        "hyperagents-demo:defaults",
        JSON.stringify(defaults),
      );
      localStorage.setItem(
        "hyperagents-demo:push-notifications",
        JSON.stringify(push),
      );
    } catch {}
  }, [profile, defaults, push]);
  useEffect(() => {
    setSearch("");
    setFile("");
    ref.current?.querySelector(".sx-content")?.scrollTo(0, 0);
  }, [section]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    ref.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Tab") {
        const f = ref.current?.querySelectorAll<HTMLElement>(
          'button,input,select,textarea,a[href],[tabindex="0"]',
        );
        if (!f?.length) return;
        const first = f[0],
          last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      previous?.focus();
    };
  }, []);
  const select = (
    label: string,
    value: string,
    options: string[],
    change: (s: string) => void,
  ) => (
    <label className="sx-setting-row">
      <span>{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => change(e.target.value)}
      >
        {options.map((n) => (
          <option key={n}>{n}</option>
        ))}
      </select>
    </label>
  );
  const setDefault = (key: keyof typeof defaults, v: string | boolean) =>
    setDefaults({ ...defaults, [key]: v });
  const integrationCard = (s: string[]) => (
    <div className="sx-integration-card" key={s[0]}>
      <div className="sx-integration-heading">
        <span
          className={
            "sx-service-logo service-" + s[0].split(" ")[0].toLowerCase()
          }
        >
          {s[3]}
        </span>
        <strong>{s[0]}</strong>
        <span className="sx-service-type">{s[1]}</span>
      </div>
      <small>{s[2]}</small>
      <button
        className="btn small"
        onClick={() => setDialog("connect:" + s[0])}
      >
        {s[0] === "Telegram" ? "Set up on an agent" : "Connect"}
      </button>
    </div>
  );
  let content: React.ReactNode;
  if (section === "personalization")
    content = (
      <>
        <h4>Profile photo</h4>
        <p className="muted">
          Shown to people you work with. JPG, PNG or WebP up to 5 MB.
        </p>
        <div className="sx-avatar-row">
          {photo ? (
            <img
              className="sx-profile-photo"
              src={photo}
              alt="Selected local profile"
            />
          ) : (
            <span className="avatar sx-profile-photo">
              {profile.name[0] || "D"}
            </span>
          )}
          <button
            className="btn small"
            onClick={() => fileInput.current?.click()}
          >
            Upload photo
          </button>
          <input
            hidden
            ref={fileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              if (f.size > 5 * 1024 * 1024) {
                notify("Please select an image smaller than 5 MB.");
                return;
              }
              const reader = new FileReader();
              reader.onload = () => setPhoto(String(reader.result));
              reader.readAsDataURL(f);
            }}
          />
        </div>
        <label className="field">
          Email
          <small className="muted">
            Used to sign in. It can’t be changed here.
          </small>
          <div className="sx-readonly">demo@example.com</div>
        </label>
        <label className="field">
          User ID<small className="muted">Support may ask for this.</small>
          <div className="sx-readonly">local-demo-user</div>
        </label>
        <label className="field">
          Display name
          <input
            className="input"
            value={profile.name}
            onChange={(e) => setProfile({ ...profile, name: e.target.value })}
          />
        </label>
        <label className="field">
          Company domain
          <small className="muted">
            Personalizes homepage task recommendations with your company’s news
            and industry.
          </small>
          <input
            className="input"
            placeholder="example.com"
            value={profile.company}
            onChange={(e) =>
              setProfile({ ...profile, company: e.target.value })
            }
          />
        </label>
        <p className="demo-note">
          Profile changes are saved locally on this device.
        </p>
      </>
    );
  else if (section === "appearance")
    content = (
      <>
        {select("Color mode", theme, ["light", "dark", "system"], setTheme)}
        <p className="muted">
          Choose a light or dark appearance, or follow your system preference.
        </p>
        <div className="sx-theme-previews">
          {["light", "dark", "system"].map((n) => (
            <button
              className={
                (theme === n ? "active " : "") + "sx-theme-preview " + n
              }
              key={n}
              onClick={() => setTheme(n)}
            >
              <div>
                <aside />
                <main>
                  <i />
                  <i />
                  <i />
                </main>
              </div>
              <span>
                {n[0].toUpperCase() + n.slice(1)}
                {theme === n && <Check size={13} />}
              </span>
            </button>
          ))}
        </div>
      </>
    );
  else if (section === "thread-defaults")
    content = (
      <>
        <p className="muted">
          The following defaults apply to new threads without an assigned agent.
        </p>
        {select(
          "Default model",
          defaults.model,
          [
            "Choose your model",
            "Auto",
            "GPT-6.1 Sol",
            "Claude Opus",
            "Gemini Pro",
          ],
          (v) => setDefault("model", v),
        )}
        {select(
          "Subagent model",
          defaults.subagent,
          ["Auto", "Same as main model", "GPT-6.1 Sol"],
          (v) => setDefault("subagent", v),
        )}
        {select(
          "Execution mode",
          defaults.mode,
          ["Execute", "Plan first", "Auto"],
          (v) => setDefault("mode", v),
        )}
        {select(
          "Reasoning effort",
          defaults.reasoning,
          ["Low", "Medium", "High"],
          (v) => setDefault("reasoning", v),
        )}
        <div className="sx-setting-row">
          <div>
            <strong>First run limit</strong>
            <small>
              Maximum time for each independent task in this preview.
            </small>
          </div>
          <select aria-label="First run limit">
            <option>4 hours</option>
            <option>1 hour</option>
            <option>30 minutes</option>
          </select>
        </div>
        <button
          className="sx-setting-row sx-row-button"
          onClick={() => setDialog("tools")}
        >
          <span>Tools</span>
          <span>{defaults.tools} ›</span>
        </button>
        <div className="sx-setting-row">
          <div>
            <strong>Agent delegation</strong>
            <small>Changes are local to this UI preview.</small>
          </div>
          <select aria-label="Agent delegation">
            <option>Choose on each request</option>
            <option>Never</option>
          </select>
        </div>
        <label className="sx-setting-row">
          <div>
            <strong>Ask for approval</strong>
            <small>Consequential actions should require approval.</small>
          </div>
          <input
            type="checkbox"
            checked={defaults.ask}
            onChange={(e) => setDefault("ask", e.target.checked)}
          />
        </label>
        <p className="demo-note">
          Selections are saved locally. No runtime settings are changed.
        </p>
      </>
    );
  else if (section === "security")
    content = (
      <>
        <div className="sx-setting-row">
          <div>
            <h4>Active sessions</h4>
            <p className="muted">
              For a connected account, you can sign out of other sessions. This
              demo has no authenticated sessions.
            </p>
          </div>
          <button className="sx-danger" onClick={() => setDialog("signout")}>
            Sign out everywhere
          </button>
        </div>
        <div className="sx-security-card">
          <h3>
            <Monitor size={17} />
            Browser access
          </h3>
          <p className="muted">
            The browser can sign into websites separately. No passwords or
            browser credentials are stored by this demo.
          </p>
          <div className="sx-setting-row">
            <div>
              <strong>Your browser profile</strong>
              <small>Local preview only — no signed-in sites</small>
            </div>
            <button className="btn small" onClick={() => setDialog("browser")}>
              Manage
            </button>
          </div>
        </div>
        <div className="sx-setting-row">
          <div>
            <strong>Delete account</strong>
            <small>This demo does not have a real account to delete.</small>
          </div>
          <button className="sx-danger" onClick={() => setDialog("delete")}>
            Delete this account
          </button>
        </div>
      </>
    );
  else if (section === "notifications")
    content = (
      <>
        <h4>Browser notifications</h4>
        <p className="muted">
          Receive system notifications when an agent finishes working or asks a
          question on a thread you’re not currently viewing.
        </p>
        <div className="sx-warning">
          This frontend preview does not request browser notification
          permission.
        </div>
        <label className="sx-setting-row">
          <div>
            <h4>Mobile push notifications</h4>
            <p className="muted">
              Receive push notifications in the mobile app. The toggle is a
              local preference only.
            </p>
          </div>
          <input
            type="checkbox"
            checked={push}
            onChange={(e) => setPush(e.target.checked)}
          />
        </label>
        <p className="muted">
          Notifications when a scheduled run completes are turned on per
          schedule.
        </p>
      </>
    );
  else if (section === "integrations")
    content = (
      <>
        <div className="sx-catalog-toolbar">
          <div className="sx-catalog-search">
            <Search size={14} />
            <input
              aria-label="Search integrations"
              placeholder="Search integrations…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <button
            className="plain"
            onClick={() =>
              notify("Demo catalog refreshed. No account status was requested.")
            }
          >
            <RefreshCw size={13} />
            Refresh
          </button>
        </div>
        <p className="muted">
          Looking for a site the agent signs into in its browser? Those logins
          live in{" "}
          <button
            className="sx-inline"
            onClick={() => navigateSection("security")}
          >
            Browser access
          </button>
          .
        </p>
        <h4>
          Local configurations{" "}
          <span className="badge">{workspace.data.connections.length}</span>
        </h4>
        <div className="sx-integration-grid">
          {workspace.data.connections
            .filter((c) =>
              (c.provider + " " + c.label)
                .toLowerCase()
                .includes(search.toLowerCase()),
            )
            .map((c) => (
              <div className="sx-integration-card" key={c.id}>
                <div className="sx-integration-heading">
                  <strong>{c.label}</strong>
                  <span className="sx-service-type">LOCAL</span>
                </div>
                <small>
                  {c.provider} · {c.enabled ? "Enabled UI binding" : "Disabled"}{" "}
                  · Not authenticated
                </small>
                <button
                  className="btn small"
                  onClick={() => setDialog("manage:" + c.id)}
                >
                  Manage configuration
                </button>
              </div>
            ))}
        </div>
        {!search &&
          !workspace.data.connections.some((c) => c.provider === "GitHub") && (
            <div className="sx-integration-grid">
              <div className="sx-integration-card">
                <div className="sx-integration-heading">
                  <span className="sx-service-logo">◉</span>
                  <strong>GitHub</strong>
                  <span className="sx-service-type">MCP</span>
                </div>
                <small>Code repositories, issues, PRs</small>
                <small>Example connection — not authenticated</small>
                <button
                  className="btn small"
                  onClick={() => setDialog("connect:GitHub")}
                >
                  Manage preview
                </button>
              </div>
            </div>
          )}
        <h4>Featured</h4>
        <div className="sx-integration-grid">
          {catalog
            .slice(0, 6)
            .filter((s) =>
              s.join(" ").toLowerCase().includes(search.toLowerCase()),
            )
            .map(integrationCard)}
        </div>
        <div className="sx-section-head">
          <h4>All other integrations</h4>
          <button className="plain" onClick={() => setDialog("custom")}>
            <Plus size={13} />
            Add
          </button>
        </div>
        <div className="sx-integration-grid">
          {catalog
            .slice(6)
            .filter((s) =>
              s.join(" ").toLowerCase().includes(search.toLowerCase()),
            )
            .map(integrationCard)}
        </div>
        {search &&
          !catalog.some((s) =>
            s.join(" ").toLowerCase().includes(search.toLowerCase()),
          ) && (
            <div className="empty-state">
              <p>No integrations found.</p>
            </div>
          )}
        <button className="sx-custom-mcp" onClick={() => setDialog("custom")}>
          <Plus size={19} />
          <span>
            <strong>Add custom MCP server</strong>
            <small>Connect any tool that offers an MCP server</small>
          </span>
        </button>
      </>
    );
  else if (section === "mcp-access")
    content = (
      <>
        <h4>Connect an app</h4>
        <p className="muted">
          Add Hyperagent as an MCP server to any client that supports it. This
          demonstration endpoint does not connect to a live service.
        </p>
        <label className="field">
          MCP server URL
          <div className="sx-copy-field">
            <code>https://example.com/mcp</code>
            <button
              onClick={() =>
                navigator.clipboard
                  ?.writeText("https://example.com/mcp")
                  .then(() => notify("Copied demo URL"))
                  .catch(() => notify("Clipboard unavailable."))
              }
            >
              Copy
            </button>
          </div>
        </label>
        <p className="demo-note">
          Demo placeholder URL — not a real connection endpoint.
        </p>
        <h4>Active connections</h4>
        <p className="muted">
          People and apps you’ve connected. Removing access takes effect
          immediately in a connected system.
        </p>
        <div className="empty-state">
          <KeyRound size={32} />
          <h3>No active connections</h3>
          <p>No apps are connected to this UI preview.</p>
        </div>
      </>
    );
  else if (section === "import-openclaw" || section === "import-manus")
    content = (
      <>
        <p className="muted">Import agents and context into your workspace.</p>
        <label
          className="sx-dropzone"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            setFile(e.dataTransfer.files[0]?.name || "");
          }}
        >
          <Upload size={28} />
          <strong>
            {section === "import-openclaw"
              ? "Drop your workspace export"
              : "Add your Manus ZIP"}
          </strong>
          <small>
            {section === "import-openclaw"
              ? "Select an exported JSON file or archive"
              : "Import your tasks and conversation exports"}
          </small>
          <input
            type="file"
            accept=".zip,.json"
            aria-label="Choose import file"
            onChange={(e) => setFile(e.target.files?.[0]?.name || "")}
          />
          <span className="btn small">Choose file</span>
        </label>
        {file && (
          <div className="sx-file-selected">
            <FileText size={16} />
            {file}
            <button className="plain" onClick={() => setFile("")}>
              Remove
            </button>
          </div>
        )}
        <p className="demo-note">
          File names are previewed locally. Nothing is uploaded or imported.
        </p>
        <div className="sx-import-description">
          <h4>What can be imported</h4>
          <p>
            Agents, instructions, skills and supporting documents can be mapped
            into a connected workspace.
          </p>
          <p>
            Review your export before importing. Backend migration is out of
            scope for this UI recreation.
          </p>
        </div>
      </>
    );
  else if (section === "billing")
    content = (
      <>
        <h4>Bonus credits</h4>
        <p className="muted">
          Credits cover usage that is not included in a plan. No payment methods
          are connected to this demo.
        </p>
        <div className="sx-setting-row">
          <div>
            <h4>Current Plan</h4>
            <span className="badge">Free</span>
          </div>
          <div className="actions">
            <button className="plain" onClick={() => setDialog("plans")}>
              View plans
            </button>
            <button className="plain" onClick={() => setDialog("plans")}>
              Manage <ChevronDown size={12} />
            </button>
          </div>
        </div>
        <div className="sx-plan-heading">
          <span>◉</span>
          <strong>Free plan</strong>
        </div>
        <p className="muted">
          This preview is for interface exploration. It does not meter usage or
          initiate payments.
        </p>
        {[
          ["Browser & files", "0% used"],
          ["Tools & usage", "0% used"],
          ["Model credits", "0% used"],
        ].map(([n, v]) => (
          <div className="sx-meter" key={n}>
            <div>
              <span>{n}</span>
              <small>{v}</small>
            </div>
            <div>
              <i />
            </div>
          </div>
        ))}
        <div className="sx-setting-row">
          <div>
            <strong>Shared billing</strong>
            <small>Manage your plan and budget in a connected account.</small>
          </div>
          <button className="btn small" onClick={() => setDialog("plans")}>
            View plans
          </button>
        </div>
        <p className="demo-note">
          Example usage values, not real billing data.
        </p>
      </>
    );
  else if (section === "usage")
    content = (
      <>
        <h4>Token usage</h4>
        <p className="muted">
          Token usage grouped across your agents and conversations.
        </p>
        <div className="sx-usage-stats">
          <div>
            <small>INPUT TOKENS</small>
            <strong>0</strong>
          </div>
          <div>
            <small>OUTPUT TOKENS</small>
            <strong>0</strong>
          </div>
          <div>
            <small>ESTIMATED COST</small>
            <strong>$0.00</strong>
          </div>
        </div>
        <div className="sx-usage-chart">
          <svg
            viewBox="0 0 550 220"
            role="img"
            aria-label="Demo token usage chart with no live data"
          >
            <g stroke="currentColor" opacity=".12">
              {[20, 60, 100, 140, 180].map((y) => (
                <line key={y} x1="25" x2="535" y1={y} y2={y} />
              ))}
            </g>
            <path
              d="M25 180 L70 180 L115 180 L160 180 L205 180 L250 180 L295 180 L340 180 L385 180 L430 180 L475 180 L535 180"
              fill="none"
              stroke="#9b91be"
              strokeWidth="2"
            />
            {["Oct 1", "Oct 7", "Oct 14", "Oct 21", "Oct 27"].map((s, i) => (
              <text
                key={s}
                x={25 + i * 120}
                y="208"
                fontSize="9"
                fill="currentColor"
                opacity=".5"
              >
                {s}
              </text>
            ))}
          </svg>
        </div>
        <p className="demo-note">
          No LLM or tool requests have been made. This chart uses demo data.
        </p>
      </>
    );
  else if (section === "ai-providers")
    content = (
      <>
        <h4>Your connections</h4>
        <p className="muted">
          Manage your own model subscriptions and provider connections.
        </p>
        <div className="empty-state">
          <Brain size={30} />
          <h3>No connections yet</h3>
          <p>Connect ChatGPT to use your own plan.</p>
        </div>
        <h4>Connect ChatGPT</h4>
        <p className="muted">
          Sign in to explore the connection flow in a connected system.
        </p>
        <button
          className="btn primary small"
          onClick={() => setDialog("connect:ChatGPT")}
        >
          ◉ Connect with ChatGPT
        </button>
        <p className="demo-note">
          OAuth is not connected in this frontend preview.
        </p>
      </>
    );
  else if (section === "referrals")
    content = (
      <div className="sx-warning">
        <Gift size={15} />
        <span>
          Referrals unavailable
          <br />
          <small>Referrals are not enabled for this demo workspace.</small>
        </span>
      </div>
    );
  else
    content = (
      <p className="muted">Choose a settings section from the navigation.</p>
    );
  return (
    <div
      className="sx-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="sx-dialog"
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <IconButton
          label="Close settings"
          className="sx-close"
          onClick={onClose}
        >
          <X size={17} />
        </IconButton>
        <nav className="sx-nav" aria-label="Settings navigation">
          {groups.map((g) => (
            <section key={g.label}>
              <h5>{g.label}</h5>
              {g.items.map(([key, label, I]) => {
                const Icon = I as typeof User;
                return (
                  <button
                    className={section === key ? "active" : ""}
                    key={key as string}
                    onClick={() => navigateSection(key as string)}
                  >
                    <Icon size={13} />
                    <span>{label as string}</span>
                  </button>
                );
              })}
            </section>
          ))}
        </nav>
        <section className="sx-content">
          <h2>{heading}</h2>
          {content}
        </section>
      </div>
      {dialog && (
        <Modal
          title={
            dialog.startsWith("manage:")
              ? "Connection settings"
              : dialog === "plans"
                ? "Choose a plan"
                : dialog.startsWith("connect:")
                  ? "Connect " + dialog.slice(8)
                  : dialog === "custom"
                    ? "Add custom MCP server"
                    : dialog === "delete"
                      ? "Delete account"
                      : dialog === "tools"
                        ? "Default tools"
                        : "Security preview"
          }
          onClose={() => setDialog("")}
        >
          {dialog === "plans" ? (
            <>
              <div className="segmented sx-plan-period">
                {["Monthly", "Yearly"].map((n) => (
                  <button
                    className={
                      "btn small " + (frequency === n ? "selected" : "")
                    }
                    key={n}
                    onClick={() => setFrequency(n)}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <div className="grid3">
                {["Free", "Pro", "Team"].map((n) => (
                  <div className="card" key={n}>
                    <h3>{n}</h3>
                    <p className="muted">
                      {n === "Free"
                        ? "Explore the workspace"
                        : "More room for your work"}
                    </p>
                    <button
                      className="btn small"
                      onClick={() =>
                        notify(
                          "Plan selection is a UI preview only. No payment or subscription was created.",
                        )
                      }
                    >
                      {n === "Free" ? "Current plan" : "Select " + n}
                    </button>
                  </div>
                ))}
              </div>
              <p className="demo-note">
                Plan names are shown for layout reference; no pricing or
                purchase offer is made.
              </p>
            </>
          ) : dialog === "custom" ||
            dialog.startsWith("connect:") ||
            dialog.startsWith("manage:") ? (
            <>{connectionForm}</>
          ) : dialog === "tools" ? (
            <>
              <p className="muted">
                Default tool selection in this local preview.
              </p>
              {[
                "Search",
                "Browser",
                "Webpages",
                "Slides",
                "Tables",
                "Documents",
              ].map((n) => (
                <label className="check-row" key={n}>
                  <input type="checkbox" defaultChecked />
                  {n}
                </label>
              ))}
              <button
                className="btn primary"
                onClick={() => {
                  setDialog("");
                  notify(
                    "Tool preview updated locally. No tools will execute.",
                  );
                }}
              >
                Done
              </button>
            </>
          ) : (
            <>
              <p>
                {dialog === "delete"
                  ? "This demo has no server-side account to delete. Your local data has not been removed."
                  : dialog.startsWith("connect:")
                    ? "OAuth, credentials, and external service connections are intentionally not connected."
                    : "This is a read-only frontend preview. No sessions, credentials, or permissions have been changed."}
              </p>
              <button className="btn" onClick={() => setDialog("")}>
                Close preview
              </button>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
