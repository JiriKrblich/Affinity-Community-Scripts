/**
 * name: Join Curves Pro
 * description: Connects open curves with smooth G1/C1 Bézier bridges (default) or welds nodes without drawing lines (CorelDRAW standard), with single-curve support and plotter precision.
 * version: 1.2.2
 * author: Antigravity
 */

'use strict';

const { app } = require('/application.js');
const { Document } = require('/document.js');
const { Dialog, DialogResult } = require('/dialog.js');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands.js');
const { CurveBuilder, PolyCurve, Point, Transform } = require('/geometry.js');
const { Selection } = require('/selections.js');
const { UnitType } = require('affinity:common');

// =============================================================================
// GEOMETRY & VECTOR MATHEMATICS
// =============================================================================

const PT_TO_MM = 25.4 / 72.0;
const MM_TO_PT = 72.0 / 25.4;

function dist(p1, p2) {
    return Math.hypot(p2.x - p1.x, p2.y - p1.y);
}

function normalize(v) {
    const len = Math.hypot(v.x, v.y);
    if (len > 1e-9) {
        return { x: v.x / len, y: v.y / len };
    }
    return { x: 1, y: 0 };
}

function cloneBezier(b) {
    return {
        start: { x: b.start.x, y: b.start.y },
        c1: { x: b.c1.x, y: b.c1.y },
        c2: { x: b.c2.x, y: b.c2.y },
        end: { x: b.end.x, y: b.end.y }
    };
}

function approxBezierLength(b) {
    const chord = dist(b.start, b.end);
    const poly = dist(b.start, b.c1) + dist(b.c1, b.c2) + dist(b.c2, b.end);
    return (chord + poly) * 0.5;
}

function reverseChain(chain) {
    return chain.map(b => ({
        start: { x: b.end.x, y: b.end.y },
        c1: { x: b.c2.x, y: b.c2.y },
        c2: { x: b.c1.x, y: b.c1.y },
        end: { x: b.start.x, y: b.start.y }
    })).reverse();
}

function getExitTangent(chain) {
    const last = chain[chain.length - 1];
    let v = { x: last.end.x - last.c2.x, y: last.end.y - last.c2.y };
    if (Math.hypot(v.x, v.y) < 1e-6) {
        v = { x: last.end.x - last.start.x, y: last.end.y - last.start.y };
    }
    return normalize(v);
}

function getEntryTangent(chain) {
    const first = chain[0];
    let v = { x: first.c1.x - first.start.x, y: first.c1.y - first.start.y };
    if (Math.hypot(v.x, v.y) < 1e-6) {
        v = { x: first.end.x - first.start.x, y: first.end.y - first.start.y };
    }
    return normalize(v);
}

// =============================================================================
// BRIDGING & NODE WELDING ENGINES
// =============================================================================

function buildSmoothBezierBridge(chainA, chainB, tension) {
    const lastA = chainA[chainA.length - 1];
    const firstB = chainB[0];
    const E1 = lastA.end;
    const S2 = firstB.start;
    const gap = dist(E1, S2);

    if (gap < 1e-4) {
        return [...chainA, ...chainB];
    }

    const t1 = getExitTangent(chainA);
    const t2 = getEntryTangent(chainB);
    const h = (gap / 3.0) * tension;

    const bridge = {
        start: { x: E1.x, y: E1.y },
        c1: { x: E1.x + t1.x * h, y: E1.y + t1.y * h },
        c2: { x: S2.x - t2.x * h, y: S2.y - t2.y * h },
        end: { x: S2.x, y: S2.y }
    };

    return [...chainA, bridge, ...chainB];
}

