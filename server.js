const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const db = require('./database');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

let gameState = {
  isBettingPhase: true,
  roundNumber: 1,
  numbersDrawn: [],
  availableNumbers: [],
  intervalId: null,
  countdownTimer: null,
  miniAccumulated: 0,
  config: {},
  drawIntervalMs: 2500
};

global.notifiedWinners = new Set();

// ========== FUNCIONES DE PERSISTENCIA ==========
function loadConfig() {
  return new Promise((resolve) => {
    db.all("SELECT key, value FROM config", (err, rows) => {
      if (err) return resolve({});
      const cfg = {};
      rows.forEach(r => { cfg[r.key] = r.value; });
      gameState.config = cfg;
      gameState.drawIntervalMs = parseInt(cfg.drawInterval) || 2500;
      gameState.roundNumber = parseInt(cfg.currentRound) || 1;
      gameState.miniAccumulated = parseFloat(cfg.currentMiniAccumulated) || 0;
      resolve(cfg);
    });
  });
}

function setConfig(key, value) {
  return new Promise((resolve) => {
    db.run(`INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)`, [key, String(value)], (err) => {
      if (!err) {
        gameState.config[key] = String(value);
        if (key === 'drawInterval') gameState.drawIntervalMs = parseInt(value) || 2500;
      }
      resolve();
    });
  });
}

async function savePersistentState() {
  await setConfig('currentRound', gameState.roundNumber);
  await setConfig('currentMiniAccumulated', gameState.miniAccumulated);
}

async function saveCurrentRoundState() {
  const state = {
    numbersDrawn: gameState.numbersDrawn,
    isBettingPhase: gameState.isBettingPhase,
    availableNumbers: gameState.availableNumbers
  };
  await setConfig('currentRoundState', JSON.stringify(state));
}

async function loadCurrentRoundState() {
  const stateStr = gameState.config.currentRoundState;
  if (stateStr) {
    try {
      const state = JSON.parse(stateStr);
      gameState.numbersDrawn = state.numbersDrawn || [];
      gameState.isBettingPhase = state.isBettingPhase !== undefined ? state.isBettingPhase : true;
      gameState.availableNumbers = state.availableNumbers || Array.from({ length: 80 }, (_, i) => i + 1);
      if (!gameState.isBettingPhase && gameState.numbersDrawn.length > 0 && gameState.numbersDrawn.length < 20) {
        console.log('⚠️ Sorteo interrumpido. Se reiniciará la ronda.');
        gameState.numbersDrawn = [];
        gameState.isBettingPhase = true;
        gameState.availableNumbers = Array.from({ length: 80 }, (_, i) => i + 1);
        await saveCurrentRoundState();
      }
    } catch(e) {
      console.error('Error al cargar estado de ronda:', e);
    }
  }
}

// ========== FUNCIONES AUXILIARES ==========
async function getTotalBetThisRound() {
  return new Promise((resolve) => {
    db.get(`SELECT SUM(betValue) as total FROM bet_combinations WHERE status = 'pending'`, (err, row) => {
      resolve(row?.total || 0);
    });
  });
}

async function getRandomPendingTicket() {
  return new Promise((resolve) => {
    db.get(`SELECT ticketCode FROM tickets WHERE roundNumber = ? AND status = 'pending' ORDER BY RANDOM() LIMIT 1`, 
      [gameState.roundNumber], (err, row) => {
        resolve(row?.ticketCode || null);
      });
  });
}

async function getMachineNetProfit() {
  return new Promise((resolve) => {
    db.get(`SELECT COALESCE(SUM(betValue),0) as totalBet FROM bet_combinations`, (err, betRow) => {
      if (err) return resolve(0);
      db.get(`SELECT COALESCE(SUM(wonAmount),0) as totalWonPaid FROM bet_combinations bc JOIN tickets t ON bc.ticketCode = t.ticketCode WHERE bc.status='won' AND t.paidAt IS NOT NULL`, (err2, wonRow) => {
        if (err2) return resolve(0);
        const profit = (betRow.totalBet || 0) - (wonRow.totalWonPaid || 0);
        resolve(profit);
      });
    });
  });
}

