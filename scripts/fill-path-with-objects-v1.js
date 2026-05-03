
'use strict';
// FILL PATH WITH OBJECTS v1.7
// v1.7: fixed Radial grid center clustering — inner rings use fewer spokes proportional to circumference

const { Document } = require('/document');
const { Dialog, DialogResult } = require('/dialog');
const { DocumentCommand, CompoundCommandBuilder, AddChildNodesCommandBuilder } = require('/commands');
const { ContainerNodeDefinition } = require('/nodes');
const { Transform } = require('/geometry');
const { UnitType } = require('/units');
const { NodeMoveType, NodeChildType } = require('affinity:dom');

function makePRNG(seed){let s=(seed||1)>>>0;return()=>{s+=0x6D2B79F5;let t=Math.imul(s^s>>>15,s|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296;};}
function shuffleArray(arr,seed){const a=[...arr],rand=makePRNG(seed);for(let i=a.length-1;i>0;i--){const j=Math.floor(rand()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
function evalBez(b,t){const u=1-t;return{x:u*u*u*b.start.x+3*u*u*t*b.c1.x+3*u*t*t*b.c2.x+t*t*t*b.end.x,y:u*u*u*b.start.y+3*u*u*t*b.c1.y+3*u*t*t*b.c2.y+t*t*t*b.end.y};}
function getWorldBeziers(node){const c=node.polyCurve.clone();c.transform(node.transformInterface.transform);c.transform(node.localToSpreadTransform);return[...c.at(0).beziers];}
function sampleBezierPolygon(beziers,baseSteps){const pts=[],steps=baseSteps||60;for(let bi=0;bi<beziers.length;bi++){const b=beziers[bi];const ch=Math.hypot(b.end.x-b.start.x,b.end.y-b.start.y);const cp=Math.hypot(b.c1.x-b.start.x,b.c1.y-b.start.y)+Math.hypot(b.c2.x-b.c1.x,b.c2.y-b.c1.y)+Math.hypot(b.end.x-b.c2.x,b.end.y-b.c2.y);const r=ch>0.01?cp/ch:1;const ss=Math.max(steps,Math.round(steps*r));for(let s=0;s<ss;s++)pts.push(evalBez(b,s/ss));}return pts;}
function pointInPolygonRC(px,py,pp){let ins=false;for(let i=0,j=pp.length-1;i<pp.length;j=i++){const xi=pp[i].x,yi=pp[i].y,xj=pp[j].x,yj=pp[j].y;if(((yi>py)!==(yj>py))&&(px<(xj-xi)*(py-yi)/(yj-yi)+xi))ins=!ins;}return ins;}
function pointInsideWithMargin(px,py,pp,m){if(!pointInPolygonRC(px,py,pp))return false;if(m<=0)return true;const d=[[1,0],[-1,0],[0,1],[0,-1],[.707,.707],[-.707,.707],[.707,-.707],[-.707,-.707]];for(const[dx,dy]of d)if(!pointInPolygonRC(px+dx*m,py+dy*m,pp))return false;return true;}
function getCenter(n){const b=n.getSpreadBaseBox(false);return{x:b.x+b.width/2,y:b.y+b.height/2};}
function getWorldRot(n){try{return n.transformInterface.transform.decompose().rotation;}catch(e){return 0;}}
function getBBoxArea(n){try{const b=n.getSpreadBaseBox(false);return b.width*b.height;}catch(e){return 0;}}
function hasNoFill(n){if(!n||!n.isVectorNode||!n.polyCurve)return false;try{return!n.hasBrushFill;}catch(e){return false;}}
function autoDetectPathIndex(nodes){const nf=[],hf=[];for(let i=0;i<nodes.length;i++){if(nodes[i]&&nodes[i].isVectorNode&&nodes[i].polyCurve&&hasNoFill(nodes[i]))nf.push(i);else hf.push(i);}if(nf.length>0&&hf.length>0){let bc=-1,ba=-1;for(const idx of nf){try{if(nodes[idx].polyCurve.at(0).isClosed){const a=getBBoxArea(nodes[idx]);if(a>ba){ba=a;bc=idx;}}}catch(e){}}if(bc>=0)return bc;return nf[0];}let best=-1,bA=-1;for(let i=0;i<nodes.length;i++){const n=nodes[i];if(n&&n.isVectorNode&&n.polyCurve){try{if(n.polyCurve.at(0).isClosed){const a=getBBoxArea(n);if(a>bA){bA=a;best=i;}}}catch(e){}}}return best;}
function polyBBox(pts){let x1=Infinity,y1=Infinity,x2=-Infinity,y2=-Infinity;for(const p of pts){if(p.x<x1)x1=p.x;if(p.x>x2)x2=p.x;if(p.y<y1)y1=p.y;if(p.y>y2)y2=p.y;}return{x:x1,y:y1,w:x2-x1,h:y2-y1};}
function polyCentroid(pts){let sx=0,sy=0;for(const p of pts){sx+=p.x;sy+=p.y;}return{x:sx/pts.length,y:sy/pts.length};}

// ── Grid: 0=Rect, 1=Hex, 2=Circular, 3=Diamond, 4=Sunflower, 5=Radial ──
function generatePoints(pp,spacing,gt,margin,jSeed,jAmt,nT,scSeed,scAmt){
const bb=polyBBox(pp);const jR=(jSeed>0&&jAmt>0)?makePRNG(jSeed):null;const scR=(scSeed>0&&scAmt<100)?makePRNG(scSeed):null;
const cen=polyCentroid(pp);const mR=Math.max(bb.w,bb.h)/2;const pts=[],ri=[];
function add(px,py,r){if(!pointInsideWithMargin(px,py,pp,margin))return;if(scR&&scR()*100>=scAmt)return;pts.push({x:px,y:py});ri.push(r);}
function jit(px,py,sx,sy){if(jR){px+=(jR()-0.5)*sx*jAmt;py+=(jR()-0.5)*sy*jAmt;}return{x:px,y:py};}

if(gt===0||gt===1){
  const isH=gt===1;const rH=isH?spacing*Math.sqrt(3)/2:spacing;let row=0,idx=0;
  for(let y=bb.y;y<=bb.y+bb.h;y+=rH){const ox=(isH&&row%2===1)?spacing/2:0;for(let x=bb.x+ox;x<=bb.x+bb.w;x+=spacing){const j=jit(x,y,spacing,rH);add(j.x,j.y,idx);idx++;}row++;}
}else if(gt===2){
  const j0=jit(cen.x,cen.y,spacing,spacing);add(j0.x,j0.y,0);let ring=1;
  for(let r=spacing;r<=mR+spacing;r+=spacing){const nP=Math.max(6,Math.round(2*Math.PI*r/spacing));const ao=(ring%2===0)?0:Math.PI/nP;for(let i=0;i<nP;i++){const a=2*Math.PI*i/nP+ao;const j=jit(cen.x+r*Math.cos(a),cen.y+r*Math.sin(a),spacing,spacing);add(j.x,j.y,ring);}ring++;}
}else if(gt===3){
  const c45=Math.cos(Math.PI/4),s45=Math.sin(Math.PI/4);const md=Math.hypot(bb.w,bb.h)/2+spacing*2;const cx=bb.x+bb.w/2,cy=bb.y+bb.h/2;let idx=0;
  for(let gy=-md;gy<=md;gy+=spacing){for(let gx=-md;gx<=md;gx+=spacing){const rx=cx+gx*c45-gy*s45,ry=cy+gx*s45+gy*c45;const j=jit(rx,ry,spacing,spacing);add(j.x,j.y,idx);idx++;}}
}else if(gt===4){
  const ga=Math.PI*(3-Math.sqrt(5));const maxN=Math.max(10,Math.round(bb.w*bb.h/(spacing*spacing)*1.5));const sf=spacing/Math.sqrt(Math.PI);
  for(let i=0;i<maxN;i++){const r=sf*Math.sqrt(i),th=i*ga;const j=jit(cen.x+r*Math.cos(th),cen.y+r*Math.sin(th),spacing,spacing);add(j.x,j.y,i);}
}else if(gt===5){
  // RADIAL — spokes from center, thinned at inner rings to prevent clustering
  const maxSpokes=Math.max(4,Math.round(2*Math.PI*mR/spacing/1.5));
  let idx=0;
  const j0=jit(cen.x,cen.y,spacing,spacing);add(j0.x,j0.y,0);
  for(let r=spacing;r<=mR+spacing;r+=spacing){
    // At this radius, how many spokes can fit with proper spacing?
    const fitAtR=Math.max(1,Math.floor(2*Math.PI*r/spacing));
    const useSp=Math.min(maxSpokes,fitAtR);
    for(let s=0;s<useSp;s++){
      const a=2*Math.PI*s/useSp;
      const j=jit(cen.x+r*Math.cos(a),cen.y+r*Math.sin(a),spacing,spacing);
      add(j.x,j.y,idx);idx++;
    }
  }
}
return{points:pts,ringIndices:ri};}

function computeTransformT(pt,bb,cen,mR,mode){if(mode===0)return 0;if(mode===1)return mR>0?Math.min(Math.hypot(pt.x-cen.x,pt.y-cen.y)/mR,1):0;if(mode===2)return bb.h>0?(pt.y-bb.y)/bb.h:0;if(mode===3)return bb.w>0?(pt.x-bb.x)/bb.w:0;return 0;}
function applyZOrder(doc,nodes,zS){if(!nodes||nodes.length<2)return false;try{let o=zS>0?shuffleArray([...nodes],zS):[...nodes];const c=CompoundCommandBuilder.create();for(let i=1;i<o.length;i++)c.addCommand(DocumentCommand.createMoveNodes(o[i].selfSelection,o[i-1],NodeMoveType.After,NodeChildType.Main),false);doc.executeCommand(c.createCommand());return true;}catch(e){return false;}}
function groupIntoContainer(doc,nodes,name){if(!nodes||!nodes.length)return null;try{const def=ContainerNodeDefinition.create(name);const b=AddChildNodesCommandBuilder.create();b.setInsertionTargetSelection(nodes[0].selfSelection);b.addContainerNode(def);const ac=b.createCommand();doc.executeCommand(ac);const ct=ac.newNodes&&ac.newNodes[0];if(!ct)return null;const mv=CompoundCommandBuilder.create();for(let i=nodes.length-1;i>=0;i--)mv.addCommand(DocumentCommand.createMoveNodes(nodes[i].selfSelection,ct,NodeMoveType.Inside,NodeChildType.Main),false);doc.executeCommand(mv.createCommand());return ct;}catch(e){return null;}}

function doFill(doc,pathNode,tNodes,tOrig,params){
const bez=getWorldBeziers(pathNode);const pp=sampleBezierPolygon(bez,60);const nT=tNodes.length;
const{points:rP,ringIndices:rR}=generatePoints(pp,params.spacing,params.gridType,params.margin,params.jitterSeed,params.jitterAmt/100,nT,params.scatterSeed,params.scatterAmt);
const xfm=params.xfm;const bb=polyBBox(pp);const cen=polyCentroid(pp);const mR=Math.max(bb.w,bb.h)/2;
let pts=rP,rings=rR;
if(xfm.mode>0&&(xfm.scatStart<100||xfm.scatEnd<100)){const sR=makePRNG(7919);const fp=[],fr=[];for(let i=0;i<rP.length;i++){const t=computeTransformT(rP[i],bb,cen,mR,xfm.mode);const d=xfm.scatStart+(xfm.scatEnd-xfm.scatStart)*t;if(sR()*100<d){fp.push(rP[i]);fr.push(rR[i]);}}pts=fp;rings=fr;}
if(!pts.length)throw new Error('No points inside the path.\nTry reducing spacing or margin.');
const N=pts.length;let tI=[];if(params.gridType===2){for(let i=0;i<N;i++)tI.push(rings[i]%nT);}else{for(let i=0;i<N;i++)tI.push(i%nT);}
if(params.shuffleSeed>0)tI=shuffleArray(tI,params.shuffleSeed);
const rRnd=makePRNG(params.rotSeed||1),sRnd=makePRNG(params.sizeSeed||1);const mxR=(params.rotMaxDeg||0)*Math.PI/180,sAmp=(params.sizeAmt||0)/100;
const gR=(params.globalRot||0)*Math.PI/180,dS=params.scaleBase/100;
const comp=CompoundCommandBuilder.create();
for(let i=0;i<N;i++){const ti=tI[i],tN=tNodes[ti],orig=tOrig[ti],pt=pts[i];let delta=Transform.createTranslate(pt.x-orig.cx,pt.y-orig.cy);
let eR=params.rotSeed>0?(rRnd()-0.5)*2*mxR:0;let eS=params.sizeSeed>0?1+(sRnd()-0.5)*2*sAmp:1;
let xS=1,xR=0;if(xfm.mode>0){const t=computeTransformT(pt,bb,cen,mR,xfm.mode);xS=(xfm.scaleStart+(xfm.scaleEnd-xfm.scaleStart)*t)/100;xR=(xfm.rotStart+(xfm.rotEnd-xfm.rotStart)*t)*Math.PI/180;}
const tRot=gR+xR+eR;if(tRot!==0)delta=Transform.createTranslate(pt.x,pt.y).multiply(Transform.createRotate(tRot)).multiply(Transform.createTranslate(-pt.x,-pt.y)).multiply(delta);
const tSc=dS*xS*eS;if(Math.abs(tSc-1)>0.0001)delta=Transform.createTranslate(pt.x,pt.y).multiply(Transform.createScale(tSc,tSc)).multiply(Transform.createTranslate(-pt.x,-pt.y)).multiply(delta);
comp.addCommand(DocumentCommand.createTransform(tN.selfSelection,delta,{duplicateNodes:true}),false);}
const cmd=comp.createCommand();doc.executeCommand(cmd);const allNew=cmd.newNodes||[];let eu=0;
if(params.zSeed>0&&allNew.length>=2)if(applyZOrder(doc,allNew,params.zSeed))eu++;
return{allNew,extraUndos:eu,pointCount:N};}

function doUndo(doc){doc.executeCommand(DocumentCommand.createUndo());}
function showError(msg){const d=Dialog.create('Fill Path');d.addColumn().addGroup('Error').addStaticText('',msg);d.show();}

const doc=Document.current;
if(!doc){showError('No document open.');}else{
const sel=doc.selection,sL=sel?sel.length:0;
if(sL<2){showError('Select at least 1 closed path + 1 template object.');}else{
const aN=[];for(let i=0;i<sL;i++)aN.push(sel.at(i).node);
const pI=autoDetectPathIndex(aN);
if(pI<0){showError('No closed vector path found.');}else{
const pN=aN[pI];const tN=aN.filter((_,i)=>i!==pI);const tO=tN.map(n=>{const c=getCenter(n);return{cx:c.x,cy:c.y,rot:getWorldRot(n)};});
if(!tN.length){showError('No template objects found.');}else{
const dlg=Dialog.create('Fill Path with Objects v1.7');dlg.initialWidth=760;
const c1=dlg.addColumn();
const gG=c1.addGroup('Grid');
const gtC=gG.addComboBox('Grid type',['Rectangular','Hexagonal','Circular','Diamond','Sunflower','Radial'],0);
const spC=gG.addUnitValueEditor('Spacing (pt)',UnitType.Number,UnitType.Number,40,5,500);spC.precision=1;spC.showPopupSlider=true;
const mgC=gG.addUnitValueEditor('Margin from edge (pt)',UnitType.Number,UnitType.Number,5,0,200);mgC.precision=1;mgC.showPopupSlider=true;
const scC=gG.addUnitValueEditor('Object scale',UnitType.Percentage,UnitType.Percentage,100,5,500);scC.precision=1;scC.showPopupSlider=true;
const grC=gG.addUnitValueEditor('Object rotation',UnitType.Degree,UnitType.Degree,0,-360,360);grC.precision=1;grC.showPopupSlider=true;

const xG=c1.addGroup('Transform');
const xmC=xG.addComboBox('Mode',['None','Circular','Rect Up/Down','Rect Left/Right'],0);
const xssC=xG.addUnitValueEditor('Scale start',UnitType.Percentage,UnitType.Percentage,100,1,1000);xssC.precision=1;xssC.showPopupSlider=true;
const xseC=xG.addUnitValueEditor('Scale end',UnitType.Percentage,UnitType.Percentage,100,1,1000);xseC.precision=1;xseC.showPopupSlider=true;
const xrsC=xG.addUnitValueEditor('Rotation start',UnitType.Degree,UnitType.Degree,0,-3600,3600);xrsC.precision=1;
const xreC=xG.addUnitValueEditor('Rotation end',UnitType.Degree,UnitType.Degree,0,-3600,3600);xreC.precision=1;
const xscsC=xG.addUnitValueEditor('Scatter start',UnitType.Percentage,UnitType.Percentage,100,0,100);xscsC.precision=0;xscsC.showPopupSlider=true;
const xsceC=xG.addUnitValueEditor('Scatter end',UnitType.Percentage,UnitType.Percentage,100,0,100);xsceC.precision=0;xsceC.showPopupSlider=true;

const aG=c1.addGroup('Apply Options');const dpC=aG.addSwitch('Delete path on Apply',false);
const bG=c1.addGroup('');bG.enableSeparator=true;const btns=bG.addButtonSet('',['Preview','Apply'],0);

const c2=dlg.addColumn();
const rG=c2.addGroup('Randomize  (seed 0 = off)');
const rnC=rG.addSwitch('Enable randomize',false);
const shC=rG.addUnitValueEditor('Shuffle seed',UnitType.Number,UnitType.Number,0,0,99999);shC.precision=0;
const jkC=rG.addUnitValueEditor('Position jitter seed',UnitType.Number,UnitType.Number,0,0,99999);jkC.precision=0;
const jaC=rG.addUnitValueEditor('Jitter amount',UnitType.Percentage,UnitType.Percentage,40,1,100);jaC.precision=0;jaC.showPopupSlider=true;
const ssC=rG.addUnitValueEditor('Scatter seed',UnitType.Number,UnitType.Number,0,0,99999);ssC.precision=0;
const saC=rG.addUnitValueEditor('Scatter density',UnitType.Percentage,UnitType.Percentage,70,1,100);saC.precision=0;saC.showPopupSlider=true;
const rsC=rG.addUnitValueEditor('Rotation seed',UnitType.Number,UnitType.Number,0,0,99999);rsC.precision=0;
const rmC=rG.addUnitValueEditor('Rotation max angle',UnitType.Degree,UnitType.Degree,180,1,360);rmC.precision=0;rmC.showPopupSlider=true;
const szC=rG.addUnitValueEditor('Size seed',UnitType.Number,UnitType.Number,0,0,99999);szC.precision=0;
const smC=rG.addUnitValueEditor('Size amount',UnitType.Percentage,UnitType.Percentage,30,1,100);smC.precision=0;smC.showPopupSlider=true;
const zC=rG.addUnitValueEditor('Z-order seed',UnitType.Number,UnitType.Number,0,0,99999);zC.precision=0;

shC.setIsEnabledBy(rnC);jkC.setIsEnabledBy(rnC);jaC.setIsEnabledBy(rnC);ssC.setIsEnabledBy(rnC);saC.setIsEnabledBy(rnC);
rsC.setIsEnabledBy(rnC);rmC.setIsEnabledBy(rnC);szC.setIsEnabledBy(rnC);smC.setIsEnabledBy(rnC);zC.setIsEnabledBy(rnC);

function getP(){const rE=rnC.value,jS=rE?Math.round(jkC.value):0,sS=rE?Math.round(ssC.value):0;
return{spacing:Math.max(5,spC.value),gridType:gtC.selectedIndex,margin:mgC.value,scaleBase:scC.value,globalRot:grC.value,deletePath:dpC.value,
xfm:{mode:xmC.selectedIndex,scaleStart:xssC.value,scaleEnd:xseC.value,rotStart:xrsC.value,rotEnd:xreC.value,scatStart:xscsC.value,scatEnd:xsceC.value},
shuffleSeed:rE?Math.round(shC.value):0,jitterSeed:jS,jitterAmt:(rE&&jS>0)?jaC.value:0,
scatterSeed:sS,scatterAmt:(rE&&sS>0)?saC.value:100,
rotSeed:rE?Math.round(rsC.value):0,rotMaxDeg:rE?rmC.value:0,sizeSeed:rE?Math.round(szC.value):0,sizeAmt:rE?smC.value:0,zSeed:rE?Math.round(zC.value):0};}

let pA=false,eU=0,lR=null;
function run(p){eU=0;lR=null;lR=doFill(doc,pN,tN,tO,p);eU=lR.extraUndos;}
function undo(){for(let i=0;i<eU;i++)doUndo(doc);doUndo(doc);eU=0;lR=null;}
try{run(getP());pA=true;}catch(e){showError('Preview failed:\n'+e.message);}
let go=true;
while(go){btns.selectedIndex=0;const r=dlg.show();const params=getP(),mode=btns.selectedIndex;
if(pA){undo();pA=false;}
if(r.value===DialogResult.Ok.value){try{run(params);pA=true;}catch(e){showError('Fill failed:\n'+e.message);}
if(mode===1){if(pA&&lR&&lR.allNew.length)groupIntoContainer(doc,lR.allNew,'filled_objects');if(pA&&params.deletePath)try{doc.deleteSelection(pN.selfSelection);}catch(e){}go=false;}}else{go=false;}}
}}}}
