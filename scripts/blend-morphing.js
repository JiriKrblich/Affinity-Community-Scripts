'use strict';
// BLEND MORPHING v115-EN
// English GUI version of Überblendung (Morphing) v115. Logic identical,
// including: the composedSpreadTF fix (v113), the stale-preview-on-OK fix
// (v114), and the tab-based GUI (v115) — pattern matching "Transform
// Objects v8": a persistent left navigation column (tab radio group,
// Preview, Presets) with two content columns whose groups are shown/hidden
// per active tab via .isVisible. 4 tabs: Objects & Method / Blend & Colour /
// Rotation & Path / Correspondence & Locks.

const { Dialog, DialogResult } = require('/dialog.js');
const { Document } = require('/document.js');
const { DocumentCommand, AddChildNodesCommandBuilder, NodeMoveType, NodeChildType } = require('/commands.js');
const { Colour, Gradient, RGBA8 } = require('/colours.js');
const { FillDescriptor, FillType, GradientFill } = require('/fills.js');
const { GradientFillType } = require('affinity:fills');
const { PolyCurve, CurveBuilder, Transform } = require('/geometry.js');
const { Selection, SubSelectionType } = require('/selections.js');
const { ContainerNodeDefinition, PolyCurveNodeDefinition } = require('/nodes.js');
const { app } = require('/application.js');
const { File, FileSystemApi } = require('/fs.js');

const DUMMY_SOLID_FD = FillDescriptor.createSolid(RGBA8(0,0,0,0));
function stableBrushWrite(targetNode,fd){if(fd.fill.fillType.value!==2)targetNode.brushFillDescriptor=DUMMY_SOLID_FD;targetNode.brushFillDescriptor=fd;}
function stablePenWrite(targetNode,fd){try{if(fd.fill.fillType.value!==2)targetNode.penFillDescriptor=DUMMY_SOLID_FD;targetNode.penFillDescriptor=fd;}catch(e){}}

function lerp(a,b,t){return a+(b-a)*t;}
function easedT(t,exp,dm){const e=Math.max(0.1,exp);if(dm===0)return t;if(dm===1)return Math.pow(t,e);if(dm===2)return 1-Math.pow(1-t,e);if(dm===3){return t<0.5?Math.pow(2*t,e)/2:1-Math.pow(2*(1-t),e)/2;}return t;}
function easedAngle(frac,exp,dm){const e=Math.max(0.1,exp);if(dm===0)return frac;if(dm===1)return Math.pow(frac,e);if(dm===2)return 1-Math.pow(1-frac,e);if(dm===3){return frac<0.5?Math.pow(2*frac,e)/2:1-Math.pow(2*(1-frac),e)/2;}return frac;}
function slerpAngle(a,b,t){let d=b-a;while(d>Math.PI)d-=2*Math.PI;while(d<-Math.PI)d+=2*Math.PI;return a+d*t;}
function applyTFtoPoint(tf,x,y){try{const r=tf.applyToPoint({x,y});if(isFinite(r.x)&&isFinite(r.y))return r;}catch(e){}try{const d=tf.data;return{x:d[0]*x+d[1]*y+d[2],y:d[3]*x+d[4]*y+d[5]};}catch(e){}return{x,y};}
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

function spiralPivot(fpA,fpB,frac,spiralTurns,bulge){
    const cx=(fpA.x+fpB.x)/2,cy=(fpA.y+fpB.y)/2;
    const dx=fpA.x-cx,dy=fpA.y-cy;
    const r0=Math.sqrt(dx*dx+dy*dy);
    if(r0<0.0001)return{x:cx,y:cy};
    const angleStart=Math.atan2(dy,dx);
    const totalSweep=Math.PI+spiralTurns*2*Math.PI;
    const ang=angleStart+frac*totalSweep;
    const r=r0*(1+bulge*Math.sin(Math.PI*frac));
    return{x:cx+r*Math.cos(ang),y:cy+r*Math.sin(ang)};
}
function buildPathSampler(pts){
    const cum=[0];let total=0;
    for(let i=1;i<pts.length;i++){const dx=pts[i].x-pts[i-1].x,dy=pts[i].y-pts[i-1].y;total+=Math.sqrt(dx*dx+dy*dy);cum.push(total);}
    return{pts,cum,total};
}
function pathPointAt(sampler,frac){
    if(!sampler||sampler.pts.length<2)return null;
    frac=Math.max(0,Math.min(1,frac));
    const target=frac*sampler.total,cum=sampler.cum,pts=sampler.pts;
    let idx=0;while(idx<cum.length-1&&cum[idx+1]<target)idx++;
    if(idx>=pts.length-1)return{x:pts[pts.length-1].x,y:pts[pts.length-1].y};
    const segStart=cum[idx],segEnd=cum[idx+1],segLen=segEnd-segStart;
    const segT=segLen>0.0001?(target-segStart)/segLen:0;
    return{x:pts[idx].x+(pts[idx+1].x-pts[idx].x)*segT,y:pts[idx].y+(pts[idx+1].y-pts[idx].y)*segT};
}
function pivotPoint(fpA,fpB,easedFrac,lockPivot,spiralMode,spiralTurns,spiralBulge,pathMode,pathSampler,pathFrac,spiralFrac){
    if(lockPivot)return{x:fpA.x,y:fpA.y};
    if(pathMode&&pathSampler){const p=pathPointAt(pathSampler,pathFrac!=null?pathFrac:easedFrac);if(p)return p;}
    if(spiralMode)return spiralPivot(fpA,fpB,spiralFrac!=null?spiralFrac:easedFrac,spiralTurns,spiralBulge);
    return{x:lerp(fpA.x,fpB.x,easedFrac),y:lerp(fpA.y,fpB.y,easedFrac)};
}
function pathShiftAt(fpA,fpB,easedFrac,pathMode,pathSampler,pathFrac){
    if(!pathMode||!pathSampler)return{x:0,y:0};
    const p=pathPointAt(pathSampler,pathFrac!=null?pathFrac:easedFrac);
    if(!p)return{x:0,y:0};
    return{x:p.x-lerp(fpA.x,fpB.x,easedFrac),y:p.y-lerp(fpA.y,fpB.y,easedFrac)};
}
function applyPathShift(doc,node,fromX,fromY,toX,toY){
    const dx=toX-fromX,dy=toY-fromY;
    if(Math.abs(dx)<0.0001&&Math.abs(dy)<0.0001)return;
    const tf=Transform.createIdentity();const d=tf.data;
    d[0]=1;d[1]=0;d[2]=dx;d[3]=0;d[4]=1;d[5]=dy;
    doc.executeCommand(DocumentCommand.createTransform(Selection.create(doc,[node]),tf,{duplicateNodes:false}));
}

const FT_NAME={1:'None',2:'Solid',3:'Gradient',4:'Bitmap',5:'Mesh',6:'Hatch'};
function ftName(ft){return FT_NAME[ft]||('Type '+ft);}
function hasMeshFill(node){try{return node.brushFillDescriptor.fill.fillType.value===5;}catch(e){return false;}}
function getNodeRotation(node){try{const d=composedSpreadTF(node).data;return Math.atan2(d[3],d[0]);}catch(e){return 0;}}

function setBrushToSpread(doc,node){const fd=node.brushFillDescriptor;if(fd.fill.fillType.value!==FillType.Gradient.value)return false;if(fd.isAnchoredToSpread)return false;if(isIdTF(composedSpreadTF(node)))return false;doc.setBrushFillIsAnchoredToSpread(true,node,{applyToAllFills:false},false);return true;}
function restoreBrush(doc,node,ch){if(ch)doc.setBrushFillIsAnchoredToSpread(false,node,{applyToAllFills:false},false);}
function setPenToSpread(doc,node){try{const pfd=node.penFillDescriptor;if(!pfd||!pfd.fill)return false;if(pfd.fill.fillType.value!==FillType.Gradient.value)return false;if(pfd.isAnchoredToSpread)return false;if(isIdTF(composedSpreadTF(node)))return false;doc.setPenFillIsAnchoredToSpread(true,node,{applyToAllFills:false},false);return true;}catch(e){return false;}}
function restorePen(doc,node,ch){if(ch)try{doc.setPenFillIsAnchoredToSpread(false,node,{applyToAllFills:false},false);}catch(e){}}

const FX_CMD={0:(sel,fx)=>DocumentCommand.createSetBevelEmbossLayerEffect(sel,fx),1:(sel,fx,i)=>DocumentCommand.createSetOutlineLayerEffect(sel,fx,i),2:(sel,fx)=>DocumentCommand.createSetPhongBevelLayerEffect(sel,fx),3:(sel,fx,i)=>DocumentCommand.createSetInnerShadowLayerEffect(sel,fx,i),4:(sel,fx)=>DocumentCommand.createSetInnerGlowLayerEffect(sel,fx),5:(sel,fx,i)=>DocumentCommand.createSetColourOverlayLayerEffect(sel,fx,i),6:(sel,fx,i)=>DocumentCommand.createSetGradientOverlayLayerEffect(sel,fx,i),7:(sel,fx)=>DocumentCommand.createSetOuterGlowLayerEffect(sel,fx),8:(sel,fx,i)=>DocumentCommand.createSetOuterShadowLayerEffect(sel,fx,i),9:(sel,fx)=>DocumentCommand.createSetGaussianBlurLayerEffect(sel,fx)};
function applyFXFromNode(doc,sourceNode,targetNode){const lei=sourceNode.layerEffectsInterface;if(!lei||!lei.hasActiveEffects)return;const sel=Selection.create(doc,[targetNode]);const pi={};lei.enumerateEffects(fx=>{try{const tv=fx.type.value;const cl=fx.clone();pi[tv]=pi[tv]||0;const fn=FX_CMD[tv];if(fn)doc.executeCommand(fn(sel,cl,pi[tv]));pi[tv]++;}catch(e){}});}

