// Rights record: every piece of footage or audio in a project must say why the user may use it.
// Clipping is refused for any source without a valid record.
import crypto from "node:crypto";
import fs from "node:fs";

export const RIGHTS_BASES = {
  own: "I created this footage and own the rights",
  licensed: "I hold a licence that allows editing and reposting",
  permission: "The rights holder gave me written permission to edit and repost",
  public_domain: "Public domain or a licence such as CC0 / CC BY that allows reuse",
};

export function validateRights(input) {
  const errors = [];
  if (!RIGHTS_BASES[input?.basis]) errors.push(`basis must be one of: ${Object.keys(RIGHTS_BASES).join(", ")}`);
  if (!input?.holder?.trim()) errors.push("holder (who owns the rights) is required");
  if (["licensed", "permission", "public_domain"].includes(input?.basis) && !input?.evidence?.trim())
    errors.push("evidence is required for this basis (licence link, permission reference, etc.)");
  if (input?.confirmed !== true && input?.confirmed !== "true")
    errors.push("the uploader must confirm the rights statement");
  return errors;
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

export function buildRightsRecord({ sourceId, fileName, sha256, kind = "video", input, confirmedBy }) {
  return {
    sourceId,
    fileName,
    sha256, // ties the record to the exact bytes that were uploaded
    kind, // video | audio | music
    basis: input.basis,
    basisText: RIGHTS_BASES[input.basis],
    holder: input.holder.trim(),
    evidence: input.evidence?.trim() || null,
    confirmedBy: confirmedBy || "owner",
    confirmedAt: new Date().toISOString(),
  };
}

export function assertSourcesCleared(project, sourceIds) {
  const cleared = new Set(project.rights.map((r) => r.sourceId));
  const missing = sourceIds.filter((id) => !cleared.has(id));
  if (missing.length) {
    throw Object.assign(new Error(`No rights record for source(s): ${missing.join(", ")}`), { status: 422 });
  }
}
