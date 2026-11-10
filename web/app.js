"use strict";
const $ = id => document.getElementById(id);
const labels = {PASS:"Өткізу",SCAN:"Қосымша сканерлеу",DEEP:"Толық тексеру"};
const policyNames = {utility:"Байес + пайдалық",rule:"Ережелік агент",q:"Q-learning",all:"Барлығын тексеру"};
let state, playing=false, timer=null, busy=false, vehicleNodes=new Map(), lastCurve="";
let motionUntil=0;
const fmt=(x,d=1)=>x==null?"—":Number(x).toLocaleString("kk-KZ",{minimumFractionDigits:d,maximumFractionDigits:d});
function message(text){$("error").textContent=text;$("error").hidden=!text;}
async function api(path,data){
  const response=await fetch(path,data===undefined?{}:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});
  const body=await response.json();
  if(!response.ok)throw Error(body.error||"Сұрау орындалмады.");
  return body;
}
function pause(){playing=false;clearTimeout(timer);$("play").textContent="▶ Іске қосу";}
async function mutate(path,data={}){
  if(busy)return;
  if(path==="/api/step" && [...vehicleNodes.values()].some(n=>n._reservation||(n._detentionStage==="blocked")))return;
  busy=true;
  try{message("");state=await api(path,data);render();}
  catch(e){pause();message(e.message||"Сервермен байланыс үзілді.");}
  finally{busy=false;}
}
async function tick(){
  if(!playing)return;
  if([...vehicleNodes.values()].some(n=>n._reservation||(n._detentionStage==="blocked"))){timer=setTimeout(tick,100);return;}
  await mutate("/api/step");
  if(playing&&!state.done)timer=setTimeout(tick,Math.max(Number($("speed").value),motionUntil-performance.now()+180));
  else pause();
}
$("play").onclick=()=>{if(playing)return pause();playing=true;$("play").textContent="Ⅱ Кідірту";tick();};
$("step").onclick=()=>{pause();mutate("/api/step");};
$("finish").onclick=()=>{pause();mutate("/api/finish");};
$("reset").onclick=()=>{
  pause();
  const inputs=["prior","gap","trucks","seed"].map($);
  if(!inputs.every(i=>i.reportValidity()))return;
  vehicleNodes.forEach(n=>{cancelAnimationFrame(n._frame);n.remove();});vehicleNodes.clear();motionUntil=0;resetExitControl();
  mutate("/api/reset",{policy:$("policy").value,prior:Number($("prior").value)/100,arrival_gap:Number($("gap").value),trucks:Number($("trucks").value),seed:Number($("seed").value)});
};
document.querySelectorAll("[data-action]").forEach(button=>button.onclick=()=>{pause();mutate("/api/step",{action:button.dataset.action});});
document.querySelectorAll(".tab").forEach(button=>button.onclick=()=>{
  document.querySelectorAll(".tab,.page").forEach(n=>n.classList.remove("active"));
  button.classList.add("active");$(button.dataset.tab).classList.add("active");
  if(button.dataset.tab==="strategy")loadGame();
  if(button.dataset.tab==="terminal")requestAnimationFrame(drawVehicles);
});
$("train").onclick=()=>{pause();mutate("/api/train");};
$("export").onclick=async()=>{
  try{const data=await api("/api/export");const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"});const url=URL.createObjectURL(blob);const link=document.createElement("a");link.href=url;link.download=`Smart_Customs_AI_esep_${data.simulation.seed}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){message(e.message);}
};
function setSignal(id,value,yes,no){$(id).textContent=value===null?"Әлі жүргізілген жоқ":value?yes:no;$(id).classList.toggle("alarm",value===true);}
function render(){
  const s=state,m=s.metrics,o=s.current;
  $("completed").innerHTML=`${m.completed} <small>/ ${s.config.trucks}</small>`;
  $("completion-bar").style.width=`${100*m.completed/s.config.trucks}%`;
  $("detected").textContent=m.detected;$("wait").innerHTML=`${fmt(m.avg_wait)} <small>мин</small>`;
  $("missed").textContent=m.missed??"—";$("sim-time").textContent=fmt(s.time);
  $("play").disabled=$("step").disabled=$("finish").disabled=s.done;
  $("observation").hidden=s.done;$("episode-end").hidden=!s.done;
  if(s.done){pause();$("truck-title").textContent="Қорытынды";$("cargo").textContent="АЯҚТАЛДЫ";$("end-summary").textContent=`${m.completed} көлік өңделді. Анықтау үлесі: ${m.recall===null?"бұзушылық жоқ":fmt(m.recall*100)+"%"}. Орташа толық уақыт: ${fmt(m.avg_time)} минут. Сыйақы: ${fmt(m.reward)}.`;}
  if(o){
    const truck=s.trucks.find(t=>t.id===o.truck_id);
    $("truck-title").textContent=`Көлік №${String(o.truck_id).padStart(3,"0")}`;$("cargo").textContent=truck.cargo;
    setSignal("primary-signal",o.primary,"Дабыл","Қалыпты");setSignal("document-signal",o.document,"Сәйкессіздік","Сәйкес");setSignal("scan-signal",o.scan,"Дабыл","Қалыпты");
    $("risk").textContent=fmt(o.posterior*100,2)+"%";$("risk-bar").style.width=(o.posterior*100)+"%";
    $("risk-detail").textContent=`Бастапқы ${fmt(s.config.prior*100)}% → датчик + құжат${o.scan!==null?" + қосымша сканер":""}. Жүктің нақты құрамы агентке белгісіз.`;
    $("recommendation").textContent=labels[s.recommendation];
    const reasons={utility:"Күтілетін сыйақы, тексеру құны және бекет кезегі салыстырылды.",q:"Әрекет оқытылған Q-кестедегі ең жоғары мәнмен таңдалды.",fallback:"Бұл күйге дайын Q-мән жоқ. Байес + пайдалық тәсілі қолданылды.",rule:"Қарапайым ереже: алғашқы дабыл болса — толық тексеру.",all:"Әр көлік толық тексеруге жіберіледі."};
    $("reason").textContent=reasons[s.source];
    const values=s.source==="q"?s.q_values:s.values;
    $("values").replaceChildren();
    for(const action of Object.keys(s.values)){
      const row=document.createElement("div");row.className="value-row"+(action===s.recommendation?" selected":"");
      const name=document.createElement("span"),value=document.createElement("span");name.textContent=labels[action];value.textContent=fmt(values?.[action],2);row.append(name,value);$("values").append(row);
    }
    document.querySelector('[data-action="SCAN"]').disabled=o.scan!==null;
  }
  $("model-notice").textContent=s.model.available?`Q-модель дайын: ${s.model.episodes} эпизод, ${s.model.states} күй. Параметр өзгерсе, қайта оқыту қажет.`:"Осы параметрлерге сәйкес Q-модель жоқ. Q режимінде оқытуға дейін Байес + пайдалық тәсілі қолданылады.";
  $("logs").replaceChildren();
  for(const log of [...s.logs].reverse()){
    const row=document.createElement("div");row.className="log-row";
    const time=document.createElement("time"),text=document.createElement("span"),id=document.createElement("b");time.textContent=fmt(log.time);id.textContent=`#${String(log.truck_id).padStart(3,"0")} `;text.append(id,document.createTextNode(log.message));row.append(time,text);$("logs").append(row);
  }
  drawVehicles();renderLearning();renderScannerSummary();renderExitReport();
}
const yard = { left:-1560, top:-150, width:3160, height:1750, primarySlots:8, reserveSlots:12 };
const laneCapacity = yard.primarySlots + yard.reserveSlots;
function queueBay(index, stationY){
  if(index < yard.primarySlots) return {x:1250-index*110, y:stationY};
  return {x:-1380+(index-yard.primarySlots)*110, y:stationY===340?120:570};
}
const detentionRows=[810,1190,1350,1510];
const detentionCapacity=detentionRows.length*8;
function detentionBay(index){
  return {x:480+index%8*120,y:detentionRows[Math.floor(index/8)]};
}
function drawVehicles(){
  if(!state)return;
  if(!$("terminal-scene")){buildTerminalMap();enhanceTerminalDetails();finishYardMaterials();installFleetArtwork();addExitControl();expandTerminalGrounds();buildDetentionYard();installObjectTargets();startLiveYard();}
  // Restoring an already processed episode is a snapshot, not a replay from the entrance.
  const confirmed=state.trucks.filter(t=>t.status==="detected").sort((a,b)=>a.finish-b.finish||a.id-b.id);
  const detained=confirmed.slice(0,detentionCapacity);
  const overflowIds=new Set(confirmed.slice(detentionCapacity).map(t=>t.id));
  if(state.done||detained.some(t=>!vehicleNodes.has(t.id))){resetExitControl();for(const n of vehicleNodes.values()){cancelAnimationFrame(n._frame);n.remove();}vehicleNodes.clear();}
  const trucks=state.trucks,active=trucks.filter(t=>["decision","scanning","inspecting","leaving"].includes(t.status));
  const scans=active.filter(t=>t.status==="scanning").sort((a,b)=>a.start-b.start);
  const deeps=active.filter(t=>t.status==="inspecting").sort((a,b)=>a.start-b.start);
  const departing=active.filter(t=>t.status==="leaving").slice(-1);
  const recent=trucks.filter(t=>t.status==="released").slice(-2);

  const shown=[...active.filter(t=>t.status==="decision"),...scans.slice(0,laneCapacity),...deeps.slice(0,laneCapacity),...departing,...recent,...detained],ids=new Set(shown.map(t=>t.id));
  vehicleNodes.forEach((node,id)=>{if(!ids.has(id)&&!node._retiring){
    node._retiring=true;
    if(overflowIds.has(id)||node.classList.contains("detected")){if(node._gatePending)resetExitControl();cancelAnimationFrame(node._frame);node.remove();vehicleNodes.delete(id);return;}
    
    moveTruck(node,{x:1700,y:340},()=>{node.remove();vehicleNodes.delete(id);});
  }});
  const lanes={scanning:0,inspecting:0,released:0,detected:0};
  for(const t of shown){
    let node=vehicleNodes.get(t.id),fresh=!node;
    if(fresh){node=document.createElement("div");node.innerHTML=truckGraphic(t.id);node.setAttribute("role","button");node.tabIndex=0;node.onclick=()=>showFleetModel(t.id);node.onkeydown=e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();showFleetModel(t.id);}};node._position={x:-1620,y:340};node.style.visibility="hidden";$("vehicles").append(node);vehicleNodes.set(t.id,node);}
    node._retiring=false;
    node.className=`vehicle ${t.status}${t.status==="decision"?" current":""}${t.scan===true&&t.status!=="detected"?" scan-alarm":""}`;
    const status=t.status==="decision"?"Шешім күтілуде":t.status==="scanning"||t.status==="inspecting"?(t.start>state.time?"Кезекте":t.status==="scanning"?"Сканерлеу":"Тексеру"):t.status==="detected"?"Анықталды":"Өткізілді";
    node.title=`Көлік №${t.id} · ${t.cargo} · ${status}`;node.setAttribute("aria-label",node.title);
    if(!node._detentionStage)node.querySelector(".truck-tag").textContent=`${String(t.id).padStart(3,"0")} · ${status}`;
    let x=250,y=340;
    if(t.status==="decision"&&t.actions.includes("SCAN"))x=1250;
    if(t.status==="scanning"){({x,y}=queueBay(lanes.scanning++,340));}
    if(t.status==="inspecting"){({x,y}=queueBay(lanes.inspecting++,590));}
    if(t.status==="leaving"||t.status==="released"){x=1700;y=340;}
    if(t.status==="detected"){({x,y}=detentionBay(lanes.detected++));
      if(fresh){node._position={x,y};node._detentionStage='parked';node._visible=true;node.style.visibility='';}
      scheduleDetention(node,{x,y},t.id);continue;}
    if(fresh&&t.status!=="decision"){node._position={x,y};node._visible=true;node.style.visibility='';}
    moveTruck(node,{x,y});
  }
  $("scan-load").textContent=scans.length?`${scans.length} көлік · кезекте ${scans.filter(t=>t.start>state.time).length}`:"Бекет бос";
  $("deep-load").textContent=deeps.length?`${deeps.length} көлік · кезекте ${deeps.filter(t=>t.start>state.time).length}`:"Бекет бос";
  $("terminal-scene").classList.toggle("scanner-active",scans.some(t=>t.start<=state.time));
  $("terminal-scene").classList.toggle("inspection-active",deeps.some(t=>t.start<=state.time));
  const reserveUse = [scans,deeps].map(queue=>Math.min(yard.reserveSlots,Math.max(0,queue.length-yard.primarySlots)));
  $('reserve-count').textContent=`Резервте бос: ${2*yard.reserveSlots-reserveUse[0]-reserveUse[1]} / ${2*yard.reserveSlots}`;
  for(const [lane,y] of [120,570].entries()){
    for(let i=0;i<yard.reserveSlots;i++) $(`bay-${y}-${i}`).classList.toggle('occupied',i<reserveUse[lane]);
  }
  const heldLabel=`Ұсталған көліктер: ${detained.length} / ${detentionCapacity}`;
  $('held-view').textContent=heldLabel;
  $('held-yard-count').textContent=confirmed.length>detentionCapacity ? heldLabel+` · Картадан тыс: ${confirmed.length-detentionCapacity}` : heldLabel;
  const hidden=Math.max(0,scans.length-laneCapacity)+Math.max(0,deeps.length-laneCapacity)+Math.max(0,active.filter(t=>t.status==="leaving").length-1);
  $("overflow").textContent=hidden?`Қосымша кезек: ${hidden} көлік · бекеттердегі санға енгізілген`:"Әр белгі — нақты симуляциядағы көлік";
}
// Each leg follows a paved lane. Rounded corners supply continuous steering.
function roadRoute(from,to){
  const points=[from];
  const inReserve=p=>p.x<0 && (p.y===120 || p.y===570);
  if(inReserve(from) && from.y!==to.y){
    points.push({x:-1480,y:from.y},{x:-1480,y:340});
    from=points.at(-1);
  }
  if(inReserve(to) && from.y!==to.y){
    if(from.y!==340) points.push({x:370,y:from.y},{x:370,y:340});
    points.push({x:-55,y:340},{x:-55,y:to.y},to);
    return points.filter((p,i,a)=>!i||p.x!==a[i-1].x||p.y!==a[i-1].y);
  }
  if(Math.abs(from.y-to.y)>3){
    const junction=(to.x===1480&&to.y===340)?1460:(from.y>700||to.y>700||from.x>430)?1480:370;
    points.push({x:junction,y:from.y},{x:junction,y:to.y});
  }
  points.push(to);
  return points.filter((p,i,a)=>!i||Math.hypot(p.x-a[i-1].x,p.y-a[i-1].y)>.1);
}
function roundedRoad(points){
  let d=`M${points[0].x},${points[0].y}`;
  for(let i=1;i<points.length-1;i++){
    const a=points[i-1],b=points[i],c=points[i+1];
    const ab=Math.hypot(b.x-a.x,b.y-a.y),bc=Math.hypot(c.x-b.x,c.y-b.y),r=Math.min(32,ab/2,bc/2);
    const p={x:b.x-(b.x-a.x)*r/ab,y:b.y-(b.y-a.y)*r/ab};
    const q={x:b.x+(c.x-b.x)*r/bc,y:b.y+(c.y-b.y)*r/bc};
    d+=` L${p.x},${p.y} Q${b.x},${b.y} ${q.x},${q.y}`;
  }
  const end=points.at(-1);return d+` L${end.x},${end.y}`;
}
// Vehicle footprint in map units, including mirrors and a safety clearance.
function trafficOverlap(a,b){
  for(const angle of [a.angle,a.angle+Math.PI/2,b.angle,b.angle+Math.PI/2]){
    const x=Math.cos(angle),y=Math.sin(angle);
    const radius=q=>50*Math.abs(Math.cos(q.angle)*x+Math.sin(q.angle)*y)+25*Math.abs(-Math.sin(q.angle)*x+Math.cos(q.angle)*y);
    if(Math.abs((a.x-b.x)*x+(a.y-b.y)*y)>=radius(a)+radius(b))return false;
  }
  return true;
}
function trafficPose(path,d,length){
  const p=path.getPointAtLength(d),a=path.getPointAtLength(Math.max(0,d-.5)),b=path.getPointAtLength(Math.min(length,d+.5));
  return {x:p.x,y:p.y,angle:Math.atan2(b.y-a.y,b.x-a.x)};
}
function trafficPathFree(node,samples){
  for(const other of vehicleNodes.values()){
    if(other===node||!other.isConnected||other._position?.x>1650)continue;
    const occupied=other._reservation || (other._visible?[{...other._position,angle:other._angle||0}]:[]);
    for(const a of samples)for(const b of occupied){
      if(Math.abs(a.x-b.x)<150&&Math.abs(a.y-b.y)<150&&trafficOverlap(a,b))return false;
    }
  }
  return true;
}
function moveTruck(node,target,onComplete){
  if(node._target&&node._target.x===target.x&&node._target.y===target.y){
    if(!node._moving&&onComplete)onComplete();
    return;
  }
  if(node._moving){
    if(node._reservation){node._queued={target,onComplete};return;}
    cancelAnimationFrame(node._frame);node._moving=false;node._queued=null;
  }
  node._target=target;node._queued=null;
  const from=node._position||{x:-1620,y:340};
  const path=document.createElementNS("http://www.w3.org/2000/svg","path");
  path.setAttribute("d",roundedRoad(roadRoute(from,target)));
  const length=path.getTotalLength(),samples=[];
  for(let d=0;d<length;d+=10)samples.push(trafficPose(path,d,length));
  samples.push(trafficPose(path,length,length));
  const speed={1500:155,800:225,250:360}[$("speed").value]||225;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
  const duration=reduced?0:Math.max(450,length/speed*1000);
  let start=null,lastCheck=-Infinity;
  node._moving=true;
  if(!node._visible)node.style.visibility='hidden';
  function frame(now){
    if(!node.isConnected){node._reservation=null;node._moving=false;return;}
    if(start===null){
      if(now-lastCheck<80){node._frame=requestAnimationFrame(frame);return;}
      lastCheck=now;
      if(!trafficPathFree(node,samples)){
        node.classList.add('traffic-wait');node.dataset.traffic='Жол босауын күтуде';
        node._frame=requestAnimationFrame(frame);return;
      }
      // Reserve the whole conflicting road section before entering it.
      node._reservation=samples;node._visible=true;node.style.visibility='';
      node.classList.remove('traffic-wait');delete node.dataset.traffic;
      start=now;motionUntil=Math.max(motionUntil,now+duration);
    }
    const t=duration?Math.min(1,(now-start)/duration):1;
    const easing=t<.15?t*t/.255:t>.85?1-(1-t)*(1-t)/.255:(t-.075)/.85;
    const distance=Math.min(length,Math.max(0,easing*length));
    const p=trafficPose(path,distance,length);
    node.style.left=((p.x-yard.left)*100/yard.width)+'%';node.style.top=((p.y-yard.top)*100/yard.height)+'%';
    node.querySelector('svg').style.transform=`rotate(${p.angle*180/Math.PI}deg)`;
    node._position={x:p.x,y:p.y};node._angle=p.angle;
    node.classList.toggle('braking',t>.85);
    if(t<1)node._frame=requestAnimationFrame(frame);
    else{
      node._reservation=null;node._moving=false;node.classList.remove('braking');
      const next=node._queued;node._queued=null;
      if(onComplete)onComplete();
      if(next&&node.isConnected)moveTruck(node,next.target,next.onComplete);
    }
  }
  node._frame=requestAnimationFrame(frame);
}
const terminalMaterials = JSON.parse(document.getElementById('terminal-materials').textContent);