function bbCenter(node){try{const bb=node.getSpreadBaseBox(false);return{x:bb.x+bb.width/2,y:bb.y+bb.height/2};}catch(e){return{x:0,y:0};}}
function getSpreadGeomViaAnchor(doc,node){const wasAnchored=node.brushFillDescriptor.isAnchoredToSpread;if(!wasAnchored)doc.setBrushFillIsAnchoredToSpread(true,node,{applyToAllFills:false},false);const tr=node.brushFillDescriptor.transform;const g={v1x:tr.xAxis.x,v1y:tr.xAxis.y,v2x:tr.yAxis.x,v2y:tr.yAxis.y,ox:tr.origin.x,oy:tr.origin.y};if(!wasAnchored)doc.setBrushFillIsAnchoredToSpread(false,node,{applyToAllFills:false},false);return g;}
function getPenSpreadGeomViaAnchor(doc,node){try{const pfd=node.penFillDescriptor;if(!pfd||!pfd.fill)return null;const wasAnchored=pfd.isAnchoredToSpread;if(!wasAnchored)doc.setPenFillIsAnchoredToSpread(true,node,{applyToAllFills:false},false);const tr=node.penFillDescriptor.transform;const g={v1x:tr.xAxis.x,v1y:tr.xAxis.y,v2x:tr.yAxis.x,v2y:tr.yAxis.y,ox:tr.origin.x,oy:tr.origin.y};if(!wasAnchored)doc.setPenFillIsAnchoredToSpread(false,node,{applyToAllFills:false},false);return g;}catch(e){return null;}}
function spreadGeomToTransform(ox,oy,v1x,v1y,v2x,v2y){const newTr=Transform.createIdentity();const d=newTr.data;d[0]=v1x;d[3]=v1y;d[1]=v2x;d[4]=v2y;d[2]=ox;d[5]=oy;return newTr;}
function makeRelativeGradFD(fd,sourceNode,targetBBCenter,totalAngleRad){const sGeom=fdToSpreadGeom(fd,sourceNode);const srcBBC=bbCenter(sourceNode);let newGeom={p0x:targetBBCenter.x+(sGeom.p0x-srcBBC.x),p0y:targetBBCenter.y+(sGeom.p0y-srcBBC.y),v1x:sGeom.v1x,v1y:sGeom.v1y,v2x:sGeom.v2x,v2y:sGeom.v2y};if(totalAngleRad&&Math.abs(totalAngleRad)>0.0001){const cosR=Math.cos(totalAngleRad),sinR=Math.sin(totalAngleRad);newGeom=rotateGeom(newGeom,targetBBCenter.x,targetBBCenter.y,cosR,sinR);}return FillDescriptor.create(fd.fill,false,makeTrFromGeom(newGeom),fd.blendMode,false);}
function getLocalBB(node){let lx0=1e9,lx1=-1e9,ly0=1e9,ly1=-1e9;try{const pc=node.curvesInterface.polyCurve;for(let ci=0;ci<pc.curveCount;ci++){for(const nd of pc.at(ci).nodes){lx0=Math.min(lx0,nd.position.x);lx1=Math.max(lx1,nd.position.x);ly0=Math.min(ly0,nd.position.y);ly1=Math.max(ly1,nd.position.y);}}}catch(e){}if(lx0>lx1){const bb=node.getSpreadBaseBox(false);return{x:bb.x,y:bb.y,w:bb.width,h:bb.height};}return{x:lx0,y:ly0,w:lx1-lx0,h:ly1-ly0};}
function setMeshFDForTarget(meshFD,dstNode){const lb=getLocalBB(dstNode);const newTr=Transform.createIdentity();const d=newTr.data;d[0]=lb.w;d[3]=0;d[1]=0;d[4]=lb.h;d[2]=lb.x;d[5]=lb.y;stableBrushWrite(dstNode,meshFD.cloneWithNewTransform(newTr));}
function setMeshPenFDForTarget(meshFD,dstNode){const lb=getLocalBB(dstNode);const newTr=Transform.createIdentity();const d=newTr.data;d[0]=lb.w;d[3]=0;d[1]=0;d[4]=lb.h;d[2]=lb.x;d[5]=lb.y;stablePenWrite(dstNode,meshFD.cloneWithNewTransform(newTr));}
function setNodeRotationTransform(doc,node,alpha,cx,cy){const cosA=Math.cos(alpha),sinA=Math.sin(alpha);const tf=Transform.createIdentity();const d=tf.data;d[0]=cosA;d[1]=-sinA;d[2]=cx;d[3]=sinA;d[4]=cosA;d[5]=cy;doc.executeCommand(DocumentCommand.createTransform(Selection.create(doc,[node]),tf,{duplicateNodes:false}));}
function applyGuiRotation(doc,node,guiAngleRad,px,py){if(Math.abs(guiAngleRad)<0.0001)return;const cosG=Math.cos(guiAngleRad),sinG=Math.sin(guiAngleRad);const tf=Transform.createIdentity();const d=tf.data;d[0]=cosG;d[1]=-sinG;d[2]=px-cosG*px+sinG*py;d[3]=sinG;d[4]=cosG;d[5]=py-sinG*px-cosG*py;doc.executeCommand(DocumentCommand.createTransform(Selection.create(doc,[node]),tf,{duplicateNodes:false}));}
function getRefOrigin(doc,refNode){if(!refNode)return null;try{const ft=refNode.brushFillDescriptor?.fill?.fillType?.value;if(ft===4||ft===6){const g=getSpreadGeomViaAnchor(doc,refNode);return{ox:g.ox,oy:g.oy};}}catch(e){}const bbc=bbCenter(refNode);return{ox:bbc.x,oy:bbc.y};}
function getPenRefOrigin(doc,refNode){if(!refNode)return null;try{const pfd=refNode.penFillDescriptor;if(!pfd||!pfd.fill)return null;const ft=pfd.fill.fillType.value;if(ft===4||ft===6){const g=getPenSpreadGeomViaAnchor(doc,refNode);if(g)return{ox:g.ox,oy:g.oy};}}catch(e){}const bbc=bbCenter(refNode);return{ox:bbc.x,oy:bbc.y};}
function setFDWithSpreadGeom(doc,fd,dstNode,ox,oy,v1x,v1y,v2x,v2y){stableBrushWrite(dstNode,fd);doc.setBrushFillIsAnchoredToSpread(true,dstNode,{applyToAllFills:false},false);const newFD=dstNode.brushFillDescriptor.cloneWithNewTransform(spreadGeomToTransform(ox,oy,v1x,v1y,v2x,v2y));dstNode.brushFillDescriptor=newFD;doc.setBrushFillIsAnchoredToSpread(false,dstNode,{applyToAllFills:false},false);}
function setPenFDWithSpreadGeom(doc,fd,dstNode,ox,oy,v1x,v1y,v2x,v2y){try{stablePenWrite(dstNode,fd);doc.setPenFillIsAnchoredToSpread(true,dstNode,{applyToAllFills:false},false);const newFD=dstNode.penFillDescriptor.cloneWithNewTransform(spreadGeomToTransform(ox,oy,v1x,v1y,v2x,v2y));dstNode.penFillDescriptor=newFD;doc.setPenFillIsAnchoredToSpread(false,dstNode,{applyToAllFills:false},false);}catch(e){}}
function applyRotToGeom(srcGeom,totalRot,alphaA,alphaB,tE,rotateFill,alphaSrc){let{v1x,v1y,v2x,v2y}=srcGeom;let rot=totalRot;if(rotateFill){const ai=slerpAngle(alphaA,alphaB,tE);rot+=(ai-alphaSrc);}if(Math.abs(rot)>0.0001){const cosR=Math.cos(rot),sinR=Math.sin(rot);const nv1x=v1x*cosR-v1y*sinR,nv1y=v1x*sinR+v1y*cosR;const nv2x=v2x*cosR-v2y*sinR,nv2y=v2x*sinR+v2y*cosR;v1x=nv1x;v1y=nv1y;v2x=nv2x;v2y=nv2y;}return{v1x,v1y,v2x,v2y};}
function setBitmapFDForTarget(doc,fd,srcNode,refNode,dstNode,tE,rotateFill,guiAngleRad,alphaA,alphaB,alphaSrc,invertOrigin){const srcGeom=getSpreadGeomViaAnchor(doc,srcNode);const ro=getRefOrigin(doc,refNode);const newOx=ro?(invertOrigin?lerp(ro.ox,srcGeom.ox,tE):lerp(srcGeom.ox,ro.ox,tE)):srcGeom.ox;const newOy=ro?(invertOrigin?lerp(ro.oy,srcGeom.oy,tE):lerp(srcGeom.oy,ro.oy,tE)):srcGeom.oy;const{v1x,v1y,v2x,v2y}=applyRotToGeom(srcGeom,guiAngleRad,alphaA,alphaB,tE,rotateFill,alphaSrc);setFDWithSpreadGeom(doc,fd,dstNode,newOx,newOy,v1x,v1y,v2x,v2y);}
function setBitmapPenFDForTarget(doc,fd,srcNode,refNode,dstNode,tE,rotateFill,guiAngleRad,alphaA,alphaB,alphaSrc,invertOrigin){const srcGeom=getPenSpreadGeomViaAnchor(doc,srcNode);if(!srcGeom)return;const ro=getPenRefOrigin(doc,refNode);const newOx=ro?(invertOrigin?lerp(ro.ox,srcGeom.ox,tE):lerp(srcGeom.ox,ro.ox,tE)):srcGeom.ox;const newOy=ro?(invertOrigin?lerp(ro.oy,srcGeom.oy,tE):lerp(srcGeom.oy,ro.oy,tE)):srcGeom.oy;const{v1x,v1y,v2x,v2y}=applyRotToGeom(srcGeom,guiAngleRad,alphaA,alphaB,tE,rotateFill,alphaSrc);setPenFDWithSpreadGeom(doc,fd,dstNode,newOx,newOy,v1x,v1y,v2x,v2y);}
function setHatchFDForTarget(doc,fd,srcNode,refNode,dstNode,tE,rotateFill,guiAngleRad,alphaA,alphaB,alphaSrc,invertOrigin){const srcGeom=getSpreadGeomViaAnchor(doc,srcNode);const ro=getRefOrigin(doc,refNode);const newOx=ro?(invertOrigin?lerp(ro.ox,srcGeom.ox,tE):lerp(srcGeom.ox,ro.ox,tE)):srcGeom.ox;const newOy=ro?(invertOrigin?lerp(ro.oy,srcGeom.oy,tE):lerp(srcGeom.oy,ro.oy,tE)):srcGeom.oy;const{v1x,v1y,v2x,v2y}=applyRotToGeom(srcGeom,guiAngleRad,alphaA,alphaB,tE,rotateFill,alphaSrc);setFDWithSpreadGeom(doc,fd,dstNode,newOx,newOy,v1x,v1y,v2x,v2y);}
function setHatchPenFDForTarget(doc,fd,srcNode,refNode,dstNode,tE,rotateFill,guiAngleRad,alphaA,alphaB,alphaSrc,invertOrigin){const srcGeom=getPenSpreadGeomViaAnchor(doc,srcNode);if(!srcGeom)return;const ro=getPenRefOrigin(doc,refNode);const newOx=ro?(invertOrigin?lerp(ro.ox,srcGeom.ox,tE):lerp(srcGeom.ox,ro.ox,tE)):srcGeom.ox;const newOy=ro?(invertOrigin?lerp(ro.oy,srcGeom.oy,tE):lerp(srcGeom.oy,ro.oy,tE)):srcGeom.oy;const{v1x,v1y,v2x,v2y}=applyRotToGeom(srcGeom,guiAngleRad,alphaA,alphaB,tE,rotateFill,alphaSrc);setPenFDWithSpreadGeom(doc,fd,dstNode,newOx,newOy,v1x,v1y,v2x,v2y);}
function setFillOnTargetM2(doc,sourceFD,sourceNode,targetNode,srcSpreadBB,dstSpreadBB,refNode,tE,rotateFill,guiAngleRad,fpx,fpy,alphaA,alphaB,alphaSrc,invertOrigin){const ft=sourceFD.fill.fillType.value;try{if(ft===FillType.Gradient.value){const tbc=bbCenter(targetNode);let totalRot=guiAngleRad;if(rotateFill){const ai=slerpAngle(alphaA,alphaB,tE);totalRot+=(ai-alphaSrc);}stableBrushWrite(targetNode,makeRelativeGradFD(sourceFD,sourceNode,tbc,totalRot));}else if(ft===4){setBitmapFDForTarget(doc,sourceFD,sourceNode,refNode,targetNode,tE,rotateFill,guiAngleRad,alphaA,alphaB,alphaSrc,invertOrigin);}else if(ft===6){setHatchFDForTarget(doc,sourceFD,sourceNode,refNode,targetNode,tE,rotateFill,guiAngleRad,alphaA,alphaB,alphaSrc,invertOrigin);}else if(ft===5){setMeshFDForTarget(sourceFD,targetNode);}else{stableBrushWrite(targetNode,sourceFD);}}catch(e){try{stableBrushWrite(targetNode,sourceFD);}catch(e2){}}}
function setPenFDForTarget(doc,sourcePFD,sourceNode,refNode,targetNode,wt,tE,rotateFill,guiAngleRad,alphaA,alphaB,alphaSrc,invertOrigin){if(wt<=0||!sourcePFD||!sourcePFD.fill)return;const ft=sourcePFD.fill.fillType.value;try{if(ft===FillType.Gradient.value){const tbc=bbCenter(targetNode);let totalRot=guiAngleRad;if(rotateFill){const ai=slerpAngle(alphaA,alphaB,tE);totalRot+=(ai-alphaSrc);}stablePenWrite(targetNode,makeRelativeGradFD(sourcePFD,sourceNode,tbc,totalRot));}else if(ft===4){setBitmapPenFDForTarget(doc,sourcePFD,sourceNode,refNode,targetNode,tE,rotateFill,guiAngleRad,alphaA,alphaB,alphaSrc,invertOrigin);}else if(ft===6){setHatchPenFDForTarget(doc,sourcePFD,sourceNode,refNode,targetNode,tE,rotateFill,guiAngleRad,alphaA,alphaB,alphaSrc,invertOrigin);}else if(ft===5){setMeshPenFDForTarget(sourcePFD,targetNode);}else{stablePenWrite(targetNode,sourcePFD);}}catch(e){try{stablePenWrite(targetNode,sourcePFD);}catch(e2){}}}
function applyStyleForMethod2(doc,sourceNode,refNode,targetNode,wInterp,sourceLs,nodeOpacity,applyFX,srcBB,dstBB,tE,rotateFill,guiAngleRad,fpx,fpy,alphaA,alphaB,alphaSrc,invertOrigin){const fd=sourceNode.brushFillDescriptor;doc.executeCommand(DocumentCommand.createSetOpacity(Selection.create(doc,[targetNode]),nodeOpacity));if(wInterp>0){if(sourceLs){try{doc.executeCommand(DocumentCommand.createSetLineStyleDescriptor(Selection.create(doc,[targetNode]),sourceLs));}catch(e){}}targetNode.lineWeightPts=wInterp;try{const pfd=sourceNode.penFillDescriptor;if(pfd&&pfd.fill){setPenFDForTarget(doc,pfd,sourceNode,refNode,targetNode,wInterp,tE,rotateFill,guiAngleRad,alphaA,alphaB,alphaSrc,invertOrigin);}}catch(e){}}else{targetNode.lineWeightPts=0;}if(applyFX)applyFXFromNode(doc,sourceNode,targetNode);setFillOnTargetM2(doc,fd,sourceNode,targetNode,srcBB,dstBB,refNode,tE,rotateFill,guiAngleRad,fpx,fpy,alphaA,alphaB,alphaSrc,invertOrigin);}

