const cors = require("cors");

import 'dotenv/config';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import express from 'express';
import { closeDatabase, connectToDatabase, getDatabaseStatus } from './config/db.js';
import { errorHandler } from './middleware/errorHandler.js';
import healthRoutes from './routes/healthRoutes.js';
import authRoutes from './routes/authRoutes.js';
import equipmentRoutes from './routes/equipmentRoutes.js';
import bookingRoutes from './routes/bookingRoutes.js';
import paymentRoutes from './routes/paymentRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import favoriteRoutes from './routes/favoriteRoutes.js';
import reviewRoutes from './routes/reviewRoutes.js';
import contactRoutes from './routes/contactRoutes.js';
import ownerRoutes from './routes/ownerRoutes.js';
import { handleStripeWebhook } from './controllers/paymentController.js';
import { startBookingCompletionJob, stopBookingCompletionJob } from './jobs/bookingCompletionJob.js';
import { sendError, sendSuccess } from './utils/response.js';

const app = express();

app.use(cors({
  origin: ["https://easyrent-client.vercel.app", "http://localhost:3000"],
  credentials: true,
}));
app.disable('x-powered-by');
const port = Number.parseInt(process.env.PORT ?? '5000', 10);
const allowedOrigins = (process.env.CLIENT_URL ?? process.env.CORS_ORIGIN ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use((_request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'SAMEORIGIN');
  response.setHeader('X-XSS-Protection', '1; mode=block');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (process.env.NODE_ENV === 'production') {
    response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }

    callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
}));

app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false, limit: '10mb' }));
app.use(cookieParser());

app.get('/', (_request, response) => {
  sendSuccess(response, {
    message: 'Welcome to the Rentora API',
    data: { name: 'Rentora API', status: 'running' },
  });
});

app.use('/api/health', healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/equipment', equipmentRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/favorites', favoriteRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/owner', ownerRoutes);

app.use((_request, response) => {
  sendError(response, {
    statusCode: 404,
    message: 'Route not found',
  });
});

app.use(errorHandler);

let server;
let isShuttingDown = false;

function validateEnvironment() {
  const missing = [];
  if (!process.env.MONGODB_URI) missing.push('MONGODB_URI');
  if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
    missing.push('JWT_SECRET');
  }
  if (missing.length > 0) {
    console.error(`Fatal: Missing required environment variables: ${missing.join(', ')}`);
    return false;
  }
  return true;
}

async function startServer() {
  if (!validateEnvironment()) {
    process.exitCode = 1;
    return;
  }

  try {
    await connectToDatabase();
  } catch (error) {
    console.error('Unable to start EasyRent API: MongoDB connection failed.', error);
    process.exitCode = 1;
    return;
  }

  if (isShuttingDown) {
    await closeDatabase();
    return;
  }

  startBookingCompletionJob();
  server = app.listen(port, () => {
    console.info(`Rentora API listening on port ${port}.`);
  });
}

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.info(`${signal} received. Shutting down gracefully.`);
  stopBookingCompletionJob();

  try {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  } catch (error) {
    console.error('HTTP server shutdown failed:', error);
    process.exitCode = 1;
  }

  try {
    await closeDatabase();
    console.info('MongoDB connection closed.');
  } catch (error) {
    console.error('MongoDB shutdown failed:', error);
    process.exitCode = 1;
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

void startServer();

export { app, getDatabaseStatus };