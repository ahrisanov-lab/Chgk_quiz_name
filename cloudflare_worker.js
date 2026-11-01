/**
 * Cloudflare Worker для командного Telegram-бота ЧГК («Это База»).
 *
 * Что делает бот:
 * 1. Публикует вопросы БЕЗ ответа и БЕЗ спойлера в сообщении вопроса.
 * 2. Выводит уровень сложности пакета (TrueDL), номер вопроса и процент взятия.
 * 3. По отдельной команде /ans (или /answer, /a, /ответ) либо по кнопке «Показать ответ»
 *    присылает ответ на последний опубликованный в чате вопрос.
 * 4. Исключает повторы вопросов в чате (история сыгранных вопросов сохраняется автоматически).
 * 5. Полностью исключает вопросы с раздаточным материалом.
 *
 * Переменные окружения в настройках Worker (Settings -> Variables and Secrets):
 *   TELEGRAM_BOT_TOKEN — токен бота от @BotFather
 *   DATA_URL           — (необязательно) прямая ссылка raw.githubusercontent.com на questions.json
 *   ALLOWED_CHAT_ID    — (необязательно) ID чата команды, например -1001234567890
 */

const DEFAULT_DATA_URL =
  "https://raw.githubusercontent.com/ahrisanov-lab/Chgk_quiz_name/main/questions.json";

let cachedQuestions = null;
let cacheTime = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 час

// Внутренний кэш состояния по чатам: { [chatId]: { last: number|null, used: number[], ts: number } }
let memoryState = null;
let commandsMenuRegistered = false;

const HANDOUT_TEXT_RE =
  /(\[\s*раздаточный материал|раздаточный материал\s*:|раздатка\s*:|на раздаточном материале|на раздатке|мы раздали вам|розданн|перед вами на раздатке)/i;

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function parseAvgComplexity(raw) {
  if (!raw) return null;
  const nums = String(raw)
    .split(";")
    .map((s) => parseFloat(s.trim().replace(",", ".")))
    .filter((n) => !Number.isNaN(n));
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function hasHandoutInText(text) {
  return HANDOUT_TEXT_RE.test(String(text || ""));
}

// Парсер CSV на случай, если в DATA_URL указан .csv вместо .json
function parseCsv(text) {
  const clean = text.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    const next = clean[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        row.push(field);
        field = "";
      } else if (ch === "\r" && next === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        i++;
      } else if (ch === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else {
        field += ch;
      }
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim());
  const idxT = headers.indexOf("турнир");
  const idxDl = headers.indexOf("уровень пакета");
  const idxN = headers.indexOf("номер вопроса");
  const idxQ = headers.indexOf("вопрос");
  const idxA = headers.indexOf("ответ");
  const idxC = headers.indexOf("сложность");
  const idxH = headers.indexOf("есть раздатка");

  const result = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length < 4) continue;
    const hasHandout = idxH >= 0 ? String(r[idxH] || "").trim() === "1" : false;
    const q = String(r[idxQ] || "").trim();
    const a = String(r[idxA] || "").trim();
    if (hasHandout || !q || !a || hasHandoutInText(q)) continue;
    const cr = idxC >= 0 ? String(r[idxC] || "").trim() : "";
    const dl = idxDl >= 0 ? String(r[idxDl] || "").trim() : "";
    result.push({
      t: idxT >= 0 ? String(r[idxT] || "").trim() : "",
      dl,
      n: idxN >= 0 ? String(r[idxN] || "").trim() : String(i),
      q,
      a,
      c: parseAvgComplexity(cr),
      cr,
    });
  }
  return result;
}

async function getQuestions(dataUrl) {
  const now = Date.now();
  if (cachedQuestions && now - cacheTime < CACHE_TTL_MS) {
    return cachedQuestions;
  }
  const resp = await fetch(dataUrl);
  if (!resp.ok) {
    throw new Error(`Не удалось загрузить базу (${resp.status})`);
  }
  const text = await resp.text();
  let parsed;
  if (dataUrl.endsWith(".json") || text.trim().startsWith("[")) {
    parsed = JSON.parse(text);
  } else {
    parsed = parseCsv(text);
  }
  // Дополнительная фильтрация вопросов с раздаткой
  cachedQuestions = parsed.filter(
    (item) => item && item.q && item.a && !hasHandoutInText(item.q)
  );
  cacheTime = now;
  return cachedQuestions;
}

async function tgApi(token, method, payload) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return resp.json();
}

