# Design System — COSMOA

> **프로젝트 전체 디자인의 기준 문서입니다. (PM 관리)**
>
> - 모든 팀원은 **반드시 이 문서를 기준으로** 화면을 구현합니다. 페이지 디자인을 독자적으로 새로 만들지 않습니다.
> - 이 문서의 값은 `src/common/style.css`의 `:root` CSS Variable과 **1:1로 일치**해야 합니다.
> - 색상·간격·글꼴 크기는 값을 직접 쓰지 말고 `var(--color-primary)`처럼 **Variable로만** 사용합니다.
> - 수정이 필요하면 PM과 공유한 뒤, 이 문서와 `style.css`를 **함께** 수정합니다.

**디자인 원본**: Claude Artifact "COSMOA - 로그인 & 홈" — https://claude.ai/artifact/FuNeQBvvcYDcthngzgjNjf
원본 소스 사본: `docs/reference/main.dc.html`(홈), `docs/reference/login.dc.html`(로그인). 값이 애매할 때는 이 파일의 inline style을 기준으로 합니다. (Artifact 전용 형식이라 브라우저에서 직접 열리지는 않습니다. 화면은 위 링크에서 확인)

| 버전 | 날짜 | 변경 내용 | 작성 |
|---|---|---|---|
| 0.1 | 2026-09-21 | 기본 구조 및 임시 기본값 작성 | PM |
| 1.0 | 2026-09-21 | COSMOA 디자인 원본 분석 결과 반영 | PM |
| 1.1 | 2026-09-21 | 기본 글꼴을 나눔스퀘어 네오 OTF(Rg / Bd / Eb)로 변경, 굵기를 3단계 역할 Variable로 정리 | PM |
| 1.2 | 2026-09-21 | UI 다듬기: Card 미세 Shadow(`--shadow-card`) 및 Hover Shadow, Input Focus Ring, Sidebar 구분선·활성 Indicator, Transition·Motion 규칙 추가 | PM |
| 1.3 | 2026-09-22 | Desktop Sidebar 접기/펼치기(264px ↔ 80px) 추가, `--layout-sidebar-width-collapsed` Token 추가. Grid 열 수를 화면 폭 → 본문 폭(Container Query) 기준으로 변경 | PM |

`(파생)` 표시는 원본에 없어서 같은 톤으로 맞춰 정한 값입니다. 원본에 해당 요소가 추가되면 교체합니다.

---

## 1. Brand / Visual Direction

| 항목 | 기준 |
|---|---|
| 서비스명 | **COSMOA** by COSTD |
| 전체 디자인 컨셉 | 국내 핀테크 앱 스타일의 밝고 단순한 업무 도구. 회색 배경 위에 **테두리 없는 흰색 둥근 Card**를 올려 정보를 구분 (그림자는 거의 보이지 않는 수준만) |
| Dashboard 분위기 | 차분하고 신뢰감 있는 Blue 단색 계열. 색은 Primary Blue 하나만 강조에 쓰고 나머지는 Gray 단계로 표현. Gradient, 장식 요소, Emoji 사용 안 함 |
| 화면 밀도 | **낮음(여유 있음)** — 본문 16px, Card 내부 여백 32px, Section 간격 72px. 한 화면에 많이 넣기보다 크게 읽히게 |
| 정보 우선순위 | ① 페이지 제목(38px) → ② Section 제목(26px) → ③ 핵심 수치(32~40px Bold) → ④ Card 제목·본문 → ⑤ 출처·기준 시각 등 보조 정보(14px Gray) |
| 문체 | 해요체 ("확인해요", "계산해요"). 데이터 출처와 기준 시각을 Section 우측에 표기 |
| Icon | 24×24 viewBox, `stroke="currentColor"`, `stroke-width: 2`, round cap/join의 **inline Line SVG**. Emoji·Icon Font 사용 안 함 |
| 증감 색상 | 국내 금융 관례: **상승 = 빨강(`--color-up`), 하락 = 파랑(`--color-down`)**. `▲ 0.32%` / `▼ 0.18%` 형식 |