async function getDailyProfit() {
  const today = new Date().toISOString().slice(0, 10);
  return new Promise((resolve) => {
    db.get(`SELECT COALESCE(SUM(betValue),0) as totalBet FROM bet_combinations bc JOIN tickets t ON bc.ticketCode = t.ticketCode WHERE DATE(t.createdAt) = ?`, [today], (err, betRow) => {
      if (err) return resolve(0);
      db.get(`SELECT COALESCE(SUM(wonAmount),0) as totalWonPaid FROM bet_combinations bc JOIN tickets t ON bc.ticketCode = t.ticketCode WHERE DATE(t.paidAt) = ? AND bc.status='won' AND t.paidAt IS NOT NULL`, [today], (err2, wonRow) => {
        if (err2) return resolve(0);
        const profit = (betRow.totalBet || 0) - (wonRow.totalWonPaid || 0);
        resolve(profit);
      });
    });
  });
}

// ========== TABLA DE PREMIOS ==========
function calculatePrize(numbersCount, hits, betValue, config) {
  const multiplier = parseFloat(config.globalMultiplier) || 0;
  if (multiplier <= 0) return 0;

  let basePrize = 0;

  if (numbersCount === 2) {
    if (hits === 1) basePrize = betValue * 1;
    else if (hits === 2) basePrize = betValue * 10;
  }
  else if (numbersCount === 3) {
    if (hits === 2) basePrize = betValue * 2;
    else if (hits === 3) basePrize = betValue * 50;
  }
  else if (numbersCount === 4) {
    if (hits === 2) basePrize = betValue * 1;
    else if (hits === 3) basePrize = betValue * 10;
    else if (hits === 4) basePrize = betValue * 100;
  }
  else if (numbersCount === 5) {
    if (hits === 4) basePrize = betValue * 50;
    else if (hits === 5) basePrize = betValue * 1000;
  }
  else return 0;

  return Math.floor(basePrize * multiplier);
}

// ========== VERIFICACIÓN DE GANADORES ==========
async function checkRealTimeWinners() {
  const drawn = gameState.numbersDrawn;
  const combos = await new Promise((resolve) => {
    db.all(`SELECT id, ticketCode, numbers, betValue, status FROM bet_combinations WHERE status = 'pending'`, (err, rows) => resolve(rows || []));
  });
  for (const c of combos) {
    if (global.notifiedWinners.has(c.id)) continue;
    const nums = c.numbers.split(',').map(Number);
    const hits = nums.filter(n => drawn.includes(n)).length;
    const numbersCount = nums.length;
    const wonAmount = calculatePrize(numbersCount, hits, c.betValue, gameState.config);
    if (wonAmount > 0) {
      global.notifiedWinners.add(c.id);
      io.emit('ticketWon', {
        ticketCode: c.ticketCode,
        winningNumbers: nums.filter(n => drawn.includes(n)),
        amount: wonAmount,
        combinationId: c.id
      });
    }
  }
}

async function evaluateAllBets() {
  const drawn = gameState.numbersDrawn;
  const combos = await new Promise((resolve) => {
    db.all(`SELECT id, ticketCode, numbers, betValue FROM bet_combinations WHERE status = 'pending'`, (err, rows) => resolve(rows || []));
  });
  const ticketWins = {};
  for (const c of combos) {
    const nums = c.numbers.split(',').map(Number);
    const hits = nums.filter(n => drawn.includes(n)).length;
    const numbersCount = nums.length;
    const won = calculatePrize(numbersCount, hits, c.betValue, gameState.config);
    if (won > 0) {
      db.run(`UPDATE bet_combinations SET status = 'won', wonAmount = ? WHERE id = ?`, [won, c.id]);
      if (!ticketWins[c.ticketCode]) ticketWins[c.ticketCode] = 0;
      ticketWins[c.ticketCode] += won;
    } else {
      db.run(`UPDATE bet_combinations SET status = 'lost' WHERE id = ?`, [c.id]);
    }
  }
  for (const [ticketCode, totalWin] of Object.entries(ticketWins)) {
    db.run(`UPDATE tickets SET status = 'won' WHERE ticketCode = ?`, [ticketCode]);
    io.emit('ticketWon', { ticketCode, amount: totalWin });
  }
}

