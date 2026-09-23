# 개발요청서 자동변환 · 직접작성 시스템

## 1. 브리핑

해외영업 담당자가 바이어에게 받은 RFP, Product Brief, Development Brief 등의 파일을 업로드하면 문서의 정보를 자동으로 추출하고, 사내 연구소가 실제 제품 개발에 사용할 수 있는 `개발요청서` 형식으로 변환한다.

파일이 없는 경우에는 해외영업 담당자가 동일한 개발요청서를 직접 작성할 수 있다.

자동변환과 직접작성은 최종적으로 동일한 Development Request Schema를 사용하며, 작성된 개발요청서는 사용자가 확인 및 수정한 뒤 PDF 파일로 저장할 수 있다.

본 기능은 단순 번역기가 아니다.

핵심은 다음과 같다.

바이어 RFP
→ 전체 내용 분석
→ 개발에 필요한 정보 선별
→ 언어 변환
→ 사내 개발요청서 구조로 Mapping
→ 사용자 확인
→ 필요 시 수정
→ PDF 저장


---

# 2. 개발요청서 정보 공개 원칙

개발요청서는 바이어 RFP의 모든 정보를 연구소에 그대로 전달하는 문서가 아니다.

연구소가 처방 개발을 시작하고 방향을 판단하는 데 필요한 정보를 중심으로 구성한다.


## 연구소 개발요청서에 포함

- 고객사
- 제품명
- 제품 유형
- 목표 가격대
- 수출 대상국
- 수출 금지 원료
- 제품 설명
- 처방 가이드
- 벤치마크 제품명
- 컬러 / 쉐이드 벤치마크
- 제형 / 텍스처
- 사용감 / 외관
- 점도
- 향 / Flavor
- 피니시
- 커버력
- 필수 적용 원료
- 선호 원료
- 사용 타입
- 사용 방법
- 추가 참고사항
- 품질 관련 필요사항
- 참고 이미지 / 첨부자료


## 연구소 개발요청서에서 제외

다음 정보는 바이어 문서에 존재하더라도 연구소용 개발요청서에는 노출하지 않는다.

- Initial Order Quantity
- Annual Projection Quantity
- MOQ
- 거래 조건
- Incoterms
- 영업 단가
- 상세 Target Cost
- 영업 원가
- 마진

- Target Claims / Benefits
- RIPT
- Ocular Testing
- Sensory Testing
- Clinical Testing
- 기타 Claim / Efficacy Testing

즉,

`수량·거래조건·영업정보`

및

`클레임·효능 검증용 시험정보`

는 연구소용 개발요청서에서 제외한다.


## 선택적으로 관리

다음 정보는 개발요청서 작성의 필수값으로 사용하지 않는다.

- Target Fill Weight / 용량
- Primary Packaging
- Secondary Packaging
- Tertiary Packaging
- 용기 상세
- 패키징 상세
- Package Drop Test

원문에 존재하는 경우 Raw Data에는 보존할 수 있으나 개발요청서 작성을 위해 반드시 입력하도록 요구하지 않는다.


---

# 3. 전체 사용자 Flow

## 자동변환

STEP 1
파일 업로드
    ↓
자동 분석 및 변환
    ↓
STEP 2
개발요청서 Result
    ↓
┌───────────────┐
│               │
수정          PDF 저장
│
▼
STEP 3
개발요청서 수정
    ↓
수정 완료
    ↓
STEP 2


## 직접작성

STEP 1
직접 작성
    ↓
STEP 4
개발요청서 직접 작성
    ↓
작성 완료
    ↓
개발요청서 Result
    ↓
PDF 저장


---

# 4. STEP 1 — 시작 화면

기존 화면 구조를 유지한다.


┌───────────────────────────────────────────────────────────────────────┐
│ 개발요청서 분석                                                      │
│ 바이어 요청서를 변환하거나 직접 작성하여 개발팀에 전달합니다.       │
│                                                                       │
│ ┌──────────────────────────────────┐ ┌──────────────────────────────┐ │
│ │ 개발요청서 업로드               │ │ 변환 설정                    │ │
│ │                                  │ │                              │ │
│ │ 바이어에게 받은 요청서를        │ │ 고객사                       │ │
│ │ 올려주세요.                     │ │ [ 선택 ▼ ]                   │ │
│ │                                  │ │                              │ │
│ │ ┌──────────────────────────────┐ │ │ 원문 언어                    │ │
│ │ │                              │ │ │ [ 자동 감지 ▼ ]             │ │
│ │ │    파일을 업로드하세요       │ │ │                              │ │
│ │ │                              │ │ │         ↓                    │ │
│ │ │ PDF / DOCX / XLSX / 이미지  │ │ │                              │ │
│ │ └──────────────────────────────┘ │ │ 출력 언어                    │ │
│ │                                  │ │ [ 한국어 ▼ ]                 │ │
│ │ ───────── 또는 ─────────────── │ │                              │ │
│ │                                  │ │ 전달 대상                    │ │
│ │ [ 직접 작성해서 개발팀에       │ │ ☑ 연구소                     │ │
│ │   넘기기 → ]                    │ │ ☑ 공장                       │ │
│ └──────────────────────────────────┘ └──────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────┘


