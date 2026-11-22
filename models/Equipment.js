import mongoose from 'mongoose';

const equipmentSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, minlength: 3, maxlength: 150 },
  description: { type: String, required: true, trim: true, maxlength: 5000 },
  category: { type: String, required: true, trim: true, lowercase: true },
  pricePerDay: { type: Number, required: true, min: 0.01 },
  rentalType: { type: String, enum: ['daily', 'weekly', 'monthly'], default: 'daily' },
  location: { type: String, required: true, trim: true, maxlength: 200 },
  image: { type: String, required: true, trim: true },
  quantity: { type: Number, required: true, min: 1, default: 1 },
  condition: { type: String, enum: ['new', 'like-new', 'good', 'fair', 'worn'], default: 'good' },
  brand: { type: String, default: '', trim: true, maxlength: 100 },
  model: { type: String, default: '', trim: true, maxlength: 100 },
  rentalTerms: { type: String, default: '', trim: true, maxlength: 3000 },
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'RentoraUser', required: true },
  availability: { type: Boolean, default: true },
  approvalStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
}, { collection: 'equipment', timestamps: true });

equipmentSchema.index({ approvalStatus: 1, createdAt: -1 });
equipmentSchema.index({ ownerId: 1, createdAt: -1 });
equipmentSchema.index({ category: 1, rentalType: 1, pricePerDay: 1, availability: 1 });
equipmentSchema.index({ title: 'text', location: 'text' });

export const Equipment = mongoose.models.RentoraEquipment || mongoose.model('RentoraEquipment', equipmentSchema);
