import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
  email: { type: String, required: true, trim: true, lowercase: true },
  passwordHash: { type: String, select: false },
  passwordResetTokenHash: { type: String, select: false },
  passwordResetExpiresAt: { type: Date, select: false },
  passwordResetRequestedAt: { type: Date, select: false },
  tokenVersion: { type: Number, default: 0, min: 0, select: false },
  role: { type: String, enum: ['customer', 'renter', 'owner', 'admin'], default: 'renter' },
  image: { type: String, default: '' },
  phone: { type: String, default: '' },
  address: { type: String, default: '' },
  authProvider: { type: String, enum: ['email', 'google', 'github'], default: 'email' },
  status: { type: String, enum: ['active', 'suspended', 'deactivated'], default: 'active' },
  googleId: { type: String },
  githubId: { type: String },
  emailVerified: { type: Boolean, default: false },
}, {
  collection: 'users',
  timestamps: true,
  strict: false,
});

userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ googleId: 1 }, { sparse: true });
userSchema.index({ githubId: 1 }, { sparse: true });
userSchema.index({ passwordResetTokenHash: 1 }, { sparse: true });

export const User = mongoose.models.RentoraUser || mongoose.model('RentoraUser', userSchema);
