"""Flask Entry Point.

현재 단계에서는 페이지 이동을 위한 기본 Route만 정의합니다.
API 처리, AI 기능, 계산 로직, 파일 분석 등은 각 담당자가
자신의 MD 파일(src/<폴더>/<이름>.md)을 기준으로 이후 추가합니다.

규칙
- 아래 "페이지 Route"는 PM 관리 영역입니다. 삭제하거나 URL을 변경하지 마세요.
- 새 Route는 파일 하단의 담당자별 영역에 추가하고, 기존 URL과 충돌하지 않게 합니다.
- API Key는 코드에 직접 쓰지 말고 os.getenv()로 불러옵니다.
"""

import os
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, abort, render_template, send_from_directory

BASE_DIR = Path(__file__).resolve().parent
SRC_DIR = BASE_DIR / "src"

# 개발 서버 재시작 때 이전 프로세스에서 상속된 키 대신 수정한 .env를 반영합니다.
load_dotenv(BASE_DIR / ".env", override=True)

# 일반적인 templates/ 대신 src/ 전체를 템플릿 폴더로 사용합니다.
# 템플릿 이름은 src/ 기준 상대 경로입니다. 예: "02_regulatory/regulatory.html"
# 기본 static 폴더는 사용하지 않고, 아래 asset() Route가 src/ 안의 CSS·JS를 제공합니다.
app = Flask(__name__, template_folder=str(SRC_DIR), static_folder=None)
app.config["SECRET_KEY"] = os.getenv("FLASK_SECRET_KEY", "dev-only-change-me")

# src/ 안에서 브라우저에 제공해도 되는 파일 확장자 (HTML 템플릿, MD 명세서는 제외)
ASSET_EXTENSIONS = {
    ".css", ".js", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico",
    ".woff", ".woff2", ".ttf", ".otf", ".json",
}


@app.route("/assets/<path:filename>")
def asset(filename):
    """src/ 내부의 정적 파일 제공. 예: url_for('asset', filename='common/style.css')"""
    if Path(filename).suffix.lower() not in ASSET_EXTENSIONS:
        abort(404)
    return send_from_directory(SRC_DIR, filename)


# ---------------------------------------------------------------------------
# 페이지 Route (PM 관리) — 삭제 / URL 변경 금지
# ---------------------------------------------------------------------------

@app.route("/")
def home():
    return render_template("01_home/home.html")


@app.route("/regulatory")
def regulatory():
    return render_template("02_regulatory/regulatory.html")


@app.route("/margin-calculator")
def margin():
    return render_template("03_margin/margin.html")


@app.route("/ai-formulation")
def simulation():
    return render_template("04_simulation/simulation.html")


@app.route("/dev-request")
def dev_request():
    return render_template("05_requisition/requisition.html")


# ---------------------------------------------------------------------------
# 담당자별 Backend Route 추가 영역
# 자신의 영역에만 추가하세요. URL은 자신의 페이지 경로를 접두사로 사용합니다.
# ---------------------------------------------------------------------------

# [A] Home — 접두사: /api/home/...


# [B] 국가별 인허가 규제 — 접두사: /api/regulatory/...
#     처리 로직은 src/02_regulatory/regulatory_service.py 에 있고 여기에는 Route만 둡니다.
#     계약: src/02_regulatory/api_reference.md
import importlib.util as _regulatory_importlib
from flask import jsonify as _regulatory_jsonify, request as _regulatory_request

_regulatory_spec = _regulatory_importlib.spec_from_file_location(
    "regulatory_service", SRC_DIR / "02_regulatory" / "regulatory_service.py"
)
regulatory_service = _regulatory_importlib.module_from_spec(_regulatory_spec)
_regulatory_spec.loader.exec_module(regulatory_service)


def _regulatory_error(exc):
    """RegulatoryApiError → JSON 오류 응답. 설정 오류 503, 그 외 외부 API 오류 502."""
    status = 503 if exc.kind == "config" else 502
    return _regulatory_jsonify({"ok": False, "error": exc.to_dict()}), status


@app.route("/api/regulatory/ingredients")
def regulatory_ingredients():
    """한글 성분명 후보 검색. ?q=성분명 → 후보 최대 10개 (규제 조회는 하지 않음)."""
    q = (_regulatory_request.args.get("q") or "").strip()
    if not q:
        return _regulatory_jsonify({"ok": False, "error": {"kind": "validation", "message": "성분명을 입력해 주세요."}}), 400
    try:
        result = regulatory_service.search_ingredients_kr(q)
    except regulatory_service.RegulatoryApiError as exc:
        return _regulatory_error(exc)
    result["ok"] = True
    return _regulatory_jsonify(result)


@app.route("/api/regulatory/regulations")
def regulatory_regulations():
    """성분 코드 + 시장 코드로 규제 조회. ?code=5489&country=EU"""
    code = (_regulatory_request.args.get("code") or "").strip()
    country = (_regulatory_request.args.get("country") or "").strip().upper()
    if not code.isdigit():
        return _regulatory_jsonify({"ok": False, "error": {"kind": "validation", "message": "성분을 먼저 선택해 주세요."}}), 400
    if country not in regulatory_service.MARKET_CODES:
        return _regulatory_jsonify({"ok": False, "error": {"kind": "validation", "message": "국가/시장을 선택해 주세요."}}), 400
    try:
        result = regulatory_service.get_regulations(code, country)
    except regulatory_service.RegulatoryApiError as exc:
        return _regulatory_error(exc)
    result["ok"] = True
    return _regulatory_jsonify(result)


# [C] 원가 경쟁력 및 마진 시뮬레이션 — 접두사: /api/margin-calculator/...


# [D] AI 제형/샘플 시뮬레이션 — 접두사: /api/ai-formulation/...


# [E] 개발요청서 — 접두사: /api/dev-request/...


if __name__ == "__main__":
    app.run(
        host="127.0.0.1",
        port=int(os.getenv("FLASK_PORT", "5000")),
        debug=os.getenv("FLASK_DEBUG", "1") == "1",
        extra_files=[str(BASE_DIR / ".env")],
    )
