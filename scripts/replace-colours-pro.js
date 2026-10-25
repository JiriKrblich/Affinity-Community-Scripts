
'use strict';
// ═══════════════════════════════════════════════════════════════════════════════
// Replace Colours PRO (v23) — English version of "Farben ersetzen PRO v23"
//
// Changes vs. v22:
//  - Robust rollback: doc.history.position = … can fail with COMMAND_FAILED when the start
//    position is 0 (a document without any history yet, e.g. just opened). v23 falls back
//    to stepping back with history.undo() until the start position is reached, and logs a
//    warning if it cannot be reached.
// From v22 (cause of "hatch / gradient is not reset"):
//  Affinity's undo history is limited in depth (measured: roughly 1070-1080 steps). v19-v21
//  wrote every fill as its own history step; in large documents the OLDEST preview steps
//  (gradients, hatches) dropped out of the history and stayed changed. v22+ batches all
//  fill / stroke / text changes into ONE CompoundCommand (= one history step), processes
//  every object only once, and verifies/heals hatches AND gradients after every rollback
//  against a snapshot taken when the dialog opens.
// Bitmaps are still written as separate steps (few, large objects).
// Unchanged: selection snapshot (restored only if changed), OK applies fresh, Lab ΔE
// matching, presets, mapping export.
// ═══════════════════════════════════════════════════════════════════════════════

const { Document }                            = require('/document');
const { Dialog, DialogResult }                = require('/dialog');
const { RGBA8, Colour, Gradient }             = require('/colours');
const { SolidFill, FillDescriptor, FillType, GradientFill, HatchFill } = require('/fills');
const { Selection }                           = require('/selections');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands');
const { StoryDelta }                          = require('/storydelta');
const { File, FileSystemApi }                 = require('/fs');
const { app }                                 = require('/application');

// ─── Byte/string helper ────────────────────────────────────────────────────────
function bufferToStr(buf){const arr=new Uint8Array(buf);let s='';for(let i=0;i<arr.length;i++)s+=String.fromCharCode(arr[i]);return s;}

// ─── HSL ──────────────────────────────────────────────────────────────────────
function rgba8ToHsl(r,g,b){
    r/=255;g/=255;b/=255;
    const max=Math.max(r,g,b),min=Math.min(r,g,b);
    let h=0,s=0;const l=(max+min)/2;
    if(max!==min){const d=max-min;s=l>0.5?d/(2-max-min):d/(max+min);
        switch(max){case r:h=((g-b)/d+(g<b?6:0))/6;break;case g:h=((b-r)/d+2)/6;break;case b:h=((r-g)/d+4)/6;break;}}
    return{h,s,l};
}
function hslToRgb8(h,s,l){
    let r,g,b;
    if(s===0){r=g=b=l;}else{
        const q=l<0.5?l*(1+s):l+s-l*s,p=2*l-q;
        const H=(p,q,t)=>{if(t<0)t+=1;if(t>1)t-=1;if(t<1/6)return p+(q-p)*6*t;if(t<1/2)return q;if(t<2/3)return p+(q-p)*(2/3-t)*6;return p;};
        r=H(p,q,h+1/3);g=H(p,q,h);b=H(p,q,h-1/3);}
    return{r:Math.round(Math.min(255,Math.max(0,r*255))),g:Math.round(Math.min(255,Math.max(0,g*255))),b:Math.round(Math.min(255,Math.max(0,b*255)))};
}
function clamp01(v){return Math.max(0,Math.min(1,v));}

// ─── Lab / Delta-E ────────────────────────────────────────────────────────────
function rgbToLab(r,g,b){
    const lin=v=>{v/=255;return v<=0.04045?v/12.92:Math.pow((v+0.055)/1.055,2.4);};
    const rl=lin(r),gl=lin(g),bl=lin(b);
    const X=(rl*0.4124+gl*0.3576+bl*0.1805)/0.9505;
    const Y=(rl*0.2126+gl*0.7152+bl*0.0722);
    const Z=(rl*0.0193+gl*0.1192+bl*0.9505)/1.0890;
    const f=t=>t>0.008856?Math.cbrt(t):(7.787*t+16/116);
    const fx=f(X),fy=f(Y),fz=f(Z);
    return{L:116*fy-16,a:500*(fx-fy),b:200*(fy-fz)};
}
function deltaELab(r1,g1,b1,lab2,hueWeight){
    const l1=rgbToLab(r1,g1,b1);
    const dL=l1.L-lab2.L,da=l1.a-lab2.a,db=l1.b-lab2.b;
    if(!hueWeight||hueWeight<=1) return Math.sqrt(dL*dL+da*da+db*db);
    return Math.sqrt(dL*dL + hueWeight*(da*da+db*db));
}
function labToRgb8(L,a,b){
    let y2=(L+16)/116,x2=a/500+y2,z=y2-b/200;
    x2=x2>0.2069?x2*x2*x2:(x2-16/116)/7.787;
    y2=y2>0.2069?y2*y2*y2:(y2-16/116)/7.787;
    z =z >0.2069?z*z*z   :(z -16/116)/7.787;
    x2*=0.9505;z*=1.0890;
    const gc=v=>v<=0.0031308?12.92*v:1.055*Math.pow(Math.max(0,v),1/2.4)-0.055;
    return{r:Math.round(Math.min(1,Math.max(0,gc( 3.2406*x2-1.5372*y2-0.4986*z)))*255),
           g:Math.round(Math.min(1,Math.max(0,gc(-0.9689*x2+1.8758*y2+0.0415*z)))*255),
           b:Math.round(Math.min(1,Math.max(0,gc( 0.0557*x2-0.2040*y2+1.0570*z)))*255)};
}

