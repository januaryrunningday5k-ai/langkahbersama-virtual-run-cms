const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const MySQLStoreFactory = require('express-mysql-session');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const isProduction = process.env.NODE_ENV === 'production';
const SESSION_MAX_AGE = 1000 * 60 * 60 * 8;
fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET must be a unique random value of at least 32 characters.');
if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 12) throw new Error('Set ADMIN_EMAIL and an ADMIN_PASSWORD of at least 12 characters.');
if (!process.env.DB_NAME || !process.env.DB_USER || !process.env.DB_PASSWORD) throw new Error('Set DB_NAME, DB_USER and DB_PASSWORD for MySQL.');

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 5),
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
      amount BIGINT NOT NULL DEFAULT 0,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      payment_session_id VARCHAR(255) NULL,
      ticket_pdf_path VARCHAR(255) NULL,
      ticket_sent_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      strava_athlete_id VARCHAR(255) NULL,
      strava_access_token TEXT NULL,
      strava_refresh_token TEXT NULL,
      strava_expires_at BIGINT NULL,
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
    `CREATE TABLE IF NOT EXISTS oauth_states (
      state VARCHAR(255) NOT NULL PRIMARY KEY,
      registration_id BIGINT UNSIGNED NOT NULL,
      expires_at BIGINT NOT NULL,
      CONSTRAINT fk_oauth_registration FOREIGN KEY (registration_id) REFERENCES registrations(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS participant_tokens (
      token_hash CHAR(64) NOT NULL PRIMARY KEY,
      registration_id BIGINT UNSIGNED NOT NULL,
      expires_at BIGINT NOT NULL,
      used_at BIGINT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_tokens_registration FOREIGN KEY (registration_id) REFERENCES registrations(id),
      INDEX idx_participant_tokens_expiry (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS ticket_mail_jobs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      registration_id BIGINT UNSIGNED NOT NULL UNIQUE,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      attempts INT NOT NULL DEFAULT 0,
      next_attempt_at BIGINT NOT NULL DEFAULT 0,
      last_error VARCHAR(500) NULL,
      sent_at DATETIME NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_mail_jobs_registration FOREIGN KEY (registration_id) REFERENCES registrations(id),
      INDEX idx_mail_jobs_status (status, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  ];
  for (const statement of schema) await pool.query(statement);

  const adminEmail = process.env.ADMIN_EMAIL.trim().toLowerCase();
  if (!(await one('SELECT id FROM admins WHERE email = ?', [adminEmail]))) {
    await run('INSERT INTO admins(email, password_hash) VALUES(?, ?)', [adminEmail, await bcrypt.hash(process.env.ADMIN_PASSWORD, 12)]);
  }
  if (!(await one('SELECT id FROM events LIMIT 1'))) {
    const date = days => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await run(`INSERT INTO events(slug,name,description,start_date,end_date,registration_deadline,distances_json,active)
      VALUES(?,?,?,?,?,?,?,1)`, [
      'langkahbersama-virtual-run',
      'LangkahBersama Virtual Run',
      'Ikuti tantangan lari virtual dari mana saja.',
      date(7), date(30), date(5),
      JSON.stringify({ '5K': 150000, '10K': 250000, '21K': 350000, '42K': 550000 })
    ]);
  }
}

const MySQLStore = MySQLStoreFactory(session);
const sessionStore = new MySQLStore({ ...dbConfig, clearExpired: true, checkExpirationInterval: 15 * 60 * 1000 });
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"], baseUri: ["'self'"], formAction: ["'self'"],
      frameAncestors: ["'none'"], objectSrc: ["'none'"],
      scriptSrc: ["'self'", "'unsafe-inline'"], styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'], fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'https://api.open-meteo.com'], mediaSrc: ["'self'"], childSrc: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false,
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

const publicApiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Terlalu banyak permintaan. Silakan coba lagi nanti.' } });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Login dibatasi sementara. Coba lagi nanti.' } });
const accessLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Terlalu banyak permintaan akses tiket. Silakan tunggu.' } });
app.use('/api/', publicApiLimiter);

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
let mailer = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

function text(v, n = 250) {
  if (typeof v !== 'string') return '';
  return v.replace(/\0/g, '').trim().slice(0, n);
}
function code(v) { return text(v, 30).toUpperCase(); }
function makeCode() { return `LB-${crypto.randomBytes(6).toString('hex').toUpperCase()}`; }
function safeSlug(v) { return text(v, 100).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function validDate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)); }
function eventView(row) {
  const distances = typeof row.distances_json === 'string' ? JSON.parse(row.distances_json) : row.distances_json;
  return { ...row, distances, active: !!row.active };
}
function requireAdmin(req, res, next) {
  if (!req.session.adminId) return res.status(401).json({ error: 'Silakan masuk sebagai admin.' });
  next();
}
async function participant(req, res, next) {
  try {
    const r = await one("SELECT id FROM registrations WHERE code=? AND status='paid'", [code(req.params.code)]);
    if (!r) return res.status(404).json({ error: 'Tiket tidak ditemukan atau belum dibayar.' });
    req.registrationId = r.id;
    next();
  } catch (error) { next(error); }
}
async function requireParticipantCode(req, res, next) {
  try {
    const r = await one("SELECT id FROM registrations WHERE code=? AND status='paid'", [code(req.params.code)]);
    if (!r) return res.sendStatus(404);
    if (!req.session?.participantRegistrationId || String(req.session.participantRegistrationId) !== String(r.id)) {
      return res.status(401).json({ error: 'Verifikasi peserta diperlukan.' });
    }
    next();
  } catch (error) { next(error); }
}

async function ticketBuffer(reg) {
  const event = await one('SELECT name,start_date,end_date FROM events WHERE id=?', [reg.event_id]);
  const qr = await QRCode.toBuffer(`${BASE_URL}/track/${reg.code}`, { errorCorrectionLevel: 'M', margin: 1, width: 180 });
  const pdf = new PDFDocument({ size: 'A5', margin: 36 });
  const chunks = [];
  pdf.on('data', chunk => chunks.push(chunk));
  pdf.fontSize(20).text(event?.name || 'Virtual Run Ticket', { align: 'center' });
  pdf.moveDown();
  pdf.fontSize(12).text(`Kode tiket: ${reg.code}`);
  pdf.text(`Nama: ${reg.name}`);
  pdf.text(`Email: ${reg.email}`);
  pdf.text(`Jarak: ${reg.distance}`);
  pdf.text(`Event: ${event.start_date} — ${event.end_date}`);
  pdf.moveDown();
  pdf.image(qr, { fit: [120, 120], align: 'center' });
  pdf.text(`Pantau aktivitas: ${BASE_URL}/track/${reg.code}`, { align: 'center' });
  pdf.end();
  await new Promise((resolve, reject) => { pdf.on('end', resolve); pdf.on('error', reject); });
  return Buffer.concat(chunks);
}
async function enqueueTicket(registrationId) {
  await run(`INSERT INTO ticket_mail_jobs(registration_id,status,attempts,next_attempt_at,last_error,sent_at,updated_at)
    VALUES(?,'pending',0,0,NULL,NULL,CURRENT_TIMESTAMP) ON DUPLICATE KEY UPDATE registration_id=VALUES(registration_id)`, [registrationId]);
}
async function deliverTicket(reg) {
  if (!mailer) throw new Error('SMTP is not configured');
  const pdf = await ticketBuffer(reg);
  await mailer.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: reg.email,
    subject: 'Tiket Anda — LangkahBersama Virtual Run',
    text: `Halo ${reg.name},\n\nTiket Anda sudah aktif. Silakan buka link di bawah ini untuk melacak aktivitas Anda.\n\n${BASE_URL}/track/${reg.code}\n\nTerima kasih.`,
    attachments: [{ filename: `tiket-${reg.code}.pdf`, content: pdf, contentType: 'application/pdf' }]
  });
  await run('UPDATE registrations SET ticket_sent_at=CURRENT_TIMESTAMP WHERE id=?', [reg.id]);
  await run("UPDATE ticket_mail_jobs SET status='sent', attempts=attempts+1, sent_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP, last_error=NULL WHERE registration_id=?", [reg.id]);
}
let mailWorkerBusy = false;
async function processMailQueue() {
  if (mailWorkerBusy || !mailer) return;
  mailWorkerBusy = true;
  try {
    const job = await one("SELECT id,registration_id,attempts FROM ticket_mail_jobs WHERE status IN ('pending','failed') AND next_attempt_at<=? ORDER BY id LIMIT 1", [Date.now()]);
    if (!job) return;
    const reg = await one('SELECT * FROM registrations WHERE id=?', [job.registration_id]);
    if (!reg) { await run('DELETE FROM ticket_mail_jobs WHERE id=?', [job.id]); return; }
    try { await deliverTicket(reg); }
    catch (error) {
      const attempts = job.attempts + 1;
      const nextDelay = Math.min(60 * 60 * 1000, 1000 * 60 * Math.pow(2, attempts - 1));
      await run("UPDATE ticket_mail_jobs SET status='failed', attempts=?, next_attempt_at=?, last_error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?", [attempts, Date.now() + nextDelay, String(error.message || error).slice(0, 500), job.id]);
    }
  } catch (error) { console.error('Ticket mail queue error:', error); }
  finally { mailWorkerBusy = false; }
}
setInterval(processMailQueue, 5000).unref();

app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), asyncRoute(async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.sendStatus(503);
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET); }
  catch (error) { console.error('Stripe signature verification failed:', error.message); return res.status(400).send(`Webhook Error: ${error.message}`); }
  if (event.type === 'checkout.session.completed') {
    const checkout = event.data.object;
    const registration = await one('SELECT * FROM registrations WHERE payment_session_id=?', [checkout.id]);
    if (registration) {
      await run("UPDATE registrations SET status='paid', payment_session_id=? WHERE id=?", [checkout.id, registration.id]);
      await enqueueTicket(registration.id);
    }
  } else if (event.type === 'checkout.session.expired') {
    await run("UPDATE registrations SET status='expired' WHERE payment_session_id=?", [event.data.object.id]);
  }
  return res.json({ received: true });
}));

app.use(express.json({ limit: '30kb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.get('/api/events/active', asyncRoute(async (req, res) => {
  const e = await one('SELECT * FROM events WHERE active=1 ORDER BY id DESC LIMIT 1');
  if (!e) return res.status(404).json({ error: 'Belum ada event aktif.' });
  res.json(eventView(e));
}));

app.post('/api/registrations', asyncRoute(async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Pembayaran online belum dikonfigurasi.' });
  const event = await one('SELECT * FROM events WHERE id=? AND active=1', [Number(req.body.event_id)]);
  if (!event) return res.status(400).json({ error: 'Event tidak valid atau belum aktif.' });
  const name = text(req.body.name, 100);
  const email = text(req.body.email, 160).toLowerCase();
  const phone = text(req.body.phone, 30);
  const distance = text(req.body.distance, 20);
  const shirt = text(req.body.shirt, 10) || 'M';
  const address = text(req.body.address, 300);
  const promo = text(req.body.promo, 30);
  const prices = typeof event.distances_json === 'string' ? JSON.parse(event.distances_json || '{}') : event.distances_json;
  const amount = Number(prices[distance] || 0);
  if (!name || !email || !phone || !distance || !address || !amount) return res.status(400).json({ error: 'Data pendaftaran tidak lengkap atau tarif tidak valid.' });
  const regCode = makeCode();
  const result = await run(`INSERT INTO registrations(event_id,code,name,email,phone,distance,shirt,address,promo,amount,status,payment_session_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,CURRENT_TIMESTAMP)`, [event.id, regCode, name, email, phone, distance, shirt, address, promo, amount, 'pending']);
  try {
    const checkout = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price_data: { currency: 'idr', product_data: { name: `${event.name} — ${distance}` }, unit_amount: amount }, quantity: 1 }],
      success_url: `${BASE_URL}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/?payment=cancelled`, customer_email: email,
      metadata: { registration_id: String(result.insertId), code: regCode },
      expires_at: Math.round(Date.now() / 1000) + 1800, payment_method_types: ['card']
    });
    await run('UPDATE registrations SET payment_session_id=? WHERE id=?', [checkout.id, result.insertId]);
    return res.json({ ok: true, sessionId: checkout.id, url: checkout.url });
  } catch (error) {
    await run('DELETE FROM registrations WHERE id=?', [result.insertId]);
    console.error('Stripe checkout creation failed:', error.message);
    return res.status(500).json({ error: 'Gagal membuat sesi pembayaran. Silakan coba lagi.' });
  }
}));

app.get('/api/payment-status', asyncRoute(async (req, res) => {
  if (!stripe || !req.query.session_id) return res.status(400).json({ error: 'Sesi tidak valid.' });
  try {
    const checkout = await stripe.checkout.sessions.retrieve(text(req.query.session_id, 200));
    const registration = await one('SELECT * FROM registrations WHERE payment_session_id=?', [checkout.id]);
    return res.json({ paid: Boolean(checkout.payment_status === 'paid' || registration?.status === 'paid'), sessionId: checkout.id, amount_total: checkout.amount_total || 0 });
  } catch { return res.status(400).json({ error: 'Sesi tidak ditemukan atau tidak valid.' }); }
}));
app.get('/api/tickets/:code.pdf', asyncRoute(async (req, res) => {
  const r = await one("SELECT * FROM registrations WHERE code=? AND status='paid'", [code(req.params.code)]);
  if (!r) return res.status(404).send('Tiket tidak ditemukan atau belum dibayar.');
  try {
    const pdf = await ticketBuffer(r);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="ticket-${r.code}.pdf"`);
    return res.send(pdf);
  } catch (error) { console.error('Ticket generation failed:', error.message); return res.status(500).send('Gagal membuat tiket.'); }
}));

