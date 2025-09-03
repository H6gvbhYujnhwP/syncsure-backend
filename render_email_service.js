import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

// --- Professional HTML Email Templates ---

const welcomeEmailTemplate = (customerName) => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Welcome to SyncSure</title>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
        .button { display: inline-block; background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; }
        .footer { text-align: center; margin-top: 30px; color: #666; font-size: 14px; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🛡️ Welcome to SyncSure!</h1>
        <p>Your OneDrive monitoring solution</p>
    </div>
    <div class="content">
        <h2>Hello ${customerName},</h2>
        <p>Thank you for joining SyncSure! We're excited to have you on board and help you monitor your OneDrive health across all your devices.</p>
        
        <h3>What's Next?</h3>
        <p>• Access your dashboard to manage licenses and monitor devices</p>
        <p>• Download the SyncSure agent for your devices</p>
        <p>• Set up real-time monitoring and alerts</p>
        
        <a href="https://syncsure.cloud/dashboard" class="button">Go to Dashboard</a>
        
        <p>If you have any questions, our support team is here to help at <a href="mailto:support@syncsure.cloud">support@syncsure.cloud</a>.</p>
        
        <p>Best regards,<br><strong>The SyncSure Team</strong></p>
    </div>
    <div class="footer">
        <p>© 2025 SyncSure. All rights reserved.</p>
    </div>
</body>
</html>
`;

const licenseDeliveryEmailTemplate = (customerName, licenseKey, maxDevices) => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Your SyncSure License Key</title>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
        .license-box { background: #e8f4fd; border: 2px solid #667eea; padding: 20px; margin: 20px 0; border-radius: 8px; text-align: center; }
        .license-key { font-family: 'Courier New', monospace; font-size: 18px; font-weight: bold; color: #667eea; letter-spacing: 2px; }
        .button { display: inline-block; background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; }
        .footer { text-align: center; margin-top: 30px; color: #666; font-size: 14px; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🔑 Your SyncSure License</h1>
        <p>Ready to protect your OneDrive</p>
    </div>
    <div class="content">
        <h2>Hello ${customerName},</h2>
        <p>Thank you for your purchase! Your SyncSure license is ready and waiting for you.</p>
        
        <div class="license-box">
            <h3>Your License Key</h3>
            <div class="license-key">${licenseKey}</div>
            <p><strong>Max Devices:</strong> ${maxDevices}</p>
        </div>
        
        <h3>Getting Started:</h3>
        <p>1. Download the SyncSure agent from your dashboard</p>
        <p>2. Install it on your devices</p>
        <p>3. Enter your license key when prompted</p>
        <p>4. Start monitoring your OneDrive health!</p>
        
        <a href="https://syncsure.cloud/dashboard" class="button">Download Agent</a>
        
        <p>Need help? Contact us at <a href="mailto:support@syncsure.cloud">support@syncsure.cloud</a></p>
        
        <p>Best regards,<br><strong>The SyncSure Team</strong></p>
    </div>
    <div class="footer">
        <p>© 2025 SyncSure. All rights reserved.</p>
    </div>
</body>
</html>
`;

const deviceAlertEmailTemplate = (customerName, deviceName, alertType, lastSeen) => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SyncSure Device Alert</title>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #ff6b6b 0%, #ee5a24 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
        .alert-box { background: #fff5f5; border: 2px solid #ff6b6b; padding: 20px; margin: 20px 0; border-radius: 8px; }
        .device-name { font-weight: bold; color: #ee5a24; }
        .button { display: inline-block; background: #ff6b6b; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; }
        .footer { text-align: center; margin-top: 30px; color: #666; font-size: 14px; }
    </style>
</head>
<body>
    <div class="header">
        <h1>⚠️ Device Alert</h1>
        <p>SyncSure Monitoring System</p>
    </div>
    <div class="content">
        <h2>Hello ${customerName},</h2>
        <p>We've detected an issue with one of your monitored devices that requires your attention.</p>
        
        <div class="alert-box">
            <h3>Alert Details</h3>
            <p><strong>Device:</strong> <span class="device-name">${deviceName}</span></p>
            <p><strong>Alert Type:</strong> ${alertType}</p>
            <p><strong>Last Seen:</strong> ${lastSeen}</p>
        </div>
        
        <h3>Recommended Actions:</h3>
        <p>• Check if the device is powered on and connected to the internet</p>
        <p>• Verify the SyncSure agent is running on the device</p>
        <p>• Restart the SyncSure agent if necessary</p>
        <p>• Check OneDrive sync status on the device</p>
        
        <a href="https://syncsure.cloud/dashboard" class="button">View Dashboard</a>
        
        <p>If the issue persists, please contact our support team at <a href="mailto:alerts@syncsure.cloud">alerts@syncsure.cloud</a></p>
        
        <p>Best regards,<br><strong>The SyncSure Monitoring Team</strong></p>
    </div>
    <div class="footer">
        <p>© 2025 SyncSure. All rights reserved.</p>
    </div>
</body>
</html>
`;

const supportEmailTemplate = (customerName, supportQuery, ticketId) => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SyncSure Support Inquiry Received</title>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #2ecc71 0%, #27ae60 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
        .query-box { background: #e8f8f5; border: 2px solid #2ecc71; padding: 20px; margin: 20px 0; border-radius: 8px; }
        .ticket-id { font-family: 'Courier New', monospace; font-weight: bold; color: #27ae60; }
        .footer { text-align: center; margin-top: 30px; color: #666; font-size: 14px; }
    </style>
</head>
<body>
    <div class="header">
        <h1>💬 Support Inquiry Received</h1>
        <p>We're here to help!</p>
    </div>
    <div class="content">
        <h2>Hello ${customerName},</h2>
        <p>Thank you for contacting SyncSure support. We have received your inquiry and our team will respond as soon as possible.</p>
        
        <div class="query-box">
            <h3>Your Support Request</h3>
            <p><strong>Ticket ID:</strong> <span class="ticket-id">${ticketId}</span></p>
            <p><strong>Your Message:</strong></p>
            <blockquote>${supportQuery}</blockquote>
        </div>
        
        <h3>What Happens Next?</h3>
        <p>• Our support team will review your request</p>
        <p>• You'll receive a detailed response within 24 hours</p>
        <p>• For urgent issues, we may contact you directly</p>
        
        <p>You can reply to this email to add more information to your support request.</p>
        
        <p>Best regards,<br><strong>The SyncSure Support Team</strong></p>
    </div>
    <div class="footer">
        <p>© 2025 SyncSure. All rights reserved.</p>
    </div>
</body>
</html>
`;

const billingEmailTemplate = (customerName, amount, invoiceId, nextBillingDate) => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SyncSure Payment Confirmation</title>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
        .billing-box { background: #e8f4fd; border: 2px solid #667eea; padding: 20px; margin: 20px 0; border-radius: 8px; }
        .amount { font-size: 24px; font-weight: bold; color: #667eea; }
        .button { display: inline-block; background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; }
        .footer { text-align: center; margin-top: 30px; color: #666; font-size: 14px; }
    </style>
</head>
<body>
    <div class="header">
        <h1>💳 Payment Confirmed</h1>
        <p>Thank you for your payment</p>
    </div>
    <div class="content">
        <h2>Hello ${customerName},</h2>
        <p>Your payment has been successfully processed. Thank you for continuing to use SyncSure!</p>
        
        <div class="billing-box">
            <h3>Payment Details</h3>
            <p><strong>Amount:</strong> <span class="amount">$${amount}</span></p>
            <p><strong>Invoice ID:</strong> ${invoiceId}</p>
            <p><strong>Next Billing Date:</strong> ${nextBillingDate}</p>
        </div>
        
        <p>Your SyncSure service will continue uninterrupted. You can view your billing history and manage your subscription from your dashboard.</p>
        
        <a href="https://syncsure.cloud/billing" class="button">View Billing</a>
        
        <p>Questions about your bill? Contact us at <a href="mailto:accounts@syncsure.cloud">accounts@syncsure.cloud</a></p>
        
        <p>Best regards,<br><strong>The SyncSure Team</strong></p>
    </div>
    <div class="footer">
        <p>© 2025 SyncSure. All rights reserved.</p>
    </div>
</body>
</html>
`;

// --- Email Sending Functions ---

export const sendWelcomeEmail = async (customerEmail, customerName) => {
  try {
    const { data, error } = await resend.emails.send({
      from: 'accounts@syncsure.cloud',
      to: customerEmail,
      subject: 'Welcome to SyncSure - Your OneDrive Monitoring Solution',
      html: welcomeEmailTemplate(customerName),
    });
    
    if (error) {
      console.error('Resend API error (welcome email):', error);
      return { success: false, error };
    }
    
    console.log(`✅ Welcome email sent to ${customerEmail} (ID: ${data.id})`);
    return { success: true, messageId: data.id };
  } catch (error) {
    console.error('Error sending welcome email:', error);
    return { success: false, error: error.message };
  }
};

export const sendLicenseDeliveryEmail = async (customerEmail, customerName, licenseKey, maxDevices = 1) => {
  try {
    const { data, error } = await resend.emails.send({
      from: 'accounts@syncsure.cloud',
      to: customerEmail,
      subject: 'Your SyncSure License Key - Ready to Download',
      html: licenseDeliveryEmailTemplate(customerName, licenseKey, maxDevices),
    });
    
    if (error) {
      console.error('Resend API error (license delivery):', error);
      return { success: false, error };
    }
    
    console.log(`✅ License delivery email sent to ${customerEmail} (ID: ${data.id})`);
    return { success: true, messageId: data.id };
  } catch (error) {
    console.error('Error sending license delivery email:', error);
    return { success: false, error: error.message };
  }
};

export const sendDeviceAlertEmail = async (customerEmail, customerName, deviceName, alertType = 'Device Offline', lastSeen = 'Unknown') => {
  try {
    const { data, error } = await resend.emails.send({
      from: 'alerts@syncsure.cloud',
      to: customerEmail,
      subject: `SyncSure Alert: ${alertType} - ${deviceName}`,
      html: deviceAlertEmailTemplate(customerName, deviceName, alertType, lastSeen),
    });
    
    if (error) {
      console.error('Resend API error (device alert):', error);
      return { success: false, error };
    }
    
    console.log(`✅ Device alert email sent to ${customerEmail} (ID: ${data.id})`);
    return { success: true, messageId: data.id };
  } catch (error) {
    console.error('Error sending device alert email:', error);
    return { success: false, error: error.message };
  }
};

export const sendSupportEmail = async (customerEmail, customerName, supportQuery) => {
  try {
    const ticketId = `SS-${Date.now()}-${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
    
    // Send confirmation to customer
    const { data: customerData, error: customerError } = await resend.emails.send({
      from: 'support@syncsure.cloud',
      to: customerEmail,
      subject: `Support Request Received - Ticket ${ticketId}`,
      html: supportEmailTemplate(customerName, supportQuery, ticketId),
    });
    
    if (customerError) {
      console.error('Resend API error (support confirmation):', customerError);
      return { success: false, error: customerError };
    }
    
    // Send notification to support team
    const { data: supportData, error: supportError } = await resend.emails.send({
      from: 'support@syncsure.cloud',
      to: 'support@syncsure.cloud',
      reply_to: customerEmail,
      subject: `New Support Request - ${ticketId} from ${customerName}`,
      html: `
        <h2>New Support Request</h2>
        <p><strong>From:</strong> ${customerName} (${customerEmail})</p>
        <p><strong>Ticket ID:</strong> ${ticketId}</p>
        <p><strong>Message:</strong></p>
        <blockquote>${supportQuery}</blockquote>
      `,
    });
    
    if (supportError) {
      console.error('Resend API error (support notification):', supportError);
    }
    
    console.log(`✅ Support emails sent for ${customerEmail} (Ticket: ${ticketId})`);
    return { success: true, ticketId, customerMessageId: customerData.id, supportMessageId: supportData?.id };
  } catch (error) {
    console.error('Error sending support email:', error);
    return { success: false, error: error.message };
  }
};

export const sendBillingEmail = async (customerEmail, customerName, amount, invoiceId, nextBillingDate) => {
  try {
    const { data, error } = await resend.emails.send({
      from: 'accounts@syncsure.cloud',
      to: customerEmail,
      subject: 'SyncSure Payment Confirmation - Thank You',
      html: billingEmailTemplate(customerName, amount, invoiceId, nextBillingDate),
    });
    
    if (error) {
      console.error('Resend API error (billing email):', error);
      return { success: false, error };
    }
    
    console.log(`✅ Billing email sent to ${customerEmail} (ID: ${data.id})`);
    return { success: true, messageId: data.id };
  } catch (error) {
    console.error('Error sending billing email:', error);
    return { success: false, error: error.message };
  }
};

// --- Utility Functions ---

export const testEmailService = async () => {
  try {
    const testResult = await sendWelcomeEmail('test@syncsure.cloud', 'Test User');
    return testResult;
  } catch (error) {
    console.error('Email service test failed:', error);
    return { success: false, error: error.message };
  }
};

// Export all functions for use in main application
export default {
  sendWelcomeEmail,
  sendLicenseDeliveryEmail,
  sendDeviceAlertEmail,
  sendSupportEmail,
  sendBillingEmail,
  testEmailService
};
