'use strict';
// GROUP MORPHING v34
//
// v34: time-step rotation: new option "Pivot" (tab 2):
//        • Group centre - centre of the respective time-step group (as before)
//        • Group focal point - focal point of the source groups, interpolated per step between
//          group A and B (spacing curve); without a set focal point the centre of the source group.
//          With an active path the pivot moves along the path.
//      Default "Group centre" = same result as v33.
//
// v33: time-step rotation (tab 2, time-step sorting only) extended like the per-object rotation:
//      "Full turns" (additive), angle distribution Linear/Ease in/Ease out/S-curve and angle
//      exponent. Total angle T=0->T=1 = rotation per step x (intermediate steps + 1)
//      + turns x 360 degrees, spread by the angle distribution; shown in the dialog.
//      Linear and 0 turns = same result as v32 (step n is rotated by n x rotation).
//
// v32: (1) Base and Alternative merged: the placement of the master group is now an option
//      (tab 2 "Result" -> "Placement of the master group"):
//        • Standard (like Group Morphing)  • Above both source groups (like Group Morphing Alternative)
//      The separate Alternative version is no longer needed.
//      (2) New tab 5 "Path": the group is blended along a path. The path is the first vector object
//      whose name starts with "_" (as in Blend Morphing; not part of group A/B; may be selected too).
//      Reference point of the group: focal point (otherwise centre) or centre of the bounding box.
//      Per time step a common offset (and optionally a rotation) is applied to all objects of that
//      step - the morphing of the pairs itself is unchanged.
//        • Relative mode: the path shape is fitted between the reference points of A and B
//          (rotated/scaled) - starts exactly at A, ends exactly at B.
//        • Absolute mode: the reference point lies exactly on the path (A/B copies at the path ends).
//        • Distribution by spacing curve or even (arc length); direction automatic, as drawn or
//          reversed; "Align to path" rotates each step by the change of the path tangent relative to
//          the path start.
//      Purely arithmetic (points and fill transforms) - still 4 history entries.
//      Without a path and with placement "Standard" = same result as v31.
//
// v31: Two extensions (tab 4 "Rotation & effects"):
//  1) Layer effects (FX) taken optionally from object A or object B per pair (until now only
//     from A). The info line shows whether the chosen side has effects.
//  2) Rotation: new field "Full turns" (integer, negative = opposite direction). The full turns
//     are added to the increment on the total angle:
//     total angle = increment x (intermediate steps + 1) + turns x 360 degrees,
//     spread by the chosen angle distribution. The end position B stays the same, the
//     intermediate steps additionally turn round N full times.
//  Defaults (FX from A, 0 turns) = same result as v30. Presets without the new fields load
//  with these defaults.
//
// v30: New option "Pivot follows spacing curve" (Rotation tab). Until now the pivot (moving focal
//      point) was interpolated with the angle distribution, the shape with the spacing curve. If the
//      curves differ, the pivot sat beside the object centre in the intermediate steps and the objects
//      were shifted sideways. With the option each object rotates about its own moving focal point and
//      the path follows the spacing curve exactly. Off = same result as v29.
//
// CHANGES v29 (base: v28) - undo unified, result unchanged:
// - Output always in exactly 4 history entries, independent of the number of pairs: master group,
//   placing + all sub-groups (1 compound), all objects of all sub-groups (1 compound),
//   opacity/FX/time-step offset (1 compound). v28: 3 + 1 per sub-group (42 pairs = 46).
// - Preview undo without the history position and without blind counting: undo is repeated
//   until the preview master group is no longer in the document. Creating it is the first own
//   entry - so undoing stops exactly there, also with a full history, and can never reach an
//   earlier user action. Limit: counted steps + 4, then a safety net (delete the group).
//   With a full history v28 undid the counted number of steps; if a command creates no entry of
//   its own, that would have undone a user action as well.
// - Compared live (42 sub-groups x 7, 7 time steps x 20 with offset): 0 deviations,
//   46 -> 4 and 11 -> 4 entries; undo exact; error case fully rolled back;
//   a user action directly before stays intact.
//
// v28: undo via position difference. v27: counted steps with a full history.
// v26: performance rework (objects purely in JavaScript, created in bulk, fill directly in
//      spread coordinates; hard-cut fixes). v25: stacking order 3.3.3.
// v24: toColour() for gradient stops. v23: tabbed GUI. v21: gradients in transformed groups.

const { Dialog, DialogResult } = require('/dialog.js');
const { Document } = require('/document.js');
const { app } = require('/application.js');
const { File, FileSystemApi } = require('/fs');
const { DocumentCommand, AddChildNodesCommandBuilder, CompoundCommandBuilder, NodeMoveType, NodeChildType } = require('/commands.js');
const { Colour, Gradient, RGBA8 } = require('/colours.js');
const { FillDescriptor, FillType, GradientFill } = require('/fills.js');
const { GradientFillType } = require('affinity:fills');
const { PolyCurve, CurveBuilder, Transform } = require('/geometry.js');
const { Selection } = require('/selections.js');
const { ContainerNodeDefinition, PolyCurveNodeDefinition } = require('/nodes.js');
const { LineStyleDescriptor } = require('/linestyle');
function lerp(a,b,t){return a+(b-a)*t;}
function easedT(t,exp,dm){const e=Math.max(0.1,exp);if(dm===0)return t;if(dm===1)return Math.pow(t,e);if(dm===3){return t<0.5?Math.pow(2*t,e)/2:1-Math.pow(2*(1-t),e)/2;}return 1-Math.pow(1-t,e);}
function easedAngle(frac,exp,dm){const e=Math.max(0.1,exp);if(dm===0)return frac;if(dm===1)return Math.pow(frac,e);if(dm===3){return frac<0.5?Math.pow(2*frac,e)/2:1-Math.pow(2*(1-frac),e)/2;}return 1-Math.pow(1-frac,e);}
function slerpAngle(a,b,t){let d=b-a;while(d>Math.PI)d-=2*Math.PI;while(d<-Math.PI)d+=2*Math.PI;return a+d*t;}
function applyTFtoPoint(tf,x,y){try{const r=tf.applyToPoint({x,y});if(isFinite(r.x)&&isFinite(r.y))return r;}catch(e){}try{const d=tf.data;return{x:d[0]*x+d[1]*y+d[2],y:d[3]*x+d[4]*y+d[5]};}catch(e){}return{x,y};}
function localToSpreadPoint(node,lx,ly){
    let x=lx,y=ly,cur=node;
    while(cur){
        try{const p=applyTFtoPoint(cur.transform,x,y);x=p.x;y=p.y;}catch(e){break;}
        let next=null;try{next=cur.parent;}catch(e){next=null;}
        if(!next)break;
        cur=next;
    }
    return{x,y};
}
function isIdTF(tf){try{const d=tf.data;return Math.abs(d[0]-1)<0.001&&Math.abs(d[1])<0.001&&Math.abs(d[2])<0.001&&Math.abs(d[3])<0.001&&Math.abs(d[4]-1)<0.001&&Math.abs(d[5])<0.001;}catch(e){return true;}}
function composeAffine(A,B){
    const ad=A.data,bd=B.data;
    return{data:[
        bd[0]*ad[0]+bd[1]*ad[3],
        bd[0]*ad[1]+bd[1]*ad[4],
        bd[0]*ad[2]+bd[1]*ad[5]+bd[2],
        bd[3]*ad[0]+bd[4]*ad[3],
        bd[3]*ad[1]+bd[4]*ad[4],
        bd[3]*ad[2]+bd[4]*ad[5]+bd[5]
    ]};
}
function composedSpreadTF(node){
    const nd=node.transform.data;
    let composed={data:[nd[0],nd[1],nd[2],nd[3],nd[4],nd[5]]};
    let n=node.parent;
    while(n){
        const pd=n.transform.data;
        composed=composeAffine(composed,{data:[pd[0],pd[1],pd[2],pd[3],pd[4],pd[5]]});
        n=n.parent;
    }
    return composed;
}
function makeTrFromGeom(g){try{const ang=Math.atan2(g.v1y,g.v1x),sc=Math.sqrt(g.v1x*g.v1x+g.v1y*g.v1y);if(sc<0.001)return Transform.createIdentity().translated(g.p0x,g.p0y);return Transform.createIdentity().rotated(ang).scaled(sc).translated(g.p0x,g.p0y);}catch(e){return Transform.createIdentity();}}
function fdToSpreadGeom(fd,node){const anchored=fd.isAnchoredToSpread,fdt=fd.transform,p0l={x:fdt.origin.x,y:fdt.origin.y},v1l={x:fdt.xAxis.x,y:fdt.xAxis.y},v2l={x:fdt.yAxis.x,y:fdt.yAxis.y};if(anchored)return{p0x:p0l.x,p0y:p0l.y,v1x:v1l.x,v1y:v1l.y,v2x:v2l.x,v2y:v2l.y};const ntf=composedSpreadTF(node),p0s=applyTFtoPoint(ntf,p0l.x,p0l.y),p1s=applyTFtoPoint(ntf,p0l.x+v1l.x,p0l.y+v1l.y),p2s=applyTFtoPoint(ntf,p0l.x+v2l.x,p0l.y+v2l.y);return{p0x:p0s.x,p0y:p0s.y,v1x:p1s.x-p0s.x,v1y:p1s.y-p0s.y,v2x:p2s.x-p0s.x,v2y:p2s.y-p0s.y};}
function solidGeom(bb){return{p0x:bb.x+bb.w/2,p0y:bb.y+bb.h/2,v1x:0,v1y:0,v2x:0,v2y:0};}
function toPolar(g){return{p0x:g.p0x,p0y:g.p0y,r1:Math.sqrt(g.v1x**2+g.v1y**2),a1:Math.atan2(g.v1y,g.v1x),r2:Math.sqrt(g.v2x**2+g.v2y**2),a2:Math.atan2(g.v2y,g.v2x)};}
function fromPolar(p){return{p0x:p.p0x,p0y:p.p0y,v1x:p.r1*Math.cos(p.a1),v1y:p.r1*Math.sin(p.a1),v2x:p.r2*Math.cos(p.a2),v2y:p.r2*Math.sin(p.a2)};}
function lerpPolar(gA,gB,t){if(t<=0)return gA;if(t>=1)return gB;const pA=toPolar(gA),pB=toPolar(gB);return fromPolar({p0x:lerp(pA.p0x,pB.p0x,t),p0y:lerp(pA.p0y,pB.p0y,t),r1:lerp(pA.r1,pB.r1,t),a1:slerpAngle(pA.a1,pB.a1,t),r2:lerp(pA.r2,pB.r2,t),a2:slerpAngle(pA.a2,pB.a2,t)});}
function rotateGeom(g,cx,cy,cos,sin){const dx=g.p0x-cx,dy=g.p0y-cy;return{p0x:cx+dx*cos-dy*sin,p0y:cy+dx*sin+dy*cos,v1x:g.v1x*cos-g.v1y*sin,v1y:g.v1x*sin+g.v1y*cos,v2x:g.v2x*cos-g.v2y*sin,v2y:g.v2x*sin+g.v2y*cos};}