app.post('/api/track/request-access', accessLimiter, asyncRoute(async (req, res) => {
  const c = code(req.body.code);
  const email = text(req.body.email, 160).toLowerCase();
  const r = await one('SELECT id,email FROM registrations WHERE code=?', [c]);
  if (!r || r.email !== email) return res.status(404).json({ error: 'Kode tiket atau email tidak cocok.' });
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = Date.now() + 1000 * 60 * 15;
  await run('INSERT INTO participant_tokens(token_hash,registration_id,expires_at,created_at) VALUES(?,?,?,CURRENT_TIMESTAMP)', [tokenHash, r.id, expiresAt]);
  const link = `${BASE_URL}/track/${c}?token=${encodeURIComponent(rawToken)}`;
  if (mailer) await mailer.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to: email, subject: 'Link akses pantauan aktivitas', text: `Klik tautan berikut untuk melihat pantauan aktivitas Anda:\n\n${link}\n\nTautan berlaku 15 menit.` });
  return res.json({ ok: true, message: 'Link akses telah dikirim ke email Anda.' });
}));
app.get('/api/track/verify', asyncRoute(async (req, res) => {
  const raw = text(req.query.token, 100);
  if (!raw) return res.status(400).json({ error: 'Token tidak valid.' });
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const token = await one('SELECT * FROM participant_tokens WHERE token_hash=? AND expires_at>? AND used_at IS NULL', [hash, Date.now()]);
  if (!token) return res.status(400).json({ error: 'Token sudah kadaluarsa atau tidak valid.' });
  const reg = await one('SELECT id,code FROM registrations WHERE id=?', [token.registration_id]);
  if (!reg) return res.status(404).json({ error: 'Peserta tidak ditemukan.' });
  req.session.participantRegistrationId = reg.id;
  await run('UPDATE participant_tokens SET used_at=? WHERE token_hash=?', [Date.now(), hash]);
  return res.redirect(`/track/${reg.code}`);
}));
app.post('/api/track/:code/logout', participant, (req, res) => { delete req.session.participantRegistrationId; res.json({ ok: true }); });
app.get('/track/:code', (req, res) => res.sendFile(path.join(ROOT, 'public', 'track.html')));
app.get('/api/track/:code', participant, asyncRoute(async (req, res) => {
  const r = await one('SELECT r.code,r.name,r.distance,r.status,e.name AS event_name,e.start_date,e.end_date FROM registrations r JOIN events e ON e.id=r.event_id WHERE r.id=?', [req.registrationId]);
  if (!r) return res.status(404).json({ error: 'Tiket tidak ditemukan.' });
  const activities = await many('SELECT * FROM activities WHERE registration_id=? ORDER BY created_at DESC', [req.registrationId]);
  res.json({ ...r, activities, stravaConfigured: Boolean(process.env.STRAVA_CLIENT_ID && process.env.STRAVA_CLIENT_SECRET) });
}));

