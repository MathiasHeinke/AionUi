// ===========================================================================
// THE AUTHORITATIVE PHYSICAL PAGE COUNT — derived from the PDF bytes.
//
// WHY THIS FILE EXISTS. `page_count` arrived on the wire, from the payer, and
// became the authority for five money-relevant things at once: the credit
// RESERVE, the daily page CAP, the provider PROMPT, the response-heading
// VALIDATION, and — the sharp edge — the FALLBACK `measuredUnits` used to
// settle whenever OpenRouter omits `usage.cost`. The bytes were SHA-256
// checked, which proves only that they were not altered in transit; it says
// nothing about how many pages they contain. A caller declaring `page_count: 1`
// on a 500-page document was OCR'd for 500 and charged for 1 every time the
// provider's cost figure was missing.
//
// WHAT THIS IS NOT. It is NOT a regex sweep for the token `/Page`. That
// heuristic is wrong in at least four ways that all occur in ordinary files:
// object streams hide the page objects inside a compressed blob where no
// top-level regex sees them; cross-reference streams do the same to the
// xref; incremental updates leave superseded page objects lying in the file
// that a text scan happily counts again; and `/Pages` (the tree node) shares
// its prefix with `/Page` (the leaf). It would swap an untrusted number for an
// unreliable one and look like a fix.
//
// WHAT IT IS. A structural read of the document, the same route a conforming
// viewer takes: locate `startxref`, walk the cross-reference chain (classic
// tables, cross-reference streams, hybrid `/XRefStm`, and `/Prev` history),
// resolve the trailer `/Root` to the catalog, follow `/Pages` and WALK the
// page tree, counting `/Type /Page` LEAF NODES as resolved objects. The
// root's own `/Count` is then used only as a CORROBORATION: if the declared
// count and the walked leaves disagree, the file is internally inconsistent —
// two conforming readers could legitimately price it differently — and we
// refuse rather than pick one.
//
// EVERY UNKNOWN IS A REFUSAL. Encrypted document, filter we do not implement,
// xref we cannot parse, cyclic page tree, budget exhausted: all return
// `{ ok: false }`. The caller must fail closed on that. Undercharging is the
// defect this file exists to close, so "could not tell" must never resolve to
// a number.
// ===========================================================================

export type PdfPageCountRefusal =
  | 'not-a-pdf'
  | 'startxref-unreadable'
  | 'xref-unreadable'
  | 'encrypted'
  | 'catalog-unreadable'
  | 'page-tree-unreadable'
  | 'page-tree-count-mismatch'
  | 'page-tree-too-large'
  | 'stream-unreadable'
  | 'budget-exhausted';

export type PdfPageCountResult = { ok: true; pageCount: number } | { ok: false; reason: PdfPageCountRefusal };

// Budgets. A hostile PDF is a hostile input: every walk is bounded, and
// exhausting a bound is a refusal, never a partial answer.
const MAX_XREF_SECTIONS = 64;
const MAX_OBJECT_LOADS = 20_000;
const MAX_PAGE_TREE_NODES = 20_000;
const MAX_PAGE_TREE_DEPTH = 64;
const MAX_PAGE_LEAVES = 5_000;
const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_VALUE_DEPTH = 32;
const STARTXREF_TAIL_BYTES = 4096;

// ── VALUE MODEL ────────────────────────────────────────────────────────────
// `undefined` means "failed to parse / absent". PDF's own null is a tagged
// object so the two can never be confused at a call site.

type PdfName = { readonly kind: 'name'; readonly value: string };
type PdfRef = { readonly kind: 'ref'; readonly num: number; readonly gen: number };
type PdfDict = { readonly kind: 'dict'; readonly entries: Map<string, PdfValue> };
type PdfArray = { readonly kind: 'array'; readonly items: PdfValue[] };
type PdfStream = {
  readonly kind: 'stream';
  readonly dict: PdfDict;
  readonly dataStart: number;
};
type PdfOpaque = { readonly kind: 'string' | 'null' };

type PdfValue = number | boolean | PdfName | PdfRef | PdfDict | PdfArray | PdfStream | PdfOpaque | undefined;