const FT_NAME={1:'None',2:'Solid',3:'Gradient',4:'Bitmap',5:'Mesh',6:'Hatch'};
function ftName(ft){return FT_NAME[ft]||('Type '+ft);}
function hasFX(info){try{return info.node.layerEffectsInterface?.hasActiveEffects||false;}catch(e){return false;}}

const FX_CMD={0:(sel,fx)=>DocumentCommand.createSetBevelEmbossLayerEffect(sel,fx),1:(sel,fx,i)=>DocumentCommand.createSetOutlineLayerEffect(sel,fx,i),2:(sel,fx)=>DocumentCommand.createSetPhongBevelLayerEffect(sel,fx),3:(sel,fx,i)=>DocumentCommand.createSetInnerShadowLayerEffect(sel,fx,i),4:(sel,fx)=>DocumentCommand.createSetInnerGlowLayerEffect(sel,fx),5:(sel,fx,i)=>DocumentCommand.createSetColourOverlayLayerEffect(sel,fx,i),6:(sel,fx,i)=>DocumentCommand.createSetGradientOverlayLayerEffect(sel,fx,i),7:(sel,fx)=>DocumentCommand.createSetOuterGlowLayerEffect(sel,fx),8:(sel,fx,i)=>DocumentCommand.createSetOuterShadowLayerEffect(sel,fx,i),9:(sel,fx)=>DocumentCommand.createSetGaussianBlurLayerEffect(sel,fx)};
function bbCenter(node){try{const bb=node.getSpreadBaseBox(false);return{x:bb.x+bb.width/2,y:bb.y+bb.height/2};}catch(e){return{x:0,y:0};}}
function resample(pts,N){if(!pts.length)return Array(N).fill({x:0,y:0});if(pts.length===1)return Array(N).fill(pts[0]);const r=[];for(let i=0;i<N;i++){const f=(N===1)?0:(i/(N-1))*(pts.length-1);const lo=Math.floor(f),hi=Math.min(lo+1,pts.length-1),t=f-lo;r.push({x:lerp(pts[lo].x,pts[hi].x,t),y:lerp(pts[lo].y,pts[hi].y,t)});}return r;}
function ptCurve(px,py,N){return Array(N).fill({x:px,y:py});}
function rgba8ToHsl(r,g,b,alpha){r/=255;g/=255;b/=255;const max=Math.max(r,g,b),min=Math.min(r,g,b);let h=0,s=0;const l=(max+min)/2;if(max!==min){const d=max-min;s=l>0.5?d/(2-max-min):d/(max+min);switch(max){case r:h=((g-b)/d+(g<b?6:0))/6;break;case g:h=((b-r)/d+2)/6;break;case b:h=((r-g)/d+4)/6;break;}}return{h,s,l,alpha:(alpha!=null?alpha:255)/255};}
function mkCol(hsl,noise){const col=Colour.createHSLAf(hsl);try{col.noise=noise||0;}catch(e){}return col;}
function stopRGBA(s){
    if(s.rgba8)return s.rgba8;
    try{return Colour.createHSLAf(s.hsl).rgba8;}catch(e){return{r:0,g:0,b:0,alpha:(s.hsl&&s.hsl.alpha!=null)?Math.round(s.hsl.alpha*255):255};}
}
function r8(r,g,b,a){return RGBA8(r,g,b,a!=null?a:255);}
function toColour(c){return (c instanceof Colour)?c:new Colour(c);}
function cToRGBA(c){try{if(c instanceof Colour)return c.rgba8;return new Colour(c).rgba8;}catch(e){return{r:0,g:0,b:0,alpha:255};}}
function rgba8Eq(a,b){return a.r===b.r&&a.g===b.g&&a.b===b.b&&a.alpha===b.alpha;}
function readSt(grad,i){const s=grad.getStop(i);const col=toColour(s.colour);const rgba8=col.rgba8;let hsl,noise=0;try{hsl=col.hslaf;}catch(e){hsl=rgba8ToHsl(rgba8.r,rgba8.g,rgba8.b,rgba8.alpha*255);}try{noise=col.noise||0;}catch(e){}return{position:s.position,midpoint:s.midpoint!=null?s.midpoint:0.5,noise,hsl,rgba8,origColour:toColour(s.colour)};}
function readStops(gf){const g=gf.gradient,st=[];for(let i=0;i<g.stopCount;i++)st.push(readSt(g,i));st.sort((a,b)=>a.position-b.position);return st;}
function origStops(gf){const g=gf.gradient,r=[];for(let i=0;i<g.stopCount;i++){const s=g.getStop(i);r.push({colour:toColour(s.colour),position:s.position,midpoint:s.midpoint!=null?s.midpoint:0.5});}return r;}
function colStops(rgba){const hsl=rgba8ToHsl(rgba.r,rgba.g,rgba.b,rgba.alpha);return[{position:0,midpoint:0.5,noise:0,hsl,rgba8:rgba},{position:1,midpoint:0.5,noise:0,hsl,rgba8:rgba}];}
function normHsl(h){if(h.l<0.001||h.l>0.999)return{...h,s:0};return h;}
function resHue(h,p){const n=normHsl(h);if(n.s<0.001)return{...n,h:p.h};return n;}
function resampleSt(stops,n){if(stops.length===n)return stops;const r=[];for(let i=0;i<n;i++){const pos=i/(n-1);let lo=stops[0],hi=stops[stops.length-1];for(let j=0;j<stops.length-1;j++){if(stops[j].position<=pos&&stops[j+1].position>=pos){lo=stops[j];hi=stops[j+1];break;}}const span=hi.position-lo.position,lt=span>0.001?(pos-lo.position)/span:0;const hA=lo.hsl,hB=hi.hsl;r.push({position:pos,midpoint:lerp(lo.midpoint||0.5,hi.midpoint||0.5,lt),noise:lerp(lo.noise||0,hi.noise||0,lt),hsl:{h:lerp(hA.h,hB.h,lt),s:lerp(hA.s,hB.s,lt),l:lerp(hA.l,hB.l,lt),alpha:lerp(hA.alpha,hB.alpha,lt)},rgba8:null,origColour:null});}return r;}
function hueArc(hA,hB,cm,identical){
    const raw=hB-hA;
    const arcRight=raw<0?raw+1:raw;
    const arcLeft=raw>0?raw-1:raw;
    if(cm===1)return identical?1:arcRight;
    if(cm===2)return identical?-1:arcLeft;
    if(cm===4)return identical?1:(Math.abs(arcRight)>=Math.abs(arcLeft)?arcRight:arcLeft);
    if(cm===5)return identical?0:(Math.abs(arcRight)<=Math.abs(arcLeft)?arcRight:arcLeft);
    return raw;
}
function cwStops(sA,sB,cm){
    const hA=resHue(normHsl(sA.hsl),sB.hsl),hB=resHue(normHsl(sB.hsl),sA.hsl);
    const identical=Math.abs(hA.h-hB.h)<1e-6&&Math.abs(hA.s-hB.s)<1e-6&&Math.abs(hA.l-hB.l)<1e-6;
    const arc=hueArc(hA.h,hB.h,cm,identical);
    const n=Math.min(6,Math.floor(Math.abs(arc)/(6/360)));if(n<=0)return[];
    const res=[];for(let k=1;k<=n;k++){const t=k/(n+1),h=((hA.h+arc*t)%1+1)%1;res.push({position:lerp(sA.position,sB.position,t),midpoint:0.5,noise:lerp(sA.noise||0,sB.noise||0,t),hsl:{h,s:lerp(hA.s,hB.s,t),l:lerp(hA.l,hB.l,t),alpha:lerp(hA.alpha,hB.alpha,t)},rgba8:null,origColour:null});}return res;
}
function iStops(stA,stB,t,cm,gfA,gfB){if(t<=0)return gfA?origStops(gfA):null;if(t>=1)return gfB?origStops(gfB):null;const n=Math.max(stA.length,stB.length,2);const rsA=resampleSt(stA,n),rsB=resampleSt(stB,n);const res=[];if(cm===0){for(let i=0;i<n;i++){const sA=rsA[i],sB=rsB[i];if(sA.rgba8&&sB.rgba8&&rgba8Eq(sA.rgba8,sB.rgba8)&&sA.origColour){res.push({colour:sA.origColour,position:lerp(sA.position,sB.position,t),midpoint:lerp(sA.midpoint||0.5,sB.midpoint||0.5,t)});}else{const hA=sA.hsl,hB=sB.hsl;res.push({position:lerp(sA.position,sB.position,t),midpoint:lerp(sA.midpoint||0.5,sB.midpoint||0.5,t),noise:lerp(sA.noise||0,sB.noise||0,t),hsl:{h:lerp(hA.h,hB.h,t),s:lerp(hA.s,hB.s,t),l:lerp(hA.l,hB.l,t),alpha:lerp(hA.alpha,hB.alpha,t)}});}}return res;}if(cm===3){for(let i=0;i<n;i++){const sA=rsA[i],sB=rsB[i];const rgA=stopRGBA(sA),rgB=stopRGBA(sB);if(sA.origColour&&rgba8Eq(rgA,rgB)){res.push({colour:sA.origColour,position:lerp(sA.position,sB.position,t),midpoint:lerp(sA.midpoint||0.5,sB.midpoint||0.5,t)});continue;}const rr=lerp(rgA.r,rgB.r,t),gg=lerp(rgA.g,rgB.g,t),bb=lerp(rgA.b,rgB.b,t),aa=lerp(rgA.alpha,rgB.alpha,t);res.push({position:lerp(sA.position,sB.position,t),midpoint:lerp(sA.midpoint||0.5,sB.midpoint||0.5,t),noise:0,hsl:rgba8ToHsl(rr,gg,bb,aa)});}return res;}const base=[];for(let i=0;i<n;i++){const sA=rsA[i],sB=rsB[i];const identical=sA.rgba8&&sB.rgba8&&rgba8Eq(sA.rgba8,sB.rgba8);const hA=resHue(normHsl(sA.hsl),sB.hsl),hB=resHue(normHsl(sB.hsl),sA.hsl);const arc=hueArc(hA.h,hB.h,cm,identical);const h=((hA.h+arc*t)%1+1)%1;base.push({position:lerp(sA.position,sB.position,t),midpoint:lerp(sA.midpoint||0.5,sB.midpoint||0.5,t),noise:lerp(sA.noise||0,sB.noise||0,t),hsl:{h,s:lerp(hA.s,hB.s,t),l:lerp(hA.l,hB.l,t),alpha:lerp(hA.alpha,hB.alpha,t)}});}for(let i=0;i<base.length;i++){res.push(base[i]);if(i<base.length-1)for(const ws of cwStops(base[i],base[i+1],cm))res.push(ws);}return res.length>0?res:base;}
function mkGrad(stops){return Gradient.create(stops.map(s=>s.colour?{colour:s.colour,position:s.position,midpoint:s.midpoint!=null?s.midpoint:0.5}:{colour:mkCol(s.hsl,s.noise||0),position:s.position,midpoint:s.midpoint!=null?s.midpoint:0.5}));}

