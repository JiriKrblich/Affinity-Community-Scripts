/* MR Film Grain v2.0.1 for Affinity 3.3+
 * Creates or updates its own tagged grain layer. Existing artwork is preserved.
 */
'use strict';

function mrGrainFillField(width, height, options, field, seed) {
    const count = width * height;
    field.fill(0);
    let state = (seed >>> 0) || 1;
    function random() {
        state = (state + 0x6D2B79F5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    let particles = 0;
    if (options.size <= 0.75) {
        for (let i=0;i<count;i++) field[i]=2*(random()+random()+random()-1.5);
        const a=0.05*Math.pow(options.size/0.75,2)*(1-0.9*options.sharpness)*(0.6+0.8*options.clump);
        const previous=new Float32Array(width), current=new Float32Array(width);
        previous.set(field.subarray(0,width));
        for (let y=0;y<height;y++) {
            const row=y*width;
            current.set(field.subarray(row,row+width));
            for (let x=0;x<width;x++) {
                const next=y+1<height?field[row+width+x]:current[x];
                field[row+x]=(1-4*a)*current[x]+a*(current[Math.max(0,x-1)]+current[Math.min(width-1,x+1)]+previous[x]+next);
            }
            previous.set(current);
        }
    }
    else {
    const radius = options.size * 0.8;
    const variation = 0.2 + 0.65 * options.clump;
    const padding = Math.ceil(radius * (1 + variation)) + 2;
    const area = (width + 2 * padding) * (height + 2 * padding);
    particles = Math.ceil(2.2 * area / (Math.PI * radius * radius));
    const edgeWidth=1-0.9*options.sharpness;
    for (let p = 0; p < particles; p++) {
        const cx = random() * (width + 2 * padding) - padding;
        const cy = random() * (height + 2 * padding) - padding;
        const r = radius * (1 - variation + 2 * variation * random());
        const invR2 = 1 / (r * r);
        const mark = (random() < 0.5 ? -1 : 1) * (0.65 + 0.7 * random());
        const x0 = Math.max(0, Math.ceil(cx - r - 0.5));
        const x1 = Math.min(width - 1, Math.floor(cx + r - 0.5));
        const y0 = Math.max(0, Math.ceil(cy - r - 0.5));
        const y1 = Math.min(height - 1, Math.floor(cy + r - 0.5));
        for (let y = y0; y <= y1; y++) {
            const dy = y + 0.5 - cy;
            const yTerm = dy * dy * invR2;
            const offset = y * width;
            for (let x = x0; x <= x1; x++) {
                const dx = x + 0.5 - cx;
                const t = 1 - yTerm - dx * dx * invR2;
                if (t > 0) { const edge=Math.min(1,t/edgeWidth); field[offset+x]+=mark*edge*edge; }
            }
        }
    }
    }
    let sum = 0, sum2 = 0;
    for (let i = 0; i < count; i++) { const v = field[i]; sum += v; sum2 += v * v; }
    const mean = sum / count;
    const sigma = Math.sqrt(Math.max(1e-12, sum2 / count - mean * mean));
    return {mean,sigma,particles};
}

function mrGrainEncode(value, stats, size) {
    let n=(value-stats.mean)/stats.sigma;
    const a=Math.abs(n);
    if(a>2)n=(n<0?-1:1)*(2+(a-2)/(1+0.5*(a-2)));
    return Math.round(32767.5+3276.75*Math.min(1,size)*n);
}

function mrGrainBuffer(width,height) {
    const { PixelBuffer, RasterFormat }=require('/rasterobject.js');
    const count=width*height;
    if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||!Number.isSafeInteger(count*8))throw new Error('Invalid project pixel dimensions.');
    const buffer=PixelBuffer.create(width,height,RasterFormat.RGBA16);
    if(buffer.buffer.byteLength!==count*8)throw new Error('Unexpected bitmap layout.');
    return buffer;
}

function mrGrainGenerateMono(width,height,options) {
    const started=Date.now(), count=width*height;
    const buffer=mrGrainBuffer(width,height);
    const field=new Float32Array(buffer.buffer,0,count);
    const stats=mrGrainFillField(width,height,options,field,options.seed);
    const pixels = new Uint16Array(buffer.buffer);
    for (let i = count-1; i >= 0; i--) {
        const j = i * 4;
        const value=mrGrainEncode(field[i],stats,options.size);
        pixels[j] = pixels[j + 1] = pixels[j + 2] = value;
        pixels[j + 3] = 65535;
    }
    return {bitmap:buffer.createCompatibleBitmap(true),milliseconds:Date.now()-started,particles:stats.particles};
}

function mrGrainGenerateRGB(width,height,options) {
    const started=Date.now(),count=width*height;
    const values=new Uint16Array(count*3),field=new Float32Array(count);
    const salts=[0x9E3779B9,0x243F6A88,0xB7E15162];
    for(let channel=0;channel<3;channel++) {
        const stats=mrGrainFillField(width,height,options,field,(options.seed^salts[channel])>>>0);
        for(let i=0;i<count;i++)values[i*3+channel]=mrGrainEncode(field[i],stats,options.size);
    }
    return {values,milliseconds:Date.now()-started};
}

function mrGrainMixColor(monoBitmap,rgb,color) {
    if(color===0)return monoBitmap;
    const width=monoBitmap.width,height=monoBitmap.height,count=width*height;
    const monoBuffer=monoBitmap.createCompatibleBuffer(true);
    const mono=new Uint16Array(monoBuffer.buffer);
    const buffer=mrGrainBuffer(width,height),pixels=new Uint16Array(buffer.buffer);
    const a=1-color,b=color,gain=1/Math.sqrt(a*a+b*b),mid=32767.5;
    for(let i=0;i<count;i++) {
        const shared=mono[i*4]-mid;
        for(let channel=0;channel<3;channel++)pixels[i*4+channel]=Math.round(mid+(a*shared+b*(rgb.values[i*3+channel]-mid))*gain);
        pixels[i*4+3]=65535;
    }
    return buffer.createCompatibleBitmap(true);
}

function mrGrainGenerate(width,height,options) {
    const started=Date.now();
    const mono=mrGrainGenerateMono(width,height,options);
    const bitmap=options.color>0?mrGrainMixColor(mono.bitmap,mrGrainGenerateRGB(width,height,options),options.color):mono.bitmap;
    return {bitmap,milliseconds:Date.now()-started,particles:mono.particles};
}

function mrGrainRanges(node, options) {
    const { Spline } = require('/geometry.js');
    const { BlendOptions } = require('/blendmodeinterface.js');
    const ranges = new BlendOptions(node.blendOptions.handle);
    const points = [];
    for (let i = 0; i <= 32; i++) {
        const x = i / 32;
        const envelope = (1 - options.tone + options.tone * Math.pow(4 * x * (1 - x), 0.35))
            * (1 + options.shadow * (1 - 2 * x));
        points.push({ x, y: Math.max(0, Math.min(1, envelope / 1.2)) });
    }
    ranges.masterUnderlyingCompositionRanges = Spline.createFromPoints(points);
    return ranges;
}

function mrGrainDefaults() {
    return { size:0.8, clump:0.5, amount:0.3, tone:1, shadow:0.5, seed:1, color:0, sharpness:0 };
}

function mrGrainResolveTarget(doc, chooseArtboard) {
    const spread=doc.currentSpread, artboards=spread.artboards;
    if (!artboards.length) return {parent:spread,artboard:null};
    const selected=[];
    for (const item of doc.selection.nodes.toArray()) {
        for (let node=item;node&&!node.isSameNode(spread);node=node.parent) {
            const board=artboards.find(a=>a.node.isSameNode(node));
            if (board) {
                if (!selected.some(a=>a.isSameObject(board))) selected.push(board);
                break;
            }
        }
    }
    let board=selected.length===1?selected[0]:artboards.length===1?artboards[0]:null;
    if (!board) {
        if (chooseArtboard) board=chooseArtboard(artboards);
        else {
            const {Dialog,DialogResult}=require('/dialog.js');
            const dlg=Dialog.create('MR Film Grain — Choose artboard');
            dlg.initialWidth=460;
            const group=dlg.addColumn().addGroup();
            const choice=group.addComboBox('Artboard',artboards.map(a=>a.description+' ('+Math.round(a.spreadBaseBox.width)+' x '+Math.round(a.spreadBaseBox.height)+' px)'),0);
            const result=dlg.runModal();
            if ((result&&result.value!==undefined?result.value:result)!==(DialogResult.Ok.value!==undefined?DialogResult.Ok.value:DialogResult.Ok))return null;
            board=artboards[choice.selectedIndex];
        }
    }
    return board?{parent:board.node,artboard:board}:null;
}

function mrGrainProjectSpec(doc,target) {
    let bounds = target.artboard?target.artboard.spreadBaseBox:doc.currentSpread.getSpreadExtents({includeSpread:true,includeBleed:false,includeChildren:false});
    if (target.artboard&&(!bounds||!Number.isFinite(bounds.width)||!Number.isFinite(bounds.height)||bounds.width<=0||bounds.height<=0))throw new Error('Cannot determine this artboard\'s pixel dimensions.');
    if (!bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)
        || bounds.width <= 0 || bounds.height <= 0) bounds = {x:0,y:0,width:doc.widthPixels,height:doc.heightPixels};
    const x = Math.floor(bounds.x), y = Math.floor(bounds.y);
    const width = Math.ceil(bounds.x+bounds.width)-x;
    const height = Math.ceil(bounds.y+bounds.height)-y;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw new Error('Cannot determine this spread\'s pixel dimensions.');
    return {x,y,width,height,dpi:Number.isFinite(doc.dpi)?doc.dpi:null,artboard:target.artboard?target.artboard.description:null};
}

