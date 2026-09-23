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
let paused = matchMedia('(prefers-reduced-motion: reduce)').matches;

// 네 가지 배합비에 따른 기본 예측 점도식
function calculateViscosity(a, c, o, h) {
  return Math.round(80 + Math.pow(c * 10, 2.3) * 260 + o * o * 22 + h * 18 + a * 45);
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
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 20 20');
  icon.setAttribute('aria-hidden', 'true');
  const outline = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  outline.setAttribute('d', key === 'jar' ? 'M4 7h12v9H4z M3 4h14v3H3z' : key === 'dropper' ? 'M8 3h4v5l2 3v6H6v-6l2-3z' : 'M6 8h8v9H6z M10 8V3h6 M8 3h5');
  icon.append(outline);
  button.append(icon, group, action);

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

// 동일한 배합·용기·점수로 연구소와 바이어용 리포트를 함께 생성합니다.
function generateReports(v, key, state, score) {
  const name = PACKS[key].name.split(' (')[0];
  const eligible = getEligiblePacks(v);
  const alternatives = eligible.filter(candidate => candidate !== key);
  const names = alternatives.map(candidate => PACKS[candidate].name.split(' (')[0]).join(' 또는 ');
  const risk = state === 'optimal'
    ? '예측 점도 기준 적합 범위 확인'
    : v < PACKS[key].min ? '저점도로 인한 누액·비산 가능성 확인' : '흡입 불량·토출 저항 및 노즐 막힘 가능성 확인';
  const report = `점도 ${fmt(v)} cPs · ${name}: ${risk} (호환도 ${score}점).`;
  const action = state === 'optimal'
    ? '현 용기 유지 후 실제 토출량·안정성 시험 권장.'
    : names ? `${names}로 패키징 변경 권장.` : '배합 점도와 용기 사양의 동시 재검토 권장.';
  const sales = state === 'optimal'
    ? `현재 제형의 예측 물성에 적합한 ${name}를 매칭했습니다. 사용감과 토출 성능을 함께 고려한 프리미엄 제품 구성을 제안합니다.`
    : names ? `현재 배합의 사용감을 살리기 위해 ${names} 적용을 제안합니다. 제형에 맞는 패키징으로 제품 완성도를 높일 수 있습니다.`
    : '목표 사용감에 맞춘 배합과 전용 용기 사양을 함께 조정하는 방향을 제안합니다.';
  return { report, action, sales };
}

// 종합 상태 업데이트
function update() {
  const a = +$('active').value;
  const c = +$('carb').value;
  const o = +$('oil').value;
  const h = +$('hum').value;
  const key = $('pack').value;

  const v = calculateViscosity(a, c, o, h);
  const state = evaluatePackage(v, key);
  const score = calculateScore(v, key, state);
  const water = Math.max(0, 100 - a - c - o - h);
  const flow = Math.round(100 / (1 + v / 6500));
  const activePpm = Math.round(a * 10000);

  current = { a, c, o, h, v, state, score, flow, water };


  ['active', 'carb', 'oil', 'hum'].forEach(id => {
    const slider = $(id);
    slider.style.setProperty('--simulation-progress', `${(slider.value - slider.min) / (slider.max - slider.min) * 100}%`);
  });

  $('active-out').textContent = a.toFixed(1) + '\%';
  $('carb-out').textContent = c.toFixed(2) + '%';
  $('oil-out').textContent = o + '\%';$('hum-out').textContent = h + '%';

  $('viscosity').textContent = fmt(v);$('flow').textContent = flow + ' / 100';
  $('water').textContent = water.toFixed(2) + '\%';$('active-val').textContent = fmt(activePpm);
  $('flow-gauge').value = flow;
  $('water-gauge').value = water;
  const parts = { active: a, carb: c, oil: o, hum: h, water };
  Object.entries(parts).forEach(([id, pct]) => {
    $('formula-' + id).style.flexGrow = pct;
    $('formula-' + id).hidden = pct <= 0;
  });
  $('formula-total').textContent = Object.values(parts).reduce((sum, pct) => sum + pct, 0).toFixed(1) + '%';
  $('formula-bar').setAttribute('aria-label', `유효 ${a}%, 점증제 ${c}%, 오일 ${o}%, 보습 ${h}%, 정제수 ${water.toFixed(2)}%`);
  const stability = water < 45 || (o >= 20 && c < 0.2) ? 'unstable' : water < 60 || (o >= 12 && c < 0.2) ? 'review' : 'stable';
  $('formula-badge').dataset.state = stability;
  $('formula-badge').textContent = { stable: '안정', review: '검토', unstable: '주의' }[stability];
  $('formula-badge').dataset.en = { stable: 'Stable', review: 'Review', unstable: 'Unstable' }[stability];
  $('lab-flow').textContent = `${flow} / 100`;
  $('lab-cycle').textContent = `${(.9 / (1 + v / 9000) + .08).toFixed(2)} /s`;

  $('texture').textContent = v < 2500 ? '묽은 워터리' : v < 9000 ? '산뜻한 점성' : v < 25000 ? '농축 리치' : '고밀도 밤(Balm)';
  $('flow-caption').textContent = v < 9000 ? '빠른 유동성 · 얇은 퍼짐성' : v < 25000 ? '완만한 레벨링 · 보습 밀착' : '형태 유지 · 높은 응집력';


  $('status-card').className = 'simulation-status-card';
  $('status-label').textContent = STATES[state].label;
  $('status-card').dataset.state = state;
  $('status-icon').textContent = { optimal: '✓', caution: '!', incompatible: '×' }[state];
  $('status-score').textContent = score;
  $('score-ring').style.setProperty('--simulation-score', `${score}%`);
  $('score-ring').setAttribute('aria-label', `예측 호환도 ${score}점 / 100, ${STATES[state].label}`);
  const packName = PACKS[key].name.split(' (')[0];
  $('diagnosis').textContent = state === 'optimal'
    ? `${fmt(v)} cPs · ${packName}의 권장 점도 범위입니다. 실제 토출량과 안정성 시험으로 최종 확인하세요.`
    : v < PACKS[key].min
      ? `저점도 제형(${fmt(v)} cPs)으로 ${packName} 사용 시 누액·비산 가능성이 있습니다.`
      : `고점도 제형(${fmt(v)} cPs)으로 ${packName} 사용 시 흡입 불량·토출 저항 및 노즐 막힘 위험이 있습니다.`;

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
  const reports = generateReports(v, key, state, score);
  $('rd-report').textContent = reports.report;
  $('rd-action').textContent = reports.action;
  $('pitch-script').textContent = reports.sales;

  if (paused) drawScene();
}

function loadPreset() {
  const p = PRESETS[$('preset').value];$('active').value = p.a;
  $('carb').value = p.c;
  $('oil').value = p.o;
  $('hum').value = p.h;
  $('pack').value = p.pack;


  update();
}

$('preset').addEventListener('change', loadPreset);$('pack').addEventListener('change', update);

['active', 'carb', 'oil', 'hum'].forEach(id => {
  $(id).addEventListener('input', () => {
    update();
  });
});

$('reset').addEventListener('click', () => {$('preset').value = 'ampoule';
  phase = 0;
  loadPreset();
});

// 피칭 스크립트 복사 기능
$('copy-pitch-btn').addEventListener('click', () => {
  const text = `[R&D 연구소 리포트]\n${$('rd-report').textContent}\n${$('rd-action').textContent}\n\n[바이어 세일즈 피칭]\n${$('pitch-script').textContent}`;
  Promise.resolve().then(() => navigator.clipboard.writeText(text)).then(() => {
    const btnSpan = $('copy-pitch-btn').querySelector('span');
    btnSpan.textContent = '복사했어요';
    setTimeout(() => { btnSpan.textContent = '스크립트 복사'; }, 2000);
  }).catch(() => {
    $('copy-pitch-btn').querySelector('span').textContent = '복사하지 못했어요. 다시 시도해 주세요';
  });
});

// Canvas lighting layers retain the original viscosity-driven animation.
const canvas=$('canvas'),ctx=canvas.getContext('2d');let width=0,height=0,phase=0,last=0,frame=0;
// Uniform logical coordinates preserve proportions on every viewport.
function resize() {
  const bounds = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(bounds.width * dpr);
  canvas.height = Math.round(bounds.height * dpr);
  width = 560;
  height = 420;
  const scale = Math.min(bounds.width / width, bounds.height / height);
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale,
    (bounds.width - width * scale) / 2 * dpr,
    (bounds.height - height * scale) / 2 * dpr);
  drawScene();
}
// Layered transmission, edge depth and a soft key light for clear serum.
function paintSerum(path, x, y, rx, ry) {
 ctx.save();
 ctx.shadowColor='rgba(30,90,130,.12)';ctx.shadowBlur=7;ctx.shadowOffsetY=3;
 const body=ctx.createLinearGradient(x-rx,y-ry,x+rx,y+ry);
 body.addColorStop(0,'rgba(56,149,209,.62)');
 body.addColorStop(.22,'rgba(125,211,252,.48)');
 body.addColorStop(.48,'rgba(224,247,255,.24)');
 body.addColorStop(.75,'rgba(56,189,248,.53)');
 body.addColorStop(1,'rgba(29,112,175,.72)');
 ctx.fillStyle=body;ctx.fill(path);ctx.shadowBlur=0;ctx.shadowOffsetY=0;
 ctx.clip(path);
 const light=ctx.createRadialGradient(x-rx*.32,y-ry*.4,0,x-rx*.32,y-ry*.4,rx*.9);
 light.addColorStop(0,'rgba(255,255,255,.92)');light.addColorStop(.35,'rgba(255,255,255,.48)');light.addColorStop(1,'rgba(255,255,255,0)');
 ctx.save();ctx.translate(x-rx*.32,y-ry*.4);ctx.scale(1,Math.max(.25,ry/rx*.5));
 ctx.translate(-x+rx*.32,-y+ry*.4);ctx.fillStyle=light;ctx.fillRect(x-rx*3,y-rx*3,rx*6,rx*6);ctx.restore();
 ctx.strokeStyle='rgba(239,251,255,.75)';ctx.lineWidth=1.2;ctx.stroke(path);
 ctx.restore();
}
function drawScene(){
 if(!current||!width||!height)return;
 ctx.clearRect(0,0,width,height);
 const x=width/2,tip=130,floor=height*.8;
 const thick=Math.min(1,current.v/50000),dropTime=.58+thick*.16;
 const spread=100*(1-thick*.7),domeHeight=18+thick*30;
 const maxNeck=(floor-tip-domeHeight)*(.18+thick*.3);
 // Faint reference scales are illustrative, not a calibrated measurement.
 ctx.save();ctx.strokeStyle='#e2e8f0';ctx.fillStyle='#94a3b8';ctx.lineWidth=.7;ctx.font='9px monospace';
 const rulerX=x-100;
 ctx.beginPath();ctx.moveTo(rulerX,140);ctx.lineTo(rulerX,300);
 for(let i=0;i<=8;i++){const yy=140+i*20;ctx.moveTo(rulerX,yy);ctx.lineTo(rulerX+(i%2?5:10),yy);if(i%2===0)ctx.fillText(`${(i*.05).toFixed(1)}`,rulerX-25,yy+3);}
 ctx.stroke();ctx.fillText('mL REF',rulerX-25,125);
 ctx.beginPath();ctx.setLineDash([2,7]);ctx.moveTo(x,145);ctx.lineTo(x,floor-55);ctx.stroke();ctx.setLineDash([]);
 for(const yy of [160,250]){ctx.beginPath();ctx.moveTo(x+88,yy);ctx.lineTo(x+98,yy);ctx.moveTo(x+93,yy-5);ctx.lineTo(x+93,yy+5);ctx.stroke();}
 ctx.beginPath();for(let i=-5;i<=5;i++){const xx=x+i*20;ctx.moveTo(xx,floor+40);ctx.lineTo(xx,floor+40+(i%5===0?7:4));}ctx.stroke();ctx.fillText('0',x-3,floor+59);ctx.fillText('10 mm REF',x+70,floor+59);
 // Clear quartz dish: back rim, glass sidewall and a refracted front lip.
 const plate=ctx.createLinearGradient(0,floor-9,0,floor+30);
 plate.addColorStop(0,'rgba(255,255,255,.72)');plate.addColorStop(.55,'rgba(210,227,238,.18)');plate.addColorStop(1,'rgba(155,184,205,.32)');
 ctx.fillStyle=plate;ctx.beginPath();ctx.ellipse(x,floor+11,135,23,0,0,Math.PI*2);ctx.fill();
 ctx.strokeStyle='rgba(148,175,195,.4)';ctx.lineWidth=1;ctx.stroke();
 ctx.beginPath();ctx.ellipse(x,floor+3,135,23,0,0,Math.PI*2);ctx.fillStyle='rgba(255,255,255,.32)';ctx.fill();ctx.stroke();
 ctx.beginPath();ctx.ellipse(x,floor+4,127,19,0,0,Math.PI);ctx.strokeStyle='rgba(255,255,255,.95)';ctx.lineWidth=2;ctx.stroke();ctx.restore();
 // Contact shadow grounds the serum on the quartz surface.
 ctx.save();ctx.translate(x,floor+8);ctx.scale(1,.18);
 const shadow=ctx.createRadialGradient(0,0,spread*.12,0,0,spread*1.2);
 shadow.addColorStop(0,'rgba(41,75,98,.19)');shadow.addColorStop(.65,'rgba(41,75,98,.06)');shadow.addColorStop(1,'rgba(41,75,98,0)');
 ctx.fillStyle=shadow;ctx.fillRect(-spread*1.2,-spread*1.2,spread*2.4,spread*2.4);ctx.restore();
 // A convex surface-tension profile, with a refracted lower meniscus.
 const pool=new Path2D();
 pool.moveTo(x-spread,floor);
 pool.bezierCurveTo(x-spread*.9,floor-domeHeight*.7,x-spread*.45,floor-domeHeight,x,floor-domeHeight);
 pool.bezierCurveTo(x+spread*.5,floor-domeHeight,x+spread*.92,floor-domeHeight*.64,x+spread,floor);
 pool.bezierCurveTo(x+spread*.85,floor+14,x-spread*.82,floor+14,x-spread,floor);
 pool.closePath();
 paintSerum(pool,x,floor-domeHeight*.35,spread,domeHeight);
 ctx.save();ctx.clip(pool);
 const base=ctx.createLinearGradient(0,floor-3,0,floor+12);
 base.addColorStop(0,'rgba(56,189,248,0)');base.addColorStop(.7,'rgba(30,117,174,.24)');base.addColorStop(1,'rgba(224,247,255,.8)');
 ctx.fillStyle=base;ctx.fillRect(x-spread,floor-3,spread*2,16);
 ctx.beginPath();ctx.ellipse(x-spread*.23,floor-domeHeight*.69,spread*.38,Math.max(2,domeHeight*.09),-.06,0,Math.PI*2);
 ctx.fillStyle='rgba(255,255,255,.66)';ctx.fill();
 ctx.beginPath();ctx.moveTo(x-spread*.8,floor+1);ctx.bezierCurveTo(x-spread*.35,floor+8,x+spread*.5,floor+8,x+spread*.86,floor-1);
 ctx.strokeStyle='rgba(213,245,255,.88)';ctx.lineWidth=1.4;ctx.stroke();
 if(phase>.9){
 const t=(phase-.9)/.1;ctx.beginPath();ctx.ellipse(x,floor-domeHeight*.35,spread*(.15+t*.7),3+t*5,0,0,Math.PI*2);
 ctx.strokeStyle=`rgba(255,255,255,${(1-t)*.5})`;ctx.lineWidth=1;ctx.stroke();
 }
 ctx.restore();
 // The 98px nozzle is 1.86 times the reference length, with a smooth taper.
 const nozzle=ctx.createLinearGradient(x-15,0,x+15,0);
 nozzle.addColorStop(0,'#52677b');nozzle.addColorStop(.18,'#a5b7c6');nozzle.addColorStop(.38,'#edf4f8');nozzle.addColorStop(.54,'#b5c6d3');nozzle.addColorStop(.82,'#6d859b');nozzle.addColorStop(1,'#3e556c');
 ctx.fillStyle=nozzle;ctx.beginPath();ctx.moveTo(x-15,32);ctx.lineTo(x+15,32);ctx.lineTo(x+15,76);
 ctx.bezierCurveTo(x+15,96,x+5,108,x+4,tip);ctx.quadraticCurveTo(x,tip+2,x-4,tip);
 ctx.bezierCurveTo(x-5,108,x-15,96,x-15,76);ctx.closePath();ctx.fill();
 ctx.beginPath();ctx.moveTo(x-7,36);ctx.lineTo(x-7,76);ctx.bezierCurveTo(x-7,95,x-2,108,x-2,tip-5);
 ctx.strokeStyle='rgba(255,255,255,.62)';ctx.lineWidth=1.2;ctx.stroke();
 ctx.beginPath();ctx.ellipse(x,tip,3.7,1.5,0,0,Math.PI*2);ctx.fillStyle='rgba(47,117,153,.55)';ctx.fill();
 // Preserve necking and gravity-driven motion; the landing follows the dome.
 const drop=new Path2D();let cy,rx,ry;
 if(phase<dropTime){
 const t=phase/dropTime,neck=8+t*maxNeck,r=7+t*8;
 cy=tip+neck;rx=r;ry=r;
 drop.moveTo(x-3,tip);drop.bezierCurveTo(x-2,tip+neck*.5,x-r,cy-r,x-r,cy);
 drop.arc(x,cy,r,Math.PI,0,true);drop.bezierCurveTo(x+r,cy-r,x+2,tip+neck*.5,x+3,tip);drop.closePath();
 }else{
 const t=(phase-dropTime)/(1-dropTime);
 rx=12-thick*3;ry=12+thick*4;
 cy=tip+maxNeck+(floor-domeHeight-tip-maxNeck)*t*t;
 drop.ellipse(x,cy,rx,ry,0,0,Math.PI*2);
 }
 paintSerum(drop,x,cy,rx,ry);
 ctx.save();ctx.clip(drop);ctx.beginPath();ctx.ellipse(x-rx*.32,cy-ry*.3,Math.max(1,rx*.17),ry*.38,.25,0,Math.PI*2);
 ctx.fillStyle='rgba(255,255,255,.82)';ctx.fill();ctx.restore();
}
function tick(time){frame=0;if(paused||document.hidden){last=0;return;}const dt=last?Math.min((time-last)/1000,.05):0;last=time;phase=(phase+dt*(.9/(1+current.v/9000)+.08))%1;drawScene();frame=requestAnimationFrame(tick);}
function start(){if(!paused&&!document.hidden&&!frame)frame=requestAnimationFrame(tick);}
function motionLabel(){$('lab-status').textContent=paused?'Ⅱ PAUSED':'● ANALYZING';$('motion').textContent=paused?'시연 재생':'시연 일시정지';$('motion').setAttribute('aria-pressed',String(paused));}
$('motion').addEventListener('click',()=>{paused=!paused;motionLabel();if(paused){cancelAnimationFrame(frame);frame=0;last=0;}else start();});
document.addEventListener('visibilitychange',()=>{if(document.hidden){cancelAnimationFrame(frame);frame=0;last=0;}else start();});
loadPreset();motionLabel();new ResizeObserver(resize).observe(canvas);resize();start();

})();
