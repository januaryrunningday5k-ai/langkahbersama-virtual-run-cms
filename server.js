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

function normalizePromoCode(value) {
  return text(value, 50).trim().toUpperCase();
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

async function resolvePromoCode(code, eventId = null) {
  const normalized = normalizePromoCode(code);
  if (!normalized) return null;
  const promo = await one(`
    SELECT * FROM promo_codes
    WHERE UPPER(code) = ?
      AND active = 1
      AND (valid_from IS NULL OR valid_from <= CURDATE())
      AND (valid_until IS NULL OR valid_until >= CURDATE())
      AND (event_id IS NULL OR event_id = ?)
  `, [normalized, eventId]);
  if (!promo) return null;
  const usageLimit = Number(promo.usage_limit || 0);
  if (usageLimit > 0 && Number(promo.used_count || 0) >= usageLimit) return null;
  return promo;
}

async function applyPromoToAmount(amount, promoCode, eventId = null) {
  const amountValue = Number(amount || 0);
  if (!promoCode || amountValue <= 0) return { amount: amountValue, discount: 0, promo: null };
  const promo = await resolvePromoCode(promoCode, eventId);
  if (!promo) return { amount: amountValue, discount: 0, promo: null };
  let discount = 0;
  if (String(promo.discount_type || 'percent').toLowerCase() === 'fixed') {
    discount = Math.min(amountValue, Number(promo.discount_value || 0));
  } else {
    discount = Math.round(amountValue * (Number(promo.discount_value || 0) / 100));
  }
  const finalAmount = Math.max(0, amountValue - discount);
  await run('UPDATE promo_codes SET used_count = used_count + 1 WHERE id = ?', [promo.id]);
  return { amount: finalAmount, discount, promo };
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS site_benefits (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(120) NOT NULL,
      description TEXT NOT NULL,
      icon VARCHAR(60) NOT NULL DEFAULT '🏅',
      image_path VARCHAR(255) NULL,
      type VARCHAR(30) NOT NULL DEFAULT 'general',
      sort_order INT NOT NULL DEFAULT 0,
      active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_site_benefits_type_active (type, active, sort_order)
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
  for (const statement of schema) await pool.query(statement);

  const migrationStatements = [
    `ALTER TABLE registrations ADD COLUMN IF NOT EXISTS promo_code VARCHAR(50) NULL AFTER promo`,
    `ALTER TABLE registrations ADD COLUMN IF NOT EXISTS discount_amount BIGINT NOT NULL DEFAULT 0 AFTER amount`,
    `ALTER TABLE registrations ADD COLUMN IF NOT EXISTS final_amount BIGINT NOT NULL DEFAULT 0 AFTER discount_amount`
  ];
  for (const statement of migrationStatements) {
    try { await pool.query(statement); } catch (_) {}
  }

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
  if (!(await one('SELECT id FROM site_benefits LIMIT 1'))) {
    await run(`INSERT INTO site_benefits(title, description, icon, type, sort_order, active)
      VALUES
      (?, ?, '🏅', 'general', 1, 1),
      (?, ?, '🎽', 'racepack', 2, 1),
      (?, ?, '📈', 'general', 3, 1),
      (?, ?, '🔗', 'general', 4, 1)`, [
      'Finisher rewards', 'Peserta yang menyelesaikan jarak dan memenuhi syarat dapat menerima medali, sertifikat, dan hadiah finisher yang dijadwalkan panitia.',
      'Medali & e-certificate', 'Bukti finish dan hasil aktivitas peserta tercatat dengan aman dan bisa diverifikasi oleh panitia.',
      'Race pack', 'Setiap pendaftaran masuk dapat menerima race pack siap kirim, termasuk nomor bib digital, kaos, dan item event sesuai kategori.',
      'Aktivitas terpantau', 'Pantau progres lari langsung dari dashboard peserta dan hubungkan Strava untuk sinkronisasi otomatis.',
    ]);
  }
}

const MySQLStore = MySQLStoreFactory(session);
