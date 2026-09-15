"""
logist_mcp — MCP-сервер професійної перевірки товарів для імпорту: коди УКТЗЕД,
подвійне використання (qdpro.com.ua), офіційний курс НБУ, ідентифікація
хімічних речовин (PubChem) та перевірка реєстрації ліків (кеш drlz.info).

Задум: разом з контекстом документів (Штурман) дає точну, звірену з
першоджерелами відповідь замість здогадки з пам'яті моделі.

Шість інструментів:
  - uktzed_lookup_code: повна довідка по 10-значному коду УКТЗЕД (мито, ПДВ,
    ліцензування, пільги за угодами, обмеження, наркотичні речовини тощо)
  - uktzed_browse_classifier: навігація по ієрархії класифікатора УКТЗЕД
    (розділ -> група -> товарна позиція -> підпозиція)
  - dualuse_browse_classifier: навігація по Єдиному списку товарів подвійного
    використання, з переліком пов'язаних кодів УКТЗЕД по кожній категорії
  - get_exchange_rate: офіційний курс гривні НБУ до заданої валюти на дату
  - pubchem_identify_substance: ідентифікація хімічної речовини за назвою чи
    CAS-номером (формула, маса, синоніми) — звірка "це той самий реагент"
  - drlz_lookup_registration: пошук по локальному кешу Держреєстру ліків
    (кеш будується окремо, див. drlz_build_cache.py — сайт не має робочого
    живого пошуку, а старий www.drlz.com.ua мертвий і застарілий з 2021)

Свідомо НЕ додано:
  - EDQM CEP database: extranet.edqm.eu забороняє автоматичний доступ через
    robots.txt і вимагає sign-in — перевірка CEP залишається ручною

Запуск локально (stdio, для тестування через MCP Inspector):
    python logist_mcp.py

Запуск як віддалений сервер (Streamable HTTP, для docker-compose + Caddy):
    python logist_mcp.py --http --port 8000
"""

import json
import os
import re
import sys
from urllib.parse import quote

import httpx
from bs4 import BeautifulSoup
from pydantic import BaseModel, Field, ConfigDict, field_validator, ValidationError

from mcp.server.fastmcp import FastMCP
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

mcp = FastMCP("logist_mcp")

BASE_URL = "https://www.qdpro.com.ua/uk"
HTTP_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; AG95-LogistBot/1.0)"}
REQUEST_TIMEOUT = 20.0

# На кожній сторінці сайту після основного контенту йде однаковий блок
# сайтового меню/футера — відрізаємо все, що починається з цього маркера,
# замість того щоб покладатись на конкретні CSS-класи Drupal-теми (вони можуть
# змінитись при редизайні сайту, текстовий маркер надійніший).
BOILERPLATE_MARKER = "Головне меню"


async def _fetch_soup(path: str) -> BeautifulSoup:
    """Забрати сторінку qdpro.com.ua і повернути розпарсений BeautifulSoup."""
    url = f"{BASE_URL}/{path.lstrip('/')}"
    async with httpx.AsyncClient(
        headers=HTTP_HEADERS, timeout=REQUEST_TIMEOUT, follow_redirects=True
    ) as client:
        try:
            resp = await client.get(url)
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 404:
                raise ValueError(f"Сторінку не знайдено: {url}") from e
            raise ValueError(
                f"Помилка запиту до qdpro.com.ua: HTTP {e.response.status_code}"
            ) from e
        except httpx.TimeoutException as e:
            raise ValueError("Таймаут запиту до qdpro.com.ua, спробуйте ще раз") from e
    return BeautifulSoup(resp.text, "html.parser")


def _clean_text(soup: BeautifulSoup) -> str:
    """Очистити soup від скриптів/меню/футера і повернути текст."""
    for tag in soup(["script", "style", "nav"]):
        tag.decompose()
    text = soup.get_text("\n", strip=True)
    cut_at = text.find(BOILERPLATE_MARKER)
    if cut_at != -1:
        text = text[:cut_at]
    return text.strip()


async def _fetch_clean_text(path: str) -> str:
    """Забрати сторінку qdpro.com.ua і повернути очищений текст без меню/футера."""
    return _clean_text(await _fetch_soup(path))


