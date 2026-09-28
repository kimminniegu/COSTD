# COSMOA — OEM·ODM 해외영업 대시보드

## 프로젝트 목적

화장품 OEM·ODM 해외영업 업무를 지원하는 Flask 기반 웹 대시보드 **COSMOA** (by COSTD) 입니다.

```
로그인 → 홈 (환율 / 수출입 통계 / 바이어 현지 시각 / 뉴스 / 규제 소식)
           ├─ 1. 국가별 인허가 규제
           ├─ 2. 원가 경쟁력 및 마진 시뮬레이션
           ├─ 3. AI 제형/샘플 시뮬레이션
           └─ 4. 개발요청서 생성·변환·다국어 처리

대시보드 공통: 우하단 AI 챗봇 위젯 → 별도 챗봇 서버
```

여러 팀원이 기능을 하나씩 맡아, 각자의 기능 명세(MD)를 작성한 뒤 Claude/Codex로 개발하고 Git으로 병합합니다.

로그인·세션을 기반으로 해외영업에 필요한 데이터 조회, 시뮬레이션, 문서 처리와 AI 챗봇을 제공합니다. 외부 API를 사용하는 기능은 키와 서버 설정이 필요합니다.

공통 디자인은 `docs/design_system.md`, `docs/ui_components.md`를 따르며, `docs/reference/`에 디자인 참고 자료를 보관합니다.

| 영역 | 주요 기능 | 지원 범위·이용 안내 |
|---|---|---|
| 로그인 | SQLite 계정, 로그인·로그아웃, 세션 유지 | 계정이 없는 첫 실행 시 데모 계정 생성 |
| 홈 | 환율·수출입 통계, 바이어 현지 시각, 뉴스·규제 소식 및 더보기 | 외부 데이터 수집·캐시 사용, 알림 버튼 미구현 |
| 국가별 인허가 규제 | 성분 검색, 식약처 DB/외부 API 조회, PDF·Excel·이미지 성분 추출과 OCR | 함량 기준 비교·시장 자동 선택 등은 미구현. 조회 결과와 최종 규제 판단을 구분 |
| 원가·마진 | 견적·역제안·수량별 단가·환율 영향 계산, 견적서 PDF·영문 메일 본문 | ERP는 예시 품목 1개의 시연 데이터. 견적 입력값은 영구 저장하지 않음 |
| AI 제형/샘플 | 배합·점도·용기 호환도 시뮬레이션, 개발요청서 AI 분석·적용 | 점수는 브라우저 계산식, Canvas는 시연용 표현. 실측 유체 해석이 아님 |
| 개발요청서 | 파일 자동변환·다국어 처리, 직접작성·수정, 브라우저 인쇄로 PDF 저장 | 현재 페이지 메모리에 보관. 전달 대상은 문서 정보이며 실제 발송 기능은 없음 |
| AI 챗봇 | 공통 위젯, 별도 서버의 답변 생성·데이터 조회 도구 | 별도 서버 연결 필요. 대화 기록은 브라우저 sessionStorage에 보관 |

## 프로젝트 구조

