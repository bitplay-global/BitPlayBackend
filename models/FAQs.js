// models/FAQs.js
import mongoose from 'mongoose';

const FaqSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true
  },
  message: {
    type: String,
    required: true
  },
  date_created: {
    type: Date,
    default: Date.now
  }
});

const FAQ = mongoose.models.FAQ || mongoose.model('FAQ', FaqSchema);
export default FAQ;