function truckGraphic(id) {
  const model = 'truck' + id % 3;
  return `<svg viewBox="0 0 118 54" aria-hidden="true">
    <use href="#fleet-${model}" x="2" y="2" width="114" height="50"/>
    <g class="rear-lamps"><rect x="3" y="23" width="2" height="3" rx=".7"/><rect x="3" y="37" width="2" height="3" rx=".7"/></g>
  </svg><span class="truck-tag"></span>`;
}

function installFleetArtwork() {
  const svg = document.querySelector('.site-map');
  const defs = svg.querySelector('defs');
  for (let index = 0; index < 3; index++) {
    defs.insertAdjacentHTML('beforeend', `<symbol id="fleet-truck${index}" viewBox="0 0 114 50"><image href="${terminalMaterials['truck'+index]}" width="114" height="50"/></symbol>`);
  }
  const asphalt = svg.querySelector('#real-asphalt');
  asphalt.setAttribute('width', 360);
  asphalt.setAttribute('height', 360);
  asphalt.innerHTML = `<image href="${terminalMaterials.asphalt}" width="360" height="360"/>`;
  const road = svg.querySelector('[fill="url(#real-asphalt)"]');
  road.setAttribute('d', 'M0 290H1600V395H1540V870H400V755H1420V650H310V395H0Z M430 395V535H1420V395Z');
  road.setAttribute('fill-rule','evenodd');
  road.setAttribute('stroke','#a9a9a0');
  road.setAttribute('stroke-width','3');
  const roofs = [[100,75,250,100],[430,65,320,125],[830,70,270,120],[60,450,190,130]];
  for(const [i,[x,y,w,h]] of roofs.entries()){
    svg.insertAdjacentHTML('beforeend', `<image href="${terminalMaterials['roof'+i]}" x="${x-2}" y="${y-2}" width="${w+9}" height="${h+12}" preserveAspectRatio="none" class="terminal-roof"/>`);
  }
  // Recessed drain channels sit alongside the asphalt, outside the wheel tracks.
  for(const [x,y,w] of [[480,386,585],[545,638,540],[655,852,600]]){
    svg.insertAdjacentHTML('beforeend', `<g><path d="M${x} ${y}h${w}" stroke="#9a9990" stroke-width="5"/><path d="M${x} ${y}h${w}" stroke="#363d40" stroke-width="3" stroke-dasharray="2 1.2"/></g>`);
  }
  const beam = svg.querySelector('.scanner-light');
  defs.insertAdjacentHTML('beforeend','<linearGradient id="scan-curtain"><stop stop-color="#77ffe0" stop-opacity="0"/><stop offset=".82" stop-color="#77ffe0" stop-opacity=".31"/><stop offset=".94" stop-color="#d6fff3" stop-opacity=".9"/><stop offset="1" stop-color="#80ffe9" stop-opacity="0"/></linearGradient>');
  beam.setAttribute('width','25');
  beam.setAttribute('x','1238');
  beam.setAttribute('fill','url(#scan-curtain)');
}

function enhanceTerminalDetails(){
 const svg=document.querySelector('.site-map');
 const ns='http://www.w3.org/2000/svg',group=document.createElementNS(ns,'g');group.setAttribute('class','infrastructure-details');
 let d=`<defs><linearGradient id="roof-depth" x2="0%" y2="100%"><stop stop-color="#fff" stop-opacity=".3"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#193b48" stop-opacity=".32"/></linearGradient><pattern id="roof-solar" width="13" height="10" patternUnits="userSpaceOnUse"><rect width="13" height="10" fill="#29475c"/><path d="M0 0H13V10" fill="none" stroke="#97b0b8" stroke-width=".7"/></pattern></defs>`;
 for(const [x,y,w,h] of [[100,75,250,100],[430,65,320,125],[830,70,270,120],[60,450,190,130]]){
  d+=`<rect x="${x+7}" y="${y+7}" width="${w-14}" height="${h-27}" fill="url(#roof-depth)"/><path d="M${x} ${y+h}h${w}v10H${x}z" fill="#829793"/><path d="M${x+8} ${y+8}h${w-16}" stroke="#edf1e8" stroke-width="3"/>`;
  for(let i=0;i<Math.floor(w/34);i++)d+=`<path d="M${x+16+i*34} ${y+h-14}v9" stroke="#c8e2e3"/><path d="M${x+14+i*34} ${y+h+2}v8" stroke="#5d7674"/>`;
  d+=`<rect x="${x+w*.38}" y="${y+16}" width="${w*.24}" height="${h*.28}" fill="url(#roof-solar)" stroke="#506f80"/><path d="M${x+10} ${y+h+8}v12h12" stroke="#667c77" stroke-width="3" fill="none"/>`;
 }
 // Off-road service strip: outdoor furniture, bike racks, refuse bins and utility boxes.
 for(const [x,y] of [[450,232],[600,235],[1010,260],[70,205]]){
  d+=`<g transform="translate(${x} ${y})"><rect x="2" y="5" width="35" height="12" rx="2" fill="#22372c33"/><rect width="33" height="9" rx="2" fill="#9a7850"/><path d="M2 3h29M2 6h29" stroke="#d8bc83"/><path d="M5 9v5M28 9v5" stroke="#405b59" stroke-width="3"/><rect x="42" y="-3" width="10" height="14" rx="2" fill="#54766d"/><rect x="42" y="-3" width="10" height="3" fill="#334e4e"/></g>`;
 }
 for(let i=0;i<8;i++)d+=`<path d="M${780+i*7} 258v-16q3-7 6 0v16" stroke="#8da4a3" stroke-width="2" fill="none"/>`;
 for(const [x,y] of [[340,235],[1390,223],[262,650]])d+=`<path d="M${x} ${y}v-20" stroke="#718b8b" stroke-width="3"/><rect x="${x-9}" y="${y-28}" width="18" height="13" rx="2" fill="#2f7180" stroke="#eff2da"/><path d="M${x-5} ${y-22}h10m-4-3l4 3-4 3" stroke="#fff" fill="none"/>`;
 // Stacked pallets and forklift are parked entirely outside the main travel lanes.
 for(let i=0;i<9;i++){let x=470+i*65,y=687;d+=`<rect x="${x+4}" y="${y+5}" width="44" height="24" fill="#31473933"/><rect x="${x}" y="${y}" width="44" height="24" fill="#ab8556" stroke="#795c3d"/><path d="M${x+3} ${y+5}h38m-38 7h38m-38 7h38" stroke="#d9b581"/><rect x="${x+5}" y="${y-9}" width="31" height="26" fill="${i%2?'#c2aa7c':'#b58e5d'}" stroke="#8f744f"/><path d="M${x+20} ${y-8}v25" stroke="#ead5a7" stroke-width="3"/>`;}
 d+=`<g transform="translate(1050 690)"><rect x="-5" y="0" width="9" height="13" rx="2" fill="#283942"/><rect x="-5" y="27" width="9" height="13" rx="2" fill="#283942"/><rect x="32" y="0" width="9" height="13" rx="2" fill="#283942"/><rect x="32" y="27" width="9" height="13" rx="2" fill="#283942"/><rect width="38" height="40" rx="6" fill="#d9a048" stroke="#9a702e"/><rect x="10" y="7" width="22" height="26" fill="#42565c" stroke="#ecc37a" stroke-width="3"/><rect x="12" y="13" width="10" height="14" rx="3" fill="#253d48"/><path d="M40 5v30M43 10h23M43 30h23" stroke="#7d9397" stroke-width="4"/></g>`;
 // Security cameras, drain grilles and fire equipment.
 for(const [x,y] of [[110,285],[1380,280],[1400,655],[310,730]])d+=`<path d="M${x} ${y}v-30h13" stroke="#5c747b" stroke-width="2"/><rect x="${x+9}" y="${y-33}" width="14" height="7" rx="2" fill="#e3e9e2" stroke="#819599"/><rect x="${x+21}" y="${y-32}" width="3" height="5" fill="#254551"/>`;
 for(let i=0;i<7;i++){let x=470+i*120;d+=`<rect x="${x}" y="399" width="22" height="7" fill="#374d50"/>`;for(let k=0;k<5;k++)d+=`<path d="M${x+3+k*4} 400v5" stroke="#839a98"/>`;}
 for(const [x,y] of [[1150,500],[260,560],[850,208]])d+=`<rect x="${x}" y="${y}" width="9" height="16" rx="3" fill="#c45c44"/><path d="M${x-2} ${y+5}h13M${x+2} ${y}v-3h6" stroke="#7b3d30" stroke-width="2"/>`;
 // Small walking staff remain on the pedestrian strip.
 for(let i=0;i<8;i++)d+=`<g class="yard-person" style="animation-delay:-${i*1.2}s" transform="translate(${420+i*95} 258)"><ellipse cx="3" cy="4" rx="6" ry="9" fill="#294a3d26"/><circle cy="-6" r="3.5" fill="#d5ab84"/><rect x="-4" y="-2" width="8" height="10" rx="2" fill="${i%2?'#d9a34a':'#527d91'}"/><path d="M-2 8v5M2 8v5" stroke="#314752" stroke-width="2"/><path d="M-3 1h6" stroke="#f5edbd"/></g>`;
 group.innerHTML=d;svg.append(group);
 const controls=document.createElement('div');controls.className='map-tools';controls.innerHTML='<button type="button" id="map-zoom-in" aria-label="Картаны үлкейту">＋</button><button type="button" id="map-zoom-out" aria-label="Картаны кішірейту">−</button><button type="button" id="map-zoom-reset">Толық карта</button>';
 controls.insertAdjacentHTML('afterbegin','<output id="reserve-count" aria-live="off"></output><button type="button" id="west-view">Батыс резерві</button><button type="button" id="post-view">Тексеру бекеттері</button><button type="button" id="held-view">Ұсталған көліктер</button><button type="button" id="fleet-view">Көлікті 3D көру</button><button type="button" id="interior-view">Корпустың іші</button>');
 $('map').before(controls);
 const viewport=$('map'),scene=$('terminal-scene');
 let zoom=1;
 function setView(scale,centerX,centerY){
   zoom=Math.max(1,Math.min(4,scale));
   scene.style.width=viewport.clientWidth*zoom+'px';
   viewport.scrollLeft=(centerX-yard.left)/yard.width*scene.offsetWidth-viewport.clientWidth/2;
   viewport.scrollTop=(centerY-yard.top)/yard.height*scene.offsetHeight-viewport.clientHeight/2;
 }
 function zoomAroundCenter(factor){
   const cx=yard.left+(viewport.scrollLeft+viewport.clientWidth/2)/scene.offsetWidth*yard.width;
   const cy=yard.top+(viewport.scrollTop+viewport.clientHeight/2)/scene.offsetHeight*yard.height;
   setView(zoom*factor,cx,cy);
 }
 const localScale=()=>Math.min(4,Math.max(2,2400/Math.max(1,viewport.clientWidth)));
 $('west-view').onclick=()=>setView(localScale(),-780,330);
 $('post-view').onclick=()=>setView(localScale(),810,475);
 $('held-view').onclick=()=>setView(localScale(),885,1180);
 $('fleet-view').onclick=()=>showFleetModel(state.current?.truck_id ?? state.trucks.find(t=>t.status!=='upcoming')?.id ?? 1);
 $('interior-view').onclick=()=>{setView(4,36,1325);showSiteObject('building');};
 $('map-zoom-in').onclick=()=>zoomAroundCenter(1.35);
 $('map-zoom-out').onclick=()=>zoomAroundCenter(1/1.35);
 $('map-zoom-reset').onclick=()=>setView(1,20,725);
 $('west-view').click();
}