---

# 5. 파일 업로드 → STEP 2

파일 업로드 자체를 자동변환 Trigger로 사용한다.

별도의 `분석 시작` 버튼은 사용하지 않는다.


파일 업로드
    ↓
파일 인식
    ↓
문서 전체 정보 추출
    ↓
원문 언어 감지
    ↓
연구소 전달 대상 정보 선별
    ↓
출력 언어 변환
    ↓
개발요청서 Field Mapping
    ↓
STEP 2 자동 전환


처리 중:


개발요청서를 변환하고 있습니다.

✓ 파일 확인
✓ 문서 내용 추출
✓ 개발 항목 분류
✓ 언어 변환
● 개발요청서 작성 중


변환 완료 후 STEP 1 화면 아래에 결과를 붙이지 않는다.

페이지 자체가 STEP 2로 전환된다.


---

# 6. 다국어 처리

영어 → 한국어 전용으로 제한하지 않는다.


원문 언어
[ 자동 감지 ▼ ]

       ↓

출력 언어
[ 한국어 ▼ ]


예:

영어 → 한국어
중국어 → 한국어
일본어 → 한국어
프랑스어 → 한국어

한국어 → 영어
한국어 → 중국어
한국어 → 일본어


단순 직역보다 원문의 개발 의미를 유지하는 것을 우선한다.


---

# 7. RFP 자동변환 기본 원칙

원본 PDF의 섹션 구조를 참고하여 개발요청서를 구성한다.

원본 RFP:

01 Item
02 Pricing
03 Formula
04 Safety / Efficacy Testing
05 Quality Testing
06 Package Testing
07 Packaging
08 Reference


이를 연구소용 개발요청서로 변환할 때는 다음과 같이 재구성한다.


01 기본정보
02 제품 개발 요구사항
03 원료 요구사항
04 사용 정보
05 품질 확인사항
06 참고자료


즉 원문의 전체 구조를 무조건 복사하는 것이 아니라,

`원문의 의미와 항목 → 연구소 개발 목적에 맞는 구조`

로 변환한다.


---

# 8. 개발요청서 전체 화면 구조

STEP 2, STEP 3, STEP 4 모두 동일한 개발요청서 구조를 사용한다.


┌─────────────────────────────────────────────────────┬────────────────────────┐
│ 개발요청서                                         │ 문서 정보              │
│                                                     │                        │
│ 기본정보                                            │ 작성 방식              │
│                                                     │ 자동변환               │
│ 고객사                 제품명                       │                        │
│                                                     │ 입력 완료              │
│ 제품 유형              목표 가격대                  │ 14 / 18                │
│                                                     │                        │
│ 수출 대상국            수출 금지 원료               │ 확인 필요              │
│                                                     │ ⚠ 2건                 │
│ ───────────────────────────────────────────────── │                        │
│                                                     │ 벤치마크 제품명        │
│ 제품 개발 요구사항                                 │                        │
│                                                     │                        │
│ 제품 설명                                          │ 수출 검토              │
│ 처방 가이드                                        │                        │
│ 제품 특성                                          │                        │
│ 컬러/쉐이드 참고                                   │ 전달 대상              │
│                                                     │ 연구소 / 공장          │
│ ───────────────────────────────────────────────── │                        │
│                                                     │                        │
│ 원료 요구사항                                      │                        │
│                                                     │                        │
│ 필수 적용 원료                                     │                        │
│ 선호 원료                                          │                        │
│                                                     │                        │
│ ───────────────────────────────────────────────── │                        │
│                                                     │                        │
│ 사용 정보                                          │                        │
│                                                     │                        │
│ 사용 타입                                          │                        │
│ 사용 방법                                          │                        │
│ 추가 참고사항                                      │                        │
│                                                     │                        │
│ ───────────────────────────────────────────────── │                        │
│                                                     │                        │
│ 품질 확인사항                                      │                        │
│                                                     │                        │
│ 안정도                                             │                        │
│ 미생물                                             │                        │
│                                                     │                        │
│ ───────────────────────────────────────────────── │                        │
│                                                     │                        │
│ 참고자료                                           │                        │
│                                                     │                        │
│ Reference Image                                    │                        │
│ 첨부파일                                           │                        │
│                                                     │ [ 수정 ]               │
│                                                     │                        │
│                                                     │ [ PDF로 저장 ]         │
└─────────────────────────────────────────────────────┴────────────────────────┘


---

# 9. 01 기본정보

기존에 확정한 상단 정보는 그대로 유지한다.


┌──────────────────────┬──────────────────────┐
│ 고객사               │ 제품명               │
├──────────────────────┼──────────────────────┤
│ 제품 유형            │ 목표 가격대          │
├──────────────────────┼──────────────────────┤
│ 수출 대상국          │ 수출 금지 원료       │
└──────────────────────┴──────────────────────┘


---

# 10. 고객사

STEP 1에서 고객사를 선택했다면 해당 값을 우선 사용한다.