```
COSTD/
├── app.py                  # 메인 Flask 서버: 로그인·페이지·API 연결
├── README.md
├── .env                    # 로컬 환경변수 (Git 제외)
├── .env.example            # 환경변수 예시 (비밀값 없음, Git 포함)
├── .gitignore
├── .gitattributes          # 텍스트 줄바꿈 및 SQLite 바이너리 처리
├── .dockerignore
├── Dockerfile              # 메인 서버 배포 이미지 (OCR·한글 폰트 포함)
├── requirements.txt
├── data/regulatory/
│   ├── README.md           # 배포용 DB 출처·수집 정보·갱신 절차
│   └── mfds_use_restriction.sqlite  # Git에 포함된 식약처 DB
├── instance/               # 로컬 데이터 (Git·Docker 이미지 제외)
│   ├── cosmoa.db           # 실행 시 생성되는 계정·홈 캐시 DB
│   └── regulatory/         # 로컬 식약처 수집 DB의 기본 위치
├── docs/
│   ├── design_system.md    # 디자인 기준 문서
│   ├── ui_components.md    # 공통 UI 컴포넌트 규격
│   ├── deploy_render.md    # 메인·챗봇 배포 및 시연 준비
│   └── reference/          # 로그인·홈 디자인 참고 자료
└── src/
    ├── common/             # [PM] 공통 UI·인증
    │   ├── base.html / style.css / common.js
    │   ├── auth.py / login.html / login.css
    │   ├── fonts/          # 나눔스퀘어 네오 OTF (Rg / Bd / Eb)
    │   └── img/            # 로고·로그인 배경·아이콘
    ├── 01_home/            # [A] 홈 데이터와 더보기 페이지
    │   ├── home.html / home.css / home.js / home.md
    │   ├── home_data.py / home_trade.py
    │   └── news.html / regulations.html
    ├── 02_regulatory/      # [B] 규제 조회·파일 추출·식약처 DB
    │   ├── regulatory.html / regulatory.css / regulatory.js / regulatory.md
    │   ├── regulatory_service.py / regulatory_extract.py / regulatory_ocr.py
    │   ├── regulatory_mfds_lookup.py / mfds_use_restriction.py
    │   ├── api_reference.md / demo_verification.md
    │   ├── samples/        # 시연용 PDF·Excel·이미지
    │   ├── test_data/      # API 응답 기록
    │   └── tests/          # 단위·Route 테스트, fixtures/ 추출 자료
    ├── 03_margin/          # [C] 마진 계산·견적서
    │   ├── margin.html / margin.css / margin.js / margin.md
    │   └── service.py / margin_quote_document.html / margin_user_guide.md
    ├── 04_simulation/      # [D] 제형 시뮬레이션·문서 분석
    │   ├── simulation.html / simulation.css / simulation.js / simulation.md
    │   └── service.py
    ├── 05_requisition/     # [E] 개발요청서
    │   ├── requisition.html / requisition.css / requisition.js / requisition.md
    │   ├── service.py / schema.py / IMPLEMENTATION.md
    │   └── tests/          # 단위 테스트·브라우저 검증 스크립트
    └── 06_chatbot/         # [F] 공통 챗봇 위젯·별도 서버
        ├── server.py / tools.py
        ├── chatbot_widget.html / chatbot.css / chatbot.js / chatbot.md
        ├── images/
        └── tests/
```

위 트리는 주요 파일을 역할별로 묶은 것입니다. `.env`와 `instance/`는 로컬 설정·생성 데이터이며 새로 받은 저장소에는 없을 수 있습니다. `__pycache__/` 등 실행 캐시는 생략했습니다.

## 설치 및 실행

프로젝트 루트 `COSTD/`에서 실행합니다.

### 1. 가상환경 생성·활성화

```
conda create -n tdenv python=3.10
conda activate tdenv
```

### 2. requirements 설치

```bash
pip install -r requirements.txt
```

패키지를 추가했다면 `requirements.txt`에 한 줄 추가하고 PR에 명시합니다.

### 3. .env 설정

`.env`는 Git에 올라가지 않습니다. 처음 받은 사람은 `.env.example`을 복사해서 만듭니다.

기존 `.env`가 있으면 덮어쓰지 말고 누락된 설정만 추가합니다. Windows PowerShell에서 처음 만드는 경우:

```powershell
Copy-Item .env.example .env
```

Bash에서는 `cp .env.example .env`를 사용합니다. 전체 항목은 [`.env.example`](.env.example)을 기준으로 아래 용도에 맞게 설정합니다.