// ─── .afpalette parser ────────────────────────────────────────────────────────
function parseAfpalette(arrayBuffer){
    const arr=new Uint8Array(arrayBuffer);const dv=new DataView(arrayBuffer);
    function findStr(needle){
        const nb=[];for(let i=0;i<needle.length;i++)nb.push(needle.charCodeAt(i));
        const pos=[];
        outer:for(let i=0;i<arr.length-nb.length;i++){for(let j=0;j<nb.length;j++)if(arr[i+j]!==nb[j])continue outer;pos.push(i);}
        return pos;
    }
    let paletteName='Afpalette';
    const nclp=findStr('NClP');
    if(nclp.length){const np=nclp[0]+4;const nameLen=dv.getUint32(np,true);let name='';
        for(let i=0;i<nameLen;i++){const c=arr[np+4+i];if(c===0)break;name+=String.fromCharCode(c);}if(name)paletteName=name;}
    const colours=[];
    for(const hp of findStr('Hloc_')){if(hp+21>arr.length)continue;
        const C=dv.getFloat32(hp+5,true),M=dv.getFloat32(hp+9,true),Y=dv.getFloat32(hp+13,true),K=dv.getFloat32(hp+17,true);
        if(C<0||C>1||M<0||M>1||Y<0||Y>1||K<0||K>1)continue;
        colours.push({r:Math.round((1-C)*(1-K)*255),g:Math.round((1-M)*(1-K)*255),b:Math.round((1-Y)*(1-K)*255)});}
    for(const lp of findStr('<loc_')){if(lp+11>arr.length)continue;
        const u1=dv.getUint16(lp+5,true),u2=dv.getUint16(lp+7,true),u3=dv.getUint16(lp+9,true);
        colours.push(labToRgb8(u1/65535*100,(u2-32768)/32768*128,(u3-32768)/32768*128));}
    const hasHSL=findStr('ALSH').length>0;
    for(const dp of findStr('Dloc_')){if(dp+17>arr.length)continue;
        const f1=dv.getFloat32(dp+5,true),f2=dv.getFloat32(dp+9,true),f3=dv.getFloat32(dp+13,true);
        if(f1<0||f1>1||f2<0||f2>1||f3<0||f3>1)continue;
        colours.push(hasHSL?hslToRgb8(f1,f2,f3):{r:Math.round(f1*255),g:Math.round(f2*255),b:Math.round(f3*255)});}
    return colours.length?{paletteName,colours}:null;
}

function loadPaletteFromFile(){
    const path=app.chooseFile();if(!path)return null;
    if(!path.toLowerCase().endsWith('.afpalette')){app.alert('Please choose an .afpalette file.','Replace Colours');return null;}
    try{const result=parseAfpalette(new Uint8Array(File.readAll(path).buffer).buffer);
        if(!result||!result.colours.length){app.alert('No colours found.\nSupported colour spaces: CMYK, Lab, HSL, RGB.','Replace Colours');return null;}
        return result;}
    catch(e){app.alert('Error while loading:\n'+e.message,'Replace Colours');return null;}
}

// ─── Preset system ─────────────────────────────────────────────────────────────
const PRESET_DIR_NAME='AffinityScriptPresets';
const PRESET_FILE_NAME='ReplaceColours_settings.json';
function getPresetPath(){return app.userDesktopPath+'\\'+PRESET_DIR_NAME+'\\'+PRESET_FILE_NAME;}
function savePreset(settings){
    try{
        FileSystemApi.createDirectories(app.userDesktopPath+'\\'+PRESET_DIR_NAME);
        const f=new File(getPresetPath(),'wb');
        f.writeStringAsUtf8(JSON.stringify(settings));
        f.close();return true;
    }catch(e){console.log('savePreset error: '+e);return false;}
}
function loadPreset(){
    try{const buf=File.readAll(getPresetPath());return JSON.parse(bufferToStr(buf.buffer));}catch(e){return null;}
}
function exportMapping(mappingLines){
    try{
        FileSystemApi.createDirectories(app.userDesktopPath+'\\'+PRESET_DIR_NAME);
        const path=app.userDesktopPath+'\\'+PRESET_DIR_NAME+'\\ReplaceColours_mapping_'+Date.now()+'.json';
        const f=new File(path,'wb');
        f.writeStringAsUtf8(JSON.stringify(mappingLines,null,2));
        f.close();return path;
    }catch(e){console.log('exportMapping error: '+e);return null;}
}

// ─── Built-in palettes ────────────────────────────────────────────────────────
const BUILTIN={
    'Greyscale':       [{r:0,g:0,b:0},{r:32,g:32,b:32},{r:64,g:64,b:64},{r:96,g:96,b:96},{r:128,g:128,b:128},{r:160,g:160,b:160},{r:192,g:192,b:192},{r:224,g:224,b:224},{r:255,g:255,b:255}],
    'Primary colours': [{r:255,g:0,b:0},{r:0,g:255,b:0},{r:0,g:0,b:255},{r:255,g:255,b:0},{r:0,g:255,b:255},{r:255,g:0,b:255},{r:255,g:128,b:0},{r:0,g:0,b:0},{r:255,g:255,b:255}],
    'Pastels':         [{r:255,g:179,b:186},{r:255,g:223,b:186},{r:255,g:255,b:186},{r:186,g:255,b:201},{r:186,g:225,b:255},{r:186,g:186,b:255},{r:255,g:186,b:255},{r:255,g:255,b:255},{r:200,g:200,b:200}],
    'Earth tones':     [{r:101,g:67,b:33},{r:139,g:90,b:43},{r:160,g:120,b:60},{r:188,g:143,b:80},{r:205,g:170,b:120},{r:222,g:196,b:155},{r:240,g:220,b:190},{r:80,g:50,b:20},{r:60,g:30,b:10}],
    'Neon colours':    [{r:255,g:0,b:100},{r:255,g:50,b:0},{r:200,g:255,b:0},{r:0,g:255,b:100},{r:0,g:200,b:255},{r:100,g:0,b:255},{r:255,g:0,b:200},{r:255,g:200,b:0},{r:0,g:255,b:255}],
};

