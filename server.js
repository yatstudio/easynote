import express from 'express';
import pg from 'pg';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);
const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL;

if (!databaseUrl) {
  console.error('Missing DATABASE_URL. Set it to the Zeabur PostgreSQL connection string.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined
});
const sessions = new Map();

app.use(express.json({ limit: '15mb' }));
app.use(express.static(__dirname));

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, database: 'connected' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function token() {
  return crypto.randomBytes(32).toString('hex');
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

async function initDb() {
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto;');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vaults (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      password_hash TEXT UNIQUE NOT NULL,
      settings JSONB NOT NULL DEFAULT '{"autoLock":15,"theme":"system"}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS notes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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

app.post('/api/vault/open', async (req, res) => {
  const password = String(req.body.password || '');
  if (password.length < 4) return res.status(400).json({ error: 'password_too_short' });

  const passwordHash = sha256(password);
  let result = await pool.query('SELECT * FROM vaults WHERE password_hash = $1', [passwordHash]);
  let vault = result.rows[0];

  if (!vault) {
    result = await pool.query(
      'INSERT INTO vaults (password_hash) VALUES ($1) RETURNING *',
      [passwordHash]
    );
    vault = result.rows[0];
    await pool.query(
      `INSERT INTO notes (vault_id, title, html, plain, pinned, media)
       VALUES ($1, $2, $3, $4, TRUE, $5), ($1, $6, $7, $8, FALSE, $9)`,
      [
        vault.id,
        '欢迎使用 EasyNote',
        '<p>这里只需要密码即可进入。你的备忘录数据会保存到 PostgreSQL 数据库。</p><div class="media-block link-card"><div class="favicon">🔗</div><div><b>链接卡片示例</b><br><small>粘贴链接后可以保存为富媒体块</small></div></div>',
        '这里只需要密码即可进入。你的备忘录数据会保存到 PostgreSQL 数据库。链接卡片示例',
        JSON.stringify({ images: 0, links: 1, files: 0 }),
        '购物清单',
        '<ul><li>咖啡豆</li><li>牛奶</li><li>USB-C 线</li></ul>',
        '咖啡豆 牛奶 USB-C 线',
        JSON.stringify({ images: 0, links: 0, files: 0 })
      ]
    );
  }

  const sessionToken = token();
  sessions.set(sessionToken, { vaultId: vault.id, createdAt: Date.now() });
  res.json({ token: sessionToken, vault: { id: vault.id, settings: vault.settings } });
});

app.post('/api/vault/lock', requireSession, (req, res) => {
  sessions.delete(req.sessionToken);
  res.json({ ok: true });
});

app.patch('/api/vault/settings', requireSession, async (req, res) => {
  const settings = req.body.settings || {};
  const result = await pool.query(
    'UPDATE vaults SET settings = $2, updated_at = NOW() WHERE id = $1 RETURNING settings',
    [req.vaultId, settings]
  );
  res.json({ settings: result.rows[0].settings });
});

app.delete('/api/vault', requireSession, async (req, res) => {
  await pool.query('DELETE FROM vaults WHERE id = $1', [req.vaultId]);
  sessions.delete(req.sessionToken);
  res.json({ ok: true });
});

app.get('/api/notes', requireSession, async (req, res) => {
  const result = await pool.query('SELECT * FROM notes WHERE vault_id = $1 ORDER BY pinned DESC, updated_at DESC', [req.vaultId]);
  res.json({ notes: result.rows.map(sanitizeNote) });
});

app.post('/api/notes', requireSession, async (req, res) => {
  const result = await pool.query(
    'INSERT INTO notes (vault_id, title, html, plain, media) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [req.vaultId, req.body.title || '新备忘录', req.body.html || '<p>开始记录...</p>', req.body.plain || '', req.body.media || { images: 0, links: 0, files: 0 }]
  );
  res.json({ note: sanitizeNote(result.rows[0]) });
});

app.patch('/api/notes/:id', requireSession, async (req, res) => {
  const result = await pool.query(
    `UPDATE notes SET title = $3, html = $4, plain = $5, pinned = $6, deleted = $7, media = $8, updated_at = NOW()
     WHERE id = $1 AND vault_id = $2 RETURNING *`,
    [req.params.id, req.vaultId, req.body.title, req.body.html, req.body.plain || '', !!req.body.pinned, !!req.body.deleted, req.body.media || { images: 0, links: 0, files: 0 }]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json({ note: sanitizeNote(result.rows[0]) });
});

app.delete('/api/notes/:id', requireSession, async (req, res) => {
  const permanent = req.query.permanent === '1';
  if (permanent) {
    await pool.query('DELETE FROM notes WHERE id = $1 AND vault_id = $2', [req.params.id, req.vaultId]);
    return res.json({ ok: true });
  }
  const result = await pool.query('UPDATE notes SET deleted = TRUE, updated_at = NOW() WHERE id = $1 AND vault_id = $2 RETURNING *', [req.params.id, req.vaultId]);
  res.json({ note: result.rows[0] ? sanitizeNote(result.rows[0]) : null });
});

app.get('/api/export', requireSession, async (req, res) => {
  const result = await pool.query('SELECT * FROM notes WHERE vault_id = $1 ORDER BY updated_at DESC', [req.vaultId]);
  res.json({ exportedAt: new Date().toISOString(), notes: result.rows.map(sanitizeNote) });
});

initDb().then(() => {
  app.listen(port, () => console.log(`EasyNote running at http://localhost:${port}`));
}).catch(error => {
  console.error(error);
  process.exit(1);
});
