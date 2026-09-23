# UI Components — COSMOA

> **반복적으로 사용하는 UI 요소의 규격 문서입니다. (PM 관리)**
>
> - 공통 UI 요소는 각 담당자가 **새로 디자인하지 않고** 이 문서의 HTML 구조와 Class를 그대로 사용합니다.
> - 스타일은 `src/common/style.css`, 동작은 `src/common/common.js`에 구현되어 있습니다. 페이지 CSS에서 다시 정의하지 않습니다.
> - 색상·크기 등 Token은 `docs/design_system.md`를 따릅니다.
> - 여기에 없는 컴포넌트가 필요하면: 한 페이지에서만 쓰면 자기 폴더 CSS에(`<페이지>-` 접두사, Token은 Variable 사용), 여러 페이지에서 쓰면 PM에게 요청해 이 문서에 추가합니다.

**디자인 원본**: `docs/reference/main.dc.html`, `docs/reference/login.dc.html` (v1.0, 2026-09-21 반영)

**공통 원칙**

- Card·Button·Input에는 **Border가 없습니다.** 배경색 차이로 구분하고, Card에는 거의 보이지 않는 `--shadow-card`만 적용됩니다.
- **Input / Select / Tabs / Table / 회색 Button은 흰색 Card 안에** 배치합니다. 회색 페이지 배경 위에는 흰색 요소(`.card`, `.btn-surface`)만 놓습니다.
- Icon은 inline Line SVG(`stroke="currentColor"`, `stroke-width="2"`, 24×24 viewBox)만 사용합니다. Emoji 금지.
- 글자 굵기는 `--font-weight-regular`(본문) / `--font-weight-bold`(버튼·소제목) / `--font-weight-extrabold`(큰 제목·대표 수치) 3종만 사용합니다.
- 공통 상태 Class: `.is-active` `.is-selected` `.is-error` `.is-disabled` `.is-open` (+ 표준 `disabled` 속성)

---

## 1. Header

- **Desktop에는 상단 Header가 없습니다.** 페이지 상단은 `.page-header`(날짜 + 제목)로 시작합니다.
- ≤1024px에서만 상단 Bar(`.app-header`, 60px, 흰색)가 나타나며 햄버거 버튼과 로고를 표시합니다.
- **위치**: `src/common/base.html` — 담당자는 수정하지 않습니다.
- **CSS Class**: `.app-header` `.app-header__toggle` `.app-brand` `.app-brand__logo` `.app-brand__name` `.app-brand__sub`

## 2. Navigation

- **용도**: 페이지 간 이동. Sidebar 안에 위치
- **위치**: `src/common/base.html` — **메뉴 추가/변경은 PM만** 수행
- **CSS Class**: `.app-nav` `.app-nav__label` `.app-nav__link`
- **크기/여백**: 항목 높이 48px, 좌우 Padding 14px, radius 12px, Icon 20px + gap 12px, 15px / Regular, 항목 간격 4px
- **상태**: 기본 `#4E5968` / Hover → 배경 `surface-muted` / Active → `.is-active` 배경 `primary-soft` + 글자 `primary` + Bold (현재 URL 기준 자동 적용, `aria-current="page"`)
- 링크는 반드시 `url_for()` 사용: `href="{{ url_for('regulatory') }}"`

| endpoint | URL | 메뉴명 |
|---|---|---|
| `home` | `/` | 홈 |
| `regulatory` | `/regulatory` | 국가별 인허가 규제 |
| `margin` | `/margin-calculator` | 원가·마진 시뮬레이션 |
| `simulation` | `/ai-formulation` | AI 제형/샘플 시뮬레이션 |
| `dev_request` | `/dev-request` | 개발요청서 |

## 3. Sidebar

