import cron from 'node-cron';
import { getDB } from '../config/db.js';
import { sendBookingCompletedEmails } from '../services/emailService.js';

let scheduledTask;

export async function runBookingCompletionJob(now = new Date()) {
  const bookings = getDB().collection('bookings');
  const completed = await bookings.find({
    bookingStatus: 'confirmed',
    paymentStatus: 'paid',
    endDate: { $lte: now },
  }).toArray();

  for (const booking of completed) {
    const update = await bookings.updateOne(
      { _id: booking._id, bookingStatus: 'confirmed', endDate: { $lte: now } },
      {
        $set: {
          bookingStatus: 'completed',
          completionEmailStatus: 'pending',
          updatedAt: now,
        },
      },
    );
    if (update.modifiedCount === 1) booking.bookingStatus = 'completed';
  }

  const notifications = await bookings.find({
    bookingStatus: 'completed',
    endDate: { $lte: now },
    completionEmailStatus: { $in: ['pending', 'failed'] },
  }).toArray();

  for (const booking of notifications) {
    try {
      await sendBookingCompletedEmails(booking);
      await bookings.updateOne(
        { _id: booking._id, bookingStatus: 'completed', completionEmailStatus: { $in: ['pending', 'failed'] } },
        { $set: { completionEmailStatus: 'sent', completionEmailSentAt: new Date(), updatedAt: new Date() } },
      );
    } catch (error) {
      await bookings.updateOne(
        { _id: booking._id, bookingStatus: 'completed' },
        { $set: { completionEmailStatus: 'failed', updatedAt: new Date() } },
      );
      console.error(`Completion notification failed for booking ${booking._id}:`, error.message);
    }
  }

  return { completedCount: completed.length, notificationCount: notifications.length };
}

export function startBookingCompletionJob() {
  if (scheduledTask) return;
  const schedule = process.env.BOOKING_COMPLETION_CRON || '*/5 * * * *';
  if (!cron.validate(schedule)) {
    throw new Error('BOOKING_COMPLETION_CRON must be a valid cron expression.');
  }
  scheduledTask = cron.schedule(schedule, () => {
    void runBookingCompletionJob().catch((error) => {
      console.error('Booking completion job failed:', error);
    });
  });
}

export function stopBookingCompletionJob() {
  scheduledTask?.stop();
  scheduledTask = undefined;
}