// Чтение и сохранение состояния (последний вопрос и список сыгранных вопросов без повторов)
// Используется 3 уровня: память воркера + Cloudflare Cache API + служебный слот Telegram Bot API (language_code: "eo")
const STATE_CACHE_URL = "https://chgk-bot-state.internal/state-v2";

function mergeStates(a, b) {
  const out = { chats: {} };
  const allChats = new Set([
    ...Object.keys((a && a.chats) || {}),
    ...Object.keys((b && b.chats) || {}),
  ]);
  for (const cid of allChats) {
    const ca = (a && a.chats && a.chats[cid]) || { last: null, used: [], ts: 0 };
    const cb = (b && b.chats && b.chats[cid]) || { last: null, used: [], ts: 0 };
    const usedSet = new Set([...(ca.used || []), ...(cb.used || [])]);
    const newer = (cb.ts || 0) >= (ca.ts || 0) ? cb : ca;
    const older = newer === cb ? ca : cb;
    out.chats[cid] = {
      last: newer.last !== null && newer.last !== undefined ? newer.last : older.last,
      used: Array.from(usedSet),
      ts: Math.max(ca.ts || 0, cb.ts || 0),
    };
  }
  return out;
}

async function loadState(token) {
  if (memoryState) {
    return memoryState;
  }

  let cacheState = null;
  try {
    if (typeof caches !== "undefined" && caches.default) {
      const cachedResp = await caches.default.match(STATE_CACHE_URL);
      if (cachedResp) {
        cacheState = await cachedResp.json();
      }
    }
  } catch (_) {}

  let tgState = null;
  try {
    const res = await tgApi(token, "getMyCommands", {
      scope: { type: "default" },
      language_code: "eo",
    });
    if (res && res.ok && Array.isArray(res.result) && res.result.length > 0) {
      const sorted = res.result
        .filter((c) => c.command && c.command.startsWith("s_"))
        .sort((x, y) => parseInt(x.command.slice(2), 10) - parseInt(y.command.slice(2), 10));
      const rawJson = sorted.map((c) => c.description).join("");
      if (rawJson) {
        tgState = JSON.parse(rawJson);
      }
    }
  } catch (_) {}

  memoryState = mergeStates(cacheState, tgState);
  return memoryState;
}

async function saveState(token, state) {
  memoryState = state;

  // 1. Сохраняем в Cloudflare Edge Cache
  try {
    if (typeof caches !== "undefined" && caches.default) {
      await caches.default.put(
        STATE_CACHE_URL,
        new Response(JSON.stringify(state), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=31536000",
          },
        })
      );
    }
  } catch (_) {}

  // 2. Сохраняем в служебный языковой слот Telegram Bot API (language_code: "eo")
  try {
    const jsonStr = JSON.stringify(state);
    const chunks = [];
    for (let i = 0; i < jsonStr.length && chunks.length < 95; i += 240) {
      chunks.push({
        command: `s_${chunks.length}`,
        description: jsonStr.slice(i, i + 240),
      });
    }
    if (chunks.length > 0) {
      await tgApi(token, "setMyCommands", {
        commands: chunks,
        scope: { type: "default" },
        language_code: "eo",
      });
    }
  } catch (_) {}
}

function getChatState(state, chatId) {
  const key = String(chatId);
  if (!state.chats) state.chats = {};
  if (!state.chats[key]) {
    state.chats[key] = { last: null, used: [], ts: 0 };
  }
  return state.chats[key];
}

function pickQuestion(questions, level, usedIndices) {
  const usedSet = new Set(usedIndices || []);
  const matchingAll = [];
  const matchingUnused = [];

  for (let i = 0; i < questions.length; i++) {
    const item = questions[i];
    if (!item || !item.q || !item.a || hasHandoutInText(item.q)) continue;
    const c = item.c;
    if (level === "easy" && (c === null || c < 65)) continue;
    if (level === "medium" && (c === null || c < 35 || c >= 65)) continue;
    if (level === "hard" && (c === null || c >= 35)) continue;

    matchingAll.push({ index: i, item });
    if (!usedSet.has(i)) {
      matchingUnused.push({ index: i, item });
    }
  }

  if (matchingUnused.length > 0) {
    const picked = matchingUnused[Math.floor(Math.random() * matchingUnused.length)];
    return { picked, resetUsed: false };
  }

  if (matchingAll.length > 0) {
    const picked = matchingAll[Math.floor(Math.random() * matchingAll.length)];
    return { picked, resetUsed: true, matchingIndices: matchingAll.map((m) => m.index) };
  }

  return { picked: null, resetUsed: false };
}

