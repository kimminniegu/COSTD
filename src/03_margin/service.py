"""원가 경쟁력 및 마진 시뮬레이션 비즈니스 로직 (담당자 C).

기능 명세: src/03_margin/margin.md
- app.py 의 Route 는 입력 추출 → 이 모듈 호출 → 응답 반환만 합니다.
- 금액 계산은 모두 Decimal 로 하고, 응답 직전에만 float 로 변환합니다. (margin.md §4.0)
- 현재 구현 범위: Master Data·GET master (§8.2 0~1단계), Tab 1 수량별 단가·마진 (2단계),
  Tab 2 물류·인코텀즈·환율·스트레스·역제안 (3~5단계), Tab 3 PI 미리보기·PDF (10~11단계)
"""

import io
import json
import logging
import os
import re
import threading
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from decimal import ROUND_CEILING, ROUND_HALF_UP, Decimal, InvalidOperation
from email.utils import parsedate_to_datetime
from pathlib import Path

from flask import Response, current_app, jsonify

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


def to_decimal(value, field, errors, *, label, min_value=None, max_value=None, required=True, default=None,
               range_code="OUT_OF_RANGE"):
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
        errors.add(range_code, field, f"{label}은(는) {_fmt(min_value)}~{_fmt(max_value)} 사이로 입력해 주세요")
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


def calc_supply_price(unit_cost, target_margin, override=None, qty=1):
    """제안 공급단가 P(q)(10원 올림)·수동 단가 적용과 마진 지표. 수식 §4.2.3

    margin_rate 는 판매가 대비 이익률(소수)입니다: (P − C) / P
    """
    suggested = ceil_to(unit_cost / (1 - pct(target_margin)), KRW_PRICE_ROUND_UNIT)
    price = override if override is not None else suggested
    unit_margin = price - unit_cost
    return {
        "suggested": suggested,
        "price": price,
        "is_overridden": override is not None,
        "unit_margin": unit_margin,              # G(q)  원/ea
        "total_margin": unit_margin * qty,       # G_total(q)
        "margin_rate": unit_margin / price,      # g(q)
        "total_sales": price * qty,              # S(q)
    }


def classify_margin(rate, target, minimum):
    """마진 상태 판정 (rate·target·minimum 은 소수). 수식 §4.2.5"""
    if rate < 0:
        return "negative"
    if rate < minimum:
        return "below_defense"
    if rate < target - MARGIN_TOLERANCE:
        return "below_target"
    return "ok"


def normalize_tiers(tiers, moq, errors=None):
    """tiers 검증 → MOQ 포함·중복 제거·오름차순 정렬. 규칙 §3.1.3, §7.1

    errors 를 주면 오류를 모으기만 하고, 생략하면 오류 시 MarginValidationError 를 던집니다.
    """
    if errors is None:
        errors = _Errors()
        result = normalize_tiers(tiers, moq, errors)
        errors.raise_if_any()
        return result
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
                        min_value=Decimal(0), max_value=MAX_TARGET_MARGIN, default=DEFAULT_TARGET_MARGIN,
                        range_code="INVALID_MARGIN")
    minimum = to_decimal(payload.get("min_margin"), "min_margin", errors, label="마진 방어선",
                         min_value=Decimal(0), max_value=MAX_TARGET_MARGIN, default=DEFAULT_MIN_MARGIN,
                         range_code="INVALID_MARGIN")
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
        p = calc_supply_price(c["unit_cost"], target, req["price_overrides"].get(qty), qty)
        unit_cost, price, rate = c["unit_cost"], p["price"], p["margin_rate"]
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
            "unit_margin": out(p["unit_margin"]),
            "total_margin": out(p["total_margin"]),
            "margin_rate": out(rate * 100),
            "total_sales": out(p["total_sales"]),
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
            "unit_margin": [row["unit_margin"] for row in rows],
            "margin_rate": [row["margin_rate"] for row in rows],
            "status": [row["status"] for row in rows],
        },
        "summary": {
            "has_negative": any(row["status"] == "negative" for row in rows),
            "has_below_defense": any(row["status"] == "below_defense" for row in rows),
        },
    }
    return data, warnings


# ---------------------------------------------------------------------------
# Tab 2 — CBM · 물류비 · 인코텀즈 (margin.md §4.3)
# ---------------------------------------------------------------------------

COST_LABELS = {
    "inland": "내륙운송",
    "export_customs": "수출통관",
    "origin_local": "선적지 부대비용",
    "main_freight": "운임",
    "insurance": "적하보험료",
    "dest_charges": "도착지 비용",
}
MAX_CARTON_CM = Decimal("200")
MAX_CARTON_KG = Decimal("100")
MAX_UNITS_PER_CARTON = 10_000
MAX_CARTON_ALLOWANCE = Decimal("50")
MAX_FX_RATE = Decimal("100000")
MAX_NAMED_PLACE_LEN = 60


def _ceil_int(value):
    """Decimal 올림 → int"""
    return int(Decimal(value).to_integral_value(rounding=ROUND_CEILING))


def _enum(value, allowed, field, errors, label):
    if value not in allowed:
        errors.add("OUT_OF_RANGE", field, f"{label} 값이 올바르지 않아요")
        return None
    return value


def calc_packing(carton, qty, mode):
    """카톤 수·CBM·중량·RT·청구중량·컨테이너 수. 수식 §4.3.1"""
    dims = carton["length_cm"] * carton["width_cm"] * carton["height_cm"]
    allowance = 1 + pct(carton["allowance_rate"])
    upc = carton["units_per_carton"]
    cartons = _ceil_int(Decimal(qty) / upc)
    carton_cbm = dims / Decimal(1_000_000)
    cbm_raw = carton_cbm * cartons
    cbm = cbm_raw * allowance
    gross = carton["gross_weight_kg"] * cartons
    packing = {
        "cartons": cartons,
        "carton_cbm": carton_cbm,
        "cbm_raw": cbm_raw,
        "cbm": cbm,
        "gross_weight_kg": gross,
        "revenue_ton": None,
        "volumetric_kg": None,
        "chargeable_kg": None,
        "containers": None,
        "utilization": None,
        "last_carton_units": qty - (cartons - 1) * upc,
    }
    if mode == "AIR":
        volumetric = dims / AIR_VOLUMETRIC_DIVISOR * cartons * allowance
        packing["volumetric_kg"] = volumetric
        packing["chargeable_kg"] = max(gross, volumetric)
    else:
        packing["revenue_ton"] = max(cbm, gross / Decimal(1000))
    if mode in CONTAINER_SPECS:
        spec = CONTAINER_SPECS[mode]
        containers = max(_ceil_int(cbm / spec["cbm"]), _ceil_int(gross / spec["kg"]), 1)
        packing["containers"] = containers
        packing["utilization"] = cbm / (spec["cbm"] * containers)
    return packing


def calc_logistics_costs(packing, mode, region, usd_rate):
    """운송 방식별 물류비 항목(부담 주체 적용 전). 수식 §4.3.2"""
    local = LOCAL_CHARGES_KRW[mode]
    freight_rate = MAIN_FREIGHT_USD[region][mode]
    dest = DEST_CHARGES_USD[mode]

    if mode == "SEA_LCL":
        rt = packing["revenue_ton"]
        inland = local["inland"]["base"] + local["inland"]["per_cbm"] * packing["cbm"]
        origin = local["origin_local"]["per_rt"] * rt + local["origin_local"]["fixed"]
        freight = freight_rate * max(rt, MAIN_FREIGHT_MINIMUM["SEA_LCL"]["min_rt"])
        dest_usd = dest["per_rt"] * rt + dest["fixed"]
    elif mode in CONTAINER_SPECS:
        n = packing["containers"]
        inland = local["inland"]["per_container"] * n
        origin = local["origin_local"]["per_container"] * n + local["origin_local"]["fixed"]
        freight = freight_rate * n
        dest_usd = dest["per_container"] * n
    else:  # AIR
        cw = packing["chargeable_kg"]
        inland = local["inland"]["base"] + local["inland"]["per_kg"] * cw
        origin = local["origin_local"]["per_kg"] * cw + local["origin_local"]["fixed"]
        freight = max(freight_rate * cw, MAIN_FREIGHT_MINIMUM["AIR"]["min_usd"])
        dest_usd = dest["per_kg"] * cw + dest["fixed"]

    freight_label = "항공 운임" if mode == "AIR" else "해상 운임"
    return [
        {"key": "inland", "label": COST_LABELS["inland"], "currency": "KRW", "amount": inland, "krw": inland},
        {"key": "export_customs", "label": COST_LABELS["export_customs"], "currency": "KRW",
         "amount": local["export_customs"], "krw": local["export_customs"]},
        {"key": "origin_local", "label": COST_LABELS["origin_local"], "currency": "KRW", "amount": origin, "krw": origin},
        {"key": "main_freight", "label": freight_label, "currency": "USD", "amount": freight, "krw": freight * usd_rate},
        {"key": "dest_charges", "label": COST_LABELS["dest_charges"], "currency": "USD", "amount": dest_usd,
         "krw": dest_usd * usd_rate},
    ]