function alignHandlesAtJunction(prevSeg, nextSeg, J, smoothMode) {
    let tIn = { x: J.x - prevSeg.c2.x, y: J.y - prevSeg.c2.y };
    let lenIn = Math.hypot(tIn.x, tIn.y);
    if (lenIn < 1e-6) {
        tIn = { x: J.x - prevSeg.start.x, y: J.y - prevSeg.start.y };
        lenIn = Math.hypot(tIn.x, tIn.y) / 3.0;
    }
    tIn = normalize(tIn);

    let tOut = { x: nextSeg.c1.x - J.x, y: nextSeg.c1.y - J.y };
    let lenOut = Math.hypot(tOut.x, tOut.y);
    if (lenOut < 1e-6) {
        tOut = { x: nextSeg.end.x - J.x, y: nextSeg.end.y - J.y };
        lenOut = Math.hypot(tOut.x, tOut.y) / 3.0;
    }
    tOut = normalize(tOut);

    const dotVal = Math.max(-1.0, Math.min(1.0, tIn.x * tOut.x + tIn.y * tOut.y));
    const angleDeg = Math.acos(dotVal) * (180.0 / Math.PI);

    const shouldSmooth = (smoothMode === 1) || (smoothMode === 0 && angleDeg <= 60.0);
    if (shouldSmooth) {
        let tBlend = { x: tIn.x + tOut.x, y: tIn.y + tOut.y };
        if (Math.hypot(tBlend.x, tBlend.y) < 1e-4) {
            tBlend = { x: nextSeg.end.x - prevSeg.start.x, y: nextSeg.end.y - prevSeg.start.y };
        }
        const T = normalize(tBlend);
        prevSeg.c2 = { x: J.x - T.x * lenIn, y: J.y - T.y * lenIn };
        nextSeg.c1 = { x: J.x + T.x * lenOut, y: J.y + T.y * lenOut };
    }
}

function weldTwoChainsIntoOne(chainA, chainB, smoothMode) {
    const copyA = chainA.map(cloneBezier);
    const copyB = chainB.map(cloneBezier);

    const lastA = copyA[copyA.length - 1];
    const firstB = copyB[0];
    const E1 = lastA.end;
    const S2 = firstB.start;

    const J = { x: (E1.x + S2.x) * 0.5, y: (E1.y + S2.y) * 0.5 };

    const deltaA = { x: J.x - E1.x, y: J.y - E1.y };
    const deltaB = { x: J.x - S2.x, y: J.y - S2.y };

    lastA.end = { x: J.x, y: J.y };
    lastA.c2 = { x: lastA.c2.x + deltaA.x, y: lastA.c2.y + deltaA.y };

    firstB.start = { x: J.x, y: J.y };
    firstB.c1 = { x: firstB.c1.x + deltaB.x, y: firstB.c1.y + deltaB.y };

    alignHandlesAtJunction(lastA, firstB, J, smoothMode);

    return [...copyA, ...copyB];
}

function weldSingleOpenCurveEndpoints(chain, smoothMode) {
    if (chain.length === 0) return chain;
    const copy = chain.map(cloneBezier);
    const first = copy[0];
    const last = copy[copy.length - 1];

    const S = first.start;
    const E = last.end;
    const J = { x: (S.x + E.x) * 0.5, y: (S.y + E.y) * 0.5 };

    const deltaS = { x: J.x - S.x, y: J.y - S.y };
    const deltaE = { x: J.x - E.x, y: J.y - E.y };

    first.start = { x: J.x, y: J.y };
    first.c1 = { x: first.c1.x + deltaS.x, y: first.c1.y + deltaS.y };

    last.end = { x: J.x, y: J.y };
    last.c2 = { x: last.c2.x + deltaE.x, y: last.c2.y + deltaE.y };

    alignHandlesAtJunction(last, first, J, smoothMode);

    return copy;
}

