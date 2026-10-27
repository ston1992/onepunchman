import { useEffect, useRef, useState } from "react";
import type { Account, TaskEvent, TaskStatus } from "@twinly/shared";

const STATUS_LABEL: Record<TaskStatus, string> = {
  starting: "Starting cloud workspace...",
  running: "Working...",
  waiting_approval: "Needs your approval",
  idle: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

type TimelineEvent = Exclude<TaskEvent, { kind: "status" }>;

/** History and live events can overlap by a few events; keep the first of each. */
function append(list: TimelineEvent[], event: TimelineEvent): TimelineEvent[] {
  if ("id" in event && list.some((e) => "id" in e && e.id === event.id)) return list;
  return [...list, event];
}

export function TaskView({ taskId, account }: { taskId: string; account: Account }) {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [status, setStatus] = useState<{ status: TaskStatus; detail?: string }>({ status: "starting" });
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const [reply, setReply] = useState("");
  const [error, setError] = useState("");
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const off = window.twin.onTaskEvent((event) => {
      if (event.taskId !== taskId) return;
      if (event.kind === "status") setStatus({ status: event.status, detail: event.detail });
      else setEvents((list) => append(list, event));
    });
    window.twin.listTasks().then((tasks) => {
      const task = tasks.find((t) => t.id === taskId);
      if (task) setStatus((s) => (s.status === "starting" ? { status: task.status } : s));
    });
    window.twin
      .getTaskEvents(taskId)
      .then((history) => setEvents((live) => live.reduce(append, history as TimelineEvent[])))
      .catch((e: Error) => setError(e.message));
    return off;
  }, [taskId]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [events]);

  const busy = status.status === "starting" || status.status === "running" || status.status === "waiting_approval";

  const act = (action: () => Promise<void>) => {
    setError("");
    action().catch((e: Error) => setError(e.message));
  };

  function answer(id: string, allow: boolean) {
    setAnswered((s) => new Set(s).add(id));
    act(() => window.twin.answerApproval(taskId, id, allow));
  }

  function send() {
    const text = reply.trim();
    if (!text) return;
    setReply("");
    act(() => window.twin.sendFollowUp(taskId, text));
  }

  return (
    <div className="task">
      <header className="task-header">
        <span className={`dot ${status.status}`} />
        <span>{STATUS_LABEL[status.status]}</span>
        {status.detail && <span className="muted"> - {status.detail}</span>}
        {busy && (
          <button className="ghost small" onClick={() => act(() => window.twin.stopTask(taskId))}>
            Stop
          </button>
        )}
      </header>

      <div className="timeline">
        {events.map((event, i) => {
          switch (event.kind) {
            case "user":
              return <div key={i} className="bubble user">{event.text}</div>;
            case "message":
              return <div key={i} className="bubble agent">{event.text}</div>;
            case "tool":
              return (
                <div key={i} className="tool" title={event.summary}>
                  <span className="tool-name">{event.name}</span> <code>{event.summary}</code>
                </div>
              );
            case "approval":
              return (
                <div key={i} className="approval">
                  <div>
                    Your twin wants to run <b>{event.name}</b>: <code>{event.summary}</code>
                  </div>
                  {!answered.has(event.id) && status.status === "waiting_approval" && (
                    <div className="row">
                      <button className="primary small" onClick={() => answer(event.id, true)}>Allow</button>
                      <button className="small" onClick={() => answer(event.id, false)}>Deny</button>
                    </div>
                  )}
                </div>
              );
            case "files":
              return (
                <div key={i} className="files">
                  <div>
                    <b>Deliverables:</b> {event.files.map((f) => f.name).join(", ")}
                  </div>
                  <button className="small" onClick={() => act(() => window.twin.openOutputs(taskId))}>
                    Save &amp; open folder
                  </button>
                </div>
              );
            case "error":
              return <div key={i} className="error">{event.message}</div>;
          }
        })}
        {busy && events.length > 0 && <div className="working muted">Your twin is working...</div>}
        <div ref={bottom} />
      </div>

      {error && (
        <div className="error-row composer-error">
          <p className="error">{error}</p>
          {account.billingEnabled && account.plan === "free" && error.includes("Upgrade") && (
            <button className="primary small" onClick={() => window.twin.upgrade()}>Upgrade to Pro</button>
          )}
        </div>
      )}
      <div className="composer">
        <textarea
          rows={2}
          placeholder={busy ? "Add instructions while it works..." : "Ask for changes. Corrections are remembered."}
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="primary" disabled={!reply.trim() || status.status === "waiting_approval"} onClick={send}>
          Send
        </button>
      </div>
    </div>
  );
}
