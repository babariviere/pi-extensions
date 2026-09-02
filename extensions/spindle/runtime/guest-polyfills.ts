/**
 * Host APIs the pinned engine does not ship.
 *
 * The sandbox runs bellard/quickjs, whose global surface is ECMA-262 plus
 * nothing (see `runtime/guest-baseline.test.ts` for the pinned inventory).
 * Every Web-platform global a program might reasonably reach for is therefore
 * absent: no `TextEncoder`, no `URL`, no `atob`, no `crypto`, no
 * `structuredClone`, no `queueMicrotask`, no `performance`. None of these are
 * capabilities; they are pure computation over values the program already
 * holds, so supplying them adds ergonomics without widening what a program can
 * reach. Anything that *is* a capability (`fetch` above all) stays out
 * deliberately: the only path to the outside world must remain the audited
 * host-call table, which the filesystem sandbox and the MCP read-only policy
 * sit behind.
 *
 * Injection is conditional. `newContext()` runs per `execute()` call, so every
 * byte here is re-parsed on every single `spindle_exec` invocation. A program
 * that never mentions `URL` should not pay to parse a URL parser, so each
 * polyfill declares the identifiers that imply it and only the matching ones
 * are concatenated into the setup source. The scan is a substring test over
 * the program text, which errs toward injecting: a mention inside a comment or
 * a string still pulls the polyfill in, which is harmless. It does mean a
 * program that reaches a global purely dynamically
 * (`globalThis["Text" + "Encoder"]`) will not trigger injection.
 *
 * Every polyfill here must have a matching declaration in
 * `runtime/guest-types.ts`. These are not in `lib.es2025`, so without the
 * declaration the type-checker rejects the program with TS2304 (which, unlike
 * TS2339, is not filtered) and the runtime support is unreachable.
 */

export interface SpindleGuestPolyfill {
	/** Stable identifier, used by tests and by the entropy wiring. */
	readonly name: string;
	/** Identifiers whose presence in the program implies this polyfill. */
	readonly triggers: readonly string[];
	/** Guest JavaScript, evaluated inside the setup IIFE. */
	readonly source: string;
}

const QUEUE_MICROTASK = `
globalThis.queueMicrotask = (callback) => {
  if (typeof callback !== "function") throw new TypeError("queueMicrotask requires a function");
  Promise.resolve().then(callback);
};
`;

/**
 * Wall-clock, millisecond resolution, measured from context creation. Not
 * monotonic and deliberately no finer than Date.now(): a high-resolution timer
 * inside an in-process WASM sandbox is a timing side channel, and nothing a
 * guest program does needs sub-millisecond measurement.
 */
const PERFORMANCE = `
const __spindleTimeOrigin = Date.now();
globalThis.performance = Object.freeze({
  now: () => Date.now() - __spindleTimeOrigin,
  timeOrigin: __spindleTimeOrigin,
});
`;

const BASE64 = `
const __spindleB64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
globalThis.btoa = (input) => {
  const text = String(input);
  let out = "";
  for (let i = 0; i < text.length; i += 3) {
    const c0 = text.charCodeAt(i);
    const c1 = text.charCodeAt(i + 1);
    const c2 = text.charCodeAt(i + 2);
    if (c0 > 255 || (!Number.isNaN(c1) && c1 > 255) || (!Number.isNaN(c2) && c2 > 255)) {
      throw new TypeError("btoa: the input contains a character outside the Latin-1 range; encode it with TextEncoder first");
    }
    const packed = (c0 << 16) | ((Number.isNaN(c1) ? 0 : c1) << 8) | (Number.isNaN(c2) ? 0 : c2);
    out += __spindleB64[(packed >> 18) & 63];
    out += __spindleB64[(packed >> 12) & 63];
    out += i + 1 < text.length ? __spindleB64[(packed >> 6) & 63] : "=";
    out += i + 2 < text.length ? __spindleB64[packed & 63] : "=";
  }
  return out;
};
globalThis.atob = (input) => {
  const text = String(input).replace(/[ \\t\\n\\f\\r]/g, "");
  if (text.length % 4 === 1) throw new TypeError("atob: the input is not valid base64 (bad length)");
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const character of text) {
    if (character === "=") break;
    const value = __spindleB64.indexOf(character);
    if (value < 0) throw new TypeError("atob: the input is not valid base64 (bad character " + JSON.stringify(character) + ")");
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buffer >> bits) & 255);
    }
  }
  return out;
};
`;

