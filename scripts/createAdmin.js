
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import bcrypt from 'bcryptjs';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const rl = readline.createInterface({ input, output });

async function createAdmin() {
  let client;

  try {
    const name = (await rl.question('Admin name: ')).trim();
    const email = (await rl.question('Admin email: ')).trim().toLowerCase();
    const password = await rl.question('Admin password: ');

    if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error('Please provide a valid name and email.');
    }

    if (password.length < 8 || !/[A-Z]/.test(password) || !/[a-z]/.test(password)) {
      throw new Error('Password must be at least 8 characters and include uppercase and lowercase letters.');
    }

    if (!process.env.MONGODB_URI) {
      throw new Error('MONGODB_URI is missing from .env');
    }

    client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();

    const db = client.db(process.env.MONGODB_DB_NAME || 'rentora');
    const users = db.collection('users');

    const existingUser = await users.findOne({ email });

    if (existingUser) {
      throw new Error(
        'This email already exists. No account was changed.'
      );
    }

    const passwordHash = await bcrypt.hash(password, 10);

    await users.insertOne({
      name,
      email,
      passwordHash,
      role: 'admin',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    console.log('\nAdmin account created successfully!');
    console.log('Email:', email);
    console.log('Role: admin');
  } catch (error) {
    console.error('\nError:', error.message);
    process.exitCode = 1;
  } finally {
    if (client) await client.close();
    rl.close();
  }
}

createAdmin();
