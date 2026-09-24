# 원가 경쟁력 및 마진 시뮬레이션

> 담당: C · 기능 요구사항은 이 문서가 최우선입니다. 디자인·공통 UI는 `docs/design_system.md`, `docs/ui_components.md`를 따릅니다.

| 버전 | 날짜 | 변경 내용 | 작성 |
|---|---|---|---|
| 2.0 | 2026-09-23 | 화면 전면 재구성(견적 계산 / 역제안 분석 / 수량별 단가 / 환율 영향 4개 탭) 및 견적서 PDF 팝업 기준으로 명세 작성 | C |
| 2.1 | 2026-09-24 | 물류비 약식 CBM 추정(접이식), 역제안 사양 변경(VE) 추천·영업 승인 가이드라인(R&R) Badge, '내부·대외 비교'를 견적서 발행 옵션으로 편입, 영문 이메일 제안문 복사 | C |
| 2.2 | 2026-09-24 | 수량별 단가: 견적 수량 추가 입력칸, 막대 차트와 가격표를 '수량별 단가표' 한 Card로 통합(단가 칸 안 가로 막대, MOQ 수량 옆 MOQ 표시), 입력·표 정렬 정리 | C |

## 1. 페이지 목적

화장품 OEM·ODM 해외영업 담당자가 **제조원가 → 수출 단가 → 바이어 역제안 대응 → 수량별 가격표 → 환율 리스크 → 견적서 PDF 발행**까지 한 화면에서 끝낼 수 있게 하는 원가·마진 시뮬레이터입니다.

- 원가(원재료·임가공·부자재)와 단계별 마진(1차 마진 · 물류 마진 · 영업마진)을 넣으면 인코텀즈별 USD 단가를 즉시 계산해요.
- 바이어가 목표가를 제시하면 "수락 / 영업마진 양보 / 1차·물류 마진 조정 / 불가" 중 어디에 해당하는지 판정하고, 재역제안 가격과 대응 방안을 보여줘요.
- 수량 할인 구간과 MOQ 정책으로 바이어용 가격표를 만들고, 결제 시점 환율 변동이 마진에 주는 영향을 확인해요.
- 계산 결과를 회사 양식(A4) 견적서 PDF로 바로 내려받고, 바이어에게 보낼 영문 커버레터를 복사해요.
- 무거운 계산 대신 **실무 약식(휴리스틱)** 을 씁니다. 물류비는 카톤 수·CBM으로, 사양 변경(VE)은 개당 절감 하한값으로 빠르게 가늠하고, 값은 언제든 직접 고칠 수 있어요.

## 2. 담당 파일

| 파일 | 역할 |
|---|---|
| `src/03_margin/margin.html` | 화면 템플릿 (`common/base.html` 상속), 견적서 PDF 팝업(Modal) 포함 |
| `src/03_margin/margin.css` | 이 페이지 전용 스타일 (`margin-` 접두사, CSS Variable만 사용) |
| `src/03_margin/margin.js` | 모든 계산·렌더링·이벤트 (IIFE, 전역 변수 없음) |
| `src/03_margin/margin.md` | 이 기능 명세서 |
| `src/03_margin/service.py` | 견적서 PDF: 회사 정보(`COMPANY`), 입력 검증, 합계 재계산, 영문 금액 표기, PDF 생성 / 현재 USD/KRW 환율 조회(10분 캐시) |
| `src/03_margin/margin_quote_document.html` | 견적서 PDF 전용 문서 템플릿 (xhtml2pdf용, base.html 비상속) |
| `app.py` | `# [C]` 주석 아래 Backend Route 2개만 |

## 3. URL

| URL | Method | endpoint | 설명 |
|---|---|---|---|
| `/margin-calculator` | GET | `margin` | 페이지 (PM 관리 Route, 로그인 필요) |
| `/api/margin-calculator/quote-profile` | GET | `margin_quote_profile` | 견적서 팝업 자동 연동 값 (우리 회사 정보 + 로그인 담당자) |
| `/api/margin-calculator/quote-pdf` | POST | `margin_quote_pdf` | 견적서 PDF 생성·다운로드 |
| `/api/margin-calculator/fx-rate` | GET | `margin_fx_rate` | 현재 USD/KRW 환율 (기준 환율 옆 표시·적용용) |

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
| 좌측 입력 › **약식 포장/CBM 추정** | 접이식(`<details>`) 보조 도구. 단품 프리셋 → 카톤 수·CBM 자동 산출 → **운임 반영** 버튼으로 FOB 물류비·해상운임 칸에 기본값 채움 (수동 수정 가능) |
| **견적 계산** | 인코텀즈별 USD 단가(대표 수치), 단가 구성 막대(원가·1차 마진·물류비·물류 마진·영업마진·할인·할증), 핵심 지표 4개, 상세 탭 2개 |
| └ 항목별 원가 | 원재료·임가공·부자재·물류비의 원가 / 마진율 / 공급가 / 마진 표 |
| └ 견적서 | 통합형 / 분리형 / 오픈북형 미리보기, **원가 구성 숨김 / 마진 흡수 발행** 옵션(체크 시 흡수 Slider와 내부·대외 비교 표 노출), **견적서 PDF** 버튼 → 팝업에서 고객사 정보 입력 후 PDF 다운로드 → 완료 안내 + **영문 이메일 제안문 복사** |
| **역제안 분석** | ① 상단 Card: 목표가·항목별 최소 마진 입력 + 종합 판정(판정·R&R Badge, 영업마진, 부족/여유 금액) + 가격 위치 Gauge / ② 중단 2분할: **사양 변경(VE) 추천** \| **마진 직접 조정** (둘 다 상단 판정·Gauge에 즉시 반영) / ③ 대응 방안 카드 한 줄 |
| **수량별 단가** | MOQ·MOQ 미만 정책(소량 할증 / 주문 불가), **견적 수량 추가** 입력칸, 막대와 가격표를 합친 **수량별 단가표**(단가 칸 안 가로 막대, MOQ 수량 옆 `MOQ` 표시, 편집 가능), 바이어용 가격표 텍스트 복사, **영문 이메일 제안문 복사** |
| **환율 영향** | ① 상단 Card: 계약 단가 · 결제 시점 환율(직접 입력 ↔ Slider) → 핵심 결과 3분할(실현 영업마진 · 환차손익 · 방어 단가) → 마지노선 환율 칩 3개 / ② 하단 Card: 환율 변동 시나리오 표(항상 표시) |