| 구분 | 환경변수 | 용도·필요 조건 |
|---|---|---|
| 메인 서버 | `FLASK_SECRET_KEY`, `FLASK_DEBUG`, `FLASK_PORT` | 세션 서명, 로컬 디버그·포트(기본 5000). 운영에서는 고정된 비밀키 필수 |
| 로그인 | `COSMOA_DEMO_EMAIL`, `COSMOA_DEMO_PASSWORD`, `COSMOA_DEMO_NAME`, `COSMOA_DEMO_TEAM` | 계정이 없을 때 생성할 데모 계정 |
| 홈·환율 | `EXIM_API_KEY`, `DATA_GO_KR_KEY` | 수출입은행 환율, 관세청 수출입·KOTRA 데이터 |
| 홈 선택 설정 | `KOTRA_NEWS_URL`, `COSMETIC_HS_CODES` | KOTRA 요청 주소, 화장품 HS 코드(기본 3304) |
| 성분 검색·규제 API | `RAPIDAPI_KEY`, `RAPIDAPI_HOST` | 성분 후보 검색 및 외부 규제 API. 식약처 DB 조회를 선택해도 API를 통한 성분 검색에는 필요 |
| 식약처 DB | `MFDS_DB_PATH` | 읽을 DB 경로. 아래 로컬 설정 참고 |
| 식약처 수집 | `MFDS_API_KEY` | 별도 수집 스크립트용 Decoding 인증키. 포함된 DB 조회만 할 때는 불필요 |
| 규제 OCR | `TESSERACT_CMD`, `TESSDATA_PREFIX` | Tesseract 실행 파일·언어 데이터 경로. 자동 탐색으로 찾을 수 있으면 생략 |
| AI 공통 | `OPENAI_API_KEY` | **메인의 제형 문서 분석·개발요청서 자동변환과 챗봇 서버 모두 사용** |
| AI 모델 선택 | `SIMULATION_OPENAI_MODEL`, `REQUISITION_OPENAI_MODEL`, `CHATBOT_OPENAI_MODEL` | 각 기능의 모델. 기본 gpt-4.1 |
| 챗봇 연결 | `CHATBOT_URL`, `CHATBOT_SECRET` | 메인에서 호출할 챗봇 서버 주소, 양쪽 서버에 동일하게 설정할 공유 비밀값 |
| 챗봇 로컬 설정 | `CHATBOT_PORT`, `CHATBOT_DB_PATH` | 기본 포트 5100, 기본 캐시 DB는 `instance/cosmoa.db`. 경로를 바꾸지 않으면 DB 변수 생략 |

`OTHER_API_KEY`는 예비 항목입니다. 필요한 기능의 키를 위 표에 따라 설정합니다.

- 실제 Key 값은 자신의 `.env`에만 입력합니다. **코드, MD, `.env.example`, 커밋에 Key를 쓰지 않습니다.**
- Python에서는 `os.getenv("OPENAI_API_KEY")`처럼 읽습니다. 로컬에서는 두 서버가 루트 `.env`를 읽습니다. 메인은 로컬 `.env`를 우선하고, 챗봇은 기존 프로세스 환경변수를 우선합니다.
- 메인은 `COSMOA_ENV=production` 또는 `RENDER=true`이면 운영 모드로 동작하며 `.env`를 읽지 않습니다. 배포 값은 서비스별 환경변수로 설정합니다.
- 새 환경변수가 필요하면 `.env.example`에 **이름만** 추가합니다.

### 4. 식약처 DB와 OCR·PDF 준비

**식약처 DB** — 새로 받은 저장소에는 배포용 DB가 `data/regulatory/`에 포함되어 있습니다. 프로젝트 루트에서 실행할 때 로컬 `.env`에 다음과 같이 지정합니다.

```dotenv
MFDS_DB_PATH=data/regulatory/mfds_use_restriction.sqlite
```

다른 작업 디렉터리에서 실행한다면 절대 경로를 사용합니다. 변수를 생략할 경우 코드의 기본 경로는 `instance/regulatory/mfds_use_restriction.sqlite`이므로 그 위치에 DB가 있어야 합니다. 서버는 DB를 읽기 전용으로 조회하며 시작·검색 시 자동 수집하지 않습니다.

