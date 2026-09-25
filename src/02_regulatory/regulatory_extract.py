"""국가별 인허가 규제 — 업로드 문서(텍스트 PDF · 스캔 PDF · 이미지 · .xlsx)에서 성분명·함량을 추출하는 모듈 (담당자 B).

OCR (2026-09-23 추가): 텍스트가 없는 PDF 쪽과 PNG·JPG 이미지는 regulatory_ocr.py(Tesseract, 서버 로컬)로 읽는다.
- PDF 는 쪽마다 텍스트 유무를 먼저 보고, 텍스트가 거의 없는 쪽에만 OCR 을 적용한다(한 쪽을 두 번 읽지 않음).
- OCR 로 읽은 행은 모두 needs_review 로 표시한다. 인식 오류를 임의 확정하지 않는다.
- OCR 이 준비되지 않은 환경에서도 텍스트 PDF·Excel 은 그대로 동작한다.

app.py [B] 영역의 POST /api/regulatory/extract Route 에서만 사용한다. 규제 API 는 호출하지 않는다.

원칙 (src/02_regulatory/regulatory.md 5·7·9·11·13항)
- 성분 표(헤더에 INCI / Ingredient / 성분명 / 원료명 등)가 확인되는 범위만 추출한다. 헤더가 없으면 추출하지 않는다.
  일반 설명 문장을 성분으로 만들지 않기 위해, 표가 아닌 줄은 후보로 삼지 않는다.
- 함량은 문서에 적힌 원문 그대로 보관한다(수치·범위·단위·q.s.). 없는 값은 None 이며 0 으로 바꾸지 않는다.
- 불명확한 항목(문장처럼 보이는 이름, 형식이 다른 함량, 비어 있는 이름)은 needs_review 로 표시하고 추측하지 않는다.
- 업로드 원본은 OS 임시 디렉터리에서만 처리하고 성공·실패와 관계없이 finally 에서 삭제한다. src/ 나 /assets/ 에 두지 않는다.
- 문서 내용·파일명·API Key 는 로그에 남기지 않는다. 외부 AI/OCR 전송은 하지 않는다.
- 스캔 PDF · 이미지 · 그 외 형식은 "현재 텍스트 PDF와 Excel만 지원" 으로 안내하고 추출 성공으로 표시하지 않는다.

제한값 (명세 6항 '확인 예정'에 대한 이번 단계 기본값. regulatory.md 에 기록)
- 파일 1개, 10 MB 이하 / PDF 20쪽 이하 / Excel 시트 20개 이하, 시트당 앞 2,000행 스캔 / 성분 행 최대 200개 (초과분은 잘라내고 안내)
"""

import os
import re
import tempfile
import zipfile
from datetime import datetime

import importlib.util as _importlib_util

_ocr_spec = _importlib_util.spec_from_file_location("regulatory_ocr", os.path.join(os.path.dirname(os.path.abspath(__file__)), "regulatory_ocr.py"))
ocr = _importlib_util.module_from_spec(_ocr_spec)
_ocr_spec.loader.exec_module(ocr)

MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_PDF_PAGES = 20
MAX_XLSX_SHEETS = 20
MAX_SCAN_ROWS = 2000
MAX_ITEMS = 200
MIN_TEXT_CHARS = 20            # 처리한 페이지 전체에서 이보다 적은 글자만 읽히면 스캔 PDF 로 본다

SUPPORTED_EXT = {".pdf": "pdf", ".xlsx": "xlsx", ".png": "image", ".jpg": "image", ".jpeg": "image"}
NOT_YET_EXT = {".gif", ".webp", ".tif", ".tiff", ".bmp", ".heic", ".xls", ".csv", ".doc", ".docx", ".hwp", ".txt"}
UNSUPPORTED_MESSAGE = "현재 텍스트 PDF · 스캔 PDF · PNG/JPG 이미지 · Excel(.xlsx)만 지원합니다."
MIN_PAGE_TEXT_CHARS = 20       # 쪽에서 읽힌 글자(공백 제외)가 이보다 적으면 텍스트 없는 쪽으로 보고 OCR 대상

# 성분 표 헤더 인식 (한글·영문). 셀 하나가 이 패턴에 맞고 짧을 때만 헤더로 본다.
# 제목 변형: 성분명 / 한글 성분명 / 영문 성분명 / INCI Name / INCI / Ingredient (name) / 원료명 / 물질명 / 성분 (INCI)
NAME_HEADER = re.compile(r"(inci|ingredient|raw\s*material|성분\s*명?|원료\s*명?|물질\s*명?|^(한글|국문|영문|영어|korean|english)\b)", re.I)
INDEX_HEADER = re.compile(r"^(no\.?|num\.?|#|번호|순번|연번|순서)$", re.I)          # 행 번호 열
TOTAL_ROW = re.compile(r"^(합\s*계|총\s*계|소\s*계|total|sum|subtotal)\b", re.I)   # 합계 행 — 성분 아님
META_ROW = re.compile(r"^(제품\s*명|제품\s*코드|문서\s*번호|문서\s*구분|작성\s*일|작성\s*부서|작성자|개정\s*번호|결재|승인|검토|작성|비고|document\s*no|product\s*(name|code)|department|approved|reviewed|prepared)\b", re.I)
AMOUNT_HEADER = re.compile(r"(%|％|percent|level|content|concentration|amount|dosage|dose|w/w|wt|함량|배합|비율|농도|투입)", re.I)
ROLE_HEADER = re.compile(r"(role|status|function|purpose|remark|note|comment|역할|용도|구분|비고|기능)", re.I)
HEADER_MAX_LEN = 40
# 함량·역할 열이 없을 때는 이름 열 제목이 이 형태와 정확히 맞아야 헤더로 본다 (문장 속 'ingredients' 오인 방지)
STRICT_NAME_HEADER = re.compile(r"^(inci(\s*name)?|ingredients?(\s*name)?|ingredient\s*\(inci\)|raw\s*materials?|성분\s*명|성분|원료\s*명|원료|물질\s*명)\s*[:：]?$", re.I)

