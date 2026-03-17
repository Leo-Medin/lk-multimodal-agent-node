import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import crypto from 'node:crypto';
import path from 'node:path';
import type {
  BrandGroup,
  FaqEntry,
  GeneralInfo,
  HoursEntry,
  PriceEntry,
  Service,
  TenantKB,
} from './types/kb.js';

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

  return (
    passages
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
      // Keep only non-empty text chunks
      .filter((c) => c.text.length > 0)
  );
}

function paragraphPassages(body: string): string[] {
  // Paragraph split on blank lines
  return (
    body
      .split(/\n\s*\n/g)
      .map((p) => p.trim())
      .filter(Boolean)
      // Optional: collapse internal newlines for better speech context
      .map((p) => p.replace(/\s*\n\s*/g, ' '))
  );
}

function pipeTableToPassages(body: string): string[] {
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  let currentCategory = '';
  const passages: string[] = [];

  for (const line of lines) {
    // If it's a header line, update the current category context
    if (line.startsWith('#')) {
      // Clean up the header (remove # and dashes)
      currentCategory = line.replace(/^[#\s-]+|[#\s-]+$/g, '');
      continue;
    }

    // If it's a data row
    if (line.includes('|')) {
      const cols = line.split('|').map((c) => c.trim());
      const [service, price, notes] = cols;

      const parts: string[] = [];
      // Prepend the category context to the text chunk
      if (currentCategory) parts.push(`Category: ${currentCategory}.`);
      if (service) parts.push(`Service: ${service}.`);
      if (price) parts.push(`Price: ${price}.`);
      if (notes) parts.push(`Notes: ${notes}.`);

      passages.push(parts.join(' '));
    }
  }
  return passages;
}

// ---------- Index loading ----------

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

  const qNorm = normalizeForSearch(query);

  // Calculate inverse document frequency (IDF) for better token weighting
  // Rare tokens (like brand names) should score higher than common ones (like "price", "for")
  const tokenDocCount = new Map<string, number>();
  for (const c of index.chunks) {
    const uniqueTokens = new Set(c.tokens);
    for (const token of uniqueTokens) {
      tokenDocCount.set(token, (tokenDocCount.get(token) || 0) + 1);
    }
  }

  const totalDocs = index.chunks.length;
  const idf = (token: string): number => {
    const docCount = tokenDocCount.get(token) || 1;
    return Math.log(totalDocs / docCount);
  };

  const results: SearchResult[] = [];
  for (const c of index.chunks) {
    let score = 0;

    // Token overlap with IDF weighting
    const tokenSet = new Set(c.tokens);
    let matchedCount = 0;
    for (const t of qTokens) {
      if (tokenSet.has(t)) {
        // Rare tokens get higher scores
        const weight = idf(t);
        score += 2 * weight;
        matchedCount++;
      }
    }

    // Title boost (with IDF)
    const titleTokens = new Set(tokenize(c.title));
    for (const t of qTokens) {
      if (titleTokens.has(t)) {
        score += 1 * idf(t);
      }
    }

    // Substring boost (exact phrase match is valuable)
    const cNorm = normalizeForSearch(c.text);
    if (cNorm.includes(qNorm)) {
      score += 10; // Strong boost for exact phrase
    }

    // Completeness bonus: reward chunks that match MORE query tokens
    const matchRatio = matchedCount / qTokens.length;
    if (matchRatio >= 0.5) {
      score += 5 * matchRatio; // Bonus scales with match completeness
    }

    // Penalize chunks with brand context that don't match brand-specific tokens
    const chunkHasBrandContext =
      cNorm.includes('brand') ||
      cNorm.includes('european') ||
      cNorm.includes('japanese') ||
      cNorm.includes('korean') ||
      cNorm.includes('chinese') ||
      cNorm.includes('american') ||
      cNorm.includes('premium');

    if (chunkHasBrandContext) {
      const missingTokens = qTokens.filter((t) => !tokenSet.has(t));
      if (missingTokens.length > 0) {
        score -= missingTokens.length * 2;
      }
    }

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

  const resultsSorted = results.sort((a, b) => b.score - a.score);
  console.log('searchDocs resultsSorted number', resultsSorted.length);
  console.log('searchDocs resultsSliced:', resultsSorted.slice(0, topK));
  return resultsSorted.slice(0, topK);
}

function makeChunk(
  tenantId: string,
  section: string,
  id: string,
  title: string,
  text: string,
): Chunk {
  return {
    tenantId,
    docId: `${tenantId}:${section}`,
    chunkId: `${tenantId}:${section}:${id}`,
    sourceFile: section, // used as citation label in the agent
    title,
    text,
    tokens: tokenize(text),
  };
}

function kbGeneralToChunks(tenantId: string, g: GeneralInfo): Chunk[] {
  const lines: string[] = [
    `Company: ${g.companyName}.`,
    `Address: ${g.address}.`,
    `Phone: ${g.phone.join(', ')}.`,
    `Email: ${g.email}.`,
    g.website ? `Website: ${g.website}.` : '',
    g.locationUrl ? `Map: ${g.locationUrl}.` : '',
    g.description ? `About: ${g.description}.` : '',
  ].filter(Boolean);

  // One chunk per logical field group so retrieval is focused
  const text = lines.join(' ');
  return [makeChunk(tenantId, 'general', 'info', 'General Info', text)];
}

const DAY_LABELS: Record<string, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

function kbHoursToChunks(tenantId: string, hours: HoursEntry[]): Chunk[] {
  // Produce one human-readable chunk so the LLM gets the full picture at once
  const lines = hours.map((h) => {
    const day = DAY_LABELS[h.day] ?? h.day;
    if (!h.open || !h.close) return `${day}: Closed${h.note ? ` (${h.note})` : ''}.`;
    return `${day}: ${h.open}–${h.close}${h.note ? ` (${h.note})` : ''}.`;
  });

  const text = `Office hours: ${lines.join(' ')}`;
  return [makeChunk(tenantId, 'hours', 'schedule', 'Office Hours', text)];
}

function kbServicesToChunks(tenantId: string, services: Service[]): Chunk[] {
  const active = services.filter((s) => s.active);

  // One summary chunk (for "what services do you offer?" queries)
  const summaryText = `Services offered: ${active.map((s) => s.name).join(', ')}.`;
  const summary = makeChunk(tenantId, 'services', 'summary', 'Services', summaryText);

  // One chunk per service (for specific service queries)
  const individual = active.map((s) => {
    const parts = [
      `Service: ${s.name}.`,
      `Category: ${s.category}.`,
      s.description ? `Details: ${s.description}.` : '',
    ].filter(Boolean);
    return makeChunk(tenantId, 'services', s.id, s.name, parts.join(' '));
  });

  return [summary, ...individual];
}

function kbPricesToChunks(
  tenantId: string,
  prices: PriceEntry[],
  services: Service[],
  brandGroups?: BrandGroup[], // NEW parameter
): Chunk[] {
  const serviceMap = new Map(services.map((s) => [s.id, s]));
  const brandMap = new Map(brandGroups?.map((bg) => [bg.id, bg]) ?? []);

  return prices.map((p) => {
    const service = serviceMap.get(p.serviceId);
    const name = p.label ?? service?.name ?? p.serviceId;
    const category = service?.category ?? '';

    const parts = [
      category ? `Category: ${category}.` : '',
      `Service: ${name}.`,
      `Price: ${p.price} ${p.currency}${p.unit ? ` ${p.unit}` : ''}.`,
      p.notes ? `Notes: ${p.notes}.` : '',
    ];

    // --- NEW: Include brand group info in searchable text ---
    if (p.appliesTo?.brandGroupId) {
      const bg = brandMap.get(p.appliesTo.brandGroupId);
      if (bg) {
        parts.push(`Applies to: ${bg.name}.`);
        if (bg.description) parts.push(`Brands: ${bg.description}.`);
        // Also add individual brand names for direct matching
        if (bg.brands && bg.brands.length > 0) {
          parts.push(`Specific brands: ${bg.brands.join(', ')}.`);
        }
      }
    }

    const text = parts.filter(Boolean).join(' ');
    return makeChunk(tenantId, 'prices', p.serviceId, `Price: ${name}`, text);
  });
}

function kbFaqToChunks(tenantId: string, faq: FaqEntry[]): Chunk[] {
  return faq.map((f) => {
    const text = `Q: ${f.question} A: ${f.answer}`;
    return makeChunk(tenantId, `faq-${f.language}`, f.id, f.question, text);
  });
}

// ─────────────────────────────────────────────
//  New entry point: load from TenantKB object
// ─────────────────────────────────────────────

export function loadTenantKBKnowledge(kb: TenantKB): KnowledgeIndex {
  const { tenantId } = kb;
  const chunks: Chunk[] = [
    ...kbGeneralToChunks(tenantId, kb.general),
    ...kbHoursToChunks(tenantId, kb.hours),
    ...kbServicesToChunks(tenantId, kb.services),
    ...kbPricesToChunks(tenantId, kb.prices, kb.services, kb.brandGroups), // Pass brandGroups
    ...kbFaqToChunks(tenantId, kb.faq),
  ];

  console.log(`[KB] Loaded ${chunks.length} chunks for tenant "${tenantId}" v${kb.version}`);
  return { tenantId, chunks };
}

// ─────────────────────────────────────────────
//  load TenantKB from S3 (per-tenant)
// ─────────────────────────────────────────────

async function s3BodyToString(body: unknown): Promise<string> {
  if (!body) return '';

  // AWS SDK v3 in Node typically returns a Readable stream with transformToString available
  if (typeof body === 'object' && 'transformToString' in body) {
    const b = body as { transformToString: () => Promise<string> };
    return await b.transformToString();
  }

  // Fallback for Readable streams
  if (typeof body === 'object' && 'on' in body) {
    const readable = body as NodeJS.ReadableStream;
    return await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      readable.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      readable.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      readable.on('error', reject);
    });
  }

  // If it ever comes as a Buffer/Uint8Array
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8');

  return String(body);
}