function mrGrainPlacement(target,spec) {
    const {Transform}=require('/geometry.js');
    const placement=Transform.createTranslate(spec.x,spec.y);
    return target.artboard?target.parent.localToSpreadTransform.inverted.postmultipliedBy(placement):placement;
}

function mrGrainBitmap(node) {
    return node.isShapeNode?node.brushFillDescriptor.fill.bitmap:node.createCompatibleBitmap(true);
}

function mrGrainConvertBitmap(bitmap,format) {
    if (bitmap.format.value===format.value)return bitmap;
    const {Bitmap}=require('/rasterobject.js');
    const converted=Bitmap.create(bitmap.width,bitmap.height,format);
    bitmap.copyTo(converted,{x:0,y:0,width:bitmap.width,height:bitmap.height},0,0);
    return converted;
}

function mrGrainBitmapFill(bitmap) {
    const {BitmapFill,FillDescriptor,RasterExtendType,RasterResamplerType}=require('/fills.js');
    const {Transform}=require('/geometry.js');
    const {BlendMode}=require('affinity:common');
    return FillDescriptor.create(BitmapFill.create(bitmap,RasterExtendType.Zero,RasterResamplerType.NearestNeighbour,false),true,Transform.createScale(bitmap.width,bitmap.height),BlendMode.Normal,false);
}