function valPairM1(aA,aB){const INTERP=[1,2,3];if(!INTERP.includes(aA.ft))return'⚠ Fill A ('+ftName(aA.ft)+') cannot be interpolated.';if(!INTERP.includes(aB.ft))return'⚠ Fill B ('+ftName(aB.ft)+') cannot be interpolated.';if(aA.isGrad&&aB.isGrad&&aA.gft!==aB.gft){const n=['Linear','Elliptical','Radial','Conical'];return'⚠ Different gradient types ('+n[aA.gft]+'/'+n[aB.gft]+').';}return null;}
function iFillGeom(aA,aB,t,cm,useAnchored){if(!aA.isGrad&&!aB.isGrad){if(aA.isNone&&aB.isNone)return{fd:FillDescriptor.createSolid(r8(0,0,0,0)),geom:null,gft:-1};if(t<=0){const c=aA.solidRGBA||{r:0,g:0,b:0,alpha:0};return{fd:FillDescriptor.createSolid(r8(c.r,c.g,c.b,c.alpha)),geom:null,gft:-1};}if(t>=1){const c=aB.solidRGBA||{r:0,g:0,b:0,alpha:0};return{fd:FillDescriptor.createSolid(r8(c.r,c.g,c.b,c.alpha)),geom:null,gft:-1};}const st=iStops(aA.stops,aB.stops,t,cm,null,null);if(!st||!st[0])return{fd:FillDescriptor.createSolid(RGBA8(128,128,128,255)),geom:null,gft:-1};let rgba;if(st[0].colour){rgba=cToRGBA(st[0].colour);}else{const col=mkCol(st[0].hsl,st[0].noise||0);rgba=col.rgba8;}return{fd:FillDescriptor.createSolid(r8(rgba.r,rgba.g,rgba.b,rgba.alpha)),geom:null,gft:-1};}const st=iStops(aA.stops,aB.stops,t,cm,aA.gfOrig,aB.gfOrig);const gft=aA.isGrad?aA.gft:aB.gft;const gi=lerpPolar(aA.sGeom,aB.sGeom,t);let ng;if(st){ng=mkGrad(st);}else{ng=mkGrad(aA.stops.map((sA,i)=>{const sB=aB.stops[Math.min(i,aB.stops.length-1)];const hA=sA.hsl,hB=sB.hsl;return{position:lerp(sA.position,sB.position,t),midpoint:0.5,noise:0,hsl:{h:lerp(hA.h,hB.h,t),s:lerp(hA.s,hB.s,t),l:lerp(hA.l,hB.l,t),alpha:lerp(hA.alpha,hB.alpha,t)}};}));}let tr;if(t<=0&&aA.origFdTr){tr=aA.origFdTr;}else if(t>=1&&aB.origFdTr){tr=aB.origFdTr;}else{tr=makeTrFromGeom(gi);}const fd=FillDescriptor.create(GradientFill.create(ng,gft),false,tr,aA.isGrad?aA.blendMode:aB.blendMode,useAnchored);return{fd,geom:gi,gft,ng,blendMode:aA.isGrad?aA.blendMode:aB.blendMode,useAnchored};}
function fdFromGeom(result,geomRotated){if(!result.geom||!geomRotated)return result.fd;return FillDescriptor.create(GradientFill.create(result.ng,result.gft),false,makeTrFromGeom(geomRotated),result.blendMode,result.useAnchored);}

function getWt(n){try{const w=n.lineWeightPts;return(typeof w==='number'&&isFinite(w))?w:0;}catch(e){return 0;}}
function getLS(n){try{return n.lineStyleDescriptor;}catch(e){return null;}}
function getPenAna(node){try{const pfd=node.penFillDescriptor;if(!pfd||!pfd.fill)return null;return anaFD(pfd,node);}catch(e){return null;}}
function readAttrs(doc,info,res){
    const{node,seqIdx,isText}=info;const{curves,anyOpen}=sampleNode(node,res);
    if(!isText)return{bAna:anaFD(node.brushFillDescriptor,node),pAna:getPenAna(node),wt:getWt(node),ls:getLS(node),curves,anyOpen,bbc:bbCenter(node)};
    doc.executeCommand(DocumentCommand.createConvertToCurves(Selection.create(doc,[node])));
    let conv=null,ix=0;for(const l of doc.layers.all){if(!l.curvesInterface)continue;if(ix===seqIdx){conv=l;break;}ix++;}
    let bAna=anaFD(FillDescriptor.createSolid(RGBA8(0,0,0,0)),node);let pAna=null,wt=0,ls=null;
    if(conv?.curvesInterface?.isMutable){try{bAna=anaFD(conv.brushFillDescriptor,conv);}catch(e){}pAna=getPenAna(conv);wt=getWt(conv);ls=getLS(conv);}
    doc.executeCommand(DocumentCommand.createUndo());
    return{bAna,pAna,wt,ls,curves,anyOpen,bbc:bbCenter(node)};
}

// ── v26: matrix once per object, sample points purely in JavaScript ─────────
function tfToSpread(node){try{return composedSpreadTF(node);}catch(e){return{data:[1,0,0,0,1,0]};}}
function apTF(tf,x,y){const d=tf.data;return{x:d[0]*x+d[1]*y+d[2],y:d[3]*x+d[4]*y+d[5]};}
function sampleC(c,tf,cnt){const pts=[];let bz=[];try{bz=c.beziers.toArray();}catch(e){}if(bz.length>0){const pb=Math.max(2,Math.floor(cnt/bz.length));for(const b of bz){const s=b.start,c1=b.c1,c2=b.c2,en=b.end;const sx=s.x,sy=s.y,ax=c1.x,ay=c1.y,bx=c2.x,by=c2.y,ex=en.x,ey=en.y;for(let si=0;si<pb;si++){const t=si/pb,mt=1-t;const lx=mt*mt*mt*sx+3*mt*mt*t*ax+3*mt*t*t*bx+t*t*t*ex;const ly=mt*mt*mt*sy+3*mt*mt*t*ay+3*mt*t*t*by+t*t*t*ey;const p=apTF(tf,lx,ly);if(isFinite(p.x)&&isFinite(p.y))pts.push(p);}}}if(!pts.length){for(const nd of c.nodes){const p=apTF(tf,nd.position.x,nd.position.y);if(isFinite(p.x)&&isFinite(p.y))pts.push(p);}}return pts;}
function sampleNode(node,res){const curves=[];let anyOpen=false;try{const tf=tfToSpread(node);const pc=node.curvesInterface.polyCurve;for(let ci=0;ci<pc.curveCount;ci++){const c=pc.at(ci);const pts=sampleC(c,tf,res);if(pts.length>1)curves.push({pts,isClosed:c.isClosed});if(!c.isClosed)anyOpen=true;}}catch(e){}return{curves,anyOpen};}

// v26: fill transform directly in spread coordinates (replaces the temporary anchoring
// to the spread from v21 - verified live: deviation 0.0000 even in a rotated group).
function affToTransform(a){const t=Transform.createIdentity();const d=t.data;for(let k=0;k<6;k++)d[k]=a.data[k];return t;}
function fdSpreadTransform(fd,node){
    if(fd.isAnchoredToSpread)return fd.transform.clone();
    const fd0=fd.transform.data;
    return affToTransform(composeAffine({data:[fd0[0],fd0[1],fd0[2],fd0[3],fd0[4],fd0[5]]},tfToSpread(node)));
}
function fdToSpread(fd,node){
    // complete fill (any type) unchanged, only the transform moved to spread space - for hard cut
    try{
        const ft=fd.fill.fillType.value;
        if(ft===FillType.None.value||ft===FillType.Solid.value||ft===1)return fd;
        return FillDescriptor.create(fd.fill,fd.isScaleWithObject,fdSpreadTransform(fd,node),fd.blendMode,false);
    }catch(e){return fd;}
}
function anaFD(fd,node){const ft=fd.fill.fillType.value;const isNone=ft===1||ft===FillType.None.value,isSolid=ft===FillType.Solid.value,isGrad=ft===FillType.Gradient.value;const bb_raw=node.getSpreadBaseBox(false);const sBB={x:bb_raw.x,y:bb_raw.y,w:bb_raw.width,h:bb_raw.height};if(isNone){const rgba={r:0,g:0,b:0,alpha:0};return{isNone,isSolid:false,isGrad:false,gft:-1,stops:colStops(rgba),solidRGBA:rgba,gfOrig:null,sGeom:solidGeom(sBB),anchored:false,blendMode:null,origFdTr:null,ft};}if(isSolid){const rgba=cToRGBA(fd.fill.colour);return{isNone:false,isSolid,isGrad:false,gft:-1,stops:colStops(rgba),solidRGBA:rgba,gfOrig:null,sGeom:solidGeom(sBB),anchored:false,blendMode:null,origFdTr:null,ft};}if(isGrad){const gf=fd.fill,anchored=fd.isAnchoredToSpread,sGeom=fdToSpreadGeom(fd,node);return{isNone:false,isSolid:false,isGrad:true,gft:gf.gradientFillType,stops:readStops(gf),solidRGBA:null,gfOrig:gf,sGeom,anchored,blendMode:fd.blendMode,origFdTr:fdSpreadTransform(fd,node),ft};}return{isNone:false,isSolid:false,isGrad:false,isSpecial:true,gft:-1,stops:colStops({r:0,g:0,b:0,alpha:0}),solidRGBA:{r:0,g:0,b:0,alpha:0},gfOrig:null,sGeom:solidGeom(sBB),anchored:false,blendMode:null,origFdTr:null,ft};}

