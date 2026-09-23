# 원가 경쟁력 및 마진 시뮬레이션

> 담당: C · 기능 요구사항은 이 문서가 최우선입니다. 디자인·공통 UI는 `docs/design_system.md`, `docs/ui_components.md`를 따릅니다.

| 버전 | 날짜 | 변경 내용 | 작성 |
|---|---|---|---|
| 2.0 | 2026-09-23 | 화면 전면 재구성(견적 계산 / 역제안 분석 / 수량별 단가 / 환율 영향 4개 탭) 및 견적서 PDF 팝업 기준으로 명세 작성 | C |

## 1. 페이지 목적

화장품 OEM·ODM 해외영업 담당자가 **제조원가 → 수출 단가 → 바이어 역제안 대응 → 수량별 가격표 → 환율 리스크 → 견적서 PDF 발행**까지 한 화면에서 끝낼 수 있게 하는 원가·마진 시뮬레이터입니다.

- 원가(원재료·임가공·부자재)와 단계별 마진(1차 마진 · 물류 마진 · 영업마진)을 넣으면 인코텀즈별 USD 단가를 즉시 계산해요.
- 바이어가 목표가를 제시하면 "수락 / 영업마진 양보 / 1차·물류 마진 조정 / 불가" 중 어디에 해당하는지 판정하고, 재역제안 가격과 대응 방안을 보여줘요.
- 수량 할인 구간과 MOQ 정책으로 바이어용 가격표를 만들고, 결제 시점 환율 변동이 마진에 주는 영향을 확인해요.
- 계산 결과를 회사 양식(A4) 견적서 PDF로 바로 내려받아요.

## 2. 담당 파일

| 파일 | 역할 |
|---|---|
| `src/03_margin/margin.html` | 화면 템플릿 (`common/base.html` 상속), 견적서 PDF 팝업(Modal) 포함 |
| `src/03_margin/margin.css` | 이 페이지 전용 스타일 (`margin-` 접두사, CSS Variable만 사용) |
| `src/03_margin/margin.js` | 모든 계산·렌더링·이벤트 (IIFE, 전역 변수 없음) |
| `src/03_margin/margin.md` | 이 기능 명세서 |
| `src/03_margin/service.py` | 견적서 PDF: 회사 정보(`COMPANY`), 입력 검증, 합계 재계산, 영문 금액 표기, PDF 생성 |
| `src/03_margin/margin_quote_document.html` | 견적서 PDF 전용 문서 템플릿 (xhtml2pdf용, base.html 비상속) |
| `app.py` | `# [C]` 주석 아래 Backend Route 2개만 |

## 3. URL

| URL | Method | endpoint | 설명 |
|---|---|---|---|
| `/margin-calculator` | GET | `margin` | 페이지 (PM 관리 Route, 로그인 필요) |
| `/api/margin-calculator/quote-profile` | GET | `margin_quote_profile` | 견적서 팝업 자동 연동 값 (우리 회사 정보 + 로그인 담당자) |
| `/api/margin-calculator/quote-pdf` | POST | `margin_quote_pdf` | 견적서 PDF 생성·다운로드 |

- API는 README 규칙 9에 따라 `/api/margin-calculator/` 접두사를 씁니다.
- 모든 Route에 `@login_required`가 붙어 있어 로그인하지 않으면 `/login`으로 이동합니다.

## 4. 사용자

| 사용자 | 사용 목적 |
|---|---|
| 해외영업 담당자 (주 사용자) | 견적 단가 산출, 바이어 역제안 검토, 가격표·견적서 발행 |
| 영업 팀장 | 최소 영업마진 기준 준수 여부, 환율 리스크 확인 |
| 바이어 (간접) | PDF 견적서·가격표를 전달받음. 원가·마진율 등 내부 정보는 노출하지 않음 (오픈북형 선택 시에만 원가 구성 공개) |

## 5. 주요 기능