// ========== CICLO DEL JUEGO ==========
function resetRound() {
  if (gameState.intervalId) clearInterval(gameState.intervalId);
  if (gameState.countdownTimer) clearInterval(gameState.countdownTimer);
  gameState.numbersDrawn = [];
  gameState.availableNumbers = Array.from({ length: 80 }, (_, i) => i + 1);
  gameState.isBettingPhase = true;
  global.notifiedWinners = new Set();
  io.emit('resetGame', { round: gameState.roundNumber });
  io.emit('phaseChange', { isBettingPhase: true });
  io.emit('countdown', { remaining: 240, phase: 'betting' });
  saveCurrentRoundState();

  let remaining = 240;
  gameState.countdownTimer = setInterval(() => {
    remaining--;
    io.emit('countdown', { remaining, phase: 'betting' });
    if (remaining <= 0) {
      clearInterval(gameState.countdownTimer);
      startDrawingPhase();
    }
  }, 1000);
}

// Función de sorteo mejorada: respeta la configuración avoidBetNumbers
async function startDrawingPhase() {
  gameState.isBettingPhase = false;
  io.emit('phaseChange', { isBettingPhase: false });
  io.emit('bettingClosed');
  io.emit('countdown', { remaining: 0, phase: 'drawing' });
  io.emit('speak', { message: '¡Inicia el sorteo!' });

  if (gameState.numbersDrawn.length >= 20) {
    endRound();
    return;
  }

  const avoidBetNumbers = gameState.config.avoidBetNumbers === 'true';

  let numbersToDraw = [];

  if (avoidBetNumbers) {
    // Modo trampa: evitar números apostados
    const combos = await new Promise((resolve) => {
      db.all(`SELECT numbers FROM bet_combinations WHERE status = 'pending'`, (err, rows) => resolve(rows || []));
    });
    const betNumbersSet = new Set();
    for (const combo of combos) {
      const nums = combo.numbers.split(',').map(Number);
      nums.forEach(n => betNumbersSet.add(n));
    }

    const allNumbers = Array.from({ length: 80 }, (_, i) => i + 1);
    const nonBetNumbers = allNumbers.filter(n => !betNumbersSet.has(n));
    const alreadyDrawn = gameState.numbersDrawn;
    const needed = 20 - alreadyDrawn.length;

    if (nonBetNumbers.length >= needed) {
      const shuffledNonBet = [...nonBetNumbers];
      for (let i = shuffledNonBet.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffledNonBet[i], shuffledNonBet[j]] = [shuffledNonBet[j], shuffledNonBet[i]];
      }
      numbersToDraw = shuffledNonBet.slice(0, needed);
    } else {
      numbersToDraw = [...nonBetNumbers];
      const remaining = needed - numbersToDraw.length;
      const availableBetNumbers = [...betNumbersSet].filter(n => !alreadyDrawn.includes(n));
      const shuffledBet = [...availableBetNumbers];
      for (let i = shuffledBet.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffledBet[i], shuffledBet[j]] = [shuffledBet[j], shuffledBet[i]];
      }
      numbersToDraw.push(...shuffledBet.slice(0, remaining));
    }
  } else {
    // Modo normal: sorteo completamente aleatorio
    if (gameState.numbersDrawn.length === 0) {
      const shuffled = Array.from({ length: 80 }, (_, i) => i + 1);
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      numbersToDraw = shuffled.slice(0, 20);
    } else {
      const remainingNumbers = gameState.availableNumbers.filter(n => !gameState.numbersDrawn.includes(n));
      const needed = 20 - gameState.numbersDrawn.length;
      const shuffledRemaining = [...remainingNumbers];
      for (let i = shuffledRemaining.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffledRemaining[i], shuffledRemaining[j]] = [shuffledRemaining[j], shuffledRemaining[i]];
      }
      numbersToDraw = shuffledRemaining.slice(0, needed);
    }
  }

  let drawIndex = 0;
  gameState.intervalId = setInterval(async () => {
    if (drawIndex >= numbersToDraw.length) {
      clearInterval(gameState.intervalId);
      endRound();
      return;
    }
    const num = numbersToDraw[drawIndex];
    gameState.numbersDrawn.push(num);
    const idx = gameState.availableNumbers.indexOf(num);
    if (idx !== -1) gameState.availableNumbers.splice(idx, 1);
    io.emit('newNumber', { number: num, drawnList: gameState.numbersDrawn });
    await checkRealTimeWinners();
    await saveCurrentRoundState();
    drawIndex++;
  }, gameState.drawIntervalMs);
}

