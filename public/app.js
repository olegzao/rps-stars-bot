const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  tg.setHeaderColor('#08080f');
  tg.setBackgroundColor('#08080f');
}

const socket = io();

let myId = null;
let myScore = 0;
let oppScore = 0;
let currentRoomId = null;
let timerInterval = null;
let roundLogs = [];
let opponentInfo = null;
let isReady = false;
let currentGameType = null; // 'rps' or 'coin'

const CHOICE_SVG = {
  rock: '<svg style="width:36px;height:36px"><use href="#icon-rock"/></svg>',
  scissors: '<svg style="width:36px;height:36px"><use href="#icon-scissors"/></svg>',
  paper: '<svg style="width:36px;height:36px"><use href="#icon-paper"/></svg>',
  timeout: '<svg style="width:36px;height:36px"><use href="#icon-timeout"/></svg>',
};

const CHOICE_MINI = {
  rock: '<svg style="width:18px;height:18px"><use href="#icon-rock"/></svg>',
  scissors: '<svg style="width:18px;height:18px"><use href="#icon-scissors"/></svg>',
  paper: '<svg style="width:18px;height:18px"><use href="#icon-paper"/></svg>',
  timeout: '<svg style="width:18px;height:18px"><use href="#icon-timeout"/></svg>',
};

const $ = (id) => document.getElementById(id);

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(id).classList.add('active');
}

function updateScoreUI() {
  $('headerScore').textContent = `${myScore} — ${oppScore}`;
}

// --- Auth ---
const initData = tg?.initData || '';
const urlParams = new URLSearchParams(window.location.search);
const roomFromUrl = urlParams.get('room');

socket.emit('auth', { initData });

socket.on('auth_ok', (data) => {
  myId = data.user.telegram_id;
  if (roomFromUrl) {
    joinRoom(roomFromUrl);
  }
});

socket.on('auth_error', () => {
  $('statusText').textContent = 'Ошибка авторизации';
});

// === GAME SELECTION ===
function selectGame(type) {
  currentGameType = type;
  if (type === 'rps') {
    $('gameMenuIcon').innerHTML = '<svg style="width:100%;height:100%;filter:drop-shadow(0 0 30px rgba(124,92,252,0.25))"><use href="#icon-rock"/></svg>';
    $('gameMenuTitle').textContent = 'Камень Ножницы Бумага';
    $('gameMenuSub').textContent = 'Классика — 5 сек на ход';
    $('btnFindOpponent').onclick = () => findGame();
  } else {
    $('gameMenuIcon').innerHTML = '<svg style="width:100%;height:100%;filter:drop-shadow(0 0 30px rgba(240,185,11,0.25))"><use href="#icon-coin"/></svg>';
    $('gameMenuTitle').textContent = 'Орёл и Решка';
    $('gameMenuSub').textContent = 'Ставки 1-5 баллов • 10 баллов на старте';
    $('btnFindOpponent').onclick = () => coinFindGame();
  }
  showScreen('screenGameMenu');
}

// === RPS (existing) ===
function findGame() {
  socket.emit('find_game');
  showScreen('screenSearching');
}

function cancelSearch() {
  if (currentGameType === 'coin') {
    socket.emit('coin_cancel_search');
  } else {
    socket.emit('cancel_search');
  }
  showScreen('screenLobby');
}

socket.on('matching', (data) => {
  if (data.status === 'searching') {
    showScreen('screenSearching');
  } else if (data.status === 'cancelled') {
    showScreen('screenLobby');
  }
});

function createRoom() {
  socket.emit('join_room', {});
}

function joinRoom(roomId) {
  socket.emit('join_room', { roomId });
}

socket.on('room_joined', (data) => {
  currentRoomId = data.roomId;
  myScore = 0;
  oppScore = 0;
  roundLogs = [];
  $('roundLog').innerHTML = '';
  updateScoreUI();

  const botUsername = tg?.initDataUnsafe?.bot?.username || '';
  const link = botUsername
    ? `https://t.me/${botUsername}?start=game_${data.roomId}`
    : `${window.location.origin}?room=${data.roomId}`;
  $('roomLink').textContent = link;
  $('roomLink').dataset.link = link;

  if (data.players.length < 2) {
    showScreen('screenWaiting');
  }
});

socket.on('waiting_opponent', () => {
  showScreen('screenWaiting');
});

socket.on('room_full', () => {
  alert('Комната заполнена');
});