| 탭 | 기능 |
|---|---|
| **견적 계산** | 인코텀즈별 USD 단가(대표 수치), 단가 구성 막대(원가·1차 마진·물류비·물류 마진·영업마진·할인·할증), 핵심 지표 4개, 상세 탭 3개 |
| └ 항목별 원가 | 원재료·임가공·부자재·물류비의 원가 / 마진율 / 공급가 / 마진 표 |
| └ 내부·대외 비교 | 마진 일부를 원가·물류비로 "흡수"시켜 대외 견적에 보여줄 구성 비교 (원화/달러 전환) |
| └ 견적서 | 통합형 / 분리형 / 오픈북형 미리보기, **견적서 PDF** 버튼 → 팝업에서 고객사 정보 입력 후 PDF 다운로드 |
| **역제안 분석** | 바이어 목표가 판정(4단계), 가격 위치 Gauge(손익분기·최대 양보가·최소 마진가·목표 마진가), 항목별 마진 직접 조정, 대응 방안 카드 |
| **수량별 단가** | MOQ·MOQ 미만 정책(소량 할증 / 주문 불가), 수량별 단가 막대 차트, 편집 가능한 가격표, 바이어용 가격표 텍스트 복사 |
| **환율 영향** | USD 계약 단가 고정 시 결제 환율별 영업마진·총 마진 그래프, 버틸 수 있는 환율 3종, ±5%·±10% 시나리오 표 |

## 6. 사용자 입력

### 6.1 공통 입력 (좌측 입력 Card + 상단 기준 환율)

| 항목 | id | 단위 | 기본값 | 규칙 |
|---|---|---|---|---|
| 기준 환율 USD/KRW | `margin-fx` | 원 | 1400 | > 0 (상단 Tab Card 우측) |
| 1차 마진 입력 방식 | `margin-seg-minput` | - | 항목별 | 항목별 / 일괄 |
| 원재료·임가공·부자재 원가 (개당) | `margin-raw` / `-proc` / `-pack` | 원 | 850 / 400 / 650 | ≥ 0 |
| 항목별 1차 마진율 | `margin-r-raw` / `-r-proc` / `-r-pack` | % | 20 / 10 / 15 | 마진율 방식이면 < 100 |
| 일괄 1차 마진율 | `margin-m1` | % | 15 | "일괄" 선택 시에만 표시 |
| 로스율 | `margin-loss` | % | 0 | 원가 세 항목에 곱해짐 |
| 부자재 사급 | `margin-sagup` | 체크 | 해제 | 체크 시 부자재 마진 0% |
| 영업마진 계산 방식 | `margin-seg-mmode` | - | 마진율 | 마진율(판매가 대비) / 마크업(원가 대비) — 모든 마진에 공통 적용 |
| 영업마진 목표 / 최소 | `margin-m2` / `margin-m2min` | % | 20 / 15 | |
| 인코텀즈 | `margin-inco` | - | FOB | EXW / FOB / CFR / CIF |
| 주문수량 | `margin-qty` | 개 | 10000 | > 0 |
| FOB 물류비 총액 | `margin-logi` | 원 | 1,200,000 | EXW면 0으로 계산 |
| 물류 마진율 | `margin-r-logi` | % | 10 | |
| 해상운임 총액 | `margin-freight` | $ | 1500 | CFR·CIF일 때만 표시 |
| 보험요율 | `margin-ins` | % | 0.2 | CIF일 때만 표시 |
| 수량 할인 구간 | `margin-tiers` | 개 / % | 20,000개 3%, 50,000개 5% | 추가·삭제 가능 |

### 6.2 탭별 입력

| 탭 | 항목 | id | 기본값 |
|---|---|---|---|
| 견적 계산 › 내부·대외 비교 | 원가·물류비에 흡수할 금액 (Slider) | `margin-abs-c` / `margin-abs-l` | 0원 (최대 = 총 마진) |
| 견적 계산 › 견적서 | 형식 | `margin-seg-qmode` | 통합형 |
| 역제안 분석 | 바이어 목표가 / 항목별 최소 마진 | `margin-target` / `margin-item-floor` | $1.95 / 5% |
| 역제안 분석 | 항목별 조정 마진율 | `margin-adj-raw` / `-proc` / `-pack` / `-logi` | 현재 마진율 |
| 수량별 단가 | MOQ / MOQ 미만 정책 / 소량 할증률 | `margin-moq` / `margin-seg-moqmode` / `margin-moq-sur` | 5000 / 소량 할증 / 10% |
| 수량별 단가 | 가격표 행 (수량, 물류비 총액) | 표 안 입력 | 3천·5천·1만·2만·5만개 |
| 환율 영향 | 계약 단가 / 현재 견적 단가 사용 | `margin-fx-contract` / `margin-fx-use-quote` | 체크(견적 단가 연동) |
| 환율 영향 | 결제 시점 환율 (Slider) | `margin-fx-settle` | 기준 환율, 범위 ±15% |

