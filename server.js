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
const REVEAL_DELAY = 2000;
const STAKE = 1;

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is required in .env');
  process.exit(1);
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- Rooms ---
const rooms = new Map();

function createRoom(roomId, playerId) {
  return {
    id: roomId,
    players: { [playerId]: { id: playerId, choice: null, socket: null, score: 0, ready: false } },
    round: 0,
    status: 'waiting',
    timer: null,
    roundStartedAt: null,
  };
}

function getPlayerIds(room) {
  return Object.keys(room.players).map(Number);
}

function getOpponentId(room, playerId) {
  const ids = getPlayerIds(room);
  return ids.find((id) => id !== playerId);
}

function determineWinner(choice1, choice2) {
  if (choice1 === choice2) return 'draw';
  const wins = { rock: 'scissors', scissors: 'paper', paper: 'rock' };
  return wins[choice1] === choice2 ? 'p1' : 'p2';
}

function broadcastToRoom(room, event, data) {
  for (const p of Object.values(room.players)) {
    if (p.socket) p.socket.emit(event, data);
  }
}

function getBalances(room) {
  const balances = {};
  for (const pid of getPlayerIds(room)) {
    balances[pid] = getBalance(pid);
  }
  return balances;
}

function startRound(room) {
  const ids = getPlayerIds(room);
  if (ids.length < 2) return;

  for (const pid of ids) {
    const bal = getBalance(pid);
    if (bal < STAKE) {
      const player = room.players[pid];
      if (player.socket) {
        player.socket.emit('no_stars', { balance: bal });
      }
      const oppId = getOpponentId(room, pid);
      if (oppId && room.players[oppId]?.socket) {
        room.players[oppId].socket.emit('opponent_no_stars');
      }
      return;
    }
  }

  const success = deductStars(ids[0], ids[1], STAKE);
  if (!success) {
    broadcastToRoom(room, 'error', { message: 'Недостаточно звёзд' });
    return;
  }

  room.round++;
  for (const p of Object.values(room.players)) {
    p.choice = null;
  }
  room.status = 'playing';
  room.roundStartedAt = Date.now();

  const balances = getBalances(room);

  broadcastToRoom(room, 'round_start', {
    round: room.round,
    pot: STAKE * 2,
    balances,
    timeMs: ROUND_TIME,
  });

  room.timer = setTimeout(() => resolveRound(room), ROUND_TIME);
}

function resolveRound(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }

  const ids = getPlayerIds(room);
  if (ids.length < 2) return;

  const [p1Id, p2Id] = ids;
  const p1 = room.players[p1Id];
  const p2 = room.players[p2Id];
  const c1 = p1.choice;
  const c2 = p2.choice;

  let winnerId = null;
  let loserId = null;
  let result;

  if (!c1 && !c2) {
    handleDraw(p1Id, p2Id, STAKE);
    result = 'draw';
  } else if (!c1) {
    winnerId = p2Id;
    loserId = p1Id;
    awardWinner(p2Id, p1Id, STAKE * 2);
    p2.score++;
    result = 'timeout';
  } else if (!c2) {
    winnerId = p1Id;
    loserId = p2Id;
    awardWinner(p1Id, p2Id, STAKE * 2);
    p1.score++;
    result = 'timeout';
  } else {
    const outcome = determineWinner(c1, c2);
    if (outcome === 'draw') {
      handleDraw(p1Id, p2Id, STAKE);
      result = 'draw';
    } else if (outcome === 'p1') {
      winnerId = p1Id;
      loserId = p2Id;
      awardWinner(p1Id, p2Id, STAKE * 2);
      p1.score++;
      result = 'win';
    } else {
      winnerId = p2Id;
      loserId = p1Id;
      awardWinner(p2Id, p1Id, STAKE * 2);
      p2.score++;
      result = 'win';
    }
  }

  addRound(room.id, room.round, c1 || 'timeout', c2 || 'timeout', winnerId);

  const balances = getBalances(room);

  broadcastToRoom(room, 'round_result', {
    round: room.round,
    choices: { [p1Id]: c1 || 'timeout', [p2Id]: c2 || 'timeout' },
    winnerId,
    result,
    scores: { [p1Id]: p1.score, [p2Id]: p2.score },
    balances,
  });

  room.status = 'reveal';
  setTimeout(() => {
    if (room.status === 'reveal') {
      startRound(room);
    }
  }, REVEAL_DELAY);
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
  if (!user || user.balance <= 0) {
    return res.status(400).json({ error: 'Nothing to refund' });
  }

  const refunded = await refundStars(telegramId, user.balance);
  const updated = getUser(telegramId);
  res.json({ refunded, balance: updated.balance });
});