// v26: compute geometry only (no document commands)
// v30: pivot optionally follows the spacing curve instead of the angle distribution (off by default).
// v31: rotTurns = full turns, added to the increment on the total angle.
let PIVOT_FOLLOWS_DIST=false;
// v32: path - one affine transform per time step si (offset + optional rotation), otherwise null
let PATH_TF=null;
function pathAffine(dx,dy,rot,cx,cy){const c=Math.cos(rot),s=Math.sin(rot);const ex=dx-cx,ey=dy-cy;return{data:[c,-s,cx+c*ex-s*ey,s,c,cy+s*ex+c*ey]};}
function samplePathNode(node,res){
    try{
        const tf=tfToSpread(node);const pc=node.curvesInterface.polyCurve;if(!pc||pc.curveCount<1)return null;
        const c=pc.at(0);const pts=sampleC(c,tf,res);
        let bz=[];try{bz=c.beziers.toArray();}catch(e){}
        if(c.isClosed){if(pts.length)pts.push({x:pts[0].x,y:pts[0].y});}
        else if(bz.length){const e=bz[bz.length-1].end;const p=apTF(tf,e.x,e.y);if(isFinite(p.x)&&isFinite(p.y))pts.push(p);}
        if(pts.length<2)return null;
        const cum=[0];let total=0;for(let i=1;i<pts.length;i++){total+=Math.hypot(pts[i].x-pts[i-1].x,pts[i].y-pts[i-1].y);cum.push(total);}
        if(total<1e-6)return null;
        return{pts,cum,total,closed:c.isClosed};
    }catch(e){return null;}
}
function pathAt(S,f){
    f=Math.max(0,Math.min(1,f));const target=f*S.total,cum=S.cum,pts=S.pts;
    let lo=0,hi=cum.length-1;while(hi-lo>1){const m=(lo+hi)>>1;if(cum[m]<=target)lo=m;else hi=m;}
    const seg=cum[hi]-cum[lo],u=seg>1e-9?(target-cum[lo])/seg:0;
    return{x:lerp(pts[lo].x,pts[hi].x,u),y:lerp(pts[lo].y,pts[hi].y,u)};
}
function nodeIsInside(n,anc){try{let p=n.parent;while(p){if(p.isSameNode(anc))return true;p=p.parent;}}catch(e){}return false;}
function findPathNode(doc,groups){
    for(const l of doc.layers.all){
        try{
            if(!l.curvesInterface)continue;
            const nm=l.userDescription||l.defaultDescription||'';if(!nm.startsWith('_'))continue;
            let skip=false;for(const g of groups){if(l.isSameNode(g)||nodeIsInside(l,g)){skip=true;break;}}
            if(!skip)return l;
        }catch(e){}
    }
    return null;
}
function groupRefPoint(n,mode){
    if(mode!==1){try{const f=n.transformInterface.focalPoint;if(f&&f.isValid)return apTF(tfToSpread(n),f.point.x,f.point.y);}catch(e){}}
    try{const bb=n.getSpreadBaseBox(false);return{x:bb.x+bb.width/2,y:bb.y+bb.height/2};}catch(e){}
    return{x:0,y:0};
}
// returns the affine transform per time step (0..steps+1) or null
function buildPathTF(S,RA,RB,steps,dm,dexp,o){
    const d2=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
    let P0=pathAt(S,0),P1=pathAt(S,1);
    let rev=o.dir===2;
    if(o.dir===0)rev=(d2(P1,RA)+d2(P0,RB))<(d2(P0,RA)+d2(P1,RB));
    const P=f=>pathAt(S,rev?1-f:f);
    P0=P(0);P1=P(1);
    let Q;
    if(o.mode===1){Q=P;}
    else{
        const vx=P1.x-P0.x,vy=P1.y-P0.y,wx=RB.x-RA.x,wy=RB.y-RA.y;const lv=Math.hypot(vx,vy),lw=Math.hypot(wx,wy);
        if(lv>1e-6&&lw>1e-6){
            const sc=lw/lv,ph=Math.atan2(wy,wx)-Math.atan2(vy,vx),c=Math.cos(ph)*sc,s=Math.sin(ph)*sc;
            Q=f=>{const p=P(f),dx=p.x-P0.x,dy=p.y-P0.y;return{x:RA.x+c*dx-s*dy,y:RA.y+s*dx+c*dy};};
        }else{
            Q=f=>{const p=P(f);return{x:lerp(RA.x,RB.x,f)+p.x-lerp(P0.x,P1.x,f),y:lerp(RA.y,RB.y,f)+p.y-lerp(P0.y,P1.y,f)};};
        }
    }
    const tang=f=>{const e=0.002;const a=Q(Math.max(0,f-e)),b=Q(Math.min(1,f+e));return Math.atan2(b.y-a.y,b.x-a.x);};
    const ang0=o.align?tang(0):0;
    const out=[];
    for(let si=0;si<=steps+1;si++){
        const tr=si/(steps+1);const tE=easedT(tr,dexp,dm);const f=o.dist===1?tr:tE;
        const C=Q(f);const L={x:lerp(RA.x,RB.x,tE),y:lerp(RA.y,RB.y,tE)};
        let rot=0;if(o.align){rot=tang(f)-ang0;while(rot>Math.PI)rot-=2*Math.PI;while(rot<-Math.PI)rot+=2*Math.PI;}
        out.push(pathAffine(C.x-L.x,C.y-L.y,rot,C.x,C.y));
    }
    return out;
}
function fdApplyAffine(fd,M){
    try{
        if(!fd||!fd.fill)return fd;const ft=fd.fill.fillType.value;
        if(ft===1||ft===FillType.None.value||ft===FillType.Solid.value)return fd;
        const t=fd.transform.data;
        return FillDescriptor.create(fd.fill,fd.isScaleWithObject,affToTransform(composeAffine({data:[t[0],t[1],t[2],t[3],t[4],t[5]]},M)),fd.blendMode,fd.isAnchoredToSpread);
    }catch(e){return fd;}
}
function totalRotDeg(rotDeg,rotTurns,steps){return rotDeg*(steps+1)+(rotTurns||0)*360;}
function buildGeomCurve(cdA,cdB,nC,fpA,fpB,t,dm,dexp,rotDeg,rotTurns,rotDm,rotExp,steps,si){
    const tE=easedT(t,dexp,dm);const angleFrac=(steps+1)>0?si/(steps+1):0;const easedFrac=easedAngle(angleFrac,rotExp,rotDm);const totalAngleDeg=totalRotDeg(rotDeg,rotTurns,steps);const angleRad=(totalAngleDeg*easedFrac)*Math.PI/180;const cosA=Math.cos(angleRad),sinA=Math.sin(angleRad);
    const rotOn=totalAngleDeg!==0&&angleRad!==0;
    const pf=PIVOT_FOLLOWS_DIST?tE:easedFrac;const cx=lerp(fpA.x,fpB.x,pf),cy=lerp(fpA.y,fpB.y,pf);
    const M=PATH_TF?PATH_TF[si]:null;
    const pc=new PolyCurve();
    for(let ci=0;ci<nC;ci++){const dA=cdA[ci],dB=cdB[ci];let mPts=dA.pts.map((p,i)=>({x:lerp(p.x,dB.pts[i].x,tE),y:lerp(p.y,dB.pts[i].y,tE)}));if(rotOn){mPts=mPts.map(p=>{const dx=p.x-cx,dy=p.y-cy;return{x:cx+dx*cosA-dy*sinA,y:cy+dx*sinA+dy*cosA};});}if(M){mPts=mPts.map(p=>apTF(M,p.x,p.y));}if(!mPts.every(p=>isFinite(p.x)&&isFinite(p.y)))return null;const cb=new CurveBuilder();cb.begin(mPts[0]);for(let pi=1;pi<mPts.length;pi++)cb.lineTo(mPts[pi]);if(dA.isClosed||dB.isClosed)cb.close();pc.addCurve(cb.createCurve());}
    return{pc,tE,angleRad,cosA,sinA,cx,cy,rotOn,M};
}
function setDefName(def,label){try{def.setUserDescription(label);}catch(e){try{def.userDescription=label;}catch(e2){}}}
const LS_ZERO=LineStyleDescriptor.createDefault(0);
function scaledLS(ls,wSrc,wTarget){try{if(!ls||!(wSrc>0))return null;return ls.cloneScaled(wTarget/wSrc);}catch(e){return null;}}

