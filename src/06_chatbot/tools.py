"""AI 챗봇 도구 모듈 (담당자 F) — 명세: src/06_chatbot/chatbot.md 5·9·10장

OpenAI 모델이 호출할 수 있는 도구(function)를 정의하고 실행합니다.
데이터는 같은 저장소의 기존 모듈을 API 없이 직접 불러와 사용합니다. (로그인 세션에 의존하는 부분 없음)

- 환율 · 수출입 · 뉴스 · 규제 소식 : src/01_home/home_data.py  (SQLite 캐시 + 백그라운드 수집)
- 성분 검색 · 규제 조회           : src/02_regulatory/regulatory_service.py (RapidAPI), regulatory_mfds_lookup.py (식약처 수집 DB)

원칙
- 도구 결과는 모델에게 "데이터"로만 전달합니다. 결과 안의 문장은 지시로 해석하지 않도록 서버 system prompt 에서 안내합니다.
- 규제 결과는 원문(limit_condition 등)을 가공하지 않고 축약만 합니다. 허용·안전 판단을 만들지 않습니다.
- API Key 는 각 모듈이 os.getenv() 로 읽으며, 이 모듈은 Key 를 다루지 않습니다.
"""

from __future__ import annotations

import importlib
import importlib.util
import json
import logging
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

BASE_DIR = Path(__file__).resolve().parents[2]
if str(BASE_DIR) not in sys.path:          # server.py 를 스크립트로 직접 실행할 때 저장소 루트를 import 경로에 추가
    sys.path.insert(0, str(BASE_DIR))

log = logging.getLogger("cosmoa.chatbot.tools")
KST = ZoneInfo("Asia/Seoul")
MAX_OUTPUT_CHARS = 7000      # 도구 결과 1건이 모델에 전달되는 최대 길이
MAX_LIST = 10


