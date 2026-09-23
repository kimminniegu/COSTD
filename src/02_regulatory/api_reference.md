# 국가별 인허가 규제 — API 참고 문서

담당자 B. `/api/regulatory/` Route 계약과 외부 K뷰티 API 호출 방식을 기록한다.
기능 요구사항은 `regulatory.md`가 우선이며, 이 문서는 구현된 계약과 실제 확인한 API 응답만 다룬다.

- 처리 모듈: `src/02_regulatory/regulatory_service.py` (app.py [B] 영역에서 파일 경로로 로드)
- 실제 호출 기록: `src/02_regulatory/test_data/*.json` (인증 정보 제거, 응답 본문·HTTP 상태·호출 제한 헤더만)
- 테스트: `python -m unittest discover -s src/02_regulatory/tests -v` (외부 호출 없음)

## 1. 내부 Route (브라우저 → Flask)

브라우저는 아래 Route만 호출한다. 외부 API Key는 서버 환경변수(`RAPIDAPI_KEY`, `RAPIDAPI_HOST`)에서만 읽고 응답·로그에 넣지 않는다.

### GET `/api/regulatory/ingredients?q=<성분명>`

한글명·영문 INCI명 후보 검색. **규제 조회를 하지 않는다.** 자동완성(입력 멈춤 300ms 후)과 검색 버튼 모두 이 Route를 사용한다.

| 항목 | 내용 |
|---|---|
| 파라미터 | `q` 필수. 앞뒤 공백 제거 후 빈 값 또는 2글자 미만이면 400 (API 문서의 min 2 chars) |
| 외부 호출 | 입력에 한글이 있으면 `GET /v1/ingredient/kr?q=<q>`, 없으면 `GET /v1/ingredient/inci?q=<q>` — **항상 1회** |
| 성공 200 | 아래 JSON |
| 검증 실패 400 | `{"ok": false, "error": {"kind": "validation", "message": "..."}}` |
| 설정 오류 503 | `error.kind = "config"` — Key/Host 미설정. 외부 호출 없음 |
| 외부 API 오류 502 | `error.kind = timeout / connection / auth / rate_limit / http / invalid_response` |

```json
{
  "ok": true,
  "query": "레티놀",
  "candidates": [
    {
      "code": 5489,
      "kr_name": "레티놀",
      "inci_name": "Retinol",
      "old_name": null,
      "cas_numbers": "11103-57-4, 68-26-8",
      "record_updated_at": "2026-08-26 23:44:59",
      "match_rank": 0
    }
  ],
  "total": 1,
  "truncated": false,
  "search_field": "kr",
  "match_mode": "starts_with",
  "data_source": "Ministry of Food and Drug Safety (MFDS, ...), European Commission CosIng Database (...)",
  "queried_at": "2026-09-23T10:21:49+09:00"
}
```

- `candidates`는 `code` 기준 중복 제거 후 `match_rank`(0 정확 일치 → 1 시작 일치 → 2 포함 일치 → 3 그 외) 순, 같은 순위는 API 순서. 최대 10개, 초과 시 `truncated: true`.
- `kr_name`이 비어 있으면 `null` — 화면은 영문명만 표시하고 한글명을 만들지 않는다.
- `record_updated_at`은 API 레코드의 `updated_at`이다. **규제 자료 갱신일이 아니다.**
- 매칭은 앞뒤 공백 제거 + `casefold()`(영문 대소문자 무시). 순위 계산에는 `kr_name`·`inci_name`·`old_name`을 사용한다.
- `search_field`는 실제 호출한 엔드포인트(`kr` | `inci`), `match_mode`는 API 일치 방식(`starts_with`). 두 엔드포인트 모두 **시작 일치**라 중간 포함 입력(예: `티놀`)은 후보가 없다.
- 한글 엔드포인트에 영문을 넣으면 0건(`test_data/search_kr_english_retinol.json`)이므로 언어별로 엔드포인트를 고른다. 혼합 입력(한글+영문)은 한글 엔드포인트로 보낸다.

### GET `/api/regulatory/regulations?code=<성분코드>&country=<시장코드>`

성분 코드 + 시장 코드로 규제 조회. 후보 선택만으로는 호출하지 않으며, 화면에서 성분이 확정된 뒤 검색 버튼을 눌렀을 때 호출한다.