async function endRound() {
  clearInterval(gameState.intervalId);
  io.emit('gameEnd', { numbers: gameState.numbersDrawn });
  await db.run(`INSERT INTO rounds (roundNumber, numbers, playedAt, miniAccumulatedValue) VALUES (?, ?, ?, ?)`,
    [gameState.roundNumber, JSON.stringify(gameState.numbersDrawn), new Date().toISOString(), gameState.miniAccumulated]);
  await evaluateAllBets();
  const totalBet = await getTotalBetThisRound();
  gameState.miniAccumulated += Math.floor(totalBet * 0.10);
  const target = parseInt(gameState.config.miniAccumulatedTarget) || 500000;
  io.emit('updateMiniAccumulated', { current: gameState.miniAccumulated, target });
  
  if (gameState.miniAccumulated >= target) {
    const winner = await getRandomPendingTicket();
    if (winner) {
      const prize = Math.floor(gameState.miniAccumulated * (parseFloat(gameState.config.miniAccumulatedPercentage) || 0.35));
      db.run(`INSERT INTO special_winners (ticketCode, amount, awardedAt) VALUES (?, ?, ?)`, [winner, prize, new Date().toISOString()]);
      io.emit('accumulatedWinner', { ticketCode: winner, amount: prize });
      console.log(`🎉 Acumulado explotó! Ganador: ${winner} - Premio: $${prize}`);
    } else {
      console.log('⚠️ Acumulado alcanzó el objetivo pero no hay boletas pendientes. El premio se pierde y el acumulado se reinicia.');
    }
    gameState.miniAccumulated = 0;
    await savePersistentState();
  }

  setTimeout(async () => {
    gameState.roundNumber++;
    if (gameState.roundNumber > 999999) gameState.roundNumber = 1;
    io.emit('roundUpdate', { round: gameState.roundNumber });
    await savePersistentState();
    resetRound();
  }, 8000);
  await savePersistentState();
  await saveCurrentRoundState();
}

// ========== API REST ==========
app.post('/api/bets/create', async (req, res) => {
  if (!gameState.isBettingPhase) return res.status(403).json({ error: 'Apuestas cerradas.' });
  const { combinations } = req.body;
  if (!combinations || !combinations.length) return res.status(400).json({ error: 'No combinations' });
  const currentBudget = parseInt(gameState.config.machineBudget) || 0;
  const total = combinations.reduce((s, c) => s + c.betValue, 0);
  if (currentBudget < total) return res.status(403).json({ error: 'Presupuesto insuficiente.' });
  const ticketCode = uuidv4().slice(0, 8).toUpperCase();
  const now = new Date().toISOString();
  db.run(`INSERT INTO tickets (ticketCode, createdAt, totalAmount, status, roundNumber) VALUES (?, ?, ?, ?, ?)`,
    [ticketCode, now, total, 'pending', gameState.roundNumber]);
  for (const combo of combinations) {
    const numbersStr = combo.numbers.join(',');
    db.run(`INSERT INTO bet_combinations (ticketCode, numbers, betValue, status) VALUES (?, ?, ?, ?)`,
      [ticketCode, numbersStr, combo.betValue, 'pending']);
  }
  const newBudget = currentBudget - total;
  await setConfig('machineBudget', newBudget);
  io.emit('budgetUpdated', { budget: newBudget });
  const netProfit = await getMachineNetProfit();
  const dailyProfit = await getDailyProfit();
  io.emit('netProfitUpdated', { netProfit });
  io.emit('dailyProfitUpdated', { dailyProfit });
  res.json({ ticketCode, totalAmount: total, status: 'pending' });
});

app.delete('/api/ticket/:code', async (req, res) => {
  const { code } = req.params;
  db.get(`SELECT totalAmount FROM tickets WHERE ticketCode = ?`, [code], async (err, ticket) => {
    if (err || !ticket) return res.status(404).json({ error: 'Boleta no encontrada' });
    const total = ticket.totalAmount;
    db.run(`DELETE FROM bet_combinations WHERE ticketCode = ?`, [code]);
    db.run(`DELETE FROM tickets WHERE ticketCode = ?`, [code], async (err2) => {
      if (err2) return res.status(500).json({ error: err2.message });
      const currBudget = parseInt(gameState.config.machineBudget) || 0;
      const newBudget = currBudget + total;
      await setConfig('machineBudget', newBudget);
      io.emit('budgetUpdated', { budget: newBudget });
      const netProfit = await getMachineNetProfit();
      const dailyProfit = await getDailyProfit();
      io.emit('netProfitUpdated', { netProfit });
      io.emit('dailyProfitUpdated', { dailyProfit });
      res.json({ success: true, refunded: total });
    });
  });
});

