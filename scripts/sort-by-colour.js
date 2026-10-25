
'use strict';

const { Document } = require('/document');
const { Selection } = require('/selections');
const { Dialog, DialogResult } = require('/dialog');
const { app } = require('/application');
const { DocumentCommand, CompoundCommandBuilder, AddChildNodesCommandBuilder, NodeMoveType, NodeChildType } = require('/commands');
const { ContainerNodeDefinition } = require('/nodes');
const { Colour } = require('/colours');

function toColour(colOrHandle) {
  return (colOrHandle && colOrHandle.hslaf !== undefined) ? colOrHandle : new Colour(colOrHandle);
}

function isTextNode(node) {
  return !!node.story;
}

function getFillDescriptor(node, usePen) {
  if (isTextNode(node)) {
    try {
      const atts = node.story.getGlyphAtts(0);
      return usePen ? atts.penFill : atts.brushFill;
    } catch(e) { return null; }
  }
  try {
    return usePen ? node.penFillDescriptor : node.brushFillDescriptor;
  } catch(e) { return null; }
}

function getColorHsl(node, usePen) {
  try {
    const fd = getFillDescriptor(node, usePen);
    const fill = fd && fd.fill;
    if (!fill || fill[Symbol.toStringTag] !== 'SolidFill') return null;
    const c = toColour(fill.colour);
    const h = c.hslaf;
    return { h: h.h*360, s: h.s*100, l: h.l*100 };
  } catch(e) { return null; }
}

function hslToHex(h, s, l) {
  h/=360; s/=100; l/=100;
  let r,g,b;
  if (s===0) { r=g=b=l; } else {
    const q=l<0.5?l*(1+s):l+s-l*s, p=2*l-q;
    const hue2rgb=(pp,qq,t)=>{if(t<0)t+=1;if(t>1)t-=1;if(t<1/6)return pp+(qq-pp)*6*t;if(t<1/2)return qq;if(t<2/3)return pp+(qq-pp)*(2/3-t)*6;return pp;};
    r=hue2rgb(p,q,h+1/3); g=hue2rgb(p,q,h); b=hue2rgb(p,q,h-1/3);
  }
  const toHex=x=>Math.round(x*255).toString(16).padStart(2,'0');
  return '#'+toHex(r)+toHex(g)+toHex(b);
}

function hslToName(h, s, l) {
  if (s < 8) {
    if (l < 20) return 'Black';
    if (l > 80) return 'White';
    return 'Grey';
  }
  if (h < 15 || h >= 345) return 'Red';
  if (h < 40)  return 'Orange';
  if (h < 70)  return 'Yellow';
  if (h < 150) return 'Green';
  if (h < 190) return 'Cyan';
  if (h < 260) return 'Blue';
  if (h < 290) return 'Violet';
  return 'Magenta';
}

function groupLabel(gi, c, useName) {
  if (!c) return 'No solid colour';
  const hex = hslToHex(c.h, c.s, c.l);
  return useName ? hslToName(c.h, c.s, c.l)+' '+hex : 'Colour group '+(gi+1)+' '+hex;
}

function getArea(node) {
  try { const bb=node.spreadVisibleBox; if(bb) return bb.width*bb.height; } catch(e) {}
  return 0;
}

function isGroup(node) {
  return node.isGroupNode === true || node[Symbol.toStringTag] === 'ContainerNode';
}

function colorDist(c1, c2, mode, tolH, tolS, tolL) {
  if (mode===0) {
    const dh=Math.min(Math.abs(c1.h-c2.h),360-Math.abs(c1.h-c2.h))/180;
    const ds=Math.abs(c1.s-c2.s)/100, dl=Math.abs(c1.l-c2.l)/100;
    return Math.sqrt(dh*dh*2+ds*ds*0.8+dl*dl*0.6)*100;
  }
  if (mode===1) return Math.min(Math.abs(c1.h-c2.h),360-Math.abs(c1.h-c2.h));
  if (mode===2) return Math.abs(c1.s-c2.s);
  if (mode===3) return Math.abs(c1.l-c2.l);
  const dh=Math.min(Math.abs(c1.h-c2.h),360-Math.abs(c1.h-c2.h));
  const ds=Math.abs(c1.s-c2.s), dl=Math.abs(c1.l-c2.l);
  return (dh<=tolH && ds<=tolS && dl<=tolL) ? 0 : 1e9;
}

