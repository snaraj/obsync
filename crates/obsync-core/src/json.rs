//! Strict RFC 8259 JSON, standard library only.
//!
//! The parser accepts exactly the grammar in RFC 8259 and nothing else. It
//! deliberately refuses comments, trailing commas, `NaN`, `Infinity`, hex or
//! octal numbers, leading zeros, single-quoted strings, unquoted keys, a
//! leading byte-order mark, unescaped control characters, lone surrogates,
//! and duplicate object keys. Input must be valid UTF-8.
//!
//! Duplicate keys are a parse error rather than a resolution rule: with "last
//! one wins" or "first one wins" the same bytes can mean two different things
//! to two readers, which is exactly the ambiguity a request signature is
//! supposed to remove (`docs/threat-model.md`, "Malicious client input").
//!
//! Objects keep insertion order, so [`Value::to_json`] of a parsed document
//! is byte-stable: it is the same document with every optional space removed.
//! Nesting is capped at [`MAX_DEPTH`] so a hostile document cannot exhaust the
//! stack.

use std::fmt;
use std::fmt::Write as _;

/// Maximum nesting depth of arrays and objects. The outermost container is
/// depth 1, so 64 nested arrays parse and 65 do not.
pub const MAX_DEPTH: usize = 64;

/// A parsed JSON value.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    /// JSON `null`.
    Null,
    /// JSON `true` or `false`.
    Bool(bool),
    /// A number written without a fraction or exponent that fits in `i64`.
    Int(i64),
    /// Any other number. Always finite: a document whose number overflows
    /// `f64` is refused with [`JsonErrorKind::InvalidNumber`].
    Float(f64),
    /// A string. Escapes are resolved; the content is valid UTF-8 and may
    /// contain any scalar value, including `U+0000`.
    Str(String),
    /// An array, in document order.
    Array(Vec<Value>),
    /// An object. Insertion order is preserved and keys are unique.
    Object(Vec<(String, Value)>),
}

/// Why a document was refused, and where.
#[derive(Debug, PartialEq, Eq)]
pub struct JsonError {
    /// Byte offset into the input at which the document was refused.
    pub offset: usize,
    /// What was wrong.
    pub kind: JsonErrorKind,
}

/// The reason a document was refused.
#[derive(Debug, PartialEq, Eq)]
pub enum JsonErrorKind {
    /// The document ended in the middle of a value.
    UnexpectedEof,
    /// A byte appeared where the grammar does not allow it.
    UnexpectedChar,
    /// A number is not RFC 8259 syntax, or does not fit a finite `f64`.
    InvalidNumber,
    /// A `\` escape is not one of the eight named escapes or `\uXXXX`, or a
    /// surrogate pair is malformed.
    InvalidEscape,
    /// The input is not valid UTF-8.
    InvalidUtf8,
    /// A byte below `0x20` appeared unescaped inside a string.
    ControlChar,
    /// Nesting exceeded [`MAX_DEPTH`].
    DepthExceeded,
    /// The input is longer than the caller's limit ([`parse_limited`]).
    TooLarge,
    /// One object carries the same key twice.
    DuplicateKey,
    /// A complete value was followed by something other than whitespace.
    TrailingData,
}

impl JsonErrorKind {
    /// A short, stable, human-readable reason.
    pub fn as_str(&self) -> &'static str {
        match self {
            JsonErrorKind::UnexpectedEof => "unexpected end of input",
            JsonErrorKind::UnexpectedChar => "unexpected character",
            JsonErrorKind::InvalidNumber => "invalid number",
            JsonErrorKind::InvalidEscape => "invalid escape",
            JsonErrorKind::InvalidUtf8 => "invalid utf-8",
            JsonErrorKind::ControlChar => "unescaped control character",
            JsonErrorKind::DepthExceeded => "nesting too deep",
            JsonErrorKind::TooLarge => "document too large",
            JsonErrorKind::DuplicateKey => "duplicate object key",
            JsonErrorKind::TrailingData => "trailing data",
        }
    }
}

impl fmt::Display for JsonErrorKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl fmt::Display for JsonError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} at byte {}", self.kind, self.offset)
    }
}

impl std::error::Error for JsonError {}

/// Parse one JSON document. Nesting is capped at [`MAX_DEPTH`]; the input
/// length is capped only by the slice itself.
pub fn parse(bytes: &[u8]) -> Result<Value, JsonError> {
    let text = match std::str::from_utf8(bytes) {
        Ok(text) => text,
        Err(err) => {
            return Err(JsonError {
                offset: err.valid_up_to(),
                kind: JsonErrorKind::InvalidUtf8,
            });
        }
    };
    let mut parser = Parser {
        text,
        offset: 0,
        depth: 0,
    };
    parser.skip_whitespace();
    let value = parser.value()?;
    parser.skip_whitespace();
    if parser.offset != text.len() {
        return Err(parser.error(JsonErrorKind::TrailingData));
    }
    Ok(value)
}

/// Parse one JSON document, refusing anything longer than `max_bytes` before
/// reading it. The reported offset is `max_bytes`, the point at which the
/// document became too long.
pub fn parse_limited(bytes: &[u8], max_bytes: usize) -> Result<Value, JsonError> {
    if bytes.len() > max_bytes {
        return Err(JsonError {
            offset: max_bytes,
            kind: JsonErrorKind::TooLarge,
        });
    }
    parse(bytes)
}

