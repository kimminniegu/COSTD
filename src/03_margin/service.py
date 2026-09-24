"""원가 경쟁력 및 마진 시뮬레이션 — 견적서 PDF · 현재 환율 (담당자 C)

화면(margin.js)이 계산한 견적 값과 팝업에서 입력한 고객사 정보를 받아 검증하고,
회사 양식 견적서 PDF 를 만듭니다.
- 문서 템플릿: src/03_margin/margin_quote_document.html
- 공급사(우리 회사) 정보는 아래 COMPANY 에서 관리하고, 화면이 보낸 값으로 바꾸지 않습니다.
- 원가·마진율 등 내부 값은 받지 않습니다. (오픈북형일 때 바이어에게 공개하는 원가 구성만 받음)
- 금액 합계는 서버에서 다시 더해 문서 안의 숫자가 서로 어긋나지 않게 합니다.
- 현재 USD/KRW 환율: 수출 대금을 원화로 받는 기준인 TTB(전신환 받으실 때)를 씁니다.
  한국수출입은행 ttb(EXIM_API_KEY 있을 때) → 없거나 실패하면 ExchangeRate-API 중간값 × 0.99 추정 TTB(키 없음).
  둘 다 하루 1회 고시·갱신 값이라 10분 동안 메모리에 캐시합니다.
"""

from __future__ import annotations

import io
import logging
import math
import os
import re
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import requests

from xhtml2pdf import pisa

try:  # xhtml2pdf 0.2.17+ : 문서가 읽을 수 있는 파일 범위를 정하는 정책 (이전 버전은 제한 없음)
    from xhtml2pdf.config.resources import ResourceAccessPolicy
except ImportError:
    ResourceAccessPolicy = None

# 우리 회사 정보 — 견적서 머리글·서명란에 자동으로 들어갑니다. 회사 정보가 바뀌면 여기만 고칩니다.
COMPANY = {
    "name": "COSTD Co., Ltd.",
    "address": "",   # 예: "123, Teheran-ro, Gangnam-gu, Seoul, Republic of Korea"
    "phone": "",     # 예: "+82-2-1234-5678"
    "email": "",     # 예: "sales@costd.co.kr"
}

MAX_TEXT = 200
MAX_LINES = 20
INCOTERMS = {"EXW", "FOB", "CFR", "CIF"}
MODES = {"one", "split", "open"}

# 한글 회사명·주소도 깨지지 않도록 시스템의 한글 TTF 를 찾아 씁니다. (없으면 Helvetica — 영문만 표시)
_FONT_CANDIDATES = [
    (Path("C:/Windows/Fonts/malgun.ttf"), Path("C:/Windows/Fonts/malgunbd.ttf")),
    (Path("/usr/share/fonts/truetype/nanum/NanumGothic.ttf"), Path("/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf")),
]


def _font_paths():
    for regular, bold in _FONT_CANDIDATES:
        if regular.exists():
            return {"regular": regular.as_posix(), "bold": (bold if bold.exists() else regular).as_posix()}
    return None


def quote_profile(user):
    """팝업을 열 때 자동으로 채울 값 — 우리 회사 정보 + 로그인한 담당자."""
    user = user or {}
    return {"company": dict(COMPANY), "contact": {"name": user.get("name", ""), "email": user.get("email", "")}}


def _text(data, key, label, required=False, default=""):
    value = data.get(key, default)
    value = "" if value is None else str(value).strip()
    if required and not value:
        raise ValueError(f"{label}을(를) 입력하세요.")
    if len(value) > MAX_TEXT:
        raise ValueError(f"{label}은(는) {MAX_TEXT}자 이하로 입력하세요.")
    return value


def _number(value, label, minimum=0.0):
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{label} 값이 올바르지 않아요.") from None
    if not math.isfinite(number) or number < minimum:
        raise ValueError(f"{label} 값이 올바르지 않아요.")
    return number


def _money(value):
    return f"{value:,.2f}"


_ONES = ["", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE", "TEN", "ELEVEN",
         "TWELVE", "THIRTEEN", "FOURTEEN", "FIFTEEN", "SIXTEEN", "SEVENTEEN", "EIGHTEEN", "NINETEEN"]
_TENS = ["", "", "TWENTY", "THIRTY", "FORTY", "FIFTY", "SIXTY", "SEVENTY", "EIGHTY", "NINETY"]


