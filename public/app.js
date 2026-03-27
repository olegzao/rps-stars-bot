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

// --- Room ---
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

  // Show ready button after short delay
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
  socket.emit('end_game');
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
  $('statusText').textContent = 'Соперник отключился';
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