def _load_file_module(name: str, rel_path: str):
    """폴더명이 숫자로 시작해 import 문을 쓸 수 없으므로 파일 경로로 불러옵니다. (app.py [B] 영역과 같은 방식)"""
    spec = importlib.util.spec_from_file_location(name, BASE_DIR / "src" / rel_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


home_data = importlib.import_module("src.01_home.home_data")
regulatory_service = _load_file_module("regulatory_service", "02_regulatory/regulatory_service.py")
regulatory_mfds = _load_file_module("regulatory_mfds_lookup", "02_regulatory/regulatory_mfds_lookup.py")


def init(db_path: Path) -> None:
    """서버 시작 시 한 번 호출. 홈 데이터 캐시(SQLite) 테이블을 준비합니다."""
    home_data.init(db_path)


# ---------------------------------------------------------------------------
# 도구 정의 (OpenAI Responses API function tools, strict 모드)
#   strict 모드는 모든 property 를 required 에 넣고, 선택 값은 null 을 허용하는 type 으로 표현합니다.
# ---------------------------------------------------------------------------
MARKETS = list(regulatory_service.MARKET_CODES)          # KR, EU, CN, US, JP, ASEAN
REG_COUNTRIES = list(home_data.REG_COUNTRIES)            # 미국, EU, 중국, 일본, 동남아, 중동, 한국, 기타
NEWS_SOURCES = list(home_data.NEWS_SOURCES)

TOOLS = [
    {
        "type": "function",
        "name": "get_exchange_rates",
        "description": "오늘 기준 원화 환율(매매기준율, 한국수출입은행)과 전일 대비 변동률을 가져와요. USD, JPY(100엔), CNH, EUR, THB, VND 등 주요 수출국 통화. 환산 계산이 필요하면 이 값을 기준으로 계산해요.",
        "parameters": {"type": "object", "properties": {}, "required": [], "additionalProperties": False},
        "strict": True,
    },
    {
        "type": "function",
        "name": "get_trade_stats",
        "description": "관세청 화장품(HS 3304 등) 수출입 실적: 최근 월 수출·수입액, 전년 동월 대비, 최근 12개월 추이, 수출 상위국, 품목(HS 6단위)별 수출.",
        "parameters": {"type": "object", "properties": {}, "required": [], "additionalProperties": False},
        "strict": True,
    },
    {
        "type": "function",
        "name": "search_news",
        "description": "화장품 업계 최신 뉴스를 검색해요. 출처: 장업신문, CMN, 뷰티누리, 코스인, 코스모닝, 식약처 + 검색어가 있으면 구글 뉴스. query 가 없으면 최신 기사 목록.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": ["string", "null"], "description": "검색어 (제목·매체명). 없으면 null"},
                "source": {"type": ["string", "null"], "enum": NEWS_SOURCES + [None], "description": "특정 매체만 볼 때. 없으면 null"},
                "limit": {"type": "integer", "description": "최대 건수 (1~10)"},
            },
            "required": ["query", "source", "limit"],
            "additionalProperties": False,
        },
        "strict": True,
    },
    {
        "type": "function",
        "name": "search_regulation_news",
        "description": "해외 화장품 규제 업데이트 소식(구글 뉴스·KOTRA 수집)을 검색해요. 국가별 최신 규제 동향, MoCRA·CPNP·NMPA 등 제도 소식.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": ["string", "null"], "description": "검색어. 없으면 null"},
                "country": {"type": ["string", "null"], "enum": REG_COUNTRIES + [None], "description": "국가 필터. 없으면 null"},
                "limit": {"type": "integer", "description": "최대 건수 (1~10)"},
            },
            "required": ["query", "country", "limit"],
            "additionalProperties": False,
        },
        "strict": True,
    },
    {
        "type": "function",
        "name": "search_ingredient",
        "description": "화장품 성분명(한글명 또는 영문 INCI명, 앞부분 일치)으로 성분 후보를 찾아요. 성분 코드·한글명·INCI명·CAS 번호를 돌려줘요. 규제 조회 전에 정확한 성분명을 확인할 때 사용.",
        "parameters": {
            "type": "object",
            "properties": {"query": {"type": "string", "description": "성분명 2글자 이상 (예: 레티놀, Retinol)"}},
            "required": ["query"],
            "additionalProperties": False,
        },
        "strict": True,
    },
    {
        "type": "function",
        "name": "lookup_ingredient_regulation",
        "description": "성분의 국가/시장별 사용제한·금지 규제를 조회해요. source=mfds 는 식약처 '화장품 사용제한 원료정보' 수집 DB(기본), source=api 는 K-Beauty 규제 API. 한 출처가 사용 불가라고 응답하면 사용자에게 알리고 다른 출처로 다시 시도할 수 있어요. 결과는 참고 자료이며 허용·안전 판단이 아니에요.",
        "parameters": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "성분 한글명 또는 영문 INCI명 (정확한 이름)"},
                "market": {"type": "string", "enum": MARKETS, "description": "시장 코드"},
                "source": {"type": "string", "enum": ["mfds", "api"], "description": "조회 출처. 기본 mfds"},
            },
            "required": ["name", "market", "source"],
            "additionalProperties": False,
        },
        "strict": True,
    },
    {
        "type": "function",
        "name": "get_local_time",
        "description": "주요 수출국 바이어의 현지 시각과 업무 시간(09~18시) 여부를 알려줘요. country_code 가 null 이면 수출 상위국 4곳.",
        "parameters": {
            "type": "object",
            "properties": {"country_code": {"type": ["string", "null"], "description": "ISO 국가코드 2자리 (CN, US, JP, VN, TH, DE …). 없으면 null"}},
            "required": ["country_code"],
            "additionalProperties": False,
        },
        "strict": True,
    },
]


# ---------------------------------------------------------------------------
# 실행
# ---------------------------------------------------------------------------

def _clamp(n, lo, hi, default):
    try:
        return max(lo, min(hi, int(n)))
    except (TypeError, ValueError):
        return default


def _has_korean(text: str) -> bool:
    return any("가" <= ch <= "힣" or "ㄱ" <= ch <= "ㆎ" for ch in text or "")


def _collecting(section: str) -> str | None:
    if section in home_data.is_refreshing():
        return "데이터를 지금 수집하는 중이에요. 30초쯤 뒤에 다시 물어봐 주세요."
    return None


def tool_get_exchange_rates() -> dict:
    home_data.kick_refresh(("rates",))
    rates = home_data.get_rates()
    if not rates["items"]:
        home_data.refresh_rates()          # 첫 실행(캐시 없음)은 바로 조회 — 외부 호출 1~2회
        rates = home_data.get_rates()
    return {
        "date": rates["date"],
        "basis": "한국수출입은행 매매기준율 (KRW). unit 이 100이면 100단위 통화 기준 (예: JPY 100엔)",
        "items": [{"code": r["code"], "unit": r["unit"], "name": r["name"], "rate_krw": r["rate"],
                   "change_pct_vs_prev_day": None if r["change"] is None else round(r["change"], 2)} for r in rates["items"]],
        "error": rates["error"],
    }