DB 갱신은 별도 `mfds_use_restriction.py` 수집 작업입니다. 수집기도 `MFDS_DB_PATH`를 사용하므로 **갱신할 때는 로컬 수집 경로를 지정**하고, 검증 후 배포용 사본을 교체합니다. 출처·수집 정보·갱신 절차는 [DB 안내](data/regulatory/README.md)를 따릅니다.

**OCR** — 스캔 PDF·PNG/JPG를 처리하려면 Tesseract 본체와 `kor`·`eng` 언어 데이터가 필요합니다. `pip install -r requirements.txt`만으로 본체가 설치되지는 않습니다. Windows 설치·경로 설정은 [규제 명세 13장](src/02_regulatory/regulatory.md)을 따릅니다. OCR이 없어도 텍스트 PDF와 Excel 추출은 사용할 수 있습니다.

**견적서 PDF 폰트** — 서버는 Windows의 맑은 고딕 또는 Linux의 NanumGothic TTF를 찾습니다. 한글 폰트가 없으면 영문 기본 폰트를 사용하므로 한글 출력에 문제가 생길 수 있습니다. `Dockerfile`에는 Tesseract·한글/영문 언어 데이터·나눔 폰트 설치가 포함되어 있습니다.

### 5. 메인 서버 실행·로그인

```bash
python app.py
```

→ http://127.0.0.1:5000

로그인 전에는 `/login`으로 이동합니다. 첫 실행 시 로그인 가능한 계정이 없으면 `COSMOA_DEMO_*` 값으로 계정을 만듭니다. **로컬 개발에서 해당 값이 비어 있으면** 기본 계정 `demo@costd.kr` / `cosmoa1234`가 생성됩니다. 운영에서는 이메일과 공개 기본값이 아닌 비밀번호를 설정해야 계정이 생성됩니다.

이미 계정이 있으면 `.env`의 데모 비밀번호를 바꿔도 기존 비밀번호는 바뀌지 않습니다. 로컬 기존 계정의 비밀번호는 아래 명령의 이메일을 실제 계정 이메일로 바꾸어 변경합니다. 새 비밀번호는 숨김 입력으로 받습니다.

```powershell
python -m src.common.auth set-password demo@costd.kr
```

계정·홈 캐시는 `instance/cosmoa.db`에 저장됩니다. `FLASK_PORT`를 바꿨다면 접속 주소도 해당 포트로 바꿉니다.

### 6. AI 챗봇 함께 실행

`.env`에 `CHATBOT_URL=http://127.0.0.1:5100`, `CHATBOT_SECRET`, `OPENAI_API_KEY`를 설정합니다. **별도 터미널**에서 같은 가상환경을 활성화한 뒤 프로젝트 루트에서 실행합니다.

```powershell
conda activate tdenv
python src/06_chatbot/server.py
```

메인과 챗봇을 모두 실행한 상태로 사용합니다. 로컬에서는 `.env`와 기본 캐시 DB를 함께 사용합니다. `CHATBOT_PORT`를 바꾸면 `CHATBOT_URL`도 맞춰야 합니다. `http://127.0.0.1:5100/health`는 서버 상태 확인용이며, 외부 API 연결 성공은 실제 질문으로 별도 확인합니다.

```text
브라우저 공통 위젯 → 메인 /api/chatbot/message (로그인 확인)
                 → 챗봇 /chat (공유 비밀값 확인) → AI 답변·조회 도구
```

### 7. Render 배포

저장소의 배포 구성은 메인(Docker)과 AI 챗봇(Python 런타임)을 별도 서비스로 실행합니다. 서비스별 설정·환경변수·데이터 유지 범위·발표 전 준비는 [Render 배포 안내](docs/deploy_render.md)를 따릅니다. 두 서비스는 배포 환경에서 디스크를 공유하지 않습니다.

