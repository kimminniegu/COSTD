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

load_dotenv(BASE_DIR / ".env")

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


# [C] 원가 경쟁력 및 마진 시뮬레이션 — 접두사: /api/margin-calculator/...
from src.03_margin.service import MARGIN_DATA, calculate_simulation, save_pi_version

@app.route("/api/margin-calculator/init", methods=["GET"])
def margin_init():
    return jsonify(MARGIN_DATA)

@app.route("/api/margin-calculator/simulate", methods=["POST"])
def margin_simulate():
    data = request.json or {}
    result = calculate_simulation(data)
    return jsonify(result)

@app.route("/api/margin-calculator/quotations/save", methods=["POST"])
def margin_save_quotation():
    data = request.json or {}
    _, history = save_pi_version(data)
    return jsonify({"success": True, "history": history})

# [D] AI 제형/샘플 시뮬레이션 — 접두사: /api/ai-formulation/...


# [E] 개발요청서 — 접두사: /api/dev-request/...


if __name__ == "__main__":
    app.run(
        host="127.0.0.1",
        port=int(os.getenv("FLASK_PORT", "5000")),
        debug=os.getenv("FLASK_DEBUG", "1") == "1",
    )
