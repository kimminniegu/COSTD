"""원가 경쟁력 및 마진 시뮬레이션 비즈니스 로직 (담당자 C).

기능 명세: src/03_margin/margin.md
- app.py 의 Route 는 입력 추출 → 이 모듈 호출 → 응답 반환만 합니다.
- 금액 계산은 모두 Decimal 로 하고, 응답 직전에만 float 로 변환합니다. (margin.md §4.0)
- 현재 구현 범위: §3.2 Master Data 전체 + GET master (§8.2 0~1단계), Tab 1 수량별 단가 계산 (2단계)
"""

from datetime import datetime, timedelta, timezone
from decimal import ROUND_CEILING, ROUND_HALF_UP, Decimal, InvalidOperation

from flask import current_app, jsonify

KST = timezone(timedelta(hours=9), "KST")

# ---------------------------------------------------------------------------
# Master Data (margin.md §3.2) — 할인율 등은 모의 기준값입니다.
# ---------------------------------------------------------------------------

MARGIN_MOQ = 1500                        # 최소 발주 수량(ea) — 고정값
MARGIN_MAX_TIERS = 8                     # MOQ 행 포함
MARGIN_MAX_QTY = 1_000_000
MARGIN_MAX_TIER_INPUTS = 50              # 정규화 전 tiers 배열 최대 길이 (비정상 요청 차단)
DEFAULT_TIERS = [3000, 5000, 10000]
TIER_PRESETS = [3000, 5000, 10000]
DEFAULT_TARGET_MARGIN = Decimal("30")    # %
DEFAULT_MIN_MARGIN = Decimal("15")       # % (마진 방어선)
DEFAULT_FIXED_COST = Decimal("600000")   # 원/발주
DEFAULT_LOSS_RATE = Decimal("2")         # %
KRW_PRICE_ROUND_UNIT = Decimal("10")     # 원화 공급단가 올림 단위
MAX_TARGET_MARGIN = Decimal("80")        # %
HIGH_TARGET_MARGIN = Decimal("60")       # % 초과 시 경고
MAX_UNIT_COST = Decimal("1000000")       # 원/ea
MAX_FIXED_COST = Decimal("1000000000")   # 원/발주
MAX_LOSS_RATE = Decimal("30")            # %
MAX_OVERRIDE_PRICE = Decimal("10000000") # 원/ea
MARGIN_TOLERANCE = Decimal("0.0005")     # 목표 달성 판정 허용 오차 (0.05%p)

COST_COMPONENTS = [
    ("bulk", "벌크"),
    ("container", "용기"),
    ("packaging", "단상자·라벨·설명서"),
    ("processing", "충진·포장·검수"),
]

# 계단식: min_qty <= q 인 행 중 min_qty 가 가장 큰 행의 할인율(%)을 적용 (margin.md §3.2.2)
VOLUME_DISCOUNTS = [
    (1500,  {"bulk": 0,  "container": 0,  "packaging": 0,  "processing": 0}),
    (3000,  {"bulk": 3,  "container": 5,  "packaging": 5,  "processing": 8}),
    (5000,  {"bulk": 5,  "container": 8,  "packaging": 8,  "processing": 12}),
    (10000, {"bulk": 8,  "container": 12, "packaging": 12, "processing": 18}),
    (20000, {"bulk": 10, "container": 15, "packaging": 15, "processing": 22}),
    (50000, {"bulk": 12, "container": 18, "packaging": 18, "processing": 25}),
]

PRODUCT_CATEGORIES = [
    ("skincare", "스킨케어"),
    ("makeup", "메이크업"),
    ("haircare", "헤어케어"),
    ("bodycare", "바디케어"),
    ("suncare", "선케어"),
    ("etc", "기타"),
]

# 페이지 기본값 — Tab 2·3 (margin.md §3.2.1, §3.1.7, §6.4.4)
CARTON_ALLOWANCE_DEFAULT = Decimal("5")    # % 카톤 포장 여유율
AIR_VOLUMETRIC_DIVISOR = Decimal("6000")   # cm³/kg 항공 부피중량 환산
PI_VALIDITY_DAYS_DEFAULT = 30
PI_LEAD_TIME_DAYS_DEFAULT = 45
PI_HS_CODE_DEFAULT = "3304.99"
STRESS_STEPS = [-10, -5, 0, 5, 10]         # % 환율 변동 시나리오
COUNTER_QTY_SEARCH_MAX = 200_000
COUNTER_QTY_SEARCH_STEP = 500
LCL_SUGGEST_FCL_CBM = Decimal("15")        # LCL 이 이 CBM 을 넘으면 FCL 검토 경고
FCL_LOW_UTILIZATION = Decimal("0.6")       # FCL 적재율 경고 기준
HEAVY_CARTON_KG = Decimal("25")            # 카톤 중량 경고 기준

