'use strict';
// GROUP MORPHING ALTERNATIVE v13 (English GUI variant of "Gruppen-Morphing-Alternative v13"; base: Group Morphing v27)
//
// v13: FIX preview with a full undo history (2048 entries) as in base v27: history steps are
//      counted and undone exactly that many times.
// v12: performance rework as in base v26 (result unchanged):
//      - Objects are computed purely in JavaScript and created with ONE command per sub-group;
//        insertion order gives the stacking (stackInOrder/reorderChildren no longer needed).
//      - Opacity, "hide A/B", FX and time-step offset/rotation as ONE compound command.
//      - No more temporary anchoring of gradients to the spread; fill transform computed directly
//        in spread coordinates via the parent chain (verified live, deviation 0.0000).
//      - Also fixed: hard cut from transformed groups positioned correctly, hard cut for the
//        stroke as well, gradients move with time-step offset/rotation.
// v11: stacking order 3.3.3. v10: toColour() for gradient stops (3.3.3).
//
// VARIANT of "Group Morphing" - the only functional change: the placement of the master group
// in the layer stack (see topOfPair()). The search for Group A/B runs to the end, so the master
// group is inserted after the LAST source node found and thus lies above BOTH source groups.
// Other differences: dialog title "Group Morphing Alternative" and preset prefix
// "GroupMorphingAlternative_". Object/group names are identical to the base script.

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

function valPairM1(aA,aB){const INTERP=[1,2,3];if(!INTERP.includes(aA.ft))return'\u26a0 Fill A ('+ftName(aA.ft)+') cannot be interpolated.';if(!INTERP.includes(aB.ft))return'\u26a0 Fill B ('+ftName(aB.ft)+') cannot be interpolated.';if(aA.isGrad&&aB.isGrad&&aA.gft!==aB.gft){const n=['Linear','Elliptical','Radial','Conical'];return'\u26a0 Different gradient types ('+n[aA.gft]+'/'+n[aB.gft]+').';}return null;}
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
function buildGeomCurve(cdA,cdB,nC,fpA,fpB,t,dm,dexp,rotDeg,rotDm,rotExp,steps,si){
    const tE=easedT(t,dexp,dm);const angleFrac=(steps+1)>0?si/(steps+1):0;const easedFrac=easedAngle(angleFrac,rotExp,rotDm);const totalAngleDeg=rotDeg*(steps+1);const angleRad=(totalAngleDeg*easedFrac)*Math.PI/180;const cosA=Math.cos(angleRad),sinA=Math.sin(angleRad);
    const cx=lerp(fpA.x,fpB.x,easedFrac),cy=lerp(fpA.y,fpB.y,easedFrac);
    const pc=new PolyCurve();
    for(let ci=0;ci<nC;ci++){const dA=cdA[ci],dB=cdB[ci];let mPts=dA.pts.map((p,i)=>({x:lerp(p.x,dB.pts[i].x,tE),y:lerp(p.y,dB.pts[i].y,tE)}));if(rotDeg!==0&&angleRad!==0){mPts=mPts.map(p=>{const dx=p.x-cx,dy=p.y-cy;return{x:cx+dx*cosA-dy*sinA,y:cy+dx*sinA+dy*cosA};});}if(!mPts.every(p=>isFinite(p.x)&&isFinite(p.y)))return null;const cb=new CurveBuilder();cb.begin(mPts[0]);for(let pi=1;pi<mPts.length;pi++)cb.lineTo(mPts[pi]);if(dA.isClosed||dB.isClosed)cb.close();pc.addCurve(cb.createCurve());}
    return{pc,tE,angleRad,cosA,sinA,cx,cy};
}
function setDefName(def,label){try{def.setUserDescription(label);}catch(e){try{def.userDescription=label;}catch(e2){}}}
const LS_ZERO=LineStyleDescriptor.createDefault(0);
function scaledLS(ls,wSrc,wTarget){try{if(!ls||!(wSrc>0))return null;return ls.cloneScaled(wTarget/wSrc);}catch(e){return null;}}