### 6.3 견적서 PDF 팝업 (`#margin-quote-modal`)

| 구분 | 항목 | id | 필수 | 기본값 |
|---|---|---|---|---|
| 우리 회사 (자동 연동) | 회사명 | `margin-q-company` | - | `service.COMPANY["name"]`, 수정 불가 |
| | 담당자 / 이메일 | `margin-q-contact-name` / `-email` | | 로그인 사용자 이름·이메일, 수정 가능 |
| 고객사 | 회사명(영문) | `margin-q-buyer-company` | ○ | |
| | 국가 / 담당자(Attn.) / 주소 / 이메일 | `margin-q-buyer-country` / `-attn` / `-address` / `-email` | | |
| 견적 조건 | 견적 번호 | `margin-q-no` | ○ | `QT-YYYYMMDD-01` |
| | 유효기간 | `margin-q-validity` | | 30일 |
| | 품목명(영문) | `margin-q-product` | ○ | Toner 150ml (미리보기에도 반영) |
| | 결제 조건 / 지정 장소 / 납기 / 비고 | `margin-q-payment` / `-place` / `-lead` / `-remarks` | | T/T / (EXW·FOB: Korea, CFR·CIF: Port of destination) |

## 7. 처리 과정

모든 단가 계산은 브라우저(`margin.js`)에서 즉시 합니다. 입력이 바뀔 때마다 `render()`가 4개 탭을 모두 다시 그립니다. 서버는 견적서 PDF 생성만 합니다.

### 7.1 마진 적용식

```
apply(base, r) = 마진율 방식: base / (1 − r)      (판매가 대비)
                 마크업 방식: base × (1 + r)      (원가 대비)
toSale(m)      = 마진율 방식: m,  마크업 방식: m / (1 + m)   (판매가 대비 비율로 환산)
```

### 7.2 견적 단가 (forward)

```
항목 원가      item_k = 원가_k × (1 + 로스율)                  (k = 원재료, 임가공, 부자재)
원가 합계      C      = Σ item_k
1차 공급가     P1     = Σ apply(item_k, 1차마진율_k)            (사급이면 부자재 마진 0)
개당 물류비    L      = EXW ? 0 : 물류비 총액 / 수량
물류 공급가    Lsup   = apply(L, 물류 마진율)
영업 전 단가   P2     = P1 + Lsup
정가           P3     = apply(P2, 영업마진 목표)
할인율         d      = 수량 이상인 구간 중 가장 큰 구간의 할인율
할증률         s      = (수량 < MOQ 이고 "소량 할증") ? 할증률 : 0
원화 판매가    P4     = P3 × (1 − d) × (1 + s)
USD 단가       U      = P4 / 기준환율
               CFR·CIF: U += 해상운임 총액 / 수량
               CIF    : U += U × 1.1 × 보험요율
```

지표: 1차 마진(물류 포함) `1 − (C + L) / P2`, 할인 후 영업마진 `1 − P2 / P4`, 총 마진 `(P4 − C − L) / P4`

### 7.3 역제안 판정

목표가 t(USD)를 원화 FOB 기준 T로 되돌린 뒤(CIF 보험·해상운임 제외) 네 기준가와 비교합니다.

| 기준가 | 계산 |
|---|---|
| 손익분기 | `toUsd(C + L)` |
| 최대 양보가 | 항목별 마진을 `min(항목별 최소 마진, 현재 마진율)`로 낮춘 공급가 합에 최소 영업마진 적용 |
| 최소 마진가 | `toUsd(apply(P2, 최소 영업마진))` |
| 목표 마진가 | `toUsd(apply(P2, 영업마진 목표))` |