## 6. 사용자 입력

### 6.1 공통 입력 (좌측 입력 Card + 상단 기준 환율)

| 항목 | id | 단위 | 기본값 | 규칙 |
|---|---|---|---|---|
| 기준 환율 USD/KRW | `margin-fx` | 원 | 1400 | > 0 (상단 Tab Card 우측). 라벨 `기준 환율` 아래 알약 버튼 `TTB 1,351.1`(`margin-fxlive-apply`)을 누르면 현재 USD TTB(소수 1자리)로 바뀜 |
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

**약식 포장/CBM 추정** (`details#margin-cbm`, 기본 접힘 — 접힌 상태에서도 제목 아래에 `250카톤 · 6.25 CBM` 요약 표시)

| 항목 | id | 단위 | 기본값 | 규칙 |
|---|---|---|---|---|
| 단품 용량/형태 프리셋 | `margin-cbm-preset` | - | 토너/에센스 100~150ml | 선택 시 아래 입수·부피를 프리셋 값으로 덮어씀 |
| 카톤당 입수 | `margin-cbm-ea` | ea | 40 | > 0 (토너/에센스 40 · 크림/단지 50ml 60 · 마스크팩 200) |
| 카톤 부피 | `margin-cbm-box` | CBM | 0.025 | > 0 (세 프리셋 모두 0.025, 수동 수정 가능) |
| 내륙·통관 단가 | `margin-cbm-inland` | 원/CBM | 150,000 | ≥ 0 (트럭·CFS·THC·통관을 묶은 약식 단가) |
| LCL 해상운임 | `margin-cbm-lcl` | $/CBM | 50 | ≥ 0 |

### 6.2 탭별 입력

| 탭 | 항목 | id | 기본값 |
|---|---|---|---|
| 견적 계산 › 견적서 | 형식 | `margin-seg-qmode` | 통합형 |
| 견적 계산 › 견적서 | 원가 구성 숨김 / 마진 흡수 발행 | `margin-abs-on` | 해제 (해제 시 흡수액 0으로 계산) |
| 견적 계산 › 견적서 | 원가·물류비에 흡수할 금액 (Slider, 옵션 체크 시에만 표시) / 표시 통화 | `margin-abs-c` / `margin-abs-l` / `margin-seg-absunit` | 0원 (최대 = 총 마진) / 원화 |
| 역제안 분석 | 바이어 목표가 / 항목별 최소 마진 | `margin-target` / `margin-item-floor` | $1.95 / 5% |
| 역제안 분석 | 항목별 조정 마진율 | `margin-adj-raw` / `-proc` / `-pack` / `-logi` | 현재 마진율 |
| 역제안 분석 › VE | 코팅/후가공 생략 · 단상자 평량/단일도수 · 부자재 사급 전환 | `margin-ve-coat` / `-box` / `-sagup` | 해제 (항상 표시, 입력에서 이미 사급이면 사급 전환은 비활성) |
| 수량별 단가 | MOQ / MOQ 미만 정책 / 소량 할증률 | `margin-moq` / `margin-seg-moqmode` / `margin-moq-sur` | 5000 / 소량 할증 / 10% (주문 불가면 할증률 칸 비활성) |
| 수량별 단가 | 견적 수량 추가 | `margin-qty-add` + `margin-qty-add-btn` (Enter 가능) | 비어 있음 |
| 수량별 단가 | 가격표 행 (수량, 물류비 총액) | 표 안 입력 | 3천·5천·1만·2만·5만개 |
| 환율 영향 | 계약 단가 / 현재 견적 단가 사용 | `margin-fx-contract` / `margin-fx-use-quote` | 체크(견적 단가 연동) |
| 환율 영향 | 결제 시점 환율 (직접 입력 / Slider, 양방향 연동) | `margin-fx-settle-input` / `margin-fx-settle` | 기준 환율, 범위 ±10% (최소·목표 환율 포함, 최대 ±20%) |

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
| 버튼 | 영문 이메일 제안문 복사 / 닫기 / PDF 다운로드 | `margin-copy-mail` / `data-modal-close` / `margin-q-pdf` | | PDF 저장 후 `#margin-q-done` 완료 안내 표시 |

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

