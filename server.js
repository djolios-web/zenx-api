const express = require('express');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Pool } = require('pg');
const { Paddle } = require('@paddle/paddle-node-sdk');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const paddle = new Paddle(process.env.PADDLE_API_KEY, {
  environment: process.env.PADDLE_ENV || 'production'
});

const PRODUCTS = {
  'initiate-monthly':  process.env.PADDLE_PRICE_INITIATE_MONTHLY,
  'initiate-yearly':   process.env.PADDLE_PRICE_INITIATE_YEARLY,
  'architect-monthly': process.env.PADDLE_PRICE_ARCHITECT_MONTHLY,
  'architect-yearly':  process.env.PADDLE_PRICE_ARCHITECT_YEARLY
};

const COOKIE_SECRET = process.env.SESSION_SECRET || 'zenx-secret-key';

function signUserId(userId) {
  const hmac = crypto.createHmac('sha256', COOKIE_SECRET).update(userId).digest('hex');
  return hmac + '.' + userId;
}

function unsignUserId(signedValue) {
  if (!signedValue) return null;
  const dotIndex = signedValue.indexOf('.');
  if (dotIndex === -1) return null;
  const hmac = signedValue.substring(0, dotIndex);
  const userId = signedValue.substring(dotIndex + 1);
  const expected = crypto.createHmac('sha256', COOKIE_SECRET).update(userId).digest('hex');
  if (hmac !== expected) return null;
  return userId;
}

app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

app.use((req, res, next) => {
  console.log(`[${req.method}] ${req.path} | cookie: ${req.headers.cookie ? 'present' : 'missing'}`);
  next();
});

async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(255) PRIMARY KEY,
        email VARCHAR(255) UNIQUE,
        paddle_customer_id VARCHAR(255),
        subscription_status VARCHAR(50) DEFAULT 'inactive',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
  }
}

app.get('/api/init', (req, res) => {
  let userId = unsignUserId(req.cookies.userId);
  if (!userId) {
    userId = Date.now().toString(36) + Math.random().toString(36).substr(2);
    res.cookie('userId', signUserId(userId), {
      maxAge: 365 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      secure: true,
      sameSite: 'none'
    });
  }
  res.json({ success: true, userId });
});

app.get('/api/me', async (req, res) => {
  const userId = unsignUserId(req.cookies.userId);
  if (!userId) return res.json({ userId: null, email: null });
  try {
    const result = await pool.query(
      'SELECT email, subscription_status FROM users WHERE id = $1',
      [userId]
    );
    res.json({
      userId,
      email: result.rows[0]?.email || null,
      subscriptionStatus: result.rows[0]?.subscription_status || 'inactive'
    });
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Failed to fetch user info' });
  }
});

app.post('/api/email', async (req, res) => {
  const { email } = req.body;
  const userId = unsignUserId(req.cookies.userId);
  console.log('📧 Email request:', { email, userId });

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  if (!userId) {
    return res.status(400).json({ error: 'Session not initialized' });
  }

  try {
    // ✅ Check if email exists with a different userId
    const existing = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );

    if (existing.rows.length > 0 && existing.rows[0].id !== userId) {
      // Email exists with different ID — update to current userId
      await pool.query(
        'UPDATE users SET id = $1, updated_at = CURRENT_TIMESTAMP WHERE email = $2',
        [userId, email]
      );
    } else {
      // New email — insert or update same user
      await pool.query(
        `INSERT INTO users (id, email, updated_at)
         VALUES ($1, $2, CURRENT_TIMESTAMP)
         ON CONFLICT (id) DO UPDATE SET email = $2, updated_at = CURRENT_TIMESTAMP`,
        [userId, email]
      );
    }

    console.log('✅ Email saved:', email);
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Email error:', error);
    res.status(500).json({ error: 'Failed to save email: ' + error.message });
  }
});

app.post('/api/checkout', async (req, res) => {
  const { plan } = req.body;
  const userId = unsignUserId(req.cookies.userId);
  console.log('🛒 Checkout started | userId:', userId, '| plan:', plan);

  if (!userId) return res.status(400).json({ error: 'Session not initialized' });
  if (!plan)   return res.status(400).json({ error: 'Plan required' });

  const priceId = PRODUCTS[plan];
  if (!priceId) return res.status(400).json({ error: 'Invalid plan: ' + plan });

  console.log('💰 Price ID:', priceId);
  console.log('🔑 Paddle API Key prefix:', process.env.PADDLE_API_KEY?.substring(0, 20));

  try {
    const result = await pool.query(
      'SELECT email, paddle_customer_id FROM users WHERE id = $1',
      [userId]
    );
    const user = result.rows[0];
    const email = user?.email;
    console.log('📧 Email found:', email);

    if (!email) {
      return res.status(400).json({ error: 'Email not found. Please complete step 1.' });
    }

    let customerId = user?.paddle_customer_id;

    if (!customerId) {
      console.log('👤 Creating Paddle customer for:', email);
      const customer = await paddle.customers.create({ email });
      customerId = customer.id;
      await pool.query(
        'UPDATE users SET paddle_customer_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [customerId, userId]
      );
      console.log('✅ Paddle customer created:', customerId);
    }

    console.log('🛒 Creating checkout for customer:', customerId, 'price:', priceId);
    const checkout = await paddle.checkouts.create({
      customerId,
      items: [{ priceId, quantity: 1 }],
      successUrl: `${process.env.FRONTEND_URL}/zenx-hub/`,
      customData: { userId, plan }
    });

    console.log('✅ Checkout URL created:', checkout.url);
    res.json({ url: checkout.url });

  } catch (error) {
    console.error('❌ Checkout error full:', error);
    res.status(500).json({ error: error.message || 'Checkout failed' });
  }
});

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

app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err.stack);
  res.status(500).json({ error: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  initDatabase();
});