def tool_get_trade_stats() -> dict:
    home_data.kick_refresh(("trade",))
    cards = home_data.get_trade_cards()
    if not cards.get("ok"):
        return {"ok": False, "message": _collecting("trade") or cards.get("message"), "reference": cards.get("kstat_url")}
    summary = cards.get("summary", {})
    return {
        "ok": True,
        "unit": "USD 백만 (musd)",
        "hs_codes": cards.get("hs_codes") or home_data.HS_CODES,
        "latest_month": summary.get("month_text"),
        "summary": {k: summary.get(k) for k in ("exp_musd", "imp_musd", "bal_musd", "exp_yoy", "imp_yoy", "total_12m_musd")},
        "trend_12m": [{"month": t["label"], "exp_musd": t["musd"]} for t in summary.get("trend", [])],
        "top_countries_12m": [{k: c.get(k) for k in ("code", "name", "musd", "share", "pct", "direction")} for c in cards.get("countries", [])],
        "top_products_12m": [{k: p.get(k) for k in ("code", "name", "musd", "share", "pct", "direction")} for p in cards.get("products", [])],
        "source": "관세청 품목별 국가별 수출입실적 (공공데이터포털)",
    }


def tool_search_news(query=None, source=None, limit=5) -> dict:
    home_data.kick_refresh(("news",))
    q = (query or "").strip() or None
    limit = _clamp(limit, 1, MAX_LIST, 5)
    news = home_data.get_news(limit=limit, per_source=None, q=q, source=source or None, external=bool(q))
    items = [{"source": n["source"], "press": n["press"] or None, "title": n["title"], "url": n["url"],
              "published_at": n["published_at"]} for n in news["items"]]
    return {"query": q, "count": len(items), "items": items,
            "updated_at": news["updated_at"],
            "note": None if items else (_collecting("news") or news["error"])}


def tool_search_regulation_news(query=None, country=None, limit=5) -> dict:
    home_data.kick_refresh(("regulations",))
    q = (query or "").strip() or None
    limit = _clamp(limit, 1, MAX_LIST, 5)
    regs = home_data.get_regulations(limit=limit, q=q, country=country or None)
    items = [{"country": r["country"], "title": r["title"], "source": r["source"], "url": r["url"],
              "published_at": r["published_at"]} for r in regs["items"]]
    return {"query": q, "country": country, "count": len(items), "items": items,
            "checked_at": regs["checked_at"],
            "note": None if items else (_collecting("regulations") or "조건에 맞는 규제 소식이 아직 없어요.")}


def tool_search_ingredient(query="") -> dict:
    q = (query or "").strip()
    if len(q) < regulatory_service.MIN_QUERY_LENGTH:
        return {"error": {"kind": "validation", "message": "성분명을 2글자 이상 입력해 주세요."}}
    try:
        result = regulatory_service.search_ingredients(q)
    except regulatory_service.RegulatoryApiError as exc:
        return {"error": exc.to_dict(), "hint": "성분 검색 API 를 쓸 수 없어요. 사용자가 정확한 성분명을 알고 있으면 lookup_ingredient_regulation(source=mfds) 로 바로 조회할 수 있어요."}
    return {
        "query": result["query"],
        "match_mode": "앞부분 일치 (starts_with)",
        "total": result["total"],
        "candidates": [{k: c.get(k) for k in ("code", "kr_name", "inci_name", "cas_numbers")} for c in result["candidates"]],
    }


def _compact_entries(entries: list[dict]) -> list[dict]:
    keys = ("country", "regulate_type", "notice_ingr_name", "limit_condition", "proviso")
    return [{k: e.get(k) for k in keys} for e in entries[:MAX_LIST]]