function mrGrainValidate(options) {
    const result = Object.assign(mrGrainDefaults(), options);
    const limits = {size:[0.1,64],clump:[0,1],amount:[0,1],tone:[0,1],shadow:[-1,1],seed:[1,2147483647],color:[0,1],sharpness:[0,1]};
    for (const key of Object.keys(limits)) {
        if (!Number.isFinite(result[key])) throw new Error('Invalid ' + key + ' value.');
        result[key] = Math.max(limits[key][0], Math.min(limits[key][1], result[key]));
    }
    result.seed = Math.round(result.seed);
    return result;
}

function mrGrainFindLayer(doc,target) {
    const nodes = target.parent.children.toArray();
    for (let i = nodes.length - 1; i >= 0; i--) {
        if ((nodes[i].isRasterNode||nodes[i].isShapeNode) && nodes[i].hasKey('MRFilmGrain.settings')
            && nodes[i].description.indexOf('MR Film Grain') === 0) return nodes[i];
    }
    return null;
}

function mrGrainReadOptions(node) {
    if (!node) return mrGrainDefaults();
    const options = mrGrainValidate(JSON.parse(node.getValueForKey('MRFilmGrain.settings')));
    options.amount = node.globalOpacity;
    return options;
}

function mrGrainStructureKey(width, height, options) {
    return [width,height,options.size,options.clump,options.seed,options.sharpness].join(':');
}