| 판정 | 조건 | 색 |
|---|---|---|
| 수락 가능 | t ≥ 목표 마진가 | success |
| 영업마진 양보 | 최소 마진가 ≤ t < 목표 마진가 | caution (warning 파생) |
| 1차·물류 마진 조정 | 최대 양보가 ≤ t < 최소 마진가 | warning |
| 마진만으로 불가 | t < 최대 양보가 | danger |

- 마진 직접 조정: 조정 마진율로 공급가 합 S′를 다시 구해 `영업마진 = 1 − S′ / T`, 최소 영업마진까지 부족액, 이 조정안의 최소 마진 단가를 표시합니다.
- 대응 방안: ① 재역제안(최소 마진가) ② 목표가에서 최소 영업마진을 지키는 1차·물류 공통 마진율 ③ EXW 전환 단가 ④ 다음 할인 구간 수량 단가(물류비는 수량 비례의 85%로 가정). 목표가가 최소 마진가보다 낮으면 ①을 강조합니다.

### 7.4 수량별 단가

- 가격표의 각 행(수량, 물류비 총액)으로 7.2를 다시 계산합니다.
- MOQ 미만: "소량 할증"이면 할증 적용, "주문 불가"면 단가 대신 "주문 불가"로 표시하고 복사 대상에서 제외합니다.
- 요약: MOQ 수량 단가와 가장 낮은 단가, 그 차이(%)와 할인 후 영업마진.

### 7.5 환율 영향

```
FOB 달러 단가  fobU = 계약단가 (CIF면 ÷ (1 + 1.1 × 보험요율), CFR·CIF면 − 해상운임/수량)
원화 매출      rev(f) = fobU × f
영업마진       m2(f)  = 1 − P2 / rev(f)
총 마진        tot(f) = (rev(f) − C − L) / rev(f)
버틸 수 있는 환율  목표 = P2 / (1 − toSale(목표)) / fobU,  최소 = P2 / (1 − toSale(최소)) / fobU,  손익분기 = (C + L) / fobU
```

- Slider 범위는 기준 환율의 ±15%(10원 단위), 시나리오 표는 −10% / −5% / 0 / +5% / +10%입니다.

### 7.6 견적서 PDF

1. **견적서 PDF** 버튼 → 공통 Modal(`data-modal-open`)이 팝업을 엽니다. 처음 열 때 `quote-profile`을 불러와 회사명·담당자를 채웁니다.
2. 필수값 확인 → 견적 계산의 형식별 품목(`st.quote`)과 팝업 입력값을 JSON으로 `quote-pdf`에 POST 합니다.
3. 서버: `build_quote_context()` 검증 → 합계 재계산 → `margin_quote_document.html` 렌더 → `html_to_pdf()` → `Quotation_<견적번호>.pdf` 첨부 응답.
4. 브라우저: Blob으로 내려받고 팝업을 닫습니다.

## 8. 출력 결과

| 위치 | 출력 |
|---|---|
| 견적 계산 | 인코텀즈 단가(`kpi-value-lg`), 원화 단가·주문 총액, 할인/할증/MOQ Badge, 구성 막대, Stat Tile 4개, 항목별 원가 표, 내부·대외 비교 표 2개, 견적서 미리보기 |
| 역제안 분석 | 판정 박스(Badge + 제목 + 설명), Gauge, 조정 결과 박스, 대응 방안 카드 2~4개 |
| 수량별 단가 | 요약 박스, SVG 막대 차트(MOQ 선, MOQ 미만 빗금), 가격표(현재·MOQ·MOQ 미만 표시) |
| 환율 영향 | 판정 박스, SVG 선 그래프(판정 구간 배경·기준선), 버틸 수 있는 환율 3칸, 시나리오 표 |
| 가격표 복사 | 영문 텍스트: `Price list (FOB Korea, USD per pc)` / `MOQ: 5,000 pcs` / `10,000 pcs : $2.15 (volume discount 3%)` … |
| 견적서 PDF (A4 1장) | 회사명·연락처 / QUOTATION / 고객사·견적번호·일자·유효기간·담당자 / 거래 조건(Price Term·Currency·Payment·MOQ) / 품목 표 / 합계·영문 금액(SAY US DOLLARS … ONLY.) / 오픈북형 원가 구성 / Terms & Conditions / 비고 / 서명란 / 쪽 번호 |