원문에서 고객사를 명확하게 확인할 수 있는 경우 Mapping할 수 있다.


---

# 11. 제품명

원본 PDF:


Project Name


개발요청서:


제품명


---

# 12. 제품 유형

원본 PDF:


Product Category


개발요청서:


제품 유형


제품 유형은 대분류 Dropdown을 사용한다.


[ 선택 ▼ ]

스킨케어
베이스 메이크업
립
아이
바디
헤어
클렌징
선케어
기타 / 직접 입력


`기타 / 직접 입력` 선택 시:


제품 유형 직접 입력 *

[                         ]


---

# 13. 목표 가격대

연구소에는 상세 Target Cost를 공개하지 않는다.


○ 저가
○ 중가
○ 고가


원문:


Target Cost (Formula)


를 활용할 수 있지만 회사 내부 가격대 Mapping 기준이 있을 때만 자동 분류한다.

기준이 없으면:


⚠ 확인 필요


로 표시한다.


Target Cost (Component)는 연구소용 개발요청서에 표시하지 않는다.


---

# 14. 수출 대상국

원본 PDF:


Distribution Countries


개발요청서:


수출 대상국


복수 선택을 지원한다.


[ 미국 × ] [ 캐나다 × ] [ + 국가 추가 ]


수출 대상국은 처방 가능 여부와 사용 가능 원료 판단에 영향을 줄 수 있으므로 상단 핵심정보로 유지한다.


---

# 15. 수출 금지 원료

원본 PDF:


DO NOT USE ingredients


를 우선 Mapping한다.


수출 금지 원료

[ Talc × ] [ + 원료 ]


단, 내부적으로는 반드시 다음을 구분한다.


buyer_prohibited_ingredients

regulatory_restricted_ingredients


바이어가 사용하지 말라고 요청한 원료를 국가 법규상 금지 원료라고 자동 확정하지 않는다.

국가 규제 근거가 확인되지 않았다면:


⚠ 규제 확인 필요


로 표시한다.


---

# 16. 02 제품 개발 요구사항

원본 PDF의 `Formula` 영역에서 연구소가 처방 방향을 이해하기 위해 필요한 내용을 변환한다.


제품 개발 요구사항

제품 설명
[                                         ]

처방 가이드
[                                         ]


제품 특성

┌─────────────────────┬─────────────────────┐
│ 제형 / 텍스처      │ 사용감 / 외관       │
├─────────────────────┼─────────────────────┤
│ 점도                │ 향 / Flavor         │
├─────────────────────┼─────────────────────┤
│ 피니시              │ 커버력              │
└─────────────────────┴─────────────────────┘


컬러 / 쉐이드 참고

[                                         ]


Mapping:


Formula Guidelines
→ 처방 가이드

Product Description
→ 제품 설명

Base Texture
→ 제형 / 텍스처

Appearance / Sensory
→ 사용감 / 외관

Viscosity
→ 점도

Base Fragrance / Flavor
→ 향 / Flavor

Base Finish
→ 피니시

Base Coverage
→ 커버력

Color / Shade Benchmark(s)
→ 컬러 / 쉐이드 참고


---

# 17. 클레임 정보 제외

원본 PDF에는:


Target Claims / Benefits


항목이 존재할 수 있다.

하지만 현재 연구소용 개발요청서에는 별도 항목으로 표시하지 않는다.


Target Claims / Benefits
→ 개발요청서 노출 X
→ Raw Data 보존


또한 클레임과 관련된 시험 항목 역시 연구소용 개발요청서에서 제외한다.


RIPT
Ocular
Sensory Testing
Clinical Testing
Other Safety / Efficacy Testing


따라서 개발요청서에는 다음과 같은 영역을 만들지 않는다.


Safety / Efficacy Testing
Claim Testing
Clinical Claim
효능시험
클레임 검증


---

# 18. 벤치마크 제품명

원본 PDF:


Formula Benchmark


를 Mapping한다.

벤치마크 제품명은 기존 요구사항대로 오른쪽 Panel에 단일 Field로 유지한다.


벤치마크 제품명

[ NARS Light Reflecting Setting Powder ]


다음 기능은 만들지 않는다.


벤치마크 추가
다중 벤치마크
브랜드 별도 관리
벤치마크 평가항목


원문에 명확한 제품명이 있을 때만 자동 입력한다.

원문에서 제품명이 확인되지 않고 이미지밖에 없다면 이미지로부터 임의 추정하지 않는다.


---

# 19. 컬러 / 쉐이드 벤치마크

원본 PDF에:


Color / Shade Benchmark(s)


가 존재하면 연구소 개발 참고정보로 사용한다.


컬러 / 쉐이드 참고

[ 원문에서 추출된 내용 ]


관련 이미지가 존재하면 Reference Image로 연결할 수 있다.

컬러 정보가 없는 제품이면 해당 영역을 비워두거나 숨길 수 있다.


---

# 20. 03 원료 요구사항

원본 PDF의 원료 관련 내용을 연구소용으로 변환한다.


원료 요구사항

필수 적용 원료
[ Ingredient A × ] [ + 원료 ]

