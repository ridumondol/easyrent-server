import mongoose from 'mongoose';

const contactMessageSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
  subject: { type: String, required: true, trim: true, maxlength: 120 },
  message: { type: String, required: true, trim: true, maxlength: 3000 },
  status: { type: String, enum: ['new', 'handled'], default: 'new' },
}, { collection: 'contactMessages', timestamps: true });

contactMessageSchema.index({ status: 1, createdAt: -1 });

export const ContactMessage = mongoose.models.RentoraContactMessage || mongoose.model('RentoraContactMessage', contactMessageSchema);