// v26: returns only definitions + values per pair; creation happens later in bulk.
function createBlendDefsForPair(doc,infoA,infoB,steps,cm,rotDeg,rotDm,rotExp,dm,dexp,applyFX,rotateFill,hideEnds,sampleRes){
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
        const res=buildGeomCurve(cdA,cdB,nC,fpA,fpB,t_raw,dm,dexp,rotDeg,rotDm,rotExp,steps,si);if(!res)return null;
        const{pc,tE,angleRad,cosA,sinA,cx,cy}=res;
        let brushFD;
        if(fillFallback){
            brushFD=tE<0.5?hcBrushA:hcBrushB;
        }else{
            const brushResult=iFillGeom(aA,aB,tE,cm,bothAnchored);brushFD=brushResult.fd;
            if(rotateFill&&brushResult.geom&&rotDeg!==0&&angleRad!==0){brushFD=fdFromGeom(brushResult,rotateGeom(brushResult.geom,cx,cy,cosA,sinA));}
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
                    if(rotateFill&&penResult.geom&&rotDeg!==0&&angleRad!==0){penFD=fdFromGeom(penResult,rotateGeom(penResult.geom,cx,cy,cosA,sinA));}
                }
            }
        }
        let def;
        try{def=PolyCurveNodeDefinition.create(pc,brushFD,penFD,lsd,noneFD);}
        catch(e){def=PolyCurveNodeDefinition.create(pc,FillDescriptor.createSolid(RGBA8(128,128,128,255)),penFD,lsd,noneFD);}
        setDefName(def,label);
        const op=(hideEnds&&(t_raw<=0||t_raw>=1))?0:lerp(opA,opB,tE);
        return{def,op};
    }
    const rawA=mkItem(0,0,nA+' [0]');if(!rawA)return{error:'Error in object A ('+nA+')'};
    const morphs=[];
    for(let i=1;i<=steps;i++){const it=mkItem(i/(steps+1),i,nA+'\u2192'+nB+' ['+i+']');if(it)morphs.push(it);}
    const rawB=mkItem(1,steps+1,nB+' ['+(steps+1)+']');if(!rawB)return{error:'Error in object B ('+nB+')'};
    return{rawA,morphs,rawB,fxSource:applyFX?infoA.node:null,usedFallback:fillFallback,fallbackReason};
}