function buildTerminalMap(){
 const rect=(x,y,w,h,fill,extra='')=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" ${extra}/>`;
 const label=(x,y,text,size=16,color='#335950')=>`<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-family="Arial">${text}</text>`;
 function building(x,y,w,h,title){return `<g filter="url(#yard-shadow)">${rect(x,y,w,h,'#edf0e7','rx="4" stroke="#8baba6"')}${rect(x+7,y+7,w-14,h-27,'url(#roof-ribs)')}${Array.from({length:Math.floor(w/38)},(_,i)=>rect(x+14+i*38,y+h-15,24,10,'#56869b')).join('')}${rect(x+20,y+18,45,30,'#baccc6','stroke="#7c9693"')}${rect(x+w-67,y+18,45,30,'#baccc6','stroke="#7c9693"')}<circle cx="${x+42}" cy="${y+33}" r="10" fill="#7f9798"/><circle cx="${x+w-44}" cy="${y+33}" r="10" fill="#7f9798"/></g>${label(x,y+h+24,title)}`;}
 function tree(x,y){
   const variant=(x+y)%3===0?0:1;
   return `<image href="${terminalMaterials['tree'+variant]}" x="${x-23}" y="${y-23}" width="46" height="46" class="yard-canopy"/>`;
 }
 let art=`<defs><pattern id="yard-paving" width="22" height="22" patternUnits="userSpaceOnUse">${rect(0,0,22,22,'#d7dfd6')}<path d="M0 0H22V22" fill="none" stroke="#bccac2" stroke-width=".8"/></pattern><pattern id="yard-asphalt" width="9" height="9" patternUnits="userSpaceOnUse">${rect(0,0,9,9,'#485760')}<circle cx="2" cy="4" r=".7" fill="#7f8b8f" opacity=".3"/></pattern><pattern id="roof-ribs" width="14" height="14" patternUnits="userSpaceOnUse">${rect(0,0,14,14,'#9eafb0')}<path d="M0 0V14M3 0V14" stroke="#c4d1cf" stroke-width="1.5"/></pattern><pattern id="yard-zebra" width="13" height="13" patternUnits="userSpaceOnUse">${rect(0,0,7,13,'#efefda')}</pattern><filter id="yard-shadow" x="-20%" y="-20%" width="150%" height="170%"><feDropShadow dx="6" dy="9" stdDeviation="3" flood-color="#1f3934" flood-opacity=".22"/></filter></defs>`;
 art+=rect(0,0,1600,950,'#bfcfb2')+rect(25,24,1550,900,'url(#yard-paving)','rx="12" stroke="#91a78e" stroke-width="3"');
 // The roads correspond exactly to the animated lane coordinates.
 art+=`<path d="M0 290H1600V395H0Z M310 340H430V650H310Z M370 535H1540V650H370Z M1420 340H1540V870H1420Z M400 755H1540V870H400Z" fill="url(#yard-asphalt)" stroke="#edf0df" stroke-width="5"/>`;
 art+=`<path d="M0 344H1600M430 594H1420M430 815H1420M374 397V530M1484 403V750" stroke="#bbc8c3" stroke-width="2" stroke-dasharray="18 14" fill="none"/>`;
 art+=building(100,75,250,100,'01 · Алғашқы бақылау')+building(430,65,320,125,'Кеден басқармасы')+building(830,70,270,120,'Логистикалық қойма');
 art+=building(60,450,190,130,'Қызметтік ғимарат');
 art+=rect(1150,65,360,150,'#e7f2e6','rx="10" stroke="#9abcb0"')+label(1170,95,'02 / ҚОСЫМША СКАНЕР',17,'#127b71')+`<text id="scan-load" x="1170" y="127" font-family="Arial" font-size="17" fill="#476e63">Бекет бос</text>`+label(1170,160,'Дабыл — күмәнді белгі.',14)+label(1170,185,'Нәтижені толық тексеру растайды.',14);
 art+=rect(1165,292,170,101,'#b8f4db55','stroke="#5da99c" stroke-width="2"')+`<path d="M1160 298V277H1340V298M1160 388V410H1340V388" fill="none" stroke="#b5cbc6" stroke-width="13"/><rect class="scanner-light" x="1248" y="300" width="4" height="86" fill="#6decc2"/>`;
 art+=rect(1105,444,260,63,'#fcf2db','rx="6" stroke="#bba47c"')+label(1120,469,'03 · Толық тексеру',18)+`<text id="deep-load" x="1120" y="493" font-family="Arial" font-size="14" fill="#335950">Бекет бос</text>`;
 art+=rect(1175,539,170,108,'#fae4a555','stroke="#d6b574" stroke-width="3"')+`<circle class="inspection-light" cx="1342" cy="464" r="6" fill="#b1b9ac"/>`;
 art+=label(445,275,'СКАНЕРГЕ КЕЗЕК →',16)+label(455,519,'ТОЛЫҚ ТЕКСЕРУГЕ КЕЗЕК →',16)+label(450,733,'РАСТАЛҒАН БҰЗУШЫЛЫҚТАР · БАҚЫЛАУ ТҰРАҒЫ',17,'#974f3c')+label(40,270,'КІРУ →',18)+label(1470,270,'ШЫҒУ →',18);
 for(let i=0;i<8;i++){let x=1250-i*110;art+=`<path d="M${x-48} 302v-7h96v7M${x-48} 630v10h96v-10" fill="none" stroke="#dec380" stroke-width="2"/>`+label(x-6,318,String(i+1).padStart(2,'0'),10,'#adbbb9');}
 for(let i=0;i<8;i++)art+=`<path d="M${424+i*120} 766v91" stroke="#b9c7c0" stroke-width="2"/>`;
 art+=rect(197,220,66,39,'#e9eee5','stroke="#88a8a1" rx="3"')+rect(204,227,40,20,'#588ca2')+`<path d="M280 288V335" stroke="#f5edce" stroke-width="7"/><path d="M280 288V335" stroke="#c1774e" stroke-width="7" stroke-dasharray="8 8"/>`;
 art+=rect(72,296,24,91,'url(#yard-zebra)')+rect(1380,296,24,91,'url(#yard-zebra)');
 // Loading docks and stacks sit outside the swept vehicle lanes.
 for(let i=0;i<5;i++){let x=445+i*119;art+=rect(x,425,100,58,['#478887','#b87452','#758eaa','#b99a59','#74917d'][i],'rx="2" stroke="#426765"');for(let k=0;k<12;k++)art+=`<path d="M${x+6+k*8} 429v49" stroke="#e3eee5" opacity=".38"/>`;}
 art+=label(445,417,'КОНТЕЙНЕР АЛАҢЫ',13);
 for(let i=0;i<6;i++){let y=655+i*32;art+=rect(75,y,160,29,'#7c8c8b','stroke="#e6eddf"');art+=rect(100,y+5,48,19,['#d9e3d8','#6b94a1','#a78b6a'][i%3],'rx="5"')+rect(115,y+7,19,15,'#375d6a','rx="2"');}
 art+=label(70,637,'ҚЫЗМЕТТІК ТҰРАҚ',14);
 for(let i=0;i<7;i++){let x=840+i*35;art+=rect(x,225,26,20,'#405f74','stroke="#b4d3dc"')+`<path d="M${x+13} 226v18M${x+1} 235h24" stroke="#7095a3"/>`;}
 for(let x of [40,385,790,1547])for(let y of [58,150,235])art+=tree(x,y);
 for(let x of [290,1550])for(let y of [460,510,690,730,890])art+=tree(x,y);
 for(let x of [70,450,780,1120,1510])art+=`<path d="M${x} 30V53M${x} 30h18M${x} 914v-25M${x} 889h18" stroke="#5c7776" stroke-width="3"/>`+rect(x+14,26,17,6,'#f2df9a');
 art+=`<path d="M35 38H1560M35 48H1560M35 904H1560M35 914H1560" stroke="#849a8d" fill="none"/>`;
 for(let x=35;x<1570;x+=35)art+=`<path d="M${x} 34V52M${x} 900V919" stroke="#637e70" stroke-width="2"/>`;
 for(let [x,y] of [[1120,570],[1370,570],[1120,625],[1370,625],[300,416],[430,677]])art+=`<path d="M${x} ${y}l-5 13h10z" fill="#e8a354" stroke="#fff0ce"/>`;
 for(let [x,y] of [[1130,516],[1360,515]])art+=`<circle cx="${x}" cy="${y}" r="4" fill="#e2b18a"/><path d="M${x} ${y+5}v12" stroke="#dd9b42" stroke-width="7"/><path d="M${x-3} ${y+16}v8M${x+3} ${y+16}v8" stroke="#355261" stroke-width="3"/>`;
 $("map").innerHTML=`<div class="terminal-scene" id="terminal-scene"><svg class="site-map" viewBox="-1560 -150 3160 1750" role="img" aria-label="Кеңейтілген кеден терминалы: екі тексеру кезегі, қоймалар, сканер және бақылау тұрағы">${art}</svg><div id="vehicles"></div><div id="overflow" class="overflow"></div><div class="map-scale">SMART CUSTOMS AI<span>Оқу симуляторы · сызбалық карта</span></div></div>`;
}