def resolve_incoterm(incoterm, mode):
    """항공 + 해상 전용 조건(FOB·CFR·CIF) → FCA·CPT·CIP 로 변환. (effective, warnings)"""
    term = INCOTERMS[incoterm]
    if mode == "AIR" and term["sea_only"]:
        effective = term["air_equivalent"]
        return effective, [{"code": "SEA_ONLY_TERM_ON_AIR",
                            "message": f"{incoterm}는 해상 전용 조건이라 항공은 {effective} 기준으로 계산했어요"}]
    return incoterm, []


def resolve_insurance_clause(incoterm, clause):
    """보험 조건 확정. CIP 는 ICC(A) 필수, CIF 는 ICC(C) 이상. (clause | None, warnings)"""
    if not INCOTERMS[incoterm]["seller_pays"]["insurance"]:
        return None, []
    minimum = INCOTERMS[incoterm]["min_insurance_clause"]
    clause = clause if clause in INSURANCE_RATES else minimum
    if minimum == "ICC_A" and clause != "ICC_A":
        return "ICC_A", [{"code": "INSURANCE_CLAUSE_UPGRADED",
                          "message": f"{incoterm}는 ICC(A) 부보가 필요해 ICC(A)로 계산했어요"}]
    return clause, []


def apply_incoterm(costs, incoterm):
    """부담 주체(borne_by) 지정 후 매도인 부담 합계 K(원화 항목)·Y(외화 항목 원화 환산). 수식 §4.3.2"""
    seller_pays = INCOTERMS[incoterm]["seller_pays"]
    krw_total = Decimal(0)
    fx_total = Decimal(0)
    for item in costs:
        item["borne_by"] = "seller" if seller_pays[item["key"]] else "buyer"
        if item["borne_by"] == "seller":
            if item["currency"] == "KRW":
                krw_total += item["krw"]
            else:
                fx_total += item["krw"]
    return costs, krw_total, fx_total


def calc_insurance(cfr_value, clause):
    """적하보험료 — 부보 110% 순환참조를 대수적으로 풉니다. V = B / (1 − 1.1r), I = V − B. 수식 §4.3.3"""
    rate = pct(INSURANCE_RATES[clause]["rate_pct"])
    cif_value = cfr_value / (1 - INSURANCE_COVERAGE * rate)
    return {
        "clause": clause,
        "rate": rate,
        "cfr_value": cfr_value,
        "cif_value": cif_value,
        "insured_value": cif_value * INSURANCE_COVERAGE,
        "premium": cif_value - cfr_value,
    }


def validate_logistics_request(payload, *, require_prices=True):
    """calculate-cbm-logistics 요청 검증 → (정규화된 입력, warnings) (§3.1.4)"""
    errors = _Errors()
    qty = to_quantity(payload.get("qty"))
    if qty is None:
        errors.add("REQUIRED_FIELD", "qty", "발주 수량을 입력해 주세요")
    elif qty < MARGIN_MOQ:
        errors.add("MOQ_VIOLATION", "qty", f"{qty:,}ea는 MOQ({MARGIN_MOQ:,}ea) 미만이에요")
    elif qty > MARGIN_MAX_QTY:
        errors.add("OUT_OF_RANGE", "qty", f"수량은 최대 {MARGIN_MAX_QTY:,}ea까지 입력할 수 있어요")

    unit_cost = supply_price = None
    if require_prices:
        unit_cost = to_decimal(payload.get("unit_cost"), "unit_cost", errors, label="총 제조원가",
                               min_value=Decimal(0), max_value=MAX_OVERRIDE_PRICE)
        supply_price = to_decimal(payload.get("supply_price"), "supply_price", errors, label="공급단가",
                                  min_value=Decimal("0.01"), max_value=MAX_OVERRIDE_PRICE)

    raw = payload.get("carton") if isinstance(payload.get("carton"), dict) else {}
    carton = {
        "length_cm": to_decimal(raw.get("length_cm"), "carton.length_cm", errors, label="카톤 가로",
                                min_value=Decimal("0.1"), max_value=MAX_CARTON_CM),
        "width_cm": to_decimal(raw.get("width_cm"), "carton.width_cm", errors, label="카톤 세로",
                               min_value=Decimal("0.1"), max_value=MAX_CARTON_CM),
        "height_cm": to_decimal(raw.get("height_cm"), "carton.height_cm", errors, label="카톤 높이",
                                min_value=Decimal("0.1"), max_value=MAX_CARTON_CM),
        "gross_weight_kg": to_decimal(raw.get("gross_weight_kg"), "carton.gross_weight_kg", errors,
                                      label="카톤 총중량", min_value=Decimal("0.01"), max_value=MAX_CARTON_KG),
        "allowance_rate": to_decimal(raw.get("allowance_rate"), "carton.allowance_rate", errors, label="포장 여유율",
                                     min_value=Decimal(0), max_value=MAX_CARTON_ALLOWANCE,
                                     default=CARTON_ALLOWANCE_DEFAULT),
    }
    upc = to_quantity(raw.get("units_per_carton"))
    if upc is None or not 1 <= upc <= MAX_UNITS_PER_CARTON:
        errors.add("OUT_OF_RANGE", "carton.units_per_carton",
                   f"카톤 입수량은 1~{MAX_UNITS_PER_CARTON:,} 사이 정수로 입력해 주세요")
    carton["units_per_carton"] = upc

    mode = _enum(payload.get("transport_mode"), TRANSPORT_MODES, "transport_mode", errors, "운송 방식")
    region = _enum(payload.get("dest_region"), REGIONS, "dest_region", errors, "도착 권역")
    incoterm = _enum(payload.get("incoterm"), INCOTERMS, "incoterm", errors, "인코텀즈")
    clause = payload.get("insurance_clause")
    if clause not in (None, "", *INSURANCE_RATES):
        errors.add("OUT_OF_RANGE", "insurance_clause", "보험 조건 값이 올바르지 않아요")

    named_place = str(payload.get("named_place") or "").strip()
    if len(named_place) > MAX_NAMED_PLACE_LEN:
        errors.add("OUT_OF_RANGE", "named_place", f"지정 장소는 {MAX_NAMED_PLACE_LEN}자 이내로 입력해 주세요")
    if region and not named_place:
        named_place = REGIONS[region]["default_place"]

    usd_rate = to_decimal(payload.get("usd_rate"), "usd_rate", errors, label="USD 환율",
                          min_value=Decimal("0.0001"), max_value=MAX_FX_RATE, required=False)
    errors.raise_if_any()

    warnings = []
    if usd_rate is None:
        usd_rate, fx_warnings = _default_usd_rate()
        warnings.extend(fx_warnings)
    return {
        "qty": qty, "unit_cost": unit_cost, "supply_price": supply_price, "carton": carton,
        "transport_mode": mode, "dest_region": region, "named_place": named_place,
        "incoterm": incoterm, "insurance_clause": clause or None, "usd_rate": usd_rate,
    }, warnings


def _logistics_core(req, qty):
    """수량 qty 의 포장·물류비·부담 주체. 보험료는 가액에 따라 달라지므로 호출 측에서 계산합니다."""
    mode = req["transport_mode"]
    effective, warnings = resolve_incoterm(req["incoterm"], mode)
    clause, clause_warnings = resolve_insurance_clause(effective, req["insurance_clause"])
    packing = calc_packing(req["carton"], qty, mode)
    costs = calc_logistics_costs(packing, mode, req["dest_region"], req["usd_rate"])
    costs, krw_total, fx_total = apply_incoterm(costs, effective)
    return {
        "effective_incoterm": effective,
        "insurance_clause": clause,
        "insurance_rate": pct(INSURANCE_RATES[clause]["rate_pct"]) if clause else Decimal(0),
        "packing": packing,
        "costs": costs,
        "krw_total": krw_total,
        "fx_total": fx_total,
        "warnings": warnings + clause_warnings,
    }


