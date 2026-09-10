'use strict';

// A circuit skeleton: a rounded closed polygon resampled into N route samples by
// arc length. PURE: no engine globals, so test/skeleton-test.js can load this file
// on its own in node. Closure is free: a polygon closes by construction.
//
// corners: [x, z, radius, height, flags]; x/z/radius in kilo-units, height in
// hundreds. Edge k leaves corner k. Wave/chicane/tunnel/cross flags describe edge k;
// banked describes corner k's arc.
const SK_WAVE=1, SK_CHICANE=2, SK_TUNNEL=4, SK_CROSS=8, SK_BANKED=16;

function buildSkeleton(corners, N)
{
    const n=corners.length, TAU=2*Math.PI;
    const C=corners.map(c=>({x:c[0]*1e3, z:c[1]*1e3, r:c[2]*1e3, h:(c[3]||0)*100, f:c[4]||0}));
    const at=k=>C[(k%n+n)%n];
    // The start straight (edge 0) always runs toward +z, the engine's initial forward.
    const phi=Math.atan2(C[1].x-C[0].x, C[1].z-C[0].z);
    for(const c of C)
    {
        const x=c.x*Math.cos(phi)-c.z*Math.sin(phi), z=c.x*Math.sin(phi)+c.z*Math.cos(phi);
        c.x=x; c.z=z;
    }
    for(let k=0;k<n;++k)
    {
        const p=at(k-1), c=at(k), q=at(k+1);
        const ax=p.x-c.x, az=p.z-c.z, bx=q.x-c.x, bz=q.z-c.z, la=Math.hypot(ax,az), lb=Math.hypot(bx,bz);
        c.theta=Math.acos(Math.max(-1,Math.min(1,(ax*bx+az*bz)/la/lb))); // interior angle
        c.ax=ax/la; c.az=az/la; c.bx=bx/lb; c.bz=bz/lb;
    }
    const tangent=c=>c.r/Math.tan(c.theta/2); // corner to fillet tangent point
    // Two fillets sharing an edge must fit on it: shrink both radii together.
    for(let pass=0;pass<4;++pass) for(let k=0;k<n;++k)
    {
        const a=at(k), b=at(k+1), L=Math.hypot(b.x-a.x,b.z-a.z), t=tangent(a)+tangent(b);
        if(t>L) a.r*=L/t*.99, b.r*=L/t*.99;
    }
    // Dense polyline (25 units apart: coarser chords jitter the resampled heading, and a
    // 4,480-unit half-width turns .005 rad of jitter into 22 units of edge error): arc k,
    // then edge k's straight.
    const P=[], arcEnd=[];
    const push=(x,z,f)=>P.push({x,z,f});
    for(let k=0;k<n;++k)
    {
        const c=at(k), q=at(k+1), t=tangent(c);
        const T1x=c.x+c.ax*t, T1z=c.z+c.az*t, T2x=c.x+c.bx*t, T2z=c.z+c.bz*t;
        let mx=c.ax+c.bx, mz=c.az+c.bz; const ml=Math.hypot(mx,mz)||1; mx/=ml; mz/=ml;
        const d=c.r/Math.sin(c.theta/2), ox=c.x+mx*d, oz=c.z+mz*d; // arc centre on the bisector
        const a1=Math.atan2(T1x-ox,T1z-oz), a2=Math.atan2(T2x-ox,T2z-oz);
        let sweep=a2-a1; sweep-=Math.round(sweep/TAU)*TAU;
        const m=Math.max(2,Math.ceil(c.r*Math.abs(sweep)/25));
        for(let j=0;j<=m;++j)
        {
            const a=a1+sweep*j/m;
            push(ox+Math.sin(a)*c.r, oz+Math.cos(a)*c.r, c.f&SK_BANKED);
        }
        arcEnd.push(P.length-1);
        const tq=tangent(q), Sx=q.x+q.ax*tq, Sz=q.z+q.az*tq;
        const dx=Sx-T2x, dz=Sz-T2z, L=Math.hypot(dx,dz), steps=Math.ceil(L/25);
        // Lateral sine on flagged straights: [periods, amplitude, start, span] of the
        // edge. The (1-cos) envelope keeps position AND heading continuous at both ends.
        // A chicane is one period squeezed into the middle 40%, so it actually bites.
        // Amplitude grows with the straight squared (curvature ~ A/L^2), so a wave on a
        // short straight stays near a 25,000 radius and a chicane near 13,000.
        const wave=c.f&SK_WAVE?[2,Math.min(2500,L*L/5e6),0,1]:c.f&SK_CHICANE?[1,Math.min(3500,(L*.4)**2/6.5e5),.3,.4]:0;
        for(let j=1;j<steps;++j)
        {
            const u=j/steps;
            let off=0;
            if(wave)
            {
                const v=Math.min(1,Math.max(0,(u-wave[2])/wave[3]));
                off=wave[1]*Math.sin(TAU*wave[0]*v)*(1-Math.cos(TAU*v))/2;
            }
            push(T2x+dx*u+dz/L*off, T2z+dz*u-dx/L*off, c.f&(SK_WAVE|SK_CHICANE|SK_TUNNEL|SK_CROSS));
        }
    }
    const M=P.length, cum=new Float64Array(M+1);
    for(let i=0;i<M;++i){ const a=P[i], b=P[(i+1)%M]; cum[i+1]=cum[i]+Math.hypot(b.x-a.x,b.z-a.z); }
    const L=cum[M], step=L/N;
    // s=0 sits 8,000 units past corner 0's arc, so the grid (negative s) is on the straight.
    const sStart=cum[arcEnd[0]]+8000, sMid=arcEnd.map(i=>cum[i]);
    const out={x:new Float64Array(N),z:new Float64Array(N),heading:new Float64Array(N),turn:new Float64Array(N),
        height:new Float64Array(N),flags:new Int32Array(N),length:L};
    for(let i=0,j=0;i<N;++i)
    {
        const s=(sStart+i*step)%L;
        if(cum[j]>s) j=0;
        while(cum[j+1]<s) ++j;
        const a=P[j], b=P[(j+1)%M], u=(s-cum[j])/(cum[j+1]-cum[j]||1);
        out.x[i]=a.x+(b.x-a.x)*u; out.z[i]=a.z+(b.z-a.z)*u; out.flags[i]=a.f;
        // Heights are cosine keyframes at the arc ends, wrapping at n-1 -> 0.
        let k=0; while(k<n-1 && sMid[k+1]<=s) ++k;
        if(s<sMid[0]) k=n-1;
        const c0=at(k), c1=at(k+1), s0=sMid[k], s1=k==n-1?sMid[0]+L:sMid[k+1], ss=k==n-1&&s<sMid[0]?s+L:s;
        const w=(1-Math.cos(Math.PI*(ss-s0)/(s1-s0)))/2;
        out.height[i]=c0.h+(c1.h-c0.h)*w;
    }
    for(let i=0;i<N;++i)
    {
        const a=(i+N-1)%N, b=(i+1)%N;
        out.heading[i]=Math.atan2(out.x[b]-out.x[a], out.z[b]-out.z[a]);
    }
    // turn: heading change per world unit, scaled so 1 = a 25,000-unit radius, then a
    // small box blur so the AI and bank never see a per-sample kink
    const raw=new Float64Array(N);
    for(let i=0;i<N;++i)
    {
        let d=out.heading[(i+1)%N]-out.heading[(i+N-1)%N]; d-=Math.round(d/TAU)*TAU;
        raw[i]=d/2/step*25000;
    }
    for(let i=0;i<N;++i){ let sum=0; for(let k=-4;k<=4;++k) sum+=raw[(i+k+N)%N]; out.turn[i]=sum/9; }
    return out;
}