## 페이지 URL

| URL | endpoint (`url_for`) | 템플릿 | 담당 |
|---|---|---|---|
| `/login` | `login` | `src/common/login.html` | PM |
| `/logout` | `logout` | 로그아웃 후 로그인 화면으로 이동 | PM |
| `/` | `home` | `src/01_home/home.html` | A |
| `/news` | `home_news` | `src/01_home/news.html` | A |
| `/regulations` | `home_regulations` | `src/01_home/regulations.html` | A |
| `/regulatory` | `regulatory` | `src/02_regulatory/regulatory.html` | B |
| `/margin-calculator` | `margin` | `src/03_margin/margin.html` | C |
| `/ai-formulation` | `simulation` | `src/04_simulation/simulation.html` | D |
| `/dev-request` | `dev_request` | `src/05_requisition/requisition.html` | E |
| `/assets/<path>` | `asset` | `src/` 내부 CSS·JS·이미지 제공 | PM |

대시보드 페이지와 뉴스·규제 더보기는 로그인이 필요합니다. `/regulatory`는 성분 규제 조회, `/regulations`는 홈의 규제 소식 더보기입니다.

### 기능별 API

메인 서버의 아래 API는 로그인 후 사용합니다. 세부 요청·응답은 각 기능 명세를 확인합니다.

| 경로 | 역할 | 담당 |
|---|---|---|
| `/api/home/data`, `/api/home/regulations` | 홈 데이터·규제 소식 | A |
| `/api/home/rates/<code>`, `/api/home/trade`, `/api/home/validation` | 환율·수출입 상세, 데이터 교차검증 | A |
| `/api/regulatory/ingredients`, `/api/regulatory/regulations` | 성분 검색·규제 조회 | B |
| `/api/regulatory/extract` (POST) | 문서·이미지 성분 추출 | B |
| `/api/margin-calculator/quote-profile`, `/api/margin-calculator/fx-rate`, `/api/margin-calculator/erp-cost` | 견적 기본정보·환율·시연용 원가 | C |
| `/api/margin-calculator/quote-pdf` (POST) | 견적서 PDF 생성 | C |
| `/api/ai-formulation/brief` (POST) | 개발요청서 AI 분석 | D |
| `/api/dev-request/convert` (POST) | 개발요청서 자동변환 (`requisition.requisition_convert`) | E |
| `/api/chatbot/message` (POST) | 챗봇 서버 중계 (`chatbot_message`) | F |

**별도 챗봇 서버**에는 `GET /health`(상태 확인), `POST /chat`(공유 비밀값 검증 후 답변)이 있습니다. 메인 서버의 페이지 URL과 구분합니다.

## Flask에서 `src/` HTML을 사용하는 방식

팀원별 폴더 분리를 위해 일반적인 `templates/`, `static/` 대신 `src/`를 그대로 사용합니다. HTML을 다른 폴더로 복사하지 않습니다.

**1) 템플릿** — `template_folder`를 `src/`로 지정했습니다. 템플릿 이름은 `src/` 기준 상대 경로입니다.

```python
app = Flask(__name__, template_folder=str(SRC_DIR), static_folder=None)
render_template("02_regulatory/regulatory.html")
```