// ─── Expanded target palette ──────────────────────────────────────────────────
function expandPalette(palette,useLV,lStep,useSV,sStep){
    const targets=[];const ls=lStep/100,ss=sStep/100;
    for(const base of palette){
        const{h,s,l}=rgba8ToHsl(base.r,base.g,base.b);
        let lVals=[l];
        if(useLV&&ls>0){lVals=[];const start=((l%ls)+ls)%ls;let v=start<1e-9?0:start;while(v<=1+1e-9){lVals.push(clamp01(Math.round(v*1000)/1000));v+=ls;}if(!lVals.length)lVals=[l];}
        let sVals=[s];
        if(useSV&&ss>0){sVals=[];const start=((s%ss)+ss)%ss;let v=start<1e-9?0:start;while(v<=1+1e-9){sVals.push(clamp01(Math.round(v*1000)/1000));v+=ss;}if(!sVals.length)sVals=[s];}
        for(const lv of lVals)for(const sv of sVals){
            const c=hslToRgb8(h,sv,lv);
            targets.push({r:c.r,g:c.g,b:c.b,lab:rgbToLab(c.r,c.g,c.b)});
        }
    }
    return targets;
}

// ─── Colour matching with cache ───────────────────────────────────────────────
function makeMatcher(targets, hueWeight){
    const cache=new Map();
    function raw(r,g,b,tol){
        if(tol===-1){for(const t of targets) if(t.r===r&&t.g===g&&t.b===b) return t;return null;}
        const bestMatch=tol>=255;let bestDist=Infinity,best=null;
        for(const t of targets){
            if(!bestMatch&&(Math.abs(t.r-r)>tol||Math.abs(t.g-g)>tol||Math.abs(t.b-b)>tol))continue;
            const dist=deltaELab(r,g,b,t.lab,hueWeight);
            if(dist<bestDist){bestDist=dist;best=t;}
        }
        return best?{...best,_dist:bestDist}:null;
    }
    return function findTarget(r,g,b,tol){
        const key=r+','+g+','+b+'|'+tol;
        if(cache.has(key))return cache.get(key);
        const res=raw(r,g,b,tol);cache.set(key,res);return res;
    };
}

// ─── Collect leaf nodes (every object exactly ONCE) ───────────────────────────
function collectLeafNodes(node,out){
    if(node.isGroupNode){try{for(const ch of node.children)collectLeafNodes(ch,out);}catch(e){}return;}
    out.push(node);
}
// Removes selected nodes that already have a selected ancestor.
function dropNodesWithSelectedAncestor(nodes){
    return nodes.filter(n=>{
        let p;try{p=n.parent;}catch(e){p=null;}
        let d=0;
        while(p&&d<128){
            for(const o of nodes){try{if(o!==n&&p.isSameNode(o))return false;}catch(e){}}
            try{p=p.parent;}catch(e){p=null;}
            d++;
        }
        return true;
    });
}
function collectTargetNodes(doc,scope,selNodes){
    if(scope==='all'){
        // doc.layers.all already contains ALL descendants (incl. group children) → non-groups only.
        return Array.from(doc.layers.all).filter(n=>!n.isGroupNode);
    }
    let top;
    if(scope==='activeLayer'){const l=Array.from(doc.layers.all);top=l.length?[l[0]]:[];}
    else top=dropNodesWithSelectedAncestor([...selNodes]);
    const out=[];for(const n of top)collectLeafNodes(n,out);
    return out;
}

// ─── Text detection (double-checked) ──────────────────────────────────────────
function isTextNode(node){
    if(node.isArtTextNode)return true;
    try{
        const tag=Object.prototype.toString.call(node);
        return tag==='[object ArtTextNode]'||tag==='[object FrameTextNode]';
    }catch(e){return false;}
}

// ─── Selection helpers ────────────────────────────────────────────────────────
function snapshotSelectionNodes(doc){
    try{return doc.selection.nodes.toArray();}catch(e){return [];}
}
function makeSel(doc,nodes){
    return nodes.length?Selection.create(doc,nodes):Selection.createEmpty(doc);
}
function selectionMatches(doc,nodes){
    let cur=[];
    try{cur=doc.selection.nodes.toArray();}catch(e){return false;}
    if(cur.length!==nodes.length)return false;
    for(const n of nodes){
        let found=false;
        for(const c of cur){try{if(c.isSameNode(n)){found=true;break;}}catch(e){}}
        if(!found)return false;
    }
    return true;
}
function restoreSelectionIfChanged(doc,nodes){
    if(selectionMatches(doc,nodes))return;
    try{doc.selection=makeSel(doc,nodes);}catch(e){}
}
function leafCountOf(nodes){
    const out=[];for(const n of nodes)collectLeafNodes(n,out);return out.length;
}

