'use strict';
// State/endpoint integration check. Canvas is a no-op surface; visual QA still
// uses the real local page. The solver and UI are the production source files.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const Engine=require('./engine.js');
const fragment=fs.readFileSync(path.join(__dirname,'original-fragment.html'),'utf8');
const seedText=fragment.match(/<script[^>]*id="lbm-v6-snapshots"[^>]*>([\s\S]*?)<\/script>/)[1];
const seed=JSON.parse(seedText);
const noop=()=>{};
const canvasContext=new Proxy({createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)})},{get:(o,k)=>k in o?o[k]:noop});
class Element {
  constructor(name='') {this.name=name;this.dataset={};this.style={};this.attrs={};this.events={};this.children=[];this.nodes=new Map();this.value='';this.textContent='';}
  setAttribute(k,v) {this.attrs[k]=String(v);}
  getAttribute(k) {return this.attrs[k];}
  addEventListener(k,fn) {this.events[k]=fn;}
  fire(k,extra={}) {assert.ok(this.events[k],`${this.name} has ${k} handler`);this.events[k]({target:this,...extra});}
  appendChild(v) {this.children.push(v);}
  querySelector(s) {if(!this.nodes.has(s))this.nodes.set(s,new Element(s));return this.nodes.get(s);}
  getContext() {return canvasContext;}
  getBoundingClientRect() {return {width:this.name==='.lb-lattice'?880:1240,height:this.name==='.lb-lattice'?352:414,left:0,top:0};}
}
const root=new Element('root'),stages=[0,1,2,3].map(i=>{const e=new Element(`stage${i}`);e.dataset.stage=String(i);return e;});
const fields=['vorticity','speed'].map(f=>{const e=new Element(f);e.dataset.field=f;return e;});
root.querySelectorAll=s=>s==='[data-stage]'?stages:s==='[data-field]'?fields:[];
const el=s=>root.querySelector(s);
el('#lbm-v6-snapshots').textContent=seedText;
el('[aria-label="演示速度"]').value='1';
const document={getElementById:id=>{assert.equal(id,'lbm-minimal-v6');return root;},createElement:name=>new Element(name),addEventListener:noop};
const engines=[],flowDraws=[];
let now=0,pendingFrame;
const context={document,performance:{now:()=>now},devicePixelRatio:1,ResizeObserver:class{observe(){}},requestAnimationFrame:fn=>{pendingFrame=fn;return 1;},Float64Array,Uint8Array,Uint32Array,Int32Array,Uint8ClampedArray,Math,JSON,Number,String,console,
  LBMEngine:{make:(...args)=>{
    const engine=Engine.make(...args),macros=engine.macros;
    engine.macros=field=>{
      const phase=Number(root.dataset.phase),inFlight=el('[data-comparison]').textContent.includes('演示中');
      const expectedPhase=inFlight?Math.max(0,phase-1):phase;
      flowDraws.push({n:engine.n,field,phase,progress:Number(root.dataset.progress),teachingStep:Number(root.dataset.teachingStep),expectedField:engine.prepare()[['start','streamed','collided','bounced'][expectedPhase]]});
      return macros(field);
    };
    engines.push(engine);return engine;
  }}
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'ui.js'),'utf8'),context,{filename:'ui.js'});
const teaching=engines[0],flow=engines[1];
function frames(count,ms=1000/60) {for(let i=0;i<count;i++){now+=ms;const fn=pendingFrame;assert.ok(fn);pendingFrame=null;fn(now);}}
function runUntil(predicate,limit=1000) {for(let i=0;!predicate()&&i<limit;i++)frames(1);assert.ok(predicate(),'condition reached before frame limit');}
function populations() {return el('[data-populations]').children;}
function assertEndpoint(which,x=Number(el('[aria-label="格点 x 坐标"]').value),y=Number(el('[aria-label="格点 y 坐标"]').value)) {
  const snapshot=teaching.prepare()[which],offset=(y*40+x)*9;
  for(const card of populations())assert.equal(card.querySelector('.lb-pop-value').textContent,snapshot[offset+Number(card.dataset.direction)].toFixed(3));
  const draw=flowDraws.at(-1);
  assert.equal(draw.n,teaching.n,'flow and teaching integer step match');
  assert.equal(draw.field,flow.prepare()[which],'flow receives same exact phase field');
}
assert.equal(teaching.n,seed.n);assert.equal(flow.n,seed.n);
assert.equal(populations().length,9);assertEndpoint('start');
el('[data-next]').fire('click');
assert.equal(Number(root.dataset.phase),1);assert.equal(Number(root.dataset.progress),0);assertEndpoint('start');
frames(27);
assert.ok(Number(root.dataset.progress)>.45&&Number(root.dataset.progress)<.55);assertEndpoint('start');
el('[data-play]').fire('click');
const pausedProgress=root.dataset.progress,pausedValues=populations().map(c=>c.querySelector('.lb-pop-value').textContent);
frames(60);
assert.equal(root.dataset.progress,pausedProgress,'pause freezes in-flight position');
assert.deepEqual(populations().map(c=>c.querySelector('.lb-pop-value').textContent),pausedValues);
el('[data-play]').fire('click');
runUntil(()=>flowDraws.at(-1).field===flow.prepare().streamed);
assert.equal(Number(root.dataset.phase),1);assertEndpoint('streamed');
el('[data-play]').fire('click');
for(const [phase,key] of [[2,'collided'],[3,'bounced']]) {
  stages[phase].fire('click');runUntil(()=>String(root.dataset.running)==='false');assertEndpoint(key);
  assert.equal(String(root.dataset.running),'false');
}
assert.equal(Number(root.dataset.timeStep),seed.n+1);
// Solid-cell inspector must use the actual stored reversed populations.
el('[aria-label="格点 x 坐标"]').value='8';el('[aria-label="格点 y 坐标"]').value='5';
el('[aria-label="格点 x 坐标"]').fire('change');assertEndpoint('bounced',8,5);
assert.equal(el('[data-rho]').textContent,'—');
el('[data-next]').fire('click');assert.equal(teaching.n,seed.n+1);assert.equal(flow.n,teaching.n);assertEndpoint('start',8,5);
// Continuous playback genuinely commits repeated numerical steps at 100×.
el('[aria-label="演示速度"]').value='100';el('[aria-label="演示速度"]').fire('input');
assert.equal(el('[data-speed]').textContent,'100.0×');
const initialValue=teaching.F[(5*40+8)*9+3],initialTime=now,target=teaching.n+5;
el('[data-play]').fire('click');runUntil(()=>teaching.n>=target);
assert.equal(flow.n,teaching.n);assert.ok(now-initialTime<3000,'10× advances five cycles in under three seconds');
assert.notEqual(teaching.F[(5*40+8)*9+3],initialValue,'future cycles change populations');
el('[data-play]').fire('click');const frozenStep=teaching.n;frames(60);assert.equal(teaching.n,frozenStep);
fields[1].fire('click');assert.equal(el('[data-field-unit]').textContent,'|u|');assert.equal(el('[data-color-max]').textContent,'0.25');
fields[0].fire('click');assert.equal(el('[data-field-unit]').textContent,'ω');
for(const draw of flowDraws){
  assert.ok(draw.field.every(Number.isFinite),'rendered population fields remain finite');
  assert.equal(draw.n,draw.teachingStep,'every flow redraw matches teaching time');
  assert.equal(draw.field,draw.expectedField,'every flow redraw matches displayed numerical phase');
}
console.log(`UI state checks passed: 9 exact channels; streaming/collision/bounce endpoints; pause/resume; ${teaching.n-seed.n} committed steps; 100× progression; ${flowDraws.length} synchronized flow draws.`);
