const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const MySQLStoreFactory = require('express-mysql-session');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const isProduction = process.env.NODE_ENV === 'production';
const SESSION_MAX_AGE = 1000 * 60 * 60 * 8;

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  throw new Error('SESSION_SECRET must be at least 32 characters long.');
}
if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 12) {
  throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD (minimum 12 characters).');
}
if (!process.env.DB_NAME || !process.env.DB_USER || !process.env.DB_PASSWORD) {
  throw new Error('Set DB_NAME, DB_USER and DB_PASSWORD for MySQL.');
}

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
  queueLimit: 0,
  charset: 'utf8mb4'
};

const pool = mysql.createPool(dbConfig);
const one = async (sql, params = []) => {
  const [rows] = await pool.execute(sql, params);
  return rows[0] || null;
};
const many = async (sql, params = []) => {
  const [rows] = await pool.execute(sql, params);
  return rows;
};
const run = async (sql, params = []) => {
  const [result] = await pool.execute(sql, params);
  return result;
};
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function text(v, n = 250) {
  if (typeof v !== 'string') return '';
  return v.replace(/\0/g, '').trim().slice(0, n);
}
function normalizePromoCode(v) {
  return text(v, 50).trim().toUpperCase();
}
function validDate(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
}
function safeSlug(v) {
  return text(v, 100).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function statusLabel(value) {
  const map = {
    pending: 'Menunggu pembayaran',
    paid: 'Lunas',
    expired: 'Kedaluwarsa',
    failed: 'Gagal',
    approved: 'Disetujui',
    rejected: 'Ditolak',
    submitted: 'Dikirim'
  };
  return map[value] || value || 'Tidak diketahui';
}

const MySQLStore = MySQLStoreFactory(session);
const sessionStore = new MySQLStore({ ...dbConfig, clearExpired: true, checkExpirationInterval: 15 * 60 * 1000 });

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'data:']
    }
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  hsts: isProduction ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
  noSniff: true,
  frameguard: { action: 'deny' }
}));
app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: isProduction, maxAge: SESSION_MAX_AGE }
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Login dibatasi sementara. Coba lagi nanti.' }
});
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Terlalu banyak permintaan. Silakan coba lagi nanti.' }
});
app.use('/api/', apiLimiter);
app.use(express.json({ limit: '20kb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

function requireAdmin(req, res, next) {
  if (!req.session.adminId) {
    return res.status(401).json({ error: 'Silakan masuk sebagai admin.' });
  }
  next();
}

async function logAudit(adminId, action, entityType, entityId, details = {}) {
  try {
    await run(
      'INSERT INTO audit_logs(admin_id, action, entity_type, entity_id, details_json, created_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP)',
      [adminId || null, action, entityType, entityId || null, JSON.stringify(details || {})]
    );
  } catch (error) {
    console.error('Audit log failed:', error.message);
  }
}

async function initializeDatabase() {
  const schema = [
    `CREATE TABLE IF NOT EXISTS admins (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS events (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      slug VARCHAR(120) NOT NULL UNIQUE,
      name VARCHAR(255) NOT NULL,
      description TEXT NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      registration_deadline DATE NOT NULL,
      distances_json JSON NOT NULL,
      active TINYINT(1) NOT NULL DEFAULT 0,
      INDEX idx_events_active (active, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS registrations (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      event_id BIGINT UNSIGNED NOT NULL,
      code VARCHAR(60) NOT NULL UNIQUE,
      name VARCHAR(150) NOT NULL,
      email VARCHAR(255) NOT NULL,
      phone VARCHAR(60) NOT NULL,
      distance VARCHAR(30) NOT NULL,
      shirt VARCHAR(20) NOT NULL DEFAULT 'M',
      address TEXT NOT NULL,
      promo VARCHAR(50) NOT NULL DEFAULT '',
      promo_code VARCHAR(50) NULL,
      amount BIGINT NOT NULL DEFAULT 0,
      discount_amount BIGINT NOT NULL DEFAULT 0,
      final_amount BIGINT NOT NULL DEFAULT 0,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      payment_session_id VARCHAR(255) NULL,
      ticket_pdf_path VARCHAR(255) NULL,
      ticket_sent_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_registrations_event FOREIGN KEY (event_id) REFERENCES events(id),
      INDEX idx_registrations_payment_session (payment_session_id),
      INDEX idx_registrations_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS activities (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      registration_id BIGINT UNSIGNED NOT NULL,
      source VARCHAR(30) NOT NULL,
      external_id VARCHAR(255) NULL,
      distance_m BIGINT NULL,
      activity_date DATE NULL,
      proof_path VARCHAR(255) NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'submitted',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_activities_registration FOREIGN KEY (registration_id) REFERENCES registrations(id),
      INDEX idx_activities_registration_created (registration_id, created_at),
      INDEX idx_activities_external (external_id, registration_id),
      INDEX idx_activities_proof (proof_path)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS promo_codes (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(50) NOT NULL UNIQUE,
      event_id BIGINT UNSIGNED NULL,
      discount_type VARCHAR(20) NOT NULL DEFAULT 'percent',
      discount_value DECIMAL(10,2) NOT NULL DEFAULT 0,
      usage_limit INT NOT NULL DEFAULT 0,
      used_count INT NOT NULL DEFAULT 0,
      valid_from DATE NULL,
      valid_until DATE NULL,
      active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_promo_event FOREIGN KEY (event_id) REFERENCES events(id),
      INDEX idx_promos_active_code (active, code),
      INDEX idx_promos_event (event_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      admin_id BIGINT UNSIGNED NULL,
      action VARCHAR(100) NOT NULL,
      entity_type VARCHAR(80) NOT NULL,
      entity_id BIGINT UNSIGNED NULL,
      details_json JSON NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_audit_logs_created (created_at DESC),
      INDEX idx_audit_logs_admin (admin_id, created_at DESC),
      CONSTRAINT fk_audit_admin FOREIGN KEY (admin_id) REFERENCES admins(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  ];

  for (const statement of schema) {
    await pool.query(statement);
  }

  const adminEmail = process.env.ADMIN_EMAIL.trim().toLowerCase();
  const adminExists = await one('SELECT id FROM admins WHERE email = ?', [adminEmail]);
  if (!adminExists) {
    await run('INSERT INTO admins(email, password_hash) VALUES(?, ?)', [adminEmail, await bcrypt.hash(process.env.ADMIN_PASSWORD, 12)]);
  }

  const hasEvent = await one('SELECT id FROM events LIMIT 1');
  if (!hasEvent) {
    const today = new Date();
    const start = new Date(today.getTime() + 7 * 86400000).toISOString().slice(0, 10);
    const end = new Date(today.getTime() + 30 * 86400000).toISOString().slice(0, 10);
    const deadline = new Date(today.getTime() + 5 * 86400000).toISOString().slice(0, 10);
    await run(`INSERT INTO events(slug,name,description,start_date,end_date,registration_deadline,distances_json,active)
      VALUES(?,?,?,?,?,?,?,1)`, [
      'langkahbersama-virtual-run',
      'LangkahBersama Virtual Run',
      'Ikuti tantangan lari virtual dari mana saja.',
      start,
      end,
      deadline,
      JSON.stringify({ '5K': 150000, '10K': 250000, '21K': 350000, '42K': 550000 })
    ]);
  }

  const samplePromo = await one('SELECT id FROM promo_codes WHERE code = ?', ['LBWELCOME']);
  if (!samplePromo) {
    const event = await one('SELECT id FROM events WHERE active = 1 LIMIT 1');
    await run(`INSERT INTO promo_codes(code, event_id, discount_type, discount_value, usage_limit, used_count, valid_from, valid_until, active)
      VALUES(?,?,?,?,?,?,?,?,1)`, ['LBWELCOME', event ? event.id : null, 'percent', 10, 50, 0, new Date().toISOString().slice(0, 10), new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10)]);
  }
}

async function getActiveEvent() {
  return one('SELECT * FROM events WHERE active = 1 ORDER BY id DESC LIMIT 1');
}

async function resolvePromoCode(code, eventId = null) {
  const normalized = normalizePromoCode(code);
  if (!normalized) return null;

  const promo = await one(`
    SELECT * FROM promo_codes
    WHERE UPPER(code) = ?
      AND active = 1
      AND (event_id IS NULL OR event_id = ?)
      AND (valid_from IS NULL OR valid_from <= CURDATE())
      AND (valid_until IS NULL OR valid_until >= CURDATE())
  `, [normalized, eventId]);

  if (!promo) return null;
  if (Number(promo.usage_limit || 0) > 0 && Number(promo.used_count || 0) >= Number(promo.usage_limit)) {
    return null;
  }
  return promo;
}

async function applyPromoToAmount(amount, promoCode, eventId = null) {
  const baseAmount = Number(amount || 0);
  if (!promoCode || baseAmount <= 0) {
    return { amount: baseAmount, discount: 0, promo: null };
  }

  const promo = await resolvePromoCode(promoCode, eventId);
  if (!promo) {
    return { amount: baseAmount, discount: 0, promo: null };
  }

  let discount = 0;
  if (String(promo.discount_type || 'percent').toLowerCase() === 'fixed') {
    discount = Math.min(baseAmount, Number(promo.discount_value || 0));
  } else {
    discount = Math.round(baseAmount * (Number(promo.discount_value || 0) / 100));
  }

  const finalAmount = Math.max(0, baseAmount - discount);
  await run('UPDATE promo_codes SET used_count = used_count + 1 WHERE id = ?', [promo.id]);
  return { amount: finalAmount, discount, promo };
}

async function eventSummary() {
  const rows = await many('SELECT * FROM events ORDER BY id DESC');
  return rows.map(row => ({
    ...row,
    distances: typeof row.distances_json === 'string' ? JSON.parse(row.distances_json) : row.distances_json,
    active: !!row.active
  }));
}

app.get('/api/health', (req, res) => res.json({ ok: true, status: 'healthy' }));

app.get('/api/events/active', asyncRoute(async (req, res) => {
  const event = await getActiveEvent();
  if (!event) return res.status(404).json({ error: 'Belum ada event aktif.' });
  res.json({
    ...event,
    distances: typeof event.distances_json === 'string' ? JSON.parse(event.distances_json) : event.distances_json,
    active: !!event.active
  });
}));

app.post('/api/admin/login', loginLimiter, asyncRoute(async (req, res) => {
  const email = text(req.body.email, 160).toLowerCase();
  const password = text(req.body.password, 200);
  const admin = await one('SELECT * FROM admins WHERE email = ?', [email]);
  if (!admin || !(await bcrypt.compare(password, admin.password_hash))) {
    return res.status(401).json({ error: 'Email atau kata sandi salah.' });
  }
  req.session.adminId = admin.id;
  req.session.save(err => {
    if (err) return res.status(500).json({ error: 'Gagal membuka sesi admin.' });
    res.json({ ok: true, email: admin.email });
  });
}));

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ ok: true }));

app.get('/api/admin/events', requireAdmin, asyncRoute(async (req, res) => {
  res.json(await eventSummary());
}));

app.post('/api/admin/events', requireAdmin, asyncRoute(async (req, res) => {
  const name = text(req.body.name, 120);
  const description = text(req.body.description, 2000);
  const startDate = text(req.body.start_date, 10);
  const endDate = text(req.body.end_date, 10);
  const registrationDeadline = text(req.body.registration_deadline, 10);
  const distances = typeof req.body.distances === 'object' && req.body.distances ? req.body.distances : {};

  if (!name || !startDate || !endDate || !registrationDeadline || !Object.keys(distances).length) {
    return res.status(400).json({ error: 'Data event tidak lengkap.' });
  }
  if (!validDate(startDate) || !validDate(endDate) || !validDate(registrationDeadline)) {
    return res.status(400).json({ error: 'Tanggal event tidak valid.' });
  }

  for (const [key, value] of Object.entries(distances)) {
    if (!key || Number(value) <= 0) {
      return res.status(400).json({ error: 'Harga jarak tidak valid.' });
    }
  }

  const slug = safeSlug(req.body.slug || name) || 'event';
  const result = await run(
    'INSERT INTO events(slug,name,description,start_date,end_date,registration_deadline,distances_json,active) VALUES(?,?,?,?,?,?,?,0)',
    [slug, name, description, startDate, endDate, registrationDeadline, JSON.stringify(distances)]
  );

  await logAudit(req.session.adminId, 'create_event', 'events', result.insertId, { name, slug });
  res.status(201).json({ ok: true, id: result.insertId });
}));

app.put('/api/admin/events/:id', requireAdmin, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const existing = await one('SELECT * FROM events WHERE id = ?', [id]);
  if (!existing) return res.status(404).json({ error: 'Event tidak ditemukan.' });

  const name = text(req.body.name, 120);
  const description = text(req.body.description, 2000);
  const startDate = text(req.body.start_date, 10);
  const endDate = text(req.body.end_date, 10);
  const registrationDeadline = text(req.body.registration_deadline, 10);
  const distances = typeof req.body.distances === 'object' && req.body.distances ? req.body.distances : {};

  if (!name || !startDate || !endDate || !registrationDeadline || !Object.keys(distances).length) {
    return res.status(400).json({ error: 'Data event tidak lengkap.' });
  }
  for (const [key, value] of Object.entries(distances)) {
    if (!key || Number(value) <= 0) {
      return res.status(400).json({ error: 'Harga jarak tidak valid.' });
    }
  }

  const slug = safeSlug(req.body.slug || name) || existing.slug;
  await run(
    'UPDATE events SET slug=?, name=?, description=?, start_date=?, end_date=?, registration_deadline=?, distances_json=? WHERE id=?',
    [slug, name, description, startDate, endDate, registrationDeadline, JSON.stringify(distances), id]
  );

  await logAudit(req.session.adminId, 'update_event', 'events', id, { slug, name });
  res.json({ ok: true });
}));

app.post('/api/admin/events/:id/activate', requireAdmin, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const event = await one('SELECT id FROM events WHERE id = ?', [id]);
  if (!event) return res.status(404).json({ error: 'Event tidak ditemukan.' });

  await run('UPDATE events SET active = CASE WHEN id = ? THEN 1 ELSE 0 END', [id]);
  await logAudit(req.session.adminId, 'activate_event', 'events', id, { active: true });
  res.json({ ok: true });
}));

app.get('/api/admin/promos', requireAdmin, asyncRoute(async (req, res) => {
  const rows = await many(`
    SELECT p.*, e.name AS event_name
    FROM promo_codes p
    LEFT JOIN events e ON e.id = p.event_id
    ORDER BY p.created_at DESC
  `);
  res.json(rows.map(row => ({
    ...row,
    active: !!row.active,
    used_count: Number(row.used_count || 0),
    usage_limit: Number(row.usage_limit || 0)
  })));
}));

app.post('/api/admin/promos', requireAdmin, asyncRoute(async (req, res) => {
  const code = normalizePromoCode(req.body.code);
  const type = String(req.body.discount_type || 'percent').toLowerCase() === 'fixed' ? 'fixed' : 'percent';
  const value = Number(req.body.discount_value || 0);
  const usageLimit = Number(req.body.usage_limit || 0);
  const eventId = req.body.event_id ? Number(req.body.event_id) : null;
  const validFrom = text(req.body.valid_from || '', 10);
  const validUntil = text(req.body.valid_until || '', 10);

  if (!code || value <= 0) {
    return res.status(400).json({ error: 'Kode promo dan nilai diskon wajib diisi.' });
  }
  if (validFrom && !validDate(validFrom)) return res.status(400).json({ error: 'Tanggal mulai promo tidak valid.' });
  if (validUntil && !validDate(validUntil)) return res.status(400).json({ error: 'Tanggal akhir promo tidak valid.' });
  if (eventId) {
    const event = await one('SELECT id FROM events WHERE id = ?', [eventId]);
    if (!event) return res.status(404).json({ error: 'Event tidak ditemukan.' });
  }

  const result = await run(
    'INSERT INTO promo_codes(code,event_id,discount_type,discount_value,usage_limit,used_count,valid_from,valid_until,active) VALUES(?,?,?,?,?,?,?,?,1)',
    [code, eventId, type, value, usageLimit, 0, validFrom || null, validUntil || null]
  );

  await logAudit(req.session.adminId, 'create_promo', 'promo_codes', result.insertId, { code, type, value });
  res.status(201).json({ ok: true, id: result.insertId });
}));

app.put('/api/admin/promos/:id', requireAdmin, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const existing = await one('SELECT * FROM promo_codes WHERE id = ?', [id]);
  if (!existing) return res.status(404).json({ error: 'Promo tidak ditemukan.' });

  const code = normalizePromoCode(req.body.code || existing.code);
  const type = String(req.body.discount_type || existing.discount_type || 'percent').toLowerCase() === 'fixed' ? 'fixed' : 'percent';
  const value = Number(req.body.discount_value || existing.discount_value || 0);
  const usageLimit = Number(req.body.usage_limit || existing.usage_limit || 0);
  const validFrom = text(req.body.valid_from || existing.valid_from || '', 10);
  const validUntil = text(req.body.valid_until || existing.valid_until || '', 10);
  const eventId = req.body.event_id ? Number(req.body.event_id) : existing.event_id;

  if (!code || value <= 0) return res.status(400).json({ error: 'Kode promo dan nilai diskon wajib diisi.' });
  if (validFrom && !validDate(validFrom)) return res.status(400).json({ error: 'Tanggal mulai promo tidak valid.' });
  if (validUntil && !validDate(validUntil)) return res.status(400).json({ error: 'Tanggal akhir promo tidak valid.' });

  await run(
    'UPDATE promo_codes SET code=?, event_id=?, discount_type=?, discount_value=?, usage_limit=?, valid_from=?, valid_until=? WHERE id=?',
    [code, eventId, type, value, usageLimit, validFrom || null, validUntil || null, id]
  );

  await logAudit(req.session.adminId, 'update_promo', 'promo_codes', id, { code, type, value });
  res.json({ ok: true });
}));

app.delete('/api/admin/promos/:id', requireAdmin, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const existing = await one('SELECT * FROM promo_codes WHERE id = ?', [id]);
  if (!existing) return res.status(404).json({ error: 'Promo tidak ditemukan.' });

  await run('DELETE FROM promo_codes WHERE id = ?', [id]);
  await logAudit(req.session.adminId, 'delete_promo', 'promo_codes', id, { code: existing.code });
  res.json({ ok: true });
}));

app.get('/api/admin/stats', requireAdmin, asyncRoute(async (req, res) => {
  const [totalRegs, totalPaid, totalPending, totalEvents, totalPromos] = await Promise.all([
    one('SELECT COUNT(*) AS total FROM registrations'),
    one('SELECT COUNT(*) AS total FROM registrations WHERE status = "paid"'),
    one('SELECT COUNT(*) AS total FROM registrations WHERE status IN ("pending","expired","failed")'),
    one('SELECT COUNT(*) AS total FROM events'),
    one('SELECT COUNT(*) AS total FROM promo_codes')
  ]);

  res.json({
    registrations: Number(totalRegs?.total || 0),
    paid: Number(totalPaid?.total || 0),
    pending: Number(totalPending?.total || 0),
    events: Number(totalEvents?.total || 0),
    promos: Number(totalPromos?.total || 0),
    generated_at: new Date().toISOString()
  });
}));

app.get('/api/admin/audit', requireAdmin, asyncRoute(async (req, res) => {
  const rows = await many(`
    SELECT l.*, a.email as admin_email
    FROM audit_logs l
    LEFT JOIN admins a ON a.id = l.admin_id
    ORDER BY l.created_at DESC
    LIMIT 100
  `);
  res.json(rows.map(row => ({
    ...row,
    details: row.details_json ? JSON.parse(row.details_json) : {}
  })));
}));

app.post('/api/registrations', asyncRoute(async (req, res) => {
  const event = await getActiveEvent();
  if (!event) return res.status(400).json({ error: 'Belum ada event aktif.' });

  const name = text(req.body.name, 100);
  const email = text(req.body.email, 160).toLowerCase();
  const phone = text(req.body.phone, 30);
  const distance = text(req.body.distance, 20);
  const shirt = text(req.body.shirt, 10) || 'M';
  const address = text(req.body.address, 300);
  const promoCode = normalizePromoCode(req.body.promo_code || req.body.promo || '');

  const prices = typeof event.distances_json === 'string' ? JSON.parse(event.distances_json) : event.distances_json;
  const originalAmount = Number(prices[distance] || 0);
  if (!name || !email || !phone || !distance || !address || !originalAmount) {
    return res.status(400).json({ error: 'Data pendaftaran tidak lengkap atau tarif tidak valid.' });
  }

  const promoResult = await applyPromoToAmount(originalAmount, promoCode, event.id);
  const code = `LB-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

  const result = await run(`
    INSERT INTO registrations(event_id, code, name, email, phone, distance, shirt, address, promo, promo_code, amount, discount_amount, final_amount, status, created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
  `, [
    event.id,
    code,
    name,
    email,
    phone,
    distance,
    shirt,
    address,
    promoCode || '',
    promoCode || null,
    originalAmount,
    promoResult.discount,
    promoResult.amount,
    'pending'
  ]);

  await logAudit(null, 'register_participant', 'registrations', result.insertId, { code, email, distance, promo_code: promoCode || null });

  res.status(201).json({
    ok: true,
    id: result.insertId,
    code,
    amount: originalAmount,
    discount: promoResult.discount,
    final_amount: promoResult.amount,
    promo_applied: !!promoResult.promo,
    status: 'pending'
  });
}));

app.get('/api/admin/registrations', requireAdmin, asyncRoute(async (req, res) => {
  const rows = await many(`
    SELECT r.*, e.name AS event_name
    FROM registrations r
    LEFT JOIN events e ON e.id = r.event_id
    ORDER BY r.created_at DESC
  `);
  res.json(rows.map(row => ({
    ...row,
    status_label: statusLabel(row.status),
    amount: Number(row.amount || 0),
    discount_amount: Number(row.discount_amount || 0),
    final_amount: Number(row.final_amount || 0)
  })));
}));

app.get('/api/admin/activities', requireAdmin, asyncRoute(async (req, res) => {
  const rows = await many(`
    SELECT a.*, r.code, r.name AS participant_name, r.email, e.name AS event_name
    FROM activities a
    JOIN registrations r ON r.id = a.registration_id
    JOIN events e ON e.id = r.event_id
    ORDER BY a.created_at DESC
  `);
  res.json(rows);
}));

app.patch('/api/admin/activities/:id', requireAdmin, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const status = text(req.body.status, 20);
  if (!['approved', 'rejected', 'submitted'].includes(status)) {
    return res.status(400).json({ error: 'Status aktivitas tidak valid.' });
  }
  await run('UPDATE activities SET status = ? WHERE id = ?', [status, id]);
  await logAudit(req.session.adminId, 'review_activity', 'activities', id, { status });
  res.json({ ok: true });
}));

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Terjadi kesalahan server.' });
});

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Premium backend ready on ${BASE_URL}`);
    });
  })
  .catch(error => {
    console.error('Database initialization failed:', error.message);
    process.exit(1);
  });