function renderLearning(){
  const s=state,job=s.job;$("trained-states").textContent=s.model.states;
  const running=["training","evaluating"].includes(job.state);$("train").disabled=running;
  $("train-progress").style.width=(job.state==="idle"?(s.model.episodes?100:0):100*job.progress/job.total)+"%";
  $("train-status").textContent=job.state==="training"?`Оқыту: ${job.progress} / ${job.total} эпизод`:job.state==="evaluating"?"Тәуелсіз ағындарда бағалау…":job.state==="failed"?job.error:s.model.episodes?`${s.model.episodes} эпизодпен оқытылған модель дайын`:"Оқыту әлі жүргізілмеді";
  const curve=s.model.curve,key=JSON.stringify(curve);
  if(key!==lastCurve){lastCurve=key;drawCurve(curve);}
  const b=s.benchmark;$("benchmark").replaceChildren();
  if(!b){$("benchmark-description").textContent="Оқытудан кейін есептеледі";return;}
  $("benchmark-description").textContent=`${b.episodes} эпизод × ${b.config.trucks} көлік · тәуекел ${fmt(b.config.prior*100)}% · аралық ${fmt(b.config.arrival_gap)} мин`;
  for(const policy of ["rule","all","utility","q"]){
    const r=b.policies[policy],tr=document.createElement("tr");if(policy==="q")tr.className="q-row";
    const values=[policyNames[policy],r.recall===null?"—":fmt(r.recall*100)+"%",r.missed,r.legal_deep,fmt(r.avg_time)+" мин",fmt(r.reward_per_truck,2)+" ± "+fmt(r.reward_ci95,2)];
    for(const v of values){const td=document.createElement("td");td.textContent=v;tr.append(td);}$("benchmark").append(tr);
  }
  $("benchmark-note").textContent=`${b.note} Бағалау кілттері: ${b.seeds.join("–")}. Q-кесте қамтуы: ${fmt(b.policies.q.q_coverage*100)}%. Қалған күйлерде пайдалық тәсілі қолданылады.`;
}
function drawCurve(data){
  if(!data.length){$("curve").textContent="Оқыту нәтижесі осында көрсетіледі.";return;}
  const ns="http://www.w3.org/2000/svg",svg=document.createElementNS(ns,"svg");svg.setAttribute("viewBox","0 0 640 190");svg.setAttribute("role","img");svg.setAttribute("aria-label","Q-learning оқыту сыйақысының графигі");
  const low=Math.min(...data.map(p=>p.reward)),high=Math.max(...data.map(p=>p.reward));
  for(let i=0;i<4;i++){const y=20+i*45,line=document.createElementNS(ns,"line"),text=document.createElementNS(ns,"text");for(const [k,v]of Object.entries({x1:50,x2:625,y1:y,y2:y,stroke:"#e4ebdf"}))line.setAttribute(k,v);text.setAttribute("x","0");text.setAttribute("y",y+4);text.setAttribute("fill","#7b8c7b");text.setAttribute("font-size","10");text.textContent=fmt(high-i*(high-low)/3,0);svg.append(line,text);}
  const poly=document.createElementNS(ns,"polyline");poly.setAttribute("points",data.map((p,i)=>`${50+i*575/Math.max(1,data.length-1)},${155-(p.reward-low)*135/Math.max(1,high-low)}`).join(" "));poly.setAttribute("fill","none");poly.setAttribute("stroke","#087e78");poly.setAttribute("stroke-width","2.5");svg.append(poly);
  for(const [x,text]of [[50,"20 эпизод"],[540,`${data.at(-1).episode} эпизод`]]){const t=document.createElementNS(ns,"text");t.setAttribute("x",x);t.setAttribute("y",182);t.setAttribute("font-size",10);t.setAttribute("fill","#7b8c7b");t.textContent=text;svg.append(t);}
  $("curve").replaceChildren(svg);
}
async function loadGame(){
  try{if(!$("game-risk").reportValidity())return;const r=await api("/api/strategy?risk="+Number($("game-risk").value)/100);
    const max=["Спектрлік талдау","Жүкті ашып тексеру","Құжат аудиті"],min=["Экрандау","Органикалық ортаға жасыру","Жалған құжат"];
    $("game-prep").textContent=max[r.pruned.path[0]];$("game-conceal").textContent=min[r.pruned.path[1]];$("game-response").textContent=max[r.pruned.path[2]];
    $("game-stats").textContent=`Ойын бағасы: ${fmt(r.pruned.score,2)}. Қаралған соңғы күйлер: ${r.pruned.leaves} / ${r.full.leaves}. Қиылған тармақтар: ${r.pruned.cutoffs}. Толық іздеу бағасы: ${fmt(r.full.score,2)}.`;
    $("matrix").replaceChildren();r.pruned.matrix.forEach((row,i)=>{const tr=document.createElement("tr");for(const v of [max[i],...row.map(x=>fmt(x,2))]){const td=document.createElement("td");td.textContent=v;tr.append(td);}$("matrix").append(tr);});
  }catch(e){message(e.message);}
}
$("game-risk").onchange=loadGame;
window.addEventListener("resize",drawVehicles);
async function poll(){try{if(!busy&&!playing){const before=state;const latest=await api("/api/state");if(before===state&&!busy&&!playing&&JSON.stringify(latest)!==JSON.stringify(state)){state=latest;render();}}}catch(e){pause();message("Жергілікті сервермен байланыс үзілді. Қосымшаны қайта іске қосыңыз.");}finally{setTimeout(poll,2500);}}
async function init(){try{state=await api("/api/state");$("policy").value=state.policy;$("prior").value=state.config.prior*100;$("gap").value=state.config.arrival_gap;$("trucks").value=state.config.trucks;$("seed").value=state.seed;render();setTimeout(poll,2500);}catch(e){message(e.message);}}
function renderScannerSummary(){
 const scanned=state.trucks.filter(t=>t.scan!==null), alarms=scanned.filter(t=>t.scan===true);
 const confirmed=alarms.filter(t=>t.status==='detected');
 $('scanner-summary').textContent=`Сканер нәтижелері: ${scanned.length} · Дабыл: ${alarms.length} · Дабылдан кейін расталған бұзушылық: ${confirmed.length}`;
 const queued=state.trucks.filter(t=>['scanning','inspecting'].includes(t.status)&&t.start>state.time);
 $('queue-summary').textContent=`Кезекте: ${queued.length} көлік · Дабыл бар: ${queued.filter(t=>t.scan===true||t.primary||t.document).length}. Дабыл бұзушылықты өздігінен растамайды.`;
 $('scan-history').replaceChildren();
 for(const t of scanned.slice(-8).reverse()){
  const row=document.createElement('div');row.className='scan-history-row';
  const end=t.status==='detected'?'Бұзушылық расталды':t.status==='released'?(t.actions.includes('DEEP')?'Тексеруде бұзушылық табылмады':'Өткізілді'):t.status==='inspecting'?'Толық тексеруге жіберілді':'Шешім күтілуде';
  row.textContent=`№${t.id} · ${t.scan?'⚠ Дабыл':'Қалыпты'} → ${end}`;$('scan-history').append(row);
 }
 if(!scanned.length)$('scan-history').textContent='Қосымша сканердің нәтижелері осында сақталады.';
}
$('dense-demo').onclick=()=>{pause();$('prior').value=25;$('gap').value=1;$('trucks').value=100;$('seed').value=42;$('policy').value='utility';$('reset').click();};


function finishYardMaterials(){
 const svg=document.querySelector('.site-map'),ns='http://www.w3.org/2000/svg';
 let seed=7391;const rand=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
 const layer=(name,html,before=null)=>{const g=document.createElementNS(ns,'g');g.setAttribute('class',name);g.innerHTML=html;before?svg.insertBefore(g,before):svg.append(g);return g;};
 let grain='';for(let i=0;i<170;i++)grain+=`<circle cx="${rand()*96}" cy="${rand()*96}" r="${.2+rand()*.65}" fill="${i%3?'#bec4ba':'#17282e'}" opacity="${.07+rand()*.12}"/>`;
 let paver='';for(let y=0;y<64;y+=16)for(let x=-16;x<64;x+=32)paver+=`<rect x="${x+(y%32?16:0)}" y="${y}" width="31" height="15" rx="1" fill="${['#d1d4c8','#c6cdc2','#d9dacf','#cbd1c6'][Math.floor(rand()*4)]}" stroke="#aab8ae" stroke-width=".5"/>`;
 const defs=document.createElementNS(ns,'defs');defs.innerHTML=`<pattern id="real-asphalt" width="96" height="96" patternUnits="userSpaceOnUse"><rect width="96" height="96" fill="#45515a"/>${grain}</pattern><pattern id="real-paving" width="64" height="64" patternUnits="userSpaceOnUse">${paver}</pattern><linearGradient id="real-roof" x2="0%" y2="100%"><stop stop-color="#c4cfcc"/><stop offset=".45" stop-color="#8d9e9e"/><stop offset=".48" stop-color="#d6dfd9"/><stop offset=".52" stop-color="#809393"/><stop offset="1" stop-color="#a6b7b3"/></linearGradient><linearGradient id="real-glass" x2="100%" y2="100%"><stop stop-color="#243f51"/><stop offset=".45" stop-color="#7198a7"/><stop offset=".49" stop-color="#b7cfd0"/><stop offset=".53" stop-color="#4b7181"/><stop offset="1" stop-color="#2b4c5f"/></linearGradient><linearGradient id="real-portal" x2="100%" y2="0%"><stop stop-color="#407d7f"/><stop offset=".15" stop-color="#8ac9bb"/><stop offset=".7" stop-color="#64a99e"/><stop offset="1" stop-color="#123e49"/></linearGradient><radialGradient id="real-crown"><stop stop-color="#a5bc77"/><stop offset=".52" stop-color="#6e8d54"/><stop offset="1" stop-color="#385d43"/></radialGradient><radialGradient id="oil-stain"><stop stop-color="#1d3034" stop-opacity=".35"/><stop offset="1" stop-color="#263c40" stop-opacity="0"/></radialGradient><filter id="soft-yard-shadow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.3"/></filter>`;svg.prepend(defs);
 svg.querySelectorAll('[fill="url(#yard-asphalt)"]').forEach(n=>n.setAttribute('fill','url(#real-asphalt)'));
 svg.querySelectorAll('[fill="url(#yard-paving)"]').forEach(n=>n.setAttribute('fill','url(#real-paving)'));
 // Tire marks and repaired pavement stay underneath all labels and infrastructure.
 const road=svg.querySelector('[fill="url(#real-asphalt)"]');let wear='';
 for(let y of [340,590,810]){
  let left=y===340?0:430;
  for(let dy of [-13,13])wear+=`<path d="M${left} ${y+dy}H1410" stroke="#182f37" stroke-width="7" opacity=".10" fill="none"/>`;
  for(let i=0;i<12;i++){let x=left+rand()*(1400-left);wear+=`<ellipse cx="${x}" cy="${y+rand()*35-17}" rx="${12+rand()*22}" ry="${4+rand()*7}" fill="url(#oil-stain)"/>`;}
 }
 wear+=`<path d="M310 345Q371 345 371 409V525Q371 590 440 590" fill="none" stroke="#233840" stroke-width="5" opacity=".2"/>`;
 for(const [x,y] of [[560,362],[925,613],[1375,833]])wear+=`<rect x="${x}" y="${y}" width="39" height="14" rx="3" fill="#3a4951" opacity=".55"/><path d="M${x+4} ${y+3}l10 4 6-3 12 7" stroke="#788882" stroke-width=".65" fill="none"/>`;
 layer('pavement-wear',wear,road.nextSibling);
 let d='';
 // Shallow facade extrusion, loading doors, gutters, roof seams and skylights.
 for(const [x,y,w,h] of [[100,75,250,100],[430,65,320,125],[830,70,270,120],[60,450,190,130]]){
  d+=`<path d="M${x+2} ${y+h+9}l12 12h${w}l-12-12z" fill="#283c3c" opacity=".18" filter="url(#soft-yard-shadow)"/><path d="M${x+w} ${y}l6 8v${h}l-6-8z" fill="#657b79"/><rect x="${x+7}" y="${y+7}" width="${w-14}" height="${h-27}" fill="url(#real-roof)"/>`;
  for(let i=12;i<w-10;i+=9)d+=`<path d="M${x+i} ${y+9}v${h-31}" stroke="#e2e8dd" stroke-width=".9" opacity=".6"/><path d="M${x+i+1.6} ${y+9}v${h-31}" stroke="#435e62" stroke-width=".65" opacity=".35"/>`;
  d+=`<path d="M${x+7} ${y+h*.46}h${w-14}" stroke="#edf0e5" stroke-width="2"/><path d="M${x+3} ${y+h-18}h${w-6}" stroke="#667e80" stroke-width="2"/>`;
  for(let i=0;i<Math.floor(w/38);i++){let wx=x+14+i*38;d+=`<rect x="${wx}" y="${y+h-15}" width="24" height="10" fill="url(#real-glass)" stroke="#dbe2d8" stroke-width=".8"/><path d="M${wx+12} ${y+h-15}v10" stroke="#bdcec8"/>`;}
  for(let xx of [x+20,x+w-67]){
   d+=`<rect x="${xx+4}" y="${y+23}" width="45" height="30" fill="#25434b" opacity=".28"/><rect x="${xx}" y="${y+18}" width="45" height="30" rx="2" fill="#c8d1c8" stroke="#71888a"/><circle cx="${xx+22}" cy="${y+33}" r="11" fill="#354f59" stroke="#9eb3ae" stroke-width="2"/>`;
   for(let k=0;k<8;k++){let a=k*Math.PI/4;d+=`<path d="M${xx+22} ${y+33}l${Math.cos(a)*8} ${Math.sin(a)*8}" stroke="#9fb5b1" stroke-width="2"/>`;}
   d+=`<circle cx="${xx+22}" cy="${y+33}" r="3" fill="#cdd9ce"/>`;
  }
  d+=`<rect x="${x+w*.38}" y="${y+16}" width="${w*.24}" height="${h*.28}" fill="url(#roof-solar)" stroke="#d0ded7" stroke-width="1.5"/>`;
  for(let xx of [x+6,x+w-5])d+=`<path d="M${xx} ${y+12}v${h-6}l4 4" fill="none" stroke="#536e72" stroke-width="2"/>`;
 }
 // Scanner portal and inspection platform gain steel framing and instrument cabinets.
 d+=`<path d="M1155 281l10-9h173l8 9v20h-13v-14h-165v14h-13z" fill="url(#real-portal)" stroke="#184c53"/><path d="M1155 391h13v14h165v-14h13v23h-191z" fill="url(#real-portal)" stroke="#184c53"/><path d="M1165 274h171" stroke="#9dc6bb" stroke-width="2"/>`;
 for(let x of [1160,1336]){
  d+=`<rect x="${x-5}" y="304" width="10" height="80" rx="2" fill="#2f535e"/><path d="M${x} 309v70" stroke="#b1d5c7" stroke-width="1.5"/>`;
  for(let y=310;y<380;y+=10)d+=`<circle cx="${x}" cy="${y}" r="1.5" fill="#e2ece2"/>`;
 }
 for(let x of [1140,1360])d+=`<rect x="${x}" y="368" width="13" height="21" rx="2" fill="#cdd5cc" stroke="#7b9695"/><path d="M${x+3} 374h7m-7 4h7m-7 4h7" stroke="#6b8587"/><circle cx="${x+9}" cy="371" r="1" fill="#5bb998"/>`;
 d+=`<path d="M1175 542h170M1175 646h170" stroke="#253f49" stroke-width="7"/>`;
 for(let x=1178;x<1343;x+=14)d+=`<path d="M${x} 539l6 6M${x} 643l6 6" stroke="#e7bd64" stroke-width="4"/>`;
 // Container locks and corner castings, with shadows along their rear faces.
 for(let i=0;i<5;i++){let x=445+i*119;d+=`<path d="M${x} 483l5 6h100v-58l-5-6v58z" fill="#2e484b" opacity=".36"/>`;for(let xx of [x+3,x+96])for(let yy of [428,478])d+=`<rect x="${xx}" y="${yy}" width="4" height="4" fill="#bac9be"/>`;for(let xx of [x+91,x+95])d+=`<path d="M${xx} 434v40" stroke="#bccbc2" stroke-width="1"/>`;}
 // Foliage uses layered irregular crowns, rather than flat circles.
 for(const c of [...svg.querySelectorAll('circle[fill="#678a55"]')]){
  const x=+c.getAttribute('cx'),y=+c.getAttribute('cy');
  d+=`<ellipse cx="${x+10}" cy="${y+12}" rx="19" ry="13" fill="#254535" opacity=".22" filter="url(#soft-yard-shadow)"/>`;
  for(let k=0;k<13;k++){const a=k*2.4,r=5+rand()*9;d+=`<circle cx="${x+Math.cos(a)*r}" cy="${y+Math.sin(a)*r}" r="${7+rand()*4}" fill="url(#real-crown)"/>`;}
  for(let k=0;k<15;k++)d+=`<circle cx="${x-11+rand()*21}" cy="${y-11+rand()*21}" r="${.6+rand()}" fill="#c1cb8f" opacity=".45"/>`;
 }
 // More realistic parked cars, kept in their marked bays.
 for(let i=0;i<6;i++){const y=655+i*32;d+=`<g transform="translate(100 ${y+5})"><rect x="3" y="3" width="48" height="19" rx="5" fill="#233b4240"/><rect x="2" y="-1" width="9" height="3" rx="1" fill="#263a41"/><rect x="34" y="-1" width="9" height="3" rx="1" fill="#263a41"/><rect x="2" y="17" width="9" height="3" rx="1" fill="#263a41"/><rect x="34" y="17" width="9" height="3" rx="1" fill="#263a41"/><rect width="48" height="19" rx="5" fill="${['#d4d9cf','#637e8e','#ae8c68'][i%3]}" stroke="#526e75"/><rect x="15" y="2" width="19" height="15" rx="3" fill="url(#real-glass)"/><rect x="20" y="2" width="10" height="15" rx="2" fill="${['#e5e8de','#7796a4','#bca280'][i%3]}"/><path d="M45 3v4m0 5v4" stroke="#f5edbf" stroke-width="2"/><path d="M2 3v4m0 5v4" stroke="#b75c4d" stroke-width="1.5"/></g>`;}
 layer('realistic-architecture',d);
}