/**
 * UTF-8 only, which is the encoding every caller in this environment wants.
 * Unpaired surrogates encode to U+FFFD and malformed input decodes to U+FFFD
 * (or throws under `fatal`). The streaming `{ stream: true }` option is not
 * supported: there is no incremental byte source in the guest to stream from.
 */
const TEXT_CODEC = `
const __spindleUtf8Labels = new Set(["utf-8", "utf8", "unicode-1-1-utf-8", "unicode11utf8", "unicode20utf8", "x-unicode20utf8"]);
class __SpindleTextEncoder {
  get encoding() { return "utf-8"; }
  encode(input) {
    const text = input === undefined ? "" : String(input);
    const bytes = [];
    for (let i = 0; i < text.length; i++) {
      let point = text.charCodeAt(i);
      if (point >= 0xd800 && point <= 0xdbff) {
        const low = i + 1 < text.length ? text.charCodeAt(i + 1) : Number.NaN;
        if (low >= 0xdc00 && low <= 0xdfff) {
          point = 0x10000 + ((point - 0xd800) << 10) + (low - 0xdc00);
          i++;
        } else {
          point = 0xfffd;
        }
      } else if (point >= 0xdc00 && point <= 0xdfff) {
        point = 0xfffd;
      }
      if (point < 0x80) {
        bytes.push(point);
      } else if (point < 0x800) {
        bytes.push(0xc0 | (point >> 6), 0x80 | (point & 63));
      } else if (point < 0x10000) {
        bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 63), 0x80 | (point & 63));
      } else {
        bytes.push(0xf0 | (point >> 18), 0x80 | ((point >> 12) & 63), 0x80 | ((point >> 6) & 63), 0x80 | (point & 63));
      }
    }
    return new Uint8Array(bytes);
  }
  encodeInto(source, destination) {
    if (!(destination instanceof Uint8Array)) throw new TypeError("TextEncoder.encodeInto requires a Uint8Array destination");
    const encoded = this.encode(source);
    const written = Math.min(encoded.length, destination.length);
    // Never split a code point across the boundary.
    let cut = written;
    while (cut > 0 && (encoded[cut] & 0xc0) === 0x80) cut--;
    destination.set(encoded.subarray(0, cut));
    let read = 0;
    for (let i = 0; i < cut; ) {
      const lead = encoded[i];
      const size = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
      read += size === 4 ? 2 : 1;
      i += size;
    }
    return { read, written: cut };
  }
}
class __SpindleTextDecoder {
  constructor(label, options) {
    const requested = label === undefined ? "utf-8" : String(label).trim().toLowerCase();
    if (!__spindleUtf8Labels.has(requested)) {
      throw new RangeError("TextDecoder: the sandbox implements utf-8 only, not " + JSON.stringify(requested));
    }
    const settings = options === undefined || options === null ? {} : options;
    Object.defineProperty(this, "fatal", { value: Boolean(settings.fatal), enumerable: true });
    Object.defineProperty(this, "ignoreBOM", { value: Boolean(settings.ignoreBOM), enumerable: true });
  }
  get encoding() { return "utf-8"; }
  decode(input, options) {
    if (options !== undefined && options !== null && options.stream) {
      throw new TypeError("TextDecoder.decode: the sandbox does not implement streaming decodes");
    }
    if (input === undefined || input === null) return "";
    let bytes;
    if (input instanceof Uint8Array) bytes = input;
    else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
    else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    else throw new TypeError("TextDecoder.decode expects an ArrayBuffer or a typed array");
    let out = "";
    let index = 0;
    if (!this.ignoreBOM && bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) index = 3;
    while (index < bytes.length) {
      const lead = bytes[index];
      let size = 0;
      if (lead < 0x80) size = 1;
      else if (lead >= 0xc2 && lead <= 0xdf) size = 2;
      else if (lead >= 0xe0 && lead <= 0xef) size = 3;
      else if (lead >= 0xf0 && lead <= 0xf4) size = 4;
      let point = -1;
      if (size === 1) {
        point = lead;
      } else if (size > 1 && index + size <= bytes.length) {
        let accumulated = lead & (size === 2 ? 31 : size === 3 ? 15 : 7);
        let valid = true;
        for (let k = 1; k < size; k++) {
          const continuation = bytes[index + k];
          if ((continuation & 0xc0) !== 0x80) { valid = false; break; }
          accumulated = (accumulated << 6) | (continuation & 63);
        }
        const minimum = size === 2 ? 0x80 : size === 3 ? 0x800 : 0x10000;
        if (valid && accumulated >= minimum && accumulated <= 0x10ffff && !(accumulated >= 0xd800 && accumulated <= 0xdfff)) {
          point = accumulated;
        }
      }
      if (point < 0) {
        if (this.fatal) throw new TypeError("TextDecoder.decode: the input is not valid utf-8");
        out += "\\ufffd";
        index += 1;
        continue;
      }
      out += String.fromCodePoint(point);
      index += size;
    }
    return out;
  }
}
Object.defineProperty(__SpindleTextEncoder, "name", { value: "TextEncoder" });
Object.defineProperty(__SpindleTextDecoder, "name", { value: "TextDecoder" });
globalThis.TextEncoder = __SpindleTextEncoder;
globalThis.TextDecoder = __SpindleTextDecoder;
`;

