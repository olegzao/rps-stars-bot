try { require('dotenv').config(); } catch {}
console.log('BOT_TOKEN present:', !!process.env.BOT_TOKEN);
console.log('WEBAPP_URL:', process.env.WEBAPP_URL);
console.log('PORT:', process.env.PORT);
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const { initDb, getUser, createUser, getBalance, deductStars, awardWinner, handleDraw, addRound, createGame, joinGame, endGame: endGameDb } = require('./db');
const { initBot, setBalanceUpdateCallback, refundStars, validateInitData } = require('./bot');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL || 'http://localhost:3000';
const PORT = process.env.PORT || 3000;
const ROUND_TIME = 5000;
const STAKE = 1;
const COIN_STARTING_POINTS = 10;

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is required in .env');
  process.exit(1);
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- Rooms & Matchmaking ---
const rooms = new Map();
const matchQueue = []; // [{playerId, socket}]

// --- Coin Flip Rooms & Matchmaking ---
const coinRooms = new Map();
const coinMatchQueue = [];

function newCoinRoom(roomId, playerId) {
  return {
    id: roomId,
    gameType: 'coin',
    players: {
      [playerId]: { id: playerId, points: COIN_STARTING_POINTS, socket: null, ready: false, roundsWon: 0 }
    },
    round: 0,
    status: 'waiting', // waiting | ready_check | proposing | responding | flipping | finished
    timer: null,
    currentBet: null,    // { amount, choice, proposerId }
    turnOrder: [],       // [id1, id2] — who proposes next
    turnIndex: 0,
  };
}

function coinGetPlayerIds(room) {
  return Object.keys(room.players).map(Number);
}

function coinGetOpponentId(room, playerId) {
  return coinGetPlayerIds(room).find((id) => id !== playerId);
}

function coinBroadcast(room, event, data) {
  for (const p of Object.values(room.players)) {
    if (p.socket) p.socket.emit(event, data);
  }
}

function coinGetPoints(room) {
  const pts = {};
  for (const pid of coinGetPlayerIds(room)) pts[pid] = room.players[pid].points;
  return pts;
}

function coinEnterReadyCheck(room) {
  room.status = 'ready_check';
  for (const p of Object.values(room.players)) p.ready = false;

  const playersList = coinGetPlayerIds(room).map((id) => {
    const u = getUser(id);
    return { id, username: u?.username || '', firstName: u?.first_name || '' };
  });

  coinBroadcast(room, 'coin_game_ready', { players: playersList, points: coinGetPoints(room) });
  coinBroadcast(room, 'coin_ready_check', { readyPlayers: [] });
}

function coinCheckGameOver(room) {
  const ids = coinGetPlayerIds(room);
  const someoneOut = ids.some((id) => room.players[id].points <= 0);
  if (someoneOut) {
    const scores = {};
    ids.forEach((id) => { scores[id] = room.players[id].roundsWon; });
    coinBroadcast(room, 'coin_game_over', { scores, points: coinGetPoints(room), reason: 'bankrupt' });
    endGameDb(room.id);
    room.status = 'finished';
    return true;
  }
  return false;
}

function coinStartProposing(room) {
  room.round++;
  room.status = 'proposing';
  room.currentBet = null;

  const proposerId = room.turnOrder[room.turnIndex % 2];
  const maxBet = Math.min(10, ...coinGetPlayerIds(room).map((id) => room.players[id].points));

  coinBroadcast(room, 'coin_propose_turn', {
    round: room.round,
    proposerId,
    maxBet,
    points: coinGetPoints(room),
  });
}

