"""원가 경쟁력 및 마진 시뮬레이션 비즈니스 로직 (담당자 C).

기능 명세: src/03_margin/margin.md
- app.py 의 Route 는 입력 추출 → 이 모듈 호출 → 응답 반환만 합니다.
- 금액 계산은 모두 Decimal 로 하고, 응답 직전에만 float 로 변환합니다. (margin.md §4.0)
- 현재 구현 범위: Tab 1 수량별 공급 단가 및 마진 시뮬레이터 (margin.md §8.2 0~2단계)
"""

from decimal import ROUND_CEILING, ROUND_HALF_UP, Decimal, InvalidOperation

from flask import current_app, jsonify

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


def out(value, places=2):
    """응답 직렬화용 반올림 후 float."""
    quant = Decimal(1).scaleb(-places)
    return float(Decimal(value).quantize(quant, rounding=ROUND_HALF_UP))


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


def get_master_data():
    """마스터 데이터·기본값. 수식 §3.2"""
    data = {
        "defaults": {
            "moq": MARGIN_MOQ,
            "tiers": DEFAULT_TIERS,
            "tier_presets": TIER_PRESETS,
            "target_margin": float(DEFAULT_TARGET_MARGIN),
            "min_margin": float(DEFAULT_MIN_MARGIN),
            "max_target_margin": float(MAX_TARGET_MARGIN),
            "fixed_cost": float(DEFAULT_FIXED_COST),
            "loss_rate": float(DEFAULT_LOSS_RATE),
            "max_tiers": MARGIN_MAX_TIERS,
            "max_qty": MARGIN_MAX_QTY,
            "max_unit_cost": float(MAX_UNIT_COST),
            "krw_round_unit": float(KRW_PRICE_ROUND_UNIT),
        },
        "volume_discounts": [{"min_qty": q, "rates": rates} for q, rates in VOLUME_DISCOUNTS],
        "cost_components": [{"key": k, "label": label} for k, label in COST_COMPONENTS],
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