## 2. Typography

- 기본 글꼴: **나눔스퀘어 네오 (NanumSquare Neo) OTF** — 폰트 파일을 프로젝트에 포함해 로컬 제공 (외부 CDN 미사용)
- 대체 글꼴: `"Apple SD Gothic Neo", "Malgun Gothic", sans-serif`
- 선언: `src/common/style.css` 상단의 `@font-face` / 파일 위치: `src/common/fonts/`
- 디자인 원본 시안은 IBM Plex Sans KR로 그려져 있으나, 프로젝트 글꼴은 나눔스퀘어 네오로 확정했습니다. 크기·색상은 원본 값을 그대로 따릅니다.

**굵기는 3종만 사용합니다.** `font-weight`에 숫자를 직접 쓰지 말고 Variable을 사용합니다. (300 / 500 / 600 / 900 등은 파일이 없어 의도와 다르게 표시됩니다)

| 굵기 | Variable | 파일 | 용도 |
|---|---|---|---|
| Regular 400 | `--font-weight-regular` | `nanum_square_neo_rg.otf` | 일반 본문, 설명, 메뉴(비활성), Caption |
| Bold 700 | `--font-weight-bold` | `nanum_square_neo_bd.otf` | 버튼, 소제목(Card 제목·Modal 제목), Label, 활성 메뉴·Tab, Badge, Table Header, 작은 수치 |
| ExtraBold 800 | `--font-weight-extrabold` | `nanum_square_neo_eb.otf` | 큰 제목(페이지 제목·Section 제목), 대표 수치(KPI), 로고 |

HTML 태그 기본값: `h1`·`h2` → ExtraBold / `h3`·`h4`·`strong`·`b`·`th` → Bold / 그 외 → Regular

| 용도 | Variable | 크기 | 굵기 | 자간 | Class |
|---|---|---|---|---|---|
| 페이지 제목 | `--font-size-page-title` | 38px | ExtraBold | -1px | `.page-title` |
| Section 제목 | `--font-size-section-title` | 26px | ExtraBold | -0.6px | `.section-title` |
| Card 제목 (소제목) | `--font-size-card-title` | 19px | Bold | 0 | `.card-title` |
| 버튼 | `--font-size-body` | 16px (sm 14 / lg 17) | Bold | 0 | `.btn` |
| 본문 | `--font-size-body` | 16px | Regular | 0 | (body 기본) |
| 메뉴 | `--font-size-sub` | 15px | Regular / 활성 Bold | -0.3px | `.app-nav__link` |
| 보조 설명 | `--font-size-sub` | 15px | Regular | 0 | `.kpi-label` 등 |
| Label / Meta | `--font-size-label` | 14px | Label Bold / Meta Regular | 0 | `.form-label`, `.section-meta`, `.card-subtitle` |
| Caption | `--font-size-caption` | 13px | Regular | 0 | `.text-caption` |
| 숫자 / KPI | `--font-size-kpi` | 32px | ExtraBold | -0.8px | `.kpi-value` |
| 숫자 / KPI (대표 수치) | `--font-size-kpi-lg` | 40px | ExtraBold | -1px | `.kpi-value.kpi-value-lg` |

- 기본 행간: `--line-height-base: 1.5` (제목 1.3)
- 숫자는 항상 `font-variant-numeric: tabular-nums` (`.text-number`, `.is-numeric`, `.kpi-value`)

## 3. Colors

