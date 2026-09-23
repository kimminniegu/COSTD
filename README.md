# COSMOA — OEM·ODM 해외영업 대시보드

## 프로젝트 목적

화장품 OEM·ODM 해외영업 업무를 지원하는 Flask 기반 웹 대시보드 **COSMOA** (by COSTD) 입니다.

```
로그인 → 홈 (환율 / AI 챗봇 / 트렌드)
           ├─ 1. 국가별 인허가 규제
           ├─ 2. 원가 경쟁력 및 마진 시뮬레이션
           ├─ 3. AI 제형/샘플 시뮬레이션
           └─ 4. 개발요청서 생성·변환·다국어 처리
```

여러 팀원이 기능을 하나씩 맡아, 각자의 기능 명세(MD)를 작성한 뒤 Claude/Codex로 개발하고 Git으로 병합합니다.

> **현재 단계**: 공통 구조(폴더, 디자인 시스템, 공통 UI, Route, 페이지 골격)만 구성되어 있습니다.
> 공통 디자인은 COSMOA 디자인 원본(`docs/reference/`)을 반영한 상태입니다.
> 각 페이지의 실제 기능과 로그인은 아직 구현되지 않았습니다. (로그인 화면 시안은 `docs/reference/login.dc.html`)

## 프로젝트 구조

```
COSTD/
├── app.py                  # Flask Entry Point, 페이지 Route          [PM]
├── README.md
├── .env                    # 로컬 환경변수 (Git 제외)
├── .env.example            # 환경변수 이름 목록 (Git 포함)
├── .gitignore
├── requirements.txt
├── docs/
│   ├── design_system.md    # 디자인 기준 문서                         [PM]
│   ├── ui_components.md    # 공통 UI 컴포넌트 규격                    [PM]
│   └── reference/          # 디자인 원본 소스 (COSMOA Artifact 사본)   [PM]
└── src/
    ├── common/
    │   ├── base.html       # 공통 Layout (Sidebar / Nav / Footer)     [PM]
    │   ├── style.css       # 공통 CSS                                 [PM]
    │   ├── fonts/          # 나눔스퀘어 네오 OTF (Rg / Bd / Eb)       [PM]
    │   └── common.js       # 공통 JS (Sidebar, Modal, Tabs)           [PM]
    ├── 01_home/              home.html / .css / .js / .md             [A]
    ├── 02_regulatory/        regulatory.html / .css / .js / .md       [B]
    ├── 03_margin/            margin.html / .css / .js / .md           [C]
    ├── 04_simulation/        simulation.html / .css / .js / .md       [D]
    └── 05_requisition/       requisition.html / .css / .js / .md      [E]
```

## 설치 및 실행

### 1. 가상환경 생성

```
conda create -n tdenv python=3.10
```

### 2. requirements 설치

```bash
pip install -r requirements.txt
```

패키지를 추가했다면 `requirements.txt`에 한 줄 추가하고 PR에 명시합니다.

### 3. .env 설정

`.env`는 Git에 올라가지 않습니다. 처음 받은 사람은 `.env.example`을 복사해서 만듭니다.

```bash
cp .env.example .env      # Windows: copy .env.example .env
```

```
FLASK_SECRET_KEY=
FLASK_DEBUG=1
FLASK_PORT=5000
OPENAI_API_KEY=
OTHER_API_KEY=
```

- 실제 Key 값은 자신의 `.env`에만 입력합니다. **코드, MD, `.env.example`, 커밋에 Key를 쓰지 않습니다.**
- Python에서는 환경변수로 불러옵니다: `os.getenv("OPENAI_API_KEY")` (`app.py`에서 `load_dotenv()` 호출됨)
- 새 환경변수가 필요하면 `.env.example`에 **이름만** 추가합니다.

### 4. Flask 실행

```bash
python app.py
```

→ http://127.0.0.1:5000

## 페이지 URL

| URL | endpoint (`url_for`) | 템플릿 | 담당 |
|---|---|---|---|
| `/` | `home` | `src/01_home/home.html` | A |
| `/regulatory` | `regulatory` | `src/02_regulatory/regulatory.html` | B |
| `/margin-calculator` | `margin` | `src/03_margin/margin.html` | C |
| `/ai-formulation` | `simulation` | `src/04_simulation/simulation.html` | D |
| `/dev-request` | `dev_request` | `src/05_requisition/requisition.html` | E |
| `/assets/<path>` | `asset` | `src/` 내부 CSS·JS·이미지 제공 | PM |

## Flask에서 `src/` HTML을 사용하는 방식

팀원별 폴더 분리를 위해 일반적인 `templates/`, `static/` 대신 `src/`를 그대로 사용합니다. HTML을 다른 폴더로 복사하지 않습니다.