/// Build an object from borrowed keys. The caller owns uniqueness: passing the
/// same key twice produces a value that [`parse`] would refuse.
pub fn obj(pairs: Vec<(&str, Value)>) -> Value {
    Value::Object(
        pairs
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect(),
    )
}

struct Parser<'a> {
    text: &'a str,
    offset: usize,
    depth: usize,
}

impl<'a> Parser<'a> {
    fn bytes(&self) -> &'a [u8] {
        self.text.as_bytes()
    }

    fn peek(&self) -> Option<u8> {
        self.bytes().get(self.offset).copied()
    }

    fn error(&self, kind: JsonErrorKind) -> JsonError {
        JsonError {
            offset: self.offset,
            kind,
        }
    }

    fn at(&self, offset: usize, kind: JsonErrorKind) -> JsonError {
        JsonError { offset, kind }
    }

    /// The one place that turns "ran out of input" into an error kind.
    fn expected(&self) -> JsonError {
        match self.peek() {
            None => self.error(JsonErrorKind::UnexpectedEof),
            Some(_) => self.error(JsonErrorKind::UnexpectedChar),
        }
    }

    fn slice(&self, from: usize, to: usize) -> Result<&'a str, JsonError> {
        match self.text.get(from..to) {
            Some(text) => Ok(text),
            // Unreachable: every cut is made at an ASCII delimiter.
            None => Err(self.at(from, JsonErrorKind::InvalidUtf8)),
        }
    }

    fn skip_whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.offset += 1;
        }
    }

    fn value(&mut self) -> Result<Value, JsonError> {
        match self.peek() {
            None => Err(self.error(JsonErrorKind::UnexpectedEof)),
            Some(b'n') => self.literal("null", Value::Null),
            Some(b't') => self.literal("true", Value::Bool(true)),
            Some(b'f') => self.literal("false", Value::Bool(false)),
            Some(b'"') => Ok(Value::Str(self.string()?)),
            Some(b'[') => self.array(),
            Some(b'{') => self.object(),
            Some(b'-' | b'0'..=b'9') => self.number(),
            Some(_) => Err(self.error(JsonErrorKind::UnexpectedChar)),
        }
    }

    fn literal(&mut self, word: &str, value: Value) -> Result<Value, JsonError> {
        if self.bytes()[self.offset..].starts_with(word.as_bytes()) {
            self.offset += word.len();
            return Ok(value);
        }
        Err(self.error(JsonErrorKind::UnexpectedChar))
    }

    fn enter(&mut self) -> Result<(), JsonError> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(self.error(JsonErrorKind::DepthExceeded));
        }
        Ok(())
    }

    fn array(&mut self) -> Result<Value, JsonError> {
        self.enter()?;
        self.offset += 1;
        let mut items = Vec::new();
        self.skip_whitespace();
        if self.peek() == Some(b']') {
            self.offset += 1;
            self.depth -= 1;
            return Ok(Value::Array(items));
        }
        loop {
            self.skip_whitespace();
            items.push(self.value()?);
            self.skip_whitespace();
            match self.peek() {
                Some(b',') => self.offset += 1,
                Some(b']') => {
                    self.offset += 1;
                    break;
                }
                _ => return Err(self.expected()),
            }
        }
        self.depth -= 1;
        Ok(Value::Array(items))
    }

    fn object(&mut self) -> Result<Value, JsonError> {
        self.enter()?;
        self.offset += 1;
        let mut members: Vec<(String, Value)> = Vec::new();
        let mut key_offsets: Vec<usize> = Vec::new();
        self.skip_whitespace();
        if self.peek() == Some(b'}') {
            self.offset += 1;
            self.depth -= 1;
            return Ok(Value::Object(members));
        }
        loop {
            self.skip_whitespace();
            if self.peek() != Some(b'"') {
                return Err(self.expected());
            }
            key_offsets.push(self.offset);
            let key = self.string()?;
            self.skip_whitespace();
            if self.peek() != Some(b':') {
                return Err(self.expected());
            }
            self.offset += 1;
            self.skip_whitespace();
            let value = self.value()?;
            members.push((key, value));
            self.skip_whitespace();
            match self.peek() {
                Some(b',') => self.offset += 1,
                Some(b'}') => {
                    self.offset += 1;
                    break;
                }
                _ => return Err(self.expected()),
            }
        }
        self.depth -= 1;
        if let Some(offset) = duplicate_key_offset(&members, &key_offsets) {
            return Err(self.at(offset, JsonErrorKind::DuplicateKey));
        }
        Ok(Value::Object(members))
    }

    fn string(&mut self) -> Result<String, JsonError> {
        self.offset += 1;
        let mut out = String::new();
        let mut chunk = self.offset;
        loop {
            let byte = match self.peek() {
                Some(byte) => byte,
                None => return Err(self.error(JsonErrorKind::UnexpectedEof)),
            };
            match byte {
                b'"' => {
                    out.push_str(self.slice(chunk, self.offset)?);
                    self.offset += 1;
                    return Ok(out);
                }
                b'\\' => {
                    out.push_str(self.slice(chunk, self.offset)?);
                    self.offset += 1;
                    self.escape(&mut out)?;
                    chunk = self.offset;
                }
                0x00..=0x1f => return Err(self.error(JsonErrorKind::ControlChar)),
                _ => self.offset += 1,
            }
        }
    }

    fn escape(&mut self, out: &mut String) -> Result<(), JsonError> {
        let byte = match self.peek() {
            Some(byte) => byte,
            None => return Err(self.error(JsonErrorKind::UnexpectedEof)),
        };
        self.offset += 1;
        let resolved = match byte {
            b'"' => '"',
            b'\\' => '\\',
            b'/' => '/',
            b'b' => '\u{8}',
            b'f' => '\u{c}',
            b'n' => '\n',
            b'r' => '\r',
            b't' => '\t',
            b'u' => return self.unicode_escape(out),
            _ => {
                self.offset -= 1;
                return Err(self.error(JsonErrorKind::InvalidEscape));
            }
        };
        out.push(resolved);
        Ok(())
    }

    fn unicode_escape(&mut self, out: &mut String) -> Result<(), JsonError> {
        // Points at the backslash, so every surrogate complaint names the pair.
        let escape_at = self.offset - 2;
        let first = self.hex4(escape_at)?;
        let code = if (0xd800..0xdc00).contains(&first) {
            if !self.bytes()[self.offset..].starts_with(b"\\u") {
                return Err(self.at(escape_at, JsonErrorKind::InvalidEscape));
            }
            self.offset += 2;
            let second = self.hex4(escape_at)?;
            if !(0xdc00..0xe000).contains(&second) {
                return Err(self.at(escape_at, JsonErrorKind::InvalidEscape));
            }
            0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00)
        } else {
            // A lone low surrogate arrives here and `char::from_u32` refuses
            // it, along with every other value that is not a scalar.
            first
        };
        match char::from_u32(code) {
            Some(resolved) => out.push(resolved),
            None => return Err(self.at(escape_at, JsonErrorKind::InvalidEscape)),
        }
        Ok(())
    }

    fn hex4(&mut self, escape_at: usize) -> Result<u32, JsonError> {
        let bytes = self.bytes();
        if self.offset + 4 > bytes.len() {
            return Err(self.at(bytes.len(), JsonErrorKind::UnexpectedEof));
        }
        let mut value = 0u32;
        for byte in &bytes[self.offset..self.offset + 4] {
            match hex_digit(*byte) {
                Some(digit) => value = value * 16 + digit,
                None => return Err(self.at(escape_at, JsonErrorKind::InvalidEscape)),
            }
        }
        self.offset += 4;
        Ok(value)
    }

    fn number(&mut self) -> Result<Value, JsonError> {
        let start = self.offset;
        if self.peek() == Some(b'-') {
            self.offset += 1;
        }
        match self.peek() {
            Some(b'0') => {
                self.offset += 1;
                if matches!(self.peek(), Some(b'0'..=b'9')) {
                    return Err(self.at(start, JsonErrorKind::InvalidNumber));
                }
            }
            Some(b'1'..=b'9') => self.digits(),
            _ => return Err(self.at(start, JsonErrorKind::InvalidNumber)),
        }
        let mut fractional = false;
        if self.peek() == Some(b'.') {
            fractional = true;
            self.offset += 1;
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(self.at(start, JsonErrorKind::InvalidNumber));
            }
            self.digits();
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            fractional = true;
            self.offset += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.offset += 1;
            }
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(self.at(start, JsonErrorKind::InvalidNumber));
            }
            self.digits();
        }
        let text = self.slice(start, self.offset)?;
        if !fractional && let Ok(integer) = text.parse::<i64>() {
            return Ok(Value::Int(integer));
        }
        match text.parse::<f64>() {
            Ok(float) if float.is_finite() => Ok(Value::Float(float)),
            _ => Err(self.at(start, JsonErrorKind::InvalidNumber)),
        }
    }

    fn digits(&mut self) {
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.offset += 1;
        }
    }
}