# 함량 원문 형식: q.s. / 숫자(범위) + 선택 단위. 맞지 않으면 원문은 유지하되 확인 필요.
AMOUNT_VALUE = re.compile(
    r"^\s*(?:q\.?\s?s\.?|qs)\b"
    r"|^\s*[<≤>≥~≈]?\s*\d+(?:[.,]\d+)?\s*(?:[-~–]\s*\d+(?:[.,]\d+)?)?\s*(?:%|％|ppm|mg/g|g/kg|mg/kg|wt%|w/w|w/v)?\s*$",
    re.I,
)
SECTION_LINE = re.compile(r"^\s*\d{1,2}\s*[/.)]\s")           # "04 / Requested ingredients" 같은 절 제목
SENTENCE_HINT = re.compile(r"[.!?]\s+\S|[.!?]$")               # 문장 부호로 끝나거나 문장이 이어짐
MAX_NAME_LEN = 80
MAX_NAME_WORDS = 6

# 문서 내 참고 정보 (원문 그대로만 보관, 시장 코드로 바꾸지 않는다)
MARKET_LABEL = re.compile(r"(distribution\s*countr|target\s*market|market|countr|대상\s*국가|수출\s*국가|판매\s*국가|판매\s*시장|대상\s*시장)", re.I)
USE_LABEL = re.compile(r"(application|product\s*type|usage|use\s*type|leave[- ]on|rinse[- ]off|사용\s*방법|제품\s*유형|사용\s*부위|사용\s*조건)", re.I)


class ExtractError(Exception):
    """추출 실패. kind: validation(400) | limit(400) | unsupported(415) | unreadable(422)"""

    STATUS = {"validation": 400, "limit": 400, "unsupported": 415, "unreadable": 422,
              "ocr_unavailable": 503, "ocr_timeout": 422, "ocr_failed": 422}

    def __init__(self, kind, message):
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.http_status = self.STATUS.get(kind, 400)

    def to_dict(self):
        return {"kind": self.kind, "message": self.message}


def _now_iso():
    return datetime.now().astimezone().isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# 공통: 파일 수신·검증·임시 저장
# ---------------------------------------------------------------------------

def classify_filename(filename):
    """확장자로 처리 종류를 정한다. 지원 안 함은 unsupported, 알 수 없는 확장자는 validation."""
    ext = os.path.splitext(filename or "")[1].lower()
    if ext in SUPPORTED_EXT:
        return SUPPORTED_EXT[ext], ext
    if ext in NOT_YET_EXT:
        raise ExtractError("unsupported", UNSUPPORTED_MESSAGE)
    raise ExtractError("validation", "지원하지 않는 파일 형식이에요. PDF 또는 .xlsx 파일을 올려 주세요.")


def save_upload_to_temp(stream, ext):
    """업로드 스트림을 OS 임시 파일에 저장한다. 용량 초과면 즉시 중단하고 파일을 지운다. 경로를 돌려준다."""
    fd, path = tempfile.mkstemp(prefix="cosmoa-reg-", suffix=ext)
    total = 0
    try:
        with os.fdopen(fd, "wb") as out:
            while True:
                chunk = stream.read(256 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_FILE_BYTES:
                    raise ExtractError("limit", "파일이 너무 커요. 10 MB 이하 파일을 올려 주세요.")
                out.write(chunk)
    except BaseException:
        _remove_quietly(path)
        raise
    if total == 0:
        _remove_quietly(path)
        raise ExtractError("validation", "빈 파일이에요. 내용이 있는 파일을 올려 주세요.")
    return path, total


def _remove_quietly(path):
    try:
        os.remove(path)
    except OSError:
        pass


def verify_real_format(path, kind):
    """확장자만 믿지 않고 실제 파일 서명을 확인한다."""
    with open(path, "rb") as f:
        head = f.read(8)
    if kind == "pdf":
        if not head.startswith(b"%PDF"):
            raise ExtractError("unreadable", "PDF 파일로 읽을 수 없어요. 파일이 손상되었거나 확장자와 내용이 달라요.")
    elif kind == "image":
        if not (head.startswith(b"\x89PNG\r\n\x1a\n") or head.startswith(b"\xff\xd8\xff")):
            raise ExtractError("unreadable", "PNG 또는 JPG 이미지로 읽을 수 없어요. 파일이 손상되었거나 확장자와 내용이 달라요.")
    elif kind == "xlsx":
        if not head.startswith(b"PK") or not zipfile.is_zipfile(path):
            raise ExtractError("unreadable", "Excel(.xlsx) 파일로 읽을 수 없어요. 파일이 손상되었거나 확장자와 내용이 달라요.")
        with zipfile.ZipFile(path) as z:
            if "xl/workbook.xml" not in z.namelist():
                raise ExtractError("unreadable", "Excel(.xlsx) 통합 문서 구조가 아니에요. .xls 는 .xlsx 로 저장한 뒤 올려 주세요.")


def extract_upload(filename, stream, sheet=None):
    """Route 진입점. 임시 저장 → 형식 확인 → 추출. 어떤 경우에도 임시 파일을 삭제한다."""
    kind, ext = classify_filename(filename)
    path, size = save_upload_to_temp(stream, ext)
    try:
        verify_real_format(path, kind)
        if kind == "pdf":
            result = extract_pdf(path)
        elif kind == "image":
            result = extract_image(path)
        else:
            result = extract_xlsx(path, sheet)
    except ocr.OcrError as exc:
        raise ExtractError(exc.kind, exc.message)
    finally:
        _remove_quietly(path)
    result["file"] = {"name": os.path.basename(filename or ""), "kind": kind, "size": size}
    result["extracted_at"] = _now_iso()
    return result


# ---------------------------------------------------------------------------
# 표 해석 (PDF·Excel 공통)
# ---------------------------------------------------------------------------

def _cell_text(v):
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v).strip()