목표가 t(USD)를 원화 FOB 기준 T로 되돌린 뒤(CIF 보험·해상운임 제외) 네 기준가와 비교합니다. 기준가·판정·Gauge는 `priceLines()` / `zoneOf()` / `drawGauge()`로 묶여 있어 VE·마진 조정을 적용한 시뮬레이션 결과도 같은 로직으로 계산합니다.

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

**화면 3단계**

1. **상단 Card — 바이어 목표가 위치 및 판정 구간**: 왼쪽 입력(`margin-target`, `margin-item-floor`, `라벨 | 입력` 2행), 오른쪽 종합 판정 박스(`#margin-verdict`), 아래 Gauge(`#margin-gauge`), 그 아래 한 줄에 판정 구간 범례와 시뮬레이션 적용 안내(`#margin-gauge-note`). Gauge 아래 여백은 기준가 라벨이 두 줄로 겹칠 때만(`.has-row2`) 늘립니다. 판정 문구·R&R Badge·부족 금액은 이 박스 한 곳에만 표시합니다.
2. **중단 2분할** — 왼쪽 **사양 변경(VE) 추천**, 오른쪽 **마진 직접 조정**. 둘을 합친 시뮬레이션 결과가 상단 판정·Gauge에 즉시 반영되고, 각 Card 하단에는 한 줄 요약(선택 절감액 / 조정 합계·조정안의 최소 마진 단가)만 둡니다. (기존 조정 결과 박스와 VE 결과 박스·VE 전용 Gauge는 상단과 중복되어 제거)
3. **하단 Card — 대응 방안**: 카드 2~4개를 한 줄(열 균등)로 배치합니다. 본문 폭 880px 이하에서는 2열.

**시뮬레이션 (VE + 마진 직접 조정)**

```
조정 마진율   rates_k = 입력한 조정값 ?? 현재 마진율_k          (k = 원재료·임가공·부자재·물류)
              VE 사급 전환 체크 시 rates_pack = 0
부자재 원가   pack′ = max(0, 부자재 원가 − VE 차감액(코팅 30 + 단상자 20))
r′            = forward({ ...p, pack: pack′, rates })
P′            = priceLines({ ...p, pack: pack′, rates }, r′)
영업마진′     m′ = 1 − r′.P2 / T               판정′ = zoneOf(t, P′)
부족/여유     gap = r′.P2 − supMaxFor(T, 최소 영업마진)     (+ 부족 / − 여유, 개당 공급가 기준)
```

- 시뮬레이션이 없으면(`|r.P2 − r′.P2| < 0.5원`) 판정 박스: 판정 Badge + R&R Badge / `영업마진 11.9%` + `84원 부족`(danger) 또는 `N원 여유`(success) / 판정 설명.
- 시뮬레이션이 있으면: 판정이 바뀐 경우 `현재 Badge → 적용 후 Badge`, `영업마진 11.9% → 16.3%`, 부족/여유는 적용 후 기준, 설명 줄은 `VE −59원 · 마진 조정 −63원 적용 · 최소 영업마진을 지키는 단가 $1.92`. Gauge는 적용 후 기준선으로 다시 그리고 위에 `VE·마진 조정 적용 후 기준선 (적용 전 최소 마진가 $2.02)` 안내를 붙입니다.
- 마진 직접 조정 행: `원재료 / 현재 20.0% · −63원` + 조정 입력칸. 조정된 행은 `.margin-adj-row.is-changed`(연한 파랑 배경)로 표시합니다. 행의 금액은 조정만의 효과(VE 제외)입니다.
- R&R Badge는 시뮬레이션 적용 후 영업마진 `m′`로 판단합니다. (없으면 `m′ = m`)
- 대응 방안: ① 재역제안(최소 마진가) ② 목표가에서 최소 영업마진을 지키는 1차·물류 공통 마진율 ③ EXW 전환 단가 ④ 다음 할인 구간 수량 단가(물류비는 수량 비례의 85%로 가정). 목표가가 최소 마진가보다 낮으면 ①을 강조합니다.

**영업 승인 가이드라인 (R&R)** — 목표가에서 남는 영업마진(판매가 대비, 시뮬레이션 적용 시 `m′`)으로 판단하며 상단 판정 박스에만 붙습니다.

| 조건 (기본값 목표 20% / 최소 15%) | Badge |
|---|---|
| m ≥ 목표 | 없음 (담당자 진행) |
| 최소 ≤ m < 목표 | `badge-info` "팀장 전결 가능 (승인 권장)" |
| m < 최소 | `badge-danger` "본부장/임원 특별 승인 필요 (마진 방어 필수)" |

- 목표·최소는 좌측 입력값을 따르며, 마크업 방식이면 `toSale()`로 판매가 대비로 바꿔 비교합니다.

**사양 변경(VE) 추천** — 중단 왼쪽에 항상 표시합니다. 판정이 orange·red면 Card 설명이 "마진만으로 맞추기 어려워요", 그 외에는 "지금은 마진만으로 대응 가능해요"로 바뀝니다.

| 팁 | 약식 절감 (개당) | 계산 반영 |
|---|---|---|
| 부자재 코팅/후가공 생략 | −30~50원 | 보수적으로 **하한 30원**을 부자재 원가에서 차감 |
| 단상자 지류 평량 변경 / 단일도수 인쇄 | −20원 | 부자재 원가에서 20원 차감 |
| 부자재 사급 전환 검토 | 부자재 1차 마진 (`supply.pack − items.pack`) | 부자재 마진율 0% |