fn hex_digit(byte: u8) -> Option<u32> {
    match byte {
        b'0'..=b'9' => Some(u32::from(byte - b'0')),
        b'a'..=b'f' => Some(u32::from(byte - b'a') + 10),
        b'A'..=b'F' => Some(u32::from(byte - b'A') + 10),
        _ => None,
    }
}

/// Offset of the earliest repeated key in an object, if any. Sorting keeps
/// this O(n log n): a linear scan per member is quadratic, which a 4 MiB body
/// of one-character keys would turn into a denial of service.
fn duplicate_key_offset(members: &[(String, Value)], offsets: &[usize]) -> Option<usize> {
    let mut keyed: Vec<(&str, usize)> = members
        .iter()
        .zip(offsets)
        .map(|((key, _), offset)| (key.as_str(), *offset))
        .collect();
    keyed.sort_unstable();
    let mut earliest: Option<usize> = None;
    for pair in keyed.windows(2) {
        if pair[0].0 == pair[1].0 {
            let repeat = pair[0].1.max(pair[1].1);
            earliest = Some(match earliest {
                Some(current) => current.min(repeat),
                None => repeat,
            });
        }
    }
    earliest
}

impl Value {
    /// Serialize to canonical JSON: no whitespace, object members in insertion
    /// order, `"` and `\` and every character below `0x20` escaped (control
    /// characters as `\u00xx`, lowercase), every other scalar value emitted as
    /// UTF-8. A `Float` whose value is integral keeps its `.0`, so parsing the
    /// output of a parsed document returns exactly the same value.
    ///
    /// A `Float` that is `NaN` or infinite cannot come from [`parse`]; it is a
    /// programming error, and it serializes as `null` rather than emitting
    /// something no JSON reader accepts.
    pub fn to_json(&self) -> String {
        let mut out = String::new();
        self.write_json(&mut out);
        out
    }

