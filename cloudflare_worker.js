/**
 * Cloudflare Worker для командного Telegram-бота ЧГК («Это База»).
 *
 * Переменные окружения в настройках Worker (Settings -> Variables and Secrets):
 *   TELEGRAM_BOT_TOKEN — токен бота от @BotFather
 *   DATA_URL           — прямая ссылка raw.githubusercontent.com на questions.json (или gotquestions_100_packs.csv)
 *   ALLOWED_CHAT_ID    — (необязательно) ID чата команды, например -1001234567890
 */

let cachedQuestions = null;
let cacheTime = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 час

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

// Простой RFC-4180 парсер CSV на случай, если в DATA_URL указан .csv вместо .json
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
    if (hasHandout) continue;
    const q = String(r[idxQ] || "").trim();
    const a = String(r[idxA] || "").trim();
    if (!q || !a) continue;
    const cr = idxC >= 0 ? String(r[idxC] || "").trim() : "";
    result.push({
      t: idxT >= 0 ? String(r[idxT] || "").trim() : "",
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
  if (dataUrl.endsWith(".json") || text.trim().startsWith("[")) {
    cachedQuestions = JSON.parse(text);
  } else {
    cachedQuestions = parseCsv(text);
  }
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

function pickQuestion(questions, level) {
  const filtered = [];
  for (let i = 0; i < questions.length; i++) {
    const item = questions[i];
    const c = item.c;
    if (level === "easy" && (c === null || c < 65)) continue;
    if (level === "medium" && (c === null || c < 35 || c >= 65)) continue;
    if (level === "hard" && (c === null || c >= 35)) continue;
    filtered.push({ index: i, item });
  }
  if (!filtered.length) return null;
  return filtered[Math.floor(Math.random() * filtered.length)];
}

const DEFAULT_DATA_URL =
  "https://raw.githubusercontent.com/ahrisanov-lab/Chgk_quiz_name/main/questions.json";

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

    // Удобная привязка вебхука прямо из браузера: https://<ваш-воркер>.workers.dev/register
    if (url.pathname === "/register") {
      const webhookUrl = `${url.origin}/webhook`;
      const res = await tgApi(token, "setWebhook", { url: webhookUrl });
      return new Response(JSON.stringify(res, null, 2), {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    if (request.method !== "POST") {
      return new Response("Бот ЧГК работает. Для привязки вебхука откройте /register", {
        status: 200,
      });
    }

    try {
      const update = await request.json();
      const allowedChat = env.ALLOWED_CHAT_ID ? String(env.ALLOWED_CHAT_ID).trim() : "";

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
            const ansMsg =
              `<b>Ответ</b> (${escapeHtml(q.t)}, №${escapeHtml(q.n)}):\n` +
              `<tg-spoiler>${escapeHtml(q.a)}</tg-spoiler>`;
            await tgApi(token, "sendMessage", {
              chat_id: chatId,
              text: ansMsg,
              parse_mode: "HTML",
            });
          }
          await tgApi(token, "answerCallbackQuery", { callback_query_id: cb.id });
          return new Response("OK");
        }

        if (data.startsWith("next:")) {
          const level = data.slice(5) || "any";
          await tgApi(token, "answerCallbackQuery", { callback_query_id: cb.id });
          const picked = pickQuestion(questions, level);
          if (picked) {
            await sendQuestionMessage(token, chatId, picked.index, picked.item, level);
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
            "/q — случайный вопрос\n" +
            "/easy — легкий вопрос (взятие ≥ 65%)\n" +
            "/medium — средний вопрос (35–65%)\n" +
            "/hard — сложный вопрос (&lt; 35%)",
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
        const picked = pickQuestion(questions, level);
        if (!picked) {
          await tgApi(token, "sendMessage", {
            chat_id: chatId,
            text: "Вопросы выбранного уровня не найдены.",
          });
          return new Response("OK");
        }
        await sendQuestionMessage(token, chatId, picked.index, picked.item, level);
      }

      return new Response("OK");
    } catch (err) {
      return new Response("OK", { status: 200 });
    }
  },
};

async function sendQuestionMessage(token, chatId, index, q, level) {
  const compStr = q.cr ? ` · Взятие: ${escapeHtml(q.cr)}%` : "";
  const text =
    `<b>${escapeHtml(q.t)}</b>\n` +
    `Вопрос №${escapeHtml(q.n)}${compStr}\n\n` +
    `${escapeHtml(q.q)}\n\n` +
    `Ответ под спойлером: <tg-spoiler>${escapeHtml(q.a)}</tg-spoiler>`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "Отправить ответ отдельно", callback_data: `ans:${index}` },
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
