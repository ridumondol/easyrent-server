import mongoose from 'mongoose';

const paymentSchema = new mongoose.Schema({
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'RentoraBooking', required: true },
  renterId: { type: mongoose.Schema.Types.ObjectId, ref: 'RentoraUser', required: true },
  transactionId: { type: String, required: true, unique: true },
  stripeCheckoutSessionId: { type: String, unique: true, sparse: true },
  stripePaymentIntentId: { type: String, default: '' },
  checkoutReservation: { type: Boolean, default: false },
  productName: { type: String },
  sessionExpiresAt: { type: Date },
  amount: { type: Number, required: true, min: 0 },
  currency: { type: String, default: 'bdt', lowercase: true },
  status: { type: String, enum: ['pending', 'success', 'failed', 'refunded'], default: 'pending' },
}, { collection: 'payments', timestamps: true });

paymentSchema.index({ renterId: 1, createdAt: -1 });
paymentSchema.index({ bookingId: 1 }, {
  unique: true,
  partialFilterExpression: { status: 'success' },
});

export const Payment = mongoose.models.RentoraPayment || mongoose.model('RentoraPayment', paymentSchema);