def _cap(text: str, limit: int) -> str:
    """Обрізати надто довгий текст (сторінки qdpro тягнуть ~48КБ сайтового меню)."""
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "\n…[обрізано]"


def _extract_links(soup: BeautifulSoup, prefix: str) -> list[dict]:
    """Витягти дочірні вузли з посилань <a href=".../{prefix}/{id}">.

    ВАЖЛИВО для dualuse: навігація по дереву вимагає внутрішнього node_id, який
    живе ЛИШЕ в href посилання (get_text його втрачає). Тут ми беремо id із
    сегмента шляху після /{prefix}/ і повертаємо його разом з текстом-підписом,
    щоб модель могла заглибитись наступним викликом.
    """
    pat = re.compile(rf"/{re.escape(prefix)}/([^/?#\"']+)")
    out: list[dict] = []
    seen: set = set()
    for a in soup.find_all("a", href=True):
        m = pat.search(a["href"])
        if not m:
            continue
        node = m.group(1).strip()
        label = a.get_text(" ", strip=True)
        if not node:
            continue
        key = (node, label)
        if key in seen:
            continue
        seen.add(key)
        out.append({"id": node, "label": label})
    return out[:400]


def _trim_footer(text: str) -> str:
    """Cut the shared site menu/footer that follows the content on every page."""
    cut = text.find(BOILERPLATE_MARKER)
    if cut != -1:
        text = text[:cut]
    return text.strip()


def _extract_goodinfo(soup: BeautifulSoup) -> tuple:
    """Split a goodinfo page into (common, tabs).

    The page carries the customs regime views as jQuery tabs in ONE document:
    `#jquery_tab0` = ІМПОРТ, `#jquery_tab1` = ЕКСПОРТ, `#jquery_tab2` = ТРАНЗИТ
    (labels come from the tab menu `<a href="#jquery_tabN">`). A flat get_text()
    mashes all regimes together, so a requirement can't be attributed to import
    vs export vs transit. Here we pull each tab's text SEPARATELY (labelled) and
    return the remaining page (code description, tariff, shared notes) as `common`.
    Falls back gracefully: a page without these tabs yields common = full text,
    tabs = [].
    """
    for tag in soup(["script", "style", "nav"]):
        tag.decompose()

    labels: dict = {}
    for a in soup.find_all("a", href=True):
        m = re.match(r"#(jquery_tab\d+)$", a["href"].strip())
        if m:
            labels[m.group(1)] = a.get_text(" ", strip=True)

    tabs: list = []
    for i in range(8):
        tid = f"jquery_tab{i}"
        node = soup.find(id=tid)
        if node is None:
            continue
        tabs.append({"label": labels.get(tid, tid), "text": _trim_footer(node.get_text("\n", strip=True))})

    container = soup.find(id="jquery_tabs")
    if container is not None:
        container.decompose()
    common = _trim_footer(soup.get_text("\n", strip=True))
    return common, tabs


def _clean_text_and_links(soup: BeautifulSoup, prefix: str, cap: int) -> tuple:
    """Повернути (очищений+обрізаний текст, список дочірніх вузлів з node_id)."""
    # Strip the site menu/footer first so its links don't pollute the child list.
    for tag in soup(["script", "style", "nav"]):
        tag.decompose()
    links = _extract_links(soup, prefix)
    text = _cap(_clean_text(soup), cap)
    return text, links


