const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'rps_stars.db');
let db;

async function initDb() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id INTEGER PRIMARY KEY,
      username TEXT DEFAULT '',
      first_name TEXT DEFAULT '',
      balance INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      draws INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      charge_id TEXT NOT NULL,
      provider_charge_id TEXT DEFAULT '',
      type TEXT NOT NULL DEFAULT 'deposit',
      refunded INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      player1_id INTEGER,
      player2_id INTEGER,
      status TEXT DEFAULT 'waiting',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      round_num INTEGER NOT NULL,
      p1_choice TEXT,
      p2_choice TEXT,
      winner_id INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  saveDb();
  return db;
}

function saveDb() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// Auto-save every 10 seconds
setInterval(() => saveDb(), 10000);

// --- Helpers ---
function getUser(telegramId) {
  const stmt = db.prepare('SELECT * FROM users WHERE telegram_id = ?');
  stmt.bind([telegramId]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function createUser(telegramId, username, firstName) {
  db.run('INSERT OR IGNORE INTO users (telegram_id, username, first_name) VALUES (?, ?, ?)',
    [telegramId, username, firstName]);
  saveDb();
}

function getBalance(telegramId) {
  const user = getUser(telegramId);
  return user ? user.balance : 0;
}

function updateBalance(telegramId, delta) {
  db.run('UPDATE users SET balance = balance + ? WHERE telegram_id = ?', [delta, telegramId]);
}

function addWin(telegramId) {
  db.run('UPDATE users SET wins = wins + 1 WHERE telegram_id = ?', [telegramId]);
}
function addLoss(telegramId) {
  db.run('UPDATE users SET losses = losses + 1 WHERE telegram_id = ?', [telegramId]);
}
function addDraw(telegramId) {
  db.run('UPDATE users SET draws = draws + 1 WHERE telegram_id = ?', [telegramId]);
}

function addPayment(telegramId, amount, chargeId, providerChargeId, type) {
  db.run(
    'INSERT INTO payments (telegram_id, amount, charge_id, provider_charge_id, type) VALUES (?, ?, ?, ?, ?)',
    [telegramId, amount, chargeId, providerChargeId, type]
  );
}

function getUnrefundedPayments(telegramId) {
  const results = [];
  const stmt = db.prepare(
    'SELECT * FROM payments WHERE telegram_id = ? AND type = ? AND refunded = 0 ORDER BY created_at ASC'
  );
  stmt.bind([telegramId, 'deposit']);
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function markRefunded(paymentId) {
  db.run('UPDATE payments SET refunded = 1 WHERE id = ?', [paymentId]);
}

function createGame(gameId, player1Id) {
  db.run("INSERT INTO games (id, player1_id, status) VALUES (?, ?, 'waiting')", [gameId, player1Id]);
  saveDb();
}

function joinGame(player2Id, gameId) {
  db.run("UPDATE games SET player2_id = ?, status = 'active' WHERE id = ?", [player2Id, gameId]);
  saveDb();
}

function endGame(gameId) {
  db.run("UPDATE games SET status = 'finished' WHERE id = ?", [gameId]);
  saveDb();
}

function addRound(gameId, roundNum, p1Choice, p2Choice, winnerId) {
  db.run(
    'INSERT INTO rounds (game_id, round_num, p1_choice, p2_choice, winner_id) VALUES (?, ?, ?, ?, ?)',
    [gameId, roundNum, p1Choice, p2Choice, winnerId]
  );
  saveDb();
}

// --- Transactions ---
function deductStars(player1Id, player2Id, amount) {
  const p1 = getBalance(player1Id);
  const p2 = getBalance(player2Id);
  if (p1 < amount || p2 < amount) return false;

  db.run('BEGIN');
  try {
    updateBalance(player1Id, -amount);
    updateBalance(player2Id, -amount);
    db.run('COMMIT');
    saveDb();
    return true;
  } catch (e) {
    db.run('ROLLBACK');
    return false;
  }
}

function awardWinner(winnerId, loserId, pot) {
  db.run('BEGIN');
  try {
    updateBalance(winnerId, pot);
    addWin(winnerId);
    addLoss(loserId);
    db.run('COMMIT');
    saveDb();
  } catch (e) {
    db.run('ROLLBACK');
  }
}

function handleDrawResult(p1Id, p2Id, amount) {
  db.run('BEGIN');
  try {
    updateBalance(p1Id, amount);
    updateBalance(p2Id, amount);
    addDraw(p1Id);
    addDraw(p2Id);
    db.run('COMMIT');
    saveDb();
  } catch (e) {
    db.run('ROLLBACK');
  }
}

function depositStars(telegramId, amount, chargeId, providerChargeId) {
  db.run('BEGIN');
  try {
    updateBalance(telegramId, amount);
    addPayment(telegramId, amount, chargeId, providerChargeId, 'deposit');
    db.run('COMMIT');
    saveDb();
  } catch (e) {
    db.run('ROLLBACK');
  }
}

module.exports = {
  initDb,
  saveDb,
  getUser,
  createUser,
  getBalance,
  updateBalance,
  getUnrefundedPayments,
  markRefunded,
  createGame,
  joinGame,
  endGame,
  addRound,
  deductStars,
  awardWinner,
  handleDraw: handleDrawResult,
  depositStars,
};