socket.on('game_ready', (data) => {
  const opp = data.players.find((p) => p.id !== myId);
  opponentInfo = opp;
  const oppName = opp?.firstName || opp?.username || 'Соперник';
  $('opponentName').textContent = `vs ${oppName}`;
  $('btnExit').style.display = '';
  showScreen('screenGame');
});

// --- Ready phase ---
socket.on('ready_check', () => {
  showReadyPhase();
});

socket.on('ready_update', (data) => {
  const iAmReady = data.readyPlayers.includes(myId);
  const oppReady = data.readyPlayers.length > (iAmReady ? 1 : 0);

  const btn = $('btnReady');
  if (iAmReady) {
    btn.disabled = true;
    btn.textContent = 'ГОТОВ ✓';
  }

  let statusText = '';
  if (data.readyPlayers.length === 0) {
    statusText = 'Нажмите "Готов" чтобы начать';
  } else if (data.readyPlayers.length === 1) {
    statusText = iAmReady ? 'Ждём соперника...' : 'Соперник готов!';
  }
  $('readyStatus').innerHTML = statusText +
    '<div class="ready-dots">' +
    `<span class="ready-dot ${iAmReady ? 'active' : ''}"></span>` +
    `<span class="ready-dot ${oppReady ? 'active' : ''}"></span>` +
    '</div>';
});

function showReadyPhase() {
  isReady = false;
  $('readyArea').style.display = 'flex';
  $('choicesArea').style.display = 'none';
  $('timer').style.display = 'none';
  $('timerRing').style.animation = 'none';
  const btn = $('btnReady');
  btn.disabled = false;
  btn.textContent = 'ГОТОВ';
  $('readyStatus').innerHTML = 'Нажмите "Готов" чтобы начать' +
    '<div class="ready-dots"><span class="ready-dot"></span><span class="ready-dot"></span></div>';
}

function playerReady() {
  if (isReady) return;
  isReady = true;
  socket.emit('player_ready');
  $('btnReady').disabled = true;
  $('btnReady').textContent = 'ГОТОВ ✓';
}

// --- Game ---
socket.on('round_start', (data) => {
  showScreen('screenGame');
  $('readyArea').style.display = 'none';
  $('revealArea').style.display = 'none';
  $('resultText').style.display = 'none';
  $('choicesArea').style.display = 'flex';
  $('roundInfo').textContent = `РАУНД ${data.round}`;
  $('statusText').textContent = 'Выбирай!';

  document.querySelectorAll('.choice-btn').forEach((b) => {
    b.classList.remove('selected');
    b.disabled = false;
  });

  const ring = $('timerRing');
  ring.style.animation = 'none';
  void ring.offsetWidth;
  ring.style.animation = 'timer-spin 5s linear';

  startTimer(Math.ceil(data.timeMs / 1000));
});

function startTimer(seconds) {
  clearInterval(timerInterval);
  let t = seconds;
  const timerEl = $('timer');
  timerEl.textContent = t;
  timerEl.style.display = '';
  timerEl.classList.remove('urgent');

  timerInterval = setInterval(() => {
    t--;
    timerEl.textContent = t;
    timerEl.classList.remove('pulse');
    void timerEl.offsetWidth;
    timerEl.classList.add('pulse');

    if (t <= 2) timerEl.classList.add('urgent');
    if (t <= 0) clearInterval(timerInterval);
  }, 1000);
}

function makeChoice(choice) {
  socket.emit('make_choice', { choice });
  document.querySelectorAll('.choice-btn').forEach((b) => {
    b.disabled = true;
    if (b.dataset.choice === choice) b.classList.add('selected');
  });
  $('statusText').textContent = 'Ждём соперника...';
}

socket.on('opponent_chose', () => {
  $('statusText').textContent = 'Соперник выбрал!';
});

