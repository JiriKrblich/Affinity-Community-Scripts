'use strict';
// GROUP MORPHING ALTERNATIVE v7 (EN) (base: Group Morphing v21)
//
// VARIANT of "Group Morphing" — the only functional difference: the placement of the overall
// group in the layer stack is reversed (see makeGroup()). The search for group A/B runs to
// the end, so the overall group is inserted after the LAST found source node and therefore
// sits visibly ABOVE BOTH source groups.
// Dialog title "Group Morphing Alternative", preset prefix "GruppenMorphingAlternative_".
// The generated object/group names stay identical to the German version ("Gruppen-Morphing N",
// "... – Paar k", "T=0", "Zwischenschritt k"), so "Gruppen-Morphing-Tweak" keeps working.
//
// CHANGES v7 (as Group Morphing v21):
// - BUGFIX gradients in transformed groups: fdToSpreadGeom and the isIdTF check in
//   setBrushToSpread/setPenToSpread now use composedSpreadTF() (full parent chain) instead of
//   node.transform only - the same fix as in "Blend (Morphing) v113".
// - BUGFIX stale preview: OK recalculates if the settings changed since the preview; with
//   unchanged settings the preview is kept.
// v6: S-curve for "Spacing" and "Angle distribution".

const { Dialog, DialogResult } = require('/dialog.js');
const { Document } = require('/document.js');
const { app } = require('/application.js');
const { File, FileSystemApi } = require('/fs');
const { DocumentCommand, AddChildNodesCommandBuilder, NodeMoveType, NodeChildType } = require('/commands.js');
const { Colour, Gradient, RGBA8 } = require('/colours.js');
const { FillDescriptor, FillType, GradientFill } = require('/fills.js');
const { GradientFillType } = require('affinity:fills');
const { PolyCurve, CurveBuilder, Transform } = require('/geometry.js');
const { Selection } = require('/selections.js');
const { ContainerNodeDefinition, PolyCurveNodeDefinition } = require('/nodes.js');

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
// v7: full parent chain (as in Blend v113). composeAffine(A,B) = first A, then B.
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
// v7: composedSpreadTF instead of node.transform
function fdToSpreadGeom(fd,node){const anchored=fd.isAnchoredToSpread,fdt=fd.transform,p0l={x:fdt.origin.x,y:fdt.origin.y},v1l={x:fdt.xAxis.x,y:fdt.xAxis.y},v2l={x:fdt.yAxis.x,y:fdt.yAxis.y};if(anchored)return{p0x:p0l.x,p0y:p0l.y,v1x:v1l.x,v1y:v1l.y,v2x:v2l.x,v2y:v2l.y};const ntf=composedSpreadTF(node),p0s=applyTFtoPoint(ntf,p0l.x,p0l.y),p1s=applyTFtoPoint(ntf,p0l.x+v1l.x,p0l.y+v1l.y),p2s=applyTFtoPoint(ntf,p0l.x+v2l.x,p0l.y+v2l.y);return{p0x:p0s.x,p0y:p0s.y,v1x:p1s.x-p0s.x,v1y:p1s.y-p0s.y,v2x:p2s.x-p0s.x,v2y:p2s.y-p0s.y};}
function solidGeom(bb){return{p0x:bb.x+bb.w/2,p0y:bb.y+bb.h/2,v1x:0,v1y:0,v2x:0,v2y:0};}
function toPolar(g){return{p0x:g.p0x,p0y:g.p0y,r1:Math.sqrt(g.v1x**2+g.v1y**2),a1:Math.atan2(g.v1y,g.v1x),r2:Math.sqrt(g.v2x**2+g.v2y**2),a2:Math.atan2(g.v2y,g.v2x)};}
function fromPolar(p){return{p0x:p.p0x,p0y:p.p0y,v1x:p.r1*Math.cos(p.a1),v1y:p.r1*Math.sin(p.a1),v2x:p.r2*Math.cos(p.a2),v2y:p.r2*Math.sin(p.a2)};}
function lerpPolar(gA,gB,t){if(t<=0)return gA;if(t>=1)return gB;const pA=toPolar(gA),pB=toPolar(gB);return fromPolar({p0x:lerp(pA.p0x,pB.p0x,t),p0y:lerp(pA.p0y,pB.p0y,t),r1:lerp(pA.r1,pB.r1,t),a1:slerpAngle(pA.a1,pB.a1,t),r2:lerp(pA.r2,pB.r2,t),a2:slerpAngle(pA.a2,pB.a2,t)});}
function rotateGeom(g,cx,cy,cos,sin){const dx=g.p0x-cx,dy=g.p0y-cy;return{p0x:cx+dx*cos-dy*sin,p0y:cy+dx*sin+dy*cos,v1x:g.v1x*cos-g.v1y*sin,v1y:g.v1x*sin+g.v1y*cos,v2x:g.v2x*cos-g.v2y*sin,v2y:g.v2x*sin+g.v2y*cos};}

