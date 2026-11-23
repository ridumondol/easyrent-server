import mongoose from 'mongoose';

const bookingSchema = new mongoose.Schema({
  equipmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'RentoraEquipment', required: true },
  renterId: { type: mongoose.Schema.Types.ObjectId, ref: 'RentoraUser', required: true },
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'RentoraUser', required: true },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  quantity: { type: Number, required: true, min: 1 },
  pricePerDay: { type: Number, required: true, min: 0 },
  rentalType: { type: String, enum: ['daily', 'weekly', 'monthly'], default: 'daily' },
  rentalUnits: { type: Number, min: 1 },
  totalDays: { type: Number, required: true, min: 1 },
  totalAmount: { type: Number, required: true, min: 0 },
  phone: { type: String, required: true, maxlength: 50 },
  address: { type: String, required: true, maxlength: 500 },
  notes: { type: String, default: '', maxlength: 1000 },
  bookingStatus: { type: String, enum: ['pending', 'confirmed', 'cancelled', 'completed'], default: 'pending' },
  paymentStatus: { type: String, enum: ['unpaid', 'paid', 'refunded'], default: 'unpaid' },
  paymentTransactionId: { type: String },
  paidAt: { type: Date },
  refundedAt: { type: Date },
  cancellationReason: { type: String },
  refundStatus: { type: String, enum: ['pending', 'processing', 'failed', 'succeeded'] },
  completionEmailStatus: { type: String, enum: ['pending', 'sent', 'failed'] },
  completionEmailSentAt: { type: Date },
}, { collection: 'bookings', timestamps: true });

bookingSchema.index({ renterId: 1, createdAt: -1 });
bookingSchema.index({ ownerId: 1, createdAt: -1 });
bookingSchema.index({ equipmentId: 1, bookingStatus: 1, startDate: 1, endDate: 1 });

export const Booking = mongoose.models.RentoraBooking || mongoose.model('RentoraBooking', bookingSchema);
