const express = require('express');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Pool } = require('pg');
const Paddle = require('@paddle/paddle-node-sdk').Paddle;
const path = require('path');
const crypto = require('crypto');

// Load environment variables
require('dotenv').config();

const app = express();

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize Paddle
const paddle = new Paddle(process.env.PADDLE_API_KEY, {
  environment: process.env.PADDLE_ENV || 'sandbox'
});

// PRODUCTS constant
const PRODUCTS = {
  'initiate-monthly': process.env.PADDLE_PRICE_INITIATE_MONTHLY,
  'initiate-yearly': process.env.PADDLE_PRICE_INITIATE_YEARLY,
  'architect-monthly': process.env.PADDLE_PRICE_ARCHITECT_MONTHLY,
  'architect-yearly': process.env.PADDLE_PRICE_ARCHITECT_YEARLY
};

// Cookie signing helpers
const COOKIE_SECRET = process.env.SESSION_SECRET || 'zenx-secret-key-change-in-production';

function signUserId(userId) {
  return crypto.createHmac('sha256', COOKIE_SECRET).update(userId).digest('hex') + '.' + userId;
}

function unsignUserId(signedValue) {
  if (!signedValue) return null;
  const parts = signedValue.split('.');
  if (parts.length !== 2) return null;
  const hmac = parts[0];
  const userId = parts[1];
  const expectedHmac = crypto.createHmac('sha256', COOKIE_SECRET).update(userId).digest('hex');
  if (hmac !== expectedHmac) return null;
  return userId;
}

// Middleware
app.use(cookieParser());
app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static files (public folder)
app.use(express.static('public'));

// Initialize database table
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        paddle_customer_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
  }
}

// Initialize session endpoint
app.get('/api/init', (req, res) => {
  let userId = unsignUserId(req.cookies.userId);
  if (!userId) {
    userId = Date.now().toString(36) + Math.random().toString(36).substr(2);
    res.cookie('userId', signUserId(userId), {
      maxAge: 365 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax'
    });
  }
  res.json({ success: true, userId });
});

// Get current user
app.get('/api/me', async (req, res) => {
  const userId = unsignUserId(req.cookies.userId);
  if (!userId) return res.json({ userId: null, email: null });

  try {
    const result = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
    res.json({ userId, email: result.rows[0]?.email || null });
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Failed to fetch user info' });
  }
});

// Store email
app.post('/api/email', async (req, res) => {
  const { email } = req.body;
  const userId = unsignUserId(req.cookies.userId);

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  if (!userId) {
    return res.status(400).json({ error: 'Session not initialized' });
  }

  try {
    await pool.query(
      'UPDATE users SET email = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [email, userId]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Email storage error:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'This email is already registered.' });
    }
    res.status(500).json({ error: 'Failed to save email' });
  }
});

// Checkout
app.post('/api/checkout', async (req, res) => {
  const { plan } = req.body;
  const userId = unsignUserId(req.cookies.userId);

  console.log('✅ Checkout started - userId:', userId, 'plan:', plan);

  if (!userId) return res.status(400).json({ error: 'Session not initialized' });
  if (!plan) return res.status(400).json({ error: 'Plan required' });

  const priceId = PRODUCTS[plan];
  if (!priceId) return res.status(400).json({ error: 'Invalid plan' });

  try {
    const result = await pool.query('SELECT email, paddle_customer_id FROM users WHERE id = $1', [userId]);
    const email = result.rows[0]?.email;

    console.log('📧 Email found:', email);

    if (!email) {
      return res.status(400).json({ error: 'Email not found. Please complete step 1 first.' });
    }

    let customerId = result.rows[0]?.paddle_customer_id;

    if (!customerId) {
      const customer = await paddle.customers.create({ email });
      customerId = customer.id;
      await pool.query(
        'UPDATE users SET paddle_customer_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [customerId, userId]
      );
    }

    const checkout = await paddle.checkouts.create({
      customerId: customerId,
      items: [{ priceId, quantity: 1 }],
      successUrl: `${process.env.FRONTEND_URL}/zenx-hub/`,
      customData: { userId, plan }
    });

    res.json({ url: checkout.url });
  } catch (error) {
    console.error('❌ Checkout error:', error);
    res.status(500).json({ error: error.message || 'Checkout failed' });
  }
});

// Webhook
app.post('/webhook/paddle', async (req, res) => {
  try {
    const event = req.body;
    if (event.event_type === 'transaction.completed') {
      const { customer_id } = event.data;
      await pool.query(
        'UPDATE users SET subscription_status = $1, updated_at = CURRENT_TIMESTAMP WHERE paddle_customer_id = $2',
        ['active', customer_id]
      );
    }
    res.json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  initDatabase();
});
