// Standalone SMTP connectivity check -- reads from .env (SMTP_USER/SMTP_PASS,
// same vars as helpers/smtpEmail.js) rather than hardcoded credentials.
// Usage: node helpers/test-smtp.js <recipient-email>
import "dotenv/config";
import { verifySmtpConnection, sendTicketReplyEmail } from "./smtpEmail.js";

async function main() {
  const recipient = process.argv[2];

  console.log("Verifying SMTP connection...");
  const verify = await verifySmtpConnection();
  if (!verify.ok) {
    console.error("SMTP connection failed:", verify.message);
    process.exit(1);
  }
  console.log(`SMTP connection successful! Sending as ${verify.user}`);

  if (!recipient) {
    console.log("No recipient given -- skipping send test. Usage: node helpers/test-smtp.js you@example.com");
    return;
  }

  console.log(`Sending test email to ${recipient}...`);
  const info = await sendTicketReplyEmail({
    toEmail: recipient,
    subject: "SMTP Test",
    message: "This is a test email to verify SMTP settings.",
  });
  console.log("Test email sent! Message ID:", info.messageId);
}

main().catch((err) => {
  console.error("SMTP test failed:", err);
  process.exit(1);
});