- Card 하단 요약: `선택 절감 개당 −59원 · 주문 전체 약 −588,235원 (약식 추정, 공급사 확인 필요)`, 선택 없으면 `선택한 사양 변경 없음`. 판정·Gauge 반영은 위 시뮬레이션에서 마진 조정과 함께 계산합니다.

### 7.4 수량별 단가

- 가격표의 각 행(수량, 물류비 총액)으로 7.2를 다시 계산합니다.
- MOQ 미만: "소량 할증"이면 할증 적용, "주문 불가"면 단가 대신 "주문 불가"로 표시하고 복사 대상에서 제외합니다.
- 요약: MOQ 수량 단가와 가장 낮은 단가, 그 차이(%)와 할인 후 영업마진.
- 견적 수량 추가: 입력한 수량으로 행을 추가합니다. 물류비 총액은 표에서 수량이 가장 가까운 행(로그 거리 기준)을 골라 `물류비 × (새 수량 ÷ 그 수량)^0.75`를 1만원 단위로 반올림해 채웁니다(최소 1만원, 수량이 늘수록 개당 물류비가 줄어드는 약식). 채운 값은 표에서 바로 고칠 수 있습니다.
- 단가 막대: 주문 가능한 행 중 최저 단가를 35%, 최고 단가를 100% 길이로 선형 배치해 작은 차이도 눈에 보이게 합니다. 색은 현재 주문 `is-cur`, 다른 수량 `is-other`, MOQ 미만 `is-hatch`(빗금).
- MOQ와 같은 수량의 행은 수량 입력칸 바로 옆에 `MOQ` 표시(`.margin-qtable__moq`)를 붙입니다. MOQ 미만 행은 빗금 막대로 구분합니다.
- 정렬: 모든 칸의 첫 줄을 입력칸 높이(44px, `.margin-qtable__line`)에 맞추고, 개당 물류·할인/할증·주문 총액은 그 아래 보조 줄에 둡니다. 표 안 숫자 입력은 스핀 버튼을 숨깁니다.

### 7.5 환율 영향

```
FOB 달러 단가  fobU = 계약단가 (CIF면 ÷ (1 + 1.1 × 보험요율), CFR·CIF면 − 해상운임/수량)
원화 매출      rev(f) = fobU × f
영업마진       m2(f)  = 1 − P2 / rev(f)
마지노선 환율  목표 = P2 / (1 − toSale(목표)) / fobU,  최소 = P2 / (1 − toSale(최소)) / fobU,  손익분기 = (C + L) / fobU
환차손익       pnl = (rev(f) − rev(견적 환율)) × 수량
방어 단가      need = P2 / (1 − toSale(목표)) / f  (+ CFR·CIF 해상운임/수량, CIF 보험)   ← 결제 환율 f에서 목표 영업마진을 지키려면 바이어에게 요구할 USD 단가
```

- Slider 범위(실무 기준): 견적~결제 1~3개월 사이 원/달러 변동을 보수적으로 본 **기준 환율 ±10%**. 최소·목표 마진 환율이 그 밖이면 `× 0.97` / `× 1.03` 여유를 두고 포함하도록 넓히되 **±20%까지만**, 10원 단위(step 5원). 손익분기 환율은 현실적 변동폭 밖인 경우가 많아 범위에 넣지 않고 칩으로만 보여줍니다. 시나리오 표는 −10% / −5% / 0 / +5% / +10%입니다.
- **① 상단 Card — 입력과 결과를 한 Card 안에서**
  1. 입력: 왼쪽 계약 단가(+ 현재 견적 단가 사용), 오른쪽 결제 시점 환율 입력칸 + 변동률 + `견적 환율로` 버튼, 그 바로 아래 Slider와 범위 끝 값.
     입력칸에 숫자를 넣으면 즉시 `st.fxSettle`에 반영되어 Slider·결과·시나리오 표가 다시 그려지고, Slider를 움직이면 입력칸 값이 바뀝니다. 입력 중(포커스)에는 입력칸을 덮어쓰지 않고, 입력을 마치면(`change`) Slider 범위 안 값으로 정리합니다.
     Slider 트랙이 곧 **위험/안전 게이지**입니다. margin.js가 `--margin-fxrange-bg`로 트랙을 최소 · 목표 환율 경계로 나눠 칠하고, 손잡이가 현재 결제 환율 위치를 가리킵니다. 트랙은 3구간 단색입니다: 최소 마진 환율 미만 빨강(`--margin-fxrange-bad`, 손익분기 미만 포함) / 최소~목표 주황(`--margin-fxrange-warn`) / 목표 이상 초록(`--margin-fxrange-good`). 세 색은 `.margin-page`에서 `--color-danger / -warning / -success`의 밝기·채도만 올린 맑은 색(상대 색 문법 `oklch(from …)`)입니다. (별도 게이지 막대 없음)
  2. 핵심 결과 3분할(연한 박스 `.margin-kpi` 3개, 배경 `--color-background`):
     - 실현 영업마진 `m2(f)` + 판정 Badge(목표 마진 유지 / 최소 마진 이상 / 최소 마진 미달 / 영업 손실)
     - 환차손익 총액 `pnl` — 이익 `text-up`(빨강 ▲ +), 손실 `text-down`(파랑 ▼ −), 0이면 `±0원`. 보조 줄에 견적 환율 대비 개당 금액.
     - 방어 단가 `need` — 보조 줄에 `목표 마진 20% 유지 · 현재보다 +$0.16` 또는 `현재 단가로 달성`.
  3. 마지노선 환율 칩(구 '버틸 수 있는 환율'): `손익분기 940원` · `최소 마진(15%) 1,316원` · `목표 마진(20%) 1,398원`. 색 점은 판정 구간 색, 견적 환율에서 이미 미달이면 숫자를 `--color-danger`로 표시.
