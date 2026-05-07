/**
 * name: Tile Generator
 * description: 10 pattern types:
 * 
 * 	Basic Grid — straight rows and columns
 * 	Brick Offset — every other row shifted by stagger %
 * 	Half-Drop — every other column shifted by stagger %
 * 	Diamond — 45° rotated grid
 * 	Hexagonal — honeycomb packing (cos 30° row height)
 * 	Radial Burst — tiles in concentric rings (cols = rings, rows = items per ring)
 * 	Spiral — Fibonacci golden-angle spiral placement
 * 	Wave — sinusoidal row offset driven by stagger %
 * 	Pinwheel — grid positions with progressive rotation across the whole pattern
 * 	Random Scatter — randomised position and rotation within each grid cell
 * 
 * 	Progressive hue shifting: reads the source object's solid fill colour, 
 * 	(e.g. 180° = complementary colours) across all tiles.
 * version: 1.0.0
 * author: S1m0mP1
 */


"use strict";

const { Document }   = require("/document");
const { Dialog, DialogResult } = require("/dialog");
const { AddChildNodesCommandBuilder, DocumentCommand, NodeChildType, NodeMoveType } = require("/commands");
const { ContainerNodeDefinition } = require("/nodes");
const { Selection } = require("/selections");
const { Transform }  = require("/geometry");
const { UnitType }   = require("/units");
const { Colour }     = require("/colours");
const { SolidFill, FillDescriptor } = require("/fills");

function getNodeBox(n) {
  return n.exactSpreadBaseBox ||
    (typeof n.getSpreadBaseBox === "function" ? n.getSpreadBaseBox(true) : null) ||
    n.spreadVisibleBox;
}

function getBounds(sel) {
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity,ok=false;
  for (let i=0;i<sel.length;i++) {
    const bb=getNodeBox(sel.at(i).node);
    if (!bb) continue; ok=true;
    if (bb.x<minX)minX=bb.x; if (bb.y<minY)minY=bb.y;
    if (bb.x+bb.width>maxX)maxX=bb.x+bb.width;
    if (bb.y+bb.height>maxY)maxY=bb.y+bb.height;
  }
  return ok?{x:minX,y:minY,width:maxX-minX,height:maxY-minY}:{x:0,y:0,width:0,height:0};
}

function exec(doc,cmd){doc.executeCommand(cmd);}
function undoN(doc,n){for(let i=0;i<n;i++)exec(doc,DocumentCommand.createUndo());}

function createGroup(doc,name) {
  const b=AddChildNodesCommandBuilder.create();
  b.setInsertionTarget(doc.currentSpread);
  b.addContainerNode(ContainerNodeDefinition.create(name));
  const cmd=b.createCommand(false,NodeChildType.Main);
  doc.executeCommand(cmd);
  return cmd.newNodes[0];
}
function moveInto(doc,nodes,container) {
  const v=nodes.filter(Boolean);
  if(!v.length)return;
  exec(doc,DocumentCommand.createMoveNodes(Selection.create(doc,v),container,NodeMoveType.Inside,NodeChildType.Main));
}

function makeRng(seed) {
  let s=seed>>>0||1;
  return ()=>{s+=0x6d2b79f5;let t=Math.imul(s^s>>>15,1|s);t^=t+Math.imul(t^t>>>7,61|t);return((t^t>>>14)>>>0)/4294967296;};
}

function readFillHSL(node) {
  try {
    const fd=node.brushFillDescriptor;
    if (!fd) return null;
    const fill=fd.fill;
    return (fill&&fill.colour)?fill.colour.hslaf:null;
  } catch(e){return null;}
}

function shiftNodeHue(doc,node,hslFallback,hueDelta) {
  let count=0;
  if (Math.abs(hueDelta)<0.0001) return 0;
  try {
    const hsl=readFillHSL(node)||hslFallback;
    if (hsl) {
      const newH=((hsl.h+hueDelta)%1.0+1.0)%1.0;
      const newCol=Colour.createHSLAf({h:newH,s:hsl.s,l:hsl.l,alpha:hsl.alpha});
      doc.setBrushFillDescriptor(FillDescriptor.createSolid(SolidFill.create(newCol)),node);
      count++;
    }
  } catch(e){}
  let child=node.firstChild;
  while(child){count+=shiftNodeHue(doc,child,hslFallback,hueDelta);child=child.nextSibling;}
  return count;
}

const PATTERN_NAMES=[
  "Basic Grid","Brick Offset","Half-Drop","Diamond","Hexagonal",
  "Radial Burst","Spiral","Wave","Pinwheel","Random Scatter"
];