// v26: returns only definitions + values per pair; creation happens later in bulk.
// v31: fxFrom 0 = effects from object A, 1 = from object B; rotTurns = full turns.
function createBlendDefsForPair(doc,infoA,infoB,steps,cm,rotDeg,rotTurns,rotDm,rotExp,dm,dexp,applyFX,fxFrom,rotateFill,hideEnds,sampleRes){
    const atA=readAttrs(doc,infoA,sampleRes),atB=readAttrs(doc,infoB,sampleRes);const aA=atA.bAna,aB=atB.bAna;
    const fallbackReason=valPairM1(aA,aB);const fillFallback=!!fallbackReason;
    const hcBrushA=fillFallback?fdToSpread(infoA.node.brushFillDescriptor,infoA.node):null;
    const hcBrushB=fillFallback?fdToSpread(infoB.node.brushFillDescriptor,infoB.node):null;
    const bothAnchored=aA.isGrad&&aB.isGrad&&aA.anchored&&aB.anchored;
    const penBothAnchored=(atA.pAna?.anchored||false)&&(atB.pAna?.anchored||false);
    const nullAna={isNone:true,isSolid:false,isGrad:false,gft:-1,stops:colStops({r:0,g:0,b:0,alpha:0}),solidRGBA:{r:0,g:0,b:0,alpha:0},gfOrig:null,sGeom:solidGeom({x:0,y:0,w:1,h:1}),anchored:false,blendMode:null,origFdTr:null,ft:1};
    const opA=infoA.node.globalOpacity||1,opB=infoB.node.globalOpacity||1;const wA=atA.wt,wB=atB.wt;
    const pAnaA=atA.pAna||nullAna,pAnaB=atB.pAna||nullAna;const hasPenFill=(wA>0||wB>0)&&(!pAnaA.isNone||!pAnaB.isNone);
    const nA=infoA.name,nB=infoB.name;
    function getFP(n){try{const f=n.transformInterface.focalPoint;if(f.isValid)return apTF(tfToSpread(n),f.point.x,f.point.y);}catch(e){}try{const bb=n.getSpreadBaseBox(false);return{x:bb.x+bb.width/2,y:bb.y+bb.height/2};}catch(e){}return{x:0,y:0};}
    const fpA=getFP(infoA.node),fpB=getFP(infoB.node);
    const nCA=atA.curves.length,nCB=atB.curves.length,nC=Math.max(nCA||1,nCB||1);const rNA=nCA>0?atA.curves[0].pts.length:4;
    const cdA=[],cdB=[];
    for(let ci=0;ci<nC;ci++){let pA,pB,cA=true,cB=true;if(ci<nCA){pA=atA.curves[ci].pts;cA=atA.curves[ci].isClosed;}else{pA=ptCurve(fpA.x,fpA.y,rNA);}if(ci<nCB){pB=atB.curves[ci].pts;cB=atB.curves[ci].isClosed;}else{pB=ptCurve(fpB.x,fpB.y,rNA);}const N=Math.max(pA.length,pB.length,4);cdA.push({pts:resample(pA,N),isClosed:cA});cdB.push({pts:resample(pB,N),isClosed:cB});}
    const noneFD=FillDescriptor.createNone();
    function mkItem(t_raw,si,label){
        const res=buildGeomCurve(cdA,cdB,nC,fpA,fpB,t_raw,dm,dexp,rotDeg,rotTurns,rotDm,rotExp,steps,si);if(!res)return null;
        const{pc,tE,cosA,sinA,cx,cy,rotOn,M}=res;
        let brushFD;
        if(fillFallback){
            brushFD=tE<0.5?hcBrushA:hcBrushB;
        }else{
            const brushResult=iFillGeom(aA,aB,tE,cm,bothAnchored);brushFD=brushResult.fd;
            if(rotateFill&&brushResult.geom&&rotOn){brushFD=fdFromGeom(brushResult,rotateGeom(brushResult.geom,cx,cy,cosA,sinA));}
        }
        const wLerp=lerp(wA,wB,tE);
        let lsd=LS_ZERO,penFD=noneFD;
        if(wLerp>0){
            lsd=scaledLS(atA.ls,wA,wLerp)||scaledLS(atB.ls,wB,wLerp)||LineStyleDescriptor.createDefault(wLerp);
            if(hasPenFill){
                if(fillFallback){
                    // v26: hard cut for the stroke as well (v25 left the default stroke here)
                    const src=tE<0.5?infoA.node:infoB.node;
                    try{penFD=fdToSpread(src.penFillDescriptor,src);}catch(e){penFD=noneFD;}
                }else{
                    const penResult=iFillGeom(pAnaA,pAnaB,tE,cm,penBothAnchored);penFD=penResult.fd;
                    if(rotateFill&&penResult.geom&&rotOn){penFD=fdFromGeom(penResult,rotateGeom(penResult.geom,cx,cy,cosA,sinA));}
                }
            }
        }
        if(M){brushFD=fdApplyAffine(brushFD,M);if(penFD!==noneFD)penFD=fdApplyAffine(penFD,M);}
        let def;
        try{def=PolyCurveNodeDefinition.create(pc,brushFD,penFD,lsd,noneFD);}
        catch(e){def=PolyCurveNodeDefinition.create(pc,FillDescriptor.createSolid(RGBA8(128,128,128,255)),penFD,lsd,noneFD);}
        setDefName(def,label);
        const op=(hideEnds&&(t_raw<=0||t_raw>=1))?0:lerp(opA,opB,tE);
        return{def,op};
    }
    const rawA=mkItem(0,0,nA+' [0]');if(!rawA)return{error:'Error in object A ('+nA+')'};
    const morphs=[];
    for(let i=1;i<=steps;i++){const it=mkItem(i/(steps+1),i,nA+'→'+nB+' ['+i+']');if(it)morphs.push(it);}
    const rawB=mkItem(1,steps+1,nB+' ['+(steps+1)+']');if(!rawB)return{error:'Error in object B ('+nB+')'};
    const fxSource=applyFX?(fxFrom===1?infoB.node:infoA.node):null;
    return{rawA,morphs,rawB,fxSource,usedFallback:fillFallback,fallbackReason};
}

// v29: entire output in exactly 4 history entries (independent of the number of pairs):
//  1) master group  2) placing + all sub-groups  3) all objects of all sub-groups
//  (insertion order = stack bottom to top)  4) opacity, FX, time-step transforms.
// v32: PLACE_LAST=false: Standard (first source group found); true: last one found (like Alternative,
//      master group lies above both source groups)
let PLACE_LAST=false;
function topOfPair(doc,nodeA,nodeB){let topNode=nodeA;for(const l of doc.layers.all){if(l.isSameNode(nodeA)){topNode=nodeA;if(!PLACE_LAST)break;}if(l.isSameNode(nodeB)){topNode=nodeB;if(!PLACE_LAST)break;}}return topNode;}
function childArr(n){try{return n.children.toArray();}catch(e){const r=[];for(const c of n.children)r.push(c);return r;}}
function buildOutput(doc,gName,groupA,groupB,groups,stepTF){
    // groups: [{name, items:[{def,op,fxSource}]}] - items bottom to top
    const bm=AddChildNodesCommandBuilder.create();bm.addContainerNode(ContainerNodeDefinition.create(gName));
    const cm=bm.createCommand(false);exec(cm);const master=cm.newNodes[0];if(!master)return null;
    LAST_MASTER=master;
    const c1=CompoundCommandBuilder.create();
    c1.addCommand(DocumentCommand.createMoveNodes(Selection.create(doc,[master]),topOfPair(doc,groupA,groupB),NodeMoveType.After,NodeChildType.Main));
    const bs=AddChildNodesCommandBuilder.create();bs.setInsertionTarget(master);
    for(const g of groups)bs.addContainerNode(ContainerNodeDefinition.create(g.name));
    c1.addCommand(bs.createCommand(false));
    exec(c1.createCommand(false));
    const subs=childArr(master);
    if(subs.length!==groups.length)throw new Error('Sub-groups: '+subs.length+' instead of '+groups.length);
    const c2=CompoundCommandBuilder.create();
    for(let gi=0;gi<groups.length;gi++){
        const bc=AddChildNodesCommandBuilder.create();bc.setInsertionTarget(subs[gi]);
        for(const it of groups[gi].items)bc.addNode(it.def);
        c2.addCommand(bc.createCommand(false));
    }
    exec(c2.createCommand(false));
    const opMap=new Map();const fxJobs=[];
    for(let gi=0;gi<groups.length;gi++){
        const g=groups[gi],nodes=childArr(subs[gi]);
        if(nodes.length!==g.items.length)throw new Error('Objects in sub-group '+(gi+1)+': '+nodes.length+' instead of '+g.items.length);
        for(let k=0;k<nodes.length;k++){
            const it=g.items[k],n=nodes[k];
            if(Math.abs(it.op-1)>1e-6){const key=it.op.toFixed(6);if(!opMap.has(key))opMap.set(key,{op:it.op,nodes:[]});opMap.get(key).nodes.push(n);}
            if(it.fxSource)fxJobs.push({src:it.fxSource,node:n});
        }
    }
    const cb=CompoundCommandBuilder.create();let nCmd=0;
    for(const v of opMap.values()){cb.addCommand(DocumentCommand.createSetOpacity(Selection.create(doc,v.nodes),v.op));nCmd++;}
    // FX: one command per effect and source object for all its copies
    const bySrc=[];for(const j of fxJobs){let e=bySrc.find(x=>x.src.isSameNode(j.src));if(!e){e={src:j.src,nodes:[]};bySrc.push(e);}e.nodes.push(j.node);}
    for(const e of bySrc){
        const lei=e.src.layerEffectsInterface;if(!lei||!lei.hasActiveEffects)continue;
        const sel=Selection.create(doc,e.nodes);const pi={};
        lei.enumerateEffects(fx=>{try{const tv=fx.type.value;pi[tv]=pi[tv]||0;const fn=FX_CMD[tv];if(fn){cb.addCommand(fn(sel,fx.clone(),pi[tv]));nCmd++;}pi[tv]++;}catch(err){}});
    }
    if(stepTF){
        for(let gi=0;gi<subs.length;gi++){const tf=stepTF(gi,subs[gi]);if(tf){cb.addCommand(DocumentCommand.createTransform(Selection.create(doc,[subs[gi]]),tf,{duplicateNodes:false}));nCmd++;}}
    }
    if(nCmd>0)exec(cb.createCommand(false));
    return master;
}
// v33: time-step rotation with full turns and angle distribution (like per-object rotation)
function stepTransformFn(offX,offY,stepRotDeg,stepTurns,stepRotDm,stepRotExp,steps,pivotFn){
    stepTurns=stepTurns||0;
    if(!(offX||offY||stepRotDeg||stepTurns))return null;
    const totalDeg=totalRotDeg(stepRotDeg,stepTurns,steps);
    return function(si,g){
        let bb;try{bb=g.getSpreadBaseBox(false);}catch(e){bb=null;}
        let px=bb?bb.x+bb.width/2:0,py=bb?bb.y+bb.height/2:0;
        if(pivotFn){const pv=pivotFn(si);if(pv&&isFinite(pv.x)&&isFinite(pv.y)){px=pv.x;py=pv.y;}}
        const angRad=totalDeg*easedAngle((steps+1)>0?si/(steps+1):0,stepRotExp,stepRotDm)*Math.PI/180;
        const cosA=Math.cos(angRad),sinA=Math.sin(angRad);
        const tf=Transform.createIdentity();const d=tf.data;
        d[0]=cosA;d[1]=-sinA;d[2]=px-cosA*px+sinA*py+offX*si;
        d[3]=sinA;d[4]=cosA;d[5]=py-sinA*px-cosA*py+offY*si;
        return tf;
    };
}
function withFx(it,src){return{def:it.def,op:it.op,fxSource:src};}
function pairedGroups(pairResults,childrenA,childrenB,masterName){
    const groups=[];
    for(let k=0;k<pairResults.length;k++){
        const pr=pairResults[k];if(pr.error)continue;
        const items=[pr.rawA,...pr.morphs,pr.rawB].map(it=>withFx(it,pr.fxSource));
        groups.push({name:masterName+' – Pair '+(k+1)+': '+childrenA[k].name+' → '+childrenB[k].name,items});
    }
    return groups;
}
function stepGroups(pairResults,steps,masterName){
    const stepCount=steps+2,groups=[];
    for(let si=0;si<stepCount;si++){
        const items=[];
        for(const pr of pairResults){
            if(pr.error)continue;
            let it;if(si===0)it=pr.rawA;else if(si===stepCount-1)it=pr.rawB;else it=pr.morphs[si-1];
            if(it)items.push(withFx(it,pr.fxSource));
        }
        if(!items.length)continue;
        groups.push({si,name:masterName+' – '+(si===0?'T=0':(si===stepCount-1?'T=1':'Step '+si)),items});
    }
    return groups;
}