- **용도**: 좌측 고정 영역 — 로고 / 메뉴 / 사용자 영역(하단)
- **CSS Class**: `.app-sidebar` `.app-sidebar__head` `.app-sidebar__collapse` `.app-sidebar-backdrop` `.app-nav__text` `.app-user` `.app-user__avatar` `.app-user__name` `.app-user__team`
- **크기**: 너비 264px(펼침) / 80px(접힘), 전체 높이, 흰색, Padding 32px 20px, 블록 간격 40px
- **상태 (Desktop ≥1025px)**: 로고 옆 `[data-sidebar-collapse]` 버튼으로 접기/펼치기. 접히면 `<html class="is-sidebar-collapsed">`가 붙고 아래처럼 내용이 바뀝니다. 상태는 `localStorage("cosmoa.sidebar")`에 저장되어 페이지 이동·새로고침 후에도 유지됩니다.
  - 로고: 텍스트 숨김, 아이콘만 / "메뉴" 라벨 → 얇은 구분선 / 메뉴: 아이콘만 가운데 정렬, Hover 시 우측에 메뉴명 Tooltip(`data-label`) / 사용자 영역: 아바타만
  - 본문(`.app-main`)의 좌측 여백도 함께 줄어듭니다 (0.28s Transition)
  - 페이지 JS에서 강제로 바꿔야 할 때: `Common.setSidebarCollapsed(true | false)`
- **상태 (≤1024px)**: 숨김 → `[data-sidebar-toggle]` 클릭 시 `.is-open` (Drawer, 항상 펼친 모양). 배경 클릭 / ESC로 닫힘. 접기 버튼은 표시되지 않습니다.
- 사용자 영역은 로그인 구현 전까지 `[사용자명]` Placeholder입니다.

## 4. Button

- **용도**: 사용자 액션. 한 영역에 Primary는 1개만 사용

```html
<button type="button" class="btn btn-primary">저장</button>
<button type="button" class="btn btn-soft">이어서 계산</button>
<button type="button" class="btn btn-secondary">취소</button>      <!-- Card 안 -->
<a class="btn btn-surface" href="{{ url_for('home') }}">← 홈으로</a> <!-- 페이지 배경 위 -->
<button type="button" class="btn btn-ghost">더보기</button>
<button type="button" class="btn btn-danger">삭제</button>
<button type="button" class="btn btn-surface btn-icon" aria-label="알림"><svg>…</svg></button>
```

| Class | 배경 / 글자 | 사용 위치 |
|---|---|---|
| `.btn-primary` | `#1B64DA` / 흰색 | 주요 액션 |
| `.btn-soft` | `#E8F3FF` / `#1B64DA` | 보조 강조 액션 |
| `.btn-secondary` | `#F2F4F6` / `#4E5968` | 흰색 Card 안의 일반 액션 |
| `.btn-surface` | 흰색 / `#4E5968` | 회색 페이지 배경 위의 일반 액션 |
| `.btn-ghost` | 투명 / `#6B7684` | 약한 액션 |
| `.btn-danger` | `#E42939` / 흰색 | 삭제 등 |

- **크기**: `.btn-sm` 36px·r10·14px / 기본 48px·r14·16px / `.btn-lg` 56px·r16·17px / `.btn-icon` 44×44·r12 / `.btn-block` 가로 100%
- **공통**: Border 없음, Bold, 좌우 Padding 20px
- **Hover**: Primary → `#1957C2`, 나머지 → 한 단계 진한 배경
- **Disabled**: `disabled` 또는 `.is-disabled` → 투명도 45%, 클릭 불가
- **Loading**: 버튼 안에 `<span class="spinner spinner-sm"></span>` + `disabled`

## 5. Card

- **용도**: 정보 묶음의 기본 컨테이너. 흰색, radius 24px, **Border 없음**, 미세 Shadow(`--shadow-card`, 공통 CSS에서 자동 적용)

