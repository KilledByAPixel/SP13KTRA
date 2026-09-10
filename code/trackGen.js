'use strict';

// closed-loop circuit generation
// - the track is a loop of lapTrackSegments; all lookups wrap via wrapSegment
// - trackHeadingCum[i] = unwrapped heading at sample i (the generator fingerprint the tests hash)

let trackHeadingCum;   // unwrapped heading per sample: the generator fingerprint the tests hash
let trackRacingLine;   // per-segment ideal x offset for the AI racers
let trackMapPts, trackMapCenter, trackMapRadius; // the loop in TRUE world space: [x,z] every 8 segments, its bounding box centre and half extent
let lapWorldLength, routeScale=1.25; // real lap length, and world units per route unit

// a throwaway star polygon for the dev reroll (R on the title, 6 in dev mode)
function randomCorners(count)
{
    const corners=[];
    for(let k=0;k<count;++k)
    {
        const a=2*PI*k/count+random.float(-.2,.2), d=random.float(70,110);
        corners.push([Math.sin(a)*d, Math.cos(a)*d, random.float(12,40), random.float(0,2500), random.float()<.3?SK_WAVE:0]);
    }
    return corners;
}

// Build one closed circuit
function buildTrack()
{
    if(worldKey===trackSeed+':'+currentCircuit) return;
    disposeWorld();
    const N = lapTrackSegments;
    track = [];

    // Authored skeletons ship; a rerolled seed gets a random polygon for generator tests.
    random.setSeed(trackSeed+currentCircuit*137);
    const corners=debug && trackSeed!=1331?randomCorners(random.int(6,10)):circuitCorners[currentCircuit];
    const sk=buildSkeleton(corners,N);
    lapWorldLength=sk.length; routeScale=sk.length/lapDistance;
    debug && LOG('lap',sk.length|0,'units, spacing',(sk.length/N).toFixed(1));
    trackHeadingCum=new Float64Array(N+1);
    for(let i=0;i<N;++i) trackHeadingCum[i+1]=trackHeadingCum[i]+clampAngle(sk.heading[(i+1)%N]-sk.heading[i]);

    // --- heights: keyframes plus a gentle swell of whole-number frequencies (seamless) ---
    random.setSeed(trackSeed+currentCircuit*31);
    const waves = [];
    for(let k=0; k<2; ++k)
        waves.push([random.int(3,8), levelInfo.bump/(k+1), random.float(2*PI)]);

    // --- create segments ---
    const width = laneWidth*1.6*levelInfo.laneCount; // wide, wipeout style
    for(let i=0; i<N; ++i)
    {
        let height = sk.height[i];
        for(const [f, a, ph] of waves)
            height += a*Math.sin(2*PI*f*i/N + ph);
        const t = track[i] = new TrackSegment(i, vec3(sk.x[i], height, sk.z[i]), width);
        t.turn = sk.turn[i]; t.flags = sk.flags[i];
        // bank into the corner from curvature, or as the corner's flag says
        t.roll = t.flags&SK_BANKED ? clamp(t.turn*9,-.5,.5) : clamp(levelInfo.bankAmp*t.turn,-.5,.5);
    }
    // bank never changes suddenly: two box blurs over 121 samples (GDD: no sudden bank)
    for(let pass=0; pass<2; ++pass)
    {
        const r = track.map(t=>t.roll);
        for(let i=0; i<N; ++i)
        {
            let sum = 0;
            for(let k=-60; k<=60; ++k) sum += r[wrapSegment(i+k)];
            track[i].roll = sum/121;
        }
    }

    // --- racing line: drift toward the inside of upcoming corners ---
    trackRacingLine = new Float64Array(N);
    let lineX = 0;
    for(let i=0; i<2*N; ++i) // second pass makes the wrap seam converge
    {
        const j = wrapSegment(i);
        let ahead = 0;
        for(let k=0; k<80; k+=8)
            ahead += track[wrapSegment(j+k)].turn;
        const margin = track[j].width*bermStart-450; // inside the flat part of the ribbon, not a wall-era width
        lineX = lerp(.03, lineX, clamp(300*ahead, -margin, margin));
        trackRacingLine[j] = lineX;
    }

    // Recharge is a safe outside line after the grid. Pad pairs weave exactly
    // one lane across each acceleration straight, with a 15,000-world-unit gap.
    for(let i=60;i<260;++i) track[i].roadType=2;
    for(let i=300;i<N-300;++i)
    {
        if(abs(track[i].turn)>.1 || abs(track[wrapSegment(i+150)].turn)>.1) continue;
        const lanes=levelInfo.laneCount;
        let lane=random.int(0,lanes);
        for(let g=0;g<2;++g)
        {
            for(let k=0;k<6;++k)
                track[i+k].roadType=1,track[i+k].padX=(lane-(lanes-1)/2)*laneWidth;
            i+=120;
            lane+=lane==0?1:lane==lanes-1?-1:random.sign();
        }
        i+=random.int(150,300)*levelInfo.padWait|0;
    }

    // --- corner warnings: every 24 samples (the single road panels), where a corner
    // tighter than about a 31,000 radius is coming within 150 samples ---
    for(let i=72; i<N; i+=24)
    {
        let leftTurns = 0, rightTurns = 0;
        for(let k=0; k<150; k+=20)
        {
            const x = track[wrapSegment(i+k)].turn;
            if (x > 0) leftTurns  = max(leftTurns, x);
            else       rightTurns = max(rightTurns, -x);
        }
        if (rightTurns > .8 || leftTurns > .8)
            track[i].chev = sign(rightTurns - leftTurns);
    }

    // the skyline field draws from random LAST: nothing placed above moves
    buildCourseWorld();
}
