import mongoose from 'mongoose';

const reviewSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'RentoraUser', required: true },
  equipmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'RentoraEquipment', required: true },
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'RentoraBooking' },
  rating: { type: Number, required: true, min: 1, max: 5 },
  comment: { type: String, required: true, trim: true, minlength: 3, maxlength: 1500 },
}, { collection: 'reviews', timestamps: true });

reviewSchema.index({ equipmentId: 1, createdAt: -1 });
reviewSchema.index({ userId: 1, equipmentId: 1 }, { unique: true });

export const Review = mongoose.models.RentoraReview || mongoose.model('RentoraReview', reviewSchema);
