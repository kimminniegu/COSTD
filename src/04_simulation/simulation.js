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
  $('water').textContent = water.toFixed(2) + '\%';$('active-val').textContent = `${fmt(activePpm)} ppm`;

  $('texture').textContent = v < 2500 ? '묽은 워터리' : v < 9000 ? '산뜻한 점성' : v < 25000 ? '농축 리치' : '고밀도 밤(Balm)';
  $('flow-caption').textContent = v < 9000 ? '빠른 유동성 · 얇은 퍼짐성' : v < 25000 ? '완만한 레벨링 · 보습 밀착' : '형태 유지 · 높은 응집력';


  $('status-card').className = 'alert simulation-status-card alert-' + ({ optimal: 'info', caution: 'warning', incompatible: 'danger' }[state]);
  $('status-label').textContent = STATES[state].label;
  $('status-card').dataset.state = state;
  $('status-icon').textContent = { optimal: '✓', caution: '!', incompatible: '×' }[state];
  $('status-score').textContent = `호환도 ${score}점`;

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

// Canvas: 사용자 제공 「시뮬레이션 아스트라 초안_20260922.html」의 원본 렌더링/시연 로직.
const canvas=$('canvas'),ctx=canvas.getContext('2d');let width=0,height=0,phase=0,last=0,frame=0;
// 원본의 560×420 기준 좌표를 균일 확대/축소합니다. drawScene/tick은 초안 그대로입니다.
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
function drawScene(){
 if(!current||!width||!height)return;
 ctx.clearRect(0,0,width,height);const x=width/2,tip=height*.28,floor=height*.8;
 const thick=Math.min(1,current.v/50000),dropTime=.58+thick*.16,maxNeck=(floor-tip)*(.18+thick*.3);
 ctx.strokeStyle='rgba(62,100,136,.13)';ctx.lineWidth=1;
 for(let y=90;y<height-40;y+=32){ctx.beginPath();ctx.moveTo(20,y);ctx.lineTo(width-20,y);ctx.stroke();}
 for(let xx=32;xx<width;xx+=48){ctx.beginPath();ctx.moveTo(xx,75);ctx.lineTo(xx,height-40);ctx.stroke();}
 // 시료 노즐
 const nozzle=ctx.createLinearGradient(x-18,0,x+18,0);nozzle.addColorStop(0,'#27394e');nozzle.addColorStop(.5,'#96adc4');nozzle.addColorStop(1,'#283b50');ctx.fillStyle=nozzle;
 ctx.beginPath();ctx.moveTo(x-18,65);ctx.lineTo(x+18,65);ctx.lineTo(x+18,tip-20);ctx.lineTo(x+5,tip);ctx.lineTo(x-5,tip);ctx.lineTo(x-18,tip-20);ctx.closePath();ctx.fill();
 ctx.fillStyle='rgba(56,189,248,.6)';ctx.fillRect(x-7,75,14,Math.max(2,tip-95));
 // 같은 점도에서도 용기 선택으로 시료 색상이 바뀌지 않도록 시안 유지
 ctx.fillStyle='#38bdf8';ctx.shadowColor='#38bdf8';ctx.shadowBlur=12;ctx.beginPath();
 if(phase<dropTime){const t=phase/dropTime,neck=8+t*maxNeck,r=7+t*8;ctx.moveTo(x-4,tip);ctx.bezierCurveTo(x-2,tip+neck*.5,x-r,tip+neck-r,x-r,tip+neck);ctx.arc(x,tip+neck,r,Math.PI,0,true);ctx.bezierCurveTo(x+r,tip+neck-r,x+2,tip+neck*.5,x+4,tip);ctx.closePath();}
 else{const t=(phase-dropTime)/(1-dropTime),y=tip+maxNeck+(floor-tip-maxNeck-12)*t*t;ctx.ellipse(x,y,12-thick*3,12+thick*4,0,0,Math.PI*2);}ctx.fill();ctx.shadowBlur=0;
 // 시료 받침과 퍼짐: 고점도일수록 좁고 두껍게 표시
 ctx.strokeStyle='rgba(56,189,248,.3)';ctx.beginPath();ctx.ellipse(x,floor+8,width*.31,20,0,0,Math.PI*2);ctx.stroke();
 const spread=Math.min(width*.22,100)*(1-thick*.7);const liquid=ctx.createLinearGradient(0,floor-18,0,floor+15);liquid.addColorStop(0,'rgba(56,189,248,.65)');liquid.addColorStop(1,'rgba(56,189,248,.08)');ctx.fillStyle=liquid;ctx.beginPath();ctx.ellipse(x,floor,spread,5+thick*15,0,0,Math.PI*2);ctx.fill();
 if(phase>.86){const t=(phase-.86)/.14;ctx.strokeStyle=`rgba(56,189,248,${(1-t)*.6})`;ctx.beginPath();ctx.ellipse(x,floor+3,20+t*spread,4+t*8,0,0,Math.PI*2);ctx.stroke();}
 ctx.font='11px system-ui';ctx.textAlign='center';ctx.fillStyle='#8ba6bf';ctx.fillText('SAMPLE FLOW',x,floor+43);
}
function tick(time){frame=0;if(paused||document.hidden){last=0;return;}const dt=last?Math.min((time-last)/1000,.05):0;last=time;phase=(phase+dt*(.9/(1+current.v/9000)+.08))%1;drawScene();frame=requestAnimationFrame(tick);}
function start(){if(!paused&&!document.hidden&&!frame)frame=requestAnimationFrame(tick);}
function motionLabel(){$('motion').textContent=paused?'시연 재생':'시연 일시정지';$('motion').setAttribute('aria-pressed',String(paused));}
$('motion').addEventListener('click',()=>{paused=!paused;motionLabel();if(paused){cancelAnimationFrame(frame);frame=0;last=0;}else start();});
document.addEventListener('visibilitychange',()=>{if(document.hidden){cancelAnimationFrame(frame);frame=0;last=0;}else start();});
loadPreset();motionLabel();new ResizeObserver(resize).observe(canvas);resize();start();

})();
