"""국가별 인허가 규제 — 서버 로컬 OCR 래퍼 (담당자 B). 외부 AI/OCR 서비스에 전송하지 않는다.

엔진: Tesseract OCR (pytesseract) + 스캔 PDF 페이지 렌더링 pypdfium2 + 이미지 처리 Pillow.
- 실행 파일 위치: 환경변수 TESSERACT_CMD → PATH 의 tesseract → Windows 기본 설치 경로 순으로 찾는다.
- 언어 데이터: 환경변수 TESSDATA_PREFIX (kor.traineddata·eng.traineddata 가 있는 폴더). 없으면 엔진 기본 tessdata.
- 한글·영문 동시 인식(kor+eng). 언어 데이터가 없으면 available=False 와 설치 안내를 돌려준다.

제한값 (regulatory_extract.py 의 파일 제한에 더해 적용)
- OCR 적용 페이지 최대 OCR_MAX_PAGES 장, 페이지당 OCR_PAGE_TIMEOUT 초, 파일당 총 OCR_TOTAL_BUDGET 초
- 이미지 화소 OCR_MAX_PIXELS 초과는 거부, 긴 변이 OCR_MAX_SIDE 를 넘으면 축소해 인식
- 렌더링·축소한 중간 이미지는 메모리에서만 다루고 파일로 남기지 않는다. 인식 텍스트·파일명은 로그에 남기지 않는다.
"""

import os
import shutil
import time

OCR_LANGS = "kor+eng"
OCR_MAX_PAGES = 10
OCR_PAGE_TIMEOUT = 25          # 초, 페이지(이미지) 하나
OCR_TOTAL_BUDGET = 90          # 초, 파일 하나
OCR_MAX_PIXELS = 30_000_000    # 약 5500 x 5500
OCR_MAX_SIDE = 2600            # px, 이보다 크면 축소 (인식 시간·메모리 제한)
OCR_MIN_SIDE = 300             # px, 이보다 작으면 인식이 어려워 확대
RENDER_SCALE = 200 / 72        # PDF 페이지 렌더링 약 200 dpi
MIN_OCR_CHARS = 10             # 인식된 글자(공백 제외)가 이보다 적으면 '인식 결과 없음'

_TESSERACT_DEFAULTS = (
    r"C:\Program Files\Tesseract-OCR\tesseract.exe",
    r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
    "/usr/bin/tesseract",
    "/usr/local/bin/tesseract",
    "/opt/homebrew/bin/tesseract",
)

INSTALL_HINT = (
    "Windows: 'winget install UB-Mannheim.TesseractOCR' 로 엔진을 설치하고, kor.traineddata 를 tessdata 폴더에 넣은 뒤 "
    ".env 의 TESSERACT_CMD / TESSDATA_PREFIX 를 지정해 주세요. "
    "Linux 서버: apt install tesseract-ocr tesseract-ocr-kor tesseract-ocr-eng. 자세한 절차는 regulatory.md 13항."
)


class OcrError(Exception):
    """kind: ocr_unavailable(503) | ocr_timeout(422) | ocr_failed(422) | limit(400)"""

    STATUS = {"ocr_unavailable": 503, "ocr_timeout": 422, "ocr_failed": 422, "limit": 400}

    def __init__(self, kind, message):
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.http_status = self.STATUS.get(kind, 422)


# ---------------------------------------------------------------------------
# 엔진 확인
# ---------------------------------------------------------------------------

def find_tesseract_cmd():
    env = (os.getenv("TESSERACT_CMD") or "").strip()
    if env and os.path.isfile(env):
        return env
    on_path = shutil.which("tesseract")
    if on_path:
        return on_path
    for p in _TESSERACT_DEFAULTS:
        if os.path.isfile(p):
            return p
    return None


def _configure():
    """pytesseract 에 실행 파일 경로를 알려 준다. 패키지가 없으면 ImportError."""
    import pytesseract  # noqa: F401  (pip: pytesseract)
    cmd = find_tesseract_cmd()
    if cmd:
        pytesseract.pytesseract.tesseract_cmd = cmd
    prefix = (os.getenv("TESSDATA_PREFIX") or "").strip()
    if prefix and os.path.isdir(prefix):
        os.environ["TESSDATA_PREFIX"] = prefix
    return pytesseract, cmd


_cache = {"at": 0.0, "info": None}