**2) 공통 Layout** — 대시보드와 뉴스·규제 더보기 페이지는 `common/base.html`을 상속합니다. Sidebar / Navigation / Footer / 공통 CSS·JS를 함께 사용하므로 메뉴는 공통 레이아웃에서 변경합니다. 로그인 화면과 견적서 PDF 템플릿은 별도 구조입니다. 챗봇은 `base.html`에서 `06_chatbot/chatbot_widget.html`을 include하여 표시합니다.

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
<img src="{{ url_for('asset', filename='common/img/costd_logo.png') }}">
```

페이지 이동 링크도 `url_for()`를 사용합니다: `<a href="{{ url_for('margin') }}">`

**4) Python 모듈과 API 등록** — 기능별 처리 로직은 담당 폴더에 둡니다. 숫자로 시작하는 폴더는 `importlib.import_module()` 또는 파일 경로 기반 로딩을 사용합니다. `app.py`에는 Route와 모듈 연결 코드를 두며, 개발요청서는 `src/05_requisition/service.py`의 Blueprint를 등록합니다. 챗봇의 답변 생성은 별도 `server.py`에서 수행하고 메인은 중계합니다.

## 팀원별 담당 폴더

| 담당 | 영역 | 수정 가능 |
|---|---|---|
| **PM** | 공통 영역·배포 | `docs/`, `src/common/`, `app.py`의 로그인·페이지 Route, Navigation, `README.md`, Git·Docker 설정, 배포용 `data/regulatory/` |
| **A** | Home | `src/01_home/` |
| **B** | 국가별 인허가 규제 | `src/02_regulatory/` |
| **C** | 원가 경쟁력 및 마진 시뮬레이션 | `src/03_margin/` |
| **D** | AI 제형/샘플 시뮬레이션 | `src/04_simulation/` |
| **E** | 개발요청서 | `src/05_requisition/` |
| **F** | AI 챗봇 위젯·별도 서버 | `src/06_chatbot/`, `app.py`의 `[F]` 영역 |

- 각 담당자는 `app.py` 하단의 **자신의 영역**(`# [B] …` 주석 아래)에 Backend Route와 필요한 모듈 연결 코드를 추가합니다. 개발요청서는 기존 Blueprint 구조를 유지합니다.
- Python 처리 로직은 자신의 폴더 모듈(예: `src/02_regulatory/regulatory_service.py`)에 둡니다.
- 홈 콘텐츠·데이터는 A, 공통 사이드바·Navigation·로그인은 PM이 관리합니다.
- 공통 파일·배포 설정 변경은 PM과 조율하고, 기능 담당자는 기존 인터페이스와 다른 기능의 동작을 유지합니다.

## 공통 문서

| 문서 | 내용 |
|---|---|
| [디자인 시스템](docs/design_system.md) | Typography, Colors(CSS Variable), Layout, Shape, Responsive. **모든 화면 구현의 기준** |
| [디자인 참고 자료](docs/reference/) | 로그인·홈 디자인 참고 자료 |
| [공통 UI 규격](docs/ui_components.md) | Header, Button, Card, Form, Table, Modal 등의 HTML 구조·Class·상태 |
| `src/<폴더>/<이름>.md` | 페이지별 기능 명세서. 담당자가 직접 작성. **기능 요구사항은 이 파일이 최우선** |
| [Render 배포 안내](docs/deploy_render.md) | 메인·챗봇 설정, 환경변수, 시연 준비·점검 |
| [식약처 DB 안내](data/regulatory/README.md) | 배포용 DB 출처·수집 정보·갱신 절차 |
| [규제 API 계약](src/02_regulatory/api_reference.md) | 규제 조회·추출 API 요청·응답 |
| [규제 시연 검증 기록](src/02_regulatory/demo_verification.md) | 시연 자료별 검증 결과와 미검증 항목 |
| [마진 사용자 가이드](src/03_margin/margin_user_guide.md) | 계산·역제안·견적서 PDF 사용 방법 |
| [개발요청서 실행·검증](src/05_requisition/IMPLEMENTATION.md) | 구현 범위, API 설정, 저장·번역 제한, 검증 방법 |
| [챗봇 명세](src/06_chatbot/chatbot.md) | 위젯·서버·조회 도구와 인터페이스 |