def find_header(cells):
    """셀 목록에서 성분 표 헤더를 찾는다. {name, amount, role} 열 index 또는 None.

    표 헤더로 인정하는 조건 (설명 문장·절 제목을 헤더로 오인하지 않기 위해)
    - 비어 있지 않은 셀이 2개 이상이고 모두 짧다(HEADER_MAX_LEN 이하)
    - 성분명 열이 있고, 함량 열이나 역할 열이 함께 있거나 성분명 열 제목이 STRICT_NAME_HEADER 와 정확히 맞는다
    """
    texts = [_norm_header_text(_cell_text(c)) for c in cells]
    nonempty = [t for t in texts if t]
    if len(nonempty) < 2 or any(len(t) > HEADER_MAX_LEN for t in nonempty):
        return None
    if any(SENTENCE_HINT.search(t) for t in nonempty):
        return None
    name_idx = name2_idx = amount_idx = role_idx = index_idx = None
    for i, t in enumerate(texts):
        if not t:
            continue
        if index_idx is None and INDEX_HEADER.match(t):
            index_idx = i
        elif NAME_HEADER.search(t) and not AMOUNT_HEADER.search(t.replace("INCI", "").replace("inci", "")):
            if name_idx is None:
                name_idx = i
            elif name2_idx is None:
                name2_idx = i                      # 두 번째 이름 열 (예: 한글 성분명 + INCI Name) — 같은 행 = 같은 성분
        elif amount_idx is None and AMOUNT_HEADER.search(t):
            amount_idx = i
        elif role_idx is None and ROLE_HEADER.search(t):
            role_idx = i
    if name_idx is None:
        return None
    if amount_idx is None and role_idx is None and name2_idx is None and not STRICT_NAME_HEADER.match(texts[name_idx]):
        return None
    # 한글 열과 영문 열이 둘 다 있으면 한글 열을 대표 이름으로 (후보 검색은 한글 엔드포인트가 넓다)
    if name2_idx is not None and _has_hangul(texts[name2_idx]) and not _has_hangul(texts[name_idx]):
        name_idx, name2_idx = name2_idx, name_idx
    return {"name": name_idx, "name2": name2_idx, "amount": amount_idx, "role": role_idx, "index": index_idx}


def _norm_header_text(t):
    """제목 비교용 정규화: 앞뒤·중복 공백 정리, 줄바꿈 제거, 한글 음절 사이 공백 제거(OCR), 끝의 구두점 제거. 대소문자는 re.I 로 무시."""
    t = re.sub(r"\s+", " ", (t or "").replace("\n", " ")).strip()
    t = re.sub(r"(?<=[\uac00-\ud7a3]) (?=[\uac00-\ud7a3])", "", t)
    t = re.sub(r"[:：.。,;·]+$", "", t).strip()
    return t


def _has_hangul(t):
    return any("\uac00" <= ch <= "\ud7a3" for ch in (t or ""))


def _review_name(name):
    """이름이 성분명으로 보기 어려운 이유 목록. 비어 있으면 문제 없음."""
    reasons = []
    if not name:
        reasons.append("성분명이 비어 있어요. 직접 입력해 주세요.")
        return reasons
    if len(name) > MAX_NAME_LEN:
        reasons.append("성분명이 너무 길어요. 문장이 섞였는지 확인해 주세요.")
    words = name.split()
    if len(words) > MAX_NAME_WORDS or SENTENCE_HINT.search(name):
        reasons.append("문장처럼 보여요. 성분명만 남겨 주세요.")
    return reasons


def _tidy_name(t):
    t = re.sub(r"\s*/\s*", "/", (t or "").strip())     # 성분명의 '/' 주변 공백 제거 (INCI 표기에는 공백이 없다)
    return re.sub(r"\s+", " ", t)


AMOUNT_FULL = re.compile(
    r"^\s*(?:q\.?\s?s\.?|qs)(?:\s*(?:to|ad)\s*\d+(?:[.,]\d+)?\s*[%％]?)?\s*$"
    r"|^\s*[<≤>≥~≈]?\s*\d+(?:[.,]\d+)?\s*(?:[-~–]\s*\d+(?:[.,]\d+)?)?\s*(?:%|％|ppm|mg/g|g/kg|mg/kg|wt%|w/w|w/v)?\s*$",
    re.I,
)


