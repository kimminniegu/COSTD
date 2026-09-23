/* 배합 계산 및 Canvas 시연. 공통 UI와 전역 이름을 공유하지 않습니다. */
(() => {
'use strict';

const $ = id => document.getElementById('simulation-' + id);
const fmt = n => n.toLocaleString('ko-KR');
const theme = getComputedStyle(document.documentElement);
const token = name => theme.getPropertyValue(name).trim();

// 도움말은 한 번에 하나만 표시. 마우스, 키보드, 터치에서 같은 설명을 제공합니다.
let activeHelp = null;
let helpTimer;
function closeHelp() {
  clearTimeout(helpTimer);
  if (!activeHelp) return;
  activeHelp.panel.hidden = true;
  activeHelp.button.setAttribute('aria-expanded', 'false');
  activeHelp = null;
}
function openHelp(button) {
  clearTimeout(helpTimer);
  if (activeHelp?.button === button) return;
  closeHelp();
  const panel = document.getElementById(button.dataset.simulationHelp);
  panel.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  activeHelp = { button, panel };
  // body에 두어 공통 container의 transform/contain 영향을 피합니다.
  document.body.append(panel);
  const rect = button.getBoundingClientRect();
  const bounds = panel.getBoundingClientRect();
  const left = Math.max(12, Math.min(rect.left, innerWidth - bounds.width - 12));
  const below = rect.bottom + 8;
  const top = below + bounds.height < innerHeight - 12 ? below : Math.max(12, rect.top - bounds.height - 8);
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}
document.querySelectorAll('[data-simulation-help]').forEach(button => {
  const panel = document.getElementById(button.dataset.simulationHelp);
  button.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') openHelp(button); });
  button.addEventListener('pointerleave', () => { helpTimer = setTimeout(closeHelp, 180); });
  button.addEventListener('focus', () => openHelp(button));
  button.addEventListener('click', () => openHelp(button));
  button.addEventListener('blur', closeHelp);
  panel.addEventListener('pointerenter', () => clearTimeout(helpTimer));
  panel.addEventListener('pointerleave', closeHelp);
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeHelp(); });
document.addEventListener('pointerdown', event => {
  if (activeHelp && !activeHelp.button.contains(event.target) && !activeHelp.panel.contains(event.target)) closeHelp();
});
window.addEventListener('resize', closeHelp);
window.addEventListener('scroll', closeHelp, true);

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
  optimal: { label: '적합', color: 'var(--color-primary)' },
  caution: { label: '주의', color: 'var(--color-warning)' },
  incompatible: { label: '부적합', color: 'var(--color-danger)' }
};

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
  button.className = 'btn btn-secondary btn-sm simulation-pack-option';

  const group = document.createElement('span');
  const name = document.createElement('strong');
  const detail = document.createElement('small');
  const action = document.createElement('span');

  name.textContent = p.name.split(' (')[0];
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

  $('active-out').textContent = a.toFixed(1) + '\%';$('active-ppm').textContent = `${fmt(activePpm)} ppm`;
  $('carb-out').textContent = c.toFixed(2) + '%';
  $('oil-out').textContent = o + '\%';$('hum-out').textContent = h + '%';

  $('viscosity').textContent = fmt(v);$('flow').textContent = flow + ' / 100';
  $('water').textContent = water.toFixed(2) + '\%';$('active-val').textContent = `${fmt(activePpm)} ppm`;

  $('texture').textContent = v < 2500 ? '묽은 워터리' : v < 9000 ? '산뜻한 점성' : v < 25000 ? '농축 리치' : '고밀도 밤(Balm)';
  $('flow-caption').textContent = v < 9000 ? '빠른 유동성 · 얇은 퍼짐성' : v < 25000 ? '완만한 레벨링 · 보습 밀착' : '형태 유지 · 높은 응집력';


  $('status-card').className = 'alert simulation-status-card alert-' + ({ optimal: 'info', caution: 'warning', incompatible: 'danger' }[state]);
  $('status-label').textContent = STATES[state].label;
  $('status-card').dataset.state = state;
  $('status-icon').textContent = { optimal: '✓', caution: '!', incompatible: '×' }[state];
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
    detail.textContent = `${range} cPs`;
    button.title = `권장 범위: ${range} cPs. ${spec.detail}`;
    button.hidden = !eligible.includes(k);
    button.style.display = button.hidden ? 'none' : '';
    button.setAttribute('aria-pressed', String(k === key));
    button.className = `btn ${k === key ? 'btn-soft' : 'btn-secondary'} btn-sm simulation-pack-option`;
    action.textContent = k === key ? '선택됨' : '선택 →';
  }
  emptyMsg.hidden = eligible.length > 0;

  // 기술 영업 피칭 가이드 업데이트
  const pitchText = generatePitchScript(v, key, state, isVitC, isOilPhase, isCapsule);
  $('pitch-script').textContent = pitchText;

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
  // 액적 안쪽에 광원을 반사해 둥근 부피감을 표현합니다.
  ctx.save();
  ctx.clip();
  const shine = ctx.createRadialGradient(x - r * .35, y - r * .3, 0, x - r * .2, y, r * 1.15);
  shine.addColorStop(0, 'rgba(255,255,255,.9)');
  shine.addColorStop(.3, 'rgba(255,255,255,.3)');
  shine.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = shine;
  ctx.fillRect(x - r * 2, y - r * 2, r * 4, r * 4);
  ctx.restore();
}