/**
 * A real structured clone, not a JSON round-trip. JSON.parse(JSON.stringify(x))
 * was already available to any program that wanted it; the reason to add this
 * global is precisely that it preserves what JSON drops (Map, Set, Date,
 * RegExp, typed arrays) and tolerates cycles. Uncloneable inputs throw rather
 * than being silently dropped, matching the platform.
 */
const STRUCTURED_CLONE = `
globalThis.structuredClone = (value) => {
  const seen = new Map();
  const clone = (input) => {
    if (input === null) return null;
    const kind = typeof input;
    if (kind === "function") throw new TypeError("structuredClone: a function could not be cloned");
    if (kind === "symbol") throw new TypeError("structuredClone: a symbol could not be cloned");
    if (kind !== "object") return input;
    if (seen.has(input)) return seen.get(input);
    if (input instanceof Date) {
      const copy = new Date(input.getTime());
      seen.set(input, copy);
      return copy;
    }
    if (input instanceof RegExp) {
      const copy = new RegExp(input.source, input.flags);
      seen.set(input, copy);
      return copy;
    }
    if (input instanceof ArrayBuffer) {
      const copy = input.slice(0);
      seen.set(input, copy);
      return copy;
    }
    if (ArrayBuffer.isView(input)) {
      const buffer = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
      const copy = input instanceof DataView ? new DataView(buffer) : new input.constructor(buffer);
      seen.set(input, copy);
      return copy;
    }
    if (input instanceof Error) {
      const copy = new input.constructor(input.message);
      seen.set(input, copy);
      if (input.stack !== undefined) copy.stack = input.stack;
      if (input.cause !== undefined) copy.cause = clone(input.cause);
      return copy;
    }
    if (Array.isArray(input)) {
      const copy = [];
      seen.set(input, copy);
      for (let i = 0; i < input.length; i++) copy[i] = clone(input[i]);
      return copy;
    }
    if (input instanceof Map) {
      const copy = new Map();
      seen.set(input, copy);
      for (const entry of input) copy.set(clone(entry[0]), clone(entry[1]));
      return copy;
    }
    if (input instanceof Set) {
      const copy = new Set();
      seen.set(input, copy);
      for (const entry of input) copy.add(clone(entry));
      return copy;
    }
    if (input instanceof WeakMap || input instanceof WeakSet || input instanceof WeakRef || input instanceof Promise) {
      throw new TypeError("structuredClone: a " + input.constructor.name + " could not be cloned");
    }
    const copy = {};
    seen.set(input, copy);
    for (const key of Object.keys(input)) copy[key] = clone(input[key]);
    return copy;
  };
  return clone(value);
};
`;

