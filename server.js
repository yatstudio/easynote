import express from 'express';
import pg from 'pg';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);
const pickEnv = (...names) => names.map(name => process.env[name]).find(Boolean);
const databaseUrl = pickEnv(
  'DATABASE_URL',
  'POSTGRES_URL',
  'POSTGRES_PRISMA_URL',
  'POSTGRES_CONNECTION_STRING',
  'POSTGRES_CONNECTION_URL',
  'POSTGRES_URI',
  'POSTGRESQL_URL',
  'POSTGRESQL_URI',
  'POSTGRESQL_DATABASE_URL',
  'ZEABUR_POSTGRESQL_URL',
  'ZEABUR_POSTGRESQL_CONNECTION_STRING',
  'PG_URL'
);
const pgHost = pickEnv('PGHOST', 'POSTGRES_HOST', 'POSTGRESQL_HOST', 'DB_HOST');
const pgPort = pickEnv('PGPORT', 'POSTGRES_PORT', 'POSTGRESQL_PORT', 'DB_PORT') || 5432;
const pgUser = pickEnv('PGUSER', 'POSTGRES_USER', 'POSTGRES_USERNAME', 'POSTGRESQL_USER', 'POSTGRESQL_USERNAME', 'DB_USER', 'DB_USERNAME');
const pgPassword = pickEnv('PGPASSWORD', 'POSTGRES_PASSWORD', 'POSTGRESQL_PASSWORD', 'DB_PASSWORD');
const pgDatabase = pickEnv('PGDATABASE', 'POSTGRES_DATABASE', 'POSTGRES_DB', 'POSTGRESQL_DATABASE', 'POSTGRESQL_DB', 'DB_DATABASE', 'DB_NAME');
const hasPgEnv = pgHost && pgUser && pgPassword && pgDatabase;
const sslConfig = pickEnv('PGSSLMODE', 'POSTGRES_SSLMODE') === 'require' ? { rejectUnauthorized: false } : undefined;
const pool = databaseUrl
  ? new Pool({ connectionString: databaseUrl, ssl: sslConfig })
  : hasPgEnv
    ? new Pool({
        host: pgHost,
        port: Number(pgPort),
        user: pgUser,
        password: pgPassword,
        database: pgDatabase,
        ssl: sslConfig
      })
    : null;

const sessions = new Map();
let dbReady = false;
let dbInitError = null;

// Rate limiting for brute-force protection
const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 5; // Max password attempts per IP per window

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() ||
         req.headers['x-real-ip'] ||
         req.connection?.remoteAddress ||
         req.socket?.remoteAddress ||
         'unknown';
}

function checkRateLimit(ip) {
  const now = Date.now();
  const record = rateLimitStore.get(ip);

  if (!record) {
    rateLimitStore.set(ip, { attempts: 1, firstAttempt: now, blockedUntil: null });
    return { allowed: true, remainingAttempts: MAX_ATTEMPTS - 1 };
  }

  // Check if still blocked
  if (record.blockedUntil && now < record.blockedUntil) {
    const waitSeconds = Math.ceil((record.blockedUntil - now) / 1000);
    return { allowed: false, remainingAttempts: 0, waitSeconds };
  }

  // Reset if window expired
  if (now - record.firstAttempt > RATE_LIMIT_WINDOW) {
    rateLimitStore.set(ip, { attempts: 1, firstAttempt: now, blockedUntil: null });
    return { allowed: true, remainingAttempts: MAX_ATTEMPTS - 1 };
  }

  // Increment attempts
  record.attempts++;

  if (record.attempts > MAX_ATTEMPTS) {
    record.blockedUntil = now + RATE_LIMIT_WINDOW;
    const waitSeconds = Math.ceil(RATE_LIMIT_WINDOW / 1000);
    return { allowed: false, remainingAttempts: 0, waitSeconds };
  }

  return { allowed: true, remainingAttempts: MAX_ATTEMPTS - record.attempts };
}

function resetRateLimit(ip) {
  rateLimitStore.delete(ip);
}

// Clean up old rate limit records every hour
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimitStore.entries()) {
    if (now - record.firstAttempt > RATE_LIMIT_WINDOW && (!record.blockedUntil || now > record.blockedUntil)) {
      rateLimitStore.delete(ip);
    }
  }
}, 60 * 60 * 1000);