// v26: entire output with few commands.
//  1 command master group, 1 move, 1 command all sub-groups, 1 command per sub-group for
//  its objects (insertion order = stack bottom to top, verified live),
//  then 1 compound for opacity, FX and time-step transforms.
// ALTERNATIVE: no break - topNode ends up pointing at the LAST source node found.
function topOfPair(doc,nodeA,nodeB){let topNode=nodeA;for(const l of doc.layers.all){if(l.isSameNode(nodeA)){topNode=nodeA;}if(l.isSameNode(nodeB)){topNode=nodeB;}}return topNode;}
function childArr(n){try{return n.children.toArray();}catch(e){const r=[];for(const c of n.children)r.push(c);return r;}}
function buildOutput(doc,gName,groupA,groupB,groups,stepTF){
    // groups: [{name, items:[{def,op,fxSource}]}] - items bottom to top
    const bm=AddChildNodesCommandBuilder.create();bm.addContainerNode(ContainerNodeDefinition.create(gName));
    const cm=bm.createCommand(false);exec(cm);const master=cm.newNodes[0];if(!master)return null;
    try{exec(DocumentCommand.createMoveNodes(Selection.create(doc,[master]),topOfPair(doc,groupA,groupB),NodeMoveType.After,NodeChildType.Main));}catch(e){}
    const bs=AddChildNodesCommandBuilder.create();bs.setInsertionTarget(master);
    for(const g of groups)bs.addContainerNode(ContainerNodeDefinition.create(g.name));
    exec(bs.createCommand(false));
    const subs=childArr(master);
    if(subs.length!==groups.length)throw new Error('Sub-groups: '+subs.length+' instead of '+groups.length);
    const opMap=new Map();const fxJobs=[];
    for(let gi=0;gi<groups.length;gi++){
        const g=groups[gi],sub=subs[gi];
        const bc=AddChildNodesCommandBuilder.create();bc.setInsertionTarget(sub);
        for(const it of g.items)bc.addNode(it.def);
        exec(bc.createCommand(false));
        const nodes=childArr(sub);
        for(let k=0;k<nodes.length&&k<g.items.length;k++){
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
    if(nCmd>0)exec(cb.createCommand());
    return master;
}
function stepTransformFn(offX,offY,stepRotDeg){
    if(!(offX||offY||stepRotDeg))return null;
    return function(si,g){
        let bb;try{bb=g.getSpreadBaseBox(false);}catch(e){bb=null;}
        const px=bb?bb.x+bb.width/2:0,py=bb?bb.y+bb.height/2:0;
        const angRad=stepRotDeg*si*Math.PI/180;
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
        groups.push({name:masterName+' \u2013 Pair '+(k+1)+': '+childrenA[k].name+' \u2192 '+childrenB[k].name,items});
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
        groups.push({si,name:masterName+' \u2013 '+(si===0?'T=0':(si===stepCount-1?'T=1':'Step '+si)),items});
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
    const pairResults=[];const warnings=[];
    for(let k=0;k<pairCount;k++){
        const iA=sa[k],iB=sb[k];
        const fx=p.applyFX&&hasFX(iA);
        const r=createBlendDefsForPair(doc,iA,iB,p.steps,p.cm,p.rot,p.rotDm,p.rotExp,p.dm,p.dexp,fx,p.rotateFill,p.hideEnds,p.sampleRes);
        if(r.error){warnings.push('Pair '+(k+1)+' ('+iA.name+' / '+iB.name+'): '+r.error);}
        else if(r.usedFallback){warnings.push('Pair '+(k+1)+' ('+iA.name+' / '+iB.name+'): simplified fill (hard cut) \u2014 '+r.fallbackReason);}
        pairResults.push(r);
    }
    let groups,stf=null;
    if(p.sortMode===0){
        groups=pairedGroups(pairResults,sa,sb,gName);
        if(!groups.length)return{structResult:{error:'No valid pairs (geometry error in all pairs).'},warnings};
    }else{
        groups=stepGroups(pairResults,p.steps,gName);
        if(!groups.length)return{structResult:{error:'No valid objects (geometry error in all pairs).'},warnings};
        const f=stepTransformFn(p.offX,p.offY,p.stepRot);
        if(f)stf=(gi,g)=>f(groups[gi].si,g);
    }
    const grp=buildOutput(doc,gName,groupA,groupB,groups,stf);
    if(!grp)return{structResult:{error:'Error creating the master group.'},warnings};
    return{structResult:{grp,count:groups.length},warnings};
}
// v27: history steps created are counted and the preview is undone exactly that many times.
// With a full history (2048 entries) doc.history.position no longer increases - resetting via
// the position would then have had no effect.
let STEPS=0;
function exec(cmd){doc.executeCommand(cmd);STEPS++;}
function undoSteps(n){for(let i=0;i<n;i++){try{doc.history.undo();}catch(e){break;}}}

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
const PRESET_PREFIX='GroupMorphingAlternative_';

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

            const dlg=Dialog.create('Group Morphing Alternative');dlg.initialWidth=760;dlg.setIsResizable(true);
            const cNav=dlg.addColumn();cNav.widthProportion=0.7;
            const cA=dlg.addColumn();cA.widthProportion=1.6;
            const PAGES=[[],[],[],[]];
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
            const rNav=gNav.addRadioGroup('',['1  Pairs','2  Result','3  Curve & colour','4  Rotation & effects'],0);
            const go=cNav.addGroup('Selected groups');
            const tA=go.addStaticText('Group A:',groupName(groupA)+' ('+childrenA.length+' objects)');
            const tB=go.addStaticText('Group B:',groupName(groupB)+' ('+childrenB.length+' objects)');
            const tN=go.addStaticText('Pairs:',String(pairCount));
            const gact=cNav.addGroup('Actions');
            const btnSwap=gact.addButton('\u2195 Swap');
            const btnPreview=gact.addButton('\ud83d\udc41 Preview');
            const gpreset=cNav.addGroup('Presets');
            const btnPresetSave=gpreset.addButton('\ud83d\udcbe Save\u2026');
            const btnPresetLoad=gpreset.addButton('\ud83d\udcc2 Load\u2026');
            const btnPresetDelete=gpreset.addButton('\ud83d\uddd1 Delete\u2026');
            const gWarn=cNav.addGroup('Notes');const tWarn=gWarn.addStaticText('','');

            const gbx=pageGroup(0,cA,'Blend');const tbS=gbx.addTextBox('Intermediate steps:','5');const tbSR=gbx.addTextBox('Sample resolution:','40');
            const gpm=pageGroup(0,cA,'Pair matching');
            const rbPM=gpm.addRadioGroup('Criterion:',['By layer order','Row-wise: left\u2192right','Row-wise: right\u2192left','Column-wise: top\u2192bottom','Column-wise: bottom\u2192top','Nearest neighbour (distance)'],1);
            const rbDir=gpm.addRadioGroup('Direction (layer order / row / column only):',['Forward','Crosswise (A forward, B backward)','Both backward'],0);

            const gs=pageGroup(1,cA,'Sorting of result groups');
            const rbS=gs.addRadioGroup('',['Group by object pairs','Group by time steps (T=0 \u2192 T=1)'],0);
            const rbPO=gs.addRadioGroup('Order (stacking of pairs):',['Unchanged (as matched)','Distance: small\u2192large (explosion)','Distance: large\u2192small (implosion)'],0);
            const gvis=pageGroup(1,cA,'Visibility');
            const cbHideEnds=gvis.addCheckBox('Only intermediate steps visible (hide A/B)',false);
            const gso=pageGroup(1,cA,'Time-step offset/rotation (time-step sorting only)');
            const tbOffX=gso.addTextBox('Offset X per step:','0');
            const tbOffY=gso.addTextBox('Offset Y per step:','0');
            const tbStepRot=gso.addTextBox('Rotation per step (degrees):','0');

            const gd=pageGroup(2,cA,'Positions / opacity curve');const rbD=gd.addRadioGroup('Spacing:',['Linear','Ease in','Ease out','S-curve'],0);const tbE=gd.addTextBox('Exponent:','2.0');
            const gc2=pageGroup(2,cA,'Colour blend');const rbC=gc2.addRadioGroup('Mode:',['Linear','Colour wheel right','Colour wheel left','RGB (direct)','Colour wheel max. (longest path)','Colour wheel min. (shortest path)'],0);

            const gr=pageGroup(3,cA,'Rotation (per object)');const tbR=gr.addTextBox('Increment (degrees):','0');const rbRD=gr.addRadioGroup('Angle distribution:',['Linear','Ease in','Ease out','S-curve'],0);const tbRE=gr.addTextBox('Angle exponent:','2.0');const cbRotFill=gr.addCheckBox('Rotate fill',true);
            const gfx=pageGroup(3,cA,'Layer effects (from object A per pair)');
            const anyFXA=childrenA.some(hasFX);
            const cbFX=gfx.addCheckBox('Transfer FX',anyFXA);
            const tFX=gfx.addStaticText('',anyFXA?'At least one object A has layer effects':'No objects A with layer effects');

            // v26: radio groups ignore their start index -> set explicitly
            try{rbPM.selectedIndex=1;rbDir.selectedIndex=0;rbS.selectedIndex=0;rbPO.selectedIndex=0;rbD.selectedIndex=0;rbC.selectedIndex=0;rbRD.selectedIndex=0;}catch(e){}
            rNav.selectedIndex=0;
            showPage(0);
            try{rNav.setOnValueChangedHandler(()=>{showPage(rNav.selectedIndex);});}catch(e){}

            // v27: the preview is undone via its counted history steps
            // (works with a full history as well).
            let pg=null;
            let previewKey=null;
            let pvSteps=0;
            function restoreSel(){try{doc.executeCommand(DocumentCommand.createSetSelection(Selection.create(doc,origSel)));}catch(e){}}
            function clrPv(){
                if(pg||pvSteps>0){undoSteps(pvSteps);restoreSel();}
                pg=null;previewKey=null;pvSteps=0;
            }
            function refresh(){
                clrPv();
                const p=getP();
                const gn='Group Morphing '+gi;
                const sm=p.sortMode===0?'Pairs':'Time steps';
                const t0=Date.now();
                STEPS=0;
                let res;
                try{res=runBlendCore(doc,{childrenA,childrenB,pairCount,groupA,groupB},gn,p);}
                catch(e){undoSteps(STEPS);STEPS=0;restoreSel();try{tWarn.setText('Error: '+e.message);}catch(e2){}return false;}
                const{structResult,warnings}=res;
                if(structResult.error){undoSteps(STEPS);STEPS=0;restoreSel();try{tWarn.setText(structResult.error);}catch(e){}return false;}
                pg=structResult.grp;
                pvSteps=STEPS;
                previewKey=JSON.stringify(p);
                let msg=gn+' ['+sm+'] ('+pairCount+' pairs, '+structResult.count+' sub-groups, '+(Date.now()-t0)+' ms)';
                if(warnings.length)msg+=' \u2014 '+warnings.length+' note(s)';
                console.log(msg);
                try{tWarn.setText(warnings.length?warnings.join(' | '):'');}catch(e){}
                return true;
            }
            function updateNames(){
                try{tA.setText(groupName(groupA)+' ('+childrenA.length+' objects)');}catch(e){try{tA.text=groupName(groupA)+' ('+childrenA.length+' objects)';}catch(e2){}}
                try{tB.setText(groupName(groupB)+' ('+childrenB.length+' objects)');}catch(e){try{tB.text=groupName(groupB)+' ('+childrenB.length+' objects)';}catch(e2){}}
                try{tN.setText(String(pairCount));}catch(e){try{tN.text=String(pairCount);}catch(e2){}}
                const aFX=childrenA.some(hasFX);
                try{cbFX.value=aFX;}catch(e){}
                try{tFX.setText(aFX?'At least one object A has layer effects':'No objects A with layer effects');}catch(e){}
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
                rotDm:rbRD.selectedIndex,
                rotExp:Math.max(0.1,parseFloat((tbRE.text||'2').replace(',','.'))||2),
                dm:rbD.selectedIndex,
                dexp:Math.max(0.1,parseFloat((tbE.text||'2').replace(',','.'))||2),
                applyFX:cbFX.value,
                rotateFill:cbRotFill.value,
                hideEnds:cbHideEnds.value,
                offX:parseFloat((tbOffX.text||'0').replace(',','.'))||0,
                offY:parseFloat((tbOffY.text||'0').replace(',','.'))||0,
                stepRot:parseFloat((tbStepRot.text||'0').replace(',','.'))||0
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
                try{rbRD.selectedIndex=d.rotDm??0;}catch(e){}
                try{tbRE.text=String(d.rotExp??2);}catch(e){}
                try{rbD.selectedIndex=d.dm??0;}catch(e){}
                try{tbE.text=String(d.dexp??2);}catch(e){}
                try{cbFX.value=!!d.applyFX;}catch(e){}
                try{cbRotFill.value=!!d.rotateFill;}catch(e){}
                try{cbHideEnds.value=!!d.hideEnds;}catch(e){}
                try{tbOffX.text=String(d.offX??0);}catch(e){}
                try{tbOffY.text=String(d.offY??0);}catch(e){}
                try{tbStepRot.text=String(d.stepRot??0);}catch(e){}
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
                if(!name||!name.trim()){console.log('Save cancelled \u2014 no name entered.');return;}
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
                    console.log('\u2713 '+gn+' (preview applied, no recomputation)');
                }else if(refresh()){
                    console.log('\u2713 '+gn+' applied');
                }
            }
        }
    }
} // End