const FT_NAME={1:'None',2:'Solid',3:'Gradient',4:'Bitmap',5:'Mesh',6:'Hatch'};
function ftName(ft){return FT_NAME[ft]||('Type '+ft);}
function hasFX(info){try{return info.node.layerEffectsInterface?.hasActiveEffects||false;}catch(e){return false;}}

// v7: isIdTF checks the FULL transform chain
function setBrushToSpread(doc,node){const fd=node.brushFillDescriptor;if(fd.fill.fillType.value!==FillType.Gradient.value)return false;if(fd.isAnchoredToSpread)return false;if(isIdTF(composedSpreadTF(node)))return false;doc.setBrushFillIsAnchoredToSpread(true,node,{applyToAllFills:false},false);return true;}
function restoreBrush(doc,node,ch){if(ch)doc.setBrushFillIsAnchoredToSpread(false,node,{applyToAllFills:false},false);}
function setPenToSpread(doc,node){try{const pfd=node.penFillDescriptor;if(!pfd||!pfd.fill)return false;if(pfd.fill.fillType.value!==FillType.Gradient.value)return false;if(pfd.isAnchoredToSpread)return false;if(isIdTF(composedSpreadTF(node)))return false;doc.setPenFillIsAnchoredToSpread(true,node,{applyToAllFills:false},false);return true;}catch(e){return false;}}
function restorePen(doc,node,ch){if(ch)try{doc.setPenFillIsAnchoredToSpread(false,node,{applyToAllFills:false},false);}catch(e){}}

const FX_CMD={0:(sel,fx)=>DocumentCommand.createSetBevelEmbossLayerEffect(sel,fx),1:(sel,fx,i)=>DocumentCommand.createSetOutlineLayerEffect(sel,fx,i),2:(sel,fx)=>DocumentCommand.createSetPhongBevelLayerEffect(sel,fx),3:(sel,fx,i)=>DocumentCommand.createSetInnerShadowLayerEffect(sel,fx,i),4:(sel,fx)=>DocumentCommand.createSetInnerGlowLayerEffect(sel,fx),5:(sel,fx,i)=>DocumentCommand.createSetColourOverlayLayerEffect(sel,fx,i),6:(sel,fx,i)=>DocumentCommand.createSetGradientOverlayLayerEffect(sel,fx,i),7:(sel,fx)=>DocumentCommand.createSetOuterGlowLayerEffect(sel,fx),8:(sel,fx,i)=>DocumentCommand.createSetOuterShadowLayerEffect(sel,fx,i),9:(sel,fx)=>DocumentCommand.createSetGaussianBlurLayerEffect(sel,fx)};
function applyFXFromNode(doc,sourceNode,targetNode){const lei=sourceNode.layerEffectsInterface;if(!lei||!lei.hasActiveEffects)return;const sel=Selection.create(doc,[targetNode]);const pi={};lei.enumerateEffects(fx=>{try{const tv=fx.type.value;const cl=fx.clone();pi[tv]=pi[tv]||0;const fn=FX_CMD[tv];if(fn)doc.executeCommand(fn(sel,cl,pi[tv]));pi[tv]++;}catch(e){}});}

function bbCenter(node){try{const bb=node.getSpreadBaseBox(false);return{x:bb.x+bb.width/2,y:bb.y+bb.height/2};}catch(e){return{x:0,y:0};}}

function sampleC(c,node,cnt){const pts=[];let bz=[];try{bz=c.beziers.toArray();}catch(e){}if(bz.length>0){const pb=Math.max(2,Math.floor(cnt/bz.length));for(const b of bz){for(let si=0;si<pb;si++){const t=si/pb,mt=1-t;const lx=mt*mt*mt*b.start.x+3*mt*mt*t*b.c1.x+3*mt*t*t*b.c2.x+t*t*t*b.end.x;const ly=mt*mt*mt*b.start.y+3*mt*mt*t*b.c1.y+3*mt*t*t*b.c2.y+t*t*t*b.end.y;const p=localToSpreadPoint(node,lx,ly);if(isFinite(p.x)&&isFinite(p.y))pts.push(p);}}}if(!pts.length){for(const nd of c.nodes){const p=localToSpreadPoint(node,nd.position.x,nd.position.y);if(isFinite(p.x)&&isFinite(p.y))pts.push(p);}}return pts;}
function sampleNode(node,res){const curves=[];let anyOpen=false;try{const pc=node.curvesInterface.polyCurve;for(let ci=0;ci<pc.curveCount;ci++){const c=pc.at(ci);const pts=sampleC(c,node,res);if(pts.length>1)curves.push({pts,isClosed:c.isClosed});if(!c.isClosed)anyOpen=true;}}catch(e){}return{curves,anyOpen};}
function resample(pts,N){if(!pts.length)return Array(N).fill({x:0,y:0});if(pts.length===1)return Array(N).fill(pts[0]);const r=[];for(let i=0;i<N;i++){const f=(N===1)?0:(i/(N-1))*(pts.length-1);const lo=Math.floor(f),hi=Math.min(lo+1,pts.length-1),t=f-lo;r.push({x:lerp(pts[lo].x,pts[hi].x,t),y:lerp(pts[lo].y,pts[hi].y,t)});}return r;}
function ptCurve(px,py,N){return Array(N).fill({x:px,y:py});}

