// Delete Empty Groups, Folders & Containers
// Scans all spreads and deletes empty groups, folders, and containers.
// Runs multiple passes to catch containers that become empty after their children are removed.

const { Document } = require("/document");
const { getNodeChildrenRecursive, NodeChildType } = require("/nodes");

const doc = Document.current;
if (!doc) {
  console.log("ERROR: No document open");
} else {
  let totalDeleted = 0;
  let pass = 0;
  let keepGoing = true;

  while (keepGoing) {
    pass++;
    // Collect empty groups and containers - deepest first (reverse traversal)
    const toDelete = [];

    for (const spread of doc.spreads) {
      // Reverse order = deepest children processed first
      for (const node of getNodeChildrenRecursive(
        spread.handle,
        NodeChildType.Main,
        true,
      )) {
        if ((node.isGroupNode || node.isContainerNode) && !node.firstChild) {
          const name =
            node.description ||
            node.userDescription ||
            (node.isGroupNode ? "Group" : "Container");
          toDelete.push({ node, name });
        }
      }
    }

    if (toDelete.length === 0) {
      keepGoing = false;
    } else {
      console.log(
        "Pass " + pass + ": deleting " + toDelete.length + " empty node(s)...",
      );
      for (const { node, name } of toDelete) {
        console.log(
          "  Deleting: " +
            name +
            " [" +
            (node.isGroupNode ? "Group" : "Container") +
            "]",
        );
        node.delete();
        totalDeleted++;
      }
    }

    if (pass > 20) break; // safety cap against infinite loops
  }

  console.log(
    "Done. Total deleted: " +
      totalDeleted +
      " empty node(s) in " +
      (pass - 1) +
      " pass(es).",
  );
}