**1) 템플릿** — `template_folder`를 `src/`로 지정했습니다. 템플릿 이름은 `src/` 기준 상대 경로입니다.

```python
app = Flask(__name__, template_folder=str(SRC_DIR), static_folder=None)
render_template("02_regulatory/regulatory.html")
```

**2) 공통 Layout** — 모든 페이지는 `common/base.html`을 상속합니다. Sidebar / Navigation / Footer / 공통 CSS·JS가 한 곳에만 있으므로 모든 페이지가 자동으로 같은 디자인을 사용하고, 메뉴 변경 시 5개 HTML을 각각 고칠 필요가 없습니다.

```html
{% extends "common/base.html" %}
{% block title %}…{% endblock %}
{% block page_css %}…{% endblock %}
{% block content %}…{% endblock %}
{% block page_js %}…{% endblock %}
```

**3) CSS / JS / 이미지** — `/assets/<경로>` Route가 `src/` 안의 파일을 제공합니다. 허용된 확장자(css, js, 이미지, 폰트, json)만 제공하므로 `.html` 템플릿 원본과 `.md` 명세서는 브라우저에서 접근할 수 없습니다.

```html
<link rel="stylesheet" href="{{ url_for('asset', filename='02_regulatory/regulatory.css') }}">
<img src="{{ url_for('asset', filename='02_regulatory/images/sample.png') }}">
```

페이지 이동 링크도 `url_for()`를 사용합니다: `<a href="{{ url_for('margin') }}">`

## 팀원별 담당 폴더

| 담당 | 영역 | 수정 가능 |
|---|---|---|
| **PM** | 공통 영역 | `docs/`, `src/common/`, `app.py`의 페이지 Route, Navigation 구조, `README.md`, `.gitignore` |
| **A** | Home | `src/01_home/` |
| **B** | 국가별 인허가 규제 | `src/02_regulatory/` |
| **C** | 원가 경쟁력 및 마진 시뮬레이션 | `src/03_margin/` |
| **D** | AI 제형/샘플 시뮬레이션 | `src/04_simulation/` |
| **E** | 개발요청서 | `src/05_requisition/` |

- 각 담당자는 `app.py` 하단의 **자신의 영역**(`# [B] …` 주석 아래)에만 Backend Route를 추가할 수 있습니다.
- Python 코드가 길어지면 자신의 폴더에 모듈(예: `src/02_regulatory/service.py`)을 만들고 `app.py`에는 Route만 둡니다.
- Home의 "바로가기" 링크 영역은 Navigation 구조이므로 PM이 관리합니다.

## 공통 문서

| 문서 | 내용 |
|---|---|
| `docs/design_system.md` | 디자인 컨셉, Typography, Colors(CSS Variable), Layout, Shape, Responsive. **모든 화면 구현의 기준** |
| `docs/reference/` | 디자인 원본(Claude Artifact "COSMOA - 로그인 & 홈")의 소스 사본. 값이 애매할 때 확인용 |
| `docs/ui_components.md` | Header, Button, Card, Form, Table, Modal 등 공통 UI의 HTML 구조·Class·상태. **새로 디자인하지 않고 그대로 사용** |
| `src/<폴더>/<이름>.md` | 페이지별 기능 명세서. 담당자가 직접 작성. **기능 요구사항은 이 파일이 최우선** |

### 공통 디자인을 변경하려면

1. PM에게 공유 (무엇을 / 왜)
2. PM이 `docs/design_system.md` 수정 → `src/common/style.css`의 `:root` Variable을 동일하게 수정
3. 컴포넌트 규격이 바뀌면 `docs/ui_components.md`도 수정
4. 공지 후 각자 `git pull`

대부분의 색상·간격·글꼴 변경은 `:root` Variable 값만 바꾸면 전체 페이지에 반영됩니다.

## 개발 규칙

1. 각 담당자는 자신의 폴더 안에서 개발한다.
2. 다른 팀원의 MD / HTML / CSS / JS를 임의로 수정하지 않는다.
3. 공통 디자인은 `docs/design_system.md`를 따른다.
4. 공통 UI는 `docs/ui_components.md`를 따른다.
5. 공통 CSS는 `src/common/style.css`를 따른다.
6. 페이지별 CSS는 해당 페이지에서만 필요한 내용만 작성한다. (공통 Button, Card 등을 다시 정의하지 않는다)
7. Home과 공통 Navigation은 PM이 관리한다.
8. `app.py`의 기존 Route를 삭제하거나 임의로 변경하지 않는다.
9. 새로운 Route를 추가할 때 기존 Route와 충돌하지 않는다. (`/api/<자신의 페이지 경로>/...` 접두사 사용)
10. API Key를 코드에 직접 작성하지 않는다.
11. 다른 담당자의 기능을 임의로 구현하지 않는다.
12. 기존 코드를 수정해야 한다면 최소 범위만 변경한다.
13. 페이지 디자인을 독자적으로 새로 만들지 않는다.
14. 기능별 실제 요구사항은 해당 폴더의 MD 파일을 최우선으로 따른다.
15. **AI 도구(바이브 코딩)로 작업할 때 커밋은 담당자가 직접 한다.** AI에게는 커밋 제목과 내용 요약만 요청하고, `git add` / `git commit` / `git push`는 AI가 실행하지 않게 한다.