# 운송 방식 (margin.md §3.1.4) — port_loading 은 PI 선적항 기본값
TRANSPORT_MODES = {
    "SEA_LCL":   {"label": "해상 LCL",      "is_sea": True,  "port_loading": "Busan, Korea"},
    "SEA_FCL20": {"label": "해상 FCL 20ft", "is_sea": True,  "port_loading": "Busan, Korea"},
    "SEA_FCL40": {"label": "해상 FCL 40ft", "is_sea": True,  "port_loading": "Busan, Korea"},
    "AIR":       {"label": "항공",          "is_sea": False, "port_loading": "Incheon Airport, Korea"},
}

# 도착 권역 (margin.md §3.2.4)
REGIONS = {
    "US_WEST": {"label": "미국 서부",  "default_place": "Los Angeles, USA"},
    "US_EAST": {"label": "미국 동부",  "default_place": "New York, USA"},
    "EU":      {"label": "유럽",       "default_place": "Rotterdam, Netherlands"},
    "JP":      {"label": "일본",       "default_place": "Tokyo, Japan"},
    "CN":      {"label": "중국",       "default_place": "Shanghai, China"},
    "SEA":     {"label": "동남아",     "default_place": "Ho Chi Minh, Vietnam"},
    "ME":      {"label": "중동",       "default_place": "Dubai, UAE"},
    "OCEANIA": {"label": "오세아니아", "default_place": "Sydney, Australia"},
}

# Incoterms® 2020 — seller_pays 가 True 인 비용만 매도인 견적가에 포함 (margin.md §3.2.3)
# 해상 전용 조건의 항공 대응: FOB→FCA, CFR→CPT, CIF→CIP. DDP 는 범위 외라 제공하지 않습니다.
_PAYS_NONE = {"inland": False, "export_customs": False, "origin_local": False,
              "main_freight": False, "insurance": False, "dest_charges": False}


def _pays(**flags):
    return {**_PAYS_NONE, **flags}


INCOTERMS = {
    "EXW": {"sea_only": False, "air_equivalent": None, "min_insurance_clause": None,
            "seller_pays": _pays(),
            "help": "공장 인도. 모든 운송비를 바이어가 부담해요"},
    "FCA": {"sea_only": False, "air_equivalent": None, "min_insurance_clause": None,
            "seller_pays": _pays(inland=True, export_customs=True),
            "help": "지정 장소에서 운송인에게 인도해요"},
    "FOB": {"sea_only": True, "air_equivalent": "FCA", "min_insurance_clause": None,
            "seller_pays": _pays(inland=True, export_customs=True, origin_local=True),
            "help": "선적항 본선 적재까지 부담해요"},
    "CFR": {"sea_only": True, "air_equivalent": "CPT", "min_insurance_clause": None,
            "seller_pays": _pays(inland=True, export_customs=True, origin_local=True, main_freight=True),
            "help": "해상 운임까지 부담해요"},
    "CIF": {"sea_only": True, "air_equivalent": "CIP", "min_insurance_clause": "ICC_C",
            "seller_pays": _pays(inland=True, export_customs=True, origin_local=True, main_freight=True, insurance=True),
            "help": "운임과 적하보험까지 부담해요"},
    "CPT": {"sea_only": False, "air_equivalent": None, "min_insurance_clause": None,
            "seller_pays": _pays(inland=True, export_customs=True, origin_local=True, main_freight=True),
            "help": "목적지까지 운송비를 부담해요"},
    "CIP": {"sea_only": False, "air_equivalent": None, "min_insurance_clause": "ICC_A",
            "seller_pays": _pays(inland=True, export_customs=True, origin_local=True, main_freight=True, insurance=True),
            "help": "운송비와 적하보험(ICC(A))을 부담해요"},
    "DAP": {"sea_only": False, "air_equivalent": None, "min_insurance_clause": None,
            "seller_pays": _pays(inland=True, export_customs=True, origin_local=True, main_freight=True, dest_charges=True),
            "help": "목적지 도착 인도. 관세·부가세는 바이어가 부담해요"},
}

# 원화 부대비용 — 모의 기준값 (margin.md §3.2.4)
#   inland         내륙운송      base(원/건) + per_cbm / per_kg(C.W.) / per_container
#   export_customs 수출통관      원/건
#   origin_local   THC·CFS·DOC   per_rt / per_kg / per_container + fixed(원/건)
LOCAL_CHARGES_KRW = {
    "SEA_LCL": {
        "inland": {"base": Decimal("100000"), "per_cbm": Decimal("15000")},
        "export_customs": Decimal("30000"),
        "origin_local": {"per_rt": Decimal("25000"), "fixed": Decimal("40000")},
    },
    "SEA_FCL20": {
        "inland": {"per_container": Decimal("350000")},
        "export_customs": Decimal("30000"),
        "origin_local": {"per_container": Decimal("180000"), "fixed": Decimal("40000")},
    },
    "SEA_FCL40": {
        "inland": {"per_container": Decimal("450000")},
        "export_customs": Decimal("30000"),
        "origin_local": {"per_container": Decimal("250000"), "fixed": Decimal("40000")},
    },
    "AIR": {
        "inland": {"base": Decimal("80000"), "per_kg": Decimal("300")},
        "export_customs": Decimal("30000"),
        "origin_local": {"per_kg": Decimal("150"), "fixed": Decimal("40000")},
    },
}

