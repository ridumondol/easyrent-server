import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { MongoClient } from 'mongodb';

const equipmentSeed = [
  {
    title: 'Compact Excavator',
    category: 'construction',
    pricePerDay: 185,
    rentalType: 'daily',
    location: 'Austin, Texas',
    image: 'https://images.unsplash.com/photo-1580901368919-7738efb0f87e?auto=format&fit=crop&w=1200&q=85',
    description: 'A dependable compact excavator for trenching, landscaping, and tight-access jobs.',
  },
  {
    title: 'Full-frame Camera Kit',
    category: 'photography',
    pricePerDay: 95,
    rentalType: 'daily',
    location: 'Austin, Texas',
    image: 'https://images.unsplash.com/photo-1516035069371-29a1b244cc32?auto=format&fit=crop&w=1200&q=85',
    description: 'A creator-ready camera kit with a versatile lens, spare batteries, and charger.',
  },
  {
    title: 'Utility Cargo Van',
    category: 'vehicles',
    pricePerDay: 120,
    rentalType: 'daily',
    location: 'Austin, Texas',
    image: 'https://images.unsplash.com/photo-1549317661-bd32c8ce0db2?auto=format&fit=crop&w=1200&q=85',
    description: 'A clean cargo van with generous load space for deliveries and weekend projects.',
  },
  {
    title: 'Compact Farm Tractor',
    category: 'agriculture',
    pricePerDay: 210,
    rentalType: 'daily',
    location: 'Austin, Texas',
    image: 'https://images.unsplash.com/photo-1500382017468-9049fed747ef?auto=format&fit=crop&w=1200&q=85',
    description: 'A versatile compact tractor for small farms, acreage, and property maintenance.',
  },
  {
    title: 'Portable Power Generator',
    category: 'electronics',
    pricePerDay: 72,
    rentalType: 'daily',
    location: 'Austin, Texas',
    image: 'https://images.unsplash.com/photo-1473341304170-971dccb5ac1e?auto=format&fit=crop&w=1200&q=85',
    description: 'Quiet portable power for job sites, outdoor events, and backup needs.',
  },
  {
    title: 'Event Lighting Set',
    category: 'events',
    pricePerDay: 55,
    rentalType: 'daily',
    location: 'Austin, Texas',
    image: 'https://images.unsplash.com/photo-1507504031003-b417219a0fde?auto=format&fit=crop&w=1200&q=85',
    description: 'A versatile lighting set for community gatherings and small events.',
  },
];

function assertCredentials(label, email, password) {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(`${label} email is missing or invalid.`);
  }
  if (!password || password.length < 8 || !/[A-Z]/.test(password) || !/[a-z]/.test(password)) {
    throw new Error(`${label} password must be at least 8 characters with uppercase and lowercase letters.`);
  }
}

async function ensureUser(users, { name, email, password, role }) {
  const normalizedEmail = email.toLowerCase();
  let user = await users.findOne({ email: normalizedEmail });
  if (user) {
    if (user.role !== role) {
      throw new Error(`Seed email ${normalizedEmail} already exists with role "${user.role}", expected "${role}".`);
    }
    return user;
  }

  const now = new Date();
  const passwordHash = await bcrypt.hash(password, 10);
  try {
    const result = await users.insertOne({
      name,
      email: normalizedEmail,
      passwordHash,
      role,
      image: '',
      phone: '',
      address: '',
      createdAt: now,
      updatedAt: now,
    });
    user = await users.findOne({ _id: result.insertedId });
    if (!user) throw new Error(`Could not load seeded ${role} account.`);
    return user;
  } catch (error) {
    if (error?.code !== 11000) throw error;
    user = await users.findOne({ email: normalizedEmail });
    if (user?.role === role) return user;
    throw error;
  }
}

async function seedDemo() {
  const configs = [
    { label: 'Admin', name: process.env.SEED_ADMIN_NAME || 'Rentora Admin', email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD, role: 'admin' },
    { label: 'Owner', name: process.env.SEED_OWNER_NAME || 'Rentora Owner', email: process.env.SEED_OWNER_EMAIL, password: process.env.SEED_OWNER_PASSWORD, role: 'owner' },
    { label: 'Customer', name: process.env.SEED_CUSTOMER_NAME || 'Rentora Customer', email: process.env.SEED_CUSTOMER_EMAIL, password: process.env.SEED_CUSTOMER_PASSWORD, role: 'renter' },
  ];
  for (const config of configs) assertCredentials(config.label, config.email, config.password);
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');

  const client = new MongoClient(process.env.MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(process.env.MONGODB_DB_NAME || 'rentora');
    await db.collection('users').createIndex({ email: 1 }, { unique: true });
    const [admin, owner, customer] = await Promise.all(
      configs.map((config) => ensureUser(db.collection('users'), config)),
    );
    const equipmentCollection = db.collection('equipment');
    const now = new Date();
    const equipment = [];
    for (const [index, item] of equipmentSeed.entries()) {
      const filter = { ownerId: owner._id, title: item.title };
      await equipmentCollection.updateOne(
        filter,
        {
          $setOnInsert: {
            ...item,
            quantity: 2,
            condition: 'good',
            brand: '',
            model: '',
            rentalTerms: 'Return the equipment in the same condition. Contact the owner if anything changes.',
            ownerId: owner._id,
            availability: true,
            approvalStatus: 'approved',
            createdAt: now,
            updatedAt: now,
          },
        },
        { upsert: true },
      );
      equipment.push(await equipmentCollection.findOne(filter));
      if (index === 0) {
        await equipmentCollection.updateOne(
          { ownerId: owner._id, title: 'Pending Approval Demo Listing' },
          {
            $setOnInsert: {
              title: 'Pending Approval Demo Listing',
              description: 'Sample listing demonstrating the admin approval queue.',
              category: 'tools',
              pricePerDay: 35,
              rentalType: 'daily',
              location: 'Austin, Texas',
              image: item.image,
              quantity: 1,
              condition: 'good',
              ownerId: owner._id,
              availability: true,
              approvalStatus: 'pending',
              createdAt: now,
              updatedAt: now,
            },
          },
          { upsert: true },
        );
      }
    }

    const reviews = db.collection('reviews');
    for (const [index, equipmentItem] of equipment.slice(0, 4).entries()) {
      await reviews.updateOne(
        { userId: customer._id, equipmentId: equipmentItem._id },
        {
          $setOnInsert: {
            userId: customer._id,
            equipmentId: equipmentItem._id,
            rating: 5,
            comment: [
              'Exactly as listed and easy to arrange with the owner.',
              'Reliable gear and a smooth pickup experience.',
              'A great local option for a one-time project.',
              'Clear pricing and helpful communication throughout.',
            ][index],
            createdAt: now,
            updatedAt: now,
          },
        },
        { upsert: true },
      );
    }

    console.info('Rentora demo data is ready.');
    console.info(`Admin: ${admin.email}`);
    console.info(`Owner: ${owner.email}`);
    console.info(`Customer: ${customer.email}`);
    console.info(`Approved equipment: ${equipment.length}; pending approvals: 1; sample reviews: 4.`);
  } finally {
    await client.close();
  }
}

seedDemo().catch((error) => {
  console.error('Demo seed failed:', error.message);
  process.exitCode = 1;
});