선호 원료
[ Ingredient B × ] [ + 원료 ]


Mapping:


Necessary Ingredients
→ 필수 적용 원료

Additional Ideal Ingredients
→ 선호 원료


DO NOT USE Ingredients는 여기서 중복 표시하지 않는다.

상단의 `수출 금지 원료`에서 관리한다.


---

# 21. 04 사용 정보

원본 PDF의 다음 항목을 포함한다.


Application
(leave on or rinse off)

Directions for Use

Additional Comments


개발요청서:


사용 정보

사용 타입
[ Leave-on ▼ ]

사용 방법
[                                         ]

추가 참고사항
[                                         ]


Mapping:


Application
→ 사용 타입

Directions for Use
→ 사용 방법

Additional Comments
→ 추가 참고사항


사용 타입 표준값:


Leave-on
Rinse-off
기타
확인 필요


---

# 22. 05 품질 확인사항

클레임 시험은 제외하지만 제품 개발과 품질 확인에 직접 필요한 Quality Testing 정보는 별도로 관리할 수 있다.

원본 PDF:


Quality Testing

Stability (duration)

Micro, yeast & Mold


개발요청서:


품질 확인사항

┌──────────────────┬─────────────┬──────────────────┐
│ 항목             │ 필요 여부   │ 책임 주체        │
├──────────────────┼─────────────┼──────────────────┤
│ 안정도 시험      │             │                  │
│ 미생물 시험      │             │                  │
└──────────────────┴─────────────┴──────────────────┘


안정도 기간이 원문에 있으면 함께 표시한다.


안정도 시험

필요 여부
[ 필요 ]

기간
[ 12주 ]

책임 주체
[ Manufacturer ]


원문의 `Responsibility`가 명확하면 그대로 변환한다.

책임 주체가 없는 경우 시스템이 임의로 연구소 또는 공장을 지정하지 않는다.


---

# 23. Safety / Efficacy Testing 제외

원본 PDF의 다음 영역은 연구소 개발요청서에 표시하지 않는다.


Safety / Efficacy Testing

RIPT

Ocular

Sensory Testing

Clinical Testing

Other


해당 값은 필요하면 Raw Data에만 저장한다.


"ript": {...}

"ocular": {...}

"sensory_testing": {...}

"clinical_testing": {...}


현재 개발요청서 PDF에도 출력하지 않는다.


---

# 24. 용량 정보 처리

원본 PDF:


Target Fill Weight


는 필수 개발요청 정보로 사용하지 않는다.

즉:


Target Fill Weight
→ 필수 입력 X
→ 기본 개발요청서 노출 X


원문에 존재하면 Raw Data로 보존할 수 있다.


"target_fill_weight": {
    "source_value": "",
    "used_in_request": false
}


향후 생산 또는 패키징 검토가 필요한 경우 별도 화면에서 활용한다.


---

# 25. 용기 / 패키징 정보 처리

원본 PDF에는 다음 정보가 존재한다.


Primary Packaging

Secondary Packaging

Tertiary Packaging


하지만 현재 연구소용 개발요청서에서는 필수정보로 요구하지 않는다.

따라서 기본 개발요청서 Form에는 다음 항목을 필수 Field로 만들지 않는다.


1차 포장

2차 포장

3차 포장

용기 형태

용기 규격


원문에 패키징 정보가 존재하는 경우에는 삭제하지 않고 Raw Data에 보존한다.


"packaging": {
    "primary": {},
    "secondary": {},
    "tertiary": {}
}


---

# 26. 패키지 시험 처리

원본 PDF에는:


Compatibility

Drop Testing / Functionality


이 존재한다.

현재 개발요청서에서는 기본 입력항목으로 노출하지 않는다.


Compatibility
→ 기본 개발요청서 노출 X

Drop Testing / Functionality
→ 기본 개발요청서 노출 X


필요한 경우 Raw Data에 보존하여 향후 패키지/품질 담당 화면에서 활용한다.


---

# 27. 수량 정보 제외

원본 PDF의 Pricing 영역에는:


Number of SKUs

Initial Order Quantity

Annual Projection Quantity


가 존재한다.

현재 연구소 개발요청서에는 수량 정보를 노출하지 않는다.


Number of SKUs
→ 연구소 화면 X

Initial Order Quantity
→ 연구소 화면 X

Annual Projection Quantity
→ 연구소 화면 X


데이터 자체는 영업 및 Order Feasibility 관리를 위해 내부적으로 보존할 수 있다.


---

# 28. 거래 및 가격정보 제외

연구소용 개발요청서에서는 다음 정보를 제외한다.


MOQ

Initial Order Quantity

Annual Projection Quantity

Incoterms

거래 조건

상세 Target Cost

Target Cost (Component)

영업 원가

마진


단 `Target Cost (Formula)`를 기반으로 내부 기준에 따라 계산된:


목표 가격대

저가 / 중가 / 고가


만 연구소에 보여줄 수 있다.


---

# 29. 일정 정보 처리

원본 PDF에는:


First Submission Due Date

In DC Date

Target Launch Date


가 존재할 수 있다.

