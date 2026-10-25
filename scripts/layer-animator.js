/**
 * name: Layer Animator
 * description: Creates an animation from an Affinity document by displaying,
 *              and optionally, exporting a sequence of frames as PNG files.
 *
 *              The document should consist of zero or more "static" layers that
 *              will appear in every output file, plus one or more "animated"
 *              layers that will each be written to separate output files.
 *
 *              Static layers are marked as such by being locked. All other
 *              top-level layers will be considered animatable.
 *
 *              If the document contains artboards, then you can select which
 *              artboard to animate. Otherwise the whole document is used.
 * version: 1.0
 * author: JamesRandom
 */

"use strict";

// cspell:ignore artboard artboards uselayer

const { app } = require("/application");
const { DocumentCommand } = require("/commands.js");
const { Document } = require("/document.js");
const { Dialog, DialogResult } = require("/dialog");
const { FileExportOptions, FileExportArea } = require("/document");
const { UnitType } = require("/units");
const { fs } = require("/fs");


/**
 * Create a dialog box to set the options for the animator:
 *
 * Artboard: Select which artboard to export from
 *           (only if the document contains artboards).
 * Delay: The time (in seconds) between displaying frames.
 * Save frames: Enable saving the animation frames to files.
 * Filename: Either generate file names from the frame
 *           number or the layer name.
 * File type: Select the output file type (PNG, GIF, etc).
 *
 * @param doc The current document
 * @returns An object representing the values in the form if OK is clicked, or
 * null if Cancel is clicked.
 */
function getOptions(doc) {

  let root = null
  let artboardControl = null

  // Get the list of artboards (if any)
  const spread = doc.spreads.first;
  if (!spread)
    throw new Error("no spread found.");
  doc.executeCommand(DocumentCommand.createSetCurrentSpread(spread))
  const artboardCount = safeLength(spread.artboards)

  // Create the dialog box
  const dialog = Dialog.create("Layer Animator Options");
  dialog.initialWidth = 380;
  const dialogColumn = dialog.addColumn();

  // Options for controlling animation
  const animationGroup = dialogColumn.addGroup("Animation");
  // Add artboard selector if more then one
  if (artboardCount > 1) {
    const artboardDisplayNames = spread.artboards.map((x) => `${x.description} (${safeLength(x.node.children)})`)
    artboardControl = animationGroup.addComboBox("Artboard", artboardDisplayNames);
    artboardControl.isFullWidth = true;
  } else if (artboardCount > 0) {
    // If just one, that is the root
    root = spread.artboards[0].node
  }
  else {
    // Otherwise the whole document
    root = spread
  }

  // Note: documentation appears to be wrong.
  // https://sdk.affinity.studio/33000/js/apis/DialogGroupApi/addUnitValueEditor.html
  // Says the last 3 arguments are min, max, initial but experiment shows they
  // are initial, min, max.
  const delayControl = animationGroup.addUnitValueEditor(
    "Delay (seconds)",
    UnitType.Number, UnitType.Number,
    0.25, 0, 10
  );
  delayControl.showPopupSlider = true

  // Options for file output
  const fileGroup = dialogColumn.addGroup("File");
  const saveControl = fileGroup.addCheckBox("Save frames", false);
  saveControl.setIsFullWidth(true)
  const filenameControl = fileGroup.addRadioGroup("Filename", ["Frame number", "Layer name"], 0);

  // Note: could use FileExportOptions.enumeratePresetNames() to get the full
  // list of export types, but that is far more than we need (more than 60
  // options)
  const FILETYPES = [
    "PNG",
    "GIF RGB",
    "GIF Grayscale",
    "JPEG (Best quality)",
    "JPEG (High quality)",
    "JPEG (Medium quality)",
    "JPEG (Low quality)",
  ]
  const fileTypeControl = fileGroup.addComboBox("File type", FILETYPES);

  const result = dialog.runModal();
  if (!result || result.value !== DialogResult.Ok.value) {
    return null;
  }

  const options = []

  if (artboardCount > 1) {
    // Use the artboard selected from the dialog
    const board = spread.artboards[artboardControl.selectedIndex]
    options["root"] = board.node
    options["area"] = FileExportArea.createForArtboard(board);
  } else if (artboardCount > 0) {
    // Use the only artboard
    options["root"] = root
    options["area"] = FileExportArea.createForArtboard(spread.artboards[0]);
  } else {
    // Use the whole document
    options["root"] = root
    options["area"] = FileExportArea.createForWholeDocument()
  }

  options["delay"] = delayControl.value
  options["save"] = saveControl.value
  options["uselayer"] = filenameControl.selectedIndex
  const type = FILETYPES[fileTypeControl.selectedIndex]
  options["type"] = type
  // Get the first "word" from the export type as the extension
  options["extension"] = type.substring(0, (type + " ").indexOf(" ")).toLowerCase()

  return options
}


