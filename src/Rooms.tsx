import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Users,
  Plus,
  MessageSquare,
  Pencil,
  Trash2,
  Archive,
  Clock,
} from "lucide-react";
import type { PageProps } from "./types";
import type { Room } from "./local-model";
import { uid, now } from "./local-model";
import { useWorkspace } from "./workspace";
import { IconButton, Modal } from "./ui";
import Schedules from "./Schedules";
export default function Rooms({ path, navigate, notify }: PageProps) {
  const w = useWorkspace();
  const id = path.split("/")[2],
    room = w.data.rooms.find((r) => r.id === id),
    creating = id === "new";
  const [name, setName] = useState(""),
    [topic, setTopic] = useState(""),
    [members, setMembers] = useState<string[]>([]),
    [open, setOpen] = useState(""),
    [tab, setTab] = useState("Discussion"),
    [text, setText] = useState(""),
    [archived, setArchived] = useState(false);
  useEffect(() => {
    setName(room?.name || "");
    setTopic(room?.topic || "");
    setMembers(room?.agentIds || []);
    setOpen("");
    setText("");
    setTab("Discussion");
  }, [path, w.state.active]);
  const save = () => {
    const r: Room = {
      id: room?.id || uid("room"),
      name: name.trim(),
      topic,
      agentIds: members,
      notes: room?.notes || [],
    };
    w.set("rooms", (rs) =>
      room ? rs.map((x) => (x.id === room.id ? r : x)) : [...rs, r],
    );
    setOpen("");
    navigate("/rooms/" + r.id);
    notify("Room saved locally.");
  };
  const roomThreads = w.data.threads.filter(
    (t) => t.roomId === id && !t.archived,
  );
  return (
    <div className="standard-page local-rooms">
      {!id ? (
        <>
          <div className="page-header">
            <h1 className="page-title">Rooms</h1>
            <div className="actions">
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={archived}
                  onChange={(e) => setArchived(e.target.checked)}
                />
                Archived
              </label>
              <button
                className="btn primary"
                onClick={() => navigate("/rooms/new")}
              >
                <Plus size={14} />
                New room
              </button>
            </div>
          </div>
          <div className="grid2">
            {w.data.rooms
              .filter((r) => !!r.archived === archived)
              .map((r) => (
                <a
                  className="card"
                  key={r.id}
                  href={"/rooms/" + r.id}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate("/rooms/" + r.id);
                  }}
                >
                  <Users size={25} />
                  <h3>{r.name}</h3>
                  <p className="muted">
                    {r.topic || "A shared space for your work."}
                  </p>
                  <small>
                    {r.agentIds.length} local agents · {r.notes.length} notes
                  </small>
                </a>
              ))}
          </div>
          {!w.data.rooms.some((r) => !!r.archived === archived) && (
            <div className="empty-state">
              <Users size={32} />
              <h3>No rooms yet</h3>
              <p>Start a room to organize discussions and related work.</p>
            </div>
          )}
        </>
      ) : creating ? (
        <>
          <div className="page-header">
            <button className="plain" onClick={() => navigate("/rooms")}>
              <ArrowLeft size={15} />
              New room
            </button>
            <div className="actions">
              <span className="badge">Draft room</span>
              <button className="btn" onClick={() => navigate("/rooms")}>
                Cancel
              </button>
              <button
                className="btn primary"
                disabled={!name.trim()}
                onClick={save}
              >
                Create room
              </button>
            </div>
          </div>
          <div className="room-content">
            <h2>A shared room for this work.</h2>
            <p className="muted">
              Keep local notes, agents, schedules, and threads together. No
              multiplayer server or model is connected.
            </p>
            <label className="field">
              Room name
              <input
                aria-label="Room name"
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name your room"
              />
            </label>
            <label className="field">
              What will you work on?
              <textarea
                aria-label="What will you work on?"
                className="textarea"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
              />
            </label>
            <div className="page-header">
              <h3>Room team</h3>
              <button className="btn small" onClick={() => setOpen("members")}>
                <Plus size={14} />
                Add members
              </button>
            </div>
            <div className="card room-member">
              <span className="avatar">D</span>
              <div>
                <strong>You</strong>
                <p className="muted">Room manager · local workspace</p>
              </div>
            </div>
            {members.map((agentId) => (
              <div className="card room-member" key={agentId}>
                <Users size={17} />
                <strong>
                  {w.data.agents.find((a) => a.id === agentId)?.name ||
                    "Unknown agent"}
                </strong>
                <button
                  className="plain"
                  onClick={() =>
                    setMembers(members.filter((x) => x !== agentId))
                  }
                >
                  Remove
                </button>
              </div>
            ))}
            <div className="empty-state small">
              <h3>{members.length ? "Your room team" : "Just you so far"}</h3>
              <p>Agents are local saved identities, not running workers.</p>
            </div>
            <div className="grid3">
              {["Talk together", "Work in threads", "Move it forward"].map(
                (n) => (
                  <div className="card" key={n}>
                    <MessageSquare size={18} />
                    <h4>{n}</h4>
                  </div>
                ),
              )}
            </div>
            <div className="card schedule-card">
              <Clock size={20} />
              <div>
                <h3>A rhythm when you need one</h3>
                <p>
                  After creating the room, add schedule configurations.
                  Execution stays off.
                </p>
              </div>
            </div>
          </div>
        </>
      ) : room ? (
        <>
          <div className="page-header">
            <div>
              <button className="plain" onClick={() => navigate("/rooms")}>
                <ArrowLeft size={15} />
                Rooms
              </button>
              <h1 className="page-title">{room.name}</h1>
            </div>
            <div className="actions">
              <button
                className="btn small"
                onClick={() => {
                  setName(room.name);
                  setTopic(room.topic);
                  setMembers(room.agentIds);
                  setOpen("edit");
                }}
              >
                <Pencil size={14} />
                Edit room
              </button>
              <button
                className="btn small"
                onClick={() => {
                  w.set("rooms", (rs) =>
                    rs.map((r) =>
                      r.id === room.id ? { ...r, archived: !r.archived } : r,
                    ),
                  );
                  navigate("/rooms");
                }}
              >
                <Archive size={14} />
                {room.archived ? "Restore" : "Archive"}
              </button>
            </div>
          </div>
          <p className="muted">{room.topic}</p>
          <div className="tabs">
            {["Discussion", "Threads", "Team", "Schedules"].map((n) => (
              <button
                key={n}
                className={tab === n ? "selected" : ""}
                onClick={() => setTab(n)}
              >
                {n}
                {n === "Threads" ? " (" + roomThreads.length + ")" : ""}
              </button>
            ))}
          </div>
          {tab === "Discussion" ? (
            <div className="local-room-discussion">
              <p className="demo-note">
                Local discussion notes only. No LLM response or invitation is
                sent.
              </p>
              {room.notes.map((n) => (
                <article className="card" key={n.id}>
                  <div className="page-header">
                    <small className="muted">
                      You · {new Date(n.createdAt).toLocaleString()}
                    </small>
                    <IconButton
                      label="Delete note"
                      onClick={() => {
                        if (confirm("Delete this local note?"))
                          w.set("rooms", (rs) =>
                            rs.map((r) =>
                              r.id === room.id
                                ? {
                                    ...r,
                                    notes: r.notes.filter((x) => x.id !== n.id),
                                  }
                                : r,
                            ),
                          );
                      }}
                    >
                      <Trash2 size={14} />
                    </IconButton>
                  </div>
                  <p>{n.text}</p>
                </article>
              ))}
              {!room.notes.length && (
                <div className="empty-state small">
                  <MessageSquare size={25} />
                  <h3>Start the discussion</h3>
                </div>
              )}
              <form
                className="card"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!text.trim()) return;
                  w.set("rooms", (rs) =>
                    rs.map((r) =>
                      r.id === room.id
                        ? {
                            ...r,
                            notes: [
                              ...r.notes,
                              {
                                id: uid("note"),
                                text: text.trim(),
                                createdAt: now(),
                              },
                            ],
                          }
                        : r,
                    ),
                  );
                  setText("");
                }}
              >
                <label className="field">
                  Add a room note
                  <textarea
                    aria-label="Add a room note"
                    className="textarea"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                  />
                </label>
                <button className="btn primary" disabled={!text.trim()}>
                  Add note
                </button>
              </form>
            </div>
          ) : tab === "Team" ? (
            <div className="local-summary-cards">
              <div className="page-header">
                <h3>Room team</h3>
                <button
                  className="btn"
                  onClick={() => {
                    setMembers(room.agentIds);
                    setOpen("members");
                  }}
                >
                  Manage members
                </button>
              </div>
              <p>You · Room manager</p>
              {room.agentIds.map((a) => (
                <button
                  className="card"
                  key={a}
                  onClick={() => navigate("/agents/" + a)}
                >
                  {w.data.agents.find((x) => x.id === a)?.name ||
                    "Missing local identity"}{" "}
                  ›
                </button>
              ))}
            </div>
          ) : tab === "Schedules" ? (
            <Schedules roomId={room.id} />
          ) : (
            <div className="local-summary-cards">
              <div className="page-header">
                <h3>Related threads</h3>
                <button className="btn" onClick={() => setOpen("thread")}>
                  Add existing thread
                </button>
              </div>
              {roomThreads.map((t) => (
                <button
                  className="card rp-project-thread-card"
                  key={t.id}
                  onClick={() => navigate("/thread/" + t.id)}
                >
                  <h3>{t.title}</h3>
                  <p>{t.summary}</p>
                </button>
              ))}
              <p className="muted">
                Link existing threads without sending a model request.
              </p>
            </div>
          )}
          <button
            className="plain local-danger-actions"
            onClick={() => {
              if (
                confirm(
                  "Delete this room? Its threads will remain in the workspace.",
                )
              ) {
                w.set("rooms", (rs) => rs.filter((r) => r.id !== room.id));
                w.set("threads", (ts) =>
                  ts.map((t) =>
                    t.roomId === room.id ? { ...t, roomId: undefined } : t,
                  ),
                );
                w.set("schedules", (ss) =>
                  ss.filter((s) => s.roomId !== room.id),
                );
                navigate("/rooms");
              }
            }}
          >
            <Trash2 size={14} />
            Delete room
          </button>
        </>
      ) : (
        <div className="empty-state">
          <h2>Room not found</h2>
          <button className="btn" onClick={() => navigate("/rooms")}>
            View rooms
          </button>
        </div>
      )}
      {open === "members" && (
        <Modal
          title="Room members"
          onClose={() => setOpen("")}
          footer={
            <button
              className="btn primary"
              onClick={() => {
                if (room)
                  w.set("rooms", (rs) =>
                    rs.map((r) =>
                      r.id === room.id ? { ...r, agentIds: members } : r,
                    ),
                  );
                setOpen("");
              }}
            >
              Done
            </button>
          }
        >
          <p className="muted">
            Choose local agent identities. This does not activate agents or
            invite people.
          </p>
          {w.data.agents
            .filter((a) => !a.archived)
            .map((a) => (
              <label className="check-row" key={a.id}>
                <input
                  type="checkbox"
                  checked={members.includes(a.id)}
                  onChange={(e) =>
                    setMembers(
                      e.target.checked
                        ? [...members, a.id]
                        : members.filter((x) => x !== a.id),
                    )
                  }
                />
                {a.name}
              </label>
            ))}
          {!w.data.agents.length && (
            <button className="btn" onClick={() => navigate("/agents/new")}>
              Create an agent
            </button>
          )}
        </Modal>
      )}
      {open === "edit" && (
        <Modal
          title="Edit room"
          onClose={() => setOpen("")}
          footer={
            <button
              className="btn primary"
              disabled={!name.trim()}
              onClick={save}
            >
              Save room
            </button>
          }
        >
          <label className="field">
            Room name
            <input
              aria-label="Room name"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="field">
            Topic
            <textarea
              aria-label="Topic"
              className="textarea"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
            />
          </label>
        </Modal>
      )}
      {open === "thread" && (
        <Modal title="Link a thread" onClose={() => setOpen("")}>
          {w.data.threads
            .filter((t) => !t.archived)
            .map((t) => (
              <button
                className="rp-add-thread-row"
                key={t.id}
                onClick={() => {
                  w.set("threads", (ts) =>
                    ts.map((x) =>
                      x.id === t.id ? { ...x, roomId: room!.id } : x,
                    ),
                  );
                  setOpen("");
                }}
              >
                {t.title}
                <Plus size={14} />
              </button>
            ))}
        </Modal>
      )}
    </div>
  );
}