function sampleC(c,nodeTF,cnt){const pts=[];let bz=[];try{bz=c.beziers.toArray();}catch(e){}if(bz.length>0){const pb=Math.max(2,Math.floor(cnt/bz.length));for(const b of bz){for(let si=0;si<pb;si++){const t=si/pb,mt=1-t;const lx=mt*mt*mt*b.start.x+3*mt*mt*t*b.c1.x+3*mt*t*t*b.c2.x+t*t*t*b.end.x;const ly=mt*mt*mt*b.start.y+3*mt*mt*t*b.c1.y+3*mt*t*t*b.c2.y+t*t*t*b.end.y;const p=applyTFtoPoint(nodeTF,lx,ly);if(isFinite(p.x)&&isFinite(p.y))pts.push(p);}}}if(!pts.length){for(const nd of c.nodes){const p=applyTFtoPoint(nodeTF,nd.position.x,nd.position.y);if(isFinite(p.x)&&isFinite(p.y))pts.push(p);}}return pts;}
function sampleNode(node,sampleRes){const curves=[];let anyOpen=false;try{const pc=node.curvesInterface.polyCurve,ntf=composedSpreadTF(node);for(let ci=0;ci<pc.curveCount;ci++){const c=pc.at(ci);const pts=sampleC(c,ntf,sampleRes);if(pts.length>1)curves.push({pts,isClosed:c.isClosed});if(!c.isClosed)anyOpen=true;}}catch(e){}return{curves,anyOpen};}
function resample(pts,N){if(!pts.length)return Array(N).fill({x:0,y:0});if(pts.length===1)return Array(N).fill(pts[0]);const r=[];for(let i=0;i<N;i++){const f=(N===1)?0:(i/(N-1))*(pts.length-1);const lo=Math.floor(f),hi=Math.min(lo+1,pts.length-1),t=f-lo;r.push({x:lerp(pts[lo].x,pts[hi].x,t),y:lerp(pts[lo].y,pts[hi].y,t)});}return r;}
function ptCurve(px,py,N){return Array(N).fill({x:px,y:py});}

function alignStartPoint(ptsA,ptsB,closedB){
    if(!closedB||ptsA.length<3)return ptsB;
    const N=ptsB.length;
    let bestOffset=0,bestRev=false,bestDist=Infinity;
    for(const rev of [false,true]){
        const arr=rev?ptsB.slice().reverse():ptsB;
        for(let off=0;off<N;off++){
            let d=0;
            for(let i=0;i<N;i++){
                const b=arr[(i+off)%N],a=ptsA[i];
                const dx=a.x-b.x,dy=a.y-b.y;
                d+=dx*dx+dy*dy;
            }
            if(d<bestDist){bestDist=d;bestOffset=off;bestRev=rev;}
        }
    }
    const arr=bestRev?ptsB.slice().reverse():ptsB;
    const out=[];for(let i=0;i<N;i++)out.push(arr[(i+bestOffset)%N]);
    return out;
}
function getForcedAnchor(item,node){
    try{
        if(!item)return null;
        const sub=item.getSubSelectionOfType(SubSelectionType.CurveNode);
        if(!sub||sub.isEmpty||sub.itemCount!==1)return null;
        const it=sub.getItem(0);
        if(it.curveID!==0)return null;
        const curve=node.curvesInterface.polyCurve.at(0);
        const onCurveIds=[];
        for(let i=0;i<curve.nodeCount;i++){if(curve.getNode(i).type.value===0)onCurveIds.push(i);}
        const isClosed=curve.isClosed;
        for(let idx=0;idx<onCurveIds.length;idx++){
            const aIdx=(isClosed&&idx===onCurveIds.length-1)?0:idx;
            if(onCurveIds[idx]===it.nodeID)return aIdx;
        }
        return null;
    }catch(e){return null;}
}
function rotateRawToAnchor(node,pts,ankerIdx,sampleRes){
    if(ankerIdx==null)return pts;
    let bzLen=0;
    try{bzLen=node.curvesInterface.polyCurve.at(0).beziers.toArray().length;}catch(e){}
    if(bzLen<=0)return pts;
    const pb=Math.max(2,Math.floor(sampleRes/bzLen));
    const rawIdx=ankerIdx*pb;
    if(rawIdx<=0||rawIdx>=pts.length)return pts;
    return pts.slice(rawIdx).concat(pts.slice(0,rawIdx));
}
function findPathObject(doc,excludeNodes){
    for(const l of doc.layers.all){
        if(!l.curvesInterface)continue;
        const name=l.userDescription||l.defaultDescription||'';
        if(!name.startsWith('_'))continue;
        let excluded=false;
        for(const ex of excludeNodes){if(ex&&l.isSameNode(ex)){excluded=true;break;}}
        if(excluded)continue;
        return l;
    }
    return null;
}
const PATH_SAMPLE_RES=300;
function buildPathSamplerFromNode(pathNode){
    if(!pathNode)return null;
    const{curves}=sampleNode(pathNode,PATH_SAMPLE_RES);
    if(!curves.length)return null;
    return buildPathSampler(curves[0].pts);
}

