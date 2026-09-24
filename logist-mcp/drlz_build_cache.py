"""
drlz_build_cache.py — одноразовий/періодичний краулер Державного реєстру
лікарських засобів (drlz.info), офіційної заміни застарілого www.drlz.com.ua
(там форма пошуку віддає 500-ку, а CSV-вивантаження не оновлювалось з 2021).

drlz.info не має задокументованого текстового пошуку і його CSV-експорт
зависає по таймауту при живому запиті — тому підхід інший: обійти всі
сторінки офіційного постраничного лістингу (підтверджено робочий,
~1000 сторінок по 10 записів) ОДИН РАЗ і зберегти результат у локальний
JSON-файл. MCP-тул drlz_lookup_registration потім шукає по цьому файлу
миттєво, не залежачи від того, чи живий сайт у момент запиту.

Запуск (вручну або через cron, напр. раз на тиждень):
    python drlz_build_cache.py [--out drlz_cache.json] [--pages N] [--delay 0.5]

Порада: перший запуск краще зробити з `--pages 5`, щоб на очах перевірити,
що парсинг таблиці коректно ліг на реальну верстку сайту (я перевіряв
структуру сторінки через текстовий рендер, не бачив живого HTML з
CSS-класами — тому є шанс, що селектори треба буде підправити).
"""

import argparse
import asyncio
import json
import sys
import time
from datetime import datetime, timezone

import httpx
from bs4 import BeautifulSoup

BASE_URL = "https://drlz.info/register/products/"
HTTP_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; AG95-LogistBot/1.0)"}
REQUEST_TIMEOUT = 30.0
EXPECTED_COLUMNS = [
    "reg_number",
    "name",
    "reg_end_date",
    "active_substances",
    "manufacturer",
    "reg_holder",
]


def _parse_page(html: str) -> list[dict]:
    """Розпарсити одну сторінку лістингу в список записів реєстру."""
    soup = BeautifulSoup(html, "html.parser")
    table = soup.find("table")
    if table is None:
        return []

    rows = []
    for tr in table.find_all("tr"):
        cells = tr.find_all("td")
        if len(cells) < len(EXPECTED_COLUMNS) + 1:  # +1 бо перша колонка — порядковий номер
            continue  # це рядок заголовка чи щось нетипове — пропускаємо

        texts = [c.get_text(strip=True) for c in cells[1:]]  # відкидаємо порядковий номер
        record = dict(zip(EXPECTED_COLUMNS, texts))

        # Колонка "Назва" — друга після порядкового номера (cells[0]=#, cells[1]=№ РП,
        # cells[2]=Назва) і містить посилання на картку препарату.
        link = cells[2].find("a", href=True) if len(cells) > 2 else None
        record["product_url"] = (
            f"https://drlz.info{link['href']}"
            if link and link["href"].startswith("/")
            else (link["href"] if link else "")
        )
        rows.append(record)
    return rows


async def build_cache(out_path: str, max_pages: int, delay: float) -> None:
    all_records: list[dict] = []
    empty_streak = 0

    async with httpx.AsyncClient(headers=HTTP_HEADERS, timeout=REQUEST_TIMEOUT) as client:
        for page in range(1, max_pages + 1):
            try:
                resp = await client.get(BASE_URL, params={"page": page})
                resp.raise_for_status()
            except httpx.HTTPError as e:
                print(f"[сторінка {page}] помилка запиту: {e} — зупиняюсь", file=sys.stderr)
                break

            records = _parse_page(resp.text)
            if not records:
                empty_streak += 1
                print(f"[сторінка {page}] 0 записів (поспіль порожніх: {empty_streak})")
                if empty_streak >= 3:
                    print("Три порожні сторінки поспіль — вважаю, що реєстр закінчився.")
                    break
            else:
                empty_streak = 0
                all_records.extend(records)
                if page % 20 == 0 or page == 1:
                    print(f"[сторінка {page}/{max_pages}] зібрано всього: {len(all_records)}")

            time.sleep(delay)  # ввічливість до сайту — не долбити без затримки

    payload = {
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "source": BASE_URL,
        "count": len(all_records),
        "records": all_records,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    print(f"\nГотово: {len(all_records)} записів збережено у {out_path}")
    if all_records:
        print("Приклад першого запису:", json.dumps(all_records[0], ensure_ascii=False))
    else:
        print(
            "УВАГА: жодного запису не розпізнано — структура таблиці на сайті, "
            "ймовірно, відрізняється від очікуваної. Треба звірити з реальним "
            "HTML сторінки й підправити _parse_page().",
            file=sys.stderr,
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default="drlz_cache.json", help="Шлях до вихідного JSON-файлу")
    parser.add_argument(
        "--pages", type=int, default=1000, help="Максимальна кількість сторінок для обходу"
    )
    parser.add_argument(
        "--delay", type=float, default=0.5, help="Пауза між запитами в секундах (ввічливість)"
    )
    args = parser.parse_args()
    asyncio.run(build_cache(args.out, args.pages, args.delay))


if __name__ == "__main__":
    main()