function suggestTolerance(items) {
  const colored = items.filter(x=>x.hsl);
  if (colored.length < 2) return 15;
  const sample = colored.slice(0, 100);
  const dists = [];
  for (let i=0; i<sample.length; i++)
    for (let j=i+1; j<Math.min(i+6,sample.length); j++)
      dists.push(colorDist(sample[i].hsl, sample[j].hsl, 0, 30, 30, 30));
  dists.sort((a,b)=>a-b);
  return Math.min(100, Math.max(1, Math.round(dists[Math.floor(dists.length*0.20)] || 15)));
}

function calcGroups(items, mode, tol, tolH, tolS, tolL, sortAsc, minArea, grayThresh, useGrayGroup) {
  const groups = [];
  const grayGroup = useGrayGroup ? {c:null, isGray:true, totalArea:0, items:[]} : null;

  for (let i=0; i<items.length; i++) {
    const item = items[i];
    if (item.area < minArea) continue;
    if (useGrayGroup && item.hsl && item.hsl.s < grayThresh) {
      grayGroup.items.push(item); grayGroup.totalArea+=item.area; continue;
    }
    if (!item.hsl) {
      let ng = groups.find(g=>g.noColor);
      if (!ng) { ng={c:null,noColor:true,totalArea:0,items:[]}; groups.push(ng); }
      ng.items.push(item); ng.totalArea+=item.area; continue;
    }
    let best=null, bestD=1e9;
    for (let j=0; j<groups.length; j++) {
      if (!groups[j].c||groups[j].noColor) continue;
      const d=colorDist(item.hsl,groups[j].c,mode,tolH,tolS,tolL);
      if (d<bestD) { bestD=d; best=groups[j]; }
    }
    const threshold = mode===4 ? 0.5 : tol;
    if (best && bestD<=threshold) {
      best.items.push(item); best.totalArea+=item.area;
      const wc=best.items.filter(x=>x.hsl);
      let sh=0,ss=0,sl=0;
      wc.forEach(x=>{sh+=x.hsl.h;ss+=x.hsl.s;sl+=x.hsl.l;});
      best.c={h:sh/wc.length,s:ss/wc.length,l:sl/wc.length};
    } else {
      groups.push({c:{...item.hsl},noColor:false,totalArea:item.area,items:[item]});
    }
  }

  const result = groups.filter(g=>g.items.length>0);
  if (grayGroup && grayGroup.items.length>0) result.unshift(grayGroup);

  if (sortAsc) {
    result.forEach(g=>g.items.sort((a,b)=>a.area-b.area));
    result.sort((a,b)=>a.totalArea-b.totalArea);
  } else {
    result.forEach(g=>g.items.sort((a,b)=>b.area-a.area));
    result.sort((a,b)=>b.totalArea-a.totalArea);
  }
  return result;
}

// ── Selection ─────────────────────────────────────────────────────────────────

const doc = Document.current;
if (!doc) { app.alert('No active document.','Sort by Colour'); throw new Error(); }
const sel = doc.selection;
if (!sel || sel.length < 1) { app.alert('Please select at least 1 object.','Sort by Colour'); throw new Error(); }

const sourceGroupsRaw = [];
const directNodesRaw = [];
let textNodeCount = 0;

for (let i=0; i<sel.length; i++) {
  const n = sel.at(i).node;
  if (!n) continue;
  if (isGroup(n)) {
    const children = [];
    for (const ch of n.children) {
      children.push(ch);
      if (isTextNode(ch)) textNodeCount++;
    }
    if (children.length>0) sourceGroupsRaw.push({sourceGroup:n, nodes:children});
  } else {
    directNodesRaw.push(n);
    if (isTextNode(n)) textNodeCount++;
  }
}
if (directNodesRaw.length>0) sourceGroupsRaw.unshift({sourceGroup:null, nodes:directNodesRaw});
if (sourceGroupsRaw.length===0) { app.alert('No objects found.','Sort by Colour'); throw new Error(); }
const totalItems = sourceGroupsRaw.reduce((s,g)=>s+g.nodes.length, 0);
if (totalItems<2) { app.alert('At least 2 objects required.','Sort by Colour'); throw new Error(); }

// ── Dialog ────────────────────────────────────────────────────────────────────

const dlg = Dialog.create('Sort by Colour');
dlg.setIsResizable(true);
dlg.initialWidth = 500;

const col = dlg.addColumn();
col.widthProportion = 1;

const grpInfo = col.addGroup('Selection');
const infoLines = [sourceGroupsRaw.length+' source(s), '+totalItems+' objects'
  + (textNodeCount>0 ? ' ('+textNodeCount+' text objects)' : '')];
sourceGroupsRaw.forEach((sg,i)=>{
  const name = sg.sourceGroup ? (sg.sourceGroup.userDescription||'Group '+(i+1)) : 'Direct selection';
  infoLines.push('  '+name+': '+sg.nodes.length+' obj.');
});
grpInfo.addStaticText('', infoLines.join('\n'));