# 주운임(USD) — 모의 기준값. LCL /RT(최소 1RT), FCL /컨테이너, AIR /kg C.W.(유류할증 포함) (margin.md §3.2.4)
MAIN_FREIGHT_USD = {
    "US_WEST": {"SEA_LCL": Decimal("85"),  "SEA_FCL20": Decimal("2400"), "SEA_FCL40": Decimal("3800"), "AIR": Decimal("4.2")},
    "US_EAST": {"SEA_LCL": Decimal("110"), "SEA_FCL20": Decimal("3600"), "SEA_FCL40": Decimal("5600"), "AIR": Decimal("4.8")},
    "EU":      {"SEA_LCL": Decimal("95"),  "SEA_FCL20": Decimal("2800"), "SEA_FCL40": Decimal("4400"), "AIR": Decimal("4.5")},
    "JP":      {"SEA_LCL": Decimal("45"),  "SEA_FCL20": Decimal("700"),  "SEA_FCL40": Decimal("1100"), "AIR": Decimal("2.2")},
    "CN":      {"SEA_LCL": Decimal("40"),  "SEA_FCL20": Decimal("500"),  "SEA_FCL40": Decimal("800"),  "AIR": Decimal("2.0")},
    "SEA":     {"SEA_LCL": Decimal("50"),  "SEA_FCL20": Decimal("650"),  "SEA_FCL40": Decimal("1050"), "AIR": Decimal("2.4")},
    "ME":      {"SEA_LCL": Decimal("90"),  "SEA_FCL20": Decimal("1900"), "SEA_FCL40": Decimal("3000"), "AIR": Decimal("3.6")},
    "OCEANIA": {"SEA_LCL": Decimal("95"),  "SEA_FCL20": Decimal("1600"), "SEA_FCL40": Decimal("2600"), "AIR": Decimal("4.0")},
}
MAIN_FREIGHT_MINIMUM = {
    "SEA_LCL": {"min_rt": Decimal("1")},     # 최소 1RT 부과
    "AIR": {"min_usd": Decimal("80")},       # 최소 운임 $80
}

# 도착지 비용(USD, DAP 전용) — 권역 공통 (margin.md §3.2.4)
DEST_CHARGES_USD = {
    "SEA_LCL": {"per_rt": Decimal("45"), "fixed": Decimal("120")},
    "SEA_FCL20": {"per_container": Decimal("450")},
    "SEA_FCL40": {"per_container": Decimal("450")},
    "AIR": {"per_kg": Decimal("0.6"), "fixed": Decimal("80")},
}

# 컨테이너 적재 한도 (margin.md §3.2.4)
CONTAINER_SPECS = {
    "SEA_FCL20": {"cbm": Decimal("28"), "kg": Decimal("21000")},
    "SEA_FCL40": {"cbm": Decimal("58"), "kg": Decimal("26000")},
}

# 적하보험 요율(%) — 부보 금액 = CIF(CIP) 가액 × 110% (margin.md §3.2.4, §4.3.3)
INSURANCE_RATES = {
    "ICC_A": {"label": "ICC(A) 전위험 담보", "rate_pct": Decimal("0.10")},
    "ICC_C": {"label": "ICC(C) 최소 담보",   "rate_pct": Decimal("0.05")},
}
INSURANCE_COVERAGE = Decimal("1.1")

