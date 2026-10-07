(function (scope) {
  'use strict';
  // D2Q9 channels match the approved v6 grid. Array rows increase downwards;
  // reported uy and vorticity use physical y pointing upwards.
  const dirs = [[0,0],[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]];
  const opposite = [0,5,6,7,8,1,2,3,4];
  const weights = [4/9,1/9,1/36,1/9,1/36,1/9,1/36,1/9,1/36];

  // NumPy legacy RandomState uses MT19937 and the polar Gaussian transform.
  // Reproducing it keeps seed=42 initial populations reproducible, offline.
  function normalGenerator(seed) {
    const mt = new Uint32Array(624); let index = 624, spare;
    mt[0] = seed >>> 0;
    for (let i=1;i<624;i++) mt[i] = (Math.imul(1812433253,mt[i-1]^(mt[i-1]>>>30))+i)>>>0;
    function uint() {
      if(index>=624) {
        for(let i=0;i<624;i++) {
          const y=(mt[i]&0x80000000)|(mt[(i+1)%624]&0x7fffffff);
          mt[i]=(mt[(i+397)%624]^(y>>>1)^((y&1)?0x9908b0df:0))>>>0;
        }
        index=0;
      }
      let y=mt[index++]; y^=y>>>11; y^=(y<<7)&0x9d2c5680; y^=(y<<15)&0xefc60000; y^=y>>>18;
      return y>>>0;
    }
    function uniform() { return ((uint()>>>5)*67108864+(uint()>>>6))/9007199254740992; }
    return function normal() {
      if(spare!==undefined) { const value=spare; spare=undefined; return value; }
      let x,y,r; do { x=2*uniform()-1; y=2*uniform()-1; r=x*x+y*y; } while(r>=1||r===0);
      const f=Math.sqrt(-2*Math.log(r)/r); spare=x*f; return y*f;
    };
  }

  function make(nx,ny,options={}) {
    if(!Number.isInteger(nx)||!Number.isInteger(ny)||nx<2||ny<2) throw new Error('Grid dimensions must be integers >= 2.');
    const count=nx*ny, size=count*9, tau=options.tau===undefined?.6:Number(options.tau), rho0=options.rho0===undefined?100:Number(options.rho0);
    if(!Number.isFinite(tau)||tau<=.5||!Number.isFinite(rho0)||rho0<=0) throw new Error('Invalid lattice parameters.');
    const solid=new Uint8Array(count);
    if(options.solid) {
      if(options.solid.length!==count) throw new Error('Obstacle mask size does not match grid.');
      for(let k=0;k<count;k++) solid[k]=options.solid[k]?1:0;
    } else {
      for(let y=0;y<ny;y++)for(let x=0;x<nx;x++) solid[y*nx+x]=((x-nx/4)**2+(y-ny/2)**2<(ny/4)**2)?1:0;
    }
    let initial;
    if(options.initial) {
      if(options.initial.length!==size) throw new Error('Population field size does not match grid.');
      initial=new Float64Array(options.initial);
      for(const f of initial) if(!Number.isFinite(f)) throw new Error('Population field must be finite.');
    } else {
      initial=new Float64Array(size); const normal=normalGenerator(options.seed===undefined?42:options.seed);
      for(let y=0;y<ny;y++)for(let x=0;x<nx;x++) {
        const base=(y*nx+x)*9; let rho=0;
        for(let i=0;i<9;i++) initial[base+i]=1+.01*normal();
        initial[base+3]+=2*(1+.2*Math.cos(2*Math.PI*x/nx*4));
        for(let i=0;i<9;i++) rho+=initial[base+i];
        for(let i=0;i<9;i++) initial[base+i]*=rho0/rho;
      }
    }
    let cached=null;
    const engine={nx,ny,tau,rho0,solid,F:initial,n:options.n===undefined?0:options.n,prepare,commit,advance,macros};
    // Precompute push destinations, including periodic edges as np.roll does.
    const destinations=new Int32Array(size);
    for(let y=0;y<ny;y++)for(let x=0;x<nx;x++)for(let i=0;i<9;i++) {
      const xx=(x+dirs[i][0]+nx)%nx,yy=(y+dirs[i][1]+ny)%ny;
      destinations[(y*nx+x)*9+i]=(yy*nx+xx)*9+i;
    }
    function prepare() {
      if(cached) return cached;
      const start=engine.F,streamed=new Float64Array(size),collided=new Float64Array(size),bounced=new Float64Array(size),boundary=new Float64Array(size);
      for(let k=0;k<size;k++) streamed[destinations[k]]=start[k];
      for(let node=0;node<count;node++) {
        const base=node*9;
        // Save the streamed populations BEFORE collision, as in bndryF.
        if(solid[node]) for(let i=0;i<9;i++) boundary[base+i]=streamed[base+opposite[i]];
        let rho=0,mx=0,my=0;
        for(let i=0;i<9;i++) {const f=streamed[base+i];rho+=f;mx+=f*dirs[i][0];my+=f*dirs[i][1];}
        if(!Number.isFinite(rho)||rho<=0) throw new Error('Non-positive or non-finite density at node '+node+'.');
        const ux=mx/rho,uy=my/rho,u2=ux*ux+uy*uy;
        for(let i=0;i<9;i++) {
          const cu=dirs[i][0]*ux+dirs[i][1]*uy;
          const feq=rho*weights[i]*(1+3*cu+4.5*cu*cu-1.5*u2);
          const post=streamed[base+i]+(feq-streamed[base+i])/tau;
          if(!Number.isFinite(post)) throw new Error('Non-finite population at node '+node+'.');
          collided[base+i]=post;
          // Full-way/on-node bounce-back: reverse only here; release during
          // the NEXT streaming step. No second reflected flight is applied.
          bounced[base+i]=solid[node]?boundary[base+i]:post;
        }
      }
      cached={start,streamed,collided,bounced,boundary}; return cached;
    }
    function commit() { engine.F=prepare().bounced; engine.n++; cached=null; return engine.F; }
    function advance(steps=1) {
      if(!Number.isInteger(steps)||steps<0) throw new Error('Step count must be a nonnegative integer.');
      for(let step=0;step<steps;step++) commit(); return engine.F;
    }
    function macros(field=engine.F) {
      if(field.length!==size) throw new Error('Population field size does not match grid.');
      const rho=new Float64Array(count),ux=new Float64Array(count),uy=new Float64Array(count),speed=new Float64Array(count),vorticity=new Float64Array(count);
      for(let node=0;node<count;node++) {
        const base=node*9; let density=0,mx=0,my=0;
        for(let i=0;i<9;i++) {const f=field[base+i];density+=f;mx+=f*dirs[i][0];my-=f*dirs[i][1];}
        rho[node]=density;
        // pmocz zeroes velocities in the cylinder before differentiating.
        if(!solid[node]) {ux[node]=mx/density;uy[node]=my/density;speed[node]=Math.hypot(ux[node],uy[node]);}
      }
      for(let y=0;y<ny;y++)for(let x=0;x<nx;x++) {
        const node=y*nx+x;
        // Physical vorticity omega = d(uy)/dx - d(ux)/dy, with lattice
        // spacing 1. Screen rows increase downward, opposite physical y.
        vorticity[node]=solid[node]?NaN:((uy[y*nx+(x+1)%nx]-uy[y*nx+(x-1+nx)%nx])+(ux[((y+1)%ny)*nx+x]-ux[((y-1+ny)%ny)*nx+x]))/2;
      }
      return {rho,ux,uy,speed,vorticity};
    }
    return engine;
  }
  const api={make,dirs,opposite,weights};
  scope.LBMEngine=api;
  if(typeof module!=='undefined'&&module.exports) module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