function isDict(value: PdfValue): value is PdfDict {
  return typeof value === 'object' && value !== undefined && value.kind === 'dict';
}
function isArray(value: PdfValue): value is PdfArray {
  return typeof value === 'object' && value !== undefined && value.kind === 'array';
}
function isRef(value: PdfValue): value is PdfRef {
  return typeof value === 'object' && value !== undefined && value.kind === 'ref';
}
function isStream(value: PdfValue): value is PdfStream {
  return typeof value === 'object' && value !== undefined && value.kind === 'stream';
}
function isNamed(value: PdfValue, name: string): boolean {
  return typeof value === 'object' && value !== undefined && value.kind === 'name' && value.value === name;
}
function asInteger(value: PdfValue): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

// ── LEXER ──────────────────────────────────────────────────────────────────

function isWhitespaceByte(byte: number): boolean {
  return byte === 0x00 || byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d || byte === 0x20;
}

function isDelimiterByte(byte: number): boolean {
  return (
    byte === 0x28 ||
    byte === 0x29 ||
    byte === 0x3c ||
    byte === 0x3e ||
    byte === 0x5b ||
    byte === 0x5d ||
    byte === 0x7b ||
    byte === 0x7d ||
    byte === 0x2f ||
    byte === 0x25
  );
}

function isRegularByte(byte: number): boolean {
  return !isWhitespaceByte(byte) && !isDelimiterByte(byte);
}

class PdfLexer {
  pos: number;
  readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array, pos: number) {
    this.bytes = bytes;
    this.pos = pos;
  }

  byteAt(offset: number): number {
    return offset >= 0 && offset < this.bytes.length ? this.bytes[offset] : -1;
  }

  skipSpace(): void {
    while (this.pos < this.bytes.length) {
      const byte = this.bytes[this.pos];
      if (isWhitespaceByte(byte)) {
        this.pos += 1;
        continue;
      }
      if (byte === 0x25) {
        // A comment runs to the end of the line.
        while (this.pos < this.bytes.length && this.bytes[this.pos] !== 0x0a && this.bytes[this.pos] !== 0x0d)
          this.pos += 1;
        continue;
      }
      return;
    }
  }

  /** The run of regular characters at the cursor, as ASCII. */
  readToken(): string {
    this.skipSpace();
    const start = this.pos;
    while (this.pos < this.bytes.length && isRegularByte(this.bytes[this.pos])) {
      this.pos += 1;
    }
    if (this.pos === start) return '';
    let token = '';
    for (let index = start; index < this.pos; index += 1) {
      token += String.fromCharCode(this.bytes[index]);
    }
    return token;
  }

  /** Consume `keyword` if it is the next token. */
  matchKeyword(keyword: string): boolean {
    const saved = this.pos;
    if (this.readToken() === keyword) return true;
    this.pos = saved;
    return false;
  }

  readInteger(): number | undefined {
    const saved = this.pos;
    const token = this.readToken();
    if (!/^[+-]?\d+$/.test(token)) {
      this.pos = saved;
      return undefined;
    }
    const parsed = Number(token);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }

  private readName(): PdfName {
    this.pos += 1; // '/'
    let name = '';
    while (this.pos < this.bytes.length && isRegularByte(this.bytes[this.pos])) {
      const byte = this.bytes[this.pos];
      if (byte === 0x23 && this.pos + 2 < this.bytes.length) {
        const hex = String.fromCharCode(this.bytes[this.pos + 1], this.bytes[this.pos + 2]);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          name += String.fromCharCode(parseInt(hex, 16));
          this.pos += 3;
          continue;
        }
      }
      name += String.fromCharCode(byte);
      this.pos += 1;
    }
    return { kind: 'name', value: name };
  }

  private skipLiteralString(): PdfValue {
    this.pos += 1; // '('
    let depth = 1;
    while (this.pos < this.bytes.length) {
      const byte = this.bytes[this.pos];
      this.pos += 1;
      if (byte === 0x5c) {
        this.pos += 1; // escaped byte, whatever it is
        continue;
      }
      if (byte === 0x28) depth += 1;
      else if (byte === 0x29) {
        depth -= 1;
        if (depth === 0) return { kind: 'string' };
      }
    }
    return undefined;
  }

  private skipHexString(): PdfValue {
    this.pos += 1; // '<'
    while (this.pos < this.bytes.length) {
      if (this.bytes[this.pos] === 0x3e) {
        this.pos += 1;
        return { kind: 'string' };
      }
      this.pos += 1;
    }
    return undefined;
  }

  private parseDict(depth: number): PdfValue {
    this.pos += 2; // '<<'
    const entries = new Map<string, PdfValue>();
    for (;;) {
      this.skipSpace();
      if (this.byteAt(this.pos) === 0x3e && this.byteAt(this.pos + 1) === 0x3e) {
        this.pos += 2;
        return { kind: 'dict', entries };
      }
      if (this.byteAt(this.pos) !== 0x2f) return undefined;
      const key = this.readName();
      const value = this.parseValue(depth + 1);
      if (value === undefined) return undefined;
      entries.set(key.value, value);
    }
  }

  private parseArray(depth: number): PdfValue {
    this.pos += 1; // '['
    const items: PdfValue[] = [];
    for (;;) {
      this.skipSpace();
      if (this.byteAt(this.pos) === 0x5d) {
        this.pos += 1;
        return { kind: 'array', items };
      }
      if (this.pos >= this.bytes.length) return undefined;
      const value = this.parseValue(depth + 1);
      if (value === undefined) return undefined;
      items.push(value);
    }
  }

  /** `12 0 R` if the three tokens are there, otherwise the plain number. */
  private parseNumberOrRef(): PdfValue {
    const saved = this.pos;
    const token = this.readToken();
    if (token === '') return undefined;
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(token)) {
      this.pos = saved;
      return undefined;
    }
    const value = Number(token);
    if (!Number.isFinite(value)) {
      this.pos = saved;
      return undefined;
    }
    if (Number.isInteger(value) && value >= 0 && !token.includes('.')) {
      const afterNumber = this.pos;
      const generation = this.readInteger();
      if (generation !== undefined && generation >= 0 && this.matchKeyword('R')) {
        return { kind: 'ref', num: value, gen: generation };
      }
      this.pos = afterNumber;
    }
    return value;
  }

  parseValue(depth = 0): PdfValue {
    if (depth > MAX_VALUE_DEPTH) return undefined;
    this.skipSpace();
    const byte = this.byteAt(this.pos);
    if (byte < 0) return undefined;
    if (byte === 0x2f) return this.readName();
    if (byte === 0x5b) return this.parseArray(depth);
    if (byte === 0x28) return this.skipLiteralString();
    if (byte === 0x3c) {
      return this.byteAt(this.pos + 1) === 0x3c ? this.parseDict(depth) : this.skipHexString();
    }
    if (byte === 0x29 || byte === 0x3e || byte === 0x5d || byte === 0x7b || byte === 0x7d) {
      return undefined;
    }
    const saved = this.pos;
    const token = this.readToken();
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return { kind: 'null' };
    this.pos = saved;
    return this.parseNumberOrRef();
  }
}