// Canvas에 원근·굴절·접지 그림자를 합성합니다. 배합/물성 계산과 독립된 렌더링입니다.
function drawSamplePlatform(x, y, radius, scale) {
  const depth = 18 * scale;
  const ry = radius * .22;
  ctx.save();
  ctx.translate(x + radius * .08, y + depth + 18 * scale);
  ctx.scale(1, .25);
  const shadow = ctx.createRadialGradient(0, 0, radius * .2, 0, 0, radius * 1.3);
  shadow.addColorStop(0, 'rgba(39,64,96,.24)');
  shadow.addColorStop(.65, 'rgba(39,64,96,.08)');
  shadow.addColorStop(1, 'rgba(39,64,96,0)');
  ctx.fillStyle = shadow;
  ctx.fillRect(-radius * 1.4, -radius * 1.4, radius * 2.8, radius * 2.8);
  ctx.restore();

  // 수평 타원 상판 + 두께가 있는 전면으로 유리 원판의 원근을 구성합니다.
  ctx.beginPath();
  ctx.ellipse(x, y, radius, ry, 0, 0, Math.PI);
  ctx.lineTo(x - radius, y + depth);
  ctx.ellipse(x, y + depth, radius, ry, 0, Math.PI, 0, true);
  ctx.closePath();
  const edge = ctx.createLinearGradient(x - radius, y, x + radius, y + depth);
  edge.addColorStop(0, '#b6cbdc');
  edge.addColorStop(.18, '#edf7ff');
  edge.addColorStop(.48, '#c5d6e5');
  edge.addColorStop(.8, '#8faac2');
  edge.addColorStop(1, '#dceaf4');
  ctx.fillStyle = edge;
  ctx.fill();

  ellipse(x, y, radius, ry);
  const top = ctx.createLinearGradient(x, y - ry, x, y + ry);
  top.addColorStop(0, '#e2edf5');
  top.addColorStop(.5, '#f8fcff');
  top.addColorStop(1, '#d9e8f4');
  ctx.fillStyle = top;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.95)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ellipse(x, y, radius * .9, ry * .87);
  ctx.strokeStyle = 'rgba(111,151,185,.22)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(x, y + depth, radius, ry, 0, .12, Math.PI - .12);
  ctx.strokeStyle = 'rgba(255,255,255,.75)';
  ctx.stroke();
}

