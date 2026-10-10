//! A minimal JSON reader and writer for the oracle's line protocol (no dependencies). Integers travel as decimal
//! strings (or plain JSON numbers when small), because u64 and u128 do not fit a JSON double.

#[derive(Debug, Clone, PartialEq)]
pub enum J {
    Null,
    Bool(bool),
    /// a number token, kept as written (the oracle only reads integers)
    Num(String),
    Str(String),
    Arr(Vec<J>),
    Obj(Vec<(String, J)>),
}

pub fn parse(src: &str) -> Result<J, String> {
    let mut p = Parser {
        s: src.as_bytes(),
        i: 0,
    };
    let v = p.value()?;
    p.ws();
    if p.i != p.s.len() {
        return Err(format!("trailing input at byte {}", p.i));
    }
    Ok(v)
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
}

impl Parser<'_> {
    fn ws(&mut self) {
        while self.i < self.s.len() && matches!(self.s[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }
    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }
    fn eat(&mut self, c: u8) -> Result<(), String> {
        self.ws();
        if self.peek() == Some(c) {
            self.i += 1;
            Ok(())
        } else {
            Err(format!("expected '{}' at byte {}", c as char, self.i))
        }
    }
    fn lit(&mut self, word: &str, v: J) -> Result<J, String> {
        if self.s[self.i..].starts_with(word.as_bytes()) {
            self.i += word.len();
            Ok(v)
        } else {
            Err(format!("bad literal at byte {}", self.i))
        }
    }
    fn value(&mut self) -> Result<J, String> {
        self.ws();
        match self.peek() {
            Some(b'{') => self.object(),
            Some(b'[') => self.array(),
            Some(b'"') => Ok(J::Str(self.string()?)),
            Some(b't') => self.lit("true", J::Bool(true)),
            Some(b'f') => self.lit("false", J::Bool(false)),
            Some(b'n') => self.lit("null", J::Null),
            Some(c) if c == b'-' || c.is_ascii_digit() => {
                let start = self.i;
                self.i += 1;
                while self.i < self.s.len()
                    && (self.s[self.i].is_ascii_digit()
                        || matches!(self.s[self.i], b'.' | b'e' | b'E' | b'+' | b'-'))
                {
                    self.i += 1;
                }
                Ok(J::Num(
                    String::from_utf8_lossy(&self.s[start..self.i]).into_owned(),
                ))
            }
            _ => Err(format!("unexpected input at byte {}", self.i)),
        }
    }
    fn string(&mut self) -> Result<String, String> {
        self.eat(b'"')?;
        let mut out = String::new();
        loop {
            let c = self.peek().ok_or("unterminated string")?;
            self.i += 1;
            match c {
                b'"' => return Ok(out),
                b'\\' => {
                    let e = self.peek().ok_or("unterminated escape")?;
                    self.i += 1;
                    match e {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'n' => out.push('\n'),
                        b't' => out.push('\t'),
                        b'r' => out.push('\r'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'u' => {
                            let hex = self.s.get(self.i..self.i + 4).ok_or("short \\u escape")?;
                            let code = u32::from_str_radix(&String::from_utf8_lossy(hex), 16)
                                .map_err(|e| e.to_string())?;
                            out.push(char::from_u32(code).unwrap_or('\u{fffd}'));
                            self.i += 4;
                        }
                        _ => return Err("bad escape".into()),
                    }
                }
                _ => {
                    // multi-byte UTF-8 passes through byte by byte
                    let start = self.i - 1;
                    let mut end = self.i;
                    while end < self.s.len() && (self.s[end] & 0xC0) == 0x80 {
                        end += 1;
                    }
                    out.push_str(&String::from_utf8_lossy(&self.s[start..end]));
                    self.i = end;
                }
            }
        }
    }
    fn array(&mut self) -> Result<J, String> {
        self.eat(b'[')?;
        let mut out = Vec::new();
        self.ws();
        if self.peek() == Some(b']') {
            self.i += 1;
            return Ok(J::Arr(out));
        }
        loop {
            out.push(self.value()?);
            self.ws();
            match self.peek() {
                Some(b',') => self.i += 1,
                Some(b']') => {
                    self.i += 1;
                    return Ok(J::Arr(out));
                }
                _ => return Err(format!("expected ',' or ']' at byte {}", self.i)),
            }
        }
    }
    fn object(&mut self) -> Result<J, String> {
        self.eat(b'{')?;
        let mut out = Vec::new();
        self.ws();
        if self.peek() == Some(b'}') {
            self.i += 1;
            return Ok(J::Obj(out));
        }
        loop {
            self.ws();
            let k = self.string()?;
            self.eat(b':')?;
            out.push((k, self.value()?));
            self.ws();
            match self.peek() {
                Some(b',') => self.i += 1,
                Some(b'}') => {
                    self.i += 1;
                    return Ok(J::Obj(out));
                }
                _ => return Err(format!("expected ',' or '}}' at byte {}", self.i)),
            }
        }
    }
}

impl J {
    pub fn get(&self, key: &str) -> Result<&J, String> {
        match self {
            J::Obj(kv) => kv
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v)
                .ok_or_else(|| format!("missing field `{key}`")),
            _ => Err(format!("not an object (looking for `{key}`)")),
        }
    }
    fn digits(&self) -> Result<&str, String> {
        match self {
            J::Num(s) | J::Str(s) if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) => {
                Ok(s)
            }
            other => Err(format!("not a non-negative integer: {other:?}")),
        }
    }
    pub fn u128(&self) -> Result<u128, String> {
        self.digits()?.parse::<u128>().map_err(|e| e.to_string())
    }
    pub fn u64(&self) -> Result<u64, String> {
        self.digits()?.parse::<u64>().map_err(|e| e.to_string())
    }
    pub fn u32(&self) -> Result<u32, String> {
        self.digits()?.parse::<u32>().map_err(|e| e.to_string())
    }
    pub fn u16(&self) -> Result<u16, String> {
        self.digits()?.parse::<u16>().map_err(|e| e.to_string())
    }
    pub fn u8(&self) -> Result<u8, String> {
        self.digits()?.parse::<u8>().map_err(|e| e.to_string())
    }
    pub fn arr(&self) -> Result<&[J], String> {
        match self {
            J::Arr(v) => Ok(v),
            other => Err(format!("not an array: {other:?}")),
        }
    }
    pub fn is_null(&self) -> bool {
        matches!(self, J::Null)
    }
}

/// Writes a JSON string literal.
pub fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// A JSON object from already-encoded values, in the given order.
pub fn obj(fields: &[(&str, String)]) -> String {
    let body: Vec<String> = fields
        .iter()
        .map(|(k, v)| format!("{}:{}", quote(k), v))
        .collect();
    format!("{{{}}}", body.join(","))
}

/// An integer as a JSON decimal string.
pub fn int<T: ToString>(v: T) -> String {
    quote(&v.to_string())
}

pub fn boolean(v: bool) -> String {
    if v {
        "true".into()
    } else {
        "false".into()
    }
}
