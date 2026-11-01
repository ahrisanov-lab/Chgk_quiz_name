#!/usr/bin/env python3
"""
Выгрузка пакетов вопросов с gotquestions.online в CSV.

Столбцы CSV:
- турнир
- номер вопроса
- вопрос
- ответ
- сложность
- есть раздатка (1 или 0)

Примеры запуска:
  python3 gq_to_csv.py --latest-with-dl 100 -o gotquestions_100_packs.csv
  python3 gq_to_csv.py --pack 7308 --pack 7307 -o questions.csv
  python3 gq_to_csv.py --file packs.txt -o questions.csv
"""

import argparse
import csv
import json
import math
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Dict, List, Optional, Tuple
import requests

BASE_URL = "https://gotquestions.online"
DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/126.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
}

DECODER = json.JSONDecoder()


def clean_text(val: Any) -> str:
    if val is None:
        return ""
    s = str(val)
    s = s.replace("\u00a0", " ").replace("\u2060", "")
    return s.strip()


def extract_rsc_stream(html: str) -> str:
    chunks = re.findall(r'self\.__next_f\.push\(\[1,"(.*?)"\]\)</script>', html, re.S)
    parts: List[str] = []
    for c in chunks:
        try:
            parts.append(json.loads('"' + c + '"'))
        except Exception:
            continue
    return "".join(parts)


def parse_rsc_text_chunks(full_stream: str) -> Dict[str, str]:
    t_map: Dict[str, str] = {}
    for m in re.finditer(r"([0-9a-fA-F]+):T([0-9a-fA-F]+),", full_stream):
        cid = m.group(1)
        byte_len = int(m.group(2), 16)
        start_pos = m.end()
        raw_bytes = full_stream[start_pos:].encode("utf-8")[:byte_len]
        t_map["$" + cid] = raw_bytes.decode("utf-8", errors="ignore")
    return t_map


def resolve_str(val: Any, t_map: Dict[str, str]) -> str:
    if not isinstance(val, str):
        return "" if val is None else str(val)
    if val.startswith("$$"):
        return val[1:]
    if val.startswith("$") and val in t_map:
        return t_map[val]
    return val


def fetch_latest_pack_ids_with_dl(count: int, timeout: int = 20) -> List[int]:
    """
    Получает ID последних опубликованных пакетов (по дате публикации uDate desc),
    у которых проставлен уровень сложности (uDL=false).
    """
    page_size = min(100, max(18, count if count % 2 == 0 else count + 1))
    pages_needed = math.ceil(count / page_size)
    pack_ids: List[int] = []

    session = requests.Session()
    session.headers.update(DEFAULT_HEADERS)

    for page in range(1, pages_needed + 1):
        url = (
            f"{BASE_URL}/search?type=packages"
            f"&uDL=false&sSort=uDate&sortDirection=desc"
            f"&limit={page_size}&page={page}"
        )
        r = session.get(url, timeout=timeout)
        r.raise_for_status()
        full_stream = extract_rsc_stream(r.text)
        marker = '"initialData":'
        idx = full_stream.find(marker)
        if idx == -1:
            break
        init_data, _ = DECODER.raw_decode(full_stream, idx + len(marker))
        items = init_data.get("items", [])
        if not items:
            break
        for item in items:
            pid = item.get("id")
            if isinstance(pid, int) and pid not in pack_ids:
                pack_ids.append(pid)
                if len(pack_ids) >= count:
                    return pack_ids
    return pack_ids[:count]


def fetch_pack_data(pack_id: int, timeout: int = 20, retries: int = 4) -> Optional[Dict[str, Any]]:
    url = f"{BASE_URL}/pack/{pack_id}"
    for attempt in range(retries):
        try:
            r = requests.get(url, headers=DEFAULT_HEADERS, timeout=timeout)
            if r.status_code == 429:
                time.sleep(1.5 * (attempt + 1))
                continue
            r.raise_for_status()
            full_stream = extract_rsc_stream(r.text)
            t_map = parse_rsc_text_chunks(full_stream)
            marker = f'"pack":{{"id":{pack_id},'
            pos = 0
            while True:
                idx = full_stream.find(marker, pos)
                if idx == -1:
                    break
                obj, end_idx = DECODER.raw_decode(full_stream, idx + len('"pack":'))
                if isinstance(obj, dict) and "tours" in obj:
                    obj["title"] = resolve_str(obj.get("title", ""), t_map)
                    for tour in obj.get("tours", []):
                        for q in tour.get("questions", []):
                            for k in (
                                "text",
                                "answer",
                                "razdatkaText",
                                "razdatkaPic",
                                "razdatkaPicGeneric",
                                "audio",
                                "comment",
                                "zachet",
                                "nezachet",
                                "source",
                            ):
                                if k in q:
                                    q[k] = resolve_str(q[k], t_map)
                    return obj
                pos = end_idx
            return None
        except Exception:
            if attempt < retries - 1:
                time.sleep(1.0 * (attempt + 1))
    return None


