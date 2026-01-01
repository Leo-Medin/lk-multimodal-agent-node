import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type Chunk = {
  tenantId: string;
  docId: string;
  chunkId: string;
  sourceFile: string; // filename only (for citation)
  title: string; // first line
  text: string; // chunk text
  tokens: string[]; // normalized tokens for search
};

export type KnowledgeIndex = {
  tenantId: string;
  chunks: Chunk[];
};

// ---------- Normalization / tokenization ----------

export function normalizeForSearch(input: string): string {
  // Goal: stable matching across punctuation/case; MVP-friendly; language-agnostic
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // remove diacritics
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ') // punctuation → spaces (unicode letters/numbers)
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(input: string): string[] {
  const norm = normalizeForSearch(input);
  // Keep tokens length >= 2 to reduce noise; you can tune
  return norm.split(' ').filter((t) => t.length >= 2);
}

function stableId(parts: string[]): string {
  const h = crypto.createHash('sha1');
  h.update(parts.join('|'));
  return h.digest('hex').slice(0, 16);
}

// ---------- Parsing & chunking ----------

type ParseOptions = {
  tenantId: string;
  sourceFile: string;
  maxChunkChars?: number; // safeguard for huge paragraphs
};

export function parseTxtToChunks(txt: string, opts: ParseOptions): Chunk[] {
  const { tenantId, sourceFile, maxChunkChars = 1800 } = opts;

  // Split into lines, find first non-empty as title
  const lines = txt.replace(/\r\n/g, '\n').split('\n');
  let title = '';
  let startIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l.length > 0) {
      title = l;
      startIdx = i + 1;
      break;
    }
  }
  if (!title) title = path.basename(sourceFile);

  const body = lines.slice(startIdx).join('\n').trim();

  // Detect "price table" lines (contains | and not just a single header)
  // We will convert each table row into a normalized passage.
  const hasPipeTable = body.split('\n').some((l) => l.includes('|'));

  let rawPassages: string[] = [];

  if (hasPipeTable) {
    rawPassages = pipeTableToPassages(body);
  } else {
    rawPassages = paragraphPassages(body);
  }

  // Enforce maxChunkChars by splitting long passages
  const passages: string[] = [];
  for (const p of rawPassages) {
    if (p.length <= maxChunkChars) {
      passages.push(p);
    } else {
      // naive split by sentences; fallback to hard split
      const splits = p.split(/(?<=[.!?])\s+/);
      let buf = '';
      for (const s of splits) {
        if ((buf + ' ' + s).trim().length <= maxChunkChars) {
          buf = (buf ? buf + ' ' : '') + s;
        } else {
          if (buf) passages.push(buf.trim());
          buf = s;
        }
      }
      if (buf) passages.push(buf.trim());
    }
  }

  const docId = `${tenantId}:${path.basename(sourceFile)}`; // stable enough for MVP
  const docHash = stableId([tenantId, sourceFile, title]);

  return passages
    .map((text, idx) => {
      const chunkId = `${docHash}#${idx}`;
      return {
        tenantId,
        docId,
        chunkId,
        sourceFile: path.basename(sourceFile),
        title,
        text: text.trim(),
        tokens: tokenize(text),
      } satisfies Chunk;
    })
    .filter((c) => c.text.length > 0);
}

function paragraphPassages(body: string): string[] {
  // Paragraph split on blank lines
  return body
    .split(/\n\s*\n/g)
    .map((p) => p.trim())
    .filter(Boolean)
    // Optional: collapse internal newlines for better speech context
    .map((p) => p.replace(/\s*\n\s*/g, ' '));
}

function pipeTableToPassages(body: string): string[] {
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));

  // Keep only lines that look like rows
  const rows = lines.filter((l) => l.includes('|'));

  // Convert each row to a sentence-like passage so retrieval is easy
  // Example: "Service: Car wash basic. Price: 10. Notes: exterior only."
  return rows.map((row) => {
    const cols = row.split('|').map((c) => c.trim());
    const [service, price, notes] = cols;

    const parts: string[] = [];
    if (service) parts.push(`Service: ${service}.`);
    if (price) parts.push(`Price: ${price}.`);
    if (notes) parts.push(`Notes: ${notes}.`);

    return parts.join(' ');
  });
}

// ---------- Index loading ----------

export function loadTenantTxtKnowledge(params: {
  tenantId: string;
  folderPath: string;
}): KnowledgeIndex {
  const { tenantId, folderPath } = params;

  const files = fs
    .readdirSync(folderPath, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.txt'))
    .map((d) => d.name);

  const chunks: Chunk[] = [];
  for (const file of files) {
    console.log('processing file:', file);
    const full = path.join(folderPath, file);
    const txt = fs.readFileSync(full, 'utf8');
    chunks.push(...parseTxtToChunks(txt, { tenantId, sourceFile: full }));
  }
  console.log('chunks:', chunks);

  return { tenantId, chunks };
}

// ---------- Search ----------

export type SearchResult = {
  chunkId: string;
  title: string;
  sourceFile: string;
  text: string;
  score: number;
};

export function searchDocs(params: {
  index: KnowledgeIndex;
  query: string;
  topK?: number;
}): SearchResult[] {
  const { index, query, topK = 3 } = params;

  const qTokens = tokenize(query);
  console.log('searchDocs qTokens', qTokens);
  if (qTokens.length === 0) return [];

  // Basic scoring:
  // - token overlap count
  // - small boost if token appears in title
  // - small boost for exact substring match
  const qNorm = normalizeForSearch(query);

  const results: SearchResult[] = [];
  for (const c of index.chunks) {
    let score = 0;

    // Token overlap
    const tokenSet = new Set(c.tokens);
    for (const t of qTokens) {
      if (tokenSet.has(t)) score += 2;
    }

    // Title boost
    const titleTokens = new Set(tokenize(c.title));
    for (const t of qTokens) {
      if (titleTokens.has(t)) score += 1;
    }

    // Substring boost (helps for phone numbers, exact phrases, etc.)
    const cNorm = normalizeForSearch(c.text);
    if (cNorm.includes(qNorm)) score += 4;

    if (score > 0) {
      results.push({
        chunkId: c.chunkId,
        title: c.title,
        sourceFile: c.sourceFile,
        text: c.text,
        score,
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}
