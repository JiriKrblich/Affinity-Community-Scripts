'use strict';
// ARRANGE ON PATH v2.7
// Changes from v2.6:
//   UI: reverted to v2.4 layout — removed Output section and static text label.
//       "Delete path on Apply" moved back into "Apply Options" group.
//       Grouping into sh1, sh2, ... still always happens on Apply (silently).

const { Document }  = require('/document');
const { Dialog, DialogResult } = require('/dialog');
const { DocumentCommand, CompoundCommandBuilder, AddChildNodesCommandBuilder } = require('/commands');
const { ContainerNodeDefinition } = require('/nodes');
const { Transform } = require('/geometry');
const { UnitType }  = require('/units');
const { NodeMoveType, NodeChildType } = require('affinity:dom');

// ── Bezier math ───────────────────────────────────────────
function evalBez(b,t){const u=1-t;return{x:u*u*u*b.start.x+3*u*u*t*b.c1.x+3*u*t*t*b.c2.x+t*t*t*b.end.x,y:u*u*u*b.start.y+3*u*u*t*b.c1.y+3*u*t*t*b.c2.y+t*t*t*b.end.y};}
function evalBezTangent(b,t){const u=1-t;return{x:3*u*u*(b.c1.x-b.start.x)+6*u*t*(b.c2.x-b.c1.x)+3*t*t*(b.end.x-b.c2.x),y:3*u*u*(b.c1.y-b.start.y)+6*u*t*(b.c2.y-b.c1.y)+3*t*t*(b.end.y-b.c2.y)};}
function buildArcTable(beziers){const STEPS=500;const tbl=[];let cum=0;for(let bi=0;bi<beziers.length;bi++){const b=beziers[bi];let prev=evalBez(b,0);tbl.push({bi,t:0,cum});for(let s=1;s<=STEPS;s++){const t=s/STEPS,pt=evalBez(b,t);cum+=Math.hypot(pt.x-prev.x,pt.y-prev.y);tbl.push({bi,t,cum});prev=pt;}}return tbl;}
function arcLookup(tbl,frac){const total=tbl[tbl.length-1].cum;const c=Math.min(Math.max(frac,0),1)*total;let lo=0,hi=tbl.length-1;while(lo<hi-1){const m=(lo+hi)>>1;if(tbl[m].cum<=c)lo=m;else hi=m;}const a=tbl[lo],bE=tbl[hi],span=bE.cum-a.cum;const f=span<1e-9?0:(c-a.cum)/span;return{bi:f<0.5?a.bi:bE.bi,t:a.t+(bE.t-a.t)*f};}
function normFrac(f){if(f>=0&&f<=1)return f;return((f%1)+1)%1;}
function samplePath(tbl,beziers,frac){const{bi,t}=arcLookup(tbl,normFrac(frac));return evalBez(beziers[bi],t);}
function sampleTangent(tbl,beziers,frac){const sf=Math.min(Math.max(normFrac(frac),0.0001),0.9999);const{bi,t}=arcLookup(tbl,sf);const tang=evalBezTangent(beziers[bi],Math.min(Math.max(t,0.0001),0.9999));const len=Math.hypot(tang.x,tang.y);return len<1e-9?{x:1,y:0}:{x:tang.x/len,y:tang.y/len};}
function getWorldBeziers(node){const c=node.polyCurve.clone();c.transform(node.transformInterface.transform);c.transform(node.localToSpreadTransform);return[...c.at(0).beziers];}
function nearestFrac(cx,cy,tbl,beziers){let bf=0,bd=Infinity;for(let i=0;i<=1000;i++){const frac=i/1000,pt=samplePath(tbl,beziers,frac),d=Math.hypot(pt.x-cx,pt.y-cy);if(d<bd){bd=d;bf=frac;}}const w=1/1000;for(let i=0;i<=200;i++){const frac=Math.min(Math.max(bf-w+2*w*i/200,0),1),pt=samplePath(tbl,beziers,frac),d=Math.hypot(pt.x-cx,pt.y-cy);if(d<bd){bd=d;bf=frac;}}return bf;}
function resolveRange(startFrac,endFrac,isClosed){let sf=startFrac,ef=endFrac;if(isClosed&&ef<sf)ef+=1.0;const span=ef-sf;const useLoop=isClosed&&span>=0.999;return{sf,ef,useLoop};}
function computeFrac(i,N,sf,ef,useLoop){
  if(N===1)return(sf+ef)/2;
  const raw=useLoop?sf+(i/N)*(ef-sf):sf+(i/(N-1))*(ef-sf);
  return Math.min(Math.max(raw,sf),ef);
}
function sortByPathOrder(objNodes,origData,tbl,beziers){const proj=objNodes.map((nd,i)=>({origIdx:i,frac:nearestFrac(origData[i].cx,origData[i].cy,tbl,beziers)}));proj.sort((a,b)=>a.frac-b.frac);return{sortedNodes:proj.map(p=>objNodes[p.origIdx]),sortedOrig:proj.map(p=>origData[p.origIdx])};}

