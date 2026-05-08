/**
 * combine4braille_affinity.js
 * Affinity Publisher (Canva) SDK Script
 *
 * Combines all text frames in the document into a single text file,
 * ordered for braille preparation:
 *
 *   Pages are walked in absolute page order (spread.firstPageIndex +
 *   getPageIndexOfBox). On each page:
 *     1. Multi-frame stories that START on this page are output in full
 *        (once only, deduplicated by story handle).
 *     2. Single-frame text nodes on this page follow, sorted
 *        top→bottom then left→right.
 *   Pasteboard items (x < -200 or x > pageWidth + 200) are skipped.
 *   Blocks are separated by a double paragraph break.
 *
 *   Output: Desktop\combine4braille_output.txt
 *
 * HOW TO RUN:
 *   Window > General > Scripts — paste and run, or save to script library.
 */

"use strict";

var Document = require("/document").Document;
var app = require("/application").app;
var Nodes = require("/nodes");

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function isBlank(s) {
  return !s || /^\s*$/.test(s);
}

function getNodeText(node) {
  try {
    var t = node.text;
    if (typeof t === "string") return t.replace(/[\n\r\s]+$/, "");
  } catch (e) {}
  try {
    var t2 = node.storyInterface.text;
    if (typeof t2 === "string") return t2.replace(/[\n\r\s]+$/, "");
  } catch (e) {}
  return "";
}

function getFullStoryText(node) {
  try {
    var t = node.storyInterface.story.text;
    if (typeof t === "string") return t.replace(/[\n\r\s]+$/, "");
  } catch (e) {}
  return getNodeText(node);
}

function isMultiFrame(node) {
  try {
    return node.storyInterface.isMultiFrameTextFlow === true;
  } catch (e) {
    return false;
  }
}

// Story identity key: story.length is unique per story.
// Two frames in the same threaded story share the same story.length.
// We also check rangeBegin to only output on the FIRST frame of a story.
function storyInfo(node) {
  try {
    var si = node.storyInterface;
    var st = si.story;
    var sr = si.storyRange;
    return {
      key: String(st.length),
      isFirst: sr.begin === 0,
      storyLen: st.length,
    };
  } catch (e) {
    return null;
  }
}

// ─── NODE COLLECTION ──────────────────────────────────────────────────────────

/**
 * Recursively collect all FrameTextNode and ArtTextNode objects
 * within a node's subtree.
 */
function collectTextNodes(node, results, depth) {
  if (depth > 8) return;
  try {
    var typed = Nodes.createTypedNode(node.handle);
    if (typed.isFrameTextNode || typed.isArtTextNode) {
      results.push(typed);
      return; // don't recurse into text nodes
    }
    for (var child of node.children) {
      collectTextNodes(child, results, depth + 1);
    }
  } catch (e) {
    // createTypedNode failed — try walking children directly
    try {
      for (var child of node.children) {
        collectTextNodes(child, results, depth + 1);
      }
    } catch (e2) {}
  }
}

// ─── PASTEBOARD DETECTION ─────────────────────────────────────────────────────

/**
 * Estimate page width from the first spread that has a normal-looking
 * page box (x >= 0 and width > 0).
 * Falls back to 5200 (typical magazine page in Affinity units).
 */
function estimatePageWidth(doc) {
  try {
    for (var spread of doc.spreads) {
      // A single-page spread: find a text node on the page
      for (var child of spread.children) {
        var nodes = [];
        collectTextNodes(child, nodes, 0);
        for (var i = 0; i < nodes.length; i++) {
          try {
            var box = nodes[i].getSpreadBaseBox();
            // A legitimate on-page frame has x >= 0 and reasonable width
            if (box && box.x >= 0 && box.width > 100) {
              // page width ≈ box.x + box.width (rough upper bound)
              // Better: use getPageIndexOfBox to find page boundary
              return box.x + box.width + 500; // generous estimate
            }
          } catch (e) {}
        }
      }
    }
  } catch (e) {}
  return 6000; // safe fallback
}

/**
 * Returns true if the node's bounding box is on the pasteboard
 * (clearly outside the page area).
 * Pasteboard items have strongly negative x or very large x.
 * Threshold: more than 200 units outside [0, pageWidth].
 */