def _split_amount(text):
    """OCR 셀에 함량 뒤로 다른 열 글이 붙은 경우('4.0% Required', 'q.s. to 100% Balance') 함량 형식에 온전히 맞는
    앞부분만 함량으로, 나머지는 비고로 돌려준다. 형식에 맞는 부분이 없으면 원문 그대로."""
    t = (text or "").strip()
    if not t or AMOUNT_FULL.match(t):
        return t, None
    tokens = t.split()
    for n in range(len(tokens) - 1, 0, -1):
        head = " ".join(tokens[:n])
        if AMOUNT_FULL.match(head):
            return head, " ".join(tokens[n:])
    return t, None


def make_item(index, name, amount, role, location, unit_hint=None, inci=None):
    name = _tidy_name(name)
    inci = _tidy_name(inci) or None
    if not name and inci:
        name, inci = inci, None                  # 한글 이름 칸이 비면 영문 이름을 대표 이름으로
    amount = (amount or "").strip() or None
    reasons = _review_name(name)
    if amount is not None and not AMOUNT_VALUE.match(amount):
        reasons.append("함량 형식을 확인해 주세요. (원문 그대로 두었어요)")
    return {
        "id": "r%d" % index,
        "name_raw": name,
        "inci_raw": inci,                          # 같은 행의 영문(INCI) 이름 열 원문. 없으면 None
        "amount_raw": amount,                      # 문서 원문 그대로. 없으면 None (0 아님)
        "amount_unit_hint": unit_hint,             # 열 제목에 단위가 있을 때만 (예: "%")
        "role_raw": (role or "").strip() or None,
        "location": location,
        "source": "text",                          # text | ocr (OCR 로 읽은 행은 _mark_ocr_items 가 바꾼다)
        "needs_review": bool(reasons),
        "review_reasons": reasons,
    }


def _unit_hint(header_text):
    t = header_text or ""
    if "%" in t or "％" in t:
        return "%"
    m = re.search(r"\b(ppm|mg/g|g/kg|mg/kg)\b", t, re.I)
    return m.group(1) if m else None


# ---------------------------------------------------------------------------
# PDF (텍스트 레이어) — pypdf layout 모드로 표 행을 읽는다
# ---------------------------------------------------------------------------

def _split_layout_line(line):
    """레이아웃 텍스트 한 줄을 2칸 이상 공백 기준으로 셀로 나눈다."""
    return [c.strip() for c in re.split(r"\s{2,}", line.strip()) if c.strip()]


def _pdf_pages_text(path):
    try:
        from pypdf import PdfReader
    except ImportError:
        raise ExtractError("unreadable", "서버에 PDF 처리 패키지(pypdf)가 없어요. 관리자에게 requirements 설치를 요청해 주세요.")
    try:
        reader = PdfReader(path)
        if reader.is_encrypted:
            try:
                if not reader.decrypt(""):
                    raise ExtractError("unreadable", "암호로 보호된 PDF 예요. 암호를 해제한 파일을 올려 주세요.")
            except ExtractError:
                raise
            except Exception:
                raise ExtractError("unreadable", "암호로 보호된 PDF 예요. 암호를 해제한 파일을 올려 주세요.")
        n_pages = len(reader.pages)
    except ExtractError:
        raise
    except Exception:
        raise ExtractError("unreadable", "PDF 를 읽지 못했어요. 파일이 손상되었는지 확인하고 다시 올려 주세요.")
    if n_pages > MAX_PDF_PAGES:
        raise ExtractError("limit", "PDF 는 %d쪽 이하만 처리해요. (이 파일: %d쪽)" % (MAX_PDF_PAGES, n_pages))
    pages, failed = [], []
    for i in range(n_pages):
        try:
            text = reader.pages[i].extract_text(extraction_mode="layout") or ""
        except Exception:
            text = ""
            failed.append(i + 1)
        pages.append(text)
    return pages, failed


def parse_table_lines(lines, location_of):
    """레이아웃 줄 목록에서 성분 표를 찾아 항목을 만든다. location_of(line_index) 로 원문 위치 문자열을 받는다."""
    items, header, blank_run, header_text = [], None, 0, ""
    doc_market = doc_use = None
    for idx, line in enumerate(lines):
        cells = _split_layout_line(line)
        if header is None:
            if len(cells) >= 2:
                joined = " ".join(cells)
                if doc_market is None and MARKET_LABEL.search(cells[0]) and len(cells[0]) <= HEADER_MAX_LEN:
                    doc_market = {"text": " ".join(cells[1:]), "location": location_of(idx)}
                if doc_use is None and USE_LABEL.search(cells[0]) and len(cells[0]) <= HEADER_MAX_LEN:
                    doc_use = {"text": " ".join(cells[1:]), "location": location_of(idx)}
                del joined
            h = None if (not cells or SECTION_LINE.match(line)) else find_header(cells)
            if h:
                header = h
                header_text = cells[h["amount"]] if h["amount"] is not None and h["amount"] < len(cells) else ""
                blank_run = 0
            continue
        # 표 본문
        if not cells:
            blank_run += 1
            if blank_run >= 2:
                header = None            # 표 끝. 다음 표가 또 있으면 다시 헤더부터 찾는다
            continue
        blank_run = 0
        if SECTION_LINE.match(line) or (len(cells) == 1 and len(cells[0]) > MAX_NAME_LEN):
            header = None
            continue
        need = 2 if header["amount"] is not None else 1
        if len(cells) < need:
            # 함량 열이 있는 표에서 셀이 하나뿐인 줄: 이름만 있는 행일 수도, 설명일 수도 있어 확인 필요로 남긴다
            if len(cells) == 1 and len(cells[0]) <= MAX_NAME_LEN and not SENTENCE_HINT.search(cells[0]):
                items.append(make_item(len(items) + 1, cells[0], None, None, location_of(idx), _unit_hint(header_text)))
                items[-1]["needs_review"] = True
                items[-1]["review_reasons"].append("함량 칸을 찾지 못했어요. 원문을 확인해 주세요.")
            else:
                header = None
            continue
        name = cells[header["name"]] if header["name"] < len(cells) else cells[0]
        name2 = cells[header["name2"]] if header.get("name2") is not None and header["name2"] < len(cells) else None
        amount = cells[header["amount"]] if header["amount"] is not None and header["amount"] < len(cells) else None
        role = cells[header["role"]] if header["role"] is not None and header["role"] < len(cells) else None
        if TOTAL_ROW.match(name or ""):
            header = None                          # 합계 행 = 표 끝
            continue
        items.append(make_item(len(items) + 1, name, amount, role, location_of(idx), _unit_hint(header_text), inci=name2))
    return items, doc_market, doc_use