서버별 환경변수는 이 README와 배포 안내를 따릅니다. 메인은 제형 분석·개발요청서 변환에, 챗봇 서버는 답변 생성에 `OPENAI_API_KEY`를 사용합니다.

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
7. 홈 콘텐츠·데이터는 A, 공통 Navigation·로그인은 PM이 관리한다.
8. `app.py`의 기존 Route를 삭제하거나 임의로 변경하지 않는다.
9. 새로운 Route를 추가할 때 기존 Route와 충돌하지 않는다. (`/api/<자신의 페이지 경로>/...` 접두사 사용)
10. API Key를 코드에 직접 작성하지 않는다.
11. 다른 담당자의 기능을 임의로 구현하지 않는다.
12. 기존 코드를 수정해야 한다면 최소 범위만 변경한다.
13. 페이지 디자인을 독자적으로 새로 만들지 않는다.
14. 기능별 실제 요구사항은 해당 폴더의 MD 파일을 최우선으로 따른다.
15. **AI 도구(바이브 코딩)로 작업할 때 커밋·푸시·머지는 담당자가 직접 한다.** AI에게는 커밋 제목과 내용 요약만 요청하고, `git add` / `git commit` / `git push` / `git merge`는 AI가 실행하지 않게 한다.

이름 충돌 방지:

- 페이지 CSS Class, HTML `id`는 페이지 접두사 사용 — `regulatory-…`, `margin-…`, `simulation-…`, `requisition-…`, `home-…`, `chatbot-…` (챗봇 CSS의 기존 `chatbot__…` 형식도 유지)
- 페이지 JS는 전역 변수를 만들지 않도록 IIFE 또는 `DOMContentLoaded` 안에 작성
- Flask 함수명(endpoint)도 접두사 사용 — 예: `regulatory_search`, `margin_calculate`

## Claude / Codex에게 요청하는 방법

1. 해당 기능의 명세, 구현 코드, API 계약·사용 안내·검증 기록을 먼저 확인합니다.
2. 변경할 요구사항·대상 파일·검증 범위를 정하고 기존 기능과 연결 방식을 유지합니다.
3. AI 코딩 도구에 아래와 같이 요청합니다. (국가별 인허가 규제 담당자 예시)

```
다음 문서를 순서대로 먼저 읽어 주세요.
1. README.md
2. docs/design_system.md
3. docs/ui_components.md
4. src/02_regulatory/regulatory.md
5. src/02_regulatory/api_reference.md
6. src/02_regulatory/demo_verification.md

기존 src/02_regulatory/ 구현과 tests/를 확인하고, 아래 변경 요구사항을 해당 폴더 안에 반영해 주세요.
변경 요구사항: [구체적인 변경 내용 작성]

규칙:
- src/02_regulatory/ 밖의 파일은 수정하지 마세요. (docs/, src/common/, 다른 담당자 폴더 수정 금지)
- app.py는 "[B] 국가별 인허가 규제" 주석 아래에 필요한 Route·모듈 연결 코드를 추가하는 것만 허용합니다.
  기존 Route는 삭제·변경하지 말고, URL은 /api/regulatory/ 로 시작하게 해 주세요.
- 공통 Button, Card, Form, Table, Modal 등은 ui_components.md의 HTML 구조와 Class를 그대로 사용하세요.
- 색상·간격·글자 굵기는 design_system.md의 CSS Variable만 사용하세요. (굵기는 --font-weight-regular / -bold / -extrabold 3종뿐)
- regulatory.css에는 이 페이지에서만 필요한 스타일만, "regulatory-" 접두사로 작성하세요.
- API Key는 os.getenv()로 불러오세요.
- 공통 영역 수정이 필요해 보이면 수정하지 말고 알려 주세요.
- 변경 범위에 맞는 기존 테스트를 실행하고, 결과와 미검증 항목을 알려 주세요.
- git add / commit / push / merge는 실행하지 마세요. 작업이 끝나면 변경 내용과 커밋 제목 제안만 알려 주세요. Git 반영은 제가 직접 합니다.
```

## 검증 방법

프로젝트 루트에서 가상환경을 활성화한 뒤 필요한 기능의 테스트를 실행합니다.

