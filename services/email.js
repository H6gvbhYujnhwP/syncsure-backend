import fetch from "node-fetch";

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";

/**
 * Enhanced email service with multiple templates
 */

// Email templates
const templates = {
  welcome: {
    subject: "Welcome to SyncSure - Your License is Ready!",
    getHtml: ({ customerName, licenseKey, downloadUrl, maxDevices }) => `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Welcome to SyncSure</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #2563eb; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background: #f8fafc; padding: 30px; border-radius: 0 0 8px 8px; }
          .license-box { background: white; border: 2px solid #2563eb; padding: 20px; margin: 20px 0; border-radius: 8px; text-align: center; }
          .license-key { font-family: monospace; font-size: 18px; font-weight: bold; color: #2563eb; letter-spacing: 2px; }
          .download-btn { display: inline-block; background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 20px 0; }
          .footer { text-align: center; margin-top: 30px; color: #666; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>🎉 Welcome to SyncSure!</h1>
          <p>Your OneDrive monitoring solution is ready</p>
        </div>
        <div class="content">
          <p>Hi ${customerName || 'there'},</p>
          
          <p>Thank you for choosing SyncSure! Your payment has been processed successfully and your custom monitoring agent is ready for download.</p>
          
          <div class="license-box">
            <h3>Your License Key</h3>
            <div class="license-key">${licenseKey}</div>
            <p><strong>Max Devices:</strong> ${maxDevices}</p>
          </div>
          
          <p><strong>What's Next?</strong></p>
          <ol>
            <li>Download your custom SyncSure agent using the button below</li>
            <li>Install it on your devices (supports up to ${maxDevices} devices)</li>
            <li>Monitor your OneDrive sync status in real-time</li>
          </ol>
          
          <div style="text-align: center;">
            <a href="${downloadUrl}" class="download-btn">Download SyncSure Agent</a>
          </div>
          
          <p><strong>Need Help?</strong></p>
          <ul>
            <li>📖 <a href="https://docs.syncsure.cloud/setup">Setup Guide</a></li>
            <li>💬 <a href="https://syncsure.cloud/support">Contact Support</a></li>
            <li>📊 <a href="https://syncsure.cloud/dashboard">Dashboard</a></li>
          </ul>
          
          <p>Welcome to the SyncSure family!</p>
          
          <p>Best regards,<br/>
          The SyncSure Team</p>
        </div>
        <div class="footer">
          <p>SyncSure - Professional OneDrive Monitoring for MSPs</p>
          <p>If you have any questions, reply to this email or visit our support center.</p>
        </div>
      </body>
      </html>
    `
  },

  buildComplete: {
    subject: "Your SyncSure Agent is Ready for Download",
    getHtml: ({ customerName, licenseKey, downloadUrl, buildTag }) => `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>SyncSure Agent Ready</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #059669; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background: #f0fdf4; padding: 30px; border-radius: 0 0 8px 8px; }
          .download-btn { display: inline-block; background: #059669; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 20px 0; }
          .footer { text-align: center; margin-top: 30px; color: #666; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>✅ Your Agent is Ready!</h1>
          <p>Build ${buildTag} completed successfully</p>
        </div>
        <div class="content">
          <p>Hi ${customerName || 'there'},</p>
          
          <p>Great news! Your custom SyncSure monitoring agent has been built and is ready for download.</p>
          
          <p><strong>License:</strong> ${licenseKey}<br/>
          <strong>Build:</strong> ${buildTag}</p>
          
          <div style="text-align: center;">
            <a href="${downloadUrl}" class="download-btn">Download Your Agent</a>
          </div>
          
          <p>This agent is pre-configured with your license key and ready to deploy across your devices.</p>
          
          <p>Best regards,<br/>
          The SyncSure Team</p>
        </div>
        <div class="footer">
          <p>SyncSure - Professional OneDrive Monitoring for MSPs</p>
        </div>
      </body>
      </html>
    `
  },

  paymentConfirmation: {
    subject: "Payment Confirmation - SyncSure Subscription",
    getHtml: ({ customerName, amount, invoiceId, nextBilling }) => `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Payment Confirmation</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #2563eb; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background: #f8fafc; padding: 30px; border-radius: 0 0 8px 8px; }
          .receipt-box { background: white; border: 1px solid #e5e7eb; padding: 20px; margin: 20px 0; border-radius: 8px; }
          .footer { text-align: center; margin-top: 30px; color: #666; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>💳 Payment Confirmed</h1>
          <p>Thank you for your payment</p>
        </div>
        <div class="content">
          <p>Hi ${customerName || 'there'},</p>
          
          <p>We've successfully processed your payment for SyncSure monitoring services.</p>
          
          <div class="receipt-box">
            <h3>Payment Details</h3>
            <p><strong>Amount:</strong> £${amount}</p>
            <p><strong>Invoice ID:</strong> ${invoiceId}</p>
            <p><strong>Next Billing:</strong> ${nextBilling}</p>
            <p><strong>Service:</strong> SyncSure OneDrive Monitoring</p>
          </div>
          
          <p>Your subscription is now active and your monitoring services will continue uninterrupted.</p>
          
          <p>Best regards,<br/>
          The SyncSure Team</p>
        </div>
        <div class="footer">
          <p>SyncSure - Professional OneDrive Monitoring for MSPs</p>
        </div>
      </body>
      </html>
    `
  }
};

/**
 * Send welcome email with license information
 */
export async function sendWelcomeEmail({ to, customerName, licenseKey, downloadUrl, maxDevices }) {
  return await sendEmail({
    to,
    template: 'welcome',
    data: { customerName, licenseKey, downloadUrl, maxDevices }
  });
}

/**
 * Send build completion notification
 */
export async function sendBuildCompleteEmail({ to, customerName, licenseKey, downloadUrl, buildTag }) {
  return await sendEmail({
    to,
    template: 'buildComplete',
    data: { customerName, licenseKey, downloadUrl, buildTag }
  });
}

/**
 * Send payment confirmation email
 */
export async function sendPaymentConfirmationEmail({ to, customerName, amount, invoiceId, nextBilling }) {
  return await sendEmail({
    to,
    template: 'paymentConfirmation',
    data: { customerName, amount, invoiceId, nextBilling }
  });
}

/**
 * Generic email sending function
 */
async function sendEmail({ to, template, data }) {
  if (!RESEND_API_KEY) {
    console.log("[email] RESEND_API_KEY not set — skipping send");
    return { skipped: true };
  }

  const emailTemplate = templates[template];
  if (!emailTemplate) {
    throw new Error(`Unknown email template: ${template}`);
  }

  const body = {
    from: "SyncSure <noreply@syncsure.cloud>",
    to: [to],
    subject: emailTemplate.subject,
    html: emailTemplate.getHtml(data)
  };

  try {
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

    const result = await res.json();
    console.log(`[email] Sent ${template} email to ${to}:`, result.id);
    return result;
  } catch (error) {
    console.error(`[email] Failed to send ${template} email to ${to}:`, error.message);
    throw error;
  }
}

/**
 * Legacy function for backward compatibility
 */
export async function sendLicenseEmail({ to, licenseKey, downloadUrl }) {
  return await sendWelcomeEmail({ 
    to, 
    licenseKey, 
    downloadUrl, 
    maxDevices: 'Unlimited',
    customerName: null 
  });
}