# ---------------------------------------------------------------------------
# OCR 위치 기반 표 복원 (이미지 · 스캔 PDF 쪽)
#   ocr.ocr_table() 이 돌려준 줄(셀마다 x 범위·신뢰도)에서 제목 줄을 찾고, 제목 셀의 x 범위로 열 구간을 만들어
#   각 줄의 셀을 열에 배정한다. 행 번호 열이 있는데 번호가 없는 줄은 앞 행의 이어지는 줄(두 줄 셀)로 합친다.
# ---------------------------------------------------------------------------

def _column_bands(header_cells, line_height):
    """제목 셀 x 범위 → 열 구간 목록 [{"core": (x0, x1), "band": (l, r)}]. 제목 셀 순서(왼쪽부터)가 열 index 다.
    band: 이웃 제목과의 중간선 사이. 바깥쪽(첫·끝 열)은 제목 셀에서 줄 높이 3배까지만 — 그 밖의 셀은 표 밖으로 본다."""
    xs = sorted((c["x0"], c["x1"]) for c in header_cells)
    margin = max(30, int(line_height * 3))
    bands = []
    for i, (x0, x1) in enumerate(xs):
        left = (xs[i - 1][1] + x0) // 2 if i > 0 else x0 - margin
        right = (x1 + xs[i + 1][0]) // 2 if i + 1 < len(xs) else x1 + margin
        bands.append({"core": (x0, x1), "band": (left, right)})
    return bands


def _assign_cells(line, bands):
    """줄의 셀들을 열에 배정: 제목 셀과 x 범위가 겹치면 그 열, 아니면 중간선 구간, 둘 다 아니면 표 밖(무시).
    한 열에 여러 셀이 오면 공백으로 잇는다. 반환: [열별 {"text","conf"} 또는 None]"""
    cols = [None] * len(bands)
    m = max(8, int(line["height"] * 0.8))
    for c in line["cells"]:
        mid = (c["x0"] + c["x1"]) // 2
        best = None
        for j, b in enumerate(bands):
            if c["x1"] >= b["core"][0] - m and c["x0"] <= b["core"][1] + m:
                best = j
                break
        if best is None:
            for j, b in enumerate(bands):
                if b["band"][0] <= mid < b["band"][1]:
                    best = j
                    break
        if best is None:
            continue                               # 표 열 바깥의 글 (여백 메모 등)
        if cols[best] is None:
            cols[best] = {"text": c["text"], "conf": c["conf"]}
        else:
            cols[best]["text"] += " " + c["text"]
            cols[best]["conf"] = min(cols[best]["conf"], c["conf"])
    return cols


def _looks_garbled(text):
    """글자·숫자가 절반 미만이면 인식이 깨진 셀로 본다."""
    t = (text or "").replace(" ", "")
    if not t:
        return False
    good = sum(1 for ch in t if ch.isalnum() or "\uac00" <= ch <= "\ud7a3" or ch in "/-().%,")
    return good / len(t) < 0.5