| 항목 | 내용 |
|---|---|
| 파라미터 | `code` 숫자 필수, `country` ∈ `KR, EU, CN, US, JP, ASEAN` (대소문자 무시) |
| 외부 호출 | `GET /v1/ingredient/{code}/regulations?country=<country>` 1회 |
| 오류 | ingredients 와 동일 (400 / 502 / 503) |

```json
{
  "ok": true,
  "ingredient": {"code": 5489, "kr_name": "레티놀", "inci_name": "Retinol"},
  "country": {"requested": "EU", "resolved": "EU", "code": "EU"},
  "lookup_status": "found",
  "result_status": "listed",
  "result_note": null,
  "entries": [
    {
      "country": "EU",
      "country_code": "EU",
      "regulate_type": "제한",
      "notice_ingr_name": "(2E,4E,6E,8E)-3,7-dimethyl-...",
      "proviso": null,
      "limit_condition": "* 【Restrictions】\nProduct Type, body parts : (a) Body lotion\n... (원문 그대로)",
      "source_type": "limit"
    }
  ],
  "markets_listed": ["EU"],
  "data_source": "Ministry of Food and Drug Safety (MFDS, ...), European Commission CosIng Database (...)",
  "disclaimer": "Regulatory reference data only. ...",
  "source_updated_at": null,
  "queried_at": "2026-09-23T10:21:56+09:00"
}
```

**`lookup_status` 판정 규칙** (응답의 `data`와 `result_status`만 사용)

| 값 | 조건 | 화면 조회 상태 |
|---|---|---|
| `found` | `result_status = "listed"` 이고 `data`가 비어 있지 않음 | 규제 정보 조회됨 |
| `no_data` | `result_status = "not_listed_in_country"` 이고 `data = []` | 규제 데이터 미확인 (허용·안전 아님) |
| `hold` | 확인하지 않은 `result_status` 값, 또는 `listed`인데 `data = []` 등 예상 밖 조합 | 판단 보류 · 추가 확인 필요 |
| (오류) | HTTP 오류·연결 실패·`success != true`·형식 불일치 → 502 `error` | API 오류 (미확인으로 바꾸지 않음) |

- `ingredient.regulation_status`(예: `Restricted`)는 성분 전체 속성이라 **선택 시장의 상태로 쓰지 않으며 응답에서 제외**한다.
- `markets_outside_plan`은 의미 미확인이라 사용·전달하지 않는다.
- `limit_condition`, `proviso`, `notice_ingr_name`은 가공 없이 원문 그대로 전달한다.
- `source_updated_at`은 응답에 규제 자료 갱신일이 없어 항상 `null`(화면 '미제공'). `queried_at`은 서버가 호출한 시각.

## 2. 외부 API (K-Beauty Cosmetic Ingredients / RapidAPI)

| 항목 | 내용 |
|---|---|
| 기본 주소 | `https://k-beauty-cosmetic-ingredients.p.rapidapi.com` (`RAPIDAPI_HOST`) |
| 인증 헤더 | `x-rapidapi-key`, `x-rapidapi-host` — 서버만 보유 |
| 타임아웃 | 연결 5초 / 읽기 15초 (`regulatory_service.py`) |
| 재시도·캐시 | 없음 (화면의 '다시 시도' 버튼으로 수동 재조회) |

### 확인된 호출 (2026-09-23 실제 호출, `test_data/`)

