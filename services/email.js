import fetch from "node-fetch";

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";

/**
 * Sends a plain license email. Swap with your template when ready.
 */
export async function sendLicenseEmail({ to, licenseKey, downloadUrl }) {
  if (!RESEND_API_KEY) {
    console.log("[email] RESEND_API_KEY not set — skipping send");
    return { skipped: true };
  }
  const body = {
    from: "SyncSure <noreply@syncsure.cloud>",
    to: [to],
    subject: "Your SyncSure License & Download",
    html: `
      <p>Hi,</p>
      <p>Your license key: <strong>${licenseKey}</strong></p>
      <p>Download your agent here: <a href="${downloadUrl}">${downloadUrl}</a></p>
      <p>Thanks,<br/>SyncSure</p>
    `
  };

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Resend error: ${res.status} ${txt}`);
  }
  return res.json();
}

