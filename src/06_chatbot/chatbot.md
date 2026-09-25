# COSMOA AI 챗봇 명세서

| 항목 | 내용 |
|---|---|
| 프로젝트 | COSMOA (화장품 해외영업 업무지원 플랫폼) |
| 팀 | COSTD |
| 담당 범위 | 우하단 플로팅 AI 챗봇 (데이터 도구 호출 + 업무 비서) |
| 기술 스택 | Flask(독립 서버, Render 별도 배포), OpenAI Responses API(function calling), Vanilla JS 위젯 |
| 문서 버전 | v0.1 (2026-09-25) |

---

## 1. 페이지 목적

모든 화면의 우하단에 떠 있는 AI 비서다. 해외영업 담당자가 화면을 옮기지 않고 **환율·수출입·뉴스·규제·성분 규제**를 물어보고, **바이어 메일 초안·단가/환산 계산·문서 문구 정리** 같은 화장품 무역 업무를 도움받는다.

- 데이터 질문은 모델이 도구(function)를 호출해 **같은 저장소의 기존 모듈**에서 실제 값을 가져와 답한다. 지어내지 않는다.
- 화장품 무역과 관계없는 요청은 정중히 사양한다.
- 규제 답변은 참고 자료이며 허용·안전 판단이 아니라는 점을 항상 덧붙인다.

## 2. 담당 파일

```
src/06_chatbot/
├── chatbot.md              이 문서
├── server.py               독립 Flask 앱 (Render 별도 서비스). OpenAI 호출 + 도구 실행 반복
├── tools.py                도구 정의(JSON Schema, strict) + 실행. 기존 모듈 직접 import
├── chatbot_widget.html     위젯 템플릿 (base.html 마지막에 include)
├── chatbot.css             위젯 스타일 (chatbot- 접두사, 공통 Token 만 사용)
├── chatbot.js              위젯 동작 (IIFE, sessionStorage 로 대화 유지)
└── tests/test_chatbot.py   unittest (외부 API 호출 없음. 가짜 OpenAI 서버로 왕복 검증)
```

공용 파일에 덧붙인 것 (14장 참고): `app.py` [F] 영역, `src/common/base.html` include 1줄, `requirements.txt` gunicorn, `.env.example` CHATBOT_* 4개.

## 3. URL

| 서버 | 메서드 · URL | 설명 |
|---|---|---|
| COSMOA 본 서버 (app.py) | `POST /api/chatbot/message` | 위젯 → 중계. 로그인 세션 확인 후 챗봇 서버 `/chat` 으로 전달 (endpoint `chatbot_message`) |
| COSMOA 본 서버 | `GET /assets/06_chatbot/chatbot.css`, `chatbot.js` | 위젯 정적 파일 |
| 챗봇 서버 (server.py) | `GET /health` | 상태 확인 (Render Health Check 경로) |
| 챗봇 서버 | `POST /chat` | 헤더 `X-Chatbot-Secret` 일치 시에만 응답 |

브라우저는 챗봇 서버를 직접 호출하지 않는다. (CORS 없음, 시크릿은 서버끼리만 공유)

## 4. 사용자

로그인한 COSMOA 사용자 전원. 세션이 없으면 중계 Route 가 401 을 돌려주고 위젯이 재로그인을 안내한다. 로그인 화면(`login.html`)은 base.html 을 쓰지 않으므로 위젯이 없다.

## 5. 주요 기능

| 구분 | 기능 | 도구 |
|---|---|---|
| 데이터 조회 | 오늘 환율 · 전일 대비 · 환산 계산 | `get_exchange_rates` |
| | 화장품 수출입 실적 (월간, 12개월 추이, 상위국, 품목) | `get_trade_stats` |
| | 화장품 뉴스 검색 (수집 6개 매체 + 구글 뉴스) | `search_news` |
| | 해외 규제 소식 검색 (국가 필터) | `search_regulation_news` |
| | 성분 후보 검색 (한글명 / INCI) | `search_ingredient` |
| | 성분 × 시장 규제 조회 (식약처 수집 DB 또는 K-Beauty API) | `lookup_ingredient_regulation` |
| | 바이어 현지 시각 · 업무 시간 여부 | `get_local_time` |
| 업무 비서 | 바이어 메일·회신 초안(한/영), 견적·마진·환산 계산, 개발요청서·제안서 문구, 규제 용어 설명, 회의 요약 | 도구 없음 (모델) |
| 위젯 | 열기/닫기, 추천 질문 Chip, Enter 전송, 대화 지우기, 페이지 이동 후 대화 유지(탭 단위) | — |

