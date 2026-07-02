'use strict';
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');
const { Resend } = require('resend');
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

if (!process.env.DATABASE_URL) {
  console.error('Erro: DATABASE_URL não definida. Crie o arquivo .env com base no .env.example');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
});

const MASTER_EMAIL = 'andrewsfranco93@gmail.com';

// Auto-migrate orders table: add status and payment_proof_url columns
pool.query(`
  ALTER TABLE montblanc.orders ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'created';
  ALTER TABLE montblanc.orders ADD COLUMN IF NOT EXISTS payment_proof_url TEXT;
`).catch(e => console.error('orders migrate:', e.message));

// Auto-migrate users table: add reset token columns
pool.query(`
  ALTER TABLE montblanc.users ADD COLUMN IF NOT EXISTS reset_token TEXT;
  ALTER TABLE montblanc.users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ;
`).catch(e => console.error('reset_token migrate:', e.message));

// Auto-create images table for DB-stored uploads
pool.query(`
  CREATE TABLE IF NOT EXISTS montblanc.images (
    id SERIAL PRIMARY KEY,
    data TEXT NOT NULL,
    mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
`).catch(e => console.error('images table init:', e.message));

// Auto-create store_settings table and seed default row
pool.query(`
  CREATE TABLE IF NOT EXISTS montblanc.store_settings (
    id INTEGER PRIMARY KEY DEFAULT 1,
    is_open BOOLEAN DEFAULT TRUE,
    CONSTRAINT montblanc_store_single CHECK (id = 1)
  );
  INSERT INTO montblanc.store_settings (id, is_open) VALUES (1, TRUE) ON CONFLICT DO NOTHING;
`).catch(e => console.error('store_settings init:', e.message));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, /^image\//.test(file.mimetype));
  }
});

const app = express();
app.use(express.json());

// Serve static files (support.js, etc.)
app.use(express.static(__dirname));

// Serve the main HTML
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'Delivery Montblanc.dc.html'));
});

// ─── AUTH ────────────────────────────────────────────────────────────────────