// ─── Robust history rollback (v23) ────────────────────────────────────────────
// 1) jump via doc.history.position; 2) if that throws (e.g. COMMAND_FAILED when the start
// position is 0 — a document without history) or does not reach the target, step back with
// history.undo(); 3) warn if the target still is not reached.
function rollbackToPosition(doc,pos){
    try{
        if(doc.history.position!==pos)doc.history.position=pos;
    }catch(e){
        console.log('History jump failed ('+e.message+') – falling back to step-wise undo.');
    }
    let guard=0;
    while(doc.history.position>pos&&doc.history.canUndo&&guard<10000){
        try{doc.history.undo();}catch(e){console.log('Undo error: '+e.message);break;}
        guard++;
    }
    if(doc.history.position!==pos){
        console.log('Warning: history rollback incomplete (position '+doc.history.position+' instead of '+pos+'; history depth exceeded?).');
    }
}

// ─── Hatch and gradient snapshot and self-healing ─────────────────────────────
function rgbaObj(c){return c?{r:c.r,g:c.g,b:c.b,alpha:c.alpha}:null;}
function sameRgba(a,b){
    if(!a&&!b)return true;
    if(!a||!b)return false;
    return a.r===b.r&&a.g===b.g&&a.b===b.b&&a.alpha===b.alpha;
}
function snapshotFills(doc){
    const hatch=[],gradient=[];
    for(const l of doc.layers.all){
        try{
            const fd=l.brushFillDescriptor;
            const f=fd&&fd.fill;
            if(!f||!f.fillType)continue;
            const ft=f.fillType.value;
            if(ft===FillType.Hatch.value){
                hatch.push({node:l,
                            pen:f.penColour?rgbaObj(f.penColour.rgba8):null,
                            brush:f.brushColour?rgbaObj(f.brushColour.rgba8):null});
            }else if(ft===FillType.Gradient.value){
                gradient.push({node:l,
                               stops:f.gradient.stops.map(s=>({position:s.position,midpoint:s.midpoint,smoothness:s.smoothness,
                                                               colour:rgbaObj(new Colour(s.colour).rgba8)}))});
            }
        }catch(e){}
    }
    return{hatch,gradient};
}
function verifyFills(doc,snap){
    let fixedH=0,fixedG=0;
    for(const s of snap.hatch){
        try{
            const fd=s.node.brushFillDescriptor;
            const f=fd&&fd.fill;
            if(!f||!f.fillType||f.fillType.value!==FillType.Hatch.value)continue;
            const curPen=f.penColour?rgbaObj(f.penColour.rgba8):null;
            const curBrush=f.brushColour?rgbaObj(f.brushColour.rgba8):null;
            if(sameRgba(curPen,s.pen)&&sameRgba(curBrush,s.brush))continue;
            const nf=f.clone();
            nf.penColour=s.pen?RGBA8(s.pen.r,s.pen.g,s.pen.b,s.pen.alpha):null;
            nf.brushColour=s.brush?RGBA8(s.brush.r,s.brush.g,s.brush.b,s.brush.alpha):null;
            doc.setBrushFillDescriptor(FillDescriptor.create(nf,fd.isScaleWithObject,fd.transform,fd.blendMode,fd.isAnchoredToSpread),Selection.create(doc,[s.node]),null,false);
            fixedH++;
        }catch(e){console.log('Hatch check: '+e);}
    }
    for(const s of snap.gradient){
        try{
            const fd=s.node.brushFillDescriptor;
            const f=fd&&fd.fill;
            if(!f||!f.fillType||f.fillType.value!==FillType.Gradient.value)continue;
            const cur=f.gradient.stops;
            let same=cur.length===s.stops.length;
            if(same){
                for(let i=0;i<cur.length;i++){
                    if(!sameRgba(rgbaObj(new Colour(cur[i].colour).rgba8),s.stops[i].colour)||Math.abs(cur[i].position-s.stops[i].position)>1e-6){same=false;break;}
                }
            }
            if(same)continue;
            const stops=s.stops.map(x=>({position:x.position,midpoint:x.midpoint,smoothness:x.smoothness,
                                          colour:RGBA8(x.colour.r,x.colour.g,x.colour.b,x.colour.alpha)}));
            const nf=f.cloneWithNewGradient(Gradient.create(stops));
            doc.setBrushFillDescriptor(FillDescriptor.create(nf,fd.isScaleWithObject,fd.transform,fd.blendMode,fd.isAnchoredToSpread),Selection.create(doc,[s.node]),null,false);
            fixedG++;
        }catch(e){console.log('Gradient check: '+e);}
    }
    if(fixedH+fixedG>0)console.log('Self-heal: '+fixedH+' hatch fill(s) and '+fixedG+' gradient(s) restored manually to the original colours (the history rollback had not captured them).');
    return fixedH+fixedG;
}