# 통화 (margin.md §3.2.5)
#   exim_unit        한국수출입은행 cur_unit 값
#   exim_divisor     JPY(100) 처럼 100 단위 고시 통화는 100 으로 나눠 "1 단위당 KRW" 로 정규화
#   fallback_krw     모든 외부 소스 실패 시 쓰는 모의 기준 환율(1 단위당 KRW)
CURRENCIES = {
    "USD": {"name": "US Dollar",         "symbol": "$",   "exim_unit": "USD",      "exim_divisor": 1,   "price_decimals": 3, "amount_decimals": 2, "fallback_krw": Decimal("1380.00"), "words": "US DOLLARS"},
    "EUR": {"name": "Euro",              "symbol": "€",   "exim_unit": "EUR",      "exim_divisor": 1,   "price_decimals": 3, "amount_decimals": 2, "fallback_krw": Decimal("1510.00"), "words": "EUROS"},
    "JPY": {"name": "Japanese Yen",      "symbol": "¥",   "exim_unit": "JPY(100)", "exim_divisor": 100, "price_decimals": 1, "amount_decimals": 0, "fallback_krw": Decimal("9.40"),    "words": "JAPANESE YEN"},
    "CNY": {"name": "Chinese Yuan",      "symbol": "¥",   "exim_unit": "CNH",      "exim_divisor": 1,   "price_decimals": 3, "amount_decimals": 2, "fallback_krw": Decimal("191.00"),  "words": "CHINESE YUAN"},
    "GBP": {"name": "British Pound",     "symbol": "£",   "exim_unit": "GBP",      "exim_divisor": 1,   "price_decimals": 3, "amount_decimals": 2, "fallback_krw": Decimal("1800.00"), "words": "POUNDS STERLING"},
    "HKD": {"name": "Hong Kong Dollar",  "symbol": "HK$", "exim_unit": "HKD",      "exim_divisor": 1,   "price_decimals": 3, "amount_decimals": 2, "fallback_krw": Decimal("177.00"),  "words": "HONG KONG DOLLARS"},
    "SGD": {"name": "Singapore Dollar",  "symbol": "S$",  "exim_unit": "SGD",      "exim_divisor": 1,   "price_decimals": 3, "amount_decimals": 2, "fallback_krw": Decimal("1060.00"), "words": "SINGAPORE DOLLARS"},
    "AUD": {"name": "Australian Dollar", "symbol": "A$",  "exim_unit": "AUD",      "exim_divisor": 1,   "price_decimals": 3, "amount_decimals": 2, "fallback_krw": Decimal("900.00"),  "words": "AUSTRALIAN DOLLARS"},
    "CAD": {"name": "Canadian Dollar",   "symbol": "C$",  "exim_unit": "CAD",      "exim_divisor": 1,   "price_decimals": 3, "amount_decimals": 2, "fallback_krw": Decimal("1010.00"), "words": "CANADIAN DOLLARS"},
    "THB": {"name": "Thai Baht",         "symbol": "฿",   "exim_unit": "THB",      "exim_divisor": 1,   "price_decimals": 2, "amount_decimals": 2, "fallback_krw": Decimal("41.50"),   "words": "THAI BAHT"},
}
FALLBACK_FX_KRW = {code: c["fallback_krw"] for code, c in CURRENCIES.items()}
FALLBACK_FX_AS_OF = "2026-09-01"           # 모의 기준 환율 기준일 (표시용)

# 환율 외부 연동 (margin.md §6.3) — Key·Timeout·TTL 은 호출 시점에 os.getenv() 로 읽습니다.
KOREAEXIM_FX_URL = "https://oapi.koreaexim.go.kr/site/program/financial/exchangeJSON"
OPEN_ER_API_URL_DEFAULT = "https://open.er-api.com/v6/latest/USD"
FX_CACHE_TTL_MIN_DEFAULT = 60
FX_TIMEOUT_SEC_DEFAULT = 5
FX_LOOKBACK_DAYS = 7                       # 비영업일 역조회 최대 일수
FX_STALE_DAYS = 3                          # 캐시가 이보다 오래되면 stale
FX_FORCE_MIN_INTERVAL_SEC = 60             # force=1 재요청 최소 간격
TTB_ESTIMATE_SPREAD = Decimal("0.01")      # TTB 미제공 소스: base × (1 − 0.01)

# 결제 조건 (margin.md §3.2.6)
PAYMENT_TERMS = {
    "TT_30_70":    {"label": "T/T 30% 선금 / 70% 선적 전",          "deposit_pct": Decimal("30"),
                    "pi_text": "T/T 30% deposit with order, 70% balance before shipment"},
    "TT_30_70_BL": {"label": "T/T 30% 선금 / 70% B/L 사본 수령 후", "deposit_pct": Decimal("30"),
                    "pi_text": "T/T 30% deposit with order, 70% balance against copy of B/L"},
    "TT_50_50":    {"label": "T/T 50% / 50%",                       "deposit_pct": Decimal("50"),
                    "pi_text": "T/T 50% deposit with order, 50% balance before shipment"},
    "TT_100":      {"label": "T/T 100% 선불",                       "deposit_pct": Decimal("100"),
                    "pi_text": "T/T 100% in advance"},
    "LC_SIGHT":    {"label": "일람불 L/C",                          "deposit_pct": Decimal("0"),
                    "pi_text": "Irrevocable L/C at sight"},
}
DEFAULT_PAYMENT_TERMS = "TT_30_70"

# PI 표준 약관 — 템플릿에서 순서대로 format() 해서 출력 (margin.md §3.2.7)
PI_STANDARD_TERMS = [
    "Validity: This quotation is valid until {validity_date}.",
    "Lead time: {lead_time_days} days after receipt of deposit and final artwork approval.",
    "Quantity tolerance: ±10% of the ordered quantity may be shipped and invoiced accordingly.",
    "Minimum order quantity: {moq} pcs per SKU.",
    "Bank charges: All bank charges outside Korea are for the buyer's account.",
    "Shelf life: 36 months from the date of manufacture (unopened).",
    "Prices are quoted {incoterm} {named_place} (Incoterms® 2020) in {currency}.",
]


def _require(condition, what):
    if not condition:
        raise ValueError(f"margin master data 오류: {what}")


