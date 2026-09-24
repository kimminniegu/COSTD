"""Home 데이터 모듈 (담당자 A) — 명세: src/01_home/home.md 4~9장

환율(수출입은행) · 화장품 수출입(관세청) · 화장품 뉴스(6개 출처) · 규제 업데이트(구글 뉴스 RSS / KOTRA)를
수집해 SQLite(instance/cosmoa.db)에 저장하고, 홈 화면에 필요한 형태로 돌려줍니다.

- 외부 호출은 캐시가 오래됐을 때만 백그라운드 스레드에서 실행합니다. (홈 접속 시 확인 방식, 6-4 / 8-3)
- 한 출처가 실패해도 나머지는 계속 진행하고, 전체 실패 시 직전 저장값을 그대로 보여줍니다. (5-6 / 6-7 / 8-6)
- API Key는 환경변수에서만 읽습니다: EXIM_API_KEY, DATA_GO_KR_KEY
"""

from __future__ import annotations

import calendar
import difflib
import importlib
import json
import logging
import os
import re
import sqlite3
import threading
import time
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import unquote, urljoin
from zoneinfo import ZoneInfo

import feedparser
import requests
from bs4 import BeautifulSoup

log = logging.getLogger("cosmoa.home")

KST = ZoneInfo("Asia/Seoul")
HEADERS = {"User-Agent": "COSMOA-news-bot (school project; contact: costd)"}
TIMEOUT = 10

# 갱신 주기 (초)
NEWS_TTL = 6 * 3600          # 6-4
REG_TTL = 1 * 3600           # 8-3
TRADE_TTL = 24 * 3600        # 5-4
RATE_MAX_LOOKBACK_DAYS = 7   # 4-3

NEWS_LIMIT = 12              # 서버가 홈에 보내는 뉴스 건수 (2-7)
NEWS_PER_SOURCE = 3          # 출처당 최대 건수 (6-3)
REG_LIMIT = 8                # 규제 소식 건수 (8-6)

# ---------------------------------------------------------------------------
# DB
# ---------------------------------------------------------------------------
_DB_PATH: Path | None = None
_lock = threading.Lock()
_refreshing: set[str] = set()


