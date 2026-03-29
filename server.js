'use strict';

const express    = require('express');
const cookieParser = require('cookie-parser');
const cors       = require('cors');
const { Pool }   = require('pg');
const { Paddle, Environment } = require('@paddle/paddle-node-sdk');
const crypto     = require('crypto');
const axios      = require('axios');
require('dotenv').config();

console.log('KEY:', process.env.PADDLE_API_KEY);
console.log('ENV:', process.env.PADDLE_ENV);
console.log('PRICE:', process.env.PADDLE_PRICE_ARCHITECT_MONTHLY);
console.log('SC_PART1:', process.env.PADDLE_PRICE_SC_PART1);
console.log('SC_BUNDLE:', process.env.PADDLE_PRICE_SC_BUNDLE);

const app = express();
app.set('trust proxy', 1);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const paddle = new Paddle(process.env.PADDLE_API_KEY, {
  environment: process.env.PADDLE_ENV === 'production'
    ? Environment.Production
    : Environment.Sandbox
});

const PRODUCTS = {
  'initiate-monthly':  process.env.PADDLE_PRICE_INITIATE_MONTHLY,
  'initiate-yearly':   process.env.PADDLE_PRICE_INITIATE_YEARLY,
  'architect-monthly': process.env.PADDLE_PRICE_ARCHITECT_MONTHLY,
  'architect-yearly':  process.env.PADDLE_PRICE_ARCHITECT_YEARLY,
  'sc-protocol': process.env.PADDLE_PRICE_SC_PROTOCOL,
  'sc-part1':    process.env.PADDLE_PRICE_SC_PART1,
  'sc-part2':    process.env.PADDLE_PRICE_SC_PART2,
  'sc-part3':    process.env.PADDLE_PRICE_SC_PART3,
  'sc-part4':    process.env.PADDLE_PRICE_SC_PART4,
  'sc-part5':    process.env.PADDLE_PRICE_SC_PART5,
  'sc-part6':    process.env.PADDLE_PRICE_SC_PART6,
  'sc-bundle':   process.env.PADDLE_PRICE_SC_BUNDLE,
  'gob':         process.env.PADDLE_PRICE_GOB,
};

const COOKIE_SECRET  = process.env.SESSION_SECRET || 'zenx-secret-key';
const ALLOWED_ORIGINS = [
  'https://zenx.academy',
  'https://www.zenx.academy'
];

function signUserId(userId) {
  const hmac = crypto.createHmac('sha256', COOKIE_SECRET).update(userId).digest('hex');
  return hmac + '.' + userId;
}

function unsignUserId(signedValue) {
  if (!signedValue) return null;
  const dotIndex = signedValue.indexOf('.');
  if (dotIndex === -1) return null;
  const hmac   = signedValue.substring(0, dotIndex);
  const userId = signedValue.substring(dotIndex + 1);
  const expected = crypto.createHmac('sha256', COOKIE_SECRET).update(userId).digest('hex');
  if (hmac !== expected) return null;
  return userId;
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use('/webhook/paddle', express.raw({ type: 'application/json' }));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.use((req, res, next) => {
  console.log(`[${req.method}] ${req.path} | origin: ${req.headers.origin || 'none'}`);
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
    console.log('✅ Database initialized');
  } catch (error) {
    console.error('❌ Database init error:', error);
  }
}

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

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
  if (!email || !email.includes('@'))
    return res.status(400).json({ error: 'Valid email required' });
  if (!userId)
    return res.status(400).json({ error: 'Session not initialized' });
  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0 && existing.rows[0].id !== userId) {
      await pool.query(
        'UPDATE users SET id = $1, updated_at = CURRENT_TIMESTAMP WHERE email = $2',
        [userId, email]
      );
    } else {
      await pool.query(
        `INSERT INTO users (id, email, updated_at)
         VALUES ($1, $2, CURRENT_TIMESTAMP)
         ON CONFLICT (id) DO UPDATE SET email = $2, updated_at = CURRENT_TIMESTAMP`,
        [userId, email]
      );
    }
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Email error:', error);
    res.status(500).json({ error: 'Failed to save email: ' + error.message });
  }
});