def _words_below_1000(n):
    words = []
    if n >= 100:
        words += [_ONES[n // 100], "HUNDRED"]
        n %= 100
    if n >= 20:
        words.append(_TENS[n // 10] + (f"-{_ONES[n % 10]}" if n % 10 else ""))
    elif n:
        words.append(_ONES[n])
    return words


def amount_in_words(amount, currency="USD"):
    """1234.5 → 'SAY US DOLLARS ONE THOUSAND TWO HUNDRED THIRTY-FOUR AND CENTS FIFTY ONLY.'"""
    whole, cents = divmod(int(round(amount * 100)), 100)
    words = []
    for value, name in ((10**9, "BILLION"), (10**6, "MILLION"), (10**3, "THOUSAND"), (1, "")):
        chunk = (whole // value) % 1000
        if chunk:
            words += _words_below_1000(chunk) + ([name] if name else [])
    text = " ".join(words) or "ZERO"
    unit = "US DOLLARS" if currency == "USD" else currency
    tail = f" AND CENTS {' '.join(_words_below_1000(cents))}" if cents else ""
    return f"SAY {unit} {text}{tail} ONLY."


def build_quote_context(payload, user=None):
    """화면에서 보낸 견적 값을 검증해 문서 템플릿 context 로 바꿉니다. 잘못된 값이면 ValueError."""
    if not isinstance(payload, dict):
        raise ValueError("견적서 정보가 없어요.")
    buyer = payload.get("buyer") or {}
    contact = payload.get("contact") or {}
    if not isinstance(buyer, dict) or not isinstance(contact, dict):
        raise ValueError("입력 정보 형식이 올바르지 않아요.")

    mode = payload.get("mode")
    if mode not in MODES:
        raise ValueError("견적서 형식이 올바르지 않아요.")
    incoterm = payload.get("incoterm")
    if incoterm not in INCOTERMS:
        raise ValueError("인코텀즈가 올바르지 않아요.")

    try:
        issue = date.fromisoformat(str(payload.get("issue_date", "")))
    except ValueError:
        issue = date.today()
    validity_days = int(_number(payload.get("validity_days", 30), "유효기간", 1))

    raw_lines = payload.get("lines") or []
    if not isinstance(raw_lines, list) or not raw_lines or len(raw_lines) > MAX_LINES:
        raise ValueError("견적 품목이 없어요.")
    lines, total = [], 0.0
    for i, line in enumerate(raw_lines, 1):
        if not isinstance(line, dict):
            raise ValueError("견적 품목 형식이 올바르지 않아요.")
        amount = round(_number(line.get("amount"), f"{i}번 품목 금액"), 2)
        unit_price = line.get("unit_price")
        lines.append({
            "no": i,
            "description": _text(line, "description", f"{i}번 품목명", required=True),
            "qty": _text(line, "qty", f"{i}번 수량"),
            "unit_price": "" if unit_price in (None, "") else _money(_number(unit_price, f"{i}번 단가")),
            "amount": _money(amount),
        })
        total += amount

    breakdown = []
    if mode == "open":
        for row in payload.get("breakdown") or []:
            if isinstance(row, dict):
                breakdown.append({
                    "label": _text(row, "label", "원가 구성 항목", required=True),
                    "usd": _money(_number(row.get("usd"), "원가 구성 금액", -1e9)),
                    "share": _text(row, "share", "원가 구성 비중"),
                })

    profile = quote_profile(user)
    currency = "USD"
    return {
        "quote_no": _text(payload, "quote_no", "견적 번호", required=True),
        "issue_date": issue.strftime("%d %b %Y"),
        "valid_until": (issue + timedelta(days=validity_days)).strftime("%d %b %Y"),
        "validity_days": validity_days,
        "currency": currency,
        "seller": profile["company"],
        "contact": {
            "name": _text(contact, "name", "담당자") or profile["contact"]["name"],
            "email": _text(contact, "email", "담당자 이메일") or profile["contact"]["email"],
        },
        "buyer": {
            "company": _text(buyer, "company", "고객사 회사명", required=True),
            "country": _text(buyer, "country", "고객사 국가"),
            "address": _text(buyer, "address", "고객사 주소"),
            "attn": _text(buyer, "attn", "고객사 담당자"),
            "email": _text(buyer, "email", "고객사 이메일"),
        },
        "incoterm": incoterm,
        "named_place": _text(payload, "named_place", "지정 장소")
        or ("Korea" if incoterm in ("EXW", "FOB") else "Port of destination"),
        "payment": _text(payload, "payment", "결제 조건") or "T/T",
        "lead_time": _text(payload, "lead_time", "납기"),
        "moq": _text(payload, "moq", "MOQ"),
        "discount_note": _text(payload, "discount_note", "할인 안내"),
        "remarks": _text(payload, "remarks", "비고"),
        "lines": lines,
        "breakdown": breakdown,
        "total": _money(round(total, 2)),
        "total_words": amount_in_words(round(total, 2), currency),
        "font": _font_paths(),
    }


def quote_filename(quote_no):
    safe = re.sub(r"[^A-Za-z0-9_-]+", "_", quote_no).strip("_") or "quotation"
    return f"Quotation_{safe}.pdf"


def html_to_pdf(html):
    buffer = io.BytesIO()
    options = {}
    font = _font_paths()
    if ResourceAccessPolicy is not None:
        # 원격 요청은 막고, 로컬 파일은 한글 글꼴 폴더만 읽게 합니다.
        options["resource_policy"] = ResourceAccessPolicy(
            allow_remote=False, base_dir=Path(font["regular"]).parent if font else None)
    result = pisa.CreatePDF(html, dest=buffer, encoding="utf-8", **options)
    if result.err:
        raise RuntimeError("PDF 를 만들지 못했어요.")
    return buffer.getvalue()


# ---------------------------------------------------------------------------
# 현재 USD/KRW 환율 — 화면 상단 '기준 환율' 옆 표시 · [적용] 버튼용
# ---------------------------------------------------------------------------
log = logging.getLogger(__name__)
EXIM_URL = os.getenv("EXIM_API_URL", "https://oapi.koreaexim.go.kr/site/program/financial/exchangeJSON")
OPEN_FX_URL = "https://open.er-api.com/v6/latest/USD"
TTB_FROM_MID = 0.99   # 수출입은행 USD 전신환 스프레드 1% (TTB = 매매기준율 × 0.99) — 중간값에서 TTB 추정용
FX_TIMEOUT = 5
FX_CACHE_SEC = 600
KST = timezone(timedelta(hours=9))
_fx_cache = {"at": 0.0, "data": None}


def _fx_exim():
    """한국수출입은행 USD ttb(전신환 받으실 때). 휴일·11시 이전에는 빈 응답이라 최근 영업일까지 최대 7일 거슬러 올라갑니다."""
    key = os.getenv("EXIM_API_KEY")
    if not key:
        return None
    today = datetime.now(KST).date()
    for back in range(8):
        day = today - timedelta(days=back)
        res = requests.get(EXIM_URL, params={"authkey": key, "searchdate": day.strftime("%Y%m%d"), "data": "AP01"},
                           timeout=FX_TIMEOUT)
        res.raise_for_status()
        rows = res.json()
        usd = next((r for r in rows or [] if r.get("cur_unit") == "USD"), None)
        ttb = str((usd or {}).get("ttb") or "").replace(",", "").strip()   # 예: "1,372.63" → 1372.63
        if ttb:
            return {"rate": round(float(ttb), 2), "source": "한국수출입은행 TTB(전신환 받으실 때)", "as_of": day.isoformat()}
    return None


def _fx_open():
    """ExchangeRate-API 공개 엔드포인트 (키 없음, 하루 1회 갱신). 시장 중간값만 주므로 × 0.99 로 TTB 를 추정합니다."""
    res = requests.get(OPEN_FX_URL, timeout=FX_TIMEOUT)
    res.raise_for_status()
    data = res.json()
    rate = (data.get("rates") or {}).get("KRW")
    if data.get("result") != "success" or not rate:
        return None
    updated = datetime.fromtimestamp(data.get("time_last_update_unix", time.time()), KST)
    return {"rate": round(float(rate) * TTB_FROM_MID, 2), "source": "ExchangeRate-API 중간값 × 0.99 (추정 TTB)",
            "as_of": updated.strftime("%Y-%m-%d %H:%M")}


def usd_krw_rate():
    """현재 USD/KRW TTB {"rate": 1351.12, "source": "...", "as_of": "..."} — 두 소스 모두 실패하면 RuntimeError.
    (홈 DB exchange_rates 에는 매매기준율만 있어 TTB 조회에 쓰지 않습니다.)"""
    now = time.time()
    if _fx_cache["data"] and now - _fx_cache["at"] < FX_CACHE_SEC:
        return _fx_cache["data"]
    for fetch in (_fx_exim, _fx_open):
        try:
            data = fetch()
        except (requests.RequestException, ValueError, TypeError) as err:
            log.warning("환율 조회 실패 (%s): %s", fetch.__name__, err)
            data = None
        if data:
            _fx_cache.update(at=now, data=data)
            return data
    raise RuntimeError("현재 환율을 불러오지 못했어요.")