function mrGrainModelCurrent(node) {
    return node.hasKey('MRFilmGrain.engine')&&node.getValueForKey('MRFilmGrain.engine')==='2.0.0';
}

function mrGrainLayerFits(node,spec,target) {
    if (target.artboard&&!node.isShapeNode) return false;
    const bitmap=node.isShapeNode?mrGrainBitmap(node):{width:node.rasterWidth,height:node.rasterHeight};
    if (bitmap.width !== spec.width || bitmap.height !== spec.height) return false;
    if (node.isShapeNode) {
        const box=node.baseBox;
        if (box.x!==0||box.y!==0||box.width!==spec.width||box.height!==spec.height)return false;
    }
    const expected = mrGrainPlacement(target,spec).data;
    return Array.from(node.transform.data).every((v,i)=>Math.abs(v-expected[i])<1e-8);
}

function mrGrainSettingsCommand(doc, node, options, bitmap, archiveNode, target) {
    const { CompoundCommandBuilder, DocumentCommand } = require('/commands.js');
    const { BlendMode } = require('affinity:common');
    const { NodeMoveType, NodeChildType } = require('affinity:dom');
    const spec = mrGrainProjectSpec(doc,target);
    const selection = node.selfSelection;
    const compound = CompoundCommandBuilder.create();
    if (bitmap) compound.addCommand(node.isShapeNode?DocumentCommand.createSetBrushFill(selection,mrGrainBitmapFill(bitmap)):DocumentCommand.createReplaceBitmap(selection,mrGrainConvertBitmap(bitmap,doc.format)));
    compound.addCommand(DocumentCommand.createSetBlendMode(selection, BlendMode.LinearLight, false));
    compound.addCommand(DocumentCommand.createSetOpacity(selection, options.amount));
    compound.addCommand(DocumentCommand.createSetBlendRanges(selection, mrGrainRanges(node, options)));
    compound.addCommand(DocumentCommand.createSetVisibility(selection, true));
    compound.addCommand(DocumentCommand.createSetTagValueForKey(selection, 'MRFilmGrain.settings', JSON.stringify(options)));
    compound.addCommand(DocumentCommand.createSetTagValueForKey(selection,'MRFilmGrain.engine','2.0.0'));
    compound.addCommand(DocumentCommand.createSetTagValueForKey(selection, 'MRFilmGrain.project', JSON.stringify(spec)));
    if (archiveNode) compound.addCommand(DocumentCommand.createSetVisibility(archiveNode.selfSelection,false));
    const roots = target.parent.children.toArray();
    const top = roots[roots.length - 1];
    if (top && !top.isSameNode(node)) compound.addCommand(DocumentCommand.createMoveNodes(selection, top, NodeMoveType.After, NodeChildType.Main));
    return compound.createCommand();
}