현재 개발요청서에서는 일정 정보를 필수 입력항목으로 만들지 않는다.

자동변환 시 Raw Data에는 저장한다.


first_submission_due_date

in_dc_date

target_launch_date


향후 일정관리 기능에서 활용한다.

특히 `In DC Date`는 연구소용 개발요청서에 노출하지 않는다.


---

# 30. 06 참고자료

원본 문서에 포함된 제품 이미지 또는 Reference Image는 개발요청서에서 사용할 수 있다.


참고자료

┌────────────────┐ ┌────────────────┐
│ Reference      │ │ Reference      │
│ Image          │ │ Image          │
└────────────────┘ └────────────────┘


첨부파일

[ 원본 RFP ]


이미지는 연구소가 벤치마크 제품의 외관이나 제품 방향을 이해하는 참고자료로 활용한다.

이미지에 제품명이 명확하게 표시되지 않은 경우 시스템이 제품명을 추측해서 입력하지 않는다.


---

# 31. STEP 2 — 자동변환된 개발요청서

자동변환이 끝나면 다음 구조로 STEP 2를 보여준다.


┌─────────────────────────────────────────────────────┬───────────────────────┐
│ 개발요청서                                         │ 문서 정보             │
│                                                     │                       │
│ 기본정보                                            │ 작성 방식             │
│                                                     │ 자동변환              │
│ 고객사                 제품명                       │                       │
│ Glowtree Beauty        Loose Setting Powder         │ 입력 완료             │
│                                                     │ 14 / 18               │
│ 제품 유형              목표 가격대                  │                       │
│ 베이스 메이크업        중가                         │ 확인 필요             │
│                                                     │ ⚠ 2건                │
│ 수출 대상국            수출 금지 원료               │                       │
│ 미국                    Talc                        │ ──────────────────── │
│                                                     │                       │
│ ───────────────────────────────────────────────── │ 벤치마크 제품명       │
│                                                     │                       │
│ 제품 개발 요구사항                                 │ NARS Light            │
│                                                     │ Reflecting Setting    │
│ 제품 설명                                          │ Powder                │
│ ...                                                 │                       │
│                                                     │ ──────────────────── │
│ 처방 가이드                                        │                       │
│ ...                                                 │ 수출 검토             │
│                                                     │ 미국 ⚠ 확인 필요    │
│ 제품 특성                                          │                       │
│                                                     │ 전달 대상             │
│ 제형/텍스처       ...                              │ 연구소 / 공장         │
│ 사용감/외관       ...                              │                       │
│ 점도              ...                              │                       │
│ 향                ...                              │                       │
│ 피니시            ...                              │                       │
│ 커버력            ...                              │                       │
│                                                     │                       │
│ 컬러/쉐이드 참고                                   │                       │
│ ...                                                 │                       │
│                                                     │                       │
│ ───────────────────────────────────────────────── │                       │
│                                                     │                       │
│ 원료 요구사항                                      │                       │
│                                                     │                       │
│ 필수 적용 원료                                     │                       │
│ ...                                                 │                       │
│                                                     │                       │
│ 선호 원료                                          │                       │
│ ...                                                 │                       │
│                                                     │                       │
│ ───────────────────────────────────────────────── │                       │
│                                                     │                       │
│ 사용 정보                                          │                       │
│                                                     │                       │
│ 사용 타입        Leave-on                          │                       │
│ 사용 방법        ...                               │                       │
│ 추가 참고사항    ...                               │                       │
│                                                     │                       │
│ ───────────────────────────────────────────────── │                       │
│                                                     │                       │
│ 품질 확인사항                                      │                       │
│                                                     │                       │
│ 안정도 시험      필요 / 기간 / 책임주체            │                       │
│ 미생물 시험      필요 / 책임주체                   │                       │
│                                                     │                       │
│ ───────────────────────────────────────────────── │                       │
│                                                     │                       │
│ 참고자료                                            │                       │
│                                                     │                       │
│ [Reference Image] [Reference Image]                │                       │
│                                                     │                       │
│                                                     │ [ 수정 ]              │
│                                                     │                       │
│                                                     │ [ PDF로 저장 ]        │
└─────────────────────────────────────────────────────┴───────────────────────┘


STEP 2는 Read Only이다.


---

# 32. STEP 2 오른쪽 Panel

오른쪽 구조는 기존 설계를 유지한다.


문서 정보

작성 방식
자동변환

입력 완료
14 / 18

확인 필요
⚠ 2건

────────────────

벤치마크 제품명

NARS Light Reflecting
Setting Powder

────────────────

수출 검토

미국
⚠ 확인 필요

────────────────

전달 대상

연구소 / 공장


[ 수정 ]

[ PDF로 저장 ]


수정과 PDF 저장 버튼은 오른쪽 하단에 세로로 배치한다.


---

# 33. STEP 3 — 수정 화면

STEP 2에서:


[ 수정 ]


을 누르면 STEP 3으로 이동한다.

화면 Layout은 유지하고 값만 Edit Mode로 전환한다.


개발요청서 수정


기본정보

고객사 *
[ Glowtree Beauty ▼ ]