| 역할 | Variable | 값 | 용도 |
|---|---|---|---|
| Primary | `--color-primary` | `#1B64DA` | Primary Button, Link, 활성 메뉴 텍스트, 강조 수치 |
| Primary Hover | `--color-primary-hover` | `#1957C2` | Hover |
| Primary Bright | `--color-primary-bright` | `#3182F6` | 로고, 차트 선·막대, Focus, Checkbox |
| Primary Soft | `--color-primary-soft` | `#E8F3FF` | 활성 메뉴 배경, Soft Button, Icon Tile, 차트 영역 |
| Primary Light | `--color-primary-light` | `#90C2FF` | 차트 보조 막대 |
| Secondary | `--color-secondary` | `#4E5968` | 보조 텍스트·Icon |
| Accent | `--color-accent` | `#3182F6` | Primary Bright와 동일 (별도 Accent 색 없음) |
| Background | `--color-background` | `#F2F4F6` | 페이지 배경, Input 배경, Segment 배경 |
| Surface | `--color-surface` | `#FFFFFF` | Card, Sidebar, Modal |
| Surface Muted | `--color-surface-muted` | `#F9FAFB` | Card 안의 보조 패널, Stat Tile, 사용자 영역 |
| Surface Inverse | `--color-surface-inverse` | `#191F28` | 선택된 Card |
| Border | `--color-border` | `#F2F4F6` | 구분선, 차트 Grid line |
| Border Strong | `--color-border-strong` | `#E5E8EB` (파생) | 강한 구분선, 점선 테두리 |
| Text Primary | `--color-text-primary` | `#191F28` | 제목, 본문 |
| Text Strong | `--color-text-strong` | `#333D4B` | 목록 항목 |
| Text Body | `--color-text-body` | `#4E5968` | 메뉴, Label, 설명 문단 |
| Text Secondary | `--color-text-secondary` | `#6B7684` | 보조 설명, Caption, 출처 |
| Text Placeholder | `--color-text-placeholder` | `#8B95A1` | Placeholder, 비활성 Icon |
| Text Inverse | `--color-text-inverse` / `-secondary` | `#FFFFFF` / `#B0B8C1` | 어두운 배경 위 텍스트 |
| Success | `--color-success` / `-soft` | `#029359` / `#E5F7EF` (파생) | 성공, 완료 |
| Warning | `--color-warning` / `-soft` | `#C76A00` / `#FFF3E0` (파생) | 주의 |
| Danger | `--color-danger` / `-soft` | `#E42939` / `#FFEEEE`(soft 파생) | 오류, 삭제 |
| Info | `--color-info` / `-soft` | `#1B64DA` / `#E8F3FF` | 안내 (Primary와 동일) |
| Up / Down | `--color-up` / `--color-down` | `#E42939` / `#1B64DA` | 수치 상승 / 하락 |

```css
:root {
    --color-primary: #1b64da;
    --color-primary-bright: #3182f6;
    --color-primary-soft: #e8f3ff;
    --color-background: #f2f4f6;
    --color-surface: #ffffff;
    --color-surface-muted: #f9fafb;
    --color-border: #f2f4f6;
    --color-text-primary: #191f28;
    --color-text-body: #4e5968;
    --color-text-secondary: #6b7684;
    --color-danger: #e42939;
}
```

전체 목록은 `src/common/style.css` 상단의 `:root`를 참고합니다.

**배경에 따른 색 선택** — 테두리가 없는 디자인이라 요소는 배경과의 명도 차이로 구분됩니다.

| 놓이는 위치 | 요소 배경 |
|---|---|
| 페이지 배경(`#F2F4F6`) 위 | 흰색 (`.card`, `.btn-surface`) |
| 흰색 Card 안 | 회색 `#F2F4F6` (`.form-control`, `.btn-secondary`, `.tabs`) 또는 `#F9FAFB` (`.stat-tile`, `.placeholder`) |

→ **Input, Table, Tabs는 Card 안에 배치합니다.** 페이지 배경 위에 직접 놓으면 보이지 않습니다.

## 4. Layout

