'use strict';

// Token-aware translation of Opera 12 CSS prefixes. The scanner walks the
// stylesheet once, copying comments, strings, and url() bodies verbatim, and
// rewrites only complete identifier / at-keyword tokens that exactly match the
// recognized set below. Substrings inside longer identifiers (for example a
// class named `.x-o-transform`) are not tokens of their own and are untouched.

const PREFIXED_PROPERTIES = new Set([
  'transform', 'transform-origin', 'transform-style',
  'transition', 'transition-property', 'transition-duration',
  'transition-timing-function', 'transition-delay',
  'animation', 'animation-name', 'animation-duration', 'animation-timing-function',
  'animation-delay', 'animation-iteration-count', 'animation-direction',
  'animation-fill-mode', 'animation-play-state',
  'user-select', 'text-overflow',
]);

const PREFIXED_FUNCTIONS = new Set(['linear-gradient']);
const PREFIXED_AT_RULES = new Set(['keyframes']);

function isNameChar(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
    c === '-' || c === '_' || c > '\x7f';
}

// Read an identifier-like run (including escapes) starting at i.
function readName(css, i) {
  let j = i;
  while (j < css.length) {
    const c = css[j];
    if (c === '\\' && j + 1 < css.length && css[j + 1] !== '\n') { j += 2; continue; }
    if (!isNameChar(c)) break;
    j++;
  }
  return j;
}

function skipString(css, i) {
  const quote = css[i];
  let j = i + 1;
  while (j < css.length) {
    const c = css[j];
    if (c === '\\') { j += 2; continue; }
    if (c === quote || c === '\n') return j + 1;
    j++;
  }
  return css.length;
}

function skipComment(css, i) {
  const end = css.indexOf('*/', i + 2);
  return end === -1 ? css.length : end + 2;
}

// Unquoted url(...) contents are a single token in CSS; copy them verbatim.
function skipUrlBody(css, i) {
  let j = i;
  while (j < css.length && /\s/.test(css[j])) j++;
  if (css[j] === '"' || css[j] === "'") return i; // quoted: handled as a string
  while (j < css.length && css[j] !== ')') {
    if (css[j] === '\\') j++;
    j++;
  }
  return j;
}

function translateName(name, next) {
  const lower = name.toLowerCase();
  if (!lower.startsWith('-o-')) return null;
  const bare = lower.slice(3);
  if (next === '(') return PREFIXED_FUNCTIONS.has(bare) ? bare : null;
  return PREFIXED_PROPERTIES.has(bare) ? bare : null;
}

const OPPOSITE_SIDE = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

// Legacy gradients name the starting side ("top") and measure angles from
// east, counter-clockwise; the standard syntax names the ending side ("to
// bottom") and measures from north, clockwise. Returns null when the first
// argument is not a direction (for example, a color).
function standardDirection(arg) {
  const sides = arg.toLowerCase().split(/\s+/);
  if (sides.length <= 2 && sides.every((s) => OPPOSITE_SIDE[s])) return 'to ' + sides.map((s) => OPPOSITE_SIDE[s]).join(' ');
  const angle = /^(-?(?:\d+(?:\.\d*)?|\.\d+))deg$/i.exec(arg);
  return angle ? `${90 - Number(angle[1])}deg` : null;
}

function transformCss(css) {
  let out = '';
  let i = 0;
  let changes = 0;
  while (i < css.length) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') {
      const end = skipComment(css, i);
      out += css.slice(i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = skipString(css, i);
      out += css.slice(i, end);
      i = end;
      continue;
    }
    if (c === '@') {
      const end = readName(css, i + 1);
      const name = css.slice(i + 1, end);
      const lower = name.toLowerCase();
      if (lower.startsWith('-o-') && PREFIXED_AT_RULES.has(lower.slice(3))) {
        out += '@' + lower.slice(3);
        changes++;
      } else {
        out += css.slice(i, end);
      }
      i = end;
      continue;
    }
    if (isNameChar(c) || c === '\\') {
      // Start of an identifier/number/hash-name run. A token begins here only
      // because the previous character was not a name character.
      const end = readName(css, i);
      const name = css.slice(i, end);
      const prev = i > 0 ? css[i - 1] : '';
      const standalone = prev !== '#' && prev !== '.';
      const translated = standalone ? translateName(name, css[end]) : null;
      if (translated) {
        out += translated;
        changes++;
      } else {
        out += name;
      }
      i = end;
      if (translated === 'linear-gradient') {
        // A direction argument is short; bounding the look-ahead keeps
        // translation linear on files full of unterminated gradients.
        const window = css.slice(i, i + 64);
        const comma = window.indexOf(',');
        const paren = window.indexOf(')');
        if (comma !== -1 && (paren === -1 || comma < paren)) {
          const raw = window.slice(1, comma);
          const converted = standardDirection(raw.trim());
          if (converted) {
            out += '(' + raw.replace(raw.trim(), converted);
            i += comma;
          }
        }
      }
      if (name.toLowerCase() === 'url' && css[i] === '(') {
        out += '(';
        i++;
        const bodyEnd = skipUrlBody(css, i);
        out += css.slice(i, bodyEnd);
        i = bodyEnd;
      }
      continue;
    }
    out += c;
    i++;
  }
  return { css: out, changes };
}

module.exports = { transformCss };