function collapseMicroSegmentsInChain(chain, microTolPt, isClosed, smoothMode) {
    if (chain.length <= 1) return chain;

    let modified = true;
    let current = chain.map(cloneBezier);

    while (modified && current.length > 1) {
        modified = false;
        for (let i = 0; i < current.length; i++) {
            const seg = current[i];
            const len = approxBezierLength(seg);

            if (len < microTolPt && current.length > 1) {
                const mid = { x: (seg.start.x + seg.end.x) * 0.5, y: (seg.start.y + seg.end.y) * 0.5 };
                const deltaPrev = { x: mid.x - seg.start.x, y: mid.y - seg.start.y };
                const deltaNext = { x: mid.x - seg.end.x, y: mid.y - seg.end.y };

                const prevIdx = (i === 0) ? (isClosed ? current.length - 1 : -1) : i - 1;
                const nextIdx = (i === current.length - 1) ? (isClosed ? 0 : -1) : i + 1;

                if (prevIdx >= 0) {
                    current[prevIdx].end = { x: mid.x, y: mid.y };
                    current[prevIdx].c2 = {
                        x: current[prevIdx].c2.x + deltaPrev.x,
                        y: current[prevIdx].c2.y + deltaPrev.y
                    };
                }
                if (nextIdx >= 0) {
                    current[nextIdx].start = { x: mid.x, y: mid.y };
                    current[nextIdx].c1 = {
                        x: current[nextIdx].c1.x + deltaNext.x,
                        y: current[nextIdx].c1.y + deltaNext.y
                    };
                }

                if (prevIdx >= 0 && nextIdx >= 0) {
                    alignHandlesAtJunction(current[prevIdx], current[nextIdx], mid, smoothMode);
                }

                current.splice(i, 1);
                modified = true;
                break;
            }
        }
    }

    return current;
}

function buildChamferBridge(chainA, chainB) {
    const lastA = chainA[chainA.length - 1];
    const firstB = chainB[0];
    const E1 = lastA.end;
    const S2 = firstB.start;
    const gap = dist(E1, S2);

    if (gap < 1e-4) {
        return [...chainA, ...chainB];
    }

    const bridge = {
        start: { x: E1.x, y: E1.y },
        c1: { x: E1.x, y: E1.y },
        c2: { x: S2.x, y: S2.y },
        end: { x: S2.x, y: S2.y }
    };

    return [...chainA, bridge, ...chainB];
}

// =============================================================================
// SUBPATH EXTRACTION & PARSING
// =============================================================================

function extractAllSubpaths(doc) {
    const items = [];
    if (doc.selection.length === 0) return items;

    const primaryNode = doc.selection.at(0).node || doc.selection.at(0);
    const xfPrimary = primaryNode.transformInterface ? primaryNode.transformInterface.transform : null;
    const invPrimary = xfPrimary ? xfPrimary.inverted : null;

    for (let i = 0; i < doc.selection.length; i++) {
        const selItem = doc.selection.at(i);
        const node = selItem.node || selItem;
        if (!node || !node.curvesInterface) continue;

        let pc = null;
        try {
            pc = node.curvesInterface.polyCurve;
        } catch (e) {
            continue;
        }
        if (!pc || pc.curves.length === 0) continue;

        let xfToPrimary = null;
        if (node !== primaryNode && invPrimary) {
            const xfNode = node.transformInterface ? node.transformInterface.transform : null;
            if (xfNode) {
                xfToPrimary = invPrimary.multiply(xfNode);
            }
        }

        for (let cIdx = 0; cIdx < pc.curves.length; cIdx++) {
            const curve = pc.curves.at(cIdx);
            if (curve.pointCount < 2) continue;

            const beziers = [];
            for (const b of curve.beziers) {
                const bLocal = xfToPrimary ? b.transformed(xfToPrimary) : b.clone();
                beziers.push({
                    start: { x: bLocal.start.x, y: bLocal.start.y },
                    c1: { x: bLocal.c1.x, y: bLocal.c1.y },
                    c2: { x: bLocal.c2.x, y: bLocal.c2.y },
                    end: { x: bLocal.end.x, y: bLocal.end.y }
                });
            }

            if (beziers.length === 0) continue;

            const startPt = beziers[0].start;
            const endPt = beziers[beziers.length - 1].end;
            const isClosed = curve.isClosed || dist(startPt, endPt) < 1e-4;

            items.push({
                node,
                subpathIndex: cIdx,
                beziers,
                startPt,
                endPt,
                isClosed
            });
        }
    }
    return items;
}

// =============================================================================
// MASTER JOIN EXECUTION ENGINE (v1.2.1 Architecture)
// =============================================================================