/**
 * getRandomValues has to be synchronous, and every host call in this runtime is
 * asynchronous, so the guest cannot reach the host RNG on demand. Instead the
 * host injects a fixed pool of real entropy (`__spindleEntropy`, filled from
 * node:crypto) and this draws from it. When the pool runs out the call throws:
 * degrading to Math.random() would hand back numbers that look secure and are
 * not, which is worse than failing.
 *
 * crypto.subtle is absent on purpose. It is a capability rather than a
 * convenience, and nothing in a code-mode program needs the guest to hold keys.
 */
const CRYPTO = `
const __spindleEntropyHex = globalThis.__spindleEntropy ?? "";
delete globalThis.__spindleEntropy;
const __spindleEntropyPool = new Uint8Array(__spindleEntropyHex.length / 2);
for (let i = 0; i < __spindleEntropyPool.length; i++) {
  __spindleEntropyPool[i] = Number.parseInt(__spindleEntropyHex.substr(i * 2, 2), 16);
}
let __spindleEntropyUsed = 0;
const __spindleTakeEntropy = (count) => {
  if (__spindleEntropyUsed + count > __spindleEntropyPool.length) {
    throw new Error(
      "crypto: the sandbox entropy pool (" + __spindleEntropyPool.length + " bytes) is exhausted. " +
      "getRandomValues must be synchronous, but every host call here is async, so the guest draws " +
      "from a fixed pool the host injects up front rather than falling back to Math.random(). " +
      "Ask for fewer bytes, or generate them in a pi.bash call.",
    );
  }
  const slice = __spindleEntropyPool.subarray(__spindleEntropyUsed, __spindleEntropyUsed + count);
  __spindleEntropyUsed += count;
  return slice;
};
const __spindleIntegerViews = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, BigInt64Array, BigUint64Array];
globalThis.crypto = Object.freeze({
  getRandomValues: (view) => {
    if (!__spindleIntegerViews.some((kind) => view instanceof kind)) {
      throw new TypeError("crypto.getRandomValues expects an integer typed array");
    }
    if (view.byteLength > 65536) throw new TypeError("crypto.getRandomValues accepts at most 65536 bytes");
    const bytes = __spindleTakeEntropy(view.byteLength);
    new Uint8Array(view.buffer, view.byteOffset, view.byteLength).set(bytes);
    return view;
  },
  randomUUID: () => {
    const bytes = Uint8Array.from(__spindleTakeEntropy(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [];
    for (let i = 0; i < 16; i++) hex.push(bytes[i].toString(16).padStart(2, "0"));
    return hex.slice(0, 4).join("") + "-" + hex.slice(4, 6).join("") + "-" + hex.slice(6, 8).join("") + "-" + hex.slice(8, 10).join("") + "-" + hex.slice(10, 16).join("");
  },
});
`;

/**
 * A pragmatic URL, not a WHATWG-conformant one. It covers what a code-mode
 * program actually does: parse an absolute URL, read and edit its parts,
 * resolve a relative reference against a base, and round-trip a query string.
 *
 * Known departures from the spec, all deliberate: authority parsing requires an
 * explicit "//" (so "http:example.com" is treated as opaque rather than
 * hierarchical), hostnames are lowercased but not IDNA/punycode-normalized, and
 * percent-encoding of path and host is left as the caller wrote it. Anything
 * relying on those details should not be relying on this.
 */