function rgba8ToHsl(r,g,b,alpha){r/=255;g/=255;b/=255;const max=Math.max(r,g,b),min=Math.min(r,g,b);let h=0,s=0;const l=(max+min)/2;if(max!==min){const d=max-min;s=l>0.5?d/(2-max-min):d/(max+min);switch(max){case r:h=((g-b)/d+(g<b?6:0))/6;break;case g:h=((b-r)/d+2)/6;break;case b:h=((r-g)/d+4)/6;break;}}return{h,s,l,alpha:(alpha!=null?alpha:255)/255};}
function mkCol(hsl,noise){const col=Colour.createHSLAf(hsl);try{col.noise=noise||0;}catch(e){}return col;}
function stopRGBA(s){
    if(s.rgba8)return s.rgba8;
    try{return Colour.createHSLAf(s.hsl).rgba8;}catch(e){return{r:0,g:0,b:0,alpha:(s.hsl&&s.hsl.alpha!=null)?Math.round(s.hsl.alpha*255):255};}
}
function r8(r,g,b,a){return RGBA8(r,g,b,a!=null?a:255);}
function cToRGBA(c){try{if(c instanceof Colour)return c.rgba8;return new Colour(c).rgba8;}catch(e){return{r:0,g:0,b:0,alpha:255};}}
function rgba8Eq(a,b){return a.r===b.r&&a.g===b.g&&a.b===b.b&&a.alpha===b.alpha;}
function readSt(grad,i){const s=grad.getStop(i);const col=new Colour(s.colour);const rgba8=col.rgba8;let hsl,noise=0;try{hsl=col.hslaf;}catch(e){hsl=rgba8ToHsl(rgba8.r,rgba8.g,rgba8.b,rgba8.alpha*255);}try{noise=col.noise||0;}catch(e){}return{position:s.position,midpoint:s.midpoint!=null?s.midpoint:0.5,noise,hsl,rgba8,origColour:new Colour(s.colour)};}
function readStops(gf){const g=gf.gradient,st=[];for(let i=0;i<g.stopCount;i++)st.push(readSt(g,i));st.sort((a,b)=>a.position-b.position);return st;}
function origStops(gf){const g=gf.gradient,r=[];for(let i=0;i<g.stopCount;i++){const s=g.getStop(i);r.push({colour:new Colour(s.colour),position:s.position,midpoint:s.midpoint!=null?s.midpoint:0.5});}return r;}
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

function anaFD(fd,node){const ft=fd.fill.fillType.value;const isNone=ft===1||ft===FillType.None.value,isSolid=ft===FillType.Solid.value,isGrad=ft===FillType.Gradient.value;const bb_raw=node.getSpreadBaseBox(false);const sBB={x:bb_raw.x,y:bb_raw.y,w:bb_raw.width,h:bb_raw.height};if(isNone){const rgba={r:0,g:0,b:0,alpha:0};return{isNone,isSolid:false,isGrad:false,gft:-1,stops:colStops(rgba),solidRGBA:rgba,gfOrig:null,sGeom:solidGeom(sBB),anchored:false,blendMode:null,origFdTr:null,ft};}if(isSolid){const rgba=cToRGBA(fd.fill.colour);return{isNone:false,isSolid,isGrad:false,gft:-1,stops:colStops(rgba),solidRGBA:rgba,gfOrig:null,sGeom:solidGeom(sBB),anchored:false,blendMode:null,origFdTr:null,ft};}if(isGrad){const gf=fd.fill,anchored=fd.isAnchoredToSpread,sGeom=fdToSpreadGeom(fd,node);return{isNone:false,isSolid:false,isGrad:true,gft:gf.gradientFillType,stops:readStops(gf),solidRGBA:null,gfOrig:gf,sGeom,anchored,blendMode:fd.blendMode,origFdTr:fd.transform.clone(),ft};}return{isNone:false,isSolid:false,isGrad:false,isSpecial:true,gft:-1,stops:colStops({r:0,g:0,b:0,alpha:0}),solidRGBA:{r:0,g:0,b:0,alpha:0},gfOrig:null,sGeom:solidGeom(sBB),anchored:false,blendMode:null,origFdTr:null,ft};}
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

