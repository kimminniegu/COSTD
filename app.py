"""Flask Entry Point.

페이지 이동을 위한 기본 Route와 로그인/세션, 홈 화면 API를 정의합니다.
각 기능 페이지의 API 처리, AI 기능, 계산 로직 등은 담당자가
자신의 MD 파일(src/<폴더>/<이름>.md)을 기준으로 아래 담당자별 영역에 추가합니다.

규칙
- "페이지 Route"와 "로그인" 영역은 PM 관리 영역입니다. 삭제하거나 URL을 변경하지 마세요.
- 새 Route는 파일 하단의 담당자별 영역에 추가하고, 기존 URL과 충돌하지 않게 합니다.
- 페이지 Route에는 @login_required 를 붙입니다. (로그인하지 않으면 /login 으로 이동)
- API Key는 코드에 직접 쓰지 말고 os.getenv()로 불러옵니다.
- Python 모듈은 담당자 폴더(src/<폴더>/)에 두고 importlib 로 불러옵니다. (폴더명이 숫자로 시작해 import 문을 쓸 수 없음)
"""

import importlib
import logging
import os
import re
from importlib import import_module
from datetime import timedelta
from pathlib import Path
from zoneinfo import ZoneInfo
from datetime import datetime

from dotenv import load_dotenv
from flask import Flask, abort, jsonify, redirect, render_template, request, send_from_directory, url_for
from markupsafe import Markup, escape

BASE_DIR = Path(__file__).resolve().parent
SRC_DIR = BASE_DIR / "src"
INSTANCE_DIR = BASE_DIR / "instance"          # SQLite 등 로컬 데이터 (Git 제외)
DB_PATH = INSTANCE_DIR / "cosmoa.db"

load_dotenv(BASE_DIR / ".env")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

# 일반적인 templates/ 대신 src/ 전체를 템플릿 폴더로 사용합니다.
# 템플릿 이름은 src/ 기준 상대 경로입니다. 예: "02_regulatory/regulatory.html"
# 기본 static 폴더는 사용하지 않고, 아래 asset() Route가 src/ 안의 CSS·JS를 제공합니다.
app = Flask(__name__, template_folder=str(SRC_DIR), static_folder=None)
app.config["SECRET_KEY"] = os.getenv("FLASK_SECRET_KEY") or "dev-only-change-me"   # .env 에 빈 값이어도 개발용 기본값 사용
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(days=30)   # "로그인 상태 유지" 체크 시
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"

# 공통 모듈 (PM) / 홈 데이터 모듈 (A)
auth = importlib.import_module("src.common.auth")
home_data = importlib.import_module("src.01_home.home_data")
auth.init(DB_PATH)
home_data.init(DB_PATH)
login_required = auth.login_required

KST = ZoneInfo("Asia/Seoul")

# src/ 안에서 브라우저에 제공해도 되는 파일 확장자 (HTML 템플릿, MD 명세서, Python 모듈은 제외)
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


@app.context_processor
def inject_user():
    """모든 템플릿에서 current_user 사용 가능 (Sidebar 사용자 영역)"""
    return {"current_user": auth.current_user()}


# ---------------------------------------------------------------------------
# 로그인 (PM 관리) — 화면: src/common/login.html, 로직: src/common/auth.py
# ---------------------------------------------------------------------------

@app.route("/login", methods=["GET", "POST"])
def login():
    if auth.current_user():
        return redirect(url_for("home"))
    error, email = None, ""
    next_url = auth.safe_next(request.values.get("next"))
    if request.method == "POST":
        email = request.form.get("email", "").strip()
        password = request.form.get("password", "")
        user = auth.authenticate(email, password) if email and password else None
        if user:
            auth.login_user(user, remember=request.form.get("remember") == "1")
            return redirect(next_url or url_for("home"))
        error = "이메일 또는 비밀번호를 다시 확인해 주세요."
    demo_hint = None
    if app.debug:  # 개발 중에만 데모 계정 안내 표시
        demo_hint = f"{os.getenv('COSMOA_DEMO_EMAIL', 'demo@costd.kr')} / {os.getenv('COSMOA_DEMO_PASSWORD', 'cosmoa1234')}"
    return render_template("common/login.html", error=error, email=email, next=next_url, demo_hint=demo_hint), (401 if error else 200)