const URL_POLYFILL = `
const __spindleDefaultPorts = { "ftp:": "21", "file:": "", "http:": "80", "https:": "443", "ws:": "80", "wss:": "443" };
const __spindleSchemePattern = /^[A-Za-z][A-Za-z0-9+.-]*$/;

const __spindleFormEncode = (value) =>
  encodeURIComponent(String(value))
    .replace(/%20/g, "+")
    .replace(/[!'()~]/g, (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase());
const __spindleFormDecode = (value) => {
  const spaced = String(value).replace(/\\+/g, " ");
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced;
  }
};
const __spindleParseQuery = (query) => {
  const text = String(query).replace(/^\\?/, "");
  if (text === "") return [];
  const pairs = [];
  for (const chunk of text.split("&")) {
    if (chunk === "") continue;
    const separator = chunk.indexOf("=");
    if (separator < 0) pairs.push([__spindleFormDecode(chunk), ""]);
    else pairs.push([__spindleFormDecode(chunk.slice(0, separator)), __spindleFormDecode(chunk.slice(separator + 1))]);
  }
  return pairs;
};

const __spindleParamState = new WeakMap();
const __spindleParams = (receiver) => {
  const state = __spindleParamState.get(receiver);
  if (!state) throw new TypeError("URLSearchParams: the receiver is not a URLSearchParams");
  return state;
};
const __spindleParamsChanged = (state) => {
  if (state.onChange) state.onChange();
};
const __spindleInitPairs = (init) => {
  if (init === undefined || init === null) return [];
  const existing = __spindleParamState.get(init);
  if (existing) return existing.pairs.map((pair) => [pair[0], pair[1]]);
  if (typeof init === "string") return __spindleParseQuery(init);
  if (Array.isArray(init)) {
    return init.map((entry) => {
      const pair = Array.from(entry);
      if (pair.length !== 2) throw new TypeError("URLSearchParams: every init entry needs exactly two elements");
      return [String(pair[0]), String(pair[1])];
    });
  }
  if (typeof init === "object") return Object.keys(init).map((key) => [key, String(init[key])]);
  throw new TypeError("URLSearchParams: unsupported init value");
};

class __SpindleURLSearchParams {
  constructor(init) {
    __spindleParamState.set(this, { pairs: __spindleInitPairs(init), onChange: null });
  }
  get size() { return __spindleParams(this).pairs.length; }
  append(name, value) {
    const state = __spindleParams(this);
    state.pairs.push([String(name), String(value)]);
    __spindleParamsChanged(state);
  }
  delete(name, value) {
    const state = __spindleParams(this);
    const key = String(name);
    state.pairs = state.pairs.filter((pair) => pair[0] !== key || (value !== undefined && pair[1] !== String(value)));
    __spindleParamsChanged(state);
  }
  get(name) {
    const key = String(name);
    const found = __spindleParams(this).pairs.find((pair) => pair[0] === key);
    return found ? found[1] : null;
  }
  getAll(name) {
    const key = String(name);
    return __spindleParams(this).pairs.filter((pair) => pair[0] === key).map((pair) => pair[1]);
  }
  has(name, value) {
    const key = String(name);
    return __spindleParams(this).pairs.some((pair) => pair[0] === key && (value === undefined || pair[1] === String(value)));
  }
  set(name, value) {
    const state = __spindleParams(this);
    const key = String(name);
    const text = String(value);
    const index = state.pairs.findIndex((pair) => pair[0] === key);
    if (index < 0) state.pairs.push([key, text]);
    else {
      state.pairs[index] = [key, text];
      state.pairs = state.pairs.filter((pair, at) => at <= index || pair[0] !== key);
    }
    __spindleParamsChanged(state);
  }
  sort() {
    const state = __spindleParams(this);
    state.pairs = state.pairs
      .map((pair, at) => [pair, at])
      .sort((left, right) => (left[0][0] < right[0][0] ? -1 : left[0][0] > right[0][0] ? 1 : left[1] - right[1]))
      .map((entry) => entry[0]);
    __spindleParamsChanged(state);
  }
  forEach(callback, thisArg) {
    for (const pair of __spindleParams(this).pairs.slice()) callback.call(thisArg, pair[1], pair[0], this);
  }
  keys() { return __spindleParams(this).pairs.map((pair) => pair[0])[Symbol.iterator](); }
  values() { return __spindleParams(this).pairs.map((pair) => pair[1])[Symbol.iterator](); }
  entries() { return __spindleParams(this).pairs.map((pair) => [pair[0], pair[1]])[Symbol.iterator](); }
  [Symbol.iterator]() { return this.entries(); }
  toString() {
    return __spindleParams(this)
      .pairs.map((pair) => __spindleFormEncode(pair[0]) + "=" + __spindleFormEncode(pair[1]))
      .join("&");
  }
}

const __spindleNormalizePath = (pathname) => {
  const trailing = pathname.endsWith("/") || pathname.endsWith("/.") || pathname.endsWith("/..");
  const output = [];
  for (const segment of pathname.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      output.pop();
      continue;
    }
    output.push(segment);
  }
  return "/" + output.join("/") + (trailing && output.length > 0 ? "/" : "");
};

const __spindleParseAbsolute = (text) => {
  const colon = text.indexOf(":");
  if (colon < 1) return null;
  const scheme = text.slice(0, colon).toLowerCase();
  if (!__spindleSchemePattern.test(scheme)) return null;
  const protocol = scheme + ":";
  let rest = text.slice(colon + 1);
  const parsed = { protocol, username: "", password: "", hostname: "", port: "", pathname: "", search: "", hash: "", hierarchical: false };
  if (rest.startsWith("//")) {
    parsed.hierarchical = true;
    rest = rest.slice(2);
    const boundary = /[/?#]/.exec(rest);
    let authority = boundary ? rest.slice(0, boundary.index) : rest;
    rest = boundary ? rest.slice(boundary.index) : "";
    const at = authority.lastIndexOf("@");
    if (at >= 0) {
      const credentials = authority.slice(0, at);
      authority = authority.slice(at + 1);
      const separator = credentials.indexOf(":");
      parsed.username = separator < 0 ? credentials : credentials.slice(0, separator);
      parsed.password = separator < 0 ? "" : credentials.slice(separator + 1);
    }
    if (authority.startsWith("[")) {
      const close = authority.indexOf("]");
      if (close < 0) throw new TypeError("Invalid URL: unterminated IPv6 host in " + JSON.stringify(text));
      parsed.hostname = authority.slice(0, close + 1).toLowerCase();
      const tail = authority.slice(close + 1);
      if (tail.startsWith(":")) parsed.port = tail.slice(1);
      else if (tail !== "") throw new TypeError("Invalid URL: unexpected text after the IPv6 host in " + JSON.stringify(text));
    } else {
      const separator = authority.lastIndexOf(":");
      if (separator >= 0) {
        parsed.hostname = authority.slice(0, separator).toLowerCase();
        parsed.port = authority.slice(separator + 1);
      } else {
        parsed.hostname = authority.toLowerCase();
      }
    }
    if (parsed.port !== "") {
      if (!/^[0-9]+$/.test(parsed.port) || Number(parsed.port) > 65535) {
        throw new TypeError("Invalid URL: " + JSON.stringify(parsed.port) + " is not a valid port in " + JSON.stringify(text));
      }
      parsed.port = String(Number(parsed.port));
    }
    if (__spindleDefaultPorts[protocol] === parsed.port) parsed.port = "";
    const special = Object.prototype.hasOwnProperty.call(__spindleDefaultPorts, protocol);
    if (special && protocol !== "file:" && parsed.hostname === "") {
      throw new TypeError("Invalid URL: missing host in " + JSON.stringify(text));
    }
  }
  const hashAt = rest.indexOf("#");
  if (hashAt >= 0) {
    parsed.hash = rest.slice(hashAt);
    rest = rest.slice(0, hashAt);
  }
  const queryAt = rest.indexOf("?");
  if (queryAt >= 0) {
    parsed.search = rest.slice(queryAt);
    rest = rest.slice(0, queryAt);
  }
  if (parsed.hierarchical) {
    parsed.pathname = __spindleNormalizePath(rest === "" ? "/" : rest.startsWith("/") ? rest : "/" + rest);
  } else {
    parsed.pathname = rest;
  }
  if (parsed.hash === "#") parsed.hash = "";
  if (parsed.search === "?") parsed.search = "";
  return parsed;
};

const __spindleAuthorityPrefix = (parsed) => {
  if (!parsed.hierarchical) throw new TypeError("Invalid URL: cannot resolve a relative reference against an opaque base URL");
  let out = parsed.protocol + "//";
  if (parsed.username !== "" || parsed.password !== "") {
    out += parsed.username + (parsed.password !== "" ? ":" + parsed.password : "") + "@";
  }
  out += parsed.hostname;
  if (parsed.port !== "") out += ":" + parsed.port;
  return out;
};

const __spindleSerialize = (parsed) =>
  (parsed.hierarchical ? __spindleAuthorityPrefix(parsed) : parsed.protocol) + parsed.pathname + parsed.search + parsed.hash;

const __spindleParseUrl = (input, base) => {
  const text = String(input).trim();
  const absolute = __spindleParseAbsolute(text);
  if (absolute) return absolute;
  if (base === undefined || base === null) throw new TypeError("Invalid URL: " + JSON.stringify(text));
  const baseParsed = __spindleParseUrl(base, undefined);
  const prefix = __spindleAuthorityPrefix(baseParsed);
  if (text === "") return __spindleParseAbsolute(prefix + baseParsed.pathname + baseParsed.search);
  if (text.startsWith("//")) return __spindleParseAbsolute(baseParsed.protocol + text);
  if (text.startsWith("/")) return __spindleParseAbsolute(prefix + text);
  if (text.startsWith("?")) return __spindleParseAbsolute(prefix + baseParsed.pathname + text);
  if (text.startsWith("#")) return __spindleParseAbsolute(prefix + baseParsed.pathname + baseParsed.search + text);
  const directory = baseParsed.pathname.slice(0, baseParsed.pathname.lastIndexOf("/") + 1);
  return __spindleParseAbsolute(prefix + directory + text);
};

const __spindleUrlState = new WeakMap();
const __spindleUrl = (receiver) => {
  const state = __spindleUrlState.get(receiver);
  if (!state) throw new TypeError("URL: the receiver is not a URL");
  return state;
};

class __SpindleURL {
  constructor(url, base) {
    const parsed = __spindleParseUrl(url, base);
    const params = new __SpindleURLSearchParams(parsed.search);
    const state = { parsed, params };
    __spindleUrlState.set(this, state);
    __spindleParams(params).onChange = () => {
      const query = params.toString();
      state.parsed.search = query === "" ? "" : "?" + query;
    };
  }
  get href() { return __spindleSerialize(__spindleUrl(this).parsed); }
  set href(value) {
    const state = __spindleUrl(this);
    state.parsed = __spindleParseUrl(value, undefined);
    __spindleParams(state.params).pairs = __spindleParseQuery(state.parsed.search);
  }
  get protocol() { return __spindleUrl(this).parsed.protocol; }
  set protocol(value) {
    const scheme = String(value).replace(/:$/, "").toLowerCase();
    if (!__spindleSchemePattern.test(scheme)) throw new TypeError("URL: invalid protocol " + JSON.stringify(value));
    __spindleUrl(this).parsed.protocol = scheme + ":";
  }
  get username() { return __spindleUrl(this).parsed.username; }
  set username(value) { __spindleUrl(this).parsed.username = String(value); }
  get password() { return __spindleUrl(this).parsed.password; }
  set password(value) { __spindleUrl(this).parsed.password = String(value); }
  get hostname() { return __spindleUrl(this).parsed.hostname; }
  set hostname(value) { __spindleUrl(this).parsed.hostname = String(value).toLowerCase(); }
  get port() { return __spindleUrl(this).parsed.port; }
  set port(value) {
    const text = String(value);
    const parsed = __spindleUrl(this).parsed;
    if (text === "") {
      parsed.port = "";
      return;
    }
    if (!/^[0-9]+$/.test(text) || Number(text) > 65535) throw new TypeError("URL: invalid port " + JSON.stringify(value));
    parsed.port = __spindleDefaultPorts[parsed.protocol] === String(Number(text)) ? "" : String(Number(text));
  }
  get host() {
    const parsed = __spindleUrl(this).parsed;
    return parsed.port === "" ? parsed.hostname : parsed.hostname + ":" + parsed.port;
  }
  set host(value) {
    const text = String(value);
    const separator = text.lastIndexOf(":");
    if (separator > text.indexOf("]")) {
      this.hostname = text.slice(0, separator);
      this.port = text.slice(separator + 1);
    } else {
      this.hostname = text;
    }
  }
  get pathname() { return __spindleUrl(this).parsed.pathname; }
  set pathname(value) {
    const parsed = __spindleUrl(this).parsed;
    const text = String(value);
    parsed.pathname = parsed.hierarchical ? __spindleNormalizePath(text.startsWith("/") ? text : "/" + text) : text;
  }
  get search() { return __spindleUrl(this).parsed.search; }
  set search(value) {
    const state = __spindleUrl(this);
    const text = String(value);
    state.parsed.search = text === "" || text === "?" ? "" : text.startsWith("?") ? text : "?" + text;
    __spindleParams(state.params).pairs = __spindleParseQuery(state.parsed.search);
  }
  get searchParams() { return __spindleUrl(this).params; }
  get hash() { return __spindleUrl(this).parsed.hash; }
  set hash(value) {
    const text = String(value);
    __spindleUrl(this).parsed.hash = text === "" || text === "#" ? "" : text.startsWith("#") ? text : "#" + text;
  }
  get origin() {
    const parsed = __spindleUrl(this).parsed;
    const special = Object.prototype.hasOwnProperty.call(__spindleDefaultPorts, parsed.protocol);
    if (!parsed.hierarchical || !special || parsed.protocol === "file:") return "null";
    return parsed.protocol + "//" + this.host;
  }
  toString() { return this.href; }
  toJSON() { return this.href; }
}
Object.defineProperty(__SpindleURL, "name", { value: "URL" });
Object.defineProperty(__SpindleURLSearchParams, "name", { value: "URLSearchParams" });
globalThis.URL = __SpindleURL;
globalThis.URLSearchParams = __SpindleURLSearchParams;
`;