## 6. 사용자 입력

| 입력 | 제한 | 처리 |
|---|---|---|
| 메시지 | 1건 4,000자, 대화 기록 최근 30건만 전송 | 앞뒤 공백 제거, 빈 메시지 무시 |
| 추천 질문 Chip | 고정 5개 | 클릭 시 해당 문장을 바로 전송 |
| 대화 지우기 | — | sessionStorage 기록 삭제, 빈 상태로 |

## 7. 처리 과정

```
브라우저 chatbot.js
  └─ POST /api/chatbot/message {messages:[{role, content}…]}          (같은 사이트, 세션 쿠키)
       └─ app.py chatbot_message : 세션 확인 → user{name, team} 추가 → POST {CHATBOT_URL}/chat (X-Chatbot-Secret)
            └─ server.py /chat : 시크릿 검증 → 메시지 검증 → run_chat()
                 ├─ OpenAI Responses API (instructions = system prompt + 현재 시각 + 사용자, tools = tools.TOOLS, store=false)
                 ├─ 응답에 function_call 이 있으면 tools.execute() 로 실행 → function_call_output 을 input 에 붙여 다시 호출
                 │    (최대 6회. 마지막 회차는 tool_choice=none 으로 답변만 받음)
                 └─ message 가 나오면 {"ok": true, "reply", "tools_used"} 반환
       └─ 응답 상태코드·본문을 그대로 브라우저에 전달
```

- 대화 상태는 서버에 저장하지 않는다. (`store: false`, 서버 무상태) 기록은 브라우저 sessionStorage 에만 있다.
- 도구 결과는 JSON 문자열(최대 7,000자)로 모델에 전달하고, 결과 안의 문장은 지시로 따르지 않도록 system prompt 에 명시한다.

## 8. 출력 결과

- 답변은 해요체 한국어(영어 질문은 영어). 채팅창 폭에 맞춰 표·제목·코드블록 없이, `- ` 목록과 `**굵게**` 만 쓴다.
- 위젯은 HTML 을 escape 한 뒤 `**굵게**`, `- 목록`, URL 링크만 변환해 표시한다. (모델 출력의 HTML 은 실행되지 않음)
- 숫자에는 기준일·출처를 함께 적는다. 규제 결과에는 "참고 자료, 최종 판단은 담당자·법령 원문 확인" 문구를 붙인다.

## 9. API / 외부 데이터

| 구분 | 출처 | 모듈 | 환경변수 |
|---|---|---|---|
| 모델 | OpenAI Responses API (`/v1/responses`, function calling, strict schema) | server.py (SDK 없이 urllib — 05_requisition 과 같은 방식) | `OPENAI_API_KEY`, `CHATBOT_OPENAI_MODEL`(기본 gpt-4.1) |
| 환율 · 수출입 · 뉴스 · 규제 소식 | 홈 데이터 캐시(SQLite) + 백그라운드 수집 | `src/01_home/home_data.py` 직접 import | `EXIM_API_KEY`, `DATA_GO_KR_KEY`, (선택) `KOTRA_NEWS_URL`, `COSMETIC_HS_CODES` |
| 성분 검색 · 규제(API) | K-Beauty Cosmetic Ingredients API (RapidAPI) | `src/02_regulatory/regulatory_service.py` | `RAPIDAPI_KEY`, `RAPIDAPI_HOST` |
| 규제(식약처) | 식약처 사용제한 원료정보 수집 DB (읽기 전용) | `src/02_regulatory/regulatory_mfds_lookup.py` | `MFDS_DB_PATH` (기본 instance/regulatory/mfds_use_restriction.sqlite) |

기존 모듈은 로그인 세션에 의존하지 않아 분리 없이 그대로 쓴다. 폴더명이 숫자로 시작하므로 `importlib.import_module` / `spec_from_file_location` 으로 불러온다.

