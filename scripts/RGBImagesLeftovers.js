// ============================================================

// OPEN RGB IMAGES AS DOCUMENTS (v2)

// - Saves extracted images into Desktop/Found-RGB/

// - Auto-numbers duplicates: image.jpg -> image_2.jpg, image_3.jpg ...

// ============================================================

const { app } = require("/application");

const { FileSystemApi } = require("/fs");

const desktopPath = app.getUserDesktopPath;

const outputFolder = desktopPath + "/Found-RGB";

// RGB pixel format values: RGBA8=0, RGBA16=1, RGBAuf=8

const RGB_FORMATS = new Set([0, 1, 8]);

function isRGBImage(node) {
  if (!node.isImageNode && !node.isEmbeddedDocumentNode) return false;

  try {
    return RGB_FORMATS.has(
      node.imageResourceInterface.getColourFormat(false).value,
    );
  } catch (e) {
    return false;
  }
}

function placementLabel(value) {
  return value === 1 ? "linked" : "embedded";
}

// Build a unique destination path, appending _2, _3 ... if the file already exists

function uniquePath(folder, filename) {
  const dotIndex = filename.lastIndexOf(".");

  const base = dotIndex >= 0 ? filename.slice(0, dotIndex) : filename;

  const ext = dotIndex >= 0 ? filename.slice(dotIndex) : "";

  let candidate = folder + "/" + filename;

  let counter = 2;

  while (FileSystemApi.exists(candidate)) {
    candidate = folder + "/" + base + "_" + counter + ext;

    counter++;
  }

  return candidate;
}

// --- Main ---

const doc = app.documents.current;

if (!doc) {
  app.alert("No document is currently open.", "Open RGB Images");
} else {
  // Collect RGB image nodes across all spreads

  const found = [];

  for (const spread of doc.spreads) {
    for (const node of spread.layers.all) {
      if (isRGBImage(node)) {
        const iri = node.imageResourceInterface;

        found.push({
          iri,

          filename: iri.imageFilePath,

          placement: iri.imagePlacement.value,
        });
      }
    }
  }

  if (found.length === 0) {
    app.alert(
      "No RGB images were found in the current document.",
      "Open RGB Images",
    );
  } else {
    // Ensure output folder exists

    FileSystemApi.createDirectories(outputFolder);

    const opened = [];

    const failed = [];

    for (const img of found) {
      const destPath = uniquePath(outputFolder, img.filename);

      try {
        const savedPath = img.iri.saveOriginalFile(destPath);

        if (savedPath) {
          const newDoc = app.documents.load(savedPath);

          if (newDoc) {
            const shortName = destPath.split("/").pop();

            opened.push(shortName + " [" + placementLabel(img.placement) + "]");

            console.log(
              "Opened: " +
                shortName +
                " (" +
                placementLabel(img.placement) +
                ")",
            );
          } else {
            failed.push(img.filename + " (could not load)");
          }
        } else {
          failed.push(img.filename + " (could not save)");
        }
      } catch (e) {
        failed.push(img.filename + " (" + e.message + ")");

        console.log("Error: " + img.filename + " - " + e.message);
      }
    }

    // Summary dialog

    const lines = [
      "Found " + found.length + " RGB image(s).",

      "Saved to: Desktop/Found-RGB/\n",
    ];

    if (opened.length > 0) {
      lines.push("Opened (" + opened.length + "):");

      opened.forEach((f) => lines.push(" \u2713 " + f));
    }

    if (failed.length > 0) {
      lines.push("\nFailed (" + failed.length + "):");

      failed.forEach((f) => lines.push(" \u2717 " + f));
    }

    app.alert(lines.join("\n"), "Open RGB Images");
  }
}
