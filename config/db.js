import mongoose from 'mongoose';
import { User } from '../models/User.js';
import { Equipment } from '../models/Equipment.js';
import { Booking } from '../models/Booking.js';
import { Payment } from '../models/Payment.js';
import { Favorite } from '../models/Favorite.js';
import { Review } from '../models/Review.js';
import { ContactMessage } from '../models/ContactMessage.js';

const indexedModels = [User, Equipment, Booking, Payment, Favorite, Review, ContactMessage];

export async function ensureIndexes() {
  await Promise.all(indexedModels.map((model) => model.createIndexes()));
}

export async function connectToDatabase() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is required to connect to MongoDB.');
  }

  try {
    await mongoose.connect(uri, {
      dbName: process.env.MONGODB_DB_NAME || 'rentora',
      serverSelectionTimeoutMS: 5000,
      maxPoolSize: 50,
      minPoolSize: 5,
    });

    await mongoose.connection.db.command({ ping: 1 });
    await ensureIndexes();
    console.info('MongoDB connected successfully through Mongoose.');
    return mongoose.connection.db;
  } catch (error) {
    await mongoose.disconnect();
    throw error;
  }
}

export function getDatabaseStatus() {
  if (mongoose.connection.readyState === 1) return 'connected';
  return process.env.MONGODB_URI ? 'disconnected' : 'not_configured';
}

export function getDB() {
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
    throw new Error('Database is not connected.');
  }
  return mongoose.connection.db;
}

export async function closeDatabase() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}
