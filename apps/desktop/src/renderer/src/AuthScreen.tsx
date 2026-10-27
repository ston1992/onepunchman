import { useState } from "react";
import type { Account } from "@twinly/shared";

export function AuthScreen({ onSignedIn }: { onSignedIn: (account: Account) => void }) {
  const [mode, setMode] = useState<"signup" | "login">("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function forgot() {
    setError("");
    if (!email) return setError("Enter your email above first.");
    try {
      await window.twin.forgotPassword(email);
      setNotice("If that email has an account, a reset link is on its way.");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      onSignedIn(mode === "signup" ? await window.twin.signUp(email, password) : await window.twin.logIn(email, password));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand">Twinly</div>
        <h1>{mode === "signup" ? "Meet your work twin" : "Welcome back"}</h1>
        <p className="muted">
          {mode === "signup"
            ? "An AI copy of you that drafts, researches and analyzes in your voice."
            : "Sign in to pick up where your twin left off."}
        </p>
        <label>
          Email
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            minLength={mode === "signup" ? 10 : 1}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {mode === "login" && (
          <button type="button" className="link forgot" onClick={forgot}>
            Forgot password?
          </button>
        )}
        {notice && <p className="muted">{notice}</p>}
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>
          {busy ? "One moment..." : mode === "signup" ? "Create account" : "Sign in"}
        </button>
        <button type="button" className="ghost" onClick={() => setMode(mode === "signup" ? "login" : "signup")}>
          {mode === "signup" ? "Already have an account? Sign in" : "New here? Create an account"}
        </button>
        {mode === "signup" && (
          <p className="fine-print">
            By creating an account you agree to the{" "}
            <button type="button" className="link" onClick={() => window.twin.openLegal("terms")}>
              Terms
            </button>{" "}
            and{" "}
            <button type="button" className="link" onClick={() => window.twin.openLegal("privacy")}>
              Privacy Policy
            </button>
            .
          </p>
        )}
      </form>
    </div>
  );
}
