const DEFAULT_DATA_URL =
  "https://raw.githubusercontent.com/ahrisanov-lab/Chgk_quiz_name/main/questions.json";

let cachedQuestions = null;
let cacheTime = 0;
let memoryState = null;
let commandsMenuRegistered = false;

const CACHE_TTL_MS = 60 * 60 * 1000;
const STATE_CACHE_URL = "https://chgk-bot-state.internal/state-v2";
const HANDOUT_RE =
  /(\[\s*раздаточный материал|раздаточный материал\s*:|раздатка\s*:|на раздаточном материале|на раздатке|мы раздали вам|розданн|перед вами на раздатке)/i;

const BOT_COMMANDS_MENU = [
  { command: "q", description: "Случайный вопрос (без раздатки)" },
  { command: "ans", description: "Показать ответ на последний вопрос" },
  { command: "easy", description: "Легкий вопрос (взятие от 65%)" },
  { command: "medium", description: "Средний вопрос (взятие 35–65%)" },
  { command: "hard", description: "Сложный вопрос (взятие до 35%)" },
  { command: "reset", description: "Сбросить историю сыгранных вопросов" },
];

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function tgApi(token, method, payload) {
  const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return resp.json();
}

async function getQuestions(dataUrl) {
  const now = Date.now();
  if (cachedQuestions && now - cacheTime < CACHE_TTL_MS) return cachedQuestions;
  const resp = await fetch(dataUrl);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  cachedQuestions = data.filter(
    (item) => item && item.q && item.a && !HANDOUT_RE.test(String(item.q))
  );
  cacheTime = now;
  return cachedQuestions;
}

function mergeStates(a, b) {
  const out = { chats: {} };
  const keys = new Set([
    ...Object.keys((a && a.chats) || {}),
    ...Object.keys((b && b.chats) || {}),
  ]);
  for (const cid of keys) {
    const ca = (a && a.chats && a.chats[cid]) || { last: null, used: [], ts: 0 };
    const cb = (b && b.chats && b.chats[cid]) || { last: null, used: [], ts: 0 };
    const newer = (cb.ts || 0) >= (ca.ts || 0) ? cb : ca;
    const older = newer === cb ? ca : cb;
    out.chats[cid] = {
      last: newer.last !== null && newer.last !== undefined ? newer.last : older.last,
      used: Array.from(new Set([...(ca.used || []), ...(cb.used || [])])),
      ts: Math.max(ca.ts || 0, cb.ts || 0),
    };
  }
  return out;
}

async function loadState(token) {
  if (memoryState) return memoryState;
  let cacheState = null;
  try {
    if (typeof caches !== "undefined" && caches.default) {
      const r = await caches.default.match(STATE_CACHE_URL);
      if (r) cacheState = await r.json();
    }
  } catch (_) {}

  let tgState = null;
  try {
    const res = await tgApi(token, "getMyCommands", {
      scope: { type: "default" },
      language_code: "eo",
    });
    if (res && res.ok && Array.isArray(res.result) && res.result.length > 0) {
      const raw = res.result
        .filter((c) => c.command && c.command.startsWith("s_"))
        .sort((x, y) => parseInt(x.command.slice(2), 10) - parseInt(y.command.slice(2), 10))
        .map((c) => c.description)
        .join("");
      if (raw) tgState = JSON.parse(raw);
    }
  } catch (_) {}

  memoryState = mergeStates(cacheState, tgState);
  return memoryState;
}

async function saveState(token, state) {
  memoryState = state;
  try {
    if (typeof caches !== "undefined" && caches.default) {
      await caches.default.put(
        STATE_CACHE_URL,
        new Response(JSON.stringify(state), {
          headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=31536000" },
        })
      );
    }
  } catch (_) {}

  try {
    const jsonStr = JSON.stringify(state);
    const chunks = [];
    for (let i = 0; i < jsonStr.length && chunks.length < 95; i += 240) {
      chunks.push({ command: `s_${chunks.length}`, description: jsonStr.slice(i, i + 240) });
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
  if (!state.chats[key]) state.chats[key] = { last: null, used: [], ts: 0 };
  return state.chats[key];
}

function pickQuestion(questions, level, usedIndices) {
  const usedSet = new Set(usedIndices || []);
  const all = [];
  const unused = [];
  for (let i = 0; i < questions.length; i++) {
    const item = questions[i];
    if (!item || !item.q || !item.a || HANDOUT_RE.test(String(item.q))) continue;
    const c = item.c;
    if (level === "easy" && (c === null || c < 65)) continue;
    if (level === "medium" && (c === null || c < 35 || c >= 65)) continue;
    if (level === "hard" && (c === null || c >= 35)) continue;
    all.push({ index: i, item });
    if (!usedSet.has(i)) unused.push({ index: i, item });
  }
  if (unused.length > 0) {
    return { picked: unused[Math.floor(Math.random() * unused.length)], resetUsed: false };
  }
  if (all.length > 0) {
    return {
      picked: all[Math.floor(Math.random() * all.length)],
      resetUsed: true,
      matchingIndices: all.map((m) => m.index),
    };
  }
  return { picked: null, resetUsed: false };
}

async function sendQuestionMessage(token, chatId, index, q, level) {
  const meta = [];
  if (q.dl) meta.push(`Уровень пакета: ${escapeHtml(q.dl)}`);
  meta.push(`Вопрос №${escapeHtml(q.n)}`);
  if (q.cr) meta.push(`Взятие: ${escapeHtml(q.cr)}%`);

  const text = `<b>${escapeHtml(q.t)}</b>\n${meta.join(" · ")}\n\n${escapeHtml(q.q)}`;
  const reply_markup = {
    inline_keyboard: [
      [
        { text: "Показать ответ", callback_data: `ans:${index}` },
        { text: "Следующий вопрос", callback_data: `next:${level}` },
      ],
    ],
  };
  await tgApi(token, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", reply_markup });
}

async function sendAnswerMessage(token, chatId, q) {
  const text = `<b>Ответ</b> (${escapeHtml(q.t)}, вопрос №${escapeHtml(q.n)}):\n${escapeHtml(q.a)}`;
  await tgApi(token, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const token = env.TELEGRAM_BOT_TOKEN;
    const dataUrl = env.DATA_URL || DEFAULT_DATA_URL;

    if (!token) {
      return new Response("Укажите TELEGRAM_BOT_TOKEN в Settings -> Variables and Secrets.", { status: 500 });
    }

    if (url.pathname === "/register") {
      const webhook = await tgApi(token, "setWebhook", { url: `${url.origin}/webhook` });
      const commands = await tgApi(token, "setMyCommands", { commands: BOT_COMMANDS_MENU });
      commandsMenuRegistered = true;
      return new Response(JSON.stringify({ webhook, commands }, null, 2), {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    if (request.method !== "POST") {
      return new Response("Бот ЧГК работает. Для привязки вебхука откройте /register", { status: 200 });
    }

    try {
      const update = await request.json();
      const allowedChat = env.ALLOWED_CHAT_ID ? String(env.ALLOWED_CHAT_ID).trim() : "";

      if (!commandsMenuRegistered) {
        commandsMenuRegistered = true;
        tgApi(token, "setMyCommands", { commands: BOT_COMMANDS_MENU }).catch(() => {});
      }

      if (update.callback_query) {
        const cb = update.callback_query;
        const chatId = cb.message?.chat?.id;
        if (!chatId || (allowedChat && String(chatId) !== allowedChat)) return new Response("OK");
        const data = cb.data || "";
        const questions = await getQuestions(dataUrl);

        if (data.startsWith("ans:")) {
          const q = questions[parseInt(data.slice(4), 10)];
          if (q) await sendAnswerMessage(token, chatId, q);
          await tgApi(token, "answerCallbackQuery", { callback_query_id: cb.id });
          return new Response("OK");
        }

        if (data.startsWith("next:")) {
          const level = data.slice(5) || "any";
          await tgApi(token, "answerCallbackQuery", { callback_query_id: cb.id });
          const state = await loadState(token);
          const chatState = getChatState(state, chatId);
          const { picked, resetUsed, matchingIndices } = pickQuestion(questions, level, chatState.used);
          if (picked) {
            if (resetUsed && matchingIndices) {
              const rm = new Set(matchingIndices);
              chatState.used = chatState.used.filter((i) => !rm.has(i));
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

      const msg = update.message;
      if (!msg || !msg.text) return new Response("OK");
      const chatId = msg.chat.id;
      if (allowedChat && String(chatId) !== allowedChat) return new Response("OK");

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

      if (cmd === "/ans" || cmd === "/answer" || cmd === "/a" || cmd === "/otvet" || cmd === "/ответ") {
        const questions = await getQuestions(dataUrl);
        const state = await loadState(token);
        const chatState = getChatState(state, chatId);
        const targetQ =
          chatState.last !== null && chatState.last !== undefined ? questions[chatState.last] : null;
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

      const levelMap = { "/q": "any", "/question": "any", "/easy": "easy", "/medium": "medium", "/hard": "hard" };
      if (levelMap[cmd]) {
        const questions = await getQuestions(dataUrl);
        const level = levelMap[cmd];
        const state = await loadState(token);
        const chatState = getChatState(state, chatId);
        const { picked, resetUsed, matchingIndices } = pickQuestion(questions, level, chatState.used);
        if (!picked) {
          await tgApi(token, "sendMessage", { chat_id: chatId, text: "Вопросы не найдены." });
          return new Response("OK");
        }
        if (resetUsed && matchingIndices) {
          const rm = new Set(matchingIndices);
          chatState.used = chatState.used.filter((i) => !rm.has(i));
        }
        chatState.used.push(picked.index);
        chatState.last = picked.index;
        chatState.ts = Date.now();
        await sendQuestionMessage(token, chatId, picked.index, picked.item, level);
        await saveState(token, state);
      }

      return new Response("OK");
    } catch (_) {
      return new Response("OK", { status: 200 });
    }
  },
};
