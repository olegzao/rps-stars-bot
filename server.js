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

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is required in .env');
  process.exit(1);
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- Rooms & Matchmaking ---
const rooms = new Map();
const matchQueue = []; // [{playerId, socket}]

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

  socket.on('request_balance', () => {
    if (!socket._playerId) return;
    const user = getUser(socket._playerId);
    if (user) socket.emit('balance_update', { balance: user.balance });
  });

  socket.on('disconnect', () => {
    const pid = socket._playerId;
    const roomId = socket._currentRoom;

    // Remove from matchmaking queue
    const qIdx = matchQueue.findIndex((q) => q.playerId === pid);
    if (qIdx !== -1) matchQueue.splice(qIdx, 1);

    if (!roomId || !pid) return;
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