- **② 하단 Card — 환율 변동 시나리오 표**: 환율별 마진 그래프 없이 표만 항상 보여줍니다. 견적 환율 대비 −10% / −5% / 0 / +5% / +10% 행의 환율 · 개당 원화 · 영업마진(판정 Badge) · 주문 영업이익.

### 7.6 물류비 약식 계산 (CBM 추정)

```
카톤 수        = ⌈주문수량 ÷ 카톤당 입수⌉
CBM            = 카톤 수 × 카톤 부피
청구 CBM       = max(1, CBM)                         (LCL 최소 1 CBM 관행)
FOB 내륙물류비 = 청구 CBM × 내륙·통관 단가  → 1만원 단위 반올림
해상운임 총액  = 청구 CBM × LCL 운임        → $1 단위 올림
```

- 기본값(10,000개, 토너 프리셋): 250카톤 · 6.25 CBM → 내륙 940,000원 · 해상 $313.
- 주문수량·프리셋을 바꾸면 추정치는 즉시 다시 계산되지만, `margin-logi` / `margin-freight` 칸은 **운임 반영** 버튼을 눌렀을 때만 바뀝니다. 반영 후에도 두 칸은 직접 수정할 수 있습니다.
- 해상운임은 FOB·EXW에서도 칸에 채워지며, CFR·CIF를 고를 때 단가에 더해집니다.
- CBM이 15 이상이면 "20ft 컨테이너(FCL) 견적과 비교해 보세요." 안내를 보여줍니다.

### 7.7 견적서 발행 옵션 (원가 구성 숨김 / 마진 흡수)

- `margin-abs-on`을 체크하면 흡수 Slider·통화 전환·내부 원가표 / 대외 견적 표가 나타나고, 흡수액이 분리형(물류 행)·오픈북형(원가 구성)에 반영됩니다. 통합형 단가는 바뀌지 않습니다.
- 해제하면 Slider 값은 보존하되 계산에는 0원으로 들어갑니다.

### 7.8 영문 이메일 제안문

견적서 PDF 팝업의 **영문 이메일 제안문 복사**(`margin-copy-mail`)와 수량별 단가 탭 가격표 Card의 같은 버튼(`margin-copy-mail-tier`)이 같은 텍스트를 클립보드에 복사합니다. 복사 전에 `quote-profile`을 한 번 불러와 우리 회사·담당자를 채웁니다.

```
Subject: Quotation QT-20260924-01 - Toner 150ml (FOB)

Dear Glow Beauty Inc.,                         ← 담당자(Attn.)가 있으면 담당자 이름

Thank you for your interest in our products. Please find the attached official quotation QT-20260924-01 for Toner 150ml.

- Unit price: $2.15 per pc (FOB Korea)         ← 지정 장소 없으면 EXW·FOB: Korea / CFR·CIF: Port of destination
- Quantity: 10,000 pcs (Total $21,500.00)
- MOQ: 5,000 pcs
- Volume pricing: 5,000 pcs $2.23 / 20,000 pcs $2.08 / ...   ← 가격표 중 MOQ 이상, 현재 수량 제외
- Payment: T/T
- Lead time: ...                               ← 입력했을 때만
- Validity: 30 days from 2026-09-24

Please feel free to contact us if you have any questions. We look forward to your feedback.

Best regards,
<담당자> / <회사명> / <담당자 이메일>
```

- 팝업 값이 비어 있으면 `[Customer]`, `[Quotation No.]`, `[Product]` 등 자리표시로 남겨 붙여넣은 뒤 채울 수 있게 합니다.
- 수량 할인이 들어간 단가면 `Volume discount of 3.0% is included in the unit price.` 문장을 추가합니다.

### 7.9 견적서 PDF

1. **견적서 PDF** 버튼 → 공통 Modal(`data-modal-open`)이 팝업을 엽니다. 처음 열 때 `quote-profile`을 불러와 회사명·담당자를 채웁니다.
2. 필수값 확인 → 견적 계산의 형식별 품목(`st.quote`)과 팝업 입력값을 JSON으로 `quote-pdf`에 POST 합니다.
3. 서버: `build_quote_context()` 검증 → 합계 재계산 → `margin_quote_document.html` 렌더 → `html_to_pdf()` → `Quotation_<견적번호>.pdf` 첨부 응답.
4. 브라우저: Blob으로 내려받고, 팝업을 닫지 않고 완료 안내(`#margin-q-done`, `.alert-success`)를 보여줘 **영문 이메일 제안문 복사**로 이어지게 합니다. 팝업을 다시 열면 안내는 숨겨집니다.