let exitTasks=[],exitWorking=false,exitGeneration=0;
function resetExitControl(){for(const n of vehicleNodes.values()){if(n._gatePending){cancelAnimationFrame(n._frame);n._moving=false;n._reservation=null;n._queued=null;n._target=null;n._gatePending=false;delete n._detentionStage;}}exitGeneration++;exitTasks=[];exitWorking=false;document.querySelector('#exit-control')?.classList.remove('blocked');}
function scheduleDetention(node,target,id){
 node._detentionTarget=target;
 if(node._detentionStage==='parked'){moveTruck(node,target);return;}
 if(node._detentionStage)return;
 node._detentionStage='pending';node._gatePending=true;exitTasks.push({node,id,generation:exitGeneration});runExitTask();
}
function runExitTask(){
 if(exitWorking)return;
 const task=exitTasks.shift();if(!task)return;
 const {node,id,generation}=task;
 if(!node.isConnected||generation!==exitGeneration){runExitTask();return;}
 exitWorking=true;node._detentionStage='approaching';
 moveTruck(node,{x:1480,y:340},()=>{
  if(!node.isConnected||generation!==exitGeneration){exitWorking=false;runExitTask();return;}
  node._detentionStage='blocked';node.querySelector('.truck-tag').textContent=`${String(id).padStart(3,'0')} · ШЫҒУҒА ТЫЙЫМ`;
  $('exit-control').classList.add('blocked');$('exit-status').textContent=`№${id} · Шығуға тыйым`;
  const delay=matchMedia('(prefers-reduced-motion: reduce)').matches?0:1800;
  motionUntil=Math.max(motionUntil,performance.now()+delay);
  setTimeout(()=>{
   if(generation!==exitGeneration)return;
   if(!node.isConnected){exitWorking=false;runExitTask();return;}
   node._detentionStage='parking';
   moveTruck(node,node._detentionTarget,()=>{
    if(generation!==exitGeneration)return;
    node._detentionStage='parked';node._gatePending=false;
    node.querySelector('.truck-tag').textContent=`${String(id).padStart(3,'0')} · Ұсталды`;
    $('exit-control').classList.remove('blocked');$('exit-status').textContent='Шығуды бақылау';exitWorking=false;runExitTask();
   });
  },delay);
 });
}
function addExitControl(){
 const svg=document.querySelector('.site-map'),ns='http://www.w3.org/2000/svg',g=document.createElementNS(ns,'g');g.id='exit-control';
 g.innerHTML=`<rect x="1535" y="235" width="56" height="42" rx="3" fill="#e0e8de" stroke="#829b95"/><path d="M1532 235h62v7h-62z" fill="#4c7c7b"/><rect x="1542" y="248" width="29" height="18" fill="url(#real-glass)"/><rect x="1538" y="284" width="11" height="15" rx="2" fill="#e6b361" stroke="#927042"/><g class="exit-boom"><path d="M1543 294v88" stroke="#f2efdc" stroke-width="6"/><path d="M1543 294v88" stroke="#c26c53" stroke-width="6" stroke-dasharray="7 7"/></g><circle class="exit-signal" cx="1580" cy="257" r="5"/><text id="exit-status" x="1390" y="223" font-family="Arial" font-size="12" fill="#3c6157">Шығуды бақылау</text><path d="M1518 300v80" stroke="#e9e6cd" stroke-width="3"/>`;
 svg.append(g);
 const staff=document.createElementNS(ns,'g');
 const officer=(x,y)=>`<g transform="translate(${x} ${y})"><ellipse cx="5" cy="8" rx="8" ry="14" fill="#253d3d30"/><path d="M-3 7l-1 10M3 7l1 10" stroke="#293e50" stroke-width="4"/><rect x="-6" y="-5" width="12" height="15" rx="3" fill="#32596b"/><path d="M-4-3v10M4-3v10" stroke="#e7bd58" stroke-width="3"/><path d="M-6-1l-4 10M6-1l4 8" stroke="#32596b" stroke-width="3"/><circle cy="-10" r="4" fill="#d5ad8b"/><path d="M-5-12h10v3H-5z" fill="#22445a"/><rect x="5" y="0" width="7" height="9" rx="1" fill="#243e49" stroke="#9ab6b5"/><path d="M-5 18h5m3 0h5" stroke="#1f303b" stroke-width="3"/></g>`;
 staff.innerHTML=officer(1500,255)+officer(1380,491)+`<text x="1413" y="276" fill="#43685d" font-size="11" font-family="Arial">Кезекші инспектор</text><text x="1348" y="520" fill="#43685d" font-size="10" font-family="Arial">Бақылаушы</text>`;svg.append(staff);
}
function renderExitReport(){
 const released=state.trucks.filter(t=>t.status==='released'),held=state.trucks.filter(t=>t.status==='detected');
 $('exit-counts').textContent=`Шығуға рұқсат берілді: ${released.length} · Расталған бұзушылықпен ұсталды: ${held.length}`;
 $('exit-results').hidden=!state.done;
 if(!state.done)return;
 $('exit-results-body').replaceChildren();
 for(const t of [...released,...held]){
  const row=document.createElement('tr');
  const alarm=t.primary||t.document||t.scan===true;
  const cells=[`№${t.id}`,t.cargo,alarm?'Күмәнді белгі болды':'Дабыл болған жоқ',t.status==='detected'?'Ұсталды · шығуға тыйым':t.actions.includes('DEEP')?'Тексерілді · шығуға рұқсат':'Шығуға рұқсат'];
  for(const v of cells){const c=document.createElement('td');c.textContent=v;row.append(c);}if(t.status==='detected')row.className='held-row';$('exit-results-body').append(row);
 }
}