제품명 *
[ Loose Setting Powder ]

제품 유형 *
[ 베이스 메이크업 ▼ ]

목표 가격대
○ 저가 ● 중가 ○ 고가

수출 대상국 *
[ 미국 × ] [ + 국가 ]

수출 금지 원료
[ Talc × ] [ + 원료 ]


제품 개발 요구사항

제품 설명
[                                   ]

처방 가이드
[                                   ]

제형 / 텍스처
[                                   ]

사용감 / 외관
[                                   ]

점도
[                                   ]

향 / Flavor
[                                   ]

피니시
[                                   ]

커버력
[                                   ]

컬러 / 쉐이드 참고
[                                   ]


원료 요구사항

필수 적용 원료
[ + 원료 ]

선호 원료
[ + 원료 ]


사용 정보

사용 타입
[ Leave-on ▼ ]

사용 방법
[                                   ]

추가 참고사항
[                                   ]


품질 확인사항

안정도 시험
[ 필요 / 불필요 / 확인 필요 ▼ ]

기간
[                                   ]

책임 주체
[                                   ]

미생물 시험
[ 필요 / 불필요 / 확인 필요 ▼ ]

책임 주체
[                                   ]


참고자료

[ 파일 추가 ]


오른쪽 Panel

벤치마크 제품명
[                                   ]

수출 검토
[                                   ]

전달 대상
☑ 연구소
☑ 공장


[ 수정 취소 ]

[ 수정 완료 ]


수정 완료 후 STEP 2 Result로 돌아간다.


---

# 34. STEP 4 — 직접작성

STEP 1에서:


[ 직접 작성해서 개발팀에 넘기기 → ]


를 누르면 STEP 4로 이동한다.

STEP 4는 STEP 3과 동일한 개발요청서 Form을 사용한다.

차이는 빈 Form으로 시작한다는 것이다.


개발요청서 직접 작성


기본정보

고객사 *
[ 고객사 선택 ▼ ]

제품명 *
[                                   ]

제품 유형 *
[ 선택 ▼ ]

목표 가격대
○ 저가 ○ 중가 ○ 고가

수출 대상국 *
[ + 국가 ]

수출 금지 원료
[ + 원료 ]


제품 개발 요구사항

제품 설명
[                                   ]

처방 가이드
[                                   ]

제형 / 텍스처
[                                   ]

사용감 / 외관
[                                   ]

점도
[                                   ]

향 / Flavor
[                                   ]

피니시
[                                   ]

커버력
[                                   ]

컬러 / 쉐이드 참고
[                                   ]


원료 요구사항

필수 적용 원료
[ + 원료 ]

선호 원료
[ + 원료 ]


사용 정보

사용 타입
[ 선택 ▼ ]

사용 방법
[                                   ]

추가 참고사항
[                                   ]


품질 확인사항

안정도 시험
[ 선택 ▼ ]

기간
[                                   ]

책임 주체
[                                   ]

미생물 시험
[ 선택 ▼ ]

책임 주체
[                                   ]


참고자료

[ 파일 추가 ]


오른쪽 Panel

작성 방식
직접 작성

채운 항목
0 / 18

필수 미입력
고객사
제품명
제품 유형
수출 대상국

벤치마크 제품명
[                                   ]

수출 검토
-

전달 대상
☑ 연구소
☑ 공장


[ 작성 취소 ]

[ 작성 완료 ]


---

# 35. 직접작성 완료

STEP 4에서:


[ 작성 완료 ]


을 누르면 필수값을 확인한다.


STEP 4
    ↓
작성 완료
    ↓
필수값 검증
    ↓
개발요청서 생성
    ↓
Result Mode


직접작성 Result도 STEP 2와 동일한 Layout을 사용한다.


---

# 36. PDF 저장

Result 화면에서:


[ PDF로 저장 ]


을 누르면 최종 개발요청서 PDF를 생성한다.

PDF는 사용자가 최종 확인한 데이터를 기준으로 한다.


자동변환 값
    ↓
사용자 수정
    ↓
최종값
    ↓
PDF


---

# 37. 최종 PDF 구조

PDF 역시 연구소용 개발요청서의 정보 공개 원칙을 그대로 적용한다.


개발요청서

━━━━━━━━━━━━━━━━━━━━━━━━━━━━

01 기본정보

고객사
제품명
제품 유형
목표 가격대

수출 대상국
수출 금지 원료

벤치마크 제품명


02 제품 개발 요구사항

제품 설명
처방 가이드

제형 / 텍스처
사용감 / 외관
점도
향 / Flavor
피니시
커버력

컬러 / 쉐이드 참고


03 원료 요구사항

필수 적용 원료
선호 원료


04 사용 정보

사용 타입
사용 방법
추가 참고사항


05 품질 확인사항

안정도 시험
기간
책임 주체

미생물 시험
책임 주체


06 참고자료

벤치마크 이미지
관련 첨부자료


PDF에는 다음 정보를 넣지 않는다.


수량
MOQ
Annual Projection
거래 조건
Incoterms

상세 원가
영업 마진