## 8. 출력 결과

| 위치 | 출력 |
|---|---|
| 좌측 입력 › CBM 추정 | 요약(카톤 수 · CBM), 카톤 수 / CBM / FOB 내륙물류비 / 해상운임(LCL), 최소 1 CBM·FCL 안내 |
| 견적 계산 | 인코텀즈 단가(`kpi-value-lg`), 원화 단가·주문 총액, 할인/할증/MOQ Badge, 구성 막대, Stat Tile 4개, 항목별 원가 표, (발행 옵션 체크 시) 내부·대외 비교 표 2개, 견적서 미리보기 |
| 역제안 분석 | 상단: 종합 판정 박스(판정 Badge(→ 적용 후 Badge) + R&R Badge / 영업마진(→ 적용 후) + 부족·여유 금액 / 설명) + Gauge(적용 후 기준선 안내) / 중단: VE 체크리스트 + 절감 요약, 마진 조정 4행 + 조정 합계 요약 / 하단: 대응 방안 카드 2~4개 한 줄 |
| 수량별 단가 | 요약 박스, 수량별 단가표: 수량 · 물류비 총액(+ 개당 물류) · 단가 막대(+ 현재 주문/할인/할증 · 주문 총액) · 영업마진 Badge · 삭제 |
| 환율 영향 | 상단 Card: 결제 환율 입력·변동률·Slider(트랙 = 위험/안전 구간 색, 손잡이 = 현재 환율), 결과 박스 3개(실현 영업마진+Badge · 환차손익 총액 · 방어 단가), 마지노선 환율 칩 3개 / 하단 Card: 환율 변동 시나리오 표 |
| 가격표 복사 | 영문 텍스트: `Price list (FOB Korea, USD per pc)` / `MOQ: 5,000 pcs` / `10,000 pcs : $2.15 (volume discount 3%)` … |
| 영문 이메일 제안문 복사 | 7.8의 커버레터 텍스트 (Subject 포함) |
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

### 9.3 `GET /api/margin-calculator/fx-rate`

```json
{ "rate": 1351.12, "source": "ExchangeRate-API 중간값 × 0.99 (추정 TTB)", "as_of": "2026-09-24 09:02" }
```

| 응답 | 내용 |
|---|---|
| 200 | 현재 USD/KRW **TTB(전신환 받으실 때)**. `source`는 `한국수출입은행 TTB(전신환 받으실 때)`(as_of = 고시일 `YYYY-MM-DD`) 또는 `ExchangeRate-API 중간값 × 0.99 (추정 TTB)`(as_of = 갱신 시각 KST) |
| 502 | `{"error": "현재 환율을 불러오지 못했어요."}` — 두 소스 모두 실패 |

- 수출 시뮬레이션이므로 매매기준율(`deal_bas_r`)이 아니라 수출 대금을 원화로 받을 때 적용되는 **TTB**를 씁니다.
- 조회 순서: ① 한국수출입은행 현재환율 API(`EXIM_API_KEY`가 있을 때, USD `ttb`의 쉼표를 지우고 float 변환, 휴일·11시 이전이면 최대 7일 전 영업일까지) → ② ExchangeRate-API 공개 엔드포인트(`https://open.er-api.com/v6/latest/USD`, 키 없음)의 시장 중간값 × 0.99(`TTB_FROM_MID`, 수출입은행 USD 전신환 스프레드 1%)로 **추정 TTB**. 요청 timeout 5초.
- 홈 담당 DB(`exchange_rates`)는 매매기준율만 저장하므로 TTB 조회에 쓰지 않습니다. (홈 코드·DB는 읽지도 수정하지도 않음)
- 두 소스 모두 **하루 1회 고시·갱신 값**이라 초 단위 실시간은 아닙니다. 화면에는 `TTB 1,351.1`(소수 1자리)로 표시하고 정확한 값·소스·기준 시각은 마우스를 올리면(`title`) 보여줍니다.
- 결과는 서버 메모리에 10분 캐시하고, 화면은 페이지 로드 시와 10분마다 다시 불러옵니다.

### 9.4 외부 데이터