// v26: complete run outside the dialog (also usable for tests)
function runBlendCore(doc,ctx,gName,p){
    const{childrenA,childrenB,pairCount,groupA,groupB}=ctx;
    let sa,sb;
    if(p.pairMatch===5){
        const m=matchNearestNeighbor(childrenA,childrenB);sa=m.sa;sb=m.sb;
    }else{
        let baseA,baseB;
        switch(p.pairMatch){
            case 1:baseA=sortByGrid(childrenA,'row',true,true);baseB=sortByGrid(childrenB,'row',true,true);break;
            case 2:baseA=sortByGrid(childrenA,'row',true,false);baseB=sortByGrid(childrenB,'row',true,false);break;
            case 3:baseA=sortByGrid(childrenA,'col',true,true);baseB=sortByGrid(childrenB,'col',true,true);break;
            case 4:baseA=sortByGrid(childrenA,'col',true,false);baseB=sortByGrid(childrenB,'col',true,false);break;
            default:baseA=childrenA;baseB=childrenB;
        }
        if(p.pairDir===0){sa=baseA;sb=baseB;}
        else if(p.pairDir===1){sa=baseA;sb=baseB.slice().reverse();}
        else{sa=baseA.slice().reverse();sb=baseB.slice().reverse();}
    }
    if(p.pairOrder===1||p.pairOrder===2){
        const ordered=sortPairsByDistance(sa,sb,p.pairOrder===1);
        sa=ordered.sa;sb=ordered.sb;
    }
    PIVOT_FOLLOWS_DIST=!!p.pivotDist;
    PLACE_LAST=p.placeLast===1;
    PATH_TF=null;
    if(p.pathOn&&ctx.pathSampler){
        const RA=groupRefPoint(groupA,p.refMode),RB=groupRefPoint(groupB,p.refMode);
        PATH_TF=buildPathTF(ctx.pathSampler,RA,RB,p.steps,p.dm,p.dexp,{mode:p.pathMode,dist:p.pathDist,dir:p.pathDir,align:!!p.pathAlign});
    }
    const fxFrom=p.fxFrom===1?1:0;
    const rotTurns=p.rotTurns||0;
    const pairResults=[];const warnings=[];
    for(let k=0;k<pairCount;k++){
        const iA=sa[k],iB=sb[k];
        const fx=p.applyFX&&hasFX(fxFrom===1?iB:iA);
        const r=createBlendDefsForPair(doc,iA,iB,p.steps,p.cm,p.rot,rotTurns,p.rotDm,p.rotExp,p.dm,p.dexp,fx,fxFrom,p.rotateFill,p.hideEnds,p.sampleRes);
        if(r.error){warnings.push('Pair '+(k+1)+' ('+iA.name+' / '+iB.name+'): '+r.error);}
        else if(r.usedFallback){warnings.push('Pair '+(k+1)+' ('+iA.name+' / '+iB.name+'): simplified fill (hard cut) — '+r.fallbackReason);}
        pairResults.push(r);
    }
    let groups,stf=null;
    if(p.sortMode===0){
        groups=pairedGroups(pairResults,sa,sb,gName);
        if(!groups.length)return{structResult:{error:'No valid pairs (geometry error in all pairs).'},warnings};
    }else{
        groups=stepGroups(pairResults,p.steps,gName);
        if(!groups.length)return{structResult:{error:'No valid objects (geometry error in all pairs).'},warnings};
        let pivotFn=null;
        if(p.stepPivot===1){
            // v34: group focal point, interpolated between A and B, moved along the path if active
            const FA=groupRefPoint(groupA,0),FB=groupRefPoint(groupB,0);
            pivotFn=si=>{const tE=easedT(si/(p.steps+1),p.dexp,p.dm);let q={x:lerp(FA.x,FB.x,tE),y:lerp(FA.y,FB.y,tE)};if(PATH_TF&&PATH_TF[si])q=apTF(PATH_TF[si],q.x,q.y);return q;};
        }
        const f=stepTransformFn(p.offX,p.offY,p.stepRot,p.stepTurns,p.stepRotDm,p.stepRotExp,p.steps,pivotFn);
        if(f)stf=(gi,g)=>f(groups[gi].si,g);
    }
    const grp=buildOutput(doc,gName,groupA,groupB,groups,stf);
    if(!grp)return{structResult:{error:'Error creating the master group.'},warnings};
    return{structResult:{grp,count:groups.length},warnings};
}
// v29: undo via the own master group instead of the history position or blind counting.
// Undo is repeated until the master group is no longer in the document; creating it is the
// first own entry. Limit: counted steps + 4, then a safety net.
let STEPS=0,LAST_MASTER=null;
function exec(cmd){doc.executeCommand(cmd);STEPS++;}
function nodeInDoc(n){if(!n)return false;try{for(const l of doc.layers.all)if(l.isSameNode(n))return true;}catch(e){}return false;}
function rollbackPreview(master,counted){
    if(!master)return;
    let k=0;
    while(nodeInDoc(master)&&k<counted+4){try{doc.history.undo();}catch(e){break;}k++;}
    // Safety net: if the master group is still there, it is deleted
    if(nodeInDoc(master)){try{master.delete();}catch(e){}}
}

function buildNodeInfos(doc){
    const arr=[];let si=0;
    for(const l of doc.layers.all){if(!l.curvesInterface)continue;arr.push({node:l,seqIdx:si,isText:l.isArtTextNode===true,name:l.userDescription||l.defaultDescription||('Object '+(si+1))});si++;}
    return arr;
}
function getGroupPairs(doc,nodeInfos,groupNode){
    const result=[];
    for(const child of groupNode.children){
        if(!child.curvesInterface)continue;
        const info=nodeInfos.find(x=>x.node.isSameNode(child));
        if(info)result.push(info);
    }
    return result;
}

function sortByGrid(infos,primaryAxis,primaryAsc,secondaryAsc){
    if(infos.length<=1)return infos.slice();
    const items=infos.map(info=>{
        let bb;try{bb=info.node.getSpreadBaseBox(false);}catch(e){bb={x:0,y:0,width:1,height:1};}
        return{info,cx:bb.x+bb.width/2,cy:bb.y+bb.height/2,w:bb.width||1,h:bb.height||1};
    });
    const isRow=primaryAxis==='row';
    const sizes=items.map(i=>isRow?i.h:i.w).sort((a,b)=>a-b);
    const medSize=sizes[Math.floor(sizes.length/2)]||1;
    const tol=Math.max(1,medSize*0.5);
    const primaryOf=it=>isRow?it.cy:it.cx;
    const secondaryOf=it=>isRow?it.cx:it.cy;
    items.sort((a,b)=>primaryOf(a)-primaryOf(b));
    const clusters=[];
    for(const it of items){
        let c=clusters.find(c=>Math.abs(c.pos-primaryOf(it))<=tol);
        if(!c){c={pos:primaryOf(it),items:[]};clusters.push(c);}
        c.items.push(it);
        c.pos=c.items.reduce((s,x)=>s+primaryOf(x),0)/c.items.length;
    }
    clusters.sort((a,b)=>primaryAsc?a.pos-b.pos:b.pos-a.pos);
    const result=[];
    for(const c of clusters){
        c.items.sort((a,b)=>secondaryAsc?secondaryOf(a)-secondaryOf(b):secondaryOf(b)-secondaryOf(a));
        for(const it of c.items)result.push(it.info);
    }
    return result;
}

function matchNearestNeighbor(childrenA,childrenB){
    function centers(arr){return arr.map(info=>{let bb;try{bb=info.node.getSpreadBaseBox(false);}catch(e){bb={x:0,y:0,width:0,height:0};}return{info,cx:bb.x+bb.width/2,cy:bb.y+bb.height/2};});}
    const A=centers(childrenA),B=centers(childrenB);
    const usedB=new Array(B.length).fill(false);
    const sa=[],sb=[];
    const n=Math.min(A.length,B.length);
    for(const a of A){
        let bestJ=-1,bestD=Infinity;
        for(let j=0;j<B.length;j++){
            if(usedB[j])continue;
            const dx=a.cx-B[j].cx,dy=a.cy-B[j].cy;const d=dx*dx+dy*dy;
            if(d<bestD){bestD=d;bestJ=j;}
        }
        if(bestJ===-1)continue;
        usedB[bestJ]=true;
        sa.push(a.info);sb.push(B[bestJ].info);
        if(sa.length>=n)break;
    }
    return{sa,sb};
}

function pairDistance(infoA,infoB){
    let bbA,bbB;
    try{bbA=infoA.node.getSpreadBaseBox(false);}catch(e){bbA={x:0,y:0,width:0,height:0};}
    try{bbB=infoB.node.getSpreadBaseBox(false);}catch(e){bbB={x:0,y:0,width:0,height:0};}
    const ax=bbA.x+bbA.width/2,ay=bbA.y+bbA.height/2;
    const bx=bbB.x+bbB.width/2,by=bbB.y+bbB.height/2;
    const dx=ax-bx,dy=ay-by;
    return Math.sqrt(dx*dx+dy*dy);
}
function sortPairsByDistance(sa,sb,ascending){
    const EPS=0.01;
    const idx=sa.map((_,i)=>i);
    const dist=idx.map(i=>pairDistance(sa[i],sb[i]));
    idx.sort((i,j)=>{
        const d=dist[i]-dist[j];
        if(Math.abs(d)<EPS)return i-j;
        return ascending?d:-d;
    });
    return{sa:idx.map(i=>sa[i]),sb:idx.map(i=>sb[i])};
}

const PRESETS_DIR=app.userDesktopPath+'/AffinityScriptPresets';
const PRESET_PREFIX='GroupMorphing_';

function sanitizePresetName(name){
    return String(name||'').trim().replace(/[^a-zA-Z0-9 _-]/g,'_').slice(0,80);
}
function presetPath(name){
    return PRESETS_DIR+'/'+PRESET_PREFIX+sanitizePresetName(name)+'.json';
}
function savePresetToDisk(name,dataObj){
    try{
        FileSystemApi.createDirectories(PRESETS_DIR);
        const f=File.create(presetPath(name),'w');
        f.writeStringAsUtf8(JSON.stringify(dataObj,null,2));
        f.close();
        return true;
    }catch(e){
        console.log('WARNING: preset could not be saved - '+e);
        return false;
    }
}
function loadPresetFromPath(path){
    try{
        const buf=File.readAll(path);
        return JSON.parse(buf.toString('utf8'));
    }catch(e){
        console.log('WARNING: preset could not be loaded - '+e);
        return null;
    }
}
function deletePresetAtPath(path){
    try{
        FileSystemApi.remove(path);
        return true;
    }catch(e){
        console.log('WARNING: preset could not be deleted - '+e);
        return false;
    }
}

