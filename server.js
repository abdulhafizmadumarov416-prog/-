const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const db = new Database(path.join(__dirname, 'farida.db'));

// Ҷадвали асосӣ: калид -> қиммат
db.exec(`
  CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

const getStmt  = db.prepare('SELECT value FROM kv WHERE key = ?');
const setStmt  = db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
const delStmt  = db.prepare('DELETE FROM kv WHERE key = ?');
const listStmt = db.prepare("SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\'");

app.use(express.json({ limit: '2mb' }));

// Гирифтани қиммат
app.get('/api/kv/:key', (req, res) => {
  const row = getStmt.get(req.params.key);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({ key: req.params.key, value: row.value });
});

// Захира кардан
app.put('/api/kv/:key', (req, res) => {
  const { value } = req.body;
  if (typeof value !== 'string') return res.status(400).json({ error: 'value must be string' });
  setStmt.run(req.params.key, value);
  res.json({ key: req.params.key, value });
});

// Нест кардан
app.delete('/api/kv/:key', (req, res) => {
  delStmt.run(req.params.key);
  res.json({ key: req.params.key, deleted: true });
});

// Рӯйхати калидҳо бо prefix
app.get('/api/list', (req, res) => {
  const prefix = (req.query.prefix || '').replace(/[\\%_]/g, '\\$&');
  const rows = listStmt.all(prefix + '%');
  res.json({ keys: rows.map(r => r.key) });
});

// Файлҳои барнома (index.html, style.css, script.js)
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер кор мекунад: http://localhost:${PORT}`);
});