function executeMasterJoin(allPaths, mode, smoothMode, gapTolerancePt, tension, autoClose) {
    const openPaths = allPaths.filter(p => !p.isClosed);
    const closedPaths = allPaths.filter(p => p.isClosed);

    const result = [];
    let operationsPerformed = 0;

    if (openPaths.length === 1 && closedPaths.length === 0) {
        const path = openPaths[0];
        let chain = path.beziers.map(cloneBezier);
        const endpointGap = dist(path.startPt, path.endPt);
        let closedFlag = false;

        if (mode === 0) {
            if (endpointGap <= gapTolerancePt && endpointGap > 1e-4) {
                const tExit = getExitTangent(chain);
                const tEntry = getEntryTangent(chain);
                const h = (endpointGap / 3.0) * tension;
                chain.push({
                    start: { x: chain[chain.length - 1].end.x, y: chain[chain.length - 1].end.y },
                    c1: { x: chain[chain.length - 1].end.x + tExit.x * h, y: chain[chain.length - 1].end.y + tExit.y * h },
                    c2: { x: chain[0].start.x - tEntry.x * h, y: chain[0].start.y - tEntry.y * h },
                    end: { x: chain[0].start.x, y: chain[0].start.y }
                });
                closedFlag = true;
                operationsPerformed++;
            }
        } else if (mode === 1 || mode === 2) {
            if (endpointGap <= gapTolerancePt) {
                chain = weldSingleOpenCurveEndpoints(chain, smoothMode);
                closedFlag = true;
                operationsPerformed++;
            }
            if (mode === 2) {
                const beforeCount = chain.length;
                chain = collapseMicroSegmentsInChain(chain, gapTolerancePt, closedFlag, smoothMode);
                if (chain.length < beforeCount) operationsPerformed++;
            }
        } else if (mode === 3) {
            const beforeCount = chain.length;
            chain = collapseMicroSegmentsInChain(chain, gapTolerancePt, false, smoothMode);
            if (chain.length < beforeCount) operationsPerformed++;
        } else if (mode === 4) {
            if (endpointGap <= gapTolerancePt && endpointGap > 1e-4) {
                chain.push({
                    start: { x: chain[chain.length - 1].end.x, y: chain[chain.length - 1].end.y },
                    c1: { x: chain[chain.length - 1].end.x, y: chain[chain.length - 1].end.y },
                    c2: { x: chain[0].start.x, y: chain[0].start.y },
                    end: { x: chain[0].start.x, y: chain[0].start.y }
                });
                closedFlag = true;
                operationsPerformed++;
            }
        }

        result.push({ beziers: chain, isClosed: closedFlag });
        return {
            success: operationsPerformed > 0,
            operationsCount: operationsPerformed,
            chains: result
        };
    }

    if (openPaths.length >= 2) {
        let activeChains = openPaths.map(p => p.beziers.map(cloneBezier));

        while (activeChains.length > 1) {
            let bestDist = Infinity;
            let bestI = -1;
            let bestJ = -1;
            let bestCase = -1;

            for (let i = 0; i < activeChains.length; i++) {
                const chainA = activeChains[i];
                const sA = chainA[0].start;
                const eA = chainA[chainA.length - 1].end;

                for (let j = i + 1; j < activeChains.length; j++) {
                    const chainB = activeChains[j];
                    const sB = chainB[0].start;
                    const eB = chainB[chainB.length - 1].end;

                    const d_EA_SB = dist(eA, sB);
                    const d_EA_EB = dist(eA, eB);
                    const d_SA_SB = dist(sA, sB);
                    const d_SA_EB = dist(sA, eB);

                    if (d_EA_SB < bestDist) { bestDist = d_EA_SB; bestI = i; bestJ = j; bestCase = 1; }
                    if (d_EA_EB < bestDist) { bestDist = d_EA_EB; bestI = i; bestJ = j; bestCase = 2; }
                    if (d_SA_SB < bestDist) { bestDist = d_SA_SB; bestI = i; bestJ = j; bestCase = 3; }
                    if (d_SA_EB < bestDist) { bestDist = d_SA_EB; bestI = i; bestJ = j; bestCase = 4; }
                }
            }

            if (bestDist > gapTolerancePt || bestI < 0) {
                break;
            }

            let chainA = activeChains[bestI];
            let chainB = activeChains[bestJ];

            if (bestCase === 2) {
                chainB = reverseChain(chainB);
            } else if (bestCase === 3) {
                chainA = reverseChain(chainA);
            } else if (bestCase === 4) {
                chainA = reverseChain(chainA);
                chainB = reverseChain(chainB);
            }

            let merged = null;
            if (mode === 0) {
                merged = buildSmoothBezierBridge(chainA, chainB, tension);
            } else if (mode === 1 || mode === 2) {
                merged = weldTwoChainsIntoOne(chainA, chainB, smoothMode);
                if (mode === 2) {
                    merged = collapseMicroSegmentsInChain(merged, gapTolerancePt, false, smoothMode);
                }
            } else if (mode === 4) {
                merged = buildChamferBridge(chainA, chainB);
            } else {
                merged = [...chainA, ...chainB];
            }

            activeChains.splice(bestJ, 1);
            activeChains[bestI] = merged;
            operationsPerformed++;
        }

        // Auto-close if requested (unchecked by default for 2 curves)
        for (let i = 0; i < activeChains.length; i++) {
            let ch = activeChains[i];
            let isClosed = false;
            const gap = dist(ch[0].start, ch[ch.length - 1].end);

            if (autoClose && gap <= gapTolerancePt) {
                if (mode === 0 && gap > 1e-4) {
                    const tExit = getExitTangent(ch);
                    const tEntry = getEntryTangent(ch);
                    const h = (gap / 3.0) * tension;
                    ch.push({
                        start: { x: ch[ch.length - 1].end.x, y: ch[ch.length - 1].end.y },
                        c1: { x: ch[ch.length - 1].end.x + tExit.x * h, y: ch[ch.length - 1].end.y + tExit.y * h },
                        c2: { x: ch[0].start.x - tEntry.x * h, y: ch[0].start.y - tEntry.y * h },
                        end: { x: ch[0].start.x, y: ch[0].start.y }
                    });
                    isClosed = true;
                    operationsPerformed++;
                } else if ((mode === 1 || mode === 2)) {
                    ch = weldSingleOpenCurveEndpoints(ch, smoothMode);
                    isClosed = true;
                    operationsPerformed++;
                } else if (mode === 4 && gap > 1e-4) {
                    ch.push({
                        start: { x: ch[ch.length - 1].end.x, y: ch[ch.length - 1].end.y },
                        c1: { x: ch[ch.length - 1].end.x, y: ch[ch.length - 1].end.y },
                        c2: { x: ch[0].start.x, y: ch[0].start.y },
                        end: { x: ch[0].start.x, y: ch[0].start.y }
                    });
                    isClosed = true;
                    operationsPerformed++;
                }
            }

            if (mode === 2 || mode === 3) {
                ch = collapseMicroSegmentsInChain(ch, gapTolerancePt, isClosed, smoothMode);
            }

            result.push({ beziers: ch, isClosed });
        }

        for (const cp of closedPaths) {
            let cChain = cp.beziers.map(cloneBezier);
            if (mode === 2 || mode === 3) {
                cChain = collapseMicroSegmentsInChain(cChain, gapTolerancePt, true, smoothMode);
            }
            result.push({ beziers: cChain, isClosed: true });
        }

        return {
            success: operationsPerformed > 0,
            operationsCount: operationsPerformed,
            chains: result
        };
    }

    if (closedPaths.length > 0) {
        for (const cp of closedPaths) {
            let cChain = cp.beziers.map(cloneBezier);
            const beforeCount = cChain.length;
            cChain = collapseMicroSegmentsInChain(cChain, gapTolerancePt, true, smoothMode);
            if (cChain.length < beforeCount) {
                operationsPerformed++;
            }
            result.push({ beziers: cChain, isClosed: true });
        }

        return {
            success: operationsPerformed > 0,
            operationsCount: operationsPerformed,
            chains: result
        };
    }

    return { success: false, operationsCount: 0, chains: [] };
}