const doc=Document.current;
if(!doc){console.log('No document.');}else{
    const nodeInfos=buildNodeInfos(doc);
    const selGroups=[];
    try{const sel=doc.selection;for(let i=0;i<sel.length;i++){const n=sel.at(i).node;if(n&&n.children&&n.children.length>0)selGroups.push(n);}}catch(e){}
    if(selGroups.length!==2){
        const ed=Dialog.create('Error');const ec=ed.addColumn();const eg=ec.addGroup('');
        eg.addStaticText('','Please select exactly 2 groups. Currently: '+selGroups.length+'.');
        eg.addButtonSet('',['Close'],0);ed.runModal();
    }else{
        let groupA=selGroups[0],groupB=selGroups[1];
        const origSel=[groupA,groupB];
        function groupName(g){return g.userDescription||g.defaultDescription||'Group';}
        function getPairs(){const ca=getGroupPairs(doc,nodeInfos,groupA);const cb=getGroupPairs(doc,nodeInfos,groupB);return{ca,cb,n:Math.min(ca.length,cb.length)};}
        let{ca:childrenA,cb:childrenB,n:pairCount}=getPairs();
        if(pairCount===0){
            const ed=Dialog.create('Error');const ec=ed.addColumn();const eg=ec.addGroup('');
            eg.addStaticText('','No matching object pairs found (at least 1 vector object per group required).');
            eg.addButtonSet('',['Close'],0);ed.runModal();
        }else{
            let maxGi=-1;
            for(const l of doc.layers.all){
                try{
                    const d=l.userDescription||'';
                    if(d.includes('[Preview]'))continue;
                    const m=d.match(/^Group Morphing (\d+)/);
                    if(m){const num=parseInt(m[1],10);if(!isNaN(num)&&num>maxGi)maxGi=num;}
                }catch(e){}
            }
            let gi=maxGi+1;

            const dlg=Dialog.create('Group Morphing');dlg.initialWidth=760;dlg.setIsResizable(true);
            const cNav=dlg.addColumn();cNav.widthProportion=0.7;
            const cA=dlg.addColumn();cA.widthProportion=1.6;
            const PAGES=[[],[],[],[],[]];
            function pageGroup(pi,col,title){const g=col.addGroup(title);PAGES[pi].push(g);return g;}
            let pagedOK=true;
            function showPage(i){
                if(!pagedOK)return;
                try{for(let k=0;k<PAGES.length;k++)for(const g of PAGES[k])g.isVisible=(k===i);}
                catch(e){
                    pagedOK=false;
                    try{for(const pgl of PAGES)for(const g of pgl)g.isVisible=true;}catch(e2){}
                    console.log('Tabs not available: '+e.message);
                }
            }

            const gNav=cNav.addGroup('Tabs');
            const rNav=gNav.addRadioGroup('',['1  Pairs','2  Result','3  Curve & colour','4  Rotation & effects','5  Path'],0);
            const go=cNav.addGroup('Selected groups');
            const tA=go.addStaticText('Group A:',groupName(groupA)+' ('+childrenA.length+' objects)');
            const tB=go.addStaticText('Group B:',groupName(groupB)+' ('+childrenB.length+' objects)');
            const tN=go.addStaticText('Pairs:',String(pairCount));
            const gact=cNav.addGroup('Actions');
            const btnSwap=gact.addButton('↕ Swap');
            const btnPreview=gact.addButton('👁 Preview');
            const gpreset=cNav.addGroup('Presets');
            const btnPresetSave=gpreset.addButton('💾 Save…');
            const btnPresetLoad=gpreset.addButton('📂 Load…');
            const btnPresetDelete=gpreset.addButton('🗑 Delete…');
            const gWarn=cNav.addGroup('Notes');const tWarn=gWarn.addStaticText('','');

            const gbx=pageGroup(0,cA,'Blend');const tbS=gbx.addTextBox('Intermediate steps:','5');const tbSR=gbx.addTextBox('Sample resolution:','40');
            const gpm=pageGroup(0,cA,'Pair matching');
            const rbPM=gpm.addRadioGroup('Criterion:',['By layer order','Row-wise: left→right','Row-wise: right→left','Column-wise: top→bottom','Column-wise: bottom→top','Nearest neighbour (distance)'],1);
            const rbDir=gpm.addRadioGroup('Direction (layer order / row / column only):',['Forward','Crosswise (A forward, B backward)','Both backward'],0);

            const gs=pageGroup(1,cA,'Sorting of result groups');
            const rbS=gs.addRadioGroup('',['Group by object pairs','Group by time steps (T=0 → T=1)'],0);
            const rbPO=gs.addRadioGroup('Order (stacking of pairs):',['Unchanged (as matched)','Distance: small→large (explosion)','Distance: large→small (implosion)'],0);
            const gvis=pageGroup(1,cA,'Visibility');
            const cbHideEnds=gvis.addCheckBox('Only intermediate steps visible (hide A/B)',false);
            const gpl=pageGroup(1,cA,'Placement of the master group');
            const rbPlace=gpl.addRadioGroup('',['Standard (like Group Morphing)','Above both source groups (like Alternative)'],0);
            const gso=pageGroup(1,cA,'Time-step offset/rotation (time-step sorting only)');
            const tbOffX=gso.addTextBox('Offset X per step:','0');
            const tbOffY=gso.addTextBox('Offset Y per step:','0');
            const tbStepRot=gso.addTextBox('Rotation per step (degrees):','0');
            const tbStepTurns=gso.addTextBox('Full turns:','0');
            const rbStepRD=gso.addRadioGroup('Angle distribution:',['Linear','Ease in','Ease out','S-curve'],0);
            const tbStepRE=gso.addTextBox('Angle exponent:','2.0');
            const rbStepPivot=gso.addRadioGroup('Pivot:',['Group centre (time-step group)','Group focal point (between A and B)'],0);
            const tStepRotInfo=gso.addStaticText('','');

            const gd=pageGroup(2,cA,'Positions / opacity curve');const rbD=gd.addRadioGroup('Spacing:',['Linear','Ease in','Ease out','S-curve'],0);const tbE=gd.addTextBox('Exponent:','2.0');
            const gc2=pageGroup(2,cA,'Colour blend');const rbC=gc2.addRadioGroup('Mode:',['Linear','Colour wheel right','Colour wheel left','RGB (direct)','Colour wheel max. (longest path)','Colour wheel min. (shortest path)'],0);

            const gr=pageGroup(3,cA,'Rotation (per object)');
            const tbR=gr.addTextBox('Increment (degrees):','0');
            const tbTurns=gr.addTextBox('Full turns:','0');
            const rbRD=gr.addRadioGroup('Angle distribution:',['Linear','Ease in','Ease out','S-curve'],0);const tbRE=gr.addTextBox('Angle exponent:','2.0');const cbRotFill=gr.addCheckBox('Rotate fill',true);const cbPivotDist=gr.addCheckBox('Pivot follows spacing curve',false);
            const tRotInfo=gr.addStaticText('','');

            // v31: FX source selectable (A or B)
            const gfx=pageGroup(3,cA,'Layer effects (FX)');
            function fxSide(){try{return rbFXSrc.selectedIndex===1?1:0;}catch(e){return 0;}}
            function sideHasFX(side){return (side===1?childrenB:childrenA).some(hasFX);}
            function fxInfoText(side){const n=side===1?'B':'A';return sideHasFX(side)?('At least one object '+n+' has layer effects'):('No objects '+n+' with layer effects');}
            const cbFX=gfx.addCheckBox('Transfer FX',sideHasFX(0));
            const rbFXSrc=gfx.addRadioGroup('Source per pair:',['From object A','From object B'],0);
            const tFX=gfx.addStaticText('',fxInfoText(0));

            // v32: tab 5 - path
            const pathNode=findPathNode(doc,[groupA,groupB]);
            const pathSampler=pathNode?samplePathNode(pathNode,400):null;
            const gpa=pageGroup(4,cA,'Group along a path');
            gpa.addStaticText('',pathSampler?('✓ Path found: '+(pathNode.userDescription||pathNode.defaultDescription)):(pathNode?'⚠ Path "'+(pathNode.userDescription||'')+'" not readable':'No path found (vector object, name starting with "_")'));
            const cbPath=gpa.addCheckBox('Blend along path',!!pathSampler);
            const rbPathMode=gpa.addRadioGroup('Mode:',['Relative (path shape fitted between A and B)','Absolute (reference point exactly on the path)'],0);
            const rbPathDist=gpa.addRadioGroup('Distribution on the path:',['By spacing curve','Even (arc length)'],0);
            const rbPathDir=gpa.addRadioGroup('Path direction:',['Automatic','As drawn','Reversed'],0);
            const cbPathAlign=gpa.addCheckBox('Align to path (tangent)',false);
            const gref=pageGroup(4,cA,'Reference point of the group');
            const rbRef=gref.addRadioGroup('',['Focal point (otherwise centre)','Centre (bounding box)'],0);

            // v26: radio groups ignore their start index -> set explicitly
            try{rbPM.selectedIndex=1;rbDir.selectedIndex=0;rbS.selectedIndex=0;rbPO.selectedIndex=0;rbD.selectedIndex=0;rbC.selectedIndex=0;rbRD.selectedIndex=0;rbFXSrc.selectedIndex=0;rbPlace.selectedIndex=0;rbPathMode.selectedIndex=0;rbPathDist.selectedIndex=0;rbPathDir.selectedIndex=0;rbRef.selectedIndex=0;rbStepRD.selectedIndex=0;rbStepPivot.selectedIndex=0;}catch(e){}
            rNav.selectedIndex=0;
            showPage(0);
            try{rNav.setOnValueChangedHandler(()=>{showPage(rNav.selectedIndex);});}catch(e){}
            function updateFXInfo(setCheck){
                const s=fxSide();
                if(setCheck){try{cbFX.value=sideHasFX(s);}catch(e){}}
                try{tFX.setText(fxInfoText(s));}catch(e){}
            }
            try{rbFXSrc.setOnValueChangedHandler(()=>{updateFXInfo(true);});}catch(e){}
            function parseTurns(){const v=parseFloat((tbTurns.text||'0').replace(',','.'));return isFinite(v)?Math.round(v):0;}
            function updateRotInfo(){
                try{
                    const st=Math.max(1,parseInt(tbS.text,10)||5);
                    const inc=parseFloat((tbR.text||'0').replace(',','.'))||0;
                    const tot=totalRotDeg(inc,parseTurns(),st);
                    tRotInfo.setText('Total angle A→B: '+(Math.round(tot*100)/100)+'°');
                }catch(e){}
            }
            try{tbR.setOnValueChangedHandler(updateRotInfo);}catch(e){}
            try{tbTurns.setOnValueChangedHandler(updateRotInfo);}catch(e){}
            try{tbS.setOnValueChangedHandler(()=>{updateRotInfo();updateStepRotInfo();});}catch(e){}
            updateRotInfo();
            function parseStepTurns(){const v=parseFloat((tbStepTurns.text||'0').replace(',','.'));return isFinite(v)?Math.round(v):0;}
            function updateStepRotInfo(){
                try{
                    const st=Math.max(1,parseInt(tbS.text,10)||5);
                    const inc=parseFloat((tbStepRot.text||'0').replace(',','.'))||0;
                    const tot=totalRotDeg(inc,parseStepTurns(),st);
                    tStepRotInfo.setText('Total angle T=0→T=1: '+(Math.round(tot*100)/100)+'°');
                }catch(e){}
            }
            try{tbStepRot.setOnValueChangedHandler(updateStepRotInfo);}catch(e){}
            try{tbStepTurns.setOnValueChangedHandler(updateStepRotInfo);}catch(e){}
            updateStepRotInfo();

            // v29: the preview is undone until its master group has disappeared.
            let pg=null;
            let previewKey=null;
            let pvSteps=0;
            function restoreSel(){try{doc.executeCommand(DocumentCommand.createSetSelection(Selection.create(doc,origSel)));}catch(e){}}
            function clrPv(){
                if(pg){rollbackPreview(pg,pvSteps);restoreSel();}
                pg=null;previewKey=null;pvSteps=0;
            }
            function refresh(){
                clrPv();
                const p=getP();
                const gn='Group Morphing '+gi;
                const sm=p.sortMode===0?'Pairs':'Time steps';
                const t0=Date.now();
                STEPS=0;LAST_MASTER=null;
                let res;
                try{res=runBlendCore(doc,{childrenA,childrenB,pairCount,groupA,groupB,pathSampler},gn,p);}
                catch(e){rollbackPreview(LAST_MASTER,STEPS);STEPS=0;restoreSel();try{tWarn.setText('Error: '+e.message);}catch(e2){}return false;}
                const{structResult,warnings}=res;
                if(structResult.error){rollbackPreview(LAST_MASTER,STEPS);STEPS=0;restoreSel();try{tWarn.setText(structResult.error);}catch(e){}return false;}
                pg=structResult.grp;
                pvSteps=STEPS;
                previewKey=JSON.stringify(p);
                let msg=gn+' ['+sm+'] ('+pairCount+' pairs, '+structResult.count+' sub-groups, '+STEPS+' history steps, '+(Date.now()-t0)+' ms)';
                if(warnings.length)msg+=' — '+warnings.length+' note(s)';
                console.log(msg);
                try{tWarn.setText(warnings.length?warnings.join(' | '):'');}catch(e){}
                return true;
            }
            function updateNames(){
                try{tA.setText(groupName(groupA)+' ('+childrenA.length+' objects)');}catch(e){try{tA.text=groupName(groupA)+' ('+childrenA.length+' objects)';}catch(e2){}}
                try{tB.setText(groupName(groupB)+' ('+childrenB.length+' objects)');}catch(e){try{tB.text=groupName(groupB)+' ('+childrenB.length+' objects)';}catch(e2){}}
                try{tN.setText(String(pairCount));}catch(e){try{tN.text=String(pairCount);}catch(e2){}}
                updateFXInfo(true);
                try{tWarn.setText('');}catch(e){}
            }
            function getP(){return{
                pairMatch:rbPM.selectedIndex,
                pairDir:rbDir.selectedIndex,
                pairOrder:rbPO.selectedIndex,
                sortMode:rbS.selectedIndex,
                steps:Math.max(1,parseInt(tbS.text,10)||5),
                sampleRes:Math.max(4,parseInt(tbSR.text,10)||40),
                cm:rbC.selectedIndex,
                rot:parseFloat((tbR.text||'0').replace(',','.'))||0,
                rotTurns:parseTurns(),
                rotDm:rbRD.selectedIndex,
                rotExp:Math.max(0.1,parseFloat((tbRE.text||'2').replace(',','.'))||2),
                dm:rbD.selectedIndex,
                dexp:Math.max(0.1,parseFloat((tbE.text||'2').replace(',','.'))||2),
                applyFX:cbFX.value,
                fxFrom:fxSide(),
                rotateFill:cbRotFill.value,
                pivotDist:cbPivotDist.value,
                hideEnds:cbHideEnds.value,
                offX:parseFloat((tbOffX.text||'0').replace(',','.'))||0,
                offY:parseFloat((tbOffY.text||'0').replace(',','.'))||0,
                stepRot:parseFloat((tbStepRot.text||'0').replace(',','.'))||0,
                stepTurns:parseStepTurns(),
                stepRotDm:rbStepRD.selectedIndex||0,
                stepRotExp:Math.max(0.1,parseFloat((tbStepRE.text||'2').replace(',','.'))||2),
                stepPivot:rbStepPivot.selectedIndex===1?1:0,
                placeLast:rbPlace.selectedIndex===1?1:0,
                pathOn:!!(cbPath.value&&pathSampler),
                pathMode:rbPathMode.selectedIndex===1?1:0,
                pathDist:rbPathDist.selectedIndex===1?1:0,
                pathDir:rbPathDir.selectedIndex||0,
                pathAlign:!!cbPathAlign.value,
                refMode:rbRef.selectedIndex===1?1:0
            };}
            function applyPreset(d){
                try{rbPM.selectedIndex=d.pairMatch??1;}catch(e){}
                try{rbDir.selectedIndex=d.pairDir??0;}catch(e){}
                try{rbPO.selectedIndex=d.pairOrder??0;}catch(e){}
                try{rbS.selectedIndex=d.sortMode??0;}catch(e){}
                try{tbS.text=String(d.steps??5);}catch(e){}
                try{tbSR.text=String(d.sampleRes??40);}catch(e){}
                try{rbC.selectedIndex=d.cm??0;}catch(e){}
                try{tbR.text=String(d.rot??0);}catch(e){}
                try{tbTurns.text=String(d.rotTurns??0);}catch(e){}
                try{rbRD.selectedIndex=d.rotDm??0;}catch(e){}
                try{tbRE.text=String(d.rotExp??2);}catch(e){}
                try{rbD.selectedIndex=d.dm??0;}catch(e){}
                try{tbE.text=String(d.dexp??2);}catch(e){}
                try{rbFXSrc.selectedIndex=d.fxFrom===1?1:0;}catch(e){}
                try{cbFX.value=!!d.applyFX;}catch(e){}
                updateFXInfo(false);
                try{cbRotFill.value=!!d.rotateFill;}catch(e){}
                try{cbPivotDist.value=!!d.pivotDist;}catch(e){}
                try{cbHideEnds.value=!!d.hideEnds;}catch(e){}
                try{tbOffX.text=String(d.offX??0);}catch(e){}
                try{tbOffY.text=String(d.offY??0);}catch(e){}
                try{tbStepRot.text=String(d.stepRot??0);}catch(e){}
                try{tbStepTurns.text=String(d.stepTurns??0);}catch(e){}
                try{rbStepRD.selectedIndex=d.stepRotDm??0;}catch(e){}
                try{tbStepRE.text=String(d.stepRotExp??2);}catch(e){}
                try{rbStepPivot.selectedIndex=d.stepPivot===1?1:0;}catch(e){}
                try{rbPlace.selectedIndex=d.placeLast===1?1:0;}catch(e){}
                try{cbPath.value=!!d.pathOn&&!!pathSampler;}catch(e){}
                try{rbPathMode.selectedIndex=d.pathMode===1?1:0;}catch(e){}
                try{rbPathDist.selectedIndex=d.pathDist===1?1:0;}catch(e){}
                try{rbPathDir.selectedIndex=d.pathDir||0;}catch(e){}
                try{cbPathAlign.value=!!d.pathAlign;}catch(e){}
                try{rbRef.selectedIndex=d.refMode===1?1:0;}catch(e){}
                updateRotInfo();
                updateStepRotInfo();
            }

            btnSwap.setOnClickHandler(()=>{
                clrPv();
                const tmp=groupA;groupA=groupB;groupB=tmp;
                const np=getPairs();childrenA=np.ca;childrenB=np.cb;pairCount=np.n;
                updateNames();
            });
            btnPreview.setOnClickHandler(()=>{refresh();});

            btnPresetSave.setOnClickHandler(()=>{
                const name=app.prompt('Preset name:','Save preset','');
                if(!name||!name.trim()){console.log('Save cancelled — no name entered.');return;}
                if(savePresetToDisk(name,getP())){
                    console.log('Preset "'+name.trim()+'" saved in '+PRESETS_DIR+'.');
                    try{tWarn.setText('Preset saved: '+name.trim());}catch(e){}
                }
            });
            btnPresetLoad.setOnClickHandler(()=>{
                const path=app.chooseFile();
                if(!path){console.log('Load cancelled.');return;}
                const d=loadPresetFromPath(path);
                if(!d)return;
                clrPv();
                applyPreset(d);
                console.log('Preset loaded from "'+path+'".');
                try{tWarn.setText('Preset loaded.');}catch(e){}
            });
            btnPresetDelete.setOnClickHandler(()=>{
                const path=app.chooseFile();
                if(!path){console.log('Delete cancelled.');return;}
                if(deletePresetAtPath(path)){
                    console.log('Preset file "'+path+'" deleted.');
                    try{tWarn.setText('Preset deleted.');}catch(e){}
                }
            });

            const res=dlg.runModal();
            if(!res||res.value!==DialogResult.Ok.value){
                clrPv();
                console.log('Cancelled.');
            }else{
                const gn='Group Morphing '+gi;
                if(pg&&previewKey===JSON.stringify(getP())){
                    console.log('✓ '+gn+' (preview applied, no recomputation)');
                }else if(refresh()){
                    console.log('✓ '+gn+' applied');
                }
            }
        }
    }
} // End
