import type { ParsedContact } from "./contact-sync";

/**
 * Read the handful of vCard fields this app actually uses.
 *
 * Deliberately hand-written rather than another dependency. Four properties are needed — FN, EMAIL, TEL,
 * ORG — and a general-purpose vCard library brings a whole grammar (structured names, photos, iana
 * extensions, vCard 2.1 quoted-printable) that would sit unused while still being code that can break.
 *
 * The parts of vCard that are genuinely easy to get wrong, and are handled here:
 *
 *   LINE FOLDING. A vCard line longer than 75 octets is split, with the continuation beginning with a
 *   single space or tab. Unfolding must happen BEFORE anything is parsed, or a long email address
 *   arrives cut in half and silently becomes two wrong values. This is the single most common vCard bug.
 *
 *   PARAMETERS. `EMAIL;TYPE=work:x@y` and `EMAIL;PREF=1;TYPE=INTERNET:x@y` are both ordinary. The
 *   property name is everything before the first ';' or ':', and the value is everything after the FIRST
 *   unquoted ':' — an address like `URL:https://x` contains a second colon that must not split it.
 *
 *   ESCAPING. Within a value, '\,' '\;' '\n' and '\\' are escapes. An organisation genuinely named
 *   "Smith, Jones & Co" arrives as `ORG:Smith\, Jones & Co`.
 *
 *   STRUCTURED VALUES. ORG is a semicolon-separated list (company;department). Only the first component
 *   is the organisation's name.
 *
 * Anything this does not understand is ignored rather than guessed at.
 */

/** Bounds, because a vCard is attacker-supplied the moment anyone can write to a shared address book. */
const MAX_CARD_BYTES = 256 * 1024;
const MAX_VALUE_LENGTH = 512;
const MAX_VALUES_PER_PROPERTY = 25;

/** Undo RFC 6350 line folding: a CRLF (or LF) followed by one space or tab is a continuation. */
function unfold(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}

/** Undo value escaping. Order matters: backslash last, or '\\n' becomes a newline. */
function unescapeValue(value: string): string {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

interface VCardLine {
  name: string;
  value: string;
}

function parseLines(card: string): VCardLine[] {
  const out: VCardLine[] = [];
  for (const raw of unfold(card).split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    // The value starts after the first colon that is not inside a quoted parameter.
    let colon = -1;
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === ":" && !inQuotes) {
        colon = i;
        break;
      }
    }
    if (colon <= 0) continue;

    const head = line.slice(0, colon);
    const value = line.slice(colon + 1);
    // Strip parameters, and any group prefix ("item1.EMAIL" is how Apple writes them).
    const name = head.split(";")[0]!.split(".").pop()!.trim().toUpperCase();
    if (!name) continue;
    out.push({ name, value });
  }
  return out;
}

function clamp(value: string): string | null {
  const trimmed = unescapeValue(value);
  return trimmed ? trimmed.slice(0, MAX_VALUE_LENGTH) : null;
}

/**
 * One vCard into a `ParsedContact`, or null when it carries nothing usable.
 *
 * `providerContactId` is supplied by the caller — for CardDAV that is the object's URL on the server,
 * which is stable and unique in a way a vCard UID is not always guaranteed to be.
 */
export function parseVCard(card: string, providerContactId: string): ParsedContact | null {
  if (!card || Buffer.byteLength(card, "utf8") > MAX_CARD_BYTES) return null;

  const lines = parseLines(card);
  if (lines.length === 0) return null;

  let displayName: string | null = null;
  let structuredName: string | null = null;
  let organizationName: string | null = null;
  const emails: string[] = [];
  const phones: string[] = [];

  for (const line of lines) {
    switch (line.name) {
      case "FN":
        displayName = displayName ?? clamp(line.value);
        break;
      case "N": {
        // Family;Given;Additional;Prefix;Suffix — used only when FN is absent, which is rare but legal.
        const parts = line.value.split(";").map((p) => unescapeValue(p));
        const given = parts[1] ?? "";
        const family = parts[0] ?? "";
        const joined = [given, family].filter(Boolean).join(" ").trim();
        structuredName = structuredName ?? (joined || null);
        break;
      }
      case "EMAIL": {
        const value = clamp(line.value);
        // A vCard email field that is not an address at all is noise, not a contact detail.
        if (value && emails.length < MAX_VALUES_PER_PROPERTY && value.includes("@") && !emails.includes(value)) emails.push(value);
        break;
      }
      case "TEL": {
        const value = clamp(line.value);
        if (value && phones.length < MAX_VALUES_PER_PROPERTY && !phones.includes(value)) phones.push(value);
        break;
      }
      case "ORG": {
        // Structured: company;department. Only the first component names the organisation.
        const company = clamp(line.value.split(";")[0] ?? "");
        organizationName = organizationName ?? company;
        break;
      }
      default:
        break;
    }
  }

  const name = displayName ?? structuredName;
  // A card with no name and no way to reach the person is not a contact worth creating.
  if (!name && emails.length === 0 && phones.length === 0) return null;

  return {
    providerContactId,
    displayName: name ?? emails[0] ?? phones[0] ?? "Unnamed contact",
    emails,
    phones,
    organizationName,
    deleted: false,
  };
}