function buildGeomNode(doc,cdA,cdB,nC,fpA,fpB,t,dm,dexp,rotDeg,rotDm,rotExp,steps,si){
    const tE=easedT(t,dexp,dm);const angleFrac=(steps+1)>0?si/(steps+1):0;const easedFrac=easedAngle(angleFrac,rotExp,rotDm);const totalAngleDeg=rotDeg*(steps+1);const angleRad=(totalAngleDeg*easedFrac)*Math.PI/180;const cosA=Math.cos(angleRad),sinA=Math.sin(angleRad);
    const cx=lerp(fpA.x,fpB.x,easedFrac),cy=lerp(fpA.y,fpB.y,easedFrac);
    const pc=new PolyCurve();
    for(let ci=0;ci<nC;ci++){const dA=cdA[ci],dB=cdB[ci];let mPts=dA.pts.map((p,i)=>({x:lerp(p.x,dB.pts[i].x,tE),y:lerp(p.y,dB.pts[i].y,tE)}));if(rotDeg!==0&&angleRad!==0){mPts=mPts.map(p=>{const dx=p.x-cx,dy=p.y-cy;return{x:cx+dx*cosA-dy*sinA,y:cy+dx*sinA+dy*cosA};});}if(!mPts.every(p=>isFinite(p.x)&&isFinite(p.y)))return null;const cb=new CurveBuilder();cb.begin(mPts[0]);for(let pi=1;pi<mPts.length;pi++)cb.lineTo(mPts[pi]);if(dA.isClosed||dB.isClosed)cb.close();pc.addCurve(cb.createCurve());}
    const def=PolyCurveNodeDefinition.createDefault();def.setCurves(pc);const ab=AddChildNodesCommandBuilder.create();ab.addPolyCurveNode(def);const ac=ab.createCommand(false);doc.executeCommand(ac);
    return{nn:ac.newNodes[0],tE,angleRad,cosA,sinA,cx,cy};
}

function makeGroup(doc,allNs,gName,nodeA,nodeB){
    const gb2=AddChildNodesCommandBuilder.create();gb2.addContainerNode(ContainerNodeDefinition.create(gName));gb2.setInsertionTargetSelection(Selection.create(doc,allNs));const gc=gb2.createCommand(false);doc.executeCommand(gc);const grp=gc.newNodes[0];if(!grp)return null;
    try{grp.userDescription=gName;}catch(e){}
    doc.executeCommand(DocumentCommand.createMoveNodes(Selection.create(doc,allNs),grp,NodeMoveType.Inside,NodeChildType.Main));
    // ALTERNATIVE: no break - topNode ends up on the LAST found source node.
    let topNode=nodeA;for(const l of doc.layers.all){if(l.isSameNode(nodeA)){topNode=nodeA;}if(l.isSameNode(nodeB)){topNode=nodeB;}}
    try{doc.executeCommand(DocumentCommand.createMoveNodes(Selection.create(doc,[grp]),topNode,NodeMoveType.After,NodeChildType.Main));}catch(e){}
    return grp;
}
function makeSimpleGroup(doc,allNs,gName){
    if(!allNs.length)return null;
    const gb=AddChildNodesCommandBuilder.create();gb.addContainerNode(ContainerNodeDefinition.create(gName));gb.setInsertionTargetSelection(Selection.create(doc,allNs));const gc=gb.createCommand(false);doc.executeCommand(gc);const grp=gc.newNodes[0];if(!grp)return null;
    try{grp.userDescription=gName;}catch(e){}
    doc.executeCommand(DocumentCommand.createMoveNodes(Selection.create(doc,allNs),grp,NodeMoveType.Inside,NodeChildType.Main));
    return grp;
}
function positionSiblingsAfter(doc,orderedGroups,nodeA,nodeB){
    let topNode=nodeA;
    for(const l of doc.layers.all){if(l.isSameNode(nodeA)){topNode=nodeA;}if(l.isSameNode(nodeB)){topNode=nodeB;}}
    let anchor=topNode;
    for(const g of orderedGroups){
        try{doc.executeCommand(DocumentCommand.createMoveNodes(Selection.create(doc,[g]),anchor,NodeMoveType.After,NodeChildType.Main));}catch(e){}
        anchor=g;
    }
}