function makeTiles(patType,cols,rows,unitW,unitH,stagger,rng) {
  const tiles=[], total=cols*rows, stg=stagger/100;
  const cx=(cols-1)*unitW/2, cy=(rows-1)*unitH/2;
  switch(patType) {
    case 0:
      for(let r=0;r<rows;r++)for(let c=0;c<cols;c++)
        tiles.push({dx:c*unitW,dy:r*unitH,rot:0}); break;
    case 1:
      for(let r=0;r<rows;r++)for(let c=0;c<cols;c++)
        tiles.push({dx:c*unitW+(r%2?unitW*stg:0),dy:r*unitH,rot:0}); break;
    case 2:
      for(let r=0;r<rows;r++)for(let c=0;c<cols;c++)
        tiles.push({dx:c*unitW,dy:r*unitH+(c%2?unitH*stg:0),rot:0}); break;
    case 3:
      for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){
        const gx=c*unitW-cx,gy=r*unitH-cy,ang=Math.PI/4;
        tiles.push({dx:gx*Math.cos(ang)-gy*Math.sin(ang)+cx,
                    dy:gx*Math.sin(ang)+gy*Math.cos(ang)+cy,rot:0});
      } break;
    case 4:
      for(let r=0;r<rows;r++)for(let c=0;c<cols;c++)
        tiles.push({dx:c*unitW+(r%2?unitW*0.5:0),dy:r*unitH*0.866,rot:0}); break;
    case 5:
      tiles.push({dx:0,dy:0,rot:0});
      for(let ring=1;ring<=cols;ring++){
        const count=rows*ring,radius=ring*unitW;
        for(let i=0;i<count;i++){
          const a=(i/count)*2*Math.PI;
          tiles.push({dx:Math.cos(a)*radius,dy:Math.sin(a)*radius,rot:0});
        }
      } break;
    case 6:
      for(let i=0;i<total;i++){
        const a=i*Math.PI*(3-Math.sqrt(5)),r=Math.sqrt(i)*unitW*0.6;
        tiles.push({dx:Math.cos(a)*r,dy:Math.sin(a)*r,rot:0});
      } break;
    case 7:{
      const wAmp=unitH*stg,wFreq=2*Math.PI/Math.max(1,cols-1);
      for(let r=0;r<rows;r++)for(let c=0;c<cols;c++)
        tiles.push({dx:c*unitW,dy:r*unitH+Math.sin(c*wFreq)*wAmp,rot:0});
      break;}
    case 8:{
      let idx=0;
      for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){
        tiles.push({dx:c*unitW,dy:r*unitH,rot:(idx/Math.max(1,total-1))*360*stg});
        idx++;
      } break;}
    case 9:
      for(let r=0;r<rows;r++)for(let c=0;c<cols;c++)
        tiles.push({dx:c*unitW+(rng()-0.5)*unitW*stg,
                    dy:r*unitH+(rng()-0.5)*unitH*stg,
                    rot:rng()*360*stg}); break;
  }
  return tiles;
}

function generate(doc,origNodes,bounds,opts,isFinal) {
  const {cols,rows,gapX,gapY,patType,stagger,hueShift,seed}=opts;
  const unitW=(bounds.width||0)+gapX, unitH=(bounds.height||0)+gapY;
  const rng=makeRng(seed);
  const cx=bounds.x+bounds.width/2, cy=bounds.y+bounds.height/2;
  const tiles=makeTiles(patType,cols,rows,unitW,unitH,stagger,rng);
  const total=tiles.length;
  const ox=tiles.length?tiles[0].dx:0, oy=tiles.length?tiles[0].dy:0;

  let srcHSL=null;
  for(const n of origNodes){
    srcHSL=readFillHSL(n); if(srcHSL) break;
    let ch=n.firstChild; while(ch&&!srcHSL){srcHSL=readFillHSL(ch);ch=ch.nextSibling;}
  }

  let cmds=0;
  const dupNodes=[];

  for(let i=1;i<total;i++){
    const tile=tiles[i];
    const relDX=tile.dx-ox, relDY=tile.dy-oy;
    for(const node of origNodes){
      try{
        let t=Transform.createTranslate(relDX,relDY);
        if(tile.rot!==0){
          const tcx=cx+relDX, tcy=cy+relDY;
          t=Transform.createRotate(tile.rot*Math.PI/180,tcx,tcy).multiply(t);
        }
        const dup=node.duplicate(t);
        if(dup){dupNodes.push(dup);cmds++;}
      }catch(e){}
    }
    if(hueShift>0&&srcHSL){
      const hueDelta=(i/Math.max(1,total-1))*(hueShift/360);
      const myDupes=dupNodes.slice(dupNodes.length-origNodes.length);
      for(const dup of myDupes) cmds+=shiftNodeHue(doc,dup,srcHSL,hueDelta);
    }
  }

  const label=isFinal
    ? `${PATTERN_NAMES[patType]} ${cols}×${rows}`
    : `Preview — ${PATTERN_NAMES[patType]}`;
  const grp=createGroup(doc,label); cmds++;
  moveInto(doc,[...origNodes,...dupNodes],grp); cmds++;
  return {cmds,group:grp};
}