// ─── Replace bitmap (own history steps; few, large objects) ───────────────────
function replaceRaster(doc,node,findTarget,tol,mappingLog){
    try{
        const ri=node.rasterInterface;if(!ri)return 0;
        const w=ri.width,h=ri.height;if(w<=0||h<=0)return 0;
        const buf=ri.createCompatibleBuffer(true);const fmt=ri.format?ri.format.value:0;let cnt=0;
        if(fmt===0){const a=new Uint8Array(buf.buffer);for(let i=0;i<a.length;i+=4){if(a[i+3]===0)continue;const t=findTarget(a[i],a[i+1],a[i+2],tol);if(t){a[i]=t.r;a[i+1]=t.g;a[i+2]=t.b;cnt++;}}}
        else if(fmt===1){const a=new Uint16Array(buf.buffer);for(let i=0;i<a.length;i+=4){if(a[i+3]===0)continue;const t=findTarget(Math.round(a[i]/257),Math.round(a[i+1]/257),Math.round(a[i+2]/257),tol);if(t){a[i]=t.r*257;a[i+1]=t.g*257;a[i+2]=t.b*257;cnt++;}}}
        else if(fmt===9){const a=new Float32Array(buf.buffer);for(let i=0;i<a.length;i+=4){if(a[i+3]===0)continue;const t=findTarget(Math.round(Math.min(1,Math.max(0,a[i]))*255),Math.round(Math.min(1,Math.max(0,a[i+1]))*255),Math.round(Math.min(1,Math.max(0,a[i+2]))*255),tol);if(t){a[i]=t.r/255;a[i+1]=t.g/255;a[i+2]=t.b/255;cnt++;}}}
        if(cnt>0){const bm=ri.createCompatibleBitmap(false);buf.copyTo(bm,{x:0,y:0,width:w,height:h},0,0);
            doc.executeCommand(DocumentCommand.createReplaceBitmap(Selection.create(doc,[node]),bm),false);
            if(mappingLog)mappingLog.push({type:'bitmap',node:node.defaultDescription,pixelsChanged:cnt});}
        return cnt>0?1:0;
    }catch(e){console.log('raster:'+e);return 0;}
}

// ─── Batch building blocks: add commands to ONE CompoundCommandBuilder ────────
const rgbTxt=(c)=>'RGB('+c.r+','+c.g+','+c.b+')';

function addSolidFillCommand(builder,doc,node,findTarget,tol,mappingLog){
    try{
        const fd=node.brushFillDescriptor;if(!fd)return 0;const f=fd.fill;
        if(!f||!f.fillType||f.fillType.value!==FillType.Solid.value||!f.colour)return 0;
        const c=f.colour.rgba8;
        const t=findTarget(c.r,c.g,c.b,tol);if(!t)return 0;
        builder.addCommand(DocumentCommand.createSetBrushFill(Selection.create(doc,[node]),
            FillDescriptor.createSolid(SolidFill.create(RGBA8(t.r,t.g,t.b,c.alpha!=null?c.alpha:255)))));
        if(mappingLog)mappingLog.push({type:'fill',node:node.defaultDescription,from:rgbTxt(c),to:rgbTxt(t),
            deltaE:t._dist!=null?t._dist.toFixed(2):'exact'});
        return 1;
    }catch(e){console.log('solid:'+e);return 0;}
}

function addStrokeCommand(builder,doc,node,findTarget,tol,mappingLog){
    try{
        const pd=node.penFillDescriptor;if(!pd)return 0;const f=pd.fill;
        if(!f||!f.fillType||f.fillType.value!==FillType.Solid.value||!f.colour)return 0;
        const c=f.colour.rgba8;
        const t=findTarget(c.r,c.g,c.b,tol);if(!t)return 0;
        builder.addCommand(DocumentCommand.createSetPenFill(Selection.create(doc,[node]),
            FillDescriptor.createSolid(SolidFill.create(RGBA8(t.r,t.g,t.b,c.alpha!=null?c.alpha:255)))));
        if(mappingLog)mappingLog.push({type:'stroke',node:node.defaultDescription,from:rgbTxt(c),to:rgbTxt(t)});
        return 1;
    }catch(e){console.log('stroke:'+e);return 0;}
}

function addGradientCommand(builder,doc,node,findTarget,tol,mappingLog){
    try{
        const fd=node.brushFillDescriptor;if(!fd)return 0;const f=fd.fill;
        if(!f||!f.fillType||f.fillType.value!==FillType.Gradient.value)return 0;
        let changed=false;
        const newStops=f.gradient.stops.map(s=>{
            const rgba=new Colour(s.colour).rgba8;
            const t=findTarget(rgba.r,rgba.g,rgba.b,tol);
            if(t){
                changed=true;
                if(mappingLog)mappingLog.push({type:'gradient-stop',node:node.defaultDescription,from:rgbTxt(rgba),to:rgbTxt(t)});
                return{position:s.position,midpoint:s.midpoint,smoothness:s.smoothness,colour:RGBA8(t.r,t.g,t.b,rgba.alpha)};
            }
            return{position:s.position,midpoint:s.midpoint,smoothness:s.smoothness,colour:RGBA8(rgba.r,rgba.g,rgba.b,rgba.alpha)};
        });
        if(!changed)return 0;
        const nf=f.cloneWithNewGradient(Gradient.create(newStops));
        builder.addCommand(DocumentCommand.createSetBrushFill(Selection.create(doc,[node]),
            FillDescriptor.create(nf,fd.isScaleWithObject,fd.transform,fd.blendMode,fd.isAnchoredToSpread)));
        return 1;
    }catch(e){console.log('gradient:'+e);return 0;}
}

