// Helpers both PR sources share, so a local review and a GitHub review assemble the same snapshot
// from the same inputs.

import { MAX_HEAD_FILE_BYTES, MAX_HEAD_FILES_TOTAL_BYTES, MAX_LINKED_ISSUES, type FileText } from "./types";

// GitHub's closing keywords: close, closes, closed, fix, fixes, fixed, resolve, resolves, resolved,
// optionally followed by a colon. "Refs #n" is deliberately not a link: it names context, not the
// requirement the change claims to meet.
export function linkedIssueNumbers(body: string): number[] {
  const found: number[] = [];
  for (const match of body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d{1,7})\b/gi)) {
    const number = Number(match[1]);
    if (number > 0 && !found.includes(number)) found.push(number);
    if (found.length === MAX_LINKED_ISSUES) break;
  }
  return found;
}

export function selectHeadFiles(candidates: readonly FileText[]): { headFiles: FileText[]; omittedFiles: string[] } {
  const headFiles: FileText[] = [];
  const omittedFiles: string[] = [];
  let total = 0;
  for (const file of candidates) {
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (bytes > MAX_HEAD_FILE_BYTES || file.content.includes("\u0000") || total + bytes > MAX_HEAD_FILES_TOTAL_BYTES) {
      omittedFiles.push(file.path);
      continue;
    }
    headFiles.push(file);
    total += bytes;
  }
  return { headFiles, omittedFiles };
}