function showError(msg){
  const d=Dialog.create("Tile Generator – Error");
  d.initialWidth=420;
  d.addColumn().addGroup("").addStaticText("",msg).isFullWidth=true;
  d.runModal();
}

function main(){
  const doc=Document.current;
  if(!doc) return showError("No document open.");
  const sel=doc.selection;
  if(!sel||sel.length===0) return showError("Select at least one object to tile.");

  const origNodes=[];
  for(let i=0;i<sel.length;i++) origNodes.push(sel.at(i).node);
  const bounds=getBounds(sel);

  const dlg=Dialog.create("✦ Tile Generator");
  dlg.initialWidth=420;
  const col=dlg.addColumn();

  const typeGrp=col.addGroup("Pattern Type");
  const typeCtrl=typeGrp.addComboBox("Type",PATTERN_NAMES,0);
  typeCtrl.isFullWidth=true;

  const gridGrp=col.addGroup("Grid");
  const colsCtrl=gridGrp.addUnitValueEditor("Columns / Rings",UnitType.Number,UnitType.Number,5,1,50);
  colsCtrl.precision=0;
  const rowsCtrl=gridGrp.addUnitValueEditor("Rows / Per Ring",UnitType.Number,UnitType.Number,5,1,50);
  rowsCtrl.precision=0;

  const spaceGrp=col.addGroup("Spacing");
  const gapXCtrl=spaceGrp.addUnitValueEditor("Gap X (px)",UnitType.Number,UnitType.Number,10,-5000,5000);
  gapXCtrl.precision=1;
  const gapYCtrl=spaceGrp.addUnitValueEditor("Gap Y (px)",UnitType.Number,UnitType.Number,10,-5000,5000);
  gapYCtrl.precision=1;
  const staggerCtrl=spaceGrp.addUnitValueEditor("Stagger / Wave / Scatter %",UnitType.Number,UnitType.Number,50,0,100);
  staggerCtrl.precision=0;

  const colGrp=col.addGroup("Colour");
  const hueCtrl=colGrp.addUnitValueEditor("Hue shift across pattern (°)",UnitType.Number,UnitType.Number,180,0,360);
  hueCtrl.precision=0;
  const seedCtrl=colGrp.addUnitValueEditor("Random seed",UnitType.Number,UnitType.Number,42,1,9999);
  seedCtrl.precision=0;

  const actGrp=col.addGroup("Actions");
  const statusTxt=actGrp.addStaticText("","");
  statusTxt.isFullWidth=true;
  const btns=actGrp.addButtonSet("",["↺ Preview","✓ Apply"],0);
  btns.isFullWidth=true;

  function getOpts(){
    return{
      cols:Math.max(1,Math.round(colsCtrl.value)),
      rows:Math.max(1,Math.round(rowsCtrl.value)),
      gapX:gapXCtrl.value, gapY:gapYCtrl.value,
      patType:typeCtrl.selectedIndex,
      stagger:staggerCtrl.value,
      hueShift:hueCtrl.value,
      seed:Math.round(seedCtrl.value),
    };
  }

  let previewCmds=0, previewActive=false;

  function clearPreview(){
    if(previewActive){undoN(doc,previewCmds);previewActive=false;previewCmds=0;}
  }

  // Auto-preview on open with default settings, before the dialog appears
  try{
    const opts=getOpts();
    const res=generate(doc,origNodes,bounds,opts,false);
    previewCmds=res.cmds; previewActive=true;
    statusTxt.text=`Previewing: ${PATTERN_NAMES[opts.patType]} ${opts.cols}×${opts.rows} — Apply to keep`;
  }catch(e){statusTxt.text="Preview error: "+e.message;}

  let running=true;
  while(running){
    btns.selectedIndex=0;
    const result=dlg.runModal();
    const mode=btns.selectedIndex;

    if(result.value!==DialogResult.Ok.value){
      clearPreview();
      running=false;
    } else if(mode===1){
      clearPreview();
      try{
        const res=generate(doc,origNodes,bounds,getOpts(),true);
        exec(doc,DocumentCommand.createSetSelection(res.group.selfSelection));
        running=false;
      }catch(e){statusTxt.text="✖ Error: "+e.message;}
    } else {
      clearPreview();
      try{
        const opts=getOpts();
        const res=generate(doc,origNodes,bounds,opts,false);
        previewCmds=res.cmds; previewActive=true;
        statusTxt.text=`Previewing: ${PATTERN_NAMES[opts.patType]} ${opts.cols}×${opts.rows} — Apply to keep`;
      }catch(e){statusTxt.text="✖ Preview error: "+e.message;}
    }
  }
}

try{main();}
catch(err){
  const d=Dialog.create("Tile Generator – Crash");
  d.initialWidth=420;
  d.addColumn().addGroup("Error").addStaticText("",String(err)).isFullWidth=true;
  d.runModal();
}