- 금액 표기: 원화 `1,234원`, 달러 `$2.15`, 비율 `20.0%`(소수 1자리). 증감은 design_system 관례(상승 빨강 ▲ / 하락 파랑 ▼).
- PDF에는 원가·마진율·환율 등 내부 값이 들어가지 않습니다. (오픈북형 원가 구성 제외)

## 9. API / 외부 데이터

### 9.1 `GET /api/margin-calculator/quote-profile`

```json
{ "company": { "name": "COSTD Co., Ltd.", "address": "", "phone": "", "email": "" },
  "contact": { "name": "데모 사용자", "email": "demo@costd.kr" } }
```

### 9.2 `POST /api/margin-calculator/quote-pdf`

요청 (JSON)

```json
{
  "mode": "one | split | open", "incoterm": "EXW | FOB | CFR | CIF",
  "quote_no": "QT-20260923-01", "issue_date": "2026-09-23", "validity_days": 30,
  "contact": { "name": "", "email": "" },
  "buyer": { "company": "Glow Beauty Inc.", "country": "", "attn": "", "address": "", "email": "" },
  "payment": "T/T", "named_place": "Busan, Korea", "lead_time": "", "remarks": "",
  "moq": "5,000 pcs", "discount_note": "",
  "lines": [ { "description": "Toner 150ml", "qty": "10,000 pcs", "unit_price": 2.15, "amount": 21500 } ],
  "breakdown": [ { "label": "Margin", "usd": 0.70, "share": "32.8%" } ]
}
```

| 응답 | 내용 |
|---|---|
| 200 | `application/pdf`, `Content-Disposition: attachment; filename="Quotation_<견적번호>.pdf"` |
| 400 | `{"error": "고객사 회사명을(를) 입력하세요."}` 등 검증 오류 |
| 500 | `{"error": "PDF 를 만들지 못했어요."}` |

### 9.3 외부 데이터

- 외부 API 없음. 환율은 사용자가 직접 입력합니다. API Key를 쓰지 않습니다.
- 패키지: `xhtml2pdf` (requirements.txt에 이미 있음).
- 글꼴: PDF 한글 표시용으로 시스템 TTF(Windows 맑은 고딕, Linux 나눔고딕)를 찾아 씁니다. 없으면 Helvetica(영문만).

## 10. 데이터 처리

- **DB 저장 없음.** 모든 시뮬레이션 상태는 브라우저 메모리(`margin.js`의 `st` 객체)에만 있고 새로고침하면 기본값으로 돌아갑니다.
- 우리 회사 정보는 `service.py`의 `COMPANY` 상수에서 관리합니다. (회사 주소·전화·이메일이 정해지면 여기만 수정)
- 서버는 화면이 보낸 회사명을 쓰지 않고 항상 `COMPANY`를 씁니다.
- 합계는 서버에서 품목 금액을 다시 더해 계산하므로 표와 합계·영문 금액이 어긋나지 않습니다.
- 반올림: 화면 USD 단가는 소수 2자리, 주문 총액은 `반올림 단가 × 수량`, 비율은 소수 1자리.
- PDF 생성 시 원격 리소스 요청은 막고, 로컬 파일은 글꼴 폴더만 읽도록 xhtml2pdf 리소스 정책을 제한합니다.

## 11. 예외 처리

