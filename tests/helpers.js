import assert from 'node:assert/strict';
import { MongoClient, ObjectId } from 'mongodb';

export const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:5055';

export async function api(path, { method = 'GET', token, body, headers = {} } = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }

  return { status: response.status, body: parsed };
}

let dbPromise;

export function getTestDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const client = new MongoClient(process.env.MONGODB_URI, {
        serverSelectionTimeoutMS: 10000,
      });
      await client.connect();
      return { client, db: client.db(process.env.TEST_DB_NAME) };
    })();
  }
  return dbPromise;
}

export async function closeTestDb() {
  if (!dbPromise) return;
  const { client } = await dbPromise;
  await client.close();
  dbPromise = undefined;
}

let userCounter = 0;

export async function registerUser(role, prefix = 'user') {
  userCounter += 1;
  const email = `${prefix}_${Date.now()}_${userCounter}@example.test`;
  const result = await api('/api/auth/register', {
    method: 'POST',
    body: {
      name: `Test ${role}`,
      email,
      password: 'Secret123',
      role,
    },
  });

  assert.equal(
    result.status,
    201,
    `registerUser failed: ${JSON.stringify(result.body)}`,
  );

  return {
    token: result.body.data.token,
    user: result.body.data.user,
    email,
  };
}

const EQUIPMENT_DEFAULTS = {
  title: 'Professional Excavator',
  description: 'Heavy duty excavator available for construction rental.',
  category: 'construction',
  pricePerDay: 120,
  location: 'Dhaka, Bangladesh',
  image: 'https://example.com/excavator.jpg',
  quantity: 3,
  condition: 'good',
};

export async function createEquipment(ownerToken, overrides = {}, { approve = true } = {}) {
  const result = await api('/api/equipment', {
    method: 'POST',
    token: ownerToken,
    body: { ...EQUIPMENT_DEFAULTS, ...overrides },
  });

  assert.equal(
    result.status,
    201,
    `createEquipment failed: ${JSON.stringify(result.body)}`,
  );

  const id = result.body.data.equipment._id;

  if (approve) {
    const { db } = await getTestDb();
    await db.collection('equipment').updateOne(
      { _id: new ObjectId(id) },
      { $set: { approvalStatus: 'approved' } },
    );
  }

  return id;
}

export async function insertEquipmentDirect(overrides = {}) {
  const { db } = await getTestDb();
  const now = new Date();
  const equipment = {
    ...EQUIPMENT_DEFAULTS,
    ownerId: new ObjectId(),
    approvalStatus: 'approved',
    availability: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  const result = await db.collection('equipment').insertOne(equipment);
  return result.insertedId;
}

export async function insertBookingDirect(overrides = {}) {
  const { db } = await getTestDb();
  const now = new Date();
  const booking = {
    equipmentId: new ObjectId(),
    renterId: new ObjectId(),
    ownerId: new ObjectId(),
    startDate: new Date('2030-01-10T00:00:00.000Z'),
    endDate: new Date('2030-01-13T00:00:00.000Z'),
    quantity: 1,
    pricePerDay: 100,
    totalDays: 3,
    totalAmount: 300,
    phone: '+8801700000000',
    address: 'Test address',
    notes: '',
    bookingStatus: 'confirmed',
    paymentStatus: 'unpaid',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  const result = await db.collection('bookings').insertOne(booking);
  return { _id: result.insertedId, ...booking };
}

export function dateString(daysFromToday) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + daysFromToday);
  return date.toISOString().slice(0, 10);
}

export function bookingPayload(equipmentId, overrides = {}) {
  return {
    equipmentId,
    startDate: dateString(5),
    endDate: dateString(8),
    quantity: 1,
    phone: '+8801712345678',
    address: '12 Test Road, Dhaka',
    notes: 'Please deliver on time.',
    // Deliberately manipulated values — the server must ignore all of these.
    pricePerDay: 1,
    totalAmount: 1,
    totalDays: 1,
    renterId: new ObjectId().toString(),
    ownerId: new ObjectId().toString(),
    bookingStatus: 'confirmed',
    paymentStatus: 'paid',
    ...overrides,
  };
}

export function assertError(response, status, messageFragment) {
  assert.equal(
    response.status,
    status,
    `Expected status ${status}, got ${response.status}: ${JSON.stringify(response.body)}`,
  );
  assert.equal(response.body.success, false);
  if (messageFragment) {
    assert.match(
      response.body.message ?? '',
      new RegExp(messageFragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
      `Expected message to contain "${messageFragment}", got "${response.body.message}"`,
    );
  }
}

export function assertSuccess(response, status = 200) {
  assert.equal(
    response.status,
    status,
    `Expected status ${status}, got ${response.status}: ${JSON.stringify(response.body)}`,
  );
  assert.equal(response.body.success, true);
  return response.body.data;
}