function addHatchCommand(builder,doc,node,findTarget,tol,mappingLog){
    try{
        const fd=node.brushFillDescriptor;if(!fd)return 0;const f=fd.fill;
        if(!f||!f.fillType||f.fillType.value!==FillType.Hatch.value)return 0;
        const nf=f.clone();                 // edit the clone, the original fill stays untouched
        let changed=false;
        if(f.penColour){
            const rgba=f.penColour.rgba8;
            const t=findTarget(rgba.r,rgba.g,rgba.b,tol);
            if(t){nf.penColour=RGBA8(t.r,t.g,t.b,rgba.alpha);changed=true;
                if(mappingLog)mappingLog.push({type:'hatch-pen',node:node.defaultDescription,from:rgbTxt(rgba),to:rgbTxt(t)});}
        }
        if(f.brushColour){
            const rgba=f.brushColour.rgba8;
            const t=findTarget(rgba.r,rgba.g,rgba.b,tol);
            if(t){nf.brushColour=RGBA8(t.r,t.g,t.b,rgba.alpha);changed=true;
                if(mappingLog)mappingLog.push({type:'hatch-brush',node:node.defaultDescription,from:rgbTxt(rgba),to:rgbTxt(t)});}
        }
        if(!changed)return 0;
        builder.addCommand(DocumentCommand.createSetBrushFill(Selection.create(doc,[node]),
            FillDescriptor.create(nf,fd.isScaleWithObject,fd.transform,fd.blendMode,fd.isAnchoredToSpread)));
        return 1;
    }catch(e){console.log('hatch:'+e);return 0;}
}

// Text: fill AND stroke (glyph attributes of the first character), via createFormatText
// in the same compound. Only single-colour text per object is reliably supported.
function addTextCommands(builder,node,findTarget,tol,mappingLog){
    let n=0;
    try{
        const story=node.story;
        if(!story||story.length===0)return 0;
        const atts=story.getGlyphAtts(0);
        const bf=atts.brushFill;
        if(bf&&bf.fill&&bf.fill.fillType&&bf.fill.fillType.value===FillType.Solid.value){
            const rgba=bf.fill.colour.rgba8;
            const t=findTarget(rgba.r,rgba.g,rgba.b,tol);
            if(t){
                const nfd=FillDescriptor.createSolid(SolidFill.create(RGBA8(t.r,t.g,t.b,rgba.alpha!=null?rgba.alpha:255)));
                builder.addCommand(DocumentCommand.createFormatText(node.selfSelection,StoryDelta.createBrushFill(nfd)));
                n++;
                if(mappingLog)mappingLog.push({type:'text-fill',node:node.defaultDescription,from:rgbTxt(rgba),to:rgbTxt(t)});
            }
        }
        const pf=atts.penFill;
        if(pf&&pf.fill&&pf.fill.fillType&&pf.fill.fillType.value===FillType.Solid.value){
            const rgba=pf.fill.colour.rgba8;
            const t=findTarget(rgba.r,rgba.g,rgba.b,tol);
            if(t){
                const nfd=FillDescriptor.createSolid(SolidFill.create(RGBA8(t.r,t.g,t.b,rgba.alpha!=null?rgba.alpha:255)));
                builder.addCommand(DocumentCommand.createFormatText(node.selfSelection,StoryDelta.createPenFill(nfd)));
                n++;
                if(mappingLog)mappingLog.push({type:'text-stroke',node:node.defaultDescription,from:rgbTxt(rgba),to:rgbTxt(t)});
            }
        }
    }catch(e){console.log('text:'+e);}
    return n;
}

