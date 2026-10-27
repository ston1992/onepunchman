import { useEffect, useRef, useState } from "react";
import type { TaskEvent, TaskStatus } from "@shared/types";

const STATUS_LABEL: Record<TaskStatus, string> = {
  starting: "Starting cloud workspace...",
  running: "Working...",
  waiting_approval: "Needs your approval",
  idle: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

export function TaskView({ taskId }: { taskId: string }) {
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [status, setStatus] = useState<{ status: TaskStatus; detail?: string }>({ status: "starting" });
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const [reply, setReply] = useState("");
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.twin.listTasks().then((tasks) => {
      const task = tasks.find((t) => t.id === taskId);
      if (task) setStatus({ status: task.status });
    });
    window.twin.getTaskEvents(taskId).then(setEvents);
    return window.twin.onTaskEvent((event) => {
      if (event.taskId !== taskId) return;
      if (event.kind === "status") setStatus({ status: event.status, detail: event.detail });
      else setEvents((list) => [...list, event]);
    });
  }, [taskId]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [events]);

  const busy = status.status === "starting" || status.status === "running" || status.status === "waiting_approval";

  async function answer(id: string, allow: boolean) {
    setAnswered((s) => new Set(s).add(id));
    await window.twin.answerApproval(taskId, id, allow);
  }

  async function send() {
    const text = reply.trim();
    if (!text) return;
    setReply("");
    await window.twin.sendFollowUp(taskId, text);
  }

  return (
    <div className="task">
      <header className="task-header">
        <span className={`dot ${status.status}`} />
        <span>{STATUS_LABEL[status.status]}</span>
        {status.detail && <span className="muted"> - {status.detail}</span>}
        {busy && (
          <button className="ghost small" onClick={() => window.twin.stopTask(taskId)}>
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
                <div key={i} className="tool">
                  <span className="tool-name">{event.name}</span> <code>{event.summary}</code>
                </div>
              );
            case "approval":
              return (
                <div key={i} className="approval">
                  <div>
                    Your twin wants to run <b>{event.name}</b>: <code>{event.summary}</code>
                  </div>
                  {!answered.has(event.id) && (
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
                  <div>Deliverables: {event.names.join(", ")}</div>
                  <button className="small" onClick={() => window.twin.openOutputs(taskId)}>Open folder</button>
                </div>
              );
            case "error":
              return <div key={i} className="error">{event.message}</div>;
          }
        })}
        <div ref={bottom} />
      </div>

      <div className="composer">
        <textarea
          rows={2}
          placeholder={busy ? "Add instructions while it works..." : "Ask for changes. Corrections are remembered."}
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="primary" disabled={!reply.trim()} onClick={send}>Send</button>
      </div>
    </div>
  );
}