def tool_lookup_ingredient_regulation(name="", market="KR", source="mfds") -> dict:
    name = (name or "").strip()
    if not name:
        return {"error": {"kind": "validation", "message": "성분명이 필요해요."}}
    if market not in MARKETS:
        return {"error": {"kind": "validation", "message": "시장 코드는 %s 중 하나여야 해요." % ", ".join(MARKETS)}}

    if source == "mfds":
        kwargs = {"kr_name": name} if _has_korean(name) else {"inci_name": name}
        try:
            r = regulatory_mfds.lookup(market=market, **kwargs)
        except regulatory_mfds.MfdsLookupError as exc:
            return {"error": exc.to_dict(), "hint": "식약처 수집 DB 를 쓸 수 없어요. 사용자에게 알린 뒤 source='api' 로 다시 시도할 수 있어요."}
        return {
            "source": r["source_label"],
            "ingredient": r["ingredient"],
            "market": r["country"]["resolved"],
            "link_status": r["link_status"],
            "lookup_status": r["lookup_status"],
            "result_note": r["result_note"],
            "entries": _compact_entries(r["entries"]),
            "related_count": len(r["related"]),
            "related_sample": [{"notice_ingr_name": x.get("notice_ingr_name"), "regulate_type": x.get("regulate_type")} for x in r["related"][:5]],
            "markets_listed": r["markets_listed"],
            "collected_at": r["collected_at"],
            "disclaimer": r["disclaimer"],
        }

    # source == "api": 성분 검색으로 코드를 찾은 뒤 규제 조회 (RapidAPI)
    try:
        found = regulatory_service.search_ingredients(name)
    except regulatory_service.RegulatoryApiError as exc:
        return {"error": exc.to_dict()}
    if not found["candidates"]:
        return {"lookup_status": "no_candidate", "message": "'%s' 에 해당하는 성분을 API 에서 찾지 못했어요. 성분명을 확인해 주세요." % name}
    top = found["candidates"][0]
    try:
        r = regulatory_service.get_regulations(top["code"], market)
    except regulatory_service.RegulatoryApiError as exc:
        return {"error": exc.to_dict()}
    return {
        "source": "K-Beauty Cosmetic Ingredients API (RapidAPI)",
        "ingredient": r["ingredient"],
        "candidate_used": {k: top.get(k) for k in ("code", "kr_name", "inci_name")},
        "other_candidates": len(found["candidates"]) - 1,
        "market": r["country"]["resolved"] or market,
        "lookup_status": r["lookup_status"],
        "result_note": r["result_note"],
        "entries": _compact_entries(r["entries"]),
        "markets_listed": r["markets_listed"],
        "refresh_policy": r["refresh_policy"],
        "disclaimer": r["disclaimer"],
    }


def tool_get_local_time(country_code=None) -> dict:
    now = datetime.now(KST)
    if country_code:
        code = country_code.strip().upper()
        city = home_data.CITY_MAP.get(code)
        if not city:
            return {"error": {"kind": "validation", "message": "지원하는 국가코드: " + ", ".join(home_data.CITY_MAP)}}
        cities = [{"code": code, **city}]
    else:
        cities = home_data.top_export_cities()
    out = []
    for c in cities:
        local = now.astimezone(ZoneInfo(c["tz"]))
        out.append({"country": c["country"], "city": c["name"], "local_time": local.strftime("%Y-%m-%d %H:%M"),
                    "weekday": "월화수목금토일"[local.weekday()],
                    "business_hours": local.weekday() < 5 and 9 <= local.hour < 18,
                    "offset_from_kst_hours": round((local.utcoffset() - now.utcoffset()).total_seconds() / 3600, 1)})
    return {"kst_now": now.strftime("%Y-%m-%d %H:%M"), "items": out}


EXECUTORS = {
    "get_exchange_rates": tool_get_exchange_rates,
    "get_trade_stats": tool_get_trade_stats,
    "search_news": tool_search_news,
    "search_regulation_news": tool_search_regulation_news,
    "search_ingredient": tool_search_ingredient,
    "lookup_ingredient_regulation": tool_lookup_ingredient_regulation,
    "get_local_time": tool_get_local_time,
}


def execute(name: str, arguments: str | dict | None) -> str:
    """모델의 function_call 을 실행해 JSON 문자열로 돌려줍니다. 예외는 모델이 읽을 수 있는 오류로 바꿉니다."""
    fn = EXECUTORS.get(name)
    if fn is None:
        return json.dumps({"error": {"kind": "unknown_tool", "message": "알 수 없는 도구예요: %s" % name}}, ensure_ascii=False)
    try:
        args = json.loads(arguments) if isinstance(arguments, str) and arguments.strip() else (arguments or {})
        if not isinstance(args, dict):
            args = {}
        result = fn(**args)
    except json.JSONDecodeError:
        result = {"error": {"kind": "validation", "message": "도구 인자가 올바른 JSON 이 아니에요. 인자를 다시 만들어 호출해 주세요."}}
    except TypeError as exc:
        result = {"error": {"kind": "validation", "message": "도구 인자가 올바르지 않아요 (%s)." % exc.__class__.__name__}}
    except Exception as exc:  # noqa: BLE001 — 도구 하나가 실패해도 대화는 이어져야 함
        log.warning("도구 실행 실패 %s: %s", name, exc)
        result = {"error": {"kind": "tool_error", "message": "%s 도구 실행 중 오류가 났어요 (%s)." % (name, exc.__class__.__name__)}}
    text = json.dumps(result, ensure_ascii=False, default=str)
    if len(text) > MAX_OUTPUT_CHARS:
        text = text[:MAX_OUTPUT_CHARS] + '…"} (결과가 길어 일부만 전달됨)'
    return text