이름 충돌 방지:

- 페이지 CSS Class, HTML `id`는 페이지 접두사 사용 — `regulatory-…`, `margin-…`, `simulation-…`, `requisition-…`, `home-…`
- 페이지 JS는 전역 변수를 만들지 않도록 IIFE 또는 `DOMContentLoaded` 안에 작성
- Flask 함수명(endpoint)도 접두사 사용 — 예: `regulatory_search`, `margin_calculate`

## Claude / Codex에게 요청하는 방법

1. 자신의 MD(`src/<폴더>/<이름>.md`)의 16개 항목을 먼저 작성합니다.
2. AI 코딩 도구에 아래와 같이 요청합니다. (국가별 인허가 규제 담당자 예시)

```
다음 문서를 순서대로 먼저 읽어 주세요.
1. README.md
2. docs/design_system.md
3. docs/ui_components.md
4. src/02_regulatory/regulatory.md

regulatory.md의 요구사항대로 src/02_regulatory/ 폴더 안의 파일을 구현해 주세요.

규칙:
- src/02_regulatory/ 밖의 파일은 수정하지 마세요. (docs/, src/common/, 다른 담당자 폴더 수정 금지)
- app.py는 "[B] 국가별 인허가 규제" 주석 아래에 Route를 추가하는 것만 허용합니다.
  기존 Route는 삭제·변경하지 말고, URL은 /api/regulatory/ 로 시작하게 해 주세요.
- 공통 Button, Card, Form, Table, Modal 등은 ui_components.md의 HTML 구조와 Class를 그대로 사용하세요.
- 색상·간격·글자 굵기는 design_system.md의 CSS Variable만 사용하세요. (굵기는 --font-weight-regular / -bold / -extrabold 3종뿐)
- regulatory.css에는 이 페이지에서만 필요한 스타일만, "regulatory-" 접두사로 작성하세요.
- API Key는 os.getenv()로 불러오세요.
- 공통 영역 수정이 필요해 보이면 수정하지 말고 알려 주세요.
- git add / commit / push는 실행하지 마세요. 작업이 끝나면 커밋 제목과 내용 요약만 알려 주세요. 커밋은 제가 직접 합니다.
```

## Git 작업 시 주의사항

- `main`에 직접 커밋하지 않습니다. 기능별 Branch에서 작업 후 PR로 병합합니다.
  - 예: `feature/home`, `feature/regulatory`, `feature/margin`, `feature/sample`, `feature/requisition`
- 작업 시작 전 `git pull origin main`, PR 전에 `main`을 자신의 Branch에 병합해 충돌을 먼저 해결합니다.
- `git add .` 대신 자신의 폴더만 추가합니다: `git add src/02_regulatory/ app.py`
- 커밋 전 `git status`로 **자신의 폴더 밖 파일이 바뀌지 않았는지** 확인합니다. (AI 도구가 공통 파일을 건드리는 경우가 있습니다)
- **커밋은 항상 담당자가 직접 합니다.** AI 도구에게 커밋을 맡기지 않고, 커밋 제목·내용 요약만 받아서 확인 후 직접 커밋합니다.
- `.env`, `tdenv/`, `__pycache__/`는 커밋하지 않습니다. Key를 실수로 커밋했다면 즉시 PM에게 알리고 Key를 재발급합니다.

**충돌 가능성이 높은 파일**

| 파일 | 이유 | 대응 |
|---|---|---|
| `app.py` | 모든 담당자가 Route 추가 | 자신의 주석 영역에만 추가, import는 한 줄씩, 로직은 자기 폴더 모듈로 분리 |
| `requirements.txt` | 각자 패키지 추가 | 한 줄씩 추가, 기존 줄 수정 금지, PR에 명시 |
| `.env.example` | 환경변수 이름 추가 | 파일 끝에 한 줄씩 추가 |
| `src/common/style.css`, `common.js`, `base.html` | 공통 영역 | PM만 수정 |
| `docs/*.md`, `README.md` | 공통 문서 | PM만 수정 |
| `src/01_home/home.html` | 담당자 A(위젯) + PM(기능 링크) | A는 위젯 Section, PM은 "바로가기" Section만 수정 |