    fn write_json(&self, out: &mut String) {
        match self {
            Value::Null => out.push_str("null"),
            Value::Bool(true) => out.push_str("true"),
            Value::Bool(false) => out.push_str("false"),
            Value::Int(value) => {
                let _ = write!(out, "{value}");
            }
            Value::Float(value) => {
                if value.is_finite() {
                    let start = out.len();
                    let _ = write!(out, "{value}");
                    // Display drops the fraction of an integral float ("1",
                    // not "1.0"), which would come back from `parse` as an
                    // `Int`. Keeping the point makes the round trip exact.
                    if !out[start..].contains(['.', 'e', 'E']) {
                        out.push_str(".0");
                    }
                } else {
                    out.push_str("null");
                }
            }
            Value::Str(value) => write_escaped(value, out),
            Value::Array(items) => {
                out.push('[');
                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    item.write_json(out);
                }
                out.push(']');
            }
            Value::Object(members) => {
                out.push('{');
                for (index, (key, value)) in members.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    write_escaped(key, out);
                    out.push(':');
                    value.write_json(out);
                }
                out.push('}');
            }
        }
    }

    /// Look up a key. `None` for a missing key and for any non-object.
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Object(members) => members
                .iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value),
            _ => None,
        }
    }

    /// The string, or `None` for any other kind.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(value) => Some(value),
            _ => None,
        }
    }

    /// The boolean, or `None` for any other kind.
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(value) => Some(*value),
            _ => None,
        }
    }

    /// The integer. A `Float` never coerces, so `1.0` is not `1`.
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Value::Int(value) => Some(*value),
            _ => None,
        }
    }

    /// The integer as `u64`. `None` for a negative integer, and a `Float`
    /// never coerces.
    pub fn as_u64(&self) -> Option<u64> {
        match self {
            Value::Int(value) => u64::try_from(*value).ok(),
            _ => None,
        }
    }

    /// The number as `f64`. This is the one accessor that accepts both kinds;
    /// an `Int` beyond 2^53 loses precision.
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Value::Int(value) => Some(*value as f64),
            Value::Float(value) => Some(*value),
            _ => None,
        }
    }

    /// The array, or `None` for any other kind.
    pub fn as_array(&self) -> Option<&[Value]> {
        match self {
            Value::Array(items) => Some(items),
            _ => None,
        }
    }

    /// The object's members in insertion order, or `None` for any other kind.
    pub fn as_object(&self) -> Option<&[(String, Value)]> {
        match self {
            Value::Object(members) => Some(members),
            _ => None,
        }
    }

    /// Whether this is `null`.
    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }
}

fn write_escaped(text: &str, out: &mut String) {
    out.push('"');
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            control if (control as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", control as u32);
            }
            other => out.push(other),
        }
    }
    out.push('"');
}

impl fmt::Display for Value {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_json())
    }
}

impl From<&str> for Value {
    fn from(value: &str) -> Value {
        Value::Str(value.to_string())
    }
}

impl From<String> for Value {
    fn from(value: String) -> Value {
        Value::Str(value)
    }
}

impl From<bool> for Value {
    fn from(value: bool) -> Value {
        Value::Bool(value)
    }
}

impl From<i64> for Value {
    fn from(value: i64) -> Value {
        Value::Int(value)
    }
}

/// A `u64` above `i64::MAX` becomes a `Float` and loses precision above 2^53.
/// Nothing on the wire is that large: sequence numbers, sizes, and timestamps
/// all fit `i64`.
impl From<u64> for Value {
    fn from(value: u64) -> Value {
        match i64::try_from(value) {
            Ok(integer) => Value::Int(integer),
            Err(_) => Value::Float(value as f64),
        }
    }
}

