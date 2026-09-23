/* 배합 계산, 저장 및 Canvas 시연. 공통 UI와 전역 이름을 공유하지 않습니다. */
(() => {
'use strict';

const $ = id => document.getElementById('simulation-' + id);
const fmt = n => n.toLocaleString('ko-KR');
const theme = getComputedStyle(document.documentElement);
const token = name => theme.getPropertyValue(name).trim();

const PRESETS = {
  serum: { name: '세럼', a: 2.0, c: 0.20, o: 5, h: 8, pack: 'dropper' },
  ampoule: { name: '고농축 앰플', a: 3.0, c: 0.35, o: 8, h: 10, pack: 'dropper' },
  lotion: { name: '로션', a: 1.0, c: 0.45, o: 18, h: 8, pack: 'pump' },
  cream: { name: '영양 크림', a: 2.0, c: 0.80, o: 28, h: 10, pack: 'jar' }
};

const PACKS = {
  dropper: {
    name: '스포이드 (Dropper)',
    min: 100,
    max: 5000,
    low: 30,
    high: 8500,
    detail: '저점도 제형 (흡입/토출 제어)'
  },
  pump: {
    name: '디스펜서 펌프 (Pump)',
    min: 800,
    max: 18000,
    low: 200,
    high: 28000,
    detail: '저·중점도 제형 (일반 펌핑)'
  },
  airless: {
    name: '에어리스 펌프 (Airless)',
    min: 2000,
    max: 50000,
    low: 500,
    high: 70000,
    detail: '중·고점도 제형 (산화 방지 진공 토출)'
  },
  jar: {
    name: '크림 자 (Jar)',
    min: 18000,
    max: Infinity,
    low: 9000,
    high: Infinity,
    detail: '고점도 제형 (단지형 용기)'
  }
};

const STATES = {
  optimal: { label: '적합 (Optimal)', color: 'var(--color-primary)' },
  caution: { label: '주의 (Caution)', color: 'var(--color-warning)' },
  incompatible: { label: '부적합 (Incompatible)', color: 'var(--color-danger)' }
};

let baseline = null;
let current = null;
let modified = false;
let paused = matchMedia('(prefers-reduced-motion: reduce)').matches;

// 3.3 예측 점도식 및 화학적 상성 보정
function calculateViscosity(a, c, o, h, isVitC, isCapsule) {
  const raw = Math.round(80 + Math.pow(c * 10, 2.3) * 260 + o * o * 22 + h * 18 + a * 45);
  // 비타민 C 15% 첨가 시 산성 pH로 카보머 겔 붕괴 (단, 캡슐화 솔루션 적용 시 90% 이상 방어 회복)
  if (isVitC) {
    return isCapsule ? Math.round(raw * 0.95) : Math.round(raw * 0.20);
  }
  return raw;
}

// 4. 용기 적합도 평가 및 점수 산출
function evaluatePackage(v, key) {
  const p = PACKS[key];
  if (v >= p.min && v <= p.max) return 'optimal';
  if (v >= p.low && v <= p.high) return 'caution';
  return 'incompatible';
}

function calculateScore(v, key, state) {
  const p = PACKS[key];
  if (state === 'optimal') {
    const mid = Number.isFinite(p.max) ? (p.min + p.max) / 2 : 25000;
    const range = Number.isFinite(p.max) ? (p.max - p.min) / 2 : 15000;
    const penalty = Math.min(10, Math.round(Math.abs(v - mid) / range * 8));
    return 100 - penalty;
  }
  if (state === 'caution') {
    return 65 + Math.round(Math.random() * 10);
  }
  return 25 + Math.round(Math.random() * 15);
}

function getEligiblePacks(v) {
  return Object.keys(PACKS).filter(key => evaluatePackage(v, key) === 'optimal');
}

// 추천 용기 버튼 UI 생성
const recommendationButtons = {};
for (const [key, p] of Object.entries(PACKS)) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-secondary simulation-pack-option';

  const group = document.createElement('span');
  const name = document.createElement('strong');
  const detail = document.createElement('small');
  const action = document.createElement('span');

  name.textContent = p.name;
  detail.textContent = p.detail;

  group.append(name, detail);
  button.append(group, action);

  button.addEventListener('click', () => {
    $('pack').value = key;
    update();
  });

  $('recommendations').append(button);
  recommendationButtons[key] = { button, action, detail };
}

const emptyMsg = document.createElement('p');
emptyMsg.className = 'text-caption';
emptyMsg.textContent = '적합 범위의 용기가 없습니다. 배합과 용기 사양을 함께 조정하세요.';
$('recommendations').append(emptyMsg);

// 5. 영업 피칭 스크립트 산출기
function generatePitchScript(v, key, state, isVitC, isOilPhase, isCapsule) {
  if (isCapsule) {
    return `"우려하신 유효 활성 성분 파괴 및 층분리는 당사 특허 마이크로 캡슐화(Capsule Tech)로 완벽히 수상과 격리했습니다. 시각적 심미성까지 확보되어 바이어사의 프리미엄 럭셔리 라인으로 승격 피칭하기 최적입니다."`;
  }
  if (isVitC) {
    return `"바이어사에서 요구하신 순수 비타민 C 15%는 강산성(pH 3.1)으로 인해 일반 고분자 겔 네트워크를 붕괴시킵니다. 당사 특허 마이크로 캡슐화 기술을 적용하여 겔을 보호하거나 산성 전용 안정화 복합체 처방으로 업그레이드를 제안드립니다."`;
  }
  if (isOilPhase) {
    return `"오일 성분 과다 투입으로 계면활성 밸런스가 무너져 장기 유수분 층분리 위험이 큽니다. 고압 마이크로 플루이딕 균질화 공정을 추가하거나 비타민 E를 비드화하여 수주 단가를 보정하는 전략을 권장합니다."`;
  }
  if (state === 'incompatible') {
    if (v > PACKS[key].high) {
      return `"현재 제형은 ${fmt(v)} cPs의 고영양·고점성 제형으로 현재 선택하신 용기로는 토출 저항이나 흡입 불능이 발생합니다. 진공 차단 기능의 에어리스 펌프나 럭셔리 단지형 자(Jar) 용기로의 변경을 강력히 권장합니다."`;
    }
    return `"현재 제형 점도가 낮아 용기 토출 시 측면 누액이나 비산 위험이 있습니다. 토출 오리피스 구경을 축소하거나 제형 점증제를 소폭 보강할 것을 제안드립니다."`;
  }
  return `"현재 배합 물성(${fmt(v)} cPs)은 해당 패키징의 토출 펌핑 곡선 중심에 안착되어 있어, 최상의 사용감과 안정적인 유통 수명을 보증합니다."`;
}

// 종합 상태 업데이트
function update() {
  const a = +$('active').value;
  const c = +$('carb').value;
  const o = +$('oil').value;
  const h = +$('hum').value;
  const key = $('pack').value;
  const p = PACKS[key];

  const isVitC = $('chk-vitaminc').checked;
  const isOilPhase = $('chk-oilphase').checked;
  const isCapsule = $('chk-capsule').checked;

  const v = calculateViscosity(a, c, o, h, isVitC, isCapsule);
  const state = evaluatePackage(v, key);
  const score = calculateScore(v, key, state);
  const water = Math.max(0, 100 - a - c - o - h);
  const flow = Math.round(100 / (1 + v / 6500));
  const activePpm = Math.round(a * 10000);

  current = { a, c, o, h, v, state, score, flow, water, isVitC, isOilPhase, isCapsule };

  $('sample-name').textContent = PRESETS[$('preset').value].name;
  $('modified').textContent = modified ? '사용자 조정 배합' : '기본 배합';
  $('water-sync').textContent = `정제수 동기화: ${water.toFixed(2)}%`;

  $('active-out').textContent = a.toFixed(1) + '\%';$('active-ppm').textContent = `${fmt(activePpm)} ppm`;
  $('carb-out').textContent = c.toFixed(2) + '%';
  $('oil-out').textContent = o + '\%';$('hum-out').textContent = h + '%';

  $('viscosity').textContent = fmt(v);$('flow').textContent = flow + ' / 100';
  $('water').textContent = water.toFixed(2) + '\%';$('active-val').textContent = `${fmt(activePpm)} ppm`;

  $('texture').textContent = v < 2500 ? '묽은 워터리' : v < 9000 ? '산뜻한 점성' : v < 25000 ? '농축 리치' : '고밀도 밤(Balm)';
  $('flow-caption').textContent = v < 9000 ? '빠른 유동성 · 얇은 퍼짐성' : v < 25000 ? '완만한 레벨링 · 보습 밀착' : '형태 유지 · 높은 응집력';

  $('recipe').textContent = `유효성분 ${a.toFixed(1)}% (${fmt(activePpm)} ppm) · 카보머 ${c.toFixed(2)}% · 오일 ${o}% · 수분유지제 ${h}% · 정제수 ${water.toFixed(2)}% = 총 100.00% 처방 동기화`;

  $('pack-name').textContent = p.name;
  $('status-card').className = 'alert simulation-status-card alert-' + ({ optimal: 'info', caution: 'warning', incompatible: 'danger' }[state]);
  $('status-label').textContent = STATES[state].label;
  $('status-score').textContent = `호환도 ${score}점`;

  let reasonText = '';
  if (state === 'optimal') {
    reasonText = `예측 점도(${fmt(v)} cPs)가 용기 허용 내경 및 토출 유압 곡선에 완벽히 부합합니다.`;
  } else if (v < p.min) {
    reasonText = `제형 점도가 낮아(${fmt(v)} cPs) 노즐 주변 누액 및 개봉 시 흘러넘침 우려가 있습니다.`;
  } else {
    reasonText = `제형 점도가 높아(${fmt(v)} cPs) 흡입 불능, 피스톤 복귀 지연 또는 노즐 막힘이 발생합니다.`;
  }
  $('reason').textContent = reasonText;

  // 권장 대체 용기 버튼 갱신
  const eligible = getEligiblePacks(v);
  for (const [k, { button, action, detail }] of Object.entries(recommendationButtons)) {
    const spec = PACKS[k];
    const range = Number.isFinite(spec.max) ? `${fmt(spec.min)}–${fmt(spec.max)}` : `${fmt(spec.min)} 이상`;
    detail.textContent = `권장 범위: ${range} cPs. ${spec.detail}`;
    button.hidden = !eligible.includes(k);
    button.style.display = button.hidden ? 'none' : '';
    button.setAttribute('aria-pressed', String(k === key));
    button.className = `btn ${k === key ? 'btn-soft' : 'btn-secondary'} simulation-pack-option`;
    action.textContent = k === key ? '선택됨' : '선택 →';
  }
  emptyMsg.hidden = eligible.length > 0;

  // 기술 영업 피칭 가이드 업데이트
  const pitchText = generatePitchScript(v, key, state, isVitC, isOilPhase, isCapsule);
  $('pitch-script').textContent = pitchText;

  renderComparison();
  if (paused) drawScene();
}

function loadPreset() {
  const p = PRESETS[$('preset').value];$('active').value = p.a;
  $('carb').value = p.c;
  $('oil').value = p.o;
  $('hum').value = p.h;
  $('pack').value = p.pack;

  $('chk-vitaminc').checked = false;
  $('chk-oilphase').checked = false;
  $('chk-capsule').checked = false;

  modified = false;
  update();
}

$('preset').addEventListener('change', loadPreset);$('pack').addEventListener('change', update);

['active', 'carb', 'oil', 'hum'].forEach(id => {
  $(id).addEventListener('input', () => {
    modified = true;
    update();
  });
});

['chk-vitaminc', 'chk-oilphase', 'chk-capsule'].forEach(id => {
  $(id).addEventListener('change', () => {
    modified = true;
    update();
  });
});

$('reset').addEventListener('click', () => {$('preset').value = 'ampoule';
  phase = 0;
  loadPreset();
});

// 피칭 스크립트 복사 기능
$('copy-pitch-btn').addEventListener('click', () => {
  const text = $('pitch-script').textContent;
  Promise.resolve().then(() => navigator.clipboard.writeText(text)).then(() => {
    const btnSpan = $('copy-pitch-btn').querySelector('span');
    btnSpan.textContent = '복사했어요';
    setTimeout(() => { btnSpan.textContent = '스크립트 복사'; }, 2000);
  }).catch(() => {
    $('copy-pitch-btn').querySelector('span').textContent = '복사하지 못했어요. 다시 시도해 주세요';
  });
});

// 6. 전후 비교 명세 (LocalStorage)
const STORAGE_KEY = 'integrated-formulation-baseline-v2';

function snapshot() {
  return {
    version: 2,
    preset: $('preset').value,
    active: +$('active').value,
    carb: +$('carb').value,
    oil: +$('oil').value,
    hum: +$('hum').value,
    pack: $('pack').value,
    flags: {
      vitaminC: $('chk-vitaminc').checked,
      oilPhase: $('chk-oilphase').checked,
      capsule: $('chk-capsule').checked
    },
    savedAt: new Date().toISOString()
  };
}

function renderComparison() {
  $('restore-baseline').disabled = !baseline;
  $('clear-baseline').disabled = !baseline;
  $('comparison-table').hidden = !baseline;

  $('save-baseline').textContent = baseline ? '현재 배합으로 기준 교체' : '현재 배합을 비교 기준으로 저장';

  if (!baseline) {
    $('compare-summary').textContent = '현재 배합을 저장한 뒤 슬라이더나 R&D 토글을 변경해 비교해 보세요.';
    $('comparison-body').replaceChildren();
    return;
  }

  const b = baseline;
  const n = snapshot();
  const bv = calculateViscosity(b.active, b.carb, b.oil, b.hum, b.flags.vitaminC, b.flags.capsule);
  const nv = calculateViscosity(n.active, n.carb, n.oil, n.hum, n.flags.vitaminC, n.flags.capsule);
  const diff = nv - bv;

  const delta = (v1, v2, d = 0, unit = '') => {
    const diffVal = v2 - v1;
    if (Math.abs(diffVal) < 1e-5) return '변화 없음';
    return (diffVal > 0 ? '+' : '−') + fmt(+Math.abs(diffVal).toFixed(d)) + unit;
  };

  const rows = [
    [
      '유효 활성 성분',
      `${b.active.toFixed(1)}% (${fmt(b.active * 10000)} ppm)`,
      `${n.active.toFixed(1)}% (${fmt(n.active * 10000)} ppm)`,
      delta(b.active, n.active, 1, '%p'),
      n.active > 5 ? '고농도 유효성분 안정화 처방 점검 필요' : '통상 규격 안정 범위'
    ],
    [
      '점증제 (카보머)',
      b.carb.toFixed(2) + '%',
      n.carb.toFixed(2) + '%',
      delta(b.carb, n.carb, 2, '%p'),
      n.carb < 0.2 ? '침전 및 점도 저하 방지 모니터링' : '겔 네트워크 형성'
    ],
    [
      '유상 오일 성분',
      b.oil + '%',
      n.oil + '%',
      delta(b.oil, n.oil, 0, '%p'),
      n.oil > 20 ? '고압 유화 및 전단 공정 필요' : '안정적 수상 분산'
    ],
    [
      '정제수 동기화 잔량',
      (100 - b.active - b.carb - b.oil - b.hum).toFixed(2) + '%',
      (100 - n.active - n.carb - n.oil - n.hum).toFixed(2) + '%',
      delta(100 - b.active - b.carb - b.oil - b.hum, 100 - n.active - n.carb - n.oil - n.hum, 2, '%p'),
      '100.0% 정량 균형 유지'
    ],
    [
      '예측 점도',
      fmt(bv) + ' cPs',
      fmt(nv) + ' cPs',
      delta(bv, nv, 0, ' cPs'),
      Math.abs(diff) > 5000 ? '토출 기구류 변경 여부 확인' : '유동성 허용치 충족'
    ],
    [
      '용기 적합도 판정',
      STATES[evaluatePackage(bv, b.pack)].label,
      STATES[evaluatePackage(nv, n.pack)].label,
      evaluatePackage(bv, b.pack) === evaluatePackage(nv, n.pack) ? '동일 유지' : '판정 등급 변경',
      evaluatePackage(nv, n.pack) === 'incompatible' ? '견적 업그레이드: 전용 용기 승격 필요' : '적합 규격 유지'
    ]
  ];

  $('comparison-body').replaceChildren(
    ...rows.map(([label, ...values]) => {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.scope = 'row';
      th.textContent = label;
      tr.append(th);

      values.forEach((v, i) => {
        const td = document.createElement('td');
        td.textContent = v;
        if (label === '용기 적합도 판정' && (i === 0 || i === 1)) {
          const evalState = i === 0 ? evaluatePackage(bv, b.pack) : evaluatePackage(nv, n.pack);
          td.style.color = STATES[evalState].color;
          td.style.fontWeight = 'var(--font-weight-bold)';
        }
        tr.append(td);
      });
      return tr;
    })
  );

  $('compare-summary').textContent = diff === 0
    ? '저장 기준 처방과 현재 예측 점도가 완벽히 동일합니다.'
    : `저장 기준 대비 점도가 ${fmt(Math.abs(diff))} cPs ${diff > 0 ? '상승(+)' : '하강(-)'}했습니다. (${Math.abs(diff / (bv || 1) * 100).toFixed(1)}% 변동)`;
}

$('save-baseline').addEventListener('click', () => {
  baseline = snapshot();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(baseline));
    $('storage-note').textContent = '브라우저에 비교 기준 처방 1건이 안전하게 저장되었습니다.';
  } catch {
    $('storage-note').textContent = '로컬 저장을 사용할 수 없어 세션 메모리에만 유지됩니다.';
  }
  renderComparison();
});