| 상황 | 처리 |
|---|---|
| 원가·수량·환율이 비었거나 수량·환율 ≤ 0, 원가 < 0 | 입력 Card 하단 `.form-error` "원가·수량·환율을 확인하세요…", 결과 갱신 중단 |
| 마진율 방식에서 마진 ≥ 100% | "마진율 방식에서는 마진이 100% 미만이어야 해요." |
| 역제안 목표가·최소 마진 미입력 | 역제안 Card 안 오류 문구, 판정·Gauge 비움 |
| 마진 직접 조정에 100% 이상(마진율 방식) / 숫자 아님 | 입력 무시 |
| 환율 탭 계약 단가 미입력 | 판정 박스에 "계약 단가를 입력하세요." |
| 가격표 수량·물류비 ≤ 0 | 값 반영 안 함. 행은 최소 1개 유지 |
| MOQ·할증률 음수 | 값 반영 안 함 |
| 목표가가 원가+물류비보다 낮음 | "원가와 물류비보다 낮은 가격이에요" 판정 |
| 내부·대외 비교에서 흡수액 > 총 마진 / 원가 +20% 초과 | "마진 초과 흡수"(danger) / "원가 +20% 초과"(warning) Badge |
| 클립보드 복사 불가 | `window.prompt`로 텍스트 표시 |
| 팝업 필수값 누락 | 해당 칸 `.is-error` + 팝업 하단 오류 문구, 첫 칸에 Focus. 서버도 400으로 다시 검증 |
| 팝업 자동 연동 실패 / 세션 만료 | "회사 정보를 불러오지 못했어요…" / "로그인이 만료됐어요. 다시 로그인해 주세요." |
| 텍스트 200자 초과, 품목 20개 초과, 숫자 형식 오류 | 서버 400 + 항목명이 들어간 오류 문구 |
| PDF 생성 실패 | 500 "PDF 를 만들지 못했어요." — 버튼 로딩 해제, 팝업 유지 |

## 12. UI 구성

```
.margin-page#margin-app
 ├─ .page-header  h1.page-title / p.page-description / .page-actions(← 홈으로 .btn-surface)
 └─ .margin-layout (360px + 1fr, 본문 폭 ≤ 880px에서 1열)
     ├─ aside.card.margin-inputs (Desktop sticky)
     │    원가와 1차 마진 / 영업마진 / 물류와 수량 / 수량 할인 구간 (.margin-group, 구분선)
     └─ .margin-results
          ├─ .card.card-sm.margin-toolbar : .tabs(견적 계산·역제안 분석·수량별 단가·환율 영향) + 기준 환율
          ├─ .tab-panel#margin-view-forward : 대표 단가 Card / 상세 Card(.tabs 3개 + .tab-panel)
          ├─ .tab-panel#margin-view-reverse : 목표가·판정 / Gauge / 마진 직접 조정 / 대응 방안
          ├─ .tab-panel#margin-view-tier    : MOQ·요약 / 차트 / 가격표
          └─ .tab-panel#margin-view-fx      : 계약 단가·결제 환율·판정 / 차트 / 버틸 수 있는 환율 / 시나리오
.modal-backdrop#margin-quote-modal > .modal.modal-lg  (우리 회사 / 고객사 / 견적 조건 / 취소·PDF 다운로드)
```

- 공통 컴포넌트를 그대로 사용: `.card`, `.tabs`/`.tab`/`.tab-panel`(common.js `data-tab-target`), `.table`, `.badge`, `.stat-tile`, `.kpi-*`, `.input-group`, `.form-control(-sm)`, `.form-check`, `.btn`, `.modal`, `.spinner`.
- Panel 없이 값만 고르는 버튼 묶음(항목별/일괄, 마진율/마크업 등)은 `.tabs.margin-seg`로 모양만 쓰고 `.is-active`는 margin.js가 토글합니다.
- 색·간격·글꼴은 CSS Variable만 사용합니다. 판정 4단계 색은 `--color-success / warning / danger`에서 파생한 `--margin-zone-*` 변수(`.margin-page` 범위)입니다.
- 차트는 inline SVG이며 색은 margin.css의 class로 지정합니다.
- 페이지 머리 ↔ 본문 간격만 이 페이지에서 32px로 줄였습니다. (`.margin-page .page-header`, 공통 CSS 미수정)
- 팝업은 `.container`가 Container Query 기준이라 fixed 배치가 본문 기준이 되므로, margin.js가 로드 시 `document.body`로 옮깁니다.
- 반응형: `@container page (max-width: 880px / 560px)` 기준으로 입력·결과 1열, 상단 헤더 박스 2열→1열, 팝업 입력 2열→1열.

## 13. Flask / app.py 연동

```python
# [C] 원가 경쟁력 및 마진 시뮬레이션 — 접두사: /api/margin-calculator/...
margin_service = importlib.import_module("src.03_margin.service")

@app.route("/api/margin-calculator/quote-profile", methods=["GET"])
@login_required
def margin_quote_profile(): ...            # service.quote_profile(auth.current_user())

@app.route("/api/margin-calculator/quote-pdf", methods=["POST"])
@login_required
def margin_quote_pdf(): ...                # build_quote_context → render_template → html_to_pdf
```