app.get('/api/ticket/full/:code', (req, res) => {
  const { code } = req.params;
  db.get(`SELECT * FROM tickets WHERE ticketCode = ?`, [code], (err, ticket) => {
    if (err || !ticket) return res.status(404).json({ error: 'Boleta no encontrada' });
    db.all(`SELECT numbers, betValue FROM bet_combinations WHERE ticketCode = ?`, [code], (err2, combos) => {
      if (err2) return res.status(500).json({ error: 'Error interno' });
      res.json({ ticket, combinations: combos.map(c => ({ numbers: c.numbers.split(',').map(Number), betValue: c.betValue })) });
    });
  });
});

app.get('/api/ticket/:code', (req, res) => {
  const { code } = req.params;
  db.get(`SELECT ticketCode, status, paidAt, (SELECT SUM(wonAmount) FROM bet_combinations WHERE ticketCode = ? AND status='won') as toPay FROM tickets WHERE ticketCode = ?`, [code, code], (err, ticket) => {
    if (err || !ticket) return res.status(404).json({ error: 'Boleta no encontrada' });
    res.json(ticket);
  });
});

app.get('/api/tickets/recent', (req, res) => {
  const currentRound = gameState.roundNumber;
  const minRound = Math.max(1, currentRound - 4);
  db.all(`
    SELECT t.ticketCode, t.createdAt, t.totalAmount, t.status, t.paidAt, t.roundNumber,
      (SELECT GROUP_CONCAT(numbers || ':' || betValue, '|') FROM bet_combinations WHERE ticketCode = t.ticketCode) as combinationsData
    FROM tickets t WHERE t.roundNumber >= ? AND t.roundNumber <= ? ORDER BY t.createdAt DESC
  `, [minRound, currentRound], (err, tickets) => {
    if (err) return res.status(500).json({ error: err.message });
    const result = tickets.map(t => {
      const combos = [];
      if (t.combinationsData) {
        const parts = t.combinationsData.split('|');
        parts.forEach(p => {
          const [nums, val] = p.split(':');
          if (nums && val) combos.push({ numbers: nums.split(',').map(Number), betValue: parseInt(val) });
        });
      }
      return { ...t, combinations: combos, combinationsData: undefined };
    });
    res.json(result);
  });
});

app.get('/api/stats/daily-profit', async (req, res) => {
  const profit = await getDailyProfit();
  res.json({ profit });
});

app.get('/api/stats/hotcold', (req, res) => {
  const limit = 20;
  db.all(`SELECT numbers FROM rounds ORDER BY id DESC LIMIT ?`, [limit], (err, rows) => {
    if (err || !rows.length) return res.json({ hot: [], cold: [] });
    const freq = {};
    for (let i = 1; i <= 80; i++) freq[i] = 0;
    rows.forEach(row => {
      const nums = JSON.parse(row.numbers);
      nums.forEach(n => { if (freq[n] !== undefined) freq[n]++; });
    });
    const sorted = Object.entries(freq).sort((a,b) => b[1] - a[1]);
    const hot = sorted.slice(0, 10).map(([num]) => parseInt(num));
    const cold = sorted.slice(-10).map(([num]) => parseInt(num));
    res.json({ hot, cold });
  });
});

app.get('/api/stats/random-hotcold', (req, res) => {
  const all = Array.from({ length: 80 }, (_, i) => i + 1);
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  const hot = all.slice(0, 5);
  const cold = all.slice(5, 10);
  res.json({ hot, cold });
});

app.get('/api/admin/budget', async (req, res) => {
  const budget = parseInt(gameState.config.machineBudget) || 0;
  const profit = await getMachineNetProfit();
  const dailyProfit = await getDailyProfit();
  res.json({ budget, profit, dailyProfit });
});