function isOnPasteboard(box, pageWidth) {
  if (!box) return false;
  var MARGIN = 200;
  if (box.x < -MARGIN) return true;
  if (box.x > pageWidth + MARGIN) return true;
  return false;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

function main() {
  var doc = Document.current;
  if (!doc) {
    alert("No document is open.");
    return;
  }

  var docTitle = doc.title || "document";

  var go = app.confirm(
    "combine4braille\n\n" +
      'Combine all text from "' +
      docTitle +
      '" into a\n' +
      "single text file for braille preparation?\n\n" +
      "Output: Desktop\\combine4braille_output.txt",
  );
  if (!go) return;

  // Estimate page width for pasteboard detection
  var pageWidth = estimatePageWidth(doc);

  // ── Collect all text nodes across all spreads ──────────────────────────────
  // We build a flat list of {node, absolutePageIdx, box} then sort by page,
  // then by position within page.

  var allEntries = []; // {node, absPage, box, spreadRef}
  var spreadIdx = 0;

  for (var spread of doc.spreads) {
    var firstPageIdx = spread.firstPageIndex;

    // Collect all text nodes on this spread
    var textNodes = [];
    try {
      for (var child of spread.children) {
        collectTextNodes(child, textNodes, 0);
      }
    } catch (e) {}

    for (var i = 0; i < textNodes.length; i++) {
      var node = textNodes[i];
      try {
        var box = node.getSpreadBaseBox();
        if (!box) continue;

        // Skip pasteboard items
        if (isOnPasteboard(box, pageWidth)) continue;

        // Get page index within this spread (0-based within spread)
        var pageInSpread = 0;
        try {
          pageInSpread = spread.getPageIndexOfBox(box);
          if (pageInSpread < 0) pageInSpread = 0;
        } catch (e) {}

        var absPage = firstPageIdx + pageInSpread;

        allEntries.push({
          node: node,
          absPage: absPage,
          spreadRef: spread,
          box: box,
        });
      } catch (e) {}
    }

    spreadIdx++;
  }

  if (allEntries.length === 0) {
    alert("No text frames found.");
    return;
  }

  // ── Sort by absolute page, then top→bottom, left→right ────────────────────
  allEntries.sort(function (a, b) {
    if (a.absPage !== b.absPage) return a.absPage - b.absPage;
    // Same page: sort by y first, then x
    var dy = a.box.y - b.box.y;
    if (Math.abs(dy) > 4) return dy;
    return a.box.x - b.box.x;
  });

  // ── Assemble output ────────────────────────────────────────────────────────
  // Strategy: deduplicate by story key. If two nodes share the same story
  // (threaded text flow), output the FULL story text only on the first page
  // it appears. Single-frame stories output their own text as captions.
  var blocks = [];
  var seenStoryKeys = {}; // storyKey -> true (already output)
  var pageCapCount = {}; // pageLabel -> caption count

  for (var ei = 0; ei < allEntries.length; ei++) {
    var entry = allEntries[ei];
    var node = entry.node;
    var absPage = entry.absPage;
    var pageLabel = String(absPage + 1); // 1-based for display

    // Deduplicate using story.length as key.
    // Only output a story on its FIRST frame (rangeBegin === 0).
    var si = storyInfo(node);
    if (si !== null) {
      // Skip if not the first frame of this story
      if (!si.isFirst) continue;
      // Skip if we've already output a story with this length
      // (handles edge case of two stories with same length)
      if (seenStoryKeys[si.key]) continue;
      seenStoryKeys[si.key] = true;
    }

    // Get the full story text (works for both single and multi-frame)
    var text = getFullStoryText(node);
    if (isBlank(text)) continue;

    // Multi-frame story: storyLen > rangeEnd of this frame (more text exists)
    // OR text is long (> 500 chars). Otherwise it's a caption.
    var isStory = false;
    if (si !== null && si.storyLen > 500) isStory = true;
    else if (text.length > 500) isStory = true;
    var label;

    if (isStory) {
      label = "[Page " + pageLabel + " \u2014 Story]";
    } else {
      if (!pageCapCount[pageLabel]) pageCapCount[pageLabel] = 0;
      pageCapCount[pageLabel]++;
      label =
        "[Page " +
        pageLabel +
        " \u2014 Caption " +
        pageCapCount[pageLabel] +
        "]";
    }

    blocks.push(label + "  " + text);
  }

  if (blocks.length === 0) {
    alert("No text content found after filtering.");
    return;
  }

  var combinedText = blocks.join("\n\n");

  // ── Write output ───────────────────────────────────────────────────────────
  // Write directly to Desktop using Affinity's File API
  try {
    var File = require("/fs").File;
    var outPath = app.getUserDesktopPath + "\\combine4braille_output.txt";
    var fout = new File(outPath, "w");
    fout.writeString(combinedText);
    fout.close();
    alert(
      "Done!\n\n" +
        blocks.length +
        " text blocks saved to:\n" +
        outPath +
        "\n\nOpen in Word before sending for braille.",
    );
  } catch (writeErr) {
    alert(
      "File write failed: " +
        writeErr.message +
        "\n\nFirst 500 chars:\n" +
        combinedText.substring(0, 500),
    );
  }
}

main();