// =============================================================================
// MAIN CONTROLLER
// =============================================================================

function runJoinCurvesPro() {
    const doc = Document.current || (Document.all.length > 0 ? Document.all[0] : null);
    if (!doc) {
        const dlg = Dialog.create("Join Curves Pro");
        const col = dlg.addColumn();
        const grp = col.addGroup("Notice");
        grp.addStaticText("Status", "No active document found. Please open a document with vector curves.");
        dlg.runModal();
        return;
    }

    if (doc.selection.length === 0) {
        const dlg = Dialog.create("Join Curves Pro");
        const col = dlg.addColumn();
        const grp = col.addGroup("Notice");
        grp.addStaticText("Status", "No curves selected. Please select at least 1 curve with vector nodes.");
        dlg.runModal();
        return;
    }

    const allSubpaths = extractAllSubpaths(doc);
    if (allSubpaths.length === 0) {
        const dlg = Dialog.create("Join Curves Pro");
        const col = dlg.addColumn();
        const grp = col.addGroup("Notice");
        grp.addStaticText("Status", "No vector nodes found in selection. Ensure the selected layers are Curves.");
        dlg.runModal();
        return;
    }

    const openSubpaths = allSubpaths.filter(p => !p.isClosed);
    const closedSubpaths = allSubpaths.filter(p => p.isClosed);

    let minGapPt = Infinity;
    let minSegPt = Infinity;

    for (const p of allSubpaths) {
        for (const b of p.beziers) {
            const len = approxBezierLength(b);
            if (len < minSegPt) minSegPt = len;
        }
    }

    if (openSubpaths.length >= 2) {
        for (let i = 0; i < openSubpaths.length; i++) {
            for (let j = i + 1; j < openSubpaths.length; j++) {
                const pA = openSubpaths[i], pB = openSubpaths[j];
                minGapPt = Math.min(minGapPt,
                    dist(pA.endPt, pB.startPt),
                    dist(pA.endPt, pB.endPt),
                    dist(pA.startPt, pB.startPt),
                    dist(pA.startPt, pB.endPt)
                );
            }
        }
    } else if (openSubpaths.length === 1) {
        minGapPt = dist(openSubpaths[0].startPt, openSubpaths[0].endPt);
    }

    const relevantDistanceMm = isFinite(minGapPt) ? (minGapPt * PT_TO_MM) : (isFinite(minSegPt) ? minSegPt * PT_TO_MM : 2.0);
    const initialToleranceMm = Math.max(1.0, Math.ceil(relevantDistanceMm * 1.5 * 10) / 10);

    const primaryNode = allSubpaths[0].node;
    const secondaryNodesMap = new Map();
    for (let i = 1; i < allSubpaths.length; i++) {
        const n = allSubpaths[i].node;
        if (n !== primaryNode) {
            secondaryNodesMap.set(n.handle, n);
        }
    }
    const secondaryNodes = Array.from(secondaryNodesMap.values());

    // -------------------------------------------------------------------------
    // DIALOG SETUP
    // -------------------------------------------------------------------------
    const dlg = Dialog.create("Join Curves Pro");
    const col = dlg.addColumn();

    const grpMode = col.addGroup("Join Operation");
    const modeItems = [
        "Smooth Bézier Bridge (Draw Connecting Curve)",
        "Weld Nodes into One (No Lines Drawn - Corel Style)",
        "Weld Nodes + Delete Micro-Segments (Plotter Clean)",
        "Delete Micro-Segments Only (Keep Open)",
        "Chamfer (Straight Line)"
    ];
    // Smooth Bézier Bridge is DEFAULT (index 0)
    const comboMode = grpMode.addComboBox("Mode", modeItems, 0);

    const grpSmooth = col.addGroup("Junction Smoothness");
    const smoothItems = [
        "Auto-Smooth (< 60° smooth, >= 60° sharp corner)",
        "Always Smooth (Continuous Plotter Cut)",
        "Keep Corner Sharp (Preserve Original Angles)"
    ];
    const comboSmooth = grpSmooth.addComboBox("Smoothness", smoothItems, 0);

    const grpSettings = col.addGroup("Parameters");
    const gapEditor = grpSettings.addUnitValueEditor("Tolerance Gap", UnitType.Millimeters, UnitType.Millimeters, initialToleranceMm, 0.01, 1000.0);
    gapEditor.setShowPopupSlider(true);

    const tensionEditor = grpSettings.addUnitValueEditor("Bézier Tension", UnitType.None, UnitType.None, 1.0, 0.1, 3.0);
    tensionEditor.setShowPopupSlider(true);
    tensionEditor.setPrecision(2);

    // v1.2.1 behavior: false for 2 curves so only the closest pair is joined
    const chkAutoClose = grpSettings.addCheckBox("Auto-Close opposite ends if within tolerance", openSubpaths.length <= 1);
    const chkPreview = grpSettings.addCheckBox("Live Preview", true);

    const grpInfo = col.addGroup("Geometry Info");
    if (openSubpaths.length === 1) {
        grpInfo.addStaticText("Selection", "1 Open Curve (" + openSubpaths[0].beziers.length + " segments)");
        grpInfo.addStaticText("Endpoint Gap", (minGapPt * PT_TO_MM).toFixed(3) + " mm (" + minGapPt.toFixed(2) + " pt)");
    } else if (openSubpaths.length >= 2) {
        grpInfo.addStaticText("Selection", openSubpaths.length + " Open Curves");
        grpInfo.addStaticText("Closest Gap", (minGapPt * PT_TO_MM).toFixed(3) + " mm (" + minGapPt.toFixed(2) + " pt)");
    } else {
        grpInfo.addStaticText("Selection", closedSubpaths.length + " Closed Curve(s)");
        grpInfo.addStaticText("Shortest Segment", (minSegPt * PT_TO_MM).toFixed(3) + " mm");
    }

    // -------------------------------------------------------------------------
    // PREVIEW & ATOMIC HISTORY MANAGEMENT
    // -------------------------------------------------------------------------
    let previewApplied = false;

    function applyJoinToDocument() {
        const mode = comboMode.selectedIndex;
        const smoothMode = comboSmooth.selectedIndex;
        const tolerancePt = (gapEditor.value || initialToleranceMm) * MM_TO_PT;
        const tension = tensionEditor.value || 1.0;
        const autoClose = chkAutoClose.value;

        const joinResult = executeMasterJoin(allSubpaths, mode, smoothMode, tolerancePt, tension, autoClose);
        if (!joinResult.success || joinResult.chains.length === 0) {
            return false;
        }

        const newPolyCurve = new PolyCurve();
        for (let i = 0; i < joinResult.chains.length; i++) {
            const chain = joinResult.chains[i].beziers;
            const isClosed = joinResult.chains[i].isClosed;
            if (chain.length === 0) continue;

            const cb = CurveBuilder.create();
            cb.begin(chain[0].start);
            for (let j = 0; j < chain.length; j++) {
                const b = chain[j];
                cb.addBezier(b.c1, b.c2, b.end);
            }
            if (isClosed) {
                cb.close();
            }

            const c = cb.createCurve();
            newPolyCurve.addCurve(c);
        }

        const ccb = CompoundCommandBuilder.create();
        ccb.addCommand(DocumentCommand.createSetCurves(primaryNode.curvesInterface, newPolyCurve));

        if (secondaryNodes.length > 0) {
            const selDelete = Selection.create(doc);
            for (const secNode of secondaryNodes) {
                selDelete.add(secNode);
            }
            ccb.addCommand(DocumentCommand.createDeleteSelection(selDelete));
        }

        doc.executeCommand(ccb.createCommand());
        return true;
    }

    function updatePreview() {
        if (previewApplied) {
            doc.undo();
            previewApplied = false;
        }

        if (chkPreview.value) {
            const ok = applyJoinToDocument();
            if (ok) {
                previewApplied = true;
            }
        }
    }

    dlg.setOnControlValueChangedHandler((ctrl) => {
        updatePreview();
    });

    if (chkPreview.value) {
        updatePreview();
    }

    const dialogResult = dlg.runModal();

    if (dialogResult === DialogResult.Ok) {
        if (!previewApplied) {
            applyJoinToDocument();
        }
    } else {
        if (previewApplied) {
            doc.undo();
            previewApplied = false;
        }
    }
}

// Run
runJoinCurvesPro();