app.get('/api/admin/config', (req, res) => {
  const { machineBudget, miniAccumulatedTarget, miniAccumulatedPercentage, drawInterval, globalMultiplier, currentRound, currentMiniAccumulated, avoidBetNumbers } = gameState.config;
  res.json({ machineBudget, miniAccumulatedTarget, miniAccumulatedPercentage, drawInterval, globalMultiplier, currentRound, currentMiniAccumulated, avoidBetNumbers });
});

app.post('/api/admin/config', (req, res) => {
  const allowed = ['machineBudget', 'miniAccumulatedTarget', 'miniAccumulatedPercentage', 'drawInterval', 'globalMultiplier', 'avoidBetNumbers'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  Promise.all(Object.entries(updates).map(([k, v]) => setConfig(k, v)))
    .then(async () => {
      const budget = parseInt(gameState.config.machineBudget) || 0;
      const profit = await getMachineNetProfit();
      const dailyProfit = await getDailyProfit();
      io.emit('budgetUpdated', { budget });
      io.emit('netProfitUpdated', { profit });
      io.emit('dailyProfitUpdated', { dailyProfit });
      io.emit('trapModeChanged', { enabled: gameState.config.avoidBetNumbers === 'true' });
      res.json({ success: true });
    });
});

app.post('/api/admin/set-budget', async (req, res) => {
  const { amount } = req.body;
  if (amount === undefined || amount < 0) return res.status(400).json({ error: 'Monto inválido' });
  await setConfig('machineBudget', amount);
  io.emit('budgetUpdated', { budget: amount });
  res.json({ success: true, newBudget: amount });
});

app.post('/api/admin/reload-budget', async (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Monto inválido' });
  const currBudget = parseInt(gameState.config.machineBudget) || 0;
  const newBudget = currBudget + amount;
  await setConfig('machineBudget', newBudget);
  io.emit('budgetUpdated', { budget: newBudget });
  res.json({ success: true, newBudget });
});

app.delete('/api/admin/delete-history', async (req, res) => {
  try {
    await db.run(`DELETE FROM bet_combinations`);
    await db.run(`DELETE FROM tickets`);
    await db.run(`DELETE FROM rounds`);
    await db.run(`DELETE FROM special_winners`);
    gameState.miniAccumulated = 0;
    gameState.roundNumber = 1;
    await savePersistentState();
    await saveCurrentRoundState();
    io.emit('updateMiniAccumulated', { current: 0, target: parseInt(gameState.config.miniAccumulatedTarget) || 500000 });
    const netProfit = await getMachineNetProfit();
    const dailyProfit = await getDailyProfit();
    io.emit('netProfitUpdated', { netProfit });
    io.emit('dailyProfitUpdated', { dailyProfit });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/tickets', (req, res) => {
  const { from, to, status } = req.query;
  let sql = `SELECT t.*, (SELECT SUM(wonAmount) FROM bet_combinations WHERE ticketCode = t.ticketCode) as totalWon FROM tickets t WHERE 1=1`;
  const params = [];
  if (from) { sql += ` AND t.createdAt >= ?`; params.push(from); }
  if (to) { sql += ` AND t.createdAt <= ?`; params.push(to); }
  if (status) { sql += ` AND t.status = ?`; params.push(status); }
  db.all(sql, params, (err, rows) => res.json(rows || []));
});

app.get('/api/admin/pending-payments', (req, res) => {
  db.all(`
    SELECT t.ticketCode, t.totalAmount, (SELECT SUM(wonAmount) FROM bet_combinations WHERE ticketCode = t.ticketCode AND status='won') as toPay
    FROM tickets t WHERE t.status IN ('won') AND t.paidAt IS NULL
  `, (err, rows) => res.json(rows || []));
});

app.post('/api/admin/pay-ticket', async (req, res) => {
  const { ticketCode, amount } = req.body;
  db.run(`UPDATE tickets SET paidAt = ?, status = 'paid' WHERE ticketCode = ?`, [new Date().toISOString(), ticketCode], async (err) => {
    if (err) return res.status(500).json({ error: err.message });
    const netProfit = await getMachineNetProfit();
    const dailyProfit = await getDailyProfit();
    io.emit('netProfitUpdated', { netProfit });
    io.emit('dailyProfitUpdated', { dailyProfit });
    io.emit('ticketPaid', { ticketCode, amount, isRepeat: false });
    res.json({ success: true });
  });
});

app.post('/api/ticket/pay-and-repeat', async (req, res) => {
  const { ticketCode, amount } = req.body;
  if (!ticketCode || amount === undefined) return res.status(400).json({ error: 'Datos incompletos' });

  const originalTicket = await new Promise((resolve) => {
    db.get(`SELECT * FROM tickets WHERE ticketCode = ?`, [ticketCode], (err, row) => resolve(row));
  });
  if (!originalTicket) return res.status(404).json({ error: 'Boleta no encontrada' });
  if (originalTicket.status !== 'won') return res.status(400).json({ error: 'Esta boleta no tiene premios pendientes' });
  if (originalTicket.paidAt) return res.status(400).json({ error: 'Esta boleta ya fue pagada' });

  const combinations = await new Promise((resolve) => {
    db.all(`SELECT numbers, betValue FROM bet_combinations WHERE ticketCode = ?`, [ticketCode], (err, rows) => resolve(rows || []));
  });
  if (!combinations.length) return res.status(404).json({ error: 'Boleta sin combinaciones' });

  try {
    await new Promise((resolve, reject) => {
      db.run(`UPDATE tickets SET paidAt = ?, status = 'paid' WHERE ticketCode = ?`, [new Date().toISOString(), ticketCode], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    const newTicketCode = uuidv4().slice(0, 8).toUpperCase();
    const now = new Date().toISOString();
    const newTotal = combinations.reduce((sum, c) => sum + c.betValue, 0);
    const currentBudget = parseInt(gameState.config.machineBudget) || 0;
    if (currentBudget < newTotal) throw new Error('Presupuesto insuficiente para repetir la apuesta');
    await new Promise((resolve, reject) => {
      db.run(`INSERT INTO tickets (ticketCode, createdAt, totalAmount, status, roundNumber) VALUES (?, ?, ?, ?, ?)`,
        [newTicketCode, now, newTotal, 'pending', gameState.roundNumber], (err) => {
          if (err) reject(err);
          else resolve();
        });
    });
    for (const combo of combinations) {
      const numbersStr = combo.numbers;
      await new Promise((resolve, reject) => {
        db.run(`INSERT INTO bet_combinations (ticketCode, numbers, betValue, status) VALUES (?, ?, ?, ?)`,
          [newTicketCode, numbersStr, combo.betValue, 'pending'], (err) => {
            if (err) reject(err);
            else resolve();
          });
      });
    }

    const newBudget = currentBudget - newTotal;
    await setConfig('machineBudget', newBudget);
    io.emit('budgetUpdated', { budget: newBudget });

    const netProfit = await getMachineNetProfit();
    const dailyProfit = await getDailyProfit();
    io.emit('netProfitUpdated', { netProfit });
    io.emit('dailyProfitUpdated', { dailyProfit });
    io.emit('ticketPaid', { ticketCode, amount, isRepeat: true });
    io.emit('ticketRepeated', { originalCode: ticketCode, newCode: newTicketCode, combinations, total: newTotal });

    res.json({ success: true, newTicketCode, newTotal });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error interno al procesar el pago y repetición' });
  }
});

app.post('/api/ticket/pay', async (req, res) => {
  const { ticketCode, amount } = req.body;
  if (!ticketCode || amount === undefined) return res.status(400).json({ error: 'Datos incompletos' });
  db.get(`SELECT status, paidAt FROM tickets WHERE ticketCode = ?`, [ticketCode], async (err, ticket) => {
    if (err || !ticket) return res.status(404).json({ error: 'Boleta no encontrada' });
    if (ticket.status !== 'won') return res.status(400).json({ error: 'Esta boleta no tiene premios pendientes' });
    if (ticket.paidAt) return res.status(400).json({ error: 'Esta boleta ya fue pagada' });
    db.run(`UPDATE tickets SET paidAt = ?, status = 'paid' WHERE ticketCode = ?`, [new Date().toISOString(), ticketCode], async (err2) => {
      if (err2) return res.status(500).json({ error: err2.message });
      const netProfit = await getMachineNetProfit();
      const dailyProfit = await getDailyProfit();
      io.emit('netProfitUpdated', { netProfit });
      io.emit('dailyProfitUpdated', { dailyProfit });
      io.emit('ticketPaid', { ticketCode, amount, isRepeat: false });
      res.json({ success: true });
    });
  });
});

app.post('/api/tickets/repeat', async (req, res) => {
  if (!gameState.isBettingPhase) return res.status(403).json({ error: 'Apuestas cerradas.' });
  const { ticketCode } = req.body;
  if (!ticketCode) return res.status(400).json({ error: 'Código requerido' });
  db.all(`SELECT numbers, betValue FROM bet_combinations WHERE ticketCode = ?`, [ticketCode], async (err, combos) => {
    if (err || !combos.length) return res.status(404).json({ error: 'Boleta no encontrada' });
    const combinations = combos.map(c => ({ numbers: c.numbers.split(',').map(Number), betValue: c.betValue }));
    const currentBudget = parseInt(gameState.config.machineBudget) || 0;
    const total = combinations.reduce((s, c) => s + c.betValue, 0);
    if (currentBudget < total) return res.status(403).json({ error: 'Presupuesto insuficiente.' });
    const newTicketCode = uuidv4().slice(0, 8).toUpperCase();
    const now = new Date().toISOString();
    db.run(`INSERT INTO tickets (ticketCode, createdAt, totalAmount, status, roundNumber) VALUES (?, ?, ?, ?, ?)`,
      [newTicketCode, now, total, 'pending', gameState.roundNumber]);
    for (const combo of combinations) {
      const numbersStr = combo.numbers.join(',');
      db.run(`INSERT INTO bet_combinations (ticketCode, numbers, betValue, status) VALUES (?, ?, ?, ?)`,
        [newTicketCode, numbersStr, combo.betValue, 'pending']);
    }
    const newBudget = currentBudget - total;
    await setConfig('machineBudget', newBudget);
    io.emit('budgetUpdated', { budget: newBudget });
    const netProfit = await getMachineNetProfit();
    const dailyProfit = await getDailyProfit();
    io.emit('netProfitUpdated', { netProfit });
    io.emit('dailyProfitUpdated', { dailyProfit });
    io.emit('ticketRepeated', { originalCode: ticketCode, newCode: newTicketCode, combinations, total });
    res.json({ success: true, ticketCode: newTicketCode, totalAmount: total });
  });
});

// Nuevo endpoint para cambiar el modo trampa desde el panel de apuestas
app.post('/api/toggle-trap-mode', async (req, res) => {
  const current = gameState.config.avoidBetNumbers === 'true';
  const newValue = !current;
  await setConfig('avoidBetNumbers', newValue ? 'true' : 'false');
  io.emit('trapModeChanged', { enabled: newValue });
  res.json({ success: true, enabled: newValue });
});

io.on('connection', async (socket) => {
  const budget = parseInt(gameState.config.machineBudget) || 0;
  const netProfit = await getMachineNetProfit();
  const dailyProfit = await getDailyProfit();
  socket.emit('gameState', {
    numbersDrawn: gameState.numbersDrawn,
    isBettingPhase: gameState.isBettingPhase,
    round: gameState.roundNumber,
    miniAccumulated: gameState.miniAccumulated,
    miniTarget: gameState.config.miniAccumulatedTarget || 500000
  });
  socket.emit('phaseChange', { isBettingPhase: gameState.isBettingPhase });
  socket.emit('budgetUpdated', { budget });
  socket.emit('netProfitUpdated', { netProfit });
  socket.emit('dailyProfitUpdated', { dailyProfit });
  socket.emit('roundUpdate', { round: gameState.roundNumber });
  socket.emit('trapModeChanged', { enabled: gameState.config.avoidBetNumbers === 'true' });
});

loadConfig().then(async () => {
  if (!gameState.config.machineBudget) setConfig('machineBudget', '5000000');
  if (!gameState.config.drawInterval) setConfig('drawInterval', '2500');
  if (!gameState.config.globalMultiplier) setConfig('globalMultiplier', '1.0');
  if (!gameState.config.currentRound) setConfig('currentRound', gameState.roundNumber);
  if (!gameState.config.currentMiniAccumulated) setConfig('currentMiniAccumulated', gameState.miniAccumulated);
  if (!gameState.config.avoidBetNumbers) setConfig('avoidBetNumbers', 'false');
  await loadCurrentRoundState();

  if (gameState.isBettingPhase) {
    resetRound();
  } else {
    startDrawingPhase();
  }
});
server.listen(3000, () => console.log('Servidor en http://localhost:3000'));