"""국가별 인허가 규제 — K뷰티 API(RapidAPI) 호출·응답 정규화 모듈 (담당자 B).

app.py의 [B] 영역 Route에서만 사용한다. 브라우저는 이 모듈을 직접 호출하지 않는다.

원칙 (src/02_regulatory/regulatory.md 9·10·11항)
- RAPIDAPI_KEY / RAPIDAPI_HOST 는 os.getenv() 로만 읽고, 반환값·예외 메시지·로그에 절대 넣지 않는다.
- 국가별 결과는 응답의 `data` 와 `result_status` 로만 판정한다.
  `ingredient.regulation_status`, `markets_outside_plan` 은 판정 근거로 쓰지 않는다.
- 규제 데이터가 없는 정상 응답(`not_listed_in_country`, `data=[]`)은 "규제 데이터 미확인"(no_data)이며
  허용·안전을 뜻하지 않는다. 통신·인증·형식 오류는 "API 오류"(RegulatoryApiError)로 구분한다.
- 확인하지 않은 `result_status` 값은 임의 해석하지 않고 "판단 보류"(hold)로 넘긴다.
- `limit_condition` 등 규제 조건 원문은 가공하지 않고 그대로 반환한다.

실제 호출 기록: src/02_regulatory/test_data/*.json, 계약 설명: src/02_regulatory/api_reference.md
"""

import os
from datetime import datetime

import requests

# 응답에서 안내된 시장 코드 (available_country_codes). 화면 select 값과 동일.
MARKET_CODES = ("KR", "EU", "CN", "US", "JP", "ASEAN")

# 실제 호출로 확인한 result_status 값만 등록한다. 그 외 값은 hold 처리.
#   listed                : 규제 항목 반환                                (test_data/regulations_5489_EU.json)
#   not_listed_in_country : 요청 시장 항목 없음. result_note 에 "다른 시장에 있음" 또는 "요금제 밖 시장에만 있음" 안내
#                           (test_data/regulations_5489_US.json, regulations_1013_EU_plan_note.json)
#   not_listed            : 소스 데이터에 제한·금지 항목 자체가 없음 안내       (test_data/regulations_1941_EU_not_listed.json)
# not_listed 와 markets_outside_plan 의 정확한 의미는 공개 문서에 없으므로 '허용'·'요금제 제한'으로 단정하지 않고 상태값·안내문을 그대로 전달한다.
RESULT_STATUS_FOUND = ("listed",)
RESULT_STATUS_NO_DATA = ("not_listed_in_country",)
RESULT_STATUS_NOT_LISTED = ("not_listed",)

MAX_CANDIDATES = 10
MIN_QUERY_LENGTH = 2   # API 문서 기준 검색어 최소 길이 (min 2 chars). 자동완성·직접 검색 공통
CONNECT_TIMEOUT = 5

# 검색 엔드포인트 (공개 README 문서 + 실제 호출로 확인, 둘 다 "starts with" 일치)
#   kr   : /v1/ingredient/kr?q=    한글명 시작 일치            (test_data/search_kr_*.json)
#   inci : /v1/ingredient/inci?q=  영문 INCI명 시작 일치, 대소문자 무시 (test_data/search_inci_partial_retin.json)
# 한글 엔드포인트에 영문을 넣으면 0건이므로 입력에 한글이 있으면 kr, 없으면 inci 로 1회만 호출한다.
# "contains" 부분 검색(/v1/ingredient/search)은 PRO+ 전용으로 문서화되어 있으나 이 단계에서는 사용하지 않는다.
SEARCH_ENDPOINTS = {"kr": "/v1/ingredient/kr", "inci": "/v1/ingredient/inci"}
SEARCH_MATCH_MODE = "starts_with"
READ_TIMEOUT = 15


class RegulatoryApiError(Exception):
    """외부 API 호출 실패. kind 로 원인을 구분하며 메시지에 비밀값을 넣지 않는다.

    kind: config | timeout | connection | auth(401) | access(403: 인증·구독·요금제 확인 필요) | rate_limit(429) | http | invalid_response
    """

    def __init__(self, kind, message, http_status=None):
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.http_status = http_status

    def to_dict(self):
        out = {"kind": self.kind, "message": self.message}
        if self.http_status is not None:
            out["http_status"] = self.http_status
        return out


# ---------------------------------------------------------------------------
# 호출
# ---------------------------------------------------------------------------

def _config():
    key = os.getenv("RAPIDAPI_KEY", "").strip()
    host = os.getenv("RAPIDAPI_HOST", "").strip()
    if not key or not host:
        # Key 값·변수 내용은 메시지에 넣지 않는다.
        raise RegulatoryApiError("config", "규제 API 설정이 없어요. 관리자에게 서버 환경변수 확인을 요청해 주세요.")
    return key, host


