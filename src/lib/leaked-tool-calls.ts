// Manche Modelle (z.B. Llama-3.3 "-sd" auf Workers AI) geben Werkzeugaufrufe nicht
// als strukturierten tool_call aus, sondern als JSON-Text im normalen Antworttext.
// Dieses Modul erkennt solche Aufrufe, entfernt sie aus dem Text und liefert sie
// als strukturierte Aufrufe zurueck, damit sie wie echte Tool-Calls ausgefuehrt
// werden koennen. Roher JSON-Text darf den Gast nie erreichen.

export interface LeakedToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ExtractResult {
  /** Text ohne Werkzeugaufruf-JSON (bereinigt und getrimmt). */
  text: string;
  /** Erkannte Aufrufe fuer bekannte Werkzeuge, in Textreihenfolge. */
  calls: LeakedToolCall[];
}

interface Span {
  start: number;
  end: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Findet das Ende eines balancierten JSON-Objekts/-Arrays ab `start`
// (string- und escape-sicher). Gibt -1 zurueck, wenn es nicht schliesst.
function findBalancedEnd(text: string, start: number): number {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseArgs(raw: unknown): Record<string, unknown> | null {
  if (raw === undefined || raw === null) return {};
  if (isRecord(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

// Erkennt gaengige Formen:
//  {"type":"function","name":"x","parameters":{...}}
//  {"name":"x","arguments":{...}} / "arguments" als JSON-String
//  {"function":{"name":"x","arguments":...}}
//  {"tool":"x","input":{...}}
function normalizeCall(value: unknown): { name: string; args: Record<string, unknown> } | null {
  if (!isRecord(value)) return null;
  const inner = isRecord(value.function) ? value.function : value;
  const nameRaw = inner.name ?? inner.tool ?? inner.tool_name ?? inner.toolName;
  if (typeof nameRaw !== "string" || nameRaw.length === 0) return null;
  const argsRaw = inner.parameters ?? inner.arguments ?? inner.input ?? inner.args ?? value.parameters ?? value.arguments;
  const args = parseArgs(argsRaw);
  if (!args) return null;
  // Ohne Argument-Feld und ohne Funktions-Kennzeichnung ist es kein Aufruf
  // (schuetzt normale JSON-Texte, die nur ein "name"-Feld haben).
  const hasMarker =
    value.type === "function" ||
    isRecord(value.function) ||
    argsRaw !== undefined ||
    "tool" in inner ||
    "tool_name" in inner ||
    "toolName" in inner;
  if (!hasMarker) return null;
  return { name: nameRaw, args };
}

// Umgebende Huellen entfernen, die Modelle um den JSON-Block legen:
// <tool_call>...</tool_call>, <|python_tag|>, ```json ... ```
function widenSpan(text: string, span: Span): Span {
  let { start, end } = span;
  const before = text.slice(0, start);
  const after = text.slice(end + 1);
  const pre = /(?:<tool_call>|<\|python_tag\|>|<function_call>|```(?:json)?)\s*$/i.exec(before);
  if (pre) start -= pre[0].length;
  const post = /^\s*(?:<\/tool_call>|<\/function_call>|<\|eom_id\|>|```)/i.exec(after);
  if (post) end += post[0].length;
  return { start, end };
}

export function extractLeakedToolCalls(text: string, knownTools: readonly string[]): ExtractResult {
  const known = new Set(knownTools);
  const calls: LeakedToolCall[] = [];
  const spans: Span[] = [];

  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c !== "{" && c !== "[") {
      i++;
      continue;
    }
    const end = findBalancedEnd(text, i);
    if (end === -1) {
      // Abgeschnittenes Fragment, das nach Werkzeugaufruf aussieht -> ausblenden.
      const tail = text.slice(i);
      if (c === "{" && /^\{\s*"(?:type|name|function|tool)"\s*:/.test(tail)) {
        spans.push(widenSpan(text, { start: i, end: text.length - 1 }));
        break;
      }
      i++;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.slice(i, end + 1));
    } catch {
      i++;
      continue;
    }
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    const normalized = candidates.map(normalizeCall);
    if (normalized.length > 0 && normalized.every((n) => n !== null)) {
      for (const n of normalized) {
        if (n && known.has(n.name)) calls.push({ name: n.name, args: n.args });
        // Unbekannter Name: Aufruf wird verworfen, aber ebenfalls ausgeblendet.
      }
      spans.push(widenSpan(text, { start: i, end }));
      i = end + 1;
    } else {
      i++;
    }
  }

  let cleaned = "";
  let cursor = 0;
  for (const s of spans) {
    cleaned += text.slice(cursor, s.start);
    cursor = s.end + 1;
  }
  cleaned += text.slice(cursor);
  cleaned = cleaned.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
  return { text: cleaned, calls };
}
