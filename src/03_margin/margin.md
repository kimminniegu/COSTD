# 원가 경쟁력 및 마진 시뮬레이션 (COSMOA · 담당 C)

> **이 문서는 `src/03_margin/` 기능의 최우선 기준 문서(PRD)입니다.**
> 구현 전 반드시 `README.md` → `docs/design_system.md` → `docs/ui_components.md` → 이 문서 순서로 읽습니다.
> 이 문서와 공통 문서가 충돌하면 **디자인·공통 UI는 공통 문서**, **기능·수식·API는 이 문서**를 따릅니다.

| 버전 | 날짜 | 변경 내용 | 작성 |
|---|---|---|---|
| 1.0 | 2026-09-23 | 3대 서브 탭(수량별 단가 / 수출 조건·환율·역제안 / PI·협상 히스토리) 전체 명세 작성 | C |
| 1.1 | 2026-09-23 | API 접두사를 README 규칙 9에 맞춰 `/api/margin/` → `/api/margin-calculator/`로 변경 | C |

**문서 표기 규칙**

- `원/ea` = 개당 원화 금액, `RT` = Revenue Ton(운임 부과 톤, `max(CBM, 톤)`), `q` = 발주 수량(ea)
- **[필수]** 구현 누락 시 완료로 보지 않음 / **[권장]** 시간이 되면 구현 / **[범위 외]** 이번 버전에서 구현하지 않음
- 모든 예시 수치는 §4.7의 **검증용 기준 케이스(Golden Case)** 와 일치합니다. 구현 후 이 값으로 검산합니다.
- 마스터 데이터의 운임·요율·할인율은 **모의 기준값(예시)** 입니다. 실제 포워더·협력사 견적을 받으면 `service.py`의 상수 값만 교체합니다.

---

## 목차