def _get(path, params):
    """GET 호출 후 JSON(dict)을 돌려준다. 실패는 모두 RegulatoryApiError 로 변환한다."""
    key, host = _config()
    url = "https://%s%s" % (host, path)
    headers = {"x-rapidapi-key": key, "x-rapidapi-host": host}
    try:
        resp = requests.get(url, params=params, headers=headers, timeout=(CONNECT_TIMEOUT, READ_TIMEOUT))
    except requests.exceptions.Timeout:
        raise RegulatoryApiError("timeout", "규제 API 응답이 지연되고 있어요. 잠시 후 다시 시도해 주세요.")
    except requests.exceptions.RequestException:
        # 예외 문자열에는 URL·헤더가 섞일 수 있어 종류만 남긴다.
        raise RegulatoryApiError("connection", "규제 API에 연결하지 못했어요. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.")

    status = resp.status_code
    if status == 401:
        raise RegulatoryApiError("auth", "규제 API 인증에 실패했어요. 관리자에게 서버 설정 확인을 요청해 주세요.", status)
    if status == 403:
        # RapidAPI 는 미구독·요금제 밖 엔드포인트도 403 으로 응답한다(공개 README: regulations 는 PRO+ 전용). 인증 실패와 구분해 '접근 제한'으로 둔다.
        raise RegulatoryApiError("access", "규제 API 접근이 제한됐어요 (HTTP 403). 인증 정보와 요금제(구독) 범위를 관리자에게 확인 요청해 주세요.", status)
    if status == 429:
        raise RegulatoryApiError("rate_limit", "규제 API 호출 한도를 초과했어요. 잠시 후 다시 시도해 주세요.", status)
    if status >= 400:
        raise RegulatoryApiError("http", "규제 API가 오류를 반환했어요 (HTTP %d). 잠시 후 다시 시도해 주세요." % status, status)

    try:
        body = resp.json()
    except ValueError:
        raise RegulatoryApiError("invalid_response", "규제 API 응답 형식을 해석하지 못했어요. 잠시 후 다시 시도해 주세요.", status)
    if not isinstance(body, dict):
        raise RegulatoryApiError("invalid_response", "규제 API 응답 형식이 예상과 달라요. 잠시 후 다시 시도해 주세요.", status)
    return body


def _now_iso():
    return datetime.now().astimezone().isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# 성분명 후보 검색  GET /v1/ingredient/kr?q=  (한글)  /  GET /v1/ingredient/inci?q=  (영문 INCI)
# ---------------------------------------------------------------------------

def normalize_query(text):
    """앞뒤 공백 제거 + 영문 대소문자 무시용 정규화. 표시용 원문은 호출측이 따로 보관한다."""
    return (text or "").strip().casefold()


def _match_rank(query_norm, names):
    """정확 일치 0 → 시작 일치 1 → 포함 일치 2 → 그 외 3."""
    best = 3
    for name in names:
        n = normalize_query(name)
        if not n:
            continue
        if n == query_norm:
            return 0
        if n.startswith(query_norm):
            best = min(best, 1)
        elif query_norm in n:
            best = min(best, 2)
    return best


def normalize_search_response(body, query):
    """검색 응답(body)을 후보 목록으로 정규화한다. 응답에 없는 이름은 만들지 않는다."""
    if body.get("success") is not True or not isinstance(body.get("data"), list):
        raise RegulatoryApiError("invalid_response", "성분 검색 응답 형식이 예상과 달라요. 잠시 후 다시 시도해 주세요.")

    query_norm = normalize_query(query)
    seen = set()
    candidates = []
    for idx, item in enumerate(body["data"]):
        if not isinstance(item, dict) or item.get("code") in (None, ""):
            continue
        code = item.get("code")
        if code in seen:
            continue
        seen.add(code)
        kr_name = (item.get("kr_name") or "").strip()
        inci_name = (item.get("inci_name") or "").strip()
        candidates.append({
            "code": code,
            "kr_name": kr_name or None,          # 없으면 None — 영문명만 표시 (한글명을 만들지 않음)
            "inci_name": inci_name or None,
            "old_name": (item.get("old_name") or "").strip() or None,
            "cas_numbers": (item.get("cas_numbers") or "").strip() or None,
            "record_updated_at": item.get("updated_at") or None,   # API 레코드 갱신일. 규제 자료 갱신일과 다름
            "match_rank": _match_rank(query_norm, (kr_name, inci_name, item.get("old_name") or "")),
            "_order": idx,
        })

    candidates.sort(key=lambda c: (c["match_rank"], c["_order"]))
    for c in candidates:
        del c["_order"]

    total = len(candidates)
    return {
        "query": (query or "").strip(),
        "candidates": candidates[:MAX_CANDIDATES],
        "total": total,
        "truncated": total > MAX_CANDIDATES,
        "data_source": body.get("data_source"),
        "queried_at": _now_iso(),
    }


def detect_search_field(query):
    """검색어에 한글(가-힣, 자모)이 하나라도 있으면 'kr', 아니면 'inci'."""
    for ch in (query or ""):
        if "가" <= ch <= "힣" or "ㄱ" <= ch <= "ㆎ":
            return "kr"
    return "inci"