socket.on('round_result', (data) => {
  clearInterval(timerInterval);
  $('timer').style.display = 'none';
  $('timerRing').style.animation = 'none';
  $('choicesArea').style.display = 'none';

  const myChoice = data.choices[myId];
  const oppId = Object.keys(data.choices).find((id) => Number(id) !== myId);
  const oppChoice = data.choices[oppId];

  $('revealMyIcon').innerHTML = CHOICE_SVG[myChoice] || CHOICE_SVG.timeout;
  $('revealOppIcon').innerHTML = CHOICE_SVG[oppChoice] || CHOICE_SVG.timeout;
  $('revealArea').style.display = 'flex';

  const iWon = data.winnerId === myId;
  const isDraw = data.result === 'draw';

  const myCard = $('revealMy');
  const oppCard = $('revealOpp');
  myCard.className = 'reveal-card' + (iWon ? ' winner' : (!isDraw ? ' loser' : ''));
  oppCard.className = 'reveal-card' + (!iWon && !isDraw ? ' winner' : (isDraw ? '' : ' loser'));

  [myCard, oppCard].forEach(c => {
    c.style.animation = 'none';
    void c.offsetWidth;
    c.style.animation = 'revealIn 0.4s ease';
  });

  if (isDraw) {
    $('resultText').textContent = 'Ничья!';
    $('resultText').className = 'result-text draw';
  } else if (iWon) {
    $('resultText').textContent = 'Победа!';
    $('resultText').className = 'result-text win';
  } else {
    $('resultText').textContent = 'Проигрыш';
    $('resultText').className = 'result-text lose';
  }
  $('resultText').style.display = '';

  if (data.scores) {
    myScore = data.scores[myId] || 0;
    oppScore = data.scores[oppId] || 0;
    updateScoreUI();
  }

  const logClass = isDraw ? 'd' : (iWon ? 'w' : 'l');
  const logText = isDraw ? 'НИЧЬЯ' : (iWon ? 'ПОБЕДА' : 'ПРОИГРЫШ');
  roundLogs.unshift({ round: data.round, myChoice, oppChoice, result: logText, cls: logClass });
  renderLog();

  setTimeout(() => showReadyPhase(), 1500);
});

function renderLog() {
  $('roundLog').innerHTML = roundLogs.slice(0, 10).map((l) =>
    `<div class="log-entry">
      <span>R${l.round}</span>
      <span class="log-icons">${CHOICE_MINI[l.myChoice]} vs ${CHOICE_MINI[l.oppChoice]}</span>
      <span class="log-result ${l.cls}">${l.result}</span>
    </div>`
  ).join('');
}

// --- Game Over ---
function endGame() {
  if (currentGameType === 'coin') {
    socket.emit('coin_end_game');
  } else {
    socket.emit('end_game');
  }
}

socket.on('game_over', (data) => {
  clearInterval(timerInterval);
  $('btnExit').style.display = 'none';

  const oppId = Object.keys(data.scores).find((id) => Number(id) !== myId);
  const myFinal = data.scores[myId] || 0;
  const oppFinal = data.scores[oppId] || 0;

  $('goScore').textContent = `${myFinal} — ${oppFinal}`;

  const badge = $('goBadge');
  if (myFinal >= oppFinal) {
    badge.className = 'gameover-badge win-badge';
    badge.innerHTML = '<svg><use href="#icon-trophy"/></svg>';
  } else {
    badge.className = 'gameover-badge lose-badge';
    badge.innerHTML = '<svg><use href="#icon-skull"/></svg>';
  }

  $('goStars').textContent = myFinal > oppFinal ? 'Ты победил!' : (myFinal < oppFinal ? 'Поражение' : 'Ничья!');
  $('goStars').className = 'gameover-stars ' + (myFinal > oppFinal ? 'positive' : (myFinal < oppFinal ? 'negative' : ''));
  $('goBalance').textContent = `Счёт: ${myFinal} — ${oppFinal}`;

  showScreen('screenGameOver');
});

socket.on('opponent_disconnected', () => {
  clearInterval(timerInterval);
  const st = $('statusText');
  if (st) st.textContent = 'Соперник отключился';
  setTimeout(() => {
    socket.emit('end_game');
  }, 1500);
});

socket.on('opponent_wants_rematch', () => {
  $('goStars').textContent = 'Соперник хочет реванш!';
  $('goStars').className = 'gameover-stars';
});

socket.on('rematch_start', () => {
  myScore = 0;
  oppScore = 0;
  roundLogs = [];
  $('roundLog').innerHTML = '';
  updateScoreUI();
  $('btnExit').style.display = '';
  showScreen('screenGame');
  showReadyPhase();
});

function requestRematch() {
  socket.emit('rematch');
  $('goStars').textContent = 'Ожидание соперника...';
  $('goStars').className = 'gameover-stars';
}

// ===========================
// === COIN FLIP GAME ===
// ===========================

let coinMyPoints = 10;
let coinOppPoints = 10;
let coinSelectedBet = null;
let coinSelectedSide = null;
let coinRoundLogs = [];
let coinOpponentInfo = null;
let coinIsReady = false;