def pack_to_rows(pack: Dict[str, Any]) -> List[Dict[str, Any]]:
    title = clean_text(pack.get("title", "")) or f"Пакет {pack.get('id', '')}"
    rows: List[Dict[str, Any]] = []
    for tour in pack.get("tours", []):
        for q in tour.get("questions", []):
            q_num = q.get("number", "")
            q_text = clean_text(q.get("text", ""))
            r_text = clean_text(q.get("razdatkaText", ""))
            if not q_text and r_text:
                q_text = r_text
            answer = clean_text(q.get("answer", ""))
            if not answer:
                # Если ответ случайно оказался внутри текста вопроса или в поле зачета
                m_ans = re.search(r"\n\s*Ответ[:\s]+([^\n]+)", q_text, re.I)
                if m_ans:
                    answer = clean_text(m_ans.group(1))
                elif clean_text(q.get("zachet", "")) and clean_text(q.get("zachet", "")).lower() != "точный":
                    answer = clean_text(q.get("zachet", ""))

            comp_list = q.get("complexity") or []
            complexity = "; ".join(str(x).strip() for x in comp_list if str(x).strip())

            has_handout = 1 if any(
                clean_text(q.get(k, ""))
                for k in ("razdatkaText", "razdatkaPic", "razdatkaPicGeneric", "audio")
            ) else 0

            rows.append(
                {
                    "турнир": title,
                    "номер вопроса": q_num,
                    "вопрос": q_text,
                    "ответ": answer,
                    "сложность": complexity,
                    "есть раздатка": has_handout,
                }
            )
    return rows


def parse_pack_id(raw: str) -> Optional[int]:
    raw = raw.strip()
    if not raw or raw.startswith("#"):
        return None
    if raw.isdigit():
        return int(raw)
    m = re.search(r"/pack/(\d+)", raw)
    if m:
        return int(m.group(1))
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description="Выгрузка вопросов с gotquestions.online в CSV")
    parser.add_argument(
        "--latest-with-dl",
        type=int,
        default=0,
        help="Выгрузить N последних опубликованных пакетов, у которых проставлен уровень сложности",
    )
    parser.add_argument("--pack", action="append", default=[], help="ID пакета (можно указать несколько раз)")
    parser.add_argument("--url", action="append", default=[], help="URL пакета (можно указать несколько раз)")
    parser.add_argument("--file", help="Файл со списком ID или URL пакетов (по одному на строку)")
    parser.add_argument("-o", "--output", default="questions.csv", help="Путь к выходному CSV-файлу")
    parser.add_argument("--workers", type=int, default=5, help="Количество потоков загрузки (по умолчанию 5)")
    args = parser.parse_args()

    pack_ids: List[int] = []
    if args.latest_with_dl > 0:
        print(f"Поиск {args.latest_with_dl} последних пакетов с проставленной сложностью...", file=sys.stderr)
        pack_ids.extend(fetch_latest_pack_ids_with_dl(args.latest_with_dl))

    for p in args.pack:
        pid = parse_pack_id(p)
        if pid and pid not in pack_ids:
            pack_ids.append(pid)

    for u in args.url:
        pid = parse_pack_id(u)
        if pid and pid not in pack_ids:
            pack_ids.append(pid)

    if args.file:
        with open(args.file, encoding="utf-8") as f:
            for line in f:
                pid = parse_pack_id(line)
                if pid and pid not in pack_ids:
                    pack_ids.append(pid)

    if not pack_ids:
        parser.error("Укажите --latest-with-dl N, --pack ID, --url URL или --file PATH")

    print(f"Найдено пакетов для выгрузки: {len(pack_ids)}", file=sys.stderr)
    results: Dict[int, Dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
        futs = {executor.submit(fetch_pack_data, pid): pid for pid in pack_ids}
        for i, fut in enumerate(as_completed(futs), 1):
            pid = futs[fut]
            data = fut.result()
            if data:
                results[pid] = data
                print(f"[{i}/{len(pack_ids)}] Загружен пакет {pid}: {data.get('title')}", file=sys.stderr)
            else:
                print(f"[{i}/{len(pack_ids)}] Не удалось загрузить пакет {pid}", file=sys.stderr)

    fieldnames = ["турнир", "номер вопроса", "вопрос", "ответ", "сложность", "есть раздатка"]
    total_rows = 0
    with open(args.output, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for pid in pack_ids:
            pack = results.get(pid)
            if not pack:
                continue
            rows = pack_to_rows(pack)
            writer.writerows(rows)
            total_rows += len(rows)

    print(f"Готово! Сохранено пакетов: {len(results)}, вопросов: {total_rows} -> {args.output}", file=sys.stderr)


if __name__ == "__main__":
    main()