function mrGrainApply(options,target) {
    const { Document } = require('/document.js');
    const { RasterNodeDefinition,ShapeNodeDefinition } = require('/nodes.js');
    const { RasterFormat } = require('/rasterobject.js');
    const { Transform } = require('/geometry.js');
    const { AddChildNodesCommandBuilder, InsertionMode } = require('/commands.js');
    const { NodeChildType } = require('affinity:dom');
    const doc = Document.current;
    if (!doc) throw new Error('Open a document first.');
    target=target||mrGrainResolveTarget(doc);
    if (!target) return null;
    options = mrGrainValidate(options);
    const spec = mrGrainProjectSpec(doc,target);
    const width = spec.width, height = spec.height;
    let node = mrGrainFindLayer(doc,target);
    let archiveNode = null;
    if (node && !mrGrainLayerFits(node,spec,target)) { archiveNode=node; node=null; }
    let generated = null;
    if (node) {
        const previous = mrGrainReadOptions(node);
        if (!mrGrainModelCurrent(node)||previous.color!==options.color||mrGrainStructureKey(width,height,previous)!==mrGrainStructureKey(width,height,options))generated=mrGrainGenerate(width,height,options);
        doc.executeCommand(mrGrainSettingsCommand(doc,node,options,generated ? generated.bitmap : null,null,target),false);
        console.log(JSON.stringify({layer:node.description,generationMs:generated ? generated.milliseconds : 0,cacheHit:!generated,width,height}));
        return node;
    }
    generated = mrGrainGenerate(width, height, options);
    let def;
    if (target.artboard) {
        const {ShapeRectangle}=require('/shapes.js');
        def=ShapeNodeDefinition.create(ShapeRectangle.create(),{x:0,y:0,width,height},mrGrainBitmapFill(generated.bitmap),null,null,null);
    } else {
        def=RasterNodeDefinition.create(doc.format);
        def.bitmap=mrGrainConvertBitmap(generated.bitmap,doc.format);
    }
    def.transform = Transform.createTranslate(spec.x,spec.y);
    def.userDescription = 'MR Film Grain';
    const builder = AddChildNodesCommandBuilder.create();
    builder.setInsertionTarget(target.parent);
    builder.setInsertionMode(InsertionMode.Inside_AtBack);
    if (target.artboard)builder.addShapeNode(def);
    else builder.addRasterNode(def);
    const add = builder.createCommand(false, NodeChildType.Main);
    doc.executeCommand(add, false);
    node = add.newNodes[0];
    try { doc.executeCommand(mrGrainSettingsCommand(doc,node,options,null,archiveNode,target),false); }
    catch (error) { doc.undo(); throw error; }
    console.log(JSON.stringify({ layer: node.description, generationMs: generated.milliseconds, particles: generated.particles, width, height }));
    return node;
}

