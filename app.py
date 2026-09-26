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

# 개발 서버 재시작 때 이전 프로세스에서 상속된 키 대신 수정한 .env를 반영합니다.
load_dotenv(BASE_DIR / ".env", override=True)
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

@app.context_processor
def home_asset_version():
    """홈 CSS·JS 링크에 ?v=수정시각 을 붙여, 파일이 바뀌면 브라우저가 캐시 대신 새 파일을 받게 합니다 (담당자 A 페이지 전용)"""
    home_dir = SRC_DIR / "01_home"
    try:
        ver = int(max(p.stat().st_mtime for p in (home_dir / "home.css", home_dir / "home.js")))
    except OSError:
        ver = 0
    return {"home_asset_v": ver}


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


@app.route("/api/home/rates/<code>")
@login_required
def home_api_rate_detail(code):
    """환율 상세 (명세 4-4) — 통화 하나의 송금 환율, 최근 30영업일 추이·통계"""
    detail = home_data.get_rate_detail(code)
    if detail is None:
        return jsonify({"ok": False, "error": "지원하지 않는 통화예요"}), 404
    return jsonify(detail)


@app.route("/api/home/trade")
@login_required
def home_api_trade_detail():
    """수출입 상세 (명세 5-9) — ?hs=3304|330499|all &months=3|6|12|24 &country=CN &metric=exp|imp|bal"""
    detail = home_data.get_trade_detail(
        hs=_arg("hs") or "3304",
        months=request.args.get("months", 12, type=int),
        country=_arg("country"),
        metric=_arg("metric", ("exp", "imp", "bal")) or "exp",
    )
    if detail is None:
        return jsonify({"ok": False, "error": "지원하지 않는 품목 코드예요"}), 400
    return jsonify(detail)


@app.route("/api/home/validation")
@login_required
def home_api_validation():
    """데이터 교차검증 요약 (명세 13장) — 구역별 마지막 성공·시도 시각, 환율 이상값, 수출입 정리·불일치 건수"""
    return jsonify(home_data.get_validation())


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

# 파일 추출(텍스트 PDF · .xlsx) 모듈. 규제 API 는 호출하지 않는다.
_regulatory_extract_spec = _regulatory_importlib.spec_from_file_location(
    "regulatory_extract", SRC_DIR / "02_regulatory" / "regulatory_extract.py"
)
regulatory_extract = _regulatory_importlib.module_from_spec(_regulatory_extract_spec)
_regulatory_extract_spec.loader.exec_module(regulatory_extract)

# 식약처 수집 DB 읽기 전용 조회 모듈 (수집은 별도 스크립트. 서버 시작·조회 때 수집하지 않는다)
_regulatory_mfds_spec = _regulatory_importlib.spec_from_file_location(
    "regulatory_mfds_lookup", SRC_DIR / "02_regulatory" / "regulatory_mfds_lookup.py"
)
regulatory_mfds = _regulatory_importlib.module_from_spec(_regulatory_mfds_spec)
_regulatory_mfds_spec.loader.exec_module(regulatory_mfds)


def _regulatory_error(exc):
    """RegulatoryApiError → JSON 오류 응답. 설정 오류 503, 그 외 외부 API 오류 502."""
    status = 503 if exc.kind == "config" else 502
    return _regulatory_jsonify({"ok": False, "error": exc.to_dict()}), status


@app.route("/api/regulatory/ingredients")
@login_required
def regulatory_ingredients():
    """한글명·영문 INCI명 후보 검색. ?q=성분명 → 후보 최대 10개 (규제 조회는 하지 않음). 자동완성도 같은 Route 사용."""
    q = (_regulatory_request.args.get("q") or "").strip()
    if not q:
        return _regulatory_jsonify({"ok": False, "error": {"kind": "validation", "message": "성분명을 입력해 주세요."}}), 400
    if len(q) < regulatory_service.MIN_QUERY_LENGTH:
        return _regulatory_jsonify({"ok": False, "error": {"kind": "validation", "message": "성분명을 2글자 이상 입력해 주세요."}}), 400
    try:
        result = regulatory_service.search_ingredients(q)
    except regulatory_service.RegulatoryApiError as exc:
        return _regulatory_error(exc)
    result["ok"] = True
    return _regulatory_jsonify(result)


