// ============ ZENX API - PRODUCTION READY ============
// License: MIT
// Goal: Answer "Will 1000 visitors convert?" in 7 days.
// Deploy: Render.com
// Last updated: 2026-03-25

import express from 'express';
import crypto from 'crypto';
import { Paddle, Environment } from '@paddle/paddle-node-sdk';
import pg from 'pg';
import cookieParser from 'cookie-parser';

const { Pool } = pg;
const app = express();

// Database connection
const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Initialize database tables
await pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    paddle_customer_id TEXT,
    paddle_subscription_id TEXT,
    status TEXT DEFAULT 'trial',
    created_at TIMESTAMP DEFAULT NOW(),
    paid_at TIMESTAMP,
    cohort TEXT DEFAULT 'test-1'
  );

  CREATE TABLE IF NOT EXISTS events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT,
    event_type TEXT,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type, created_at);
`);

// Paddle initialization
const paddle = new Paddle(process.env.PADDLE_API_KEY, {
  environment: process.env.PADDLE_ENV === 'production' ? Environment.production : Environment.sandbox
});

// Product price IDs from Paddle Catalog
const PRODUCTS = {
  initiate: {
    monthly: 'pri_01kmdbamyxgzp2azt2ekgbn8r9',
    yearly: 'pri_01kmdbdwc5xwyq3r1ehmc2q3pg'
  },
  architect: {
    monthly: 'pri_01kmdbh7kqjpk7megtyewewzt6',
    yearly: 'pri_01kmdbksrb60r640mvhg0qrkk9'
  }
};

// Middleware
app.use(cookieParser());
app.use(express.static('public'));

// Raw body parser for webhook signature verification
app.use('/webhook', express.raw({ type: 'application/json' }));

// JSON parser for other routes
app.use(express.json());

// Session management
const sign = (id) => {
  return `${id}.${crypto.createHmac('sha256', process.env.SECRET).update(id).digest('hex')}`;
};

const unsign = (token) => {
  if (!token) return null;
  const [id, sig] = token.split('.');
  if (!id || !sig) return null;
  const expected = crypto.createHmac('sha256', process.env.SECRET).update(id).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex')) ? id : null;
  } catch { 
    return null; 
  }
};

// Event tracking
const track = (userId, event, meta = {}) => {
  pool.query(
    'INSERT INTO events (user_id, event_type, metadata) VALUES ($1, $2, $3)',
    [userId, event, JSON.stringify(meta)]
  ).catch(err => console.error('[TRACK ERROR]', err));
};

// ============ ROUTES ============

// 1. Initialize session
app.get('/api/init', async (req, res) => {
  try {
    let userId = unsign(req.cookies.sid);

    if (!userId) {
      userId = crypto.randomBytes(16).toString('hex');
      res.cookie('sid', sign(userId), { 
        httpOnly: true, 
        secure: true, 
        sameSite: 'strict', 
        maxAge: 7 * 24 * 60 * 60 * 1000 
      });
      await pool.query(
        'INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', 
        [userId]
      );
      track(userId, 'session_created', { source: req.headers.referer || 'direct' });
    }

    const { rows } = await pool.query(
      'SELECT status, email FROM users WHERE id = $1', 
      [userId]
    );
    
    res.json({ 
      userId, 
      status: rows[0]?.status || 'trial', 
      hasEmail: !!rows[0]?.email 
    });
  } catch (err) {
    console.error('[INIT ERROR]', err);
    res.status(500).json({ error: 'server error' });
  }
});

// 2. Capture email
app.post('/api/email', async (req, res) => {
  try {
    const userId = unsign(req.cookies.sid);
    if (!userId) return res.status(401).json({ error: 'no session' });

    const { email } = req.body;
    if (!email?.includes('@')) {
      return res.status(400).json({ error: 'invalid email' });
    }

    await pool.query(
      'UPDATE users SET email = $1 WHERE id = $2', 
      [email.toLowerCase(), userId]
    );
    
    track(userId, 'email_captured', { email: email.toLowerCase() });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'email already exists' });
    }
    console.error('[EMAIL ERROR]', err);
    res.status(500).json({ error: 'server error' });
  }
});

// 3. Create checkout
app.post('/api/checkout', async (req, res) => {
  try {
    const userId = unsign(req.cookies.sid);
    if (!userId) return res.status(401).json({ error: 'no session' });

    const { plan } = req.body;
    if (!plan?.includes('-')) {
      return res.status(400).json({ error: 'invalid plan format. Use: initiate-monthly' });
    }

    track(userId, 'checkout_started', { plan });

    const { rows } = await pool.query(
      'SELECT email, paddle_customer_id FROM users WHERE id = $1', 
      [userId]
    );
    const user = rows[0];

    if (!user?.email) {
      return res.status(400).json({ error: 'email required before checkout' });
    }

    // Get or create Paddle customer
    let customerId = user.paddle_customer_id;
    if (!customerId) {
      const customer = await paddle.customers.create({ 
        email: user.email,
        customData: { userId }
      });
      customerId = customer.id;
      await pool.query(
        'UPDATE users SET paddle_customer_id = $1 WHERE id = $2', 
        [customerId, userId]
      );
    }

    // Validate plan
    const [productKey, billingKey] = plan.split('-');
    const priceId = PRODUCTS[productKey]?.[billingKey];
    if (!priceId) {
      return res.status(400).json({ error: 'invalid plan' });
    }

    // Create checkout
    const checkout = await paddle.checkouts.create({
      customerId: customerId,
      items: [{ priceId, quantity: 1 }],
      customData: { userId, plan },
      successUrl: 'https://zenx.academy/zenx-hub/',
      cancelUrl: 'https://zenx.academy/cancel'
    });

    res.json({ url: checkout.url });
  } catch (err) {
    console.error('[CHECKOUT ERROR]', err);
    res.status(500).json({ error: 'checkout failed', message: err.message });
  }
});

// 4. Webhook handler
app.post('/webhook/paddle', async (req, res) => {
  const signature = req.headers['paddle-signature'];
  const secret = process.env.PADDLE_WEBHOOK_SECRET;

  if (!signature || !secret) {
    return res.status(400).json({ error: 'missing signature or secret' });
  }

  let event;
  try {
    event = paddle.webhooks.unmarshal(req.body, secret, signature);
  } catch (err) {
    console.error('[WEBHOOK] Invalid signature:', err.message);
    return res.status(400).json({ error: 'invalid signature' });
  }

  // Acknowledge immediately
  res.json({ ok: true });

  // Process asynchronously
  try {
    console.log(`[WEBHOOK] Received: ${event.eventType}`);

    switch (event.eventType) {
      case 'subscription.created':
      case 'subscription.activated': {
        const userId = event.data.customData?.userId;
        if (!userId) {
          console.log('[WEBHOOK] No userId in customData');
          return;
        }

        await pool.query(`
          UPDATE users SET
            paddle_customer_id = $1,
            paddle_subscription_id = $2,
            status = 'active',
            paid_at = NOW()
          WHERE id = $3
        `, [event.data.customerId, event.data.id, userId]);

        const item = event.data.items?.[0];
        track(userId, 'paid', {
          subscriptionId: event.data.id,
          customerId: event.data.customerId,
          plan: item?.price?.product?.name,
          priceId: item?.price?.id,
          amount: item?.price?.unitPrice?.amount,
          interval: item?.price?.billingCycle?.interval
        });

        console.log(`[WEBHOOK] Subscription activated for user ${userId}`);
        break;
      }

      case 'transaction.paid': {
        const userId = event.data.customData?.userId;
        if (userId) {
          track(userId, 'payment_received', {
            transactionId: event.data.id,
            amount: event.data.details?.totals?.total
          });
        }
        break;
      }

      case 'subscription.canceled': {
        await pool.query(
          "UPDATE users SET status = 'canceled' WHERE paddle_subscription_id = $1",
          [event.data.id]
        );
        console.log(`[WEBHOOK] Subscription ${event.data.id} canceled`);
        break;
      }

      case 'transaction.payment_failed': {
        const userId = event.data.customData?.userId;
        if (userId) {
          track(userId, 'payment_failed', {
            transactionId: event.data.id
          });
        }
        break;
      }

      default:
        console.log(`[WEBHOOK] Unhandled event: ${event.eventType}`);
    }
  } catch (err) {
    console.error('[WEBHOOK] Processing error:', err);
  }
});

// 5. Admin metrics
app.get('/admin/metrics', async (req, res) => {
  try {
    const { rows: funnel } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE event_type = 'session_created') as visitors,
        COUNT(*) FILTER (WHERE event_type = 'email_captured') as emails,
        COUNT(*) FILTER (WHERE event_type = 'checkout_started') as checkouts,
        COUNT(*) FILTER (WHERE event_type = 'paid') as paid
      FROM events
      WHERE created_at > NOW() - INTERVAL '7 days'
    `);

    const { rows: cohorts } = await pool.query(`
      SELECT cohort,
        COUNT(*) as users,
        COUNT(*) FILTER (WHERE status = 'active') as paid,
        ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'active') / NULLIF(COUNT(*), 0), 1) as conversion_pct
      FROM users
      WHERE created_at > NOW() - INTERVAL '7 days'
      GROUP BY cohort
    `);

    const { rows: recent } = await pool.query(`
      SELECT u.id, u.email, u.paid_at, u.cohort, u.paddle_subscription_id
      FROM users u
      WHERE u.status = 'active'
      ORDER BY u.paid_at DESC
      LIMIT 10
    `);

    res.json({
      funnel: {
        visitors: parseInt(funnel[0].visitors) || 0,
        emails: parseInt(funnel[0].emails) || 0,
        checkouts: parseInt(funnel[0].checkouts) || 0,
        paid: parseInt(funnel[0].paid) || 0,
        email_rate: Math.round((funnel[0].emails / funnel[0].visitors) * 100) || 0,
        checkout_rate: Math.round((funnel[0].checkouts / funnel[0].emails) * 100) || 0,
        conversion_rate: Math.round((funnel[0].paid / funnel[0].visitors) * 100) || 0
      },
      cohorts,
      recent_conversions: recent
    });
  } catch (err) {
    console.error('[METRICS ERROR]', err);
    res.status(500).json({ error: 'server error' });
  }
});