```html
<div class="card">
  <div class="card-header">
    <div>
      <h3 class="card-title">제목</h3>
      <p class="card-subtitle">기준·출처 등 (선택)</p>
    </div>
    <!-- 우측 액션 (선택) -->
  </div>
  <div class="card-body">내용</div>
  <div class="card-footer"><a href="#">전체 보기</a></div>
</div>
```

- **CSS Class**: `.card` `.card-header` `.card-title` `.card-subtitle` `.card-body` `.card-footer` / 작은 Card `.card.card-sm`(radius 20px, Padding 18px)
- **크기/여백**: Padding 32px, Header ↔ Body 24px. Header와 Body 사이에 구분선 없음
- **Hover**: 클릭 가능한 Card(`<a class="card">` 또는 `.card.is-clickable`)만 → 2px 위로 이동
- **Selected**: `.card.is-selected` → 배경 `#191F28`, 글자 흰색 (여러 Card 중 하나를 선택하는 UI)
- **Card 안의 보조 요소**
  - `.stat-tile` > `.stat-tile__label` + `.stat-tile__value` — `#F9FAFB` 배경 r16의 작은 수치 패널
  - `.icon-tile` — 48×48 r14 `primary-soft` 배경의 Icon 박스

## 6. KPI Card

- **용도**: 핵심 수치 1개 표시

```html
<div class="card kpi-card">
  <p class="kpi-label">지표명 · 기준</p>
  <p class="kpi-value">1,234<span class="kpi-unit">원</span></p>
  <p class="kpi-delta is-up">▲ 0.32% 전일 대비</p>
</div>
```

- **CSS Class**: `.kpi-card` `.kpi-label` `.kpi-value`(32px) `.kpi-value-lg`(40px, 페이지 대표 수치) `.kpi-value.is-primary`(파란 강조) `.kpi-unit` `.kpi-delta`
- **상태**: `.kpi-delta.is-up` → **빨강**(상승) / `.is-down` → **파랑**(하락) / 없음 → Gray. `▲` `▼` 기호와 함께 표기
- **배치**: `.grid.grid-4` 등 안에 나열

## 7. Input

```html
<div class="form-group">
  <label class="form-label" for="field-id">라벨 <span class="is-required">*</span></label>
  <input class="form-control" type="text" id="field-id" placeholder="입력하세요">
  <p class="form-help">도움말 (선택)</p>
  <p class="form-error">오류 메시지 (오류 시에만 표시)</p>
</div>

<!-- 단위가 붙는 숫자 입력 -->
<div class="input-group">
  <input type="number" id="amount"><span class="input-group__suffix">USD</span>
</div>

<!-- Checkbox -->
<label class="form-check"><input type="checkbox"> 로그인 상태 유지</label>
```

- **CSS Class**: `.form-group` `.form-label` `.form-control` `.form-control-sm` `.form-help` `.form-error` / `.input-group` `.input-group__suffix` / `.form-check`
- **크기**: 높이 56px(`-sm` 44px), 좌우 Padding 18px, radius 14px, 17px, 배경 `#F2F4F6`, **Border 없음**. `.input-group`은 60px / 22px·Bold
- **Hover**: 배경 조금 진하게 / **Focus**: 흰 배경 + 1px `#3182F6` Border
- **Disabled**: `disabled` → 투명도 70% / **Error**: `.form-control.is-error`(빨간 Border + 연한 빨강 배경) + `.form-error`
- Label: 14px / Bold / `#4E5968`, Label ↔ Input 8px, 필드 간격 20px

## 8. Textarea

```html
<textarea class="form-control" rows="4"></textarea>
```

- Input과 동일한 Class·상태. 최소 높이 120px, 세로 방향만 resize

## 9. Select

```html
<select class="form-control">
  <option value="">선택하세요</option>
</select>
```

- Input과 동일한 Class·상태. 우측 화살표 Icon 자동 표시

## 10. Multi Select

- **용도**: 여러 값을 Chip으로 선택 (예: 국가 여러 개)