function applyHideEnds(doc,pairResults){
    for(const pr of pairResults){
        if(pr.error)continue;
        try{doc.executeCommand(DocumentCommand.createSetOpacity(Selection.create(doc,[pr.rawA]),0));}catch(e){}
        try{doc.executeCommand(DocumentCommand.createSetOpacity(Selection.create(doc,[pr.rawB]),0));}catch(e){}
    }
}

function reorderChildren(doc,orderedNodes){
    if(orderedNodes.length<2)return;
    let anchor=orderedNodes[0];
    for(let i=1;i<orderedNodes.length;i++){
        const g=orderedNodes[i];
        try{doc.executeCommand(DocumentCommand.createMoveNodes(Selection.create(doc,[g]),anchor,NodeMoveType.After,NodeChildType.Main));}catch(e){}
        anchor=g;
    }
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

function createBlendNodesForPair(doc,infoA,infoB,steps,cm,rotDeg,rotDm,rotExp,dm,dexp,applyFX,rotateFill,hideEnds,sampleRes){
    const origFDA=infoA.node.brushFillDescriptor,origFDB=infoB.node.brushFillDescriptor;
    const brushChA=setBrushToSpread(doc,infoA.node);const brushChB=setBrushToSpread(doc,infoB.node);
    const penChA=setPenToSpread(doc,infoA.node);const penChB=setPenToSpread(doc,infoB.node);
    const restore=()=>{restoreBrush(doc,infoA.node,brushChA);restoreBrush(doc,infoB.node,brushChB);restorePen(doc,infoA.node,penChA);restorePen(doc,infoB.node,penChB);};
    const atA=readAttrs(doc,infoA,sampleRes),atB=readAttrs(doc,infoB,sampleRes);const aA=atA.bAna,aB=atB.bAna;
    const fallbackReason=valPairM1(aA,aB);const fillFallback=!!fallbackReason;
    const bothAnchored=aA.isGrad&&aB.isGrad&&aA.anchored&&aB.anchored;
    const penBothAnchored=(atA.pAna?.anchored||false)&&(atB.pAna?.anchored||false);
    const nullAna={isNone:true,isSolid:false,isGrad:false,gft:-1,stops:colStops({r:0,g:0,b:0,alpha:0}),solidRGBA:{r:0,g:0,b:0,alpha:0},gfOrig:null,sGeom:solidGeom({x:0,y:0,w:1,h:1}),anchored:false,blendMode:null,origFdTr:null,ft:1};
    const opA=infoA.node.globalOpacity||1,opB=infoB.node.globalOpacity||1;const wA=atA.wt,wB=atB.wt;const bls=atA.ls;
    const pAnaA=atA.pAna||nullAna,pAnaB=atB.pAna||nullAna;const hasPenFill=(wA>0||wB>0)&&(!pAnaA.isNone||!pAnaB.isNone);
    const nA=infoA.name,nB=infoB.name;
    function getFP(n){try{const f=n.transformInterface.focalPoint;if(f.isValid)return localToSpreadPoint(n,f.point.x,f.point.y);}catch(e){}try{const bb=n.getSpreadBaseBox(false);return{x:bb.x+bb.width/2,y:bb.y+bb.height/2};}catch(e){}return{x:0,y:0};}
    const fpA=getFP(infoA.node),fpB=getFP(infoB.node);
    const nCA=atA.curves.length,nCB=atB.curves.length,nC=Math.max(nCA||1,nCB||1);const rNA=nCA>0?atA.curves[0].pts.length:4;
    const cdA=[],cdB=[];
    for(let ci=0;ci<nC;ci++){let pA,pB,cA=true,cB=true;if(ci<nCA){pA=atA.curves[ci].pts;cA=atA.curves[ci].isClosed;}else{pA=ptCurve(fpA.x,fpA.y,rNA);}if(ci<nCB){pB=atB.curves[ci].pts;cB=atB.curves[ci].isClosed;}else{pB=ptCurve(fpB.x,fpB.y,rNA);}const N=Math.max(pA.length,pB.length,4);cdA.push({pts:resample(pA,N),isClosed:cA});cdB.push({pts:resample(pB,N),isClosed:cB});}
    function mkNode(t_raw,si,label){
        const res=buildGeomNode(doc,cdA,cdB,nC,fpA,fpB,t_raw,dm,dexp,rotDeg,rotDm,rotExp,steps,si);if(!res||!res.nn)return null;
        const{nn,tE,angleRad,cosA,sinA,cx,cy}=res;
        let brushFD;
        if(fillFallback){
            brushFD=tE<0.5?origFDA:origFDB;
        }else{
            const brushResult=iFillGeom(aA,aB,tE,cm,bothAnchored);brushFD=brushResult.fd;
            if(rotateFill&&brushResult.geom&&rotDeg!==0&&angleRad!==0){brushFD=fdFromGeom(brushResult,rotateGeom(brushResult.geom,cx,cy,cosA,sinA));}
        }
        try{doc.executeCommand(DocumentCommand.createSetBrushFill(Selection.create(doc,[nn]),brushFD));}catch(e){doc.executeCommand(DocumentCommand.createSetBrushFill(Selection.create(doc,[nn]),FillDescriptor.createSolid(RGBA8(128,128,128,255))));}
        doc.executeCommand(DocumentCommand.createSetOpacity(Selection.create(doc,[nn]),lerp(opA,opB,tE)));
        const wLerp=lerp(wA,wB,tE);
        if(wLerp>0){
            if(bls){try{doc.executeCommand(DocumentCommand.createSetLineStyleDescriptor(Selection.create(doc,[nn]),bls));}catch(e){}}
            nn.lineWeightPts=wLerp;
            if(hasPenFill&&!fillFallback){const penResult=iFillGeom(pAnaA,pAnaB,tE,cm,penBothAnchored);let penFD=penResult.fd;if(rotateFill&&penResult.geom&&rotDeg!==0&&angleRad!==0){penFD=fdFromGeom(penResult,rotateGeom(penResult.geom,cx,cy,cosA,sinA));}try{doc.executeCommand(DocumentCommand.createSetPenFill(Selection.create(doc,[nn]),penFD));}catch(e){}}
        }else{nn.lineWeightPts=0;}
        if(applyFX)applyFXFromNode(doc,infoA.node,nn);
        if(hideEnds&&(t_raw<=0||t_raw>=1)){try{doc.executeCommand(DocumentCommand.createSetOpacity(Selection.create(doc,[nn]),0));}catch(e){}}
        nn.userDescription=label;return nn;
    }
    const rawA=mkNode(0,0,nA+' [0]');if(!rawA){restore();return{error:'Error at object A ('+nA+')'};}
    const morphs=[];
    for(let i=1;i<=steps;i++){const nn=mkNode(i/(steps+1),i,nA+'\u2192'+nB+' ['+i+']');if(nn)morphs.push(nn);}
    const rawB=mkNode(1,steps+1,nB+' ['+(steps+1)+']');if(!rawB){restore();return{error:'Error at object B ('+nB+')'};}
    restore();
    return{rawA,morphs,rawB,usedFallback:fillFallback,fallbackReason};
}

// Group names stay German (compatibility with "Gruppen-Morphing-Tweak")
function buildPairedStructure(doc,pairResults,childrenA,childrenB,masterName){
    const subGroups=[];
    for(let k=0;k<pairResults.length;k++){
        const pr=pairResults[k];if(pr.error)continue;
        const allNs=[pr.rawB,...pr.morphs.slice().reverse(),pr.rawA];
        const gName=masterName+' \u2013 Paar '+(k+1)+': '+childrenA[k].name+' \u2192 '+childrenB[k].name;
        const g=makeSimpleGroup(doc,allNs,gName);
        if(g)subGroups.push(g);
    }
    if(!subGroups.length)return{error:'No valid pairs (geometry error on all pairs).'};
    return{grps:subGroups};
}
function buildStepStructure(doc,pairResults,steps,masterName,offX,offY,stepRotDeg){
    const stepCount=steps+2;
    const stepGroups=[];
    for(let si=0;si<stepCount;si++){
        const nodesAtStep=[];
        for(const pr of pairResults){
            if(pr.error)continue;
            let nn;
            if(si===0)nn=pr.rawA;else if(si===stepCount-1)nn=pr.rawB;else nn=pr.morphs[si-1];
            if(nn)nodesAtStep.push(nn);
        }
        if(!nodesAtStep.length)continue;
        const label=masterName+' \u2013 '+(si===0?'T=0':(si===stepCount-1?'T=1':'Zwischenschritt '+si));
        const g=makeSimpleGroup(doc,nodesAtStep,label);
        if(g){
            if(offX||offY||stepRotDeg){
                let bb;try{bb=g.getSpreadBaseBox(false);}catch(e){bb=null;}
                const px=bb?bb.x+bb.width/2:0,py=bb?bb.y+bb.height/2:0;
                const angRad=stepRotDeg*si*Math.PI/180;
                const cosA=Math.cos(angRad),sinA=Math.sin(angRad);
                const tf=Transform.createIdentity();const d=tf.data;
                d[0]=cosA;d[1]=-sinA;d[2]=px-cosA*px+sinA*py+offX*si;
                d[3]=sinA;d[4]=cosA;d[5]=py-sinA*px-cosA*py+offY*si;
                try{doc.executeCommand(DocumentCommand.createTransform(Selection.create(doc,[g]),tf,{duplicateNodes:false}));}catch(e){}
            }
            stepGroups.push(g);
        }
    }
    if(!stepGroups.length)return{error:'No valid objects (geometry error on all pairs).'};
    return{grps:stepGroups};
}

const PRESETS_DIR=app.userDesktopPath+'/AffinityScriptPresets';
const PRESET_PREFIX='GruppenMorphingAlternative_';

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
        eg.addButtonSet('',['Close'],0).isFullWidth=true;ed.runModal();
    }else{
        let groupA=selGroups[0],groupB=selGroups[1];
        function groupName(g){return g.userDescription||g.defaultDescription||'Group';}
        function getPairs(){const ca=getGroupPairs(doc,nodeInfos,groupA);const cb=getGroupPairs(doc,nodeInfos,groupB);return{ca,cb,n:Math.min(ca.length,cb.length)};}
        let{ca:childrenA,cb:childrenB,n:pairCount}=getPairs();
        if(pairCount===0){
            const ed=Dialog.create('Error');const ec=ed.addColumn();const eg=ec.addGroup('');
            eg.addStaticText('','No matching object pairs found (at least 1 vector object per group required).');
            eg.addButtonSet('',['Close'],0).isFullWidth=true;ed.runModal();
        }else{
            let maxGi=-1;
            for(const l of doc.layers.all){
                try{
                    const d=l.userDescription||'';
                    if(d.includes('[Vorschau]'))continue;
                    const m=d.match(/^Gruppen-Morphing (\d+)/);
                    if(m){const num=parseInt(m[1],10);if(!isNaN(num)&&num>maxGi)maxGi=num;}
                }catch(e){}
            }
            let gi=maxGi+1;

            const dlg=Dialog.create('Group Morphing Alternative');dlg.initialWidth=760;dlg.setIsResizable(true);
            const col1=dlg.addColumn();col1.widthProportion=0.42;
            const go=col1.addGroup('Selected groups');
            const tA=go.addStaticText('Group A:',groupName(groupA)+' ('+childrenA.length+' objects)');
            const tB=go.addStaticText('Group B:',groupName(groupB)+' ('+childrenB.length+' objects)');
            const tN=go.addStaticText('Pairs:',String(pairCount));

            const gbx=col1.addGroup('Blend');const tbS=gbx.addTextBox('Intermediate steps:','5');const tbSR=gbx.addTextBox('Sample resolution:','40');

            const gpm=col1.addGroup('Pair matching');
            const rbPM=gpm.addRadioGroup('Criterion:',['By layer order','Row by row: left\u2192right','Row by row: right\u2192left','Column by column: top\u2192bottom','Column by column: bottom\u2192top','Nearest neighbour (distance)'],1);
            const rbDir=gpm.addRadioGroup('Direction (layer order / row / column only):',['Forward','Crosswise (A forward, B backward)','Both backward'],0);

            const gs=col1.addGroup('Sorting of the result groups');
            const rbS=gs.addRadioGroup('',['Group by object pairs','Group by time steps (T=0 \u2192 T=1)'],0);
            const rbPO=gs.addRadioGroup('Order (stacking of the pairs):',['Unchanged (as matched)','Distance: small\u2192large (explosion)','Distance: large\u2192small (implosion)'],0);

            const gvis=col1.addGroup('Visibility');
            const cbHideEnds=gvis.addCheckBox('Only intermediate steps visible (hide A/B)',false);

            const gso=col1.addGroup('Time step offset/rotation (time step sorting only)');
            const tbOffX=gso.addTextBox('Offset X per step:','0');
            const tbOffY=gso.addTextBox('Offset Y per step:','0');
            const tbStepRot=gso.addTextBox('Rotation per step (degrees):','0');

            const gWarn=col1.addGroup('');const tWarn=gWarn.addStaticText('','');

            const col2=dlg.addColumn();col2.widthProportion=0.58;
            const gd=col2.addGroup('Positions / opacity curve');const rbD=gd.addRadioGroup('Spacing:',['Linear','Ease in','Ease out','S-curve'],0);const tbE=gd.addTextBox('Exponent:','2.0');
            const gc2=col2.addGroup('Colour blend');const rbC=gc2.addRadioGroup('Mode:',['Linear','Colour wheel right','Colour wheel left','RGB (direct)','Colour wheel max. (longest way)','Colour wheel min. (shortest way)'],0);

            const gr=col2.addGroup('Rotation (per object)');const tbR=gr.addTextBox('Increment (degrees):','0');const rbRD=gr.addRadioGroup('Angle distribution:',['Linear','Ease in','Ease out','S-curve'],0);const tbRE=gr.addTextBox('Angle exponent:','2.0');const cbRotFill=gr.addCheckBox('Rotate fill as well',true);

            const gfx=col2.addGroup('Layer effects (from object A per pair)');
            const anyFXA=childrenA.some(hasFX);
            const cbFX=gfx.addCheckBox('Take over FX',anyFXA);
            const tFX=gfx.addStaticText('',anyFXA?'At least one object A has layer effects':'No objects A with layer effects');

            const gact=col2.addGroup('Actions');
            const btnSwap=gact.addButton('\u2195 Swap');
            const btnPreview=gact.addButton('\ud83d\udc41 Preview');

            const gpreset=col2.addGroup('Presets');
            const btnPresetSave=gpreset.addButton('\ud83d\udcbe Save\u2026');
            const btnPresetLoad=gpreset.addButton('\ud83d\udcc2 Load\u2026');
            const btnPresetDelete=gpreset.addButton('\ud83d\uddd1 Delete\u2026');

            let pg=null;
            let previewKey=null;   // v7: settings of the last shown preview
            function clrPv(){if(pg){try{pg.delete();}catch(e){}pg=null;}previewKey=null;}
            function refresh(){
                clrPv();
                const p=getP();
                const gn='Gruppen-Morphing '+gi;
                const sm=p.sortMode===0?'pairs':'time steps';
                const{structResult,warnings}=runBlend(gn,p);
                if(structResult.error){try{tWarn.setText(structResult.error);}catch(e){}return false;}
                if(structResult.grp){
                    pg=structResult.grp;
                    previewKey=JSON.stringify(p);
                    let kc=0;for(const k of structResult.grp.children)kc++;
                    let msg=gn+' ['+sm+'] ('+pairCount+' pairs, '+kc+' subgroups)';
                    if(warnings.length)msg+=' \u2014 '+warnings.length+' note(s)';
                    console.log(msg);
                    try{tWarn.setText(warnings.length?warnings.join(' | '):'');}catch(e){}
                    return true;
                }
                return false;
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

            function runBlend(gName,p){
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
                    const r=createBlendNodesForPair(doc,iA,iB,p.steps,p.cm,p.rot,p.rotDm,p.rotExp,p.dm,p.dexp,fx,p.rotateFill,p.hideEnds,p.sampleRes);
                    if(r.error){warnings.push('Pair '+(k+1)+' ('+iA.name+' / '+iB.name+'): '+r.error);}
                    else if(r.usedFallback){warnings.push('Pair '+(k+1)+' ('+iA.name+' / '+iB.name+'): simplified fill (hard cut) \u2014 '+r.fallbackReason);}
                    pairResults.push(r);
                }
                const structResult=p.sortMode===0
                    ?buildPairedStructure(doc,pairResults,sa,sb,gName)
                    :buildStepStructure(doc,pairResults,p.steps,gName,p.offX,p.offY,p.stepRot);
                if(structResult.error)return{structResult,warnings};
                const grp=makeGroup(doc,structResult.grps,gName,groupA,groupB);
                if(!grp)return{structResult:{error:'Error while creating the overall group.'},warnings};
                reorderChildren(doc,structResult.grps);
                if(p.hideEnds)applyHideEnds(doc,pairResults);
                return{structResult:{grp,count:structResult.grps.length},warnings};
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
                if(!name||!name.trim()){console.log('Saving cancelled \u2014 no name entered.');return;}
                if(savePresetToDisk(name,getP())){
                    console.log('Preset "'+name.trim()+'" saved in '+PRESETS_DIR+'.');
                    try{tWarn.setText('Preset saved: '+name.trim());}catch(e){}
                }
            });
            btnPresetLoad.setOnClickHandler(()=>{
                const path=app.chooseFile();
                if(!path){console.log('Loading cancelled.');return;}
                const d=loadPresetFromPath(path);
                if(!d)return;
                clrPv();
                applyPreset(d);
                console.log('Preset loaded from "'+path+'".');
                try{tWarn.setText('Preset loaded.');}catch(e){}
            });
            btnPresetDelete.setOnClickHandler(()=>{
                const path=app.chooseFile();
                if(!path){console.log('Deleting cancelled.');return;}
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
                const gn='Gruppen-Morphing '+gi;
                // v7: keep the preview only if the settings have not changed since
                if(pg&&previewKey===JSON.stringify(getP())){
                    try{pg.userDescription=gn;}catch(e){}
                    console.log('\u2713 '+gn+' (preview kept, no new pass)');
                }else if(refresh()){
                    console.log('\u2713 '+gn+' applied');
                }
            }
        }
    }
} // End