function rgba8ToHsl(r,g,b,alpha){r/=255;g/=255;b/=255;const max=Math.max(r,g,b),min=Math.min(r,g,b);let h=0,s=0;const l=(max+min)/2;if(max!==min){const d=max-min;s=l>0.5?d/(2-max-min):d/(max+min);switch(max){case r:h=((g-b)/d+(g<b?6:0))/6;break;case g:h=((b-r)/d+2)/6;break;case b:h=((r-g)/d+4)/6;break;}}return{h,s,l,alpha:(alpha!=null?alpha:255)/255};}
function mkCol(hsl,noise){const col=Colour.createHSLAf(hsl);try{col.noise=noise||0;}catch(e){}return col;}
function r8(r,g,b,a){return RGBA8(r,g,b,a!=null?a:255);}
function cToRGBA(c){try{if(c instanceof Colour)return c.rgba8;return new Colour(c).rgba8;}catch(e){return{r:0,g:0,b:0,alpha:255};}}
function rgba8Eq(a,b){return a.r===b.r&&a.g===b.g&&a.b===b.b&&a.alpha===b.alpha;}
function readSt(grad,i){const s=grad.getStop(i);const col=new Colour(s.colour);const rgba8=col.rgba8;let hsl,noise=0;try{hsl=col.hslaf;}catch(e){hsl=rgba8ToHsl(rgba8.r,rgba8.g,rgba8.b,rgba8.alpha*255);}try{noise=col.noise||0;}catch(e){}return{position:s.position,midpoint:s.midpoint!=null?s.midpoint:0.5,noise,hsl,rgba8,origColour:new Colour(s.colour)};}
function readStops(gf){const g=gf.gradient,st=[];for(let i=0;i<g.stopCount;i++)st.push(readSt(g,i));st.sort((a,b)=>a.position-b.position);return st;}
function origStops(gf){const g=gf.gradient,r=[];for(let i=0;i<g.stopCount;i++){const s=g.getStop(i);r.push({colour:new Colour(s.colour),position:s.position,midpoint:s.midpoint!=null?s.midpoint:0.5});}return r;}
function colStops(rgba){const hsl=rgba8ToHsl(rgba.r,rgba.g,rgba.b,rgba.alpha);return[{position:0,midpoint:0.5,noise:0,hsl,rgba8:rgba},{position:1,midpoint:0.5,noise:0,hsl,rgba8:rgba}];}
function normHsl(h){if(h.l<0.001||h.l>0.999)return{...h,s:0};return h;}
function resHue(h,p){const n=normHsl(h);if(n.s<0.001)return{...n,h:p.h};return n;}
function resampleSt(stops,n){if(stops.length===n)return stops;const r=[];for(let i=0;i<n;i++){const pos=i/(n-1);let lo=stops[0],hi=stops[stops.length-1];for(let j=0;j<stops.length-1;j++){if(stops[j].position<=pos&&stops[j+1].position>=pos){lo=stops[j];hi=stops[j+1];break;}}const span=hi.position-lo.position,lt=span>0.001?(pos-lo.position)/span:0;const hA=lo.hsl,hB=hi.hsl;r.push({position:pos,midpoint:lerp(lo.midpoint||0.5,hi.midpoint||0.5,lt),noise:lerp(lo.noise||0,hi.noise||0,lt),hsl:{h:lerp(hA.h,hB.h,lt),s:lerp(hA.s,hB.s,lt),l:lerp(hA.l,hB.l,lt),alpha:lerp(hA.alpha,hB.alpha,lt)},rgba8:lo.rgba8&&hi.rgba8?{r:lerp(lo.rgba8.r,hi.rgba8.r,lt),g:lerp(lo.rgba8.g,hi.rgba8.g,lt),b:lerp(lo.rgba8.b,hi.rgba8.b,lt),alpha:lerp(lo.rgba8.alpha,hi.rgba8.alpha,lt)}:null,origColour:null});}return r;}
function cwStops(sA,sB,dir){const hA=resHue(normHsl(sA.hsl),sB.hsl),hB=resHue(normHsl(sB.hsl),sA.hsl);let arc=hB.h-hA.h;if(dir===1&&arc<0)arc+=1;if(dir===-1&&arc>0)arc-=1;const n=Math.min(6,Math.floor(Math.abs(arc)/(6/360)));if(n<=0)return[];const res=[];for(let k=1;k<=n;k++){const t=k/(n+1),h=((hA.h+arc*t)%1+1)%1;res.push({position:lerp(sA.position,sB.position,t),midpoint:0.5,noise:lerp(sA.noise||0,sB.noise||0,t),hsl:{h,s:lerp(hA.s,hB.s,t),l:lerp(hA.l,hB.l,t),alpha:lerp(hA.alpha,hB.alpha,t)},rgba8:null,origColour:null});}return res;}
function rgbDirectStops(rsA,rsB,t){const n=Math.max(rsA.length,rsB.length);const res=[];for(let i=0;i<n;i++){const sA=rsA[Math.min(i,rsA.length-1)],sB=rsB[Math.min(i,rsB.length-1)];const cA=sA.rgba8||mkCol(sA.hsl,sA.noise||0).rgba8;const cB=sB.rgba8||mkCol(sB.hsl,sB.noise||0).rgba8;const r=Math.round(lerp(cA.r,cB.r,t)),g=Math.round(lerp(cA.g,cB.g,t)),b=Math.round(lerp(cA.b,cB.b,t)),al=Math.round(lerp(cA.alpha,cB.alpha,t));res.push({colour:RGBA8(r,g,b,al),position:lerp(sA.position,sB.position,t),midpoint:lerp(sA.midpoint||0.5,sB.midpoint||0.5,t)});}return res;}
function iStops(stA,stB,t,cm,gfA,gfB){if(t<=0)return gfA?origStops(gfA):null;if(t>=1)return gfB?origStops(gfB):null;const n=Math.max(stA.length,stB.length,2);const rsA=resampleSt(stA,n),rsB=resampleSt(stB,n);if(cm===3)return rgbDirectStops(rsA,rsB,t);const res=[];if(cm===0){for(let i=0;i<n;i++){const sA=rsA[i],sB=rsB[i];if(sA.rgba8&&sB.rgba8&&rgba8Eq(sA.rgba8,sB.rgba8)&&sA.origColour){res.push({colour:sA.origColour,position:lerp(sA.position,sB.position,t),midpoint:lerp(sA.midpoint||0.5,sB.midpoint||0.5,t)});}else{const hA=sA.hsl,hB=sB.hsl;res.push({position:lerp(sA.position,sB.position,t),midpoint:lerp(sA.midpoint||0.5,sB.midpoint||0.5,t),noise:lerp(sA.noise||0,sB.noise||0,t),hsl:{h:lerp(hA.h,hB.h,t),s:lerp(hA.s,hB.s,t),l:lerp(hA.l,hB.l,t),alpha:lerp(hA.alpha,hB.alpha,t)}});}}return res;}const dir=cm===1?1:-1;const base=[];for(let i=0;i<n;i++){const sA=rsA[i],sB=rsB[i];const identical=sA.rgba8&&sB.rgba8&&rgba8Eq(sA.rgba8,sB.rgba8);const hA=resHue(normHsl(sA.hsl),sB.hsl),hB=resHue(normHsl(sB.hsl),sA.hsl);let arc=hB.h-hA.h;if(identical){arc=dir===1?1:-1;}else{if(dir===1&&arc<0)arc+=1;if(dir===-1&&arc>0)arc-=1;}const h=((hA.h+arc*t)%1+1)%1;base.push({position:lerp(sA.position,sB.position,t),midpoint:lerp(sA.midpoint||0.5,sB.midpoint||0.5,t),noise:lerp(sA.noise||0,sB.noise||0,t),hsl:{h,s:lerp(hA.s,hB.s,t),l:lerp(hA.l,hB.l,t),alpha:lerp(hA.alpha,hB.alpha,t)}});}for(let i=0;i<base.length;i++){res.push(base[i]);if(i<base.length-1)for(const ws of cwStops(base[i],base[i+1],dir))res.push(ws);}return res.length>0?res:base;}
function mkGrad(stops){return Gradient.create(stops.map(s=>s.colour?{colour:s.colour,position:s.position,midpoint:s.midpoint!=null?s.midpoint:0.5}:{colour:mkCol(s.hsl,s.noise||0),position:s.position,midpoint:s.midpoint!=null?s.midpoint:0.5}));}
function anaFD(fd,node){const ft=fd.fill.fillType.value;const isNone=ft===1||ft===FillType.None.value,isSolid=ft===FillType.Solid.value,isGrad=ft===FillType.Gradient.value;const bb_raw=node.getSpreadBaseBox(false);const sBB={x:bb_raw.x,y:bb_raw.y,w:bb_raw.width,h:bb_raw.height};if(isNone){const rgba={r:0,g:0,b:0,alpha:0};return{isNone,isSolid:false,isGrad:false,gft:-1,stops:colStops(rgba),solidRGBA:rgba,gfOrig:null,sGeom:solidGeom(sBB),anchored:false,blendMode:null,origFdTr:null,ft};}if(isSolid){const rgba=cToRGBA(fd.fill.colour);return{isNone:false,isSolid,isGrad:false,gft:-1,stops:colStops(rgba),solidRGBA:rgba,gfOrig:null,sGeom:solidGeom(sBB),anchored:false,blendMode:null,origFdTr:null,ft};}if(isGrad){const gf=fd.fill,anchored=fd.isAnchoredToSpread,sGeom=fdToSpreadGeom(fd,node);return{isNone:false,isSolid:false,isGrad:true,gft:gf.gradientFillType,stops:readStops(gf),solidRGBA:null,gfOrig:gf,sGeom,anchored,blendMode:fd.blendMode,origFdTr:fd.transform.clone(),ft};}return{isNone:false,isSolid:false,isGrad:false,isSpecial:true,gft:-1,stops:colStops({r:0,g:0,b:0,alpha:0}),solidRGBA:{r:0,g:0,b:0,alpha:0},gfOrig:null,sGeom:solidGeom(sBB),anchored:false,blendMode:null,origFdTr:null,ft};}
function valPairM1(aA,aB){const INTERP=[1,2,3];if(!INTERP.includes(aA.ft))return'⚠ Fill ('+ftName(aA.ft)+') cannot be interpolated\u2014use Style Blend.';if(!INTERP.includes(aB.ft))return'⚠ Fill ('+ftName(aB.ft)+') cannot be interpolated\u2014use Style Blend.';if(aA.isGrad&&aB.isGrad&&aA.gft!==aB.gft){const n=['Linear','Elliptical','Radial','Conical'];return'⚠ Different gradient types ('+n[aA.gft]+'/'+n[aB.gft]+')\u2014use Style Blend.';}return null;}
function iFillGeom(aA,aB,t,cm,useAnchored){if(!aA.isGrad&&!aB.isGrad){if(aA.isNone&&aB.isNone)return{fd:FillDescriptor.createSolid(r8(0,0,0,0)),geom:null,gft:-1};if(t<=0){const c=aA.solidRGBA||{r:0,g:0,b:0,alpha:0};return{fd:FillDescriptor.createSolid(r8(c.r,c.g,c.b,c.alpha)),geom:null,gft:-1};}if(t>=1){const c=aB.solidRGBA||{r:0,g:0,b:0,alpha:0};return{fd:FillDescriptor.createSolid(r8(c.r,c.g,c.b,c.alpha)),geom:null,gft:-1};}if(cm===3){const cA=aA.solidRGBA||{r:0,g:0,b:0,alpha:0},cB=aB.solidRGBA||{r:0,g:0,b:0,alpha:0};const r=Math.round(lerp(cA.r,cB.r,t)),g=Math.round(lerp(cA.g,cB.g,t)),b=Math.round(lerp(cA.b,cB.b,t)),a=Math.round(lerp(cA.alpha,cB.alpha,t));return{fd:FillDescriptor.createSolid(r8(r,g,b,a)),geom:null,gft:-1};}const st=iStops(aA.stops,aB.stops,t,cm,null,null);if(!st||!st[0])return{fd:FillDescriptor.createSolid(RGBA8(128,128,128,255)),geom:null,gft:-1};const col=st[0].colour?st[0].colour:mkCol(st[0].hsl,st[0].noise||0);const rgba=col.rgba8;return{fd:FillDescriptor.createSolid(r8(rgba.r,rgba.g,rgba.b,rgba.alpha)),geom:null,gft:-1};}const st=iStops(aA.stops,aB.stops,t,cm,aA.gfOrig,aB.gfOrig);const gft=aA.isGrad?aA.gft:aB.gft;const gi=lerpPolar(aA.sGeom,aB.sGeom,t);let ng;if(st){ng=mkGrad(st);}else{ng=mkGrad(aA.stops.map((sA,i)=>{const sB=aB.stops[Math.min(i,aB.stops.length-1)];const hA=sA.hsl,hB=sB.hsl;return{position:lerp(sA.position,sB.position,t),midpoint:0.5,noise:0,hsl:{h:lerp(hA.h,hB.h,t),s:lerp(hA.s,hB.s,t),l:lerp(hA.l,hB.l,t),alpha:lerp(hA.alpha,hB.alpha,t)}};}));}let tr;if(t<=0&&aA.origFdTr){tr=aA.origFdTr;}else if(t>=1&&aB.origFdTr){tr=aB.origFdTr;}else{tr=makeTrFromGeom(gi);}const fd=FillDescriptor.create(GradientFill.create(ng,gft),false,tr,aA.isGrad?aA.blendMode:aB.blendMode,useAnchored);return{fd,geom:gi,gft,ng,blendMode:aA.isGrad?aA.blendMode:aB.blendMode,useAnchored};}
function fdFromGeom(result,geomRotated){if(!result.geom||!geomRotated)return result.fd;return FillDescriptor.create(GradientFill.create(result.ng,result.gft),false,makeTrFromGeom(geomRotated),result.blendMode,result.useAnchored);}