// ── PRNG ─────────────────────────────────────────────────
function makePRNG(seed){let s=(seed||1)>>>0;return()=>{s+=0x6D2B79F5;let t=Math.imul(s^s>>>15,s|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296;};}
function shuffleArray(arr,seed){const a=[...arr],rand=makePRNG(seed);for(let i=a.length-1;i>0;i--){const j=Math.floor(rand()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
function antiClusterShuffle(arr,seed){
  const rand=makePRNG(seed);const N=arr.length;if(N<=1)return[...arr];
  const counts=new Map();for(const v of arr)counts.set(v,(counts.get(v)||0)+1);
  let templates=[...counts.keys()];
  for(let i=templates.length-1;i>0;i--){const j=Math.floor(rand()*(i+1));[templates[i],templates[j]]=[templates[j],templates[i]];}
  templates.sort((a,b)=>counts.get(b)-counts.get(a));
  const rem=new Map(templates.map(t=>[t,counts.get(t)]));
  const result=[];let last=-1;
  for(let pos=0;pos<N;pos++){
    let best=-1,bestCnt=-1;
    for(const t of templates){const cnt=rem.get(t)||0;if(cnt>0&&t!==last&&cnt>bestCnt){bestCnt=cnt;best=t;}}
    if(best===-1){for(const t of templates){if((rem.get(t)||0)>0){best=t;break;}}}
    result.push(best);rem.set(best,(rem.get(best)||0)-1);last=best;
  }
  return result;
}

// ── Randomize ─────────────────────────────────────────────
function applyRandomize(fracs,tmplIdx,sf,ef,rnd,useLoop){
  const N=fracs.length;const extraRot=new Array(N).fill(0);const extraScale=new Array(N).fill(1);
  if(!rnd||!rnd.enabled)return{extraRot,extraScale};
  if(rnd.jitterSeed>0){
    const rand=makePRNG(rnd.jitterSeed);const span=ef-sf;const step=span/Math.max(N,1);
    const amp=Math.min(Math.max((rnd.jitterAmt||30)/100,0),0.9);
    for(let i=0;i<N;i++){
      fracs[i]+=(rand()-0.5)*step*amp*2;
      if(useLoop){while(fracs[i]<sf)fracs[i]+=span;while(fracs[i]>=ef)fracs[i]-=span;}
      else fracs[i]=Math.min(Math.max(fracs[i],sf),ef);
    }
    const pairs=fracs.map((f,i)=>({f,t:tmplIdx[i]}));pairs.sort((a,b)=>a.f-b.f);
    for(let i=0;i<N;i++){fracs[i]=pairs[i].f;tmplIdx[i]=pairs[i].t;}
  }
  if(rnd.shuffleSeed>0){const s=antiClusterShuffle([...tmplIdx],rnd.shuffleSeed);for(let i=0;i<N;i++)tmplIdx[i]=s[i];}
  if(rnd.rotSeed>0){const rand=makePRNG(rnd.rotSeed);const maxR=(rnd.rotMaxDeg||45)*Math.PI/180;for(let i=0;i<N;i++)extraRot[i]=(rand()-0.5)*2*maxR;}
  if(rnd.sizeSeed>0){const rand=makePRNG(rnd.sizeSeed);const amp=(rnd.sizeAmt||30)/100;for(let i=0;i<N;i++)extraScale[i]=1+(rand()-0.5)*2*amp;}
  return{extraRot,extraScale};
}

// ── Z-order ───────────────────────────────────────────────
function applyZOrder(doc,nodes,zSeed){
  if(!nodes||nodes.length<2)return false;
  try{
    let ordered=[...nodes];if(zSeed>0)ordered=shuffleArray(ordered,zSeed);
    const c=CompoundCommandBuilder.create();
    for(let i=1;i<ordered.length;i++)c.addCommand(DocumentCommand.createMoveNodes(ordered[i].selfSelection,ordered[i-1],NodeMoveType.After,NodeChildType.Main),false);
    doc.executeCommand(c.createCommand());return true;
  }catch(e){return false;}
}

// ── Bring elements above paths ────────────────────────────
function bringElementsAbovePaths(doc,pathNodes,elementNodes){
  if(!elementNodes||!elementNodes.length||!pathNodes||!pathNodes.length)return false;
  try{
    const parent=pathNodes[0].parent;if(!parent)return false;
    let top=pathNodes[0];
    for(const child of parent.children)for(const pn of pathNodes){try{if(child.isSameNode(pn))top=pn;}catch(e){}}
    const c=CompoundCommandBuilder.create();
    for(let i=elementNodes.length-1;i>=0;i--)c.addCommand(DocumentCommand.createMoveNodes(elementNodes[i].selfSelection,top,NodeMoveType.After,NodeChildType.Main),false);
    doc.executeCommand(c.createCommand());return true;
  }catch(e){return false;}
}

// ── Group nodes into named container ─────────────────────
function groupIntoContainer(doc,nodes,name){
  if(!nodes||!nodes.length)return null;
  try{
    const def=ContainerNodeDefinition.create(name);
    const builder=AddChildNodesCommandBuilder.create();
    builder.setInsertionTargetSelection(nodes[0].selfSelection);
    builder.addContainerNode(def);
    const addCmd=builder.createCommand();
    doc.executeCommand(addCmd);
    const container=addCmd.newNodes&&addCmd.newNodes[0];
    if(!container)return null;
    const mv=CompoundCommandBuilder.create();
    for(let i=nodes.length-1;i>=0;i--)mv.addCommand(DocumentCommand.createMoveNodes(nodes[i].selfSelection,container,NodeMoveType.Inside,NodeChildType.Main),false);
    doc.executeCommand(mv.createCommand());
    return container;
  }catch(e){return null;}
}

// ── Node utilities ────────────────────────────────────────
function getCenter(node){const b=node.getSpreadBaseBox(false);return{x:b.x+b.width/2,y:b.y+b.height/2};}
function getWorldRot(node){try{return node.transformInterface.transform.decompose().rotation;}catch(e){return 0;}}
function getBBoxArea(node){try{const b=node.getSpreadBaseBox(false);return b.width*b.height;}catch(e){return 0;}}
function hasNoFill(node){if(!node||!node.isVectorNode||!node.polyCurve)return false;try{return !node.hasBrushFill;}catch(e){return false;}}

// ── Path detection ────────────────────────────────────────
function autoDetectPathIndices(nodes){
  const noFill=[],hasFill=[];
  for(let i=0;i<nodes.length;i++){
    if(nodes[i]&&nodes[i].isVectorNode&&nodes[i].polyCurve&&hasNoFill(nodes[i]))noFill.push(i);
    else hasFill.push(i);
  }
  if(noFill.length>0&&hasFill.length>0)return noFill;
  for(let i=0;i<nodes.length;i++){const n=nodes[i];if(n&&n.isVectorNode&&n.polyCurve&&!n.polyCurve.at(0).isClosed)return[i];}
  let best=-1,bestArea=-1;
  for(let i=0;i<nodes.length;i++){const n=nodes[i];if(n&&n.isVectorNode&&n.polyCurve){const a=getBBoxArea(n);if(a>bestArea){bestArea=a;best=i;}}}
  return best>=0?[best]:[];
}

// ── Placement helpers ─────────────────────────────────────
function buildDelta(cx,cy,tx,ty,rot,align,flip,tang){
  if(align){let ox=Transform.createRotate(tang-rot);if(flip)ox=Transform.createScale(1,-1).multiply(ox);return Transform.createTranslate(tx,ty).multiply(ox).multiply(Transform.createTranslate(-cx,-cy));}
  if(flip){const rx=Transform.createTranslate(tx,ty).multiply(Transform.createRotate(tang)).multiply(Transform.createScale(1,-1)).multiply(Transform.createRotate(-tang)).multiply(Transform.createTranslate(-tx,-ty));return rx.multiply(Transform.createTranslate(tx-cx,ty-cy));}
  return Transform.createTranslate(tx-cx,ty-cy);
}
function buildFinalDelta(pd,pt,rr,rs,ds,dr){
  let d=pd;
  if(rr!==0)d=Transform.createTranslate(pt.x,pt.y).multiply(Transform.createRotate(rr)).multiply(Transform.createTranslate(-pt.x,-pt.y)).multiply(d);
  if(rs!==1)d=Transform.createTranslate(pt.x,pt.y).multiply(Transform.createScale(rs,rs)).multiply(Transform.createTranslate(-pt.x,-pt.y)).multiply(d);
  if(Math.abs(ds-1)>0.0001)d=Transform.createTranslate(pt.x,pt.y).multiply(Transform.createScale(ds,ds)).multiply(Transform.createTranslate(-pt.x,-pt.y)).multiply(d);
  if(Math.abs(dr)>0.0001)d=Transform.createTranslate(pt.x,pt.y).multiply(Transform.createRotate(dr)).multiply(Transform.createTranslate(-pt.x,-pt.y)).multiply(d);
  return d;
}
function getDetTransform(i,N,xfm){const t=N>1?i/(N-1):0;return{detScale:xfm.scaleStart+(xfm.scaleEnd-xfm.scaleStart)*t,detRot:(xfm.rotStartDeg+(xfm.rotEndDeg-xfm.rotStartDeg)*t)*Math.PI/180};}

function addPathCmds(compound,pc,nodes,odata,params,dupNodes){
  const{sf,ef,useLoop}=resolveRange(params.startFrac,params.endFrac,pc.isClosed);
  const N=nodes.length,fracs=[],tmpl=[];
  for(let i=0;i<N;i++){fracs.push(computeFrac(i,N,sf,ef,useLoop));tmpl.push(i);}
  if(params.reverse)fracs.reverse();
  const{extraRot,extraScale}=applyRandomize(fracs,tmpl,sf,ef,params.rnd,useLoop);
  for(let i=0;i<N;i++){
    const node=nodes[tmpl[i]],orig=odata[tmpl[i]];
    const pt=samplePath(pc.tbl,pc.pathBeziers,fracs[i]);
    const tang=sampleTangent(pc.tbl,pc.pathBeziers,fracs[i]);
    const{detScale,detRot}=getDetTransform(i,N,params.xfm);
    compound.addCommand(DocumentCommand.createTransform(node.selfSelection,buildFinalDelta(buildDelta(orig.cx,orig.cy,pt.x,pt.y,orig.rot,params.alignToPath,params.flip,Math.atan2(tang.y,tang.x)),pt,extraRot[i],extraScale[i],detScale,detRot),{duplicateNodes:dupNodes}),false);
  }
  return N;
}
function sortForPath(nodes,odata,pc,smart){
  if(!smart)return{ns:[...nodes],od:[...odata]};
  const s=sortByPathOrder([...nodes],[...odata],pc.tbl,pc.pathBeziers);
  return{ns:s.sortedNodes,od:s.sortedOrig};
}

// ── Config ────────────────────────────────────────────────
function buildMultiConfig(allNodes,allOrigData,pathIndices){
  const pathIdxSet=new Set(pathIndices),pathCfgs=[],pathNodes=[];
  for(const pi of pathIndices){
    const n=allNodes[pi];if(!n||!n.isVectorNode||!n.polyCurve)continue;
    let pb;try{pb=getWorldBeziers(n);if(!pb||!pb.length)throw 0;}catch(e){continue;}
    pathCfgs.push({pathNode:n,pathBeziers:pb,tbl:buildArcTable(pb),isClosed:n.polyCurve.at(0).isClosed});
    pathNodes.push(n);
  }
  if(!pathCfgs.length)return null;
  const oi=allNodes.map((_,i)=>i).filter(i=>!pathIdxSet.has(i));
  return{pathCfgs,pathNodes,objNodes:oi.map(i=>allNodes[i]),origData:oi.map(i=>allOrigData[i]),isClosed:pathCfgs[0].isClosed};
}

// ── Main apply ────────────────────────────────────────────
function doApplyAll(doc,cfg,params){
  const{pathCfgs,pathNodes,objNodes,origData}=cfg;
  if(!objNodes.length)throw new Error('No elements to arrange.\nAll selected objects were detected as paths.');
  const{rnd,repeatMode,repeatCount}=params;
  const nPaths=pathCfgs.length,multiPath=nPaths>1;
  let perPathNodes=[],allFinalNodes=[],extraUndos=0;

  if(repeatMode){
    const comp=CompoundCommandBuilder.create();let n=0;
    for(let p=0;p<nPaths;p++){
      const pc=pathCfgs[p];const N=repeatCount,nT=objNodes.length;
      const{sf,ef,useLoop}=resolveRange(params.startFrac,params.endFrac,pc.isClosed);
      const fracs=[],tmpl=[];
      for(let i=0;i<N;i++){fracs.push(computeFrac(i,N,sf,ef,useLoop));tmpl.push(i%nT);}
      if(params.reverse)fracs.reverse();
      const{extraRot,extraScale}=applyRandomize(fracs,tmpl,sf,ef,rnd,useLoop);
      for(let i=0;i<N;i++){
        const node=objNodes[tmpl[i]],orig=origData[tmpl[i]];
        const pt=samplePath(pc.tbl,pc.pathBeziers,fracs[i]),tang=sampleTangent(pc.tbl,pc.pathBeziers,fracs[i]);
        const{detScale,detRot}=getDetTransform(i,N,params.xfm);
        comp.addCommand(DocumentCommand.createTransform(node.selfSelection,buildFinalDelta(buildDelta(orig.cx,orig.cy,pt.x,pt.y,orig.rot,params.alignToPath,params.flip,Math.atan2(tang.y,tang.x)),pt,extraRot[i],extraScale[i],detScale,detRot),{duplicateNodes:true}),false);
        n++;
      }
    }
    if(!n)throw new Error('Nothing to place.');
    const cmd=comp.createCommand();doc.executeCommand(cmd);
    const allNew=cmd.newNodes||[];
    for(let p=0;p<nPaths;p++)perPathNodes.push(allNew.slice(p*repeatCount,(p+1)*repeatCount));
    allFinalNodes=allNew;

  }else if(multiPath){
    const{ns:ns0,od:od0}=sortForPath(objNodes,origData,pathCfgs[0],params.smartPlacement);
    const compA=CompoundCommandBuilder.create();
    if(!addPathCmds(compA,pathCfgs[0],ns0,od0,params,false))throw new Error('Nothing to place.');
    doc.executeCommand(compA.createCommand());
    perPathNodes=[ns0];allFinalNodes=[...ns0];
    if(nPaths>1){
      const p0data=ns0.map(n=>{const c=getCenter(n);return{cx:c.x,cy:c.y,rot:getWorldRot(n)};});
      const compB=CompoundCommandBuilder.create();let nB=0;
      for(let p=1;p<nPaths;p++)nB+=addPathCmds(compB,pathCfgs[p],ns0,p0data,params,true);
      if(nB>0){
        const cmdB=compB.createCommand();doc.executeCommand(cmdB);
        const allNew=cmdB.newNodes||[];const M=ns0.length;
        for(let p=1;p<nPaths;p++)perPathNodes.push(allNew.slice((p-1)*M,p*M));
        allFinalNodes.push(...allNew);extraUndos++;
      }
    }

  }else{
    const{ns,od}=sortForPath(objNodes,origData,pathCfgs[0],params.smartPlacement);
    const comp=CompoundCommandBuilder.create();
    if(!addPathCmds(comp,pathCfgs[0],ns,od,params,false))throw new Error('Nothing to place.');
    doc.executeCommand(comp.createCommand());
    perPathNodes=[ns];allFinalNodes=[...ns];
  }

  if(allFinalNodes.length&&pathNodes.length)if(bringElementsAbovePaths(doc,pathNodes,allFinalNodes))extraUndos++;
  if(rnd&&rnd.enabled&&rnd.zSeed>0&&allFinalNodes.length>=2)if(applyZOrder(doc,allFinalNodes,rnd.zSeed))extraUndos++;

  return{extraUndos,perPathNodes};
}

function doUndo(doc){doc.executeCommand(DocumentCommand.createUndo());}
function showError(msg){const d=Dialog.create('Arrange on Path');d.addColumn().addGroup('Error').addStaticText('',msg);d.show();}

// ── MAIN ─────────────────────────────────────────────────
const doc=Document.current;
if(!doc){showError('No document open.');}else{
  const sel=doc.selection,selLen=sel?sel.length:0;
  if(selLen<2){showError('Select at least 1 path + 1 object.');}else{
    const allNodes=[];
    for(let i=0;i<selLen;i++)allNodes.push(sel.at(i).node);
    const allOrigData=allNodes.map(n=>{const c=getCenter(n);return{cx:c.x,cy:c.y,rot:getWorldRot(n)};});
    const pathIndices=autoDetectPathIndices(allNodes);
    if(!pathIndices.length){showError('No vector path found in selection.');}else{
      const cfg=buildMultiConfig(allNodes,allOrigData,pathIndices);
      if(!cfg){showError('Cannot read path geometry.');}else
      if(!cfg.objNodes.length){showError('No elements to arrange.\n\nAll selected objects were detected as paths.\nSelect the elements to place along the path(s).');}else{
        const nPaths=cfg.pathCfgs.length,multiPath=nPaths>1;
        const autoRepeat=cfg.objNodes.length===1,multiTmpl=cfg.objNodes.length>1;

        const dlg=Dialog.create('Arrange on Path');dlg.initialWidth=760;

        // ── Left column — identical to v2.4 layout ─────────
        const col1=dlg.addColumn();

        const placementGrp=col1.addGroup(multiPath?`Placement  (${nPaths} paths — all elements on each)`:'Placement');
        const smartCtrl=placementGrp.addSwitch('Smart Placement  (sort by path proximity)',true);
        const startCtrl=placementGrp.addUnitValueEditor('Start offset',UnitType.Percentage,UnitType.Percentage,0,0,100);
        startCtrl.precision=1;startCtrl.showPopupSlider=true;
        const endCtrl=placementGrp.addUnitValueEditor('End offset',UnitType.Percentage,UnitType.Percentage,100,0,100);
        endCtrl.precision=1;endCtrl.showPopupSlider=true;

        const repeatGrp=col1.addGroup('Repeat');
        const repeatCtrl=repeatGrp.addSwitch(multiTmpl?`Repeat  (${cfg.objNodes.length} templates → a,b,c…)`:'Repeat object along path',autoRepeat);
        const repeatCountCtrl=repeatGrp.addUnitValueEditor(multiPath?`Count (× ${nPaths} paths)`:'Count',UnitType.Number,UnitType.Number,6,2,500);
        repeatCountCtrl.precision=0;

        const orientGrp=col1.addGroup('Orientation');
        const alignCtrl=orientGrp.addSwitch('Align to path',false);
        const flipCtrl=orientGrp.addSwitch('Flip',false);
        const reverseCtrl=orientGrp.addSwitch('Reverse',false);

        const applyOptGrp=col1.addGroup('Apply Options');
        const deletePathCtrl=applyOptGrp.addSwitch(multiPath?'Delete paths on Apply':'Delete path on Apply',false);

        const btnGrp=col1.addGroup('');btnGrp.enableSeparator=true;
        const btns=btnGrp.addButtonSet('',['Preview','Apply'],0);

        // ── Right column — identical to v2.4 layout ────────
        const col2=dlg.addColumn();

        const xfmGrp=col2.addGroup('Transform  (interpolated first → last)');
        const scaleStartCtrl=xfmGrp.addUnitValueEditor('Scale start',UnitType.Percentage,UnitType.Percentage,100,1,1000);scaleStartCtrl.precision=1;scaleStartCtrl.showPopupSlider=true;
        const scaleEndCtrl=xfmGrp.addUnitValueEditor('Scale end',UnitType.Percentage,UnitType.Percentage,100,1,1000);scaleEndCtrl.precision=1;scaleEndCtrl.showPopupSlider=true;
        const rotStartCtrl=xfmGrp.addUnitValueEditor('Rotation start',UnitType.Degree,UnitType.Degree,0,-3600,3600);rotStartCtrl.precision=1;
        const rotEndCtrl=xfmGrp.addUnitValueEditor('Rotation end',UnitType.Degree,UnitType.Degree,0,-3600,3600);rotEndCtrl.precision=1;

        const randGrp=col2.addGroup('Randomize  (seed 0 = off)');
        const randCtrl=randGrp.addSwitch('Enable randomize',false);
        const shuffleSeedCtrl=randGrp.addUnitValueEditor('Shuffle seed',UnitType.Number,UnitType.Number,0,0,99999);shuffleSeedCtrl.precision=0;
        const jitterSeedCtrl=randGrp.addUnitValueEditor('Spacing jitter seed',UnitType.Number,UnitType.Number,0,0,99999);jitterSeedCtrl.precision=0;
        const jitterAmtCtrl=randGrp.addUnitValueEditor('Spacing amount',UnitType.Percentage,UnitType.Percentage,30,1,100);jitterAmtCtrl.precision=0;jitterAmtCtrl.showPopupSlider=true;
        const rotSeedCtrl=randGrp.addUnitValueEditor('Rotation seed',UnitType.Number,UnitType.Number,0,0,99999);rotSeedCtrl.precision=0;
        const rotMaxCtrl=randGrp.addUnitValueEditor('Rotation max angle',UnitType.Degree,UnitType.Degree,45,1,180);rotMaxCtrl.precision=0;rotMaxCtrl.showPopupSlider=true;
        const sizeSeedCtrl=randGrp.addUnitValueEditor('Size seed',UnitType.Number,UnitType.Number,0,0,99999);sizeSeedCtrl.precision=0;
        const sizeAmtCtrl=randGrp.addUnitValueEditor('Size amount',UnitType.Percentage,UnitType.Percentage,30,1,100);sizeAmtCtrl.precision=0;sizeAmtCtrl.showPopupSlider=true;
        const zSeedCtrl=randGrp.addUnitValueEditor('Z-order seed',UnitType.Number,UnitType.Number,0,0,99999);zSeedCtrl.precision=0;

        function getParams(){return{startFrac:startCtrl.value/100,endFrac:endCtrl.value/100,isClosed:cfg.isClosed,alignToPath:alignCtrl.value,flip:flipCtrl.value,reverse:reverseCtrl.value,deletePath:deletePathCtrl.value,smartPlacement:smartCtrl.value,repeatMode:repeatCtrl.value,repeatCount:Math.max(2,Math.round(repeatCountCtrl.value)),xfm:{scaleStart:scaleStartCtrl.value/100,scaleEnd:scaleEndCtrl.value/100,rotStartDeg:rotStartCtrl.value,rotEndDeg:rotEndCtrl.value},rnd:{enabled:randCtrl.value,shuffleSeed:Math.round(shuffleSeedCtrl.value),jitterSeed:Math.round(jitterSeedCtrl.value),jitterAmt:jitterAmtCtrl.value,rotSeed:Math.round(rotSeedCtrl.value),rotMaxDeg:rotMaxCtrl.value,sizeSeed:Math.round(sizeSeedCtrl.value),sizeAmt:sizeAmtCtrl.value,zSeed:Math.round(zSeedCtrl.value)}};}

        let previewActive=false,extraUndoCount=0,lastResult=null;
        function runApply(params){
          extraUndoCount=0;lastResult=null;
          lastResult=doApplyAll(doc,cfg,params);
          extraUndoCount=lastResult.extraUndos;
        }
        function runUndo(){for(let i=0;i<extraUndoCount;i++)doUndo(doc);doUndo(doc);extraUndoCount=0;lastResult=null;}

        try{runApply(getParams());previewActive=true;}catch(e){showError('Preview failed:\n'+e.message);}

        let running=true;
        while(running){
          btns.selectedIndex=0;
          const r=dlg.show();
          const params=getParams(),mode=btns.selectedIndex;
          if(previewActive){runUndo();previewActive=false;}
          if(r.value===DialogResult.Ok.value){
            try{runApply(params);previewActive=true;}catch(e){showError('Arrange failed:\n'+e.message);}
            if(mode===1){
              if(previewActive&&lastResult){
                const ppn=lastResult.perPathNodes;
                for(let p=0;p<ppn.length;p++)groupIntoContainer(doc,ppn[p],`sh${p+1}`);
              }
              if(previewActive&&params.deletePath){try{for(const pn of cfg.pathNodes)doc.deleteSelection(pn.selfSelection);}catch(e){}}
              running=false;
            }
          }else{running=false;}
        }
      }
    }
  }
}