app.post('/api/register', async (req, res) => {
  const { name, email, phone, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Campos obrigatórios ausentes' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const isMaster = email.toLowerCase() === MASTER_EMAIL;
    const r = await pool.query(
      'INSERT INTO montblanc.users (name, email, phone, password_hash, is_master) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, email, apartment, is_master',
      [name, email, phone || null, hash, isMaster]
    );
    res.json({ ok: true, user: r.rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'E-mail já cadastrado' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'E-mail e senha são obrigatórios' });
  try {
    const r = await pool.query('SELECT * FROM montblanc.users WHERE email = $1', [email]);
    if (!r.rows.length) return res.status(401).json({ error: 'Usuário não encontrado' });
    const user = r.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Senha incorreta' });
    res.json({ ok: true, user: { id: user.id, name: user.name, email: user.email, apartment: user.apartment, is_master: user.is_master } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/user/:id/apartment', async (req, res) => {
  const { apartment } = req.body;
  try {
    // is_master nunca muda por troca de apartamento — depende exclusivamente do e-mail
    await pool.query(
      'UPDATE montblanc.users SET apartment = $1 WHERE id = $2',
      [apartment, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PASSWORD RESET ──────────────────────────────────────────────────────────

app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'E-mail obrigatório' });
  try {
    const r = await pool.query('SELECT id FROM montblanc.users WHERE email = $1', [email]);
    if (!r.rows.length) return res.json({ ok: true }); // não revela se email existe
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expires = new Date(Date.now() + 60 * 60 * 1000);
    await pool.query(
      'UPDATE montblanc.users SET reset_token = $1, reset_token_expires = $2 WHERE email = $3',
      [code, expires, email]
    );
    if (resend) {
      await resend.emails.send({
        from: 'Delivery Montblanc <onboarding@resend.dev>',
        to: email,
        subject: 'Seu código de recuperação de senha',
        html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;">
                 <h2 style="color:#1B8A4F;">Delivery Montblanc</h2>
                 <p>Seu código para redefinir a senha é:</p>
                 <div style="font-size:36px;font-weight:800;letter-spacing:10px;color:#1C1A17;padding:24px 0;">${code}</div>
                 <p style="color:#6B675F;font-size:14px;">Válido por 1 hora. Se não foi você, ignore este email.</p>
               </div>`,
      });
    } else {
      console.log(`[DEV] Código de reset para ${email}: ${code}`);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  const { email, code, newPassword } = req.body;
  if (!email || !code || !newPassword) return res.status(400).json({ error: 'Dados incompletos' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'A senha precisa ter ao menos 6 caracteres' });
  try {
    const r = await pool.query(
      'SELECT id, reset_token, reset_token_expires FROM montblanc.users WHERE email = $1',
      [email]
    );
    if (!r.rows.length) return res.status(400).json({ error: 'E-mail não encontrado' });
    const user = r.rows[0];
    if (user.reset_token !== code) return res.status(400).json({ error: 'Código inválido' });
    if (!user.reset_token_expires || new Date() > new Date(user.reset_token_expires))
      return res.status(400).json({ error: 'Código expirado. Solicite um novo.' });
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      'UPDATE montblanc.users SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL WHERE id = $2',
      [hash, user.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── ALL ORDERS (MASTER) ─────────────────────────────────────────────────────

app.get('/api/orders/all', async (_req, res) => {
  try {
    const r = await pool.query(`
      SELECT o.*,
        json_agg(json_build_object('name', p.name, 'qty', oi.quantity, 'price', oi.price) ORDER BY oi.id) AS items
      FROM montblanc.orders o
      JOIN montblanc.order_items oi ON oi.order_id = o.id
      JOIN montblanc.products p ON p.id = oi.product_id
      GROUP BY o.id ORDER BY o.created_at DESC
    `);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/orders/:id/status', async (req, res) => {
  const { status } = req.body;
  const valid = ['created', 'paid', 'delivering', 'delivered'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Status inválido' });
  try {
    await pool.query('UPDATE montblanc.orders SET status = $1 WHERE id = $2', [status, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/orders/:id/proof', upload.single('proof'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  try {
    const b64 = req.file.buffer.toString('base64');
    const imgRes = await pool.query(
      'INSERT INTO montblanc.images (data, mime_type) VALUES ($1, $2) RETURNING id',
      [b64, req.file.mimetype]
    );
    const url = '/api/images/' + imgRes.rows[0].id;
    await pool.query('UPDATE montblanc.orders SET payment_proof_url = $1 WHERE id = $2', [url, req.params.id]);
    res.json({ url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── STORE STATUS ────────────────────────────────────────────────────────────

app.get('/api/store/status', async (_req, res) => {
  try {
    const r = await pool.query('SELECT is_open FROM montblanc.store_settings WHERE id = 1');
    res.json({ open: r.rows[0]?.is_open !== false });
  } catch {
    res.json({ open: true });
  }
});

app.post('/api/store/status', async (req, res) => {
  const { open } = req.body;
  try {
    await pool.query('UPDATE montblanc.store_settings SET is_open = $1 WHERE id = 1', [open !== false]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── IMAGES ──────────────────────────────────────────────────────────────────

app.get('/api/images/:id', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT data, mime_type FROM montblanc.images WHERE id = $1',
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).end();
    const buf = Buffer.from(r.rows[0].data, 'base64');
    res.set('Content-Type', r.rows[0].mime_type);
    res.set('Cache-Control', 'public, max-age=31536000');
    res.send(buf);
  } catch (e) {
    res.status(500).end();
  }
});

// ─── UPLOAD ──────────────────────────────────────────────────────────────────

app.post('/api/upload', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  try {
    const b64 = req.file.buffer.toString('base64');
    const r = await pool.query(
      'INSERT INTO montblanc.images (data, mime_type) VALUES ($1, $2) RETURNING id',
      [b64, req.file.mimetype]
    );
    res.json({ url: '/api/images/' + r.rows[0].id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PRODUCTS ────────────────────────────────────────────────────────────────

app.get('/api/products', async (_req, res) => {
  try {
    const r = await pool.query('SELECT * FROM montblanc.products WHERE active = TRUE ORDER BY created_at');
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/products', async (req, res) => {
  const { id, name, cat, price, unit, icon, description, tag } = req.body;
  try {
    const r = await pool.query(
      'INSERT INTO montblanc.products (id, name, cat, price, unit, icon, description, tag) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [id, name, cat, price, unit, icon || 'ph-package', description || '', tag || 'Novo']
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/products/:id', async (req, res) => {
  const { name, cat, price, unit, icon, description, tag, active } = req.body;
  try {
    const r = await pool.query(
      `UPDATE montblanc.products
       SET name=$1, cat=$2, price=$3, unit=$4, icon=$5, description=$6, tag=$7, active=$8
       WHERE id=$9 RETURNING *`,
      [name, cat, price, unit, icon || 'ph-package', description || '', tag || '', active !== false, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Produto não encontrado' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── CATEGORIES ──────────────────────────────────────────────────────────────

app.get('/api/categories', async (_req, res) => {
  try {
    const r = await pool.query('SELECT name FROM montblanc.categories ORDER BY id');
    res.json(r.rows.map(row => row.name));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/categories', async (req, res) => {
  const { name } = req.body;
  try {
    await pool.query('INSERT INTO montblanc.categories (name) VALUES ($1) ON CONFLICT DO NOTHING', [name]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/categories/:name', async (req, res) => {
  try {
    await pool.query('DELETE FROM montblanc.categories WHERE name = $1', [req.params.name]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── ORDERS ──────────────────────────────────────────────────────────────────

app.post('/api/orders', async (req, res) => {
  const { user_id, apartment, payment, items, total } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderRes = await client.query(
      'INSERT INTO montblanc.orders (user_id, apartment, payment, total) VALUES ($1,$2,$3,$4) RETURNING *',
      [user_id || null, apartment, payment, total]
    );
    const order = orderRes.rows[0];
    for (const item of items) {
      await client.query(
        'INSERT INTO montblanc.order_items (order_id, product_id, quantity, price) VALUES ($1,$2,$3,$4)',
        [order.id, item.id, item.qty, item.price]
      );
      await client.query('UPDATE montblanc.products SET sold = sold + $1 WHERE id = $2', [item.qty, item.id]);
    }
    await client.query('COMMIT');
    res.json({ ok: true, order });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.get('/api/orders/:userId', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT o.*, json_agg(json_build_object('name', p.name, 'qty', oi.quantity, 'price', oi.price)) AS items
       FROM montblanc.orders o
       JOIN montblanc.order_items oi ON oi.order_id = o.id
       JOIN montblanc.products p ON p.id = oi.product_id
       WHERE o.user_id = $1
       GROUP BY o.id ORDER BY o.created_at DESC`,
      [req.params.userId]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── FAVORITES ───────────────────────────────────────────────────────────────

app.get('/api/favorites/:userId', async (req, res) => {
  try {
    const r = await pool.query('SELECT product_id FROM montblanc.favorites WHERE user_id = $1', [req.params.userId]);
    const favs = {};
    r.rows.forEach(row => { favs[row.product_id] = true; });
    res.json(favs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/favorites/toggle', async (req, res) => {
  const { user_id, product_id } = req.body;
  try {
    const exists = await pool.query(
      'SELECT 1 FROM montblanc.favorites WHERE user_id=$1 AND product_id=$2',
      [user_id, product_id]
    );
    if (exists.rows.length) {
      await pool.query('DELETE FROM montblanc.favorites WHERE user_id=$1 AND product_id=$2', [user_id, product_id]);
    } else {
      await pool.query('INSERT INTO montblanc.favorites (user_id, product_id) VALUES ($1,$2)', [user_id, product_id]);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── START ───────────────────────────────────────────────────────────────────

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Delivery Montblanc rodando em http://localhost:${PORT}`);
  });
}

module.exports = app;