const upload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.pdf'].includes(ext)) return cb(new Error('Format file tidak didukung.'));
    cb(null, true);
  }
});
function detectFile(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { ext: '.jpg', mime: 'image/jpeg' };
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: '.png', mime: 'image/png' };
  if (buffer.length >= 5 && buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) return { ext: '.pdf', mime: 'application/pdf' };
  return null;
}
app.post('/api/track/:code/upload', participant, upload.single('proof'), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Pilih bukti aktivitas.' });
  const detected = detectFile(req.file.buffer);
  if (!detected) return res.status(400).json({ error: 'File bukti tidak valid.' });
  if (req.file.mimetype && !['image/jpeg', 'image/png', 'application/pdf'].includes(req.file.mimetype)) return res.status(400).json({ error: 'Jenis file tidak diizinkan.' });
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${detected.ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), req.file.buffer, { mode: 0o600 });
  await run("INSERT INTO activities(registration_id,source,proof_path,status,created_at) VALUES(?,'upload',?,'submitted',CURRENT_TIMESTAMP)", [req.registrationId, filename]);
  return res.json({ ok: true, message: 'Bukti aktivitas berhasil dikirim.' });
}));
app.get('/uploads/:filename', requireAdmin, asyncRoute(async (req, res) => {
  const filename = path.basename(req.params.filename);
  if (!(await one('SELECT id FROM activities WHERE proof_path=?', [filename]))) return res.sendStatus(404);
  res.sendFile(path.join(UPLOAD_DIR, filename));
}));