/**
 * Create an output directory based on the document filename. If the document
 * has not been saved, then use the default name ("Untitled").
 *
 * @param {DocumentApi} doc The current document.
 * @returns {str} The path where exported files will be written.
 */
function getDirectory(doc) {
  let name = "Untitled"
  // Extract filename from path if document has been saved
  if (doc.path) {
    const filename = doc.path.substring(doc.path.lastIndexOf("/") + 1)
    // Strip extension from file
    name = filename.substring(0, filename.lastIndexOf("."))
  }

  // Only the desktop folder is reliably writable for scripts?
  // Note: need to enable access in Affinity settings
  const outputDirectory = `${app.userDesktopPath}/${name}_frames`;
  console.log(outputDirectory)

  // Create directory path if it doesn't exist
  try {
    fs.createDirectories(outputDirectory);
  } catch (e) {
    if (e.message == "PERMISSION_DENIED") {
      throw new Error(`could not create export directory '${outputDirectory}': ${e.message.toLowerCase()}.`,
        { cause: e });
    }
  }
  if (!fs.isDirectory(outputDirectory)) {
    throw new Error(`export directory '${outputDirectory}' not created.`);
  }

  return outputDirectory
}


/**
 *
 * @param root The top-level node containing the layers to export frames from.
 * @returns An array of the unlocked top-level layers in the artboard.
 */
function getLayers(root) {
  // Array of layers to animate
  const unlockedLayers = []

  // Create a list of all the unlocked top-level layers
  for (const n of root.children) {
    if (!n.isLocked) {
      unlockedLayers.push(n)
    }
  }

  // console.log(unlockedLayers.length)
  // console.log(unlockedLayers.map((x) => x.description))

  return unlockedLayers
}


/**
 * Busy loop for N milliseconds.
 *
 * @param {int} n Time to sleep in milliseconds.
 */
function sleep(n) {
  var now = Date.now()
  const end = now + n
  while (now < end) {
    now = Date.now();
  }
}


/**
 * Generate a filename
 *
 * @param {int} frame Frame number
 * @param {str} name Name of the current layer
 * @param {Object} options Options for animation
 * @returns {str} A full path to the output file
 */
function filename(frame, name, options) {
  //
  let filename
  if (options.uselayer) {
    filename = name.replace(new RegExp(/ +/, "g"), "_")
  } else {
    filename = `frame_${String(frame).padStart(4, "0")}`;
  }

  filename = `${options.directory}/${filename}.${options.extension}`

  return filename
}


/**
 * Animate the selected layers by making each visible in turn. If enabled, save
 * each frame to a file.
 *
 * @param {DocumentApi} doc
 * @param {Object} options
 */
function animate(doc, layers, options) {
  if (safeLength(layers) == 0) {
    throw new Error("no animatable layers.")
  }

  // Ensure all animation layers are hidden to start with
  for (const layer of layers) {
    doc.setVisible(false, layer)
  }

  const exportOpts = FileExportOptions.createWithPresetName(options.type)

  var frame = 0;
  for (const layer of layers) {
    // Get the name of this layer
    const name = (layer.userDescription || layer.description || "").trim();

    // Make this layer visible
    doc.setVisible(true, layer)

    // Pause
    sleep(options.delay * 1000)

    // Save frame if enabled
    if (options.save) {
      const fname = filename(frame, name, options)

      // Export this frame
      try {
        doc.export(fname, exportOpts, options.area);
      } catch (e) {
        throw new Error(`could not create output file '${fname}': ${e.message.toLowerCase()}.`, { cause: e })
      }
    }

    // And hide the layer again
    doc.setVisible(false, layer)
    frame++
  }
  console.log(`Processed ${frame} frames`)
}


/**
 * Get the length of any object. If it is defined and has a length attribute,
 * then return that. Otherwise return 0.
 *
 * @param {*} obj The object to get the length of *
 * @returns {int} The length of the object or zero
 */
function safeLength(obj) {
  if (!obj || !obj.length) {
    return 0
  } else {
    return obj.length
  }
}


function main() {

  const doc = Document.current;
  if (!doc) {
    alert("This script requires an open document");
    return;
  }

  // Get options from dialog
  const options = getOptions(doc)
  if (options) {
    for (const a in options) {
      console.log(a, options[a])
    }
  } else {
    console.log("Cancelled")
    return
  }

  if (safeLength(options.root.children) == 0) {
    throw new Error("selected document or artboard contains no layers")
  }

  // Create the output directory
  if (options.save) {
    options["directory"] = getDirectory(doc)
  }

  // Get the layers to export
  const animateLayers = getLayers(options.root)

  animate(doc, animateLayers, options)
}

// Run the script
try {
  main()
} catch (e) {
  app.alert(e)
}
