// Starter legal pages. Have a lawyer review both before launch; the company
// name, address and contact email are placeholders.

const COMPANY = "Twinly, Inc.";
const CONTACT = "privacy@twinly.app";
const UPDATED = "2026-10-27";

const PAGES = {
  privacy: {
    title: "Privacy Policy",
    body: `
<p>Last updated ${UPDATED}. This policy explains what ${COMPANY} ("Twinly", "we") collects and how we use it.</p>
<h2>What we collect</h2>
<ul>
<li><b>Account data:</b> your email address and a salted hash of your password.</li>
<li><b>Twin data:</b> the profile, writing samples and preferences you give your twin, and preferences it learns from your corrections.</li>
<li><b>Task data:</b> the instructions you send, the work your twin produces, and files it creates.</li>
<li><b>Billing data:</b> handled by Stripe. We store your Stripe customer ID, never your card number.</li>
</ul>
<h2>How we use it</h2>
<p>Only to provide the service: to run your tasks, to make your twin sound like you, and to bill you. We do not sell or share your personal information for cross-context behavioral advertising, and we do not use your data to train AI models.</p>
<h2>Service providers</h2>
<p>Tasks run on Anthropic's Claude platform, which processes your instructions, twin data and files to perform the work. Payments are processed by Stripe. Each acts as our service provider under contract.</p>
<h2>Retention and deletion</h2>
<p>We keep your data while your account is open. Deleting your account (Settings &rarr; Delete account) permanently deletes your twin, your task history and cloud workspaces, and cancels your subscription.</p>
<h2>Your rights (including California residents)</h2>
<p>You may request access to, correction of, or deletion of your personal information, and you will not be discriminated against for exercising these rights. Email <a href="mailto:${CONTACT}">${CONTACT}</a>; we respond within 45 days.</p>
<h2>Contact</h2>
<p>${COMPANY}, <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>`,
  },
  terms: {
    title: "Terms of Service",
    body: `
<p>Last updated ${UPDATED}. By using Twinly you agree to these terms.</p>
<h2>The service</h2>
<p>Twinly gives you an AI "work twin" that drafts documents, analyses and other work in a cloud workspace. Output is AI-generated and can be wrong: review it before you rely on it or send it to anyone. You are responsible for what you send.</p>
<h2>Acceptable use</h2>
<p>Do not use Twinly to break the law, infringe others' rights, impersonate people without their consent, send spam, attack systems, or generate content that our model provider's usage policies prohibit. We may suspend accounts that do.</p>
<h2>Your content</h2>
<p>You own what you put in and what your twin produces for you. You grant us the limited rights needed to run the service.</p>
<h2>Plans and billing</h2>
<p>Paid plans renew monthly until cancelled; cancel anytime from Manage billing, effective at the end of the period. Each plan includes a monthly usage allowance; when it runs out, new tasks wait until the next month or an upgrade.</p>
<h2>Disclaimers and liability</h2>
<p>The service is provided "as is". To the extent the law allows, our total liability is limited to the amount you paid us in the 12 months before the claim.</p>
<h2>Contact</h2>
<p>${COMPANY}, <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>`,
  },
  "billing-done": {
    title: "You're all set",
    body: "<p>You can close this tab and go back to Twinly. Your plan updates within a few seconds.</p>",
  },
} as const;

export function legalPage(page: keyof typeof PAGES): string {
  const { title, body } = PAGES[page];
  return htmlPage(title, body);
}

/** Password reset form; posts the token and new password back to the API. */
export function resetPage(token: string): string {
  return htmlPage(
    "Choose a new password",
    `<form id="f"><p><input id="p" type="password" minlength="10" required placeholder="New password (10+ characters)" style="font:inherit;padding:8px;width:100%;max-width:360px"></p>
<p><button style="font:inherit;padding:8px 16px">Save password</button></p><p id="m"></p></form>
<script>
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const res = await fetch("/v1/auth/reset", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: ${JSON.stringify(token)}, password: document.getElementById("p").value }) });
  const data = await res.json().catch(() => ({}));
  document.getElementById("m").textContent = res.ok ? "Password updated. Go back to Twinly and sign in." : (data.error || "That link didn't work.");
  if (res.ok) document.getElementById("p").disabled = true;
});
</script>`,
  );
}

export function messagePage(title: string, message: string): string {
  return htmlPage(title, `<p>${message}</p>`);
}

function htmlPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} - Twinly</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:720px;margin:0 auto;padding:32px 16px;color:#1d1d1b;background:#fff}
@media (prefers-color-scheme:dark){body{color:#ececea;background:#161615}a{color:#8aa4ff}}h2{font-size:18px;margin-top:28px}</style>
</head><body><h1>${title}</h1>${body}</body></html>`;
}