- 현재 환율만 외부 API를 씁니다(9.3). 한국수출입은행 API Key는 `.env`의 `EXIM_API_KEY`(홈과 같은 키)를 `os.getenv()`로 읽고, 없으면 키가 필요 없는 ExchangeRate-API 중간값으로 TTB를 추정합니다. 계산에 쓰는 기준 환율은 여전히 사용자가 입력하며, [적용]을 눌렀을 때만 현재 환율로 바뀝니다.
- CBM 단가·VE 절감액은 사용자 입력 또는 약식 기본값입니다.
- 패키지: `xhtml2pdf`, `requests` (requirements.txt에 이미 있음).
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
| 환율 탭 계약 단가 미입력 | 상단 Card `#margin-fx-err`에 "계약 단가를 입력하세요.", 결과 갱신 중단 |
| 결제 시점 환율 입력이 비었거나 0 이하 | 값 반영 안 함, 입력을 마치면 현재 결제 환율로 되돌림 |
| 결제 시점 환율이 Slider 범위 밖 | 범위 끝 값으로 계산하고 입력을 마치면 그 값으로 표시 |
| 가격표 수량·물류비 ≤ 0 | 값 반영 안 함. 행은 최소 1개 유지 (1개 남으면 삭제 버튼 비활성) |
| 견적 수량 추가: 빈 값·0 이하 / 이미 있는 수량 | 입력칸 아래 `.form-error` "0보다 큰 수량을 입력하세요." / "10,000개는 이미 표에 있어요." |
| MOQ·할증률 음수 | 값 반영 안 함 |
| 목표가가 원가+물류비보다 낮음 | "원가와 물류비보다 낮은 가격이에요" 판정 |
| 내부·대외 비교에서 흡수액 > 총 마진 / 원가 +20% 초과 | "마진 초과 흡수"(danger) / "원가 +20% 초과"(warning) Badge |
| 클립보드 복사 불가 | `window.prompt`로 텍스트 표시 (가격표·영문 제안문 공통 `copyText()`) |
| CBM 추정 입수·부피 ≤ 0, 단가 < 0 또는 빈 값 | 추정 영역에 `.form-error` 문구, **운임 반영** 버튼 비활성 |
| CBM < 1 | 운임은 최소 1 CBM으로 계산하고 안내 문구 표시 |
| VE: 입력에서 이미 부자재 사급 | 사급 전환 체크박스 비활성, "입력에서 이미 부자재 사급으로 계산 중이에요." |
| VE: 차감액 > 부자재 원가 | 부자재 원가를 0원까지만 낮춤 |
| 영문 제안문: 팝업 값 비어 있음 | `[Customer]` 등 자리표시로 복사 |
| 팝업 필수값 누락 | 해당 칸 `.is-error` + 팝업 하단 오류 문구, 첫 칸에 Focus. 서버도 400으로 다시 검증 |
| 팝업 자동 연동 실패 / 세션 만료 | "회사 정보를 불러오지 못했어요…" / "로그인이 만료됐어요. 다시 로그인해 주세요." |
| 텍스트 200자 초과, 품목 20개 초과, 숫자 형식 오류 | 서버 400 + 항목명이 들어간 오류 문구 |
| PDF 생성 실패 | 500 "PDF 를 만들지 못했어요." — 버튼 로딩 해제, 팝업 유지 |
| 현재 환율 조회 실패 / 세션 만료 | 알약 버튼이 `TTB 없음`으로 바뀌고 비활성. 10분 뒤 자동 재시도 |
| 기준 환율이 이미 현재 TTB와 같음 | 알약 버튼이 `TTB 1,351.1 ✓`로 바뀌고 비활성 |

## 12. UI 구성

```
.margin-page#margin-app
 ├─ .page-header  h1.page-title / p.page-description / .page-actions(← 홈으로 .btn-surface)
 └─ .margin-layout (360px + 1fr, 본문 폭 ≤ 880px에서 1열)
     ├─ aside.card.margin-inputs (Desktop sticky)
     │    원가와 1차 마진 / 영업마진 / 물류와 수량(+ details.margin-drawer#margin-cbm) / 수량 할인 구간 (.margin-group, 구분선)
     └─ .margin-results
          ├─ .card.card-sm.margin-toolbar : .tabs(견적 계산·역제안 분석·수량별 단가·환율 영향) + .margin-fxbox(라벨 `기준 환율` + 알약 버튼 `TTB 1,351.1` | 기준 환율 입력, 툴바 한 줄 유지)
          ├─ .tab-panel#margin-view-forward : 대표 단가 Card / 상세 Card(.tabs 2개: 항목별 원가 · 견적서)
          │    └ 견적서: 형식 · 견적서 PDF / .form-check#margin-abs-on / .margin-abs-box(hidden) / 미리보기
          ├─ .tab-panel#margin-view-reverse : ① .card(.margin-rtop: 입력 | #margin-verdict → #margin-gauge → 범례·안내 한 줄) / ② .margin-rmid(VE .card | 마진 직접 조정 .card) / ③ 대응 방안 .card
          ├─ .tab-panel#margin-view-tier    : 한 줄 입력(MOQ · MOQ 미만 주문 · 할증률 · 견적 수량 추가, 모두 44px) / 한 줄 요약 / 수량별 단가표 Card(범례 · 가격표 복사 · 영문 이메일 제안문 복사, table.margin-qtable)
          └─ .tab-panel#margin-view-fx      : ① .card > .margin-fxdash(입력 2열 (Slider = input.margin-fxrange 게이지) → .margin-kpi 3분할 → .margin-chips) / ② .card(환율 변동 시나리오 표)
.modal-backdrop#margin-quote-modal > .modal.modal-lg  (우리 회사 / 고객사 / 견적 조건 / 완료 안내 .alert / 영문 이메일 제안문 복사 · 닫기 · PDF 다운로드)
```