app.get('/api/strava/connect/:code', asyncRoute(async (req, res) => {
  if (!process.env.STRAVA_CLIENT_ID || !process.env.STRAVA_CLIENT_SECRET) return res.status(503).send('Strava belum dikonfigurasi.');
  const r = await one("SELECT id FROM registrations WHERE code=? AND status='paid'", [code(req.params.code)]);
  if (!r) return res.status(404).send('Tiket tidak ditemukan.');
  const state = crypto.randomBytes(16).toString('hex');
  await run('INSERT INTO oauth_states(state,registration_id,expires_at) VALUES(?,?,?)', [state, r.id, Date.now() + 1000 * 60 * 10]);
  const params = new URLSearchParams({ client_id: process.env.STRAVA_CLIENT_ID, response_type: 'code', redirect_uri: `${BASE_URL}/api/strava/callback`, approval_prompt: 'auto', scope: 'read,activity:read_all', state });
  return res.redirect(`https://www.strava.com/oauth/authorize?${params.toString()}`);
}));
app.get('/api/strava/callback', asyncRoute(async (req, res) => {
  const state = text(req.query.state, 100);
  const saved = await one('SELECT * FROM oauth_states WHERE state=? AND expires_at>?', [state, Date.now()]);
  if (!saved) return res.status(400).send('Sesi Strava tidak valid atau sudah kedaluwarsa.');
  const codeStr = text(req.query.code, 200);
  if (!codeStr) return res.status(400).send('Tidak ada kode oauth Strava.');
  try {
    const result = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: process.env.STRAVA_CLIENT_ID, client_secret: process.env.STRAVA_CLIENT_SECRET, code: codeStr, grant_type: 'authorization_code' })
    });
    const data = await result.json();
    if (!result.ok) throw new Error(data.errors?.[0]?.message || 'Strava auth failed');
    await run('UPDATE registrations SET strava_access_token=?,strava_refresh_token=?,strava_athlete_id=?,strava_expires_at=? WHERE id=?', [data.access_token, data.refresh_token, String(data.athlete?.id || ''), Date.now() + (data.expires_in || 0) * 1000, saved.registration_id]);
    await run('DELETE FROM oauth_states WHERE state=?', [state]);
    const reg = await one('SELECT code FROM registrations WHERE id=?', [saved.registration_id]);
    return res.redirect(`${BASE_URL}/track/${reg.code}?strava=connected`);
  } catch (error) { console.error('Strava callback failed:', error); return res.status(500).send('Gagal menghubungkan Strava.'); }
}));
app.post('/api/strava/sync/:code', requireParticipantCode, asyncRoute(async (req, res) => {
  const reg = await one('SELECT r.*,e.start_date,e.end_date FROM registrations r JOIN events e ON e.id=r.event_id WHERE r.code=?', [code(req.params.code)]);
  if (!reg || !reg.strava_access_token) return res.status(400).json({ error: 'Strava belum terhubung.' });
  try {
    const url = new URL('https://www.strava.com/api/v3/athlete/activities');
    url.searchParams.set('per_page', '30');
    const response = await fetch(url, { headers: { Authorization: `Bearer ${reg.strava_access_token}` } });
    if (!response.ok) throw new Error('Strava sync failed');
    const activities = await response.json();
    let imported = 0;
    for (const item of activities) {
      const existing = await one('SELECT id FROM activities WHERE external_id=? AND registration_id=?', [String(item.id), reg.id]);
      if (!existing && item.distance && Number(item.distance) > 0) {
        await run("INSERT INTO activities(registration_id,source,external_id,distance_m,activity_date,status,created_at) VALUES(?,'strava',?,?,?,'submitted',CURRENT_TIMESTAMP)", [reg.id, String(item.id), Math.round(Number(item.distance)), item.start_date_local || new Date(item.start_date).toISOString().slice(0, 10)]);
        imported++;
      }
    }
    return res.json({ ok: true, imported });
  } catch (error) { console.error('Strava sync error:', error); return res.status(500).json({ error: 'Sinkronisasi Strava gagal.' }); }
}));