function mrGrainShowDialog(testCallback) {
    const { Document } = require('/document.js');
    const { Dialog, DialogResult, UnitType } = require('/dialog.js');
    const doc = Document.current;
    if (!doc) throw new Error('Open a document first.');
    const target=mrGrainResolveTarget(doc);
    if (!target) return;
    const positionBefore = doc.history.position;
    let node = mrGrainFindLayer(doc,target);
    const created = !node;
    if (created) node = mrGrainApply(mrGrainDefaults(),target);
    const spec = mrGrainProjectSpec(doc,target);
    if (!created && (!mrGrainLayerFits(node,spec,target)||!mrGrainModelCurrent(node)))node=mrGrainApply(mrGrainReadOptions(node),target);
    const setupUndoSteps = doc.history.position-positionBefore;
    const initial = mrGrainReadOptions(node);
    const width = spec.width, height = spec.height;
    const initialKey = mrGrainStructureKey(width,height,initial);
    const cache = new Map();
    const diagnostics = { generations:0, generationMs:0, previews:0, colorMixes:0 };
    const initialBitmap=mrGrainConvertBitmap(mrGrainBitmap(node),require('/rasterobject.js').RasterFormat.RGBA16);
    cache.set(initialKey,{mono:initial.color===0?initialBitmap:null,rgb:null,lastColor:initial.color,lastBitmap:initialBitmap});
    const dlg = Dialog.create('MR Film Grain');
    dlg.initialWidth = 460;
    const column = dlg.addColumn();
    const texture = column.addGroup('Grain structure');
    const size = texture.addUnitValueEditor('Scale',UnitType.Number,UnitType.Number,initial.size,0.1,64).setPrecision(2);
    const clump = texture.addUnitValueEditor('Grain variation (%)',UnitType.Number,UnitType.Number,initial.clump*100,0,100).setPrecision(0).setShowPopupSlider(true);
    const sharpness=texture.addUnitValueEditor('Sharpness (%)',UnitType.Number,UnitType.Number,initial.sharpness*100,0,100).setPrecision(0).setShowPopupSlider(true);
    const color=texture.addUnitValueEditor('Color (%)',UnitType.Number,UnitType.Number,initial.color*100,0,100).setPrecision(0).setShowPopupSlider(true);
    const seed = texture.addUnitValueEditor('Seed',UnitType.Number,UnitType.Number,initial.seed,1,2147483647).setPrecision(0);
    const response = column.addGroup('Strength and tonal response');
    const amount = response.addUnitValueEditor('Amount (%)',UnitType.Number,UnitType.Number,initial.amount*100,0,100).setPrecision(0).setShowPopupSlider(true);
    const tone = response.addUnitValueEditor('Reduce grain in blacks and whites (%)',UnitType.Number,UnitType.Number,initial.tone*100,0,100).setPrecision(0).setShowPopupSlider(true);
    const shadow = response.addUnitValueEditor('Shadow bias (%)',UnitType.Number,UnitType.Number,initial.shadow*100,-100,100).setPrecision(0).setShowPopupSlider(true);
    const info = column.addGroup();
    if (target.artboard) info.addStaticText('Artboard',target.artboard.description);
    info.addStaticText('Project',width+' x '+height+' px'+(spec.dpi?' | '+spec.dpi+' DPI':''));
    info.addStaticText('', 'Color: 0% monochrome / 100% independent RGB.');
    info.addStaticText('', 'RGB fields are prepared once per texture while editing.');
    info.addStaticText('', 'Changes to scale, variation, sharpness or seed will regenerate the texture. Amount and tonal controls reuse the cached grain.');
    function readOptions() {
        return mrGrainValidate({size:size.value,clump:clump.value/100,seed:seed.value,amount:amount.value/100,tone:tone.value/100,shadow:shadow.value/100,color:color.value/100,sharpness:sharpness.value/100});
    }
    function prepare(options) {
        const key = mrGrainStructureKey(width,height,options);
        if (!cache.has(key)) {
            const result = mrGrainGenerateMono(width,height,options);
            diagnostics.generations++;
            diagnostics.generationMs += result.milliseconds;
            if (cache.size >= 2) {
                for (const entry of cache.keys()) { if (entry !== initialKey) { cache.delete(entry); break; } }
            }
            cache.set(key,{mono:result.bitmap,rgb:null,lastColor:0,lastBitmap:result.bitmap});
        }
        const entry=cache.get(key);
        if(entry.lastColor!==options.color) {
            if(!entry.mono) {
                const result=mrGrainGenerateMono(width,height,options);
                entry.mono=result.bitmap;diagnostics.generations++;diagnostics.generationMs+=result.milliseconds;
            }
            if(options.color>0&&!entry.rgb) {
                entry.rgb=mrGrainGenerateRGB(width,height,options);
                diagnostics.generations+=3;diagnostics.generationMs+=entry.rgb.milliseconds;
            }
            entry.lastBitmap=mrGrainMixColor(entry.mono,entry.rgb,options.color);
            entry.lastColor=options.color;diagnostics.colorMixes++;
        }
        return key===initialKey&&options.color===initial.color?null:entry.lastBitmap;
    }
    function preview() {
        const options = readOptions();
        const bitmap = prepare(options);
        doc.executeCommand(mrGrainSettingsCommand(doc,node,options,bitmap,null,target),true);
        diagnostics.previews++;
    }
    dlg.onControlValueChangedHandler = preview;
    let accepted = false;
    try {
        const result = testCallback ? testCallback({dlg,node,doc,controls:{size,clump,seed,amount,tone,shadow,color,sharpness},preview,readOptions,diagnostics}) : dlg.runModal();
        if ((result && result.value !== undefined ? result.value : result)
            === (DialogResult.Ok.value !== undefined ? DialogResult.Ok.value : DialogResult.Ok)) {
            const options = readOptions();
            const bitmap = prepare(options);
            doc.clearPreviews();
            doc.executeCommand(mrGrainSettingsCommand(doc,node,options,bitmap,null,target),false);
            accepted = true;
        }
    }
    finally {
        doc.clearPreviews();
        if (!accepted && setupUndoSteps>0 && doc.history.position === positionBefore+setupUndoSteps) {
            for (let i=0;i<setupUndoSteps;i++) doc.undo();
        }
    }
}

if (typeof MR_GRAIN_AUTOMATION_TEST === 'function') mrGrainShowDialog(MR_GRAIN_AUTOMATION_TEST);
else if (typeof MR_GRAIN_AUTOMATION_OPTIONS !== 'undefined') mrGrainApply(MR_GRAIN_AUTOMATION_OPTIONS);
else mrGrainShowDialog();
