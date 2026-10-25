// Object Distortion v49-PRO (EN)
// v49 – three fixes:
//  1) BUGFIX "Apply" without a preview did nothing: the Apply branch never called
//     doApplyAll() - without a preview the document stayed unchanged; after a preview
//     with values changed afterwards, the old values applied. Apply now recalculates
//     if there is no preview or the settings changed since the preview (same seed
//     other than 0 -> identical result; with seed 0 an unchanged preview stays as shown).
//  2) BUGFIX position 0: "doc.history.position = posBeforeAll" threw COMMAND_FAILED
//     when nothing had to be converted (freshly opened document) - preview and Cancel
//     aborted. Now rollbackTo() with an undo-loop fallback.
//  3) Presets saved with File.create() instead of the deprecated new File().
//     Prefix "OVZ_" is identical to the German version (presets exchangeable).
// v48: getTF(node) accumulates the full parent chain (transformed groups).
'use strict';
const { Document }                = require('/document');
const { Dialog, DialogResult }    = require('/dialog');
const { PolyCurve, CurveBuilder } = require('/geometry');
const { DocumentCommand }         = require('/commands');
const { Selection }               = require('/selections.js');
const { app }                     = require('/application');
const { File, FileSystemApi }     = require('/fs');

const doc = Document.current;
const PRESETS_DIR   = app.userDesktopPath + '/AffinityScriptPresets';
const PRESET_PREFIX = 'OVZ_';