function coinFindGame() {
  currentGameType = 'coin';
  socket.emit('coin_find_game');
  showScreen('screenSearching');
}

socket.on('coin_matching', (data) => {
  if (data.status === 'searching') {
    showScreen('screenSearching');
  } else if (data.status === 'cancelled') {
    showScreen('screenLobby');
  }
});

socket.on('coin_room_joined', (data) => {
  currentRoomId = data.roomId;
  currentGameType = 'coin';
  coinRoundLogs = [];
  $('coinRoundLog').innerHTML = '';
});

socket.on('coin_game_ready', (data) => {
  const opp = data.players.find((p) => p.id !== myId);
  coinOpponentInfo = opp;
  const oppName = opp?.firstName || opp?.username || 'Соперник';
  $('coinOpponentName').textContent = `vs ${oppName}`;
  $('coinOppLabel').textContent = oppName.toUpperCase();
  $('btnExit').style.display = '';

  if (data.points) {
    coinMyPoints = data.points[myId] || 10;
    const oppId = Object.keys(data.points).find((id) => Number(id) !== myId);
    coinOppPoints = data.points[oppId] || 10;
    $('coinMyPoints').textContent = coinMyPoints;
    $('coinOppPoints').textContent = coinOppPoints;
  }

  showScreen('screenCoinGame');
  coinShowReadyPhase();
});

socket.on('coin_ready_check', () => {
  coinShowReadyPhase();
});

socket.on('coin_ready_update', (data) => {
  const iAmReady = data.readyPlayers.includes(myId);
  const oppReady = data.readyPlayers.length > (iAmReady ? 1 : 0);

  const btn = $('coinBtnReady');
  if (iAmReady) {
    btn.disabled = true;
    btn.textContent = 'ГОТОВ ✓';
  }

  let statusText = '';
  if (data.readyPlayers.length === 0) {
    statusText = 'Нажмите "Готов"';
  } else if (data.readyPlayers.length === 1) {
    statusText = iAmReady ? 'Ждём соперника...' : 'Соперник готов!';
  }
  $('coinReadyStatus').innerHTML = statusText +
    '<div class="ready-dots">' +
    `<span class="ready-dot ${iAmReady ? 'active' : ''}"></span>` +
    `<span class="ready-dot ${oppReady ? 'active' : ''}"></span>` +
    '</div>';
});

function coinShowReadyPhase() {
  coinIsReady = false;
  $('coinReadyArea').style.display = 'flex';
  $('coinBettingArea').style.display = 'none';
  $('coinFlipArea').style.display = 'none';
  $('coinResultArea').style.display = 'none';
  $('coinStatus').textContent = 'Подтвердите готовность';
  const btn = $('coinBtnReady');
  btn.disabled = false;
  btn.textContent = 'ГОТОВ';
  $('coinReadyStatus').innerHTML = 'Нажмите "Готов"' +
    '<div class="ready-dots"><span class="ready-dot"></span><span class="ready-dot"></span></div>';
}

function coinPlayerReady() {
  if (coinIsReady) return;
  coinIsReady = true;
  socket.emit('coin_player_ready');
  $('coinBtnReady').disabled = true;
  $('coinBtnReady').textContent = 'ГОТОВ ✓';
}

// --- Betting ---
socket.on('coin_betting_start', (data) => {
  $('coinRoundInfo').textContent = `РАУНД ${data.round}`;
  $('coinReadyArea').style.display = 'none';
  $('coinFlipArea').style.display = 'none';
  $('coinResultArea').style.display = 'none';
  $('coinBettingArea').style.display = 'flex';
  $('coinStatus').textContent = 'Сделай ставку и выбери сторону';

  coinSelectedBet = null;
  coinSelectedSide = null;
  $('coinConfirmBet').disabled = true;

  if (data.points) {
    coinMyPoints = data.points[myId] || 0;
    const oppId = Object.keys(data.points).find((id) => Number(id) !== myId);
    coinOppPoints = data.points[oppId] || 0;
    $('coinMyPoints').textContent = coinMyPoints;
    $('coinOppPoints').textContent = coinOppPoints;
  }

  // Update bet buttons based on points
  document.querySelectorAll('.coin-bet-btn').forEach((b) => {
    b.classList.remove('selected');
    const val = parseInt(b.textContent);
    b.disabled = val > coinMyPoints;
  });
  document.querySelectorAll('.coin-side-btn').forEach((b) => b.classList.remove('selected'));
});

