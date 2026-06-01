'use strict';

const { Document } = require('/document');
const {
    DocumentCommand,
    NodeChildType,
    NodeMoveType
} = require('/commands');
const { Selection } = require('/selections');
const { Transform, unionRects } = require('/geometry');

function sameNode(a, b) {
    return a && b && a.isSameNode(b);
}

function getTopLevelSelectedNodes(document) {
    const selectedNodes = document.selection.nodes.toArray();
    return Selection.create(document, selectedNodes, true).nodes.toArray();
}

function getBounds(nodes) {
    let bounds = null;

    for (const node of nodes) {
        const nodeBounds = node.getSpreadBaseBox(false);
        bounds = bounds ? unionRects(bounds, nodeBounds) : nodeBounds;
    }

    return bounds;
}

function getNodePageIndex(node) {
    return getPageIndexForBounds(node.spread, node.getSpreadBaseBox(false));
}

function getPageIndexForBounds(spread, bounds) {
    if (spread.pageCount <= 1) {
        return spread.firstPageIndex;
    }

    const spreadBox = spread.baseBox;
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    const isHorizontalSpread = spreadBox.width >= spreadBox.height;
    let localPageIndex;

    if (isHorizontalSpread) {
        const pageWidth = spreadBox.width / spread.pageCount;
        localPageIndex = Math.floor((centerX - spreadBox.x) / pageWidth);
    }
    else {
        const pageHeight = spreadBox.height / spread.pageCount;
        localPageIndex = Math.floor((centerY - spreadBox.y) / pageHeight);
    }

    localPageIndex = Math.max(0, Math.min(spread.pageCount - 1, localPageIndex));
    return spread.firstPageIndex + localPageIndex;
}

function getSpreadForPage(document, pageIndex) {
    for (const spread of document.spreads) {
        if (spread.firstPageIndex <= pageIndex && spread.lastPageIndex >= pageIndex) {
            return spread;
        }
    }
    return null;
}

function walkNodes(node, callback) {
    callback(node);

    try {
        for (const child of node.children) {
            walkNodes(child, callback);
        }
    }
    catch (e) {
        // Some nodes do not expose children.
    }
}

function getPageContentEdges(spread) {
    const edgesByPage = {};

    for (const child of spread.children) {
        walkNodes(child, node => {
            if (!node.isVisible) {
                return;
            }

            let bounds;
            try {
                bounds = node.getSpreadBaseBox(false);
            }
            catch (e) {
                return;
            }

            if (!bounds || bounds.width === 0 && bounds.height === 0) {
                return;
            }

            const pageIndex = getPageIndexForBounds(spread, bounds);
            let edges = edgesByPage[pageIndex];
            if (!edges) {
                edges = edgesByPage[pageIndex] = {
                    minX: bounds.x,
                    maxX: bounds.x + bounds.width,
                    minY: bounds.y,
                    maxY: bounds.y + bounds.height
                };
            }
            else {
                edges.minX = Math.min(edges.minX, bounds.x);
                edges.maxX = Math.max(edges.maxX, bounds.x + bounds.width);
                edges.minY = Math.min(edges.minY, bounds.y);
                edges.maxY = Math.max(edges.maxY, bounds.y + bounds.height);
            }
        });
    }

    return edgesByPage;
}

function millimetresToPixels(document, value) {
    return value * document.dpi / 25.4;
}

function getCurrentDocumentMargins(document) {
    const candidates = [
        document.properties,
        document.documentProperties,
        document.documentPropertiesInterface,
        document.rootNode && document.rootNode.properties,
        document.rootNode && document.rootNode.documentProperties
    ];

    for (const properties of candidates) {
        if (!properties) {
            continue;
        }

        const includeMargins = properties.includeMargins ?? properties.marginsEnabled ?? properties.useMargins;
        const margins = properties.margin ?? properties.margins;
        if (!includeMargins || !margins) {
            continue;
        }

        const left = Number(margins.left);
        const right = Number(margins.right);
        const top = Number(margins.top);
        const bottom = Number(margins.bottom);
        if ([left, right, top, bottom].some(value => !Number.isFinite(value) || value < 0)) {
            continue;
        }

        if (left === 0 && right === 0 && top === 0 && bottom === 0) {
            continue;
        }

        return { left, right, top, bottom };
    }

    return null;
}

function getPhysicalMarginsForPage(document, spread, pageIndex) {
    const margins = getCurrentDocumentMargins(document);
    if (!margins) {
        return null;
    }

    if (spread.pageCount <= 1) {
        return margins;
    }

    const spreadBox = spread.baseBox;
    const isHorizontalSpread = spreadBox.width >= spreadBox.height;
    if (!isHorizontalSpread) {
        return margins;
    }

    const localPageIndex = pageIndex - spread.firstPageIndex;
    const isLeftPage = localPageIndex === 0;

    return {
        left: isLeftPage ? margins.right : margins.left,
        right: isLeftPage ? margins.left : margins.right,
        top: margins.top,
        bottom: margins.bottom
    };
}