function findQuestionFromReply(questions, replyText) {
  if (!replyText) return null;
  const lines = String(replyText).split("\n");
  if (lines.length < 2) return null;
  const title = lines[0].trim();
  const numMatch = lines[1].match(/Вопрос\s*№\s*(\d+)/i);
  if (!title || !numMatch) return null;
  const num = numMatch[1];
  for (let i = 0; i < questions.length; i++) {
    if (questions[i].t === title && String(questions[i].n) === num) {
      return { index: i, item: questions[i] };
    }
  }
  return null;
}

const BOT_COMMANDS_MENU = [
  { command: "q", description: "Случайный вопрос (без раздатки)" },
  { command: "ans", description: "Показать ответ на последний вопрос" },
  { command: "easy", description: "Легкий вопрос (взятие от 65%)" },
  { command: "medium", description: "Средний вопрос (взятие 35–65%)" },
  { command: "hard", description: "Сложный вопрос (взятие до 35%)" },
  { command: "reset", description: "Сбросить историю сыгранных вопросов" },
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const token = env.TELEGRAM_BOT_TOKEN;
    const dataUrl = env.DATA_URL || DEFAULT_DATA_URL;

    if (!token) {
      return new Response(
        "Укажите переменную окружения TELEGRAM_BOT_TOKEN в настройках Worker (Settings -> Variables and Secrets).",
        { status: 500 }
      );
    }

    // Привязка вебхука и регистрация меню команд: https://<ваш-воркер>.workers.dev/register
    if (url.pathname === "/register") {
      const webhookUrl = `${url.origin}/webhook`;
      const webhookRes = await tgApi(token, "setWebhook", { url: webhookUrl });
      const cmdRes = await tgApi(token, "setMyCommands", {
        commands: BOT_COMMANDS_MENU,
      });
      commandsMenuRegistered = true;
      return new Response(
        JSON.stringify({ webhook: webhookRes, commands_menu: cmdRes }, null, 2),
        { headers: { "Content-Type": "application/json; charset=utf-8" } }
      );
    }

    if (request.method !== "POST") {
      return new Response("Бот ЧГК работает. Для привязки вебхука откройте /register", {
        status: 200,
      });
    }

    try {
      const update = await request.json();
      const allowedChat = env.ALLOWED_CHAT_ID ? String(env.ALLOWED_CHAT_ID).trim() : "";

      if (!commandsMenuRegistered) {
        commandsMenuRegistered = true;
        tgApi(token, "setMyCommands", { commands: BOT_COMMANDS_MENU }).catch(() => {});
      }

      // Обработка нажатий на inline-кнопки
      if (update.callback_query) {
        const cb = update.callback_query;
        const chatId = cb.message?.chat?.id;
        if (!chatId || (allowedChat && String(chatId) !== allowedChat)) {
          return new Response("OK");
        }
        const data = cb.data || "";
        const questions = await getQuestions(dataUrl);

        if (data.startsWith("ans:")) {
          const idx = parseInt(data.slice(4), 10);
          const q = questions[idx];
          if (q) {
            await sendAnswerMessage(token, chatId, q);
          }
          await tgApi(token, "answerCallbackQuery", { callback_query_id: cb.id });
          return new Response("OK");
        }

        if (data.startsWith("next:")) {
          const level = data.slice(5) || "any";
          await tgApi(token, "answerCallbackQuery", { callback_query_id: cb.id });
          const state = await loadState(token);
          const chatState = getChatState(state, chatId);
          const { picked, resetUsed, matchingIndices } = pickQuestion(
            questions,
            level,
            chatState.used
          );
          if (picked) {
            if (resetUsed && matchingIndices) {
              const removeSet = new Set(matchingIndices);
              chatState.used = chatState.used.filter((i) => !removeSet.has(i));
            }
            chatState.used.push(picked.index);
            chatState.last = picked.index;
            chatState.ts = Date.now();
            await sendQuestionMessage(token, chatId, picked.index, picked.item, level);
            await saveState(token, state);
          }
          return new Response("OK");
        }
      }

      // Обработка текстовых команд в чате
      const msg = update.message;
      if (!msg || !msg.text) return new Response("OK");

      const chatId = msg.chat.id;
      if (allowedChat && String(chatId) !== allowedChat) {
        return new Response("OK");
      }

      const cmd = msg.text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();

      if (cmd === "/start" || cmd === "/help") {
        await tgApi(token, "sendMessage", {
          chat_id: chatId,
          parse_mode: "HTML",
          text:
            "<b>Командный бот ЧГК «Это База»</b>\n\n" +
            "/q — случайный вопрос (без раздатки)\n" +
            "/easy — легкий вопрос (взятие ≥ 65%)\n" +
            "/medium — средний вопрос (35–65%)\n" +
            "/hard — сложный вопрос (&lt; 35%)\n" +
            "/ans — показать ответ на последний вопрос\n" +
            "/reset — сбросить историю сыгранных вопросов",
        });
        return new Response("OK");
      }

      // Отдельная команда показа ответа на последний опубликованный в чате вопрос
      if (
        cmd === "/ans" ||
        cmd === "/answer" ||
        cmd === "/a" ||
        cmd === "/otvet" ||
        cmd === "/ответ"
      ) {
        const questions = await getQuestions(dataUrl);
        const state = await loadState(token);
        const chatState = getChatState(state, chatId);

        let targetQ = null;
        // Если команда отправлена ответом (Reply) на конкретный вопрос, ищем его
        if (msg.reply_to_message && msg.reply_to_message.text) {
          const fromReply = findQuestionFromReply(questions, msg.reply_to_message.text);
          if (fromReply) {
            targetQ = fromReply.item;
          }
        }
        // Иначе берем последний опубликованный вопрос в этом чате
        if (!targetQ && chatState.last !== null && chatState.last !== undefined) {
          targetQ = questions[chatState.last] || null;
        }

        if (!targetQ) {
          await tgApi(token, "sendMessage", {
            chat_id: chatId,
            text: "В этом чате еще нет активного вопроса. Отправьте /q, чтобы получить вопрос.",
          });
          return new Response("OK");
        }

        await sendAnswerMessage(token, chatId, targetQ);
        return new Response("OK");
      }

      // Сброс истории сыгранных вопросов
      if (cmd === "/reset") {
        const state = await loadState(token);
        const chatState = getChatState(state, chatId);
        chatState.used = [];
        chatState.ts = Date.now();
        await saveState(token, state);
        await tgApi(token, "sendMessage", {
          chat_id: chatId,
          text: "История сыгранных вопросов для этого чата сброшена.",
        });
        return new Response("OK");
      }

      const levelMap = {
        "/q": "any",
        "/question": "any",
        "/easy": "easy",
        "/medium": "medium",
        "/hard": "hard",
      };

      if (levelMap[cmd]) {
        const questions = await getQuestions(dataUrl);
        const level = levelMap[cmd];
        const state = await loadState(token);
        const chatState = getChatState(state, chatId);

        const { picked, resetUsed, matchingIndices } = pickQuestion(
          questions,
          level,
          chatState.used
        );
        if (!picked) {
          await tgApi(token, "sendMessage", {
            chat_id: chatId,
            text: "Вопросы выбранного уровня не найдены.",
          });
          return new Response("OK");
        }

        if (resetUsed && matchingIndices) {
          const removeSet = new Set(matchingIndices);
          chatState.used = chatState.used.filter((i) => !removeSet.has(i));
        }
        chatState.used.push(picked.index);
        chatState.last = picked.index;
        chatState.ts = Date.now();

        await sendQuestionMessage(token, chatId, picked.index, picked.item, level);
        await saveState(token, state);
      }

      return new Response("OK");
    } catch (err) {
      return new Response("OK", { status: 200 });
    }
  },
};

async function sendQuestionMessage(token, chatId, index, q, level) {
  const metaParts = [];
  if (q.dl) {
    metaParts.push(`Уровень пакета: ${escapeHtml(q.dl)}`);
  }
  metaParts.push(`Вопрос №${escapeHtml(q.n)}`);
  if (q.cr) {
    metaParts.push(`Взятие: ${escapeHtml(q.cr)}%`);
  }

  const text =
    `<b>${escapeHtml(q.t)}</b>\n` +
    `${metaParts.join(" · ")}\n\n` +
    `${escapeHtml(q.q)}`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "Показать ответ", callback_data: `ans:${index}` },
        { text: "Следующий вопрос", callback_data: `next:${level}` },
      ],
    ],
  };

  await tgApi(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
}

async function sendAnswerMessage(token, chatId, q) {
  const text =
    `<b>Ответ</b> (${escapeHtml(q.t)}, вопрос №${escapeHtml(q.n)}):\n` +
    `${escapeHtml(q.a)}`;

  await tgApi(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
  });
}