def parse_table_ocr(lines, location):
    """ocr_table() 줄 목록 → (items, doc_market, doc_use, info). info: {"header_found", "header_text", "recognized_samples"}"""
    items, header, bands, header_text = [], None, None, ""
    doc_market = doc_use = None
    prev_top = None
    info = {"header_found": False, "header_text": None, "recognized_samples": []}
    for ln in lines:
        cells = [c["text"] for c in ln["cells"]]
        if not cells:
            continue
        if header is None:
            if len(info["recognized_samples"]) < 3 and len(ln["text"]) >= 4:
                info["recognized_samples"].append(ln["text"][:60])
            if len(cells) >= 2 and len(cells[0]) <= HEADER_MAX_LEN:
                if doc_market is None and MARKET_LABEL.search(cells[0]):
                    doc_market = {"text": " ".join(cells[1:]), "location": location}
                if doc_use is None and USE_LABEL.search(cells[0]):
                    doc_use = {"text": " ".join(cells[1:]), "location": location}
            h = find_header(cells)
            if h:
                header, bands = h, _column_bands(ln["cells"], ln["height"])
                header_text = cells[h["amount"]] if h["amount"] is not None else ""
                info["header_found"], info["header_text"] = True, ln["text"]
                prev_top = ln["top"]
            continue
        # ---- 표 본문 ----
        if prev_top is not None and ln["top"] - prev_top > max(60, ln["height"] * 4):
            header = None                          # 세로로 크게 떨어진 줄 = 표 밖 (비고·결재란 등)
            continue
        prev_top = ln["top"]
        cols = _assign_cells(ln, bands)
        get = lambda key: (cols[header[key]]["text"].strip() if header.get(key) is not None and cols[header[key]] else "")
        conf_of = lambda key: (cols[header[key]]["conf"] if header.get(key) is not None and cols[header[key]] else 100.0)
        name, name2, amount, role, index = get("name"), get("name2"), get("amount"), get("role"), get("index")
        amount, spill = _split_amount(amount)
        if spill and not role:
            role = spill
        joined = " ".join(cells)
        if TOTAL_ROW.match(name) or TOTAL_ROW.match(joined) or TOTAL_ROW.match(name2):
            header = None                          # 합계 행 = 표 끝
            continue
        if META_ROW.match(name) or META_ROW.match(joined):
            header = None
            continue
        if not name and not name2 and not amount:
            continue
        # 행 번호 열이 있는데 번호가 없는 줄 → 앞 행의 두 번째 줄 (두 줄로 표시된 셀)
        continuation = header.get("index") is not None and items and not re.match(r"^\d{1,3}$", index or "")
        if continuation and (name or name2) and not re.match(r"^\d{1,3}$", (name or "")[:3]):
            prev = items[-1]
            if name:
                prev["name_raw"] = (prev["name_raw"] + " " + name).strip()
            if name2:
                prev["inci_raw"] = ((prev.get("inci_raw") or "") + " " + name2).strip()
            if amount and not prev["amount_raw"]:
                prev["amount_raw"] = amount
                if not AMOUNT_VALUE.match(amount):
                    prev["review_reasons"].append("함량 형식을 확인해 주세요. (원문 그대로 두었어요)")
            if "두 줄로 나뉜 셀을 합쳤어요" not in " ".join(prev["review_reasons"]):
                prev["review_reasons"].append("두 줄로 나뉜 셀을 합쳤어요. 성분명·함량 연결을 확인해 주세요.")
            prev["needs_review"] = True
            continue
        item = make_item(len(items) + 1, name, amount, role, location, _unit_hint(header_text), inci=name2)
        low = [k for k in ("name", "name2", "amount") if header.get(k) is not None and cols[header[k]] and conf_of(k) < ocr.LOW_CONF]
        if low or _looks_garbled(name) or _looks_garbled(name2) or (amount and _looks_garbled(amount)):
            item["review_reasons"].append("인식 신뢰도가 낮아요. 원문과 대조해 주세요.")
            item["needs_review"] = True
        if header.get("amount") is not None and not amount:
            item["review_reasons"].append("함량 칸을 읽지 못했어요. 원문을 확인해 주세요.")
            item["needs_review"] = True
        items.append(item)
    return items, doc_market, doc_use, info


def _ocr_with_retry(img, timeout):
    """psm 6(균일 블록)으로 인식하고 제목 줄을 못 찾으면 psm 4(가변 크기 단일 열)로 한 번 더 시도한다."""
    lines, chars, meta = ocr.ocr_table(img, timeout=timeout, psm=6)
    if chars >= ocr.MIN_OCR_CHARS and not any(find_header([c["text"] for c in ln["cells"]]) for ln in lines):
        lines2, chars2, meta2 = ocr.ocr_table(img, timeout=timeout, psm=4)
        if any(find_header([c["text"] for c in ln["cells"]]) for ln in lines2):
            return lines2, chars2, meta2, True
    return lines, chars, meta, False


def _mark_ocr_items(items):
    for it in items:
        if "(OCR)" in (it.get("location") or ""):
            it["source"] = "ocr"
            it["needs_review"] = True
            it["review_reasons"].append("OCR 인식 결과예요. 원문과 대조해서 성분명·함량을 확인해 주세요.")
        else:
            it.setdefault("source", "text")
    return items


