// קובץ: db.js

const { Pool } = require('pg');

const isProduction = process.env.NODE_ENV === 'production';

// Prioritize DATABASE_URL if available, fallback to individual parameters
const connectionConfig = process.env.DATABASE_URL 
  ? { connectionString: process.env.DATABASE_URL }
  : {
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      database: process.env.DB_DATABASE,
      password: process.env.DB_PASSWORD,
      port: process.env.DB_PORT || 5432,
    };

// Enforce SSL for cloud deployments (e.g., Render, Heroku)
if (process.env.DB_SSL === 'true' || isProduction) {
  connectionConfig.ssl = { rejectUnauthorized: false };
}

connectionConfig.max = 20; 
connectionConfig.idleTimeoutMillis = 30000; 
connectionConfig.connectionTimeoutMillis = 2000; 
const pool = new Pool(connectionConfig);

pool.on('error', (err, client) => {
  console.error('❌ Unexpected error on idle client', err.message);
});

async function testConnection() {
  try {
    const res = await pool.query('SELECT NOW()');
    console.log('✅ Database connection successful:', res.rows[0].now);
  } catch (err) {
    console.error('❌ Database connection error:', err.message);
  }
}

module.exports = { pool, testConnection };