| 항목 | Variable | 값 |
|---|---|---|
| 전체 페이지 최대 너비 | `--layout-max-width` | 1320px (Content 영역, 파생 — 원본은 1440px 화면 기준 1176px) |
| 최대 너비 (Sidebar 접힘) | `--layout-max-width-collapsed` | 1504px (파생) — 접어서 비는 184px만큼 본문이 넓어짐 |
| Header 높이 | `--layout-header-height` | **Desktop에는 Header 없음.** Tablet/Mobile 상단 Bar 60px |
| Sidebar 너비 | `--layout-sidebar-width` | 264px (흰색, 좌측 고정, Padding 32px 20px) |
| Sidebar 너비 (접힘) | `--layout-sidebar-width-collapsed` | 80px (파생) — Desktop에서 접었을 때, 아이콘만 표시. `html.is-sidebar-collapsed` |
| 페이지 Padding | `--layout-page-padding-y` / `-x` | 상 48px / 좌우 56px |
| Section 간격 | `--layout-section-gap` | 72px |
| Section 제목 ↔ 내용 | `--layout-section-inner-gap` | 24px |
| Card 간격 | `--layout-card-gap` | 16px |
| Card 내부 Padding | `--layout-card-padding` | 32px (바로가기 Card 28px, 작은 Card 18px) |
| Footer 높이 | `--layout-footer-height` | 96px |
| Grid 기준 | `.grid` + `.grid-2/3/4/6`, `.grid-2-1`(2:1) | 균등 분할, gap 16px. 열 수는 본문 폭 기준으로 축소 (§7) |
| Grid (자동 열) | `.grid.grid-auto` / `.grid-auto-sm` | 항목 최소 240px / 168px, 본문 폭에 맞춰 열 수가 자동으로 늘고 줆. 항목 수가 정해지지 않은 목록(국가 Card, KPI Tile 등)에 사용 |
| Spacing 단위 | `--space-1` ~ `--space-18` | 4 / 8 / 12 / 16 / 20 / 24 / 32 / 40 / 48 / 56 / 72px |

페이지 기본 구조 (`src/common/base.html`):

```
┌─ Sidebar (264px, 흰색) ─┬─ Main (배경 #F2F4F6) ──────────────────────┐
│  COSMOA 로고            │  .container (padding 48px 56px)             │
│  메뉴 (48px 항목)       │    .page-header   ← 날짜 + 페이지 제목      │
│                         │    .section       ← 72px 간격               │
│                         │    .section …                               │
│  [사용자 영역]          │  .app-footer (96px)                         │
└─────────────────────────┴─────────────────────────────────────────────┘
```

## 5. Shape

| 항목 | Variable | 값 | 사용처 |
|---|---|---|---|
| Border radius | `--radius-xs` | 10px | 로고, 작은 Button |
| | `--radius-sm` | 12px | 메뉴 항목, Icon Button, Segment |
| | `--radius-md` | 14px | Input, 기본 Button, Icon Tile |
| | `--radius-lg` | 16px | 큰 Button, Stat Tile, Alert |
| | `--radius-xl` | 20px | 작은 Card |
| | `--radius-2xl` | 24px | **Card**, Modal |
| | `--radius-pill` | 999px | Badge, Chip |
| Border | `--border-default` | `1px solid #F2F4F6` | Table 행 구분선 정도에만 사용. **Card, Button, Input에는 Border 없음** (Input Focus·Error 시에만 1px 표시) |
| Shadow | `--shadow-none` | 없음 | Shadow를 끄고 싶을 때 |
| | `--shadow-card` | `0 1px 2px rgba(25,31,40,.04)` (파생) | **Card 기본.** 거의 보이지 않는 깊이감만 줍니다. 이보다 진한 Shadow를 Card에 직접 쓰지 않습니다 |
| | `--shadow-card-hover` | `0 2px 4px rgba(25,31,40,.04), 0 12px 28px rgba(25,31,40,.08)` (파생) | 클릭 가능한 Card(`a.card`, `.card.is-clickable`), `.btn-surface`의 Hover |
| | `--shadow-focus` | `0 0 0 4px rgba(49,130,246,.16)` (파생) | Input·Input Group·Multi Select의 Focus Ring |
| | `--shadow-overlay` | `0 16px 48px rgba(25,31,40,.18)` (파생) | Modal, Mobile Drawer처럼 화면 위에 뜨는 요소만 |

## 6. Motion

