import { useCallback, useEffect, useState } from "react";
import type { Account, TaskSummary, TwinProfile } from "@twinly/shared";
import { AuthScreen } from "./AuthScreen";
import { TaskView } from "./TaskView";
import { TwinSetup } from "./TwinSetup";

type View = { kind: "twin" } | { kind: "new" } | { kind: "task"; id: string };

export function App() {
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  const [error, setError] = useState("");

  useEffect(() => {
    window.twin.getSession().then(setAccount, (e: Error) => setError(e.message));
  }, []);

  if (account === undefined) {
    return (
      <div className="center">
        {error ? (
          <div className="stack">
            <p className="error">{error}</p>
            <button onClick={() => location.reload()}>Try again</button>
          </div>
        ) : (
          "Loading..."
        )}
      </div>
    );
  }
  if (account === null) return <AuthScreen onSignedIn={setAccount} />;
  return <Workspace account={account} setAccount={setAccount} />;
}

function Workspace({ account, setAccount }: { account: Account; setAccount: (a: Account | null) => void }) {
  const [profile, setProfile] = useState<TwinProfile | null | undefined>(undefined);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [view, setView] = useState<View>({ kind: "new" });
  const [error, setError] = useState("");

  const refreshAccount = useCallback(() => {
    window.twin.getSession().then((a) => a && setAccount(a), () => {});
  }, [setAccount]);

  useEffect(() => {
    window.twin.getProfile().then(setProfile, (e: Error) => setError(e.message));
    window.twin.listTasks().then(setTasks, () => {});
    // Plan changes (Stripe checkout in the browser) show up when the user comes back.
    window.addEventListener("focus", refreshAccount);
    const off = window.twin.onTaskEvent((event) => {
      if (event.kind !== "status") return;
      setTasks((list) => list.map((t) => (t.id === event.taskId ? { ...t, status: event.status } : t)));
      if (event.status === "idle" || event.status === "stopped" || event.status === "failed") refreshAccount();
    });
    return () => {
      window.removeEventListener("focus", refreshAccount);
      off();
    };
  }, [refreshAccount]);

  const logOut = async () => {
    await window.twin.logOut();
    setAccount(null);
  };

  if (profile === undefined) return <div className="center">{error || "Loading your twin..."}</div>;
  if (profile === null || view.kind === "twin") {
    return (
      <TwinSetup
        initial={profile}
        onSaved={(p) => {
          setProfile(p);
          setView({ kind: "new" });
        }}
        onBack={profile ? () => setView({ kind: "new" }) : undefined}
        onDeleted={() => setAccount(null)}
      />
    );
  }

  const usedPct = Math.min(100, Math.round((account.usageCents / account.limitCents) * 100));

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
              title={t.title}
            >
              <span className={`dot ${t.status}`} />
              <span className="ellipsis">{t.title}</span>
            </button>
          ))}
          {tasks.length === 0 && <p className="muted small-text">Your tasks will show up here.</p>}
        </nav>
        <div className="plan">
          <div className="plan-row">
            <span>{account.plan === "pro" ? "Pro" : "Free"} plan</span>
            <span className="muted">{usedPct}% used</span>
          </div>
          <div className="meter" role="meter" aria-valuenow={usedPct} aria-valuemin={0} aria-valuemax={100}>
            <div style={{ width: `${usedPct}%` }} />
          </div>
          {account.billingEnabled &&
            (account.plan === "free" ? (
              <button className="small primary" onClick={() => window.twin.upgrade().catch((e: Error) => alert(e.message))}>
                Upgrade to Pro
              </button>
            ) : (
              <button className="small" onClick={() => window.twin.manageBilling().catch((e: Error) => alert(e.message))}>
                Manage billing
              </button>
            ))}
        </div>
        <div className="row">
          <button className="ghost small" onClick={() => setView({ kind: "twin" })}>
            My twin
          </button>
          <button className="ghost small" onClick={logOut}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="main">
        {!account.emailVerified && <VerifyBanner email={account.email} />}
        {view.kind === "task" ? (
          <TaskView key={view.id} taskId={view.id} account={account} />
        ) : (
          <NewTask
            name={profile.name}
            account={account}
            onStarted={(task) => {
              setTasks((list) => [task, ...list]);
              setView({ kind: "task", id: task.id });
              refreshAccount();
            }}
          />
        )}
      </main>
    </div>
  );
}

function VerifyBanner({ email }: { email: string }) {
  const [sent, setSent] = useState(false);
  return (
    <div className="banner">
      Confirm your email to start tasks: we sent a link to <b>{email}</b>.{" "}
      {sent ? (
        <span className="muted">Sent again.</span>
      ) : (
        <button className="link" onClick={() => window.twin.resendVerification().then(() => setSent(true), () => {})}>
          Resend
        </button>
      )}
    </div>
  );
}

const EXAMPLES = [
  "Draft my weekly update to the team from these notes: ...",
  "Turn this meeting transcript into action items with owners and due dates: ...",
  "Write a LinkedIn post announcing our new feature, in my voice: ...",
];

function NewTask({ name, account, onStarted }: { name: string; account: Account; onStarted: (task: TaskSummary) => void }) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function start() {
    setBusy(true);
    setError("");
    try {
      onStarted(await window.twin.startTask(prompt.trim()));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="new-task">
      <h1>What should your twin work on{name ? `, ${name.split(" ")[0]}` : ""}?</h1>
      <textarea
        autoFocus
        rows={7}
        placeholder="Describe the task and paste any notes, data or links it needs."
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && prompt.trim()) void start();
        }}
      />
      <div className="examples">
        {EXAMPLES.map((example) => (
          <button key={example} className="chip" onClick={() => setPrompt(example)}>
            {example.replace(": ...", "")}
          </button>
        ))}
      </div>
      {error && (
        <div className="error-row">
          <p className="error">{error}</p>
          {account.billingEnabled && account.plan === "free" && error.includes("Upgrade") && (
            <button className="primary small" onClick={() => window.twin.upgrade()}>
              Upgrade to Pro
            </button>
          )}
        </div>
      )}
      <button className="primary" disabled={busy || !prompt.trim()} onClick={start}>
        {busy ? "Starting..." : "Start task"}
      </button>
    </div>
  );
}