function getMarginBox(document, spread, pageIndex, pageBox) {
    const margins = getPhysicalMarginsForPage(document, spread, pageIndex);
    if (!margins) {
        return null;
    }

    const width = pageBox.width - margins.left - margins.right;
    const height = pageBox.height - margins.top - margins.bottom;
    if (width <= 0 || height <= 0) {
        return null;
    }

    return {
        x: pageBox.x + margins.left,
        y: pageBox.y + margins.top,
        width,
        height
    };
}

function getPropertyMarginCompensation(document, sourceSpread, sourcePageIndex, sourcePageBox, targetSpread, targetPageIndex, targetPageBox, offsetX, offsetY) {
    const sourceMarginBox = getMarginBox(document, sourceSpread, sourcePageIndex, sourcePageBox);
    const targetMarginBox = getMarginBox(document, targetSpread, targetPageIndex, targetPageBox);

    if (!sourceMarginBox || !targetMarginBox) {
        return null;
    }

    return {
        x: targetMarginBox.x - sourceMarginBox.x - offsetX,
        y: targetMarginBox.y - sourceMarginBox.y - offsetY
    };
}

function getDetectedMarginCompensation(document, sourceSpread, sourcePageIndex, targetSpread, targetPageIndex, offsetX, offsetY) {
    if (!sameNode(sourceSpread, targetSpread)) {
        return { x: 0, y: 0 };
    }

    const edges = getPageContentEdges(sourceSpread);
    const sourceEdges = edges[sourcePageIndex];
    const targetEdges = edges[targetPageIndex];
    if (!sourceEdges || !targetEdges) {
        return { x: 0, y: 0 };
    }

    const maxMarginShift = millimetresToPixels(document, 50);
    const horizontalMove = Math.abs(offsetX) >= Math.abs(offsetY);

    if (horizontalMove) {
        const leftShift = targetEdges.minX - sourceEdges.minX - offsetX;
        const rightShift = targetEdges.maxX - sourceEdges.maxX - offsetX;
        if (Math.abs(leftShift) > maxMarginShift || Math.abs(rightShift) > maxMarginShift) {
            return { x: 0, y: 0 };
        }

        if (Math.abs(leftShift - rightShift) > 2) {
            return { x: 0, y: 0 };
        }

        return { x: (leftShift + rightShift) / 2, y: 0 };
    }

    const topShift = targetEdges.minY - sourceEdges.minY - offsetY;
    const bottomShift = targetEdges.maxY - sourceEdges.maxY - offsetY;
    if (Math.abs(topShift) > maxMarginShift || Math.abs(bottomShift) > maxMarginShift) {
        return { x: 0, y: 0 };
    }

    if (Math.abs(topShift - bottomShift) > 2) {
        return { x: 0, y: 0 };
    }

    return { x: 0, y: (topShift + bottomShift) / 2 };
}

function getMarginCompensation(document, sourceSpread, sourcePageIndex, sourcePageBox, targetSpread, targetPageIndex, targetPageBox, offsetX, offsetY) {
    const propertyCompensation = getPropertyMarginCompensation(
        document,
        sourceSpread,
        sourcePageIndex,
        sourcePageBox,
        targetSpread,
        targetPageIndex,
        targetPageBox,
        offsetX,
        offsetY
    );

    if (propertyCompensation) {
        return propertyCompensation;
    }

    return getDetectedMarginCompensation(
        document,
        sourceSpread,
        sourcePageIndex,
        targetSpread,
        targetPageIndex,
        offsetX,
        offsetY
    );
}

function createSinglePageBox(spread) {
    return {
        x: spread.baseBox.x,
        y: spread.baseBox.y,
        width: spread.baseBox.width,
        height: spread.baseBox.height
    };
}

function splitSpreadIntoPageBoxes(spread, vertical) {
    const spreadBox = spread.baseBox;
    const pageBoxes = [];
    const pageWidth = vertical ? spreadBox.width : spreadBox.width / spread.pageCount;
    const pageHeight = vertical ? spreadBox.height / spread.pageCount : spreadBox.height;

    for (let localPageIndex = 0; localPageIndex < spread.pageCount; ++localPageIndex) {
        pageBoxes[spread.firstPageIndex + localPageIndex] = {
            x: spreadBox.x + (vertical ? 0 : localPageIndex * pageWidth),
            y: spreadBox.y + (vertical ? localPageIndex * pageHeight : 0),
            width: pageWidth,
            height: pageHeight
        };
    }

    return pageBoxes;
}

