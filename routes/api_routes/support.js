import express from 'express';
import SupportTicket from '../../models/SupportTicket.js';
import mongoose from 'mongoose';
import { sendTicketReplyEmail, isBrevoConfigured, verifyBrevoApiKey } from '../../helpers/brevoEmail.js';
import {
  sendTicketReplyEmail as sendSmtpTicketEmail,
  isSmtpConfigured,
  verifySmtpConnection,
} from '../../helpers/smtpEmail.js';

const router = express.Router();

/** Only logged-in admin can send ticket replies (same session as dashboard). */
function requireAdminSession(req, res, next) {
  if (req.session?.isLoggedIn) return next();
  return res.status(401).json({ success: false, message: 'Unauthorized' });
}

router.post('/create', async (req, res) => {
  try {
    const { user, name, email, message } = req.body;

    if (!user || !name || !email || !message) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }

    const ticket = new SupportTicket({
      user,
      name,
      email,
      message
    });

    await ticket.save();

    res.status(201).json({ success: true, ticket });

    // Fire-and-forget auto-acknowledgment -- must never block or fail ticket
    // creation itself (the response above has already gone out). Silently
    // skipped if SMTP isn't configured.
    if (isSmtpConfigured()) {
      sendSmtpTicketEmail({
        toEmail: email,
        toName: name,
        subject: "We've received your message — BitPlayPro Support",
        message:
          "Thanks for contacting BitPlayPro support! We've received your message and " +
          "our team will review it and get back to you shortly.",
        ticketPreview: message,
      }).catch((err) => {
        console.error('Support ticket auto-ack email failed:', err.message || err);
      });
    }
  } catch (err) {
    console.error('Error creating support ticket:', err);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

router.delete('/:id/delete', requireAdminSession, async (req, res) => {
  try {
    const ticketsCollection = mongoose.connection.db.collection('supporttickets');
    const id = new mongoose.Types.ObjectId(req.params.id);
    await ticketsCollection.deleteOne({ _id: id });
    res.sendStatus(200);
  } catch (err) {
    console.error('Error deleting ticket:', err);
    res.sendStatus(500);
  }
});

/** Debug: verify SMTP connection/auth (must be registered before /:userId). */
router.get('/smtp-status', requireAdminSession, async (req, res) => {
  try {
    if (!isSmtpConfigured()) {
      return res.json({
        success: false,
        configured: false,
        message: 'Set SMTP_USER and SMTP_PASS, then restart.',
      });
    }
    const result = await verifySmtpConnection();
    return res.json({ success: result.ok, configured: true, ...result });
  } catch (err) {
    console.error('SMTP verify failed:', err);
    return res.status(500).json({ success: false, message: err.message || 'Verify failed' });
  }
});

/** Debug: verify Brevo API key (must be registered before /:userId). */
router.get('/brevo-status', requireAdminSession, async (req, res) => {
  try {
    if (!isBrevoConfigured()) {
      return res.json({
        success: false,
        configured: false,
        message: 'Set BREVO_API_KEY and BREVO_SENDER_EMAIL, then restart.',
      });
    }
    const result = await verifyBrevoApiKey();
    return res.json({ success: result.ok, configured: true, ...result });
  } catch (err) {
    console.error('Brevo verify failed:', err);
    return res.status(500).json({ success: false, message: err.message || 'Verify failed' });
  }
});

router.get('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const support_tickets = await SupportTicket.find({ user: userId }).sort({ date_created: -1 });

    res.status(200).json({
      success: true,
      count: support_tickets.length,
      support_tickets
    });
  } catch (err) {
    console.error('Error fetching user support_tickets:', err);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

router.post('/reply', requireAdminSession, async (req, res) => {
  const { email, message, name, ticketId } = req.body || {};

  if (!email || !message || !String(message).trim()) {
    return res.status(400).json({
      success: false,
      message: 'Email and message are required',
    });
  }

  if (!isBrevoConfigured()) {
    return res.status(503).json({
      success: false,
      message:
        'Email is not configured. Set BREVO_API_KEY and BREVO_SENDER_EMAIL in .env (Brevo Transactional API).',
    });
  }

  try {
    let ticketPreview = '';
    if (ticketId && mongoose.Types.ObjectId.isValid(String(ticketId))) {
      const ticket = await SupportTicket.findById(ticketId).select('message').lean();
      if (ticket?.message) ticketPreview = String(ticket.message).slice(0, 2000);
    }

    await sendTicketReplyEmail({
      toEmail: String(email).trim(),
      toName: name ? String(name).trim() : undefined,
      message: String(message).trim(),
      ticketPreview: ticketPreview || undefined,
    });

    return res.json({ success: true, message: 'Reply sent' });
  } catch (err) {
    console.error('Brevo ticket reply failed:', err.message || err);
    return res.status(500).json({
      success: false,
      message: err.message || 'Failed to send email',
    });
  }
});

export default router;