def extract_pdf(path):
    pages, failed = _pdf_pages_text(path)
    text_pages = [i + 1 for i, p in enumerate(pages) if len(re.sub(r"\s+", "", p)) >= MIN_PAGE_TEXT_CHARS]
    image_pages = [i + 1 for i in range(len(pages)) if (i + 1) not in text_pages]   # 텍스트가 거의 없는 쪽 = OCR 대상

    ocr_info = {"available": False, "applied_pages": [], "skipped_pages": [], "no_text_pages": [], "engine": None, "message": None}
    ocr_lines_by_page = {}
    if image_pages:
        info = ocr.availability()
        ocr_info["available"] = info["available"]
        ocr_info["engine"] = ("tesseract " + str(info["version"])) if info["version"] else None
        if not info["available"]:
            if not text_pages:
                raise ExtractError("ocr_unavailable", "텍스트를 읽을 수 없는 PDF(스캔·이미지)라 OCR 이 필요한데 " + info["message"])
            ocr_info["skipped_pages"] = image_pages
            ocr_info["message"] = "이미지 쪽은 OCR 이 준비되지 않아 읽지 못했어요. " + info["message"]
        else:
            budget = ocr.Budget()
            for pno in image_pages:
                if len(ocr_info["applied_pages"]) >= ocr.OCR_MAX_PAGES or budget.remaining() <= 1:
                    ocr_info["skipped_pages"].append(pno)
                    continue
                img = ocr.render_pdf_page(path, pno - 1)
                lines, chars, _meta, _retried = _ocr_with_retry(img, budget.page_timeout())
                ocr_info["applied_pages"].append(pno)
                if chars < ocr.MIN_OCR_CHARS:
                    ocr_info["no_text_pages"].append(pno)
                else:
                    ocr_lines_by_page[pno] = lines

    if not text_pages and not ocr_lines_by_page:
        if image_pages and ocr_info["available"]:
            # OCR 은 돌았지만 글자를 거의 못 읽음 → 인식 결과 없음 (오류 아님)
            result = _finish("pdf", [], ["OCR 로 읽었지만 인식된 글자가 거의 없어요. 해상도가 높은 스캔본이나 원본 파일을 올려 주세요."],
                             {"pages": len(pages), "processed": "1~%d쪽" % len(pages)}, None, None)
            result["ocr"] = ocr_info
            return result
        raise ExtractError("unsupported", "텍스트를 읽을 수 없는 PDF 예요. " + UNSUPPORTED_MESSAGE)

    # 텍스트 쪽: 레이아웃 파서 / OCR 쪽: 위치 기반 표 파서. 쪽 순서대로 합친다
    items, doc_market, doc_use = [], None, None
    ocr_header_missing = []
    for pno in range(1, len(pages) + 1):
        if pno in text_pages:
            page_lines = pages[pno - 1].splitlines()
            its, dm, du = parse_table_lines(page_lines, lambda i, _p=pno: "%d쪽" % _p)
        elif pno in ocr_lines_by_page:
            its, dm, du, pinfo = parse_table_ocr(ocr_lines_by_page[pno], "%d쪽 (OCR)" % pno)
            if not pinfo["header_found"]:
                ocr_header_missing.append(pno)
        else:
            continue
        for it in its:
            it["id"] = "r%d" % (len(items) + 1)
            items.append(it)
        doc_market = doc_market or dm
        doc_use = doc_use or du
    _mark_ocr_items(items)

    notes = []
    if ocr_info["applied_pages"]:
        notes.append("OCR 적용: %s. 인식 결과는 원문과 대조가 필요해 모두 ‘확인 필요’로 표시했어요." % ", ".join("%d쪽" % p for p in ocr_info["applied_pages"]))
    if ocr_info["no_text_pages"]:
        notes.append("OCR 로 글자를 거의 읽지 못한 쪽: %s" % ", ".join("%d쪽" % p for p in ocr_info["no_text_pages"]))
    if ocr_header_missing:
        notes.append("글자는 읽었지만 성분 표 제목(한글 성분명·INCI Name·함량 등)을 찾지 못한 쪽: %s" % ", ".join("%d쪽" % p for p in ocr_header_missing))
    if ocr_info["skipped_pages"]:
        notes.append("읽지 않은 쪽: %s (%s)" % (", ".join("%d쪽" % p for p in ocr_info["skipped_pages"]),
                                            ocr_info["message"] or "OCR 은 파일당 %d쪽·%d초까지만 처리해요" % (ocr.OCR_MAX_PAGES, ocr.OCR_TOTAL_BUDGET)))
    if failed:
        notes.append("텍스트 추출에 실패한 쪽: %s" % ", ".join("%d쪽" % p for p in failed))
    result = _finish("pdf", items, notes, {"pages": len(pages), "processed": "1~%d쪽" % len(pages), "text_pages": text_pages, "ocr_pages": ocr_info["applied_pages"]}, doc_market, doc_use)
    result["ocr"] = ocr_info
    return result


# ---------------------------------------------------------------------------
# 이미지 (PNG · JPG) — 전체를 OCR
# ---------------------------------------------------------------------------

def extract_image(path):
    info = ocr.availability()
    if not info["available"]:
        raise ExtractError("ocr_unavailable", "이미지 인식(OCR)이 준비되지 않았어요. " + info["message"])
    img = ocr.open_image_file(path)
    width, height = img.size
    lines, chars, meta, retried = _ocr_with_retry(img, ocr.OCR_PAGE_TIMEOUT)
    ocr_info = {"available": True, "applied_pages": [1], "skipped_pages": [], "no_text_pages": [] if chars >= ocr.MIN_OCR_CHARS else [1],
                "engine": ("tesseract " + str(info["version"])) if info["version"] else "tesseract", "message": None,
                "psm": meta.get("psm"), "retried": retried, "header_found": False}
    scope = {"pages": 1, "processed": "이미지 1장 (%d x %d px)" % (width, height), "ocr_pages": [1]}
    if chars < ocr.MIN_OCR_CHARS:
        # 글자 인식 실패 (표 구조 실패와 구분)
        result = _finish("image", [], ["OCR 로 읽었지만 인식된 글자가 거의 없어요. 글자가 선명하고 기울어지지 않은 이미지를 다시 올려 주세요."], scope, None, None)
        result["ocr"] = ocr_info
        result["ocr"]["outcome"] = "no_text"
        return result
    items, doc_market, doc_use, pinfo = parse_table_ocr(lines, "이미지 (OCR)")
    _mark_ocr_items(items)
    ocr_info["header_found"] = pinfo["header_found"]
    if not pinfo["header_found"]:
        # 표 구조 인식 실패 (글자는 읽음)
        notes = ["글자는 읽었지만 성분 표 제목(예: 한글 성분명 · INCI Name · 함량)을 찾지 못했어요. 표 제목 줄이 선명한 이미지를 올리거나 ‘행 추가’로 직접 입력해 주세요."]
        if pinfo["recognized_samples"]:
            notes.append("인식된 줄 예시: " + " / ".join(pinfo["recognized_samples"]))
        result = _finish("image", [], notes, scope, doc_market, doc_use)
        result["ocr"] = ocr_info
        result["ocr"]["outcome"] = "no_header"
        return result
    notes = ["OCR 적용: 이미지 전체. 인식 결과는 원문과 대조가 필요해 모두 ‘확인 필요’로 표시했어요."]
    if retried:
        notes.append("첫 인식에서 표 제목을 찾지 못해 다른 인식 방식(psm 4)으로 다시 읽었어요.")
    result = _finish("image", items, notes, scope, doc_market, doc_use)
    result["ocr"] = ocr_info
    result["ocr"]["outcome"] = "extracted" if items else "no_rows"
    if not items:
        result["notes"].append("표 제목은 찾았지만 성분 행을 읽지 못했어요. 표가 잘리지 않았는지 확인해 주세요.")
    return result


