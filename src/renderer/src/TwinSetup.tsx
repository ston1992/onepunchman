import { useEffect, useState } from "react";
import type { TwinProfile, WritingSample } from "@shared/types";

const EMPTY: TwinProfile = { name: "", role: "", company: "", voice: "", preferences: "" };

export function TwinSetup({ initial, onSaved }: { initial: TwinProfile | null; onSaved: (p: TwinProfile) => void }) {
  const [profile, setProfile] = useState<TwinProfile>(initial ?? EMPTY);
  const [samples, setSamples] = useState<WritingSample[]>([]);
  const [sampleTitle, setSampleTitle] = useState("");
  const [sampleText, setSampleText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    window.twin.listSamples().then(setSamples, () => {});
  }, []);

  const field = (key: keyof TwinProfile) => ({
    value: profile[key],
    onChange: (e: { target: { value: string } }) => setProfile({ ...profile, [key]: e.target.value }),
  });

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="twin-setup">
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
        onClick={() => run(async () => {
          await window.twin.saveProfile(profile);
          onSaved(profile);
        })}
      >
        {initial ? "Save profile" : "Create my twin"}
      </button>

      {initial && (
        <section className="samples">
          <h2>Writing samples</h2>
          <p className="muted">Paste emails, docs or posts you wrote. Three to five good ones teach your voice best.</p>
          <ul>
            {samples.map((s) => (
              <li key={s.path}>{s.title}</li>
            ))}
          </ul>
          <input placeholder="Title, e.g. Q3 launch email" value={sampleTitle} onChange={(e) => setSampleTitle(e.target.value)} />
          <textarea rows={6} placeholder="Paste the text..." value={sampleText} onChange={(e) => setSampleText(e.target.value)} />
          <button
            disabled={busy || !sampleTitle.trim() || !sampleText.trim()}
            onClick={() => run(async () => {
              await window.twin.addSample(sampleTitle.trim(), sampleText.trim());
              setSampleTitle("");
              setSampleText("");
              setSamples(await window.twin.listSamples());
            })}
          >
            Add sample
          </button>
        </section>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