@app.route("/logout")
def logout():
    auth.logout_user()
    return redirect(url_for("login"))


# ---------------------------------------------------------------------------
# 페이지 Route (PM 관리) — 삭제 / URL 변경 금지
# ---------------------------------------------------------------------------

def _greeting(now: datetime) -> str:
    if now.hour < 12:
        return "좋은 아침이에요"
    if now.hour < 18:
        return "좋은 오후예요"
    return "좋은 저녁이에요"


@app.route("/")
@login_required
def home():
    now = datetime.now(KST)
    weekday = "월화수목금토일"[now.weekday()]
    return render_template(
        "01_home/home.html",
        user=auth.current_user(),
        today_text=f"{now.month}월 {now.day}일 {weekday}요일",
        greeting=_greeting(now),
        data=home_data.get_dashboard(),
    )


@app.route("/regulatory")
@login_required
def regulatory():
    return render_template("02_regulatory/regulatory.html")


@app.route("/margin-calculator")
@login_required
def margin():
    return render_template("03_margin/margin.html")


@app.route("/ai-formulation")
@login_required
def simulation():
    return render_template("04_simulation/simulation.html")


@app.route("/dev-request")
@login_required
def dev_request():
    return render_template("05_requisition/requisition.html", request_sections=requisition_service.SECTIONS)


# ---------------------------------------------------------------------------
# 담당자별 Backend Route 추가 영역
# 자신의 영역에만 추가하세요. URL은 자신의 페이지 경로를 접두사로 사용합니다.
# ---------------------------------------------------------------------------

# [A] Home — 접두사: /api/home/...  (명세: src/01_home/home.md 9-1)

@app.template_filter("home_highlight")
def home_highlight(text, q):
    """원문에서 검색어를 찾고 각 조각을 escape 해서 안전하게 강조합니다."""
    terms = sorted(set((q or "").split()), key=lambda term: (-len(term), term))[:5]
    if not terms:
        return Markup(escape(text))
    pattern = re.compile("|".join(re.escape(term) for term in terms), re.IGNORECASE)
    source = str(text)
    parts, start = [], 0
    for match in pattern.finditer(source):
        parts.extend((str(escape(source[start:match.start()])), "<mark>",
                      str(escape(match.group())), "</mark>"))
        start = match.end()
    parts.append(str(escape(source[start:])))
    return Markup("".join(parts))


def _arg(name, allowed=None):
    v = (request.args.get(name) or "").strip()[:60]
    return v if (not allowed or v in allowed) else ""


@app.route("/news")
@login_required
def home_news():
    """뉴스 더보기 — ?q=검색어 &source=매체 (스크롤 허용)"""
    home_data.kick_refresh(("news",))
    sources = home_data.NEWS_SOURCES + [home_data.WEB_SOURCE]
    news = home_data.get_news(limit=80, per_source=None, q=_arg("q"), source=_arg("source", sources), external=True)
    return render_template("01_home/news.html", news=news)


@app.route("/regulations")
@login_required
def home_regulations():
    """규제 더보기 — ?q=검색어 &country=국가 (스크롤 허용)"""
    home_data.kick_refresh(("regulations",))
    regs = home_data.get_regulations(limit=80, q=_arg("q"), country=_arg("country", home_data.REG_COUNTRIES))
    return render_template("01_home/regulations.html", regs=regs)


@app.route("/api/home/data")
@login_required
def home_api_data():
    """홈 화면 전체 데이터 (갱신 중이면 화면이 몇 초 뒤 다시 호출)"""
    return jsonify(home_data.get_dashboard())


@app.route("/api/home/regulations")
@login_required
def home_api_regulations():
    """규제 새 소식 — ?since=<ISO 시각> 이후 게시된 것만 (화면에서 10분마다 호출)"""
    home_data.kick_refresh(("regulations",))
    return jsonify(home_data.get_regulations(since=request.args.get("since")))