def _packing_warnings(req, core):
    packing, mode, warnings = core["packing"], req["transport_mode"], []
    if mode == "SEA_LCL" and packing["cbm"] > LCL_SUGGEST_FCL_CBM:
        warnings.append({"code": "LCL_TOO_LARGE",
                         "message": f"CBM이 {_fmt(LCL_SUGGEST_FCL_CBM)}를 넘어요. FCL이 더 저렴할 수 있어요"})
    if packing["utilization"] is not None and packing["utilization"] < FCL_LOW_UTILIZATION:
        warnings.append({"code": "FCL_LOW_UTILIZATION",
                         "message": f"컨테이너 적재율이 {out(packing['utilization'] * 100, 1)}%예요. LCL이 더 저렴할 수 있어요"})
    if req["carton"]["gross_weight_kg"] > HEAVY_CARTON_KG:
        warnings.append({"code": "HEAVY_CARTON",
                         "message": f"카톤 1개가 {_fmt(HEAVY_CARTON_KG)}kg을 넘어요. 작업·파손 위험을 확인해 주세요"})
    upc = req["carton"]["units_per_carton"]
    if packing["last_carton_units"] != upc:
        full = packing["cartons"] * upc
        warnings.append({"code": "PARTIAL_CARTON",
                         "message": f"마지막 카톤은 {packing['last_carton_units']:,}ea만 들어가요. "
                                    f"수량을 {full:,}ea로 맞추면 카톤이 꽉 차요"})
    return warnings


def _serialize_packing(p):
    def opt(value, places):
        return None if value is None else out(value, places)
    return {
        "cartons": p["cartons"],
        "carton_cbm": out(p["carton_cbm"], 4),
        "cbm_raw": out(p["cbm_raw"], 3),
        "cbm": out(p["cbm"], 3),
        "gross_weight_kg": out(p["gross_weight_kg"], 2),
        "revenue_ton": opt(p["revenue_ton"], 3),
        "volumetric_kg": opt(p["volumetric_kg"], 2),
        "chargeable_kg": opt(p["chargeable_kg"], 2),
        "containers": p["containers"],
        "utilization": opt(None if p["utilization"] is None else p["utilization"] * 100, 1),
        "last_carton_units": p["last_carton_units"],
    }


def calculate_logistics(payload):
    """POST /api/margin-calculator/calculate-cbm-logistics — CBM·운임·보험료·인코텀즈 원화 단가 (§6.4.4)"""
    req, warnings = validate_logistics_request(payload)
    qty = req["qty"]
    core = _logistics_core(req, qty)
    warnings = warnings + core["warnings"] + _packing_warnings(req, core)

    krw_total, fx_total = core["krw_total"], core["fx_total"]
    cfr_value = req["supply_price"] * qty + krw_total + fx_total
    insurance = calc_insurance(cfr_value, core["insurance_clause"]) if core["insurance_clause"] else None
    premium = insurance["premium"] if insurance else Decimal(0)

    costs = [{
        "key": item["key"], "label": item["label"], "currency": item["currency"],
        "amount": out(item["amount"]), "krw": out(item["krw"]),
        "per_unit": out(item["krw"] / qty), "borne_by": item["borne_by"],
    } for item in core["costs"]]
    # 보험료는 가액 기준이라 매수인 부담일 때는 금액을 산출하지 않습니다(null).
    costs.insert(4, {
        "key": "insurance", "label": COST_LABELS["insurance"], "currency": "KRW",
        "amount": out(premium) if insurance else None, "krw": out(premium) if insurance else None,
        "per_unit": out(premium / qty) if insurance else None,
        "borne_by": "seller" if insurance else "buyer",
    })

    seller_total = krw_total + fx_total + premium
    data = {
        "qty": qty,
        "incoterm": req["incoterm"],
        "effective_incoterm": core["effective_incoterm"],
        "named_place": req["named_place"],
        "transport_mode": req["transport_mode"],
        "dest_region": req["dest_region"],
        "usd_rate": out(req["usd_rate"], 4),
        "packing": _serialize_packing(core["packing"]),
        "costs": costs,
        "totals": {
            "krw_costs": out(krw_total),
            "fx_costs_krw": out(fx_total),
            "insurance": out(premium),
            "seller_total": out(seller_total),
            "per_unit": out(seller_total / qty),
        },
        "incoterm_unit_price_krw": out(req["supply_price"] + seller_total / qty),
        "insurance_detail": None if not insurance else {
            "clause": insurance["clause"],
            "rate_pct": out(INSURANCE_RATES[insurance["clause"]]["rate_pct"], 2),
            "cfr_value": out(insurance["cfr_value"]),
            "cif_value": out(insurance["cif_value"]),
            "insured_value": out(insurance["insured_value"]),
        },
    }
    return data, warnings


# ---------------------------------------------------------------------------
# Tab 2 — 환율 (margin.md §6.3)
# 메모리 캐시 → 한국수출입은행 → open.er-api → 파일 캐시(instance/margin) → 모의 환율
# ---------------------------------------------------------------------------

FX_CACHE_DIR = Path(__file__).resolve().parents[2] / "instance" / "margin"
FX_CACHE_FILE = FX_CACHE_DIR / "fx_cache.json"
FX_FALLBACK_TTL_SEC = 300                  # 파일 캐시·모의 환율 사용 중이면 5분 뒤 외부 소스 재시도
FX_MANUAL_OUTLIER = Decimal("0.3")         # 직접 입력 환율이 기준 대비 ±30% 초과 시 경고

_fx_lock = threading.Lock()
_fx_state = {"snapshot": None, "expires": 0.0, "last_force": float("-inf"), "exim_blocked_date": None}
_logger = logging.getLogger(__name__)


def _log(level, message, *args):
    """앱 컨텍스트 안에서는 Flask logger, 밖(스크립트 테스트)에서는 모듈 logger 로 기록."""
    try:
        getattr(current_app.logger, level)(message, *args)
    except RuntimeError:
        getattr(_logger, level)(message, *args)


def _env_int(name, default):
    try:
        return int(os.getenv(name) or default)
    except ValueError:
        return default