function coinFlip(room) {
  room.status = 'flipping';
  const coinResult = Math.random() < 0.5 ? 'heads' : 'tails';
  const bet = room.currentBet;
  const proposerId = bet.proposerId;
  const responderId = coinGetOpponentId(room, proposerId);

  let winnerId = null, loserId = null;
  if (bet.choice === coinResult) {
    winnerId = proposerId;
    loserId = responderId;
  } else {
    winnerId = responderId;
    loserId = proposerId;
  }

  room.players[winnerId].points += bet.amount;
  room.players[loserId].points -= bet.amount;
  room.players[winnerId].roundsWon++;

  addRound(room.id, room.round, bet.choice, coinResult, winnerId);

  coinBroadcast(room, 'coin_flip_result', {
    round: room.round,
    coinResult,
    proposerChoice: bet.choice,
    betAmount: bet.amount,
    proposerId,
    responderId,
    winnerId,
    loserId,
    points: coinGetPoints(room),
    roundsWon: { [proposerId]: room.players[proposerId].roundsWon, [responderId]: room.players[responderId].roundsWon },
  });

  // Switch turn
  room.turnIndex++;

  setTimeout(() => {
    if (!coinCheckGameOver(room)) {
      coinStartProposing(room);
    }
  }, 3500);
}

function newRoom(roomId, playerId) {
  return {
    id: roomId,
    players: { [playerId]: { id: playerId, choice: null, socket: null, score: 0, ready: false } },
    round: 0,
    status: 'waiting',
    timer: null,
  };
}

function getPlayerIds(room) {
  return Object.keys(room.players).map(Number);
}

function getOpponentId(room, playerId) {
  return getPlayerIds(room).find((id) => id !== playerId);
}

function determineWinner(c1, c2) {
  if (c1 === c2) return 'draw';
  const wins = { rock: 'scissors', scissors: 'paper', paper: 'rock' };
  return wins[c1] === c2 ? 'p1' : 'p2';
}

function broadcastToRoom(room, event, data) {
  for (const p of Object.values(room.players)) {
    if (p.socket) p.socket.emit(event, data);
  }
}

function getBalances(room) {
  const b = {};
  for (const pid of getPlayerIds(room)) b[pid] = getBalance(pid);
  return b;
}

function startRound(room) {
  const ids = getPlayerIds(room);
  if (ids.length < 2) return;

  room.round++;
  for (const p of Object.values(room.players)) p.choice = null;
  room.status = 'playing';

  broadcastToRoom(room, 'round_start', {
    round: room.round,
    pot: STAKE * 2,
    balances: getBalances(room),
    timeMs: ROUND_TIME,
  });

  room.timer = setTimeout(() => resolveRound(room), ROUND_TIME);
}

function resolveRound(room) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }

  const ids = getPlayerIds(room);
  if (ids.length < 2) return;

  const [p1Id, p2Id] = ids;
  const p1 = room.players[p1Id], p2 = room.players[p2Id];
  const c1 = p1.choice, c2 = p2.choice;

  let winnerId = null, result;

  if (!c1 && !c2) {
    result = 'draw';
  } else if (!c1) {
    winnerId = p2Id; p2.score++; result = 'timeout';
  } else if (!c2) {
    winnerId = p1Id; p1.score++; result = 'timeout';
  } else {
    const outcome = determineWinner(c1, c2);
    if (outcome === 'draw') {
      result = 'draw';
    } else if (outcome === 'p1') {
      winnerId = p1Id; p1.score++; result = 'win';
    } else {
      winnerId = p2Id; p2.score++; result = 'win';
    }
  }

  addRound(room.id, room.round, c1 || 'timeout', c2 || 'timeout', winnerId);

  broadcastToRoom(room, 'round_result', {
    round: room.round,
    choices: { [p1Id]: c1 || 'timeout', [p2Id]: c2 || 'timeout' },
    winnerId,
    result,
    scores: { [p1Id]: p1.score, [p2Id]: p2.score },
    balances: getBalances(room),
  });

  room.status = 'ready_check';
  for (const p of Object.values(room.players)) p.ready = false;
}

function enterReadyCheck(room) {
  room.status = 'ready_check';
  for (const p of Object.values(room.players)) p.ready = false;

  const playersList = getPlayerIds(room).map((id) => {
    const u = getUser(id);
    return { id, username: u?.username || '', firstName: u?.first_name || '' };
  });

  broadcastToRoom(room, 'game_ready', { players: playersList });
  broadcastToRoom(room, 'ready_check', { readyPlayers: [] });
}