def search_ingredients(query):
    """한글명 또는 영문 INCI명 후보 검색. 앞뒤 공백 제거 후 언어에 맞는 엔드포인트를 1회만 호출한다.

    영문 대소문자는 API 가 무시하며(실제 호출 확인) 순위 계산도 casefold 로 무시한다.
    두 엔드포인트 모두 '시작 일치'라 중간 포함 검색(예: '티놀')은 이 단계에서 지원하지 않는다.
    """
    q = (query or "").strip()
    if not q:
        raise ValueError("query is empty")
    if len(q) < MIN_QUERY_LENGTH:
        raise ValueError("query too short")
    field = detect_search_field(q)
    body = _get(SEARCH_ENDPOINTS[field], {"q": q})
    result = normalize_search_response(body, q)
    result["search_field"] = field
    result["match_mode"] = SEARCH_MATCH_MODE
    return result


def search_ingredients_kr(query):
    """한글 성분명 검색 (기존 계약 유지). 새 코드는 search_ingredients() 를 사용한다."""
    q = (query or "").strip()
    if not q:
        raise ValueError("query is empty")
    body = _get(SEARCH_ENDPOINTS["kr"], {"q": q})
    result = normalize_search_response(body, q)
    result["search_field"] = "kr"
    result["match_mode"] = SEARCH_MATCH_MODE
    return result


# ---------------------------------------------------------------------------
# 시장별 규제 조회  GET /v1/ingredient/{code}/regulations?country=
# ---------------------------------------------------------------------------

def normalize_regulation_response(body, code, country):
    """규제 조회 응답을 화면용 구조로 정규화한다.

    lookup_status
      found      : result_status 가 확인된 '있음' 값이고 data 가 비어 있지 않음 → 규제 정보 조회됨
      no_data    : not_listed_in_country + data=[] → 요청 시장 항목 없음 = 규제 데이터 미확인 (허용·안전 아님)
      not_listed : not_listed + data=[] → API 소스에 제한·금지 항목 없음 안내 = 규제 목록 미등재 (허용·안전 아님)
      hold       : 확인하지 않은 result_status 또는 예상과 다른 조합 → 판단 보류·추가 확인 필요
    note_mentions_plan : result_note 에 'outside your plan' 문구가 있으면 True (문구 존재 여부만 전달, 의미 해석 없음)
    """
    if body.get("success") is not True:
        raise RegulatoryApiError("invalid_response", "규제 조회 응답이 성공 상태가 아니에요. 잠시 후 다시 시도해 주세요.")

    data = body.get("data")
    if not isinstance(data, list):
        raise RegulatoryApiError("invalid_response", "규제 조회 응답 형식이 예상과 달라요. 잠시 후 다시 시도해 주세요.")

    result_status = body.get("result_status")
    entries = []
    for item in data:
        if not isinstance(item, dict):
            continue
        entries.append({
            "country": item.get("country"),
            "country_code": item.get("country_code"),
            "regulate_type": item.get("regulate_type"),
            "notice_ingr_name": item.get("notice_ingr_name"),
            "proviso": item.get("proviso"),
            "limit_condition": item.get("limit_condition"),   # 원문 그대로
            "source_type": item.get("source_type"),
        })

    if result_status in RESULT_STATUS_FOUND and entries:
        lookup_status = "found"
    elif result_status in RESULT_STATUS_NO_DATA and not entries:
        lookup_status = "no_data"
    elif result_status in RESULT_STATUS_NOT_LISTED and not entries:
        lookup_status = "not_listed"
    else:
        # 미확인 값, 또는 listed 인데 data 가 비어 있는 등 예상과 다른 조합
        lookup_status = "hold"

    ingredient = body.get("ingredient") if isinstance(body.get("ingredient"), dict) else {}
    country_info = body.get("country") if isinstance(body.get("country"), dict) else {}

    return {
        "ingredient": {
            "code": ingredient.get("code", code),
            "kr_name": ingredient.get("kr_name") or None,
            "inci_name": ingredient.get("inci_name") or None,
        },
        "country": {
            "requested": country,
            "resolved": country_info.get("resolved"),
            "code": country_info.get("code") or country,
        },
        "lookup_status": lookup_status,
        "result_status": result_status,
        "result_note": body.get("result_note"),
        "note_mentions_plan": "outside your plan" in str(body.get("result_note") or "").lower(),
        "markets_outside_plan": body.get("markets_outside_plan"),   # 원문 값 그대로 (의미 미확인)
        "entries": entries,
        "markets_listed": body.get("markets_listed") if isinstance(body.get("markets_listed"), list) else None,
        "data_source": body.get("data_source"),          # 출처 (응답 단위 문자열)
        "disclaimer": body.get("disclaimer"),
        "source_updated_at": None,                       # 규제 자료 갱신일: 응답에 없음 → 미제공
        "queried_at": _now_iso(),                        # 서비스 조회 시각 (실제 호출 시각)
    }


def get_regulations(code, country):
    """성분 코드 + 시장 코드로 규제 조회."""
    if country not in MARKET_CODES:
        raise ValueError("unsupported market: %r" % (country,))
    code_str = str(code).strip()
    if not code_str.isdigit():
        raise ValueError("invalid ingredient code")
    body = _get("/v1/ingredient/%s/regulations" % code_str, {"country": country})
    return normalize_regulation_response(body, int(code_str), country)
