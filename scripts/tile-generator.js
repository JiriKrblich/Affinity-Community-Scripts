/**
 * name: Tile Generator
 * description: This script generates tile-based patterns from a selected object. It supports multiple layout styles, including a basic grid, brick offset, half-drop, diamond, hexagonal, radial burst, spiral, wave, pinwheel, and random scatter. It also includes progressive hue shifting, which reads the solid or gradient fill colours (shapes and text) and shifts the hue across all tiles, for example by 180° to create complementary colors.
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
 * version: 1.2.0
 * author: S1m0nP1
 *
 * 1.2.0 – Hue shift for gradient fills and text:
 *  - Solid AND gradient fills are shifted (every gradient stop gets the hue
 *    offset; stop positions, midpoints, gradient type, fill transform, blend
 *    mode and spread anchoring are kept).
 *  - Text objects (Artistic/Frame text): the real glyph fill is read from
 *    the story (node.brushFillDescriptor is always NoFill for text) and
 *    shifted per formatting run, so differently coloured words keep their
 *    individual colours.
 *  - Groups/layers are processed recursively; the source object no longer
 *    needs a solid fill for the hue shift to work.
 *  - Fills anchored to the spread (typical for script-made text gradients)
 *    stay where they are when an object is duplicated/moved, so copies
 *    showed only one end colour of the gradient. The fill transform is now
 *    carried along with each tile's move/rotation (also without hue shift).
 * 1.1.0 – checked/adapted for current Affinity SDK (3.3):
 *  - Transform.createRotate(rad) takes ONLY the angle (extra centre
 *    arguments are ignored) -> Pinwheel/Random Scatter rotated every tile
 *    around the spread origin (0,0) and threw tiles off the page. Rotation
 *    about the tile centre is now composed explicitly.
 *  - Preview rollback via doc.history.position instead of counting commands
 *    and replaying "Undo" (a miscount could undo the user's own work).
 *  - Single runModal(): "Update Preview" button keeps the dialog open,
 *    native OK = apply, Cancel/X/ESC = discard.
 *  - Gaps in document units; start values set explicitly; result layer is
 *    created in the parent of the originals instead of at spread level.
 */


"use strict";

const { Document }   = require("/document");
const { Dialog, DialogResult } = require("/dialog");
const { AddChildNodesCommandBuilder, DocumentCommand, NodeChildType, NodeMoveType } = require("/commands");
const { ContainerNodeDefinition } = require("/nodes");
const { Selection } = require("/selections");
const { Transform }  = require("/geometry");
const { UnitType }   = require("/units");
const { Colour, Gradient } = require("/colours");
const { FillDescriptor } = require("/fills");
const { TextSelection } = require("/selections");
const { StoryRange } = require("/story");
const { StoryDelta } = require("/storydelta");

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

// Rotation about a point. Transform.createRotate(rad) only takes the angle;
// A.multiply(B) applies B first.
function rotateAbout(rad,px,py){
  return Transform.createTranslate(px,py)
    .multiply(Transform.createRotate(rad))
    .multiply(Transform.createTranslate(-px,-py));
}

// Parent of the originals (layer / artboard / spread)
function findParentTarget(doc,nodes){
  try{
    const p=nodes[0].parent;
    if(p&&p[Symbol.toStringTag]!=="DocumentNode") return p;
  }catch(e){}
  return doc.currentSpread;
}