| 파일 | 호출 | HTTP | 확인 내용 |
|---|---|---|---|
| `search_kr_retinol.json` | `GET /v1/ingredient/kr?q=레티놀` | 200 | `success=true, count=1`, `data[0].code=5489`, `kr_name=레티놀`, `inci_name=Retinol`, `regulation_status=Restricted`, `updated_at` 있음 |
| `search_kr_partial_reti.json` | `GET /v1/ingredient/kr?q=레티` | 200 | `count=15`, 모두 `레티`로 **시작**하는 한글명 (레티놀·레티닐…·레티노일…). 부분(시작) 검색 지원 확인 |
| `search_kr_partial_etan.json` | `GET /v1/ingredient/kr?q=에탄` | 200 | `count=8`, `에탄`(6203)·`에탄올`(2093)·`에탄올아민`… 명세 예시 확인 |
| `search_kr_english_retinol.json` | `GET /v1/ingredient/kr?q=Retinol` | 200 | `success=true, count=0, data=[]` — 한글 엔드포인트는 영문 미지원 |
| `search_inci_partial_retin.json` | `GET /v1/ingredient/inci?q=retin` | 200 | `count=17`, 소문자 입력으로 `Retinol`·`Retinal`·`Retinyl …` 반환 — 영문 시작 일치·대소문자 무시 확인 |
| `regulations_5489_EU.json` | `GET /v1/ingredient/5489/regulations?country=EU` | 200 | `result_status=listed`, `count=1`, `data[0].limit_condition`에 제품 유형·최대 농도(0,05 % / 0,3 % RE)·표시 문구 원문, `source_type=limit`, `markets_listed=["EU"]` |
| `regulations_5489_US.json` | `GET /v1/ingredient/5489/regulations?country=US` | 200 | `result_status=not_listed_in_country`, `count=0`, `data=[]`, `result_note="No entry for US in our source data. ..."` |

응답 공통 필드: `data_source`(MFDS + EU CosIng), `disclaimer`, `available_country_codes = ["KR","EU","CN","US","JP","ASEAN"]`, `available_countries`(한글 표시명), `country.{requested, resolved, code}`.

호출 제한 헤더(2026-09-23 관측): `X-RateLimit-Requests-Limit: 25000`, `X-RateLimit-Requests-Remaining: 24906`(4단계 확인 호출 4회 후). 월 단위 요청 한도로 보이나 요금제 문서로 재확인 필요.

**엔드포인트 문서 출처**: API 제공자의 공개 저장소 README(github.com/han-tagg/Korean-cosmetic-ingredients-api). 검색 엔드포인트 `/v1/ingredient/{inci|kr|cas}?q=`는 모두 "starts with", `/v1/ingredient/search?q=&field=inci|kr|cas|all`은 "contains"이며 PRO+ 전용, 검색어 최소 2글자. 문서에 오류 응답 형식은 없다.

### 아직 확인하지 않은 것 (4단계 이후)

- 중간 포함 검색 `/v1/ingredient/search`(PRO+)의 실제 동작·현재 요금제 사용 가능 여부 (미호출). 동의어 검색 지원 여부
- `result_status` 전체 값 목록, 오류 응답(4xx/5xx) 본문 형식
- `ASEAN` 조회가 아세안 공통 기준인지 개별 국가 규정을 포함하는지
- `markets_outside_plan` 의미, 규제 자료 갱신일 제공 여부
- 429 초과 시 응답 형식. 자동완성은 300ms 디바운스·조합 중 미요청으로 호출을 줄이며 캐시는 없음

## 3. 화면 흐름 (직접 검색, 현재 구현)

1. 성분명(한글 또는 영문 INCI) 입력 → 앞뒤 공백 제거 후 2글자 이상이고 한글 조합이 끝난 뒤 300ms 동안 입력이 없으면 `/api/regulatory/ingredients` → 검색창 아래 후보 최대 10개 (로딩 / 후보 없음 / 후보 검색 실패 중 하나만 표시). 입력이 바뀌거나 목록이 닫히면 진행 중 응답은 무시한다(`acSeq`). **검색 버튼**을 바로 누르면 같은 Route로 후보를 조회한다. 직접 검색에는 함량·제품 조건 입력이 없다 (2026-09-23 요구사항 변경).
2. 후보 클릭 또는 ↑↓ + Enter 로 성분 확정 → 목록 닫힘, 검색창 아래 "선택한 성분" 표시. **이 단계에서 규제 조회는 하지 않는다.**
   - 입력과 정확히 일치(공백·대소문자 무시)하는 후보가 **정확히 하나**이면 자동 확정 후 같은 클릭에서 3번으로 진행한다. 목록이 이미 열려 있으면 재요청 없이 그 후보 안에서 판단한다. 그 외에는 반드시 사용자 선택(첫 후보를 임의 확정하지 않음).