// --- Socket.IO ---
io.on('connection', (socket) => {
  let currentRoom = null;
  let playerId = null;

  socket.on('auth', (data) => {
    const user = validateInitData(data.initData, BOT_TOKEN);
    if (!user) {
      socket.emit('auth_error', { message: 'Invalid auth' });
      return;
    }

    playerId = user.id;
    createUser(user.id, user.username || '', user.first_name || '');

    const dbUser = getUser(user.id);
    socket.emit('auth_ok', { user: dbUser });
  });

  socket.on('join_room', (data) => {
    if (!playerId) return;

    const roomId = data.roomId || crypto.randomBytes(4).toString('hex');
    let room = rooms.get(roomId);

    if (!room) {
      room = createRoom(roomId, playerId);
      rooms.set(roomId, room);
      createGame(roomId, playerId);
    } else if (!room.players[playerId] && getPlayerIds(room).length < 2) {
      room.players[playerId] = { id: playerId, choice: null, socket: null, score: 0, ready: false };
      joinGame(playerId, roomId);
    } else if (!room.players[playerId]) {
      socket.emit('room_full');
      return;
    }

    room.players[playerId].socket = socket;
    currentRoom = roomId;

    socket.emit('room_joined', {
      roomId,
      players: getPlayerIds(room).map((id) => {
        const u = getUser(id);
        return { id, username: u?.username || '', firstName: u?.first_name || '' };
      }),
    });

    if (getPlayerIds(room).length === 2) {
      broadcastToRoom(room, 'game_ready', {
        players: getPlayerIds(room).map((id) => {
          const u = getUser(id);
          return { id, username: u?.username || '', firstName: u?.first_name || '' };
        }),
      });

      setTimeout(() => startRound(room), 1000);
    } else {
      socket.emit('waiting_opponent');
    }
  });

  socket.on('make_choice', (data) => {
    if (!playerId || !currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.status !== 'playing') return;
    if (!['rock', 'paper', 'scissors'].includes(data.choice)) return;

    const player = room.players[playerId];
    if (!player || player.choice) return;

    player.choice = data.choice;

    const oppId = getOpponentId(room, playerId);
    if (oppId && room.players[oppId]?.socket) {
      room.players[oppId].socket.emit('opponent_chose');
    }

    const ids = getPlayerIds(room);
    if (ids.every((id) => room.players[id].choice)) {
      resolveRound(room);
    }
  });

  socket.on('end_game', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    if (room.timer) {
      clearTimeout(room.timer);
      room.timer = null;
    }

    if (room.status === 'playing' && playerId) {
      const player = room.players[playerId];
      if (player && !player.choice) {
        resolveRound(room);
      }
    }

    const ids = getPlayerIds(room);
    const scores = {};
    ids.forEach((id) => { scores[id] = room.players[id]?.score || 0; });

    broadcastToRoom(room, 'game_over', { scores, balances: getBalances(room) });
    endGameDb(currentRoom);
    room.status = 'finished';
  });

  socket.on('rematch', () => {
    if (!playerId || !currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.status !== 'finished') return;

    room.players[playerId].ready = true;
    room.players[playerId].score = 0;

    const ids = getPlayerIds(room);
    if (ids.every((id) => room.players[id]?.ready)) {
      room.round = 0;
      ids.forEach((id) => {
        room.players[id].ready = false;
        room.players[id].choice = null;
        room.players[id].score = 0;
      });
      room.status = 'active';
      broadcastToRoom(room, 'rematch_start', { balances: getBalances(room) });
      setTimeout(() => startRound(room), 1000);
    } else {
      const oppId = getOpponentId(room, playerId);
      if (oppId && room.players[oppId]?.socket) {
        room.players[oppId].socket.emit('opponent_wants_rematch');
      }
    }
  });

  socket.on('request_balance', () => {
    if (!playerId) return;
    const user = getUser(playerId);
    if (user) socket.emit('balance_update', { balance: user.balance });
  });

  socket.on('disconnect', () => {
    if (!currentRoom || !playerId) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    if (room.status === 'playing') {
      resolveRound(room);
    }

    const oppId = getOpponentId(room, playerId);
    if (oppId && room.players[oppId]?.socket) {
      room.players[oppId].socket.emit('opponent_disconnected');
    }

    if (room.players[playerId]) {
      room.players[playerId].socket = null;
    }

    if (room.timer) {
      clearTimeout(room.timer);
      room.timer = null;
    }

    setTimeout(() => {
      const r = rooms.get(currentRoom);
      if (r && getPlayerIds(r).every((id) => !r.players[id]?.socket)) {
        rooms.delete(currentRoom);
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

      if (room.status !== 'playing' && room.status !== 'reveal') {
        const ids = getPlayerIds(room);
        if (ids.length === 2) {
          const allHaveStars = ids.every((id) => getBalance(id) >= STAKE);
          if (allHaveStars) {
            startRound(room);
          }
        }
      }
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
