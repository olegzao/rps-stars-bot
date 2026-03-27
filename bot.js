const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const { getUser, createUser, depositStars, getUnrefundedPayments, markRefunded, updateBalance, saveDb } = require('./db');

let bot;

function initBot(token, webAppUrl) {
  bot = new TelegramBot(token, { polling: true });

  bot.on('polling_error', (err) => console.error('Bot polling error:', err.message));

  bot.onText(/\/start(.*)/, (msg, match) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const username = msg.from.username || '';
    const firstName = msg.from.first_name || '';

    createUser(telegramId, username, firstName);
    const user = getUser(telegramId);

    const param = (match[1] || '').trim();
    let gameUrl = webAppUrl;
    if (param.startsWith('game_')) {
      const roomId = param.replace('game_', '');
      gameUrl = `${webAppUrl}?room=${roomId}`;
    }

    bot.sendMessage(chatId, `Камень Ножницы Бумага на звёзды!\n\nТвой баланс: ${user.balance} ⭐`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🎮 Играть', web_app: { url: gameUrl } }],
          [{ text: '💰 1 ⭐', callback_data: 'deposit_1' }, { text: '💰 5 ⭐', callback_data: 'deposit_5' }],
          [{ text: '💰 10 ⭐', callback_data: 'deposit_10' }, { text: '💰 25 ⭐', callback_data: 'deposit_25' }],
        ],
      },
    });
  });

  bot.onText(/\/game/, (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

    createUser(telegramId, msg.from.username || '', msg.from.first_name || '');

    const roomId = crypto.randomBytes(4).toString('hex');
    const inviteLink = `https://t.me/${bot.options?.username || ''}?start=game_${roomId}`;
    const gameUrl = `${webAppUrl}?room=${roomId}`;

    bot.sendMessage(chatId, `Комната создана!\n\nОтправь ссылку другу:\n${inviteLink}`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🎮 Войти в комнату', web_app: { url: gameUrl } }],
        ],
      },
    });
  });

  bot.onText(/\/balance/, (msg) => {
    const telegramId = msg.from.id;
    createUser(telegramId, msg.from.username || '', msg.from.first_name || '');
    const user = getUser(telegramId);
    bot.sendMessage(msg.chat.id,
      `Баланс: ${user.balance} ⭐\nПобед: ${user.wins} | Поражений: ${user.losses} | Ничьих: ${user.draws}`
    );
  });

  bot.on('callback_query', (query) => {
    const data = query.data;
    if (!data.startsWith('deposit_')) return;

    const amount = parseInt(data.replace('deposit_', ''), 10);
    if (![1, 5, 10, 25, 50].includes(amount)) return;

    bot.answerCallbackQuery(query.id);

    bot.sendInvoice(
      query.from.id,
      `Пополнение ${amount} ⭐`,
      `Покупка ${amount} звёзд для игры`,
      `stars_${amount}_${Date.now()}`,
      '',
      'XTR',
      [{ label: `${amount} Stars`, amount }]
    );
  });

  bot.on('pre_checkout_query', (query) => {
    bot.answerPreCheckoutQuery(query.id, true);
  });

  bot.on('message', (msg) => {
    if (!msg.successful_payment) return;

    const telegramId = msg.from.id;
    const payment = msg.successful_payment;
    const amount = payment.total_amount;
    const chargeId = payment.telegram_payment_charge_id;
    const providerChargeId = payment.provider_payment_charge_id || '';

    createUser(telegramId, msg.from.username || '', msg.from.first_name || '');
    depositStars(telegramId, amount, chargeId, providerChargeId);

    const user = getUser(telegramId);
    bot.sendMessage(msg.chat.id, `Зачислено ${amount} ⭐!\nТекущий баланс: ${user.balance} ⭐`);

    if (onBalanceUpdate) {
      onBalanceUpdate(telegramId, user.balance);
    }
  });

  bot.getMe().then((me) => {
    bot.options.username = me.username;
    console.log(`Bot started: @${me.username}`);
  });

  return bot;
}

let onBalanceUpdate = null;

function setBalanceUpdateCallback(cb) {
  onBalanceUpdate = cb;
}

function getBot() {
  return bot;
}

async function refundStars(telegramId, amount) {
  const payments = getUnrefundedPayments(telegramId);
  let remaining = amount;

  for (const payment of payments) {
    if (remaining <= 0) break;

    try {
      await bot.refundStarPayment(telegramId, payment.charge_id);
      markRefunded(payment.id);
      updateBalance(telegramId, -payment.amount);
      saveDb();
      remaining -= payment.amount;
    } catch (err) {
      console.error(`Refund failed for charge ${payment.charge_id}:`, err.message);
    }
  }

  return amount - remaining;
}

function validateInitData(initDataStr, botToken) {
  if (!initDataStr) return null;

  const params = new URLSearchParams(initDataStr);
  const hash = params.get('hash');
  if (!hash) return null;

  params.delete('hash');
  const entries = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const checkHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (checkHash !== hash) return null;

  try {
    return JSON.parse(params.get('user'));
  } catch {
    return null;
  }
}

module.exports = { initBot, getBot, setBalanceUpdateCallback, refundStars, validateInitData };
