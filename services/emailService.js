import nodemailer from 'nodemailer';
import { getDB } from '../config/db.js';

function getSmtpConfiguration() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS || !process.env.EMAIL_FROM) {
    throw new Error('SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and EMAIL_FROM must be configured to send email.');
  }

  const port = Number(SMTP_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SMTP_PORT must be a valid TCP port.');
  }

  return { host: SMTP_HOST, port, user: SMTP_USER, pass: SMTP_PASS, from: process.env.EMAIL_FROM };
}

export function assertEmailServiceConfigured() {
  getSmtpConfiguration();
}

function createTransporter() {
  const { host, port, user, pass } = getSmtpConfiguration();
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

export async function sendBookingCompletedEmails(booking) {
  const users = getDB().collection('users');
  const [renter, owner] = await Promise.all([
    users.findOne({ _id: booking.renterId }, { projection: { name: 1, email: 1 } }),
    users.findOne({ _id: booking.ownerId }, { projection: { name: 1, email: 1 } }),
  ]);
  if (!renter?.email || !owner?.email) {
    throw new Error('Booking completion email recipients are missing.');
  }

  const equipment = await getDB().collection('equipment').findOne(
    { _id: booking.equipmentId },
    { projection: { title: 1 } },
  );
  const itemName = escapeHtml(equipment?.title || 'your rented equipment');
  const start = new Date(booking.startDate).toLocaleDateString('en-US', { timeZone: 'UTC' });
  const end = new Date(booking.endDate).toLocaleDateString('en-US', { timeZone: 'UTC' });
  const transporter = createTransporter();
  const subject = `Rentora rental completed: ${itemName}`;
  const makeMessage = (recipientName) => ({
    from: process.env.EMAIL_FROM,
    subject,
    text: `Hello ${recipientName}, the rental for ${equipment?.title || 'your equipment'} (${start} to ${end}) is now complete.`,
    html: `<p>Hello ${escapeHtml(recipientName || 'there')},</p><p>The rental for <strong>${itemName}</strong> from ${start} to ${end} is now complete.</p><p>Thank you for being part of Rentora.</p>`,
  });

  const results = await Promise.allSettled([
    transporter.sendMail({ ...makeMessage(renter.name), to: renter.email }),
    transporter.sendMail({ ...makeMessage(owner.name), to: owner.email }),
  ]);
  const failed = results.filter((result) => result.status === 'rejected');
  if (failed.length > 0) {
    throw new Error(`${failed.length} completion notification email(s) could not be sent.`);
  }
}

export async function sendPasswordResetEmail({ name, email, resetUrl }) {
  const transporter = createTransporter();
  const safeName = escapeHtml(name || 'there');
  const safeResetUrl = escapeHtml(resetUrl);

  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to: email,
    subject: 'Reset your Rentora password',
    text: `Hello ${name || 'there'},\n\nUse this link to reset your Rentora password. The link expires in 15 minutes and can only be used once:\n\n${resetUrl}\n\nIf you did not request a password reset, you can ignore this email.`,
    html: `<p>Hello ${safeName},</p><p>Use the link below to reset your Rentora password. It expires in 15 minutes and can only be used once.</p><p><a href="${safeResetUrl}">Reset your password</a></p><p>If you did not request a password reset, you can ignore this email.</p>`,
  });
}