function hasEveryPageBox(pageBoxes, spread) {
    for (let i = spread.firstPageIndex; i <= spread.lastPageIndex; ++i) {
        if (!pageBoxes[i]) {
            return false;
        }
    }
    return true;
}

function getPageBox(spread, documentPageIndex) {
    const localPageIndex = documentPageIndex - spread.firstPageIndex;

    if (localPageIndex < 0 || localPageIndex >= spread.pageCount) {
        throw new Error('The requested page is not on the supplied spread.');
    }

    if (spread.pageCount === 1) {
        return createSinglePageBox(spread);
    }

    const isVerticalSpread = spread.baseBox.height > spread.baseBox.width;
    const pageBoxes = splitSpreadIntoPageBoxes(spread, isVerticalSpread);
    if (hasEveryPageBox(pageBoxes, spread)) {
        return pageBoxes[documentPageIndex];
    }

    throw new Error('Could not determine the page boxes for this spread.');
}

function getAutomaticTargetPage(document, sourcePageIndex) {
    const sourcePageNumber = sourcePageIndex + 1;

    if (sourcePageNumber === 1 && document.pageCount > 1) {
        return 1;
    }

    if (sourcePageNumber % 2 === 0) {
        if (sourcePageIndex + 1 < document.pageCount) {
            return sourcePageIndex + 1;
        }
        return sourcePageIndex > 0 ? sourcePageIndex - 1 : null;
    }

    if (sourcePageIndex - 1 >= 0) {
        return sourcePageIndex - 1;
    }

    return sourcePageIndex + 1 < document.pageCount ? sourcePageIndex + 1 : null;
}

function moveNodesToSpread(document, nodes, targetSpread) {
    const moveSelection = Selection.create(document, nodes, true);
    const moveCommand = DocumentCommand.createMoveNodes(
        moveSelection,
        targetSpread,
        NodeMoveType.Inside,
        NodeChildType.Main
    );
    document.executeCommand(moveCommand);
}

function copySelectionToOtherPage(document, nodes) {
    const sourceSpread = nodes[0].spread;
    const sourceBounds = getBounds(nodes);
    const sourcePageIndex = getPageIndexForBounds(sourceSpread, sourceBounds);
    const targetPageIndex = getAutomaticTargetPage(document, sourcePageIndex);

    if (targetPageIndex == null) {
        alert('This document has no other page to copy to.');
        return;
    }

    const targetSpread = getSpreadForPage(document, targetPageIndex);
    if (!targetSpread) {
        alert('Could not find the target spread.');
        return;
    }

    const sourcePageBox = getPageBox(sourceSpread, sourcePageIndex);
    const targetPageBox = getPageBox(targetSpread, targetPageIndex);
    let offsetX = targetPageBox.x - sourcePageBox.x;
    let offsetY = targetPageBox.y - sourcePageBox.y;
    const marginCompensation = getMarginCompensation(
        document,
        sourceSpread,
        sourcePageIndex,
        sourcePageBox,
        targetSpread,
        targetPageIndex,
        targetPageBox,
        offsetX,
        offsetY
    );
    offsetX += marginCompensation.x;
    offsetY += marginCompensation.y;

    const sourceSelection = Selection.create(document, nodes, true);
    const duplicateCommand = DocumentCommand.createTransform(
        sourceSelection,
        Transform.createTranslate(offsetX, offsetY),
        { duplicateNodes: true }
    );

    document.executeCommand(duplicateCommand);

    const duplicatedNodes = duplicateCommand.newNodes;
    if (duplicatedNodes.length === 0) {
        alert('The selected objects could not be duplicated.');
        return;
    }

    if (!sameNode(duplicatedNodes[0].spread, targetSpread)) {
        moveNodesToSpread(document, duplicatedNodes, targetSpread);
    }

    document.selection = Selection.create(document, duplicatedNodes, true);
}

function main() {
    const document = Document.current;
    if (!document) {
        alert('This script requires an open document.');
        return;
    }

    if (document.hasArtboards) {
        alert('This script works with page documents, not artboard documents.');
        return;
    }

    const nodes = getTopLevelSelectedNodes(document);
    if (nodes.length === 0) {
        alert('Select one or more objects first.');
        return;
    }

    const sourceSpread = nodes[0].spread;
    const sourceBounds = getBounds(nodes);
    const sourcePageIndex = getPageIndexForBounds(sourceSpread, sourceBounds);

    for (const node of nodes) {
        if (!sameNode(node.spread, sourceSpread)) {
            alert('All selected objects must be on the same spread.');
            return;
        }

        const nodePageIndex = getNodePageIndex(node);
        if (nodePageIndex !== sourcePageIndex) {
            alert('All selected objects must be centered on the same page.');
            return;
        }
    }

    copySelectionToOtherPage(document, nodes);
}

module.exports.main = main;
main();