const grpSource = col.addGroup('Colour source');
const cmbSource = grpSource.addComboBox('Colour from', ['Fill','Stroke'], 0);
grpSource.addStaticText('', textNodeCount>0
  ? 'For text objects: fill/stroke of the first character.'
  : 'Determines whether fill colour or stroke colour is used for sorting.');

const grpMode = col.addGroup('Colour sort mode');
const cmb = grpMode.addComboBox('Mode', ['HSL overall (visual)','Hue H','Saturation S','Lightness L','H+S+L separate'], 0);
const edT  = grpMode.addUnitValueEditor('Tolerance', 'none','none',null,0,100);
edT.value = 15; edT.showPopupSlider = true;
const edTH = grpMode.addUnitValueEditor('Tolerance Hue H', 'none','none',null,0,180);
edTH.value = 20; edTH.showPopupSlider = true;
const edTS = grpMode.addUnitValueEditor('Tolerance Saturation S', 'none','none',null,0,100);
edTS.value = 20; edTS.showPopupSlider = true;
const edTL = grpMode.addUnitValueEditor('Tolerance Lightness L', 'none','none',null,0,100);
edTL.value = 20; edTL.showPopupSlider = true;

const grpPreset = col.addGroup('Tolerance presets');
grpPreset.addStaticText('', 'Sets tolerance for active mode:');
const btnPreset = grpPreset.addButtonSet('', ['Tight (5)','Medium (15)','Wide (35)','Auto'], 0);

const grpFilter = col.addGroup('Filter');
const edMinArea = grpFilter.addUnitValueEditor('Min. area (pt)', 'none','none',null,0,10000);
edMinArea.value = 0; edMinArea.showPopupSlider = true;
const chkGray = grpFilter.addCheckBox('Separate grey tones', false);
const edGray  = grpFilter.addUnitValueEditor('Grey S% <', 'none','none',null,0,50);
edGray.value = 8; edGray.showPopupSlider = true;

const grpOpt = col.addGroup('Options');
const cmbSort = grpOpt.addComboBox('Size order', ['Small to Large','Large to Small'], 0);
const cmbPos  = grpOpt.addComboBox('Position sort', ['None','Left to Right','Top to Bottom'], 0);
const chkName = grpOpt.addCheckBox('Name groups by colour', true);

const grpAct = col.addGroup('Action');
grpAct.addStaticText('', 'Preview shows analysis. Group applies the action.');
const btnAct = grpAct.addButtonSet('', ['Preview','Group','Cancel'], 0);

// ── Dialog loop ───────────────────────────────────────────────────────────────

let lastPresetIdx = -1;
let lastSourceIdx = -1;
let sourceGroups = null;

function rebuildItems(usePen) {
  return sourceGroupsRaw.map(sg => ({
    sourceGroup: sg.sourceGroup,
    items: sg.nodes.map(n => ({node:n, hsl:getColorHsl(n, usePen), area:getArea(n)}))
  }));
}