```html
<div class="multi-select">
  <span class="multi-select__chip">값 <button type="button" class="multi-select__remove" aria-label="삭제">×</button></span>
  <input class="multi-select__input" type="text" placeholder="추가">
</div>
```

- **CSS Class**: `.multi-select` `.multi-select__chip` `.multi-select__remove` `.multi-select__input`
- **크기**: 최소 높이 56px, Chip 32px Pill (`primary-soft` / `primary`)
- **상태**: Focus(자동) / `.is-error` / `.is-disabled`
- 스타일만 공통 제공합니다. Chip 추가·삭제 로직은 사용하는 페이지의 JS에서 구현합니다. 단순한 경우 `<select class="form-control" multiple>`도 사용 가능

## 11. File Upload

```html
<label class="file-upload">
  <input type="file">
  <span class="file-upload__title">파일을 끌어다 놓거나 클릭하여 선택</span>
  <span class="text-caption">허용 형식 / 최대 용량</span>
</label>
```

- **CSS Class**: `.file-upload` `.file-upload__title`
- **크기**: Padding 40px 20px, radius 20px, 점선 Border(이 컴포넌트만 예외적으로 Border 사용)
- **상태**: Hover / `.is-dragover`(드래그 중, 페이지 JS에서 토글) / `.is-error` / `.is-disabled`
- 업로드 처리 로직은 사용하는 페이지에서 구현합니다.

## 12. Table

```html
<div class="card">
  <div class="card-body">
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>항목</th><th class="is-numeric">수치</th></tr></thead>
        <tbody><tr><td>값</td><td class="is-numeric">1,234</td></tr></tbody>
      </table>
    </div>
  </div>
</div>
```

- **CSS Class**: `.table-wrap`(가로 스크롤) `.table` `.is-numeric`(우측 정렬 숫자)
- **여백**: Cell 14px 16px, 행 구분선 1px `#F2F4F6`, Header 14px / Bold / Gray (배경 없음)
- **Hover**: 행 배경 `surface-muted` / **Active**: `tr.is-active`
- 반드시 Card 안에 배치. 데이터 없음 → Table 대신 Empty State 표시

## 13. Tabs (Segmented Control)

```html
<div class="tabs" role="tablist">
  <button type="button" class="tab is-active" data-tab-target="panel-a">1개월</button>
  <button type="button" class="tab" data-tab-target="panel-b">3개월</button>
</div>
<div class="tab-panel is-active" id="panel-a">…</div>
<div class="tab-panel" id="panel-b">…</div>
```

- **모양**: 회색(`#F2F4F6`) r12 컨테이너 안에 Padding 4px, 활성 항목만 흰색 r9 + Bold. Card 안에서 사용
- **동작**: `data-tab-target`만 지정하면 `common.js`가 전환 처리 (추가 JS 불필요). Panel 없이 필터 버튼으로만 쓸 때는 `data-tab-target`을 생략하고 페이지 JS에서 `.is-active`를 직접 토글
- **상태**: `.is-active` / `disabled`
- Panel `id`는 페이지 접두사를 붙여 중복을 피합니다 (예: `regulatory-panel-a`)

## 14. Badge

```html
<span class="badge">기본</span>
<span class="badge badge-primary">Primary</span>
<span class="badge badge-success">완료</span>
<span class="badge badge-warning">주의</span>
<span class="badge badge-danger">오류</span>
<span class="badge badge-info">안내</span>
```

- **크기**: 높이 26px, 13px / Bold, Pill 형태, 연한 배경 + 진한 글자, Border 없음

## 15. Alert

```html
<div class="alert alert-info">
  <div>
    <p class="alert-title">제목 (선택)</p>
    <p>내용</p>
  </div>
</div>
```

- **CSS Class**: `.alert` + `.alert-info` `.alert-success` `.alert-warning` `.alert-danger`
- **모양**: 연한 색 배경, radius 16px, Padding 16px 20px, Border 없음. 제목만 상태 색상
- **용도**: 페이지/Section 안의 안내·경고 메시지