app.get('/admin', (req, res) => res.sendFile(path.join(ROOT, 'public', 'admin.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(ROOT, 'public', 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(ROOT, 'public', 'terms.html')));
app.post('/api/admin/login', loginLimiter, asyncRoute(async (req, res) => {
  const email = text(req.body.email, 160).toLowerCase();
  const pass = text(req.body.password, 200);
  const admin = await one('SELECT * FROM admins WHERE email=?', [email]);
  if (!admin || !(await bcrypt.compare(pass, admin.password_hash))) return res.status(401).json({ error: 'Email atau kata sandi salah.' });
  req.session.adminId = admin.id;
  req.session.save(err => { if (err) return res.status(500).json({ error: 'Gagal masuk.' }); res.json({ ok: true }); });
}));
app.post('/api/admin/logout', requireAdmin, (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ ok: true }));
app.get('/api/admin/events', requireAdmin, asyncRoute(async (req, res) => res.json((await many('SELECT * FROM events ORDER BY id DESC')).map(eventView))));

function validateEvent(body) {
  const name = text(body.name, 120);
  const slug = safeSlug(body.slug || body.name);
  const start = text(body.start_date, 10);
  const end = text(body.end_date, 10);
  const deadline = text(body.registration_deadline, 10);
  const description = text(body.description, 2000);
  const distances = typeof body.distances === 'object' && body.distances ? body.distances : {};
  if (!name || !start || !end || !deadline || !Object.keys(distances).length) throw new Error('Data event tidak lengkap.');
  for (const [key, value] of Object.entries(distances)) if (!key || Number(value) <= 0) throw new Error('Harga jarak tidak valid.');
  if (!validDate(start) || !validDate(end) || !validDate(deadline)) throw new Error('Tanggal event tidak valid.');
  return { name, slug, start, end, deadline, description, distances };
}
app.post('/api/admin/events', requireAdmin, asyncRoute(async (req, res) => {
  try {
    const x = validateEvent(req.body);
    const result = await run('INSERT INTO events(slug,name,description,start_date,end_date,registration_deadline,distances_json,active) VALUES(?,?,?,?,?,?,?,0)', [x.slug || 'event', x.name, x.description, x.start, x.end, x.deadline, JSON.stringify(x.distances)]);
    res.status(201).json({ ok: true, id: result.insertId });
  } catch (error) { res.status(400).json({ error: error.message || 'Event tidak valid.' }); }
}));
app.put('/api/admin/events/:id', requireAdmin, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  if (!(await one('SELECT id FROM events WHERE id=?', [id]))) return res.sendStatus(404);
  try {
    const x = validateEvent(req.body);
    await run('UPDATE events SET slug=?,name=?,description=?,start_date=?,end_date=?,registration_deadline=?,distances_json=? WHERE id=?', [x.slug || 'event', x.name, x.description, x.start, x.end, x.deadline, JSON.stringify(x.distances), id]);
    res.json({ ok: true });
  } catch (error) { res.status(400).json({ error: error.message || 'Event tidak valid.' }); }
}));
app.post('/api/admin/events/:id/activate', requireAdmin, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  if (!(await one('SELECT id FROM events WHERE id=?', [id]))) return res.sendStatus(404);
  await run('UPDATE events SET active = CASE WHEN id = ? THEN 1 ELSE 0 END', [id]);
  res.json({ ok: true });
}));
app.get('/api/admin/registrations', requireAdmin, asyncRoute(async (req, res) => res.json(await many('SELECT r.id,r.code,r.name,r.email,r.phone,r.distance,r.amount,r.status,r.ticket_sent_at,r.created_at,e.name AS event_name FROM registrations r JOIN events e ON e.id=r.event_id ORDER BY r.id DESC'))));
app.get('/api/admin/activities', requireAdmin, asyncRoute(async (req, res) => res.json(await many('SELECT a.*,r.code,r.name,r.email,e.name AS event_name FROM activities a JOIN registrations r ON r.id=a.registration_id JOIN events e ON e.id=r.event_id ORDER BY a.id DESC'))));
app.patch('/api/admin/activities/:id', requireAdmin, asyncRoute(async (req, res) => {
  const status = text(req.body.status, 20);
  if (!['approved', 'rejected', 'submitted'].includes(status)) return res.status(400).json({ error: 'Status aktivitas tidak valid.' });
  await run('UPDATE activities SET status=? WHERE id=?', [status, Number(req.params.id)]);
  res.json({ ok: true });
}));
app.get('/api/admin/ticket-jobs', requireAdmin, asyncRoute(async (req, res) => res.json(await many('SELECT j.id,j.registration_id,j.status,j.attempts,j.next_attempt_at,j.last_error,j.sent_at,r.code,r.name,r.email FROM ticket_mail_jobs j JOIN registrations r ON r.id=j.registration_id ORDER BY j.id DESC'))));
app.post('/api/admin/tickets/:code/resend', requireAdmin, asyncRoute(async (req, res) => {
  const reg = await one("SELECT * FROM registrations WHERE code=? AND status='paid'", [code(req.params.code)]);
  if (!reg) return res.status(404).json({ error: 'Tiket tidak ditemukan.' });
  try { await deliverTicket(reg); return res.json({ ok: true }); }
  catch (error) { return res.status(500).json({ error: error.message || 'Pengiriman ulang tiket gagal.' }); }
}));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Ukuran file maksimal 8 MB.' : 'Upload tidak valid.' });
  if (err) {
    console.error('Unhandled error:', err);
    return res.status(500).json({ error: 'Terjadi kesalahan server.' });
  }
  next();
});
app.use(express.static(path.join(ROOT, 'public')));

initializeDatabase().then(() => {
  app.listen(PORT, () => console.log(`Virtual Run CMS listening on ${BASE_URL}`));
}).catch(async error => {
  console.error('MySQL initialization failed:', error.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
