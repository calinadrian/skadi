// Attachments: photos, files and folders the user drops into a turn.
//
// The browser reads the files and posts them as base64, so this never needs a
// multipart parser. Images become image blocks for providers that can see;
// text becomes fenced context; a folder arrives as a manifest plus the small
// text files inside it, capped so a stray repo cannot blow the context window.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT } from './config.mjs';

export const ATTACHMENTS_DIR = join(ROOT, 'attachments');

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_CHARS = 60000;
const MAX_FOLDER_CHARS = 200000;

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.scss',
  '.html', '.htm', '.xml', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.py', '.rb', '.go',
  '.rs', '.java', '.cs', '.c', '.h', '.cpp', '.hpp', '.sh', '.ps1', '.bat', '.sql', '.env',
  '.gitignore', '.vue', '.svelte', '.lua', '.php', '.kt', '.swift', '.r', '.jl',
]);

const isText = (name, mediaType) =>
  (mediaType && mediaType.startsWith('text/')) || TEXT_EXTENSIONS.has(extname(name).toLowerCase());

/**
 * Persist one uploaded item.
 * @param {{name:string, mediaType:string, data:string, relPath?:string}} item base64 payload
 */
export function storeAttachment(item) {
  mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  const id = randomUUID();
  const safeName = String(item.name || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 120);
  const file = join(ATTACHMENTS_DIR, `${id}-${safeName}`);
  const buffer = Buffer.from(item.data || '', 'base64');
  writeFileSync(file, buffer);
  return {
    id,
    name: safeName,
    relPath: item.relPath || null,
    mediaType: item.mediaType || 'application/octet-stream',
    bytes: buffer.length,
    file,
  };
}

/**
 * Turn stored attachments into message content blocks.
 * `vision` false flattens images to a note rather than silently dropping them.
 */
export function attachmentsToBlocks(records, { vision = true } = {}) {
  const blocks = [];
  const folderFiles = [];
  let folderBudget = MAX_FOLDER_CHARS;

  for (const record of records) {
    const buffer = record.buffer ?? null;

    if (IMAGE_TYPES.has(record.mediaType)) {
      if (record.bytes > MAX_IMAGE_BYTES) {
        blocks.push({ type: 'text', text: `[${record.name}: image too large to attach (${Math.round(record.bytes / 1024)} KB)]` });
        continue;
      }
      if (vision && buffer) {
        blocks.push({ type: 'image', mediaType: record.mediaType, data: buffer.toString('base64') });
        blocks.push({ type: 'text', text: `[image: ${record.name}]` });
      } else {
        blocks.push({ type: 'text', text: `[image attached: ${record.name} — the active model cannot view images]` });
      }
      continue;
    }

    if (!buffer) continue;

    if (isText(record.name, record.mediaType)) {
      const text = buffer.toString('utf8');
      // Files that came from a folder pick get grouped under one heading.
      if (record.relPath) {
        if (folderBudget <= 0) continue;
        const slice = text.slice(0, Math.min(text.length, folderBudget, 20000));
        folderBudget -= slice.length;
        folderFiles.push({ path: record.relPath, text: slice, truncated: slice.length < text.length });
        continue;
      }
      const clipped = text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n... [truncated]` : text;
      blocks.push({
        type: 'text',
        text: `Attached file \`${record.name}\`:\n\n\`\`\`${extname(record.name).slice(1)}\n${clipped}\n\`\`\``,
      });
      continue;
    }

    blocks.push({
      type: 'text',
      text: `[attached: ${record.name} (${record.mediaType}, ${Math.round(record.bytes / 1024)} KB) — binary, not inlined. It is saved at ${record.file}]`,
    });
  }

  if (folderFiles.length) {
    const manifest = folderFiles.map((f) => f.path).sort().join('\n');
    const bodies = folderFiles
      .map((f) => `--- ${f.path}${f.truncated ? ' (truncated)' : ''} ---\n${f.text}`)
      .join('\n\n');
    blocks.unshift({
      type: 'text',
      text: `Attached folder — ${folderFiles.length} text file(s).\n\nFiles:\n${manifest}\n\nContents:\n${bodies}`,
    });
  }

  return blocks;
}

/** A compact description for the transcript and the UI. */
export function describeAttachments(records) {
  if (!records.length) return '';
  const folders = records.filter((r) => r.relPath).length;
  const loose = records.length - folders;
  const parts = [];
  if (loose) parts.push(`${loose} file${loose === 1 ? '' : 's'}`);
  if (folders) parts.push(`${folders} file${folders === 1 ? '' : 's'} from a folder`);
  return parts.join(', ');
}