## 10. 데이터 처리

- 도구 결과는 화면용 응답을 그대로 넘기지 않고 **모델에 필요한 필드만 축약**한다. (뉴스: 출처·제목·URL·시각, 규제: 국가·유형·고시명·제한조건·단서)
- 규제 원문(`limit_condition`, `proviso`, `result_note`, `disclaimer`)은 가공하지 않는다. `lookup_status` 가 not_listed 여도 "허용" 으로 바꾸지 않는다.
- 식약처 DB 가 없거나(`db_missing`) API 설정이 없으면(`config`) 오류를 그대로 모델에 전달하고, 다른 출처로 **자동 전환하지 않는다**. 모델이 사용자에게 알린 뒤 `source=api` 로 다시 시도할 수 있다.
- 홈 캐시가 비어 있으면 환율은 즉시 1회 조회하고, 뉴스·규제·수출입은 백그라운드 수집을 시작한 뒤 "수집 중" 안내를 돌려준다.
- 챗봇 서버는 Render 에서 **본 서버와 디스크를 공유하지 않는다.** 캐시 DB(`CHATBOT_DB_PATH`)를 따로 두고 같은 수집 코드로 채운다. 로컬에서는 기본값이 `instance/cosmoa.db` 라 본 서버와 공유된다. 식약처 수집 DB 는 챗봇 서버에도 복사하거나 `MFDS_DB_PATH` 로 지정해야 조회된다.

## 11. 예외 처리

| 상황 | 상태 | 사용자에게 보이는 문구 (요지) |
|---|---|---|
| 로그인 세션 없음 | 401 | 로그인이 만료됐어요 + 로그인 링크 |
| 본 서버에 CHATBOT_URL / SECRET 없음 | 503 | AI 비서가 아직 연결되지 않았어요 |
| 시크릿 불일치 | 401 | 인증되지 않은 요청이에요 (브라우저에는 그대로 전달됨) |
| 챗봇 서버에 OPENAI_API_KEY 없음 | 503 | AI 비서가 아직 설정되지 않았어요 |
| OpenAI 401/403 · 404 · 429 · 크레딧 부족 | 503 | 인증 실패 / 모델 사용 불가 / 사용량 많음 / 크레딧 부족 (원문은 노출하지 않음) |
| 대화가 컨텍스트 한도 초과 | 413 | 대화를 지우고 다시 시작해 주세요 |
| 챗봇 서버 연결 실패 · 응답 지연(90초) | 502 · 504 | 연결하지 못했어요 / 지연되고 있어요 |
| 도구 실행 오류 | 200 | 모델이 결과의 오류 안내를 전달 (대화는 계속) |
| 도구 호출 6회 초과 | 502 | 질문을 나눠서 다시 물어봐 주세요 |
| 요청 본문 256KB 초과 | 413 | 대화를 지우고 다시 시도 |

오류는 채팅창에 빨간 말풍선으로 보이며, 기록에는 저장하지 않는다.

## 12. UI 구성

| 요소 | 규격 |
|---|---|
| 위치 | `position: fixed`, 우하단 24px. z-index 는 Sidebar/Header 위, Modal(200) 아래 (190) |
| 런처 | 56px 원형 `--color-primary`, 흰 채팅 아이콘(inline SVG), `--shadow-overlay`. 열리면 × 아이콘 |
| 패널 | 380 × min(640px, 화면 높이) 흰색 Card, `--radius-2xl`, `--shadow-overlay`, 열릴 때 Modal 과 같은 0.28s 진입 |
| 헤더 | Icon Tile(primary-soft) + "AI 비서" + 부제, 대화 지우기·닫기 Icon Button |
| 빈 상태 | 안내 문구 + 추천 질문 Chip 5개 (Pill, primary-soft) |
| 말풍선 | 사용자: primary 배경 흰 글자 우측 / AI: `--color-background` 좌측 / 오류: danger-soft. 15px, 최대 폭 88% |
| 입력 | `textarea.form-control.form-control-sm` 44px(최대 120px 자동 확장) + `btn btn-primary btn-icon` 전송 |
| 로딩 | 공통 `.spinner.spinner-sm` + "답변을 준비하고 있어요" |
| Mobile ≤640px | 패널 전체 화면, 런처 숨김 |
| 접근성 | 런처 `aria-expanded/controls`, 패널 `role=dialog`, 메시지 영역 `aria-live=polite`, ESC 로 닫기(Modal 이 열려 있으면 Modal 우선) |