impl From<Vec<Value>> for Value {
    fn from(value: Vec<Value>) -> Value {
        Value::Array(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn accepted(input: &str) -> Value {
        match parse(input.as_bytes()) {
            Ok(value) => value,
            Err(err) => panic!("expected accept, refused with {err}: {input:?}"),
        }
    }

    fn refused(input: &str) -> JsonError {
        match parse(input.as_bytes()) {
            Ok(value) => panic!("expected refusal, parsed {value}: {input:?}"),
            Err(err) => err,
        }
    }

    /// Documents that must parse, named after the corpus they come from:
    /// `y_*` are JSONTestSuite (github.com/nst/JSONTestSuite) accept cases and
    /// `rfc8259_*` are the examples in RFC 8259 section 13. `accept_corpus`
    /// also round-trips every one of them through [`Value::to_json`].
    const ACCEPT: &[(&str, &str)] = &[
        ("y_array_arraysWithSpaces", "[[]   ]"),
        ("y_array_empty", "[]"),
        ("y_array_empty_string", "[\"\"]"),
        ("y_array_false", "[false]"),
        ("y_array_heterogeneous", "[null, 1, \"1\", {}]"),
        ("y_array_null", "[null]"),
        ("y_array_with_1_and_newline", "[1\n]"),
        ("y_array_with_leading_space", " [1]"),
        ("y_array_with_trailing_space", "[2] "),
        ("y_number", "[123e65]"),
        ("y_number_0e+1", "[0e+1]"),
        ("y_number_0e1", "[0e1]"),
        ("y_number_after_space", "[ 4]"),
        (
            "y_number_double_close_to_zero",
            "[-0.000000000000000000000000000000000000000000000000000000000000000000000000000001]",
        ),
        ("y_number_int_with_exp", "[20e1]"),
        ("y_number_minus_zero", "[-0]"),
        ("y_number_negative_int", "[-123]"),
        ("y_number_negative_one", "[-1]"),
        ("y_number_real_capital_e", "[1E22]"),
        ("y_number_real_capital_e_neg_exp", "[1E-2]"),
        ("y_number_real_capital_e_pos_exp", "[1E+2]"),
        ("y_number_real_fraction_exponent", "[123.456e78]"),
        ("y_number_real_neg_exp", "[1e-2]"),
        ("y_number_simple_int", "[123]"),
        ("y_number_simple_real", "[123.456789]"),
        (
            "y_number_too_big_pos_int",
            "[123123123123123123123123123123]",
        ),
        ("y_object", "{\"asd\":\"sdf\", \"dfg\":\"fgh\"}"),
        ("y_object_basic", "{\"asd\":\"sdf\"}"),
        ("y_object_empty", "{}"),
        ("y_object_empty_key", "{\"\":0}"),
        ("y_object_escaped_null_in_key", "{\"foo\\u0000bar\": 42}"),
        (
            "y_object_extreme_numbers",
            "{ \"min\": -1.0e+28, \"max\": 1.0e+28 }",
        ),
        ("y_object_with_newlines", "{\n\"a\": \"b\"\n}"),
        ("y_string_allowed_escapes", r#"["\"\\\/\b\f\n\r\t"]"#),
        ("y_string_backslash_and_u_escaped_zero", r#"["\\u0000"]"#),
        ("y_string_backslash_doublequote", r#"["\""]"#),
        ("y_string_double_escape_a", r#"["\\a"]"#),
        ("y_string_escaped_control_character", "[\"\\u0012\"]"),
        ("y_string_escaped_noncharacter", "[\"\\uFFFF\"]"),
        ("y_string_last_surrogates_1_and_2", "[\"\\uDBFF\\uDFFF\"]"),
        ("y_string_nbsp_uescaped", "[\"new\\u00A0line\"]"),
        ("y_string_simple_ascii", "[\"asd \"]"),
        ("y_string_space", "\" \""),
        ("y_string_surrogates_U+1D11E", "[\"\\uD834\\uDd1e\"]"),
        ("y_string_unicode_escaped_double_quote", "[\"\\u0022\"]"),
        ("y_string_utf8", "[\"\u{20ac}\u{1d11e}\"]"),
        ("y_structure_lonely_false", "false"),
        ("y_structure_lonely_int", "42"),
        ("y_structure_lonely_negative_real", "-0.1"),
        ("y_structure_lonely_null", "null"),
        ("y_structure_lonely_string", "\"asd\""),
        ("y_structure_lonely_true", "true"),
        ("y_structure_string_empty", "\"\""),
        ("y_structure_trailing_newline", "[\"a\"]\n"),
        ("y_structure_true_in_array", "[true]"),
        ("y_structure_whitespace_array", "\t\r\n []\n"),
        (
            "rfc8259_13_object",
            r#"{
                "Image": {
                    "Width":  800,
                    "Height": 600,
                    "Title":  "View from 15th Floor",
                    "Thumbnail": {
                        "Url":    "http://www.example.com/image/481989943",
                        "Height": 125,
                        "Width":  100
                    },
                    "Animated" : false,
                    "IDs": [116, 943, 234, 38793]
                }
            }"#,
        ),
        (
            "rfc8259_13_array",
            r#"[
                {
                   "precision": "zip",
                   "Latitude":  37.7668,
                   "Longitude": -122.3959,
                   "Address":   "",
                   "City":      "SAN FRANCISCO",
                   "State":     "CA",
                   "Zip":       "94107",
                   "Country":   "US"
                }
            ]"#,
        ),
    ];

    /// Documents that must be refused, each naming the refusal it expects.
    /// `n_*` names are JSONTestSuite reject cases; `obsync_*` are this codec's
    /// own stricter rules.
    const REFUSE: &[(&str, &str, JsonErrorKind)] = &[
        (
            "n_array_1_true_without_comma",
            "[1 true]",
            JsonErrorKind::UnexpectedChar,
        ),
        (
            "n_array_colon_instead_of_comma",
            "[\"\": 1]",
            JsonErrorKind::UnexpectedChar,
        ),
        (
            "n_array_comma_after_close",
            "[\"\"],",
            JsonErrorKind::TrailingData,
        ),
        (
            "n_array_double_comma",
            "[1,,2]",
            JsonErrorKind::UnexpectedChar,
        ),
        ("n_array_extra_close", "[1]]", JsonErrorKind::TrailingData),
        ("n_array_incomplete", "[\"x\"", JsonErrorKind::UnexpectedEof),
        ("n_array_just_comma", "[,]", JsonErrorKind::UnexpectedChar),
        (
            "n_array_missing_value",
            "[   , \"\"]",
            JsonErrorKind::UnexpectedChar,
        ),
        (
            "n_array_unclosed_with_new_lines",
            "[1,\n1\n,1",
            JsonErrorKind::UnexpectedEof,
        ),
        (
            "n_number_plus_plus",
            "[++1234]",
            JsonErrorKind::UnexpectedChar,
        ),
        ("n_number_minus_01", "[-01]", JsonErrorKind::InvalidNumber),
        (
            "n_number_starting_with_dot",
            "[.2e-3]",
            JsonErrorKind::UnexpectedChar,
        ),
        ("n_number_0_dot_e1", "[0.e1]", JsonErrorKind::InvalidNumber),
        ("n_number_2_dot_e3", "[2.e3]", JsonErrorKind::InvalidNumber),
        ("n_number_1_000", "[1 000.0]", JsonErrorKind::UnexpectedChar),
        (
            "n_number_hex_1_digit",
            "[0x1]",
            JsonErrorKind::UnexpectedChar,
        ),
        (
            "n_number_infinity",
            "[Infinity]",
            JsonErrorKind::UnexpectedChar,
        ),
        ("n_number_NaN", "[NaN]", JsonErrorKind::UnexpectedChar),
        (
            "n_number_neg_int_starting_with_zero",
            "[-012]",
            JsonErrorKind::InvalidNumber,
        ),
        (
            "n_number_with_leading_zero",
            "[012]",
            JsonErrorKind::InvalidNumber,
        ),
        (
            "n_number_real_without_fractional_part",
            "[1.]",
            JsonErrorKind::InvalidNumber,
        ),
        (
            "n_number_minus_space_1",
            "[- 1]",
            JsonErrorKind::InvalidNumber,
        ),
        (
            "n_number_expression",
            "[1+2]",
            JsonErrorKind::UnexpectedChar,
        ),
        (
            "n_number_invalid_negative_real",
            "[-123.123foo]",
            JsonErrorKind::UnexpectedChar,
        ),
        (
            "obsync_number_overflows_f64",
            "[1e400]",
            JsonErrorKind::InvalidNumber,
        ),
        (
            "n_object_double_colon",
            "{\"x\"::\"b\"}",
            JsonErrorKind::UnexpectedChar,
        ),
        (
            "n_object_missing_colon",
            "{\"a\" b}",
            JsonErrorKind::UnexpectedChar,
        ),
        (
            "n_object_trailing_comma",
            "{\"id\":0,}",
            JsonErrorKind::UnexpectedChar,
        ),
        (
            "n_object_unquoted_key",
            "{a: \"b\"}",
            JsonErrorKind::UnexpectedChar,
        ),
        (
            "n_object_missing_value",
            "{\"a\":",
            JsonErrorKind::UnexpectedEof,
        ),
        (
            "n_object_key_with_single_quotes",
            "{key: 'value'}",
            JsonErrorKind::UnexpectedChar,
        ),
        (
            "n_string_1_surrogate_then_escape_u",
            "[\"\\uD800\\u\"]",
            JsonErrorKind::UnexpectedEof,
        ),
        (
            "n_string_incomplete_surrogate",
            "[\"\\uD834\\uDd\"]",
            JsonErrorKind::InvalidEscape,
        ),
        (
            "n_string_invalid_backslash_esc",
            "[\"\\a\"]",
            JsonErrorKind::InvalidEscape,
        ),
        (
            "n_string_invalid_unicode_escape",
            "[\"\\uqqqq\"]",
            JsonErrorKind::InvalidEscape,
        ),
        (
            "n_string_escape_x",
            "[\"\\x00\"]",
            JsonErrorKind::InvalidEscape,
        ),
        (
            "n_string_single_quote",
            "['single quote']",
            JsonErrorKind::UnexpectedChar,
        ),
        (
            "n_string_unescaped_tab",
            "[\"\t\"]",
            JsonErrorKind::ControlChar,
        ),
        (
            "n_string_unescaped_newline",
            "[\"new\nline\"]",
            JsonErrorKind::ControlChar,
        ),
        (
            "n_string_lone_high_surrogate",
            "[\"\\uD800\"]",
            JsonErrorKind::InvalidEscape,
        ),
        (
            "n_string_lone_low_surrogate",
            "[\"\\uDEAD\"]",
            JsonErrorKind::InvalidEscape,
        ),
        (
            "obsync_string_high_surrogate_then_bmp_escape",
            "[\"\\uD800\\u0041\"]",
            JsonErrorKind::InvalidEscape,
        ),
        ("n_structure_no_data", "", JsonErrorKind::UnexpectedEof),
        ("n_single_space", " ", JsonErrorKind::UnexpectedEof),
        (
            "n_structure_double_array",
            "[][]",
            JsonErrorKind::TrailingData,
        ),
        (
            "n_structure_object_with_comment",
            "{\"a\":/*comment*/\"b\"}",
            JsonErrorKind::UnexpectedChar,
        ),
        (
            "n_structure_unclosed_object",
            "{\"asd\":\"asd\"",
            JsonErrorKind::UnexpectedEof,
        ),
        (
            "n_structure_array_trailing_garbage",
            "[1]x",
            JsonErrorKind::TrailingData,
        ),
        (
            "n_structure_capitalized_True",
            "[True]",
            JsonErrorKind::UnexpectedChar,
        ),
        (
            "n_structure_UTF8_BOM_no_data",
            "\u{feff}{}",
            JsonErrorKind::UnexpectedChar,
        ),
        (
            "n_structure_null_byte_outside_string",
            "123\u{0}",
            JsonErrorKind::TrailingData,
        ),
        // JSONTestSuite calls the next one y_object_duplicated_key: RFC 8259
        // leaves it to the implementation and this one refuses it on purpose
        // (module docs), so the same bytes cannot mean two things.
        (
            "obsync_object_duplicated_key",
            "{\"a\":\"b\",\"a\":\"c\"}",
            JsonErrorKind::DuplicateKey,
        ),
        (
            "obsync_object_duplicated_key_nested",
            "{\"a\":{\"b\":1,\"b\":2}}",
            JsonErrorKind::DuplicateKey,
        ),
        (
            "obsync_object_duplicated_key_escaped",
            "{\"\\u0061b\":1,\"ab\":2}",
            JsonErrorKind::DuplicateKey,
        ),
        (
            "obsync_object_duplicated_key_not_adjacent",
            "{\"a\":1,\"b\":2,\"a\":3}",
            JsonErrorKind::DuplicateKey,
        ),
    ];

    #[test]
    fn accept_corpus_parses_and_round_trips() {
        for (name, input) in ACCEPT {
            let value = accepted(input);
            let serialized = value.to_json();
            match parse(serialized.as_bytes()) {
                Ok(again) => assert_eq!(value, again, "{name}: round trip changed the value"),
                Err(err) => panic!("{name}: re-parsing {serialized:?} failed with {err}"),
            }
        }
        assert_eq!(ACCEPT.len(), 58, "accept corpus size changed");
    }

    #[test]
    fn refuse_corpus_names_its_refusal() {
        for (name, input, kind) in REFUSE {
            let err = refused(input);
            assert_eq!(&err.kind, kind, "{name}: wrong refusal for {input:?}");
            assert!(
                err.offset <= input.len(),
                "{name}: offset {} past the input",
                err.offset
            );
        }
        assert_eq!(REFUSE.len(), 55, "refusal corpus size changed");
    }

    #[test]
    fn refusal_offsets_point_at_the_problem() {
        assert_eq!(
            refused("[1,2,]"),
            JsonError {
                offset: 5,
                kind: JsonErrorKind::UnexpectedChar
            }
        );
        assert_eq!(
            refused("{\"a\":1,\"a\":2}"),
            JsonError {
                offset: 7,
                kind: JsonErrorKind::DuplicateKey
            }
        );
        assert_eq!(
            refused("  true false"),
            JsonError {
                offset: 7,
                kind: JsonErrorKind::TrailingData
            }
        );
        assert_eq!(
            refused("[\"\\q\"]"),
            JsonError {
                offset: 3,
                kind: JsonErrorKind::InvalidEscape
            }
        );
    }

    #[test]
    fn invalid_utf8_is_refused_with_the_valid_prefix_offset() {
        assert_eq!(
            parse(b"[\"ab\xff\"]"),
            Err(JsonError {
                offset: 4,
                kind: JsonErrorKind::InvalidUtf8
            })
        );
        assert_eq!(
            parse(b"\xef\xbb").map_err(|err| err.kind),
            Err(JsonErrorKind::InvalidUtf8)
        );
    }

    #[test]
    fn depth_64_parses_and_65_does_not() {
        let deep = format!("{}{}", "[".repeat(64), "]".repeat(64));
        assert!(parse(deep.as_bytes()).is_ok());
        let deeper = format!("{}{}", "[".repeat(65), "]".repeat(65));
        assert_eq!(
            parse(deeper.as_bytes()).map_err(|err| err.kind),
            Err(JsonErrorKind::DepthExceeded)
        );
        let mixed = format!("{}1{}", "{\"a\":".repeat(64), "}".repeat(64));
        assert!(parse(mixed.as_bytes()).is_ok());
        let mixed_deeper = format!("{}1{}", "{\"a\":".repeat(65), "}".repeat(65));
        assert_eq!(
            parse(mixed_deeper.as_bytes()).map_err(|err| err.kind),
            Err(JsonErrorKind::DepthExceeded)
        );
    }

    #[test]
    fn integers_at_the_i64_boundaries() {
        assert_eq!(accepted("9223372036854775807"), Value::Int(i64::MAX));
        assert_eq!(accepted("-9223372036854775808"), Value::Int(i64::MIN));
        assert_eq!(
            accepted("9223372036854775808"),
            Value::Float(9223372036854775808.0)
        );
        assert_eq!(
            accepted("-9223372036854775809"),
            Value::Float(-9223372036854775809.0)
        );
        assert_eq!(accepted("0"), Value::Int(0));
        assert_eq!(accepted("-0"), Value::Int(0));
        assert_eq!(accepted("1.0"), Value::Float(1.0));
        assert_eq!(accepted("1e2"), Value::Float(100.0));
    }

    #[test]
    fn parse_limited_refuses_before_reading() {
        let body = b"{\"a\":1}";
        assert!(parse_limited(body, 7).is_ok());
        assert_eq!(
            parse_limited(body, 6),
            Err(JsonError {
                offset: 6,
                kind: JsonErrorKind::TooLarge
            })
        );
        // The length check runs first: oversize garbage never reaches the
        // parser, so a 4 MiB body costs one comparison to refuse.
        assert_eq!(
            parse_limited(b"not json at all", 4).map_err(|err| err.kind),
            Err(JsonErrorKind::TooLarge)
        );
    }

    #[test]
    fn serialization_is_canonical_and_byte_exact() {
        let value = accepted(" { \"b\" : 1 , \"a\" : [ 1 , 2 ] , \"c\" : null } ");
        assert_eq!(value.to_json(), "{\"b\":1,\"a\":[1,2],\"c\":null}");
        assert_eq!(Value::Array(Vec::new()).to_json(), "[]");
        assert_eq!(Value::Object(Vec::new()).to_json(), "{}");
        assert_eq!(Value::Bool(true).to_json(), "true");
        assert_eq!(Value::Bool(false).to_json(), "false");
        assert_eq!(Value::Null.to_json(), "null");
        assert_eq!(Value::Int(-7).to_json(), "-7");
        assert_eq!(Value::Float(1.5).to_json(), "1.5");
        // An integral float keeps its point so it does not come back as an Int.
        assert_eq!(Value::Float(1.0).to_json(), "1.0");
        assert_eq!(Value::Float(-0.0).to_json(), "-0.0");
        assert_eq!(accepted("[0e+1]"), accepted(&accepted("[0e+1]").to_json()));
        assert_eq!(
            Value::Str(String::from("\u{e9}\u{20ac}")).to_json(),
            "\"\u{e9}\u{20ac}\""
        );
    }

    #[test]
    fn serialization_escapes_exactly_the_required_characters() {
        let value = Value::Str(String::from("a\"b\\c\nd\u{1}e\u{7f}/"));
        assert_eq!(value.to_json(), "\"a\\\"b\\\\c\\u000ad\\u0001e\u{7f}/\"");
        // Control characters round-trip as lowercase four-digit escapes.
        assert_eq!(
            accepted("\"\\u0000\\u001F\"").to_json(),
            "\"\\u0000\\u001f\""
        );
    }

    #[test]
    fn non_finite_floats_serialize_as_null() {
        assert_eq!(Value::Float(f64::NAN).to_json(), "null");
        assert_eq!(Value::Float(f64::INFINITY).to_json(), "null");
        assert_eq!(Value::Float(f64::NEG_INFINITY).to_json(), "null");
    }

    #[test]
    fn display_matches_to_json() {
        let value = accepted("{\"a\":[1,\"two\",false,null]}");
        assert_eq!(value.to_string(), value.to_json());
        assert_eq!(format!("{value}"), "{\"a\":[1,\"two\",false,null]}");
    }

    #[test]
    fn surrogate_pairs_decode_to_one_scalar() {
        assert_eq!(
            accepted("\"\\uD834\\uDd1e\""),
            Value::Str(String::from("\u{1d11e}"))
        );
        assert_eq!(
            accepted("\"\\uDBFF\\uDFFF\""),
            Value::Str(String::from("\u{10ffff}"))
        );
        assert_eq!(accepted("\"\\u0041\""), Value::Str(String::from("A")));
        assert_eq!(accepted("\"\\u00e9\""), Value::Str(String::from("\u{e9}")));
        // A pair comes back out as raw UTF-8, not as escapes.
        assert_eq!(accepted("\"\\uD834\\uDd1e\"").to_json(), "\"\u{1d11e}\"");
    }

    #[test]
    fn accessors_do_not_coerce_across_kinds() {
        let value =
            accepted("{\"s\":\"x\",\"i\":3,\"f\":3.5,\"b\":true,\"n\":null,\"a\":[1],\"o\":{}}");
        assert_eq!(value.get("s").and_then(Value::as_str), Some("x"));
        assert_eq!(value.get("i").and_then(Value::as_i64), Some(3));
        assert_eq!(value.get("i").and_then(Value::as_u64), Some(3));
        assert_eq!(value.get("i").and_then(Value::as_f64), Some(3.0));
        assert_eq!(value.get("f").and_then(Value::as_f64), Some(3.5));
        assert_eq!(value.get("f").and_then(Value::as_i64), None);
        assert_eq!(value.get("f").and_then(Value::as_u64), None);
        assert_eq!(value.get("b").and_then(Value::as_bool), Some(true));
        assert_eq!(value.get("n").map(Value::is_null), Some(true));
        assert_eq!(
            value
                .get("a")
                .and_then(Value::as_array)
                .map(|items| items.len()),
            Some(1)
        );
        assert_eq!(
            value
                .get("o")
                .and_then(Value::as_object)
                .map(|members| members.len()),
            Some(0)
        );
        assert_eq!(value.get("missing"), None);
        assert_eq!(Value::Int(1).get("a"), None);
        assert_eq!(Value::Int(-1).as_u64(), None);
        assert_eq!(Value::Str(String::new()).as_f64(), None);
        assert_eq!(Value::Null.as_str(), None);
        assert!(!Value::Bool(false).is_null());
    }

    #[test]
    fn constructors_build_what_the_api_layer_sends() {
        let value = obj(vec![
            ("ready", Value::from(true)),
            ("seq", Value::from(41_i64)),
            ("name", Value::from("obsync")),
            ("owned", Value::from(String::from("s"))),
            ("list", Value::from(vec![Value::from(1_i64)])),
            ("big", Value::from(u64::MAX)),
            ("small", Value::from(7_u64)),
        ]);
        assert_eq!(value.get("small"), Some(&Value::Int(7)));
        assert_eq!(value.get("big"), Some(&Value::Float(u64::MAX as f64)));
        assert_eq!(
            value.to_json(),
            "{\"ready\":true,\"seq\":41,\"name\":\"obsync\",\"owned\":\"s\",\"list\":[1],\"big\":18446744073709552000.0,\"small\":7}"
        );
    }

    #[test]
    fn object_order_is_insertion_order() {
        let value = accepted("{\"z\":1,\"a\":2,\"m\":3}");
        let keys: Vec<&str> = value
            .as_object()
            .unwrap_or(&[])
            .iter()
            .map(|(key, _)| key.as_str())
            .collect();
        assert_eq!(keys, vec!["z", "a", "m"]);
        assert_eq!(value.to_json(), "{\"z\":1,\"a\":2,\"m\":3}");
    }

    #[test]
    fn error_display_names_the_kind_and_offset() {
        assert_eq!(
            refused("[1,]").to_string(),
            "unexpected character at byte 3"
        );
        assert_eq!(JsonErrorKind::TooLarge.as_str(), "document too large");
    }
}
