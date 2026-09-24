import express from 'express';
import FAQ from '../../models/FAQs.js';
import { requireAdminAuth } from "../../middleware/requireAdminAuth.js";

const router = express.Router();

// GET: Fetch all FAQs
router.get('/', async (req, res) => {
  try {
    const faqs = await FAQ.find().sort({ date_created: -1 });
    res.status(200).json({ success: true, faqs });
  } catch (err) {
    console.error('Error fetching FAQs:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// POST: Create a new FAQ (admin)
router.post('/create', requireAdminAuth, async (req, res) => {
  try {
    const { name, message } = req.body;
    const faq = new FAQ({ name, message });
    await faq.save();
    res.redirect('/admin/faqs');
  } catch (err) {
    console.error('Error creating FAQ:', err);
    res.status(500).send('Internal Server Error');
  }
});

// DELETE: Delete a FAQ by ID
router.delete('/:id', requireAdminAuth, async (req, res) => {
  try {
    await FAQ.findByIdAndDelete(req.params.id);
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Delete FAQ failed:', err);
    res.status(500).json({ error: 'Delete failed' });
  }
});

export default router;
