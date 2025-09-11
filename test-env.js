/**
 * Test environment variables loading
 */

import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

console.log('🧪 Testing Environment Variables...');
console.log('DATABASE_URL:', process.env.DATABASE_URL ? 'SET' : 'NOT SET');
console.log('DATABASE_SSL:', process.env.DATABASE_SSL);
console.log('STRIPE_SECRET_KEY:', process.env.STRIPE_SECRET_KEY ? 'SET' : 'NOT SET');

if (process.env.DATABASE_URL) {
  // Mask the password for security
  const maskedUrl = process.env.DATABASE_URL.replace(/:([^:@]+)@/, ':***@');
  console.log('DATABASE_URL (masked):', maskedUrl);
}