function selectBet(amount) {
  if (amount > coinMyPoints) return;
  coinSelectedBet = amount;
  document.querySelectorAll('.coin-bet-btn').forEach((b) => {
    b.classList.toggle('selected', parseInt(b.textContent) === amount);
  });
  updateConfirmBtn();
}

function selectSide(side) {
  coinSelectedSide = side;
  $('btnHeads').classList.toggle('selected', side === 'heads');
  $('btnTails').classList.toggle('selected', side === 'tails');
  updateConfirmBtn();
}

function updateConfirmBtn() {
  const btn = $('coinConfirmBet');
  if (coinSelectedBet && coinSelectedSide) {
    btn.disabled = false;
    const sideText = coinSelectedSide === 'heads' ? 'Орёл' : 'Решка';
    btn.textContent = `Ставлю ${coinSelectedBet} на ${sideText}`;
  } else {
    btn.disabled = true;
    btn.textContent = 'Поставить';
  }
}

function confirmBet() {
  if (!coinSelectedBet || !coinSelectedSide) return;
  socket.emit('coin_place_bet', { bet: coinSelectedBet, choice: coinSelectedSide });
  $('coinBettingArea').style.display = 'none';
  $('coinStatus').textContent = 'Ставка принята. Ждём соперника...';
}

socket.on('coin_opponent_bet_placed', () => {
  $('coinStatus').textContent = 'Соперник сделал ставку!';
});

// --- Coin Flip Result ---
socket.on('coin_flip_result', (data) => {
  $('coinStatus').textContent = '';
  $('coinBettingArea').style.display = 'none';

  // Show coin animation
  $('coinFlipArea').style.display = 'flex';
  const coin = $('coin3d');
  coin.className = 'coin-3d';
  void coin.offsetWidth;
  coin.classList.add(data.coinResult === 'heads' ? 'flip-heads' : 'flip-tails');

  setTimeout(() => {
    $('coinFlipArea').style.display = 'none';
    $('coinResultArea').style.display = 'flex';

    const sideText = data.coinResult === 'heads' ? 'ОРЁЛ' : 'РЕШКА';
    $('coinResultSide').textContent = sideText;
    $('coinResultSide').className = 'coin-result-side ' + (data.coinResult === 'heads' ? 'heads-color' : 'tails-color');

    const iWon = data.winnerId === myId;
    const isDraw = !data.winnerId;

    if (isDraw) {
      $('coinResultText').textContent = 'Оба выбрали одну сторону!';
      $('coinResultText').className = 'coin-result-text draw';
      $('coinResultTransfer').textContent = '0 баллов';
    } else if (iWon) {
      $('coinResultText').textContent = 'Ты выиграл!';
      $('coinResultText').className = 'coin-result-text win';
      $('coinResultTransfer').textContent = `+${data.transferAmount} баллов`;
      $('coinResultTransfer').className = 'coin-result-transfer positive';
    } else {
      $('coinResultText').textContent = 'Ты проиграл';
      $('coinResultText').className = 'coin-result-text lose';
      $('coinResultTransfer').textContent = `-${data.transferAmount} баллов`;
      $('coinResultTransfer').className = 'coin-result-transfer negative';
    }

    // Update points
    if (data.points) {
      coinMyPoints = data.points[myId] || 0;
      const oppId = Object.keys(data.points).find((id) => Number(id) !== myId);
      coinOppPoints = data.points[oppId] || 0;
      $('coinMyPoints').textContent = coinMyPoints;
      $('coinOppPoints').textContent = coinOppPoints;
    }

    // Log
    const myChoice = data.choices[myId];
    const oppId = Object.keys(data.choices).find((id) => Number(id) !== myId);
    const oppChoice = data.choices[oppId];
    const logCls = isDraw ? 'd' : (iWon ? 'w' : 'l');
    const logText = isDraw ? 'НИЧЬЯ' : (iWon ? `+${data.transferAmount}` : `-${data.transferAmount}`);
    coinRoundLogs.unshift({
      round: data.round,
      myChoice,
      oppChoice,
      coinResult: data.coinResult,
      result: logText,
      cls: logCls,
      myBet: data.bets[myId],
      oppBet: data.bets[oppId],
    });
    renderCoinLog();

  }, 2000);
});