function getWt(n){try{const w=n.lineWeightPts;return(typeof w==='number'&&isFinite(w))?w:0;}catch(e){return 0;}}
function getLS(n){try{return n.lineStyleDescriptor;}catch(e){return null;}}
function getPenAna(node){try{const pfd=node.penFillDescriptor;if(!pfd||!pfd.fill)return null;return anaFD(pfd,node);}catch(e){return null;}}
function readAttrs(doc,info,sampleRes){
    const{node,seqIdx,isText}=info;const{curves,anyOpen}=sampleNode(node,sampleRes);
    if(!isText)return{bAna:anaFD(node.brushFillDescriptor,node),pAna:getPenAna(node),wt:getWt(node),ls:getLS(node),curves,anyOpen,bbc:bbCenter(node)};
    doc.executeCommand(DocumentCommand.createConvertToCurves(Selection.create(doc,[node])));
    let conv=null,ix=0;for(const l of doc.layers.all){if(!l.curvesInterface)continue;if(ix===seqIdx){conv=l;break;}ix++;}
    let bAna=anaFD(FillDescriptor.createSolid(RGBA8(0,0,0,0)),node);let pAna=null,wt=0,ls=null;
    if(conv?.curvesInterface?.isMutable){try{bAna=anaFD(conv.brushFillDescriptor,conv);}catch(e){}pAna=getPenAna(conv);wt=getWt(conv);ls=getLS(conv);}
    doc.executeCommand(DocumentCommand.createUndo());
    return{bAna,pAna,wt,ls,curves,anyOpen,bbc:bbCenter(node)};
}
function buildGeomNode(doc,cdA,cdB,nC,fpA,fpB,t,dm,dexp,rotDeg,fullTurns,rotDm,rotExp,steps,si,lockPivot,spiralMode,spiralTurns,spiralBulge,pathMode,pathSampler,chainSeg,chainSegs,continuousChain){
    const tE=easedT(t,dexp,dm);const angleFrac=(steps+1)>0?si/(steps+1):0;const easedFrac=easedAngle(angleFrac,rotExp,rotDm);
    const segCount=chainSegs>1?chainSegs:1;const seg0=chainSeg||0;
    const globalFrac=segCount>1?(seg0+easedFrac)/segCount:easedFrac;
    const rotFrac=continuousChain?globalFrac:easedFrac;
    const totalAngleDeg=rotDeg*(steps+1)+fullTurns*360;const angleRad=(totalAngleDeg*rotFrac)*Math.PI/180;const cosA=Math.cos(angleRad),sinA=Math.sin(angleRad);
    const pathFrac=pathMode?globalFrac:easedFrac;
    const piv=pivotPoint(fpA,fpB,easedFrac,lockPivot,spiralMode,spiralTurns,spiralBulge,pathMode,pathSampler,pathFrac,rotFrac);const cx=piv.x,cy=piv.y;
    const shift=pathShiftAt(fpA,fpB,easedFrac,pathMode,pathSampler,pathFrac);
    const pc=new PolyCurve();
    for(let ci=0;ci<nC;ci++){const dA=cdA[ci],dB=cdB[ci];let mPts=dA.pts.map((p,i)=>({x:lerp(p.x,dB.pts[i].x,tE)+shift.x,y:lerp(p.y,dB.pts[i].y,tE)+shift.y}));if((rotDeg!==0||fullTurns!==0)&&angleRad!==0){mPts=mPts.map(p=>{const dx=p.x-cx,dy=p.y-cy;return{x:cx+dx*cosA-dy*sinA,y:cy+dx*sinA+dy*cosA};});}if(!mPts.every(p=>isFinite(p.x)&&isFinite(p.y)))return null;const cb=new CurveBuilder();cb.begin(mPts[0]);for(let pi=1;pi<mPts.length;pi++)cb.lineTo(mPts[pi]);if(dA.isClosed||dB.isClosed)cb.close();pc.addCurve(cb.createCurve());}
    const def=PolyCurveNodeDefinition.createDefault();def.setCurves(pc);const ab=AddChildNodesCommandBuilder.create();ab.addPolyCurveNode(def);const ac=ab.createCommand(false);doc.executeCommand(ac);
    return{nn:ac.newNodes[0],tE,angleRad,cosA,sinA,cx,cy};
}
function buildGeomNodeMesh(doc,cdA,cdB,nC,fpA,fpB,t,dm,dexp,rotDeg,fullTurns,rotDm,rotExp,steps,si,alphaA,alphaB,lockPivot,spiralMode,spiralTurns,spiralBulge,pathMode,pathSampler,chainSeg,chainSegs,continuousChain){
    const tE=easedT(t,dexp,dm);const angleFrac=(steps+1)>0?si/(steps+1):0;const easedFrac=easedAngle(angleFrac,rotExp,rotDm);
    const segCount=chainSegs>1?chainSegs:1;const seg0=chainSeg||0;
    const globalFrac=segCount>1?(seg0+easedFrac)/segCount:easedFrac;
    const rotFrac=continuousChain?globalFrac:easedFrac;
    const totalAngleDeg=rotDeg*(steps+1)+fullTurns*360;const guiAngleRad=(totalAngleDeg*rotFrac)*Math.PI/180;const meshAlpha=slerpAngle(alphaA,alphaB,tE);const cosBack=Math.cos(-meshAlpha),sinBack=Math.sin(-meshAlpha);const allSpreadPts=[];
    for(let ci=0;ci<nC;ci++){const dA=cdA[ci],dB=cdB[ci];dA.pts.forEach((p,i)=>allSpreadPts.push({x:lerp(p.x,dB.pts[i].x,tE),y:lerp(p.y,dB.pts[i].y,tE)}));}
    let sx=0,sy=0;for(const p of allSpreadPts){sx+=p.x;sy+=p.y;}const spreadCx=sx/allSpreadPts.length,spreadCy=sy/allSpreadPts.length;const pc=new PolyCurve();
    for(let ci=0;ci<nC;ci++){const dA=cdA[ci],dB=cdB[ci];const mPts=dA.pts.map((p,i)=>({x:lerp(p.x,dB.pts[i].x,tE),y:lerp(p.y,dB.pts[i].y,tE)}));if(!mPts.every(p=>isFinite(p.x)&&isFinite(p.y)))return null;const lokPts=mPts.map(p=>{const dx=p.x-spreadCx,dy=p.y-spreadCy;return{x:dx*cosBack-dy*sinBack,y:dx*sinBack+dy*cosBack};});const cb=new CurveBuilder();cb.begin(lokPts[0]);for(let pi=1;pi<lokPts.length;pi++)cb.lineTo(lokPts[pi]);if(dA.isClosed||dB.isClosed)cb.close();pc.addCurve(cb.createCurve());}
    const def=PolyCurveNodeDefinition.createDefault();def.setCurves(pc);const ab=AddChildNodesCommandBuilder.create();ab.addPolyCurveNode(def);const ac=ab.createCommand(false);doc.executeCommand(ac);const nn=ac.newNodes[0];if(!nn)return null;
    setNodeRotationTransform(doc,nn,meshAlpha,spreadCx,spreadCy);
    const pathFrac=pathMode?globalFrac:easedFrac;
    const fpInterp=pivotPoint(fpA,fpB,easedFrac,lockPivot,spiralMode,spiralTurns,spiralBulge,pathMode,pathSampler,pathFrac,rotFrac);
    return{nn,tE,guiAngleRad,meshAlpha,spreadCx,spreadCy,fpInterp};
}
function makeGroup(doc,allNs,gName,nodeA,nodeB){
    const gb2=AddChildNodesCommandBuilder.create();gb2.addContainerNode(ContainerNodeDefinition.create(gName));gb2.setInsertionTargetSelection(Selection.create(doc,allNs));const gc=gb2.createCommand(false);doc.executeCommand(gc);const grp=gc.newNodes[0];if(!grp)return null;
    try{grp.userDescription=gName;}catch(e){}
    doc.executeCommand(DocumentCommand.createMoveNodes(Selection.create(doc,allNs),grp,NodeMoveType.Inside,NodeChildType.Main));
    let topNode=nodeA;for(const l of doc.layers.all){if(l.isSameNode(nodeA)){topNode=nodeA;break;}if(l.isSameNode(nodeB)){topNode=nodeB;break;}}
    try{doc.executeCommand(DocumentCommand.createMoveNodes(Selection.create(doc,[grp]),topNode,NodeMoveType.After,NodeChildType.Main));}catch(e){}
    return grp;
}
function makeGroupChain(doc,allNs,gName,sourceNodes){
    const gb2=AddChildNodesCommandBuilder.create();gb2.addContainerNode(ContainerNodeDefinition.create(gName));gb2.setInsertionTargetSelection(Selection.create(doc,allNs));const gc=gb2.createCommand(false);doc.executeCommand(gc);const grp=gc.newNodes[0];if(!grp)return null;
    try{grp.userDescription=gName;}catch(e){}
    doc.executeCommand(DocumentCommand.createMoveNodes(Selection.create(doc,allNs),grp,NodeMoveType.Inside,NodeChildType.Main));
    let topNode=sourceNodes[0];
    for(const l of doc.layers.all){
        let found=false;
        for(const sn of sourceNodes){if(sn&&l.isSameNode(sn)){topNode=sn;found=true;break;}}
        if(found)break;
    }
    try{doc.executeCommand(DocumentCommand.createMoveNodes(Selection.create(doc,[grp]),topNode,NodeMoveType.After,NodeChildType.Main));}catch(e){}
    return grp;
}
function createBlend(doc,infoA,infoB,steps,cm,rotDeg,fullTurns,rotDm,rotExp,dm,dexp,gName,applyFX,rotateFill,method,autoAlign,forcedA,forcedB,sampleRes,lockOpacity,lockColor,lockPivot,spiralMode,spiralTurns,spiralBulge,pathMode,pathSampler){
    const brushChA=setBrushToSpread(doc,infoA.node);const brushChB=setBrushToSpread(doc,infoB.node);
    const penChA=setPenToSpread(doc,infoA.node);const penChB=setPenToSpread(doc,infoB.node);
    const atA=readAttrs(doc,infoA,sampleRes),atB=readAttrs(doc,infoB,sampleRes);const aA=atA.bAna,aB=atB.bAna;
    if(method===0){const err=valPairM1(aA,aB);if(err){restoreBrush(doc,infoA.node,brushChA);restoreBrush(doc,infoB.node,brushChB);restorePen(doc,infoA.node,penChA);restorePen(doc,infoB.node,penChB);return{error:err};}}
    const bothAnchored=aA.isGrad&&aB.isGrad&&aA.anchored&&aB.anchored;const penBothAnchored=(atA.pAna?.anchored||false)&&(atB.pAna?.anchored||false);
    const nullAna={isNone:true,isSolid:false,isGrad:false,gft:-1,stops:colStops({r:0,g:0,b:0,alpha:0}),solidRGBA:{r:0,g:0,b:0,alpha:0},gfOrig:null,sGeom:solidGeom({x:0,y:0,w:1,h:1}),anchored:false,blendMode:null,origFdTr:null,ft:1};
    const opA=infoA.node.globalOpacity||1,opB=infoB.node.globalOpacity||1;const wA=atA.wt,wB=atB.wt;const bls=atA.ls;
    const pAnaA=atA.pAna||nullAna,pAnaB=atB.pAna||nullAna;const hasPenFill=(wA>0||wB>0)&&(!pAnaA.isNone||!pAnaB.isNone);
    const nA=infoA.name,nB=infoB.name;const alphaA=getNodeRotation(infoA.node),alphaB=getNodeRotation(infoB.node);const useMeshNodes=(method===1)&&(aA.ft===5||aB.ft===5);
    function getFP(n){try{const f=n.transformInterface.focalPoint;if(f.isValid)return applyTFtoPoint(composedSpreadTF(n),f.point.x,f.point.y);}catch(e){}try{const bb=n.getSpreadBaseBox(false);return{x:bb.x+bb.width/2,y:bb.y+bb.height/2};}catch(e){}return{x:0,y:0};}
    const fpA=getFP(infoA.node),fpB=getFP(infoB.node);const nCA=atA.curves.length,nCB=atB.curves.length,nC=Math.max(nCA||1,nCB||1);const rNA=nCA>0?atA.curves[0].pts.length:4;const cdA=[],cdB=[];
    for(let ci=0;ci<nC;ci++){
        let pA,pB,cA=true,cB=true;
        if(ci<nCA){pA=atA.curves[ci].pts;cA=atA.curves[ci].isClosed;}else{pA=ptCurve(fpA.x,fpA.y,rNA);}
        if(ci<nCB){pB=atB.curves[ci].pts;cB=atB.curves[ci].isClosed;}else{pB=ptCurve(fpB.x,fpB.y,rNA);}
        if(ci===0){
            if(forcedA!=null)pA=rotateRawToAnchor(infoA.node,pA,forcedA,sampleRes);
            if(forcedB!=null)pB=rotateRawToAnchor(infoB.node,pB,forcedB,sampleRes);
        }
        const N=Math.max(pA.length,pB.length,4);
        let rA=resample(pA,N),rB=resample(pB,N);
        const skipAuto=(ci===0&&forcedB!=null);
        if(autoAlign&&cB&&!skipAuto)rB=alignStartPoint(rA,rB,cB);
        cdA.push({pts:rA,isClosed:cA});cdB.push({pts:rB,isClosed:cB});
    }
    const restore=()=>{restoreBrush(doc,infoA.node,brushChA);restoreBrush(doc,infoB.node,brushChB);restorePen(doc,infoA.node,penChA);restorePen(doc,infoB.node,penChB);};
    const srcBBA=infoA.node.getSpreadBaseBox(false),srcBBB=infoB.node.getSpreadBaseBox(false);
    if(method===0){
        function mkNode(t_raw,si,label){
            const res=buildGeomNode(doc,cdA,cdB,nC,fpA,fpB,t_raw,dm,dexp,rotDeg,fullTurns,rotDm,rotExp,steps,si,lockPivot,spiralMode,spiralTurns,spiralBulge,pathMode,pathSampler);if(!res||!res.nn)return null;
            const{nn,tE,angleRad,cosA,sinA,cx,cy}=res;
            const brushResult=lockColor?{fd:infoA.node.brushFillDescriptor,geom:null,gft:-1}:iFillGeom(aA,aB,tE,cm,bothAnchored);let brushFD=brushResult.fd;
            if(!lockColor&&rotateFill&&brushResult.geom&&(rotDeg!==0||fullTurns!==0)&&angleRad!==0){brushFD=fdFromGeom(brushResult,rotateGeom(brushResult.geom,cx,cy,cosA,sinA));}
            try{doc.executeCommand(DocumentCommand.createSetBrushFill(Selection.create(doc,[nn]),brushFD));}catch(e){doc.executeCommand(DocumentCommand.createSetBrushFill(Selection.create(doc,[nn]),FillDescriptor.createSolid(RGBA8(128,128,128,255))));}
            doc.executeCommand(DocumentCommand.createSetOpacity(Selection.create(doc,[nn]),lockOpacity?opA:lerp(opA,opB,tE)));
            const wLerp=lerp(wA,wB,tE);
            if(wLerp>0){
                if(bls){try{doc.executeCommand(DocumentCommand.createSetLineStyleDescriptor(Selection.create(doc,[nn]),bls));}catch(e){}}
                nn.lineWeightPts=wLerp;
                if(hasPenFill){
                    const penResult=lockColor?{fd:infoA.node.penFillDescriptor,geom:null,gft:-1}:iFillGeom(pAnaA,pAnaB,tE,cm,penBothAnchored);let penFD=penResult.fd;
                    if(!lockColor&&rotateFill&&penResult.geom&&(rotDeg!==0||fullTurns!==0)&&angleRad!==0){penFD=fdFromGeom(penResult,rotateGeom(penResult.geom,cx,cy,cosA,sinA));}
                    try{doc.executeCommand(DocumentCommand.createSetPenFill(Selection.create(doc,[nn]),penFD));}catch(e){}
                }
            }else{nn.lineWeightPts=0;}
            if(applyFX)applyFXFromNode(doc,infoA.node,nn);nn.userDescription=label;return nn;
        }
        const rawA=mkNode(0,0,nA+' [0]');if(!rawA){restore();return{error:'Error A'};}
        const morphs=[];
        for(let i=1;i<=steps;i++){const nn=mkNode(i/(steps+1),i,nA+'\u2192'+nB+' ['+i+']');if(nn)morphs.push(nn);}
        const rawB=mkNode(1,steps+1,nB+' ['+(steps+1)+']');if(!rawB){restore();return{error:'Error B'};}
        const allNs=[rawB,...morphs.slice().reverse(),rawA];
        const grp=makeGroup(doc,allNs,gName,infoA.node,infoB.node);if(!grp){restore();return{error:'Error group'};}
        restore();return{grp};
    }else{
        const allNs=[];
        for(let i=0;i<=steps+1;i++){
            const t_raw=i/(steps+1);const tE=easedT(t_raw,dexp,dm);const wInterp=lerp(wA,wB,tE);
            const la=(i===0)?nA+' [0]':(i===steps+1)?nB+' ['+(steps+1)+']':nA+'\u2192'+nB+' ['+i+']';
            const lb=(i===0)?nA+'_b [0]':(i===steps+1)?nB+'_b ['+(steps+1)+']':nA+'\u2192'+nB+'_b ['+i+']';
            const angleFrac=(steps+1)>0?i/(steps+1):0;const easedFrac=easedAngle(angleFrac,rotExp,rotDm);
            const totalAngleDeg=rotDeg*(steps+1)+fullTurns*360;
            const guiAngleRad=(totalAngleDeg*easedFrac)*Math.PI/180;
            const fpInterp=pivotPoint(fpA,fpB,easedFrac,lockPivot,spiralMode,spiralTurns,spiralBulge,pathMode,pathSampler);
            let resB,resA;
            if(useMeshNodes){
                resB=buildGeomNodeMesh(doc,cdA,cdB,nC,fpA,fpB,t_raw,dm,dexp,rotDeg,fullTurns,rotDm,rotExp,steps,i,alphaA,alphaB,lockPivot,spiralMode,spiralTurns,spiralBulge,pathMode,pathSampler);if(!resB||!resB.nn){restore();return{error:'Error _b ['+i+']'};}
                applyStyleForMethod2(doc,infoB.node,infoA.node,resB.nn,wInterp,bls,opB,false,srcBBB,resB.nn.getSpreadBaseBox(false),tE,rotateFill,resB.guiAngleRad,resB.fpInterp.x,resB.fpInterp.y,alphaA,alphaB,alphaB,true);
                applyGuiRotation(doc,resB.nn,resB.guiAngleRad,resB.fpInterp.x,resB.fpInterp.y);
                if(pathMode&&pathSampler)applyPathShift(doc,resB.nn,resB.spreadCx,resB.spreadCy,resB.fpInterp.x,resB.fpInterp.y);
                resB.nn.userDescription=lb;allNs.push(resB.nn);
                resA=buildGeomNodeMesh(doc,cdA,cdB,nC,fpA,fpB,t_raw,dm,dexp,rotDeg,fullTurns,rotDm,rotExp,steps,i,alphaA,alphaB,lockPivot,spiralMode,spiralTurns,spiralBulge,pathMode,pathSampler);if(!resA||!resA.nn){restore();return{error:'Error A ['+i+']'};}
                applyStyleForMethod2(doc,infoA.node,infoB.node,resA.nn,wInterp,bls,(1-resA.tE)*opA,applyFX,srcBBA,resA.nn.getSpreadBaseBox(false),tE,rotateFill,resA.guiAngleRad,resA.fpInterp.x,resA.fpInterp.y,alphaA,alphaB,alphaA,false);
                applyGuiRotation(doc,resA.nn,resA.guiAngleRad,resA.fpInterp.x,resA.fpInterp.y);
                if(pathMode&&pathSampler)applyPathShift(doc,resA.nn,resA.spreadCx,resA.spreadCy,resA.fpInterp.x,resA.fpInterp.y);
                resA.nn.userDescription=la;allNs.push(resA.nn);
            }else{
                resB=buildGeomNode(doc,cdA,cdB,nC,fpA,fpB,t_raw,dm,dexp,rotDeg,fullTurns,rotDm,rotExp,steps,i,lockPivot,spiralMode,spiralTurns,spiralBulge,pathMode,pathSampler);if(!resB||!resB.nn){restore();return{error:'Error _b ['+i+']'};}
                applyStyleForMethod2(doc,infoB.node,infoA.node,resB.nn,wInterp,bls,opB,false,srcBBB,resB.nn.getSpreadBaseBox(false),tE,rotateFill,guiAngleRad,fpInterp.x,fpInterp.y,alphaA,alphaB,alphaB,true);
                resB.nn.userDescription=lb;allNs.push(resB.nn);
                resA=buildGeomNode(doc,cdA,cdB,nC,fpA,fpB,t_raw,dm,dexp,rotDeg,fullTurns,rotDm,rotExp,steps,i,lockPivot,spiralMode,spiralTurns,spiralBulge,pathMode,pathSampler);if(!resA||!resA.nn){restore();return{error:'Error A ['+i+']'};}
                applyStyleForMethod2(doc,infoA.node,infoB.node,resA.nn,wInterp,bls,(1-resA.tE)*opA,applyFX,srcBBA,resA.nn.getSpreadBaseBox(false),tE,rotateFill,guiAngleRad,fpInterp.x,fpInterp.y,alphaA,alphaB,alphaA,false);
                resA.nn.userDescription=la;allNs.push(resA.nn);
            }
        }
        const grp=makeGroup(doc,allNs,gName,infoA.node,infoB.node);if(!grp){restore();return{error:'Error group'};}
        restore();return{grp};
    }
}
function createChainBlend(doc,infoList,steps,cm,rotDeg,fullTurns,rotDm,rotExp,dm,dexp,gName,applyFX,rotateFill,autoAlign,sampleRes,lockOpacity,lockColor,lockPivot,spiralMode,spiralTurns,spiralBulge,pathMode,pathSampler,continuousChain){
    const N=infoList.length;
    if(N<2)return{error:'At least 2 objects required.'};
    const totalSegs=N-1;
    const allNs=[];
    let prevEndNode=null;
    for(let seg=0;seg<totalSegs;seg++){
        const infoA=infoList[seg],infoB=infoList[seg+1];
        const brushChA=setBrushToSpread(doc,infoA.node);const brushChB=setBrushToSpread(doc,infoB.node);
        const penChA=setPenToSpread(doc,infoA.node);const penChB=setPenToSpread(doc,infoB.node);
        const restoreSeg=()=>{restoreBrush(doc,infoA.node,brushChA);restoreBrush(doc,infoB.node,brushChB);restorePen(doc,infoA.node,penChA);restorePen(doc,infoB.node,penChB);};
        const atA=readAttrs(doc,infoA,sampleRes),atB=readAttrs(doc,infoB,sampleRes);const aA=atA.bAna,aB=atB.bAna;
        const err=valPairM1(aA,aB);
        if(err){restoreSeg();return{error:'Segment '+(seg+1)+' ('+infoA.name+'\u2192'+infoB.name+'): '+err};}
        const bothAnchored=aA.isGrad&&aB.isGrad&&aA.anchored&&aB.anchored;const penBothAnchored=(atA.pAna?.anchored||false)&&(atB.pAna?.anchored||false);
        const nullAna={isNone:true,isSolid:false,isGrad:false,gft:-1,stops:colStops({r:0,g:0,b:0,alpha:0}),solidRGBA:{r:0,g:0,b:0,alpha:0},gfOrig:null,sGeom:solidGeom({x:0,y:0,w:1,h:1}),anchored:false,blendMode:null,origFdTr:null,ft:1};
        const opA=infoA.node.globalOpacity||1,opB=infoB.node.globalOpacity||1;const wA=atA.wt,wB=atB.wt;const bls=atA.ls;
        const pAnaA=atA.pAna||nullAna,pAnaB=atB.pAna||nullAna;const hasPenFill=(wA>0||wB>0)&&(!pAnaA.isNone||!pAnaB.isNone);
        const nA=infoA.name,nB=infoB.name;
        function getFP(n){try{const f=n.transformInterface.focalPoint;if(f.isValid)return applyTFtoPoint(composedSpreadTF(n),f.point.x,f.point.y);}catch(e){}try{const bb=n.getSpreadBaseBox(false);return{x:bb.x+bb.width/2,y:bb.y+bb.height/2};}catch(e){}return{x:0,y:0};}
        const fpA=getFP(infoA.node),fpB=getFP(infoB.node);const nCA=atA.curves.length,nCB=atB.curves.length,nC=Math.max(nCA||1,nCB||1);const rNA=nCA>0?atA.curves[0].pts.length:4;const cdA=[],cdB=[];
        for(let ci=0;ci<nC;ci++){
            let pA,pB,cA=true,cB=true;
            if(ci<nCA){pA=atA.curves[ci].pts;cA=atA.curves[ci].isClosed;}else{pA=ptCurve(fpA.x,fpA.y,rNA);}
            if(ci<nCB){pB=atB.curves[ci].pts;cB=atB.curves[ci].isClosed;}else{pB=ptCurve(fpB.x,fpB.y,rNA);}
            if(ci===0){
                if(infoA.forcedAnker!=null)pA=rotateRawToAnchor(infoA.node,pA,infoA.forcedAnker,sampleRes);
                if(infoB.forcedAnker!=null)pB=rotateRawToAnchor(infoB.node,pB,infoB.forcedAnker,sampleRes);
            }
            const Nn=Math.max(pA.length,pB.length,4);
            let rA=resample(pA,Nn),rB=resample(pB,Nn);
            const skipAuto=(ci===0&&infoB.forcedAnker!=null);
            if(autoAlign&&cB&&!skipAuto)rB=alignStartPoint(rA,rB,cB);
            cdA.push({pts:rA,isClosed:cA});cdB.push({pts:rB,isClosed:cB});
        }
        function mkNode(t_raw,si,label){
            const res=buildGeomNode(doc,cdA,cdB,nC,fpA,fpB,t_raw,dm,dexp,rotDeg,fullTurns,rotDm,rotExp,steps,si,lockPivot,spiralMode,spiralTurns,spiralBulge,pathMode,pathSampler,seg,totalSegs,continuousChain);if(!res||!res.nn)return null;
            const{nn,tE,angleRad,cosA,sinA,cx,cy}=res;
            const brushResult=lockColor?{fd:infoA.node.brushFillDescriptor,geom:null,gft:-1}:iFillGeom(aA,aB,tE,cm,bothAnchored);let brushFD=brushResult.fd;
            if(!lockColor&&rotateFill&&brushResult.geom&&(rotDeg!==0||fullTurns!==0)&&angleRad!==0){brushFD=fdFromGeom(brushResult,rotateGeom(brushResult.geom,cx,cy,cosA,sinA));}
            try{doc.executeCommand(DocumentCommand.createSetBrushFill(Selection.create(doc,[nn]),brushFD));}catch(e){doc.executeCommand(DocumentCommand.createSetBrushFill(Selection.create(doc,[nn]),FillDescriptor.createSolid(RGBA8(128,128,128,255))));}
            doc.executeCommand(DocumentCommand.createSetOpacity(Selection.create(doc,[nn]),lockOpacity?opA:lerp(opA,opB,tE)));
            const wLerp=lerp(wA,wB,tE);
            if(wLerp>0){
                if(bls){try{doc.executeCommand(DocumentCommand.createSetLineStyleDescriptor(Selection.create(doc,[nn]),bls));}catch(e){}}
                nn.lineWeightPts=wLerp;
                if(hasPenFill){
                    const penResult=lockColor?{fd:infoA.node.penFillDescriptor,geom:null,gft:-1}:iFillGeom(pAnaA,pAnaB,tE,cm,penBothAnchored);let penFD=penResult.fd;
                    if(!lockColor&&rotateFill&&penResult.geom&&(rotDeg!==0||fullTurns!==0)&&angleRad!==0){penFD=fdFromGeom(penResult,rotateGeom(penResult.geom,cx,cy,cosA,sinA));}
                    try{doc.executeCommand(DocumentCommand.createSetPenFill(Selection.create(doc,[nn]),penFD));}catch(e){}
                }
            }else{nn.lineWeightPts=0;}
            if(applyFX)applyFXFromNode(doc,infoA.node,nn);nn.userDescription=label;return nn;
        }
        let segStartNode;
        if(seg===0){
            segStartNode=mkNode(0,0,nA+' [0]');
            if(!segStartNode){restoreSeg();return{error:'Error at chain start ('+nA+')'};}
            allNs.push(segStartNode);
        }else{
            segStartNode=prevEndNode;
        }
        for(let k=1;k<=steps;k++){
            const nn=mkNode(k/(steps+1),k,nA+'\u2192'+nB+' ['+k+']');
            if(nn)allNs.push(nn);
        }
        const segEndNode=mkNode(1,steps+1,nB+' ['+(steps+1)+']');
        if(!segEndNode){restoreSeg();return{error:'Error at chain end ('+nB+')'};}
        allNs.push(segEndNode);
        prevEndNode=segEndNode;
        restoreSeg();
    }
    const grp=makeGroupChain(doc,allNs.slice().reverse(),gName,infoList.map(x=>x.node));
    if(!grp)return{error:'Error creating group'};
    return{grp};
}