$('restore-baseline').addEventListener('click', () => {
  if (!baseline) return;
  const b = baseline;
  $('preset').value = b.preset;
  $('active').value = b.active;
  $('carb').value = b.carb;
  $('oil').value = b.oil;
  $('hum').value = b.hum;
  $('pack').value = b.pack;

  if (b.flags) {
    $('chk-vitaminc').checked = !!b.flags.vitaminC;
    $('chk-oilphase').checked = !!b.flags.oilPhase;
    $('chk-capsule').checked = !!b.flags.capsule;
  }
  modified = true;
  phase = 0;
  update();
});

$('clear-baseline').addEventListener('click', () => {   baseline = null;   try { localStorage.removeItem(STORAGE_KEY); } catch {}$('storage-note').textContent = '저장된 기준 처방을 초기화했습니다.';
  renderComparison();
});

// Canvas 2D 점탄성 물리 및 입자 렌더러
const canvas = $('canvas');
const ctx = canvas.getContext('2d');

let width = 0;
let height = 0;
let phase = 0;
let last = 0;
let frame = 0;
let displayViscosity = 0;

// 마이크로 골드 캡슐 파티클 생성
const capsules = Array.from({ length: 42 }, () => ({
  x: Math.random(),
  y: Math.random(),
  r: 1.5 + Math.random() * 2.2,
  speed: 0.15 + Math.random() * 0.35,
  alpha: 0.6 + Math.random() * 0.4
}));

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = t => t * t * (3 - 2 * t);