class LookupCodeInput(BaseModel):
    """Вхідні дані для пошуку довідки по коду УКТЗЕД."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    code: str = Field(
        ...,
        description=(
            "10-значний код УКТЗЕД, з пробілами або без "
            "(наприклад '3004 32 00 00' або '3004320000')"
        ),
        min_length=4,
        max_length=15,
    )

    @field_validator("code")
    @classmethod
    def normalize_code(cls, v: str) -> str:
        digits = re.sub(r"\D", "", v)
        if len(digits) != 10:
            raise ValueError(
                f"Код УКТЗЕД має складатись з 10 цифр, отримано {len(digits)}: {v!r}"
            )
        return digits


@mcp.tool(
    name="uktzed_lookup_code",
    annotations={
        "title": "Довідка по коду УКТЗЕД",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def uktzed_lookup_code(params: LookupCodeInput) -> str:
    """Отримати повну митну довідку по 10-значному коду УКТЗЕД.

    Повертає опис товару та (окремо для імпорту/експорту/транзиту): ставки
    ввізного/вивізного мита (пільгова і повна), ПДВ, пільгові ставки за
    торговими угодами (ЄС, ЄАВТ, Канада, Британія тощо), вимоги ліцензування,
    обмеження щодо наркотичних засобів і прекурсорів, застосування
    техрегламентів, заборони ввезення та інші митні формальності.

    Args:
        params (LookupCodeInput): 10-значний код УКТЗЕД.

    Returns:
        str: Текст довідки по товару (джерело: qdpro.com.ua, дані ДФС/Мінфіну).
    """
    return await _fetch_clean_text(f"goodinfo/{params.code}")


class BrowseClassifierInput(BaseModel):
    """Вхідні дані для навігації по ієрархії УКТЗЕД."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    code: str = Field(
        default="",
        description=(
            "Код рівня класифікатора: порожній рядок — усі 21 розділ; "
            "римська цифра (напр. 'VI') — розділ; 2 цифри (напр. '30') — група; "
            "4+ цифри (напр. '3004') — товарна позиція чи підпозиція"
        ),
        max_length=15,
    )


