/**
 * name: Group Cleanup
 * description: Deletes empty groups and releases plain single-item groups.
 * version: 1.1.0
 * author: BlackMortimer-13, hellsfaun
 * based-on: DeleteEmptyGroups by BlackMortimer-13
 */

const { Document } = require("/document");
const { BlendMode } = require("/blendmodeinterface");
const { DocumentCommand, NodeMoveType } = require("/commands");
const { Dialog } = require("/dialog");
const { getNodeChildrenRecursive, NodeChildType } = require("/nodes");
const { Selection } = require("/selections");

const doc = Document.current;
if (!doc) {
  console.log("ERROR: No document open");
} else {
  let totalDeleted = 0;
  let totalReleased = 0;
  let totalPreserved = 0;
  let totalReleaseFailed = 0;
  let finalPreserveReasonCounts = {};
  let pass = 0;
  let keepGoing = true;
  let stoppedAtSafetyCap = false;

  function getNodeName(node) {
    return (
      node.description ||
      node.userDescription ||
      (node.isGroupNode ? "Group" : "Container")
    );
  }

  function getMainChildCount(node, maxCount) {
    let count = 0;
    for (const child of node.children) {
      count++;
      if (count >= maxCount) break;
    }
    return count;
  }

  function isEmptyGroupOrContainer(node) {
    return (node.isGroupNode || node.isContainerNode) && !node.firstChild;
  }

  function isGroupLikeNode(node) {
    return node.isGroupNode || node.isContainerNode;
  }

  function hasAnyChild(node, childType) {
    return node.getFirstChild(childType) !== null;
  }

  function inspectPreserveReason(node, label, callback) {
    try {
      return callback() ? label : null;
    } catch (err) {
      console.log(
        "    Could not inspect " +
          label +
          " on " +
          getNodeName(node) +
          ": " +
          err,
      );
      return "inspection failed: " + label;
    }
  }

  function getPreserveReasons(node) {
    const reasons = [];

    const checks = [
      inspectPreserveReason(node, "active/visible layer effects", () => {
        const effects = node.layerEffectsInterface;
        return effects.hasActiveEffects || effects.hasAnyVisibleEffects;
      }),
      inspectPreserveReason(node, "global opacity", () => {
        return node.globalOpacity !== 1;
      }),
      inspectPreserveReason(node, "fill opacity", () => {
        return node.fillOpacity !== 1;
      }),
      inspectPreserveReason(node, "non-normal blend mode", () => {
        return node.blendMode.value !== BlendMode.Normal.value;
      }),
      inspectPreserveReason(node, "transparency", () => {
        return !node.transparencyInterface.isTransparencyNone;
      }),
      inspectPreserveReason(node, "hidden visibility", () => {
        return !node.isVisible;
      }),
      inspectPreserveReason(node, "export-hidden visibility", () => {
        return !node.isVisibleInExport;
      }),
      inspectPreserveReason(node, "mask/clip enclosure", () => {
        return hasAnyChild(node, NodeChildType.Enclosure);
      }),
      inspectPreserveReason(node, "locked/not locally editable", () => {
        return !node.isLocalEditable;
      }),
    ];

    for (const reason of checks) {
      if (reason) reasons.push(reason);
    }

    return reasons;
  }

  function getSingleItemGroupDecision(node) {
    if (!isGroupLikeNode(node) || getMainChildCount(node, 2) !== 1) {
      return null;
    }

    const preserveReasons = getPreserveReasons(node);
    return {
      node,
      name: getNodeName(node),
      preserveReasons,
    };
  }

  function isSingleItemGroup(node) {
    const decision = getSingleItemGroupDecision(node);
    return decision !== null && decision.preserveReasons.length === 0;
  }

  function incrementReasonCount(reasonCounts, reason) {
    if (reasonCounts[reason] == null) {
      reasonCounts[reason] = 0;
    }
    reasonCounts[reason]++;
  }

  function formatReasons(reasons) {
    return reasons.join(", ");
  }

  function formatReasonCounts(reasonCounts) {
    const parts = [];
    for (const reason of Object.keys(reasonCounts)) {
      parts.push(reason + ": " + reasonCounts[reason]);
    }
    return parts.join("; ");
  }

  function getReportReasonLabel(reason) {
    switch (reason) {
      case "active/visible layer effects":
        return "FX / layer effects";
      case "global opacity":
      case "fill opacity":
        return "Opacity";
      case "non-normal blend mode":
        return "Blend mode";
      case "transparency":
        return "Transparency";
      case "hidden visibility":
      case "export-hidden visibility":
        return "Visibility";
      case "mask/clip enclosure":
        return "Mask or clip";
      case "locked/not locally editable":
        return "Locked";
      default:
        if (reason.indexOf("inspection failed: ") === 0) {
          return "Inspection failed";
        }
        return reason;
    }
  }

  function getTopReportReasons(reasonCounts, limit) {
    const reportCounts = {};
    for (const reason of Object.keys(reasonCounts)) {
      const label = getReportReasonLabel(reason);
      if (reportCounts[label] == null) {
        reportCounts[label] = 0;
      }
      reportCounts[label] += reasonCounts[reason];
    }

    return Object.keys(reportCounts)
      .sort((a, b) => reportCounts[b] - reportCounts[a])
      .slice(0, limit)
      .map((label) => ({ label, count: reportCounts[label] }));
  }

  function addReportRow(group, label, count) {
    group.addStaticText(label, String(count));
  }

  function showPlainReport() {
    const lines = [
      "Group Cleanup",
      "",
      "Deleted empty groups: " + totalDeleted,
      "Released plain single-item: " + totalReleased,
      "Preserved protected single-item: " + totalPreserved,
    ];

    const topReasons = getTopReportReasons(finalPreserveReasonCounts, 4);
    if (topReasons.length > 0) {
      lines.push("");
      lines.push("Preserved because");
      for (const reason of topReasons) {
        lines.push(reason.label + ": " + reason.count);
      }
    }

    const warnings = [];
    if (totalReleaseFailed > 0) {
      warnings.push("Release failed: " + totalReleaseFailed);
    }
    if (stoppedAtSafetyCap) {
      warnings.push("Stopped at safety cap");
    }

    if (warnings.length > 0) {
      lines.push("");
      lines.push("Warnings");
      for (const warning of warnings) {
        lines.push(warning);
      }
    }

    alert(lines.join("\n"));
  }

  function showReport() {
    try {
      const dlg = Dialog.create("Group Cleanup");
      dlg.initialWidth = 320;
      dlg.isResizable = false;

      const column = dlg.addColumn();
      const results = column.addGroup("Results");
      addReportRow(results, "Deleted empty groups", totalDeleted);
      addReportRow(results, "Released plain groups", totalReleased);
      addReportRow(results, "Preserved protected", totalPreserved);

      const topReasons = getTopReportReasons(finalPreserveReasonCounts, 4);
      if (topReasons.length > 0) {
        const preserved = column.addGroup("Preserved because");
        for (const reason of topReasons) {
          addReportRow(preserved, reason.label, reason.count);
        }
      }

      const warnings = [];
      if (totalReleaseFailed > 0) {
        warnings.push("Release failed: " + totalReleaseFailed);
      }
      if (stoppedAtSafetyCap) {
        warnings.push("Stopped at safety cap");
      }
      if (warnings.length > 0) {
        const warningGroup = column.addGroup("Warnings");
        for (const warning of warnings) {
          warningGroup.addStaticText("", warning);
        }
      }

      dlg.runModal();
    } catch (err) {
      console.log("Could not show report dialog: " + err);
      showPlainReport();
    }
  }

  function getNodeTypeName(node) {
    return node.isGroupNode ? "Group" : "Container";
  }

  function getChildName(node) {
    return (
      node.description ||
      node.userDescription ||
      (node.isGroupNode ? "Group" : "Single item")
    );
  }

  function hasParent(child, parent) {
    const childParent = child.parent;
    return childParent && childParent.isSameNode(parent);
  }

  function getMoveTypeCandidates() {
    const names = [
      "After",
      "AfterNode",
      "AsNextSibling",
      "MoveAfter",
      "InsertAfter",
      "NextSibling",
      "Next",
      "Below",
      "Before",
      "BeforeNode",
      "AsPreviousSibling",
      "MoveBefore",
      "InsertBefore",
      "PreviousSibling",
      "Previous",
      "Above",
    ];

    const candidates = [];
    for (const name of names) {
      if (NodeMoveType[name] != null) {
        candidates.push({ name, value: NodeMoveType[name] });
      }
    }
    return candidates;
  }

  function releaseSingleItemGroup(node) {
    const child = node.firstChild;
    if (!child) return false;

    const moveTypeCandidates = getMoveTypeCandidates();
    for (const moveType of moveTypeCandidates) {
      try {
        const selection = Selection.create(doc, child);
        const command = DocumentCommand.createMoveNodes(
          selection,
          node,
          moveType.value,
          NodeChildType.Main,
        );

        doc.executeCommand(command);
        if (!hasParent(child, node)) {
          return true;
        }
      } catch (err) {
        console.log(
          "    Move command failed with NodeMoveType." +
            moveType.name +
            ": " +
            err,
        );
      }
    }

    try {
      child.moveToParent();
      if (!hasParent(child, node)) {
        return true;
      }
    } catch (err) {
      console.log("    Direct moveToParent() failed: " + err);
    }

    console.log(
      "    Could not release. Available NodeMoveType values: " +
        Object.keys(NodeMoveType).join(", "),
    );
    return false;
  }

  while (keepGoing) {
    pass++;

    const toDelete = [];
    const toRelease = [];
    const toPreserve = [];
    const preserveReasonCounts = {};

    for (const spread of doc.spreads) {
      // Reverse order = deepest children processed first.
      for (const node of getNodeChildrenRecursive(
        spread.handle,
        NodeChildType.Main,
        true,
      )) {
        if (isEmptyGroupOrContainer(node)) {
          toDelete.push({ node, name: getNodeName(node) });
          continue;
        }

        const decision = getSingleItemGroupDecision(node);
        if (!decision) {
          continue;
        }

        if (decision.preserveReasons.length === 0) {
          toRelease.push(decision);
        } else {
          toPreserve.push(decision);
          for (const reason of decision.preserveReasons) {
            incrementReasonCount(preserveReasonCounts, reason);
          }
        }
      }
    }

    let actionsThisPass = 0;

    if (toDelete.length > 0) {
      console.log(
        "Pass " + pass + ": deleting " + toDelete.length + " empty node(s)...",
      );
      for (const { node, name } of toDelete) {
        if (!isEmptyGroupOrContainer(node)) continue;

        console.log("  Deleting: " + name + " [" + getNodeTypeName(node) + "]");
        node.delete();
        totalDeleted++;
        actionsThisPass++;
      }
    }

    if (toRelease.length > 0) {
      console.log(
        "Pass " +
          pass +
          ": releasing " +
          toRelease.length +
          " single-item group/container(s)...",
      );
      for (const { node, name } of toRelease) {
        if (!isGroupLikeNode(node) || getMainChildCount(node, 2) !== 1)
          continue;

        const child = node.firstChild;
        const childName = getChildName(child);

        console.log("  Releasing: " + name + " -> " + childName);
        if (releaseSingleItemGroup(node)) {
          totalReleased++;
          actionsThisPass++;
        } else {
          totalReleaseFailed++;
          console.log("    Release skipped: " + name);
        }
      }
    }

    if (toPreserve.length > 0) {
      totalPreserved = toPreserve.length;
      finalPreserveReasonCounts = preserveReasonCounts;
      console.log(
        "Pass " +
          pass +
          ": preserving " +
          toPreserve.length +
          " stateful single-item group/container(s)...",
      );
      for (const { node, name, preserveReasons } of toPreserve) {
        console.log(
          "  Preserving: " +
            name +
            " [" +
            getNodeTypeName(node) +
            "] " +
            formatReasons(preserveReasons),
        );
      }
      console.log(
        "  Preserve reasons: " + formatReasonCounts(preserveReasonCounts),
      );
    }

    if (toDelete.length === 0 && toRelease.length === 0) {
      keepGoing = false;
      break;
    }

    if (actionsThisPass === 0) {
      keepGoing = false;
    }

    if (pass > 20) {
      stoppedAtSafetyCap = true;
      console.log("Stopped after 20 passes to avoid an infinite loop.");
      break;
    }
  }

  console.log(
    "Done. Total deleted: " +
      totalDeleted +
      " empty node(s); total released: " +
      totalReleased +
      " single-item group/container(s) in " +
      pass +
      " pass(es). Preserved stateful wrappers: " +
      totalPreserved +
      ".",
  );

  showReport();
}