function renderCoinLog() {
  $('coinRoundLog').innerHTML = coinRoundLogs.slice(0, 10).map((l) => {
    const mySide = l.myChoice === 'heads' ? 'O' : 'P';
    const oppSide = l.oppChoice === 'heads' ? 'O' : 'P';
    const coinSide = l.coinResult === 'heads' ? 'O' : 'P';
    return `<div class="log-entry">
      <span>R${l.round}</span>
      <span class="log-icons">
        <span class="coin-log-side">${mySide}(${l.myBet})</span>
        vs
        <span class="coin-log-side">${oppSide}(${l.oppBet})</span>
        = ${coinSide}
      </span>
      <span class="log-result ${l.cls}">${l.result}</span>
    </div>`;
  }).join('');
}

// --- Coin Game Over ---
socket.on('coin_game_over', (data) => {
  $('btnExit').style.display = 'none';

  const oppId = Object.keys(data.scores).find((id) => Number(id) !== myId);
  const myWins = data.scores[myId] || 0;
  const oppWins = data.scores[oppId] || 0;
  const myPts = data.points[myId] || 0;
  const oppPts = data.points[oppId] || 0;

  $('coinGoScore').textContent = `${myWins} — ${oppWins}`;

  const badge = $('coinGoBadge');
  if (myPts >= oppPts) {
    badge.className = 'gameover-badge win-badge';
    badge.innerHTML = '<svg><use href="#icon-trophy"/></svg>';
  } else {
    badge.className = 'gameover-badge lose-badge';
    badge.innerHTML = '<svg><use href="#icon-skull"/></svg>';
  }

  const diff = myPts - 10;
  if (diff > 0) {
    $('coinGoStars').textContent = `+${diff} баллов`;
    $('coinGoStars').className = 'gameover-stars positive';
  } else if (diff < 0) {
    $('coinGoStars').textContent = `${diff} баллов`;
    $('coinGoStars').className = 'gameover-stars negative';
  } else {
    $('coinGoStars').textContent = '0 баллов';
    $('coinGoStars').className = 'gameover-stars';
  }

  $('coinGoBalance').textContent = data.reason === 'bankrupt'
    ? (myPts <= 0 ? 'У тебя закончились баллы!' : 'У соперника закончились баллы!')
    : `Итого: ${myPts} — ${oppPts}`;

  showScreen('screenCoinGameOver');
});

socket.on('coin_opponent_disconnected', () => {
  $('coinStatus').textContent = 'Соперник отключился';
  setTimeout(() => {
    socket.emit('coin_end_game');
  }, 1500);
});

socket.on('coin_opponent_wants_rematch', () => {
  $('coinGoStars').textContent = 'Соперник хочет реванш!';
  $('coinGoStars').className = 'gameover-stars';
});

socket.on('coin_rematch_start', (data) => {
  coinRoundLogs = [];
  $('coinRoundLog').innerHTML = '';
  if (data.points) {
    coinMyPoints = data.points[myId] || 10;
    const oppId = Object.keys(data.points).find((id) => Number(id) !== myId);
    coinOppPoints = data.points[oppId] || 10;
  }
  $('coinMyPoints').textContent = coinMyPoints;
  $('coinOppPoints').textContent = coinOppPoints;
  $('btnExit').style.display = '';
  showScreen('screenCoinGame');
  coinShowReadyPhase();
});

function coinRequestRematch() {
  socket.emit('coin_rematch');
  $('coinGoStars').textContent = 'Ожидание соперника...';
  $('coinGoStars').className = 'gameover-stars';
}

// --- Profile ---
function showProfile() {
  if (!myId) return;
  fetch(`/api/user/${myId}`)
    .then((r) => r.json())
    .then((u) => {
      $('profWins').textContent = u.wins;
      $('profLosses').textContent = u.losses;
      $('profDraws').textContent = u.draws;
    });
  showScreen('screenProfile');
}

function backToLobby() {
  $('btnExit').style.display = 'none';
  currentRoomId = null;
  currentGameType = null;
  showScreen('screenLobby');
}

function copyLink() {
  const link = $('roomLink').dataset.link;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(link);
  }
  const el = $('roomLink');
  el.textContent = 'Скопировано!';
  el.style.color = '#00e676';
  setTimeout(() => {
    el.textContent = link;
    el.style.color = '';
  }, 1500);
}

socket.on('error', (data) => {
  alert(data.message || 'Ошибка');
});