// --- API ---
app.get('/api/user/:telegramId', (req, res) => {
  const user = getUser(parseInt(req.params.telegramId, 10));
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

app.post('/api/refund', async (req, res) => {
  const { telegramId, initData } = req.body;
  const userData = validateInitData(initData, BOT_TOKEN);
  if (!userData || userData.id !== telegramId) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const user = getUser(telegramId);
  if (!user || user.balance <= 0) return res.status(400).json({ error: 'Nothing to refund' });
  const refunded = await refundStars(telegramId, user.balance);
  res.json({ refunded, balance: getUser(telegramId).balance });
});

// --- Socket.IO ---
io.on('connection', (socket) => {
  // Store state on socket object so matchmaking can set it from another closure
  socket._playerId = null;
  socket._currentRoom = null;

  socket.on('auth', (data) => {
    let user = validateInitData(data.initData, BOT_TOKEN);
    if (!user) {
      try {
        const params = new URLSearchParams(data.initData);
        const userStr = params.get('user');
        if (userStr) user = JSON.parse(userStr);
      } catch {}
    }
    if (!user) {
      user = { id: Math.floor(Math.random() * 900000000) + 100000000, username: 'guest', first_name: 'Гость' };
    }

    socket._playerId = user.id;
    createUser(user.id, user.username || '', user.first_name || '');
    socket.emit('auth_ok', { user: getUser(user.id) });
  });

  socket.on('join_room', (data) => {
    if (!socket._playerId) return;
    const pid = socket._playerId;

    const roomId = data.roomId || crypto.randomBytes(4).toString('hex');
    let room = rooms.get(roomId);

    if (!room) {
      room = newRoom(roomId, pid);
      rooms.set(roomId, room);
      createGame(roomId, pid);
    } else if (!room.players[pid] && getPlayerIds(room).length < 2) {
      room.players[pid] = { id: pid, choice: null, socket: null, score: 0, ready: false };
      joinGame(pid, roomId);
    } else if (!room.players[pid]) {
      socket.emit('room_full');
      return;
    }

    room.players[pid].socket = socket;
    socket._currentRoom = roomId;

    socket.emit('room_joined', {
      roomId,
      players: getPlayerIds(room).map((id) => {
        const u = getUser(id);
        return { id, username: u?.username || '', firstName: u?.first_name || '' };
      }),
    });

    if (getPlayerIds(room).length === 2) {
      enterReadyCheck(room);
    } else {
      socket.emit('waiting_opponent');
    }
  });

  socket.on('find_game', () => {
    if (!socket._playerId) return;
    const pid = socket._playerId;

    // Remove if already in queue
    const idx = matchQueue.findIndex((q) => q.playerId === pid);
    if (idx !== -1) matchQueue.splice(idx, 1);

    if (matchQueue.length > 0) {
      const opponent = matchQueue.shift();

      if (!opponent.socket.connected) {
        matchQueue.push({ playerId: pid, socket });
        socket.emit('matching', { status: 'searching' });
        return;
      }

      const roomId = crypto.randomBytes(4).toString('hex');
      const room = newRoom(roomId, opponent.playerId);
      room.players[pid] = { id: pid, choice: null, socket: null, score: 0, ready: false };
      rooms.set(roomId, room);
      createGame(roomId, opponent.playerId);
      joinGame(pid, roomId);

      room.players[opponent.playerId].socket = opponent.socket;
      room.players[pid].socket = socket;

      // Set current room on BOTH sockets
      socket._currentRoom = roomId;
      opponent.socket._currentRoom = roomId;

      const playersList = getPlayerIds(room).map((id) => {
        const u = getUser(id);
        return { id, username: u?.username || '', firstName: u?.first_name || '' };
      });

      [opponent.socket, socket].forEach((s) => {
        s.emit('room_joined', { roomId, players: playersList });
      });

      enterReadyCheck(room);
    } else {
      matchQueue.push({ playerId: pid, socket });
      socket.emit('matching', { status: 'searching' });
    }
  });

  socket.on('cancel_search', () => {
    const idx = matchQueue.findIndex((q) => q.playerId === socket._playerId);
    if (idx !== -1) matchQueue.splice(idx, 1);
    socket.emit('matching', { status: 'cancelled' });
  });

  socket.on('make_choice', (data) => {
    const pid = socket._playerId;
    const roomId = socket._currentRoom;
    if (!pid || !roomId) return;
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing') return;
    if (!['rock', 'paper', 'scissors'].includes(data.choice)) return;

    const player = room.players[pid];
    if (!player || player.choice) return;

    player.choice = data.choice;

    const oppId = getOpponentId(room, pid);
    if (oppId && room.players[oppId]?.socket) {
      room.players[oppId].socket.emit('opponent_chose');
    }

    if (getPlayerIds(room).every((id) => room.players[id].choice)) {
      resolveRound(room);
    }
  });

  socket.on('player_ready', () => {
    const pid = socket._playerId;
    const roomId = socket._currentRoom;
    if (!pid || !roomId) return;
    const room = rooms.get(roomId);
    if (!room || room.status !== 'ready_check') return;

    const player = room.players[pid];
    if (!player || player.ready) return;

    player.ready = true;

    const ids = getPlayerIds(room);
    const readyPlayers = ids.filter((id) => room.players[id].ready);

    broadcastToRoom(room, 'ready_update', { readyPlayers, totalPlayers: ids.length });

    if (ids.length === 2 && ids.every((id) => room.players[id].ready)) {
      for (const p of Object.values(room.players)) p.ready = false;
      setTimeout(() => startRound(room), 500);
    }
  });

  socket.on('end_game', () => {
    const roomId = socket._currentRoom;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    if (room.timer) { clearTimeout(room.timer); room.timer = null; }

    if (room.status === 'playing' && socket._playerId) {
      const player = room.players[socket._playerId];
      if (player && !player.choice) resolveRound(room);
    }

    const ids = getPlayerIds(room);
    const scores = {};
    ids.forEach((id) => { scores[id] = room.players[id]?.score || 0; });

    broadcastToRoom(room, 'game_over', { scores, balances: getBalances(room) });
    endGameDb(roomId);
    room.status = 'finished';
  });

  socket.on('rematch', () => {
    const pid = socket._playerId;
    const roomId = socket._currentRoom;
    if (!pid || !roomId) return;
    const room = rooms.get(roomId);
    if (!room || room.status !== 'finished') return;

    room.players[pid].ready = true;
    room.players[pid].score = 0;

    const ids = getPlayerIds(room);
    if (ids.every((id) => room.players[id]?.ready)) {
      room.round = 0;
      ids.forEach((id) => {
        room.players[id].ready = false;
        room.players[id].choice = null;
        room.players[id].score = 0;
      });
      broadcastToRoom(room, 'rematch_start', { balances: getBalances(room) });
      setTimeout(() => enterReadyCheck(room), 500);
    } else {
      const oppId = getOpponentId(room, pid);
      if (oppId && room.players[oppId]?.socket) {
        room.players[oppId].socket.emit('opponent_wants_rematch');
      }
    }
  });

  // === COIN FLIP EVENTS ===
  socket.on('coin_find_game', () => {
    if (!socket._playerId) return;
    const pid = socket._playerId;

    const idx = coinMatchQueue.findIndex((q) => q.playerId === pid);
    if (idx !== -1) coinMatchQueue.splice(idx, 1);

    if (coinMatchQueue.length > 0) {
      const opponent = coinMatchQueue.shift();
      if (!opponent.socket.connected) {
        coinMatchQueue.push({ playerId: pid, socket });
        socket.emit('coin_matching', { status: 'searching' });
        return;
      }

      const roomId = 'coin_' + crypto.randomBytes(4).toString('hex');
      const room = newCoinRoom(roomId, opponent.playerId);
      room.players[pid] = { id: pid, points: COIN_STARTING_POINTS, bet: null, choice: null, socket: null, ready: false, roundsWon: 0 };
      coinRooms.set(roomId, room);
      createGame(roomId, opponent.playerId);
      joinGame(pid, roomId);

      room.players[opponent.playerId].socket = opponent.socket;
      room.players[pid].socket = socket;

      socket._currentRoom = roomId;
      socket._gameType = 'coin';
      opponent.socket._currentRoom = roomId;
      opponent.socket._gameType = 'coin';

      const playersList = coinGetPlayerIds(room).map((id) => {
        const u = getUser(id);
        return { id, username: u?.username || '', firstName: u?.first_name || '' };
      });

      [opponent.socket, socket].forEach((s) => {
        s.emit('coin_room_joined', { roomId, players: playersList, points: coinGetPoints(room) });
      });

      coinEnterReadyCheck(room);
    } else {
      coinMatchQueue.push({ playerId: pid, socket });
      socket.emit('coin_matching', { status: 'searching' });
    }
  });

  socket.on('coin_cancel_search', () => {
    const idx = coinMatchQueue.findIndex((q) => q.playerId === socket._playerId);
    if (idx !== -1) coinMatchQueue.splice(idx, 1);
    socket.emit('coin_matching', { status: 'cancelled' });
  });

  socket.on('coin_player_ready', () => {
    const pid = socket._playerId;
    const roomId = socket._currentRoom;
    if (!pid || !roomId) return;
    const room = coinRooms.get(roomId);
    if (!room || room.status !== 'ready_check') return;

    const player = room.players[pid];
    if (!player || player.ready) return;
    player.ready = true;

    const ids = coinGetPlayerIds(room);
    const readyPlayers = ids.filter((id) => room.players[id].ready);
    coinBroadcast(room, 'coin_ready_update', { readyPlayers, totalPlayers: ids.length });

    if (ids.length === 2 && ids.every((id) => room.players[id].ready)) {
      for (const p of Object.values(room.players)) p.ready = false;
      // Set turn order: first player who joined proposes first
      room.turnOrder = ids;
      room.turnIndex = 0;
      setTimeout(() => coinStartProposing(room), 500);
    }
  });

  // Proposer sends bet amount + choice (heads/tails)
  socket.on('coin_propose_bet', (data) => {
    const pid = socket._playerId;
    const roomId = socket._currentRoom;
    if (!pid || !roomId) return;
    const room = coinRooms.get(roomId);
    if (!room || room.status !== 'proposing') return;

    // Only the current proposer can propose
    const proposerId = room.turnOrder[room.turnIndex % 2];
    if (pid !== proposerId) return;

    const amount = parseInt(data.amount, 10);
    const choice = data.choice;
    const maxBet = Math.min(10, ...coinGetPlayerIds(room).map((id) => room.players[id].points));

    if (!amount || amount < 1 || amount > maxBet) return;
    if (choice !== 'heads' && choice !== 'tails') return;

    room.currentBet = { amount, choice, proposerId: pid };
    room.status = 'responding';

    const responderId = coinGetOpponentId(room, pid);
    const proposerUser = getUser(pid);

    coinBroadcast(room, 'coin_bet_proposed', {
      proposerId: pid,
      proposerName: proposerUser?.first_name || proposerUser?.username || 'Игрок',
      responderId,
      amount,
      choice,
      points: coinGetPoints(room),
    });
  });

  // Responder accepts or declines
  socket.on('coin_respond_bet', (data) => {
    const pid = socket._playerId;
    const roomId = socket._currentRoom;
    if (!pid || !roomId) return;
    const room = coinRooms.get(roomId);
    if (!room || room.status !== 'responding' || !room.currentBet) return;

    // Only the responder can respond
    const responderId = coinGetOpponentId(room, room.currentBet.proposerId);
    if (pid !== responderId) return;

    if (data.accept) {
      // Accepted — flip the coin
      coinFlip(room);
    } else {
      // Declined — responder loses 1 point
      room.players[pid].points -= 1;

      coinBroadcast(room, 'coin_bet_declined', {
        declinerId: pid,
        points: coinGetPoints(room),
      });

      room.turnIndex++;

      setTimeout(() => {
        if (!coinCheckGameOver(room)) {
          coinStartProposing(room);
        }
      }, 2000);
    }
  });

  socket.on('coin_end_game', () => {
    const roomId = socket._currentRoom;
    if (!roomId) return;
    const room = coinRooms.get(roomId);
    if (!room) return;

    if (room.timer) { clearTimeout(room.timer); room.timer = null; }

    const ids = coinGetPlayerIds(room);
    const scores = {};
    ids.forEach((id) => { scores[id] = room.players[id]?.roundsWon || 0; });

    coinBroadcast(room, 'coin_game_over', { scores, points: coinGetPoints(room), reason: 'quit' });
    endGameDb(room.id);
    room.status = 'finished';
  });

  socket.on('coin_rematch', () => {
    const pid = socket._playerId;
    const roomId = socket._currentRoom;
    if (!pid || !roomId) return;
    const room = coinRooms.get(roomId);
    if (!room || room.status !== 'finished') return;

    room.players[pid].ready = true;

    const ids = coinGetPlayerIds(room);
    if (ids.every((id) => room.players[id]?.ready)) {
      room.round = 0;
      room.turnIndex = 0;
      room.currentBet = null;
      ids.forEach((id) => {
        room.players[id].ready = false;
        room.players[id].points = COIN_STARTING_POINTS;
        room.players[id].roundsWon = 0;
      });
      coinBroadcast(room, 'coin_rematch_start', { points: coinGetPoints(room) });
      setTimeout(() => coinEnterReadyCheck(room), 500);
    } else {
      const oppId = coinGetOpponentId(room, pid);
      if (oppId && room.players[oppId]?.socket) {
        room.players[oppId].socket.emit('coin_opponent_wants_rematch');
      }
    }
  });

  socket.on('request_balance', () => {
    if (!socket._playerId) return;
    const user = getUser(socket._playerId);
    if (user) socket.emit('balance_update', { balance: user.balance });
  });

  socket.on('disconnect', () => {
    const pid = socket._playerId;
    const roomId = socket._currentRoom;

    // Remove from matchmaking queues
    const qIdx = matchQueue.findIndex((q) => q.playerId === pid);
    if (qIdx !== -1) matchQueue.splice(qIdx, 1);
    const cqIdx = coinMatchQueue.findIndex((q) => q.playerId === pid);
    if (cqIdx !== -1) coinMatchQueue.splice(cqIdx, 1);

    if (!roomId || !pid) return;

    // Handle coin room disconnect
    const coinRoom = coinRooms.get(roomId);
    if (coinRoom) {
      const oppId = coinGetOpponentId(coinRoom, pid);
      if (oppId && coinRoom.players[oppId]?.socket) {
        coinRoom.players[oppId].socket.emit('coin_opponent_disconnected');
      }
      if (coinRoom.players[pid]) coinRoom.players[pid].socket = null;
      if (coinRoom.timer) { clearTimeout(coinRoom.timer); coinRoom.timer = null; }
      setTimeout(() => {
        const r = coinRooms.get(roomId);
        if (r && coinGetPlayerIds(r).every((id) => !r.players[id]?.socket)) {
          coinRooms.delete(roomId);
        }
      }, 60000);
      return;
    }

    // Handle RPS room disconnect
    const room = rooms.get(roomId);
    if (!room) return;

    if (room.status === 'playing') resolveRound(room);

    const oppId = getOpponentId(room, pid);
    if (oppId && room.players[oppId]?.socket) {
      room.players[oppId].socket.emit('opponent_disconnected');
    }

    if (room.players[pid]) room.players[pid].socket = null;
    if (room.timer) { clearTimeout(room.timer); room.timer = null; }

    setTimeout(() => {
      const r = rooms.get(roomId);
      if (r && getPlayerIds(r).every((id) => !r.players[id]?.socket)) {
        rooms.delete(roomId);
      }
    }, 60000);
  });
});

// Balance update from bot payments
setBalanceUpdateCallback((telegramId, newBalance) => {
  for (const room of rooms.values()) {
    const player = room.players[telegramId];
    if (player?.socket) {
      player.socket.emit('balance_update', { balance: newBalance });
    }
  }
});

// --- Start ---
(async () => {
  await initDb();
  initBot(BOT_TOKEN, WEBAPP_URL);
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
})();
