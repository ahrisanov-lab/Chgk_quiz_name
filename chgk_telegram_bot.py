#!/usr/bin/env python3
"""
Telegram-бот для командного чата ЧГК.
Работает с CSV-базой (gotquestions_100_packs.csv) без внешних фреймворков (только requests).

Поддерживаемые команды в чате:
  /q или /question — случайный вопрос (без раздатки)
  /easy            — легкий вопрос (взятие >= 65%)
  /medium          — средний вопрос (взятие 35%–65%)
  /hard            — сложный вопрос (взятие < 35%)
  /ans или /answer — показать ответ на последний вопрос в этом чате
  Также под каждым вопросом есть кнопка «Показать ответ».

Запуск:
  export TELEGRAM_BOT_TOKEN="ваш_токен_от_BotFather"
  python3 chgk_telegram_bot.py --csv gotquestions_100_packs.csv
"""

import argparse
import csv
import html
import json
import os
import random
import time
from pathlib import Path
from typing import Any, Dict, List, Optional
import requests


def parse_avg_complexity(raw: str) -> Optional[float]:
    if not raw:
        return None
    vals: List[float] = []
    for part in str(raw).split(";"):
        part = part.strip().replace(",", ".")
        if not part:
            continue
        try:
            vals.append(float(part))
        except ValueError:
            continue
    return sum(vals) / len(vals) if vals else None