def _validate_master():
    """마스터 데이터 정합성 검사 — 값을 잘못 바꾸면 import 시점에 바로 실패합니다."""
    for code, term in INCOTERMS.items():
        _require(term["air_equivalent"] in (None, *INCOTERMS), f"INCOTERMS[{code}].air_equivalent")
        _require(term["min_insurance_clause"] in (None, *INSURANCE_RATES), f"INCOTERMS[{code}].min_insurance_clause")
    for region, rates in MAIN_FREIGHT_USD.items():
        _require(region in REGIONS and set(rates) == set(TRANSPORT_MODES), f"MAIN_FREIGHT_USD[{region}]")
    _require(set(LOCAL_CHARGES_KRW) == set(TRANSPORT_MODES) == set(DEST_CHARGES_USD), "운송 방식 키 불일치")
    for clause, item in INSURANCE_RATES.items():
        # CIF 가액 = B / (1 − 1.1 × r) 의 분모가 양수여야 합니다 (margin.md §4.3.3)
        _require(1 - INSURANCE_COVERAGE * item["rate_pct"] / 100 > 0, f"INSURANCE_RATES[{clause}]")
    _require([q for q, _ in VOLUME_DISCOUNTS] == sorted(q for q, _ in VOLUME_DISCOUNTS), "VOLUME_DISCOUNTS 정렬")
    _require(VOLUME_DISCOUNTS[0][0] == MARGIN_MOQ, "VOLUME_DISCOUNTS 첫 행은 MOQ")
    _require(DEFAULT_PAYMENT_TERMS in PAYMENT_TERMS, "DEFAULT_PAYMENT_TERMS")


_validate_master()

# ---------------------------------------------------------------------------
# 예외
# ---------------------------------------------------------------------------


class MarginValidationError(Exception):
    """입력 검증 실패 → HTTP 422. fields 에 필드별 메시지를 모두 담습니다."""

    def __init__(self, code, message, fields=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.fields = fields or {}


class MarginNotFoundError(Exception):
    """조회 대상 없음 → HTTP 404."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


class _Errors:
    """검증 오류 수집기. 첫 오류의 code/message 를 대표값으로 사용합니다."""

    def __init__(self):
        self.code = None
        self.message = None
        self.fields = {}

    def add(self, code, field, message):
        if self.code is None:
            self.code, self.message = code, message
        self.fields.setdefault(field, message)

    def raise_if_any(self):
        if self.code:
            raise MarginValidationError(self.code, self.message, self.fields)


# ---------------------------------------------------------------------------
# 유틸
# ---------------------------------------------------------------------------


def _parse_decimal(value):
    """JSON 값 → Decimal. 숫자가 아니면 None."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, str):
        value = value.replace(",", "").strip()
        if not value:
            return None
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    return result if result.is_finite() else None


def to_decimal(value, field, errors, *, label, min_value=None, max_value=None, required=True, default=None):
    """숫자 입력 검증 후 Decimal 반환. 오류는 errors 에 수집하고 None 반환."""
    if value is None or value == "":
        if default is not None:
            return default
        if required:
            errors.add("REQUIRED_FIELD", field, f"{label}을(를) 입력해 주세요")
        return None
    number = _parse_decimal(value)
    if number is None:
        errors.add("OUT_OF_RANGE", field, f"{label}은(는) 숫자로 입력해 주세요")
        return None
    if (min_value is not None and number < min_value) or (max_value is not None and number > max_value):
        errors.add("OUT_OF_RANGE", field, f"{label}은(는) {_fmt(min_value)}~{_fmt(max_value)} 사이로 입력해 주세요")
        return None
    return number


def to_quantity(value):
    """수량 입력 → int. 정수가 아니면 None."""
    number = _parse_decimal(value)
    if number is None or number != number.to_integral_value():
        return None
    return int(number)


def ceil_to(value, unit):
    """unit 단위 올림. 예: ceil_to(3041.43, 10) → 3050"""
    return (value / unit).to_integral_value(rounding=ROUND_CEILING) * unit


def pct(value):
    """% → 소수. 예: 30 → 0.30"""
    return value / Decimal(100)


def round_to(value, places):
    """소수 places 자리 반올림(ROUND_HALF_UP). 외화 금액·응답 정리용. 예: round_to(9380.004, 2) → 9380.00"""
    return Decimal(value).quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP)


def now_kst():
    """현재 시각(KST, UTC+9). tzdata 없는 Windows 환경도 고려해 고정 오프셋을 씁니다."""
    return datetime.now(KST)


def out(value, places=2):
    """응답 직렬화용 반올림 후 float."""
    return float(round_to(value, places))


def _fmt(value):
    if value is None:
        return ""
    return f"{value:,.0f}" if value == value.to_integral_value() else f"{value:,}"


def _error_body(code, message, fields=None):
    return {"ok": False, "error": {"code": code, "message": message, "fields": fields or {}}}