| 항목 | 값 | 사용처 |
|---|---|---|
| 기본 Transition | `--transition-base: 0.2s cubic-bezier(0.33, 1, 0.68, 1)` | Hover·Focus 등 상태 변화 |
| 페이지 진입 | `page-enter` 0.4s (8px 위로 Fade-in) | `.container`, `.tab-panel` |
| Modal | Backdrop Fade 0.2s + Modal 0.28s (12px 위로) | `.modal-backdrop.is-open` |
| 누름 | `scale(0.97)` | `.btn:active` |
| Sidebar 접기/펼치기 | 너비·본문 여백 0.28s, 화살표 회전 | `.app-sidebar`, `.app-main`, `.app-sidebar__collapse` |

- 장식용 반복 Animation은 쓰지 않습니다. (Spinner, Skeleton 제외)
- `prefers-reduced-motion: reduce` 환경에서는 모든 Animation·Transition이 꺼집니다. (공통 CSS에서 처리)

## 7. Responsive

원본은 Desktop(1440px) 시안만 있습니다. Tablet/Mobile은 같은 규칙을 축소 적용한 값입니다. (파생)

| 구분 | 기준 | 동작 |
|---|---|---|
| Desktop | ≥ 1025px | Sidebar 고정, 상단 Bar 없음, 페이지 Padding 48 / 56px |
| Tablet | ≤ 1024px | 상단 Bar(60px) + 햄버거 → Sidebar Drawer, Padding 32px, Section 간격 56px, 페이지 제목 32px |
| Mobile | ≤ 640px | Padding 24 / 20px, Section 간격 40px, Card Padding 24px, 페이지 제목 26px, Modal Button 세로 배치 |

**Grid 열 수는 화면 폭이 아니라 본문 폭 기준입니다.** `.container`가 Container Query 기준(`container-name: page`)이라, Sidebar를 접거나 펼칠 때 본문 폭이 바뀌면 Grid가 그에 맞춰 다시 배치됩니다.

| 본문 폭 | 동작 |
|---|---|
| > 880px | `.grid-2/3/4/6` 선언한 열 수 그대로. `.grid-auto`는 폭이 넓어질수록 열 추가 |
| ≤ 880px | `.grid-3/4` → 2열, `.grid-6` → 3열, `.grid-2-1` → 1열, `.col-span-3` → 2칸 |
| ≤ 560px | 모든 Grid 1열 (`.grid-6`은 2열), `.col-span-*` 해제 |

페이지 CSS에서 Breakpoint가 필요하면:
- Grid·Card 배치처럼 **본문 폭에 따라** 바뀌어야 하는 것 → `@container page (max-width: 880px)` / `(max-width: 560px)`
- 상단 Bar 등 **화면 자체**에 따라 바뀌어야 하는 것 → `@media (max-width: 1024px)` / `(max-width: 640px)`

---

## 공통 디자인 변경 절차

1. 변경이 필요한 팀원이 PM에게 공유 (무엇을 / 왜)
2. PM이 이 문서의 값을 수정하고 버전 표에 기록
3. PM이 `src/common/style.css`의 `:root` 값을 동일하게 수정
4. 새 컴포넌트/규격이면 `docs/ui_components.md`도 함께 수정
5. 팀에 공지 → 각자 `git pull`

### 새 디자인 참고 자료를 반영할 때 (PM)

UI 이미지, HTML/CSS, Font 정보, Claude Artifact 등 새 자료가 생기면:

1. 자료를 `docs/reference/`에 저장 (Artifact는 링크도 이 문서 상단에 기록)
2. AI 도구에 자료와 함께 요청: "이 자료를 분석해서 `docs/design_system.md`, `docs/ui_components.md`, `src/common/style.css`에 공통 디자인으로 반영해 주세요. 필요하면 `src/common/base.html`과 각 페이지의 기본 Layout도 같은 디자인으로 조정하세요."
3. **금지**: 각 페이지 MD(`home.md`, `regulatory.md`, `margin.md`, `simulation.md`, `requisition.md`)의 기능 요구사항을 임의로 작성하거나 기능을 구현하지 않습니다.
4. Class 이름은 가능한 한 유지합니다. (담당자들의 HTML이 깨지지 않도록 값만 변경)