init();
function expandTerminalGrounds(){
  const svg=document.querySelector('.site-map');
  const defs=svg.querySelector('defs');
  defs.insertAdjacentHTML('beforeend',`
    ${[['grass-plot','meadow'],['reserve-slab','concrete'],['basin-water','pond']].map(([id,key])=>`<pattern id="${id}" width="330" height="330" patternUnits="userSpaceOnUse"><image href="${terminalMaterials[key]}" width="330" height="330"/></pattern>`).join('')}
    <g id="reserve-lamp"><path d="M1 2l14 17" stroke="#45534a" opacity=".24" stroke-width="4"/><circle r="3.5" fill="#858878"/><path d="M0 0v-15h9" fill="none" stroke="#53616a" stroke-width="2"/><rect x="6" y="-17" width="9" height="4" rx="1.5" fill="#eee4c5"/></g>
    <g id="reserve-tree"><image href="${terminalMaterials.tree1}" x="-23" y="-23" width="46" height="46" class="yard-canopy"/></g>
    <g id="reserve-tank"><ellipse cx="5" cy="6" rx="23" ry="22" fill="#39484044"/><circle r="21" fill="#84928d" stroke="#697d79" stroke-width="2"/><circle cy="-3" r="19" fill="#c8d0c7" stroke="#e4e6da"/><path d="M-17 -3h34m-17-17v34" stroke="#a3b1a9"/><circle cy="-3" r="4" fill="#7a8885"/></g>`);
  const group=document.createElementNS('http://www.w3.org/2000/svg','g');
  group.id='expanded-grounds';
  const art=[];
  const put=markup=>art.push(markup);
  const rect=(x,y,w,h,color,extra='')=>put(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${color}" ${extra}/>`);
  const path=(d,color,width,extra='')=>put(`<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" ${extra}/>`);
  const use=(id,x,y,scale=1)=>put(`<use href="#${id}" transform="translate(${x} ${y}) scale(${scale})"/>`);
  const sign=(x,y,label,w)=>{rect(x,y,w,25,'#344c49','rx="4"');put(`<text x="${x+9}" y="${y+17}" font-family="Arial" font-size="13" font-weight="bold" fill="#fff8df">${label}</text>`);};
  let seed=1401;
  const random=()=>((seed=(seed*1664525+1013904223)>>>0)/4294967296);
  rect(yard.left,yard.top,yard.width,yard.height,'url(#grass-plot)');
  // Flood channel and windbreak along the northern boundary.
  const channel='M-1600 -102C-810 -36 -590 -122 -260 -83S300 -24 585 -80S1170 -126 1650 -68';
  for(const [width,color] of [[56,'#b6b18d'],[44,'#82956e'],[27,'#6f9280'],[12,'#89a899']])path(channel,color,width);
  for(let x=-1520;x<1580;x+=43){
    use('reserve-tree',x,-20-random()*12,.56+random()*.37);
  }
  rect(-1530,42,1512,635,'url(#reserve-slab)','rx="14" stroke="#849185" stroke-width="4"');
  // West approach and two connected holding loops, matching the motion coordinates.
  const roads=['M-1560 340H2','M-1480 340V120H-55V340','M-1480 340V570H-55V340'];
  for(const road of roads)path(road,'#b7b5a4',102,'stroke-linejoin="round"');
  for(const road of roads)path(road,'url(#real-asphalt)',96,'stroke-linejoin="round"');
  path('M-1560 340H0','#c9c8b8',2,'stroke-dasharray="18 15"');
  for(const y of [120,570]){
    for(let i=0;i<yard.reserveSlots;i++){
      const x=queueBay(i+yard.primarySlots,y===120?340:590).x;
      put(`<g class="reserve-bay" id="bay-${y}-${i}"><rect x="${x-50}" y="${y-35}" width="100" height="70" rx="3"/><path d="M${x-50} ${y+30}v-65h100v65" fill="none" stroke="#e6d7ac" stroke-width="2.4"/><text x="${x}" y="${y+9}" text-anchor="middle" font-family="Arial" font-weight="bold" font-size="24" fill="#e7e5ce">${y===120?'S':'T'}-${String(i+1).padStart(2,'0')}</text></g>`);

    }
    sign(y===120?-890:-420,y===120?47:495,y===120?'СКАНЕР · РЕЗЕРВТІК КЕЗЕК':'ТЕКСЕРУ · РЕЗЕРВТІК КЕЗЕК',225);
    for(let x=-1410;x<-100;x+=150)use('reserve-lamp',x,y+55);
  }
  // Truck scales and their instrument booth on the apron.
  for(const y of [196,421]){
    rect(-1370,y,310,68,'#616b67','rx="5"');rect(-1365,y+4,300,60,'url(#reserve-slab)');
    for(let x=-1354;x<-1073;x+=26) path(`M${x} ${y+7}v52`,'#717774',1);
    for(const dy of [10,52])path(`M-1354 ${y+dy}h272`,'#c7a962',3);
    for(const x of [-1368,-1065]){rect(x,y+13,6,30,'#494e4c');rect(x+1,y+15,4,8,'#c7a05a');}
  }
  put(`<image href="${terminalMaterials.roof3}" x="-1053" y="199" width="98" height="53" class="terminal-roof"/>`);
  sign(-1340,267,'Салмақ өлшеу алаңы',172);
  // Break up the two islands with dispatch buildings, equipment and loading aprons.
  for(const [x,y,w,h,kind] of [[-917,194,202,72,3],[-674,194,166,71,0],[-909,415,260,81,2]]){
    rect(x-10,y-6,w+24,h+21,'#a8ada4','rx="4"');
    put(`<image href="${terminalMaterials['roof'+kind]}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="none" class="terminal-roof"/>`);
  }
  sign(-916,266,'Диспетчерлік бекет',160);
  for(let k=0;k<12;k++){
    const x=-440+k%6*49,y=192+Math.floor(k/6)*34;
    rect(x+3,y+4,42,25,'#637569');rect(x,y,42,25,['#9d7056','#768b88','#647e8e'][k%3],'rx="2"');
    for(let j=4;j<40;j+=5)path(`M${x+j} ${y+2}v21`,'#d5ccad',.8);
  }
  rect(-576,411,390,81,'#a7ada0','rx="6"');
  for(let k=0;k<5;k++)use('reserve-tank',-535+k*75,448);
  path('M-545 477h328v-16','#737c6e',5);
  // Gravel maintenance road and a retention pond outside the operational pavement.
  const service='M-1560 722Q-770 687 -560 736T-120 848Q-48 870 -33 955Q-4 1040 330 1035H1595';
  path(service,'#848d74',45);path(service,'#c1b99e',39);path(service,'#b4ad91',25,'stroke-dasharray="2 4"');
  const pond='M-931 847C-854 780 -689 802 -627 850S-499 924 -574 986S-824 1050 -928 1008S-1018 912 -931 847Z';
  put(`<path d="${pond}" fill="url(#basin-water)" stroke="#a5ac84" stroke-width="17"/>`);
  for(let i=0;i<80;i++){
    const x=-846+random()*211,y=870+random()*96;
    path(`M${x} ${y}q8 -2 18 0`,'#bfd4ba',.8,'opacity=".48"');
  }
  for(let i=0;i<94;i++){
    const x=-1040+random()*2600,y=1075+random()*65;
    use('reserve-tree',x,y,.42+random()*.65);
  }
  for(let k=0;k<23;k++)use('reserve-tree',-1043+k*43,663+random()*16,.46+random()*.48);
  for(let k=0;k<22;k++)use('reserve-tree',-399+(k%7)*44+random()*10,900+Math.floor(k/7)*43,.58+random()*.4);
  // Pond maintenance pontoon, reed beds and pump station.
  rect(-673,804,15,76,'#645848');rect(-689,868,47,12,'#a08a6b');
  for(let y=807;y<868;y+=5)path(`M-672 ${y}h12`,'#bca482',1);
  for(const [cx,cy] of [[-923,853],[-965,927],[-857,1019],[-632,993]]){
    for(let k=0;k<19;k++){
      const x=cx+random()*23,y=cy+random()*10;
      path(`M${x} ${y}q-2 -5 -4 -8m4 8q2 -7 5 -10`,'#687a4f',1.5);
    }
  }
  // Fenced electrical service yard alongside the maintenance road.
  rect(510,953,490,58,'#a6a79b','rx="3" stroke="#69756d" stroke-width="2"');
  for(let i=0;i<4;i++){
    const x=537+i*82;
    rect(x,967,52,27,'#516666','rx="2"');rect(x+3,964,47,24,'#879997');
    for(let j=0;j<8;j++)path(`M${x+5+j*5} 970v17`,'#536766',1.5);
    for(let j=0;j<3;j++)use('reserve-lamp',x+9+j*12,970,.36);
  }
  put(`<image href="${terminalMaterials.roof3}" x="880" y="956" width="108" height="48" class="terminal-roof"/>`);
  for(let x=510;x<=1000;x+=28)path(`M${x} 951v7m0 50v6`,'#57665e',2);
  sign(1020,966,'Электр қосалқы станциясы',201);
  sign(-931,1041,'Су жинау тоғаны',146);
  // Keep the existing operating terminal above the new ground layer.
  group.innerHTML=art.join('');
  const oldGround=svg.querySelector('rect[fill="#bfcfb2"]');
  svg.insertBefore(group,oldGround);
}
function buildDetentionYard(){
  const svg=document.querySelector('.site-map');
  const art=['<g id="detention-extension"><rect x="386" y="1144" width="1160" height="420" rx="9" fill="url(#reserve-slab)"/>'];
  const centerline='M1480 836V1510';
  const routes=[centerline,...detentionRows.slice(1).map(y=>`M426 ${y}H1480`)];
  for(const route of routes) art.push(`<path class="held-road" d="${route}" fill="none" stroke="url(#real-asphalt)" stroke-width="88"/>`);
  art.push('<path d="M1480 870V1490" stroke="#d6cfad" stroke-width="2" stroke-dasharray="16 14"/>');
  for(let i=0;i<detentionCapacity;i++){
    const {x,y}=detentionBay(i);
    art.push(`<path d="M${x-53} ${y+31}v-62h106v62" fill="none" stroke="#ddbf80" stroke-width="1.8"/>
    <text x="${x}" y="${y+4}" text-anchor="middle" fill="#ece0b6" font-family="Arial" font-size="15">D-${String(i+1).padStart(2,'0')}</text>`);
    if(i>=8 && i%2===0) art.push(`<use href="#reserve-lamp" transform="translate(${x+52} ${y+42})"/>`);
  }
  art.push('<rect x="416" y="1106" width="405" height="32" rx="4" fill="#594639"/><text id="held-yard-count" x="428" y="1128" font-family="Arial" font-size="16" fill="#fff1d3"></text>');
  art.push(`<rect x="-294" y="1124" width="662" height="427" rx="7" fill="url(#reserve-slab)" stroke="#8f9991" stroke-width="3"/>
    <image href="${terminalMaterials.interior}" x="-264" y="1148" width="596" height="345" class="terminal-roof"/>
    <g fill="#31464b" font-size="15" text-anchor="middle" font-family="Arial">
      <text x="-158" y="1515">Диспетчер бөлмесі</text><text x="32" y="1515">Құжат тексеру</text><text x="231" y="1515">Айғақтар қоймасы</text>
    </g></g>`);
  svg.insertAdjacentHTML('beforeend',art.join(''));
}
function showFleetModel(id){
  if(document.querySelector('#fleet-dialog'))return;
  const truck=state.trucks.find(t=>t.id===id);
  if(!truck)return;
  const names=['Контейнер тасығыш','Тоңазытқышты тіркеме','Автоцистерна'];
  openObjectView({key:'truck',title:`№${String(id).padStart(3,'0')} · ${names[id%3]}`,detail:truck.cargo,model:JSON.parse($('truck-models').textContent)[id%3],preview:'truck'+id%3});
}
function openObjectView(spec){
  if($('fleet-dialog'))return;
  const dialog=document.createElement('dialog');
  dialog.id='fleet-dialog';
  dialog.innerHTML=`<header><div><h2 id="fleet-name">${spec.title}</h2><span></span></div><button aria-label="Жабу">×</button></header><div class="fleet-stage"></div><div class="fleet-controls"><button data-turn="-1">← Солға бұру</button><button data-turn="1">Оңға бұру →</button></div>`;
  dialog.setAttribute('aria-labelledby','fleet-name');
  dialog.querySelector('header span').textContent=spec.detail;
  const stage=dialog.querySelector('.fleet-stage');
  document.body.append(dialog);
  dialog.showModal();
  const wasPlaying=playing;
  if(wasPlaying)pause();
  let raf=0,observer,renderer,scene;
  dialog.onclose=()=>{
    cancelAnimationFrame(raf);observer?.disconnect();
    scene?.traverse(o=>{o.geometry?.dispose();o.material?.dispose();});
    renderer?.dispose();renderer?.forceContextLoss();dialog.remove();
    if(wasPlaying&&!state.done&&!playing)$('play').click();
  };
  dialog.querySelector('header button').onclick=()=>dialog.close();
  try{renderer=new THREE.WebGLRenderer({antialias:true,alpha:false});}
  catch(error){
    stage.innerHTML=`<img alt="${spec.title}" src="${terminalMaterials[spec.preview]||''}"><p>3D көрініс үшін браузерде графикалық үдетуді қосыңыз.</p>`;
    if(!spec.preview)stage.querySelector('img').remove();
    dialog.querySelector('.fleet-controls').hidden=true;return;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  stage.append(renderer.domElement);
  scene=new THREE.Scene();scene.background=new THREE.Color('#263746');
  const camera=new THREE.PerspectiveCamera(34,1,.1,140);
  const sky=new THREE.HemisphereLight(0xf2f9ff,0x857461,2.0);scene.add(sky);
  const sun=new THREE.DirectionalLight(0xffe5bf,3.1);sun.position.set(8,14,9);sun.castShadow=true;
  Object.assign(sun.shadow.camera,{left:-12,right:12,top:12,bottom:-12});sun.shadow.mapSize.set(1024,1024);sun.shadow.normalBias=.025;scene.add(sun);
  const rim=new THREE.DirectionalLight(0xc3e5ff,1.6);rim.position.set(-6,7,-8);scene.add(rim);
  const model=spec.model;
  for(const [kind,[x,y,z],size,color,axis] of model){
    const geometry=kind==='box'?new THREE.BoxGeometry(size[0],size[2],size[1]):new THREE.CylinderGeometry(size[0],size[0],size[1],40);
    const material=new THREE.MeshStandardMaterial({color,metalness:color==='#d6e0df'?.48:.13,roughness:color==='#284653'?.2:.48});
    const mesh=new THREE.Mesh(geometry,material);mesh.position.set(x,z,-y);
    if(axis==='Y')mesh.rotation.x=Math.PI/2;
    if(axis==='X')mesh.rotation.z=Math.PI/2;
    mesh.castShadow=true;mesh.receiveShadow=true;scene.add(mesh);
  }
  const floor=new THREE.Mesh(new THREE.PlaneGeometry(180,180),new THREE.MeshStandardMaterial({color:0x4a5359,roughness:.95}));
  floor.rotation.x=-Math.PI/2;floor.receiveShadow=true;scene.add(floor);
  let angle=.83,target=angle,elevation=.33,lastX=0,lastY=0,pointer=null;
  let focusX=0,focusY=2.2,focusZ=0,distance=spec.key==='building'?38:23;
  if(spec.key==='building')elevation=.78;
  function draw(){
    const dist=Math.max(distance,distance/camera.aspect);
    camera.position.set(focusX+Math.sin(angle)*Math.cos(elevation)*dist,focusY+Math.sin(elevation)*dist,focusZ+Math.cos(angle)*Math.cos(elevation)*dist);
    camera.lookAt(focusX,focusY,focusZ);renderer.render(scene,camera);
  }
  function control(label,onClick){
    const b=document.createElement('button');b.textContent=label;
    b.onclick=()=>onClick(b);dialog.querySelector('.fleet-controls').append(b);return b;
  }
  if(spec.key==='building'){
    const roof=new THREE.Mesh(new THREE.BoxGeometry(25.6,.26,15.6),new THREE.MeshStandardMaterial({color:0x697c82}));
    roof.position.y=2.58;roof.castShadow=true;scene.add(roof);
    const roofButton=control('Шатырды ашу',b=>{
      roof.visible=!roof.visible;b.textContent=roof.visible?'Шатырды ашу':'Шатырды жабу';
      focusX=0;focusY=1;focusZ=0;distance=38;elevation=.78;draw();
    });
    for(const [label,x] of [['Диспетчер бөлмесі',-8.4],['Құжат тексеру',0],['Айғақтар қоймасы',8.4]]){
      control(label,()=>{cancelAnimationFrame(raf);roof.visible=false;roofButton.textContent='Шатырды жабу';focusX=x;focusZ=0;focusY=.85;distance=12;elevation=.71;angle=target=.2;draw();});
    }
  }else if(spec.key==='scanner'||spec.key==='gate'){
    const scanner=spec.key==='scanner';
    const part=new THREE.Group();scene.add(part);
    const moving=scanner?new THREE.Mesh(new THREE.BoxGeometry(.05,4.6,4.7),new THREE.MeshBasicMaterial({color:0x55fbd8,transparent:true,opacity:.35,depthWrite:false})):new THREE.Mesh(new THREE.BoxGeometry(.22,.24,5.3),new THREE.MeshStandardMaterial({color:0xfff2d3}));
    part.add(moving);
    if(scanner){part.position.set(-2.8,2.45,0);}
    else{
      part.position.set(0,1.38,-2.7);moving.position.z=2.65;
      for(let k=0;k<6;k++){const stripe=new THREE.Mesh(new THREE.BoxGeometry(.228,.248,.38),new THREE.MeshStandardMaterial({color:0xc63d32}));stripe.position.z=.45+k*.86;part.add(stripe);}
    }
    let actionFrame=0,opened=false;
    dialog.addEventListener('close',()=>cancelAnimationFrame(actionFrame),{once:true});
    control(scanner?'Сканерлеуді бастау':'Шлагбаумды ашу',b=>{
      const start=performance.now();opened=!opened;b.disabled=true;
      function motion(now){
        const t=matchMedia('(prefers-reduced-motion: reduce)').matches?1:Math.min(1,(now-start)/1350);
        if(scanner)part.position.x=-2.8+5.6*(opened?t:1-t);
        else part.rotation.x=-1.48*(opened?t:1-t);
        draw();
        if(t<1)actionFrame=requestAnimationFrame(motion);
        else{b.disabled=false;if(!scanner)b.textContent=opened?'Шлагбаумды жабу':'Шлагбаумды ашу';}
      }
      actionFrame=requestAnimationFrame(motion);
    });
  }
  function resize(){const w=stage.clientWidth,h=stage.clientHeight;renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();draw();}
  observer=new ResizeObserver(resize);observer.observe(stage);resize();
  function turn(){angle+=(target-angle)*.16;if(Math.abs(target-angle)<.002)angle=target;draw();if(angle!==target)raf=requestAnimationFrame(turn);}
  dialog.querySelectorAll('[data-turn]').forEach(b=>b.onclick=()=>{cancelAnimationFrame(raf);target+=Number(b.dataset.turn)*Math.PI/4;if(matchMedia('(prefers-reduced-motion: reduce)').matches)angle=target;turn();});
  stage.onpointerdown=e=>{cancelAnimationFrame(raf);pointer=e.pointerId;stage.setPointerCapture(pointer);lastX=e.clientX;lastY=e.clientY;};
  stage.onpointermove=e=>{if(e.pointerId!==pointer)return;angle-=(e.clientX-lastX)*.011;target=angle;elevation=Math.min(1.25,Math.max(.09,elevation+(e.clientY-lastY)*.008));lastX=e.clientX;lastY=e.clientY;draw();};
  stage.onpointercancel=stage.onpointerup=()=>{pointer=null;};
}
function showSiteObject(key){
  const names={building:'Инспекциялық корпус',scanner:'Жүк сканері',gate:'Шығу шлагбаумы'};
  if(key==='building'){
    openObjectView({key,title:names[key],detail:'Шатырды ашыңыз немесе бөлмені таңдаңыз.',preview:'interior',model:JSON.parse($('inside-model').textContent)});
    return;
  }
  const model=[];
  const box=(x,y,z,w,d,h,color)=>model.push(['box',[x,y,z],[w,d,h],color]);
  box(0,0,.09,12,8,.18,'#677279');
  for(let x=-5;x<=5;x+=2)box(x,0,.19,1,.08,.014,'#e8d59e');
  if(key==='scanner'){
    for(const x of [-3,3]){
      for(const y of [-2.75,2.75]){
        box(x,y,.35,.85,.82,.37,'#b5b7a9');box(x,y,2.9,.54,.49,5,'#41767a');
        for(let z=.7;z<5.3;z+=.42)box(x,y,z,.58,.52,.06,'#8ca6a1');
      }
      box(x,0,5.5,.61,5.96,.44,'#568789');
    }
    for(const y of [-2.75,2.75])box(0,y,5.5,6,.35,.32,'#87a4a1');
    box(.8,-3.5,1.03,1.25,.65,1.66,'#b8c6c1');box(.8,-3.845,1.35,.8,.05,.47,'#254956');
    for(const y of [-.8,0,.8])box(0,y,.37,2.4,.2,.25,'#ac8460');
    box(0,0,1.17,2.15,1.85,1.37,'#ba9169');
    for(const x of [-.6,.6])box(x,0,1.17,.08,1.87,1.4,'#7b6955');
  }else{
    box(0,2.72,.86,.82,.82,1.42,'#d4a34e');
    box(-2.6,3.05,1.48,2.2,1.65,2.55,'#b4bdb0');box(-2.6,3.05,2.85,2.55,1.96,.21,'#4c6969');
    box(-2.6,2.2,1.82,1.68,.06,.91,'#3b5d6c');
    box(-1.42,2.96,1.82,.06,1.15,.91,'#638592');
    for(const y of [-3,3]){box(2,y,1.15,.1,.1,1.96,'#829091');box(2,y,2.18,.41,.31,.68,'#25333a');}
    box(2.22,-3,2.33,.045,.17,.18,'#da6247');box(2.22,3,2.05,.045,.17,.18,'#7fc6a2');
    box(-1.15,0,.19,.19,5.2,.02,'#eee5cb');
  }
  openObjectView({key,title:names[key],detail:'Жабдықтың интерактивті үлгісі',model});
}
function installObjectTargets(){
  const svg=document.querySelector('.site-map');
  const objects=[['building','Инспекциялық корпус',-264,1148,596,345],['scanner','Жүк сканері',1153,274,193,140],['gate','Шығу шлагбаумы',1517,234,76,148]];
  for(const [key,label,x,y,w,h] of objects){
    const hit=document.createElementNS('http://www.w3.org/2000/svg','rect');
    for(const [attr,value] of Object.entries({x,y,width:w,height:h,class:'object-3d-target',role:'button',tabindex:'0','aria-label':label+' · 3D','data-object':key}))hit.setAttribute(attr,value);
    const title=document.createElementNS(hit.namespaceURI,'title');title.textContent=label+' · 3D';hit.append(title);
    hit.onclick=()=>showSiteObject(key);hit.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();hit.onclick();}};svg.append(hit);
  }
  const select=document.createElement('select');select.setAttribute('aria-label','Нысанды 3D көру');
  select.add(new Option('Нысанды 3D көру…',''));
  for(const [key,label] of objects)select.add(new Option(label,key));
  select.onchange=()=>{const key=select.value;select.value='';if(key)showSiteObject(key);};
  document.querySelector('.map-tools').append(select);
}
function startLiveYard(){
  const toolbar=document.querySelector('.map-tools'),map=$('map');
  const host=document.createElement('section');host.id='live-yard';host.setAttribute('aria-label','Кеден терминалының 3D картасы');
  host.innerHTML='<div class="yard-caption"><b>Терминал · 3D</b><span id="yard-focus">Жалпы көрініс</span></div><div class="yard-inside" hidden></div>';
  map.before(host);
  let renderer;
  try{renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'low-power'});}
  catch{host.remove();return;}
  renderer.domElement.setAttribute('aria-label','Терминал. Көлікті таңдап бақылауға болады.');
  host.prepend(renderer.domElement);
  const scene=new THREE.Scene();scene.background=new THREE.Color(0xb4cad4);scene.fog=new THREE.FogExp2(0xc8d6d4,.00013);
  const camera=new THREE.PerspectiveCamera(42,1,1,18000);
  renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  scene.add(new THREE.HemisphereLight(0xfff8e7,0x8a9a9e,1.9));
  const sun=new THREE.DirectionalLight(0xffe3be,2.65);sun.position.set(-1250,2400,700);sun.target.position.set(0,0,590);scene.add(sun,sun.target);sun.castShadow=true;
  Object.assign(sun.shadow.camera,{left:-1840,right:1840,top:1540,bottom:-1540,near:10,far:6200});sun.shadow.camera.updateProjectionMatrix();sun.shadow.mapSize.set(2048,2048);sun.shadow.normalBias=.8;
  const terrain=new THREE.TextureLoader().load($('yard-ground').src,()=>{dirty=true;});terrain.colorSpace=THREE.SRGBColorSpace;terrain.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
  function ground(w,h,x,z,mat,y=0){const m=new THREE.Mesh(new THREE.PlaneGeometry(w,h),mat);m.rotation.x=-Math.PI/2;m.position.set(x,y,z);m.receiveShadow=true;scene.add(m);}
  ground(14000,14000,0,0,new THREE.MeshStandardMaterial({color:0x919c7c}),-1);
  ground(yard.width,yard.height,yard.left+yard.width/2,yard.top+yard.height/2,new THREE.MeshStandardMaterial({map:terrain}));
  const shapes={box:new THREE.BoxGeometry(1,1,1),cylinder:new THREE.CylinderGeometry(.5,.5,1,20),leaves:new THREE.IcosahedronGeometry(.5,1)};
  const palette=new THREE.MeshStandardMaterial({roughness:.67});
  function batch(items){
    const g=new THREE.Group(),dummy=new THREE.Object3D();
    for(const type of Object.keys(shapes)){
      const records=items.filter(i=>i[0]===type);if(!records.length)continue;
      const mesh=new THREE.InstancedMesh(shapes[type],palette,records.length);
      records.forEach(([kind,x,y,z,w,h,d,color,axis],index)=>{
        dummy.position.set(x,y,z);dummy.scale.set(w,h,d);dummy.rotation.set(axis==='Y'?Math.PI/2:0,0,axis==='X'?Math.PI/2:0);dummy.updateMatrix();
        mesh.setMatrixAt(index,dummy.matrix);mesh.setColorAt(index,new THREE.Color(color));
      });mesh.castShadow=true;mesh.receiveShadow=true;g.add(mesh);
    }return g;
  }
  function parts(records){return records.map(([kind,[x,y,z],size,color,axis])=>kind==='box'?[kind,x,z,-y,size[0],size[2],size[1],color]:[kind,x,z,-y,size[0]*2,size[1],size[0]*2,color,axis]);}
  const fixtures=[],pickables=[];
  const box=(x,y,z,w,h,d,color)=>fixtures.push(['box',x,y,z,w,h,d,color]);
  function hit(x,y,z,w,h,d,what){
    const m=new THREE.Mesh(shapes.box,new THREE.MeshBasicMaterial({visible:false}));m.position.set(x,y,z);m.scale.set(w,h,d);m.userData.what=what;scene.add(m);pickables.push(m);return m;
  }
  function warehouse(x,z,w,d,h){
    box(x+w/2,h/2,z+d/2,w,h,d,'#babfb5');box(x+w/2,h+1,z+d/2,w+3,3,d+3,'#829291');
    for(let dx=9;dx<w-8;dx+=18){box(x+dx,h+3,z+d/2,1.1,1.2,d,'#a2b0ab');box(x+dx,h*.57,z+d+.5,13,h*.36,1.6,'#436271');}
    for(const k of [.18,.77]){box(x+w*k,h+5,z+d*.46,24,8,16,'#b7c0ba');fixtures.push(['cylinder',x+w*k,h+9.4,z+d*.46,11,1.5,11,'#4f6060']);}
    box(x+w*.52,h+3.2,z+d*.48,w*.23,2,d*.34,'#364f5f');
  }
  for(const dims of [[100,75,250,100,45],[430,65,320,125,55],[830,70,270,120,54],[60,450,190,130,41],[-917,194,202,72,32],[-674,194,166,71,40],[-909,415,260,81,45],[-1053,199,98,53,22],[880,956,108,48,24],[1535,235,54,42,28]])warehouse(...dims);
  function container(x,z,w,d,h,c){box(x,h/2,z,w,h,d,c);for(let dx=-w/2+4;dx<w/2;dx+=8)box(x+dx,h+.7,z,1.3,1.5,d,c);}
  for(let i=0;i<5;i++)container(495+i*119,454,100,58,30,['#518385','#aa7157','#73899a','#aa8e60','#758f78'][i]);
  for(let i=0;i<12;i++)container(-419+i%6*49,205+Math.floor(i/6)*34,42,25,18,['#a47558','#668b86','#708299'][i%3]);
  for(let i=0;i<5;i++)fixtures.push(['cylinder',-535+i*75,17,448,43,34,43,'#bcc4be'],['cylinder',-535+i*75,35,448,39,3,39,'#dbe0d5']);
  let seed=421;const random=()=>((seed=(1664525*seed+1013904223)>>>0)/4294967296);
  function tree(x,z,k){box(x,11*k,z,3*k,22*k,3*k,'#76624e');for(let i=0;i<4;i++)fixtures.push(['leaves',x+(i%2-.5)*13*k,(23+random()*7)*k,z+(Math.floor(i/2)-.5)*12*k,(21+random()*5)*k,25*k,22*k,['#697e52','#819367','#879763','#627956'][i]]);}
  for(let x=-1520;x<1580;x+=44)tree(x,-28+random()*13,.7+random()*.45);
  for(let x=-1020;x<1520;x+=69)tree(x,1085+random()*44,.6+random()*.55);
  for(const x of [40,385,790,1547])for(const z of [58,150,235])tree(x,z,1);
  for(const x of [290,1550])for(const z of [460,510,690,730,890])tree(x,z,.9);
  for(let x=-1400;x<-100;x+=150)for(const z of [176,626]){box(x,15,z,2,30,2,'#65767b');box(x+4,30,z,10,2,4,'#e3dcc1');}
  for(let x=35;x<1570;x+=35)for(const z of [36,908]){box(x,8,z,2,16,2,'#697b79');box(x+17,9,z,35,2,1,'#aab9ad');}
  for(const x of [1170,1330]){for(const z of [300,380])box(x,25,z,7,50,8,'#396b72');box(x,50,340,8,6,88,'#609395');}
  for(const z of [300,380])box(1250,50,z,168,5,6,'#91aaa5');
  box(1543,10,294,9,20,10,'#ce9a49');
  // Shoulders connect the gates to the public approach beyond the terminal.
  for(const [x,width] of [[-3520,3920],[3520,3840]]){
    box(x,-.35,340,width,1,98,'#606768');
    for(let dx=-width/2+20;dx<width/2;dx+=60)box(x+dx,.3,340,22,.4,1.7,'#d7ceb1');
  }
  for(let i=0;i<6;i++){
    const z=669+i*32;box(124,6,z,43,10,17,['#9faab1','#8c765f','#647c86'][i%3]);
    box(125,12,z,24,5,14,'#486170');
  }
  for(const [x,z] of [[1500,255],[1380,491],[420,258],[610,258],[800,258],[990,258]]){
    box(x-1.7,3.7,z,2.4,7.4,3,'#384957');box(x+1.7,3.7,z,2.4,7.4,3,'#384957');
    box(x,10.5,z,6,7,3.5,'#cd9f53');box(x,12,z+1.9,5.9,1,1,'#e8deb5');
    fixtures.push(['leaves',x,16,z,4.4,5,4.4,'#c39675']);
  }
  for(let i=0;i<48;i++){
    const x=-5500+i*235,z=-2200-random()*1300;
    fixtures.push(['leaves',x,-100,z,600+random()*800,300+random()*480,600+random()*600,'#88957b']);
  }
  // Fixed equipment shares three instanced meshes with the rest of the terminal.
  // Each group also has a named camera stop at its actual map position.
  const equipment=new Map();
  function register(key,label,x,z,distance){equipment.set(key,{label,x,z,distance});}
  const cyl=(x,y,z,w,h,d,c,axis)=>fixtures.push(['cylinder',x,y,z,w,h,d,c,axis]);
  const iron='#596668',zinc='#9ba8a8',amber='#d69b38',tyre='#292f31';
  register('loading','Жүк тиеу алаңы',1032,703,176);
  for(let i=0;i<9;i++){
    const x=491+i*65,z=698;
    for(const dz of [-9,0,9])box(x,2,z+dz,43,4,3,'#856b4c');
    for(let dx=-18;dx<=18;dx+=6)box(x+dx,5,z,4,2,24,'#b99565');
    box(x,14,z-3,32,16,22,i%2?'#b79066':'#bfa47b');
    for(const dx of [-9,9])box(x+dx,14,z-3,1.3,16.5,22.5,'#626a63');
    box(x+7,15,z+8.2,7,4,.4,'#e5e0ce');
  }
  for(const x of [1053,1082])for(const z of [694,721]){
    cyl(x,7,z,14,6,14,tyre,'Y');cyl(x,7,z+(z<700?-3.3:3.3),7,1,7,zinc,'Y');
  }
  box(1067,12,707,35,12,25,amber);box(1055,20,707,12,8,24,amber);
  box(1066,20,707,10,3,11,tyre);box(1061,25,707,2.5,10,11,tyre);
  for(const x of [1054,1079])for(const z of [696,718])box(x,32,z,2.1,27,2.1,iron);
  box(1066,46,707,31,2.5,27,amber);
  for(const z of [698,716]){
    box(1091,24,z,3,44,3,iron);box(1087,23,z,1.8,34,1.8,zinc);
    box(1104,4,z,26,2.2,3.6,iron);
  }
  box(1091,41,707,3,3,21,iron);
  register('utilities','Электр қосалқы станциясы',707,980,370);
  for(let i=0;i<4;i++){
    const x=564+i*82;
    box(x,3,981,66,6,40,'#929991');box(x,18,981,46,27,23,'#748782');
    for(let dx=-21;dx<=21;dx+=4)for(const dz of [-14,14])box(x+dx,18,981+dz,1.7,22,6,'#536967');
    for(const dx of [-14,0,14]){
      cyl(x+dx,34,981,4,12,4,'#83715c');
      for(let j=0;j<3;j++)cyl(x+dx,32+j*3,981,6,1.4,6,'#9a8870');
    }
  }
  for(let x=510;x<1000;x+=24)for(const z of [951,1011])box(x,7,z,1.5,14,1.5,zinc);
  for(const z of [951,1011])for(const y of [4,10])box(755,y,z,490,.8,.8,iron);
  register('weigh','Көлік таразысы',-1208,230,340);
  for(const z of [230,455]){
    box(-1215,1.6,z,306,3.2,65,iron);box(-1215,4,z,298,1.7,57,'#899490');
    for(let x=-1353;x<-1072;x+=25)box(x,5,z,.9,.45,54,'#505b5a');
    for(const dz of [-31,31])box(-1215,5,z+dz,305,3,2,'#d5af55');
    box(-1059,13,z+24,2,26,2,iron);box(-1059,25,z+24,15,9,5,'#384745');
  }
  register('pond','Су жинау тоғаны',-750,898,380);
  for(const z of [809,839,867])for(const x of [-671,-660])cyl(x,3,z,3,12,3,'#746047');
  for(let z=805;z<878;z+=4.6)box(-666,7,z,15,2,4.2,'#b09b7c');
  for(let x=-687;x<-641;x+=5)box(x,7,874,4.6,2,12,'#a18a6a');
  for(const [x,z] of [[-923,853],[-965,927],[-857,1019],[-632,993]])for(let j=0;j<19;j++){
    const px=x+random()*23,pz=z+random()*10,h=5+random()*8;
    cyl(px,h/2,pz,.65,h,.65,'#86905a');cyl(px,h,pz,1,2.4,1,'#77684c');
  }
  register('tanks','Сұйықтық резервуарлары',-387,448,280);
  cyl(-383,7,477,4,325,4,'#9aa8a3','X');
  for(let i=0;i<5;i++){
    const x=-535+i*75;cyl(x,7,463,3,29,3,zinc,'Y');
    cyl(x,38,448,7,2,7,iron);
    for(const dx of [-3.5,3.5])box(x+dx,18,470,1,36,1,zinc);
    for(let y=3;y<36;y+=4)box(x,y,470,8,.8,1,zinc);
  }
  for(const [x,z] of [[450,232],[600,235],[1010,260],[70,205]]){
    for(const dx of [4,28])box(x+dx,3,z,2,6,9,iron);
    for(const dz of [-3,0,3])box(x+16,7,z+dz,33,2,2.6,'#a88a63');
    box(x+47,7,z,9,14,11,'#678175');box(x+47,14,z,10,1.6,12,iron);
  }
  for(let i=0;i<8;i++){
    const x=780+i*7;for(const dz of [0,12])cyl(x,4,242+dz,1.4,8,1.4,zinc);
    box(x,8,248,1.4,1.4,12,zinc);
  }
  for(const [x,z] of [[110,285],[1380,280],[1400,655],[310,730]]){
    cyl(x,18,z,2,36,2,iron);box(x+5,35,z,12,2,2,zinc);
    box(x+12,34,z,9,4,5,'#d8ded6');box(x+16.7,34,z,1,2.7,3.3,'#263b43');
  }
  for(const [x,z] of [[1150,500],[260,560],[850,208]]){
    cyl(x,5,z,5,10,5,'#b84f3b');box(x,11,z,4,2,2,iron);
  }
  for(let i=0;i<7;i++){
    const x=852+i*35;box(x,5,235,2,10,2,zinc);box(x,11,235,26,2,20,'#354e61');
    for(const dx of [-7,0,7])box(x+dx,12.2,235,.5,.3,19,'#9eaeb4');
  }
  for(const [x,z] of [[1120,570],[1370,570],[1120,625],[1370,625],[300,416],[430,677]]){
    box(x,1,z,6,2,6,tyre);cyl(x,3,z,4.4,3.2,4.4,amber);cyl(x,5.3,z,3,1.5,3,'#f5ead2');cyl(x,7,z,2,2,2,amber);
  }
  for(let i=8;i<detentionCapacity;i+=2){
    const bay=detentionBay(i),x=bay.x+52,z=bay.y+42;
    cyl(x,16,z,1.8,32,1.8,iron);box(x+3,32,z,8,2.4,3.5,'#dad9c2');
  }
  function signboard(x,z,text){
    const panel=document.createElement('canvas');panel.width=512;panel.height=88;
    const g=panel.getContext('2d');g.fillStyle='#24484a';g.fillRect(0,0,512,88);g.strokeStyle='#9aaba0';g.lineWidth=6;g.strokeRect(3,3,506,82);
    g.fillStyle='#fff6dc';g.font='bold 40px Arial';g.textAlign='center';g.fillText(text,256,57,476);
    const tex=new THREE.CanvasTexture(panel);tex.colorSpace=THREE.SRGBColorSpace;
    const board=new THREE.Mesh(new THREE.PlaneGeometry(116,20),new THREE.MeshBasicMaterial({map:tex,side:THREE.DoubleSide}));board.position.set(x,26,z);scene.add(board);
    for(const dx of [-45,45])box(x+dx,9,z,2,18,2,'#718481');
  }
  signboard(1250,263,'02 · СКАНЕР');signboard(1250,514,'03 · ТОЛЫҚ ТЕКСЕРУ');signboard(960,1120,'БАҚЫЛАУ ТҰРАҒЫ');signboard(-750,50,'БАТЫС РЕЗЕРВІ');
  scene.add(batch(fixtures));hit(1250,27,340,168,55,88,'scanner');hit(1543,16,310,22,42,64,'gate');
  for(const [key,e] of equipment)hit(e.x,14,e.z,Math.min(110,e.distance*.34),32,56,key);
  const objectMenu=toolbar.querySelector('select');
  for(const [key,e] of equipment)objectMenu.add(new Option(e.label,key));
  const gate=new THREE.Group();gate.position.set(1543,20,294);
  const stripes=[['box',0,0,44,3.5,4,88,'#f6ead5']];for(let i=0;i<6;i++)stripes.push(['box',0,0,5+i*14,3.7,4.2,7,'#b74939']);
  gate.add(batch(stripes));gate.rotation.x=-1.48;scene.add(gate);
  const beam=new THREE.Mesh(new THREE.BoxGeometry(1,40,76),new THREE.MeshBasicMaterial({color:0x4cffe4,transparent:true,opacity:.29,depthWrite:false}));scene.add(beam);
  const inside=batch(parts(JSON.parse($('inside-model').textContent)));inside.position.set(34,1,1320);inside.scale.set(23,19,22);scene.add(inside);
  const roof=batch([['box',0,0,0,584,5,336,'#889896'],['box',0,4,0,110,4,65,'#38566a'],['box',-203,7,-72,45,12,27,'#b5c3be']]);roof.position.set(34,48,1320);scene.add(roof);hit(34,25,1320,584,53,336,'building');
  const fleetModels=JSON.parse($('truck-models').textContent).map(records=>batch(parts(records)));
  const fleet=new Map(),ray=new THREE.Raycaster();
  let active=true,dirty=true,frame=0,last=0,watch=null,mode='overview',visible=true;
  let yaw=.04,pitch=1.04,range=3000,targetRange=3000;
  const center=new THREE.Vector3(20,0,750),goal=center.clone();
  const label=$('yard-focus'),insideTools=host.querySelector('.yard-inside');
  function focus(key,x,z,d,title){mode=key;watch=null;goal.set(x,key==='room'?20:0,z);targetRange=d;label.textContent=title;insideTools.hidden=!['room','building'].includes(key);roof.visible=insideTools.hidden;dirty=true;}
  function follow(id){
    const n=vehicleNodes.get(id);if(!n?._position)return;
    focus('truck',n._position.x,n._position.y,190,n.title);watch=id;pitch=.44;
  }
  function object(key){
    const e=equipment.get(key);if(e){focus(key,e.x,e.z,e.distance,e.label);pitch=.48;return;}
    if(key==='building'){focus(key,34,1320,620,'Инспекциялық корпус');pitch=.92;}
    if(key==='scanner'){focus(key,1250,340,270,'Жүк сканері');pitch=.53;}
    if(key==='gate'){focus(key,1543,320,210,'Шығу шлагбаумы');pitch=.46;}
  }
  for(const [title,x] of [['Диспетчер бөлмесі',-158],['Құжат тексеру',34],['Айғақтар қоймасы',225]]){
    const b=document.createElement('button');b.textContent=title;b.onclick=()=>{focus('room',x,1320,185,title);pitch=.70;};insideTools.append(b);
  }
  const movement=document.createElement('div');movement.className='yard-playback';
  movement.innerHTML='<button type="button" id="yard-play"></button><button type="button" id="yard-step">Бір шешім →</button>';
  host.append(movement);$('yard-play').onclick=()=>$('play').click();$('yard-step').onclick=()=>$('step').click();
  const modeButton=document.createElement('button');modeButton.type='button';modeButton.id='yard-mode';modeButton.textContent='2D карта';toolbar.prepend(modeButton);
  function switchMode(){
    active=!active;host.hidden=!active;map.hidden=active;modeButton.textContent=active?'2D карта':'3D терминал';
    for(const option of objectMenu.options){if(equipment.has(option.value))option.hidden=option.disabled=!active;}
    if(active){dirty=true;last=0;frame=requestAnimationFrame(loop);}else cancelAnimationFrame(frame);
  }
  modeButton.onclick=switchMode;map.hidden=true;
  const nav={
    'west-view':()=>{pitch=.98;focus('west',-760,340,1120,'Батыс резерві');},
    'post-view':()=>{pitch=.85;focus('posts',910,390,1050,'Тексеру бекеттері');},
    'held-view':()=>{pitch=.98;focus('held',950,1200,1100,$('held-view').textContent);},
    'fleet-view':()=>follow(state.current?.truck_id??[...fleet.keys()].at(-1)),
    'interior-view':()=>object('building'),
    'map-zoom-reset':()=>{pitch=1.02;yaw=.04;focus('overview',20,725,Math.max(3000,4900/camera.aspect),'Жалпы көрініс');},
    'map-zoom-in':()=>{targetRange=Math.max(85,targetRange/1.4);dirty=true;},
    'map-zoom-out':()=>{targetRange=Math.min(5800,targetRange*1.4);dirty=true;}
  };
  toolbar.addEventListener('click',e=>{const fn=nav[e.target.id];if(active&&fn){e.stopImmediatePropagation();fn();}},true);
  toolbar.addEventListener('change',e=>{if(active&&e.target.matches('select')&&e.target.value){e.stopImmediatePropagation();object(e.target.value);e.target.value='';}},true);
  const canvas=renderer.domElement;
  let drag=null;
  canvas.onpointerdown=e=>{drag={id:e.pointerId,x:e.clientX,y:e.clientY,dx:0,dy:0};canvas.setPointerCapture(e.pointerId);};
  canvas.onpointermove=e=>{if(drag?.id!==e.pointerId)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;drag.dx+=Math.abs(dx);drag.dy+=Math.abs(dy);drag.x=e.clientX;drag.y=e.clientY;yaw-=dx*.006;pitch=Math.max(.16,Math.min(1.48,pitch+dy*.006));dirty=true;};
  canvas.onpointercancel=()=>{drag=null;};
  canvas.onpointerup=e=>{
    if(!drag)return;const click=drag.dx+drag.dy<6;drag=null;if(!click)return;
    const rect=canvas.getBoundingClientRect();ray.setFromCamera(new THREE.Vector2(2*(e.clientX-rect.left)/rect.width-1,1-2*(e.clientY-rect.top)/rect.height),camera);
    const hits=ray.intersectObjects([...fleet.values()].filter(f=>f.model.visible).map(f=>f.hit).concat(pickables.filter(p=>typeof p.userData.what==='string')),false);
    if(hits.length){const key=hits[0].object.userData.what;typeof key==='number'?follow(key):object(key);}
  };
  canvas.onwheel=e=>{e.preventDefault();targetRange=Math.max(85,Math.min(5800,targetRange*Math.exp(Math.sign(e.deltaY)*.12)));dirty=true;};
  function resize(){const w=host.clientWidth,h=host.clientHeight;if(!w||!h)return;renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();dirty=true;}
  new ResizeObserver(resize).observe(host);resize();targetRange=range=Math.max(3000,4900/camera.aspect);
  new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;dirty=true;}).observe(host);
  function sync(){
    const play=$('yard-play'),step=$('yard-step');const playLabel=$('play').textContent;
    if(play.textContent!==playLabel)play.textContent=playLabel;
    play.disabled=$('play').disabled;step.disabled=$('step').disabled;
    for(const [id,f] of fleet)if(!vehicleNodes.has(id)){scene.remove(f.model,f.hit);f.hit.material.dispose();pickables.splice(pickables.indexOf(f.hit),1);fleet.delete(id);dirty=true;}
    for(const [id,n] of vehicleNodes){
      let f=fleet.get(id);
      if(!f){const model=fleetModels[id%3].clone();model.scale.setScalar(6.2);scene.add(model);f={model,hit:hit(0,15,0,94,30,25,id)};fleet.set(id,f);dirty=true;}
      const p=n._position;if(!p)continue;
      const shown=!!n._visible&&p.x<1645&&p.x>-1630;
      if(shown!==f.model.visible||p.x!==f.model.position.x||p.y!==f.model.position.z||f.model.rotation.y!==-(n._angle||0))dirty=true;
      f.model.visible=shown;f.model.position.set(p.x,.2,p.y);f.model.rotation.y=-(n._angle||0);
      f.hit.position.set(p.x,15,p.y);f.hit.rotation.y=f.model.rotation.y;
      if(watch===id&&shown){goal.set(p.x,12,p.y);label.textContent=n.title;}
    }
    if(watch!==null&&(!fleet.get(watch)?.model.visible)){if(!vehicleNodes.has(watch)||vehicleNodes.get(watch)?._position?.x>1645){watch=null;label.textContent='Көлік терминалдан шықты';}}
  }
  function loop(now){
    if(!active)return;frame=requestAnimationFrame(loop);if(!visible||document.hidden||now-last<32)return;last=now;
    sync();
    const blocked=$('exit-control').classList.contains('blocked');const gateTarget=blocked?0:-1.48;
    if(Math.abs(gate.rotation.x-gateTarget)>.002){gate.rotation.x+=(gateTarget-gate.rotation.x)*.22;dirty=true;}
    const scanning=$('terminal-scene').classList.contains('scanner-active');
    if(beam.visible!==scanning)dirty=true;beam.visible=scanning;if(scanning){beam.position.set(1250+60*Math.sin(now*.0025),21,340);dirty=true;}
    if(center.distanceToSquared(goal)>.08||Math.abs(range-targetRange)>.15){center.lerp(goal,.16);range+=(targetRange-range)*.16;dirty=true;}
    if(!dirty)return;dirty=false;
    camera.position.set(center.x+Math.sin(yaw)*Math.cos(pitch)*range,center.y+Math.sin(pitch)*range,center.z+Math.cos(yaw)*Math.cos(pitch)*range);camera.lookAt(center);
    renderer.render(scene,camera);
  }
  frame=requestAnimationFrame(loop);
}