```powershell
python -m unittest discover -s src/02_regulatory/tests -p "test_*.py"
python -m unittest discover -s src/05_requisition/tests -p "test_*.py"
python -m unittest discover -s src/06_chatbot/tests -p "test_*.py"
```

위 테스트는 외부 API를 모의 처리합니다. 테스트 통과는 실제 키·서비스 연결 성공을 의미하지 않습니다. 규제 테스트의 실제 식약처 DB 검증은 로컬 DB 준비 여부에 따라 생략될 수 있습니다.

개발요청서의 추가 브라우저 검증은 Windows Edge가 있는 환경에서 실행합니다. JS 문법 검사는 Node.js가 필요합니다.

```powershell
node --check src/05_requisition/requisition.js
python src/05_requisition/tests/check_browser.py
```

테스트 범위·생성 파일은 [개발요청서 검증 안내](src/05_requisition/IMPLEMENTATION.md)를 확인합니다. 수동으로는 로그인, 홈 데이터, 규제 검색·OCR, 견적서 한글 PDF, 제형 문서 분석, 개발요청서 변환·인쇄, 챗봇 질문을 변경 범위에 맞게 확인합니다. 실제 AI 분석·질문은 외부 API 사용료가 발생할 수 있습니다. 기존 [시연 검증 기록](src/02_regulatory/demo_verification.md)과 [배포 점검 절차](docs/deploy_render.md)는 해당 문서에 기록된 범위의 근거입니다.

## Git 작업 시 주의사항

- `main`에 직접 커밋하지 않습니다. 기능별 Branch에서 작업 후 PR로 병합합니다.
  - 예: `feature/home`, `feature/regulatory`, `feature/margin`, `feature/sample`, `feature/requisition`, `feature/chatbot`
- 작업 시작 전 `git pull origin main`, PR 전에 `main`을 자신의 Branch에 병합해 충돌을 먼저 해결합니다.
- `git add .` 대신 자신의 폴더만 추가합니다: `git add src/02_regulatory/ app.py`
- 커밋 전 `git status`로 **자신의 폴더 밖 파일이 바뀌지 않았는지** 확인합니다. (AI 도구가 공통 파일을 건드리는 경우가 있습니다)
- **커밋·푸시·머지는 담당자가 직접 합니다.** AI 도구는 `git add / commit / push / merge`를 실행하지 않고 변경 내용·검증 결과·커밋 제목 제안만 제공합니다.
- `.env`, `instance/`, `tdenv/`, `__pycache__/`는 커밋하지 않습니다. DB는 기본적으로 제외하며 배포용 `data/regulatory/mfds_use_restriction.sqlite`만 예외입니다. Key를 실수로 커밋했다면 즉시 PM에게 알리고 Key를 재발급합니다.

**충돌 가능성이 높은 파일**

| 파일 | 이유 | 대응 |
|---|---|---|
| `app.py` | 기능별 Route·모듈 연결 | 자신의 주석 영역에만 추가, 로직은 자기 폴더 모듈로 분리, 기존 Blueprint 연결 유지 |
| `requirements.txt` | 각자 패키지 추가 | 한 줄씩 추가, 기존 줄 수정 금지, PR에 명시 |
| `.env.example` | 환경변수 이름·설명 추가 | 실제 비밀값 없이 추가, README·배포 안내와 일치 여부 확인 |
| `src/common/style.css`, `common.js`, `base.html` | 공통 영역 | PM만 수정 |
| `docs/*.md`, `README.md` | 공통 문서 | PM만 수정 |
| `Dockerfile`, `.dockerignore`, `data/regulatory/` | 배포 환경·DB 사본 | PM 관리, 두 서버의 환경변수·DB 경로 확인 |
| `src/01_home/home.html` | 홈 콘텐츠와 공통 디자인 연결 | 콘텐츠는 A, 공통 레이아웃 변경은 PM과 조율 |