1. [기능 개요 및 비즈니스 목적](#1-기능-개요-및-비즈니스-목적)
2. [화면 레이아웃 및 서브 탭 UI 컴포넌트 구조](#2-화면-레이아웃-및-서브-탭-ui-컴포넌트-구조)
3. [데이터 요구사항 및 스키마](#3-데이터-요구사항-및-스키마)
4. [수식 및 비즈니스 로직](#4-수식-및-비즈니스-로직)
5. [서브 탭 간 상태 관리 및 데이터 흐름](#5-서브-탭-간-상태-관리-및-데이터-흐름)
6. [Backend API 명세 및 service.py 함수 설계](#6-backend-api-명세-및-servicepy-함수-설계)
7. [예외 처리 및 엣지 케이스 방어 로직](#7-예외-처리-및-엣지-케이스-방어-로직)
8. [바이브 코딩 구현 가이드라인](#8-바이브-코딩-구현-가이드라인)
- [부록 A. README 16개 항목 매핑](#부록-a-readme-16개-항목-매핑)
- [부록 B. 용어집](#부록-b-용어집)

---

## 1. 기능 개요 및 비즈니스 목적

### 1.1 한 줄 정의

화장품 OEM·ODM 해외영업 담당자가 **제조원가 → 수량별 공급단가 → 수출 조건(인코텀즈·물류·환율) → 바이어 역제안 검토 → 영문 PI 발행 → 협상 버전 관리**까지를 한 화면(3개 서브 탭)에서 끝낼 수 있게 하는 마진 시뮬레이터입니다.

### 1.2 해결하려는 업무 문제

| 현재 업무 방식의 문제 | 이 페이지가 주는 해결 |
|---|---|
| 원가표(엑셀)·운임 견적(메일)·환율(웹)을 따로 보고 손으로 합산 → 계산 실수, 시간 소요 | 원가 4대 요소와 물류·환율을 한 파이프라인으로 연결해 즉시 계산 |
| 수량이 늘면 얼마나 싸게 줄 수 있는지 감으로 판단 | 수량 구간(Tier)별 규모의 경제(할인율·고정비 분산)를 수식으로 반영한 계단식 단가표 |
| 바이어가 "$1.50에 맞춰 달라"고 할 때 수락 가능 여부를 바로 답하지 못함 | 역제안가를 넣으면 실제 마진율, 필요한 원가 절감액, 필요한 발주 수량을 즉시 제시 |
| 환율이 움직이면 이미 보낸 견적이 손해가 되는지 모름 | ±5%·±10% 환율 스트레스 테이블과 손익분기·방어선 환율 제시 |
| PI를 워드로 매번 새로 작성, 협상 차수별 조건 변화 추적 불가 | 시뮬레이션 값이 자동 바인딩되는 표준 영문 PI, 버전 저장 및 차수 간 변경 비교 |

### 1.3 사용자 및 사용 시나리오

- **주 사용자**: 화장품 OEM·ODM 기업 해외영업 담당자(견적 작성·협상), 영업 팀장(마진 승인 판단)
- **대표 시나리오**
  1. 담당자가 신제품 에센스 50ml의 원가 4대 요소를 입력하고 목표 마진 30%를 설정 → 1,500 / 3,000 / 5,000 / 10,000ea 공급단가 비교
  2. 5,000ea 구간을 선택 → 미국 서부향 해상 LCL, CIF Los Angeles, USD 조건으로 외화 단가 `$1.876` 확인, 환율 -10% 시에도 마진 21%로 방어됨을 확인
  3. 바이어가 `$1.50`을 역제안 → 마진 11.53%(방어선 15% 미달)로 "수용 불가" 판정, 원가 360원/ea 절감 또는 가격 재협상 필요 안내
  4. 재협상 끝에 `$1.75` / 10,000ea로 합의 → PI v2.0 발행, v1.0 대비 단가·수량·마진 변화 비교

### 1.4 범위

| 구분 | 내용 |
|---|---|
| **[필수]** | Tab 1 원가·Tier 계산·테이블·차트 / Tab 2 CBM·물류·인코텀즈·환율·스트레스·역제안 / Tab 3 PI 입력·미리보기·PDF·인쇄·버전 저장·비교 / 환율 외부 API + Fallback |
| **[권장]** | 입력 초안 `localStorage` 자동 저장, Tier 행별 원가 구성 상세 Modal, 차트 Hover Tooltip |
| **[범위 외]** | 관세·부가세(DDP) 계산, 로그인 사용자별 히스토리 분리(로그인 기능 구현 전), 다품목(SKU 여러 개) 동시 시뮬레이션, 수입 원료 비중에 따른 원가 환율 연동, DB(RDBMS) 도입 |

---

## 2. 화면 레이아웃 및 서브 탭 UI 컴포넌트 구조

### 2.1 공통 규칙 (이 페이지 한정 재확인)

- 템플릿 `src/03_margin/margin.html`은 `{% extends "common/base.html" %}` 를 유지하고 `title` / `page_css` / `content` / `page_js` block만 사용합니다.
- **HTML `id`, 페이지 전용 CSS Class는 모두 `margin-` 접두사**를 붙입니다. 공통 Class(`.card`, `.btn`, `.table`, `.tabs`, `.badge`, `.alert`, `.modal` 등)는 **이름 그대로** 사용하고 `margin.css`에서 재정의하지 않습니다.
- `margin.css`에는 공통 컴포넌트에 없는 요소(차트 SVG, Tier Chip 목록, PI 미리보기 iframe 높이, 요약 바 배치 등)만 작성하며, 값은 `var(--…)` Token만 사용합니다. `font-weight`는 `var(--font-weight-regular | -bold | -extrabold)` 3종만 씁니다.
- Input / Select / Table / Tabs / 회색 Button(`.btn-secondary`)은 **반드시 흰색 `.card` 안**에 둡니다. 페이지 배경 위에는 `.card`, `.btn-surface`만 둡니다.
- Icon은 24×24 inline Line SVG(`stroke="currentColor"`, `stroke-width="2"`)만 사용합니다. Emoji 금지.
- 문체는 해요체("계산했어요", "입력해 주세요"), 증감 색상은 **상승 = 빨강(`--color-up`), 하락 = 파랑(`--color-down`)** 입니다.
- 모든 숫자 셀은 `.is-numeric`(표) 또는 `.text-number`(그 외)를 붙여 `tabular-nums`로 표시합니다.

### 2.2 전체 페이지 구조

```
.page-header
 ├─ .page-eyebrow   "원가 · 마진 시뮬레이션"
 ├─ h1.page-title   "원가 경쟁력 및 마진 시뮬레이션"
 ├─ .page-description "원가부터 수출 단가, 견적서 발행까지 한 번에 계산해요."
 └─ .page-actions   [초기화 .btn-surface #margin-reset-btn] [← 홈으로 .btn-surface]

section.section#margin-context-section
 └─ .card#margin-context-card                ← 서브 탭 + 파이프라인 요약 바 (항상 상단 고정 위치)
     └─ .card-body
         ├─ .tabs#margin-tabs[role=tablist]
         │    ├─ button.tab.is-active#margin-tab-btn-tier   data-tab-target="margin-panel-tier"    "1. 수량별 단가·마진"
         │    ├─ button.tab#margin-tab-btn-export           data-tab-target="margin-panel-export"  "2. 수출 조건·환율·역제안"  (disabled 초기)
         │    └─ button.tab#margin-tab-btn-pi               data-tab-target="margin-panel-pi"      "3. 견적서(PI)·협상 히스토리" (disabled 초기)
         └─ .grid.grid-auto-sm.mt-6#margin-summary-bar  ← 확정 조건 요약 .stat-tile × 6
              수량 / 공급단가(원) / 영업 마진율 / 인코텀즈 / 외화 단가 / 적용 환율

div.tab-panel.is-active#margin-panel-tier    ← Tab 1 (§2.3)
div.tab-panel#margin-panel-export            ← Tab 2 (§2.4)
div.tab-panel#margin-panel-pi                ← Tab 3 (§2.5)

Modal × 4 (§2.6)
```

> `.tab-panel`은 `common.js`가 `id`로 찾아 전환하므로 `.card` 밖(페이지 배경 위)에 둬도 동작합니다. 패널 안의 내용은 전부 `.card`로 감쌉니다.

**서브 탭 활성화 조건 (JS가 `disabled` 속성 토글)**

| 탭 | 활성화 조건 | 비활성 시 Tooltip(`title`) |
|---|---|---|
| Tab 1 | 항상 | — |
| Tab 2 | Tab 1 계산 성공 + Tier 1개 선택됨 | "먼저 수량 구간을 선택해 주세요" |
| Tab 3 | Tab 2 외화 단가 계산 성공 | "먼저 수출 조건을 계산해 주세요" |

**요약 바 (`#margin-summary-bar`)** — 각 타일은 아래 구조, 값이 없으면 `—` 표시

```html
<div class="stat-tile" id="margin-summary-qty">
  <span class="stat-tile__label">발주 수량</span>
  <span class="stat-tile__value">5,000ea</span>
</div>
```

| id | 라벨 | 값 출처 |
|---|---|---|
| `margin-summary-qty` | 발주 수량 | `state.selection.qty` |
| `margin-summary-krw-price` | 공급단가(EXW) | 선택 Tier `supply_price_krw` |
| `margin-summary-margin` | 영업 마진율 | 선택 Tier `margin_rate` (+ 상태 `.badge`) |
| `margin-summary-incoterm` | 인코텀즈 | `"CIF Los Angeles"` 형식 |
| `margin-summary-fx-price` | 외화 단가 | `"$1.876"` |
| `margin-summary-fx-rate` | 적용 환율 | `"1,380.00 KRW/USD"` + 출처 `.text-caption` |

### 2.3 Tab 1 — 수량별 공급 단가 및 마진 시뮬레이터 (`#margin-panel-tier`)

```
.grid.grid-2-1
 ├─ .card#margin-cost-card                      "기본 제조원가"
 │   ├─ .card-header  h3.card-title "기본 제조원가" / p.card-subtitle "MOQ 1,500ea 기준 개당 원가를 입력해 주세요"
 │   └─ .card-body.stack
 │       ├─ .grid.grid-2      제품명 #margin-product-name / 용량 #margin-product-volume (input-group, "ml")
 │       ├─ .grid.grid-2      제형 카테고리 select #margin-product-category / MOQ #margin-moq (input-group, "ea")
 │       ├─ .grid.grid-2      ① 벌크 #margin-cost-bulk / ② 용기 #margin-cost-container      (input-group, "원/ea")
 │       ├─ .grid.grid-2      ③ 단상자·라벨·설명서 #margin-cost-packaging / ④ 충진·포장·검수 #margin-cost-processing
 │       ├─ .grid.grid-2      1회 고정비 #margin-fixed-cost ("원/발주") / 원부자재 로스율 #margin-loss-rate ("%")
 │       └─ .grid.grid-3      .stat-tile × 3: MOQ 기준 재료비 합계 / 임가공비 / MOQ 기준 총 제조원가 (#margin-cost-preview-*)
 │
 └─ .card#margin-tier-setting-card              "목표 마진 · 수량 구간"
     └─ .card-body.stack
         ├─ 목표 마진율 #margin-target-margin (input-group, "%")
         ├─ 마진 방어선 #margin-min-margin (input-group, "%")  + .form-help "이 값 아래로 내려가면 경고해요"
         ├─ 수량 구간 목록 .multi-select#margin-tier-chips
         │     .multi-select__chip "1,500ea (MOQ)" (삭제 버튼 없음, 고정)
         │     .multi-select__chip "3,000ea" [×] …
         │     input.multi-select__input#margin-tier-input placeholder "수량 입력 후 Enter"
         ├─ p.form-error#margin-tier-error (MOQ 미만·중복·최대 개수 초과 시)
         └─ .row  프리셋 .btn.btn-secondary.btn-sm × 3: #margin-tier-preset-3000 / -5000 / -10000

.card#margin-tier-result-card.mt-6            "수량 구간별 공급단가 비교"
 ├─ .card-header  h3 / p.card-subtitle "목표 마진 30% · 10원 단위 올림"  +  .badge#margin-tier-status (계산 중/완료/오류)
 └─ .card-body
     ├─ .alert.alert-warning#margin-tier-alert (hidden 기본; 역마진·방어선 미달 행이 있을 때)
     └─ .table-wrap > table.table#margin-tier-table
          thead: 선택 | 수량(ea) | 적용 할인 | 총 제조원가(원/ea) | 제안 공급단가(원/ea) | 영업 마진액(원/ea) | 총 마진액(원) | 영업 마진율 | 상태 | (상세)
          tbody tr.margin-tier-row[data-qty]  (선택 행: tr.is-active)
            td: input[type=radio][name=margin-tier-select]
            td.is-numeric: 5,000
            td: "벌크 5% · 용기 8% …" (.text-caption)
            td.is-numeric: 1,727
            td.is-numeric: input.form-control.form-control-sm.margin-tier-price-input (기본값=제안가, 수정 시 수동 단가 모드)
            td.is-numeric: 743
            td.is-numeric: 3,716,550
            td.is-numeric: 30.09%
            td: .badge (§4.2.5 상태 뱃지)
            td: button.btn.btn-ghost.btn-sm.margin-tier-detail-btn "상세" → #margin-cost-breakdown-modal
     └─ Empty State(.state.state-empty) — 원가 미입력 시 "원가 4대 요소를 입력하면 수량별 단가를 계산해요"

.card#margin-tier-chart-card.mt-6              "단가 · 마진 추세"
 └─ .card-body
     ├─ .row#margin-tier-chart-legend  (범례: 총 제조원가 막대 / 제안 공급단가 선 / 마진율 라벨)
     └─ div#margin-tier-chart  ← margin.js가 inline SVG 생성 (차트 라이브러리·CDN 미사용)

.row.mt-6 (우측 정렬)
 └─ button.btn.btn-primary#margin-go-export-btn "이 수량으로 수출 조건 계산하기"  (Tier 미선택 시 disabled)
```

**차트 규격 (`#margin-tier-chart`, inline SVG)**

| 항목 | 규격 |
|---|---|
| X축 | Tier 수량(범주형, `1,500` `3,000` …) |
| Y축 | 원/ea, 0부터 시작, 눈금 4~5개, Grid line `--color-border` |
| 막대 | 총 제조원가 — `--color-primary-light` |
| 선 + 점 | 제안 공급단가 — `--color-primary-bright`, 선택 Tier 점은 반지름 크게 |
| 라벨 | 각 점 위에 마진율(%) — 상태가 역마진이면 `--color-danger`, 방어선 미달이면 `--color-warning`, 그 외 `--color-text-secondary` |
| 방어선 | 차트에 별도 축을 두지 않음(이중 축 금지). 방어선은 라벨 색상과 테이블 뱃지로만 표현 |
| 인터랙션 | 점/막대 Hover 시 `div.margin-chart-tooltip`(수량·원가·단가·마진액·마진율) 표시, 클릭 시 해당 Tier 선택 |
| 반응형 | `viewBox` 사용 + `width:100%`, 컨테이너 폭 변경 시(`ResizeObserver`) 다시 그림 |

### 2.4 Tab 2 — 수출 조건 및 환율/역제안 시뮬레이터 (`#margin-panel-export`)

```
.grid.grid-2
 ├─ .card#margin-logistics-card                  "포장 규격 · 물류"
 │   └─ .card-body.stack
 │       ├─ .grid.grid-3   카톤 가로 #margin-carton-length / 세로 #margin-carton-width / 높이 #margin-carton-height  ("cm")
 │       ├─ .grid.grid-3   카톤 입수량 #margin-carton-units ("ea") / 카톤 총중량 #margin-carton-gw ("kg") / 포장 여유율 #margin-carton-allowance ("%")
 │       ├─ .grid.grid-2   발주 수량 #margin-export-qty (Tab 1 선택값 자동, 읽기 전용 + "변경" 링크는 Tab 1로 이동)
 │       │                  운송 방식 select #margin-transport-mode (해상 LCL / 해상 FCL 20ft / 해상 FCL 40ft / 항공)
 │       ├─ .grid.grid-2   도착 권역 select #margin-dest-region / 지정 장소 #margin-named-place (예: "Los Angeles", 영문)
 │       ├─ 인코텀즈 .tabs#margin-incoterm-tabs (data-tab-target 없이 필터형, JS가 .is-active 토글)
 │       │     EXW | FCA | FOB | CFR | CIF | CPT | CIP | DAP
 │       ├─ 보험 조건 select #margin-insurance-clause (ICC(A) / ICC(C)) — CIF·CIP일 때만 표시
 │       └─ .alert.alert-info#margin-incoterm-help  (선택한 인코텀즈의 매도인 부담 범위 한 줄 설명, master 데이터)
 │
 └─ .card#margin-logistics-result-card           "CBM · 운임 계산 결과"
     └─ .card-body.stack
         ├─ .grid.grid-auto-sm  .stat-tile × 5: 카톤 수 / 총 CBM / 총 중량 / 운임 부과 기준(RT·kg) / 컨테이너 수(FCL만)
         ├─ .table-wrap > table.table#margin-logistics-table
         │     항목 | 부담 | 통화 | 금액 | 원화 환산 | 원/ea
         │     내륙운송 / 수출통관 / 선적지 부대비용(THC·CFS·DOC) / 해상·항공 운임 / 적하보험료 / 도착지 비용
         │     (부담 열: .badge-primary "매도인" / .badge "매수인" — 매수인 부담 행은 금액 회색·합계 제외)
         └─ .grid.grid-2  .stat-tile: 물류비 합계(원) / 인코텀즈 단가(원/ea)

.grid.grid-2.mt-6
 ├─ .card#margin-fx-card                          "환율 · 외화 공급단가"
 │   ├─ .card-header  h3 / span.section-meta#margin-fx-meta "한국수출입은행 · 2026-09-23 11:05 기준" + .badge#margin-fx-source-badge
 │   └─ .card-body.stack
 │       ├─ .grid.grid-2  통화 select #margin-currency / 환율 기준 .tabs#margin-fx-basis-tabs (매매기준율 | 전신환 매입률(TTB) | 직접 입력)
 │       ├─ 직접 입력 환율 #margin-fx-manual-rate (input-group, "KRW/USD") — "직접 입력"일 때만 표시
 │       ├─ .card.kpi-card 대신 Card 안이므로 .stat-tile 사용 금지 → .kpi-label / .kpi-value.kpi-value-lg.is-primary 텍스트만 배치
 │       │     "CIF Los Angeles 외화 단가" / "$1.876" / .kpi-delta "원화 2,588.67원/ea"
 │       ├─ .grid.grid-3  .stat-tile: 총 견적 금액(외화) / 수출 기준 마진율 / EXW 기준 마진율
 │       └─ button.btn.btn-ghost.btn-sm#margin-fx-refresh-btn "환율 새로고침"
 │
 └─ .card#margin-fx-stress-card                   "환율 변동 민감도"
     └─ .card-body.stack
         ├─ .table-wrap > table.table#margin-fx-stress-table
         │     원화 변동 | 적용 환율 | 원화 환산 단가 | 영업 마진액(원/ea) | 영업 마진율 | 상태
         │     -10% / -5% / 0%(기준, tr.is-active) / +5% / +10%
         └─ .grid.grid-2  .stat-tile: 손익분기 환율 #margin-fx-breakeven / 마진 방어선 환율 #margin-fx-defense
             + p.text-caption "환율이 이 값 아래로 내려가면 역마진(방어선 미달)이 돼요"

.card#margin-counter-card.mt-6                    "바이어 역제안 역산"
 ├─ .card-header  h3 / p.card-subtitle "바이어 희망 단가를 넣으면 현재 원가 구조로 마진을 계산해요"
 └─ .card-body
     ├─ .grid.grid-3  바이어 희망 단가 #margin-counter-price (input-group, 통화 suffix 자동) /
     │                기준 수량 #margin-counter-qty (기본: 선택 Tier) / button.btn.btn-primary#margin-counter-btn "역산하기"
     ├─ div#margin-counter-result (계산 전 hidden)
     │   ├─ .grid.grid-4  .stat-tile: EXW 기준 마진율(+판정 .badge) / 개당 마진액 / 목표 마진 단가 / 수용 최저가(방어선)
     │   ├─ .alert#margin-counter-verdict  (판정별 alert-success / -warning / -danger, §4.5.4)
     │   ├─ h4 "원가 절감 가이드" + table.table#margin-counter-reduction-table
     │   │     원가 요소 | 현재(원/ea) | 비중 | 절감 필요액(원/ea) | 절감 후(원/ea)
     │   └─ h4 "수량 증대 가이드" + p#margin-counter-qty-guide
     │         "10,000ea 이상 발주하면 목표 마진 30.80%를 확보해요" / "수량만으로는 목표 마진을 확보할 수 없어요"
     └─ .row.mt-6  button.btn.btn-soft#margin-counter-apply-btn "이 단가로 견적서 작성" (판정이 역마진이면 disabled)

.row.mt-6 (우측 정렬)
 └─ button.btn.btn-primary#margin-go-pi-btn "이 조건으로 견적서 작성하기"
```

> **주의**: `.stat-tile`은 Card 안 보조 패널이므로 Card 안에서만 씁니다. 대표 외화 단가는 `.kpi-label` / `.kpi-value.kpi-value-lg.is-primary` / `.kpi-delta` 텍스트 Class만 Card 본문에 배치합니다(`.kpi-card`를 Card 안에 중첩하지 않음).

### 2.5 Tab 3 — 견적서(PI) 발행 및 협상 히스토리 (`#margin-panel-pi`)

```
.grid.grid-2-1
 ├─ .card#margin-pi-form-card                     "견적서 정보"
 │   └─ .card-body.stack
 │       ├─ h4 "견적 기본"  .grid.grid-3: PI 번호 #margin-pi-no(자동, 수정 가능) / 발행일 #margin-pi-date / 유효기간 #margin-pi-validity (date, 기본 +30일)
 │       ├─ h4 "바이어"     .grid.grid-2: 회사명* #margin-buyer-company / 국가* #margin-buyer-country / 주소 #margin-buyer-address(textarea rows=2)
 │       │                              담당자 #margin-buyer-contact / 이메일 #margin-buyer-email
 │       ├─ h4 "결제 · 선적" .grid.grid-2: 결제 조건 select #margin-payment-terms / 선적항 #margin-port-loading
 │       │                              도착항 #margin-port-discharge / 생산 리드타임 #margin-lead-time ("days")
 │       │                              예상 선적일 #margin-shipment-date / HS Code #margin-hs-code (기본 "3304.99")
 │       ├─ h4 "매도인 · 은행" .grid.grid-2: 회사명 #margin-seller-company / 주소 #margin-seller-address / 담당자 #margin-seller-contact
 │       │                              은행명 #margin-bank-name / SWIFT #margin-bank-swift / 계좌번호 #margin-bank-account / 예금주 #margin-bank-beneficiary
 │       │                              + .form-check#margin-seller-remember "이 브라우저에 매도인 정보 저장"
 │       ├─ h4 "추가 품목"  table.table#margin-pi-extra-table (품목·수량·단가·금액) + button.btn.btn-secondary.btn-sm#margin-pi-extra-add "품목 추가"
 │       └─ 비고 #margin-pi-remarks (textarea, 영문)
 │
 └─ .card#margin-pi-bound-card                    "시뮬레이션 연동 값"
     └─ .card-body.stack
         ├─ .alert.alert-warning#margin-pi-stale-alert (hidden 기본) "Tab 1·2 값이 바뀌었어요" + button.btn.btn-soft.btn-sm#margin-pi-rebind-btn "다시 불러오기"
         ├─ .stat-tile × 7 (읽기 전용): 제품명 / 수량 / 단가(외화) / 통화 / 인코텀즈 + 지정 장소 / 총액 / 영업 마진율(내부용 — PI에는 출력 안 됨)
         ├─ .badge#margin-pi-counter-badge "역제안 단가 적용" (역제안 반영 시에만)
         └─ .stack  button.btn.btn-primary.btn-block#margin-pi-pdf-btn "PDF 다운로드"
                    button.btn.btn-secondary.btn-block#margin-pi-print-btn "인쇄"
                    button.btn.btn-soft.btn-block#margin-history-save-open-btn data-modal-open="margin-history-save-modal" "협상 버전 저장"

.card#margin-pi-preview-card.mt-6                 "PI 미리보기"
 ├─ .card-header  h3 / button.btn.btn-secondary.btn-sm#margin-pi-preview-btn "미리보기 새로고침"
 └─ .card-body  iframe#margin-pi-preview-frame (srcdoc, sandbox="allow-same-origin allow-modals", title="Proforma Invoice 미리보기")

.card#margin-history-card.mt-6                    "협상 히스토리"
 ├─ .card-header  h3 / .row: select.form-control.form-control-sm#margin-history-deal-select (협상 건) + button.btn.btn-secondary.btn-sm#margin-history-compare-btn "선택 버전 비교" (2개 체크 시 활성)
 └─ .card-body
     └─ .table-wrap > table.table#margin-history-table
          비교(checkbox) | 버전 | 저장 일시 | 수량 | 단가 | 인코텀즈 | 영업 마진율 | 상태 | 메모 | (불러오기 .btn.btn-ghost.btn-sm)
        Empty State: "아직 저장된 협상 버전이 없어요"
```

### 2.6 Modal

| id | 크기 | 용도 | 주요 내용 |
|---|---|---|---|
| `margin-cost-breakdown-modal` | 기본 | Tier 행 원가 구성 상세 | 4대 요소별 기준 단가 → 할인율 → 로스 반영 → 원/ea, 고정비 분산액, 합계 |
| `margin-history-save-modal` | 기본 | 협상 버전 저장 | 버전 구분 `.tabs`(새 차수 v2.0 / 수정본 v1.1), 상태 select(draft/sent/countered/accepted/rejected), 메모 textarea, [취소][저장] |
| `margin-history-compare-modal` | `.modal-lg` | 버전 간 변경 비교(Track Changes) | table.table#margin-history-diff-table: 항목 / vA / vB / 변동(▲▼ + 절대·% 차이), 바뀐 행만 보기 `.form-check` |
| `margin-confirm-modal` | 기본 | 초기화·버전 불러오기 확인 | "현재 입력값이 사라져요. 계속할까요?" [취소][확인] |

모든 Modal은 `ui_components.md §16` 구조(`.modal-backdrop > .modal > .modal-header/.modal-body/.modal-footer`)를 그대로 사용하고 `Common.openModal(id)` / `Common.closeModal(id)`로 제어합니다. `window.confirm()`은 사용하지 않습니다.

### 2.7 `margin.css`에 작성 가능한 Class (허용 목록)

| Class | 용도 |
|---|---|
| `.margin-summary-bar` (id와 별개로 레이아웃 보정 필요 시) | 요약 바 타일 간격 |
| `.margin-tier-row` / `.margin-tier-price-input` | Tier 행 내 단가 Input 폭(예: `max-width: 140px`), 수동 단가 행 표시 |
| `.margin-tier-price-input.is-overridden` | 수동 수정된 단가 Input 강조(`--color-primary-soft` 배경) |
| `.margin-chart` / `.margin-chart__bar` / `.margin-chart__line` / `.margin-chart__point` / `.margin-chart__label` / `.margin-chart__grid` | 차트 SVG 요소 색(`fill`/`stroke`는 Token) |
| `.margin-chart-tooltip` | Hover Tooltip(흰 배경 `--shadow-overlay`, `--radius-sm`) |
| `.margin-pi-frame` | PI 미리보기 iframe 높이(`min-height: 960px`), 배경 `--color-surface-muted` |
| `.margin-row-muted` | 매수인 부담 등 계산 제외 행 텍스트를 `--color-text-placeholder` |
| `.margin-diff-up` / `.margin-diff-down` | 비교 Modal 변동 셀 — `--color-up` / `--color-down` |

---

## 3. 데이터 요구사항 및 스키마

### 3.1 사용자 입력 데이터

모든 금액 입력은 **숫자만** 받습니다(천 단위 콤마는 표시용, 전송 시 제거). 범위를 벗어나면 `.form-control.is-error` + `.form-error` 표시 후 계산 요청을 보내지 않습니다.

#### 3.1.1 제품 기본 정보 (Tab 1)

| 필드(JSON key) | 화면 id | 타입 | 필수 | 기본값 | 검증 |
|---|---|---|---|---|---|
| `product.name` | `margin-product-name` | string | ○ | `""` | 1~80자. PI 출력용이므로 **영문·숫자·기본 기호만**(§7.5) |
| `product.volume_ml` | `margin-product-volume` | number | – | `50` | 0 < x ≤ 5,000 |
| `product.category` | `margin-product-category` | enum | – | `"skincare"` | `skincare` `makeup` `haircare` `bodycare` `suncare` `etc` |

#### 3.1.2 원가 4대 요소 및 원가 보조 입력 (Tab 1)

| 필드 | 화면 id | 단위 | 필수 | 기본값 | 검증 | 설명 |
|---|---|---|---|---|---|---|
| `cost.bulk` | `margin-cost-bulk` | 원/ea | ○ | – | 0 ≤ x ≤ 1,000,000 | ① 벌크(내용물 원료비) — MOQ 기준 단가 |
| `cost.container` | `margin-cost-container` | 원/ea | ○ | – | 0 ≤ x ≤ 1,000,000 | ② 용기(부자재비) |
| `cost.packaging` | `margin-cost-packaging` | 원/ea | ○ | – | 0 ≤ x ≤ 1,000,000 | ③ 단상자·라벨·설명서(포장재비) |
| `cost.processing` | `margin-cost-processing` | 원/ea | ○ | – | 0 ≤ x ≤ 1,000,000 | ④ 충진·포장·검수(임가공비) |
| `cost.fixed_per_order` | `margin-fixed-cost` | 원/발주 | – | `600000` | 0 ≤ x ≤ 1,000,000,000 | 인쇄 동판·라인 셋업·QC 시험비 등 발주 1회당 고정비(수량에 분산) |
| `cost.loss_rate` | `margin-loss-rate` | % | – | `2` | 0 ≤ x ≤ 30 | 원부자재(①②③) 로스율. 임가공비에는 미적용 |
| `moq` | `margin-moq` | ea | ○ | `1500` | 정수, **≥ 1,500** (§7.1) | 최소 발주 수량 |

> 4대 요소 합계가 0이면 계산하지 않습니다(§7.2).

#### 3.1.3 마진·수량 구간 (Tab 1)

| 필드 | 화면 id | 단위 | 기본값 | 검증 |
|---|---|---|---|---|
| `target_margin` | `margin-target-margin` | % | `30` | 0 ≤ x ≤ 80 (소수 1자리) |
| `min_margin` | `margin-min-margin` | % | `15` | 0 ≤ x ≤ `target_margin` |
| `tiers` | `margin-tier-chips` | ea[] | `[3000, 5000, 10000]` | 정수, 각 값 ≥ `moq`, ≤ 1,000,000, 중복 제거, 오름차순, **MOQ 행 포함 최대 8개** |
| `price_overrides` | `.margin-tier-price-input` | `{qty: 원/ea}` | `{}` | x > 0, 10원 단위 아니어도 허용(그대로 사용) |
| `selected_qty` | radio `margin-tier-select` | ea | 계산 후 첫 사용자 Tier(없으면 MOQ) | `tiers ∪ {moq}` 중 하나 |

#### 3.1.4 포장·물류 (Tab 2)

| 필드 | 화면 id | 단위 | 기본값 | 검증 |
|---|---|---|---|---|
| `carton.length_cm` / `width_cm` / `height_cm` | `margin-carton-length/-width/-height` | cm | `40` / `30` / `25` | 0 < x ≤ 200 |
| `carton.units_per_carton` | `margin-carton-units` | ea | `60` | 정수 1 ≤ x ≤ 10,000 |
| `carton.gross_weight_kg` | `margin-carton-gw` | kg | `12` | 0 < x ≤ 100 (25 초과 시 경고) |
| `carton.allowance_rate` | `margin-carton-allowance` | % | master `CARTON_ALLOWANCE_DEFAULT`(5) | 0 ≤ x ≤ 50 |
| `qty` | `margin-export-qty` | ea | Tab 1 `selected_qty` | ≥ `moq` |
| `transport_mode` | `margin-transport-mode` | enum | `SEA_LCL` | `SEA_LCL` `SEA_FCL20` `SEA_FCL40` `AIR` |
| `dest_region` | `margin-dest-region` | enum | `US_WEST` | master `REGIONS` 키 |
| `named_place` | `margin-named-place` | string | 권역 기본 항구명 | 1~60자, 영문 |
| `incoterm` | `margin-incoterm-tabs` | enum | `FOB` | master `INCOTERMS` 키 |
| `insurance_clause` | `margin-insurance-clause` | enum | CIF→`ICC_C`, CIP→`ICC_A` | `ICC_A` `ICC_C` |

#### 3.1.5 환율 (Tab 2)

| 필드 | 화면 id | 기본값 | 검증 |
|---|---|---|---|
| `currency` | `margin-currency` | `USD` | master `CURRENCIES` 키 |
| `fx_basis` | `margin-fx-basis-tabs` | `base`(매매기준율) | `base` `ttb` `manual` |
| `fx_manual_rate` | `margin-fx-manual-rate` | – | `manual`일 때 필수, 0 < x ≤ 100,000 (KRW per 1 단위 통화) |
| `stress_steps` | (고정) | `[-10, -5, 0, 5, 10]` | 서버 상수. 요청에 넣으면 −30~+30 범위 정수 최대 9개까지 허용 |

#### 3.1.6 바이어 역제안 (Tab 2)

| 필드 | 화면 id | 단위 | 검증 |
|---|---|---|---|
| `counter.price` | `margin-counter-price` | 선택 통화/ea (현재 인코텀즈 기준) | 0 < x ≤ 100,000, 소수 4자리까지 |
| `counter.qty` | `margin-counter-qty` | ea | ≥ `moq`, 기본 `selected_qty` |

#### 3.1.7 PI 기본 정보 (Tab 3)

| 필드 | 필수 | 기본값 | 검증 |
|---|---|---|---|
| `pi.pi_no` | ○ | `COSMOA-PI-{YYYYMMDD}-{deal 순번 3자리}` | 1~40자, `[A-Za-z0-9\-_/]` |
| `pi.issue_date` | ○ | 오늘(KST) | ISO date |
| `pi.validity_date` | ○ | 발행일 + master `PI_VALIDITY_DAYS_DEFAULT`(30) | ≥ 발행일 |
| `pi.buyer.company` / `country` | ○ | – | 영문 1~120자 |
| `pi.buyer.address` / `contact` / `email` | – | – | 영문, email 형식 |
| `pi.payment_terms` | ○ | `TT_30_70` | master `PAYMENT_TERMS` 키 |
| `pi.port_loading` | ○ | 운송 방식에 따라 `Busan, Korea` / `Incheon Airport, Korea` | 영문 |
| `pi.port_discharge` | ○ | `named_place` | 영문 |
| `pi.lead_time_days` | – | `45` | 1 ≤ x ≤ 365 |
| `pi.shipment_date` | – | 발행일 + 리드타임 | ≥ 발행일 |
| `pi.hs_code` | – | `3304.99` | `^\d{4}(\.\d{2}(\d{2,4})?)?$` |
| `pi.seller.*` / `pi.bank.*` | ○(회사명·은행명·SWIFT·계좌·예금주) | `localStorage` 저장값 | 영문, SWIFT `^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$` |
| `pi.extra_items[]` | – | `[]` | 최대 10개, `{description, qty, unit_price}` (FOC 샘플은 단가 0 허용) |
| `pi.remarks` | – | `""` | 영문 ≤ 1,000자 |

### 3.2 시스템 참조·기준 데이터 (Master Data)

**위치**: `src/03_margin/service.py` 상단 상수(대문자). DB·외부 파일 없이 코드 상수로 관리하고 `GET /api/margin-calculator/master`로 프론트에 전달합니다. 프론트는 이 값을 **하드코딩하지 않습니다**.

> **모든 수치는 모의 기준값(2026-09 가정)입니다.** 실제 영업 사용 전 포워더·보험사·협력사 견적으로 교체합니다.

#### 3.2.1 페이지 기본값

```python
MARGIN_MOQ = 1500                       # 최소 발주 수량(ea)
MARGIN_MAX_TIERS = 8                    # MOQ 행 포함
MARGIN_MAX_QTY = 1_000_000
DEFAULT_TIERS = [3000, 5000, 10000]
DEFAULT_TARGET_MARGIN = Decimal("30")   # %
DEFAULT_MIN_MARGIN = Decimal("15")      # %  (마진 방어선)
DEFAULT_FIXED_COST = Decimal("600000")  # 원/발주
DEFAULT_LOSS_RATE = Decimal("2")        # %
KRW_PRICE_ROUND_UNIT = Decimal("10")    # 원화 공급단가 올림 단위
CARTON_ALLOWANCE_DEFAULT = Decimal("5") # %
AIR_VOLUMETRIC_DIVISOR = Decimal("6000")# cm³/kg
PI_VALIDITY_DAYS_DEFAULT = 30
STRESS_STEPS = [-10, -5, 0, 5, 10]      # %
COUNTER_QTY_SEARCH_MAX = 200_000
COUNTER_QTY_SEARCH_STEP = 500
```

#### 3.2.2 수량 구간 할인율 테이블 (규모의 경제)

`VOLUME_DISCOUNTS` — **계단식**: 발주 수량 `q` 이하인 가장 큰 기준 수량의 할인율을 적용합니다(구간 내 선형 보간 없음).

| 기준 수량(≥) | ① 벌크 | ② 용기 | ③ 포장재 | ④ 임가공 |
|---:|---:|---:|---:|---:|
| 1,500 | 0% | 0% | 0% | 0% |
| 3,000 | 3% | 5% | 5% | 8% |
| 5,000 | 5% | 8% | 8% | 12% |
| 10,000 | 8% | 12% | 12% | 18% |
| 20,000 | 10% | 15% | 15% | 22% |
| 50,000 | 12% | 18% | 18% | 25% |

```python
VOLUME_DISCOUNTS = [  # (min_qty, {component: rate%})
    (1500,  {"bulk": 0,  "container": 0,  "packaging": 0,  "processing": 0}),
    (3000,  {"bulk": 3,  "container": 5,  "packaging": 5,  "processing": 8}),
    (5000,  {"bulk": 5,  "container": 8,  "packaging": 8,  "processing": 12}),
    (10000, {"bulk": 8,  "container": 12, "packaging": 12, "processing": 18}),
    (20000, {"bulk": 10, "container": 15, "packaging": 15, "processing": 22}),
    (50000, {"bulk": 12, "container": 18, "packaging": 18, "processing": 25}),
]
```

#### 3.2.3 Incoterms 2020 조건별 매도인 부담 범위

`INCOTERMS` — `True`인 비용만 매도인(우리) 견적가에 포함합니다.

| 코드 | 운송 | 내륙운송 | 수출통관 | 선적지 부대비용 | 주운임 | 적하보험 | 도착지 비용 | 설명(`help`) |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|---|
| `EXW` | 전체 | – | – | – | – | – | – | 공장 인도. 모든 운송비를 바이어가 부담해요 |
| `FCA` | 전체 | ○ | ○ | – | – | – | – | 지정 장소에서 운송인에게 인도해요 |
| `FOB` | 해상 전용 | ○ | ○ | ○ | – | – | – | 선적항 본선 적재까지 부담해요 |
| `CFR` | 해상 전용 | ○ | ○ | ○ | ○ | – | – | 해상 운임까지 부담해요 |
| `CIF` | 해상 전용 | ○ | ○ | ○ | ○ | ○(ICC(C) 이상) | – | 운임과 적하보험까지 부담해요 |
| `CPT` | 전체 | ○ | ○ | ○ | ○ | – | – | 목적지까지 운송비를 부담해요 |
| `CIP` | 전체 | ○ | ○ | ○ | ○ | ○(ICC(A)) | – | 운송비와 적하보험(ICC(A))을 부담해요 |
| `DAP` | 전체 | ○ | ○ | ○ | ○ | – | ○ | 목적지 도착 인도. 관세·부가세는 바이어가 부담해요 |

```python
INCOTERMS = {
  "FOB": {"sea_only": True, "air_equivalent": "FCA",
          "seller_pays": {"inland": True, "export_customs": True, "origin_local": True,
                          "main_freight": False, "insurance": False, "dest_charges": False},
          "min_insurance_clause": None, "help": "선적항 본선 적재까지 부담해요"},
  # … 나머지 조건 동일 구조. 해상 전용 조건의 항공 대응: FOB→FCA, CFR→CPT, CIF→CIP
}
```

> DDP는 관세·부가세 계산이 필요해 **[범위 외]** 입니다. 선택지에 노출하지 않습니다.

#### 3.2.4 물류 요율 (모의 기준값)

**원화 부대비용** `LOCAL_CHARGES_KRW`

| 항목 | 해상 LCL | 해상 FCL 20ft | 해상 FCL 40ft | 항공 |
|---|---|---|---|---|
| 내륙운송(`inland`) | 100,000원 + 15,000원/CBM | 350,000원/컨테이너 | 450,000원/컨테이너 | 80,000원 + 300원/kg(C.W.) |
| 수출통관(`export_customs`) | 30,000원/건 | 30,000원/건 | 30,000원/건 | 30,000원/건 |
| 선적지 부대비용(`origin_local`, THC·CFS·DOC) | 25,000원/RT + 40,000원 | 180,000원/컨테이너 + 40,000원 | 250,000원/컨테이너 + 40,000원 | 150원/kg(C.W.) + 40,000원 |

**주운임(USD)** `MAIN_FREIGHT_USD` — LCL은 RT당(최소 1RT), FCL은 컨테이너당, 항공은 C.W. kg당(유류할증 포함, 최소 $80)

| 권역 코드 | 표시명 | 기본 지정 장소 | LCL /RT | FCL20 /cntr | FCL40 /cntr | AIR /kg |
|---|---|---|---:|---:|---:|---:|
| `US_WEST` | 미국 서부 | Los Angeles, USA | 85 | 2,400 | 3,800 | 4.2 |
| `US_EAST` | 미국 동부 | New York, USA | 110 | 3,600 | 5,600 | 4.8 |
| `EU` | 유럽 | Rotterdam, Netherlands | 95 | 2,800 | 4,400 | 4.5 |
| `JP` | 일본 | Tokyo, Japan | 45 | 700 | 1,100 | 2.2 |
| `CN` | 중국 | Shanghai, China | 40 | 500 | 800 | 2.0 |
| `SEA` | 동남아 | Ho Chi Minh, Vietnam | 50 | 650 | 1,050 | 2.4 |
| `ME` | 중동 | Dubai, UAE | 90 | 1,900 | 3,000 | 3.6 |
| `OCEANIA` | 오세아니아 | Sydney, Australia | 95 | 1,600 | 2,600 | 4.0 |

**도착지 비용(USD, DAP 전용)** `DEST_CHARGES_USD`: LCL $45/RT + $120 · FCL $450/cntr · AIR $0.6/kg + $80 (권역 공통)

**컨테이너 적재 한도** `CONTAINER_SPECS`: 20ft `28 CBM / 21,000kg`, 40ft `58 CBM / 26,000kg`

**적하보험 요율** `INSURANCE_RATES`: `ICC_A` 0.10%, `ICC_C` 0.05% · 부보 금액 = CIF(CIP) 가액 × **110%** (`INSURANCE_COVERAGE = 1.1`)

#### 3.2.5 통화 목록 `CURRENCIES`

| 코드 | 이름 | 기호 | 수출입은행 `cur_unit` | 단가 소수 자리 | 금액 소수 자리 | 모의 기준 환율(KRW) |
|---|---|---|---|:-:|:-:|---:|
| `USD` | US Dollar | `$` | `USD` | 3 | 2 | 1,380.00 |
| `EUR` | Euro | `€` | `EUR` | 3 | 2 | 1,510.00 |
| `JPY` | Japanese Yen | `¥` | `JPY(100)` | 1 | 0 | 9.40 (1엔 기준, 100엔=940.00) |
| `CNY` | Chinese Yuan | `¥` | `CNH` | 3 | 2 | 191.00 |
| `GBP` | British Pound | `£` | `GBP` | 3 | 2 | 1,800.00 |
| `HKD` | Hong Kong Dollar | `HK$` | `HKD` | 3 | 2 | 177.00 |
| `SGD` | Singapore Dollar | `S$` | `SGD` | 3 | 2 | 1,060.00 |
| `AUD` | Australian Dollar | `A$` | `AUD` | 3 | 2 | 900.00 |
| `CAD` | Canadian Dollar | `C$` | `CAD` | 3 | 2 | 1,010.00 |
| `THB` | Thai Baht | `฿` | `THB` | 2 | 2 | 41.50 |

- 내부 환율은 항상 **"1 통화 단위당 KRW"** 로 정규화합니다(JPY는 `JPY(100)` 값을 100으로 나눔).
- 모의 기준 환율(`FALLBACK_FX_KRW`)은 모든 외부 소스 실패 시 마지막 Fallback으로만 사용합니다.

#### 3.2.6 결제 조건 `PAYMENT_TERMS`

| 코드 | 화면 표시 | PI 출력 문구 | 선금 비율 |
|---|---|---|---:|
| `TT_30_70` | T/T 30% 선금 / 70% 선적 전 | `T/T 30% deposit with order, 70% balance before shipment` | 30 |
| `TT_30_70_BL` | T/T 30% 선금 / 70% B/L 사본 수령 후 | `T/T 30% deposit with order, 70% balance against copy of B/L` | 30 |
| `TT_50_50` | T/T 50% / 50% | `T/T 50% deposit with order, 50% balance before shipment` | 50 |
| `TT_100` | T/T 100% 선불 | `T/T 100% in advance` | 100 |
| `LC_SIGHT` | 일람불 L/C | `Irrevocable L/C at sight` | 0 |

#### 3.2.7 PI 표준 약관 `PI_STANDARD_TERMS` (영문, 템플릿에 순서대로 출력)

1. `Validity: This quotation is valid until {validity_date}.`
2. `Lead time: {lead_time_days} days after receipt of deposit and final artwork approval.`
3. `Quantity tolerance: ±10% of the ordered quantity may be shipped and invoiced accordingly.`
4. `Minimum order quantity: {moq} pcs per SKU.`
5. `Bank charges: All bank charges outside Korea are for the buyer's account.`
6. `Shelf life: 36 months from the date of manufacture (unopened).`
7. `Prices are quoted {incoterm} {named_place} (Incoterms® 2020) in {currency}.`

### 3.3 외부 실시간·연동 데이터

| 데이터 | 1순위 소스 | 2순위 소스 | 3·4순위 | 갱신 주기 |
|---|---|---|---|---|
| 원화 환율(매매기준율, TTB, TTS) | 한국수출입은행 현재환율 API | open.er-api.com (무료, Key 없음, 기준율만) | 파일 캐시 → 모의 기준 환율 | 메모리 캐시 TTL 60분(`MARGIN_FX_CACHE_TTL_MIN`) |

상세 연동 규격과 실패 대응은 §6.3에 정의합니다.

### 3.4 저장 데이터 스키마

#### 3.4.1 저장 위치 정책

| 파일 | 위치 | 이유 |
|---|---|---|
| 협상 히스토리 | `instance/margin/history.json` | `instance/`는 `.gitignore` 대상. **`src/` 아래에 두면 `/assets/…json`으로 외부에 노출**되므로 금지 |
| 환율 파일 캐시 | `instance/margin/fx_cache.json` | 서버 재시작 후에도 마지막 성공 환율 유지 |
| 매도인·은행 기본값 | 브라우저 `localStorage["cosmoa.margin.seller"]` | 사용자가 체크했을 때만 저장. 서버·Git에 계좌 정보를 남기지 않음 |
| 입력 초안 | 브라우저 `localStorage["cosmoa.margin.draft"]` | [권장] 새로고침 복원용 |

`instance/margin/` 폴더는 `service.py`가 최초 쓰기 시 `os.makedirs(..., exist_ok=True)`로 생성합니다.

#### 3.4.2 `history.json`

```json
{
  "schema_version": 1,
  "deals": {
    "D20260923-001": {
      "deal_id": "D20260923-001",
      "title": "ACME Beauty / Hydra Essence 50ml",
      "buyer_company": "ACME Beauty Inc.",
      "product_name": "Hydra Essence 50ml",
      "created_at": "2026-09-23T10:12:00+09:00",
      "updated_at": "2026-09-24T15:40:00+09:00",
      "versions": [
        {
          "version": "1.0",
          "saved_at": "2026-09-23T10:12:00+09:00",
          "status": "sent",
          "memo": "1차 견적. 바이어 $1.50 희망",
          "summary": {
            "qty": 5000, "currency": "USD", "unit_price": 1.876,
            "unit_price_krw": 2588.67, "total_amount": 9380.0,
            "incoterm": "CIF", "named_place": "Los Angeles, USA",
            "fx_rate": 1380.0, "fx_source": "koreaexim",
            "unit_cost_krw": 1726.69, "margin_rate_exw": 30.10, "margin_rate_export": 28.72,
            "payment_terms": "TT_30_70", "validity_date": "2026-10-23",
            "counter_applied": false
          },
          "snapshot": { "tier_request": {}, "logistics_request": {}, "fx_request": {}, "pi": {} }
        }
      ]
    }
  }
}
```

- `snapshot`은 각 API **요청 body 원본**(재계산 가능한 입력)을 그대로 저장합니다. 불러오기 시 이 값으로 화면을 복원하고 API를 다시 호출합니다.
- `summary`는 목록·비교용 결과값입니다(저장 시점 값 고정, 재계산하지 않음).
- `version` 규칙: 새 차수(`major`) → 마지막 major + 1 → `"2.0"`, 수정본(`minor`) → 같은 major의 마지막 minor + 1 → `"1.1"`.

---

## 4. 수식 및 비즈니스 로직

### 4.0 공통 계산 규칙

- 서버 계산은 **`decimal.Decimal`** 로만 합니다. `float` 연산 금지. 요청 JSON 숫자는 `Decimal(str(value))`로 변환합니다.
- 반올림 규칙
  | 대상 | 규칙 |
  |---|---|
  | 원화 공급단가(제안가) | `KRW_PRICE_ROUND_UNIT`(10원) 단위 **올림**(`ROUND_CEILING`) — 반올림으로 목표 마진이 깎이는 것을 방지 |
  | 외화 단가 | 통화별 단가 소수 자리로 **올림** |
  | 외화 금액(단가 × 수량) | 통화별 금액 소수 자리로 **반올림**(`ROUND_HALF_UP`) |
  | 원가·마진액(원) | 내부는 무한 정밀도, 응답은 소수 2자리 반올림, 화면은 정수(원) 표시 |
  | 비율(%) | 응답 소수 2자리 반올림, 화면 소수 1~2자리 |
- **마진율 정의**: 이 페이지의 모든 "마진율"은 **판매가 대비 이익률(Gross Margin on Price)** 입니다. `마진율 = (가격 − 원가) / 가격`. 원가 대비 이익률(Markup)은 쓰지 않습니다.

### 4.1 기호 정의

| 기호 | 의미 |
|---|---|
| `b, c, p, l` | MOQ 기준 벌크 / 용기 / 포장재 / 임가공 단가(원/ea) |
| `F` | 1회 고정비(원/발주) |
| `λ` | 로스율(소수, 2% → 0.02) |
| `d_k(q)` | 수량 `q`에서 요소 `k`의 할인율(소수) |
| `m`, `m_min` | 목표 마진율, 방어선 마진율(소수) |
| `C(q)` | 수량 `q`의 총 제조원가(원/ea) |
| `P(q)` | EXW 원화 공급단가(원/ea) |
| `R` | 적용 환율(KRW / 1 통화 단위) |
| `K` | 원화 표시 물류비 합계(내륙·통관·선적지) — 선적 1건 |
| `Y` | 외화 표시 물류비의 원화 환산 합계(주운임·도착지 비용) — 선적 1건 |
| `I` | 적하보험료(원) — 선적 1건 |

### 4.2 [Tab 1] 원가 및 수량 구간 단가

#### 4.2.1 할인율 조회

```
d_k(q) = VOLUME_DISCOUNTS에서 min_qty ≤ q 인 행 중 min_qty가 가장 큰 행의 rate_k / 100
```

#### 4.2.2 총 제조원가

```
재료비     M(q) = [ b·(1−d_bulk) + c·(1−d_container) + p·(1−d_packaging) ] × (1 + λ)
임가공비   L(q) = l · (1 − d_processing)
고정비분산 f(q) = F / q
총 제조원가 C(q) = M(q) + L(q) + f(q)
```

#### 4.2.3 제안 공급단가 및 마진

```
P_raw(q) = C(q) / (1 − m)
P(q)     = ceil(P_raw / 10) × 10              ← price_overrides[q]가 있으면 그 값을 그대로 사용
영업 마진액(원/ea)  G(q) = P(q) − C(q)
총 마진액(원)       G_total(q) = G(q) × q
영업 마진율         g(q) = G(q) / P(q)
총 매출(원)         S(q) = P(q) × q
```

#### 4.2.4 규모의 경제 지표 (테이블 보조 표기)

```
MOQ 대비 원가 절감률  = (C(moq) − C(q)) / C(moq)
MOQ 대비 단가 인하율  = (P(moq) − P(q)) / P(moq)
```

#### 4.2.5 마진 상태 판정 (공통 함수 `classify_margin`, Tab 1·2·3 모두 사용)

| 조건 | status | 뱃지 | 문구 |
|---|---|---|---|
| `g < 0` | `negative` | `.badge.badge-danger` | 역마진 |
| `0 ≤ g < m_min` | `below_defense` | `.badge.badge-warning` | 방어선 미달 |
| `m_min ≤ g < m − 0.0005` | `below_target` | `.badge.badge-info` | 목표 미달 |
| `g ≥ m − 0.0005` | `ok` | `.badge.badge-success` | 목표 달성 |

(0.0005 = 0.05%p 허용 오차, 올림 처리로 인한 경계 흔들림 방지)

### 4.3 [Tab 2] CBM · 물류비 · 인코텀즈 가격

#### 4.3.1 CBM 및 중량

```
카톤 수            N   = ceil(q / units_per_carton)
카톤당 CBM         v   = (L × W × H) / 1,000,000            (cm³ → m³)
총 CBM(순수)       V₀  = N × v
총 CBM(여유율)     V   = V₀ × (1 + allowance)
총 중량(kg)        G   = N × gross_weight_kg
운임 톤(RT, 해상 LCL) RT = max(V, G / 1000)
항공 부피중량(kg)  VW  = N × (L × W × H) / 6000 × (1 + allowance)
항공 청구중량(kg)  CW  = max(G, VW)
컨테이너 수(FCL)   n   = max( ceil(V / cbm_limit), ceil(G / kg_limit) )
적재율(FCL)        u   = V / (n × cbm_limit)
```

#### 4.3.2 운송 방식별 비용 (선적 1건 합계)

| 항목 | SEA_LCL | SEA_FCL20 / 40 | AIR |
|---|---|---|---|
| 내륙운송 `inland`(원) | `100,000 + 15,000 × V` | `단가 × n` | `80,000 + 300 × CW` |
| 수출통관 `export_customs`(원) | `30,000` | `30,000` | `30,000` |
| 선적지 부대 `origin_local`(원) | `25,000 × RT + 40,000` | `단가 × n + 40,000` | `150 × CW + 40,000` |
| 주운임 `main_freight`(USD) | `max(rate × RT, rate × 1)` | `rate × n` | `max(rate × CW, 80)` |
| 도착지 `dest_charges`(USD) | `45 × RT + 120` | `450 × n` | `0.6 × CW + 80` |

- USD 비용의 원화 환산은 **항상 USD 환율 `R_USD`** 를 씁니다(견적 통화가 EUR이어도 운임은 USD 기준).
- 인코텀즈의 `seller_pays` 가 `False`인 항목은 계산은 하되 합계에서 제외하고 `borne_by: "buyer"`로 응답합니다(화면 회색 행).

```
K = Σ(원화 항목 중 매도인 부담)
Y = Σ(USD 항목 중 매도인 부담) × R_USD
```

#### 4.3.3 적하보험료 (CIF / CIP)

부보 금액이 보험료를 포함한 CIF 가액의 110%이므로 **순환 참조를 대수적으로 풀어** 계산합니다.

```
CFR 가액(원)  B = P(q) × q + K + Y
보험요율      r = INSURANCE_RATES[clause]
CIF 가액(원)  V_cif = B / (1 − 1.1 × r)
보험료(원)    I = V_cif − B            (= V_cif × 1.1 × r)
```

`1 − 1.1 × r ≤ 0` 이 되는 요율은 master 검증에서 차단합니다(현실적으로 r < 5%).

#### 4.3.4 인코텀즈 원화 단가 → 외화 단가

```
물류비 단가(원/ea)     k_u = K / q,  y_u = Y / q,  i_u = I / q
인코텀즈 원화 단가     P_inc_krw = P(q) + k_u + y_u + i_u
외화 단가              P_fx = ceil_to( P_inc_krw / R , 통화 단가 소수 자리 )
외화 총액              A_fx = round( P_fx × q , 통화 금액 소수 자리 )
실수령 원화(원/ea)     X = P_fx × R
영업 마진액(원/ea)     G_exp = X − C(q) − k_u − y_u − i_u
수출 기준 마진율       g_export = G_exp / X                    ← 물류비가 매출에 포함돼 희석된 마진
EXW 기준 마진율        g_exw   = G_exp / (X − k_u − y_u − i_u)   ← Tab 1 목표 마진과 비교하는 기준
```

- 물류비는 **원가 그대로 전가(Pass-through)** 하며 물류비에 마진을 붙이지 않습니다.
- `g_exw`가 판정(§4.2.5)의 기준입니다. `g_export`는 참고 지표로 함께 표시합니다.

#### 4.3.5 환율 적용 기준

| `fx_basis` | 사용 값 | 비고 |
|---|---|---|
| `base` | 매매기준율(`deal_bas_r`) | 기본값 |
| `ttb` | 전신환 매입률(`ttb`) — 수출 대금을 원화로 바꿀 때 실제 받는 환율(보수적) | 2순위 소스(open.er-api)에는 TTB가 없으므로 `base × (1 − 0.01)`로 추정하고 `ttb_estimated: true` 표기 |
| `manual` | 사용자가 입력한 기준 환율(Budget Rate) | 사내 예산 환율 적용 시 |

### 4.4 [Tab 2] 환율 변동 스트레스 테스트

변동률 `s`(−10%, −5%, 0, +5%, +10%)는 **원화 대비 외화 가치 변동**입니다. `s < 0` = 원화 강세(환율 하락) = 수출 불리.
견적 외화 단가 `P_fx`는 이미 바이어에게 제시한 값으로 고정하고, 모든 외화 환율이 같은 비율로 움직인다고 가정합니다.

```
X  = P_fx × R                (기준 실수령 원화, 원/ea)
Yu = y_u                     (외화 표시 비용, 환율에 연동)
Ku = C(q) + k_u + i_u        (원화 고정 비용. 보험료는 단순화를 위해 고정 처리)

R_s        = R × (1 + s)
매출_s      = X × (1 + s)
마진액_s    = (X − Yu) × (1 + s) − Ku
마진율_s    = 마진액_s / 매출_s          ← 수출 기준 마진율 (표에 EXW 기준 마진율도 병기)
```

**손익분기 환율 / 방어선 환율**

```
손익분기 환율   R_be  = R × Ku / (X − Yu)
방어선 환율     R_def = R × Ku / ( X × (1 − m_min) − Yu )     ← 수출 기준 마진율이 m_min이 되는 환율
```

분모가 0 이하이면 `null`을 반환하고 "현재 단가로는 어떤 환율에서도 방어선을 지킬 수 없어요"를 표시합니다.

### 4.5 [Tab 2] 바이어 역제안(Counter Offer) 역산

입력: 바이어 희망 외화 단가 `T`(현재 인코텀즈·통화 기준), 기준 수량 `q`.

#### 4.5.1 현재 원가 구조 기준 마진

```
X_T   = T × R                                    (원/ea)
i_T   = X_T × 1.1 × r   (CIF·CIP일 때만, 아니면 0)
순 EXW 수입   N_T = X_T − k_u(q) − y_u(q) − i_T
영업 마진액   G_T = N_T − C(q)
EXW 기준 마진율 g_T = G_T / N_T                   (N_T ≤ 0 이면 판정 "역마진", 비율 null)
```

#### 4.5.2 목표 마진 단가 / 수용 최저가 (외화)

```
목표 단가     T_target = ( C(q)/(1 − m)     + k_u + y_u ) / (1 − 1.1·r) / R
수용 최저가   T_walk   = ( C(q)/(1 − m_min) + k_u + y_u ) / (1 − 1.1·r) / R
```
(보험 없는 조건은 `r = 0`. 표시할 때 통화 단가 소수 자리로 올림)

#### 4.5.3 원가 절감 가이드

```
목표 마진 달성 허용 원가   C_req = N_T × (1 − m)
절감 필요액(원/ea)         ΔC   = max(0, C(q) − C_req)
절감 필요율                ΔC / C(q)
요소별 배분(비례 배분)     ΔC_k = ΔC × (요소 k의 현재 원/ea ÷ C(q))   k ∈ {재료비 3종, 임가공, 고정비분산}
```

`ΔC ≥ C(q)` 이면 "원가 절감만으로는 불가능해요"로 표시합니다.

#### 4.5.4 수량 증대 가이드

바이어 단가 `T`를 그대로 받아들일 때 목표 마진 `m`을 달성하는 **최소 발주 수량**을 찾습니다.

```
후보 = {moq, moq+500, moq+1000, …, 200,000} ∪ VOLUME_DISCOUNTS 기준 수량들 (정렬, 중복 제거)
각 후보 q'에 대해 C(q'), 물류비(q')를 다시 계산(카톤 수·RT·컨테이너 수 재계산) → g_T(q')
g_T(q') ≥ m 인 첫 q'를 required_qty로 반환, 없으면 null
```

**판정**

| 조건 | verdict | Alert | 문구 예 |
|---|---|---|---|
| `g_T ≥ m` | `accept` | `alert-success` | "목표 마진 이상이에요. 수용해도 돼요" |
| `m_min ≤ g_T < m` | `negotiate` | `alert-warning` | "방어선은 지키지만 목표 마진에 못 미쳐요. 수량 증대나 조건 조정을 제안해 보세요" |
| `0 ≤ g_T < m_min` | `reject` | `alert-danger` | "방어선 아래예요. 원가 절감 또는 가격 재협상이 필요해요" |
| `g_T < 0` 또는 `N_T ≤ 0` | `negative` | `alert-danger` | "역마진이에요. 이 단가로는 수주할 수 없어요" |

### 4.6 [Tab 3] PI 계산

```
본품 금액          A_main  = round(P_fx_final × q, 금액 소수)       P_fx_final = 역제안 반영 시 T, 아니면 P_fx
추가 품목 금액      A_extra = Σ round(qty_i × unit_price_i, 금액 소수)
총액               A_total = A_main + A_extra
선금(Deposit)      A_dep   = round(A_total × deposit_pct / 100, 금액 소수)
잔금(Balance)      A_bal   = A_total − A_dep
영문 금액 표기      "SAY US DOLLARS NINE THOUSAND THREE HUNDRED EIGHTY AND CENTS ZERO ONLY"
```

- 영문 금액 변환 함수 `amount_to_words(amount, currency)`는 `service.py`에 직접 구현합니다(외부 패키지 미사용). 정수부는 billion/million/thousand 단위, 소수부는 `CENTS xx`(JPY는 소수부 없음).
- 통화 명칭: `US DOLLARS`, `EUROS`, `JAPANESE YEN`, `CHINESE YUAN`, `POUNDS STERLING`, `HONG KONG DOLLARS`, `SINGAPORE DOLLARS`, `AUSTRALIAN DOLLARS`, `CANADIAN DOLLARS`, `THAI BAHT`

### 4.7 검증용 기준 케이스 (Golden Case) — **구현 후 반드시 일치 확인**

**입력**: 벌크 850 · 용기 420 · 포장재 180 · 임가공 250(원/ea), 고정비 600,000원, 로스율 2%, MOQ 1,500, 목표 마진 30%, 방어선 15%

**Tab 1 결과**

| 수량 | 재료비 M | 임가공 L | 고정비분산 f | 총 제조원가 C | 제안 공급단가 P | 마진액 G | 마진율 g | 총 마진액 |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1,500 | 1,479.00 | 250.00 | 400.00 | 2,129.00 | 3,050 | 921.00 | 30.20% | 1,381,500 |
| 3,000 | 1,422.39 | 230.00 | 200.00 | 1,852.39 | 2,650 | 797.61 | 30.10% | 2,392,830 |
| 5,000 | 1,386.69 | 220.00 | 120.00 | 1,726.69 | 2,470 | 743.31 | 30.09% | 3,716,550 |
| 10,000 | 1,336.20 | 205.00 | 60.00 | 1,601.20 | 2,290 | 688.80 | 30.08% | 6,888,000 |

**Tab 2 물류** (q = 5,000, 카톤 40×30×25cm · 60ea · 12kg, 여유율 5%, SEA_LCL, US_WEST, USD 1,380.00)

| 항목 | 값 |
|---|---|
| 카톤 수 / 총 CBM(순수 → 여유율) / 총 중량 / RT | 84 / 2.520 → 2.646 / 1,008kg / 2.646 |
| 내륙운송 / 수출통관 / 선적지 부대 | 139,690원 / 30,000원 / 106,150원 → `K` = 275,840원 |
| 주운임 | $224.91 → 310,375.80원 |
| CIF 보험료(ICC(C) 0.05%) | 7,118.83원 |

| 인코텀즈 | 원화 단가(원/ea) | 외화 단가 | 개당 마진액 | 수출 기준 마진율 | EXW 기준 마진율 |
|---|---:|---:|---:|---:|---:|
| FOB | 2,525.17 | $1.830 | 743.54 | 29.44% | 30.10% |
| CFR | 2,587.24 | $1.875 | 743.57 | 28.74% | 30.10% |
| CIF | 2,588.67 | $1.876 | 743.52 | 28.72% | 30.10% |

**Tab 2 스트레스** (CIF, $1.876)

| 원화 변동 | 적용 환율 | 원화 환산 단가 | 마진액(원/ea) | 수출 기준 마진율 | EXW 기준 마진율(판정) |
|---:|---:|---:|---:|---:|---:|
| −10% | 1,242.00 | 2,329.99 | 490.84 | 21.07% | 22.13% (목표 미달) |
| −5% | 1,311.00 | 2,459.44 | 617.18 | 25.09% | 26.33% (목표 미달) |
| 0% | 1,380.00 | 2,588.88 | 743.52 | 28.72% | 30.10% (목표 달성) |
| +5% | 1,449.00 | 2,718.32 | 869.86 | 32.00% | 33.50% (목표 달성) |
| +10% | 1,518.00 | 2,847.77 | 996.20 | 34.98% | 36.59% (목표 달성) |

손익분기 환율 **973.93**, 방어선(15%) 환율 **1,150.79**

**Tab 2 역제안** (CIF, q = 5,000, 바이어 `$1.50`)

| 항목 | 값 |
|---|---|
| 원화 환산 / 보험료 / 순 EXW 수입 | 2,070.00 / 1.14 / 1,951.62 (원/ea) |
| 영업 마진액 / EXW 기준 마진율 | 224.93원 / **11.53%** → 판정 `reject`(방어선 미달) |
| 허용 원가 / 절감 필요액 / 절감률 | 1,366.13원 / **360.56원** / 20.88% |
| 목표 단가(30%) / 수용 최저가(15%) | $1.8735 → 표시 `$1.874` / $1.5578 → 표시 `$1.558` |
| 수량 증대 가이드 | `$1.50` → `null`(200,000ea까지 불가) · `$1.75` → **10,000ea**(마진 30.80%) |

> 모의 기준값(할인율·요율)을 바꾸면 이 표도 다시 계산해 갱신합니다.

---

## 5. 서브 탭 간 상태 관리 및 데이터 흐름

### 5.1 데이터 파이프라인

```
[Tab 1] 원가 입력 ──POST calculate-tiers──▶ tierResult ──(Tier 선택)──▶ selection {qty, C(q), P(q), cost_breakdown}
                                                                              │
                                                                              ▼
[Tab 2] 포장·물류 입력 + selection ──POST calculate-cbm-logistics──▶ logisticsResult {K, Y, I, 원화 단가}
         환율 (GET fx-rates) ──────────────────────────────────────▶ fx {rate, source}
         logisticsResult + fx ──POST fx-stress──▶ exportQuote {P_fx, A_fx, g_exw, stress[]}
         역제안 T ──POST reverse-counter-offer──▶ counterResult {verdict, ΔC, required_qty} ─(적용)─▶ counterApplied
                                                                              │
                                                                              ▼
[Tab 3] bound = {product, qty, P_fx_final, currency, incoterm, named_place, validity, moq}
         + PI 입력 폼 ──POST render-pi──▶ 미리보기 HTML ──(인쇄)
                      ──POST export-pi-pdf──▶ PDF Blob 다운로드
                      ──POST history──▶ 버전 저장 ──GET history──▶ 목록 / GET history/compare ──▶ 비교 Modal
```

### 5.2 클라이언트 상태 객체 (`margin.js` IIFE 내부, 전역 노출 금지)

```js
const state = {
  master: null,                 // GET /api/margin-calculator/master 응답
  fx: { rates: {}, source: null, asOf: null, isFallback: false, stale: false },
  tier: {
    input: { product: {}, cost: {}, moq: 1500, target_margin: 30, min_margin: 15, tiers: [3000, 5000, 10000], price_overrides: {} },
    result: null,               // calculate-tiers data
    status: "idle",             // idle | loading | success | error
  },
  selection: { qty: null },     // 선택 Tier (Tab 2·3의 입력원)
  export: {
    input: { carton: {}, transport_mode: "SEA_LCL", dest_region: "US_WEST", named_place: "", incoterm: "FOB",
             insurance_clause: "ICC_C", currency: "USD", fx_basis: "base", fx_manual_rate: null },
    logistics: null, quote: null, status: "idle",
  },
  counter: { input: { price: null, qty: null }, result: null, applied: null },  // applied = { price, qty }
  pi: { form: {}, bound: null, stale: false, previewHtml: null },
  history: { dealId: null, deals: [], versions: [], compareSelection: [] },
  version: { tier: 0, export: 0, bound: 0 },   // 변경 카운터(무효화 판정용)
};
```

### 5.3 이벤트 → 동작 규칙

| 이벤트 | 동작 |
|---|---|
| 페이지 로드 | ① `GET /api/margin-calculator/master` ② `GET /api/margin-calculator/fx-rates` (병렬) ③ `localStorage` 초안이 있으면 복원 ④ 원가 4대 요소가 모두 있으면 Tab 1 자동 계산 |
| Tab 1 입력 변경 | 클라이언트 검증 → 통과 시 **300ms Debounce** 후 `calculate-tiers` 호출. 진행 중 요청은 `AbortController`로 취소 |
| Tier Chip 추가/삭제, 프리셋 클릭 | 목록 정규화(정렬·중복 제거·최대 8개) → 재계산 |
| 단가 Input 수동 수정 | `price_overrides[qty]` 저장 + `.is-overridden` → 재계산(해당 행만 마진 재산출). 값을 비우면 override 해제 |
| Tier 선택(radio / 차트 클릭) | `state.selection.qty` 갱신, `tr.is-active`, 요약 바 갱신, Tab 2 활성화, `version.tier++` |
| Tab 1 결과 갱신 후 Tab 2 결과가 있음 | Tab 2를 자동 재계산(입력이 유효할 때만). 실패 시 Tab 2 `.badge` "다시 계산 필요" |
| Tab 2 입력 변경 | 300ms Debounce → `calculate-cbm-logistics` → 성공 시 `fx-stress` 연쇄 호출 |
| 통화·환율 기준 변경 | `fx-stress`만 재호출(물류비는 USD·KRW 고정이라 재계산 불필요. 단 통화 소수 자리가 바뀌므로 응답 전체 갱신) |
| 역제안 "역산하기" | 버튼 클릭 시에만 호출(Debounce 아님). 로딩 중 버튼 `disabled` + `.spinner-sm` |
| "이 단가로 견적서 작성" | `counter.applied = {price: T, qty}` → Tab 3 이동, `#margin-pi-counter-badge` 표시 |
| Tab 3 진입 | `bound`가 비어 있으면 자동 바인딩. 이미 있고 `version`이 달라졌으면 **덮어쓰지 않고** `#margin-pi-stale-alert` 표시 |
| "다시 불러오기" | `bound` 재생성, stale 해제, 미리보기 재요청 |
| PI 폼 변경 | 800ms Debounce → `render-pi` → `iframe.srcdoc` 교체 |
| 버전 저장 | Modal에서 major/minor·상태·메모 입력 → `POST history` → 목록 재조회, 새 버전 행 강조 |
| 버전 불러오기 | `#margin-confirm-modal` 확인 → `snapshot`으로 state 전체 교체 → Tab 1 → 2 순서로 재계산 → Tab 3 폼 복원 |
| 초기화 | 확인 Modal → state를 master 기본값으로 리셋, `localStorage` 초안 삭제 |

### 5.4 무효화(Stale) 규칙

- `bound`는 생성 시점의 `{version.tier, version.export}`를 기록합니다. 현재 값과 다르면 `pi.stale = true`.
- 역제안을 적용한 상태에서 Tab 1·2 값이 바뀌면 `counter.applied`는 유지하되 stale Alert에 "역제안 단가는 이전 원가 기준이에요" 문구를 추가합니다.
- 서버 응답이 도착했을 때 요청 시점의 `version`과 현재 `version`이 다르면 **응답을 버립니다**(경쟁 조건 방지).

### 5.5 초안 자동 저장 [권장]

- `state.tier.input`, `state.export.input`, `state.counter.input`, `state.pi.form`(은행 정보 제외)을 1초 Debounce로 `localStorage["cosmoa.margin.draft"]`에 저장합니다.
- 모든 `localStorage` 접근은 `try/catch`로 감싸고 실패해도 기능은 그대로 동작합니다.

---

## 6. Backend API 명세 및 service.py 함수 설계

### 6.0 URL 접두사 규칙

- README 규칙 9(`/api/<자신의 페이지 경로>/…`)에 따라 페이지 경로 `/margin-calculator`를 그대로 쓴 **`/api/margin-calculator/…`** 를 API 접두사로 사용합니다. `app.py`의 [C] 주석 안내와도 같습니다.
- 다른 담당자 접두사(`/api/home`, `/api/regulatory`, `/api/ai-formulation`, `/api/dev-request`)와 충돌하지 않습니다.
- 접두사는 `margin.js`의 `const API_BASE = "/api/margin-calculator";` 한 곳에만 둡니다. **JS에서 URL 문자열을 여기저기 하드코딩하지 않습니다.**
- 접두사 규칙은 URL에만 적용합니다. Flask 함수명(`margin_`)과 CSS Class·HTML id(`margin-`) 접두사는 그대로 유지합니다.

### 6.1 공통 규격

- 요청: `Content-Type: application/json`, UTF-8. 본문 최대 256KB(초과 시 413).
- 성공 응답
  ```json
  { "ok": true, "data": { }, "warnings": [ { "code": "LCL_TOO_LARGE", "message": "CBM이 15를 넘어요. FCL이 더 저렴할 수 있어요" } ] }
  ```
- 실패 응답
  ```json
  { "ok": false, "error": { "code": "MOQ_VIOLATION", "message": "MOQ(1,500ea) 이상부터 견적할 수 있어요", "fields": { "tiers[0]": "1,000ea는 MOQ 미만이에요" } } }
  ```
- HTTP 상태: 200 성공 / 400 형식 오류(JSON 아님, 필수 누락) / 422 검증 실패(범위·비즈니스 규칙) / 404 히스토리 없음 / 413 본문 초과 / 501 PDF 엔진 없음 / 502 외부 API 전체 실패(단, 환율은 Fallback이 있어 사실상 반환하지 않음) / 500 서버 오류
- 에러 메시지는 **해요체 한국어**, `code`는 대문자 스네이크. 서버 내부 예외 메시지(Traceback)는 응답에 넣지 않고 `app.logger.exception`으로만 기록합니다.
- 금액은 JSON number로 응답(서버에서 소수 자리 정리 후 `float` 변환). 원화는 소수 2자리, 외화 단가는 통화 단가 자리, 비율은 % 단위 소수 2자리(예: `30.09`).

### 6.2 Endpoint 목록

| Method | URL | Flask 함수(endpoint) | service 함수 | 용도 |
|---|---|---|---|---|
| GET | `/api/margin-calculator/master` | `margin_get_master` | `get_master_data()` | 마스터 데이터·기본값 |
| GET | `/api/margin-calculator/fx-rates` | `margin_get_fx_rates` | `get_fx_rates(currencies, force)` | 환율 조회(캐시·Fallback) |
| POST | `/api/margin-calculator/calculate-tiers` | `margin_calculate_tiers` | `calculate_tiers(payload)` | 수량 구간별 단가·마진 일괄 계산 |
| POST | `/api/margin-calculator/calculate-cbm-logistics` | `margin_calculate_cbm_logistics` | `calculate_logistics(payload)` | CBM·운임·보험료·인코텀즈 원화 단가 |
| POST | `/api/margin-calculator/fx-stress` | `margin_fx_stress` | `calculate_fx_quote(payload)` | 외화 단가·총액·민감도·손익분기 환율 |
| POST | `/api/margin-calculator/reverse-counter-offer` | `margin_reverse_counter_offer` | `reverse_counter_offer(payload)` | 역제안 역산 |
| POST | `/api/margin-calculator/render-pi` | `margin_render_pi` | `build_pi_context(payload)` + `render_template` | PI 미리보기·인쇄용 HTML |
| POST | `/api/margin-calculator/export-pi-pdf` | `margin_export_pi_pdf` | `build_pi_context` + `render_pi_pdf(html)` | PI PDF 다운로드 |
| GET | `/api/margin-calculator/history` | `margin_get_history` | `list_history(deal_id)` | 협상 건·버전 목록 |
| POST | `/api/margin-calculator/history` | `margin_save_history` | `save_history_version(payload)` | 버전 저장 |
| GET | `/api/margin-calculator/history/compare` | `margin_compare_history` | `compare_versions(deal_id, a, b)` | 버전 간 변경 비교 |

> 요구된 5종(`calculate-tiers`, `calculate-cbm-logistics`, `reverse-counter-offer`, `export-pi-pdf`, `history` GET·POST) 외에 `master`, `fx-rates`, `fx-stress`, `render-pi`, `history/compare`는 화면 동작에 필요해 추가했습니다.

### 6.3 외부 API 연동 전략 — 환율

#### 6.3.1 1순위: 한국수출입은행 현재환율 API

| 항목 | 값 |
|---|---|
| URL | `https://oapi.koreaexim.go.kr/site/program/financial/exchangeJSON` |
| Query | `authkey={MARGIN_KOREAEXIM_API_KEY}` `&searchdate=YYYYMMDD` `&data=AP01` |
| 응답 | JSON 배열. 주요 필드 `result`(1 성공, 2 DATA코드 오류, 3 인증코드 오류, 4 일일 제한 초과), `cur_unit`, `cur_nm`, `ttb`, `tts`, `deal_bas_r` |
| 값 형식 | **문자열 + 천 단위 콤마**(`"1,380.5"`) → 콤마 제거 후 `Decimal` |
| 특이사항 | 비영업일·당일 11시 이전에는 **빈 배열** → 전 영업일로 최대 7일 역조회 / `JPY(100)`·`IDR(100)`은 100으로 나눔 / 일일 호출 1,000회 제한 → 캐시 필수 |
| Timeout | `MARGIN_FX_TIMEOUT_SEC`(기본 5초) |
| 구현 | 표준 라이브러리 `urllib.request` + `json` (새 패키지 추가 없음) |

#### 6.3.2 2순위: open.er-api.com (Key 불필요)

| 항목 | 값 |
|---|---|
| URL | `https://open.er-api.com/v6/latest/USD` (환경변수 `MARGIN_FX_OPEN_API_URL`로 교체 가능) |
| 응답 | `{"result":"success","time_last_update_utc":"…","rates":{"KRW":1380.12,"EUR":0.914,…}}` |
| 변환 | `KRW per X = rates["KRW"] / rates[X]` (USD는 `rates["KRW"]`) |
| 한계 | 매매기준율 성격의 중간값만 제공 → TTB는 `base × 0.99` 추정 (`ttb_estimated: true`) |

#### 6.3.3 Fallback 체인과 캐시

```
get_fx_rates(currencies, force=False)
 ├─ 1) 메모리 캐시가 TTL(기본 60분) 이내이고 force=False → 반환 (source 유지, cached=true)
 ├─ 2) MARGIN_KOREAEXIM_API_KEY 있으면 수출입은행 조회(오늘 → 최대 7일 역조회)
 │      성공 → 메모리·파일 캐시 저장 → source="koreaexim"
 ├─ 3) 실패/Key 없음 → open.er-api 조회 → source="open_er_api"
 ├─ 4) 실패 → instance/margin/fx_cache.json (마지막 성공값) → source=원래 소스, is_fallback=true, stale=(as_of가 3일 초과)
 └─ 5) 실패 → FALLBACK_FX_KRW 상수 → source="mock", is_fallback=true
```

- 외부 호출은 **서버에서만** 합니다(브라우저에서 직접 호출 금지 — Key 노출·CORS 방지).
- 동시 요청이 몰려도 외부 API를 한 번만 부르도록 `threading.Lock`으로 갱신 구간을 보호합니다.
- 실패 원인은 `app.logger.warning`으로 남기고, 응답에는 `source`, `is_fallback`, `stale`, `as_of`만 노출합니다.

**화면 표시 규칙** (`#margin-fx-source-badge`, `#margin-fx-meta`)

| source / 상태 | 뱃지 | meta 문구 |
|---|---|---|
| `koreaexim` | `.badge-success` "실시간" | "한국수출입은행 · {as_of} 기준" |
| `open_er_api` | `.badge-info` "보조 소스" | "open.er-api.com · {as_of} 기준 · TTB 추정" |
| 파일 캐시(`is_fallback`) | `.badge-warning` "캐시" | "{as_of} 저장값 · 연결이 복구되면 자동 갱신돼요" |
| `mock` | `.badge-danger` "모의 환율" | "외부 환율을 불러오지 못해 모의 기준 환율을 쓰고 있어요. 직접 입력을 권장해요" |

### 6.4 Endpoint 상세

#### 6.4.1 `GET /api/margin-calculator/master`

**Response 200**

```json
{
  "ok": true,
  "data": {
    "defaults": { "moq": 1500, "tiers": [3000, 5000, 10000], "target_margin": 30, "min_margin": 15,
                  "fixed_cost": 600000, "loss_rate": 2, "carton_allowance": 5, "max_tiers": 8,
                  "max_qty": 1000000, "krw_round_unit": 10, "pi_validity_days": 30, "stress_steps": [-10, -5, 0, 5, 10] },
    "volume_discounts": [ { "min_qty": 1500, "rates": { "bulk": 0, "container": 0, "packaging": 0, "processing": 0 } } ],
    "incoterms": [ { "code": "FOB", "sea_only": true, "air_equivalent": "FCA", "seller_pays": { "inland": true }, "help": "선적항 본선 적재까지 부담해요" } ],
    "transport_modes": [ { "code": "SEA_LCL", "label": "해상 LCL" } ],
    "regions": [ { "code": "US_WEST", "label": "미국 서부", "default_place": "Los Angeles, USA" } ],
    "currencies": [ { "code": "USD", "name": "US Dollar", "symbol": "$", "price_decimals": 3, "amount_decimals": 2 } ],
    "payment_terms": [ { "code": "TT_30_70", "label": "T/T 30% 선금 / 70% 선적 전", "deposit_pct": 30 } ],
    "insurance_clauses": [ { "code": "ICC_A", "label": "ICC(A) 전위험", "rate_pct": 0.10 } ],
    "categories": [ { "code": "skincare", "label": "스킨케어" } ],
    "is_mock_rates": true
  }
}
```

#### 6.4.2 `GET /api/margin-calculator/fx-rates?currencies=USD,EUR&force=0`

- `currencies` 생략 시 master 전체. 알 수 없는 코드는 무시하고 `warnings`에 추가. `force=1`이면 메모리 캐시 무시(단 60초 이내 재요청은 캐시 반환 — 외부 API 남용 방지).

**Response 200**

```json
{
  "ok": true,
  "data": {
    "source": "koreaexim", "as_of": "2026-09-23T11:05:00+09:00", "search_date": "20260923",
    "is_fallback": false, "stale": false, "cached": false, "ttb_estimated": false,
    "rates": {
      "USD": { "base": 1380.00, "ttb": 1366.20, "tts": 1393.80 },
      "JPY": { "base": 9.40, "ttb": 9.306, "tts": 9.494 }
    }
  },
  "warnings": []
}
```

#### 6.4.3 `POST /api/margin-calculator/calculate-tiers`

**Request**

```json
{
  "product": { "name": "Hydra Essence 50ml", "volume_ml": 50, "category": "skincare" },
  "cost": { "bulk": 850, "container": 420, "packaging": 180, "processing": 250, "fixed_per_order": 600000, "loss_rate": 2 },
  "moq": 1500,
  "target_margin": 30,
  "min_margin": 15,
  "tiers": [3000, 5000, 10000],
  "price_overrides": { "10000": 2250 }
}
```

- 서버는 `tiers`에 `moq`를 자동 포함·정렬·중복 제거합니다.
- `tiers` 중 `moq` 미만 값이 있으면 **422 `MOQ_VIOLATION`**(`fields`에 해당 인덱스). 부분 계산하지 않습니다.

**Response 200**

```json
{
  "ok": true,
  "data": {
    "moq": 1500, "target_margin": 30, "min_margin": 15,
    "rows": [
      {
        "qty": 5000, "is_moq": false,
        "discounts": { "bulk": 5, "container": 8, "packaging": 8, "processing": 12 },
        "breakdown": { "bulk": 807.50, "container": 386.40, "packaging": 165.60, "loss": 27.19,
                       "material": 1386.69, "processing": 220.00, "fixed": 120.00 },
        "unit_cost": 1726.69,
        "suggested_price": 2470, "supply_price": 2470, "is_overridden": false,
        "unit_margin": 743.31, "total_margin": 3716550.00, "margin_rate": 30.09,
        "total_sales": 12350000.00,
        "cost_saving_vs_moq": 18.90, "price_cut_vs_moq": 19.02,
        "status": "ok"
      }
    ],
    "chart": { "labels": ["1,500", "3,000", "5,000", "10,000"], "unit_cost": [2129.0, 1852.39, 1726.69, 1601.2],
               "supply_price": [3050, 2650, 2470, 2290], "margin_rate": [30.2, 30.1, 30.09, 30.08] },
    "summary": { "has_negative": false, "has_below_defense": false }
  },
  "warnings": []
}
```

(`breakdown.loss`는 로스 반영분 = `(할인 후 재료비 합) × λ`)

**검증 오류 코드**: `INVALID_JSON` `REQUIRED_FIELD` `OUT_OF_RANGE` `MOQ_BELOW_MINIMUM`(moq < 1,500) `MOQ_VIOLATION` `TOO_MANY_TIERS` `ZERO_COST` `INVALID_MARGIN`(target ≥ 80 초과 또는 min > target)

**경고 코드**: `OVERRIDE_NEGATIVE_MARGIN`(수동 단가가 원가 미만) `OVERRIDE_BELOW_DEFENSE` `HIGH_TARGET_MARGIN`(target > 60)

#### 6.4.4 `POST /api/margin-calculator/calculate-cbm-logistics`

**Request**

```json
{
  "qty": 5000,
  "unit_cost": 1726.69,
  "supply_price": 2470,
  "carton": { "length_cm": 40, "width_cm": 30, "height_cm": 25, "units_per_carton": 60, "gross_weight_kg": 12, "allowance_rate": 5 },
  "transport_mode": "SEA_LCL",
  "dest_region": "US_WEST",
  "named_place": "Los Angeles, USA",
  "incoterm": "CIF",
  "insurance_clause": "ICC_C",
  "usd_rate": 1380.00
}
```

- `usd_rate`는 프론트가 `fx-rates` 결과(현재 `fx_basis` 기준 USD 값, manual이면 입력값 — 견적 통화가 USD가 아니면 USD의 base)를 넣습니다. 누락 시 서버가 `get_fx_rates(["USD"])`로 채웁니다.

**Response 200**

```json
{
  "ok": true,
  "data": {
    "incoterm": "CIF", "effective_incoterm": "CIF", "transport_mode": "SEA_LCL",
    "packing": { "cartons": 84, "carton_cbm": 0.030, "cbm_raw": 2.520, "cbm": 2.646,
                 "gross_weight_kg": 1008.0, "revenue_ton": 2.646, "chargeable_kg": null,
                 "containers": null, "utilization": null, "last_carton_units": 20 },
    "costs": [
      { "key": "inland",         "label": "내륙운송",        "currency": "KRW", "amount": 139690.00, "krw": 139690.00, "per_unit": 27.94, "borne_by": "seller" },
      { "key": "export_customs", "label": "수출통관",        "currency": "KRW", "amount": 30000.00,  "krw": 30000.00,  "per_unit": 6.00,  "borne_by": "seller" },
      { "key": "origin_local",   "label": "선적지 부대비용", "currency": "KRW", "amount": 106150.00, "krw": 106150.00, "per_unit": 21.23, "borne_by": "seller" },
      { "key": "main_freight",   "label": "해상 운임",       "currency": "USD", "amount": 224.91,    "krw": 310375.80, "per_unit": 62.08, "borne_by": "seller" },
      { "key": "insurance",      "label": "적하보험료",      "currency": "KRW", "amount": 7118.83,   "krw": 7118.83,   "per_unit": 1.42,  "borne_by": "seller" },
      { "key": "dest_charges",   "label": "도착지 비용",     "currency": "USD", "amount": 239.07,    "krw": 329916.60, "per_unit": 65.98, "borne_by": "buyer" }
    ],
    "totals": { "krw_costs": 275840.00, "fx_costs_krw": 310375.80, "insurance": 7118.83,
                "seller_total": 593334.63, "per_unit": 118.67 },
    "incoterm_unit_price_krw": 2588.67,
    "insurance_detail": { "clause": "ICC_C", "rate_pct": 0.05, "cfr_value": 12936215.80, "cif_value": 12943334.63, "insured_value": 14237668.10 }
  },
  "warnings": []
}
```

(`last_carton_units` = 마지막 카톤 입수량 `q − (N−1)×units_per_carton`, 끝수 카톤 안내용)

**경고 코드**: `SEA_ONLY_TERM_ON_AIR`(FOB·CFR·CIF + AIR → `effective_incoterm`을 FCA·CPT·CIP로 계산) `LCL_TOO_LARGE`(CBM > 15) `FCL_LOW_UTILIZATION`(적재율 < 60%) `HEAVY_CARTON`(카톤 > 25kg) `PARTIAL_CARTON`(끝수 카톤 존재) `INSURANCE_CLAUSE_UPGRADED`(CIP에 ICC(C) 요청 → ICC(A)로 계산)

#### 6.4.5 `POST /api/margin-calculator/fx-stress`

**Request**

```json
{
  "qty": 5000,
  "unit_cost": 1726.69,
  "logistics": { "krw_costs": 275840.00, "fx_costs_krw": 310375.80, "insurance": 7118.83 },
  "incoterm_unit_price_krw": 2588.67,
  "currency": "USD",
  "fx_basis": "base",
  "fx_manual_rate": null,
  "min_margin": 15,
  "target_margin": 30,
  "stress_steps": [-10, -5, 0, 5, 10]
}
```

**Response 200**

```json
{
  "ok": true,
  "data": {
    "currency": "USD", "fx_rate": 1380.00, "fx_basis": "base", "fx_source": "koreaexim", "fx_as_of": "2026-09-23T11:05:00+09:00",
    "unit_price_fx": 1.876, "total_amount_fx": 9380.00, "received_krw_per_unit": 2588.88,
    "unit_margin_krw": 743.52, "margin_rate_export": 28.72, "margin_rate_exw": 30.10, "status": "ok",
    "stress": [
      { "step": -10, "rate": 1242.00, "revenue_krw": 2329.99, "unit_margin": 490.84, "margin_rate": 21.07, "margin_rate_exw": 22.13, "status": "below_target" },
      { "step": 0,   "rate": 1380.00, "revenue_krw": 2588.88, "unit_margin": 743.52, "margin_rate": 28.72, "margin_rate_exw": 30.10, "status": "ok" }
    ],
    "breakeven_rate": 973.93,
    "defense_rate": 1150.79
  },
  "warnings": []
}
```

- 스트레스 행 `status`는 `margin_rate_exw`(= `unit_margin / (revenue − k_u − y_u×(1+s) − i_u)`) 기준으로 판정합니다.

**경고 코드**: `FX_FALLBACK`(Fallback 환율 사용) `FX_STALE`(3일 초과) `FX_MANUAL`(직접 입력)

#### 6.4.6 `POST /api/margin-calculator/reverse-counter-offer`

**Request**

```json
{
  "counter_price": 1.50,
  "currency": "USD",
  "fx_rate": 1380.00,
  "qty": 5000,
  "tier_request": { "cost": { }, "moq": 1500, "target_margin": 30, "min_margin": 15 },
  "logistics_request": { "carton": { }, "transport_mode": "SEA_LCL", "dest_region": "US_WEST", "incoterm": "CIF", "insurance_clause": "ICC_C", "usd_rate": 1380.00 }
}
```

- 수량 증대 가이드는 후보 수량마다 원가·물류비를 다시 계산해야 하므로 **원 입력(`tier_request`, `logistics_request`)** 을 받습니다.

**Response 200**

```json
{
  "ok": true,
  "data": {
    "counter_price": 1.50, "currency": "USD", "qty": 5000,
    "received_krw_per_unit": 2070.00, "insurance_per_unit": 1.14, "net_exw_revenue": 1951.62,
    "unit_cost": 1726.69, "unit_margin": 224.93, "margin_rate_exw": 11.53,
    "verdict": "reject", "status": "below_defense",
    "target_price": 1.874, "walkaway_price": 1.558, "gap_to_target": 0.374, "gap_to_target_pct": 24.93,
    "cost_reduction": {
      "allowed_cost": 1366.13, "required": 360.56, "required_pct": 20.88, "feasible": true,
      "by_component": [
        { "key": "bulk",       "label": "벌크",           "current": 823.65, "share": 47.70, "reduce": 171.99, "after": 651.66 },
        { "key": "container",  "label": "용기",           "current": 394.13, "share": 22.83, "reduce": 82.30,  "after": 311.83 },
        { "key": "packaging",  "label": "단상자·라벨·설명서", "current": 168.91, "share": 9.78,  "reduce": 35.27,  "after": 133.64 },
        { "key": "processing", "label": "충진·포장·검수",  "current": 220.00, "share": 12.74, "reduce": 45.94,  "after": 174.06 },
        { "key": "fixed",      "label": "고정비 분산",     "current": 120.00, "share": 6.95,  "reduce": 25.06,  "after": 94.94 }
      ]
    },
    "quantity_guide": { "required_qty": null, "margin_at_required": null, "searched_up_to": 200000 }
  },
  "warnings": []
}
```

- `by_component.current`의 재료비 3종은 **할인·로스 반영 후** 개당 금액입니다(합계 = `unit_cost`). 위 값은 §4.7 Golden Case(바이어 `$1.50`)의 실제 계산값입니다.
- 오류: `COUNTER_PRICE_INVALID`(≤ 0), `MOQ_VIOLATION`, 그 외 calculate-tiers·logistics와 동일한 검증 코드.

#### 6.4.7 `POST /api/margin-calculator/render-pi`

**Request** (`export-pi-pdf`와 동일 body)

```json
{
  "bound": {
    "product_name": "Hydra Essence 50ml", "volume_ml": 50, "qty": 5000, "unit_price": 1.876, "currency": "USD",
    "incoterm": "CIF", "named_place": "Los Angeles, USA", "moq": 1500, "hs_code": "3304.99",
    "cartons": 84, "units_per_carton": 60, "gross_weight_kg": 1008.0, "cbm": 2.646, "counter_applied": false
  },
  "pi": {
    "pi_no": "COSMOA-PI-20260923-001", "issue_date": "2026-09-23", "validity_date": "2026-10-23",
    "buyer": { "company": "ACME Beauty Inc.", "country": "USA", "address": "…", "contact": "Jane Doe", "email": "jane@acme.example" },
    "seller": { "company": "…", "address": "…", "contact": "…" },
    "bank": { "name": "…", "swift": "…", "account": "…", "beneficiary": "…" },
    "payment_terms": "TT_30_70", "port_loading": "Busan, Korea", "port_discharge": "Los Angeles, USA",
    "lead_time_days": 45, "shipment_date": "2026-11-07",
    "extra_items": [ { "description": "Free samples (FOC)", "qty": 50, "unit_price": 0 } ],
    "remarks": ""
  },
  "version": "1.0"
}
```

**Response 200**: `text/html; charset=utf-8` — 완성된 단독 HTML 문서(`<!DOCTYPE html>`부터). 프론트는 `iframe.srcdoc`에 넣습니다.

- 서버는 `build_pi_context()`에서 **금액을 다시 계산**합니다(프론트가 보낸 합계를 신뢰하지 않음). 검증 실패 시 422 JSON.

#### 6.4.8 `POST /api/margin-calculator/export-pi-pdf`

- Request: 6.4.7과 동일
- Response 200: `application/pdf`, `Content-Disposition: attachment; filename="PI_COSMOA-PI-20260923-001_v1.0.pdf"`
- PDF 엔진: **`xhtml2pdf`** (순수 Python, Windows 설치 문제 없음). `requirements.txt`에 `xhtml2pdf>=0.2.11` 한 줄 추가.
- `xhtml2pdf` import 실패 시 **501 `PDF_ENGINE_UNAVAILABLE`** → 프론트는 Alert "PDF 엔진이 없어 인쇄 창으로 열어요. 인쇄 대상에서 'PDF로 저장'을 선택해 주세요" 후 인쇄 흐름(§6.6)으로 대체합니다.
- 프론트 다운로드: `fetch` → `response.blob()` → `URL.createObjectURL` → 임시 `<a download>` 클릭 → `revokeObjectURL`.

#### 6.4.9 `GET /api/margin-calculator/history?deal_id=D20260923-001`

- `deal_id` 없으면 협상 건 목록(최신 수정순), 있으면 해당 건의 버전 목록(최신순).

```json
{ "ok": true, "data": { "deals": [ { "deal_id": "D20260923-001", "title": "ACME Beauty / Hydra Essence 50ml", "latest_version": "2.0", "version_count": 2, "updated_at": "2026-09-24T15:40:00+09:00" } ] } }
```

```json
{ "ok": true, "data": { "deal": { "deal_id": "D20260923-001", "title": "…" }, "versions": [ { "version": "2.0", "saved_at": "…", "status": "accepted", "memo": "…", "summary": { }, "snapshot": { } } ] } }
```

- 없는 `deal_id` → 404 `DEAL_NOT_FOUND`

#### 6.4.10 `POST /api/margin-calculator/history`

**Request**

```json
{
  "deal_id": null,
  "title": "ACME Beauty / Hydra Essence 50ml",
  "version_type": "major",
  "status": "sent",
  "memo": "1차 견적. 바이어 $1.50 희망",
  "summary": { "qty": 5000, "currency": "USD", "unit_price": 1.876 },
  "snapshot": { "tier_request": { }, "logistics_request": { }, "fx_request": { }, "pi": { }, "counter_applied": null }
}
```

- `deal_id: null` → 새 협상 건 생성(`D{YYYYMMDD}-{일련번호 3자리}`), 첫 버전 `"1.0"`.
- `status`: `draft` `sent` `countered` `accepted` `rejected`
- 서버는 `summary`의 핵심 값(단가·총액·마진율)을 `snapshot`으로 **재계산해 일치 여부를 확인**하고, 다르면 서버 계산값으로 덮어쓰고 `SUMMARY_RECALCULATED` 경고를 반환합니다.
- 은행 계좌번호는 저장 시 뒤 4자리만 남기고 마스킹(`****1234`)합니다.

**Response 200**: `{ "ok": true, "data": { "deal_id": "D20260923-001", "version": "1.0", "saved_at": "…" } }`

#### 6.4.11 `GET /api/margin-calculator/history/compare?deal_id=…&from=1.0&to=2.0`

```json
{
  "ok": true,
  "data": {
    "from": "1.0", "to": "2.0",
    "changes": [
      { "field": "unit_price",       "label": "단가",            "from": 1.876, "to": 1.75, "diff": -0.126, "diff_pct": -6.72, "direction": "down", "changed": true },
      { "field": "qty",              "label": "수량",            "from": 5000,  "to": 10000, "diff": 5000, "diff_pct": 100.0, "direction": "up", "changed": true },
      { "field": "margin_rate_exw",  "label": "영업 마진율(EXW)", "from": 30.10, "to": 30.80, "diff": 0.70, "diff_pct": null, "direction": "up", "changed": true, "unit": "%p" },
      { "field": "incoterm",         "label": "인코텀즈",        "from": "CIF", "to": "CIF", "changed": false }
    ]
  }
}
```

- 비교 필드: `qty` `unit_price` `currency` `total_amount` `unit_price_krw` `unit_cost_krw` `margin_rate_exw` `margin_rate_export` `incoterm` `named_place` `fx_rate` `payment_terms` `validity_date` `counter_applied` `status`
- 비율 필드는 `diff`를 **%p**로, `diff_pct`는 `null`. 통화가 다르면 `unit_price` 비교에 `note: "통화가 달라 원화 단가로 비교해요"`를 붙이고 `unit_price_krw`를 기준으로 봅니다.

### 6.5 `app.py` [C] 영역 작성 규칙

```python
# [C] 원가 경쟁력 및 마진 시뮬레이션 — 접두사: /api/margin-calculator/...
import importlib
margin_service = importlib.import_module("src.03_margin.service")


@app.route("/api/margin-calculator/master", methods=["GET"])
def margin_get_master():
    return jsonify({"ok": True, "data": margin_service.get_master_data()})


@app.route("/api/margin-calculator/calculate-tiers", methods=["POST"])
def margin_calculate_tiers():
    return margin_service.handle(margin_service.calculate_tiers, request.get_json(silent=True))
# … 나머지 Route도 동일 패턴
```

- Route 함수는 **입력 추출 → service 호출 → 응답 반환**만 합니다(5줄 이내). 계산·검증·파일 I/O는 모두 `service.py`.
- `service.handle(fn, payload)`: payload가 `None`이면 400 `INVALID_JSON`, `MarginValidationError` → 422, `MarginNotFoundError` → 404, 그 외 예외 → 로그 후 500. `(jsonify(body), status)` 튜플 반환.
- `render-pi` / `export-pi-pdf`는 `render_template("03_margin/margin_pi_document.html", **context)`를 Route에서 호출합니다(`render_template`은 앱 컨텍스트가 필요하므로 Route 쪽에 둠).
- 파일 상단 import 줄(`from flask import …`)은 PM 영역이므로 수정하지 않습니다. 필요한 것(`request`, `jsonify`, `render_template`)은 이미 import되어 있고, `Response`/`send_file`이 필요하면 [C] 영역 안에서 `from flask import Response`로 import합니다.
- 기존 [C] 영역의 `/api/margin-calculator/init`, `/simulate`, `/quotations/save` Route와 `MARGIN_DATA`·`calculate_simulation`·`save_pi_version` 참조는 **삭제된 `service.py`(커밋 `78d18bc`)를 가리키고 있어 현재 `python app.py`가 ImportError로 실행되지 않습니다.** 새 Route로 **전부 교체**합니다(자기 영역이므로 수정 가능). 새 Route도 같은 `/api/margin-calculator/` 접두사를 쓰므로, 기존 Route를 남겨 두지 말고 반드시 삭제해 중복·혼동을 막습니다.

### 6.6 PI 문서 템플릿 및 인쇄

- 파일: `src/03_margin/margin_pi_document.html` (Jinja 템플릿, `base.html`을 상속하지 **않는** 단독 문서)
- 이 파일은 화면 UI가 아닌 **출력 문서**이며, `xhtml2pdf`와 `iframe srcdoc`이 CSS Variable(`var(--…)`)·`style.css`를 불러올 수 없으므로 **예외적으로 템플릿 내부 `<style>`에 흑백 인쇄용 고정 값**을 씁니다. (화면용 `margin.css`에는 이 예외를 적용하지 않습니다.)
  - 글꼴: `Helvetica, Arial, sans-serif` (영문 전용), 본문 9.5pt, 표 테두리 0.5pt #000, `@page { size: A4; margin: 15mm; }`
- 문서 구성(위→아래)
  1. 제목 `PROFORMA INVOICE` / PI No. / Date / Validity / Version
  2. Seller(Shipper) 블록 · Buyer(Consignee) 블록 (2열)
  3. Shipment 블록: Port of Loading · Port of Discharge · Incoterms® 2020 · Shipment Date · Transport Mode · Country of Origin `Republic of Korea`
  4. 품목 표: `No. | Description of Goods | HS Code | Quantity (pcs) | Unit Price ({currency}) | Amount ({currency})` — 본품 1행 + 추가 품목
  5. 합계: `TOTAL {incoterm} {named_place}` + 금액 / `SAY …ONLY` 영문 금액
  6. Payment Terms 문구 + Deposit / Balance 금액
  7. Packing: `{cartons} cartons × {units_per_carton} pcs, G.W. {kg} kg, {cbm} CBM (approx.)`
  8. Bank Information (Beneficiary, Bank, SWIFT, Account No.)
  9. Terms & Conditions (`PI_STANDARD_TERMS`)
  10. 서명란 2열: `For and on behalf of {seller}` / `Accepted by {buyer}` (서명·날짜 줄)
- **내부 정보(원가, 마진율, 환율 출처)는 PI에 절대 출력하지 않습니다.**
- 인쇄: `#margin-pi-print-btn` → `iframe#margin-pi-preview-frame`의 `contentWindow.focus(); contentWindow.print();` — 페이지 전체(Sidebar 등)를 인쇄하지 않으므로 공통 레이아웃용 print CSS가 필요 없습니다.
- 모든 사용자 입력은 Jinja **autoescape**로 출력합니다(`|safe` 금지).

### 6.7 `service.py` 함수 설계

**구조**

```
service.py
├─ 상수(Master Data)             §3.2 전체
├─ 예외 클래스                    MarginValidationError(code, message, fields), MarginNotFoundError
├─ 유틸
│   ├─ to_decimal(value, field, *, min_value=None, max_value=None, allow_none=False) -> Decimal
│   ├─ ceil_to(value: Decimal, unit: Decimal) -> Decimal
│   ├─ round_to(value: Decimal, places: int) -> Decimal          # ROUND_HALF_UP
│   ├─ pct(value: Decimal) -> Decimal                             # 30 -> 0.30
│   ├─ out(value: Decimal, places=2) -> float                     # 응답 직렬화
│   ├─ now_kst() -> datetime
│   └─ handle(fn, payload) -> tuple[Response, int]                # 공통 에러 → HTTP 매핑
├─ Master
│   └─ get_master_data() -> dict
├─ Tab 1
│   ├─ get_discount_rates(qty: int) -> dict[str, Decimal]
│   ├─ calc_unit_cost(cost: dict, qty: int) -> dict               # breakdown + unit_cost
│   ├─ calc_supply_price(unit_cost, target_margin, override=None) -> dict
│   ├─ classify_margin(rate, target, minimum) -> str              # §4.2.5
│   ├─ normalize_tiers(tiers, moq) -> list[int]
│   ├─ validate_tier_request(payload) -> dict                     # 정규화된 입력
│   └─ calculate_tiers(payload) -> dict                           # API 진입점
├─ Tab 2 물류
│   ├─ calc_packing(carton, qty, mode) -> dict                    # §4.3.1
│   ├─ calc_logistics_costs(packing, mode, region, usd_rate) -> list[dict]   # §4.3.2 (부담 주체 미적용)
│   ├─ resolve_incoterm(incoterm, mode) -> tuple[str, list[warning]]
│   ├─ apply_incoterm(costs, incoterm) -> list[dict]              # borne_by 지정
│   ├─ calc_insurance(cfr_value, clause) -> dict                  # §4.3.3
│   ├─ validate_logistics_request(payload) -> dict
│   └─ calculate_logistics(payload) -> dict                       # API 진입점
├─ Tab 2 환율
│   ├─ _fetch_koreaexim(date) -> dict | None
│   ├─ _fetch_open_er_api() -> dict | None
│   ├─ _load_file_cache() / _save_file_cache(data)
│   ├─ get_fx_rates(currencies=None, force=False) -> dict         # §6.3.3
│   ├─ resolve_fx_rate(currency, basis, manual_rate) -> dict      # {rate, source, as_of, warnings}
│   ├─ calc_fx_stress(X, Yu, Ku, rate, steps, target, minimum) -> list[dict]   # §4.4
│   ├─ calc_breakeven_rates(X, Yu, Ku, rate, min_margin) -> dict
│   └─ calculate_fx_quote(payload) -> dict                        # API 진입점 (fx-stress)
├─ Tab 2 역제안
│   ├─ evaluate_counter(price_fx, rate, unit_cost, k_u, y_u, ins_rate) -> dict
│   ├─ calc_cost_reduction(breakdown, net_revenue, target) -> dict
│   ├─ search_required_qty(counter_price, rate, tier_req, logi_req) -> dict   # §4.5.4
│   └─ reverse_counter_offer(payload) -> dict                     # API 진입점
├─ Tab 3 PI
│   ├─ validate_pi(payload) -> dict                               # 영문 검사 포함 (§7.5)
│   ├─ amount_to_words(amount: Decimal, currency: str) -> str
│   ├─ build_pi_context(payload) -> dict                          # 템플릿 변수(금액 재계산)
│   └─ render_pi_pdf(html: str) -> bytes                          # xhtml2pdf, 없으면 PdfEngineUnavailable
└─ History
    ├─ HISTORY_PATH, _history_lock
    ├─ _read_history() -> dict                                    # 손상 시 .bak 보존 후 빈 구조
    ├─ _write_history(data) -> None                               # tmp 파일 작성 후 os.replace (원자적)
    ├─ list_history(deal_id=None) -> dict
    ├─ next_version(versions, version_type) -> str
    ├─ save_history_version(payload) -> dict
    └─ compare_versions(deal_id, a, b) -> dict
```

**함수 작성 규칙**

- 계산 함수(`calc_*`, `get_discount_rates`, `classify_margin`, `amount_to_words`)는 **순수 함수**: Flask·파일·네트워크에 의존하지 않고 `Decimal`을 받아 `Decimal`/dict를 돌려줍니다. 직렬화(`out()`)는 API 진입점 함수에서만 합니다.
- 입력 검증은 `validate_*`에서 한 번에 모아 `MarginValidationError(code, message, fields)`를 던집니다(첫 오류에서 멈추지 않고 필드별 오류를 모두 수집).
- 모든 함수에 한 줄 docstring과 참조 수식 번호를 적습니다. 예: `"""총 제조원가 C(q). 수식 §4.2.2"""`
- 환경변수는 모듈 import 시점이 아니라 **호출 시점**에 `os.getenv()`로 읽습니다(.env 변경 후 재시작만으로 반영).

### 6.8 환경변수 (`.env.example` 끝에 이름만 추가)

```
# [C] 원가·마진 시뮬레이션 — 환율
MARGIN_KOREAEXIM_API_KEY=
MARGIN_FX_CACHE_TTL_MIN=
MARGIN_FX_TIMEOUT_SEC=
MARGIN_FX_OPEN_API_URL=
```

| 이름 | 필수 | 코드 기본값 | 설명 |
|---|---|---|---|
| `MARGIN_KOREAEXIM_API_KEY` | – | 없음 | 한국수출입은행 Open API 인증키(https://www.koreaexim.go.kr 에서 발급). 없으면 2순위 소스부터 사용 |
| `MARGIN_FX_CACHE_TTL_MIN` | – | `60` | 환율 메모리 캐시 유지 시간(분) |
| `MARGIN_FX_TIMEOUT_SEC` | – | `5` | 외부 환율 API Timeout(초) |
| `MARGIN_FX_OPEN_API_URL` | – | `https://open.er-api.com/v6/latest/USD` | 2순위 환율 소스 URL |

> 실제 Key 값은 각자의 `.env`에만 넣습니다. 이 문서·코드·커밋에 Key를 쓰지 않습니다.

### 6.9 `requirements.txt` 추가 (한 줄, PR에 명시)

```
xhtml2pdf>=0.2.11
```

환율 조회는 표준 라이브러리(`urllib.request`)로 구현하므로 `requests`는 추가하지 않습니다.

---

## 7. 예외 처리 및 엣지 케이스 방어 로직

> 원칙: **클라이언트에서 먼저 막고(즉시 피드백), 서버에서 다시 검증**합니다(서버가 최종 기준). 오류 표시는 입력 오류 → `.form-control.is-error` + `.form-error`, 영역 경고 → `.alert`, 영역 전체 실패 → `.state.state-error`(다시 시도 버튼)를 사용합니다.

### 7.1 MOQ 미만 입력

| 상황 | 클라이언트 | 서버 |
|---|---|---|
| MOQ 필드에 1,500 미만 입력 | `#margin-moq.is-error` + "MOQ는 1,500ea 이상이어야 해요. 1,500ea 미만 소량 생산은 별도 협의가 필요해요" / 계산 요청 보내지 않음 / 포커스 아웃 시 값은 유지(자동 보정하지 않음) | 422 `MOQ_BELOW_MINIMUM` |
| Tier Chip에 MOQ 미만 수량 입력 | Chip을 추가하지 않고 `#margin-tier-error` "1,000ea는 MOQ(1,500ea) 미만이에요" + 입력값 유지 | 422 `MOQ_VIOLATION` (`fields`에 인덱스) |
| MOQ를 올려서 기존 Tier가 MOQ 미만이 됨 | 해당 Chip을 `.badge-warning` 스타일 문구로 표시하고 계산에서 제외, Alert "MOQ보다 작은 구간 2개를 제외했어요" | — |
| 역제안 기준 수량이 MOQ 미만 | `#margin-counter-qty.is-error` | 422 `MOQ_VIOLATION` |
| 끝수 수량(카톤 입수량의 배수가 아님) | 계산은 진행, Tab 2에 "마지막 카톤은 20ea만 들어가요. 수량을 5,040ea로 맞추면 카톤이 꽉 차요" 안내 | 경고 `PARTIAL_CARTON` |

### 7.2 원가·마진 입력 방어

| 상황 | 처리 |
|---|---|
| 음수·문자·빈 값 | 숫자 외 입력 차단(`inputmode="decimal"`), 빈 필수 값은 계산 보류 + Empty State 유지 |
| 4대 요소 합계 0 | 422 `ZERO_COST` "원가를 1개 이상 입력해 주세요" |
| 목표 마진 ≥ 80% 또는 < 0 | 422 `INVALID_MARGIN`. 60% 초과는 계산하되 경고 `HIGH_TARGET_MARGIN` |
| 목표 마진 = 100%(0으로 나누기) | 클라이언트·서버 모두 80% 상한으로 원천 차단 |
| 방어선 > 목표 마진 | `#margin-min-margin.is-error` "방어선은 목표 마진보다 클 수 없어요" |
| Tier 9개 이상 | 추가 차단, "수량 구간은 MOQ 포함 최대 8개까지 비교할 수 있어요" |
| 중복 수량 | 조용히 무시하고 기존 Chip을 잠깐 강조 |
| 수량 > 1,000,000 | 입력 차단 |
| 부동소수점 오차 | 서버 `Decimal` 계산 + 응답 전 자리 정리. JS는 표시 포맷만 담당하고 금액 재계산 금지 |

### 7.3 역마진·마진 방어선 경고

| 상황 | 표시 |
|---|---|
| 수동 단가 < 원가 (Tab 1) | 행 뱃지 `.badge-danger` "역마진", `#margin-tier-alert.alert-danger` "3,000ea 구간이 역마진이에요. 단가를 다시 확인해 주세요", 요약 바 마진 타일에 뱃지 동시 표시 |
| 방어선 미달 행 존재 | `.alert-warning` + 뱃지 "방어선 미달" |
| 선택 Tier가 역마진인데 Tab 2 진행 | 진행은 허용하되 Tab 2 상단 Alert 유지, "견적서 작성" 버튼 클릭 시 `#margin-confirm-modal` "역마진 조건으로 견적서를 작성할까요?" |
| 스트레스 −10%에서 역마진 | 해당 행 `.badge-danger`, 표 아래 "원화가 {x}% 이상 강세가 되면 손해예요" |
| 역제안 판정 `negative` | `#margin-counter-apply-btn` disabled + 사유 Tooltip |
| 물류비 단가 ≥ 역제안 원화 단가 (`N_T ≤ 0`) | 마진율 `—`, "바이어 희망 단가가 물류비보다 낮아요" |
| PI 저장 시 역마진 | 저장은 허용, `status`를 `draft`로 강제하지 않되 히스토리 행에 `.badge-danger` 표시 |

### 7.4 환율 API 장애 대응

| 장애 | 서버 동작 | 화면 |
|---|---|---|
| Key 없음 | 2순위부터 조회 | 뱃지 "보조 소스" |
| 수출입은행 Timeout / 5xx / SSL 오류 | 로그 후 2순위 | 동일 |
| `result` = 3(인증 오류) / 4(일일 한도) | 로그(키 값은 로그에 쓰지 않음) 후 2순위, 한도 초과 시 당일 재호출 억제 플래그 | 동일 |
| 빈 배열(주말·공휴일·11시 이전) | 최대 7일 역조회, 찾으면 `as_of`를 해당 영업일로 | meta에 "2026-09-21(월) 고시 기준" |
| 콤마·공백 포함 숫자 | 정규화 후 파싱, 실패 통화는 제외 + 경고 | 해당 통화 선택 불가(option disabled) |
| 모든 외부 소스 실패 | 파일 캐시 → 모의 환율 | 뱃지 "캐시"/"모의 환율" + `.alert-warning`, 직접 입력 탭 강조 |
| 캐시 3일 초과 | `stale: true` | "3일 넘은 환율이에요" 경고 |
| 직접 입력 환율 0·음수·비정상(기준 대비 ±30% 초과) | 0·음수는 422, ±30% 초과는 계산하되 경고 `FX_MANUAL_OUTLIER` | `.form-error` / Alert |
| `fx-rates` 요청 자체 실패(네트워크) | — | 카드 `.state.state-error` + "다시 시도", 이미 받은 환율이 있으면 그 값 유지 |

### 7.5 PI 관련

| 상황 | 처리 |
|---|---|
| PI 필드에 한글 등 비 ASCII 문자 | PDF 글꼴(Helvetica)이 한글을 지원하지 않으므로 422 `NON_ENGLISH_TEXT` "견적서는 영문으로 작성해 주세요" + 해당 필드 표시. 허용 문자: 출력 가능 ASCII + `€ £ ¥ ® ±` |
| 유효기간 < 발행일, 선적일 < 발행일 | 422 `INVALID_DATE` |
| 유효기간 경과한 버전 불러오기 | Alert "유효기간이 지난 견적이에요. 새 버전으로 저장할 때 날짜를 갱신해 주세요" |
| 필수 매도인·은행 정보 누락 | PDF·인쇄 버튼 disabled, 누락 필드 목록 Alert |
| PDF 엔진 없음 | 501 → 인쇄 흐름으로 대체 (§6.4.8) |
| PDF 생성 실패(xhtml2pdf 오류) | 500 `PDF_RENDER_FAILED`, 프론트 Alert + 인쇄 대체 안내 |
| 연속 클릭 | 요청 중 버튼 disabled + `.spinner-sm` |
| XSS | 서버 Jinja autoescape, 클라이언트는 사용자 문자열을 `textContent`로만 삽입(`innerHTML`에 사용자 입력 결합 금지). iframe `sandbox`에 `allow-scripts` 부여하지 않음 |
| 매우 긴 입력 | 필드별 최대 길이(§3.1.7) 서버 검증 |

### 7.6 히스토리 저장소

| 상황 | 처리 |
|---|---|
| `history.json` 없음 | 빈 구조로 시작 |
| JSON 손상 | `history.json.bak-{timestamp}`로 보존 후 빈 구조, 로그 + 응답 경고 `HISTORY_RECOVERED` |
| 동시 저장 | 모듈 수준 `threading.Lock` + 임시 파일 작성 후 `os.replace`(원자적 교체). 다중 프로세스 배포는 [범위 외] — 운영 전환 시 DB 이관 필요 |
| 없는 deal_id·version | 404 `DEAL_NOT_FOUND` / `VERSION_NOT_FOUND` |
| 같은 버전 두 개 선택 비교 | 비교 버튼 disabled |
| `schema_version` 불일치 | 읽기 시 마이그레이션 함수 자리 마련(현재 v1만 존재) |

### 7.7 네트워크·UI 공통

- 모든 `fetch`는 공통 래퍼 `api(method, path, body, {signal})`로 호출: JSON 파싱 실패·`ok:false`·HTTP 오류를 한 형태(`{code, message, fields}`)로 정규화합니다.
- 1초 이상 걸릴 수 있는 영역은 `.loading` 또는 버튼 내 `.spinner-sm`을 표시합니다.
- 응답 `fields`의 키(`cost.bulk`, `tiers[0]`)를 화면 id로 매핑하는 `FIELD_MAP` 객체를 두고 해당 Input에 `.is-error`를 표시합니다.
- 오류로 계산 결과를 못 받았을 때 **이전 결과를 지우지 않고** 흐리게(`opacity` 대신 뱃지 "이전 결과") 표시해 화면이 비지 않게 합니다.

---

## 8. 바이브 코딩 구현 가이드라인

### 8.1 수정 가능 / 금지 파일

| 구분 | 파일 |
|---|---|
| **수정 가능** | `src/03_margin/margin.html`, `margin.css`, `margin.js`, `margin.md`, `service.py`(신규), `margin_pi_document.html`(신규) |
| **제한적 수정** | `app.py` — `# [C] 원가 경쟁력 및 마진 시뮬레이션` 주석 아래 영역만 / `.env.example` — 파일 끝에 이름만 추가 / `requirements.txt` — `xhtml2pdf` 한 줄 추가 |
| **수정 금지** | `docs/**`, `README.md`, `src/common/**`(`base.html`, `style.css`, `common.js`), 다른 담당자 폴더(`01_home`, `02_regulatory`, `04_simulation`, `05_requisition`), `app.py`의 페이지 Route·다른 담당자 영역·상단 import, `.gitignore` |

공통 영역 수정이 필요해 보이면 **수정하지 말고 PM에게 요청**합니다(예: 공통 차트 컴포넌트, 인쇄 스타일).

### 8.2 작업 순서 (단계별 완료 기준 포함)

| 단계 | 작업 | 완료 확인 |
|---|---|---|
| **0** | `app.py` [C] 영역의 깨진 기존 Route를 제거하고, `service.py`에 빈 `get_master_data()`만 만든 뒤 `/api/margin-calculator/master` 하나만 연결 | `python app.py` 정상 실행, `/margin-calculator` 200, `/api/margin-calculator/master` 200 |
| **1** | `service.py` 상수(§3.2) + 유틸 + 예외 + `handle()` | master 응답에 모든 키 존재 |
| **2** | Tab 1 계산 함수 + `calculate_tiers` | §4.7 Tab 1 표와 **소수 2자리까지 일치** (아래 §8.4 검증 스크립트) |
| **3** | Tab 2 물류 함수 + `calculate_logistics` | §4.7 물류 값(84카톤, 2.646CBM, K=275,840, 보험료 7,118.83) 일치 |
| **4** | 환율 모듈 + `get_fx_rates` (Key 없이 → open.er-api, 네트워크 차단 시 → mock까지 확인) | 세 경로 모두 응답 `source` 확인 |
| **5** | `calculate_fx_quote`, `reverse_counter_offer` | §4.7 스트레스·역제안 값 일치 |
| **6** | `margin.html` 골격: page-header, 컨텍스트 Card(탭·요약 바), 3개 패널 Card 구조, Modal 4개 (§2) | 탭 전환·Modal 열기/닫기가 `common.js`만으로 동작 |
| **7** | `margin.js` 기반: IIFE, `state`, `api()` 래퍼, 포맷터, Debounce, master·환율 로드 | 콘솔 오류 없음, 전역 변수 없음(`Object.keys(window)` 비교) |
| **8** | Tab 1 UI 연결: 입력 검증, Chip, 테이블 렌더, 수동 단가, 선택, SVG 차트, 요약 바 | 입력 변경 후 300ms 내 테이블 갱신 |
| **9** | Tab 2 UI 연결: 물류·인코텀즈·환율·스트레스·역제안 | 인코텀즈 변경 시 매수인 부담 행 회색 처리 |
| **10** | `margin_pi_document.html` + `build_pi_context` + `render-pi` + 미리보기·인쇄 | iframe 미리보기, 인쇄 창에 PI만 표시 |
| **11** | `export-pi-pdf` (+ `requirements.txt`) | PDF 다운로드, 엔진 제거 시 501 → 인쇄 대체 |
| **12** | 히스토리 저장·목록·불러오기·비교 Modal | v1.0 → v2.0 → v2.1 번호 규칙, 비교 변동 표시 |
| **13** | 예외 처리 전수 점검(§7), 반응형(≤880px·≤560px 본문 폭), 초안 자동 저장 | §8.5 체크리스트 통과 |

### 8.3 `margin.js` 구현 규칙

```js
(function () {
  "use strict";
  const API_BASE = "/api/margin-calculator";
  const $ = (id) => document.getElementById(id);
  const state = { /* §5.2 */ };

  function debounce(fn, ms) { /* … */ }
  async function api(method, path, body, opts) { /* §7.7 정규화 */ }
  const fmt = {
    krw: (v) => Math.round(v).toLocaleString("ko-KR") + "원",
    pct: (v, d = 2) => v.toFixed(d) + "%",
    fx: (v, cur) => new Intl.NumberFormat("en-US", { style: "currency", currency: cur,
          minimumFractionDigits: state.master.currencies_by_code[cur].price_decimals }).format(v),
  };

  document.addEventListener("DOMContentLoaded", init);
})();
```

- 전역 변수·`window.xxx` 할당 금지. 공통 API는 `window.Common.openModal/closeModal`만 사용합니다.
- 이벤트는 패널 루트에 **위임(delegation)** 으로 등록합니다(동적 행·Chip 대응).
- 사용자 입력 문자열은 `textContent`로만 DOM에 넣습니다. 행 템플릿은 `document.createElement` 또는 `<template id="margin-tier-row-template">`를 사용합니다.
- 금액 **계산**은 서버 응답만 사용하고 JS는 포맷·표시만 합니다(원가 미리보기 타일의 단순 합계만 예외).
- 차트는 `renderTierChart(container, chartData, selectedQty)` 한 함수로 SVG 문자열이 아닌 `createElementNS`로 생성합니다.
- `localStorage` 접근은 전부 `try/catch`.

### 8.4 수식 검증 스크립트 (구현 후 실행, 커밋 대상 아님)

```python
# 프로젝트 루트에서: python -c "exec(open('scratch_check.py').read())"  (임시 파일, 커밋하지 않음)
import importlib
svc = importlib.import_module("src.03_margin.service")
r = svc.calculate_tiers({
    "product": {"name": "Hydra Essence 50ml"},
    "cost": {"bulk": 850, "container": 420, "packaging": 180, "processing": 250,
             "fixed_per_order": 600000, "loss_rate": 2},
    "moq": 1500, "target_margin": 30, "min_margin": 15, "tiers": [3000, 5000, 10000]})
rows = {row["qty"]: row for row in r["rows"]}
assert rows[1500]["unit_cost"] == 2129.00 and rows[1500]["supply_price"] == 3050
assert rows[5000]["unit_cost"] == 1726.69 and rows[5000]["margin_rate"] == 30.09
assert rows[10000]["supply_price"] == 2290
print("Tab 1 OK")
# 이어서 §4.7의 물류·스트레스·역제안 값도 같은 방식으로 assert
```

### 8.5 완료 조건 (Definition of Done)

- [ ] `python app.py` 실행 오류 없음, `/margin-calculator` 정상 렌더, Sidebar "원가·마진 시뮬레이션" 활성 표시
- [ ] §4.7 Golden Case 전 항목 일치
- [ ] Tab 1: 원가 4대 요소 입력 → 1,500/3,000/5,000/10,000ea 비교 테이블·차트 실시간 갱신, Tier 추가·삭제·수동 단가·선택 동작
- [ ] MOQ 미만 입력 시 경고, 계산 차단(클라이언트·서버 모두)
- [ ] Tab 2: CBM·운임·보험료·인코텀즈 단가, 인코텀즈별 매도인/매수인 부담 표시, 항공+해상 전용 조건 경고
- [ ] 환율: Key 있음/없음/네트워크 차단 세 경우 모두 화면이 동작하고 출처 뱃지가 올바름
- [ ] 스트레스 테이블 5행 + 손익분기·방어선 환율
- [ ] 역제안: 판정·원가 절감 가이드·수량 가이드·견적 반영
- [ ] Tab 3: 자동 바인딩, stale 알림, 미리보기, PDF 다운로드, 인쇄(PI만 인쇄), 한글 입력 차단
- [ ] 히스토리: 저장(major/minor), 목록, 불러오기(재계산 포함), 두 버전 비교 Modal
- [ ] 모든 id·페이지 CSS Class `margin-` 접두사, Flask 함수 `margin_` 접두사, JS 전역 변수 없음
- [ ] `margin.css`에 공통 컴포넌트 재정의 없음, 색·간격·굵기는 Variable만(§6.6 PI 문서 예외 제외)
- [ ] 본문 폭 ≤ 880px / ≤ 560px에서 레이아웃 깨짐 없음, 표는 `.table-wrap` 가로 스크롤
- [ ] API Key가 코드·로그·응답·커밋에 없음, `.env.example`에는 이름만
- [ ] `git status`로 `src/03_margin/`, `app.py`, `.env.example`, `requirements.txt` 외 변경 없음 확인

### 8.6 AI 도구 요청 템플릿

```
다음 문서를 순서대로 먼저 읽어 주세요.
1. README.md
2. docs/design_system.md
3. docs/ui_components.md
4. src/03_margin/margin.md

margin.md §8.2의 {N}단계만 구현해 주세요. (한 번에 한 단계씩 진행)

규칙:
- src/03_margin/ 밖의 파일은 수정하지 마세요. 예외: app.py의 "[C] 원가 경쟁력 및 마진 시뮬레이션" 주석 아래 영역,
  .env.example 끝에 이름만 추가, requirements.txt에 xhtml2pdf 한 줄 추가.
- API URL은 /api/margin-calculator/ 으로 시작하고 Flask 함수명은 margin_ 으로 시작하게 해 주세요.
- 공통 Button, Card, Form, Table, Tabs, Badge, Alert, Modal은 ui_components.md의 HTML 구조와 Class를 그대로 사용하세요.
- 색상·간격·글자 굵기는 design_system.md의 CSS Variable만 사용하세요. (굵기는 --font-weight-regular / -bold / -extrabold 3종뿐)
- margin.css에는 이 페이지에서만 필요한 스타일만, "margin-" 접두사로 작성하세요.
- 계산은 service.py에서 Decimal로 하고, margin.md §4.7 Golden Case 값과 일치하는지 확인해 주세요.
- API Key는 os.getenv()로 불러오세요.
- 공통 영역 수정이 필요해 보이면 수정하지 말고 알려 주세요.
- git add / commit / push는 실행하지 마세요. 작업이 끝나면 커밋 제목과 내용 요약만 알려 주세요.
```

### 8.7 주의사항 요약

1. **현재 `app.py`는 실행되지 않습니다** — [C] 영역이 삭제된 `service.py`를 import합니다. 0단계에서 먼저 고칩니다.
2. 히스토리·캐시 파일은 `instance/margin/`에만 씁니다. `src/`에 JSON을 두면 `/assets/`로 외부 공개됩니다.
3. 모의 기준값(할인율·운임·보험요율·환율)은 실제 견적으로 교체 전까지 화면에 "모의 기준값" 안내(`master.is_mock_rates`)를 `.text-caption`으로 표시합니다.
4. 마진율은 항상 **판매가 대비**입니다. Markup과 섞지 않습니다.
5. 원화 단가 올림(10원), 외화 단가 올림(통화 자리)으로 목표 마진이 반올림 때문에 깎이지 않게 합니다.
6. PI에는 원가·마진·환율 출처 같은 **내부 정보가 절대 나가지 않게** 합니다.
7. 커밋은 담당자가 직접 합니다. AI는 커밋 제목·요약만 제시합니다.

---

## 부록 A. README 16개 항목 매핑

README의 페이지 MD 기본 항목(16개)이 이 문서의 어디에 있는지 정리합니다.

| # | README 항목 | 이 문서 위치 |
|---|---|---|
| 1 | 페이지 목적 | §1.1, §1.2 |
| 2 | 담당 파일 | §8.1 |
| 3 | URL | 페이지 `/margin-calculator`(endpoint `margin`), API §6.2 |
| 4 | 사용자 | §1.3 |
| 5 | 주요 기능 | §1.4, §2.3~2.5 |
| 6 | 사용자 입력 | §3.1 |
| 7 | 처리 과정 | §4, §5 |
| 8 | 출력 결과 | §2.3~2.5(화면), §6.4(API 응답), §6.6(PI) |
| 9 | API / 외부 데이터 | §3.3, §6.3 |
| 10 | 데이터 처리 | §3.4, §4.0, §6.7 |
| 11 | 예외 처리 | §7 |
| 12 | UI 구성 | §2 |
| 13 | Flask / app.py 연동 | §6.5 |
| 14 | 수정 가능 파일 | §8.1 |
| 15 | 수정 금지 영역 | §8.1 |
| 16 | 완료 조건 | §8.5 |

## 부록 B. 용어집

| 용어 | 설명 |
|---|---|
| MOQ | Minimum Order Quantity, 최소 발주 수량 |
| Tier | 수량 구간. 구간이 올라갈수록 할인율 적용·고정비 분산으로 단가가 낮아짐 |
| 벌크 | 용기에 충진하기 전 화장품 내용물 |
| 임가공비 | 충진·포장·검수 등 제조 공정 비용 |
| CBM | Cubic Meter, 화물 부피(m³) |
| RT | Revenue Ton. 해상 LCL 운임 부과 기준, `max(CBM, 중량톤)` |
| C.W. | Chargeable Weight. 항공 운임 부과 중량, `max(실중량, 부피중량)` |
| LCL / FCL | 소량 혼적 화물 / 컨테이너 단독 화물 |
| THC / CFS / DOC | 터미널 처리비 / 혼적 화물 작업장 비용 / 서류 발급비 |
| Incoterms® 2020 | 국제상업회의소(ICC)의 무역 거래 조건 규칙 |
| ICC(A) / ICC(C) | 협회적하약관. (A) 전위험 담보, (C) 최소 담보 |
| 매매기준율 / TTB / TTS | 고시 기준 환율 / 전신환 매입률(은행이 외화를 살 때) / 전신환 매도율 |
| PI | Proforma Invoice, 계약 전 견적 송장 |
| T/T | Telegraphic Transfer, 전신 송금 |
| Counter Offer | 바이어의 역제안(희망 단가 제시) |
| 방어선(Defense Line) | 이 아래로 내려가면 수주하지 않는 최소 마진율 |