def init(db_path: Path) -> None:
    """app.py에서 한 번 호출. 테이블을 만들어 둡니다."""
    global _DB_PATH
    _DB_PATH = db_path
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with _conn() as c:
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS exchange_rates (
                date TEXT, code TEXT, name TEXT, unit INTEGER, rate REAL,
                PRIMARY KEY (date, code)
            );
            CREATE TABLE IF NOT EXISTS trade_stats (
                yymm TEXT, hs_code TEXT, country TEXT, country_name TEXT,
                exp_usd REAL, imp_usd REAL, balance REAL, fetched_at TEXT,
                PRIMARY KEY (yymm, hs_code, country)
            );
            CREATE TABLE IF NOT EXISTS news_items (
                url TEXT PRIMARY KEY, source TEXT, title TEXT,
                published_at TEXT, fetched_at TEXT
            );
            CREATE TABLE IF NOT EXISTS regulation_items (
                url TEXT PRIMARY KEY, country TEXT, title TEXT, source TEXT,
                published_at TEXT, fetched_at TEXT
            );
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
            """
        )


def _conn() -> sqlite3.Connection:
    assert _DB_PATH is not None, "home_data.init()를 먼저 호출하세요"
    c = sqlite3.connect(_DB_PATH, timeout=10, check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c


def _meta_get(key: str) -> str | None:
    with _conn() as c:
        row = c.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row["value"] if row else None


def _meta_set(key: str, value: str) -> None:
    with _conn() as c:
        c.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", (key, value))


def _now() -> datetime:
    return datetime.now(KST)


def _iso(dt: datetime | None) -> str | None:
    return dt.astimezone(KST).replace(microsecond=0).isoformat() if dt else None


def _parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s)
        return dt if dt.tzinfo else dt.replace(tzinfo=KST)
    except ValueError:
        return None


def _is_stale(key: str, ttl: int) -> bool:
    last = _parse_iso(_meta_get(key))
    return last is None or (_now() - last).total_seconds() > ttl


def _to_float(s) -> float | None:
    if s is None:
        return None
    try:
        return float(str(s).replace(",", "").strip())
    except ValueError:
        return None


def _struct_to_dt(st) -> datetime | None:
    """feedparser의 published_parsed(UTC struct_time) → KST datetime"""
    if not st:
        return None
    try:
        return datetime.fromtimestamp(calendar.timegm(st), tz=timezone.utc).astimezone(KST)
    except (OverflowError, ValueError, TypeError):
        return None


NAIVE_DT_RE = re.compile(r"^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$")


def _entry_dt(entry) -> datetime | None:
    """RSS 항목의 게시 시각.
    장업신문처럼 시간대 없이 '2026-09-22 13:07:33'로 오는 값은 한국 시각으로 보고,
    구글 뉴스처럼 GMT 가 붙은 값은 feedparser 가 UTC 로 파싱한 struct 를 변환합니다."""
    raw = (entry.get("published") or entry.get("updated") or "").strip()
    if NAIVE_DT_RE.match(raw):
        try:
            return datetime.fromisoformat(raw.replace(" ", "T")).replace(tzinfo=KST)
        except ValueError:
            pass
    return _struct_to_dt(entry.get("published_parsed") or entry.get("updated_parsed"))


def relative_time(dt: datetime | None) -> str:
    """'3시간 전' 형식. 하루가 넘으면 날짜 (6-3)"""
    if not dt:
        return ""
    diff = (_now() - dt).total_seconds()
    if diff < 60:
        return "방금 전"
    if diff < 3600:
        return f"{int(diff // 60)}분 전"
    if diff < 86400:
        return f"{int(diff // 3600)}시간 전"
    return dt.strftime("%m월 %d일").lstrip("0").replace(" 0", " ")


# ---------------------------------------------------------------------------
# 4. 환율 — 한국수출입은행 현재환율 API
# ---------------------------------------------------------------------------
EXIM_URL = os.getenv("EXIM_API_URL", "https://oapi.koreaexim.go.kr/site/program/financial/exchangeJSON")
# 표시 순서. 앞에서부터 6개를 채우며, 응답에 없는 통화(VND 등)는 건너뜁니다. (4-2, 10장)
RATE_CODES = ["USD", "JPY(100)", "CNH", "EUR", "THB", "VND", "SGD", "MYR"]
RATE_DISPLAY = 6
RATE_WARN_PCT = 10.0   # 전일 대비 이 % 이상 움직이면 이상값으로 표시 (명세 13-1)


def _exim_fetch(day: date) -> list[dict] | None:
    key = os.getenv("EXIM_API_KEY")
    if not key:
        return None
    res = requests.get(
        EXIM_URL,
        params={"authkey": key, "searchdate": day.strftime("%Y%m%d"), "data": "AP01"},
        headers=HEADERS,
        timeout=TIMEOUT,
    )
    res.raise_for_status()
    data = res.json()
    if not isinstance(data, list) or not data:
        return []
    if data[0].get("result") not in (1, None):
        raise RuntimeError(f"EXIM result={data[0].get('result')}")
    rows = []
    for d in data:
        code = d.get("cur_unit", "")
        rate = _to_float(d.get("deal_bas_r"))
        if not code or rate is None:
            continue
        unit = 100 if "(100)" in code else 1
        rows.append({"code": code, "name": d.get("cur_nm", ""), "unit": unit, "rate": rate})
    return rows


def _rates_for(day: date) -> list[dict]:
    with _conn() as c:
        rows = c.execute("SELECT * FROM exchange_rates WHERE date=?", (day.isoformat(),)).fetchall()
    return [dict(r) for r in rows]


def _ensure_rates(day: date) -> list[dict]:
    """해당 날짜 환율을 DB에서 찾고, 없으면 API로 가져와 저장. 휴일이면 [] 반환."""
    rows = _rates_for(day)
    if rows:
        return rows
    fetched = _exim_fetch(day)
    if fetched is None:
        return []
    with _conn() as c:
        if fetched:
            c.executemany(
                "INSERT OR REPLACE INTO exchange_rates (date, code, name, unit, rate) VALUES (?,?,?,?,?)",
                [(day.isoformat(), r["code"], r["name"], r["unit"], r["rate"]) for r in fetched],
            )
        else:
            # 휴일 표시: 다음번에 다시 호출하지 않도록 빈 표식을 남깁니다.
            c.execute(
                "INSERT OR REPLACE INTO exchange_rates (date, code, name, unit, rate) VALUES (?,?,?,?,?)",
                (day.isoformat(), "__EMPTY__", "", 0, 0),
            )
    return fetched


def _latest_two_rate_days() -> tuple[tuple[date, list[dict]] | None, tuple[date, list[dict]] | None]:
    """최근 영업일과 그 직전 영업일의 환율 (4-3). 하루씩 거슬러 최대 7 + 7일."""
    found: list[tuple[date, list[dict]]] = []
    day = _now().date()
    for _ in range(RATE_MAX_LOOKBACK_DAYS * 2):
        rows = [r for r in _ensure_rates(day) if r["code"] != "__EMPTY__"]
        if rows:
            found.append((day, rows))
            if len(found) == 2:
                break
        day -= timedelta(days=1)
    return (found[0] if found else None, found[1] if len(found) > 1 else None)


def refresh_rates() -> None:
    today = _now().date().isoformat()
    if _meta_get("rates_checked_date") == today and _rates_for(_now().date()):
        return
    try:
        latest, prev = _latest_two_rate_days()
        if latest:
            _meta_set("rates_latest_date", latest[0].isoformat())
            _meta_set("rates_prev_date", prev[0].isoformat() if prev else "")
            # 오늘 값이 아직 안 올라온 이른 시간이면 오늘 다시 확인할 수 있게 체크 날짜를 남기지 않습니다.
            if latest[0].isoformat() == today or _now().hour >= 12:
                _meta_set("rates_checked_date", today)
        log.info("환율 갱신: %s", latest[0] if latest else None)
    except Exception as err:  # noqa: BLE001 — 실패해도 홈은 떠야 함
        log.warning("환율 조회 실패: %s", err)
    finally:
        _meta_set("rates_last_try", _iso(_now()))


def get_rates() -> dict:
    latest_date = _meta_get("rates_latest_date")
    if not latest_date:
        return {"items": [], "date": None, "error": "환율 정보를 불러오지 못했어요"}
    latest = {r["code"]: r for r in _rates_for(date.fromisoformat(latest_date))}
    prev_date = _meta_get("rates_prev_date")
    prev = {r["code"]: r for r in _rates_for(date.fromisoformat(prev_date))} if prev_date else {}
    items = []
    for code in RATE_CODES:
        r = latest.get(code)
        if not r:
            continue
        p = prev.get(code)
        change = ((r["rate"] - p["rate"]) / p["rate"] * 100) if p and p["rate"] else None
        warning = change is not None and abs(change) >= RATE_WARN_PCT
        if warning:
            log.warning("환율 이상값: %s 전일 대비 %.2f%% (%s → %s)", code, change, p["rate"], r["rate"])
        items.append({
            "code": code.replace("(100)", ""),
            "unit": r["unit"],
            "name": r["name"],
            "rate": r["rate"],
            "rate_text": f"{r['rate']:,.2f}",
            "change": change,
            "change_text": (f"{abs(change):.2f}%" if change is not None else "—"),
            "direction": "up" if (change or 0) > 0 else ("down" if (change or 0) < 0 else "flat"),
            "warning": warning,   # 전일 대비 RATE_WARN_PCT 이상 변동 → 화면에 경고 표시
        })
        if len(items) == RATE_DISPLAY:
            break
    d = date.fromisoformat(latest_date)
    return {"items": items, "date": latest_date, "date_text": f"{d.month}/{d.day}", "error": None}


# ---------------------------------------------------------------------------
# 5. 화장품 수출입 — 관세청 품목별 국가별 수출입실적 (공공데이터포털)
# ---------------------------------------------------------------------------
TRADE_URL = os.getenv("TRADE_API_URL", "https://apis.data.go.kr/1220000/nitemtrade/getNitemtradeList")
HS_CODES = list(dict.fromkeys(c.strip() for c in os.getenv("COSMETIC_HS_CODES", "3304").split(",") if c.strip()))  # 5-3 (중복 제거)
home_trade = importlib.import_module("src.01_home.home_trade")   # pandas 분석 (홈 왼쪽 카드 3개)


def _data_go_kr_key() -> str | None:
    key = os.getenv("DATA_GO_KR_KEY")
    if not key:
        return None
    # 포털이 주는 Encoding 키를 그대로 넣으면 이중 인코딩되므로 Decoding 키로 맞춥니다.
    return unquote(key) if "%" in key else key


def _trade_fetch(start_yymm: str, end_yymm: str, hs_code: str) -> list[dict]:
    key = _data_go_kr_key()
    if not key:
        return []
    res = requests.get(
        TRADE_URL,
        params={"serviceKey": key, "strtYymm": start_yymm, "endYymm": end_yymm, "hsSgn": hs_code},
        headers=HEADERS,
        timeout=20,
    )
    res.raise_for_status()
    root = ET.fromstring(res.content)
    code = root.findtext(".//resultCode")
    if code not in (None, "00", "0"):
        raise RuntimeError(f"관세청 API resultCode={code} {root.findtext('.//resultMsg')}")
    rows = []
    for item in root.iter("item"):
        period = (item.findtext("year") or "").strip()          # 예: "2026.08" / "총계"
        yymm = period.replace(".", "").replace("-", "")
        if not yymm.isdigit() or len(yymm) != 6:
            continue
        country = (item.findtext("statCd") or "").strip()
        hs6 = (item.findtext("hsCd") or "").strip()                 # 응답은 HS 6단위(예: 330499)로 옴
        rows.append({
            "yymm": yymm,
            "hs_code": hs6 if hs6.isdigit() else hs_code,
            "country": country or "",
            "country_name": (item.findtext("statCdCntnKor1") or "").strip(),
            "exp_usd": _to_float(item.findtext("expDlr")) or 0.0,
            "imp_usd": _to_float(item.findtext("impDlr")) or 0.0,
            "balance": _to_float(item.findtext("balPayments")) or 0.0,
        })
    return rows


def refresh_trade() -> None:
    if not _is_stale("trade_fetched_at", TRADE_TTL):
        return
    now = _now()
    # 관세청 API는 조회 기간이 12개월 이내여야 함(resultCode 99) → 최근 12개월 + 그 앞 12개월, 두 번 나눠 조회
    first = now.replace(day=1)
    def _ym(months_back: int) -> str:
        y, m = first.year, first.month - months_back
        while m <= 0:
            y, m = y - 1, m + 12
        return f"{y}{m:02d}"
    windows = [(_ym(11), _ym(0)), (_ym(23), _ym(12)), (_ym(26), _ym(24))]   # 전년 동기간 비교용으로 약 27개월
    ok = False
    for hs in HS_CODES:
        rows = []
        for start, end in windows:
            try:
                rows += _trade_fetch(start, end, hs)
            except Exception as err:  # noqa: BLE001
                log.warning("수출입 조회 실패(%s %s~%s): %s", hs, start, end, err)
        if not rows:
            continue
        with _conn() as c:
            c.executemany(
                "INSERT OR REPLACE INTO trade_stats (yymm, hs_code, country, country_name, exp_usd, imp_usd, balance, fetched_at)"
                " VALUES (?,?,?,?,?,?,?,?)",
                [(r["yymm"], r["hs_code"], r["country"], r["country_name"], r["exp_usd"], r["imp_usd"], r["balance"], _iso(now))
                 for r in rows],
            )
        ok = True
    if ok:
        _meta_set("trade_fetched_at", _iso(now))
    _meta_set("trade_last_try", _iso(now))


def _trade_monthly_totals() -> dict[str, dict]:
    """월별 전체 합계 {yymm: {exp, imp, bal}} — 국가 코드가 빈 '전체' 행이 있으면 그것을, 없으면 국가별 합산."""
    with _conn() as c:
        rows = [dict(r) for r in c.execute("SELECT * FROM trade_stats")]
    totals: dict[str, dict] = {}
    total_rows = [r for r in rows if r["country"] == ""]
    src = total_rows if total_rows else [r for r in rows if r["country"]]
    for r in src:
        t = totals.setdefault(r["yymm"], {"exp": 0.0, "imp": 0.0, "bal": 0.0})
        t["exp"] += r["exp_usd"]
        t["imp"] += r["imp_usd"]
        t["bal"] += r["balance"]
    return totals


def get_trade() -> dict:
    totals = _trade_monthly_totals()
    if not totals:
        return {"ok": False, "message": "수출 실적을 불러오지 못했어요", "kstat_url": "https://stat.kita.net/"}
    latest = max(totals)
    prev_year = f"{int(latest[:4]) - 1}{latest[4:]}"
    cur, py = totals[latest], totals.get(prev_year)
    change = ((cur["exp"] - py["exp"]) / py["exp"] * 100) if py and py["exp"] else None
    m = int(latest[4:])
    return {
        "ok": True,
        "yymm": latest,
        "month_text": f"{m}월",
        "exp_musd": f"{cur['exp'] / 1e6:,.1f}",
        "imp_musd": f"{cur['imp'] / 1e6:,.1f}",
        "bal_musd": f"{cur['bal'] / 1e6:,.1f}",
        "change": change,
        "change_text": f"{abs(change):.1f}%" if change is not None else "—",
        "direction": "up" if (change or 0) > 0 else ("down" if (change or 0) < 0 else "flat"),
        "hs_codes": HS_CODES,
        "kstat_url": "https://stat.kita.net/",
    }


def get_trade_cards() -> dict:
    """홈 왼쪽 카드 3개 (pandas 결측치 처리 → home_trade.build_cards)"""
    try:
        with _conn() as c:
            rows = [dict(r) for r in c.execute("SELECT yymm, hs_code, country, country_name, exp_usd, imp_usd, balance FROM trade_stats")]
        return home_trade.build_cards(rows, HS_CODES)
    except Exception as err:  # noqa: BLE001
        log.warning("수출입 분석 실패: %s", err)
        return {"ok": False, "message": "수출입 실적을 분석하지 못했어요", "kstat_url": "https://stat.kita.net/"}


# ---------------------------------------------------------------------------
# 7. 바이어 현지 시각 — 국가·도시·시간대 목록 (7-4) 과 수출 상위국 (7-2)
# ---------------------------------------------------------------------------
CITY_MAP: dict[str, dict] = {
    "CN": {"country": "중국", "name": "베이징", "tz": "Asia/Shanghai", "alt": []},
    "US": {"country": "미국", "name": "뉴욕", "tz": "America/New_York", "alt": [{"name": "로스앤젤레스", "tz": "America/Los_Angeles"}]},
    "JP": {"country": "일본", "name": "도쿄", "tz": "Asia/Tokyo", "alt": []},
    "HK": {"country": "홍콩", "name": "홍콩", "tz": "Asia/Hong_Kong", "alt": []},
    "VN": {"country": "베트남", "name": "호찌민", "tz": "Asia/Ho_Chi_Minh", "alt": []},
    "RU": {"country": "러시아", "name": "모스크바", "tz": "Europe/Moscow", "alt": []},
    "TW": {"country": "대만", "name": "타이베이", "tz": "Asia/Taipei", "alt": []},
    "TH": {"country": "태국", "name": "방콕", "tz": "Asia/Bangkok", "alt": []},
    "SG": {"country": "싱가포르", "name": "싱가포르", "tz": "Asia/Singapore", "alt": []},
    "ID": {"country": "인도네시아", "name": "자카르타", "tz": "Asia/Jakarta", "alt": []},
    "MY": {"country": "말레이시아", "name": "쿠알라룸푸르", "tz": "Asia/Kuala_Lumpur", "alt": []},
    "PH": {"country": "필리핀", "name": "마닐라", "tz": "Asia/Manila", "alt": []},
    "CA": {"country": "캐나다", "name": "토론토", "tz": "America/Toronto", "alt": [{"name": "밴쿠버", "tz": "America/Vancouver"}]},
    "GB": {"country": "영국", "name": "런던", "tz": "Europe/London", "alt": []},
    "FR": {"country": "프랑스", "name": "파리", "tz": "Europe/Paris", "alt": []},
    "DE": {"country": "독일", "name": "베를린", "tz": "Europe/Berlin", "alt": []},
    "PL": {"country": "폴란드", "name": "바르샤바", "tz": "Europe/Warsaw", "alt": []},
    "AE": {"country": "아랍에미리트", "name": "두바이", "tz": "Asia/Dubai", "alt": []},
    "SA": {"country": "사우디아라비아", "name": "리야드", "tz": "Asia/Riyadh", "alt": []},
    "AU": {"country": "호주", "name": "시드니", "tz": "Australia/Sydney", "alt": [{"name": "퍼스", "tz": "Australia/Perth"}]},
}
DEFAULT_TOP_COUNTRIES = ["CN", "US", "JP", "VN"]  # 데이터가 없을 때 (7-2)


def _tz_offset_key(tz: str) -> int:
    """한국과의 시차(분). 같은 시차인 시간대를 하나로 묶기 위한 값 (9-3)"""
    now = datetime.now(timezone.utc)
    return int((now.astimezone(ZoneInfo(tz)).utcoffset() - now.astimezone(KST).utcoffset()).total_seconds() // 60)


def city_options() -> list[dict]:
    """'내가 선택' 편집 창에 쓰는 전체 도시 목록"""
    out = []
    for code, c in CITY_MAP.items():
        out.append({"code": code, "country": c["country"], "name": c["name"], "tz": c["tz"]})
        for a in c["alt"]:
            out.append({"code": code, "country": c["country"], "name": a["name"], "tz": a["tz"]})
    return out


def top_export_cities(n: int = 4) -> list[dict]:
    """최근 12개월 누계 수출액 상위 국가의 대표 도시. 같은 시차는 건너뜀 (7-2)"""
    with _conn() as c:
        rows = [dict(r) for r in c.execute("SELECT * FROM trade_stats WHERE country != ''")]
    ranked: list[str]
    if rows:
        months = sorted({r["yymm"] for r in rows})[-12:]
        sums: dict[str, float] = {}
        for r in rows:
            if r["yymm"] in months:
                sums[r["country"]] = sums.get(r["country"], 0.0) + r["exp_usd"]
        ranked = [k for k, _ in sorted(sums.items(), key=lambda kv: kv[1], reverse=True)]
    else:
        ranked = DEFAULT_TOP_COUNTRIES
    picked, used = [], set()
    for code in ranked:
        city = CITY_MAP.get(code)
        if not city:
            if rows:
                log.info("시간대 목록에 없는 수출 상위국: %s", code)
            continue
        key = _tz_offset_key(city["tz"])
        if key in used:
            continue
        used.add(key)
        picked.append({"rank": len(picked) + 1, "code": code, "country": city["country"], "name": city["name"], "tz": city["tz"]})
        if len(picked) == n:
            break
    if len(picked) < n and ranked is not DEFAULT_TOP_COUNTRIES:  # 데이터가 부족하면 기본 목록으로 채움
        for code in DEFAULT_TOP_COUNTRIES:
            if any(p["code"] == code for p in picked):
                continue
            city = CITY_MAP[code]
            key = _tz_offset_key(city["tz"])
            if key in used:
                continue
            used.add(key)
            picked.append({"rank": len(picked) + 1, "code": code, "country": city["country"], "name": city["name"], "tz": city["tz"]})
            if len(picked) == n:
                break
    return picked


# ---------------------------------------------------------------------------
# 6. 화장품 최신 뉴스
# ---------------------------------------------------------------------------
JANGUP_RSS = os.getenv("JANGUP_RSS_URL", "https://www.jangup.com/rss/allArticle.xml")
BEAUTYNURY_RSS = "https://news.google.com/rss/search?q=site:beautynury.com&hl=ko&gl=KR&ceid=KR:ko"
MFDS_RSS_URLS = ["https://www.mfds.go.kr/www/rss/brd.do?brdId=ntc0021", "http://www.mfds.go.kr/www/rss/brd.do?brdId=ntc0021"]
MFDS_WORDS = ["화장품", "기능성화장품", "자외선차단", "맞춤형화장품"]
DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}")
OFFICIAL_SOURCES = {"식약처"}


def _feed(url_or_bytes):
    return feedparser.parse(url_or_bytes)


def fetch_jangup() -> list[dict]:
    res = requests.get(JANGUP_RSS, headers=HEADERS, timeout=TIMEOUT)
    res.raise_for_status()
    feed = _feed(res.content)
    return [{"source": "장업신문", "title": e.title, "url": e.link, "published": _entry_dt(e)}
            for e in feed.entries if e.get("title") and e.get("link")]


def fetch_cmn() -> list[dict]:
    res = requests.get("https://www.cmn.co.kr/main/", headers=HEADERS, timeout=TIMEOUT)
    res.raise_for_status()
    soup = BeautifulSoup(res.text, "html.parser")
    items, seen = [], set()
    for a in soup.select('a[href*="news_view.asp?news_idx="]'):
        title = a.get_text(" ", strip=True)
        url = urljoin("https://www.cmn.co.kr", a["href"]).split("&")[0]
        if not title or len(title) < 8 or len(title) > 90 or url in seen:  # 요약문·빈 링크 제외
            continue
        seen.add(url)
        items.append({"source": "CMN", "title": title, "url": url, "published": None})
    return items


def fetch_beautynury() -> list[dict]:
    res = requests.get(BEAUTYNURY_RSS, headers=HEADERS, timeout=TIMEOUT)
    res.raise_for_status()
    feed = _feed(res.content)
    items = []
    for e in feed.entries:
        if not (e.get("title") and e.get("link")):
            continue
        title = e.title.rsplit(" - ", 1)[0]          # 구글 뉴스가 붙이는 " - 매체명" 제거
        title = title.split(" :: ", 1)[-1].strip()   # "화장품신문 (Beautynury.com) :: 제목" 형태 정리
        items.append({"source": "뷰티누리", "title": title, "url": e.link, "published": _entry_dt(e)})
    return items


def fetch_mediaon(source: str, base: str) -> list[dict]:
    """코스인코리아닷컴 · 코스모닝 공통 (같은 목록 구조)
    한 기사에 썸네일 링크와 본문 링크가 따로 있어, 같은 URL 의 앵커를 합쳐 제목·시각을 취합니다."""
    res = requests.get(base + "/news/article_list_all.html", headers=HEADERS, timeout=TIMEOUT)
    res.raise_for_status()
    soup = BeautifulSoup(res.text, "html.parser")
    found: dict[str, dict] = {}
    for a in soup.select('a[href*="/news/article.html?no="]'):
        url = urljoin(base, a["href"])
        item = found.setdefault(url, {"source": source, "title": "", "url": url, "published": None})
        text = a.get_text(" ", strip=True)
        if not item["title"]:
            # 목록 구조: a > img / h2(제목) / p.ffd(요약) / ul.art_info > li.name(기자) + li.date(시각)
            el = a.select_one("h2, h3, .title, .tit, strong, b")
            title = el.get_text(" ", strip=True) if el else text[:120]
            item["title"] = re.sub(r"^\d{1,2}\s+", "", title)  # 목록 순번("1 ", "2 ") 제거
        if item["published"] is None:
            m = DATE_RE.search(text)
            if m:
                item["published"] = datetime.strptime(m.group(), "%Y-%m-%d %H:%M").replace(tzinfo=KST)
    # 전체기사 목록은 항상 시각이 있으므로, 시각이 없는 앵커(인기기사 등 옆 위젯)는 제외합니다.
    return [it for it in found.values() if it["title"] and it["published"]]


def fetch_cosinkorea() -> list[dict]:
    return fetch_mediaon("코스인", "https://www.cosinkorea.com")


def fetch_cosmorning() -> list[dict]:
    return fetch_mediaon("코스모닝", "https://www.cosmorning.com")


def fetch_mfds() -> list[dict]:
    last_err: Exception | None = None
    for url in MFDS_RSS_URLS:
        try:
            res = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
            res.raise_for_status()
            feed = _feed(res.content)
            return [{"source": "식약처", "title": e.title, "url": e.link, "published": _entry_dt(e)}
                    for e in feed.entries if e.get("title") and any(w in e.title for w in MFDS_WORDS)]
        except Exception as err:  # noqa: BLE001
            last_err = err
    raise RuntimeError(f"식약처 RSS 실패: {last_err}")


NEWS_FETCHERS = (fetch_jangup, fetch_cmn, fetch_beautynury, fetch_cosinkorea, fetch_cosmorning, fetch_mfds)


def refresh_news(force: bool = False) -> None:
    if not force and not _is_stale("news_fetched_at", NEWS_TTL):
        return
    now = _now()
    got_any = False
    for i, fetch in enumerate(NEWS_FETCHERS):
        try:
            items = fetch()
            got_any = got_any or bool(items)
            with _conn() as c:
                for it in items:
                    c.execute(
                        "INSERT OR IGNORE INTO news_items (url, source, title, published_at, fetched_at) VALUES (?,?,?,?,?)",
                        (it["url"], it["source"], it["title"].strip(), _iso(it["published"] or now), _iso(now)),
                    )
            log.info("뉴스 수집 %s: %d건", fetch.__name__, len(items))
        except Exception as err:  # noqa: BLE001 — 한 매체가 실패해도 계속
            log.warning("뉴스 수집 실패 %s: %s", fetch.__name__, err)
        if i < len(NEWS_FETCHERS) - 1:
            time.sleep(1.5)  # 6-5 수집 예절
    if got_any:
        _meta_set("news_fetched_at", _iso(now))
        with _conn() as c:  # 오래된 기사 정리 (최근 400건만 보관)
            c.execute("DELETE FROM news_items WHERE url NOT IN (SELECT url FROM news_items ORDER BY published_at DESC LIMIT 400)")
    _meta_set("news_last_try", _iso(now))


def _norm_title(t: str) -> str:
    return re.sub(r"[\s\W_]+", "", t).lower()


def _similar(a: str, b: str) -> bool:
    return difflib.SequenceMatcher(None, a, b).ratio() >= 0.8


NEWS_SOURCES = ["장업신문", "CMN", "뷰티누리", "코스인", "코스모닝", "식약처"]


def _like_terms(q: str | None) -> list[str]:
    """검색어를 공백 기준으로 나눠 모든 단어가 들어간 제목만 찾습니다 (AND 검색)"""
    return [t for t in (q or "").split() if t][:5]


def _search_sql(table: str, q: str | None, field: str | None, value: str | None, limit: int) -> tuple[str, list]:
    where, args = [], []
    for t in _like_terms(q):
        where.append("(title LIKE ? OR source LIKE ?)")
        args += [f"%{t}%", f"%{t}%"]
    if field and value:
        where.append(f"{field} = ?")
        args.append(value)
    sql = f"SELECT * FROM {table}" + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY published_at DESC LIMIT ?"
    return sql, args + [limit]


# ---------------------------------------------------------------------------
# 6-8. 구글 뉴스 RSS 검색 — 뉴스 더보기에서 "검색할 때만" 보조로 결합
#   - 수집해 둔 6개 매체에 없는 기사도 찾기 위함. 홈 목록(최신 뉴스)에는 섞지 않습니다.
#   - API Key가 필요 없고, 규제 업데이트(8장)에서 쓰는 것과 같은 구글 뉴스 RSS 검색입니다.
#   - 제목·언론사·시간·원문 링크만 표시 (6-5 저작권 규칙 동일)
# ---------------------------------------------------------------------------
WEB_SOURCE = "웹 검색"
WEB_CACHE_TTL = 600              # 같은 검색어는 10분간 다시 호출하지 않음
_web_cache: dict[str, tuple[float, list[dict]]] = {}
PRESS_BY_DOMAIN = {
    "yna.co.kr": "연합뉴스", "newsis.com": "뉴시스", "news1.kr": "뉴스1", "chosun.com": "조선일보",
    "joongang.co.kr": "중앙일보", "donga.com": "동아일보", "hani.co.kr": "한겨레", "khan.co.kr": "경향신문",
    "hankyung.com": "한국경제", "mk.co.kr": "매일경제", "sedaily.com": "서울경제", "edaily.co.kr": "이데일리",
    "fnnews.com": "파이낸셜뉴스", "mt.co.kr": "머니투데이", "heraldcorp.com": "헤럴드경제", "asiae.co.kr": "아시아경제",
    "etnews.com": "전자신문", "ajunews.com": "아주경제", "etoday.co.kr": "이투데이", "hankookilbo.com": "한국일보",
    "kmib.co.kr": "국민일보", "seoul.co.kr": "서울신문", "segye.com": "세계일보", "munhwa.com": "문화일보",
    "sbs.co.kr": "SBS", "kbs.co.kr": "KBS", "imbc.com": "MBC", "ytn.co.kr": "YTN", "jtbc.co.kr": "JTBC",
    "jangup.com": "장업신문", "cmn.co.kr": "CMN", "beautynury.com": "뷰티누리", "cosinkorea.com": "코스인",
    "cosmorning.com": "코스모닝", "thebell.co.kr": "더벨", "bizwatch.co.kr": "비즈니스워치", "newspim.com": "뉴스핌",
}


def _press_name(url: str) -> str:
    host = re.sub(r"^https?://", "", url or "").split("/")[0].lower()
    host = re.sub(r"^(www|m|news|biz|view|n)\.", "", host)
    for dom, name in PRESS_BY_DOMAIN.items():
        if host == dom or host.endswith("." + dom):
            return name
    return host or "언론사"


def search_web_news(q: str, limit: int = 30) -> tuple[list[dict], str | None]:
    """구글 뉴스 RSS 로 화장품 관련 기사를 검색합니다. (기사 목록, 오류 메시지)"""
    if not q:
        return [], None
    # 화장품 관련 단어가 없으면 "화장품"을 덧붙여 업계 기사로 좁힙니다 (예: "수출" → "화장품 수출")
    query = q if any(w in q.lower() for w in ("화장품", "코스메틱", "뷰티", "cosmetic")) else f"화장품 {q}"
    hit = _web_cache.get(query)
    if hit and time.time() - hit[0] < WEB_CACHE_TTL:
        return hit[1], None
    try:
        res = requests.get(GOOGLE_RSS, params={"q": query, "hl": "ko", "gl": "KR", "ceid": "KR:ko"},
                           headers=HEADERS, timeout=TIMEOUT)
        res.raise_for_status()
        items = []
        for e in _feed(res.content).entries[:limit]:
            # 구글 뉴스 제목: "제목 - 매체명 - 출처도메인" 형식으로 오고, 하이픈이 -, –, — 로 섞여 옵니다.
            raw_title = (e.get("title") or "").strip()
            feed_press = (e.get("source", {}) or {}).get("title", "") if isinstance(e.get("source"), dict) else ""
            for tail in (feed_press,):  # 끝에 붙은 출처 표기를 먼저 떼어냅니다
                if tail and raw_title.endswith(tail):
                    raw_title = re.sub(r"\s*[-–—]\s*$", "", raw_title[: -len(tail)]).strip()
            m = re.search(r"\s[-–—]\s([^-–—]{1,30})$", raw_title)
            title = raw_title[: m.start()].strip() if m else raw_title
            title = title.split(" :: ", 1)[-1].strip()   # "화장품신문 (Beautynury.com) :: 제목" 형태 정리
            press = (m.group(1).strip() if m else "") or feed_press
            url = e.get("link")
            if not title or not url:
                continue
            press = press or (e.get("source", {}).get("title") if isinstance(e.get("source"), dict) else "") or _press_name(url)
            items.append({"source": WEB_SOURCE, "press": press, "title": title, "url": url, "published": _entry_dt(e)})
        _web_cache[query] = (time.time(), items)
        if len(_web_cache) > 200:  # 캐시가 너무 커지지 않게 오래된 것부터 정리
            for k, _ in sorted(_web_cache.items(), key=lambda kv: kv[1][0])[:100]:
                _web_cache.pop(k, None)
        return items, None
    except Exception as err:  # noqa: BLE001 — 웹 검색이 실패해도 수집 기사 검색은 그대로 보여줌
        log.warning("웹 뉴스 검색 실패: %s", err)
        return [], "웹 검색 결과를 불러오지 못했어요"


def get_news(limit: int = NEWS_LIMIT, per_source: int | None = NEWS_PER_SOURCE,
             q: str | None = None, source: str | None = None, external: bool = False) -> dict:
    """홈 목록 / 뉴스 더보기 공용. q: 제목·매체 검색어, source: 매체 필터
    external=True 이고 검색어가 있으면 구글 뉴스 RSS 검색 결과를 합쳐 최신순으로 돌려줍니다."""
    web_items, web_error = [], None
    use_web = external and bool(q) and source in (None, "", WEB_SOURCE)
    if use_web:
        web_items, web_error = search_web_news(q)
    rows = []
    if source != WEB_SOURCE:
        sql, args = _search_sql("news_items", q, "source", source, max(limit * 4, 200))
        with _conn() as c:
            rows = [dict(r) for r in c.execute(sql, args)]
    for n in web_items:  # 수집 기사와 같은 형태로 맞춰 한 목록으로 합침
        rows.append({"source": WEB_SOURCE, "press": n["press"], "title": n["title"], "url": n["url"],
                     "published_at": _iso(n["published"]) or ""})
    rows.sort(key=lambda r: r.get("published_at") or "", reverse=True)
    seen_urls: set[str] = set()
    items, counts, kept_titles = [], {}, []
    for r in rows:
        if r["url"] in seen_urls:
            continue
        if per_source and counts.get(r["source"], 0) >= per_source:
            continue
        nt = _norm_title(r["title"])
        if any(_similar(nt, k) for k in kept_titles):  # 같은 보도자료를 여러 매체가 쓴 경우 (6-3)
            continue
        seen_urls.add(r["url"])
        kept_titles.append(nt)
        counts[r["source"]] = counts.get(r["source"], 0) + 1
        dt = _parse_iso(r["published_at"])
        items.append({
            "source": r["source"],
            "external": r["source"] == WEB_SOURCE,
            "press": r.get("press", ""),
            "official": r["source"] in OFFICIAL_SOURCES,
            "title": r["title"],
            "url": r["url"],
            "published_at": r["published_at"],
            "time_text": relative_time(dt),
        })
        if len(items) >= limit:
            break
    updated = _parse_iso(_meta_get("news_fetched_at"))
    return {
        "items": items,
        "updated_at": _iso(updated),
        "updated_text": updated.strftime("%H:%M 업데이트") if updated else "",
        "error": None if items else "뉴스를 불러오지 못했어요. 잠시 후 다시 확인해 주세요",
        "q": q or "",
        "source": source or "",
        "sources": NEWS_SOURCES + ([WEB_SOURCE] if external else []),
        "web": {
            "used": use_web,
            "count": sum(1 for it in items if it["external"]),
            "error": web_error,
        },
    }


# ---------------------------------------------------------------------------
# 8. 규제 업데이트 — 구글 뉴스 RSS (+ 선택: KOTRA 단신속보뉴스)
# ---------------------------------------------------------------------------
COSMETIC_WORDS = ["화장품", "코스메틱", "cosmetic", "뷰티", "스킨케어", "선크림", "sunscreen", "skincare", "beauty"]
REG_WORDS = ["규제", "금지", "제한", "등록", "인증", "허가", "성분", "표시", "라벨", "개정", "시행", "통관", "리콜",
             "regulation", "ban", "restrict", "label", "registration", "compliance", "recall", "mocra", "cpnp", "nmpa"]
COUNTRY_TAGS = {
    "미국": ["미국", "FDA", "MoCRA", "U.S.", "United States", "California"],
    "EU": ["EU", "유럽", "CPNP", "유럽연합", "European"],
    "중국": ["중국", "NMPA", "China"],
    "일본": ["일본", "후생노동성", "Japan"],
    "동남아": ["베트남", "태국", "인도네시아", "말레이시아", "필리핀", "BPOM", "아세안", "ASEAN", "Vietnam", "Thailand", "Indonesia"],
    "중동": ["사우디", "UAE", "SFDA", "할랄", "Saudi", "Dubai"],
    "한국": ["식약처", "식품의약품안전처"],
}
GOOGLE_RSS = "https://news.google.com/rss/search"
REG_QUERIES = [
    {"q": "화장품 (규제 OR 금지성분 OR 등록 OR 라벨링 OR 인증)", "hl": "ko", "gl": "KR", "ceid": "KR:ko"},
    {"q": "cosmetics regulation (MoCRA OR CPNP OR NMPA OR ASEAN)", "hl": "en-US", "gl": "US", "ceid": "US:en"},
]


def is_cosmetic_regulation(text: str) -> bool:
    t = text.lower()
    return any(w.lower() in t for w in COSMETIC_WORDS) and any(w.lower() in t for w in REG_WORDS)


def country_tag(text: str) -> str:
    t = text.lower()
    for tag, words in COUNTRY_TAGS.items():
        if any(w.lower() in t for w in words):
            return tag
    return "기타"


def fetch_google_regulations() -> list[dict]:
    items = []
    for params in REG_QUERIES:
        res = requests.get(GOOGLE_RSS, params=params, headers=HEADERS, timeout=TIMEOUT)
        res.raise_for_status()
        for e in _feed(res.content).entries:
            title, _, press = e.title.rpartition(" - ")
            title = title or e.title
            if is_cosmetic_regulation(title):
                items.append({"country": country_tag(title), "title": title, "source": press.strip() or "언론",
                              "url": e.link, "published": _entry_dt(e)})
    return items


def fetch_kotra_regulations() -> list[dict]:
    """KOTRA 단신속보뉴스 — 요청 주소/변수는 공공데이터포털 기술문서 확인 후 KOTRA_NEWS_URL에 설정 (8-1)"""
    url = os.getenv("KOTRA_NEWS_URL")
    key = _data_go_kr_key()
    if not url or not key:
        return []
    res = requests.get(url, params={"serviceKey": key, "numOfRows": 100, "pageNo": 1, "type": "json"}, headers=HEADERS, timeout=TIMEOUT)
    res.raise_for_status()
    items = []
    try:
        data = res.json()
        rows = data
        for k in ("response", "body", "items", "item"):
            if isinstance(rows, dict) and k in rows:
                rows = rows[k]
        if isinstance(rows, dict):
            rows = [rows]
    except ValueError:  # XML
        rows = [{c.tag: c.text for c in it} for it in ET.fromstring(res.content).iter("item")]
    for r in rows or []:
        title = r.get("newsTitl") or r.get("title") or ""
        body = r.get("newsBdt") or r.get("cn") or ""
        link = r.get("newsUrl") or r.get("url") or r.get("link") or ""
        if not title or not link or not is_cosmetic_regulation(title + " " + body):
            continue
        pub = None
        for k in ("newsWrtDt", "regDt", "pubDate"):
            if r.get(k):
                for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%Y%m%d"):
                    try:
                        pub = datetime.strptime(str(r[k])[:19], fmt).replace(tzinfo=KST)
                        break
                    except ValueError:
                        pass
        items.append({"country": country_tag(title + " " + body), "title": title, "source": "KOTRA", "url": link, "published": pub})
    return items


def refresh_regulations(force: bool = False) -> None:
    if not force and not _is_stale("reg_fetched_at", REG_TTL):
        return
    now = _now()
    got_any = False
    for fetch in (fetch_google_regulations, fetch_kotra_regulations):
        try:
            items = fetch()
            got_any = got_any or bool(items)
            with _conn() as c:
                for it in items:
                    c.execute(
                        "INSERT OR IGNORE INTO regulation_items (url, country, title, source, published_at, fetched_at) VALUES (?,?,?,?,?,?)",
                        (it["url"], it["country"], it["title"].strip(), it["source"], _iso(it["published"] or now), _iso(now)),
                    )
            log.info("규제 수집 %s: %d건", fetch.__name__, len(items))
        except Exception as err:  # noqa: BLE001
            log.warning("규제 수집 실패 %s: %s", fetch.__name__, err)
    if got_any:
        _meta_set("reg_fetched_at", _iso(now))
        with _conn() as c:
            c.execute("DELETE FROM regulation_items WHERE url NOT IN (SELECT url FROM regulation_items ORDER BY published_at DESC LIMIT 200)")
    _meta_set("reg_last_try", _iso(now))


REG_COUNTRIES = ["미국", "EU", "중국", "일본", "동남아", "중동", "한국", "기타"]


def get_regulations(limit: int = REG_LIMIT, since: str | None = None,
                    q: str | None = None, country: str | None = None) -> dict:
    """홈 목록 / 규제 더보기 / 10분 폴링 공용. q: 제목·출처 검색어, country: 국가 필터"""
    sql, args = _search_sql("regulation_items", q, "country", country, max(limit * 3, 60))
    with _conn() as c:
        rows = [dict(r) for r in c.execute(sql, args)]
    since_dt = _parse_iso(since)
    items, kept = [], []
    for r in rows:
        dt = _parse_iso(r["published_at"])
        if since_dt and dt and dt <= since_dt:
            continue
        nt = _norm_title(r["title"])
        if any(_similar(nt, k) for k in kept):
            continue
        kept.append(nt)
        items.append({
            "country": r["country"],
            "title": r["title"],
            "source": r["source"],
            "url": r["url"],
            "published_at": r["published_at"],
            "time_text": relative_time(dt),
            "is_new": bool(dt and (_now() - dt).total_seconds() < 86400),  # 8-4
        })
        if len(items) >= limit:
            break
    checked = _parse_iso(_meta_get("reg_fetched_at"))
    return {
        "items": items,
        "checked_at": _iso(checked),
        "checked_text": checked.strftime("%H:%M 확인") if checked else "",
        "latest_at": items[0]["published_at"] if items else None,
        "q": q or "",
        "country": country or "",
        "countries": REG_COUNTRIES,
    }


# ---------------------------------------------------------------------------
# 통합: 홈 화면 데이터 + 백그라운드 갱신
# ---------------------------------------------------------------------------
_REFRESHERS = {
    "rates": refresh_rates,
    "trade": refresh_trade,
    "news": refresh_news,
    "regulations": refresh_regulations,
}


def _needs_refresh(section: str) -> bool:
    if section == "rates":
        today = _now().date().isoformat()
        return _meta_get("rates_checked_date") != today and _is_stale("rates_last_try", 600)
    if section == "trade":
        return _is_stale("trade_fetched_at", TRADE_TTL) and _is_stale("trade_last_try", 600)
    if section == "news":
        return _is_stale("news_fetched_at", NEWS_TTL) and _is_stale("news_last_try", 300)
    if section == "regulations":
        return _is_stale("reg_fetched_at", REG_TTL) and _is_stale("reg_last_try", 300)
    return False


def _run_refresh(section: str) -> None:
    try:
        _REFRESHERS[section]()
    finally:
        with _lock:
            _refreshing.discard(section)


def kick_refresh(sections=("rates", "trade", "news", "regulations")) -> list[str]:
    """오래된 구역만 백그라운드 스레드로 갱신 시작. 시작한 구역 이름을 돌려줍니다."""
    started = []
    for s in sections:
        with _lock:
            if s in _refreshing or not _needs_refresh(s):
                continue
            _refreshing.add(s)
        threading.Thread(target=_run_refresh, args=(s,), name=f"home-refresh-{s}", daemon=True).start()
        started.append(s)
    return started


def is_refreshing() -> list[str]:
    with _lock:
        return sorted(_refreshing)


def get_validation() -> dict:
    """/api/home/validation — 데이터 교차검증 요약 (명세 13장)
    구역별 마지막 성공·시도 시각과 오래됨 여부, 환율 이상값, 수출입 정리·불일치 건수, 저장 건수를 한 번에 돌려줍니다."""
    now = _now()

    def section(success_key: str, try_key: str, ttl: int) -> dict:
        ok, tr = _parse_iso(_meta_get(success_key)), _parse_iso(_meta_get(try_key))
        return {
            "last_success": _iso(ok),
            "last_try": _iso(tr),
            "stale": ok is None or (now - ok).total_seconds() > ttl,   # 갱신 주기를 넘김
            "failing": bool(tr and (ok is None or tr > ok)),           # 마지막 시도가 성공보다 뒤 = 실패 중
        }

    rates = get_rates()
    cards = get_trade_cards()
    with _conn() as c:
        news_by_source = dict(c.execute("SELECT source, COUNT(*) FROM news_items GROUP BY source").fetchall())
        reg_by_country = dict(c.execute("SELECT country, COUNT(*) FROM regulation_items GROUP BY country").fetchall())
        reg_by_source = dict(c.execute("SELECT CASE WHEN source='KOTRA' THEN 'KOTRA' ELSE '언론' END, COUNT(*) FROM regulation_items GROUP BY 1").fetchall())
        trade_rows = c.execute("SELECT COUNT(*) FROM trade_stats").fetchone()[0]
        trade_months = c.execute("SELECT COUNT(DISTINCT yymm) FROM trade_stats").fetchone()[0]
    rate_warnings = [it["code"] for it in rates["items"] if it.get("warning")]
    return {
        "generated_at": _iso(now),
        "refreshing": is_refreshing(),
        "rates": {
            "latest_date": rates.get("date"),
            "prev_date": _meta_get("rates_prev_date") or None,
            "last_try": _meta_get("rates_last_try"),
            "count": len(rates["items"]),
            "has_change": all(it["change"] is not None for it in rates["items"]) if rates["items"] else False,
            "warn_pct": RATE_WARN_PCT,
            "warnings": rate_warnings,      # 전일 대비 급변 통화
            "ok": bool(rates["items"]) and not rate_warnings,
        },
        "trade": section("trade_fetched_at", "trade_last_try", TRADE_TTL) | {
            "rows": trade_rows,
            "months": trade_months,
            "hs_codes": HS_CODES,
            "cleaning": cards.get("cleaning"),
            "validation": cards.get("validation"),
            "ok": bool(cards.get("ok")) and bool((cards.get("validation") or {}).get("ok")),
        },
        "news": section("news_fetched_at", "news_last_try", NEWS_TTL) | {
            "by_source": news_by_source,
            "missing_sources": [s for s in NEWS_SOURCES if not news_by_source.get(s)],   # 한 건도 없는 매체
            "ok": all(news_by_source.get(s) for s in NEWS_SOURCES),
        },
        "regulations": section("reg_fetched_at", "reg_last_try", REG_TTL) | {
            "by_country": reg_by_country,
            "by_source": reg_by_source,
            "kotra_configured": bool(os.getenv("KOTRA_NEWS_URL") and _data_go_kr_key()),
            "ok": bool(reg_by_country),
        },
    }


def get_dashboard() -> dict:
    """홈 템플릿 / /api/home/data 공용"""
    kick_refresh()
    return {
        "rates": get_rates(),
        "trade": get_trade(),
        "trade_cards": get_trade_cards(),
        "news": get_news(),
        "regulations": get_regulations(),
        "buyer_cities": top_export_cities(),
        "city_options": city_options(),
        "refreshing": is_refreshing(),
        "generated_at": _iso(_now()),
    }