@mcp.tool(
    name="uktzed_browse_classifier",
    annotations={
        "title": "Навігація по класифікатору УКТЗЕД",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def uktzed_browse_classifier(params: BrowseClassifierInput) -> str:
    """Переглянути ієрархію класифікатора УКТЗЕД, щоб знайти потрібний код.

    Структура: Розділ (I-XXI, римські цифри) -> Група (2 цифри) ->
    Товарна позиція (4 цифри) -> Підпозиція (6-10 цифр, кінцевий код для
    uktzed_lookup_code). Викликати без коду, щоб побачити всі 21 розділ,
    потім заглиблюватись по одному рівню за раз.

    Args:
        params (BrowseClassifierInput): Код рівня класифікатора (може бути
            порожнім, розділом, групою чи товарною позицією).

    Returns:
        str: Список дочірніх елементів (код + опис) для заданого рівня.
    """
    path = "uktzed" if not params.code else f"uktzed/{params.code}"
    return await _fetch_clean_text(path)


class DualUseBrowseInput(BaseModel):
    """Вхідні дані для навігації по списку товарів подвійного використання."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    node_id: str = Field(
        default="",
        description=(
            "Внутрішній ID вузла класифікатора подвійного використання. "
            "Порожньо — корінь списку (усі розділи). ID дочірніх вузлів "
            "беруться з посилань у відповіді попереднього виклику цього тулу."
        ),
        max_length=15,
    )


@mcp.tool(
    name="dualuse_browse_classifier",
    annotations={
        "title": "Навігація по списку товарів подвійного використання",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def dualuse_browse_classifier(params: DualUseBrowseInput) -> str:
    """Переглянути Єдиний список товарів подвійного використання (експортний контроль).

    Список організовано за категоріями експортного контролю (напр. "8A002" —
    морське обладнання), а НЕ за кодами УКТЗЕД напряму: кожна кінцева
    категорія переліковує пов'язані з нею коди УКТЗЕД. Щоб перевірити, чи
    підпадає товар під подвійне використання — знайдіть його категорію в
    ієрархії (почніть виклик без node_id, щоб побачити корінь дерева) і
    звірте перелічені у відповіді коди УКТЗЕД з кодом товару.

    ВАЖЛИВО: node_id — це внутрішній ID вузла сайту-джерела, НЕ сам код
    категорії експортного контролю (на кшталт "8A002"). Значення node_id для
    заглиблення треба брати з посилань у відповіді попереднього виклику.

    Args:
        params (DualUseBrowseInput): ID вузла для заглиблення (порожньо —
            корінь списку).

    Returns:
        str: Дочірні категорії та/або пов'язані коди УКТЗЕД для цього вузла.
    """
    path = "dualuse" if not params.node_id else f"dualuse/{params.node_id}"
    return await _fetch_clean_text(path)


class ExchangeRateInput(BaseModel):
    """Вхідні дані для запиту офіційного курсу НБУ."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    currency: str = Field(
        ...,
        description="Літерний код валюти за ISO-4217 (напр. 'USD', 'EUR', 'CNY', 'INR')",
        min_length=3,
        max_length=3,
    )
    date: str = Field(
        default="",
        description="Дата у форматі YYYYMMDD (напр. '20260914'); порожньо — курс на сьогодні",
    )

    @field_validator("currency")
    @classmethod
    def upper_currency(cls, v: str) -> str:
        return v.upper()

    @field_validator("date")
    @classmethod
    def validate_date(cls, v: str) -> str:
        if v and not re.fullmatch(r"\d{8}", v):
            raise ValueError(f"Дата має бути у форматі YYYYMMDD, отримано: {v!r}")
        return v


NBU_EXCHANGE_URL = "https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange"


async def _nbu_rate(params: ExchangeRateInput) -> str:
    """Живий запит офіційного курсу НБУ (спільна логіка тулу і REST-ендпоінта)."""
    query = {"json": "", "valcode": params.currency}
    if params.date:
        query["date"] = params.date

    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        try:
            resp = await client.get(NBU_EXCHANGE_URL, params=query)
            resp.raise_for_status()
            data = resp.json()
        except httpx.HTTPStatusError as e:
            raise ValueError(f"Помилка запиту до НБУ: HTTP {e.response.status_code}") from e
        except httpx.TimeoutException as e:
            raise ValueError("Таймаут запиту до НБУ, спробуйте ще раз") from e

    if not data:
        raise ValueError(
            f"Курс для {params.currency} не знайдено — перевірте код валюти "
            f"(ISO-4217, напр. USD/EUR/CNY) або дату"
        )
    rate = data[0]
    return (
        f"1 {rate['cc']} ({rate['txt']}) = {rate['rate']} грн, "
        f"станом на {rate['exchangedate']} (джерело: НБУ)"
    )


@mcp.tool(
    name="get_exchange_rate",
    annotations={
        "title": "Офіційний курс НБУ",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def get_exchange_rate(params: ExchangeRateInput) -> str:
    """Отримати офіційний курс гривні НБУ до заданої валюти.

    Корисно для перерахунку вартості товару з валюти контракту (USD, EUR,
    CNY, INR тощо) в гривню на конкретну дату — наприклад для оцінки митної
    вартості або порівняння пропозицій постачальників з різних країн.

    Args:
        params (ExchangeRateInput): Код валюти (ISO-4217) і опціонально дата
            у форматі YYYYMMDD (без дати — курс на сьогодні).

    Returns:
        str: Курс у форматі "1 XXX = YY.YYYY грн (станом на DD.MM.YYYY)".
    """
    return await _nbu_rate(params)


class SubstanceIdentifyInput(BaseModel):
    """Вхідні дані для ідентифікації хімічної речовини через PubChem."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    identifier: str = Field(
        ...,
        description=(
            "Назва речовини, торгова назва/синонім, або CAS-номер "
            "(напр. 'aspirin' або '50-78-2') — PubChem шукає CAS-номери "
            "як синонім, окремого поля для них не потрібно"
        ),
        min_length=1,
        max_length=200,
    )


PUBCHEM_BASE = "https://pubchem.ncbi.nlm.nih.gov/rest/pug"
# Політика NCBI: не більше 5 запитів/сек з одного джерела — для одиничних
# викликів у діалозі це не проблема, але не варто заганяти цей тул у цикл
# без затримки, якщо колись знадобиться перевірити список речовин масово.
PUBCHEM_PROPERTIES = "IUPACName,MolecularFormula,MolecularWeight,CanonicalSMILES,InChIKey"


@mcp.tool(
    name="pubchem_identify_substance",
    annotations={
        "title": "Ідентифікація хімічної речовини (PubChem)",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def pubchem_identify_substance(params: SubstanceIdentifyInput) -> str:
    """Ідентифікувати хімічну речовину за назвою або CAS-номером через PubChem.

    Корисно, коли два постачальники називають одну й ту саму субстанцію
    різними торговими іменами — тул повертає канонічну IUPAC-назву,
    молекулярну формулу, молекулярну масу, InChIKey та перелік синонімів
    (включно з CAS-номерами), щоб звірити, чи це справді одна й та сама
    речовина, до підписання контракту.

    Args:
        params (SubstanceIdentifyInput): Назва, синонім або CAS-номер речовини.

    Returns:
        str: Структурні дані речовини та до 10 відомих синонімів
            (джерело: PubChem, National Library of Medicine, США).
    """
    return await _pubchem(params)


async def _pubchem(params: SubstanceIdentifyInput) -> str:
    """Живий запит PubChem (спільна логіка тулу і REST-ендпоінта)."""
    encoded = quote(params.identifier, safe="")
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        try:
            prop_resp = await client.get(
                f"{PUBCHEM_BASE}/compound/name/{encoded}/property/{PUBCHEM_PROPERTIES}/JSON"
            )
            prop_resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 404:
                raise ValueError(
                    f"Речовину '{params.identifier}' не знайдено в PubChem — "
                    f"перевірте написання назви чи CAS-номер"
                ) from e
            raise ValueError(f"Помилка запиту до PubChem: HTTP {e.response.status_code}") from e
        except httpx.TimeoutException as e:
            raise ValueError("Таймаут запиту до PubChem, спробуйте ще раз") from e

        props = prop_resp.json()["PropertyTable"]["Properties"][0]

        synonyms: list[str] = []
        try:
            syn_resp = await client.get(f"{PUBCHEM_BASE}/compound/name/{encoded}/synonyms/JSON")
            syn_resp.raise_for_status()
            synonyms = syn_resp.json()["InformationList"]["Information"][0]["Synonym"][:10]
        except (httpx.HTTPStatusError, httpx.TimeoutException, KeyError, IndexError):
            pass  # синоніми не критичні — основні властивості вже отримані

    lines = [
        f"CID (PubChem ID): {props['CID']}",
        f"IUPAC-назва: {props.get('IUPACName', '—')}",
        f"Молекулярна формула: {props.get('MolecularFormula', '—')}",
        f"Молекулярна маса: {props.get('MolecularWeight', '—')}",
        f"InChIKey: {props.get('InChIKey', '—')}",
    ]
    if synonyms:
        lines.append("Синоніми (перші 10): " + ", ".join(synonyms))
    return "\n".join(lines)


class DrlzLookupInput(BaseModel):
    """Вхідні дані для пошуку в локальному кеші реєстру лікарських засобів."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    query: str = Field(
        ...,
        description="Назва препарату, діюча речовина або власник РП (пошук підрядком, без урахування регістру)",
        min_length=2,
        max_length=200,
    )
    limit: int = Field(default=15, description="Максимум результатів", ge=1, le=100)


DRLZ_CACHE_PATH = os.environ.get("DRLZ_CACHE_PATH", "drlz_cache.json")


@mcp.tool(
    name="drlz_lookup_registration",
    annotations={
        "title": "Пошук у Державному реєстрі лікарських засобів (кеш)",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False,
    },
)
async def drlz_lookup_registration(params: DrlzLookupInput) -> str:
    """Перевірити реєстрацію лікарського засобу в Україні по локальному кешу.

    Кеш будується окремим скриптом drlz_build_cache.py (запускається за
    розкладом, напр. раз на тиждень) з drlz.info — офіційної заміни
    застарілого www.drlz.com.ua, чия форма пошуку не працює, а CSV-експорт
    не оновлювався з 2021 року. Цей тул НЕ ходить у мережу — шукає підрядком
    по назві, діючій речовині чи власнику РП у вже збудованому файлі.

    Args:
        params (DrlzLookupInput): Пошуковий запит і ліміт результатів.

    Returns:
        str: Знайдені записи (№ РП, назва, дата закінчення реєстрації,
            діючі речовини, виробник, власник) або повідомлення про
            відсутність кешу з інструкцією, як його побудувати.
    """
    if not os.path.exists(DRLZ_CACHE_PATH):
        return (
            f"Локальний кеш реєстру не знайдено ({DRLZ_CACHE_PATH}). "
            f"Побудуйте його: python drlz_build_cache.py --out {DRLZ_CACHE_PATH}"
        )

    with open(DRLZ_CACHE_PATH, "r", encoding="utf-8") as f:
        cache = json.load(f)

    query_lower = params.query.lower()
    matches = [
        r
        for r in cache["records"]
        if query_lower in r.get("name", "").lower()
        or query_lower in r.get("active_substances", "").lower()
        or query_lower in r.get("reg_holder", "").lower()
    ][: params.limit]

    if not matches:
        return (
            f"Нічого не знайдено за запитом '{params.query}' у кеші "
            f"({cache['count']} записів, станом на {cache['fetched_at']})"
        )

    lines = [
        f"Знайдено {len(matches)} (з кешу на {cache['fetched_at']}, джерело: drlz.info):"
    ]
    for r in matches:
        lines.append(
            f"- {r.get('name', '—')} | № РП {r.get('reg_number', '—')} | "
            f"до {r.get('reg_end_date', '—')} | {r.get('active_substances', '—')} | "
            f"власник: {r.get('reg_holder', '—')}"
        )
    return "\n".join(lines)


# ─────────────────────────────────────────────────────────────────────────────
# Plain-REST surface (Starlette). The TS backend (Штурман) calls these simple
# JSON endpoints internally over the compose network — no MCP session handshake,
# minimal TS deps (just fetch). The @mcp.tool definitions above still register the
# same logic for stdio-MCP use (python logist_mcp.py, e.g. MCP Inspector). REST
# handlers reuse the shared helpers so both paths stay in sync.
#
# Domain problems (bad input, upstream 404/timeout) return HTTP 400 with
# {"error": "..."} so the caller gets a clean message; unexpected errors → 500.
# ─────────────────────────────────────────────────────────────────────────────


def _first_err(e: ValidationError) -> str:
    try:
        return e.errors()[0].get("msg", "Некоректні вхідні дані")
    except Exception:
        return "Некоректні вхідні дані"


def _json_err(msg: str, status: int = 400) -> JSONResponse:
    return JSONResponse({"error": msg}, status_code=status)


async def _health(request: Request) -> JSONResponse:
    return JSONResponse({"ok": True, "service": "logist_mcp"})


async def _rest_uktzed_lookup(request: Request) -> JSONResponse:
    try:
        params = LookupCodeInput(code=request.query_params.get("code", ""))
    except ValidationError as e:
        return _json_err(_first_err(e))
    try:
        soup = await _fetch_soup(f"goodinfo/{params.code}")
    except ValueError as e:
        return _json_err(str(e))
    # Split the page by customs regime (ІМПОРТ / ЕКСПОРТ / ТРАНЗИТ tabs) + a
    # `common` header. Each section is returned in full (safety-bounded); the TS
    # backend digests each one in batches (its side owns the Anthropic key), so no
    # whole comment/regime is truncated away.
    common, tabs = _extract_goodinfo(soup)
    return JSONResponse(
        {
            "code": params.code,
            "common": _cap(common, 40000),
            "tabs": [{"label": t["label"], "text": _cap(t["text"], 40000)} for t in tabs],
            "source": f"{BASE_URL}/goodinfo/{params.code}",
        }
    )


async def _rest_uktzed_browse(request: Request) -> JSONResponse:
    try:
        params = BrowseClassifierInput(code=request.query_params.get("code", ""))
    except ValidationError as e:
        return _json_err(_first_err(e))
    path = "uktzed" if not params.code else f"uktzed/{params.code}"
    try:
        soup = await _fetch_soup(path)
    except ValueError as e:
        return _json_err(str(e))
    text, links = _clean_text_and_links(soup, "uktzed", 4000)
    return JSONResponse({"code": params.code, "text": text, "links": links, "source": f"{BASE_URL}/{path}"})


async def _rest_dualuse(request: Request) -> JSONResponse:
    try:
        params = DualUseBrowseInput(node_id=request.query_params.get("node_id", ""))
    except ValidationError as e:
        return _json_err(_first_err(e))
    path = "dualuse" if not params.node_id else f"dualuse/{params.node_id}"
    try:
        soup = await _fetch_soup(path)
    except ValueError as e:
        return _json_err(str(e))
    text, links = _clean_text_and_links(soup, "dualuse", 4000)
    return JSONResponse(
        {"node_id": params.node_id, "text": text, "links": links, "source": f"{BASE_URL}/{path}"}
    )


_PCT_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*%")


def _rate_after(text: str, label: str, window: int = 60) -> str:
    """First percentage that follows `label` within `window` chars (else '')."""
    i = text.find(label)
    if i == -1:
        return ""
    m = _PCT_RE.search(text[i : i + window])
    return f"{m.group(1).replace(',', '.')}%" if m else ""


def _import_flags(text: str) -> dict:
    """Deterministic restriction flags for the ІМПОРТ regime (keyword presence)."""
    low = text.lower()
    return {
        "ban_rf": "заборон" in low and ("росій" in low or "426" in text),
        "license": "ліценз" in low,
        "vet_control": "ветеринар" in low,
        "phyto": "фітосанітар" in low,
        "dual_use": "подвійн" in low and "використанн" in low,
        "narcotic": "наркотич" in low or "прекурсор" in low,
    }


async def _rest_uktzed_flags(request: Request) -> JSONResponse:
    """Lightweight, DETERMINISTIC per-code enrichment for the consolidated-analysis
    engine (no LLM): import-regime duty rates + restriction flags parsed straight
    from the goodinfo ІМПОРТ tab. Fast enough to run per manifest line."""
    try:
        params = LookupCodeInput(code=request.query_params.get("code", ""))
    except ValidationError as e:
        return _json_err(_first_err(e))
    try:
        soup = await _fetch_soup(f"goodinfo/{params.code}")
    except ValueError as e:
        return _json_err(str(e))
    common, tabs = _extract_goodinfo(soup)
    imp = ""
    for t in tabs:
        if t["label"].strip().upper().startswith("ІМПОРТ"):
            imp = t["text"]
            break
    if not imp:
        imp = tabs[0]["text"] if tabs else common
    return JSONResponse(
        {
            "code": params.code,
            "duty_pref": _rate_after(imp, "Пільгова ставка"),
            "duty_full": _rate_after(imp, "Повна ставка"),
            "flags": _import_flags(imp),
            "source": f"{BASE_URL}/goodinfo/{params.code}",
        }
    )


async def _rest_rate(request: Request) -> JSONResponse:
    try:
        params = ExchangeRateInput(
            currency=request.query_params.get("currency", ""),
            date=request.query_params.get("date", ""),
        )
    except ValidationError as e:
        return _json_err(_first_err(e))
    try:
        text = await _nbu_rate(params)
    except ValueError as e:
        return _json_err(str(e))
    return JSONResponse({"currency": params.currency, "date": params.date, "text": text})


async def _rest_pubchem(request: Request) -> JSONResponse:
    try:
        params = SubstanceIdentifyInput(identifier=request.query_params.get("identifier", ""))
    except ValidationError as e:
        return _json_err(_first_err(e))
    try:
        text = await _pubchem(params)
    except ValueError as e:
        return _json_err(str(e))
    return JSONResponse({"identifier": params.identifier, "text": text})


def build_rest_app() -> Starlette:
    return Starlette(
        routes=[
            Route("/health", _health, methods=["GET"]),
            Route("/rest/uktzed/lookup", _rest_uktzed_lookup, methods=["GET"]),
            Route("/rest/uktzed/flags", _rest_uktzed_flags, methods=["GET"]),
            Route("/rest/uktzed/browse", _rest_uktzed_browse, methods=["GET"]),
            Route("/rest/dualuse", _rest_dualuse, methods=["GET"]),
            Route("/rest/rate", _rest_rate, methods=["GET"]),
            Route("/rest/pubchem", _rest_pubchem, methods=["GET"]),
        ]
    )


if __name__ == "__main__":
    if "--http" in sys.argv:
        port = 8015
        if "--port" in sys.argv:
            port = int(sys.argv[sys.argv.index("--port") + 1])
        import uvicorn

        host = os.environ.get("FASTMCP_HOST", "0.0.0.0")
        uvicorn.run(build_rest_app(), host=host, port=port)
    else:
        # stdio MCP transport (MCP Inspector / native connector use).
        mcp.run()
