// Transactional email through Resend's HTTP API. Without RESEND_API_KEY the
// server runs in dev mode: nothing is sent and new accounts are auto-verified.

export interface Mailer {
  send(to: string, subject: string, html: string): Promise<void>;
}

export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(to: string, subject: string, html: string) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: this.from, to, subject, html }),
    });
    if (!res.ok) throw new Error(`Email send failed (${res.status}): ${await res.text()}`);
  }
}

const layout = (body: string) =>
  `<div style="font:16px/1.6 system-ui,sans-serif;max-width:520px">${body}<p style="color:#6b6b66;font-size:13px">If you didn't ask for this, you can ignore this email.</p></div>`;

export const emails = {
  verify: (link: string) => ({
    subject: "Confirm your email for Twinly",
    html: layout(`<p>Welcome to Twinly! Confirm your email to start giving your twin work:</p><p><a href="${link}">Confirm my email</a></p>`),
  }),
  reset: (link: string) => ({
    subject: "Reset your Twinly password",
    html: layout(`<p>Use this link within an hour to choose a new password:</p><p><a href="${link}">Reset my password</a></p>`),
  }),
};
