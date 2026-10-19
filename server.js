require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const db = require('./database');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const MIDTRANS_SERVER_KEY = process.env.MIDTRANS_SERVER_KEY || '';
const IS_PROD = MIDTRANS_SERVER_KEY.startsWith('Mid-server-');
const MIDTRANS_HOST = IS_PROD ? 'https://api.midtrans.com' : 'https://api.sandbox.midtrans.com';

// 1. Ambil Semua Produk
app.get('/api/products', (req, res) => {
  db.all("SELECT id, title, price, description, image_url, status FROM products ORDER BY id DESC", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// 2. Tambah Produk Baru (Admin)
app.post('/api/products', (req, res) => {
  const { title, price, description, imageUrl, accountData } = req.body;
  if (!title || !price || !accountData) return res.status(400).json({ error: 'Data tidak lengkap' });

  db.run(
    "INSERT INTO products (title, price, description, image_url, account_data) VALUES (?, ?, ?, ?, ?)",
    [title, price, description, imageUrl, accountData],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID });
    }
  );
});

// 3. Buat Order QRIS Midtrans
app.post('/api/orders/create', async (req, res) => {
  const { productId } = req.body;
  db.get("SELECT * FROM products WHERE id = ?", [productId], async (err, product) => {
    if (err || !product) return res.status(404).json({ error: 'Produk tidak ditemukan' });
    if (product.status !== 'ready') return res.status(400).json({ error: 'Produk sudah terjual' });

    const orderId = `BIBZX-${Date.now()}`;
    const authHeader = Buffer.from(`${MIDTRANS_SERVER_KEY}:`).toString('base64');

    try {
      const response = await fetch(`${MIDTRANS_HOST}/v2/charge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${authHeader}`
        },
        body: JSON.stringify({
          payment_type: 'qris',
          transaction_details: { order_id: orderId, gross_amount: product.price },
          qris: { acquirer: 'gopay' }
        })
      });

      const data = await response.json();
      const qrisAction = data.actions?.find(a => a.name === 'generate-qr-code');
      const qrisUrl = qrisAction ? qrisAction.url : null;

      db.run("INSERT INTO orders (order_id, product_id, amount, qris_url) VALUES (?, ?, ?, ?)", [orderId, productId, product.price, qrisUrl]);

      res.json({ success: true, orderId, amount: product.price, qrisUrl, title: product.title });
    } catch (e) {
      res.status(500).json({ error: 'Gagal koneksi ke Midtrans' });
    }
  });
});

// 4. Cek Status Order & Kirim Akun
app.get('/api/orders/:orderId', (req, res) => {
  const query = `
    SELECT o.order_id, o.amount, o.status, o.qris_url, p.title, p.account_data 
    FROM orders o JOIN products p ON o.product_id = p.id WHERE o.order_id = ?
  `;
  db.get(query, [req.params.orderId], (err, order) => {
    if (err || !order) return res.status(404).json({ error: 'Order tidak ditemukan' });
    if (order.status === 'PAID') {
      return res.json({ status: 'PAID', accountData: order.account_data, title: order.title });
    }
    res.json({ status: order.status, qrisUrl: order.qris_url, amount: order.amount, title: order.title });
  });
});

// 5. Webhook Midtrans
app.post('/api/webhooks/midtrans', (req, res) => {
  const { order_id, status_code, gross_amount, signature_key, transaction_status } = req.body;
  const expectedSig = crypto.createHash('sha512').update(`${order_id}${status_code}${gross_amount}${MIDTRANS_SERVER_KEY}`).digest('hex');

  if (signature_key !== expectedSig) return res.status(401).json({ error: 'Invalid signature' });

  if (transaction_status === 'settlement' || transaction_status === 'capture') {
    db.get("SELECT product_id FROM orders WHERE order_id = ?", [order_id], (err, order) => {
      if (order) {
        db.run("UPDATE orders SET status = 'PAID' WHERE order_id = ?", [order_id]);
        db.run("UPDATE products SET status = 'sold' WHERE id = ?", [order.product_id]);
      }
    });
  }
  res.json({ status: 'OK' });
});

app.listen(PORT, () => console.log(`BIBZX Store aktif di port ${PORT}`));
     