export async function loadTenantKBFromS3(params: {
  tenantId: string;
  bucket: string;
  key: string;
  region?: string;
}): Promise<KnowledgeIndex> {
  const { tenantId, bucket, key, region } = params;

  const s3 = new S3Client({ region });

  const res = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  );

  const raw = await s3BodyToString(res.Body);
  if (!raw.trim()) {
    throw new Error(`[KB] Empty KB object from S3: s3://${bucket}/${key}`);
  }

  const kb = JSON.parse(raw) as TenantKB;

  // Safety: ensure the loaded file matches the tenant we asked for
  if (kb.tenantId !== tenantId) {
    throw new Error(
      `[KB] Tenant mismatch: requested "${tenantId}" but S3 object contains tenantId "${kb.tenantId}" (s3://${bucket}/${key})`,
    );
  }

  console.log(`[KB] Loaded KB for tenant "${tenantId}" from S3: s3://${bucket}/${key}`);

  return loadTenantKBKnowledge(kb);
}

export async function loadTenantConfigFromS3(params: {
  tenantId: string;
  bucket: string;
  region?: string;
}): Promise<{ instructions: string; officeEmail: string }> {
  const { tenantId, bucket, region } = params;
  const s3 = new S3Client({ region });
  const key = `kb/${tenantId}/config.json`;

  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const raw = await s3BodyToString(res.Body);
  if (!raw.trim()) {
    throw new Error(`[KB] Empty config object from S3: s3://${bucket}/${key}`);
  }

  console.log(`[KB] Loaded config for tenant "${tenantId}" from S3`);
  return JSON.parse(raw) as { instructions: string; officeEmail: string };
}
