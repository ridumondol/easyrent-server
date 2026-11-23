import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import {
  parseRentalDate,
  calculateTotalDays,
  calculateTotalAmount,
  datesOverlap,
  todayUtc,
} from '../utils/rental.js';
import { isValidObjectId } from '../utils/validation.js';
import { buildBlockingBookingsFilter } from '../utils/availability.js';
import { getHealth } from '../controllers/healthController.js';

describe('Rental utility functions', () => {
  it('parses date-only strings into UTC midnight', () => {
    const parsed = parseRentalDate('2030-05-12');
    assert.equal(parsed.toISOString(), '2030-05-12T00:00:00.000Z');
  });

  it('normalizes a timestamp to UTC midnight', () => {
    const parsed = parseRentalDate('2030-05-12T18:45:00.000Z');
    assert.equal(parsed.toISOString(), '2030-05-12T00:00:00.000Z');
  });

  it('rejects invalid, impossible, and empty dates', () => {
    for (const value of ['', 'nope', '2030-02-30', '2030-13-01', null, 12345]) {
      assert.equal(parseRentalDate(value), null, `should reject ${value}`);
    }
  });

  it('calculates whole rental days with an exclusive end date', () => {
    const start = parseRentalDate('2030-05-12');
    const end = parseRentalDate('2030-05-15');
    assert.equal(calculateTotalDays(start, end), 3);
    assert.equal(calculateTotalDays(start, parseRentalDate('2030-05-13')), 1);
  });

  it('calculates total amount from price, quantity and days', () => {
    assert.equal(calculateTotalAmount(75, 2, 3), 450);
    assert.equal(calculateTotalAmount(10.5, 3, 2), 63);
    assert.equal(calculateTotalAmount(33.33, 1, 3), 99.99);
  });

  it('uses half-open overlap semantics', () => {
    const aStart = parseRentalDate('2030-05-10');
    const aEnd = parseRentalDate('2030-05-14');
    const overlappingStart = parseRentalDate('2030-05-13');
    const overlappingEnd = parseRentalDate('2030-05-16');
    const backToBackStart = parseRentalDate('2030-05-14');
    const backToBackEnd = parseRentalDate('2030-05-17');
    const laterStart = parseRentalDate('2030-05-20');
    const laterEnd = parseRentalDate('2030-05-22');

    assert.equal(datesOverlap(aStart, aEnd, overlappingStart, overlappingEnd), true);
    assert.equal(datesOverlap(aStart, aEnd, backToBackStart, backToBackEnd), false);
    assert.equal(datesOverlap(aStart, aEnd, laterStart, laterEnd), false);
  });

  it('compares today at UTC midnight', () => {
    assert.equal(todayUtc().toISOString().slice(11), '00:00:00.000Z');
  });
});

describe('Validation & availability helpers', () => {
  it('strictly validates ObjectIds', () => {
    const id = new ObjectId();
    assert.equal(isValidObjectId(id.toString()), true);
    assert.equal(isValidObjectId('short'), false);
    assert.equal(isValidObjectId('abcdefghijkl'), false);
  });

  it('includes confirmed and fresh-pending bookings in the blocking filter', () => {
    const now = new Date();
    const equipmentId = new ObjectId();
    const filter = buildBlockingBookingsFilter({
      equipmentId,
      startDate: parseRentalDate('2030-05-10'),
      endDate: parseRentalDate('2030-05-14'),
      now,
    });

    assert.deepEqual(filter.bookingStatus, { $in: ['pending', 'confirmed'] });
    assert.ok(filter.$or.some((branch) => branch.bookingStatus === 'confirmed'));
    assert.ok(filter.$or.some(
      (branch) => branch.bookingStatus === 'pending' && branch.paymentStatus === 'paid',
    ));
    assert.ok(filter.$or.some(
      (branch) => branch.bookingStatus === 'pending' && branch.createdAt?.$gte,
    ));
    assert.deepEqual(filter.startDate, { $lt: parseRentalDate('2030-05-14') });
    assert.deepEqual(filter.endDate, { $gt: parseRentalDate('2030-05-10') });
  });

  it('can exclude a booking when re-checking availability', () => {
    const excludeBookingId = new ObjectId();
    const filter = buildBlockingBookingsFilter({
      equipmentId: new ObjectId(),
      startDate: parseRentalDate('2030-05-10'),
      endDate: parseRentalDate('2030-05-14'),
      excludeBookingId,
    });
    assert.deepEqual(filter._id, { $ne: excludeBookingId });
  });
});

describe('Health endpoint', () => {
  it('returns 503 when the database is disconnected', () => {
    const response = {
      statusCode: null,
      body: null,
      status(statusCode) {
        this.statusCode = statusCode;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      },
    };

    getHealth({}, response);

    assert.equal(response.statusCode, 503);
    assert.equal(response.body.success, false);
    assert.notEqual(response.body.data.database, 'connected');
  });
});