// 6. Retention emails (24h)
setInterval(async () => {
  try {
    const { rows } = await pool.query(`
      SELECT id, email, created_at
      FROM users
      WHERE status = 'trial'
        AND created_at < NOW() - INTERVAL '24 hours'
        AND created_at > NOW() - INTERVAL '25 hours'
        AND NOT EXISTS (
          SELECT 1 FROM events
          WHERE user_id = users.id AND event_type = 'paid'
        )
    `);

    for (const user of rows) {
      console.log(`[RETENTION] Email to ${user.email}: "Complete your registration..."`);
      track(user.id, 'retention_email_sent');
    }
  } catch (err) {
    console.error('[RETENTION ERROR]', err);
  }
}, 60000);

// 7. Get current user
app.get('/api/me', async (req, res) => {
  try {
    const userId = unsign(req.cookies.sid);
    if (!userId) return res.status(401).json({ error: 'no session' });

    const { rows } = await pool.query(
      'SELECT status, email FROM users WHERE id = $1', 
      [userId]
    );
    
    if (!rows[0]) return res.status(404).json({ error: 'user not found' });

    res.json({ 
      userId, 
      status: rows[0].status || 'trial', 
      email: rows[0].email, 
      accessLayer: rows[0].status === 'active' ? 'initiate' : 'observer' 
    });
  } catch (err) {
    console.error('[ME ERROR]', err);
    res.status(500).json({ error: 'server error' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    env: process.env.PADDLE_ENV || 'not set'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[ZENX API] Server running on port ${PORT}`);
  console.log(`[ZENX API] Environment: ${process.env.PADDLE_ENV || 'NOT SET'}`);
});
