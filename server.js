'use strict';
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const path = require('path');

if (!process.env.DATABASE_URL) {
  console.error('Erro: DATABASE_URL não definida. Crie o arquivo .env com base no .env.example');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

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
    const r = await pool.query(
      'INSERT INTO montblanc.users (name, email, phone, password_hash) VALUES ($1,$2,$3,$4) RETURNING id, name, email, apartment, is_master',
      [name, email, phone || null, hash]
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
    await pool.query(
      'UPDATE montblanc.users SET apartment = $1, is_master = $2 WHERE id = $3',
      [apartment, apartment === '608', req.params.id]
    );
    res.json({ ok: true });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Delivery Montblanc rodando em http://localhost:${PORT}`);
});
