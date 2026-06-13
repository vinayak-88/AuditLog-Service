import logger from '../config/logger';

interface AlertPayload {
  subject: string;
  htmlContent: string;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function sendAlert(payload: AlertPayload): Promise<void> {
  const BREVO_API_KEY = process.env.BREVO_API_KEY;
  const ALERT_FROM = process.env.ALERT_EMAIL_FROM;
  const ALERT_TO = process.env.ALERT_EMAIL_TO;

  if (!BREVO_API_KEY || !ALERT_FROM || !ALERT_TO) {
    logger.debug({ message: 'Alert skipped because Brevo env vars are not configured', subject: payload.subject });
    return;
  }

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sender: { email: ALERT_FROM, name: 'Audit Log Service' },
        to: [{ email: ALERT_TO }],
        subject: payload.subject,
        htmlContent: payload.htmlContent
      })
    });

    if (!response.ok) {
      logger.error({ message: 'Brevo alert failed', status: response.status });
    }
  } catch (err) {
    logger.error({ message: 'Alert service error', error: err });
  }
}

export async function sendTamperAlert(appId: string, appName: string, sequenceNumber: number): Promise<void> {
  const safeAppName = escapeHtml(appName);
  const safeAppId = escapeHtml(appId);

  await sendAlert({
    subject: `[CRITICAL] Chain tampering detected - ${appName}`,
    htmlContent: `
      <h2>Chain Integrity Violation Detected</h2>
      <p>A chain verification check for app <strong>${safeAppName}</strong> (${safeAppId}) has failed.</p>
      <p>Tampering detected at sequence number: <strong>${sequenceNumber}</strong></p>
      <p>All entries from this sequence number onward have invalid hashes.</p>
    `
  });
}

export async function sendAnomalyAlert(appId: string, appName: string, anomaly: string): Promise<void> {
  const safeAppName = escapeHtml(appName);
  const safeAppId = escapeHtml(appId);
  const safeAnomaly = escapeHtml(anomaly);

  await sendAlert({
    subject: `[WARNING] Anomaly detected - ${appName}`,
    htmlContent: `
      <h2>Unusual Activity Detected</h2>
      <p>App: <strong>${safeAppName}</strong> (${safeAppId})</p>
      <p>Anomaly: ${safeAnomaly}</p>
    `
  });
}