function drawGlassPipette(x, top, tip, scale, thick) {
  const tubeW = 18 * scale;
  const taper = 34 * scale;
  ctx.save();
  // 유리 외곽 경로. 클리핑 영역 안에서 액체와 반사광을 차례로 합성합니다.
  ctx.beginPath();
  ctx.moveTo(x - tubeW, top);
  ctx.lineTo(x - tubeW, tip - taper);
  ctx.bezierCurveTo(x - tubeW, tip - 19 * scale, x - 6 * scale, tip - 8 * scale, x - 5 * scale, tip);
  ctx.lineTo(x + 5 * scale, tip);
  ctx.bezierCurveTo(x + 6 * scale, tip - 8 * scale, x + tubeW, tip - 19 * scale, x + tubeW, tip - taper);
  ctx.lineTo(x + tubeW, top);
  ctx.closePath();
  const glass = ctx.createLinearGradient(x - tubeW, 0, x + tubeW, 0);
  glass.addColorStop(0, 'rgba(100,142,175,.55)');
  glass.addColorStop(.12, 'rgba(219,241,254,.7)');
  glass.addColorStop(.28, 'rgba(255,255,255,.95)');
  glass.addColorStop(.48, 'rgba(233,248,255,.22)');
  glass.addColorStop(.82, 'rgba(135,182,214,.35)');
  glass.addColorStop(1, 'rgba(89,133,170,.55)');
  ctx.fillStyle = glass;
  ctx.fill();
  ctx.strokeStyle = 'rgba(110,154,190,.6)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.clip();
  const liquidTop = top + (tip - top) * .3;
  ctx.fillStyle = getFluidMaterial(x, liquidTop, tubeW, thick, current.isVitC, current.isCapsule);
  ctx.fillRect(x - tubeW + 3 * scale, liquidTop, tubeW * 2 - 6 * scale, tip - liquidTop);
  ellipse(x, liquidTop, tubeW - 3 * scale, 4 * scale);
  ctx.fillStyle = current.isVitC && !current.isCapsule ? '#d5b595' : '#cceefa';
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.66)';
  ctx.fillRect(x - tubeW * .62, top, 3 * scale, tip - top - 12 * scale);
  ctx.fillStyle = 'rgba(255,255,255,.28)';
  ctx.fillRect(x + tubeW * .6, top, 1.5 * scale, tip - top - 18 * scale);
  // 눈금은 유체를 가리지 않도록 우측 벽에 배치합니다.
  ctx.strokeStyle = 'rgba(70,109,143,.45)';
  ctx.lineWidth = .8;
  for (let i = 1; i <= 5; i++) {
    const yy = top + i * (tip - top - taper) / 6;
    ctx.beginPath();
    ctx.moveTo(x + tubeW * (i % 2 ? .5 : .2), yy);
    ctx.lineTo(x + tubeW * .9, yy);
    ctx.stroke();
  }
  ctx.restore();

  // 상단 고무 벌브와 금속 칼라: 원통형 명암으로 스포이드 형태를 완성합니다.
  const bulbW = tubeW * 1.25;
  const bulbH = 38 * scale;
  ctx.beginPath();
  ctx.roundRect(x - bulbW, top - bulbH, bulbW * 2, bulbH + 3 * scale, [bulbW, bulbW, 4 * scale, 4 * scale]);
  const bulb = ctx.createLinearGradient(x - bulbW, 0, x + bulbW, 0);
  bulb.addColorStop(0, '#294363');
  bulb.addColorStop(.3, '#607c9d');
  bulb.addColorStop(.5, '#405e80');
  bulb.addColorStop(1, '#243c57');
  ctx.fillStyle = bulb;
  ctx.fill();
  const collar = ctx.createLinearGradient(x - bulbW, 0, x + bulbW, 0);
  collar.addColorStop(0, '#9cabbc');
  collar.addColorStop(.3, '#ffffff');
  collar.addColorStop(.55, '#e0e8f0');
  collar.addColorStop(1, '#879bb0');
  ctx.fillStyle = collar;
  ctx.fillRect(x - bulbW, top - 3 * scale, bulbW * 2, 12 * scale);
  ellipse(x, top + 9 * scale, bulbW, 3 * scale);
  ctx.fill();
}

function drawScene() {
  if (!current || !width || !height) return;

  if (!displayViscosity || paused) {
    displayViscosity = current.v;
  }

  const x = width * .5;
  const tip = height * .43;
  const floor = height * .76;

  const thick = clamp(Math.log(1 + displayViscosity / 2000) / Math.log(26), 0, 1);
  const scale = Math.min(width / 480, height / 460, 1.45);
  const r = 17 * scale;
  const neckMax = lerp(22, 92, thick) * scale;
  const formEnd = .54;
  const hit = .76;
  const impact = phase >= hit ? (phase - hit) / (1 - hit) : 0;

  ctx.clearRect(0, 0, width, height);

  // 밝은 스튜디오의 곡면 배경: UI 배경과 재질 렌더링을 분리합니다.
  const light = ctx.createLinearGradient(0, 0, width * .6, height);
  light.addColorStop(0, '#f6f9fd');
  light.addColorStop(.5, '#e8f0f8');
  light.addColorStop(.72, '#f3f7fb');
  light.addColorStop(1, '#e1eaf4');
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, width, height);

  const glow = ctx.createRadialGradient(width * .32, height * .22, 0, x, height * .4, width * .65);
  glow.addColorStop(0, 'rgba(255,255,255,.95)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);
  const plateW = Math.min(width * .33, 235);
  drawSamplePlatform(x, floor + 6, plateW, scale);

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
  // 유체 상단 반사광과 낙하 충돌의 동심원 파동.
  ctx.save();
  ctx.clip();
  ellipse(x - poolW * .18, floor - poolH * .3 - 2, poolW * .56, Math.max(1, poolH * .24));
  ctx.fillStyle = 'rgba(255,255,255,.5)';
  ctx.fill();
  ctx.restore();
  if (impact > 0) {
    ellipse(x, floor - 1, poolW * (.3 + impact * .65), Math.max(2, poolH * (.3 + impact * .6)));
    ctx.strokeStyle = `rgba(255,255,255,${(1 - impact) * .6})`;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

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
    ctx.fillText('유수분 층분리 발생 (HLB 불균형)', x, floor - poolH - 10, width - 24);
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

  drawGlassPipette(x, height * .2, tip, scale, thick);

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
  ctx.fillText(stageNotice, x, height - 8, width - 32);
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