function indexOfSequence(bytes: Uint8Array, needle: readonly number[], from: number): number {
  const limit = bytes.length - needle.length;
  for (let index = Math.max(0, from); index <= limit; index += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (bytes[index + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return index;
  }
  return -1;
}

function lastIndexOfSequence(bytes: Uint8Array, needle: readonly number[]): number {
  for (let index = bytes.length - needle.length; index >= 0; index -= 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (bytes[index + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return index;
  }
  return -1;
}

function asciiBytes(text: string): number[] {
  return Array.from(text, (character) => character.charCodeAt(0));
}

const ENDSTREAM = asciiBytes('endstream');

/**
 * An indirect object at a byte offset. `expectedNum` is REQUIRED at every call
 * site: an xref that points at the wrong object is a corrupt xref, and reading
 * whatever happens to live there is how a parser invents a document.
 */
function parseIndirectObjectAt(
  bytes: Uint8Array,
  offset: number,
  expectedNum: number | undefined
): { num: number; value: PdfValue } | undefined {
  if (!Number.isInteger(offset) || offset < 0 || offset >= bytes.length) {
    return undefined;
  }
  const lexer = new PdfLexer(bytes, offset);
  const num = lexer.readInteger();
  const gen = lexer.readInteger();
  if (num === undefined || gen === undefined || !lexer.matchKeyword('obj')) {
    return undefined;
  }
  if (expectedNum !== undefined && num !== expectedNum) return undefined;
  const value = lexer.parseValue();
  if (value === undefined) return undefined;
  if (isDict(value)) {
    const saved = lexer.pos;
    if (lexer.matchKeyword('stream')) {
      // The keyword is followed by CRLF or LF, never by CR alone.
      let dataStart = lexer.pos;
      if (bytes[dataStart] === 0x0d && bytes[dataStart + 1] === 0x0a) dataStart += 2;
      else if (bytes[dataStart] === 0x0a) dataStart += 1;
      else return undefined;
      return { num, value: { kind: 'stream', dict: value, dataStart } };
    }
    lexer.pos = saved;
  }
  return { num, value };
}

// ── FILTERS ────────────────────────────────────────────────────────────────

async function inflate(data: Uint8Array): Promise<Uint8Array | undefined> {
  // `deflate` is zlib-wrapped (what /FlateDecode specifies); `deflate-raw`
  // covers producers that omit the two-byte zlib header.
  for (const format of ['deflate', 'deflate-raw'] as const) {
    try {
      const body = new Response(data.slice()).body;
      if (!body) return undefined;
      const decompressed = body.pipeThrough(new DecompressionStream(format));
      const buffer = await new Response(decompressed).arrayBuffer();
      if (buffer.byteLength > MAX_DECOMPRESSED_BYTES) return undefined;
      return new Uint8Array(buffer);
    } catch {
      continue;
    }
  }
  return undefined;
}

function paeth(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceAbove = Math.abs(estimate - above);
  const distanceUpperLeft = Math.abs(estimate - upperLeft);
  if (distanceLeft <= distanceAbove && distanceLeft <= distanceUpperLeft) return left;
  return distanceAbove <= distanceUpperLeft ? above : upperLeft;
}

/** PNG predictors 10-15, as /DecodeParms /Predictor >= 10 selects. */
function undoPngPredictor(
  data: Uint8Array,
  colors: number,
  bitsPerComponent: number,
  columns: number
): Uint8Array | undefined {
  const bytesPerPixel = Math.max(1, Math.ceil((colors * bitsPerComponent) / 8));
  const rowLength = Math.ceil((columns * colors * bitsPerComponent) / 8);
  if (rowLength <= 0) return undefined;
  const stride = rowLength + 1;
  if (data.length === 0 || data.length % stride !== 0) return undefined;
  const rows = data.length / stride;
  const out = new Uint8Array(rows * rowLength);
  let previousRow = new Uint8Array(rowLength);
  for (let row = 0; row < rows; row += 1) {
    const filter = data[row * stride];
    const source = data.subarray(row * stride + 1, row * stride + 1 + rowLength);
    const target = out.subarray(row * rowLength, (row + 1) * rowLength);
    for (let index = 0; index < rowLength; index += 1) {
      const raw = source[index];
      const left = index >= bytesPerPixel ? target[index - bytesPerPixel] : 0;
      const above = previousRow[index];
      const upperLeft = index >= bytesPerPixel ? previousRow[index - bytesPerPixel] : 0;
      let value: number;
      if (filter === 0) value = raw;
      else if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + above;
      else if (filter === 3) value = raw + ((left + above) >> 1);
      else if (filter === 4) value = raw + paeth(left, above, upperLeft);
      else return undefined;
      target[index] = value & 0xff;
    }
    previousRow = target;
  }
  return out;
}

// ── DOCUMENT ───────────────────────────────────────────────────────────────

type XrefEntry = { kind: 'offset'; offset: number } | { kind: 'instream'; streamNum: number; index: number };

class PdfDocument {
  readonly bytes: Uint8Array;
  readonly entries: Map<number, XrefEntry>;
  private readonly cache = new Map<number, PdfValue>();
  private readonly objectStreams = new Map<number, Map<number, number> | null>();
  private readonly objectStreamData = new Map<number, Uint8Array>();
  private loads = 0;
  exhausted = false;

  constructor(bytes: Uint8Array, entries: Map<number, XrefEntry>) {
    this.bytes = bytes;
    this.entries = entries;
  }

  async getObject(num: number): Promise<PdfValue> {
    const cached = this.cache.get(num);
    if (cached !== undefined || this.cache.has(num)) return cached;
    this.loads += 1;
    if (this.loads > MAX_OBJECT_LOADS) {
      this.exhausted = true;
      return undefined;
    }
    const entry = this.entries.get(num);
    let value: PdfValue = undefined;
    if (entry?.kind === 'offset') {
      value = parseIndirectObjectAt(this.bytes, entry.offset, num)?.value;
    } else if (entry?.kind === 'instream') {
      value = await this.getFromObjectStream(entry.streamNum, num);
    }
    this.cache.set(num, value);
    return value;
  }

  async resolve(value: PdfValue): Promise<PdfValue> {
    return isRef(value) ? await this.getObject(value.num) : value;
  }

  private async getFromObjectStream(streamNum: number, wantedNum: number): Promise<PdfValue> {
    if (!this.objectStreams.has(streamNum)) {
      await this.loadObjectStream(streamNum);
    }
    const offsets = this.objectStreams.get(streamNum);
    const data = this.objectStreamData.get(streamNum);
    if (!offsets || !data) return undefined;
    const offset = offsets.get(wantedNum);
    if (offset === undefined) return undefined;
    const lexer = new PdfLexer(data, offset);
    return lexer.parseValue();
  }

  private async loadObjectStream(streamNum: number): Promise<void> {
    this.objectStreams.set(streamNum, null);
    const entry = this.entries.get(streamNum);
    if (entry?.kind !== 'offset') return;
    const parsed = parseIndirectObjectAt(this.bytes, entry.offset, streamNum);
    if (!parsed || !isStream(parsed.value)) return;
    const stream = parsed.value;
    if (!isNamed(stream.dict.entries.get('Type'), 'ObjStm')) return;
    const data = await this.streamData(stream);
    if (!data) return;
    const count = asInteger(await this.resolve(stream.dict.entries.get('N')));
    const first = asInteger(await this.resolve(stream.dict.entries.get('First')));
    if (
      count === undefined ||
      first === undefined ||
      count < 0 ||
      first < 0 ||
      count > MAX_OBJECT_LOADS ||
      first > data.length
    )
      return;
    const header = new PdfLexer(data, 0);
    const offsets = new Map<number, number>();
    for (let index = 0; index < count; index += 1) {
      const objectNumber = header.readInteger();
      const relativeOffset = header.readInteger();
      if (
        objectNumber === undefined ||
        relativeOffset === undefined ||
        relativeOffset < 0 ||
        first + relativeOffset >= data.length
      )
        return;
      if (header.pos > first) return; // header must stay inside its own region
      if (!offsets.has(objectNumber)) offsets.set(objectNumber, first + relativeOffset);
    }
    this.objectStreams.set(streamNum, offsets);
    this.objectStreamData.set(streamNum, data);
  }

  /**
   * Raw stream bytes with the filter chain applied. `resolveLength` is false
   * for the cross-reference stream itself, which must be readable BEFORE any
   * xref exists to resolve an indirect `/Length` through.
   */
  async streamData(stream: PdfStream, resolveLength = true): Promise<Uint8Array | undefined> {
    const lengthValue = resolveLength
      ? await this.resolve(stream.dict.entries.get('Length'))
      : stream.dict.entries.get('Length');
    const declared = asInteger(lengthValue);
    let end = -1;
    if (declared !== undefined && declared >= 0 && stream.dataStart + declared <= this.bytes.length) {
      const after = new PdfLexer(this.bytes, stream.dataStart + declared);
      if (after.matchKeyword('endstream')) end = stream.dataStart + declared;
    }
    if (end < 0) {
      // `/Length` was absent, indirect-and-unresolvable, or wrong. Fall back to
      // the terminator, then trim the EOL the producer put before it.
      const found = indexOfSequence(this.bytes, ENDSTREAM, stream.dataStart);
      if (found < 0) return undefined;
      end = found;
      if (end > stream.dataStart && this.bytes[end - 1] === 0x0a) end -= 1;
      if (end > stream.dataStart && this.bytes[end - 1] === 0x0d) end -= 1;
    }
    const raw = this.bytes.subarray(stream.dataStart, end);
    return await applyFilters(raw, stream.dict);
  }
}

async function applyFilters(raw: Uint8Array, dict: PdfDict): Promise<Uint8Array | undefined> {
  const filter = dict.entries.get('Filter');
  const filters: PdfValue[] = filter === undefined ? [] : isArray(filter) ? filter.items : [filter];
  let data = raw;
  for (const entry of filters) {
    if (!isNamed(entry, 'FlateDecode')) return undefined; // unknown filter: refuse
    const inflated = await inflate(data);
    if (!inflated) return undefined;
    data = inflated;
  }
  if (filters.length === 0) return data;

  const parms = dict.entries.get('DecodeParms') ?? dict.entries.get('DP');
  const parmsDict = isArray(parms) ? parms.items.find((item) => isDict(item)) : parms;
  if (!isDict(parmsDict)) return data;
  const predictor = asInteger(parmsDict.entries.get('Predictor')) ?? 1;
  if (predictor <= 1) return data;
  if (predictor < 10) return undefined; // TIFF predictor: not implemented, refuse
  const colors = asInteger(parmsDict.entries.get('Colors')) ?? 1;
  const bitsPerComponent = asInteger(parmsDict.entries.get('BitsPerComponent')) ?? 8;
  const columns = asInteger(parmsDict.entries.get('Columns')) ?? 1;
  if (colors < 1 || colors > 32 || bitsPerComponent < 1 || columns < 1) {
    return undefined;
  }
  return undoPngPredictor(data, colors, bitsPerComponent, columns);
}

// ── CROSS-REFERENCE CHAIN ──────────────────────────────────────────────────

type XrefSection = {
  entries: Map<number, XrefEntry>;
  root?: PdfRef;
  encrypted: boolean;
  prev?: number;
  xrefStm?: number;
};

function parseClassicXrefSection(bytes: Uint8Array, offset: number): XrefSection | undefined {
  const lexer = new PdfLexer(bytes, offset);
  if (!lexer.matchKeyword('xref')) return undefined;
  const entries = new Map<number, XrefEntry>();
  for (;;) {
    const saved = lexer.pos;
    if (lexer.matchKeyword('trailer')) {
      const trailer = lexer.parseValue();
      if (!isDict(trailer)) return undefined;
      const root = trailer.entries.get('Root');
      const prev = asInteger(trailer.entries.get('Prev'));
      const xrefStm = asInteger(trailer.entries.get('XRefStm'));
      return {
        entries,
        ...(isRef(root) ? { root } : {}),
        encrypted: trailer.entries.has('Encrypt'),
        ...(prev === undefined ? {} : { prev }),
        ...(xrefStm === undefined ? {} : { xrefStm }),
      };
    }
    lexer.pos = saved;
    const first = lexer.readInteger();
    const count = lexer.readInteger();
    if (first === undefined || count === undefined || first < 0 || count < 0 || count > MAX_OBJECT_LOADS)
      return undefined;
    for (let index = 0; index < count; index += 1) {
      const entryOffset = lexer.readInteger();
      const generation = lexer.readInteger();
      const kind = lexer.readToken();
      if (entryOffset === undefined || generation === undefined || (kind !== 'n' && kind !== 'f')) return undefined;
      const num = first + index;
      if (kind === 'n' && entryOffset > 0 && !entries.has(num)) {
        entries.set(num, { kind: 'offset', offset: entryOffset });
      }
    }
  }
}

async function parseXrefStreamSection(
  document: PdfDocument,
  bytes: Uint8Array,
  offset: number
): Promise<XrefSection | undefined> {
  const parsed = parseIndirectObjectAt(bytes, offset, undefined);
  if (!parsed || !isStream(parsed.value)) return undefined;
  const stream = parsed.value;
  const dict = stream.dict;
  if (!isNamed(dict.entries.get('Type'), 'XRef')) return undefined;
  const widthsValue = dict.entries.get('W');
  if (!isArray(widthsValue) || widthsValue.items.length !== 3) return undefined;
  const widths = widthsValue.items.map((item) => asInteger(item));
  if (widths.some((width) => width === undefined || width < 0 || width > 8)) {
    return undefined;
  }
  const [typeWidth, secondWidth, thirdWidth] = widths as number[];
  const size = asInteger(dict.entries.get('Size'));
  const indexValue = dict.entries.get('Index');
  const ranges: Array<[number, number]> = [];
  if (isArray(indexValue)) {
    if (indexValue.items.length % 2 !== 0) return undefined;
    for (let index = 0; index < indexValue.items.length; index += 2) {
      const start = asInteger(indexValue.items[index]);
      const count = asInteger(indexValue.items[index + 1]);
      if (start === undefined || count === undefined || start < 0 || count < 0) {
        return undefined;
      }
      ranges.push([start, count]);
    }
  } else {
    if (size === undefined || size < 0) return undefined;
    ranges.push([0, size]);
  }

  const data = await document.streamData(stream, false);
  if (!data) return undefined;
  const entryWidth = typeWidth + secondWidth + thirdWidth;
  if (entryWidth <= 0) return undefined;
  const entries = new Map<number, XrefEntry>();
  let cursor = 0;
  const readField = (width: number, fallback: number): number => {
    if (width === 0) return fallback;
    let value = 0;
    for (let index = 0; index < width; index += 1) {
      value = value * 256 + data[cursor + index];
    }
    cursor += width;
    return value;
  };
  for (const [start, count] of ranges) {
    if (count > MAX_OBJECT_LOADS) return undefined;
    for (let index = 0; index < count; index += 1) {
      if (cursor + entryWidth > data.length) return undefined;
      const type = readField(typeWidth, 1);
      const second = readField(secondWidth, 0);
      const third = readField(thirdWidth, 0);
      const num = start + index;
      if (entries.has(num)) continue;
      if (type === 1 && second > 0) {
        entries.set(num, { kind: 'offset', offset: second });
      } else if (type === 2) {
        entries.set(num, { kind: 'instream', streamNum: second, index: third });
      }
    }
  }
  const root = dict.entries.get('Root');
  const prev = asInteger(dict.entries.get('Prev'));
  return {
    entries,
    ...(isRef(root) ? { root } : {}),
    encrypted: dict.entries.has('Encrypt'),
    ...(prev === undefined ? {} : { prev }),
  };
}

function findStartXref(bytes: Uint8Array): number | undefined {
  const tailStart = Math.max(0, bytes.length - STARTXREF_TAIL_BYTES);
  const tail = bytes.subarray(tailStart);
  const found = lastIndexOfSequence(tail, asciiBytes('startxref'));
  if (found < 0) return undefined;
  const lexer = new PdfLexer(bytes, tailStart + found);
  if (!lexer.matchKeyword('startxref')) return undefined;
  const offset = lexer.readInteger();
  if (offset === undefined || offset < 0 || offset >= bytes.length) return undefined;
  return offset;
}

type XrefChain = {
  entries: Map<number, XrefEntry>;
  root?: PdfRef;
  encrypted: boolean;
};

async function loadXrefChain(bytes: Uint8Array): Promise<XrefChain | undefined> {
  const start = findStartXref(bytes);
  if (start === undefined) return undefined;
  const entries = new Map<number, XrefEntry>();
  // A scratch document so the cross-reference STREAM can be inflated before any
  // xref exists; it carries no entries, which is why `streamData` is called
  // with resolveLength=false there.
  const scratch = new PdfDocument(bytes, new Map());
  const visited = new Set<number>();
  const pending: number[] = [start];
  let root: PdfRef | undefined;
  let encrypted = false;
  let sections = 0;
  while (pending.length > 0) {
    const offset = pending.shift();
    if (offset === undefined || visited.has(offset)) continue;
    visited.add(offset);
    sections += 1;
    if (sections > MAX_XREF_SECTIONS) return undefined;
    const section = parseClassicXrefSection(bytes, offset) ?? (await parseXrefStreamSection(scratch, bytes, offset));
    if (!section) return undefined;
    // NEWEST WINS: sections are visited youngest-first, so the first definition
    // of an object number is the live one and later (older) ones never override.
    for (const [num, entry] of section.entries) {
      if (!entries.has(num)) entries.set(num, entry);
    }
    if (!root && section.root) root = section.root;
    if (section.encrypted) encrypted = true;
    if (section.xrefStm !== undefined) pending.push(section.xrefStm);
    if (section.prev !== undefined) pending.push(section.prev);
  }
  return { entries, ...(root ? { root } : {}), encrypted };
}

// ── PAGE TREE WALK ─────────────────────────────────────────────────────────

type WalkOutcome =
  | { ok: true; leaves: number; declaredCount: number | undefined }
  | { ok: false; reason: PdfPageCountRefusal };

/**
 * Counts PAGE LEAVES by resolving objects and reading their `/Type`. This is a
 * structural traversal of `/Kids`, not a text scan: a `/Page` token that is not
 * a reachable, resolved leaf object is not counted, and a page hidden inside a
 * compressed object stream is.
 */
async function walkPageTree(document: PdfDocument, rootRef: PdfRef): Promise<WalkOutcome> {
  const stack: Array<{ ref: PdfRef; depth: number }> = [{ ref: rootRef, depth: 0 }];
  const visited = new Set<number>();
  let leaves = 0;
  let declaredCount: number | undefined;
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > MAX_PAGE_TREE_NODES) return { ok: false, reason: 'page-tree-too-large' };
    if (current.depth > MAX_PAGE_TREE_DEPTH) {
      return { ok: false, reason: 'page-tree-unreadable' };
    }
    // A node reachable twice is a malformed (or deliberately confusing) tree.
    // Two readers could disagree about it, so it is a refusal, not a guess.
    if (visited.has(current.ref.num)) {
      return { ok: false, reason: 'page-tree-unreadable' };
    }
    visited.add(current.ref.num);
    const node = await document.getObject(current.ref.num);
    if (document.exhausted) return { ok: false, reason: 'budget-exhausted' };
    if (!isDict(node)) return { ok: false, reason: 'page-tree-unreadable' };
    const type = node.entries.get('Type');
    if (isNamed(type, 'Page')) {
      leaves += 1;
      if (leaves > MAX_PAGE_LEAVES) return { ok: false, reason: 'page-tree-too-large' };
      continue;
    }
    const kids = await document.resolve(node.entries.get('Kids'));
    if (!isArray(kids)) return { ok: false, reason: 'page-tree-unreadable' };
    if (current.depth === 0) {
      declaredCount = asInteger(await document.resolve(node.entries.get('Count')));
    }
    for (const kid of kids.items) {
      if (!isRef(kid)) return { ok: false, reason: 'page-tree-unreadable' };
      stack.push({ ref: kid, depth: current.depth + 1 });
    }
  }
  return { ok: true, leaves, declaredCount };
}

// ── ENTRY POINT ────────────────────────────────────────────────────────────

/**
 * The number of physical pages the bytes actually contain, or a refusal.
 *
 * There is no third outcome. A caller may not fall back to anything the client
 * sent when this returns `{ ok: false }` — that fallback is the defect this
 * function was written to remove.
 */
export async function derivePdfPageCount(bytes: Uint8Array): Promise<PdfPageCountResult> {
  if (bytes.length < 8) return { ok: false, reason: 'not-a-pdf' };
  const header = String.fromCharCode(...bytes.subarray(0, 5));
  if (header !== '%PDF-') return { ok: false, reason: 'not-a-pdf' };

  const chain = await loadXrefChain(bytes);
  if (!chain) return { ok: false, reason: 'xref-unreadable' };
  // An encrypted document's page tree may be unreadable or deliberately
  // misleading without the decryption we do not implement. Refuse.
  if (chain.encrypted) return { ok: false, reason: 'encrypted' };
  if (!chain.root) return { ok: false, reason: 'catalog-unreadable' };
  if (chain.entries.size === 0) return { ok: false, reason: 'xref-unreadable' };

  const document = new PdfDocument(bytes, chain.entries);
  const catalog = await document.getObject(chain.root.num);
  if (document.exhausted) return { ok: false, reason: 'budget-exhausted' };
  if (!isDict(catalog)) return { ok: false, reason: 'catalog-unreadable' };
  const pagesRef = catalog.entries.get('Pages');
  if (!isRef(pagesRef)) return { ok: false, reason: 'catalog-unreadable' };

  const walked = await walkPageTree(document, pagesRef);
  if (!walked.ok) return walked;
  if (walked.leaves < 1) return { ok: false, reason: 'page-tree-unreadable' };
  // CORROBORATION, NOT AUTHORITY. `/Count` is what a reader that trusts
  // metadata would bill; the walked leaves are what a reader that traverses
  // would bill. When they disagree the document prices differently depending
  // on who reads it, and the only safe answer is to price it for nobody.
  if (walked.declaredCount !== undefined && walked.declaredCount !== walked.leaves) {
    return { ok: false, reason: 'page-tree-count-mismatch' };
  }
  return { ok: true, pageCount: walked.leaves };
}