def handle(fn, payload=None, *, needs_payload=True):
    """service 함수 실행 후 (Response, status) 반환. 공통 에러 → HTTP 매핑 (margin.md §6.5)"""
    if needs_payload and not isinstance(payload, dict):
        return jsonify(_error_body("INVALID_JSON", "요청 형식이 올바르지 않아요")), 400
    try:
        data, warnings = fn(payload) if needs_payload else fn()
    except MarginValidationError as exc:
        return jsonify(_error_body(exc.code, exc.message, exc.fields)), 422
    except MarginNotFoundError as exc:
        return jsonify(_error_body(exc.code, exc.message)), 404
    except Exception:  # noqa: BLE001 — 내부 오류는 로그만 남기고 메시지는 숨깁니다
        current_app.logger.exception("margin service error")
        return jsonify(_error_body("INTERNAL_ERROR", "계산 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요")), 500
    return jsonify({"ok": True, "data": data, "warnings": warnings}), 200


# ---------------------------------------------------------------------------
# Master
# ---------------------------------------------------------------------------


def _num(value):
    """마스터 응답 직렬화용 — Decimal 을 JSON number 로 (계산에는 쓰지 않음)."""
    return float(value) if isinstance(value, Decimal) else value


def get_master_data():
    """GET /api/margin-calculator/master — 마스터 데이터·기본값 (margin.md §6.4.1)"""
    data = {
        "defaults": {
            "moq": MARGIN_MOQ,
            "tiers": DEFAULT_TIERS,
            "tier_presets": TIER_PRESETS,
            "target_margin": _num(DEFAULT_TARGET_MARGIN),
            "min_margin": _num(DEFAULT_MIN_MARGIN),
            "max_target_margin": _num(MAX_TARGET_MARGIN),
            "fixed_cost": _num(DEFAULT_FIXED_COST),
            "loss_rate": _num(DEFAULT_LOSS_RATE),
            "carton_allowance": _num(CARTON_ALLOWANCE_DEFAULT),
            "max_tiers": MARGIN_MAX_TIERS,
            "max_qty": MARGIN_MAX_QTY,
            "max_unit_cost": _num(MAX_UNIT_COST),
            "krw_round_unit": _num(KRW_PRICE_ROUND_UNIT),
            "pi_validity_days": PI_VALIDITY_DAYS_DEFAULT,
            "pi_lead_time_days": PI_LEAD_TIME_DAYS_DEFAULT,
            "hs_code": PI_HS_CODE_DEFAULT,
            "payment_terms": DEFAULT_PAYMENT_TERMS,
            "stress_steps": STRESS_STEPS,
        },
        "volume_discounts": [{"min_qty": q, "rates": rates} for q, rates in VOLUME_DISCOUNTS],
        "cost_components": [{"key": k, "label": label} for k, label in COST_COMPONENTS],
        "incoterms": [
            {"code": code, "sea_only": t["sea_only"], "air_equivalent": t["air_equivalent"],
             "min_insurance_clause": t["min_insurance_clause"], "seller_pays": t["seller_pays"], "help": t["help"]}
            for code, t in INCOTERMS.items()
        ],
        "transport_modes": [
            {"code": code, "label": m["label"], "is_sea": m["is_sea"], "port_loading": m["port_loading"]}
            for code, m in TRANSPORT_MODES.items()
        ],
        "regions": [
            {"code": code, "label": r["label"], "default_place": r["default_place"]}
            for code, r in REGIONS.items()
        ],
        "currencies": [
            {"code": code, "name": c["name"], "symbol": c["symbol"],
             "price_decimals": c["price_decimals"], "amount_decimals": c["amount_decimals"]}
            for code, c in CURRENCIES.items()
        ],
        "payment_terms": [
            {"code": code, "label": t["label"], "deposit_pct": _num(t["deposit_pct"]), "pi_text": t["pi_text"]}
            for code, t in PAYMENT_TERMS.items()
        ],
        "insurance_clauses": [
            {"code": code, "label": i["label"], "rate_pct": _num(i["rate_pct"])}
            for code, i in INSURANCE_RATES.items()
        ],
        "categories": [{"code": c, "label": label} for c, label in PRODUCT_CATEGORIES],
        "is_mock_rates": True,
    }
    return data, []


# ---------------------------------------------------------------------------
# Tab 1 — 원가 및 수량 구간 단가 (margin.md §4.2)
# ---------------------------------------------------------------------------


def get_discount_rates(qty):
    """수량 q 의 요소별 할인율(%). min_qty <= q 중 가장 큰 기준 적용. 수식 §4.2.1"""
    rates = VOLUME_DISCOUNTS[0][1]
    for min_qty, row in VOLUME_DISCOUNTS:
        if qty >= min_qty:
            rates = row
        else:
            break
    return {key: Decimal(value) for key, value in rates.items()}


