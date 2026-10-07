(()=>{
  'use strict';
  const root=document.getElementById('lbm-minimal-v6');
  const find=s=>root.querySelector(s);
  const seed=JSON.parse(find('#lbm-v6-snapshots').textContent);
  const dirs=[[0,0],[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]];
  const order=[8,1,2,7,0,3,6,5,4],names=['静止','北','东北','东','东南','南','西南','西','西北'];
  const labels=['时间步开始 · Fⁿ','迁移 · 暂存分量释放到相邻流体格点','碰撞 · 同一格点内重新分配','反弹 · 分量暂存于圆形格点'];
  const phaseNames=['时间步开始','迁移','碰撞','反弹'];
  const engine=LBMEngine.make(40,16,{initial:new Float64Array(seed.stages[0]),solid:seed.solid,n:seed.n});
  const flowEngine=LBMEngine.make(240,80,{seed:42});
  flowEngine.advance(engine.n);
  let small=engine.prepare(),large=flowEngine.prepare();
  let stage=0,selectedX=21,selectedY=10,field='vorticity';
  let progress=1,running=false,automatic=false,hold=0,last=performance.now(),speed=1;
  let boardLayout=null,dirty=true,flowDirty=true,raf=0;
  const board=find('.lb-lattice'),flow=find('.lb-flow-canvas');
  const cards=find('[data-populations]'),cardValues=[],cardDeltas=[];
  const fluidCount=engine.solid.reduce((sum,value)=>sum+!value,0);
  const wrap=(v,n)=>(v+n)%n,clamp=v=>Math.max(0,Math.min(1,v));
  const blend=(a,b,p)=>a+(b-a)*p;
  order.forEach(i=>{
    const card=document.createElement('div');card.className='lb-pop'+(i===0?' rest':'');card.dataset.direction=i;
    card.innerHTML='<div class="lb-pop-top"><span class="lb-pop-symbol">f<sub>'+i+'</sub></span><span>'+names[i]+'</span></div><div class="lb-pop-value">—</div><div class="lb-pop-delta">Δ —</div>';
    cards.appendChild(card);cardValues[i]=card.querySelector('.lb-pop-value');cardDeltas[i]=card.querySelector('.lb-pop-delta');
  });
  function stageArrays(s=small){
    const a=[s.start,s.streamed,s.collided,s.bounced];
    return{previous:a[Math.max(0,stage-1)],current:a[stage]};
  }
  // Numerical labels and the flow image use exact phase endpoints. Travelling
  // glyphs/morphs are explanatory animation, not invented fractional LBM steps.
  function exactField(s=small){const a=stageArrays(s);return progress<1?a.previous:a.current;}
  function surface(canvas){
    const box=canvas.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,2);
    const w=Math.max(1,Math.round(box.width*dpr)),h=Math.max(1,Math.round(box.height*dpr));
    if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
    const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);return{ctx,w:box.width,h:box.height};
  }
  function symbol(ctx,px,py,value,cell,color,boost=1){
    const amount=.26+.74*Math.min(1,Math.sqrt(Math.abs(value)/45));
    const size=Math.max(.9,cell*.155)*boost;
    ctx.fillStyle=color||'rgba(50,103,102,'+amount.toFixed(3)+')';ctx.fillRect(px-size/2,py-size/2,size,size);
  }
  function wrappedSymbol(ctx,px,py,value,cell,color,boost=1){
    const {ox,oy}=boardLayout,w=cell*40,h=cell*16;
    px=ox+((px-ox)%w+w)%w;py=oy+((py-oy)%h+h)%h;
    symbol(ctx,px,py,value,cell,color,boost);
  }
  function drawBoard(){
    const {ctx,w,h}=surface(board);ctx.clearRect(0,0,w,h);
    const pad=9,cell=(w-pad*2)/40,ox=pad,oy=Math.max(6,(h-cell*16)/2);boardLayout={cell,ox,oy};
    const {current,previous}=stageArrays();
    ctx.lineWidth=.6;ctx.strokeStyle='#e5e9e5';ctx.beginPath();
    for(let x=0;x<=40;x++){ctx.moveTo(ox+x*cell,oy);ctx.lineTo(ox+x*cell,oy+16*cell);}
    for(let y=0;y<=16;y++){ctx.moveTo(ox,oy+y*cell);ctx.lineTo(ox+40*cell,oy+y*cell);}ctx.stroke();
    ctx.save();ctx.beginPath();ctx.rect(ox,oy,40*cell,16*cell);ctx.clip();
    for(let y=0;y<16;y++)for(let x=0;x<40;x++){
      const n=y*40+x,left=ox+x*cell,top=oy+y*cell,solid=engine.solid[n];
      if(solid){ctx.fillStyle='#d7dcd6';ctx.fillRect(left+1,top+1,cell-2,cell-2);}
      // The selected-cell frame belongs to the initial state only. During
      // migration, collision, and bounce the channel glyphs themselves carry
      // the focus so no rectangular overlay is mistaken for a population.
      if(stage===0&&x===selectedX&&y===selectedY){ctx.fillStyle='#f7edc0';ctx.fillRect(left,top,cell,cell);}
      if(stage===2&&!solid){
        let energy=0;for(let i=0;i<9;i++)energy+=Math.abs(current[n*9+i]-previous[n*9+i]);
        const pulse=Math.sin(progress*Math.PI)**2;
        ctx.fillStyle='rgba(86,123,153,'+(.025+.065*Math.min(1,energy/1.8)*pulse).toFixed(3)+')';ctx.fillRect(left+.7,top+.7,cell-1.4,cell-1.4);
      }
    }
    // Paint every background first so a travelling population cannot be
    // erased by the selected/solid background of its destination node.
    for(let y=0;y<16;y++)for(let x=0;x<40;x++){
      const n=y*40+x,left=ox+x*cell,top=oy+y*cell,solid=engine.solid[n];
      for(let i=0;i<9;i++){
        const before=previous[n*9+i],after=current[n*9+i],dx=dirs[i][0],dy=dirs[i][1];
        let px=left+cell/2+dx*cell*.275,py=top+cell/2+dy*cell*.275;
        if(stage===1&&progress<1){
          // Push the unchanged population in its own direction, retaining its
          // channel offset. Wrapped particles enter at the opposite edge.
          px+=dx*cell*progress;py+=dy*cell*progress;
          const tx=wrap(x+dx,40),ty=wrap(y+dy,16),destination=ty*40+tx;
          // A stored bounce population is released from the solid node only
          // when this next migration reaches a fluid neighbour.
          const release=solid&&!engine.solid[destination];
          wrappedSymbol(ctx,px,py,before,cell,release?'#b86b45':solid?'rgba(61,69,62,.42)':null,release?1.12:1);continue;
        }
        if(stage===3&&solid){
          // Only populations that entered this boundary node from a fluid
          // neighbour participate in bounce-back. Internal solid-to-solid
          // channels remain hidden in the obstacle instead of being presented
          // as extra reflections.
          const sx=wrap(x-dx,40),sy=wrap(y-dy,16),source=sy*40+sx;
          if(engine.solid[source]) continue;
          // The incoming population travels from the fluid-facing side into
          // the solid node and is stored there. It is released to the adjacent
          // fluid node only during the next migration phase.
          px=left+cell/2-dx*cell*.275*(1-progress);
          py=top+cell/2-dy*cell*.275*(1-progress);
          symbol(ctx,px,py,small.streamed[n*9+i],cell,'rgba(61,69,62,.52)');continue;
        }
        const val=blend(before,after,progress),opacity=.26+.74*Math.min(1,Math.sqrt(Math.abs(val)/45));
        const color=solid?'rgba(61,69,62,'+(opacity*(stage===3?1:.32)).toFixed(3)+')':null;
        if(stage===2){
          const oldSize=Math.max(.8,Math.min(cell*.3,cell*(.055+.22*Math.sqrt(Math.abs(before)/45))));
          const size=Math.max(.8,Math.min(cell*.3,cell*(.055+.22*Math.sqrt(Math.abs(val)/45))));
          if(Math.abs(after-before)>.012&&progress<1){ctx.strokeStyle='rgba(189,145,65,'+(.54*(1-progress)).toFixed(3)+')';ctx.lineWidth=.55;ctx.strokeRect(px-oldSize/2,py-oldSize/2,oldSize,oldSize);}
          const selected=x===selectedX&&y===selectedY,drawSize=size*(selected?1.3:1);
          ctx.fillStyle=color||(selected?'rgba(86,123,153,':'rgba(50,103,102,')+opacity.toFixed(3)+')';ctx.fillRect(px-drawSize/2,py-drawSize/2,drawSize,drawSize);
        }else symbol(ctx,px,py,val,cell,color);
      }
    }
    drawSelectedEffect(ctx,cell,ox,oy);
    ctx.restore();
    ctx.strokeStyle=stage===1?'#326766':stage===3?'#b86b45':'#949e95';ctx.lineWidth=(stage===1||stage===3)?1.8:.8;
    ctx.beginPath();ctx.arc(ox+10.5*cell,oy+8.5*cell,4*cell,0,Math.PI*2);ctx.stroke();
    ctx.font='10px Consolas,monospace';ctx.fillStyle='#89928b';ctx.textAlign='left';ctx.fillText('0',ox,oy-9);ctx.textAlign='right';ctx.fillText('x 39',ox+40*cell,oy-9);ctx.fillText('y 15',ox+40*cell,oy+16*cell+18);
  }
  function drawSelectedEffect(ctx,cell,ox,oy){
    const left=ox+selectedX*cell,top=oy+selectedY*cell,cx=left+cell/2,cy=top+cell/2,start=(selectedY*40+selectedX)*9;
    if(stage===0){
      ctx.strokeStyle='#b28a2d';ctx.lineWidth=2.2;ctx.strokeRect(left+1.5,top+1.5,cell-3,cell-3);
      ctx.fillStyle='#b28a2d';const mark=Math.max(3,cell*.14);ctx.fillRect(left+2,top+2,mark,mark);ctx.fillRect(left+cell-2-mark,top+cell-2-mark,mark,mark);return;
    }
    if(stage===1&&progress<1){
      for(let i=1;i<9;i++){
        const dx=dirs[i][0],dy=dirs[i][1],sx=wrap(selectedX-dx,40),sy=wrap(selectedY-dy,16);
        wrappedSymbol(ctx,cx+dx*cell*(.275+progress),cy+dy*cell*(.275+progress),small.start[start+i],cell,'#326766',1.8);
        wrappedSymbol(ctx,cx+dx*cell*(.275-1+progress),cy+dy*cell*(.275-1+progress),small.start[(sy*40+sx)*9+i],cell,'#bd9141',1.8);
      }
    }
  }
  function updateInspector(){
    const f=exactField(),previous=stageArrays().previous,start=(selectedY*40+selectedX)*9;let rho=0,mx=0,my=0;
    for(let i=0;i<9;i++){
      const v=f[start+i],delta=v-previous[start+i];rho+=v;mx+=v*dirs[i][0];my-=v*dirs[i][1];
      cardValues[i].textContent=v.toFixed(3);cardValues[i].title=v.toPrecision(15);
      const d=cardDeltas[i];d.textContent='Δ '+(delta>=0?'+':'−')+Math.abs(delta).toFixed(4);d.className='lb-pop-delta'+(Math.abs(delta)<.00005?'':delta>0?' positive':' negative');
    }
    const solid=!!engine.solid[selectedY*40+selectedX];find('.lb-selection-label').textContent=solid?'障碍格点':'选中格点';
    find('[data-rho]').textContent=solid?'—':rho.toFixed(3);find('[data-ux]').textContent=solid?'—':(mx/rho).toFixed(4);find('[data-uy]').textContent=solid?'—':(my/rho).toFixed(4);
    find('[aria-label="格点 x 坐标"]').value=selectedX;find('[aria-label="格点 y 坐标"]').value=selectedY;
    find('[data-comparison]').textContent=progress<1?'当前：'+phaseNames[stage]+'演示中 · 数值为阶段开始值':[
      '当前：时间步开始','当前：迁移后 · Δ 相对迁移前','当前：碰撞后 · Δ 相对碰撞前','当前：反弹后 · 固体分量已反向暂存'][stage];
  }
  function updateLabels(){
    const n=engine.n+(stage===3&&progress===1?1:0);
    find('[data-time]').textContent='n = '+n;
    find('[data-stage-name]').textContent=labels[stage];
    find('[data-play]').textContent=running?'暂停':'演示';
    root.querySelectorAll('[data-stage]').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.stage)===stage)));
    find('[data-collision-status]').textContent=stage===2?'全场碰撞重算 · '+Math.round(progress*100)+'% · '+fluidCount+' 个流体格点':stage===3?'反弹分量暂存于圆形格点 · 下一迁移释放':'深浅表示数值';
    find('[data-live]').textContent=progress<1?(running?'正在':'已暂停 · ')+phaseNames[stage]+' · '+Math.round(progress*100)+'%':(stage===3?'时间步完成':phaseNames[stage]+'完成')+' · 可选择格点查看九个分量';
    find('.lb-flow-foot>span').textContent='流体场 · n = '+n+' · '+(progress<1?phaseNames[Math.max(0,stage-1)]+'后':phaseNames[stage]+(stage?'后':''));
    root.dataset.timeStep=n;root.dataset.phase=stage;root.dataset.progress=progress.toFixed(4);
    root.dataset.teachingStep=engine.n;root.dataset.flowStep=flowEngine.n;root.dataset.running=running;
    updateInspector();
  }
  const imageCanvas=document.createElement('canvas');imageCanvas.width=240;imageCanvas.height=80;
  const imageCtx=imageCanvas.getContext('2d');
  function drawFlow(){
    const {ctx,w,h}=surface(flow),d=flowEngine.macros(exactField(large)),pixels=imageCtx.createImageData(240,80);
    const values=field==='speed'?d.speed:d.vorticity;
    const neutral=[252,252,250],blue=[58,104,169],red=[196,77,65];
    for(let n=0;n<240*80;n++){
      const raw=values[n]/(field==='speed'?.25:.04),amount=Math.pow(Math.min(1,Math.abs(raw)),.62),color=field==='speed'||raw<0?blue:red;
      for(let c=0;c<3;c++)pixels.data[n*4+c]=flowEngine.solid[n]?[53,62,60][c]:Math.round(neutral[c]+(color[c]-neutral[c])*amount);
      pixels.data[n*4+3]=255;
    }
    imageCtx.putImageData(pixels,0,0);ctx.fillStyle='#fcfcfa';ctx.fillRect(0,0,w,h);
    const scale=Math.min(w/240,h/80),dw=240*scale,dh=80*scale;ctx.imageSmoothingEnabled=true;ctx.drawImage(imageCanvas,(w-dw)/2,(h-dh)/2,dw,dh);
    root.querySelectorAll('[data-field]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.field===field)));
    find('[data-color-min]').textContent=field==='speed'?'0':'−0.04';find('[data-color-max]').textContent=field==='speed'?'0.25':'+0.04';find('[data-field-unit]').textContent=field==='speed'?'|u|':'ω';
    find('.lb-color-strip').style.background=field==='speed'?'linear-gradient(90deg,#fcfcfa,#3c71ba)':'linear-gradient(90deg,#3c71ba,#fcfcfa,#c7564c)';
    flow.setAttribute('aria-label','当前第 '+(engine.n+(stage===3&&progress===1?1:0))+' 步的'+(field==='speed'?'速度':'涡量')+'场');
  }
  function render(){if(dirty){drawBoard();updateLabels();dirty=false;}if(flowDirty){drawFlow();flowDirty=false;}}
  function begin(value){stage=value;progress=value===0?1:0;hold=0;dirty=flowDirty=true;}
  function advance(){
    if(stage===3){engine.commit();flowEngine.commit();small=engine.prepare();large=flowEngine.prepare();begin(0);}
    else begin(stage+1);
  }
  function tick(now){
    const dt=Math.min(100,Math.max(0,now-last));last=now;
    if(running){
      if(progress<1){progress=Math.min(1,progress+dt*speed/900);dirty=true;if(progress===1){flowDirty=true;hold=0;if(!automatic)running=false;}}
      else if(automatic){hold+=dt*speed;if(hold>=(stage===0?300:180))advance();}
      else running=false;
    }
    render();raf=requestAnimationFrame(tick);
  }
  function stop(){running=false;automatic=false;dirty=true;}
  function selectCell(x,y){selectedX=x;selectedY=y;dirty=true;render();}
  board.addEventListener('click',e=>{
    const r=board.getBoundingClientRect(),p=boardLayout;if(!p)return;
    const x=Math.floor((e.clientX-r.left-p.ox)/p.cell),y=Math.floor((e.clientY-r.top-p.oy)/p.cell);
    if(x>=0&&x<40&&y>=0&&y<16)selectCell(x,y);
  });
  for(const dim of ['x','y'])find('[aria-label="格点 '+dim+' 坐标"]').addEventListener('change',()=>selectCell(
    Math.max(0,Math.min(39,Math.floor(Number(find('[aria-label="格点 x 坐标"]').value)||0))),
    Math.max(0,Math.min(15,Math.floor(Number(find('[aria-label="格点 y 坐标"]').value)||0)))));
  root.querySelectorAll('[data-stage]').forEach(b=>b.addEventListener('click',()=>{stop();begin(Number(b.dataset.stage));running=stage!==0;last=performance.now();render();}));
  find('[data-next]').addEventListener('click',()=>{stop();advance();running=stage!==0;last=performance.now();render();});
  find('[data-play]').addEventListener('click',()=>{
    if(running){stop();}else{running=true;automatic=true;last=performance.now();dirty=true;}
    render();
  });
  find('[aria-label="演示速度"]').addEventListener('input',e=>{speed=Number(e.target.value);find('[data-speed]').textContent=speed.toFixed(1)+'×';});
  root.querySelectorAll('[data-field]').forEach(b=>b.addEventListener('click',()=>{field=b.dataset.field;flowDirty=true;render();}));
  const observer=new ResizeObserver(()=>{dirty=flowDirty=true;render();});observer.observe(board);observer.observe(flow);
  document.addEventListener('visibilitychange',()=>{last=performance.now();});
  // Original v6 keeps distinct teaching and flow resolutions. Both now have
  // the same phase/time counter, instead of an unrelated n=1600 flow image.
  find('.lb-parameters').title='教学网格与流场网格分别求解，使用同一时间步与相同的迁移、碰撞、全程反弹顺序。';
  render();raf=requestAnimationFrame(tick);
})();
