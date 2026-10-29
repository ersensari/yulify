import { baseDir, FileError, makeFolder, saveNewFile } from "../workspace-files.js";
import type { Attached } from "../prompt-images.js";


/**
 * Pictures attached to a message, also put in the chat's folder, so that edit_image can take them.
 *
 * pi gets an attached picture as something the model sees, not as a file: with no path, edit_image could not
 * change it or make a new picture from it, and the person had to put it in the folder by hand. So while editing is
 * switched on, each attached picture is also written into the folder generated pictures go in (a name made here,
 * never the sender's), and the message pi gets ends with an <attachments> block naming the paths in order. The page
 * folds that block away (web/src/context-blocks.ts) and a sender cannot forge one: it is a framing tag that
 * neutralise() writes out as text in what people send (channels/framing.ts).
 */

/** Writes the pictures into the chat's folder and returns their paths in it, in order; none while editing is off. */
export function keepAttached(folder: string, images: Attached[]): string[] {
  if (!images.length) return [];
  let base: string;
  try {
    base = baseDir(folder);
    try { makeFolder(base, "", "generated-images"); }
    catch (error) { if (!(error instanceof FileError && error.code === "exists")) throw error; }
  } catch {
    return []; // The picture still reaches the model even if it cannot be saved.
  }
  const paths: string[] = [];
  for (const [i, image] of images.entries()) {
    const ext = image.name.split(".").pop() || "png";
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
    try {
      paths.push(saveNewFile(base, "generated-images", `attached-${stamp}-${i + 1}-${image.name.split(".")[0].slice(-6)}.${ext}`, Buffer.from(image.data, "base64")));
    } catch {
      // The picture still reaches the model as something it sees; only the path for edit_image is missing.
    }
  }
  return paths;
}

/** The block the message to pi ends with, or "" when there is nothing to name. */
export function attachmentsBlock(paths: string[]): string {
  if (!paths.length) return "";
  const list = paths.map((p, i) => `${i + 1}. ${p}`).join("\n");
  return (
    "\n\n<attachments>\n" +
    `The picture${paths.length === 1 ? "" : "s"} attached to this message ${paths.length === 1 ? "is" : "are"} also saved in the chat folder, in the order attached:\n` +
    `${list}\n` +
    "To change one, or to make any new picture from one (an avatar or portrait of the person in it, a variation, another style, " +
    "the same subject elsewhere), give its path to edit_image and describe the new picture in its prompt. " +
    "Not generate_image: it cannot see the picture, so a person or an object in it would come out as a stranger.\n" +
    "</attachments>"
  );
}