@app.route("/api/regulatory/regulations")
@login_required
def regulatory_regulations():
    """규제 조회. ?code=5489&country=EU&source=mfds|api (기본 mfds)
    - source=mfds : 식약처 수집 DB (읽기 전용). 성분 식별은 kr_name / inci_name / cas 로 하며 code 는 표시용으로만 전달한다.
    - source=api  : 기존 RapidAPI. 선택한 출처만 조회하고 실패해도 다른 출처로 바꾸지 않는다."""
    args = _regulatory_request.args
    code = (args.get("code") or "").strip()
    country = (args.get("country") or "").strip().upper()
    source = (args.get("source") or "mfds").strip().lower()
    if source not in ("mfds", "api"):
        return _regulatory_jsonify({"ok": False, "error": {"kind": "validation", "message": "규제 정보 출처는 mfds 또는 api 여야 해요."}}), 400
    if country not in regulatory_service.MARKET_CODES:
        return _regulatory_jsonify({"ok": False, "error": {"kind": "validation", "message": "국가/시장을 선택해 주세요."}}), 400
    if source == "mfds":
        kr_name = (args.get("kr_name") or "").strip()
        inci_name = (args.get("inci_name") or "").strip()
        cas = (args.get("cas") or "").strip()
        try:
            result = regulatory_mfds.lookup(kr_name=kr_name, inci_name=inci_name, cas=cas, market=country, api_code=code or None)
        except regulatory_mfds.MfdsLookupError as exc:
            return _regulatory_jsonify({"ok": False, "error": exc.to_dict()}), exc.http_status
        result["ok"] = True
        return _regulatory_jsonify(result)
    if not code.isdigit():
        return _regulatory_jsonify({"ok": False, "error": {"kind": "validation", "message": "성분을 먼저 선택해 주세요."}}), 400
    try:
        result = regulatory_service.get_regulations(code, country)
    except regulatory_service.RegulatoryApiError as exc:
        return _regulatory_error(exc)
    result["ok"] = True
    result["source"] = "api"
    result["source_label"] = "기존 API (RapidAPI K-Beauty Cosmetic Ingredients)"
    return _regulatory_jsonify(result)


@app.route("/api/regulatory/extract", methods=["POST"])
@login_required
def regulatory_extract_route():
    """업로드 문서에서 성분명·함량 추출. multipart: file (PDF·.xlsx), sheet (Excel 시트명, 선택).
    여러 시트면 status="sheet_required" 와 시트 목록을 돌려주고, 같은 파일을 sheet 와 함께 다시 보내면 추출한다.
    임시 파일은 요청 안에서 삭제되며 규제 API 는 호출하지 않는다. 계약: src/02_regulatory/api_reference.md"""
    upload = _regulatory_request.files.get("file")
    if upload is None or not (upload.filename or "").strip():
        return _regulatory_jsonify({"ok": False, "error": {"kind": "validation", "message": "파일을 선택해 주세요."}}), 400
    sheet = (_regulatory_request.form.get("sheet") or "").strip() or None
    try:
        result = regulatory_extract.extract_upload(upload.filename, upload.stream, sheet)
    except regulatory_extract.ExtractError as exc:
        return _regulatory_jsonify({"ok": False, "error": exc.to_dict()}), exc.http_status
    result["ok"] = True
    return _regulatory_jsonify(result)


# [C] 원가 경쟁력 및 마진 시뮬레이션 — 접두사: /api/margin-calculator/...
# 계산은 브라우저 margin.js 에서 하고, 서버는 견적서 PDF 생성·현재 환율 조회·ERP 원가(시연용 예시)만 합니다. (src/03_margin/service.py)
margin_service = importlib.import_module("src.03_margin.service")


@app.route("/api/margin-calculator/quote-profile", methods=["GET"])
@login_required
def margin_quote_profile():
    return jsonify(margin_service.quote_profile(auth.current_user()))


@app.route("/api/margin-calculator/quote-pdf", methods=["POST"])
@login_required
def margin_quote_pdf():
    try:
        context = margin_service.build_quote_context(request.get_json(silent=True), auth.current_user())
        pdf = margin_service.html_to_pdf(render_template("03_margin/margin_quote_document.html", **context))
    except ValueError as e:
        return jsonify(error=str(e)), 400
    except RuntimeError as e:
        return jsonify(error=str(e)), 500
    filename = margin_service.quote_filename(context["quote_no"])
    return app.response_class(pdf, mimetype="application/pdf",
                              headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@app.route("/api/margin-calculator/fx-rate", methods=["GET"])
@login_required
def margin_fx_rate():
    try:
        return jsonify(margin_service.usd_krw_rate())
    except RuntimeError as e:
        return jsonify(error=str(e)), 502


@app.route("/api/margin-calculator/erp-cost", methods=["GET"])
@login_required
def margin_erp_cost():
    return jsonify(margin_service.erp_cost())


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
        extra_files=[str(BASE_DIR / ".env")],
    )
