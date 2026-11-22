import mongoose from 'mongoose';

const favoriteSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'RentoraUser', required: true },
  equipmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'RentoraEquipment', required: true },
}, { collection: 'favorites', timestamps: true });

favoriteSchema.index({ userId: 1, equipmentId: 1 }, { unique: true });
favoriteSchema.index({ userId: 1, createdAt: -1 });

export const Favorite = mongoose.models.RentoraFavorite || mongoose.model('RentoraFavorite', favoriteSchema);