새 공통 컴포넌트는 만들지 않았다. Button·Input·Spinner 는 공통 Class 그대로, 나머지는 `chatbot-` 접두사.

## 13. Flask / app.py 연동

**본 서버 (app.py [F] 영역)**

```python
@app.route("/api/chatbot/message", methods=["POST"])   # 세션 확인 → requests.post(CHATBOT_URL + "/chat")
```
`.env`: `CHATBOT_URL`, `CHATBOT_SECRET` 두 개만 필요. OpenAI 키는 본 서버에 두지 않는다.

**챗봇 서버 (Render 별도 서비스, 같은 저장소)**

| 항목 | 값 |
|---|---|
| Root Directory | (비움 — 저장소 루트) |
| Build Command | `pip install -r requirements.txt` |
| Start Command | `gunicorn "src.06_chatbot.server:app" --bind 0.0.0.0:$PORT --timeout 120` |
| Health Check Path | `/health` |
| 환경변수 | `OPENAI_API_KEY`, `CHATBOT_SECRET`(본 서버와 동일), `CHATBOT_OPENAI_MODEL`(선택), `EXIM_API_KEY`, `DATA_GO_KR_KEY`, `RAPIDAPI_KEY`, `RAPIDAPI_HOST`, (선택) `CHATBOT_DB_PATH`, `MFDS_DB_PATH` |

**로컬 실행** (터미널 2개)

```bash
python src/06_chatbot/server.py     # 챗봇 서버, http://127.0.0.1:5100  (.env 의 OPENAI_API_KEY, CHATBOT_SECRET 사용)
python app.py                       # 본 서버. .env 에 CHATBOT_URL=http://127.0.0.1:5100, CHATBOT_SECRET=<같은 값>
```

로컬에서는 `.env` 하나를 두 서버가 함께 읽으므로 `OPENAI_API_KEY` 와 `CHATBOT_*` 를 모두 `.env` 에 두면 된다.

## 14. 수정 가능 파일

- `src/06_chatbot/` 전체
- `app.py` — `# [F] AI 챗봇` 주석 아래만
- `src/common/base.html` — `{% include "06_chatbot/chatbot_widget.html" ignore missing %}` 1줄 (PM 승인)
- `requirements.txt` 끝에 `gunicorn`, `.env.example` 끝에 `CHATBOT_*`

## 15. 수정 금지 영역

- `src/01_home/`, `src/02_regulatory/` 등 다른 담당자 모듈 — **import 만** 하고 고치지 않는다. 필요한 변경은 담당자에게 요청
- `app.py` 의 페이지 Route · 로그인 · 다른 담당자 영역
- `src/common/style.css`, `common.js`, `docs/*.md`, `README.md`

## 16. 완료 조건

- [x] 모든 페이지(로그인 제외) 우하단에 런처가 보이고, 열기/닫기/추천 Chip/Enter 전송/대화 지우기가 동작한다
- [x] 페이지를 이동해도 같은 탭에서는 대화가 유지된다 (sessionStorage)
- [x] 데이터 질문에 도구가 호출되고, 결과 기준일·출처가 답변에 포함된다 (가짜 OpenAI 로 왕복 검증)
- [x] 시크릿 불일치 401, 세션 없음 401, 설정 없음 503, OpenAI 오류는 원문 노출 없이 한글 안내
- [x] `python -m unittest src/06_chatbot/tests/test_chatbot.py` 통과 (외부 API 호출 없음)
- [ ] Render 에 챗봇 서비스 배포 후 `/health` 200 확인, 본 서버 `.env` 에 `CHATBOT_URL` 연결 (담당자 수행)
- [ ] 실제 OpenAI 키로 환율·규제·메일 초안 3가지 시나리오 확인 (담당자 수행)