function createGroup(doc,name,target) {
  const b=AddChildNodesCommandBuilder.create();
  b.setInsertionTarget(target||doc.currentSpread);
  b.addContainerNode(ContainerNodeDefinition.create(name));
  const cmd=b.createCommand(false,NodeChildType.Main);
  doc.executeCommand(cmd);
  const node=cmd.newNodes[0];
  if(!node) throw new Error("Could not create layer '"+name+"'.");
  return node;
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

// ---- hue shift (solid + gradient, vector + text) --------------------------

function shiftColour(col,delta){
  const h=col.hslaf;
  return Colour.createHSLAf({h:((h.h+delta)%1+1)%1,s:h.s,l:h.l,alpha:h.alpha});
}

// Returns a new FillDescriptor (hue shifted and/or spread anchoring carried
// along with the tile transform), or null if nothing has to change.
// tileTf: spread-space transform that was applied to the duplicate.
function shiftFillDescriptor(fd,delta,tileTf){
  const f=fd&&fd.fill;
  if(!f) return null;
  const tag=f[Symbol.toStringTag];
  const doShift=Math.abs(delta)>=0.0001;
  if(tag==="SolidFill"){
    return doShift?FillDescriptor.createSolid(shiftColour(f.colour,delta),fd.blendMode):null;
  }
  if(tag==="GradientFill"){
    const move=!!(tileTf&&fd.isAnchoredToSpread&&fd.transform);
    if(!doShift&&!move) return null;
    let newFill=f;
    if(doShift){
      const stops=f.gradient.stops.map(st=>({
        position:st.position, midpoint:st.midpoint, smoothness:st.smoothness,
        colour:shiftColour(new Colour(st.colour),delta)
      }));
      newFill=f.cloneWithNewGradient(Gradient.create(stops));
    }
    const tf=move?tileTf.multiply(fd.transform):fd.transform;
    // Rebuild (cloneWithNewFill is unreliable) - keep geometry and anchoring
    return FillDescriptor.create(newFill,fd.isScaleWithObject,tf,fd.blendMode,fd.isAnchoredToSpread);
  }
  return null;
}

function isTextNode(node){
  return /Text/.test(String(node[Symbol.toStringTag]))&&!!node.story;
}
function isContainer(node){
  return /Group|Container/.test(String(node[Symbol.toStringTag]));
}

// Text: shift every formatting run separately (keeps multi-colour text)
function shiftTextHue(doc,node,delta,tileTf){
  let count=0;
  const runs=[...node.story.glyphAttRuns];
  for(const r of runs){
    const nfd=shiftFillDescriptor(r.glyphAtts.brushFill,delta,tileTf);
    if(!nfd||r.end<=r.begin) continue;
    const sel=Selection.create(doc,node);
    sel.addSubSelectionForNode(node,TextSelection.create([new StoryRange(r.begin,r.end)]));
    doc.formatText(StoryDelta.createBrushFill(nfd),sel,false);
    count++;
  }
  return count;
}

function hasHueSource(node){
  try{
    if(isTextNode(node)) return [...node.story.glyphAttRuns].some(r=>!!shiftFillDescriptor(r.glyphAtts.brushFill,0.5,null));
    if(isContainer(node)) return [...node.children].some(hasHueSource);
    return !!shiftFillDescriptor(node.brushFillDescriptor,0.5,null);
  }catch(e){return false;}
}

function shiftNodeHue(doc,node,hueDelta,tileTf){
  let count=0;
  try{
    if(isTextNode(node)) return shiftTextHue(doc,node,hueDelta,tileTf);
    if(isContainer(node)){
      for(const ch of [...node.children]) count+=shiftNodeHue(doc,ch,hueDelta,tileTf);
      return count;
    }
    const nfd=shiftFillDescriptor(node.brushFillDescriptor,hueDelta,tileTf);
    if(nfd){doc.setBrushFillDescriptor(nfd,node);count++;}
  }catch(e){console.log("Hue shift skipped: "+e.message);}
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

function generate(doc,origNodes,bounds,opts,isFinal,target) {
  const {cols,rows,gapX,gapY,patType,stagger,hueShift,seed}=opts;
  const unitW=(bounds.width||0)+gapX, unitH=(bounds.height||0)+gapY;
  const rng=makeRng(seed);
  const cx=bounds.x+bounds.width/2, cy=bounds.y+bounds.height/2;
  const tiles=makeTiles(patType,cols,rows,unitW,unitH,stagger,rng);
  const total=tiles.length;
  const ox=tiles.length?tiles[0].dx:0, oy=tiles.length?tiles[0].dy:0;

  const canShift=hueShift>0&&origNodes.some(hasHueSource);

  let cmds=0;
  const dupNodes=[];

  for(let i=1;i<total;i++){
    const tile=tiles[i];
    const relDX=tile.dx-ox, relDY=tile.dy-oy;
    let t=Transform.createTranslate(relDX,relDY);
    if(tile.rot!==0){
      const tcx=cx+relDX, tcy=cy+relDY;
      t=rotateAbout(tile.rot*Math.PI/180,tcx,tcy).multiply(t);
    }
    const hueDelta=canShift?(i/Math.max(1,total-1))*(hueShift/360):0;
    for(const node of origNodes){
      try{
        const dup=node.duplicate(t);
        if(dup){
          dupNodes.push(dup);cmds++;
          // hue shift + carry spread-anchored gradients along with the tile
          cmds+=shiftNodeHue(doc,dup,hueDelta,t);
        }
      }catch(e){}
    }
  }

  const label=isFinal
    ? `${PATTERN_NAMES[patType]} ${cols}×${rows}`
    : `Preview — ${PATTERN_NAMES[patType]}`;
  const grp=createGroup(doc,label,target); cmds++;
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
  const target=findParentTarget(doc,origNodes);

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
  const gapXCtrl=spaceGrp.addUnitValueEditor("Gap X",UnitType.Pixel,doc.units,10,-5000,5000);
  const gapYCtrl=spaceGrp.addUnitValueEditor("Gap Y",UnitType.Pixel,doc.units,10,-5000,5000);
  const staggerCtrl=spaceGrp.addUnitValueEditor("Stagger / Wave / Scatter %",UnitType.Number,UnitType.Number,50,0,100);
  staggerCtrl.precision=0;

  const colGrp=col.addGroup("Colour");
  const hueCtrl=colGrp.addUnitValueEditor("Hue shift across pattern (°)",UnitType.Number,UnitType.Number,180,0,360);
  hueCtrl.precision=0;
  const seedCtrl=colGrp.addUnitValueEditor("Random seed",UnitType.Number,UnitType.Number,42,1,9999);
  seedCtrl.precision=0;

  const actGrp=col.addGroup("Actions");
  const previewBtn=actGrp.addButton("↺ Update Preview");
  previewBtn.isFullWidth=true;
  const statusTxt=actGrp.addStaticText("","");
  statusTxt.isFullWidth=true;

  // Start values explicitly (initial values are not reliably taken over)
  typeCtrl.selectedIndex=0;
  colsCtrl.value=5; rowsCtrl.value=5;
  gapXCtrl.value=10; gapYCtrl.value=10;
  staggerCtrl.value=50; hueCtrl.value=180; seedCtrl.value=42;

  function getOpts(){
    return{
      cols:Math.max(1,Math.round(Number(colsCtrl.value)||1)),
      rows:Math.max(1,Math.round(Number(rowsCtrl.value)||1)),
      gapX:Number(gapXCtrl.value)||0, gapY:Number(gapYCtrl.value)||0,
      patType:Number(typeCtrl.selectedIndex)||0,
      stagger:Number(staggerCtrl.value)||0,
      hueShift:Number(hueCtrl.value)||0,
      seed:Math.round(Number(seedCtrl.value)||1),
    };
  }

  // Preview handling via history position
  const basePos=doc.history.position;
  function clearPreview(){
    let guard=100000;
    while(doc.history.position>basePos&&guard-->0) doc.history.undo();
  }

  function updatePreview(){
    clearPreview();
    try{
      const opts=getOpts();
      generate(doc,origNodes,bounds,opts,false,target);
      statusTxt.text=`Previewing: ${PATTERN_NAMES[opts.patType]} ${opts.cols}×${opts.rows} — OK to keep`;
    }catch(e){
      clearPreview();
      statusTxt.text="✖ Preview error: "+e.message;
    }
  }

  previewBtn.setOnClickHandler(updatePreview);
  updatePreview();

  const result=dlg.runModal();
  clearPreview();
  if(!result||result.value!==DialogResult.Ok.value) return;

  try{
    const res=generate(doc,origNodes,bounds,getOpts(),true,target);
    exec(doc,DocumentCommand.createSetSelection(res.group.selfSelection));
  }catch(e){
    clearPreview();
    showError("Apply error: "+e.message);
  }
}

try{main();}
catch(err){
  const d=Dialog.create("Tile Generator – Crash");
  d.initialWidth=420;
  d.addColumn().addGroup("Error").addStaticText("",String(err)).isFullWidth=true;
  d.runModal();
}
