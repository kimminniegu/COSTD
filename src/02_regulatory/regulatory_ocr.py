"""국가별 인허가 규제 — 서버 로컬 OCR 래퍼 (담당자 B). 외부 AI/OCR 서비스에 전송하지 않는다.

엔진: Tesseract OCR (pytesseract) + 스캔 PDF 페이지 렌더링 pypdfium2 + 이미지 처리 Pillow (+ numpy 로 괘선 제거).
- 실행 파일 위치: 환경변수 TESSERACT_CMD → PATH 의 tesseract → Windows 기본 설치 경로 순으로 찾는다.
- 언어 데이터: 환경변수 TESSDATA_PREFIX (kor.traineddata·eng.traineddata 가 있는 폴더). 없으면 엔진 기본 tessdata.
- 한글·영문 동시 인식(kor+eng). 언어 데이터가 없으면 available=False 와 설치 안내를 돌려준다.

전처리 (2026-09-23 보완): 표 괘선(테두리)이 있으면 Tesseract 가 줄을 잘못 나눠 제목 행·일부 행이 깨진다.
  회색조 → 괘선 제거(긴 가로·세로 검은 선을 흰색으로) → 작은 이미지는 확대 순으로 정리한 뒤 인식한다.
표 복원: image_to_data 의 단어 위치로 줄을 묶고, 단어 사이 가로 간격이 크면 다른 셀로 나눈다(셀마다 x 범위·신뢰도 보관).
  텍스트만 돌려주는 image_to_string 은 열 사이 공백이 사라질 수 있어 표 해석에는 위치 정보를 쓴다.

제한값 (regulatory_extract.py 의 파일 제한에 더해 적용)
- OCR 적용 페이지 최대 OCR_MAX_PAGES 장, 페이지당 OCR_PAGE_TIMEOUT 초, 파일당 총 OCR_TOTAL_BUDGET 초
- 이미지 화소 OCR_MAX_PIXELS 초과는 거부, 긴 변이 OCR_MAX_SIDE 를 넘으면 축소, OCR_UPSCALE_BELOW 보다 작으면 확대
- 렌더링·전처리한 중간 이미지는 메모리에서만 다루고 파일로 남기지 않는다. 인식 텍스트·파일명은 로그에 남기지 않는다.
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
OCR_UPSCALE_BELOW = 1600       # px, 긴 변이 이보다 작으면 2배(최대 OCR_MAX_SIDE)까지 확대 — 작은 글자 인식률
OCR_MIN_SIDE = 300             # px, 이보다 작으면 확대
RENDER_SCALE = 200 / 72        # PDF 페이지 렌더링 약 200 dpi
MIN_OCR_CHARS = 10             # 인식된 글자(공백 제외)가 이보다 적으면 '인식 결과 없음'
GRID_DARK = 160                # 이 밝기보다 어두우면 검은 픽셀
GRID_H_RATIO = 0.25            # 폭의 25% 이상 이어진 가로 검은 선 = 괘선
GRID_V_RATIO = 0.12            # 높이의 12% 이상 이어진 세로 검은 선 = 괘선
CELL_GAP_FACTOR = 1.6          # 단어 간격이 줄 높이의 1.6배를 넘으면 다른 셀
LOW_CONF = 55                  # 셀 평균 신뢰도가 이보다 낮으면 '인식 신뢰도 낮음'

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
        import numpy  # noqa: F401
    except ImportError:
        info["missing"].append("numpy(pip)")
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
# 이미지 전처리
# ---------------------------------------------------------------------------

def remove_grid_lines(img):
    """표 괘선 제거: 폭·높이의 일정 비율 이상 이어진 검은 가로·세로 선을 흰색으로 바꾼다. 글자 획은 짧아서 남는다."""
    import numpy as np
    a = np.array(img.convert("L"))
    h, w = a.shape
    dark = a < GRID_DARK
    out = a.copy()

    def _wipe_runs(mask_1d, min_len):
        # 연속 True 구간 중 길이가 min_len 이상인 구간의 [start, end) 목록
        padded = np.concatenate(([False], mask_1d, [False]))
        edges = np.flatnonzero(padded[1:] != padded[:-1])
        starts, ends = edges[::2], edges[1::2]
        keep = (ends - starts) >= min_len
        return zip(starts[keep], ends[keep])

    min_h = max(20, int(w * GRID_H_RATIO))
    for y in np.flatnonzero(dark.sum(axis=1) >= min_h):
        for s, e in _wipe_runs(dark[y], min_h):
            out[y, s:e] = 255
    min_v = max(20, int(h * GRID_V_RATIO))
    for x in np.flatnonzero(dark.sum(axis=0) >= min_v):
        for s, e in _wipe_runs(dark[:, x], min_v):
            out[s:e, x] = 255
    from PIL import Image
    return Image.fromarray(out)


def prepare_image(img):
    """Pillow 이미지를 인식용으로 정리: 화소 제한 확인, 회색조, 괘선 제거, 크기 조정."""
    from PIL import Image, ImageOps
    w, h = img.size
    if w * h > OCR_MAX_PIXELS:
        raise OcrError("limit", "이미지가 너무 커요 (%d x %d). 긴 변 5000px 이하로 줄여서 올려 주세요." % (w, h))
    if img.mode not in ("L", "RGB"):
        img = img.convert("RGB")
    img = ImageOps.autocontrast(img.convert("L"), cutoff=1)
    img = remove_grid_lines(img)
    longest = max(w, h)
    if longest > OCR_MAX_SIDE:
        r = OCR_MAX_SIDE / float(longest)
    elif longest < OCR_UPSCALE_BELOW:
        r = min(2.0, OCR_MAX_SIDE / float(longest))
    elif longest < OCR_MIN_SIDE:
        r = OCR_MIN_SIDE / float(longest)
    else:
        r = 1.0
    if r != 1.0:
        img = img.resize((max(1, int(w * r)), max(1, int(h * r))), Image.LANCZOS)
    return img


# ---------------------------------------------------------------------------
# 인식 — 위치 정보 기반 표 복원
# ---------------------------------------------------------------------------

def _is_hangul_char(ch):
    return "\uac00" <= ch <= "\ud7a3"


def _join_words(prev_text, next_text):
    """단어 이어 붙이기. kor 모델은 한글을 음절마다 다른 '단어'로 돌려주므로 한글 뒤에 한글이 오면 공백 없이 붙인다."""
    if prev_text and next_text and _is_hangul_char(prev_text[-1]) and _is_hangul_char(next_text[0]):
        return prev_text + next_text
    return prev_text + " " + next_text


RESIDUE_CHARS = set("_|ㅣ。、'\".,-—–~`´‘’“”·:;")


def _is_residue(text):
    """괘선을 지운 자리에 남는 잔재('_', '|', 'ㅣ', '。' 등)만으로 된 짧은 토큰. 셀 경계를 이어 붙이므로 버린다."""
    t = (text or "").strip()
    return 0 < len(t) <= 2 and all(ch in RESIDUE_CHARS for ch in t)


def _tesseract_config(psm):
    return "--psm %d -c preserve_interword_spaces=1" % psm


def _run(pytesseract, fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except RuntimeError:
        raise OcrError("ocr_timeout", "OCR 처리 시간이 %d초를 넘어 중단했어요. 해상도를 낮추거나 페이지를 나눠 올려 주세요." % kwargs.get("timeout", OCR_PAGE_TIMEOUT))
    except OcrError:
        raise
    except Exception:
        raise OcrError("ocr_failed", "OCR 처리 중 오류가 났어요. 이미지 형식을 확인하고 다시 시도해 주세요. " + INSTALL_HINT)


def ocr_table(img, timeout=OCR_PAGE_TIMEOUT, psm=6):
    """이미지 → 줄 목록. 각 줄 = {"top","height","cells":[{"text","x0","x1","conf"}], "text"(셀을 3칸 공백으로 이은 문자열)}.

    text 는 기존 레이아웃 파서(2칸 이상 공백 = 셀 경계)와 호환된다. 위치·신뢰도는 표 열 복원과 '확인 필요' 판정에 쓴다.
    """
    try:
        pytesseract, _ = _configure()
    except ImportError:
        raise OcrError("ocr_unavailable", availability()["message"] or INSTALL_HINT)
    prepared = prepare_image(img)
    data = _run(pytesseract, pytesseract.image_to_data, prepared, lang=OCR_LANGS, config=_tesseract_config(psm),
                timeout=timeout, output_type=pytesseract.Output.DICT)
    groups = {}
    n = len(data.get("text", []))
    for i in range(n):
        t = (data["text"][i] or "").strip()
        if not t or _is_residue(t):
            continue
        try:
            conf = float(data["conf"][i])
        except (TypeError, ValueError):
            conf = -1.0
        key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
        groups.setdefault(key, []).append({"x0": int(data["left"][i]), "x1": int(data["left"][i]) + int(data["width"][i]),
                                            "top": int(data["top"][i]), "h": int(data["height"][i]), "text": t, "conf": conf})
    lines = []
    for words in groups.values():
        words.sort(key=lambda w: w["x0"])
        top = min(w["top"] for w in words)
        height = max(1, int(sorted(w["h"] for w in words)[len(words) // 2]))
        gap_limit = max(12, int(height * CELL_GAP_FACTOR))
        cells, cur = [], None
        for w in words:
            if cur is not None and w["x0"] - cur["x1"] <= gap_limit:
                cur["text"] = _join_words(cur["text"], w["text"])
                cur["x1"] = max(cur["x1"], w["x1"])
                cur["confs"].append(w["conf"])
            else:
                cur = {"text": w["text"], "x0": w["x0"], "x1": w["x1"], "confs": [w["conf"]]}
                cells.append(cur)
        for c in cells:
            valid = [v for v in c.pop("confs") if v >= 0]
            c["conf"] = round(sum(valid) / len(valid), 1) if valid else -1.0
        lines.append({"top": top, "height": height, "cells": cells, "text": "   ".join(c["text"] for c in cells)})
    lines.sort(key=lambda ln: ln["top"])
    chars = sum(len(c["text"].replace(" ", "")) for ln in lines for c in ln["cells"])
    return lines, chars, {"width": prepared.width, "height": prepared.height, "psm": psm}


def ocr_lines(img, timeout=OCR_PAGE_TIMEOUT, psm=6):
    """호환용: 줄 텍스트 목록과 글자 수만 돌려준다 (ocr_table 의 text 필드)."""
    lines, chars, _ = ocr_table(img, timeout, psm)
    return [ln["text"] for ln in lines], chars


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