| service.py 함수 | 역할 |
|---|---|
| `quote_profile(user)` | `COMPANY` + 로그인 사용자 이름·이메일 |
| `build_quote_context(payload, user)` | 입력 검증(ValueError), 합계 재계산, 날짜·금액 서식, 템플릿 context 생성 |
| `amount_in_words(amount)` | `SAY US DOLLARS … AND CENTS … ONLY.` |
| `quote_filename(quote_no)` | 안전한 파일명 `Quotation_<번호>.pdf` |
| `html_to_pdf(html)` | xhtml2pdf 변환(리소스 정책 제한), 실패 시 RuntimeError |

- 템플릿의 API 주소는 `url_for()`로 `#margin-app`의 `data-profile-url`, `data-pdf-url`에 넣고 JS는 이 값만 사용합니다.
- 페이지 Route `/margin-calculator`는 PM 관리 영역이므로 수정하지 않습니다.

## 14. 수정 가능 파일

- `src/03_margin/` 안의 모든 파일
- `app.py`의 `# [C] 원가 경쟁력 및 마진 시뮬레이션` 주석 아래 영역 (Route 추가·수정)
- `requirements.txt`: 필요한 패키지를 **한 줄 추가**만 (PR에 명시)

## 15. 수정 금지 영역

- `docs/`, `src/common/`(base.html, style.css, common.js, auth.py 등), `README.md`, `.gitignore` — PM 관리
- 다른 담당자 폴더(`01_home`, `02_regulatory`, `04_simulation`, `05_requisition`)
- `app.py`의 페이지 Route·로그인 영역, 다른 담당자 영역, 기존 Route 삭제·변경
- 공통 Button·Card·Table·Modal 등의 재정의 (필요하면 PM에게 요청)
- 공통 디자인 문제를 발견하면 직접 고치지 않고 PM에게 공유합니다.
  - 예: `.container`의 `container-type` 때문에 `position: fixed` Modal이 본문 기준으로 배치되는 문제 (Home `home-city-modal`도 영향 가능)

## 16. 완료 조건

- [ ] `python app.py` 실행 후 로그인 → `/margin-calculator`가 오류 없이 열린다.
- [ ] 기본값에서 FOB 단가 **$2.15 / 개**, 원가 1,900원, 할인 후 영업마진 20.0%, 총 마진 32.8%가 표시된다.
- [ ] 원가·마진·인코텀즈·수량·환율을 바꾸면 4개 탭이 즉시 다시 계산된다.
- [ ] 마진율 ↔ 마크업, 항목별 ↔ 일괄, 부자재 사급, 로스율이 단가에 반영된다.
- [ ] CFR·CIF 선택 시 해상운임·보험 입력이 나타나고 단가에 더해진다.
- [ ] 역제안: 목표가에 따라 4단계 판정·Gauge·대응 방안이 바뀌고, 마진 직접 조정 결과가 바로 계산된다.
- [ ] 수량별 단가: MOQ 미만 할증/주문 불가가 차트·가격표에 반영되고, 가격표 복사가 동작한다.
- [ ] 환율 영향: Slider·시나리오 표·버틸 수 있는 환율이 계약 단가 기준으로 계산된다.
- [ ] 견적서 PDF 팝업에 회사명과 로그인 담당자가 자동으로 채워지고, 필수값 누락 시 오류가 표시된다.
- [ ] PDF 다운로드 시 A4 한 장의 회사 양식 견적서가 저장되고, 표·합계·영문 금액이 화면 견적과 일치한다.
- [ ] 로그인하지 않은 상태의 API 호출은 로그인 화면으로 이동한다.
- [ ] 본문 폭 880px 이하에서 1열로 바뀌고 가로 스크롤 없이 사용할 수 있다.
- [ ] `src/03_margin/`, `app.py [C]` 영역 외 파일 변경이 없다. (`git status` 확인)
- [ ] 페이지 CSS의 class·id는 `margin-` 접두사, 색·간격은 CSS Variable, 굵기는 3종 Variable만 사용한다.