app.post('/api/checkout', async (req, res, next) => {
  const { plan, email } = req.body;
  console.log('🛒 Checkout | email:', email, '| plan:', plan);
  console.log('🔍 Full body received:', JSON.stringify(req.body));

  if (!plan) return res.status(400).json({ error: 'Plan required' });
  if (!email || !email.includes('@'))
    return res.status(400).json({ error: 'Valid email required' });

  const priceId = PRODUCTS[plan];
  if (!priceId) return res.status(400).json({ error: 'Invalid plan: ' + plan });

  try {
    let customerId;
    const result = await pool.query(
      'SELECT paddle_customer_id FROM users WHERE email = $1', [email]
    );
    if (result.rows[0]?.paddle_customer_id) {
      customerId = result.rows[0].paddle_customer_id;
    } else {
      const customer = await paddle.customers.create({ email });
      customerId = customer.id;
      const newId = Date.now().toString(36) + Math.random().toString(36).substr(2);
      await pool.query(
        `INSERT INTO users (id, email, paddle_customer_id, updated_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
         ON CONFLICT (email) DO UPDATE SET paddle_customer_id = $3, updated_at = CURRENT_TIMESTAMP`,
        [newId, email, customerId]
      );
    }

    const transaction = await paddle.transactions.create({
      customer_id: customerId,
      items: [{ price_id: priceId, quantity: 1 }],
      collection_mode: 'automatic',
      custom_data: { email, plan }
    });

    const checkoutUrl = transaction.checkout?.url;
    if (!checkoutUrl)
      return res.status(500).json({ error: 'No checkout URL returned from Paddle' });

    console.log('✅ Checkout URL:', checkoutUrl);
    res.json({ url: checkoutUrl });

  } catch (error) {
    console.error('❌ Checkout error:', error?.response?.data || error.message);
    next(error);
  }
});

app.post('/webhook/paddle', async (req, res) => {
  const rawBody         = req.body;
  const signatureHeader = req.headers['paddle-signature'];

  let isValid = false;
  try {
    isValid = paddle.webhooks.isSignatureValid(
      rawBody,
      process.env.PADDLE_WEBHOOK_SECRET,
      signatureHeader
    );
  } catch (e) {
    console.error('[webhook] Signature check error:', e.message);
  }

  if (!isValid) {
    console.error('[webhook] ❌ Invalid signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Malformed JSON' });
  }

  console.log('[webhook] Event:', event.event_type);
  res.status(200).json({ received: true });

  try {
    if (event.event_type === 'transaction.completed') {
      const { customer_id } = event.data;
      const email = event.data?.customer?.email;

      await pool.query(
        'UPDATE users SET subscription_status = $1, updated_at = CURRENT_TIMESTAMP WHERE paddle_customer_id = $2',
        ['active', customer_id]
      );
      console.log('[webhook] ✅ Subscription activated for customer:', customer_id);
// Generate WordPress password reset link
const wpResetResponse = await axios.post(
  `${process.env.WP_SITE_URL}/wp-json/zenx/v1/reset-link`,
  { email },
  { headers: { 'X-ZenX-Secret': process.env.WP_GRANT_SECRET } }
).catch(() => null);

const resetLink = wpResetResponse?.data?.link || 'https://zenx.academy/my-account';

// Send welcome email via Brevo
await axios.post(
  'https://api.brevo.com/v3/smtp/email',
  {
    templateId: 8,
    to: [{ email }],
    params: { RESET_LINK: resetLink }
  },
  { headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' } }
);
console.log('[webhook] ✅ Welcome email sent to:', email);
      if (email) {
        const plan = event.data?.custom_data?.plan;
        if (plan) {
          try {
            await axios.post(
              `${process.env.WP_SITE_URL}/wp-json/zenx/v1/grant-access`,
              { email, plan_id: plan },
              {
                headers: {
                  'Content-Type': 'application/json',
                  'X-ZenX-Secret': process.env.WP_GRANT_SECRET
                }
              }
            );
            console.log('[webhook] ✅ RCP access granted for:', email, '| plan:', plan);
          } catch (e) {
            console.error('[webhook] ❌ RCP grant error:', e.response?.data || e.message);
          }
        }
      }
    }

    if (event.event_type === 'subscription.canceled') {
      const { customer_id } = event.data;
      await pool.query(
        'UPDATE users SET subscription_status = $1, updated_at = CURRENT_TIMESTAMP WHERE paddle_customer_id = $2',
        ['inactive', customer_id]
      );
      console.log('[webhook] ✅ Subscription canceled for customer:', customer_id);
    }

  } catch (err) {
    console.error('[webhook] Processing error:', err.message);
  }
});

app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err.stack);
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.status(500).json({ error: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✅ ZenX Backend running on port ${PORT}`);
  console.log(`   Paddle ENV: ${process.env.PADDLE_ENV}`);
  await initDatabase();
});
