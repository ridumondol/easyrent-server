const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Parse a rental date into UTC midnight.
 * Date-only strings (YYYY-MM-DD) are validated strictly so that impossible
 * dates such as 2026-02-30 are rejected instead of silently rolling over.
 * Returns null for invalid input.
 */
export function parseRentalDate(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return toUtcMidnight(value);
  }

  if (typeof value !== 'string' || value.trim().length === 0) return null;

  const raw = value.trim();
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);

  let parsed;
  try {
    parsed = new Date(isDateOnly ? `${raw}T00:00:00.000Z` : raw);
  } catch {
    return null;
  }

  if (Number.isNaN(parsed.getTime())) return null;
  if (isDateOnly && parsed.toISOString().slice(0, 10) !== raw) return null;

  return toUtcMidnight(parsed);
}

function toUtcMidnight(date) {
  const isoDay = date.toISOString().slice(0, 10);
  return new Date(`${isoDay}T00:00:00.000Z`);
}

/** Today at UTC midnight — used for calendar-day comparisons. */
export function todayUtc() {
  return toUtcMidnight(new Date());
}

/** Whole rental days between two UTC-midnight dates (end is exclusive). */
export function calculateTotalDays(startDate, endDate) {
  return Math.round((endDate.getTime() - startDate.getTime()) / MS_PER_DAY);
}

/** Money is rounded to cents to avoid floating point drift. */
export function calculateTotalAmount(pricePerDay, quantity, totalDays) {
  return Math.round(pricePerDay * quantity * totalDays * 100) / 100;
}

export function calculateRentalUnits(totalDays, rentalType = 'daily') {
  if (!Number.isInteger(totalDays) || totalDays < 1) {
    throw new Error('Rental duration must be at least one day.');
  }
  if (rentalType === 'weekly') return Math.ceil(totalDays / 7);
  if (rentalType === 'monthly') return Math.ceil(totalDays / 30);
  return totalDays;
}

export function calculateRentalAmount(pricePerUnit, quantity, totalDays, rentalType = 'daily') {
  const units = calculateRentalUnits(totalDays, rentalType);
  return Math.round(pricePerUnit * quantity * units * 100) / 100;
}

/**
 * Half-open interval overlap: [start, end).
 * Back-to-back ranges (one ends exactly when the next starts) do not overlap.
 */
export function datesOverlap(startA, endA, startB, endB) {
  return startA.getTime() < endB.getTime() && endA.getTime() > startB.getTime();
}
