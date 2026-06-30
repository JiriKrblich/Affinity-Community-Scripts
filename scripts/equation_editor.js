/**
 * name: Equation Editor
 * category: Tools
 * description: LaTeX equation editor — creates AND edits equations.
 *
 *              HOW IT WORKS:
 *              • Select an EQ:-tagged equation → re-edit it (formula + size pre-filled).
 *              • Select any other object → replace it with a new equation.
 *              • Select nothing → if equations exist on the page, edits the most
 *                recent one; otherwise opens a fresh create dialog.
 *
 *              Size is stored in the layer name so re-renders stay the same size.
 *              Requires: Edit → Preferences → Allow network access for scripts.
 */

'use strict';

(function () {

    // ── Imports ────────────────────────────────────────────────────────────────
    const { app }                                        = require('/application');
    const { Dialog, DialogResult }                       = require('/dialog');
    const { HttpRequest, RequestMethod }                 = require('/network');
    const { Colour }                                     = require('/colours');
    const { FillDescriptor, SolidFill }                  = require('/fills');
    const { LineStyleDescriptor }                        = require('/linestyle');
    const { CurveBuilder, PolyCurve }                    = require('/geometry');
    const { PolyCurveNodeDefinition }                    = require('/nodes');
    const { AddChildNodesCommandBuilder, InsertionMode } = require('/commands');
    const { Document }                                   = require('/document');

    // ── 50 essential symbols — 5 columns × 10 rows ────────────────────────────
    const SYMBOLS = [
        // Row 1 — Arithmetic
        ['±','\\pm'],            ['×','\\times'],         ['÷','\\div'],           ['·','\\cdot'],          ['∘','\\circ'],
        // Row 2 — Comparison
        ['≠','\\neq'],           ['≤','\\leq'],           ['≥','\\geq'],           ['≈','\\approx'],        ['≡','\\equiv'],
        // Row 3 — Logic
        ['∧','\\wedge'],         ['∨','\\vee'],           ['¬','\\neg'],           ['∀','\\forall'],        ['∃','\\exists'],
        // Row 4 — Greek I
        ['α','\\alpha'],         ['β','\\beta'],          ['γ','\\gamma'],         ['δ','\\delta'],         ['ε','\\varepsilon'],
        // Row 5 — Greek II
        ['θ','\\theta'],         ['λ','\\lambda'],        ['μ','\\mu'],            ['π','\\pi'],            ['σ','\\sigma'],
        // Row 6 — Greek III + uppercase
        ['φ','\\varphi'],        ['ω','\\omega'],         ['Γ','\\Gamma'],         ['Δ','\\Delta'],         ['Σ','\\Sigma'],
        // Row 7 — Calculus / special
        ['∞','\\infty'],         ['∂','\\partial'],       ['∇','\\nabla'],         ['ℝ','\\mathbb{R}'],     ['ℕ','\\mathbb{N}'],
        // Row 8 — Integrals & roots
        ['∫','\\int_{a}^{b}'],   ['∬','\\iint'],          ['∑','\\sum_{n=0}^{N}'], ['√','\\sqrt{x}'],       ['∛','\\sqrt[3]{x}'],
        // Row 9 — Arrows
        ['→','\\rightarrow'],    ['⇒','\\Rightarrow'],    ['⟹','\\implies'],       ['↔','\\leftrightarrow'],['↦','\\mapsto'],
        // Row 10 — Sets
        ['∈','\\in'],            ['∉','\\notin'],         ['∅','\\emptyset'],      ['∪','\\cup'],           ['∩','\\cap'],
    ];

    const TEMPLATES = [
        ['Quadratic formula',    '\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}'],
        ["Euler's identity",     'e^{i\\pi} + 1 = 0'],
        ['Gaussian integral',    '\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}'],
        ['Basel problem',        '\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}'],
        ['Bayes theorem',        'P(A|B) = \\dfrac{P(B|A)\\,P(A)}{P(B)}'],
        ['Normal distribution',  'f(x) = \\frac{1}{\\sigma\\sqrt{2\\pi}} e^{-\\frac{(x-\\mu)^2}{2\\sigma^2}}'],
        ["Maxwell's equation",   '\\nabla \\times \\mathbf{E} = -\\dfrac{\\partial \\mathbf{B}}{\\partial t}'],
        ["Schrödinger",          '\\hat{H}\\psi = i\\hbar\\dfrac{\\partial\\psi}{\\partial t}'],
        ['2×2 matrix',           '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}'],
        ['Taylor series',        'f(x) = \\sum_{n=0}^{\\infty} \\frac{f^{(n)}(a)}{n!}(x-a)^n'],
        ['Pythagorean theorem',  'a^2 + b^2 = c^2'],
        ['E = mc²',              'E = mc^2'],
    ];

    // Internal size steps: [targetH in canvas units, label]
    const SIZES = [
        [22,  'Small   (~8 mm)'],
        [40,  'Normal  (~14 mm)'],
        [64,  'Large   (~22 mm)'],
        [100, 'Display (~35 mm)'],
    ];

    // ── Guard ──────────────────────────────────────────────────────────────────
    const doc = Document.current;
    if (!doc) { app.alert('Please open a document first.', 'Equation Editor'); return; }

    // ── Tag format helpers ─────────────────────────────────────────────────────
    // Layer name format: "EQ:<formula>||H:<targetH>"
    // Legacy format (no ||H:):  "EQ:<formula>"

    function makeTag(formula, targetH) {
        return 'EQ:' + formula + '||H:' + targetH;
    }

    function parseTag(desc) {
        // Returns { formula, targetH } or null if not an EQ: tag.
        if (!desc || !desc.startsWith('EQ:')) return null;
        const body = desc.slice(3);
        const hIdx = body.indexOf('||H:');
        if (hIdx >= 0) {
            return {
                formula:  body.slice(0, hIdx),
                targetH:  parseInt(body.slice(hIdx + 4), 10) || 40,
            };
        }
        return { formula: body, targetH: null }; // legacy — no stored height
    }

    function targetHToSizeIdx(h) {
        if (!h) return 1; // default: Normal
        for (let i = 0; i < SIZES.length; i++) { if (SIZES[i][0] === h) return i; }
        // Snap to nearest
        let best = 0, bestDiff = Infinity;
        SIZES.forEach(([sh], i) => { const d = Math.abs(sh - h); if (d < bestDiff) { bestDiff = d; best = i; } });
        return best;
    }

    // ── Scan spread for EQ: equations ─────────────────────────────────────────
    function scanForEquations(parent) {
        const found = [];
        try {
            for (const child of parent.children) {
                const desc   = child.userDescription || child.name || '';
                const parsed = parseTag(desc);
                if (parsed) found.push({ node: child, ...parsed });
                const inner = scanForEquations(child);
                for (const x of inner) found.push(x);
            }
        } catch (_) {}
        return found;
    }

    // ── Detect mode ────────────────────────────────────────────────────────────
    // NOTE: When run from Affinity's Script panel, the selection is cleared
    // before the script executes. Modes A/B only work when run from the
    // Script menu or a keyboard shortcut (which preserve the selection).
    //
    // A = EQ:-tagged selection        → re-edit (formula + size pre-filled)
    // B = un-tagged selection         → replace on OK (blank formula)
    // C = nothing selected, EQ: found → auto-edit most recent equation
    // D = nothing selected, none found→ fresh create

    let editingNode    = null;   // node to delete after re-render
    let initialFormula = '\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}';
    let initialSizeIdx = 1;      // Normal
    let storedTargetH  = null;   // exact targetH from the EQ: tag (ground truth for size)
    let mode           = 'D';    // fresh create

    // ── Read selection using the correct SDK API ───────────────────────────────
    // SDK: sel.length + sel.at(i).node   OR   sel.nodes.toArray()
    // Selection IS cleared when script runs from the Script panel sidebar.
    function getSelectedNodes() {
        try {
            const sel = doc.selection;
            if (!sel || sel.length === 0) return [];
            // Try toArray() first (returns typed node array)
            try {
                if (sel.nodes && typeof sel.nodes.toArray === 'function') {
                    return sel.nodes.toArray();
                }
            } catch (_) {}
            // Fall back to sel.at(i).node
            const out = [];
            for (let i = 0; i < sel.length; i++) {
                try {
                    const item = sel.at(i);
                    out.push(item && item.node ? item.node : item);
                } catch (_) {}
            }
            return out;
        } catch (_) { return []; }
    }

    try {
        const nodes = getSelectedNodes();
        if (nodes.length > 0) {
            // First: look for an EQ:-tagged node
            for (let i = 0; i < nodes.length; i++) {
                const n      = nodes[i];
                const parsed = parseTag(n && (n.userDescription || n.name || ''));
                if (parsed) {
                    editingNode    = n;
                    initialFormula = parsed.formula;
                    storedTargetH  = parsed.targetH;
                    initialSizeIdx = targetHToSizeIdx(parsed.targetH);
                    mode           = 'A';
                    break;
                }
            }
            // Fallback: any selection → replace mode
            if (mode !== 'A') {
                editingNode    = nodes[0];
                initialFormula = '';
                mode           = 'B';
            }
        }
    } catch (_) {}

    // Mode C: nothing selected → scan the spread
    if (mode === 'D') {
        const spread   = doc.currentSpread;
        const eqNodes  = spread ? scanForEquations(spread) : [];
        if (eqNodes.length > 0) {
            const eq       = eqNodes[0]; // most recent = front of stack
            editingNode    = eq.node;
            initialFormula = eq.formula;
            storedTargetH  = eq.targetH;
            initialSizeIdx = targetHToSizeIdx(eq.targetH);
            mode           = 'C';
            console.log('[EqEditor] Auto-selected: "' + initialFormula + '"');
        }
        // else: stays mode D (fresh create, initialFormula = default quadratic)
    }

    const isEditing = (mode === 'A' || mode === 'B' || mode === 'C');

    // ── Read original position from spreadVisibleBox ───────────────────────────
    // Position-only: spreadVisibleBox can include stroke padding so its .height
    // is NOT used for size — storedTargetH (from the EQ: tag) is the true size.
    let placeX = 50, placeY = 50;
    if (editingNode) {
        try {
            const box = editingNode.spreadVisibleBox
                     || (typeof editingNode.getSpreadBaseBox === 'function' ? editingNode.getSpreadBaseBox() : null)
                     || editingNode.baseBox;
            if (box) {
                if (box.x != null) placeX = box.x;
                if (box.y != null) placeY = box.y;
            }
        } catch (_) {}
    }

    const dlgTitle = mode === 'A'
        ? 'Edit  [' + initialFormula.slice(0, 36) + (initialFormula.length > 36 ? '…' : '') + ']'
        : mode === 'B'
            ? 'Replace Selection with Equation'
            : mode === 'C'
                ? 'Edit Equation  (auto-selected)'
                : 'LaTeX Equation Editor';

    // ── Build dialog ───────────────────────────────────────────────────────────
    // NOTE: hidden controls still take layout space in Affinity dialogs.
    // Solution: one static grid of 50 symbols — always visible, no category switching.

    const dlg = Dialog.create(dlgTitle);
    dlg.initialWidth = 500;
    dlg.setIsResizable(true);

    const col = dlg.addColumn();

    // ── 1. Formula box ─────────────────────────────────────────────────────────
    const fGroup     = col.addGroup('LaTeX Formula');
    const formulaBox = fGroup.addTextBox('', initialFormula);
    formulaBox.setIsMultiLine(true).setRowSpan(4).setIsFullWidth(true);

    // ── 2. Symbol grid — 5 cols × 10 rows, always visible ─────────────────────
    const symGroup   = col.addGroup('Symbols  (click to insert)');
    const symStack   = symGroup.addColumnStack();
    const symColGrps = [];
    for (let c = 0; c < 5; c++) symColGrps.push(symStack.addColumn().addGroup(''));
    SYMBOLS.forEach((sym, i) => {
        const btn = symColGrps[i % 5].addButton(sym[0]);
        btn.setIsFullWidth(true);
        btn.setOnClickHandler(() => { formulaBox.text = formulaBox.text + sym[1]; });
    });

    // ── 3. Templates ───────────────────────────────────────────────────────────
    const tmplGroup = col.addGroup('Template');
    const tmplCombo = tmplGroup.addComboBox('', TEMPLATES.map(t => t[0]), 0);
    tmplCombo.setIsFullWidth(true);
    const useBtn = tmplGroup.addButton('Use Template ↑  (replaces formula above)');
    useBtn.setIsFullWidth(true);
    useBtn.setOnClickHandler(() => {
        const t = TEMPLATES[tmplCombo.selectedIndex];
        if (t) formulaBox.text = t[1];
    });

    // ── 4. Size (pre-selected from stored tag, or Normal for fresh create) ─────
    const sizeLabel  = isEditing ? 'Size on Canvas  (preserved from original)' : 'Size on Canvas';
    const sizeGroup  = col.addGroup(sizeLabel);
    const sizeCombo  = sizeGroup.addComboBox('', SIZES.map(s => s[1]), initialSizeIdx);

    // ── Run modal ──────────────────────────────────────────────────────────────
    // Set text immediately before runModal — setting it earlier (at control
    // creation time) is sometimes cleared when subsequent controls are added.
    formulaBox.text = initialFormula;
    if (dlg.runModal() !== DialogResult.Ok) return;

    const formula = (formulaBox.text || '').trim();
    if (!formula) { app.alert('No formula entered.', 'Equation Editor'); return; }

    // Use the tag's stored targetH when re-editing (exact value used originally).
    // spreadVisibleBox.height is NOT used — it includes stroke padding and drifts.
    // If the user changed the size combo, honour their choice instead.
    const userChangedSize = sizeCombo.selectedIndex !== initialSizeIdx;
    const targetH = (isEditing && storedTargetH && !userChangedSize)
        ? storedTargetH
        : SIZES[sizeCombo.selectedIndex][0];

    // ── Fetch SVG ──────────────────────────────────────────────────────────────
    const ENCODED   = encodeURIComponent(formula);
    const LOCAL_URL = 'http://localhost:3737?from=' + ENCODED;
    const CLOUD_URL = 'https://math.vercel.app?from=' + ENCODED;

    function tryFetch(url, timeoutSec) {
        try {
            const req  = HttpRequest.create(url, RequestMethod.Get);
            req.setTimeoutInSec(timeoutSec);
            const resp = req.do().response;
            if (resp && resp.statusCode.value === 200) {
                const text = resp.content;
                if (text && text.includes('<svg')) return text;
            }
        } catch (_) {}
        return null;
    }

    let svgText = tryFetch(LOCAL_URL, 2);
    let source  = 'local';
    if (!svgText) { source = 'cloud'; svgText = tryFetch(CLOUD_URL, 20); }

    if (!svgText) {
        app.alert(
            'Could not render the equation.\n\n' +
            'LOCAL server (localhost:3737) is not running,\n' +
            'and the cloud fallback also failed.\n\n' +
            'For cloud: Edit → Preferences → Allow network access for scripts\n' +
            'For local: install and start the Affinity Equation Renderer service.',
            'Equation Editor'
        );
        return;
    }

    console.log('[EqEditor] mode=' + mode + '  SVG from ' + source + '  formula=' + formula + '  targetH=' + targetH);

    // ── SVG helpers ────────────────────────────────────────────────────────────
    const IDENTITY = [1, 0, 0, 1, 0, 0];

    function matMul(p, q) {
        return [
            p[0]*q[0]+p[2]*q[1],  p[1]*q[0]+p[3]*q[1],
            p[0]*q[2]+p[2]*q[3],  p[1]*q[2]+p[3]*q[3],
            p[0]*q[4]+p[2]*q[5]+p[4],  p[1]*q[4]+p[3]*q[5]+p[5],
        ];
    }

    function parseTransformAttr(s) {
        if (!s) return IDENTITY;
        let result = [...IDENTITY];
        const fnRe = /(\w+)\s*\(([^)]*)\)/g;
        let m, found = false;
        while ((m = fnRe.exec(s)) !== null) {
            found = true;
            const fn   = m[1];
            const args = m[2].trim().split(/[\s,]+/).filter(Boolean).map(Number);
            let t;
            switch (fn) {
            case 'matrix':    t = [args[0],args[1],args[2],args[3],args[4]||0,args[5]||0]; break;
            case 'translate': t = [1,0,0,1,args[0]||0,args[1]||0]; break;
            case 'scale': { const sx=args[0],sy=args.length>1?args[1]:args[0]; t=[sx,0,0,sy,0,0]; break; }
            case 'rotate': {
                const a=(args[0]||0)*Math.PI/180, cos=Math.cos(a), sin=Math.sin(a);
                if (args.length>=3) {
                    const cx=args[1],cy=args[2];
                    t=[cos,sin,-sin,cos,cx*(1-cos)+cy*sin,cy*(1-cos)-cx*sin];
                } else t=[cos,sin,-sin,cos,0,0];
                break;
            }
            default: t=[...IDENTITY];
            }
            result = matMul(result, t);
        }
        return found ? result : IDENTITY;
    }

    function getAttr(attrStr, name) {
        const re = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*["\']([^"\']*)["\']');
        const m  = attrStr.match(re);
        return m ? m[1] : null;
    }

    // ── Parse viewBox ──────────────────────────────────────────────────────────
    const vbMatch = svgText.match(/viewBox\s*=\s*["']([^"']*)["']/);
    if (!vbMatch) { app.alert('SVG has no viewBox attribute.', 'Equation Editor'); return; }
    const [vbX, vbY, vbW, vbH] = vbMatch[1].split(/[\s,]+/).map(Number);
    const targetW = targetH * (vbW / vbH);

    const PLACE_X = placeX, PLACE_Y = placeY;

    function toDoc(mat, svgX, svgY) {
        const sx = mat[0]*svgX + mat[2]*svgY + mat[4];
        const sy = mat[1]*svgX + mat[3]*svgY + mat[5];
        return [
            (sx - vbX) / vbW * targetW + PLACE_X,
            (sy - vbY) / vbH * targetH + PLACE_Y,
        ];
    }

    // ── Collect drawable elements ──────────────────────────────────────────────
    const elements = [];
    const xfStack  = [[...IDENTITY]];
    const tagRe    = /(<\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s[^>]*)?)(\/?)>/g;
    let tagMatch;

    while ((tagMatch = tagRe.exec(svgText)) !== null) {
        const isClose   = tagMatch[1] === '</';
        const tagName   = tagMatch[2];
        const attrStr   = tagMatch[3];
        const selfClose = tagMatch[4] === '/';

        if (!isClose) {
            const combined = matMul(
                xfStack[xfStack.length - 1],
                parseTransformAttr(getAttr(attrStr, 'transform'))
            );
            if (tagName === 'g' && !selfClose) {
                xfStack.push(combined);
            } else if (tagName === 'path') {
                const d = getAttr(attrStr, 'd');
                if (d) elements.push({ type: 'path', d, mat: combined });
            } else if (tagName === 'rect') {
                const x = parseFloat(getAttr(attrStr, 'x')      || '0');
                const y = parseFloat(getAttr(attrStr, 'y')      || '0');
                const w = parseFloat(getAttr(attrStr, 'width')  || '0');
                const h = parseFloat(getAttr(attrStr, 'height') || '0');
                if (w > 0 && h > 0) elements.push({ type: 'rect', x, y, w, h, mat: combined });
            }
        } else if (tagName === 'g' && xfStack.length > 1) {
            xfStack.pop();
        }
    }

    if (elements.length === 0) {
        app.alert('No drawable elements in the SVG.\nThe formula may contain unsupported commands.', 'Equation Editor');
        return;
    }

    // ── Build PolyCurve ────────────────────────────────────────────────────────
    const polyCurve = PolyCurve.create();

    function parseSVGPath(d) {
        const out = [], re = /([MmLlHhVvCcSsQqTtZz])([^MmLlHhVvCcSsQqTtZz]*)/g;
        let m;
        while ((m = re.exec(d)) !== null) {
            out.push({ cmd: m[1], nums: m[2].trim() ? m[2].trim().split(/[\s,]+/).filter(Boolean).map(Number) : [] });
        }
        return out;
    }

    function buildPath(d, mat) {
        const cmds = parseSVGPath(d);
        let cx=0,cy=0,sx=0,sy=0,pcp2x=0,pcp2y=0,cb=null;
        const finish = () => { if (cb) { polyCurve.addCurve(cb.createCurve()); cb = null; } };
        const ensure = (X,Y) => {
            if (!cb) { cb = CurveBuilder.create(); const [px,py] = toDoc(mat,X,Y); cb.beginXY(px,py); sx=X; sy=Y; }
        };

        for (const {cmd, nums} of cmds) {
            const rel = cmd !== 'Z' && cmd !== 'z' && cmd === cmd.toLowerCase();
            const ax  = dx => rel ? cx+dx : dx;
            const ay  = dy => rel ? cy+dy : dy;

            switch (cmd.toUpperCase()) {
            case 'M':
                finish();
                for (let i=0; i+1<nums.length; i+=2) {
                    const nx=ax(nums[i]), ny=ay(nums[i+1]);
                    if (i===0) { cx=nx; cy=ny; cb=CurveBuilder.create(); const [px,py]=toDoc(mat,nx,ny); cb.beginXY(px,py); sx=nx; sy=ny; }
                    else       { const [px,py]=toDoc(mat,nx,ny); cb.lineToXY(px,py); cx=nx; cy=ny; }
                }
                pcp2x=cx; pcp2y=cy; break;
            case 'L':
                for (let i=0; i+1<nums.length; i+=2) {
                    const nx=ax(nums[i]), ny=ay(nums[i+1]); ensure(cx,cy);
                    const [px,py]=toDoc(mat,nx,ny); cb.lineToXY(px,py); cx=nx; cy=ny;
                }
                pcp2x=cx; pcp2y=cy; break;
            case 'H':
                for (const v of nums) { const nx=rel?cx+v:v; ensure(cx,cy); const [px,py]=toDoc(mat,nx,cy); cb.lineToXY(px,py); cx=nx; }
                pcp2x=cx; pcp2y=cy; break;
            case 'V':
                for (const v of nums) { const ny=rel?cy+v:v; ensure(cx,cy); const [px,py]=toDoc(mat,cx,ny); cb.lineToXY(px,py); cy=ny; }
                pcp2x=cx; pcp2y=cy; break;
            case 'C':
                for (let i=0; i+5<nums.length; i+=6) {
                    const c1x=ax(nums[i]), c1y=ay(nums[i+1]), c2x=ax(nums[i+2]), c2y=ay(nums[i+3]), ex=ax(nums[i+4]), ey=ay(nums[i+5]);
                    ensure(cx,cy);
                    cb.addBezierXY(...toDoc(mat,c1x,c1y), ...toDoc(mat,c2x,c2y), ...toDoc(mat,ex,ey));
                    pcp2x=c2x; pcp2y=c2y; cx=ex; cy=ey;
                }
                break;
            case 'S':
                for (let i=0; i+3<nums.length; i+=4) {
                    const rc1x=2*cx-pcp2x, rc1y=2*cy-pcp2y, c2x=ax(nums[i]), c2y=ay(nums[i+1]), ex=ax(nums[i+2]), ey=ay(nums[i+3]);
                    ensure(cx,cy);
                    cb.addBezierXY(...toDoc(mat,rc1x,rc1y), ...toDoc(mat,c2x,c2y), ...toDoc(mat,ex,ey));
                    pcp2x=c2x; pcp2y=c2y; cx=ex; cy=ey;
                }
                break;
            case 'Q':
                for (let i=0; i+3<nums.length; i+=4) {
                    const qcx=ax(nums[i]), qcy=ay(nums[i+1]), ex=ax(nums[i+2]), ey=ay(nums[i+3]);
                    const c1x=cx+(2/3)*(qcx-cx), c1y=cy+(2/3)*(qcy-cy), c2x=ex+(2/3)*(qcx-ex), c2y=ey+(2/3)*(qcy-ey);
                    ensure(cx,cy);
                    cb.addBezierXY(...toDoc(mat,c1x,c1y), ...toDoc(mat,c2x,c2y), ...toDoc(mat,ex,ey));
                    pcp2x=c2x; pcp2y=c2y; cx=ex; cy=ey;
                }
                break;
            case 'T':
                for (let i=0; i+1<nums.length; i+=2) {
                    const qcx=2*cx-pcp2x, qcy=2*cy-pcp2y, ex=ax(nums[i]), ey=ay(nums[i+1]);
                    const c1x=cx+(2/3)*(qcx-cx), c1y=cy+(2/3)*(qcy-cy), c2x=ex+(2/3)*(qcx-ex), c2y=ey+(2/3)*(qcy-ey);
                    ensure(cx,cy);
                    cb.addBezierXY(...toDoc(mat,c1x,c1y), ...toDoc(mat,c2x,c2y), ...toDoc(mat,ex,ey));
                    pcp2x=qcx; pcp2y=qcy; cx=ex; cy=ey;
                }
                break;
            case 'Z':
                if (cb) cb.close(); finish(); cx=sx; cy=sy; pcp2x=cx; pcp2y=cy; break;
            }
        }
        finish();
    }

    function buildRect(x, y, w, h, mat) {
        let rY = y, rH = h;
        // MathJax uses <rect> only for horizontal rules (fraction bars, sqrt bars, etc.).
        // Thin any rect that is significantly wider than tall to avoid blocky appearance.
        if (w > h * 5) { rH = h * 0.30; rY = y + (h - rH) / 2; }
        const cb = CurveBuilder.create();
        cb.beginXY  (...toDoc(mat, x,   rY));
        cb.lineToXY (...toDoc(mat, x+w, rY));
        cb.lineToXY (...toDoc(mat, x+w, rY+rH));
        cb.lineToXY (...toDoc(mat, x,   rY+rH));
        cb.close();
        polyCurve.addCurve(cb.createCurve());
    }

    for (const el of elements) {
        if      (el.type === 'path') buildPath(el.d, el.mat);
        else if (el.type === 'rect') buildRect(el.x, el.y, el.w, el.h, el.mat);
    }

    // ── Insert onto spread ─────────────────────────────────────────────────────
    const black     = Colour.createRGBA8({ r: 0, g: 0, b: 0, alpha: 255 });
    const brushFill = FillDescriptor.createSolid(SolidFill.create(black));
    const noFill    = FillDescriptor.createNone();
    const lsd       = LineStyleDescriptor.createDefault();

    const pcDef = PolyCurveNodeDefinition.create(polyCurve, brushFill, lsd, noFill, noFill);
    // Tag stores both formula AND size so re-edits are fully lossless
    pcDef.userDescription = makeTag(formula, targetH);

    const spread  = doc.currentSpread;
    const builder = AddChildNodesCommandBuilder.create();
    builder.setInsertionTarget(spread);
    builder.setInsertionMode(InsertionMode.Inside_AtFront);
    builder.addPolyCurveNode(pcDef);
    doc.executeCommand(builder.createCommand());

    // ── Remove old node in edit modes ─────────────────────────────────────────
    if (isEditing && editingNode) {
        try { editingNode.delete(); } catch (_) {
            console.log('[EqEditor] Could not delete old node — remove it manually.');
        }
    }

    console.log('[EqEditor] mode=' + mode + '  "' + formula + '"  H=' + targetH + '  elements=' + elements.length + '  src=' + source);

})();