function resize() {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  width = r.width;
  height = r.height;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawScene();
}

function ellipse(x, y, rx, ry) {
  ctx.beginPath();
  ctx.ellipse(x, y, Math.max(.1, rx), Math.max(.1, ry), 0, 0, Math.PI * 2);
}

function getFluidMaterial(x, y, r, thick, isVitC, isCapsule) {
  const g = ctx.createLinearGradient(x - r, y, x + r, y + r);
  if (isVitC && !isCapsule) {
    // 비타민 C 단독 충돌 시 산화 갈변 톤
    g.addColorStop(0, `rgba(180, 130, 80, ${lerp(.4, .85, thick)})`);
    g.addColorStop(.5, `rgba(160, 100, 50, ${lerp(.5, .9, thick)})`);
    g.addColorStop(1, 'rgba(130, 80, 30, 0.7)');
    return g;
  }
  // 기본 청명한 아스트라 블루 톤
  g.addColorStop(0, `rgba(125,205,235,${lerp(.42, .92, thick)})`);
  g.addColorStop(.27, `rgba(224,248,255,${lerp(.77, .98, thick)})`);
  g.addColorStop(.53, `rgba(106,193,227,${lerp(.46, .94, thick)})`);
  g.addColorStop(.83, `rgba(36,104,145,${lerp(.64, .98, thick)})`);
  g.addColorStop(1, 'rgba(171,227,249,.8)');
  return g;
}

