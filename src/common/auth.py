"""로그인 / 세션 (PM 관리)

- 사용자 정보는 SQLite(instance/cosmoa.db) users 테이블에 저장합니다. (10장 미정: 필요 시 PostgreSQL로 교체)
- 비밀번호는 werkzeug 해시로만 저장합니다.
- 첫 실행 시 계정이 하나도 없으면 데모 계정을 만듭니다. (.env: COSMOA_DEMO_EMAIL / COSMOA_DEMO_PASSWORD / COSMOA_DEMO_NAME / COSMOA_DEMO_TEAM)
- 페이지 Route에는 @login_required 를 붙입니다. 로그인하지 않으면 /login 으로 보냅니다.
"""

from __future__ import annotations

import logging
import os
import sqlite3
from datetime import datetime
from functools import wraps
from zoneinfo import ZoneInfo
from pathlib import Path
from urllib.parse import urlparse

from flask import redirect, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

_DB_PATH: Path | None = None


log = logging.getLogger("cosmoa.auth")

_DEFAULT_DEMO_PASSWORD = "cosmoa1234"


def init(db_path: Path, production: bool = False) -> None:
    """users 테이블 준비. 계정이 하나도 없으면 데모 계정을 만듭니다.
    production=True 이면 COSMOA_DEMO_EMAIL / COSMOA_DEMO_PASSWORD 가 모두 설정돼 있고 공개 기본값이 아닐 때만 만듭니다.
    이미 있는 계정은 환경변수를 바꿔도 비밀번호가 바뀌지 않습니다 → 아래 set_password() / 파일 하단 명령 사용."""
    global _DB_PATH
    _DB_PATH = db_path
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with _conn() as c:
        c.execute(
            """CREATE TABLE IF NOT EXISTS users (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 email TEXT UNIQUE NOT NULL,
                 name TEXT NOT NULL,
                 team TEXT NOT NULL DEFAULT '',
                 password_hash TEXT NOT NULL,
                 created_at TEXT DEFAULT CURRENT_TIMESTAMP
               )"""
        )
        # 이메일이 비어 있는 계정(.env.example 을 그대로 복사해 값이 빈 경우 생김)은 로그인할 수 없으므로 지우고,
        # 로그인 가능한 계정이 하나도 없으면 데모 계정을 만듭니다. 빈 값(COSMOA_DEMO_EMAIL=)도 기본값으로 처리합니다.
        c.execute("DELETE FROM users WHERE trim(email) = ''")
        if c.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0:
            email, password, name, team = demo_account()
            if production and not _demo_env_ok():
                log.warning("계정이 없지만 COSMOA_DEMO_EMAIL / COSMOA_DEMO_PASSWORD 가 설정되지 않았거나 공개 기본값이라 "
                            "데모 계정을 만들지 않았습니다. 환경변수를 설정하고 다시 시작하세요.")
                return
            c.execute(   # 같은 연결로 넣습니다 (위 DELETE 가 쓰기 잠금을 잡고 있어 새 연결은 잠김)
                "INSERT OR IGNORE INTO users (email, name, team, password_hash) VALUES (?,?,?,?)",
                (email.lower(), name, team, generate_password_hash(password)),
            )


def demo_account() -> tuple[str, str, str, str]:
    """데모 계정 (email, password, name, team). .env 값이 없거나 비어 있으면 기본값."""
    return (
        os.getenv("COSMOA_DEMO_EMAIL", "").strip() or "demo@costd.kr",
        os.getenv("COSMOA_DEMO_PASSWORD", "").strip() or _DEFAULT_DEMO_PASSWORD,
        os.getenv("COSMOA_DEMO_NAME", "").strip() or "데모 사용자",
        os.getenv("COSMOA_DEMO_TEAM", "").strip() or "해외영업팀",
    )


def _demo_env_ok() -> bool:
    email = os.getenv("COSMOA_DEMO_EMAIL", "").strip()
    password = os.getenv("COSMOA_DEMO_PASSWORD", "").strip()
    return bool(email) and bool(password) and password != _DEFAULT_DEMO_PASSWORD


def _conn() -> sqlite3.Connection:
    assert _DB_PATH is not None, "auth.init()를 먼저 호출하세요"
    c = sqlite3.connect(_DB_PATH, timeout=10)
    c.row_factory = sqlite3.Row
    return c


def create_user(email: str, password: str, name: str, team: str = "") -> None:
    with _conn() as c:
        c.execute(
            "INSERT OR IGNORE INTO users (email, name, team, password_hash) VALUES (?,?,?,?)",
            (email.strip().lower(), name.strip(), team.strip(), generate_password_hash(password)),
        )


def set_password(email: str, password: str) -> bool:
    """이미 있는 계정의 비밀번호를 바꿉니다. 계정이 없으면 False."""
    with _conn() as c:
        cur = c.execute("UPDATE users SET password_hash=? WHERE email=?",
                        (generate_password_hash(password), email.strip().lower()))
        return cur.rowcount == 1


def authenticate(email: str, password: str) -> dict | None:
    with _conn() as c:
        row = c.execute("SELECT * FROM users WHERE email=?", (email.strip().lower(),)).fetchone()
    if row and check_password_hash(row["password_hash"], password):
        return {"id": row["id"], "email": row["email"], "name": row["name"], "team": row["team"]}
    return None


def current_user() -> dict | None:
    return session.get("user")


def login_user(user: dict, remember: bool = False) -> None:
    session.clear()
    # 로그인 시각·유지 여부도 함께 두어 사이드바 "내 계정" 모달(base.html)에서 보여줍니다
    session["user"] = dict(user, logged_in_at=datetime.now(ZoneInfo("Asia/Seoul")).strftime("%Y-%m-%d %H:%M"), remember=bool(remember))
    session.permanent = remember  # 로그인 상태 유지 → PERMANENT_SESSION_LIFETIME 만큼


def logout_user() -> None:
    session.clear()


def safe_next(target: str | None) -> str | None:
    """외부 주소로 튕기는 것을 막습니다. 같은 사이트 경로만 허용."""
    if not target:
        return None
    parsed = urlparse(target)
    if parsed.scheme or parsed.netloc or not target.startswith("/"):
        return None
    return target


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not current_user():
            return redirect(url_for("login", next=request.full_path.rstrip("?")))
        return view(*args, **kwargs)
    return wrapped


if __name__ == "__main__":
    # 기존 계정 비밀번호 변경 (저장소 루트에서 실행, 서버 재시작 불필요)
    #   python -m src.common.auth set-password <email>
    # 새 비밀번호는 화면에 표시되지 않는 입력으로 받습니다. (명령 기록·로그에 남지 않도록 인자로 받지 않음)
    import getpass
    import sys

    if len(sys.argv) != 3 or sys.argv[1] != "set-password":
        sys.exit("사용법: python -m src.common.auth set-password <email>")
    _DB_PATH = Path(__file__).resolve().parents[2] / "instance" / "cosmoa.db"   # app.py DB_PATH 와 같은 파일
    if not _DB_PATH.is_file():
        sys.exit("계정 DB가 없습니다: %s" % _DB_PATH)
    new_password = getpass.getpass("새 비밀번호: ")
    if len(new_password) < 8 or new_password != getpass.getpass("새 비밀번호 확인: "):
        sys.exit("비밀번호가 8자 미만이거나 확인 값과 다릅니다. 변경하지 않았습니다.")
    if not set_password(sys.argv[2], new_password):
        sys.exit("해당 이메일의 계정이 없습니다.")
    print("비밀번호를 변경했습니다.")