## 16. Modal

```html
<button type="button" class="btn btn-primary" data-modal-open="example-modal">열기</button>

<div class="modal-backdrop" id="example-modal">
  <div class="modal" role="dialog" aria-modal="true">
    <div class="modal-header">
      <h2 class="modal-title">제목</h2>
      <button type="button" class="modal-close" data-modal-close aria-label="닫기">×</button>
    </div>
    <div class="modal-body">내용</div>
    <div class="modal-footer">
      <button type="button" class="btn btn-secondary" data-modal-close>취소</button>
      <button type="button" class="btn btn-primary">확인</button>
    </div>
  </div>
</div>
```

- **동작**: `data-modal-open="<id>"` 열기 / `data-modal-close`·배경 클릭·ESC 닫기 (`common.js`)
- **JS API**: `Common.openModal('id')`, `Common.closeModal('id')`
- **크기**: 기본 520px, `.modal-lg` 800px, radius 24px, Padding 32px, 구분선 없음
- Modal `id`는 페이지 접두사를 붙입니다 (예: `margin-result-modal`)

## 17. Loading

```html
<div class="loading"><span class="spinner"></span><p>불러오는 중이에요</p></div>
<div class="skeleton" style="height: 80px"></div>
```

- **CSS Class**: `.loading` `.spinner` `.spinner-sm` `.skeleton`
- API 호출 등 1초 이상 걸릴 수 있는 영역에 표시

## 18. Empty State

```html
<div class="state state-empty">
  <p class="state-title">아직 데이터가 없어요</p>
  <p>안내 문구</p>
  <!-- 필요 시 <button class="btn btn-soft">…</button> -->
</div>
```

## 19. Error State

```html
<div class="state state-error">
  <p class="state-title">불러오지 못했어요</p>
  <p>잠시 후 다시 시도해 주세요.</p>
  <button type="button" class="btn btn-secondary">다시 시도</button>
</div>
```

- 영역 전체가 실패했을 때 사용 (Card 안에 배치). 부분 오류·입력 오류는 Alert / `.form-error` 사용

---

## 페이지 구조 / 유틸리티

```html
{% extends "common/base.html" %}
{% block content %}
<div class="page-header">
  <div>
    <p class="page-eyebrow">날짜 등 (선택)</p>
    <h1 class="page-title">페이지 제목</h1>
    <p class="page-description">설명 (선택)</p>
  </div>
  <div class="page-actions"><!-- .btn-surface --></div>
</div>

<section class="section">
  <div class="section-header">
    <h2 class="section-title">Section 제목</h2>
    <span class="section-meta">출처 · 기준 시각 (선택)</span>
  </div>
  <div class="grid grid-3"> <!-- .card … --> </div>
</section>
{% endblock %}
```

| 분류 | Class |
|---|---|
| Grid | `.grid` + `.grid-2` `.grid-3` `.grid-4` `.grid-6` `.grid-2-1`(2:1), `.col-span-2` `.col-span-3` — 열 수는 **본문 폭** 기준으로 자동 축소(≤880px → 2열, ≤560px → 1열). Sidebar 접힘/펼침에도 반응. 항목 수가 유동적인 목록은 `.grid-auto`(최소 240px) / `.grid-auto-sm`(최소 168px): 본문이 넓어지면 열이 자동으로 늘어남 |
| 배치 | `.stack`(세로, gap 24px) `.row`(가로, gap 8px) |
| Spacing | `.mt-0/2/4/6/8` `.mb-0/2/4/6/8` |
| Text | `.text-secondary` `.text-caption` `.text-number` `.text-up`(빨강) `.text-down`(파랑) |
| 구현 전 표시 | `.placeholder` `.placeholder-title` (Card 안에 배치) |