function finishLiquid(x, y, r, t, isVitC, isCapsule) {
  ctx.fillStyle = getFluidMaterial(x, y, r, t, isVitC, isCapsule);
  ctx.fill();
  ctx.strokeStyle = isVitC && !isCapsule ? 'rgba(210,160,110,.5)' : 'rgba(202,243,255,.48)';
  ctx.lineWidth = .7;
  ctx.stroke();
}

function drawScene() {
  if (!current || !width || !height) return;

  if (!displayViscosity || paused) {
    displayViscosity = current.v;
  }

  const x = width * .5;
  const tip = height * .33;
  const floor = height * .78;

  const thick = clamp(Math.log(1 + displayViscosity / 2000) / Math.log(26), 0, 1);
  const scale = Math.min(width / 600, height / 420, 1.25);
  const r = 17 * scale;
  const neckMax = lerp(22, 92, thick) * scale;
  const formEnd = .54;
  const hit = .76;
  const impact = phase >= hit ? (phase - hit) / (1 - hit) : 0;

  ctx.clearRect(0, 0, width, height);

  // 배경 조명 & 실험대 그리드
  const light = ctx.createRadialGradient(x, height * .4, 2, x, height * .48, width * .52);
  light.addColorStop(0, 'rgba(56,126,170,.19)');
  light.addColorStop(.6, 'rgba(28,59,87,.08)');
  light.addColorStop(1, 'rgba(9,15,24,0)');
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = 'rgba(89,139,174,.07)';
  ctx.lineWidth = 1;
  for (let i = -5; i <= 5; i++) {
    ctx.beginPath();
    ctx.moveTo(x + i * width * .07, height * .65);
    ctx.lineTo(x + i * width * .12, height);
    ctx.stroke();
  }

  // 유리 받침대 렌더링
  const plateW = Math.min(width * .34, 230);
  const plateH = 27 * scale;

  ctx.save();
  ctx.translate(x, floor + 19);
  ctx.scale(1, .22);
  const shadow = ctx.createRadialGradient(0, 0, 2, 0, 0, plateW);
  shadow.addColorStop(0, 'rgba(25,31,40,.12)');
  shadow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = shadow;
  ctx.fillRect(-plateW, -plateW, plateW * 2, plateW * 2);
  ctx.restore();

  ellipse(x, floor + 6, plateW, plateH);
  ctx.fillStyle = 'rgba(86,137,164,.12)';
  ctx.fill();
  ctx.strokeStyle = token('--color-primary-light');
  ctx.stroke();

  // 바닥 액웅덩이
  const settle = phase < hit ? 1 : ease(clamp(impact * 2, 0, 1));
  const poolW = lerp(95, 36, thick) * scale * (phase < hit ? 1 : lerp(.86, 1, settle));
  const poolH = lerp(5, 23, thick) * scale;
  const bounce = impact > 0 ? Math.sin(impact * Math.PI * 4) * Math.exp(-impact * 7) * (1 - thick) * 4 : 0;

  ellipse(x, floor - 2, poolW, poolH + bounce);
  ctx.fillStyle = getFluidMaterial(x, floor, poolW, thick, current.isVitC, current.isCapsule);
  ctx.fill();
  ctx.strokeStyle = current.isVitC && !current.isCapsule ? 'rgba(220,150,100,.4)' : 'rgba(190,241,254,.3)';
  ctx.stroke();

  // [R&D 시각 효과 1: 유수분 상분리 주황색 오일 띠 렌더링]
  if (current.isOilPhase && !current.isCapsule) {
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(x, floor - poolH * 0.4, poolW * 0.85, poolH * 0.35, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(245, 158, 11, 0.75)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(251, 191, 36, 0.9)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    // 상분리 경고 라벨 오버레이
    ctx.font = `${token('--font-size-caption')} ${token('--font-family-base')}`;
    ctx.fillStyle = token('--color-warning');
    ctx.textAlign = 'center';
    ctx.fillText('유수분 층분리 발생 (HLB 불균형)', x, floor - poolH - 10);
  }

  // [R&D 시각 효과 2: 특허 골드 마이크로 캡슐 파티클 부유]
  if (current.isCapsule) {
    ctx.save();
    capsules.forEach(c => {
      const px = x - poolW * 0.7 + c.x * (poolW * 1.4);
      const py = floor - poolH * 0.6 + c.y * (poolH * 1.1);
      ctx.beginPath();
      ctx.arc(px, py, c.r * scale, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(245, 158, 11, ${c.alpha})`;
      ctx.shadowColor = '#fbbf24';
      ctx.shadowBlur = 6;
      ctx.fill();
    });
    ctx.restore();
  }

  // 피펫 실린더 렌더링
  const tubeW = 15 * scale;
  const top = height * .12;

  ctx.beginPath();
  ctx.moveTo(x - tubeW, top);
  ctx.lineTo(x - tubeW, tip - 27 * scale);
  ctx.quadraticCurveTo(x - tubeW, tip - 17 * scale, x - 5 * scale, tip);
  ctx.lineTo(x + 5 * scale, tip);
  ctx.quadraticCurveTo(x + tubeW, tip - 17 * scale, x + tubeW, tip - 27 * scale);
  ctx.lineTo(x + tubeW, top);
  ctx.closePath();

  const glass = ctx.createLinearGradient(x - tubeW, 0, x + tubeW, 0);
  glass.addColorStop(0, 'rgba(179,218,238,.32)');
  glass.addColorStop(1, 'rgba(223,245,255,.48)');
  ctx.fillStyle = glass;
  ctx.fill();
  ctx.strokeStyle = token('--color-primary-light');
  ctx.lineWidth = .8;
  ctx.stroke();

  // 피펫 내부 유체 렌더링
  ctx.save();
  ctx.clip();
  ctx.fillStyle = getFluidMaterial(x, top, tubeW, thick, current.isVitC, current.isCapsule);
  ctx.fillRect(x - tubeW + 4, top + 20, tubeW * 2 - 8, tip - top);
  ctx.restore();

  // 액적 물리 애니메이션 (Bézier Necking Tail & Droplet)
  let stageText = '액적 형성';

  if (phase < formEnd) {
    const p = phase / formEnd;
    const grow = ease(clamp(p / .65, 0, 1));
    const pinch = ease(clamp((p - .68) / .32, 0, 1));
    const rr = r * lerp(.32, 1, grow);
    const neck = lerp(4, neckMax, ease(p));
    const yy = tip + neck + rr * .6;
    const waist = lerp(4 * scale, .45 * scale, pinch);

    ctx.beginPath();
    ctx.moveTo(x - 4 * scale, tip);
    ctx.bezierCurveTo(x - waist, tip + neck * .48, x - rr, yy - rr * .9, x - rr, yy);
    ctx.bezierCurveTo(x - rr, yy + rr * 1.3, x + rr, yy + rr * 1.3, x + rr, yy);
    ctx.bezierCurveTo(x + rr, yy - rr * .9, x + waist, tip + neck * .48, x + 4 * scale, tip);
    ctx.closePath();
    finishLiquid(x, yy, rr, thick, current.isVitC, current.isCapsule);

    stageText = p > .68 ? '비뉴턴 유체 필라멘트 신장' : '액적 형성';
  } else if (phase < hit) {
    const t = (phase - formEnd) / (hit - formEnd);
    const startY = tip + neckMax + r * .6;
    const yy = lerp(startY, floor - poolH - r * .7, t * t);
    const elongation = 1 + Math.sin(t * Math.PI) * .28 + thick * .2;

    ellipse(x, yy, r / Math.sqrt(elongation), r * elongation);
    finishLiquid(x, yy, r, thick, current.isVitC, current.isCapsule);

    stageText = '자유 낙하 가속도';
  } else {
    stageText = thick > .6 ? '고점도 레벨링 완만 적층' : '표면 장력 이완 및 확산';
  }

  // HUD 상태 문구
  ctx.font = `${token('--font-size-caption')} ${token('--font-family-base')}`;
  ctx.textAlign = 'center';
  ctx.fillStyle = current.isCapsule ? token('--color-warning') : token('--color-text-secondary');
  const stageNotice = current.isCapsule ? `[특허 캡슐화 보호 중] ${stageText}` : stageText;
  ctx.fillText(stageNotice, x, Math.min(height - 35, floor + 42));
}

function tick(time) {
  frame = 0;
  if (paused || document.hidden) {
    last = 0;
    return;
  }

  const dt = last ? Math.min((time - last) / 1000, .05) : 0;
  last = time;

  displayViscosity = lerp(displayViscosity || current.v, current.v, 1 - Math.exp(-dt * 5));

  // 캡슐 파티클 부유 애니메이션
  if (current && current.isCapsule) {
    capsules.forEach(c => {
      c.y += (Math.sin(time * 0.002 + c.x * 10) * 0.005) * c.speed;
      c.x += (Math.cos(time * 0.002 + c.y * 10) * 0.003) * c.speed;
    });
  }

  const duration = lerp(1.4, 4.5, clamp(Math.log(1 + displayViscosity / 2000) / Math.log(26), 0, 1));
  phase = (phase + dt / duration) % 1;

  drawScene();
  frame = requestAnimationFrame(tick);
}

function start() {
  if (!paused && !document.hidden && !frame) {
    frame = requestAnimationFrame(tick);
  }
}

function motionLabel() {
  $('motion').textContent = paused ? '시연 재생' : '시연 일시정지';
  $('motion').setAttribute('aria-pressed', String(paused));
}

$('motion').addEventListener('click', () => {
  paused = !paused;
  motionLabel();
  if (paused) {
    cancelAnimationFrame(frame);
    frame = 0;
    last = 0;
  } else {
    start();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    cancelAnimationFrame(frame);
    frame = 0;
    last = 0;
  } else {
    start();
  }
});

// 초기화
loadPreset();
motionLabel();
new ResizeObserver(resize).observe(canvas);
resize();
start();
})();