3. 성분이 확정된 상태에서 **검색 버튼** → `/api/regulatory/regulations` → **결과 카드** 1장: 성분명·영문명·시장, 조회 상태, 규제 유형(`regulate_type` 원문), 규제 조건, 실제 조회 범위, '규제 원문·출처 보기' 버튼 → 상세 Modal.
   - 결과 영역은 `loading / error / single / batch` 중 한 블록만 표시한다. 요청 완료·실패 시 로딩과 버튼 비활성은 항상 해제된다.
   - `found`: 중립 배지 '규제 정보 조회됨'(허용·안전으로 보이지 않도록 초록색을 쓰지 않음). `no_data`: 경고 배지 + "확인되지 않았어요 / 허용·안전 아님" 안내 + API `result_note`, 규제 조건 영역 숨김. `hold`: 경고 배지 + 보류 안내. API 오류: Error 블록에 서버가 준 `error.kind`·`message`·외부 HTTP 상태를 그대로 표시하고 '다시 시도' 제공.
   - 검토 상태·기준 비교·입력 부족 안내는 표시하지 않는다. 적합성·안전성 판정을 생성하지 않는다.
4. **규제 조건 표시 규칙** (`regulatory.js` `parseConditionText` / `renderConditions`)
   - `limit_condition` 원문이 `* 【태그】 라벨 : 값` 블록 구조이면 블록별로 나누고, 먼저 언어별로 배치한다: 라벨(없으면 태그·값)에 한글이 있으면 한국어, 아니면 영문. **영문 전체가 위(English · API 제공 영문), 한국어 전체가 아래(한국어 · API 제공 한국어)** 이며 한 언어만 있으면 그 언어만 표시한다. 한국어 문장 안의 영문 성분명·단위는 분리하지 않는다. 각 언어 안에서 라벨 키워드로 묶는다: 적용 제품·부위(`product type`, `body part`, `제품 유형`, `사용 부위`) / 최대 농도(`maximum concentration`, `최대 농도`) / 사용 조건·주의 문구(`conditions of use`, `warning`, `사용 조건`, `주의`) / 분류가 불확실한 블록은 '기타 원문'에 라벨 그대로 누락 없이.
   - 값 안의 `(a) … (b) …` 는 표기를 유지한 채 줄로 나눈다. 글자 표기가 적용 제품과 최대 농도의 대응 관계이며, 둘 이상 그룹에 표기가 있으면 안내 문구를 붙인다.
   - 블록 하나라도 `라벨 : 값` 으로 읽을 수 없으면 나누지 않고 원문 전체를 `pre-wrap` 으로 표시하고 "원문 구분이 확실하지 않아 그대로 표시했어요"를 붙인다.
   - 규제 항목(`entries`)이 여러 건이면 항목별 제목(순번·유형·국가)으로 구분하고, `proviso` 가 있으면 '단서 조항 (원문)' 블록으로 붙인다.
   - 문장은 재배치만 하며 번역·요약·환산·재해석을 하지 않고, 성분별 규칙을 두지 않는다. 원문 전체·출처·고시 성분명·응답 상태값은 상세 Modal 에 그대로 둔다.
5. '이전 조건의 결과' 안내는 표시 중인 결과의 조건 키(성분 code·시장)와 현재 입력이 다를 때만 보이고, 같은 조건으로 돌아오면 사라진다. 검색어를 수정하면 확정된 성분은 해제된다.
6. 파일 일괄 조회 결과(후속 단계)는 조회 조건·요약 수치·간결한 표(성분명·조회 상태·규제 유형·검토 상태·상세)로 구성한다. 함량 추출·수정·검토 상태는 파일 조회 요구사항으로 유지한다. 일부 실패 안내와 '실패 항목 재시도'는 실제 실패 건이 있을 때만 표시한다.

**공통 CSS 관련 PM 협의 사항**: `src/common/style.css`에 `[hidden] { display: none }` 규칙이 없어 `.loading`, `.state`, `.badge`, `.alert`처럼 class로 `display`를 지정하는 요소는 `hidden` 속성이 무시된다(로딩·오류·후보 상태가 동시에 보이던 원인). 공통 파일은 수정하지 않고 `regulatory.css`에서 이 페이지 영역(`#regulatory-panel-search`, `#regulatory-panel-file`, `#regulatory-results`, `#regulatory-detail-modal`)에만 `[hidden] { display: none !important }`를 적용했다. 공통 CSS에 같은 규칙을 추가하면 페이지 규칙은 제거해도 된다.
