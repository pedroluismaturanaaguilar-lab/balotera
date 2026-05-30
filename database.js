// database.js (con mejoras de persistencia, WAL y modo trampa)
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const db = new sqlite3.Database(path.join(__dirname, 'balotera.db'));

// Modo seguro: escritura síncrona y Write-Ahead Logging
db.exec(`
  PRAGMA synchronous = FULL;
  PRAGMA journal_mode = WAL;
`);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS tickets (
      ticketCode TEXT PRIMARY KEY,
      createdAt TEXT,
      totalAmount INTEGER,
      status TEXT,
      paidAt TEXT,
      roundNumber INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS bet_combinations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticketCode TEXT,
      numbers TEXT,
      betValue INTEGER,
      wonAmount INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      FOREIGN KEY (ticketCode) REFERENCES tickets(ticketCode)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      roundNumber INTEGER,
      numbers TEXT,
      playedAt TEXT,
      miniAccumulatedValue INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS special_winners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticketCode TEXT,
      amount INTEGER,
      awardedAt TEXT
    )
  `);

  // Limpiar claves antiguas
  db.run(`DELETE FROM config WHERE key LIKE 'prize_%' OR key = 'autoReloadPercent' OR key = 'hitMultiplier'`);

  const defaults = {
    'machineBudget': '5000000',
    'miniAccumulatedTarget': '500000',
    'miniAccumulatedPercentage': '0.35',
    'drawInterval': '2500',
    'globalMultiplier': '1.0',
    'currentRound': '1',
    'currentMiniAccumulated': '0',
    'currentRoundState': JSON.stringify({
      numbersDrawn: [],
      isBettingPhase: true,
      availableNumbers: Array.from({ length: 80 }, (_, i) => i + 1)
    }),
    'avoidBetNumbers': 'false'   // NUEVA CLAVE: modo trampa desactivado por defecto
  };

  for (const [key, val] of Object.entries(defaults)) {
    db.run(`INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)`, [key, val]);
  }

  db.run(`ALTER TABLE tickets ADD COLUMN roundNumber INTEGER`, (err) => {
    if (err && !err.message.includes('duplicate column')) {}
  });
});

module.exports = db;