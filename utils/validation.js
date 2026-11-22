import { ObjectId } from 'mongodb';

/**
 * Strict ObjectId check. ObjectId.isValid() also accepts arbitrary 12-byte
 * strings, so we additionally require a canonical 24-character hex round trip.
 */
export function isValidObjectId(value) {
  if (typeof value !== 'string') return value instanceof ObjectId;
  return ObjectId.isValid(value) && String(new ObjectId(value)) === value;
}

export function toObjectId(value) {
  return value instanceof ObjectId ? value : new ObjectId(String(value));
}

export function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

export function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function parsePositiveInteger(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0 ? value : null;
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