// v49: safe rollback - "doc.history.position = 0" throws COMMAND_FAILED.
function rollbackTo(pos){
    if(doc.history.position===pos)return;
    try{doc.history.position=pos;}catch(e){/* position 0: undo loop below */}
    let guard=0;
    while(doc.history.position>pos&&guard++<100000)doc.history.undo();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getTF(node){
    const chain=[];
    let cur=node;
    while(cur){
        const tag=cur[Symbol.toStringTag]||'';
        if(tag==='SpreadNode'||tag==='DocumentNode')break;
        const d=cur.transform.data;
        chain.push([d[0],d[1],d[2],d[3],d[4],d[5]]);
        cur=cur.parent;
    }
    let M=[1,0,0, 0,1,0];
    for(let i=0;i<chain.length;i++){
        const C=chain[i];
        M=[
            M[0]*C[0]+M[1]*C[3],  M[0]*C[1]+M[1]*C[4],  M[0]*C[2]+M[1]*C[5]+M[2],
            M[3]*C[0]+M[4]*C[3],  M[3]*C[1]+M[4]*C[4],  M[3]*C[2]+M[4]*C[5]+M[5],
        ];
    }
    return M;
}

function applyM(M,x,y){return{x:M[0]*x+M[1]*y+M[2],y:M[3]*x+M[4]*y+M[5]};}
function invertM(M){const d=M[0]*M[4]-M[1]*M[3];if(Math.abs(d)<1e-12)return[1,0,0,0,1,0];return[M[4]/d,-M[1]/d,(M[1]*M[5]-M[4]*M[2])/d,-M[3]/d,M[0]/d,(M[3]*M[2]-M[0]*M[5])/d];}
function applyMi(Mi,x,y){return{x:Mi[0]*x+Mi[1]*y+Mi[2],y:Mi[3]*x+Mi[4]*y+Mi[5]};}
function mulM(A,B){return[A[0]*B[0]+A[1]*B[3],A[0]*B[1]+A[1]*B[4],A[0]*B[2]+A[1]*B[5]+A[2],A[3]*B[0]+A[4]*B[3],A[3]*B[1]+A[4]*B[4],A[3]*B[2]+A[4]*B[5]+A[5]];}
function clamp(v,lo,hi){return v<lo?lo:v>hi?hi:v;}

function setAbsoluteTransform(node,N){
    const M=getTF(node),Mi=invertM(M),xf=mulM(N,Mi);
    const tf=node.transform.clone();tf.setIdentity();tf.scale(xf[0],xf[4]);tf.translate(xf[2]/xf[0],xf[5]/xf[4]);
    doc.executeCommand(DocumentCommand.createTransform(doc.selection,tf));
}

function collectNodes(sel){
    const curves=[],bitmaps=[];
    const seen=[];
    function isSeen(n){return seen.some(s=>s.isSameNode(n));}
    function addCurve(n){if(isSeen(n))return;seen.push(n);curves.push(n);}
    function visitForCurves(n,depth){
        if(!n||depth>8)return;
        if(n.rasterInterface&&n.rasterWidth>0&&!n.curvesInterface)return;
        if(n.curvesInterface){addCurve(n);return;}
        try{for(const ch of n.children)visitForCurves(ch,depth+1);}catch(e){}
    }
    for(let i=0;i<sel.length;i++){
        const n=sel.at(i).node;if(!n)continue;
        if(n.rasterInterface&&n.rasterWidth>0&&!n.curvesInterface){
            if(!isSeen(n)){seen.push(n);bitmaps.push(n);}continue;
        }
        visitForCurves(n,0);
    }
    return{curves,bitmaps};
}

function collectMutableFromSelection(){
    const result=[];
    function visit(n,depth){
        if(!n||depth>8)return;
        if(n.curvesInterface&&n.curvesInterface.isMutable){
            if(!result.some(r=>r.isSameNode(n)))result.push(n);
            return;
        }
        try{for(const ch of n.children)visit(ch,depth+1);}catch(e){}
    }
    const sel=doc.selection;
    for(let i=0;i<sel.length;i++){
        const n=sel.at(i).node;if(!n)continue;
        visit(n,0);
    }
    return result;
}

function getFocalPoint(node){
    try{
        const fp=node.transformInterface.focalPoint;
        if(!fp.isValid)return null;
        const M=getTF(node);
        return{x:M[0]*fp.point.x+M[1]*fp.point.y+M[2],y:M[3]*fp.point.x+M[4]*fp.point.y+M[5]};
    }catch(e){return null;}
}
function restoreSelection(origNodes){try{if(origNodes.length>0){const s=Selection.create(doc,origNodes);doc.executeCommand(DocumentCommand.createSetSelection(s));}}catch(e){}}

// ── PRNG & jitter ─────────────────────────────────────────────────────────────
function mulberry32(seed){let s=seed>>>0;return function(){s+=0x6D2B79F5;let t=Math.imul(s^s>>>15,1|s);t^=t+Math.imul(t^t>>>7,61|t);return((t^t>>>14)>>>0)/4294967296;};}
function makePRNG(seed){if(seed===0)return()=>Math.random();return mulberry32(seed);}
function jitter(rng){return rng()*2-1;}

// ── Strength curve ────────────────────────────────────────────────────────────
function strengthCurve(t,mode,steps){
    t=clamp(t,0,1);
    if(mode===1)return t*t*(3-2*t);
    if(mode===2){const n=Math.max(2,Math.min(10,Math.round(steps)));return Math.floor(t*n)/n;}
    return t;
}
function applyFalloff(rawPts,distPts,bb,scMode,scSteps){
    if(scMode===0)return distPts;
    return distPts.map((dp,i)=>{
        const o=rawPts[i],dx=(o.wx-bb.cx)/(bb.w/2||1),dy=(o.wy-bb.cy)/(bb.h/2||1);
        const f=strengthCurve(clamp(Math.sqrt(dx*dx+dy*dy),0,1),scMode,scSteps);
        return{...dp,wx:o.wx+(dp.wx-o.wx)*f,wy:o.wy+(dp.wy-o.wy)*f};
    });
}

// ── Preset system ─────────────────────────────────────────────────────────────
function sanitizeName(name){return String(name||'').trim().replace(/[^a-zA-Z0-9 _\-äöüÄÖÜß]/g,'_').slice(0,60);}
function presetPath(name){return PRESETS_DIR+'/'+PRESET_PREFIX+sanitizeName(name)+'.json';}
function savePreset(name,data){
    try{FileSystemApi.createDirectories(PRESETS_DIR);const f=File.create(presetPath(name),'w');f.writeStringAsUtf8(JSON.stringify(data,null,2));f.close();return true;}
    catch(e){return false;}
}
function loadPreset(path){try{return JSON.parse(File.readAll(path).toString('utf8'));}catch(e){return null;}}
function deletePreset(path){try{FileSystemApi.remove(path);return true;}catch(e){return false;}}

// ── Geometry ──────────────────────────────────────────────────────────────────
function bzPt(b,t){const mt=1-t;return{x:mt**3*b.start.x+3*mt*mt*t*b.c1.x+3*mt*t*t*b.c2.x+t**3*b.end.x,y:mt**3*b.start.y+3*mt*mt*t*b.c1.y+3*mt*t*t*b.c2.y+t**3*b.end.y};}
function splitAt05(b){const p0=b.start,p1=b.c1,p2=b.c2,p3=b.end,q0={x:(p0.x+p1.x)/2,y:(p0.y+p1.y)/2},q1={x:(p1.x+p2.x)/2,y:(p1.y+p2.y)/2},q2={x:(p2.x+p3.x)/2,y:(p2.y+p3.y)/2},r0={x:(q0.x+q1.x)/2,y:(q0.y+q1.y)/2},r1={x:(q1.x+q2.x)/2,y:(q1.y+q2.y)/2},mid={x:(r0.x+r1.x)/2,y:(r0.y+r1.y)/2};return{A:{start:p0,c1:q0,c2:r0,end:mid},B:{start:mid,c1:r1,c2:q2,end:p3}};}
function buildArcTable(bzs){const tbl=[{arc:0,p:bzs[0].start}];let arc=0;for(const b of bzs){for(let k=1;k<=20;k++){const t=k/20,prev=tbl[tbl.length-1].p,pt=bzPt(b,t);arc+=Math.sqrt((pt.x-prev.x)**2+(pt.y-prev.y)**2);tbl.push({arc,p:pt});}}return tbl;}
function sampleArc(tbl,s){let lo=0,hi=tbl.length-1;while(lo<hi-1){const mid=(lo+hi)>>1;if(tbl[mid].arc<=s)lo=mid;else hi=mid;}const a=tbl[lo],b=tbl[hi],f=(b.arc-a.arc)<1e-9?0:(s-a.arc)/(b.arc-a.arc);return{x:a.p.x+(b.p.x-a.p.x)*f,y:a.p.y+(b.p.y-a.p.y)*f};}
function numPts(total){return Math.max(60,Math.min(400,Math.round(total/2)));}
function resample(bzs,M,N,closed){
    const tbl=buildArcTable(bzs),total=tbl[tbl.length-1].arc,pts=[];
    for(let i=0;i<N;i++){
        const s=closed?(i/N)*total:(i/(N-1))*total,p=sampleArc(tbl,s);
        const sN=closed?((i+1)/N)*total:Math.min(((i+1)/(N-1))*total,total),pN=sampleArc(tbl,sN);
        const tx=pN.x-p.x,ty=pN.y-p.y,tl=Math.sqrt(tx*tx+ty*ty)||1,w=applyM(M,p.x,p.y);
        pts.push({wx:w.x,wy:w.y,nx:-ty/tl,ny:tx/tl});
    }
    return pts;
}
function wBBox(pts){let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;for(const p of pts){if(p.wx<x0)x0=p.wx;if(p.wy<y0)y0=p.wy;if(p.wx>x1)x1=p.wx;if(p.wy>y1)y1=p.wy;}return{minX:x0,minY:y0,cx:(x0+x1)/2,cy:(y0+y1)/2,w:x1-x0,h:y1-y0};}
function maxRfn(pc,M,cx,cy){let r=0;for(let i=0;i<pc.curveCount;i++)for(const b of pc.at(i).beziers){const w=applyM(M,b.start.x,b.start.y);r=Math.max(r,Math.sqrt((w.x-cx)**2+(w.y-cy)**2));}return r||1;}
function toAbs(pct,hd,fac,aN){const v=aN?Math.max(-100,Math.min(100,pct)):Math.max(1,Math.min(100,pct));return(v/100)*hd*fac;}
function buildBezierFromPts(pts,closed,Mi){
    const N=pts.length;if(N<2)return null;
    const cb=CurveBuilder.create(),t=1/3;
    cb.begin(applyMi(Mi,pts[0].wx,pts[0].wy));
    const end=closed?N:N-1;
    for(let i=0;i<end;i++){
        const i0=closed?(i-1+N)%N:Math.max(0,i-1),i2=closed?(i+1)%N:Math.min(N-1,i+1),i3=closed?(i+2)%N:Math.min(N-1,i+2);
        const prev=pts[i0],curr=pts[i],next=pts[i2],nn=pts[i3];
        const c2={x:curr.wx+(next.wx-prev.wx)*t,y:curr.wy+(next.wy-prev.wy)*t};
        const c1={x:next.wx-(nn.wx-curr.wx)*t,y:next.wy-(nn.wy-curr.wy)*t};
        cb.addBezier(applyMi(Mi,c2.x,c2.y),applyMi(Mi,c1.x,c1.y),applyMi(Mi,next.wx,next.wy));
    }
    if(closed)cb.close();return cb.createCurve();
}

// ── Distortion methods ────────────────────────────────────────────────────────
function doTwirl(pts,cx,cy,R,angleDeg,radPct,jPct,rng){const r=(radPct/100)*R,jAmp=(jPct/100)*angleDeg;return pts.map(p=>{const dx=p.wx-cx,dy=p.wy-cy,d=Math.sqrt(dx*dx+dy*dy);if(d>=r)return{...p};const a=((angleDeg+jAmp*jitter(rng))*Math.PI/180)*(1-d/r),c=Math.cos(a),s=Math.sin(a);return{...p,wx:cx+dx*c-dy*s,wy:cy+dx*s+dy*c};});}
function doBlossom(pts,cx,cy,abs,jPct,rng){const jAmp=(jPct/100)*abs.str,nS=Math.round(abs.freq)*2,sJ=Array.from({length:nS},()=>jitter(rng));return pts.map(p=>{const dx=p.wx-cx,dy=p.wy-cy,r=Math.sqrt(dx*dx+dy*dy)||1,angle=Math.atan2(dy,dx),si=Math.floor(((angle+Math.PI)/(2*Math.PI))*nS)%nS,js=abs.str+jAmp*sJ[si],nr=r+Math.sin(angle*abs.freq)*js;return{...p,wx:cx+(dx/r)*Math.max(0.01,nr),wy:cy+(dy/r)*Math.max(0.01,nr)};});}
function doStar(bzs,M,Mi,cx,cy,abs,closed,jPct,rng){const tbl=buildArcTable(bzs),total=tbl[tbl.length-1].arc,N=2*abs.freq,jAmp=(jPct/100)*abs.str,npc=PolyCurve.create(),cb=CurveBuilder.create();for(let i=0;i<N;i++){const p=sampleArc(tbl,(i/N)*total),w=applyM(M,p.x,p.y),dx=w.x-cx,dy=w.y-cy,r=Math.sqrt(dx*dx+dy*dy)||1,jStr=abs.str+jAmp*jitter(rng),nr=Math.max(0.01,r+Math.cos(Math.atan2(dy,dx)*abs.freq)*jStr),lp=applyMi(Mi,cx+(dx/r)*nr,cy+(dy/r)*nr);if(i===0)cb.begin(lp);else cb.lineTo(lp);}if(closed)cb.close();npc.addCurve(cb.createCurve());return npc;}
function doRipple(pts,cx,cy,abs,closed,focal,jPct,rng){const N=pts.length,jAmp=(jPct/100)*Math.PI*2;let po=0;const offs=pts.map(()=>{po+=(jitter(rng)*jAmp/N)*10;po*=0.95;return po;});return pts.map((p,i)=>{const ph=focal?Math.atan2(p.wy-cy,p.wx-cx)*abs.freq:(closed?i/N:i/(N-1))*abs.freq*2*Math.PI,w=Math.sin(ph+offs[i])*abs.str;return{...p,wx:p.wx+p.nx*w,wy:p.wy+p.ny*w};});}
function doWetPaint(pts,bb,abs,jPct,rng){const jAmp=(jPct/100)*abs.str,nD=Math.max(1,Math.round(abs.freq)),aJ=Array.from({length:nD+1},()=>jitter(rng)),pJ=Array.from({length:nD+1},()=>jitter(rng)*0.3);return pts.map(p=>{const tx=(p.wx-bb.minX)/(bb.w||1),drop=Math.floor(tx*nD),sJ=pJ[Math.min(drop,nD)],ph=(tx+sJ*0.1)*abs.freq*Math.PI,aF=Math.max(0,abs.str*(1+aJ[Math.min(drop,nD)]*(jPct/100)));return{...p,wy:p.wy+aF*(Math.sin(ph)*0.5+0.5)};});}
function doInflate(pts,cx,cy,R,abs,jPct,rng){const jAmp=(jPct/100)*abs.str;return pts.map(p=>{const dx=p.wx-cx,dy=p.wy-cy,r=Math.sqrt(dx*dx+dy*dy)||1,sJ=abs.str+jAmp*jitter(rng),bump=Math.sin((r/R)*Math.PI)*sJ,f=(r+bump)/r;return{...p,wx:cx+dx*f,wy:cy+dy*f};});}
function doPinch(pts,cx,cy,R,abs,jPct,rng){const jAmp=(jPct/100)*abs.str;return pts.map(p=>{const dx=p.wx-cx,dy=p.wy-cy,r=Math.sqrt(dx*dx+dy*dy)||1,t=r/R,sJ=abs.str+jAmp*jitter(rng),f=1-(sJ/R)*t*t;return{...p,wx:cx+dx*f,wy:cy+dy*f};});}
function doZigzag(pts,abs,closed,jPct,rng){const N=pts.length,jAmp=(jPct/100)*abs.str,nT=Math.round(abs.freq),tJ=Array.from({length:nT+1},()=>jitter(rng));return pts.map((p,i)=>{const t=closed?i/N:i/(N-1),saw=2*Math.abs(((t*abs.freq)%1)*2-1)-1,ti=Math.floor(t*nT),sJ=abs.str+jAmp*tJ[Math.min(ti,nT)];return{...p,wx:p.wx+p.nx*saw*sJ,wy:p.wy+p.ny*saw*sJ};});}
function doRays(pc,M,Mi,cx,cy,abs,jPct,rng){const npc=PolyCurve.create(),jAmp=(jPct/100)*abs.str;for(let ci=0;ci<pc.curveCount;ci++){const curve=pc.at(ci),bzs=curve.beziers.toArray();if(!bzs.length)continue;const cb=CurveBuilder.create();let fb=false;for(const b of bzs){const{A,B}=splitAt05(b),wm=applyM(M,A.end.x,A.end.y),dx=wm.x-cx,dy=wm.y-cy,d=Math.sqrt(dx*dx+dy*dy)||1,sJ=abs.str+jAmp*jitter(rng),lN=applyMi(Mi,wm.x+(dx/d)*sJ,wm.y+(dy/d)*sJ);if(!fb){cb.begin(b.start);fb=true;}cb.addBezier(A.c1,A.c2,lN);cb.addBezier(B.c1,B.c2,b.end);}if(curve.isClosed)cb.close();npc.addCurve(cb.createCurve());}return npc;}
function doPuckerBloat(pc,M,Mi,cx,cy,str,jPct,rng){const npc=PolyCurve.create(),jAmp=(jPct/100)*str;for(let ci2=0;ci2<pc.curveCount;ci2++){const curve=pc.at(ci2),bzs=curve.beziers.toArray();if(!bzs.length)continue;const cb=CurveBuilder.create(),ws0=applyM(M,bzs[0].start.x,bzs[0].start.y),s0J=str+jAmp*jitter(rng);cb.begin(applyMi(Mi,cx+(ws0.x-cx)*(1+s0J),cy+(ws0.y-cy)*(1+s0J)));for(const b of bzs){const we=applyM(M,b.end.x,b.end.y),wc1=applyM(M,b.c1.x,b.c1.y),wc2=applyM(M,b.c2.x,b.c2.y),eJ=str+jAmp*jitter(rng);cb.addBezier(applyMi(Mi,cx+(wc1.x-cx)*(1-str),cy+(wc1.y-cy)*(1-str)),applyMi(Mi,cx+(wc2.x-cx)*(1-str),cy+(wc2.y-cy)*(1-str)),applyMi(Mi,cx+(we.x-cx)*(1+eJ),cy+(we.y-cy)*(1+eJ)));}if(curve.isClosed)cb.close();npc.addCurve(cb.createCurve());}return npc;}
function envelopeDistort(pts,bb,mode,str,freq){const sN=str/100;return pts.map(p=>{const u=(bb.w>0)?(p.wx-bb.minX)/bb.w:0.5,v=(bb.h>0)?(p.wy-bb.minY)/bb.h:0.5;let dx=0,dy=0;if(mode===0)dy=-sN*bb.h*(1-v)*Math.sin(u*Math.PI);else if(mode===1)dy=-sN*bb.h*(1-Math.pow(2*u-1,2));else if(mode===2){const w=Math.max(1,Math.round(freq));dy=sN*bb.h*Math.sin(u*w*Math.PI*2)*(1-v*0.3);}else if(mode===3){const cx2=bb.minX+bb.w/2,cy2=bb.minY+bb.h/2,ddx=p.wx-cx2,ddy=p.wy-cy2,r=Math.sqrt(ddx*ddx+ddy*ddy),maxR=Math.sqrt((bb.w/2)**2+(bb.h/2)**2)||1;return{...p,wx:cx2+ddx*(1+sN*(r/maxR)),wy:cy2+ddy*(1+sN*(r/maxR))};}return{...p,wx:p.wx+dx,wy:p.wy+dy};});}
function doPerspective(pts,bb,strV,strH){const svN=strV/100,shN=strH/100;return pts.map(p=>{const u=(bb.w>0)?(p.wx-bb.minX)/bb.w:0.5,v=(bb.h>0)?(p.wy-bb.minY)/bb.h:0.5,midX=bb.minX+bb.w*0.5,newX=midX+(p.wx-midX)*(1-svN*(1-v)),midY=bb.minY+bb.h*0.5,newY=midY+(p.wy-midY)*(1-shN*(1-u));return{...p,wx:newX,wy:newY};});}
function doShear(pts,bb,strX,strY,angleDeg){const rad=angleDeg*Math.PI/180,cosA=Math.cos(rad),sinA=Math.sin(rad);return pts.map(p=>{const dx=p.wx-bb.cx,dy=p.wy-bb.cy,rx=dx*cosA+dy*sinA,ry=-dx*sinA+dy*cosA,nrx=rx+(strX/100)*bb.w*(ry/(bb.h*0.5||1)),nry=ry+(strY/100)*bb.h*(rx/(bb.w*0.5||1));return{...p,wx:bb.cx+nrx*cosA-nry*sinA,wy:bb.cy+nrx*sinA+nry*cosA};});}

// ── Bitmap distortion ─────────────────────────────────────────────────────────
function bitmapInverseSpread(m,osx,osy,scx,scy,maxRS,strS,freq,tw,tr){const dx=osx-scx,dy=osy-scy,r=Math.sqrt(dx*dx+dy*dy);if(r<0.001)return{ssx:osx,ssy:osy};const ndx=dx/r,ndy=dy/r;switch(m){case 0:{const R=(tr/100)*maxRS;if(r>=R)return{ssx:osx,ssy:osy};const a=-(tw*Math.PI/180)*(1-r/R),c=Math.cos(a),s=Math.sin(a);return{ssx:scx+dx*c-dy*s,ssy:scy+dx*s+dy*c};}case 1:{const nr=Math.max(0.01,r-Math.sin(Math.atan2(dy,dx)*freq)*strS);return{ssx:scx+ndx*nr,ssy:scy+ndy*nr};}case 2:{const nr=Math.max(0.01,r-Math.cos(Math.atan2(dy,dx)*freq)*strS);return{ssx:scx+ndx*nr,ssy:scy+ndy*nr};}case 3:{const phase=Math.atan2(dy,dx)*freq,w=Math.sin(phase)*strS;return{ssx:osx+(-ndy)*w,ssy:osy+ndx*w};}case 5:{const bump=Math.sin((r/maxRS)*Math.PI)*strS;return{ssx:scx+ndx*Math.max(0.01,r-bump),ssy:scy+ndy*Math.max(0.01,r-bump)};}case 6:{const t=r/maxRS,fwd=Math.max(0.01,1-(strS/maxRS)*t*t);return{ssx:scx+ndx*(r/fwd),ssy:scy+ndy*(r/fwd)};}case 7:{const arcLen=Math.atan2(dy,dx)*maxRS,tLen=2*Math.PI*maxRS,t2=((arcLen%(tLen/freq))/(tLen/freq)),saw=2*Math.abs(t2*2-1)-1;return{ssx:osx+(-ndy)*saw*strS,ssy:osy+ndx*saw*strS};}default:return{ssx:osx,ssy:osy};}}
function bilinear(arr,W,H,sxf,syf){const x0=Math.max(0,Math.min(W-2,Math.floor(sxf))),y0=Math.max(0,Math.min(H-2,Math.floor(syf)));const fx=sxf-x0,fy=syf-y0;const i00=(y0*W+x0)*4,i10=(y0*W+x0+1)*4,i01=((y0+1)*W+x0)*4,i11=((y0+1)*W+x0+1)*4;const out=[];for(let ch=0;ch<4;ch++)out.push(Math.round(arr[i00+ch]*(1-fx)*(1-fy)+arr[i10+ch]*fx*(1-fy)+arr[i01+ch]*(1-fx)*fy+arr[i11+ch]*fx*fy));return out;}
function applyBitmapDistortion(node,m,p){
    if(!node||!node.rasterInterface||!node.rasterWidth||!node.getSpreadBaseBox(false))return 0;
    let steps=0;doc.executeCommand(DocumentCommand.createSetSelection(Selection.create(doc,[node])));steps++;
    const fresh=doc.selection.at(0)?.node;if(!fresh||!fresh.rasterInterface)return steps;
    const ri=fresh.rasterInterface,W=fresh.rasterWidth,H=fresh.rasterHeight,bb=fresh.getSpreadBaseBox(false);if(!bb)return steps;
    const M=getTF(fresh),Mi=invertM(M);
    let scx=bb.x+bb.width/2,scy=bb.y+bb.height/2;
    if(p.useFocal){const fp=getFocalPoint(fresh);if(fp){scx=fp.x;scy=fp.y;}}
    const maxRS=Math.max(Math.sqrt((bb.x-scx)**2+(bb.y-scy)**2),Math.sqrt((bb.x+bb.width-scx)**2+(bb.y-scy)**2),Math.sqrt((bb.x-scx)**2+(bb.y+bb.height-scy)**2),Math.sqrt((bb.x+bb.width-scx)**2+(bb.y+bb.height-scy)**2))||1;
    const halfDiag=Math.sqrt(bb.width**2+bb.height**2)/2||1;
    const[fac,aN]=MCFG[m]||[1,false],bmpStr=p.linkBitmapStr?p.str:p.bmpStr,strS=toAbs(bmpStr,halfDiag,fac,aN),freq=Math.round(p.freq);
    const corners=[applyMi(Mi,bb.x,bb.y),applyMi(Mi,bb.x+bb.width,bb.y),applyMi(Mi,bb.x,bb.y+bb.height),applyMi(Mi,bb.x+bb.width,bb.y+bb.height)];
    let padSpread=0;if(m===0)padSpread=(p.tr/100)*maxRS*Math.min(1,Math.abs(p.tw)/180)*0.85;else if(m===1||m===2)padSpread=strS*1.1;else if(m===5)padSpread=strS*1.1;
    const padPx=padSpread>0?Math.ceil(padSpread/M[0]):0;
    const pxMin=Math.max(0,Math.floor(Math.min(...corners.map(c=>c.x)))-padPx);
    const pyMin=Math.max(0,Math.floor(Math.min(...corners.map(c=>c.y)))-padPx);
    const pxMax=Math.min(W-1,Math.ceil(Math.max(...corners.map(c=>c.x)))+padPx);
    const pyMax=Math.min(H-1,Math.ceil(Math.max(...corners.map(c=>c.y)))+padPx);
    const srcArr=new Uint8Array(ri.createCompatibleBuffer(true).buffer),dstBuf=ri.createCompatibleBuffer(true),dstArr=new Uint8Array(dstBuf.buffer);
    for(let py=pyMin;py<=pyMax;py++)for(let px=pxMin;px<=pxMax;px++){
        const osx=M[0]*px+M[1]*py+M[2],osy=M[3]*px+M[4]*py+M[5];
        const{ssx,ssy}=bitmapInverseSpread(m,osx,osy,scx,scy,maxRS,strS,freq,p.tw,p.tr);
        const spx=Mi[0]*ssx+Mi[1]*ssy+Mi[2],spy=Mi[3]*ssx+Mi[4]*ssy+Mi[5],di=(py*W+px)*4;
        if(spx<0||spy<0||spx>W-1||spy>H-1){dstArr[di]=dstArr[di+1]=dstArr[di+2]=dstArr[di+3]=0;}
        else{const rgba=bilinear(srcArr,W,H,spx,spy);dstArr[di]=rgba[0];dstArr[di+1]=rgba[1];dstArr[di+2]=rgba[2];dstArr[di+3]=rgba[3];}
    }
    const bm=ri.createCompatibleBitmap(false);dstBuf.copyTo(bm,{x:0,y:0,width:W,height:H},0,0);
    doc.executeCommand(DocumentCommand.createReplaceBitmap(doc.selection,bm));steps++;
    if(padPx>0&&padSpread>0){
        const bbCx=bb.x+bb.width/2,bbCy=bb.y+bb.height/2,pxCxN=(pxMin+pxMax)/2,pyCxN=(pyMin+pyMax)/2,nScale=(bb.width+2*padSpread)/(pxMax-pxMin);
        setAbsoluteTransform(fresh,[nScale,0,bbCx-nScale*pxCxN,0,nScale,bbCy-nScale*pyCxN]);steps++;
    }
    return steps;
}

// ── Configuration ─────────────────────────────────────────────────────────────
const MCFG=[[1,false],[1,false],[1,false],[2,false],[1,false],[1,true],[2,false],[2,false],[4,true],[1,true],[1,false],[1,false],[1,false]];
const USE_FOCAL=[true,true,true,true,false,true,true,false,true,true,false,false,false];
const BITMAP_OK=[true,true,true,true,false,true,true,true,false,false,false,false,false];
const HAS_JITTER=[true,true,true,true,true,true,true,true,true,true,false,false,false];
const MNAME=['Twirl','Blossom','Star','Ripple','Wet paint','Inflate','Pinch','Zigzag','Rays','Pucker/Bloat','Envelope','Perspective','Shear'];
const ENV_MODES=['Trapezoid','Arc','Flag','Fisheye'];
const SC_NAMES=['Linear','Ease-in-out','Step function'];
const MINFO=[
    ['Twirl group: angle + radius','Jitter: angle variation per point'],
    ['Strength × 1, frequency = petals','Jitter: amplitude variation per sector'],
    ['Strength × 1, frequency = spikes','Jitter: length variation per spike'],
    ['Strength × 2, waves along the path','Jitter: phase offset along the curve'],
    ['Strength × 1, frequency = drip width','Jitter: amplitude + spacing variation'],
    ['Strength × 1, negative = pull in','Jitter: radial bump jitter per point'],
    ['Strength × 2, no frequency effect','Jitter: pull variation per point'],
    ['Strength × 2, frequency = teeth','Jitter: amplitude variation per tooth'],
    ['Strength × 4, negative = inward','Jitter: length variation per ray'],
    ['Strength + = bloat, − = pucker','Jitter: strength variation per anchor point'],
    ['Envelope group: choose mode','no jitter'],
    ['Persp./shear group: V + H','no jitter'],
    ['Persp./shear group: X + Y + °','no jitter'],
];

// ── applyOneCurve ─────────────────────────────────────────────────────────────
function applyOneCurve(node,p,passes){
    passes=passes||1;
    const ci=node.curvesInterface;if(!ci||!ci.isMutable)return 0;
    let currentPC=ci.polyCurve;if(!currentPC||currentPC.curveCount===0)return 0;
    for(let pass=0;pass<passes;pass++){
        const pc=currentPC;
        const M=getTF(node);
        const Mi=invertM(M);
        let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
        for(let ci2=0;ci2<pc.curveCount;ci2++)for(const b of pc.at(ci2).beziers){const w=applyM(M,b.start.x,b.start.y);if(w.x<x0)x0=w.x;if(w.y<y0)y0=w.y;if(w.x>x1)x1=w.x;if(w.y>y1)y1=w.y;}
        const oBB={cx:(x0+x1)/2,cy:(y0+y1)/2,w:x1-x0,h:y1-y0,minX:x0,minY:y0};
        const hd=Math.sqrt(oBB.w**2+oBB.h**2)/2||1;
        const useFP=p.useFocal&&USE_FOCAL[p.m];
        let cx=oBB.cx,cy=oBB.cy;if(useFP){const fp=getFocalPoint(node);if(fp){cx=fp.x;cy=fp.y;}}
        const R=maxRfn(pc,M,cx,cy),useHQ=p.highQuality;
        const rng=makePRNG(p.seed===0?0:p.seed+pass*999983);
        const jPct=p.jitter;
        const npc=PolyCurve.create();
        if(p.m===9){const str=Math.max(-1,Math.min(1,p.str/100));doc.executeCommand(DocumentCommand.createSetCurves(ci,doPuckerBloat(pc,M,Mi,cx,cy,str,jPct,rng)));currentPC=ci.polyCurve;continue;}
        if(p.m===8){const abs={str:toAbs(p.str,hd,MCFG[8][0],MCFG[8][1]),freq:Math.round(p.freq)};doc.executeCommand(DocumentCommand.createSetCurves(ci,doRays(pc,M,Mi,cx,cy,abs,jPct,rng)));currentPC=ci.polyCurve;continue;}
        if(p.m===2){const abs={str:toAbs(p.str,hd,MCFG[2][0],false),freq:Math.round(p.freq)};doc.executeCommand(DocumentCommand.createSetCurves(ci,doStar(pc.at(0).beziers.toArray(),M,Mi,cx,cy,abs,pc.at(0).isClosed,jPct,rng)));currentPC=ci.polyCurve;continue;}
        const[fac,aN]=MCFG[p.m],abs={str:toAbs(p.str,hd,fac,aN),freq:Math.round(p.freq)};
        for(let ci2=0;ci2<pc.curveCount;ci2++){
            const curve=pc.at(ci2),bzs=curve.beziers.toArray();if(!bzs.length)continue;
            const closed=curve.isClosed,tbl=buildArcTable(bzs),total=tbl[tbl.length-1].arc;
            const raw=resample(bzs,M,numPts(total),closed),bb2=wBBox(raw);
            let d;
            if(p.m===0)      d=doTwirl(raw,cx,cy,R,p.tw,p.tr,jPct,rng);
            else if(p.m===1) d=doBlossom(raw,cx,cy,abs,jPct,rng);
            else if(p.m===3) d=doRipple(raw,cx,cy,abs,closed,useFP,jPct,rng);
            else if(p.m===4) d=doWetPaint(raw,bb2,abs,jPct,rng);
            else if(p.m===5) d=doInflate(raw,cx,cy,R,abs,jPct,rng);
            else if(p.m===6) d=doPinch(raw,cx,cy,R,abs,jPct,rng);
            else if(p.m===7) d=doZigzag(raw,abs,closed,jPct,rng);
            else if(p.m===10)d=envelopeDistort(raw,bb2,p.envMode,p.str,p.freq);
            else if(p.m===11)d=doPerspective(raw,bb2,p.pStrV,p.pStrH);
            else if(p.m===12)d=doShear(raw,bb2,p.shStrX,p.shStrY,p.shAngle);
            else d=raw;
            if(p.scMode>0&&p.m!==11&&p.m!==12)d=applyFalloff(raw,d,bb2,p.scMode,p.scSteps);
            if(useHQ){const c2=buildBezierFromPts(d,closed,Mi);if(c2)npc.addCurve(c2);}
            else{const cb=CurveBuilder.create(),fp2=applyMi(Mi,d[0].wx,d[0].wy);cb.begin(fp2);for(let i=1;i<d.length;i++)cb.lineTo(applyMi(Mi,d[i].wx,d[i].wy));if(closed){cb.lineTo(fp2);cb.close();}npc.addCurve(cb.createCurve());}
        }
        doc.executeCommand(DocumentCommand.createSetCurves(ci,npc));currentPC=ci.polyCurve;
    }
    return 1;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
function main(){
    if(!doc){app.alert('No document open.','Object Distortion');return;}
    const sel=doc.selection;
    if(!sel||sel.length===0){app.alert('Please select objects.','Object Distortion');return;}

    const{curves:rawCurves,bitmaps:rawBitmaps}=collectNodes(sel);
    if(!rawCurves.length&&!rawBitmaps.length){
        app.alert('No vector objects or pixel layers.','Object Distortion');return;
    }

    const origNodes=[];
    for(let i=0;i<sel.length;i++){const n=sel.at(i)?.node;if(n)origNodes.push(n);}
    let anyFocal=false;
    for(const n of [...rawCurves,...rawBitmaps])if(getFocalPoint(n)){anyFocal=true;break;}

    const posBeforeConvert=doc.history.position;
    const mutableNodes=rawCurves.filter(n=>n.curvesInterface.isMutable);
    const needsConvert=rawCurves.some(n=>!n.curvesInterface.isMutable);
    let converted=false;

    if(needsConvert){
        doc.executeCommand(DocumentCommand.createConvertToCurves(doc.selection));
        converted=true;
        const freshCurves=collectMutableFromSelection();
        for(const n of freshCurves)if(!mutableNodes.some(m=>m.isSameNode(n)))mutableNodes.push(n);
    }

    const bitmapNodes=[...rawBitmaps];
    const posBeforeAll=doc.history.position;

    const dlg=Dialog.create('Object Distortion v49-PRO');
    dlg.initialWidth=920;dlg.setIsResizable(true);

    const c1=dlg.addColumn();
    const gPre=c1.addGroup('Preset');
    const btnSave=gPre.addButton('💾 Save…');
    const btnLoad=gPre.addButton('📂 Load…');
    const btnDel =gPre.addButton('🗑  Delete…');
    const gM=c1.addGroup('Method');
    const cmb=gM.addComboBox('',MNAME,0);
    const gEnv=c1.addGroup('Envelope mode');
    const cmbEnv=gEnv.addComboBox('',ENV_MODES,0);
    const gSeed=c1.addGroup('Random seed');
    gSeed.addStaticText('','0 = new random each time');
    gSeed.addStaticText('','1–99999 = reproducible');
    const eSeed=gSeed.addUnitValueEditor('Seed','none','none',null,0,99999);eSeed.value=0;
    const gSC=c1.addGroup('Strength curve');
    const cmbSC=gSC.addComboBox('',SC_NAMES,0);
    const eSCSteps=gSC.addUnitValueEditor('Steps (2–10)','none','none',null,2,10);eSCSteps.value=4;

    const c2=dlg.addColumn();
    const gTw=c2.addGroup('Twirl');
    const eTw=gTw.addUnitValueEditor('Angle °','none','none',null,-720,720);eTw.value=180;
    const eTR=gTw.addUnitValueEditor('Radius %','none','none',null,10,100);eTR.value=85;
    const gPS=c2.addGroup('Perspective / shear');
    const ePsV=gPS.addUnitValueEditor('Strength V %','none','none',null,-100,100);ePsV.value=30;
    const ePsH=gPS.addUnitValueEditor('Strength H %','none','none',null,-100,100);ePsH.value=0;
    const eShX=gPS.addUnitValueEditor('Strength X %','none','none',null,-100,100);eShX.value=30;
    const eShY=gPS.addUnitValueEditor('Strength Y %','none','none',null,-100,100);eShY.value=0;
    const eShA=gPS.addUnitValueEditor('Angle °','none','none',null,-180,180);eShA.value=0;
    const gSF=c2.addGroup('Parameters');
    const eStr=gSF.addUnitValueEditor('Strength %','none','none',null,-100,100);eStr.value=30;
    const eFreq=gSF.addUnitValueEditor('Frequency','none','none',null,1,60);eFreq.value=6;
    const gJit=c2.addGroup('Jitter (% of strength)');
    const tJitInfo=gJit.addStaticText('','Method-specific random variation');
    const eJitter=gJit.addUnitValueEditor('Jitter %','none','none',null,0,100);eJitter.value=0;

    const c3=dlg.addColumn();c3.widthProportion=1.4;
    const gBMP=c3.addGroup('Bitmap strength');
    const cbLinkStr=gBMP.addCheckBox('Same strength',true);cbLinkStr.value=true;
    const eBmpStr=gBMP.addUnitValueEditor('Bitmap %','none','none',null,-100,100);eBmpStr.value=30;
    const gStack=c3.addGroup('Multiple passes & stacking');
    const ePasses=gStack.addUnitValueEditor('Passes (1–5)','none','none',null,1,5);ePasses.value=1;
    const cbStack=gStack.addCheckBox('2nd method',false);cbStack.value=false;
    const cmb2=gStack.addComboBox('',MNAME,1);
    const eStr2=gStack.addUnitValueEditor('Strength2 %','none','none',null,-100,100);eStr2.value=20;
    const gQual=c3.addGroup('Quality & options');
    const cbHQ=gQual.addCheckBox('Bezier (Catmull-Rom)',false);cbHQ.value=false;
    const cbBM=gQual.addCheckBox('Distort pixels',rawBitmaps.length>0);cbBM.value=rawBitmaps.length>0;
    const gI=c3.addGroup('Info');
    const tI0=gI.addStaticText('','Method: Twirl');
    const tI1=gI.addStaticText('',MINFO[0][0]);
    const tI2=gI.addStaticText('',MINFO[0][1]);
    const gFP=c3.addGroup('Focal point');
    gFP.addStaticText('',anyFocal?'FP present':'No FP → BB centre');
    const cbFP=gFP.addCheckBox('Use as centre',false);cbFP.value=anyFocal;
    const gStat=c3.addGroup('Selection');
    gStat.addStaticText('',mutableNodes.length+' curves, '+bitmapNodes.length+' pixel');
    if(converted)gStat.addStaticText('','Shapes/text converted');
    const gAct=c3.addGroup('');
    const actionBtns=gAct.addButtonSet('',['▶ Preview','✓ Apply'],0);
    actionBtns.setIsFullWidth(true);

    function readP(){
        return{
            m:cmb.selectedIndex,tw:eTw.value,tr:eTR.value,
            str:eStr.value,freq:eFreq.value,
            pStrV:ePsV.value,pStrH:ePsH.value,
            shStrX:eShX.value,shStrY:eShY.value,shAngle:eShA.value,
            useStack:cbStack.value,m2:cmb2.selectedIndex,str2:eStr2.value,
            useFocal:cbFP.value,doBitmap:cbBM.value,envMode:cmbEnv.selectedIndex,
            highQuality:cbHQ.value,linkBitmapStr:cbLinkStr.value,bmpStr:eBmpStr.value,
            passes:Math.max(1,Math.min(5,Math.round(ePasses.value))),
            seed:Math.max(0,Math.round(eSeed.value)),
            scMode:cmbSC.selectedIndex,scSteps:eSCSteps.value,
            jitter:Math.max(0,Math.min(100,eJitter.value)),
        };
    }
    function doApplyAll(p){
        for(const node of mutableNodes)applyOneCurve(node,p,p.passes);
        if(p.useStack){const p2={...p,m:p.m2,str:p.str2,passes:1};for(const node of mutableNodes)applyOneCurve(node,p2,1);}
        if(p.doBitmap&&bitmapNodes.length>0)for(const node of bitmapNodes)if(BITMAP_OK[p.m])applyBitmapDistortion(node,p.m,p);
    }
    function applyPresetData(data){
        if(!data)return;
        if(typeof data.m==='number')cmb.selectedIndex=data.m;
        if(typeof data.str==='number')eStr.value=data.str;
        if(typeof data.freq==='number')eFreq.value=data.freq;
        if(typeof data.tw==='number')eTw.value=data.tw;
        if(typeof data.tr==='number')eTR.value=data.tr;
        if(typeof data.pStrV==='number')ePsV.value=data.pStrV;
        if(typeof data.pStrH==='number')ePsH.value=data.pStrH;
        if(typeof data.shStrX==='number')eShX.value=data.shStrX;
        if(typeof data.shStrY==='number')eShY.value=data.shStrY;
        if(typeof data.shAngle==='number')eShA.value=data.shAngle;
        if(typeof data.envMode==='number')cmbEnv.selectedIndex=data.envMode;
        if(typeof data.seed==='number')eSeed.value=data.seed;
        if(typeof data.scMode==='number')cmbSC.selectedIndex=data.scMode;
        if(typeof data.scSteps==='number')eSCSteps.value=data.scSteps;
        if(typeof data.jitter==='number')eJitter.value=data.jitter;
        if(typeof data.m2==='number')cmb2.selectedIndex=data.m2;
        if(typeof data.str2==='number')eStr2.value=data.str2;
        if(typeof data.passes==='number')ePasses.value=data.passes;
        if(typeof data.highQuality==='boolean')cbHQ.value=data.highQuality;
        if(typeof data.doBitmap==='boolean')cbBM.value=data.doBitmap;
        if(typeof data.linkBitmapStr==='boolean')cbLinkStr.value=data.linkBitmapStr;
        if(typeof data.bmpStr==='number')eBmpStr.value=data.bmpStr;
        if(typeof data.useStack==='boolean')cbStack.value=data.useStack;
        if(typeof data.useFocal==='boolean')cbFP.value=data.useFocal;
    }

    cmb.setOnValueChangedHandler(()=>{
        const idx=cmb.selectedIndex;
        tI0.setText('Method: '+MNAME[idx]);
        tI1.setText(MINFO[idx][0]);
        tI2.setText(MINFO[idx][1]);
        tJitInfo.setText(HAS_JITTER[idx]?'Method-specific random variation':'— no jitter for this method');
    });
    btnSave.setOnClickHandler(()=>{
        const name=app.prompt('Preset name:','Save preset','My preset');
        if(!name||!name.trim())return;
        if(savePreset(name.trim(),readP()))tI0.setText('Preset "'+name.trim()+'" saved');
    });
    btnLoad.setOnClickHandler(()=>{
        const path=app.chooseFile();if(!path)return;
        const data=loadPreset(path);if(!data){tI0.setText('Loading failed');return;}
        applyPresetData(data);tI0.setText('Preset loaded');
    });
    btnDel.setOnClickHandler(()=>{
        const path=app.chooseFile();if(!path)return;
        if(deletePreset(path))tI0.setText('Preset deleted');
    });

    // v49: settings of the last shown preview
    let previewKey=null;

    while(true){
        const result=dlg.runModal();
        if(!result||result.value===DialogResult.Cancel.value){
            rollbackTo(posBeforeConvert);   // v49: undo preview + conversion in one go
            restoreSelection(origNodes);
            return;
        }
        const p=readP();
        const key=JSON.stringify(p);
        if(actionBtns.selectedIndex===0){
            rollbackTo(posBeforeAll);
            doApplyAll(p);
            previewKey=key;
            continue;
        }
        // v49: Apply - recalculate if there is no preview or the values changed
        if(previewKey!==key){
            rollbackTo(posBeforeAll);
            doApplyAll(p);
        }
        restoreSelection(origNodes);
        return;
    }
}
main();
