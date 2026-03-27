const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}

const socket = io();

let myId = null;
let myBalance = 0;
let myScore = 0;
let oppScore = 0;
let currentRoomId = null;
let timerInterval = null;
let roundLogs = [];
let startBalance = 0;
let opponentInfo = null;

const CHOICE_EMOJI = { rock: '🪨', scissors: '✂️', paper: '📄', timeout: '⏰' };

// --- DOM ---
const $ = (id) => document.getElementById(id);

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(id).classList.add('active');
}

function updateBalanceUI(bal) {
  myBalance = bal;
  $('headerBalance').textContent = `${bal} ⭐`;
  $('lobbyBalance').textContent = `Баланс: ${bal} ⭐`;
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
  updateBalanceUI(data.user.balance);
  startBalance = data.user.balance;

  if (roomFromUrl) {
    joinRoom(roomFromUrl);
  }
});

socket.on('auth_error', () => {
  $('statusText').textContent = 'Ошибка авторизации';
});

// --- Room ---
function createRoom() {
  if (myBalance < 1) {
    showDeposit();
    return;
  }
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

// --- Game ---
socket.on('round_start', (data) => {
  showScreen('screenGame');
  $('noStarsOverlay').classList.remove('active');
  $('revealArea').style.display = 'none';
  $('resultText').style.display = 'none';
  $('choicesArea').style.display = 'flex';
  $('roundInfo').textContent = `Раунд ${data.round} • Банк: ${data.pot} ⭐`;
  $('statusText').textContent = 'Выбирай!';

  if (data.balances && data.balances[myId] !== undefined) {
    updateBalanceUI(data.balances[myId]);
  }

  document.querySelectorAll('.choice-btn').forEach((b) => {
    b.classList.remove('selected');
    b.disabled = false;
  });

  startTimer(Math.ceil(data.timeMs / 1000));
});

function startTimer(seconds) {
  clearInterval(timerInterval);
  let t = seconds;
  $('timer').textContent = t;
  $('timer').style.display = '';
  timerInterval = setInterval(() => {
    t--;
    $('timer').textContent = t;
    $('timer').classList.remove('pulse');
    void $('timer').offsetWidth;
    $('timer').classList.add('pulse');
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
  $('choicesArea').style.display = 'none';

  const myChoice = data.choices[myId];
  const oppId = Object.keys(data.choices).find((id) => Number(id) !== myId);
  const oppChoice = data.choices[oppId];

  $('revealMy').textContent = CHOICE_EMOJI[myChoice] || '❓';
  $('revealOpp').textContent = CHOICE_EMOJI[oppChoice] || '❓';
  $('revealArea').style.display = 'flex';

  const iWon = data.winnerId === myId;
  const isDraw = data.result === 'draw';

  $('revealMy').className = 'reveal-choice' + (iWon ? ' winner' : (!isDraw ? ' loser' : ''));
  $('revealOpp').className = 'reveal-choice' + (!iWon && !isDraw ? ' winner' : (isDraw ? '' : ' loser'));

  if (isDraw) {
    $('resultText').textContent = 'Ничья! 0 ⭐';
    $('resultText').className = 'result-text draw';
  } else if (iWon) {
    $('resultText').textContent = 'Победа! +2 ⭐';
    $('resultText').className = 'result-text win';
  } else {
    $('resultText').textContent = 'Проигрыш! -1 ⭐';
    $('resultText').className = 'result-text lose';
  }
  $('resultText').style.display = '';

  // Update scores
  if (data.scores) {
    myScore = data.scores[myId] || 0;
    oppScore = data.scores[oppId] || 0;
    updateScoreUI();
  }

  if (data.balances && data.balances[myId] !== undefined) {
    updateBalanceUI(data.balances[myId]);
  }

  // Log
  const logClass = isDraw ? 'd' : (iWon ? 'w' : 'l');
  const logText = isDraw ? 'Ничья' : (iWon ? 'Победа' : 'Проигрыш');
  roundLogs.unshift({ round: data.round, myChoice, oppChoice, result: logText, cls: logClass });
  renderLog();
});

function renderLog() {
  $('roundLog').innerHTML = roundLogs.slice(0, 10).map((l) =>
    `<div class="log-entry">
      <span>R${l.round}: ${CHOICE_EMOJI[l.myChoice]} vs ${CHOICE_EMOJI[l.oppChoice]}</span>
      <span class="log-result ${l.cls}">${l.result}</span>
    </div>`
  ).join('');
}

// --- No Stars ---
socket.on('no_stars', (data) => {
  updateBalanceUI(data.balance);
  $('noStarsOverlay').classList.add('active');
});

socket.on('opponent_no_stars', () => {
  $('statusText').textContent = 'Соперник пополняет баланс...';
});

socket.on('balance_update', (data) => {
  updateBalanceUI(data.balance);
  $('noStarsOverlay').classList.remove('active');
});

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

  const currentBal = data.balances[myId] || 0;
  updateBalanceUI(currentBal);
  const diff = currentBal - startBalance;
  $('goStars').textContent = (diff >= 0 ? '+' : '') + diff + ' ⭐';
  $('goStars').className = 'gameover-stars ' + (diff >= 0 ? 'positive' : 'negative');
  $('goBalance').textContent = `Баланс: ${currentBal} ⭐`;

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

socket.on('rematch_start', (data) => {
  myScore = 0;
  oppScore = 0;
  roundLogs = [];
  $('roundLog').innerHTML = '';
  updateScoreUI();
  if (data.balances && data.balances[myId] !== undefined) {
    startBalance = data.balances[myId];
    updateBalanceUI(data.balances[myId]);
  }
  $('btnExit').style.display = '';
  showScreen('screenGame');
});

function requestRematch() {
  socket.emit('rematch');
  $('goStars').textContent = 'Ожидание соперника...';
  $('goStars').className = 'gameover-stars';
}

// --- Deposit ---
function showDeposit() {
  showScreen('screenDeposit');
}

function deposit(amount) {
  if (tg) {
    tg.openInvoice && tg.showAlert
      ? tg.showAlert(`Для пополнения ${amount} ⭐ используй кнопку в боте`)
      : alert(`Для пополнения ${amount} ⭐ используй кнопку в боте`);
  }
}

function depositFromGame(amount) {
  deposit(amount);
}

// --- Profile ---
function showProfile() {
  if (!myId) return;
  fetch(`/api/user/${myId}`)
    .then((r) => r.json())
    .then((u) => {
      $('profBalance').textContent = `${u.balance} ⭐`;
      $('profWins').textContent = u.wins;
      $('profLosses').textContent = u.losses;
      $('profDraws').textContent = u.draws;
      updateBalanceUI(u.balance);
    });
  showScreen('screenProfile');
}

async function requestRefund() {
  if (!myId || myBalance <= 0) {
    alert('Нечего выводить');
    return;
  }
  if (!confirm(`Вывести ${myBalance} ⭐ обратно?`)) return;

  try {
    const res = await fetch('/api/refund', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telegramId: myId, initData }),
    });
    const data = await res.json();
    if (data.error) {
      alert(data.error);
    } else {
      alert(`Возвращено звёзд: ${data.refunded}`);
      updateBalanceUI(data.balance);
      $('profBalance').textContent = `${data.balance} ⭐`;
    }
  } catch {
    alert('Ошибка при выводе');
  }
}

function backToLobby() {
  $('btnExit').style.display = 'none';
  currentRoomId = null;
  socket.emit('request_balance');
  showScreen('screenLobby');
}

function copyLink() {
  const link = $('roomLink').dataset.link;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(link);
  }
  $('roomLink').textContent = 'Скопировано!';
  setTimeout(() => { $('roomLink').textContent = link; }, 1500);
}

// --- Error ---
socket.on('error', (data) => {
  alert(data.message || 'Ошибка');
});
