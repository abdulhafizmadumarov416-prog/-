// Сервер бе китобхонаҳои беруна (Node.js v22.13+): API + файлҳои статикӣ + SQLite
const http = require('http');
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const isEmail = e => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const normEmail = e => String(e || '').trim().toLowerCase();

/* ==================================================================
   БАЗА (SQLite)
================================================================== */
const db = new DatabaseSync(path.join(__dirname, 'farida.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE IF NOT EXISTS users (
    email    TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    password TEXT NOT NULL,
    bio      TEXT NOT NULL DEFAULT '',
    created  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token   TEXT PRIMARY KEY,
    email   TEXT NOT NULL,
    created INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS conversations (
    id      TEXT PRIMARY KEY,
    type    TEXT NOT NULL,          -- 'dm' ё 'group'
    name    TEXT,
    owner   TEXT,
    created INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS members (
    conv_id   TEXT NOT NULL,
    email     TEXT NOT NULL,
    last_read INTEGER NOT NULL DEFAULT 0,
    joined    INTEGER NOT NULL,
    PRIMARY KEY (conv_id, email)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    conv_id TEXT NOT NULL,
    sender  TEXT NOT NULL,
    text    TEXT NOT NULL,
    created INTEGER NOT NULL,
    edited  INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages (conv_id, id);
  CREATE INDEX IF NOT EXISTS idx_members_email ON members (email);
`);

const q = {
  getKv:  db.prepare('SELECT value FROM kv WHERE key = ?'),
  setKv:  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),

  getUser:    db.prepare('SELECT email, name, password, bio, created FROM users WHERE email = ?'),
  insUser:    db.prepare('INSERT INTO users (email, name, password, bio, created) VALUES (?, ?, ?, ?, ?)'),
  allUsers:   db.prepare('SELECT email, name, bio, created FROM users'),
  setProfile: db.prepare('UPDATE users SET name = ?, bio = ? WHERE email = ?'),

  insSession: db.prepare('INSERT INTO sessions (token, email, created) VALUES (?, ?, ?)'),
  getSession: db.prepare('SELECT email, created FROM sessions WHERE token = ?'),
  delSession: db.prepare('DELETE FROM sessions WHERE token = ?'),

  getConv:     db.prepare('SELECT id, type, name, owner, created FROM conversations WHERE id = ?'),
  insConv:     db.prepare('INSERT INTO conversations (id, type, name, owner, created) VALUES (?, ?, ?, ?, ?)'),
  setOwner:    db.prepare('UPDATE conversations SET owner = ? WHERE id = ?'),
  delConv:     db.prepare('DELETE FROM conversations WHERE id = ?'),
  allConvs:    db.prepare('SELECT id, type, name, owner, created FROM conversations'),

  addMember:   db.prepare('INSERT OR IGNORE INTO members (conv_id, email, last_read, joined) VALUES (?, ?, 0, ?)'),
  getMember:   db.prepare('SELECT conv_id, email, last_read FROM members WHERE conv_id = ? AND email = ?'),
  delMember:   db.prepare('DELETE FROM members WHERE conv_id = ? AND email = ?'),
  delMembers:  db.prepare('DELETE FROM members WHERE conv_id = ?'),
  convMembers: db.prepare('SELECT u.email, u.name FROM members m JOIN users u ON u.email = m.email WHERE m.conv_id = ? ORDER BY m.joined, u.name'),
  listConvs:   db.prepare('SELECT c.id, c.type, c.name, c.owner, c.created, m.last_read FROM conversations c JOIN members m ON m.conv_id = c.id WHERE m.email = ?'),
  setRead:     db.prepare('UPDATE members SET last_read = ? WHERE conv_id = ? AND email = ?'),

  lastMsg: db.prepare('SELECT m.id, m.sender, m.text, m.created, m.deleted, u.name AS senderName FROM messages m JOIN users u ON u.email = m.sender WHERE m.conv_id = ? ORDER BY m.id DESC LIMIT 1'),
  unread:  db.prepare('SELECT COUNT(*) AS c FROM messages WHERE conv_id = ? AND id > ? AND sender != ? AND deleted = 0'),
  msgs:    db.prepare('SELECT m.id, m.sender, u.name AS senderName, m.text, m.created, m.edited, m.deleted FROM (SELECT * FROM messages WHERE conv_id = ? ORDER BY id DESC LIMIT ?) m JOIN users u ON u.email = m.sender ORDER BY m.id ASC'),
  insMsg:  db.prepare('INSERT INTO messages (conv_id, sender, text, created) VALUES (?, ?, ?, ?)'),
  getMsg:  db.prepare('SELECT id, conv_id, sender, text, created, edited, deleted FROM messages WHERE id = ?'),
  editMsg: db.prepare('UPDATE messages SET text = ?, edited = 1 WHERE id = ?'),
  delMsg:  db.prepare("UPDATE messages SET text = '', deleted = 1 WHERE id = ?"),
  delConvMsgs: db.prepare('DELETE FROM messages WHERE conv_id = ?'),
  countMsgs:   db.prepare('SELECT COUNT(*) AS c FROM messages WHERE conv_id = ?')
};

// Корбарони версияи кӯҳна (ҷадвали kv) ба ҷадвали нав кӯчонида мешаванд
for (const r of db.prepare("SELECT key, value FROM kv WHERE key LIKE 'users:%'").all()) {
  try {
    const email = r.key.slice(6);
    if (!isEmail(email) || q.getUser.get(email)) continue;
    const u = JSON.parse(r.value);
    q.insUser.run(email, u.name || email, String(u.password || ''), '', u.created || Date.now());
  } catch (e) { /* нодида мегирем */ }
}
db.prepare('DELETE FROM sessions WHERE created < ?').run(Date.now() - 30 * 86400000);


/* ==================================================================
   AI ДУХТУР — дархост ба API-и Claude (калид дар сервер нигоҳ дошта мешавад)
   Танзим: файли ai.config.json ё тағйирёбандаҳои муҳит
   ANTHROPIC_API_KEY, AI_MODEL
================================================================== */
function aiConfig() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(path.join(__dirname, 'ai.config.json'), 'utf8')); } catch (e) {}
  const apiKey = (process.env.ANTHROPIC_API_KEY || c.apiKey || '').trim();
  return {
    apiKey,
    model: process.env.AI_MODEL || c.model || 'claude-sonnet-5-5',
    baseUrl: (process.env.AI_BASE_URL || c.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, ''),
    configured: Boolean(apiKey)
  };
}

const AI_SYSTEM = `Шумо «AI Духтур» дар барномаи тиббии «Мадади Сино» ҳастед ва бо одамон сӯҳбат мекунед.

Забон: ҳамеша ба забони худи корбар ҷавоб диҳед. Агар ба тоҷикӣ нависад, бо тоҷикӣ (хати кириллӣ), агар ба русӣ ё англисӣ нависад, ба ҳамон забон. Сода, мулоим ва дӯстона бошед.

Формат: матни оддӣ бе Markdown (бе ситорача, бе сарлавҳа, бе рӯйхати рақамдор бо #). Ҷавоб одатан аз 3 то 6 ҷумла бошад, магар корбар муфассалтар хоҳад.

Қоидаҳо:
1. Маълумоти умумии тиббӣ диҳед: аломатҳо, сабабҳои эҳтимолӣ, пешгирӣ, тарзи ҳаёти солим, кай бояд ба духтур муроҷиат кард.
2. Ташхиси дақиқи шахсӣ нагузоред ва доруи муайян бо миқдори дақиқ таъин накунед. Ҳамеша хотиррасон кунед, ки барои ташхис ва табобат бояд ба духтури воқеӣ муроҷиат кард.
3. Агар аломатҳои хатарнок бошанд (дарди шадиди дил ё сина, нафастангӣ, хунравии сахт, фалаҷшавӣ ё каҷ шудани рӯй, беҳушӣ, таппиш, ҳамлаи шадиди аллергӣ, заҳролудшавӣ), фавран тавсия диҳед ба ёрии таъҷилӣ занг зананд (дар Тоҷикистон 103).
4. Агар корбар дар бораи худкушӣ ё осеб расондан ба худ ҳарф занад, бо гармӣ ва ҷиддӣ ҷавоб диҳед, ӯро танҳо нагузоред, тавсия диҳед ба ёрии таъҷилӣ занг занад ва бо касе аз наздикон ё духтур тамос гирад.
5. Агар савол ба тиб рабт надошта бошад, мулоимона бигӯед, ки шумо ёрдамчии тиббӣ ҳастед ва ба саволҳои саломатӣ кӯмак мекунед.`;

// Ҳифз аз истифодаи аз ҳад зиёд: на бештар аз 15 дархост дар як дақиқа барои як корбар
const aiRate = new Map();
function aiAllowed(email) {
  const now = Date.now();
  const arr = (aiRate.get(email) || []).filter(t => now - t < 60000);
  if (arr.length >= 15) { aiRate.set(email, arr); return false; }
  arr.push(now);
  aiRate.set(email, arr);
  return true;
}

// Таърихи сӯҳбатро тоза мекунем: танҳо user/assistant, аввал user, дар охир 20 паём
function cleanAiMessages(list) {
  let out = (Array.isArray(list) ? list : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.trim().slice(0, 4000) }))
    .slice(-20);
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon'
};

/* ==================================================================
   КОДИ МАЪМУР — дар база ҳамчун hash (scrypt) нигоҳ дошта мешавад
   Коди пешфарз: farida2026 (онро дар панели маъмур иваз кунед)
================================================================== */
function hashCode(code, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(code), salt, 32).toString('hex') };
}
function checkAdminCode(code) {
  const row = q.getKv.get('admin:code');
  if (!row) return false;
  const { salt, hash } = JSON.parse(row.value);
  const test = crypto.scryptSync(String(code), salt, 32);
  const real = Buffer.from(hash, 'hex');
  return test.length === real.length && crypto.timingSafeEqual(test, real);
}
if (!q.getKv.get('admin:code')) {
  q.setKv.run('admin:code', JSON.stringify(hashCode('farida2026')));
  console.log('Коди маъмури пешфарз сохта шуд: farida2026 (онро дар панели маъмур иваз кунед)');
}

// Ҳифз аз ҷустуҷӯи кодҳо: на бештар аз 30 хатогӣ дар 5 дақиқа аз як IP
const adminFails = new Map();
function adminBlocked(ip) {
  const e = adminFails.get(ip);
  if (!e) return false;
  if (Date.now() - e.since > 5 * 60000) { adminFails.delete(ip); return false; }
  return e.count >= 30;
}
function adminFail(ip) {
  const e = adminFails.get(ip);
  if (!e || Date.now() - e.since > 5 * 60000) adminFails.set(ip, { count: 1, since: Date.now() });
  else e.count++;
}

// Токенҳои маъмур (дар хотира, 2 соат)
const adminTokens = new Map();
function isAdmin(req) {
  const t = req.headers['x-admin-token'];
  const exp = t && adminTokens.get(t);
  if (!exp) return false;
  if (Date.now() > exp) { adminTokens.delete(t); return false; }
  return true;
}

/* ==================================================================
   ТАНЗИМОТИ ПОЧТА (SMTP)
   Ё тавассути файли smtp.config.json, ё тавассути тағйирёбандаҳои
   муҳит: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
================================================================== */
function smtpConfig() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(path.join(__dirname, 'smtp.config.json'), 'utf8')); } catch (e) {}
  const user = process.env.SMTP_USER || c.user || '';
  const pass = (process.env.SMTP_PASS || c.pass || '').replace(/\s+/g, '');
  return {
    host: process.env.SMTP_HOST || c.host || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || c.port || 465),
    user,
    pass,
    from: process.env.SMTP_FROM || c.from || user,
    configured: Boolean(user && pass)
  };
}

// Фиристодани почта тавассути SMTP бо TLS (порти 465)
function sendMail(cfg, to, subject, text) {
  return new Promise((resolve, reject) => {
    const b64 = s => Buffer.from(s, 'utf8').toString('base64');
    const body = b64(text).replace(/(.{76})/g, '$1\r\n');
    const message = [
      `From: ${cfg.from}`,
      `To: <${to}>`,
      `Subject: =?UTF-8?B?${b64(subject)}?=`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      body
    ].join('\r\n');

    const steps = [
      { expect: '220', send: 'EHLO localhost\r\n' },
      { expect: '250', send: 'AUTH LOGIN\r\n' },
      { expect: '334', send: b64(cfg.user) + '\r\n' },
      { expect: '334', send: b64(cfg.pass) + '\r\n' },
      { expect: '235', send: `MAIL FROM:<${cfg.user}>\r\n` },
      { expect: '250', send: `RCPT TO:<${to}>\r\n` },
      { expect: '250', send: 'DATA\r\n' },
      { expect: '354', send: message + '\r\n.\r\n' },
      { expect: '250', send: 'QUIT\r\n' },
      { expect: '221', send: null }
    ];

    let i = 0, buf = '', finished = false;
    const socket = tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host });
    const fail = err => { if (finished) return; finished = true; socket.destroy(); reject(err); };

    socket.setTimeout(20000, () => fail(new Error('SMTP timeout')));
    socket.on('error', fail);
    socket.on('data', chunk => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (/^\d{3}-/.test(line)) continue;
        if (!/^\d{3}( |$)/.test(line)) continue;
        const step = steps[i];
        if (line.slice(0, 3) !== step.expect) return fail(new Error('SMTP: ' + line));
        if (step.send === null) { finished = true; socket.end(); return resolve(); }
        socket.write(step.send);
        i++;
      }
    });
  });
}

/* ==================================================================
   КУМАКИҲО
================================================================== */
function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) { reject(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  try { return JSON.parse(raw || '{}'); } catch (e) { return {}; }
}

// Корбар аз рӯи токен (Authorization: Bearer ...)
function authUser(req) {
  const m = /^Bearer ([a-f0-9]+)$/.exec(req.headers['authorization'] || '');
  if (!m) return null;
  const row = q.getSession.get(m[1]);
  if (!row) return null;
  if (Date.now() - row.created > 30 * 86400000) { q.delSession.run(m[1]); return null; }
  return row.email;
}

function newSession(email) {
  const token = crypto.randomBytes(24).toString('hex');
  q.insSession.run(token, email, Date.now());
  return token;
}

const publicUser = u => ({ email: u.email, name: u.name, bio: u.bio || '' });
const cleanText = (t, max) => String(t == null ? '' : t).replace(/\r\n/g, '\n').trim().slice(0, max);

function dmId(a, b) {
  return 'dm_' + crypto.createHash('sha256').update([a, b].sort().join('|')).digest('hex').slice(0, 20);
}

// Сӯҳбат, агар корбар узви он бошад
function convFor(id, email) {
  const conv = q.getConv.get(id);
  if (!conv || !q.getMember.get(id, email)) return null;
  return conv;
}

function convDetails(conv, viewerEmail) {
  const members = q.convMembers.all(conv.id).map(m => ({ email: m.email, name: m.name }));
  let title = conv.name, other = null;
  if (conv.type === 'dm') {
    other = members.find(m => m.email !== viewerEmail) || members[0] || null;
    title = other ? other.name : 'Корбар';
  }
  return { id: conv.id, type: conv.type, name: conv.name, owner: conv.owner, title, other, members };
}

const forgotLast = new Map();   // ҳар 60 сония як дархост барои ҳар почта

/* ==================================================================
   API
================================================================== */
async function handleApi(req, res, url, pathname) {
  const J = (status, data) => sendJson(res, status, data);
  const method = req.method;
  let m;

  /* ---------- Ҳисоб: сабти ном, вуруд, барқарорсозӣ ---------- */
  if (pathname === '/api/email-exists' && method === 'POST') {
    const e = normEmail((await readJson(req)).email);
    if (!isEmail(e)) return J(400, { error: 'bad_email' });
    return J(200, { exists: Boolean(q.getUser.get(e)) });
  }

  if (pathname === '/api/register' && method === 'POST') {
    const body = await readJson(req);
    const e = normEmail(body.email);
    const password = String(body.password || '');
    const name = cleanText(body.name, 60);
    if (!isEmail(e)) return J(400, { error: 'bad_email' });
    if (password.length < 4) return J(400, { error: 'short_password' });
    if (name.length < 2) return J(400, { error: 'bad_name' });
    if (q.getUser.get(e)) return J(409, { error: 'exists' });
    q.insUser.run(e, name, password, '', Date.now());
    return J(200, { ok: true, email: e, name, bio: '', token: newSession(e) });
  }

  if (pathname === '/api/login' && method === 'POST') {
    const body = await readJson(req);
    const e = normEmail(body.email);
    const user = q.getUser.get(e);
    if (!user || user.password !== String(body.password || '')) return J(401, { error: 'invalid' });
    return J(200, { ok: true, email: user.email, name: user.name, bio: user.bio, token: newSession(e) });
  }

  if (pathname === '/api/logout' && method === 'POST') {
    const m2 = /^Bearer ([a-f0-9]+)$/.exec(req.headers['authorization'] || '');
    if (m2) q.delSession.run(m2[1]);
    return J(200, { ok: true });
  }

  if (pathname === '/api/forgot' && method === 'POST') {
    const e = normEmail((await readJson(req)).email);
    if (!isEmail(e)) return J(400, { error: 'bad_email' });
    if (Date.now() - (forgotLast.get(e) || 0) < 60000) return J(429, { error: 'too_soon' });
    const user = q.getUser.get(e);
    if (!user) return J(200, { ok: true });   // ҷавоби якхела

    const cfg = smtpConfig();
    if (!cfg.configured) {
      console.log(`[ПОЧТА ТАНЗИМ НАШУДААСТ] Коди ${e}: ${user.password}`);
      return J(503, { error: 'smtp_not_configured' });
    }
    try {
      await sendMail(
        cfg, e, 'Коди ворид ба барномаи Мадади Сино',
        `Салом, ${user.name}!\n\nКоди шумо барои ворид шудан ба барномаи Мадади Сино: ${user.password}\n\nАгар шумо инро дархост накарда бошед, ин паёмро нодида гиред.`
      );
      forgotLast.set(e, Date.now());
      return J(200, { ok: true });
    } catch (err) {
      console.error('Хатои фиристодани почта:', err.message);
      return J(502, { error: 'mail_failed' });
    }
  }

  /* ---------- Маъмур: воридшавӣ ва иваз кардани код ---------- */
  if (pathname === '/api/admin/verify' && method === 'POST') {
    const ip = req.socket.remoteAddress;
    const { code } = await readJson(req);
    if (adminBlocked(ip)) return J(429, { ok: false, error: 'too_many' });
    if (typeof code === 'string' && code.length <= 64 && checkAdminCode(code)) {
      const token = crypto.randomBytes(24).toString('hex');
      adminTokens.set(token, Date.now() + 2 * 3600 * 1000);
      return J(200, { ok: true, token });
    }
    adminFail(ip);
    return J(200, { ok: false });
  }

  if (pathname === '/api/admin/change-code' && method === 'POST') {
    const ip = req.socket.remoteAddress;
    const { oldCode, newCode } = await readJson(req);
    if (adminBlocked(ip)) return J(429, { error: 'too_many' });
    if (typeof oldCode !== 'string' || !checkAdminCode(oldCode)) {
      adminFail(ip);
      return J(403, { error: 'wrong_old' });
    }
    if (typeof newCode !== 'string' || !/^\S{6,64}$/.test(newCode)) return J(400, { error: 'bad_code' });
    q.setKv.run('admin:code', JSON.stringify(hashCode(newCode)));
    return J(200, { ok: true });
  }

  /* ---------- Маъмур: танҳо назорат (хондан) ---------- */
  if (pathname.startsWith('/api/admin/')) {
    if (!isAdmin(req)) return J(403, { error: 'forbidden' });

    if (pathname === '/api/admin/users' && method === 'GET') {
      const users = q.allUsers.all().sort((a, b) => b.created - a.created)
        .map(u => ({ email: u.email, name: u.name, created: u.created }));
      return J(200, { users });
    }

    if (pathname === '/api/admin/conversations' && method === 'GET') {
      const list = q.allConvs.all().map(c => {
        const d = convDetails(c, null);
        const title = c.type === 'dm' ? d.members.map(x => x.name).join(' ↔ ') : c.name;
        const last = q.lastMsg.get(c.id);
        return {
          id: c.id, type: c.type, title, members: d.members,
          count: q.countMsgs.get(c.id).c,
          last: last ? { sender: last.senderName, text: last.text, deleted: last.deleted, created: last.created } : null,
          ts: last ? last.created : c.created
        };
      }).sort((a, b) => b.ts - a.ts);
      return J(200, { conversations: list });
    }

    if ((m = pathname.match(/^\/api\/admin\/conversations\/([^/]+)\/messages$/)) && method === 'GET') {
      const c = q.getConv.get(decodeURIComponent(m[1]));
      if (!c) return J(404, { error: 'not_found' });
      const d = convDetails(c, null);
      const title = c.type === 'dm' ? d.members.map(x => x.name).join(' ↔ ') : c.name;
      const messages = q.msgs.all(c.id, 500).map(x => ({
        id: x.id, sender: x.sender, senderName: x.senderName, text: x.text,
        created: x.created, edited: x.edited, deleted: x.deleted
      }));
      return J(200, { id: c.id, type: c.type, title, members: d.members, messages });
    }

    return J(404, { error: 'not_found' });
  }

  /* ---------- Аз ин ҷо ҳама чиз танҳо барои корбарони воридшуда ---------- */
  const me = authUser(req);
  if (!me) return J(401, { error: 'unauthorized' });

  if (pathname === '/api/me' && method === 'GET') {
    return J(200, publicUser(q.getUser.get(me)));
  }

  if (pathname === '/api/profile' && method === 'PUT') {
    const body = await readJson(req);
    const name = cleanText(body.name, 60);
    const bio = cleanText(body.bio, 300);
    if (name.length < 2) return J(400, { error: 'bad_name' });
    q.setProfile.run(name, bio, me);
    return J(200, publicUser(q.getUser.get(me)));
  }

  /* ---------- AI Духтур ---------- */
  if (pathname === '/api/ai' && method === 'POST') {
    const cfg = aiConfig();
    if (!cfg.configured) {
      console.log('[AI ТАНЗИМ НАШУДААСТ] Калиди API нест. Нигаред ба ai.config.example.json');
      return J(503, { error: 'ai_not_configured' });
    }
    if (!aiAllowed(me)) return J(429, { error: 'too_many' });
    const messages = cleanAiMessages((await readJson(req)).messages);
    if (!messages.length) return J(400, { error: 'empty' });

    try {
      const r = await fetch(cfg.baseUrl + '/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({ model: cfg.model, max_tokens: 900, system: AI_SYSTEM, messages }),
        signal: AbortSignal.timeout(60000)
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        console.error(`[AI] Хатои API (${r.status}):`, JSON.stringify(data).slice(0, 300));
        if (r.status === 401 || r.status === 403) return J(502, { error: 'ai_key_invalid' });
        if (r.status === 429 || r.status === 529) return J(502, { error: 'ai_busy' });
        if (r.status === 404) return J(502, { error: 'ai_model' });
        return J(502, { error: 'ai_failed' });
      }
      const reply = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      if (!reply) return J(502, { error: 'ai_failed' });
      return J(200, { reply });
    } catch (e) {
      console.error('[AI] Пайваст нашуд:', e.message);
      return J(502, { error: 'ai_unreachable' });
    }
  }

  /* ---------- Корбарон ("сайти" ҳар корбар) ---------- */
  if (pathname === '/api/users' && method === 'GET') {
    const term = (url.searchParams.get('q') || '').trim().toLowerCase();
    const users = q.allUsers.all()
      .filter(u => u.email !== me)
      .filter(u => !term || u.name.toLowerCase().includes(term) || u.email.includes(term))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 40)
      .map(u => ({ email: u.email, name: u.name, bio: u.bio }));
    return J(200, { users });
  }

  if ((m = pathname.match(/^\/api\/users\/([^/]+)$/)) && method === 'GET') {
    const u = q.getUser.get(normEmail(decodeURIComponent(m[1])));
    if (!u) return J(404, { error: 'not_found' });
    return J(200, { email: u.email, name: u.name, bio: u.bio, created: u.created });
  }

  /* ---------- Сӯҳбатҳо ---------- */
  if (pathname === '/api/dm' && method === 'POST') {
    const target = normEmail((await readJson(req)).email);
    if (target === me) return J(400, { error: 'self' });
    if (!q.getUser.get(target)) return J(404, { error: 'not_found' });
    const id = dmId(me, target);
    if (!q.getConv.get(id)) {
      const now = Date.now();
      q.insConv.run(id, 'dm', null, null, now);
      q.addMember.run(id, me, now);
      q.addMember.run(id, target, now);
    }
    return J(200, { id });
  }

  if (pathname === '/api/groups' && method === 'POST') {
    const body = await readJson(req);
    const name = cleanText(body.name, 60);
    if (name.length < 2) return J(400, { error: 'bad_name' });
    const emails = [...new Set((Array.isArray(body.members) ? body.members : []).map(normEmail))]
      .filter(e => e !== me && q.getUser.get(e))
      .slice(0, 100);
    if (emails.length < 1) return J(400, { error: 'no_members' });
    const id = 'g_' + crypto.randomBytes(8).toString('hex');
    const now = Date.now();
    q.insConv.run(id, 'group', name, me, now);
    q.addMember.run(id, me, now);
    emails.forEach(e => q.addMember.run(id, e, now));
    return J(200, { id });
  }

  if (pathname === '/api/conversations' && method === 'GET') {
    const list = [];
    for (const c of q.listConvs.all(me)) {
      const last = q.lastMsg.get(c.id);
      if (c.type === 'dm' && !last) continue;     // сӯҳбати холӣ дар рӯйхат нест
      const d = convDetails(c, me);
      list.push({
        id: c.id, type: c.type, title: d.title, email: d.other ? d.other.email : null,
        memberCount: d.members.length,
        last: last ? { sender: last.sender, senderName: last.senderName, text: last.text, deleted: last.deleted, created: last.created } : null,
        unread: q.unread.get(c.id, c.last_read, me).c,
        ts: last ? last.created : c.created
      });
    }
    list.sort((a, b) => b.ts - a.ts);
    return J(200, { conversations: list });
  }

  if ((m = pathname.match(/^\/api\/conversations\/([^/]+)(?:\/(messages|members|leave))?$/))) {
    const id = decodeURIComponent(m[1]);
    const sub = m[2];
    const conv = convFor(id, me);
    if (!conv) return J(404, { error: 'not_found' });

    if (!sub && method === 'GET') return J(200, convDetails(conv, me));

    if (sub === 'messages' && method === 'GET') {
      const messages = q.msgs.all(id, 200).map(x => ({
        id: x.id, sender: x.sender, senderName: x.senderName, text: x.text,
        created: x.created, edited: x.edited, deleted: x.deleted
      }));
      if (messages.length) q.setRead.run(messages[messages.length - 1].id, id, me);
      return J(200, { messages });
    }

    if (sub === 'messages' && method === 'POST') {
      const text = cleanText((await readJson(req)).text, 4000);
      if (!text) return J(400, { error: 'empty' });
      const r = q.insMsg.run(id, me, text, Date.now());
      q.setRead.run(Number(r.lastInsertRowid), id, me);
      return J(200, { ok: true, id: Number(r.lastInsertRowid) });
    }

    if (sub === 'members' && method === 'POST') {
      if (conv.type !== 'group') return J(400, { error: 'not_group' });
      if (conv.owner !== me) return J(403, { error: 'owner_only' });
      const target = normEmail((await readJson(req)).email);
      if (!q.getUser.get(target)) return J(404, { error: 'not_found' });
      q.addMember.run(id, target, Date.now());
      return J(200, convDetails(conv, me));
    }

    if (sub === 'leave' && method === 'POST') {
      if (conv.type !== 'group') return J(400, { error: 'not_group' });
      q.delMember.run(id, me);
      const rest = q.convMembers.all(id);
      if (rest.length === 0) {
        q.delConvMsgs.run(id); q.delMembers.run(id); q.delConv.run(id);
      } else if (conv.owner === me) {
        q.setOwner.run(rest[0].email, id);
      }
      return J(200, { ok: true });
    }

    return J(405, { error: 'method_not_allowed' });
  }

  /* ---------- Таҳрир ва нест кардани паёми худӣ ---------- */
  if ((m = pathname.match(/^\/api\/messages\/(\d+)$/))) {
    const msg = q.getMsg.get(Number(m[1]));
    if (!msg || msg.sender !== me || !q.getMember.get(msg.conv_id, me)) return J(404, { error: 'not_found' });
    if (msg.deleted) return J(400, { error: 'deleted' });

    if (method === 'PUT') {
      const text = cleanText((await readJson(req)).text, 4000);
      if (!text) return J(400, { error: 'empty' });
      q.editMsg.run(text, msg.id);
      return J(200, { ok: true });
    }
    if (method === 'DELETE') {
      q.delMsg.run(msg.id);
      return J(200, { ok: true });
    }
    return J(405, { error: 'method_not_allowed' });
  }

  return J(404, { error: 'not_found' });
}

/* ==================================================================
   СЕРВЕР
================================================================== */
function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  filePath = path.normalize(path.join(__dirname, filePath));

  if (!filePath.startsWith(__dirname)) { res.writeHead(403); return res.end('Forbidden'); }
  const base = path.basename(filePath);
  if (base.startsWith('farida.db') || base.startsWith('smtp.config') || base.startsWith('ai.config') || base.startsWith('server')) {
    res.writeHead(403); return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      console.log(`[404] Файл ёфт нашуд: ${filePath}  (${err.code})`);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(`Not found\n\nҶустуҷӯ шуд: ${filePath}\nСабаб: ${err.code}`);
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url, url.pathname);
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: 'server error' });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер кор мекунад: http://localhost:${PORT}`);
  console.log(`Папка: ${__dirname}`);
  for (const f of ['index.html', 'style.css', 'script.js']) {
    console.log(`  ${f}: ${fs.existsSync(path.join(__dirname, f)) ? 'ҳаст' : 'НЕСТ  <-- мушкил дар ҳамин ҷост'}`);
  }
  console.log(aiConfig().configured
    ? `AI Духтур: танзим шудааст (модел: ${aiConfig().model})`
    : 'AI Духтур: танзим нашудааст. Нигаред ба ai.config.example.json');
  console.log(smtpConfig().configured
    ? 'Почта: танзим шудааст'
    : 'Почта: танзим нашудааст (код дар ин терминал навишта мешавад). Нигаред ба smtp.config.example.json');
});