# ---------------------------------------------------------------------------
# Excel (.xlsx) — openpyxl 읽기 전용. 여러 시트면 시트 선택을 요청한다
# ---------------------------------------------------------------------------

def _open_workbook(path):
    try:
        from openpyxl import load_workbook
    except ImportError:
        raise ExtractError("unreadable", "서버에 Excel 처리 패키지(openpyxl)가 없어요. 관리자에게 requirements 설치를 요청해 주세요.")
    try:
        return load_workbook(path, read_only=True, data_only=True)
    except Exception:
        raise ExtractError("unreadable", "Excel 파일을 읽지 못했어요. 암호가 걸려 있거나 손상된 파일인지 확인해 주세요.")


def list_sheets(path):
    wb = _open_workbook(path)
    try:
        names = list(wb.sheetnames)
        if len(names) > MAX_XLSX_SHEETS:
            raise ExtractError("limit", "시트가 %d개를 넘는 Excel 은 처리하지 않아요. (이 파일: %d개)" % (MAX_XLSX_SHEETS, len(names)))
        return names
    finally:
        wb.close()


def extract_xlsx(path, sheet=None):
    names = list_sheets(path)
    if not names:
        raise ExtractError("unreadable", "시트가 없는 Excel 파일이에요.")
    if len(names) > 1 and not sheet:
        return {"status": "sheet_required", "sheets": names, "items": [], "review_count": 0, "notes": [],
                "scope": {"sheets": len(names)}, "document_market": None, "document_use": None}
    target = sheet or names[0]
    if target not in names:
        raise ExtractError("validation", "선택한 시트가 파일에 없어요. 시트를 다시 선택해 주세요.")

    wb = _open_workbook(path)
    try:
        ws = wb[target]
        items, header, header_text, scanned, truncated_scan = [], None, "", 0, False
        doc_market = doc_use = None
        for r_idx, row in enumerate(ws.iter_rows(values_only=True), start=1):
            scanned += 1
            if scanned > MAX_SCAN_ROWS:
                truncated_scan = True
                break
            cells = [_cell_text(v) for v in row]
            if not any(cells):
                continue
            if header is None:
                nonempty = [c for c in cells if c]
                if len(nonempty) >= 2 and len(nonempty[0]) <= HEADER_MAX_LEN:
                    if doc_market is None and MARKET_LABEL.search(nonempty[0]):
                        doc_market = {"text": " ".join(nonempty[1:]), "location": "%s!%d행" % (target, r_idx)}
                    if doc_use is None and USE_LABEL.search(nonempty[0]):
                        doc_use = {"text": " ".join(nonempty[1:]), "location": "%s!%d행" % (target, r_idx)}
                h = find_header(cells)
                if h:
                    header = h
                    header_text = cells[h["amount"]] if h["amount"] is not None else ""
                continue
            name = cells[header["name"]] if header["name"] < len(cells) else ""
            amount = cells[header["amount"]] if header["amount"] is not None and header["amount"] < len(cells) else None
            role = cells[header["role"]] if header["role"] is not None and header["role"] < len(cells) else None
            if not name and not amount:
                continue                     # 성분 열·함량 열이 모두 빈 행은 건너뛴다 (다른 열의 메모 등)
            col_letter = _col_letter(header["name"] + 1)
            items.append(make_item(len(items) + 1, name, amount, role, "%s!%s%d" % (target, col_letter, r_idx), _unit_hint(header_text)))
    finally:
        wb.close()

    notes = []
    if truncated_scan:
        notes.append("시트 앞 %d행까지만 확인했어요. 그 뒤 행은 처리하지 않았어요." % MAX_SCAN_ROWS)
    scope = {"sheets": len(names), "selected_sheet": target, "scanned_rows": min(scanned, MAX_SCAN_ROWS)}
    result = _finish("xlsx", items, notes, scope, doc_market, doc_use)
    result["sheets"] = names
    return result


def _col_letter(n):
    s = ""
    while n > 0:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def _finish(kind, items, notes, scope, doc_market, doc_use):
    if len(items) > MAX_ITEMS:
        notes.append("성분 행이 %d개를 넘어 앞 %d개만 표시했어요." % (MAX_ITEMS, MAX_ITEMS))
        items = items[:MAX_ITEMS]
    status = "extracted" if items else "empty"
    if not items and not any(("인식된 글자가 거의 없어요" in n) or ("성분 표 제목" in n) for n in notes):
        notes.append("성분 표(INCI name · 성분명 · 원료명 등 제목이 있는 표)를 찾지 못했어요. 표 형식을 확인하거나 직접 입력해 주세요.")
    return {
        "status": status,
        "items": items,
        "review_count": sum(1 for it in items if it["needs_review"]),
        "notes": notes,
        "scope": scope,
        "document_market": doc_market,   # 문서에 적힌 국가/시장 원문. 시장 코드로 바꾸지 않는다
        "document_use": doc_use,         # 문서에 적힌 제품 유형·사용 조건 원문
    }