Target Claims / Benefits

RIPT
Ocular
Sensory Testing
Clinical Testing
기타 Claim / Efficacy Testing

Target Fill Weight

용기 상세
패키징 상세
Package Testing


---

# 38. PDF 원문 → 개발요청서 Mapping

| 원본 PDF | 개발요청서 | 처리 |
|---|---|---|
| Project Name | 제품명 | 포함 |
| Product Category | 제품 유형 | 포함 |
| First Submission Due Date | 내부 데이터 | 화면 제외 |
| In DC Date | 내부 데이터 | 화면 제외 |
| Target Launch Date | 내부 데이터 | 화면 제외 |
| Number of SKUs | 내부 데이터 | 연구소 제외 |
| Initial Order Quantity | 내부 데이터 | 연구소 제외 |
| Annual Projection Quantity | 내부 데이터 | 연구소 제외 |
| Target Cost (Formula) | 목표 가격대 | 변환 후 포함 |
| Target Cost (Component) | 내부 데이터 | 연구소 제외 |
| Target Fill Weight | 내부 데이터 | 필수 아님 |
| Distribution Countries | 수출 대상국 | 포함 |
| Formula Guidelines | 처방 가이드 | 포함 |
| Product Description | 제품 설명 | 포함 |
| Formula Benchmark | 벤치마크 제품명 | 포함 |
| Color/Shade Benchmark(s) | 컬러/쉐이드 참고 | 포함 |
| Base Texture | 제형/텍스처 | 포함 |
| Appearance/Sensory | 사용감/외관 | 포함 |
| Viscosity | 점도 | 포함 |
| Base Fragrance/Flavor | 향/Flavor | 포함 |
| Base Finish | 피니시 | 포함 |
| Base Coverage | 커버력 | 포함 |
| Target Claims/Benefits | Raw Data | 연구소 제외 |
| Necessary Ingredients | 필수 적용 원료 | 포함 |
| Additional Ideal Ingredients | 선호 원료 | 포함 |
| DO NOT USE ingredients | 수출 금지 원료 | 포함 |
| Application | 사용 타입 | 포함 |
| Directions for Use | 사용 방법 | 포함 |
| Additional Comments | 추가 참고사항 | 포함 |
| RIPT | Raw Data | 연구소 제외 |
| Ocular | Raw Data | 연구소 제외 |
| Sensory Testing | Raw Data | 연구소 제외 |
| Clinical Testing | Raw Data | 연구소 제외 |
| Other Safety/Efficacy | Raw Data | 연구소 제외 |
| Stability | 안정도 시험 | 포함 |
| Micro, yeast & Mold | 미생물 시험 | 포함 |
| Compatibility | Raw Data | 기본 제외 |
| Drop Testing | Raw Data | 기본 제외 |
| Primary Packaging | Raw Data | 필수 아님 |
| Secondary Packaging | Raw Data | 필수 아님 |
| Tertiary Packaging | Raw Data | 필수 아님 |
| Reference Images | 참고자료 | 포함 |


---

# 39. 내부 보존 데이터

연구소 화면에서 제외한다고 해서 원문 정보를 삭제하지 않는다.

예:


{
  "commercial_data": {
    "number_of_skus": null,
    "initial_order_quantity": null,
    "annual_projection_quantity": null,
    "target_cost_component": null
  },

  "schedule_data": {
    "first_submission_due_date": "",
    "in_dc_date": "",
    "target_launch_date": ""
  },

  "claim_data": {
    "target_claims_benefits": "",
    "ript": {},
    "ocular": {},
    "sensory_testing": {},
    "clinical_testing": {}
  },

  "optional_packaging_data": {
    "target_fill_weight": "",
    "primary_packaging": "",
    "secondary_packaging": "",
    "tertiary_packaging": "",
    "compatibility": "",
    "drop_testing": ""
  }
}


이 데이터는 향후:

영업
생산
구매
품질
패키지
일정관리

화면에서 별도로 사용할 수 있다.


---

# 40. 최종 Development Request Schema

{
  "document_id": "",

  "creation_method": "auto",

  "customer": "",

  "source_language": "",
  "target_language": "",

  "product_name": "",
  "product_type": "",
  "product_type_custom": "",

  "target_price_tier": "",

  "export_countries": [],

  "buyer_prohibited_ingredients": [],
  "regulatory_restricted_ingredients": [],

  "benchmark_product_name": "",

  "product_development": {
    "product_description": "",
    "formula_guidelines": "",
    "texture": "",
    "appearance_sensory": "",
    "viscosity": "",
    "fragrance_flavor": "",
    "finish": "",
    "coverage": "",
    "color_shade_reference": ""
  },

  "ingredients": {
    "necessary": [],
    "ideal": []
  },

  "usage": {
    "application_type": "",
    "directions_for_use": "",
    "additional_comments": ""
  },

  "quality": {
    "stability": {
      "required": null,
      "duration": "",
      "responsibility": ""
    },

    "micro": {
      "required": null,
      "responsibility": ""
    }
  },

  "reference_files": [],

  "recipients": [],

  "review_status": "",

  "source_file": "",

  "raw_extracted_data": {},

  "version": 1
}