// ─── Replace everything ───────────────────────────────────────────────────────
// Bitmaps as separate steps; ALL other changes in ONE compound command
// (= one history step, regardless of the number of objects).
function doReplace(doc,palette,useLV,lStep,useSV,sStep,tol,scope,selNodes,hueWeight,
                    includeStroke,includeGradient,includeHatch,includeText,mappingLog){
    if(!palette||!palette.length)return{count:0};
    const targets=expandPalette(palette,useLV,lStep,useSV,sStep);
    const findTarget=makeMatcher(targets,hueWeight);

    const nodes=collectTargetNodes(doc,scope,selNodes);
    let count=0;

    // Phase 1: bitmap (own steps)
    for(const n of nodes){if(n.rasterInterface){count+=replaceRaster(doc,n,findTarget,tol,mappingLog);}}

    // Phase 2: everything else batched
    const builder=CompoundCommandBuilder.create();
    let batched=0;
    for(const n of nodes){
        if(isTextNode(n)){
            if(includeText)batched+=addTextCommands(builder,n,findTarget,tol,mappingLog);
            continue;
        }
        if(includeGradient)batched+=addGradientCommand(builder,doc,n,findTarget,tol,mappingLog);
        if(includeHatch)batched+=addHatchCommand(builder,doc,n,findTarget,tol,mappingLog);
        batched+=addSolidFillCommand(builder,doc,n,findTarget,tol,mappingLog);
        if(includeStroke)batched+=addStrokeCommand(builder,doc,n,findTarget,tol,mappingLog);
    }
    if(batched>0){
        doc.executeCommand(builder.createCommand());
        count+=batched;
    }
    return{count};
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════
(function main(){
    const doc=Document.current;
    if(!doc){app.alert('No document open.','Replace Colours');return;}

    const initialPalette=loadPaletteFromFile();
    if(!initialPalette)return;

    let loadedPalette=initialPalette;
    let updateGuard=false;
    let lastMappingLog=[];

    const preset=loadPreset();

    // Save selection, history start position and hatch/gradient start colours ONCE —
    // before the dialog and before any edit.
    const selNodes=snapshotSelectionNodes(doc);
    const posBeforePreview=doc.history.position;
    const fillSnap=snapshotFills(doc);

    const builtinNames=Object.keys(BUILTIN);
    const IDX_AFP=builtinNames.length,IDX_HEX=builtinNames.length+1,IDX_LOAD=builtinNames.length+2;
    const comboItems=[...builtinNames,loadedPalette.paletteName,'Custom colours (hex)','Load another palette…'];

    const dlg=Dialog.create('Replace Colours PRO');
    dlg.initialWidth=620;dlg.setIsResizable(true);
    const c1=dlg.addColumn(),c2=dlg.addColumn();

    const gPal=c1.addGroup('Target palette');
    const cboPal=gPal.addComboBox('Palette:',comboItems,IDX_AFP);cboPal.isFullWidth=true;

    const gInfo=c1.addGroup('Swatch info');
    const txInfo=gInfo.addStaticText('','"'+loadedPalette.paletteName+'"  ·  '+loadedPalette.colours.length+' colours');

    const gHex=c1.addGroup('Custom colours (hex, comma-separated)');
    const tbHex=gHex.addTextBox('Values:','#FF0000, #00FF00, #0000FF');tbHex.isEnabled=false;

    const gTol=c1.addGroup('Colour tolerance');
    const cboTolMode=gTol.addComboBox('Mode:',['Exact match only','Tolerance range (0–254)','Best match (always replace)'],preset?.tolMode??2);
    const edTol=gTol.addUnitValueEditor('Tolerance (in "Tolerance range" mode):','px','px',0,0,254);
    edTol.value=preset?.tolerance??20;

    const gHue=c1.addGroup('Matching accuracy');
    const cbHue=gHue.addCheckBox('Weight hue more strongly',preset?.hueWeight>1);
    const edHue=gHue.addUnitValueEditor('Hue weight (1 = neutral, higher = stricter):','px','x',1,1,10);
    edHue.value=preset?.hueWeightVal??3;edHue.isEnabled=cbHue.value;

    const gScope=c1.addGroup('Objects to process');
    const cboScope=gScope.addComboBox('Scope:',['All objects in document','Selected objects only (incl. groups)','Active layer (top layer)'],0);

    const gExtra=c1.addGroup('Include additional fill types');
    const cbStroke=gExtra.addCheckBox('Replace stroke colours',preset?.includeStroke??false);
    const cbGradient=gExtra.addCheckBox('Replace gradient fills',preset?.includeGradient??false);
    const cbHatch=gExtra.addCheckBox('Replace hatch fills',preset?.includeHatch??false);
    const cbText=gExtra.addCheckBox('Replace text colours (fill + stroke, single-colour text only)',preset?.includeText??false);

    const gL=c2.addGroup('Lightness variants (extend target palette)');
    const cbL=gL.addCheckBox('Enable',preset?.useLV??false);
    const edL=gL.addUnitValueEditor('Step size (%):','px','%',0,1,100);
    edL.value=preset?.lStep??20;edL.isEnabled=cbL.value;

    const gS=c2.addGroup('Saturation variants (extend target palette)');
    const cbS=gS.addCheckBox('Enable',preset?.useSV??false);
    const edS=gS.addUnitValueEditor('Step size (%):','px','%',0,1,100);
    edS.value=preset?.sStep??20;edS.isEnabled=cbS.value;

    const gPrev=c2.addGroup('Preview');
    const swPrev=gPrev.addSwitch('Live preview',false);

    const gPreset=c2.addGroup('Settings');
    const cbSavePreset=gPreset.addCheckBox('Save as default (on apply)',preset!=null);
    const cbExportMapping=gPreset.addCheckBox('Export colour mapping as JSON',false);

    const gStat=c2.addGroup('Status & mapping');
    const txStat=gStat.addStaticText('','Ready.');
    const txMap=gStat.addStaticText('','');

    function getCurrentPalette(){
        const idx=cboPal.selectedIndex;
        if(idx<builtinNames.length)return BUILTIN[builtinNames[idx]];
        if(idx===IDX_AFP)return loadedPalette?loadedPalette.colours:[];
        if(idx===IDX_HEX){
            return tbHex.text.split(',').reduce((a,p)=>{
                const h=p.trim().replace('#','');
                if(h.length===6){const r=parseInt(h.substring(0,2),16),g=parseInt(h.substring(2,4),16),b=parseInt(h.substring(4,6),16);if(!isNaN(r+g+b))a.push({r,g,b});}
                return a;
            },[]);
        }
        return[];
    }
    function currentTol(){
        const mode=cboTolMode.selectedIndex;
        if(mode===0)return -1;
        if(mode===2)return 255;
        return Math.round(edTol.value);
    }
    function currentHueWeight(){return cbHue.value?edHue.value:1;}
    function currentScope(){
        const idx=cboScope.selectedIndex;
        return idx===1?'selection':idx===2?'activeLayer':'all';
    }

    // Rollback to the original state. A preview run is now only one or two history steps deep;
    // afterwards hatches and gradients are verified against the snapshot.
    function rollbackPreview(){
        rollbackToPosition(doc,posBeforePreview);
        verifyFills(doc,fillSnap);
        restoreSelectionIfChanged(doc,selNodes);
    }

    function formatMappingSummary(log){
        if(!log||!log.length)return'';
        const shown=log.slice(0,6).map(e=>{
            if(e.type==='bitmap')return'Bitmap "'+e.node+'": '+e.pixelsChanged+' pixels';
            let line=e.node+': '+e.from+' → '+e.to+(e.deltaE?' (ΔE '+e.deltaE+')':'');
            if(e.type==='text-fill')line='[Text fill] '+line;
            if(e.type==='text-stroke')line='[Text stroke] '+line;
            if(e.note)line+=' ['+e.note+']';
            return line;
        });
        let txt=shown.join('\n');
        if(log.length>6)txt+='\n… and '+(log.length-6)+' more';
        return txt;
    }

    function updatePreview(){
        if(updateGuard)return;updateGuard=true;
        try{
            rollbackPreview();   // always start from the untouched original

            if(!swPrev.value){txStat.text='Preview off.';txMap.text='';return;}
            const pal=getCurrentPalette();
            if(!pal.length){txStat.text='No palette selected.';txMap.text='';return;}
            const scope=currentScope();
            if(scope==='selection'&&leafCountOf(selNodes)===0){txStat.text='No objects selected.';txMap.text='';return;}

            const tol=currentTol();
            const mappingLog=[];
            const res=doReplace(doc,pal,cbL.value,edL.value,cbS.value,edS.value,tol,scope,selNodes,
                                 currentHueWeight(),cbStroke.value,cbGradient.value,cbHatch.value,cbText.value,mappingLog);
            restoreSelectionIfChanged(doc,selNodes);
            lastMappingLog=mappingLog;
            const expanded=expandPalette(pal,cbL.value,edL.value,cbS.value,edS.value);
            const modeLabel=tol===-1?'Exact':tol>=255?'Best match':'Tolerance '+tol;
            txStat.text=res.count>0
                ?'Preview ('+modeLabel+'): '+res.count+' replaced. '+expanded.length+' target colours.'
                :'Preview: no matches. '+expanded.length+' target colours.';
            txMap.text=formatMappingSummary(mappingLog);
        }catch(e){
            // Partial edits must not remain after an error.
            rollbackPreview();
            txStat.text='Error: '+e.message;txMap.text='';
        }
        finally{updateGuard=false;}
    }

    cboPal.onValueChangedHandler=()=>{
        const idx=cboPal.selectedIndex;tbHex.isEnabled=(idx===IDX_HEX);
        if(idx===IDX_LOAD){
            const result=loadPaletteFromFile();
            if(result){loadedPalette=result;txInfo.text='"'+loadedPalette.paletteName+'"  ·  '+loadedPalette.colours.length+' colours';}
            cboPal.selectedIndex=IDX_AFP;updatePreview();return;
        }
        if(idx===IDX_AFP)txInfo.text=loadedPalette?'"'+loadedPalette.paletteName+'"  ·  '+loadedPalette.colours.length+' colours':'';
        updatePreview();
    };
    cboTolMode.onValueChangedHandler=()=>{edTol.isEnabled=(cboTolMode.selectedIndex===1);updatePreview();};
    edTol.isEnabled=(cboTolMode.selectedIndex===1);
    cbHue.onValueChangedHandler=()=>{edHue.isEnabled=cbHue.value;updatePreview();};
    edHue.onValueChangedHandler=()=>updatePreview();
    cboScope.onValueChangedHandler=()=>updatePreview();
    cbStroke.onValueChangedHandler=()=>updatePreview();
    cbGradient.onValueChangedHandler=()=>updatePreview();
    cbHatch.onValueChangedHandler=()=>updatePreview();
    cbText.onValueChangedHandler=()=>updatePreview();
    cbL.onValueChangedHandler=()=>{edL.isEnabled=cbL.value;updatePreview();};
    cbS.onValueChangedHandler=()=>{edS.isEnabled=cbS.value;updatePreview();};
    edTol.onValueChangedHandler=()=>updatePreview();
    edL.onValueChangedHandler=()=>updatePreview();
    edS.onValueChangedHandler=()=>updatePreview();
    tbHex.onValueChangedHandler=()=>updatePreview();
    swPrev.onValueChangedHandler=()=>updatePreview();

    const result=dlg.runModal();

    function applySettingsSideEffects(){
        if(cbSavePreset.value){
            savePreset({
                tolMode:cboTolMode.selectedIndex, tolerance:edTol.value,
                hueWeight:cbHue.value?edHue.value:1, hueWeightVal:edHue.value,
                useLV:cbL.value, lStep:edL.value, useSV:cbS.value, sStep:edS.value,
                includeStroke:cbStroke.value, includeGradient:cbGradient.value,
                includeHatch:cbHatch.value, includeText:cbText.value
            });
        }
        if(cbExportMapping.value&&lastMappingLog.length){
            const path=exportMapping(lastMappingLog);
            if(path)app.alert('Colour mapping exported:\n'+path,'Replace Colours');
        }
    }

    if(result&&result.value===DialogResult.Ok.value){
        // Discard the preview, then apply fresh with the final settings.
        rollbackPreview();
        const pal=getCurrentPalette();
        const scope=currentScope();
        if(!pal.length){app.alert('No palette selected.','Replace Colours');return;}
        if(scope==='selection'&&leafCountOf(selNodes)===0){
            app.alert('No objects selected.','Replace Colours');return;
        }
        const tol=currentTol();
        const mappingLog=[];
        try{
            const res=doReplace(doc,pal,cbL.value,edL.value,cbS.value,edS.value,tol,scope,selNodes,
                                 currentHueWeight(),cbStroke.value,cbGradient.value,cbHatch.value,cbText.value,mappingLog);
            restoreSelectionIfChanged(doc,selNodes);
            lastMappingLog=mappingLog;
            applySettingsSideEffects();
            if(res.count===0)app.alert('No colours replaced.\nTip: check the tolerance mode or the palette.','Replace Colours');
        }catch(e){
            rollbackPreview();
            app.alert('Error while applying – document was restored.\n'+e.message,'Replace Colours');
        }
    }else{
        rollbackPreview();
    }
})();