def availability(refresh=False):
    """{"available", "engine", "version", "cmd", "langs", "missing", "message"} — 결과는 60초 캐시."""
    now = time.time()
    if not refresh and _cache["info"] and now - _cache["at"] < 60:
        return _cache["info"]
    info = {"available": False, "engine": "tesseract", "version": None, "cmd": None, "langs": [], "missing": [], "message": ""}
    try:
        import PIL  # noqa: F401
    except ImportError:
        info["missing"].append("Pillow(pip)")
    try:
        import pypdfium2  # noqa: F401
    except ImportError:
        info["missing"].append("pypdfium2(pip)")
    try:
        pytesseract, cmd = _configure()
    except ImportError:
        info["missing"].append("pytesseract(pip)")
        pytesseract, cmd = None, None
    if pytesseract is not None:
        if not cmd:
            info["missing"].append("tesseract 실행 파일")
        else:
            info["cmd"] = cmd
            try:
                info["version"] = str(pytesseract.get_tesseract_version())
                langs = pytesseract.get_languages(config="")
                info["langs"] = sorted(langs)
                for need in ("kor", "eng"):
                    if need not in langs:
                        info["missing"].append("%s.traineddata" % need)
            except Exception:
                info["missing"].append("tesseract 실행 불가 (버전·언어 목록 확인 실패)")
    info["available"] = not info["missing"]
    info["message"] = "" if info["available"] else ("OCR 준비가 안 됐어요. 부족한 항목: " + ", ".join(info["missing"]) + ". " + INSTALL_HINT)
    _cache["at"], _cache["info"] = now, info
    return info


# ---------------------------------------------------------------------------
# 이미지 준비·인식
# ---------------------------------------------------------------------------

def prepare_image(img):
    """Pillow 이미지를 인식용으로 정리: 화소 제한 확인, 회색조 변환, 너무 크면 축소·너무 작으면 확대."""
    from PIL import Image
    w, h = img.size
    if w * h > OCR_MAX_PIXELS:
        raise OcrError("limit", "이미지가 너무 커요 (%d x %d). 긴 변 5000px 이하로 줄여서 올려 주세요." % (w, h))
    if img.mode not in ("L", "RGB"):
        img = img.convert("RGB")
    img = img.convert("L")
    longest = max(w, h)
    if longest > OCR_MAX_SIDE:
        r = OCR_MAX_SIDE / float(longest)
        img = img.resize((max(1, int(w * r)), max(1, int(h * r))), Image.LANCZOS)
    elif longest < OCR_MIN_SIDE:
        r = OCR_MIN_SIDE / float(longest)
        img = img.resize((int(w * r), int(h * r)), Image.LANCZOS)
    return img


def ocr_image(img, timeout=OCR_PAGE_TIMEOUT):
    """이미지 → 줄 단위 텍스트. 열 사이 공백을 보존해(preserve_interword_spaces) 표 해석에 쓸 수 있게 한다."""
    try:
        pytesseract, _ = _configure()
    except ImportError:
        raise OcrError("ocr_unavailable", availability()["message"] or INSTALL_HINT)
    try:
        text = pytesseract.image_to_string(prepare_image(img), lang=OCR_LANGS,
                                           config="--psm 6 -c preserve_interword_spaces=1", timeout=timeout)
    except OcrError:
        raise
    except RuntimeError:
        # pytesseract 는 timeout 초과 시 RuntimeError 를 던진다
        raise OcrError("ocr_timeout", "OCR 처리 시간이 %d초를 넘어 중단했어요. 해상도를 낮추거나 페이지를 나눠 올려 주세요." % timeout)
    except Exception:
        raise OcrError("ocr_failed", "OCR 처리 중 오류가 났어요. 이미지 형식을 확인하고 다시 시도해 주세요. " + INSTALL_HINT)
    return text or ""


def ocr_lines(img, timeout=OCR_PAGE_TIMEOUT):
    text = ocr_image(img, timeout)
    lines = [ln.rstrip() for ln in text.replace("\r\n", "\n").split("\n")]
    chars = sum(len(ln.replace(" ", "")) for ln in lines)
    return lines, chars


def open_image_file(path):
    from PIL import Image, UnidentifiedImageError
    try:
        img = Image.open(path)
        img.load()
        return img
    except UnidentifiedImageError:
        raise OcrError("ocr_failed", "이미지 파일을 열지 못했어요. PNG·JPG 형식인지 확인해 주세요.")
    except Exception:
        raise OcrError("ocr_failed", "이미지 파일을 읽지 못했어요. 손상된 파일인지 확인해 주세요.")


def render_pdf_page(path, page_index, scale=RENDER_SCALE):
    """pypdfium2 로 PDF 한 쪽을 Pillow 이미지로 렌더링 (메모리에서만)."""
    try:
        import pypdfium2 as pdfium
    except ImportError:
        raise OcrError("ocr_unavailable", "스캔 PDF 렌더링 패키지(pypdfium2)가 없어요. " + INSTALL_HINT)
    pdf = pdfium.PdfDocument(path)
    try:
        page = pdf[page_index]
        try:
            return page.render(scale=scale).to_pil()
        finally:
            page.close()
    finally:
        pdf.close()


class Budget:
    """파일 하나의 총 OCR 시간 예산."""

    def __init__(self, seconds=OCR_TOTAL_BUDGET):
        self.deadline = time.monotonic() + seconds

    def remaining(self):
        return self.deadline - time.monotonic()

    def page_timeout(self):
        return max(1, min(OCR_PAGE_TIMEOUT, int(self.remaining())))