function hasFX(info){try{return info.node.layerEffectsInterface?.hasActiveEffects||false;}catch(e){return false;}}
function fxLabel(info){try{const c=info.node.layerEffectsInterface?.effectCount||0;return c>0?info.name+' ['+c+' FX]':info.name;}catch(e){return info.name;}}

const PRESET_DIR = app.userDesktopPath + '/AffinityScriptPresets';
function ensurePresetDir(){
    try{ if(!FileSystemApi.exists(PRESET_DIR)) FileSystemApi.createDirectories(PRESET_DIR); }catch(e){}
}
function savePresetToFile(p){
    try{
        const name=app.prompt('Enter preset name:','Save preset','MyPreset');
        if(!name||!name.trim())return;
        ensurePresetDir();
        const safe=name.trim().replace(/[\\/:*?"<>|]/g,'_');
        const path=PRESET_DIR+'/BLM_'+safe+'.json';
        const f=File.create(path,'wb');
        f.writeStringAsUtf8(JSON.stringify(p,null,2));
        f.close();
        console.log('✓ Preset saved: '+path);
    }catch(e){console.log('Error saving: '+e);}
}
function loadPresetFromFile(){
    try{
        ensurePresetDir();
        const path=app.chooseFile();
        if(!path)return null;
        const buf=File.readAll(path);
        const txt=buf.toString('utf8');
        return JSON.parse(txt);
    }catch(e){console.log('Error loading: '+e);return null;}
}
function deletePresetFile(){
    try{
        ensurePresetDir();
        const path=app.chooseFile();
        if(!path)return;
        FileSystemApi.remove(path);
        console.log('✓ Preset deleted: '+path);
    }catch(e){console.log('Error deleting: '+e);}
}
function showSmallError(title,msg){
    try{
        const ed=Dialog.create(title);const ec=ed.addColumn();const eg=ec.addGroup('');
        eg.addStaticText('',msg);
        eg.addButtonSet('',['Close'],0).isFullWidth=true;
        ed.runModal();
    }catch(e){}
}

const doc=Document.current;
if(!doc){console.log('No document open.');} else {
    const nodeInfos=[];let si=0;
    for(const l of doc.layers.all){if(!l.curvesInterface)continue;nodeInfos.push({node:l,seqIdx:si++,isText:l.isArtTextNode===true,name:l.userDescription||l.defaultDescription||'Object '+si});}
    const selInfos=[];
    try{
        const sel=doc.selection;
        for(let i=0;i<sel.length;i++){
            const item=sel.at(i);const n=item.node;if(!n||!n.curvesInterface)continue;
            const info=nodeInfos.find(x=>x.node.isSameNode(n));
            if(info){info.selItem=item;selInfos.push(info);}
        }
    }catch(e){}
    if(selInfos.length<2){
        showSmallError('Error','Please select at least 2 vector objects (3+ for a chain). Currently: '+selInfos.length+'.');
    }else{
        let chain=selInfos.slice();let gi=0;
        for(const l of doc.layers.all){try{if((l.userDescription||'').startsWith('BlendGroup')&&!(l.userDescription||'').includes('Preview'))gi++;}catch(e){}}
        const isChain=chain.length>2;
        for(const info of chain){info.forcedAnker=getForcedAnchor(info.selItem,info.node);}
        const meshFlags=chain.map(x=>hasMeshFill(x.node));
        const anyMesh=meshFlags.some(x=>x);

        const pathNode=findPathObject(doc,chain.map(x=>x.node));
        const pathSampler=buildPathSamplerFromNode(pathNode);

        // --- Dialog restructured into tabs (pattern: "Transform Objects v8").
        // Left: persistent navigation column (tab radio group, Preview,
        // Presets). Right: two content columns (cA, cB) whose groups are
        // shown/hidden per active tab via a PAGES mapping + .isVisible.
        const dlg=Dialog.create('Blend Morphing v115-EN');dlg.initialWidth=1000;dlg.setIsResizable(true);
        const cNav=dlg.addColumn();cNav.widthProportion=0.85;
        const cA=dlg.addColumn();cA.widthProportion=1;
        const cB=dlg.addColumn();cB.widthProportion=1;

        const PAGE_NAMES=['1 Objects & Method','2 Blend & Colour','3 Rotation & Path','4 Correspondence & Locks'];
        const PAGES=[[],[],[],[]];
        function pageGroup(pageIdx,col,title){const g=col.addGroup(title);PAGES[pageIdx].push(g);return g;}
        let pagedOK=true;
        function showPage(i){
            if(!pagedOK)return;
            try{for(let k=0;k<PAGES.length;k++)for(const g of PAGES[k])g.isVisible=(k===i);}
            catch(e){pagedOK=false;try{for(const pg of PAGES)for(const g of pg)g.isVisible=true;}catch(e2){}}
        }

        // --- Navigation column (always visible): tabs, Preview, Presets
        const gNav=cNav.addGroup('Tabs');
        const rNav=gNav.addRadioGroup('',PAGE_NAMES,0);
        const gPrevNav=cNav.addGroup('Preview');
        const btnPreview=gPrevNav.addButton('👁 Preview  (dialog stays open)');
        btnPreview.isFullWidth=true;
        const gPs=cNav.addGroup('Presets  (folder: AffinityScriptPresets)');
        const btnPresetSave=gPs.addButton('💾 Save');
        const btnPresetLoad=gPs.addButton('📂 Load');
        const btnPresetDelete=gPs.addButton('🗑 Delete');

        // --- Tab 1: Objects & Method
        const go=pageGroup(0,cA,isChain?'Chain ('+chain.length+' objects)':'Selected Objects');
        let tA,tB,tChain;
        if(!isChain){
            tA=go.addStaticText('Object A:',fxLabel(chain[0]));
            tB=go.addStaticText('Object B:',chain[1].name);
        }else{
            tChain=go.addStaticText('',chain.map(x=>x.name).join(' \u2192 '));
        }
        const btnSwap=go.addButton(isChain?'↕ Reverse chain':'↕ Swap');
        let tMesh=null;
        if(anyMesh){const gMesh=pageGroup(0,cA,'');const names=chain.filter((x,i)=>meshFlags[i]).map(x=>x.name).join(', ');tMesh=gMesh.addStaticText('','⚠ Mesh fill on: '+names+' (Style Blend only, 2 objects only).');}
        const gm=pageGroup(0,cB,'Method');
        const rbM=gm.addRadioGroup('',['Standard  (shape + style interpolated)','Style Blend  (style fixed, opacity transitions)'],0);
        const tWarn=gm.addStaticText('',isChain?'ℹ Chain: only "Standard" method supports chains (3+ objects).':'');

        // --- Tab 2: Blend & Colour
        const gbx=pageGroup(1,cA,'Blend');const tbS=gbx.addTextBox('Intermediate steps:','5');
        const gd=pageGroup(1,cA,'Position / Opacity Curve');const rbD=gd.addRadioGroup('Spacing:',['Linear','Inward','Outward','S-Curve'],0);const tbE=gd.addTextBox('Exponent:','2.0');
        const gc2=pageGroup(1,cB,'Colour Blend (Standard only)');const rbC=gc2.addRadioGroup('Mode:',['Linear (HSL)','Colour wheel CW','Colour wheel CCW','RGB (direct)'],0);

        // --- Tab 3: Rotation & Path
        const gr=pageGroup(2,cA,'Rotation');
        const tbR=gr.addTextBox('Increment (degrees):','0');
        const tbFT=gr.addTextBox('Full turns:','0');
        const rbRD=gr.addRadioGroup('Angle distribution:',['Linear','Inward','Outward','S-Curve'],0);
        const tbRE=gr.addTextBox('Angle exponent:','2.0');
        const cbRotFill=gr.addCheckBox('Rotate fill',true);
        let cbContinuousChain=null;
        if(isChain){
            cbContinuousChain=gr.addCheckBox('True concatenation (rotation continuous across the chain)',false);
            gr.addStaticText('','ℹ Enabled: rotation/spiral accumulate seamlessly across all segments (for full turns). Disabled: each segment rotates independently starting at 0°.');
        }
        const gsp=pageGroup(2,cB,'Focal Point Path');
        const cbSpiral=gsp.addCheckBox('Spiral motion (instead of linear)',false);
        const tbSpiralTurns=gsp.addTextBox('Spiral turns:','1');
        const tbSpiralBulge=gsp.addTextBox('Spiral bulge:','0.3');
        const cbUsePath=gsp.addCheckBox('Follow path object (name starting with "_")',pathNode!=null);
        const tPath=gsp.addStaticText('',pathNode?('✓ Path found: '+(pathNode.userDescription||pathNode.defaultDescription)+(isChain?' — chain distributes evenly across the whole path':'')):'No path object found (vector named starting with "_")');

        // --- Tab 4: Correspondence & Locks
        const gk=pageGroup(3,cA,'Curve Correspondence');
        const cbAutoAlign=gk.addCheckBox('Automatic start point alignment',true);
        const tbSampleRes=gk.addTextBox('Sample resolution:','40');
        const markedCount=chain.filter(x=>x.forcedAnker!=null).length;
        const tAnker=gk.addStaticText('',markedCount>0?('✓ '+markedCount+' anchor point(s) manually marked'):'No anchor point marked (optional: use Node tool to pick 1 point each)');
        const gs=pageGroup(3,cB,'Lock Properties (Standard only)');
        const cbLockOpacity=gs.addCheckBox('Lock opacity (stays A)',false);
        const cbLockColor=gs.addCheckBox('Lock colour (stays A)',false);
        const cbLockPivot=gs.addCheckBox('Keep focal point fixed',false);
        const gfx=pageGroup(3,cB,'Layer Effects (from Object A)');const cbFX=gfx.addCheckBox('Apply FX',hasFX(chain[0]));const tFX=gfx.addStaticText('',hasFX(chain[0])?chain[0].name+' has '+chain[0].node.layerEffectsInterface.effectCount+' FX':chain[0].name+' has no FX');

        let isUpdating=false;
        try{rNav.setOnValueChangedHandler(()=>{if(!isUpdating)showPage(rNav.selectedIndex);});}catch(e){}
        showPage(0);

        let pg=null;
        let previewKey=null;
        function clrPv(){if(pg){try{pg.delete();}catch(e){}pg=null;}previewKey=null;}
        function updateNames(){
            if(!isChain){
                try{tA.setText(fxLabel(chain[0]));}catch(e){}
                try{tB.setText(chain[1].name);}catch(e){}
            }else{
                try{tChain.setText(chain.map(x=>x.name).join(' \u2192 '));}catch(e){}
            }
            const aHasFX=hasFX(chain[0]);try{cbFX.value=aHasFX;}catch(e){}
            try{tFX.setText(aHasFX?chain[0].name+' has '+chain[0].node.layerEffectsInterface.effectCount+' FX':chain[0].name+' has no FX');}catch(e){}
            try{tWarn.setText(isChain?'ℹ Chain: only "Standard" method supports chains (3+ objects).':'');}catch(e){}
        }
        function getP(){return{
            method:rbM.selectedIndex,steps:Math.max(1,parseInt(tbS.text,10)||5),cm:rbC.selectedIndex,
            rot:parseFloat((tbR.text||'0').replace(',','.'))||0,
            fullTurns:parseInt(tbFT.text,10)||0,
            rotDm:rbRD.selectedIndex,rotExp:Math.max(0.1,parseFloat((tbRE.text||'2').replace(',','.'))||2),
            dm:rbD.selectedIndex,dexp:Math.max(0.1,parseFloat((tbE.text||'2').replace(',','.'))||2),
            applyFX:cbFX.value&&hasFX(chain[0]),rotateFill:cbRotFill.value,
            autoAlign:cbAutoAlign.value,sampleRes:Math.max(8,Math.min(200,parseInt(tbSampleRes.text,10)||40)),
            lockOpacity:cbLockOpacity.value,lockColor:cbLockColor.value,lockPivot:cbLockPivot.value,
            spiralMode:cbSpiral.value,spiralTurns:parseInt(tbSpiralTurns.text,10)||0,
            spiralBulge:parseFloat((tbSpiralBulge.text||'0.3').replace(',','.'))||0,
            pathMode:cbUsePath.value&&pathSampler!=null,
            continuousChain:cbContinuousChain?cbContinuousChain.value:false
        };}
        function applyPresetToControls(pr){
            isUpdating=true;
            try{
            try{rbM.selectedIndex=pr.method||0;}catch(e){}
            try{tbS.text=String(pr.steps||5);}catch(e){}
            try{rbC.selectedIndex=pr.cm||0;}catch(e){}
            try{tbR.text=String(pr.rot||0);}catch(e){}
            try{tbFT.text=String(pr.fullTurns||0);}catch(e){}
            try{rbRD.selectedIndex=pr.rotDm||0;}catch(e){}
            try{tbRE.text=String(pr.rotExp||2);}catch(e){}
            try{rbD.selectedIndex=pr.dm||0;}catch(e){}
            try{tbE.text=String(pr.dexp||2);}catch(e){}
            try{cbFX.value=!!pr.applyFX;}catch(e){}
            try{cbRotFill.value=pr.rotateFill!==false;}catch(e){}
            try{cbAutoAlign.value=pr.autoAlign!==false;}catch(e){}
            try{tbSampleRes.text=String(pr.sampleRes||40);}catch(e){}
            try{cbLockOpacity.value=!!pr.lockOpacity;}catch(e){}
            try{cbLockColor.value=!!pr.lockColor;}catch(e){}
            try{cbLockPivot.value=!!pr.lockPivot;}catch(e){}
            try{cbSpiral.value=!!pr.spiralMode;}catch(e){}
            try{tbSpiralTurns.text=String(pr.spiralTurns!=null?pr.spiralTurns:1);}catch(e){}
            try{tbSpiralBulge.text=String(pr.spiralBulge!=null?pr.spiralBulge:0.3);}catch(e){}
            try{cbUsePath.value=!!pr.pathMode;}catch(e){}
            try{if(cbContinuousChain)cbContinuousChain.value=!!pr.continuousChain;}catch(e){}
            }finally{isUpdating=false;}
        }
        function runBlend(gn,p){
            if(isChain){
                if(p.method===1)return{error:'Style Blend does not support chains (2 objects only). Please choose "Standard" or select exactly 2 objects.'};
                return createChainBlend(doc,chain,p.steps,p.cm,p.rot,p.fullTurns,p.rotDm,p.rotExp,p.dm,p.dexp,gn,p.applyFX,p.rotateFill,p.autoAlign,p.sampleRes,p.lockOpacity,p.lockColor,p.lockPivot,p.spiralMode,p.spiralTurns,p.spiralBulge,p.pathMode,pathSampler,p.continuousChain);
            }else{
                if(p.method===0){
                    return createChainBlend(doc,chain,p.steps,p.cm,p.rot,p.fullTurns,p.rotDm,p.rotExp,p.dm,p.dexp,gn,p.applyFX,p.rotateFill,p.autoAlign,p.sampleRes,p.lockOpacity,p.lockColor,p.lockPivot,p.spiralMode,p.spiralTurns,p.spiralBulge,p.pathMode,pathSampler,p.continuousChain);
                }
                return createBlend(doc,chain[0],chain[1],p.steps,p.cm,p.rot,p.fullTurns,p.rotDm,p.rotExp,p.dm,p.dexp,gn,p.applyFX,p.rotateFill,p.method,p.autoAlign,chain[0].forcedAnker,chain[1].forcedAnker,p.sampleRes,p.lockOpacity,p.lockColor,p.lockPivot,p.spiralMode,p.spiralTurns,p.spiralBulge,p.pathMode,pathSampler);
            }
        }

        btnSwap.setOnClickHandler(()=>{
            clrPv();chain=chain.slice().reverse();updateNames();
        });
        btnPreview.setOnClickHandler(()=>{
            clrPv();
            const p=getP();
            const mn=p.method===0?'Standard':'StyleBlend';
            const gn='BlendGroup '+gi+' [Preview]';
            const r=runBlend(gn,p);
            if(r&&r.error){try{tWarn.setText(r.error);}catch(e){}return;}
            if(r&&r.grp){pg=r.grp;previewKey=JSON.stringify(p);console.log('Preview ['+mn+']: '+gn);}
        });
        btnPresetSave.setOnClickHandler(()=>{savePresetToFile(getP());});
        btnPresetLoad.setOnClickHandler(()=>{const loaded=loadPresetFromFile();if(loaded)applyPresetToControls(loaded);});
        btnPresetDelete.setOnClickHandler(()=>{deletePresetFile();});

        const res=dlg.runModal();
        if(res&&res.value===DialogResult.Ok.value){
            const p=getP();
            const mn=p.method===0?'Standard':'StyleBlend';
            const posMs=p.dm===0?'lin':(p.dm===1?'e'+p.dexp.toFixed(1):p.dm===2?'o'+p.dexp.toFixed(1):'s'+p.dexp.toFixed(1));
            const rotMs=p.rotDm===0?'lin':(p.rotDm===1?'e'+p.rotExp.toFixed(1):p.rotDm===2?'o'+p.rotExp.toFixed(1):'s'+p.rotExp.toFixed(1));
            const gn='BlendGroup '+gi;
            if(pg&&previewKey===JSON.stringify(p)){
                try{pg.userDescription=gn;}catch(e){}
                console.log('✓ '+gn+' ['+mn+'] (preview applied)');
            }else{
                clrPv();
                const r=runBlend(gn,p);
                if(r&&r.error){
                    showSmallError('Error applying',r.error);
                }else if(r&&r.grp){
                    let kc=0;for(const k of r.grp.children)kc++;
                    console.log('✓ '+gn+' ['+mn+']'+(isChain?' [Chain: '+chain.map(x=>x.name).join('\u2192')+(p.continuousChain?' true-concatenated':'')+']':'')+' ('+p.steps+' steps, pos:'+posMs+(p.rot!==0||p.fullTurns!==0?', rot:'+rotMs+(p.fullTurns?' +'+p.fullTurns+'T':'')+(p.rotateFill?' fill+':' fill-'):'')+(p.pathMode?' path':p.spiralMode?' spiral':'')+', '+kc+' objects)');
                }
            }
        }else{
            clrPv();
            console.log('Cancelled.');
        }
    }
} // End