---

# 41. 자동변환 Field 처리 원칙

각 Field는 다음 상태를 가질 수 있다.


confirmed
needs_review
missing
not_applicable
user_edited


UI:


✓ 확인 완료

⚠ 확인 필요

● 미입력

- 해당 없음


원문에 값이 없으면 시스템이 임의로 생성하지 않는다.


---

# 42. 필수값

최소 필수값은 다음과 같다.


고객사
제품명
제품 유형
수출 대상국


다음 항목은 필수값으로 강제하지 않는다.


목표 가격대
수출 금지 원료
벤치마크 제품명

제품 설명
처방 가이드
제품 특성

필수 적용 원료
선호 원료

사용 정보

안정도 시험
미생물 시험

참고자료


즉 바이어 RFP의 상세 수준이 낮더라도 개발요청서 자체를 생성할 수 있어야 한다.


---

# 43. 원문 보존

자동변환 화면에는 원문과 변환 결과를 좌우 비교해서 보여주지 않는다.

사용자에게는 최종 개발요청서만 보여준다.

시스템 내부에는 다음 정보를 보존한다.


field_key

source_value
translated_value
user_value

source_page

source_language
target_language

input_source
review_status


사용자가 값을 수정하면:


input_source = user_edited


로 변경한다.


---

# 44. PDF Version

권장 파일명:


DevelopmentRequest_{Customer}_{Product}_{Language}_{YYYYMMDD}_v{Version}.pdf


예:


DevelopmentRequest_Glowtree_LooseSettingPowder_KO_20260923_v1.pdf


수정 후 다시 생성하면:


v1
→ 수정
→ v2


기존 PDF는 덮어쓰지 않는다.


---

# 45. 최종 Flow

                         STEP 1
                    개발요청서 생성
                          │
             ┌────────────┴────────────┐
             │                         │
         파일 업로드                직접 작성
             │                         │
             ▼                         ▼
          자동변환                   STEP 4
             │                    직접작성 Form
             ▼                         │
           STEP 2                   작성 완료
         Result Mode                   │
             │                         │
             │◀────────────────────────┘
             │
       ┌─────┴─────┐
       │           │
      수정       PDF 저장
       │
       ▼
     STEP 3
    Edit Mode
       │
    수정 완료
       │
       ▼
     STEP 2


---

# 46. 핵심 구현 규칙

Rule 1

파일 업로드가 완료되면 자동변환하고 STEP 2로 자동 이동한다.


Rule 2

STEP 2는 Read Only Result 화면이다.


Rule 3

STEP 2의 수정 버튼을 누르면 STEP 3으로 이동한다.


Rule 4

STEP 3에서는 자동변환된 전체 개발요청서를 수정할 수 있다.


Rule 5

STEP 1의 직접 작성 버튼은 STEP 4로 이동한다.


Rule 6

STEP 4는 STEP 3과 동일한 Form을 빈 상태로 제공한다.


Rule 7

수량, MOQ, 거래조건, 상세원가, 마진은 연구소 개발요청서에 노출하지 않는다.


Rule 8

Target Claims / Benefits 및 RIPT, Ocular, Sensory, Clinical 등의 클레임/효능 시험은 연구소 개발요청서에 노출하지 않는다.


Rule 9

용량 및 용기/패키징 정보는 개발요청서 필수값으로 사용하지 않는다.


Rule 10

원문의 Formula 관련 정보 중 실제 처방 개발에 필요한 제형, 사용감, 점도, 향, 피니시, 커버력, 원료 정보는 개발요청서에 변환한다.


Rule 11

Quality Testing 중 안정도 및 미생물 관련 정보는 제품 개발/품질 확인에 필요한 경우 개발요청서에 포함한다.


Rule 12

원문에서 제외된 데이터도 삭제하지 않고 Raw Data로 보존한다.


Rule 13

Result 화면에서 수정 또는 PDF 저장이 가능해야 한다.


Rule 14

PDF는 사용자가 최종 확인하거나 수정한 최신값을 기준으로 생성한다.


---

# 47. 최종 UX 정의

자동변환:


파일 업로드
→ RFP 전체 분석
→ 연구소 필요정보 선별
→ 언어 변환
→ 개발요청서 자동작성
→ 결과 확인
→ 필요 시 수정
→ PDF 저장


직접작성:


직접 작성
→ 동일한 개발요청서 입력
→ 작성 완료
→ 결과 확인
→ PDF 저장


최종 개발요청서는 바이어 RFP를 그대로 복사한 문서가 아니다.

원문의 구조와 요구사항을 기반으로 하되,

"연구소가 이 제품을 실제로 개발하기 위해 무엇을 알아야 하는가?"

를 기준으로 변환한다.

따라서:

포함
= 제품 방향 / 처방 / 원료 / 사용법 / 품질 / 수출 관련 정보

제외
= 수량 / 거래조건 / 영업 상세원가 / 마진 / 클레임 및 효능시험

선택
= 용량 / 용기 / 패키징 상세

의 원칙을 적용한다.