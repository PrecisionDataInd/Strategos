const nodemailer = require('nodemailer');
const cron = require('node-cron');
const { getPortfolioSummary } = require('./portfolio');
const { getCachedPrice } = require('./price-feed');

function createTransporter() {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
}

function generateReportHTML({ portfolio, price, agentBalance, vaultBalance, sessionPnl }) {
  const solPrice = price.usd || 0;
  const change24h = price.change24h || 0;
  const changeColor = change24h >= 0 ? '#6fd491' : '#e06060';
  const pnlColor = sessionPnl >= 0 ? '#6fd491' : '#e06060';
  const agentUsd = (agentBalance * solPrice).toFixed(2);
  const vaultUsd = (vaultBalance * solPrice).toFixed(2);
  const totalUsd = ((agentBalance + vaultBalance) * solPrice).toFixed(2);

  const positionRows = portfolio.positions.map(pos => `
    <tr style="border-bottom: 1px solid #2a2a32;">
      <td style="padding: 10px 12px; color: #c9a84c; font-family: monospace;">${pos.strategyName}</td>
      <td style="padding: 10px 12px; color: #e8ddd0; font-family: monospace;">\u25CE ${pos.currentValueSol.toFixed(4)}</td>
      <td style="padding: 10px 12px; color: #e8ddd0; font-family: monospace;">$${pos.currentValueUsd.toFixed(2)}</td>
      <td style="padding: 10px 12px; color: ${pos.unrealizedSol >= 0 ? '#6fd491' : '#e06060'}; font-family: monospace;">
        ${pos.unrealizedSol >= 0 ? '+' : ''}\u25CE ${pos.unrealizedSol.toFixed(6)}
      </td>
      <td style="padding: 10px 12px; color: #9a8878; font-family: monospace;">${pos.apy}</td>
      <td style="padding: 10px 12px; color: #9a8878; font-family: monospace;">${pos.daysOpen}d</td>
    </tr>
  `).join('');

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>STRATEGOS Daily Report</title></head>
<body style="background: #0d0608; color: #e8ddd0; font-family: Georgia, serif; margin: 0; padding: 20px;">
  <div style="max-width: 700px; margin: 0 auto;">

    <!-- Header -->
    <div style="border-bottom: 1px solid #3d2718; padding-bottom: 20px; margin-bottom: 24px;">
      <h1 style="font-family: Georgia, serif; color: #d4956a; font-size: 22px; letter-spacing: 0.15em; margin: 0;">
        STRATEGOS
      </h1>
      <p style="color: #8a7868; font-size: 12px; margin: 4px 0 0; letter-spacing: 0.1em; font-family: monospace;">
        AUTONOMOUS FIELD AGENT \u2014 DAILY INTELLIGENCE BRIEFING
      </p>
      <p style="color: #5a4e44; font-size: 11px; margin: 8px 0 0; font-family: monospace;">
        ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })} \u00B7 06:00 LOCAL
      </p>
    </div>

    <!-- SOL Price -->
    <div style="background: #1c1c21; border: 1px solid #2a2a32; border-radius: 6px; padding: 16px 20px; margin-bottom: 16px;">
      <p style="color: #5a4e44; font-size: 10px; letter-spacing: 0.15em; margin: 0 0 6px; font-family: monospace;">SOL MARKET PRICE</p>
      <div style="display: flex; align-items: baseline; gap: 12px;">
        <span style="font-size: 28px; color: #00d4ff; font-family: monospace;">$${solPrice.toFixed(2)}</span>
        <span style="font-size: 13px; color: ${changeColor}; font-family: monospace;">
          ${change24h >= 0 ? '+' : ''}${change24h.toFixed(2)}% 24h
        </span>
      </div>
    </div>

    <!-- Wallet Summary -->
    <div style="display: flex; gap: 12px; margin-bottom: 16px;">
      <div style="flex: 1; background: #1c1c21; border: 1px solid #2a2a32; border-radius: 6px; padding: 16px 20px;">
        <p style="color: #5a4e44; font-size: 10px; letter-spacing: 0.15em; margin: 0 0 6px; font-family: monospace;">AGENT WALLET</p>
        <p style="font-size: 22px; color: #d4956a; font-family: monospace; margin: 0;">\u25CE ${agentBalance.toFixed(4)}</p>
        <p style="font-size: 13px; color: #8a7868; font-family: monospace; margin: 4px 0 0;">$${agentUsd}</p>
      </div>
      <div style="flex: 1; background: #1c1c21; border: 1px solid #2a2a32; border-radius: 6px; padding: 16px 20px;">
        <p style="color: #5a4e44; font-size: 10px; letter-spacing: 0.15em; margin: 0 0 6px; font-family: monospace;">VAULT (COLD STORAGE)</p>
        <p style="font-size: 22px; color: #6fd491; font-family: monospace; margin: 0;">\u25CE ${vaultBalance.toFixed(4)}</p>
        <p style="font-size: 13px; color: #8a7868; font-family: monospace; margin: 4px 0 0;">$${vaultUsd}</p>
      </div>
      <div style="flex: 1; background: #1c1c21; border: 1px solid #2a2a32; border-radius: 6px; padding: 16px 20px;">
        <p style="color: #5a4e44; font-size: 10px; letter-spacing: 0.15em; margin: 0 0 6px; font-family: monospace;">TOTAL PORTFOLIO</p>
        <p style="font-size: 22px; color: #e8ddd0; font-family: monospace; margin: 0;">$${totalUsd}</p>
        <p style="font-size: 13px; color: ${pnlColor}; font-family: monospace; margin: 4px 0 0;">
          Session P&amp;L: ${sessionPnl >= 0 ? '+' : ''}\u25CE ${sessionPnl.toFixed(4)}
        </p>
      </div>
    </div>

    <!-- Open Positions -->
    <div style="background: #1c1c21; border: 1px solid #2a2a32; border-radius: 6px; margin-bottom: 16px; overflow: hidden;">
      <div style="padding: 12px 20px; border-bottom: 1px solid #2a2a32;">
        <p style="color: #d4956a; font-size: 11px; letter-spacing: 0.15em; margin: 0; font-family: monospace;">OPEN POSITIONS</p>
      </div>
      <table style="width: 100%; border-collapse: collapse;">
        <thead>
          <tr style="border-bottom: 1px solid #2a2a32;">
            <th style="padding: 8px 12px; text-align: left; color: #5a4e44; font-size: 10px; font-family: monospace; font-weight: normal; letter-spacing: 0.1em;">STRATEGY</th>
            <th style="padding: 8px 12px; text-align: left; color: #5a4e44; font-size: 10px; font-family: monospace; font-weight: normal; letter-spacing: 0.1em;">VALUE (SOL)</th>
            <th style="padding: 8px 12px; text-align: left; color: #5a4e44; font-size: 10px; font-family: monospace; font-weight: normal; letter-spacing: 0.1em;">VALUE (USD)</th>
            <th style="padding: 8px 12px; text-align: left; color: #5a4e44; font-size: 10px; font-family: monospace; font-weight: normal; letter-spacing: 0.1em;">UNREALIZED</th>
            <th style="padding: 8px 12px; text-align: left; color: #5a4e44; font-size: 10px; font-family: monospace; font-weight: normal; letter-spacing: 0.1em;">APY</th>
            <th style="padding: 8px 12px; text-align: left; color: #5a4e44; font-size: 10px; font-family: monospace; font-weight: normal; letter-spacing: 0.1em;">AGE</th>
          </tr>
        </thead>
        <tbody>${positionRows || '<tr><td colspan="6" style="padding: 16px; color: #5a4e44; font-family: monospace; text-align: center;">No open positions</td></tr>'}</tbody>
      </table>
    </div>

    <!-- Footer -->
    <div style="border-top: 1px solid #3d2718; padding-top: 16px; margin-top: 8px;">
      <p style="color: #5a4e44; font-size: 10px; font-family: monospace; margin: 0; letter-spacing: 0.08em;">
        STRATEGOS AUTONOMOUS FIELD AGENT \u00B7 NEXT REPORT IN 24 HOURS \u00B7 DO NOT REPLY TO THIS EMAIL
      </p>
    </div>

  </div>