app.use(express.json({ limit: '15mb' }));
app.use(express.static(__dirname));

app.get('/health', (req, res) => {
  res.json({ ok: true, database: pool ? (dbReady ? 'ready' : 'starting') : 'not_configured' });
});

app.get('/ready', asyncRoute(async (req, res) => {
  if (!pool) return res.status(503).json({ ok: false, database: 'not_configured' });
  await ensureDb();
  res.json({ ok: true, database: 'connected' });
}));

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function token() {
  return crypto.randomBytes(32).toString('hex');
}

function uuid() {
  return crypto.randomUUID();
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function requireDb(req, res, next) {
  if (!pool) return res.status(503).json({ error: 'database_not_configured' });
  next();
}

function requireSession(req, res, next) {
  const auth = req.headers.authorization || '';
  const raw = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const session = sessions.get(raw);
  if (!session) return res.status(401).json({ error: 'locked' });
  req.vaultId = session.vaultId;
  req.sessionToken = raw;
  next();
}

function sanitizeNote(row) {
  return {
    id: row.id,
    title: row.title,
    html: row.html,
    plain: row.plain,
    pinned: row.pinned,
    deleted: row.deleted,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    media: row.media || { images: 0, links: 0, files: 0 }
  };
}

async function ensureDb() {
  if (dbReady) return;
  if (!pool) throw new Error('Database is not configured');
  await initDb();
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vaults (
      id UUID PRIMARY KEY,
      password_hash TEXT UNIQUE NOT NULL,
      settings JSONB NOT NULL DEFAULT '{"autoLock":15,"theme":"system"}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS notes (
      id UUID PRIMARY KEY,
      vault_id UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '新备忘录',
      html TEXT NOT NULL DEFAULT '<p>开始记录文字，或插入图片、链接、附件、待办清单。</p>',
      plain TEXT NOT NULL DEFAULT '',
      pinned BOOLEAN NOT NULL DEFAULT FALSE,
      deleted BOOLEAN NOT NULL DEFAULT FALSE,
      media JSONB NOT NULL DEFAULT '{"images":0,"links":0,"files":0}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  dbReady = true;
  dbInitError = null;
}

app.post('/api/vault/open', requireDb, asyncRoute(async (req, res) => {
  await ensureDb();

  const clientIp = getClientIp(req);
  const rateCheck = checkRateLimit(clientIp);

  if (!rateCheck.allowed) {
    return res.status(429).json({
      error: 'rate_limit_exceeded',
      message: 'Too many password attempts. Please try again later.',
      waitSeconds: rateCheck.waitSeconds
    });
  }

  const password = String(req.body.password || '');
  if (password.length < 4) return res.status(400).json({ error: 'password_too_short' });

  const passwordHash = sha256(password);
  let result = await pool.query('SELECT * FROM vaults WHERE password_hash = $1', [passwordHash]);
  let vault = result.rows[0];

  if (!vault) {
    result = await pool.query(
      'INSERT INTO vaults (id, password_hash) VALUES ($1, $2) RETURNING *',
      [uuid(), passwordHash]
    );
    vault = result.rows[0];
    await pool.query(
      `INSERT INTO notes (id, vault_id, title, html, plain, pinned, media)
       VALUES ($1, $2, $3, $4, $5, TRUE, $6), ($7, $2, $8, $9, $10, FALSE, $11)`,
      [
        uuid(),
        vault.id,
        '欢迎使用 LockerNote',
        '<p>这里只需要密码即可进入。你的备忘录数据会保存到 PostgreSQL 数据库。</p><div class="media-block link-card"><div class="favicon">🔗</div><div><b>链接卡片示例</b><br><small>粘贴链接后可以保存为富媒体块</small></div></div>',
        '这里只需要密码即可进入。你的备忘录数据会保存到 PostgreSQL 数据库。链接卡片示例',
        JSON.stringify({ images: 0, links: 1, files: 0 }),
        uuid(),
        '购物清单',
        '<ul><li>咖啡豆</li><li>牛奶</li><li>USB-C 线</li></ul>',
        '咖啡豆 牛奶 USB-C 线',
        JSON.stringify({ images: 0, links: 0, files: 0 })
      ]
    );
  }

  const sessionToken = token();
  sessions.set(sessionToken, { vaultId: vault.id, createdAt: Date.now() });

  // Reset rate limit on successful authentication
  resetRateLimit(clientIp);

  res.json({ token: sessionToken, vault: { id: vault.id, settings: vault.settings } });
}));

app.post('/api/vault/lock', requireSession, (req, res) => {
  sessions.delete(req.sessionToken);
  res.json({ ok: true });
});

app.patch('/api/vault/settings', requireDb, requireSession, asyncRoute(async (req, res) => {
  await ensureDb();
  const settings = req.body.settings || {};
  const result = await pool.query(
    'UPDATE vaults SET settings = $2, updated_at = NOW() WHERE id = $1 RETURNING settings',
    [req.vaultId, settings]
  );
  res.json({ settings: result.rows[0].settings });
}));

app.delete('/api/vault', requireDb, requireSession, asyncRoute(async (req, res) => {
  await ensureDb();
  await pool.query('DELETE FROM vaults WHERE id = $1', [req.vaultId]);
  sessions.delete(req.sessionToken);
  res.json({ ok: true });
}));

app.get('/api/notes', requireDb, requireSession, asyncRoute(async (req, res) => {
  await ensureDb();
  const result = await pool.query('SELECT * FROM notes WHERE vault_id = $1 ORDER BY pinned DESC, updated_at DESC', [req.vaultId]);
  res.json({ notes: result.rows.map(sanitizeNote) });
}));

app.post('/api/notes', requireDb, requireSession, asyncRoute(async (req, res) => {
  await ensureDb();
  const result = await pool.query(
    'INSERT INTO notes (id, vault_id, title, html, plain, media) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [uuid(), req.vaultId, req.body.title || '新备忘录', req.body.html || '<p>开始记录...</p>', req.body.plain || '', req.body.media || { images: 0, links: 0, files: 0 }]
  );
  res.json({ note: sanitizeNote(result.rows[0]) });
}));

app.patch('/api/notes/:id', requireDb, requireSession, asyncRoute(async (req, res) => {
  await ensureDb();
  const result = await pool.query(
    `UPDATE notes SET title = $3, html = $4, plain = $5, pinned = $6, deleted = $7, media = $8, updated_at = NOW()
     WHERE id = $1 AND vault_id = $2 RETURNING *`,
    [req.params.id, req.vaultId, req.body.title, req.body.html, req.body.plain || '', !!req.body.pinned, !!req.body.deleted, req.body.media || { images: 0, links: 0, files: 0 }]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json({ note: sanitizeNote(result.rows[0]) });
}));

app.delete('/api/notes/:id', requireDb, requireSession, asyncRoute(async (req, res) => {
  await ensureDb();
  const permanent = req.query.permanent === '1';
  if (permanent) {
    await pool.query('DELETE FROM notes WHERE id = $1 AND vault_id = $2', [req.params.id, req.vaultId]);
    return res.json({ ok: true });
  }
  const result = await pool.query('UPDATE notes SET deleted = TRUE, updated_at = NOW() WHERE id = $1 AND vault_id = $2 RETURNING *', [req.params.id, req.vaultId]);
  res.json({ note: result.rows[0] ? sanitizeNote(result.rows[0]) : null });
}));

app.get('/api/export', requireDb, requireSession, asyncRoute(async (req, res) => {
  await ensureDb();
  const result = await pool.query('SELECT * FROM notes WHERE vault_id = $1 ORDER BY updated_at DESC', [req.vaultId]);
  res.json({ exportedAt: new Date().toISOString(), notes: result.rows.map(sanitizeNote) });
}));

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: 'server_error', detail: error.message });
});

process.on('unhandledRejection', error => console.error('Unhandled rejection:', error));
process.on('uncaughtException', error => console.error('Uncaught exception:', error));

app.listen(port, '0.0.0.0', () => {
  const dbSource = databaseUrl ? 'connection_string' : hasPgEnv ? 'split_pg_env' : 'missing';
  console.log(`LockerNote running on 0.0.0.0:${port}; database=${dbSource}`);
  ensureDb().catch(error => {
    dbReady = false;
    dbInitError = error;
    console.error('Database initialization failed; app is still running and will retry on API requests:', error.message);
  });
});