def calc_unit_cost(cost, qty):
    """총 제조원가 C(q)와 구성. 수식 §4.2.2"""
    d = get_discount_rates(qty)
    bulk = cost["bulk"] * (1 - pct(d["bulk"]))
    container = cost["container"] * (1 - pct(d["container"]))
    packaging = cost["packaging"] * (1 - pct(d["packaging"]))
    material_base = bulk + container + packaging
    loss = material_base * pct(cost["loss_rate"])
    material = material_base + loss
    processing = cost["processing"] * (1 - pct(d["processing"]))
    fixed = cost["fixed_per_order"] / Decimal(qty)
    return {
        "discounts": d,
        "bulk": bulk,
        "container": container,
        "packaging": packaging,
        "loss": loss,
        "material": material,
        "processing": processing,
        "fixed": fixed,
        "unit_cost": material + processing + fixed,
    }


def calc_supply_price(unit_cost, target_margin, override=None):
    """제안 공급단가 P(q) (10원 올림) 및 수동 단가 적용. 수식 §4.2.3"""
    suggested = ceil_to(unit_cost / (1 - pct(target_margin)), KRW_PRICE_ROUND_UNIT)
    price = override if override is not None else suggested
    return {"suggested": suggested, "price": price, "is_overridden": override is not None}


def classify_margin(rate, target, minimum):
    """마진 상태 판정 (rate·target·minimum 은 소수). 수식 §4.2.5"""
    if rate < 0:
        return "negative"
    if rate < minimum:
        return "below_defense"
    if rate < target - MARGIN_TOLERANCE:
        return "below_target"
    return "ok"


def normalize_tiers(tiers, moq, errors):
    """tiers 검증 → MOQ 포함·중복 제거·오름차순 정렬. 규칙 §3.1.3, §7.1"""
    if tiers is None:
        tiers = []
    if not isinstance(tiers, list):
        errors.add("OUT_OF_RANGE", "tiers", "수량 구간 형식이 올바르지 않아요")
        return [moq]
    if len(tiers) > MARGIN_MAX_TIER_INPUTS:
        errors.add("TOO_MANY_TIERS", "tiers", f"수량 구간은 MOQ 포함 최대 {MARGIN_MAX_TIERS}개까지 비교할 수 있어요")
        return [moq]

    result = {moq}
    for index, raw in enumerate(tiers):
        field = f"tiers[{index}]"
        qty = to_quantity(raw)
        if qty is None:
            errors.add("OUT_OF_RANGE", field, "수량은 정수로 입력해 주세요")
        elif qty < moq:
            errors.add("MOQ_VIOLATION", field, f"{qty:,}ea는 MOQ({moq:,}ea) 미만이에요")
        elif qty > MARGIN_MAX_QTY:
            errors.add("OUT_OF_RANGE", field, f"수량은 최대 {MARGIN_MAX_QTY:,}ea까지 입력할 수 있어요")
        else:
            result.add(qty)

    if len(result) > MARGIN_MAX_TIERS:
        errors.add("TOO_MANY_TIERS", "tiers", f"수량 구간은 MOQ 포함 최대 {MARGIN_MAX_TIERS}개까지 비교할 수 있어요")
    return sorted(result)


def validate_tier_request(payload):
    """calculate-tiers 요청 검증 → 정규화된 입력. 필드별 오류를 모두 모아 한 번에 던집니다."""
    errors = _Errors()

    # MOQ 는 1,500ea 고정 (margin.md §3.1.2)
    moq = MARGIN_MOQ
    raw_moq = payload.get("moq")
    if raw_moq is not None:
        given = to_quantity(raw_moq)
        if given is None or given < MARGIN_MOQ:
            errors.add("MOQ_BELOW_MINIMUM", "moq", f"MOQ는 {MARGIN_MOQ:,}ea 미만으로 설정할 수 없어요")
        elif given != MARGIN_MOQ:
            errors.add("MOQ_FIXED", "moq", f"MOQ는 {MARGIN_MOQ:,}ea로 고정돼요")

    raw_cost = payload.get("cost") if isinstance(payload.get("cost"), dict) else {}
    cost = {}
    for key, label in COST_COMPONENTS:
        cost[key] = to_decimal(raw_cost.get(key), f"cost.{key}", errors, label=label,
                               min_value=Decimal(0), max_value=MAX_UNIT_COST)
    cost["fixed_per_order"] = to_decimal(raw_cost.get("fixed_per_order"), "cost.fixed_per_order", errors,
                                         label="1회 고정비", min_value=Decimal(0), max_value=MAX_FIXED_COST,
                                         default=DEFAULT_FIXED_COST)
    cost["loss_rate"] = to_decimal(raw_cost.get("loss_rate"), "cost.loss_rate", errors, label="로스율",
                                   min_value=Decimal(0), max_value=MAX_LOSS_RATE, default=DEFAULT_LOSS_RATE)
    component_values = [cost[key] for key, _ in COST_COMPONENTS]
    if all(v is not None for v in component_values) and sum(component_values) == 0:
        errors.add("ZERO_COST", "cost", "원가를 1개 이상 입력해 주세요")

    target = to_decimal(payload.get("target_margin"), "target_margin", errors, label="목표 마진율",
                        min_value=Decimal(0), max_value=MAX_TARGET_MARGIN, default=DEFAULT_TARGET_MARGIN)
    minimum = to_decimal(payload.get("min_margin"), "min_margin", errors, label="마진 방어선",
                         min_value=Decimal(0), max_value=MAX_TARGET_MARGIN, default=DEFAULT_MIN_MARGIN)
    if target is not None and minimum is not None and minimum > target:
        errors.add("INVALID_MARGIN", "min_margin", "방어선은 목표 마진보다 클 수 없어요")

    tiers = normalize_tiers(payload.get("tiers"), moq, errors)

    overrides = {}
    raw_overrides = payload.get("price_overrides") or {}
    if not isinstance(raw_overrides, dict):
        errors.add("OUT_OF_RANGE", "price_overrides", "수동 단가 형식이 올바르지 않아요")
        raw_overrides = {}
    for raw_qty, raw_price in raw_overrides.items():
        qty = to_quantity(raw_qty)
        if qty is None or qty not in tiers or raw_price in (None, ""):
            continue  # 삭제된 구간의 수동 단가는 무시
        price = to_decimal(raw_price, f"price_overrides.{qty}", errors, label="공급단가",
                           min_value=Decimal("0.01"), max_value=MAX_OVERRIDE_PRICE)
        if price is not None:
            overrides[qty] = price

    errors.raise_if_any()
    product = payload.get("product") if isinstance(payload.get("product"), dict) else {}
    return {
        "product": product,
        "cost": cost,
        "moq": moq,
        "target_margin": target,
        "min_margin": minimum,
        "tiers": tiers,
        "price_overrides": overrides,
    }