</body>
</html>`;
}

async function sendDailyReport({ agentBalance, vaultBalance, sessionPnl, log }) {
  const transporter = createTransporter();
  if (!transporter) {
    if (log) log('WARN', 'REPORTER: Gmail not configured \u2014 skipping report', {});
    return { sent: false, reason: 'NOT_CONFIGURED' };
  }

  const portfolio = getPortfolioSummary();
  const price = getCachedPrice();

  const html = generateReportHTML({ portfolio, price, agentBalance, vaultBalance, sessionPnl });
  const solPrice = price.usd || 0;
  const totalUsd = ((agentBalance + vaultBalance) * solPrice).toFixed(2);

  try {
    await transporter.sendMail({
      from: `"STRATEGOS Agent" <${process.env.GMAIL_USER}>`,
      to: process.env.REPORT_RECIPIENT || process.env.GMAIL_USER,
      subject: `STRATEGOS Daily Brief \u2014 $${totalUsd} Portfolio \u00B7 ${new Date().toLocaleDateString()}`,
      html,
    });
    if (log) log('INFO', `REPORTER: Daily report sent to ${process.env.REPORT_RECIPIENT || process.env.GMAIL_USER}`, {});
    return { sent: true };
  } catch (err) {
    if (log) log('ERROR', `REPORTER: Failed to send report \u2014 ${err.message}`, { error: err.message });
    return { sent: false, error: err.message };
  }
}

function startReportScheduler({ getBalances, getSessionPnl, log }) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    if (log) log('WARN', 'REPORTER: Gmail credentials not configured \u2014 daily reports disabled', {});
    return;
  }

  // Schedule at 6:00 AM every day
  cron.schedule('0 6 * * *', async () => {
    log('INFO', 'REPORTER: Sending scheduled 6AM daily report', {});
    const { agent, vault } = getBalances();
    const sessionPnl = getSessionPnl();
    await sendDailyReport({ agentBalance: agent, vaultBalance: vault, sessionPnl, log });
  });

  log('INFO', 'REPORTER: Daily report scheduled for 06:00', {});
}

module.exports = { sendDailyReport, startReportScheduler, generateReportHTML };
