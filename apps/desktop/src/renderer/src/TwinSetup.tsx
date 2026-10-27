import { useEffect, useState } from "react";
import type { TwinProfile, WritingSample } from "@twinly/shared";

const EMPTY: TwinProfile = { name: "", role: "", company: "", voice: "", preferences: "" };

interface Props {
  initial: TwinProfile | null;
  onSaved: (p: TwinProfile) => void;
  onBack?: () => void;
  onDeleted: () => void;
}

export function TwinSetup({ initial, onSaved, onBack, onDeleted }: Props) {
  const [profile, setProfile] = useState<TwinProfile>(initial ?? EMPTY);
  const [samples, setSamples] = useState<WritingSample[]>([]);
  const [sampleTitle, setSampleTitle] = useState("");
  const [sampleText, setSampleText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (initial) window.twin.listSamples().then(setSamples, () => {});
  }, [initial]);

  const field = (key: keyof TwinProfile) => ({
    value: profile[key],
    onChange: (e: { target: { value: string } }) => setProfile({ ...profile, [key]: e.target.value }),
  });

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteAccount() {
    const ok = confirm(
      "Delete your account? This permanently deletes your twin, all tasks and their files, and cancels your subscription. This can't be undone.",
    );
    if (!ok) return;
    await run(async () => {
      await window.twin.deleteAccount();
      onDeleted();
    });
  }

  return (
    <div className="twin-setup">
      {onBack && (
        <button className="ghost small back" onClick={onBack}>
          &larr; Back to tasks
        </button>
      )}
      <h1>{initial ? "Your twin" : "Create your work twin"}</h1>
      <p className="muted">
        Your twin works in a secure cloud workspace and writes the way you do. Everything here is stored in your
        twin's memory, and it keeps learning from your corrections.
      </p>

      <div className="grid">
        <label>
          Name
          <input {...field("name")} placeholder="Alex Kim" />
        </label>
        <label>
          Role
          <input {...field("role")} placeholder="Product Marketing Manager" />
        </label>
        <label>
          Company
          <input {...field("company")} placeholder="Acme Inc. (B2B SaaS, 200 people)" />
        </label>
      </div>
      <label>
        How you write
        <textarea
          rows={3}
          {...field("voice")}
          placeholder="Direct and friendly. Short paragraphs. No emojis. Sign off with '- Alex'."
        />
      </label>
      <label>
        How you like work done
        <textarea
          rows={3}
          {...field("preferences")}
          placeholder="Lead with the recommendation. Tables over long lists. US spelling. Fiscal year starts Feb 1."
        />
      </label>
      <button
        className="primary"
        disabled={busy || !profile.name.trim()}
        onClick={() =>
          run(async () => {
            await window.twin.saveProfile(profile);
            if (initial) setNotice("Saved.");
            onSaved(profile);
          })
        }
      >
        {initial ? "Save profile" : "Create my twin"}
      </button>
      {notice && <p className="muted">{notice}</p>}

      {initial && (
        <section className="samples">
          <h2>Writing samples</h2>
          <p className="muted">Paste emails, docs or posts you wrote. Three to five good ones teach your voice best.</p>
          {samples.length > 0 && (
            <ul>
              {samples.map((s) => (
                <li key={s.path}>{s.title}</li>
              ))}
            </ul>
          )}
          <input placeholder="Title, e.g. Q3 launch email" value={sampleTitle} onChange={(e) => setSampleTitle(e.target.value)} />
          <textarea rows={6} placeholder="Paste the text..." value={sampleText} onChange={(e) => setSampleText(e.target.value)} />
          <button
            disabled={busy || !sampleTitle.trim() || !sampleText.trim()}
            onClick={() =>
              run(async () => {
                await window.twin.addSample(sampleTitle.trim(), sampleText.trim());
                setSampleTitle("");
                setSampleText("");
                setSamples(await window.twin.listSamples());
              })
            }
          >
            Add sample
          </button>
        </section>
      )}
      {error && <p className="error">{error}</p>}

      {initial && (
        <section className="danger">
          <h2>Delete account</h2>
          <p className="muted">Permanently deletes your twin, every task and file, and cancels billing.</p>
          <button className="danger-button" disabled={busy} onClick={deleteAccount}>
            Delete my account
          </button>
        </section>
      )}
    </div>
  );
}