def calculate_tiers(payload):
    """POST /api/margin-calculator/calculate-tiers — 수량 구간별 단가·마진 일괄 계산 (§6.4.3)"""
    req = validate_tier_request(payload)
    target, minimum = req["target_margin"], req["min_margin"]
    target_f, minimum_f = pct(target), pct(minimum)
    warnings = []
    if target > HIGH_TARGET_MARGIN:
        warnings.append({"code": "HIGH_TARGET_MARGIN",
                         "message": f"목표 마진이 {_fmt(HIGH_TARGET_MARGIN)}%를 넘어요. 시장 단가와 비교해 주세요"})

    moq_cost = calc_unit_cost(req["cost"], req["moq"])
    moq_price = calc_supply_price(moq_cost["unit_cost"], target, req["price_overrides"].get(req["moq"]))["price"]

    rows = []
    for qty in req["tiers"]:
        c = calc_unit_cost(req["cost"], qty)
        p = calc_supply_price(c["unit_cost"], target, req["price_overrides"].get(qty))
        unit_cost, price = c["unit_cost"], p["price"]
        unit_margin = price - unit_cost
        rate = unit_margin / price
        status = classify_margin(rate, target_f, minimum_f)
        if p["is_overridden"] and status == "negative":
            warnings.append({"code": "OVERRIDE_NEGATIVE_MARGIN", "qty": qty,
                             "message": f"{qty:,}ea 구간이 역마진이에요. 단가를 다시 확인해 주세요"})
        elif p["is_overridden"] and status == "below_defense":
            warnings.append({"code": "OVERRIDE_BELOW_DEFENSE", "qty": qty,
                             "message": f"{qty:,}ea 구간이 마진 방어선({_fmt(minimum)}%) 아래예요"})
        rows.append({
            "qty": qty,
            "is_moq": qty == req["moq"],
            "discounts": {k: float(v) for k, v in c["discounts"].items()},
            "breakdown": {k: out(c[k]) for k in ("bulk", "container", "packaging", "loss", "material", "processing", "fixed")},
            "unit_cost": out(unit_cost),
            "suggested_price": out(p["suggested"]),
            "supply_price": out(price),
            "is_overridden": p["is_overridden"],
            "unit_margin": out(unit_margin),
            "total_margin": out(unit_margin * qty),
            "margin_rate": out(rate * 100),
            "total_sales": out(price * qty),
            "cost_saving_vs_moq": out((moq_cost["unit_cost"] - unit_cost) / moq_cost["unit_cost"] * 100),
            "price_cut_vs_moq": out((moq_price - price) / moq_price * 100),
            "status": status,
        })

    data = {
        "moq": req["moq"],
        "target_margin": float(target),
        "min_margin": float(minimum),
        "tiers": req["tiers"],
        "rows": rows,
        "chart": {
            "labels": [f"{row['qty']:,}" for row in rows],
            "qty": [row["qty"] for row in rows],
            "unit_cost": [row["unit_cost"] for row in rows],
            "supply_price": [row["supply_price"] for row in rows],
            "margin_rate": [row["margin_rate"] for row in rows],
            "status": [row["status"] for row in rows],
        },
        "summary": {
            "has_negative": any(row["status"] == "negative" for row in rows),
            "has_below_defense": any(row["status"] == "below_defense" for row in rows),
        },
    }
    return data, warnings