while (true) {
  const res = dlg.runModal();
  if (!res || res.value === DialogResult.Cancel.value) break;

  const sourceIdx = cmbSource.selectedIndex;
  if (sourceIdx !== lastSourceIdx || !sourceGroups) {
    lastSourceIdx = sourceIdx;
    sourceGroups = rebuildItems(sourceIdx === 1);
  }

  const presetIdx = btnPreset.selectedIndex;
  if (presetIdx !== lastPresetIdx) {
    lastPresetIdx = presetIdx;
    const allFlat = sourceGroups.reduce((a,g)=>[...a,...g.items],[]);
    const autoTol = suggestTolerance(allFlat);
    const v = [5,15,35,autoTol][presetIdx];
    if (cmb.selectedIndex===4) { edTH.value=v; edTS.value=v; edTL.value=v; }
    else edT.value=v;
    continue;
  }

  const action = btnAct.selectedIndex;
  if (action===2) break;

  const mode    = cmb.selectedIndex;
  const tol     = edT.value;
  const tolH    = edTH.value, tolS=edTS.value, tolL=edTL.value;
  const sortAsc = cmbSort.selectedIndex===0;
  const posMode = cmbPos.selectedIndex;
  const minArea = edMinArea.value;
  const useGray = chkGray.value;
  const grayThr = edGray.value;
  const useName = chkName.value;

  const allResults = sourceGroups.map(sg=>({
    sourceGroup: sg.sourceGroup,
    groups: calcGroups(sg.items, mode, tol, tolH, tolS, tolL, sortAsc, minArea, grayThr, useGray)
  }));

  if (posMode>0) {
    for (const r of allResults)
      for (const grp of r.groups)
        grp.items.sort((a,b)=>{
          try {
            const ba=a.node.spreadVisibleBox, bb=b.node.spreadVisibleBox;
            if(!ba||!bb) return 0;
            return posMode===1 ? ba.x-bb.x : ba.y-bb.y;
          } catch(e){ return 0; }
        });
  }

  if (action===0) {
    const modeNames=['HSL overall','Hue H','Saturation S','Lightness L','H+S+L separate'];
    const sortLabel=sortAsc?'Small→Large':'Large→Small';
    const srcLabel = sourceIdx===1 ? 'Stroke' : 'Fill';
    const totalGroups=allResults.reduce((s,r)=>s+r.groups.length,0);
    const totalUsed=allResults.reduce((s,r)=>r.groups.reduce((ss,g)=>ss+g.items.length,0)+s,0);
    const skipped=totalItems-totalUsed;
    const allGrps=allResults.flatMap(r=>r.groups);
    const hist={1:0,'2-5':0,'6-20':0,'21-100':0,'>100':0};
    for (const g of allGrps) {
      const n=g.items.length;
      if(n===1) hist[1]++; else if(n<=5) hist['2-5']++; else if(n<=20) hist['6-20']++; else if(n<=100) hist['21-100']++; else hist['>100']++;
    }
    let txt='Colour source: '+srcLabel+'\n';
    txt+='Mode: '+modeNames[mode]+'  ('+sortLabel+')\n';
    txt+=(mode===4?'Tol H:'+tolH+' S:'+tolS+' L:'+tolL:'Tolerance: '+tol)+'\n';
    txt+='Min. area: '+minArea+(useGray?' | Grey <S'+grayThr+'%':'')+'\n\n';
    txt+=totalItems+' objects → '+totalGroups+' groups';
    if(skipped>0) txt+=' ('+skipped+' skipped)';
    txt+='\n\nDistribution:\n';
    txt+='  Single objects:  '+hist[1]+'\n  2-5 obj.:       '+hist['2-5']+'\n  6-20 obj.:      '+hist['6-20']+'\n  21-100 obj.:    '+hist['21-100']+'\n  >100 obj.:      '+hist['>100'];
    if(allResults.length>1) {
      txt+='\n\nPer source:\n';
      allResults.forEach((r,i)=>{
        const nm=r.sourceGroup?(r.sourceGroup.userDescription||'Group '+(i+1)):'Direct selection';
        txt+='  '+nm+': '+sourceGroups[i].items.length+' → '+r.groups.length+'\n';
      });
    }
    app.alert(txt,'Preview');
    continue;
  }

  // ── Group ─────────────────────────────────────────────────────────────────
  let createdTotal = 0;

  for (const result of allResults) {
    const { sourceGroup, groups } = result;
    if (!groups.length) continue;

    const groupNodes = [];
    for (let gi=0; gi<groups.length; gi++) {
      const g = groups[gi];
      const name = g.isGray ? 'Grey/Neutral' :
        (g.noColor ? 'No solid colour' : groupLabel(gi, g.c, useName));
      const prefixed = sourceGroup && sourceGroup.userDescription
        ? sourceGroup.userDescription+' – '+name : name;
      const def = ContainerNodeDefinition.create(prefixed);
      const bldr = AddChildNodesCommandBuilder.create();
      bldr.addContainerNode(def);
      const cmd = bldr.createCommand(false);
      doc.executeCommand(cmd);
      groupNodes.push(cmd.newNodes[0]);
    }

    const cb2 = CompoundCommandBuilder.create();
    for (let gi=0; gi<groupNodes.length; gi++) {
      const ng = groupNodes[gi];
      if (!ng) continue;
      const nodes = groups[gi].items.map(x=>x.node);
      cb2.addCommand(DocumentCommand.createMoveNodes(
        Selection.create(doc, nodes), ng, NodeMoveType.Inside, NodeChildType.Main
      ));
    }
    doc.executeCommand(cb2.createCommand(false));

    if (sourceGroup) {
      const validNodes = groupNodes.filter(Boolean);
      if (validNodes.length>0) {
        doc.executeCommand(DocumentCommand.createMoveNodes(
          Selection.create(doc, validNodes), sourceGroup, NodeMoveType.Inside, NodeChildType.Main
        ));
      }
    }

    createdTotal += groups.length;
  }

  app.alert(createdTotal+' colour group(s) created in '+allResults.length+' source(s).','Sort by Colour');
  break;
}
