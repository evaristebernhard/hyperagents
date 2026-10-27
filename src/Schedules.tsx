import { useState } from "react";
import { Clock, Plus, Pencil, Trash2 } from "lucide-react";
import { useWorkspace } from "./workspace";
import { uid, type Schedule } from "./local-model";
import { Modal, IconButton } from "./ui";
export default function Schedules({
  agentId,
  roomId,
}: {
  agentId?: string;
  roomId?: string;
}) {
  const w = useWorkspace();
  const list = w.data.schedules.filter(
    (s) =>
      (!agentId || s.agentId === agentId) && (!roomId || s.roomId === roomId),
  );
  const [open, setOpen] = useState(false),
    [id, setId] = useState(""),
    [name, setName] = useState(""),
    [instructions, setInstructions] = useState(""),
    [cadence, setCadence] = useState("Daily at 09:00"),
    [selectedAgent, setSelectedAgent] = useState(agentId || ""),
    [enabled, setEnabled] = useState(false);
  const edit = (s?: Schedule) => {
    setId(s?.id || "");
    setName(s?.name || "");
    setInstructions(s?.instructions || "");
    setCadence(s?.cadence || "Daily at 09:00");
    setSelectedAgent(s?.agentId || agentId || "");
    setEnabled(s?.enabled || false);
    setOpen(true);
  };
  return (
    <div className="local-schedules">
      <div className="page-header">
        <h3>
          Scheduled work <span className="badge">{list.length}</span>
        </h3>
        <button className="btn small" onClick={() => edit()}>
          <Plus size={14} />
          Add schedule
        </button>
      </div>
      <p className="demo-note">
        Schedules are saved as local configuration. No background worker is
        connected, so nothing runs automatically.
      </p>
      {list.length ? (
        list.map((s) => (
          <article className="card local-schedule" key={s.id}>
            <Clock size={20} />
            <div>
              <strong>{s.name}</strong>
              <small>
                {s.cadence} ·{" "}
                {w.data.agents.find((a) => a.id === s.agentId)?.name ||
                  "No agent assigned"}
              </small>
              <p>{s.instructions}</p>
              <span className="badge">
                {s.enabled ? "Enabled configuration" : "Disabled"} · Execution
                off
              </span>
            </div>
            <div className="actions">
              <IconButton label="Edit schedule" onClick={() => edit(s)}>
                <Pencil size={14} />
              </IconButton>
              <IconButton
                label="Delete schedule"
                onClick={() => {
                  if (confirm("Delete this local schedule?"))
                    w.set("schedules", (ss) => ss.filter((x) => x.id !== s.id));
                }}
              >
                <Trash2 size={14} />
              </IconButton>
            </div>
          </article>
        ))
      ) : (
        <div className="empty-state small">
          <Clock size={26} />
          <h3>No schedules yet</h3>
        </div>
      )}
      {open && (
        <Modal
          title={id ? "Edit schedule" : "Add schedule"}
          onClose={() => setOpen(false)}
          footer={
            <>
              <button className="btn" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button
                className="btn primary"
                disabled={!name.trim() || !instructions.trim()}
                onClick={() => {
                  const s: Schedule = {
                    id: id || uid("schedule"),
                    name: name.trim(),
                    instructions,
                    cadence,
                    enabled,
                    agentId: selectedAgent || undefined,
                    roomId,
                  };
                  w.set("schedules", (ss) =>
                    id ? ss.map((x) => (x.id === id ? s : x)) : [...ss, s],
                  );
                  setOpen(false);
                }}
              >
                Save schedule
              </button>
            </>
          }
        >
          <label className="field">
            Schedule name
            <input
              aria-label="Schedule name"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="field">
            Instructions
            <textarea
              aria-label="Instructions"
              className="textarea"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
            />
          </label>
          <label className="field">
            Frequency
            <select
              aria-label="Frequency"
              className="input"
              value={cadence}
              onChange={(e) => setCadence(e.target.value)}
            >
              {[
                "Daily at 09:00",
                "Weekly on Monday",
                "Every 30 minutes",
                "Monthly on the 1st",
              ].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Agent
            <select
              aria-label="Agent"
              className="input"
              value={selectedAgent}
              onChange={(e) => setSelectedAgent(e.target.value)}
            >
              <option value="">Unassigned</option>
              {w.data.agents
                .filter((a) => !a.archived)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Enable configuration (execution remains off)
          </label>
        </Modal>
      )}
    </div>
  );
}