- 공통 컴포넌트를 그대로 사용: `.card`, `.tabs`/`.tab`/`.tab-panel`(common.js `data-tab-target`), `.table`, `.badge`, `.stat-tile`, `.kpi-*`, `.input-group`, `.form-control(-sm)`, `.form-check`, `.btn`, `.alert`, `.modal`, `.spinner`.
- 접이식 CBM 추정은 별도 JS 없이 네이티브 `<details>`/`<summary>`를 쓰고 모양만 `.margin-drawer*`로 지정합니다. 표시·숨김이 필요한 영역(흡수 옵션, 완료 안내)은 `hidden` 속성으로 토글하고, class의 `display`에 덮이지 않도록 `.margin-page [hidden]`, `#margin-quote-modal [hidden]`을 지정합니다.
- Panel 없이 값만 고르는 버튼 묶음(항목별/일괄, 마진율/마크업 등)은 `.tabs.margin-seg`로 모양만 쓰고 `.is-active`는 margin.js가 토글합니다.
- 색·간격·글꼴은 CSS Variable만 사용합니다. 판정 4단계 색은 `--color-success / warning / danger`에서 파생한 `--margin-zone-*` 변수(`.margin-page` 범위)입니다.
- 이 페이지에는 SVG 차트가 없습니다. 수량별 단가 막대는 표 칸 안의 `.margin-qbar`(CSS 막대)로 그립니다.
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

@app.route("/api/margin-calculator/fx-rate", methods=["GET"])
@login_required
def margin_fx_rate(): ...                  # service.usd_krw_rate(), 실패 시 502
```

| service.py 함수 | 역할 |
|---|---|
| `quote_profile(user)` | `COMPANY` + 로그인 사용자 이름·이메일 |
| `build_quote_context(payload, user)` | 입력 검증(ValueError), 합계 재계산, 날짜·금액 서식, 템플릿 context 생성 |
| `amount_in_words(amount)` | `SAY US DOLLARS … AND CENTS … ONLY.` |
| `quote_filename(quote_no)` | 안전한 파일명 `Quotation_<번호>.pdf` |
| `html_to_pdf(html)` | xhtml2pdf 변환(리소스 정책 제한), 실패 시 RuntimeError |
| `usd_krw_rate()` | 현재 USD/KRW TTB (수출입은행 `ttb` → ExchangeRate-API 중간값 × 0.99 순, 10분 캐시), 모두 실패 시 RuntimeError |

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
- [ ] CBM 추정: 기본값에서 250카톤 · 6.25 CBM이 표시되고, **운임 반영** 시 FOB 물류비 940,000원 · 해상운임 $313이 채워지며 이후 직접 수정할 수 있다.
- [ ] 마진율 ↔ 마크업, 항목별 ↔ 일괄, 부자재 사급, 로스율이 단가에 반영된다.
- [ ] CFR·CIF 선택 시 해상운임·보험 입력이 나타나고 단가에 더해진다.
- [ ] 역제안: 목표가에 따라 4단계 판정·Gauge·대응 방안이 바뀌고, 기본값에서 `영업마진 11.9%` · `84원 부족` · 본부장/임원 Badge가 상단 판정 박스에 표시된다.
- [ ] 역제안: 목표~최소 영업마진 구간이면 "팀장 전결 가능", 최소 미만이면 "본부장/임원 특별 승인 필요" Badge가 보인다.
- [ ] 역제안: VE 체크나 마진 직접 조정을 바꾸면 상단 판정(Before → After)·부족/여유·Gauge가 즉시 바뀌고, 하단에 중복 결과 박스가 없다.
- [ ] 견적서 탭의 **원가 구성 숨김 / 마진 흡수 발행**을 체크해야 흡수 Slider·비교 표가 나타나고, 해제 시 분리형·오픈북형에 흡수가 반영되지 않는다.
- [ ] 수량별 단가: MOQ 미만 할증/주문 불가가 단가표(막대·MOQ 표시)에 반영되고, 가격표 복사가 동작한다.
- [ ] 수량별 단가: 견적 수량 추가에 30000을 넣으면 물류비가 채워진 행이 추가되고, 이미 있는 수량은 오류 문구가 뜬다.
- [ ] 환율 영향: Slider·시나리오 표·마지노선 환율이 계약 단가 기준으로 계산된다.
- [ ] 환율 영향: 결제 환율 입력칸과 Slider가 양방향으로 연동되고, 실현 영업마진·환차손익(손실 파랑 ▼ / 이익 빨강 ▲)·방어 단가가 즉시 바뀐다.
- [ ] 환율 영향: 환율별 마진 그래프 없이 시나리오 표가 항상 보인다.
- [ ] 견적서 PDF 팝업에 회사명과 로그인 담당자가 자동으로 채워지고, 필수값 누락 시 오류가 표시된다.
- [ ] PDF 다운로드 시 A4 한 장의 회사 양식 견적서가 저장되고, 표·합계·영문 금액이 화면 견적과 일치한다.
- [ ] PDF 저장 후 완료 안내가 보이고, 팝업·수량별 단가 탭의 **영문 이메일 제안문 복사**가 고객사·견적번호·품목·단가·MOQ가 들어간 커버레터를 복사한다.
- [ ] 로그인하지 않은 상태의 API 호출은 로그인 화면으로 이동한다.
- [ ] 기준 환율 라벨 아래 `TTB 1,351.1` 버튼을 누르면 기준 환율 칸이 바뀌며 4개 탭이 다시 계산되고 `✓`로 바뀐다. 조회 실패 시 `TTB 없음`으로 표시된다.
- [ ] 본문 폭 880px 이하에서 1열로 바뀌고 가로 스크롤 없이 사용할 수 있다.
- [ ] `src/03_margin/`, `app.py [C]` 영역 외 파일 변경이 없다. (`git status` 확인)
- [ ] 페이지 CSS의 class·id는 `margin-` 접두사, 색·간격은 CSS Variable, 굵기는 3종 Variable만 사용한다.