def load_questions(csv_path: str, skip_handouts: bool = True) -> List[Dict[str, Any]]:
    questions: List[Dict[str, Any]] = []
    with open(csv_path, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for idx, row in enumerate(reader):
            has_handout = str(row.get("есть раздатка", "0")).strip() == "1"
            if skip_handouts and has_handout:
                continue
            q_text = (row.get("вопрос") or "").strip()
            answer = (row.get("ответ") or "").strip()
            if not q_text or not answer:
                continue
            avg_comp = parse_avg_complexity(row.get("сложность", ""))
            questions.append(
                {
                    "uid": f"{row.get('турнир', '')}#{row.get('номер вопроса', idx)}",
                    "tournament": (row.get("турнир") or "").strip(),
                    "pack_dl": (row.get("уровень пакета") or "").strip(),
                    "number": (row.get("номер вопроса") or "").strip(),
                    "question": q_text,
                    "answer": answer,
                    "complexity_raw": (row.get("сложность") or "").strip(),
                    "complexity_avg": avg_comp,
                    "has_handout": has_handout,
                }
            )
    return questions


class ChgkTelegramBot:
    def __init__(
        self,
        token: str,
        questions: List[Dict[str, Any]],
        state_file: str = "bot_state.json",
        allowed_chats: Optional[List[int]] = None,
    ) -> None:
        self.api_base = f"https://api.telegram.org/bot{token}"
        self.questions = questions
        self.by_id = {i: q for i, q in enumerate(questions)}
        self.state_path = Path(state_file)
        self.allowed_chats = set(allowed_chats) if allowed_chats else None
        self.state = self._load_state()

    def _load_state(self) -> Dict[str, Any]:
        if self.state_path.exists():
            try:
                return json.loads(self.state_path.read_text(encoding="utf-8"))
            except Exception:
                pass
        return {"played": {}, "active_question": {}}

    def _save_state(self) -> None:
        self.state_path.write_text(
            json.dumps(self.state, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def _api(self, method: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        r = requests.post(f"{self.api_base}/{method}", json=payload, timeout=35)
        return r.json()

    def pick_question(self, chat_id: int, level: str = "any") -> Optional[tuple[int, Dict[str, Any]]]:
        chat_key = str(chat_id)
        played_uids = set(self.state["played"].get(chat_key, []))

        candidates: List[tuple[int, Dict[str, Any]]] = []
        for idx, q in enumerate(self.questions):
            if q["uid"] in played_uids:
                continue
            c = q["complexity_avg"]
            if level == "easy" and (c is None or c < 65.0):
                continue
            if level == "medium" and (c is None or not (35.0 <= c < 65.0)):
                continue
            if level == "hard" and (c is None or c >= 35.0):
                continue
            candidates.append((idx, q))

        if not candidates and played_uids:
            # Если все вопросы выбранного уровня сыграны, сбрасываем историю для чата
            self.state["played"][chat_key] = []
            return self.pick_question(chat_id, level=level)

        if not candidates:
            return None

        idx, chosen = random.choice(candidates)
        self.state["played"].setdefault(chat_key, []).append(chosen["uid"])
        self.state["active_question"][chat_key] = idx
        self._save_state()
        return idx, chosen

    def format_question_message(self, q: Dict[str, Any]) -> str:
        meta_parts = []
        if q.get("pack_dl"):
            meta_parts.append(f"Уровень пакета: {html.escape(q['pack_dl'])}")
        meta_parts.append(f"Вопрос №{html.escape(str(q['number']))}")
        if q.get("complexity_raw"):
            meta_parts.append(f"Взятие: {html.escape(q['complexity_raw'])}%")
        header = f"<b>{html.escape(q['tournament'])}</b>\n" + " · ".join(meta_parts)
        body = html.escape(q["question"])
        return f"{header}\n\n{body}"

    def handle_command(self, chat_id: int, text: str) -> None:
        cmd = text.split()[0].split("@")[0].lower()
        chat_key = str(chat_id)

        if cmd in ("/start", "/help"):
            help_text = (
                "<b>Командный бот «Это База»</b>\n\n"
                "/q — случайный вопрос\n"
                "/easy — легкий вопрос (взятие ≥ 65%)\n"
                "/medium — средний вопрос (35–65%)\n"
                "/hard — сложный вопрос (&lt; 35%)\n"
                "/ans — показать ответ на текущий вопрос"
            )
            self._api("sendMessage", {"chat_id": chat_id, "text": help_text, "parse_mode": "HTML"})
            return

        if cmd in ("/ans", "/answer"):
            idx = self.state["active_question"].get(chat_key)
            if idx is None or idx not in self.by_id:
                self._api("sendMessage", {"chat_id": chat_id, "text": "Сначала запросите вопрос командой /q."})
                return
            q = self.by_id[idx]
            ans_text = (
                f"<b>Ответ на вопрос №{html.escape(str(q['number']))}</b> ({html.escape(q['tournament'])}):\n"
                f"{html.escape(q['answer'])}"
            )
            self._api("sendMessage", {"chat_id": chat_id, "text": ans_text, "parse_mode": "HTML"})
            return

        level_map = {
            "/q": "any",
            "/question": "any",
            "/easy": "easy",
            "/medium": "medium",
            "/hard": "hard",
        }
        if cmd in level_map:
            picked = self.pick_question(chat_id, level=level_map[cmd])
            if not picked:
                self._api("sendMessage", {"chat_id": chat_id, "text": "Подходящие вопросы не найдены."})
                return
            idx, q = picked
            msg = self.format_question_message(q)
            keyboard = {
                "inline_keyboard": [
                    [
                        {"text": "Показать ответ", "callback_data": f"ans:{idx}"},
                        {"text": "Следующий вопрос", "callback_data": f"next:{level_map[cmd]}"},
                    ]
                ]
            }
            self._api(
                "sendMessage",
                {
                    "chat_id": chat_id,
                    "text": msg,
                    "parse_mode": "HTML",
                    "reply_markup": keyboard,
                },
            )

    def handle_callback(self, callback_query: Dict[str, Any]) -> None:
        cb_id = callback_query["id"]
        data = callback_query.get("data", "")
        msg = callback_query.get("message", {})
        chat_id = msg.get("chat", {}).get("id")
        if not chat_id:
            return

        if data.startswith("ans:"):
            idx = int(data.split(":", 1)[1])
            q = self.by_id.get(idx)
            if q:
                ans_text = (
                    f"<b>Ответ</b> ({html.escape(q['tournament'])}, вопрос №{html.escape(str(q['number']))}):\n"
                    f"{html.escape(q['answer'])}"
                )
                self._api("sendMessage", {"chat_id": chat_id, "text": ans_text, "parse_mode": "HTML"})
            self._api("answerCallbackQuery", {"callback_query_id": cb_id})
        elif data.startswith("next:"):
            level = data.split(":", 1)[1]
            self._api("answerCallbackQuery", {"callback_query_id": cb_id})
            self.handle_command(chat_id, f"/{'q' if level == 'any' else level}")

    def run_polling(self) -> None:
        offset = 0
        print(f"Бот запущен. Загружено вопросов в базу: {len(self.questions)}")
        while True:
            try:
                resp = self._api("getUpdates", {"offset": offset, "timeout": 25})
                for upd in resp.get("result", []):
                    offset = upd["update_id"] + 1
                    if "message" in upd:
                        m = upd["message"]
                        chat_id = m.get("chat", {}).get("id")
                        text = (m.get("text") or "").strip()
                        if self.allowed_chats and chat_id not in self.allowed_chats:
                            continue
                        if text.startswith("/"):
                            self.handle_command(chat_id, text)
                    elif "callback_query" in upd:
                        cb = upd["callback_query"]
                        chat_id = cb.get("message", {}).get("chat", {}).get("id")
                        if self.allowed_chats and chat_id not in self.allowed_chats:
                            continue
                        self.handle_callback(cb)
            except KeyboardInterrupt:
                print("\nОстановка бота.")
                break
            except Exception as e:
                print(f"Ошибка опроса Telegram API: {e}")
                time.sleep(3)


def main() -> None:
    parser = argparse.ArgumentParser(description="Telegram-бот ЧГК по CSV-базе")
    parser.add_argument("--csv", default="gotquestions_100_packs.csv", help="Путь к CSV-файлу с вопросами")
    parser.add_argument("--token", default=os.environ.get("TELEGRAM_BOT_TOKEN", ""), help="Токен Telegram-бота")
    parser.add_argument("--include-handouts", action="store_true", help="Включать вопросы с раздатками")
    parser.add_argument("--chat-id", type=int, action="append", help="Разрешенные chat_id (необязательно)")
    args = parser.parse_args()

    if not args.token:
        raise SystemExit("Укажите токен через переменную окружения TELEGRAM_BOT_TOKEN или параметр --token")

    questions = load_questions(args.csv, skip_handouts=not args.include_handouts)
    bot = ChgkTelegramBot(token=args.token, questions=questions, allowed_chats=args.chat_id)
    bot.run_polling()


if __name__ == "__main__":
    main()
