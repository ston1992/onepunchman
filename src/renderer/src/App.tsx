import { useEffect, useState } from "react";
import type { TaskSummary, TwinProfile } from "@shared/types";
import { TaskView } from "./TaskView";
import { TwinSetup } from "./TwinSetup";

type View = { kind: "twin" } | { kind: "new" } | { kind: "task"; id: string };

export function App() {
  const [profile, setProfile] = useState<TwinProfile | null | undefined>(undefined);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [view, setView] = useState<View>({ kind: "new" });
  const [error, setError] = useState("");

  useEffect(() => {
    window.twin.getProfile().then(setProfile, (e) => setError(String(e)));
    window.twin.listTasks().then(setTasks);
    return window.twin.onTaskEvent((event) => {
      if (event.kind === "status") {
        setTasks((list) => list.map((t) => (t.id === event.taskId ? { ...t, status: event.status } : t)));
      }
    });
  }, []);

  if (profile === undefined) return <div className="center">{error || "Loading your twin..."}</div>;
  if (profile === null || view.kind === "twin") {
    return (
      <TwinSetup
        initial={profile}
        onSaved={(p) => {
          setProfile(p);
          setView({ kind: "new" });
        }}
      />
    );
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">Twinly</div>
        <button className="primary" onClick={() => setView({ kind: "new" })}>
          New task
        </button>
        <nav>
          {tasks.map((t) => (
            <button
              key={t.id}
              className={`task-link ${view.kind === "task" && view.id === t.id ? "active" : ""}`}
              onClick={() => setView({ kind: "task", id: t.id })}
            >
              <span className={`dot ${t.status}`} />
              {t.title}
            </button>
          ))}
        </nav>
        <button className="ghost" onClick={() => setView({ kind: "twin" })}>
          My twin: {profile.name || "Profile"}
        </button>
      </aside>
      <main className="main">
        {view.kind === "task" ? (
          <TaskView key={view.id} taskId={view.id} />
        ) : (
          <NewTask
            name={profile.name}
            onStarted={(task) => {
              setTasks((list) => [task, ...list]);
              setView({ kind: "task", id: task.id });
            }}
          />
        )}
      </main>
    </div>
  );
}

function NewTask({ name, onStarted }: { name: string; onStarted: (task: TaskSummary) => void }) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function start() {
    setBusy(true);
    setError("");
    try {
      onStarted(await window.twin.startTask(prompt.trim()));
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <div className="new-task">
      <h1>What should your twin work on{name ? `, ${name.split(" ")[0]}` : ""}?</h1>
      <textarea
        autoFocus
        rows={6}
        placeholder="e.g. Draft my weekly update to the team from these notes: ..."
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
      />
      {error && <p className="error">{error}</p>}
      <button className="primary" disabled={busy || !prompt.trim()} onClick={start}>
        {busy ? "Starting..." : "Start task"}
      </button>
    </div>
  );
}