/** The polyfill that draws on host-injected entropy. */
export const CRYPTO_POLYFILL_NAME = "crypto";

/** Bytes of real entropy the host injects when the crypto polyfill is active. */
export const ENTROPY_POOL_BYTES = 4096;

export const SPINDLE_GUEST_POLYFILLS: readonly SpindleGuestPolyfill[] = [
	{ name: "queueMicrotask", triggers: ["queueMicrotask"], source: QUEUE_MICROTASK },
	{ name: "performance", triggers: ["performance"], source: PERFORMANCE },
	{ name: "base64", triggers: ["atob", "btoa"], source: BASE64 },
	{ name: "textCodec", triggers: ["TextEncoder", "TextDecoder"], source: TEXT_CODEC },
	{ name: "structuredClone", triggers: ["structuredClone"], source: STRUCTURED_CLONE },
	{ name: CRYPTO_POLYFILL_NAME, triggers: ["crypto"], source: CRYPTO },
	{ name: "url", triggers: ["URL", "URLSearchParams"], source: URL_POLYFILL },
];

/** The polyfills a program's text implies, in declaration order. */
export const selectGuestPolyfills = (code: string): readonly SpindleGuestPolyfill[] =>
	SPINDLE_GUEST_POLYFILLS.filter((polyfill) => polyfill.triggers.some((trigger) => code.includes(trigger)));

export interface SpindleGuestPolyfillPlan {
	/** Guest source to evaluate after GUEST_SETUP, or "" when nothing is needed. */
	readonly source: string;
	/** Names selected, for tests and diagnostics. */
	readonly names: readonly string[];
	/** True when the host must inject `__spindleEntropy` before evaluating. */
	readonly needsEntropy: boolean;
}

export const guestPolyfillPlan = (code: string): SpindleGuestPolyfillPlan => {
	const selected = selectGuestPolyfills(code);
	const names = selected.map((polyfill) => polyfill.name);
	return {
		source:
			selected.length === 0
				? ""
				: "(() => {\n" + selected.map((polyfill) => polyfill.source).join("\n") + "\n})();\n",
		names,
		needsEntropy: names.includes(CRYPTO_POLYFILL_NAME),
	};
};