def _http_get_json(url):
    timeout = _env_int("MARGIN_FX_TIMEOUT_SEC", FX_TIMEOUT_SEC_DEFAULT)
    req = urllib.request.Request(url, headers={"User-Agent": "COSMOA-margin/1.0", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 — 고정 https URL만 호출
        return json.loads(resp.read().decode("utf-8"))


def _estimated_rates(base):
    """TTB·TTS 를 제공하지 않는 소스: base ∓ 1% 로 추정 (§4.3.5)"""
    spread = base * TTB_ESTIMATE_SPREAD
    return {"base": base, "ttb": base - spread, "tts": base + spread}


def _fetch_koreaexim():
    """한국수출입은행 현재환율. 비영업일·11시 이전 빈 응답이면 최대 7일 역조회 (§6.3.1)"""
    key = os.getenv("MARGIN_KOREAEXIM_API_KEY")
    today = now_kst().date()
    if not key or _fx_state["exim_blocked_date"] == today:
        return None
    unit_map = {c["exim_unit"]: (code, Decimal(c["exim_divisor"])) for code, c in CURRENCIES.items()}
    for offset in range(FX_LOOKBACK_DAYS + 1):
        day = today - timedelta(days=offset)
        query = urllib.parse.urlencode({"authkey": key, "searchdate": day.strftime("%Y%m%d"), "data": "AP01"})
        try:
            rows = _http_get_json(f"{KOREAEXIM_FX_URL}?{query}")
        except Exception as exc:  # noqa: BLE001 — Timeout·SSL·5xx 모두 다음 소스로 넘깁니다
            _log("warning", "koreaexim fx request failed: %s", type(exc).__name__)  # Key 는 로그에 남기지 않음
            return None
        if not isinstance(rows, list) or not rows:
            continue  # 비영업일 → 전날로
        result_code = rows[0].get("result")
        if result_code in (2, 3, 4):
            _log("warning", "koreaexim fx result=%s (2: DATA 코드, 3: 인증, 4: 일일 한도)", result_code)
            if result_code == 4:
                _fx_state["exim_blocked_date"] = today  # 당일 재호출 억제
            return None
        rates = {}
        for row in rows:
            mapped = unit_map.get(str(row.get("cur_unit", "")).strip())
            base = _parse_decimal(row.get("deal_bas_r"))
            if not mapped or not base or base <= 0:
                continue
            code, divisor = mapped
            ttb = _parse_decimal(row.get("ttb")) or base
            tts = _parse_decimal(row.get("tts")) or base
            rates[code] = {"base": base / divisor, "ttb": ttb / divisor, "tts": tts / divisor}
        if rates:
            as_of = now_kst() if offset == 0 else datetime(day.year, day.month, day.day, 11, 0, tzinfo=KST)
            return {"source": "koreaexim", "as_of": as_of.isoformat(timespec="seconds"),
                    "search_date": day.strftime("%Y%m%d"), "ttb_estimated": False, "rates": rates}
    return None


def _fetch_open_er_api():
    """open.er-api.com (Key 불필요). 기준율만 제공 → TTB·TTS 추정 (§6.3.2)"""
    url = os.getenv("MARGIN_FX_OPEN_API_URL") or OPEN_ER_API_URL_DEFAULT
    try:
        body = _http_get_json(url)
    except Exception as exc:  # noqa: BLE001
        _log("warning", "open.er-api fx request failed: %s", type(exc).__name__)
        return None
    if not isinstance(body, dict) or body.get("result") != "success":
        return None
    raw = body.get("rates") or {}
    krw = _parse_decimal(raw.get("KRW"))
    if not krw or krw <= 0:
        return None
    rates = {}
    for code in CURRENCIES:
        per_base = _parse_decimal(raw.get(code))
        if per_base and per_base > 0:
            rates[code] = _estimated_rates(krw / per_base)  # KRW per X = rates.KRW / rates.X
    try:
        as_of = parsedate_to_datetime(body["time_last_update_utc"]).astimezone(KST)
    except (KeyError, TypeError, ValueError):
        as_of = now_kst()
    return {"source": "open_er_api", "as_of": as_of.isoformat(timespec="seconds"),
            "search_date": as_of.strftime("%Y%m%d"), "ttb_estimated": True, "rates": rates}


def _save_file_cache(snapshot):
    """마지막 성공 환율을 instance/margin/fx_cache.json 에 원자적으로 저장."""
    try:
        FX_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        data = {**snapshot, "rates": {c: {k: str(v) for k, v in r.items()} for c, r in snapshot["rates"].items()}}
        tmp = FX_CACHE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, FX_CACHE_FILE)
    except OSError as exc:
        _log("warning", "fx cache write failed: %s", exc)


def _load_file_cache():
    try:
        data = json.loads(FX_CACHE_FILE.read_text(encoding="utf-8"))
        data["rates"] = {c: {k: Decimal(v) for k, v in r.items()} for c, r in data["rates"].items()}
        return data
    except (OSError, ValueError, KeyError, TypeError, AttributeError, InvalidOperation):
        return None


def _mock_snapshot():
    return {"source": "mock", "as_of": f"{FALLBACK_FX_AS_OF}T00:00:00+09:00",
            "search_date": FALLBACK_FX_AS_OF.replace("-", ""), "ttb_estimated": True,
            "rates": {code: _estimated_rates(rate) for code, rate in FALLBACK_FX_KRW.items()}}


def _refresh_fx():
    """외부 소스를 순서대로 시도. 반환: (snapshot, is_fallback)"""
    for fetch in (_fetch_koreaexim, _fetch_open_er_api):
        snapshot = fetch()
        if snapshot and snapshot["rates"]:
            _save_file_cache(snapshot)
            return snapshot, False
    cached = _load_file_cache()
    if cached and cached.get("rates"):
        return cached, True
    return _mock_snapshot(), True


def get_fx_rates(currencies=None, force=False):
    """GET /api/margin-calculator/fx-rates — 환율 조회(캐시·Fallback). §6.3.3, §6.4.2"""
    warnings = []
    if isinstance(currencies, str):
        currencies = [c.strip().upper() for c in currencies.split(",") if c.strip()]
    if currencies:
        unknown = [c for c in currencies if c not in CURRENCIES]
        if unknown:
            warnings.append({"code": "FX_UNKNOWN_CURRENCY",
                             "message": f"지원하지 않는 통화는 제외했어요: {', '.join(unknown)}"})
        codes = [c for c in currencies if c in CURRENCIES]
    else:
        codes = list(CURRENCIES)

    with _fx_lock:  # 동시 요청이 몰려도 외부 API 는 한 번만 호출
        now = time.monotonic()
        if force and now - _fx_state["last_force"] < FX_FORCE_MIN_INTERVAL_SEC:
            force = False  # 60초 안의 강제 새로고침은 캐시 반환 (외부 API 남용 방지)
        cached = _fx_state["snapshot"] is not None and now < _fx_state["expires"] and not force
        if not cached:
            if force:
                _fx_state["last_force"] = now
            snapshot, is_fallback = _refresh_fx()
            ttl = (FX_FALLBACK_TTL_SEC if is_fallback
                   else _env_int("MARGIN_FX_CACHE_TTL_MIN", FX_CACHE_TTL_MIN_DEFAULT) * 60)
            _fx_state.update(snapshot={**snapshot, "is_fallback": is_fallback}, expires=now + ttl)
        snapshot = _fx_state["snapshot"]

    try:
        stale = now_kst() - datetime.fromisoformat(snapshot["as_of"]) > timedelta(days=FX_STALE_DAYS)
    except (TypeError, ValueError):
        stale = True
    if snapshot["is_fallback"]:
        warnings.append({"code": "FX_FALLBACK", "message": (
            "외부 환율을 불러오지 못해 모의 기준 환율을 쓰고 있어요. 직접 입력을 권장해요"
            if snapshot["source"] == "mock" else "외부 환율을 불러오지 못해 마지막 저장값을 쓰고 있어요")})
    if stale:
        warnings.append({"code": "FX_STALE", "message": f"{FX_STALE_DAYS}일 넘은 환율이에요"})

    data = {
        "source": snapshot["source"],
        "as_of": snapshot["as_of"],
        "search_date": snapshot.get("search_date"),
        "is_fallback": snapshot["is_fallback"],
        "stale": stale,
        "cached": cached,
        "ttb_estimated": snapshot.get("ttb_estimated", False),
        "rates": {code: {k: out(v, 4) for k, v in snapshot["rates"][code].items()}
                  for code in codes if code in snapshot["rates"]},
    }
    return data, warnings


def _snapshot_rate(code, basis):
    """현재 스냅샷의 1 단위당 KRW. basis: base | ttb. 반환: (Decimal, fx data, warnings)"""
    data, warnings = get_fx_rates([code])
    rate = data["rates"].get(code)
    if not rate:
        raise MarginValidationError("FX_UNAVAILABLE", f"{code} 환율을 찾지 못했어요. 직접 입력해 주세요",
                                    {"currency": f"{code} 환율 없음"})
    return Decimal(str(rate.get(basis) or rate["base"])), data, warnings


def _default_usd_rate():
    rate, _, warnings = _snapshot_rate("USD", "base")
    return rate, warnings


def resolve_fx_rate(currency, basis, manual_rate):
    """적용 환율 확정 (§4.3.5). 반환: ({rate, source, as_of, basis}, warnings)"""
    if basis == "manual":
        errors = _Errors()
        rate = to_decimal(manual_rate, "fx_manual_rate", errors, label="직접 입력 환율",
                          min_value=Decimal("0.0001"), max_value=MAX_FX_RATE)
        errors.raise_if_any()
        warnings = [{"code": "FX_MANUAL", "message": "직접 입력한 환율로 계산했어요"}]
        try:
            reference, _, _ = _snapshot_rate(currency, "base")
            if abs(rate - reference) / reference > FX_MANUAL_OUTLIER:
                warnings.append({"code": "FX_MANUAL_OUTLIER",
                                 "message": f"입력한 환율이 기준 환율({out(reference):,})과 30% 넘게 달라요"})
        except MarginValidationError:
            pass
        return {"rate": rate, "source": "manual", "as_of": now_kst().isoformat(timespec="seconds"),
                "basis": basis}, warnings
    rate, data, warnings = _snapshot_rate(currency, basis)
    return {"rate": rate, "source": data["source"], "as_of": data["as_of"], "basis": basis}, warnings


# ---------------------------------------------------------------------------
# Tab 2 — 외화 단가 · 환율 스트레스 (margin.md §4.3.4, §4.4)
# ---------------------------------------------------------------------------


def _currency_quant(currency, kind):
    """통화 소수 자리 단위. kind: price_decimals | amount_decimals"""
    return Decimal(1).scaleb(-CURRENCIES[currency][kind])


def calc_fx_stress(received, y_u, k_u, i_u, unit_cost, rate, steps, target, minimum):
    """환율 변동 s 별 실수령·마진·마진율. 금액은 원/ea, target·minimum 은 소수. 수식 §4.4

    외화 표시 비용(y_u)은 환율과 같이 움직이고, 원가·원화 물류비·보험료는 고정으로 봅니다.
    """
    fixed_krw = unit_cost + k_u + i_u
    rows = []
    for step in steps:
        f = 1 + Decimal(step) / 100
        revenue = received * f
        margin = (received - y_u) * f - fixed_krw
        exw_net = revenue - k_u - y_u * f - i_u
        rate_export = margin / revenue if revenue > 0 else None
        rate_exw = margin / exw_net if exw_net > 0 else None
        rows.append({
            "step": step,
            "rate": out(rate * f),
            "revenue_krw": out(revenue),
            "unit_margin": out(margin),
            "margin_rate": None if rate_export is None else out(rate_export * 100),
            "margin_rate_exw": None if rate_exw is None else out(rate_exw * 100),
            "status": "negative" if rate_exw is None else classify_margin(rate_exw, target, minimum),
        })
    return rows


def calc_breakeven_rates(received, y_u, fixed_krw, rate, min_margin):
    """손익분기 환율 R_be·방어선 환율 R_def (min_margin 은 소수). 분모 ≤ 0 이면 None. 수식 §4.4"""
    be_denominator = received - y_u
    def_denominator = received * (1 - min_margin) - y_u
    return {
        "breakeven": rate * fixed_krw / be_denominator if be_denominator > 0 else None,
        "defense": rate * fixed_krw / def_denominator if def_denominator > 0 else None,
    }


def calculate_fx_quote(payload):
    """POST /api/margin-calculator/fx-stress — 외화 단가·총액·민감도·손익분기 환율 (§6.4.5)"""
    errors = _Errors()
    qty = to_quantity(payload.get("qty"))
    if qty is None or qty < MARGIN_MOQ:
        errors.add("MOQ_VIOLATION", "qty", f"발주 수량은 MOQ({MARGIN_MOQ:,}ea) 이상이어야 해요")
    unit_cost = to_decimal(payload.get("unit_cost"), "unit_cost", errors, label="총 제조원가",
                           min_value=Decimal(0), max_value=MAX_OVERRIDE_PRICE)
    price_krw = to_decimal(payload.get("incoterm_unit_price_krw"), "incoterm_unit_price_krw", errors,
                           label="인코텀즈 원화 단가", min_value=Decimal("0.01"), max_value=MAX_OVERRIDE_PRICE)
    logistics = payload.get("logistics") if isinstance(payload.get("logistics"), dict) else {}
    krw_costs, fx_costs, insurance = (
        to_decimal(logistics.get(key), f"logistics.{key}", errors, label=label, min_value=Decimal(0),
                   max_value=MAX_FIXED_COST, default=Decimal(0))
        for key, label in (("krw_costs", "원화 물류비"), ("fx_costs_krw", "외화 물류비"), ("insurance", "보험료"))
    )
    currency = _enum(payload.get("currency") or "USD", CURRENCIES, "currency", errors, "통화")
    basis = _enum(payload.get("fx_basis") or "base", ("base", "ttb", "manual"), "fx_basis", errors, "환율 기준")
    target = to_decimal(payload.get("target_margin"), "target_margin", errors, label="목표 마진율",
                        min_value=Decimal(0), max_value=MAX_TARGET_MARGIN, default=DEFAULT_TARGET_MARGIN,
                        range_code="INVALID_MARGIN")
    minimum = to_decimal(payload.get("min_margin"), "min_margin", errors, label="마진 방어선",
                         min_value=Decimal(0), max_value=MAX_TARGET_MARGIN, default=DEFAULT_MIN_MARGIN,
                         range_code="INVALID_MARGIN")
    steps = payload.get("stress_steps") or STRESS_STEPS
    parsed_steps = [to_quantity(s) for s in steps] if isinstance(steps, list) else [None]
    if len(parsed_steps) > 9 or any(s is None or not -30 <= s <= 30 for s in parsed_steps):
        errors.add("OUT_OF_RANGE", "stress_steps", "변동률은 -30~30 사이 정수로 최대 9개까지 넣을 수 있어요")
    errors.raise_if_any()
    steps = sorted(set(parsed_steps) | {0})

    fx, warnings = resolve_fx_rate(currency, basis, payload.get("fx_manual_rate"))
    rate = fx["rate"]
    k_u, y_u, i_u = krw_costs / qty, fx_costs / qty, insurance / qty
    price_decimals = CURRENCIES[currency]["price_decimals"]
    amount_decimals = CURRENCIES[currency]["amount_decimals"]

    unit_price_fx = ceil_to(price_krw / rate, _currency_quant(currency, "price_decimals"))   # P_fx (올림)
    total_fx = round_to(unit_price_fx * qty, amount_decimals)                               # A_fx
    received = unit_price_fx * rate                                                         # X
    unit_margin = received - unit_cost - k_u - y_u - i_u                                    # G_exp
    exw_net = received - k_u - y_u - i_u
    rate_exw = unit_margin / exw_net if exw_net > 0 else None
    target_f, minimum_f = pct(target), pct(minimum)
    breakeven = calc_breakeven_rates(received, y_u, unit_cost + k_u + i_u, rate, minimum_f)

    data = {
        "currency": currency,
        "fx_rate": out(rate, 4),
        "fx_basis": basis,
        "fx_source": fx["source"],
        "fx_as_of": fx["as_of"],
        "unit_price_fx": out(unit_price_fx, price_decimals),
        "total_amount_fx": out(total_fx, amount_decimals),
        "received_krw_per_unit": out(received),
        "unit_margin_krw": out(unit_margin),
        "margin_rate_export": out(unit_margin / received * 100),
        "margin_rate_exw": None if rate_exw is None else out(rate_exw * 100),
        "status": "negative" if rate_exw is None else classify_margin(rate_exw, target_f, minimum_f),
        "stress": calc_fx_stress(received, y_u, k_u, i_u, unit_cost, rate, steps, target_f, minimum_f),
        "breakeven_rate": None if breakeven["breakeven"] is None else out(breakeven["breakeven"]),
        "defense_rate": None if breakeven["defense"] is None else out(breakeven["defense"]),
    }
    return data, warnings


# ---------------------------------------------------------------------------
# Tab 2 — 바이어 역제안 역산 (margin.md §4.5)
# ---------------------------------------------------------------------------

VERDICT_BY_STATUS = {"ok": "accept", "below_target": "negotiate", "below_defense": "reject", "negative": "negative"}


def evaluate_counter(price_fx, rate, unit_cost, k_u, y_u, ins_rate, target, minimum):
    """바이어 단가 T 의 원화 실수령·순 EXW 수입 N_T·마진율 g_T·판정. target·minimum 은 소수. 수식 §4.5.1"""
    received = price_fx * rate
    insurance = received * INSURANCE_COVERAGE * ins_rate
    net = received - k_u - y_u - insurance
    margin = net - unit_cost
    rate_exw = margin / net if net > 0 else None
    status = "negative" if rate_exw is None else classify_margin(rate_exw, target, minimum)
    return {"received": received, "insurance": insurance, "net": net, "margin": margin,
            "margin_rate": rate_exw, "status": status, "verdict": VERDICT_BY_STATUS[status]}


def calc_cost_reduction(cost_detail, loss_rate, net_revenue, target):
    """목표 마진 허용 원가 C_req, 절감 필요액 ΔC, 5개 요소 비례 배분. 수식 §4.5.3

    재료비 3종은 로스 반영 후 금액이라 5개 요소 합계 = 총 제조원가입니다.
    """
    unit_cost = cost_detail["unit_cost"]
    allowed = net_revenue * (1 - target)
    required = max(Decimal(0), unit_cost - allowed)
    loss_factor = 1 + pct(loss_rate)
    components = [
        ("bulk", "벌크", cost_detail["bulk"] * loss_factor),
        ("container", "용기", cost_detail["container"] * loss_factor),
        ("packaging", "단상자·라벨·설명서", cost_detail["packaging"] * loss_factor),
        ("processing", "충진·포장·검수", cost_detail["processing"]),
        ("fixed", "고정비 분산", cost_detail["fixed"]),
    ]
    by_component = []
    for key, label, current in components:
        share = current / unit_cost if unit_cost > 0 else Decimal(0)
        reduce = required * share
        by_component.append({"key": key, "label": label, "current": out(current), "share": out(share * 100),
                             "reduce": out(reduce), "after": out(current - reduce)})
    return {
        "allowed_cost": out(allowed),
        "required": out(required),
        "required_pct": out(required / unit_cost * 100) if unit_cost > 0 else None,
        "feasible": required < unit_cost,
        "by_component": by_component,
    }


def search_required_qty(price_fx, rate, cost, logistics_req, target, minimum):
    """바이어 단가를 그대로 받을 때 목표 마진 이상이 되는 최소 수량. 수식 §4.5.4

    후보: MOQ~200,000ea 500 단위 + 할인 기준 수량. 수량마다 원가·카톤·RT·컨테이너를 다시 계산합니다.
    """
    candidates = set(range(MARGIN_MOQ, COUNTER_QTY_SEARCH_MAX + 1, COUNTER_QTY_SEARCH_STEP))
    candidates |= {q for q, _ in VOLUME_DISCOUNTS if q <= COUNTER_QTY_SEARCH_MAX}
    for qty in sorted(candidates):
        unit_cost = calc_unit_cost(cost, qty)["unit_cost"]
        core = _logistics_core(logistics_req, qty)
        result = evaluate_counter(price_fx, rate, unit_cost, core["krw_total"] / qty, core["fx_total"] / qty,
                                  core["insurance_rate"], target, minimum)
        if result["margin_rate"] is not None and result["margin_rate"] >= target:
            return {"required_qty": qty, "margin_at_required": out(result["margin_rate"] * 100),
                    "searched_up_to": COUNTER_QTY_SEARCH_MAX}
    return {"required_qty": None, "margin_at_required": None, "searched_up_to": COUNTER_QTY_SEARCH_MAX}


def reverse_counter_offer(payload):
    """POST /api/margin-calculator/reverse-counter-offer — 바이어 역제안 역산 (§6.4.6)"""
    errors = _Errors()
    currency = _enum(payload.get("currency") or "USD", CURRENCIES, "currency", errors, "통화")
    price = to_decimal(payload.get("counter_price"), "counter_price", errors, label="바이어 희망 단가",
                       min_value=Decimal("0.0001"), max_value=Decimal("100000"),
                       range_code="COUNTER_PRICE_INVALID")
    if price is not None and price != round_to(price, 4):
        errors.add("COUNTER_PRICE_INVALID", "counter_price", "바이어 희망 단가는 소수 4자리까지 입력해 주세요")
    fx_rate = to_decimal(payload.get("fx_rate"), "fx_rate", errors, label="적용 환율",
                         min_value=Decimal("0.0001"), max_value=MAX_FX_RATE, required=False)
    tier_payload = payload.get("tier_request") if isinstance(payload.get("tier_request"), dict) else {}
    logistics_payload = payload.get("logistics_request") if isinstance(payload.get("logistics_request"), dict) else {}
    errors.raise_if_any()

    tier_req = validate_tier_request({**tier_payload, "tiers": [], "price_overrides": {}})
    logistics_req, warnings = validate_logistics_request(
        {**logistics_payload, "qty": payload.get("qty", logistics_payload.get("qty"))}, require_prices=False)
    if fx_rate is None:
        fx, fx_warnings = resolve_fx_rate(currency, "base", None)
        fx_rate = fx["rate"]
        warnings += fx_warnings

    qty = logistics_req["qty"]
    target, minimum = pct(tier_req["target_margin"]), pct(tier_req["min_margin"])
    cost_detail = calc_unit_cost(tier_req["cost"], qty)
    unit_cost = cost_detail["unit_cost"]
    core = _logistics_core(logistics_req, qty)
    warnings += core["warnings"]
    k_u, y_u, ins_rate = core["krw_total"] / qty, core["fx_total"] / qty, core["insurance_rate"]

    result = evaluate_counter(price, fx_rate, unit_cost, k_u, y_u, ins_rate, target, minimum)

    # 목표 단가·수용 최저가 (§4.5.2) — 보험 조건이면 (1 − 1.1r) 로 가산, 통화 단가 자리로 올림
    price_quant = _currency_quant(currency, "price_decimals")
    price_decimals = CURRENCIES[currency]["price_decimals"]
    gross_up = (1 - INSURANCE_COVERAGE * ins_rate) * fx_rate
    target_price = ceil_to((unit_cost / (1 - target) + k_u + y_u) / gross_up, price_quant)
    walkaway_price = ceil_to((unit_cost / (1 - minimum) + k_u + y_u) / gross_up, price_quant)

    data = {
        "counter_price": out(price, 4),
        "currency": currency,
        "fx_rate": out(fx_rate, 4),
        "qty": qty,
        "incoterm": core["effective_incoterm"],
        "received_krw_per_unit": out(result["received"]),
        "insurance_per_unit": out(result["insurance"]),
        "net_exw_revenue": out(result["net"]),
        "unit_cost": out(unit_cost),
        "unit_margin": out(result["margin"]),
        "margin_rate_exw": None if result["margin_rate"] is None else out(result["margin_rate"] * 100),
        "verdict": result["verdict"],
        "status": result["status"],
        "target_margin": out(tier_req["target_margin"]),
        "min_margin": out(tier_req["min_margin"]),
        "target_price": out(target_price, price_decimals),
        "walkaway_price": out(walkaway_price, price_decimals),
        "gap_to_target": out(target_price - price, price_decimals),
        "gap_to_target_pct": out((target_price - price) / price * 100),
        "cost_reduction": calc_cost_reduction(cost_detail, tier_req["cost"]["loss_rate"], result["net"], target),
        "quantity_guide": search_required_qty(price, fx_rate, tier_req["cost"], logistics_req, target, minimum),
    }
    return data, warnings


# ---------------------------------------------------------------------------
# Tab 3 — 견적서(PI) (margin.md §3.1.7, §4.6, §6.4.7~6.4.8, §6.6, §7.5)
# ---------------------------------------------------------------------------

PI_ALLOWED_EXTRA_CHARS = set("€£¥®±")
PI_NO_PATTERN = re.compile(r"^[A-Za-z0-9\-_/]{1,40}$")
PI_SWIFT_PATTERN = re.compile(r"^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$")
PI_HS_PATTERN = re.compile(r"^\d{4}(\.\d{2}(\d{2,4})?)?$")
PI_EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
PI_MAX_EXTRA_ITEMS = 10
PI_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

_ONES = ["ZERO", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE", "TEN", "ELEVEN",
         "TWELVE", "THIRTEEN", "FOURTEEN", "FIFTEEN", "SIXTEEN", "SEVENTEEN", "EIGHTEEN", "NINETEEN"]
_TENS = ["", "", "TWENTY", "THIRTY", "FORTY", "FIFTY", "SIXTY", "SEVENTY", "EIGHTY", "NINETY"]
_SCALES = [(10 ** 9, "BILLION"), (10 ** 6, "MILLION"), (10 ** 3, "THOUSAND")]


class MarginPdfUnavailableError(Exception):
    """xhtml2pdf 미설치 → HTTP 501 (프론트는 인쇄 흐름으로 대체)"""


def _words_below_thousand(n):
    words = []
    if n >= 100:
        words += [_ONES[n // 100], "HUNDRED"]
        n %= 100
    if n >= 20:
        words.append(_TENS[n // 10] + ("-" + _ONES[n % 10] if n % 10 else ""))
    elif n > 0 or not words:
        words.append(_ONES[n])
    return words


def _integer_to_words(n):
    """0 ≤ n < 10^12 정수 → 영문 대문자. 예: 9380 → NINE THOUSAND THREE HUNDRED EIGHTY"""
    if n == 0:
        return "ZERO"
    words = []
    for scale, name in _SCALES:
        if n >= scale:
            words += _words_below_thousand(n // scale) + [name]
            n %= scale
    if n:
        words += _words_below_thousand(n)
    return " ".join(words)


def amount_to_words(amount, currency):
    """PI 영문 금액. 예: 9380.00 USD → SAY US DOLLARS NINE THOUSAND THREE HUNDRED EIGHTY AND CENTS ZERO ONLY (§4.6)"""
    info = CURRENCIES[currency]
    value = round_to(amount, info["amount_decimals"])
    integer = int(value)
    text = f"SAY {info['words']} {_integer_to_words(integer)}"
    if info["amount_decimals"] > 0:
        cents = int((value - integer) * 100)
        text += f" AND CENTS {_integer_to_words(cents)}"
    return text + " ONLY"


def _is_english(text):
    return all(32 <= ord(ch) < 127 or ch in "\r\n\t" or ch in PI_ALLOWED_EXTRA_CHARS for ch in text)


def _parse_date(value):
    try:
        return date.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None


def _pi_date(value):
    """PI 표기용 날짜 — 로케일에 영향받지 않도록 월 이름을 직접 씁니다. 예: Sep 23, 2026"""
    return f"{PI_MONTHS[value.month - 1]} {value.day:02d}, {value.year}"


def _pi_money(value, currency, kind="amount"):
    """PI 금액 표기(통화 코드 없이 숫자만). 예: 9,380.00 / 1.876"""
    places = CURRENCIES[currency]["price_decimals" if kind == "price" else "amount_decimals"]
    return f"{round_to(value, places):,.{places}f}"


class _PiReader:
    """PI 입력 필드 읽기 — 영문 검사를 먼저 모아 NON_ENGLISH_TEXT 를 대표 오류로 만듭니다."""

    def __init__(self, strict):
        self.strict = strict
        self.english = _Errors()
        self.errors = _Errors()

    def text(self, source, key, field, label, *, required=False, max_len=120, pattern=None, pattern_msg=None):
        value = str(source.get(key) or "").strip()
        if not value:
            if required and self.strict:
                self.errors.add("REQUIRED_FIELD", field, f"{label}을(를) 입력해 주세요")
            return ""
        if not _is_english(value):
            self.english.add("NON_ENGLISH_TEXT", field, f"{label}은(는) 영문으로 입력해 주세요")
            return value
        if len(value) > max_len:
            self.errors.add("OUT_OF_RANGE", field, f"{label}은(는) {max_len}자 이내로 입력해 주세요")
        elif pattern and not pattern.match(value):
            self.errors.add("OUT_OF_RANGE", field, pattern_msg or f"{label} 형식이 올바르지 않아요")
        return value

    def raise_if_any(self):
        merged = _Errors()
        for source in (self.english, self.errors):  # 영문 오류를 먼저 넣어 대표 코드가 되게 함
            for field, message in source.fields.items():
                merged.add(source.code, field, message)
        if self.english.code:
            merged.message = "견적서는 영문으로 작성해 주세요"
        merged.raise_if_any()


def validate_pi(payload, *, strict=True):
    """render-pi / export-pi-pdf 요청 검증 (§3.1.7, §7.5)

    strict=False(미리보기)는 필수값 누락만 허용하고 영문·형식·날짜 검사는 그대로 합니다.
    """
    reader = _PiReader(strict)
    errors = reader.errors
    bound = payload.get("bound") if isinstance(payload.get("bound"), dict) else {}
    pi = payload.get("pi") if isinstance(payload.get("pi"), dict) else {}
    buyer = pi.get("buyer") if isinstance(pi.get("buyer"), dict) else {}
    seller = pi.get("seller") if isinstance(pi.get("seller"), dict) else {}
    bank = pi.get("bank") if isinstance(pi.get("bank"), dict) else {}

    # 시뮬레이션 연동 값 (Tab 1·2)
    product_name = reader.text(bound, "product_name", "bound.product_name", "제품명", max_len=80)
    if not product_name and strict:
        errors.add("REQUIRED_FIELD", "bound.product_name", "Tab 1에서 제품명을 영문으로 입력해 주세요")
    qty = to_quantity(bound.get("qty"))
    if qty is None or not MARGIN_MOQ <= qty <= MARGIN_MAX_QTY:
        errors.add("MOQ_VIOLATION", "bound.qty", f"수량은 {MARGIN_MOQ:,}~{MARGIN_MAX_QTY:,}ea 사이여야 해요")
    unit_price = to_decimal(bound.get("unit_price"), "bound.unit_price", errors, label="단가",
                            min_value=Decimal("0.0001"), max_value=Decimal("100000"))
    currency = _enum(bound.get("currency"), CURRENCIES, "bound.currency", errors, "통화")
    incoterm = _enum(bound.get("incoterm"), INCOTERMS, "bound.incoterm", errors, "인코텀즈")
    mode = bound.get("transport_mode") if bound.get("transport_mode") in TRANSPORT_MODES else None
    named_place = reader.text(bound, "named_place", "bound.named_place", "지정 장소", required=True,
                              max_len=MAX_NAMED_PLACE_LEN)
    volume = to_decimal(bound.get("volume_ml"), "bound.volume_ml", errors, label="용량",
                        min_value=Decimal(0), max_value=Decimal(5000), required=False)
    carton_raw = bound.get("carton") if isinstance(bound.get("carton"), dict) else None

    # PI 기본
    pi_no = reader.text(pi, "pi_no", "pi.pi_no", "PI 번호", required=True, max_len=40, pattern=PI_NO_PATTERN,
                        pattern_msg="PI 번호는 영문·숫자와 - _ / 만 쓸 수 있어요")
    issue = _parse_date(pi.get("issue_date"))
    validity = _parse_date(pi.get("validity_date"))
    shipment = _parse_date(pi.get("shipment_date")) if pi.get("shipment_date") else None
    if issue is None:
        errors.add("INVALID_DATE", "pi.issue_date", "발행일을 입력해 주세요")
    if validity is None:
        errors.add("INVALID_DATE", "pi.validity_date", "유효기간을 입력해 주세요")
    elif issue and validity < issue:
        errors.add("INVALID_DATE", "pi.validity_date", "유효기간은 발행일 이후여야 해요")
    if pi.get("shipment_date") and shipment is None:
        errors.add("INVALID_DATE", "pi.shipment_date", "선적 예정일 형식이 올바르지 않아요")
    elif shipment and issue and shipment < issue:
        errors.add("INVALID_DATE", "pi.shipment_date", "선적 예정일은 발행일 이후여야 해요")

    buyer_info = {
        "company": reader.text(buyer, "company", "pi.buyer.company", "바이어 회사명", required=True),
        "country": reader.text(buyer, "country", "pi.buyer.country", "바이어 국가", required=True, max_len=60),
        "address": reader.text(buyer, "address", "pi.buyer.address", "바이어 주소", max_len=300),
        "contact": reader.text(buyer, "contact", "pi.buyer.contact", "바이어 담당자", max_len=80),
        "email": reader.text(buyer, "email", "pi.buyer.email", "바이어 이메일", max_len=120, pattern=PI_EMAIL_PATTERN,
                             pattern_msg="이메일 형식이 올바르지 않아요"),
    }
    seller_info = {
        "company": reader.text(seller, "company", "pi.seller.company", "매도인 회사명", required=True),
        "address": reader.text(seller, "address", "pi.seller.address", "매도인 주소", max_len=300),
        "contact": reader.text(seller, "contact", "pi.seller.contact", "매도인 담당자", max_len=120),
    }
    bank_info = {
        "name": reader.text(bank, "name", "pi.bank.name", "은행명", required=True),
        "swift": reader.text(bank, "swift", "pi.bank.swift", "SWIFT 코드", required=True, max_len=11,
                             pattern=PI_SWIFT_PATTERN, pattern_msg="SWIFT 코드는 영문 대문자·숫자 8자리 또는 11자리예요"),
        "account": reader.text(bank, "account", "pi.bank.account", "계좌번호", required=True, max_len=40),
        "beneficiary": reader.text(bank, "beneficiary", "pi.bank.beneficiary", "예금주", required=True),
    }

    payment = pi.get("payment_terms") or DEFAULT_PAYMENT_TERMS
    if payment not in PAYMENT_TERMS:
        errors.add("OUT_OF_RANGE", "pi.payment_terms", "결제 조건 값이 올바르지 않아요")
    port_loading = reader.text(pi, "port_loading", "pi.port_loading", "선적항", required=True, max_len=80)
    port_discharge = reader.text(pi, "port_discharge", "pi.port_discharge", "도착항", required=True, max_len=80)
    lead_time = to_quantity(pi.get("lead_time_days")) if pi.get("lead_time_days") not in (None, "") else PI_LEAD_TIME_DAYS_DEFAULT
    if lead_time is None or not 1 <= lead_time <= 365:
        errors.add("OUT_OF_RANGE", "pi.lead_time_days", "생산 리드타임은 1~365일 사이로 입력해 주세요")
    hs_code = reader.text(pi, "hs_code", "pi.hs_code", "HS Code", max_len=12, pattern=PI_HS_PATTERN,
                          pattern_msg="HS Code 형식이 올바르지 않아요 (예: 3304.99)") or PI_HS_CODE_DEFAULT
    remarks = reader.text(pi, "remarks", "pi.remarks", "비고", max_len=1000)

    extra_raw = pi.get("extra_items") or []
    extra_items = []
    if not isinstance(extra_raw, list) or len(extra_raw) > PI_MAX_EXTRA_ITEMS:
        errors.add("OUT_OF_RANGE", "pi.extra_items", f"추가 품목은 최대 {PI_MAX_EXTRA_ITEMS}개까지 넣을 수 있어요")
        extra_raw = []
    for i, item in enumerate(extra_raw):
        item = item if isinstance(item, dict) else {}
        desc = reader.text(item, "description", f"pi.extra_items[{i}].description", f"추가 품목 {i + 1} 설명",
                           required=True)
        item_qty = to_quantity(item.get("qty"))
        if item_qty is None or not 1 <= item_qty <= MARGIN_MAX_QTY:
            errors.add("OUT_OF_RANGE", f"pi.extra_items[{i}].qty", f"추가 품목 {i + 1} 수량은 1 이상 정수로 입력해 주세요")
        price = to_decimal(item.get("unit_price"), f"pi.extra_items[{i}].unit_price", errors,
                           label=f"추가 품목 {i + 1} 단가", min_value=Decimal(0), max_value=Decimal("100000"),
                           default=Decimal(0))
        if desc or not reader.strict:
            extra_items.append({"description": desc, "qty": item_qty or 0, "unit_price": price or Decimal(0)})

    reader.raise_if_any()
    return {
        "bound": {"product_name": product_name, "volume_ml": volume, "qty": qty, "unit_price": unit_price,
                  "currency": currency, "incoterm": incoterm, "named_place": named_place, "transport_mode": mode,
                  "carton": carton_raw},
        "pi_no": pi_no, "issue_date": issue, "validity_date": validity, "shipment_date": shipment,
        "buyer": buyer_info, "seller": seller_info, "bank": bank_info, "payment_terms": payment,
        "port_loading": port_loading, "port_discharge": port_discharge, "lead_time_days": lead_time,
        "hs_code": hs_code, "remarks": remarks, "extra_items": extra_items,
        "version": str(payload.get("version") or "1.0")[:10],
    }


def _pi_packing(carton_raw, qty, mode):
    """PI 포장 내역 — 카톤 규격이 있으면 서버에서 다시 계산 (없거나 잘못되면 None)."""
    if not carton_raw or not mode:
        return None
    try:
        req, _ = validate_logistics_request({"qty": qty, "carton": carton_raw, "transport_mode": mode,
                                             "dest_region": next(iter(REGIONS)), "incoterm": "EXW", "usd_rate": 1},
                                            require_prices=False)
    except MarginValidationError:
        return None
    p = calc_packing(req["carton"], qty, mode)
    return {
        "cartons": p["cartons"],
        "units_per_carton": req["carton"]["units_per_carton"],
        "last_carton_units": p["last_carton_units"],
        "gross_weight_kg": f"{round_to(p['gross_weight_kg'], 1):,.1f}",
        "cbm": f"{round_to(p['cbm'], 3):,.3f}",
    }


def build_pi_context(payload, *, strict=True):
    """PI 템플릿 변수. 금액은 서버에서 다시 계산하고, 원가·마진·환율 출처는 넣지 않습니다. (§4.6, §6.6)"""
    req = validate_pi(payload, strict=strict)
    b = req["bound"]
    currency = b["currency"]
    amount_places = CURRENCIES[currency]["amount_decimals"]

    main_amount = round_to(b["unit_price"] * b["qty"], amount_places)                       # A_main
    description = b["product_name"]
    if b["volume_ml"] and "ml" not in description.lower():  # 제품명에 용량이 없을 때만 덧붙임
        description += f" ({_fmt(b['volume_ml'])} ml)"
    lines = [{"no": 1, "description": description, "detail": "Cosmetic product", "hs_code": req["hs_code"],
              "qty": f"{b['qty']:,}", "unit_price": _pi_money(b["unit_price"], currency, "price"),
              "amount": _pi_money(main_amount, currency)}]
    extra_total = Decimal(0)
    for i, item in enumerate(req["extra_items"], start=2):
        amount = round_to(item["unit_price"] * item["qty"], amount_places)
        extra_total += amount
        lines.append({"no": i, "description": item["description"] or "—", "detail": "",
                      "hs_code": req["hs_code"], "qty": f"{item['qty']:,}",
                      "unit_price": "FOC" if item["unit_price"] == 0 else _pi_money(item["unit_price"], currency, "price"),
                      "amount": _pi_money(amount, currency)})
    total = main_amount + extra_total                                                        # A_total
    terms = PAYMENT_TERMS[req["payment_terms"]]
    deposit = round_to(total * pct(terms["deposit_pct"]), amount_places)                      # A_dep
    balance = total - deposit                                                                # A_bal

    placeholder = "—"
    issue, validity = req["issue_date"], req["validity_date"]
    fmt_date = lambda d: _pi_date(d) if d else placeholder  # noqa: E731
    term_values = {
        "validity_date": fmt_date(validity),
        "lead_time_days": req["lead_time_days"],
        "moq": f"{MARGIN_MOQ:,}",
        "incoterm": b["incoterm"],
        "named_place": b["named_place"] or placeholder,
        "currency": currency,
    }
    return {
        "pi_no": req["pi_no"] or placeholder,
        "version": req["version"],
        "issue_date": fmt_date(issue),
        "validity_date": fmt_date(validity),
        "seller": {k: v or placeholder for k, v in req["seller"].items()},
        "buyer": {k: v or placeholder for k, v in req["buyer"].items()},
        "bank": {k: v or placeholder for k, v in req["bank"].items()},
        "shipment": {
            "port_loading": req["port_loading"] or placeholder,
            "port_discharge": req["port_discharge"] or placeholder,
            "incoterm": f"{b['incoterm']} {b['named_place']}".strip(),
            "shipment_date": fmt_date(req["shipment_date"]) if req["shipment_date"]
            else f"Within {req['lead_time_days']} days after deposit",
            "transport_mode": {"SEA_LCL": "By Sea (LCL)", "SEA_FCL20": "By Sea (FCL 20ft)",
                               "SEA_FCL40": "By Sea (FCL 40ft)", "AIR": "By Air"}.get(b["transport_mode"], placeholder),
        },
        "currency": currency,
        "lines": lines,
        "total_label": f"TOTAL {b['incoterm']} {b['named_place']}".strip(),
        "total": _pi_money(total, currency),
        "total_words": amount_to_words(total, currency),
        "payment_text": terms["pi_text"],
        "deposit_pct": _fmt(terms["deposit_pct"]),
        "balance_pct": _fmt(100 - terms["deposit_pct"]),
        "deposit": _pi_money(deposit, currency) if terms["deposit_pct"] > 0 else None,
        "balance": _pi_money(balance, currency),
        "packing": _pi_packing(b["carton"], b["qty"], b["transport_mode"]),
        "terms": [t.format(**term_values) for t in PI_STANDARD_TERMS],
        "remarks": req["remarks"],
        "_total_display": f"{currency} {_pi_money(total, currency)}",  # 응답 헤더용 (템플릿에서 쓰지 않음)
    }


def render_pi_pdf(html):
    """HTML → PDF bytes (xhtml2pdf). 미설치 시 MarginPdfUnavailableError (§6.4.8)"""
    try:
        from xhtml2pdf import pisa
    except ImportError as exc:
        raise MarginPdfUnavailableError() from exc
    buffer = io.BytesIO()
    result = pisa.CreatePDF(src=html, dest=buffer, encoding="utf-8")
    if result.err:
        raise RuntimeError(f"xhtml2pdf error count={result.err}")
    return buffer.getvalue()


def _safe_filename(text):
    return re.sub(r"[^A-Za-z0-9._-]+", "-", text).strip("-") or "PI"


def handle_pi(payload, render, *, as_pdf=False):
    """POST render-pi / export-pi-pdf 공통 처리. render(context) → HTML 문자열 (§6.4.7, §6.4.8)"""
    if not isinstance(payload, dict):
        return jsonify(_error_body("INVALID_JSON", "요청 형식이 올바르지 않아요")), 400
    strict = as_pdf or payload.get("mode") != "preview"
    try:
        context = build_pi_context(payload, strict=strict)
        html = render(context)
        headers = {"X-Margin-PI-Total": context["_total_display"]}
        if not as_pdf:
            return Response(html, headers=headers, content_type="text/html; charset=utf-8")
        pdf = render_pi_pdf(html)
    except MarginValidationError as exc:
        return jsonify(_error_body(exc.code, exc.message, exc.fields)), 422
    except MarginPdfUnavailableError:
        return jsonify(_error_body("PDF_ENGINE_UNAVAILABLE",
                                   "PDF 엔진이 없어 인쇄 창으로 열어요. 인쇄 대상에서 'PDF로 저장'을 선택해 주세요")), 501
    except Exception:  # noqa: BLE001
        current_app.logger.exception("margin PI render error")
        code, message = ("PDF_RENDER_FAILED", "PDF를 만들지 못했어요. 인쇄 창에서 'PDF로 저장'을 이용해 주세요") if as_pdf \
            else ("INTERNAL_ERROR", "견적서를 만들지 못했어요. 잠시 후 다시 시도해 주세요")
        return jsonify(_error_body(code, message)), 500
    filename = f"PI_{_safe_filename(context['pi_no'])}_v{_safe_filename(context['version'])}.pdf"
    return Response(pdf, mimetype="application/pdf",
                    headers={**headers, "Content-Disposition": f'attachment; filename="{filename}"'})