# [B] 국가별 인허가 규제 — 접두사: /api/regulatory/...


# [C] 원가 경쟁력 및 마진 시뮬레이션 — 접두사: /api/margin-calculator/...
# 계산·검증 로직은 src/03_margin/service.py, 명세는 src/03_margin/margin.md §6
margin_service = importlib.import_module("src.03_margin.service")


@app.route("/api/margin-calculator/master", methods=["GET"])
@login_required
def margin_get_master():
    return margin_service.handle(margin_service.get_master_data, needs_payload=False)


@app.route("/api/margin-calculator/calculate-tiers", methods=["POST"])
@login_required
def margin_calculate_tiers():
    return margin_service.handle(margin_service.calculate_tiers, request.get_json(silent=True))


@app.route("/api/margin-calculator/fx-rates", methods=["GET"])
@login_required
def margin_get_fx_rates():
    currencies = request.args.get("currencies")
    force = request.args.get("force") == "1"
    return margin_service.handle(lambda: margin_service.get_fx_rates(currencies, force), needs_payload=False)


@app.route("/api/margin-calculator/calculate-cbm-logistics", methods=["POST"])
@login_required
def margin_calculate_cbm_logistics():
    return margin_service.handle(margin_service.calculate_logistics, request.get_json(silent=True))


@app.route("/api/margin-calculator/fx-stress", methods=["POST"])
@login_required
def margin_fx_stress():
    return margin_service.handle(margin_service.calculate_fx_quote, request.get_json(silent=True))


@app.route("/api/margin-calculator/reverse-counter-offer", methods=["POST"])
@login_required
def margin_reverse_counter_offer():
    return margin_service.handle(margin_service.reverse_counter_offer, request.get_json(silent=True))


def _margin_render_pi_document(context):
    return render_template("03_margin/margin_pi_document.html", **context)


@app.route("/api/margin-calculator/render-pi", methods=["POST"])
@login_required
def margin_render_pi():
    return margin_service.handle_pi(request.get_json(silent=True), _margin_render_pi_document)


@app.route("/api/margin-calculator/export-pi-pdf", methods=["POST"])
@login_required
def margin_export_pi_pdf():
    return margin_service.handle_pi(request.get_json(silent=True), _margin_render_pi_document, as_pdf=True)


@app.route("/api/margin-calculator/history", methods=["GET"])
@login_required
def margin_get_history():
    deal_id = request.args.get("deal_id") or None
    return margin_service.handle(lambda: margin_service.list_history(deal_id), needs_payload=False)


@app.route("/api/margin-calculator/history", methods=["POST"])
@login_required
def margin_save_history():
    return margin_service.handle(margin_service.save_history_version, request.get_json(silent=True))


@app.route("/api/margin-calculator/history/compare", methods=["GET"])
@login_required
def margin_compare_history():
    args = request.args
    return margin_service.handle(
        lambda: margin_service.compare_versions(args.get("deal_id"), args.get("from"), args.get("to")),
        needs_payload=False)


# [D] AI 제형/샘플 시뮬레이션 — 접두사: /api/ai-formulation/...


# [E] 개발요청서 — 접두사: /api/dev-request/...

# 숫자로 시작하는 폴더명은 일반 import 문으로 불러올 수 없으므로
# import_module을 사용해 개발요청서 자동변환 API를 등록합니다.
# 공통 스키마로 자동변환·직접작성·수정·최종값 PDF 출력을 연결합니다.
requisition_service = import_module("src.05_requisition.service")


@requisition_service.blueprint.before_request
def require_requisition_user():
    if not auth.current_user():
        return jsonify(error="로그인 후 다시 이용해 주세요."), 401


app.register_blueprint(requisition_service.blueprint)


if __name__ == "__main__":
    app.run(
        host="127.0.0.1",
        port=int(os.getenv("FLASK_PORT", "5000")),
        debug=os.getenv("FLASK_DEBUG", "1") == "1",
    )
