#![forbid(unsafe_code)]

use crate::{Error, Result, s};
use obsync_core::{
    hex,
    json::{Value, obj},
    sha256::sha256,
};
use std::{
    net::{Ipv4Addr, Ipv6Addr},
    time::{SystemTime, UNIX_EPOCH},
};

pub const MAX_STATE: usize = 131072;
const PLAN_MS: u64 = 300000;
const MAX_REVISION: u64 = 9007199254740991;

pub fn digest(bytes: &[u8]) -> String {
    hex::encode(&sha256(bytes))
}
pub fn hash(value: &Value) -> String {
    digest(value.to_json().as_bytes())
}
pub fn now() -> Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|v| u64::try_from(v.as_millis()).ok())
        .filter(|n| *n <= MAX_REVISION - PLAN_MS)
        .ok_or_else(|| {
            Error::new(
                "clock_invalid",
                "The local clock cannot establish a plan lifetime.",
                5,
            )
        })
}
pub fn closed(value: &Value, keys: &[&str]) -> Result<()> {
    if value.as_object().is_some_and(|pairs| {
        pairs.len() == keys.len() && pairs.iter().all(|(k, _)| keys.contains(&k.as_str()))
    }) {
        Ok(())
    } else {
        Err(Error::input("The document has missing or unknown fields."))
    }
}
pub fn field<'a>(value: &'a Value, key: &str) -> Result<&'a Value> {
    value
        .get(key)
        .ok_or_else(|| Error::input("A required field is missing."))
}
pub fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    field(value, key)?
        .as_str()
        .ok_or_else(|| Error::input("A field must be text."))
}
pub fn number(value: &Value, key: &str) -> Result<u64> {
    field(value, key)?
        .as_u64()
        .filter(|v| *v <= MAX_REVISION)
        .ok_or_else(|| Error::input("A field must be a bounded nonnegative integer."))
}
pub fn name(value: &str) -> Result<&str> {
    if !(1..=64).contains(&value.len())
        || !value.as_bytes()[0].is_ascii_lowercase()
        || !value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
    {
        return Err(Error::input(
            "Names use 1–64 lowercase letters, digits, underscores or hyphens, starting with a letter.",
        ));
    }
    Ok(value)
}
fn hex_text(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn origin(value: &str) -> Result<String> {
    let invalid = || {
        Error::input(
            "Use an HTTPS origin with a canonical ASCII host and port; credentials and paths are refused.",
        )
    };
    if value.len() > 512 || !value.is_ascii() {
        return Err(invalid());
    }
    let rest = value.strip_prefix("https://").ok_or_else(invalid)?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    let (host, port) = if rest.starts_with('[') {
        let end = rest.find(']').ok_or_else(invalid)?;
        let ip = rest[1..end].parse::<Ipv6Addr>().map_err(|_| invalid())?;
        // Match URL's compressed hexadecimal spelling, including mapped IPv4.
        let canonical = if ip.to_ipv4_mapped().is_some() {
            let segments = ip.segments();
            format!("::ffff:{:x}:{:x}", segments[6], segments[7])
        } else {
            ip.to_string()
        };
        if rest[1..end].to_ascii_lowercase() != canonical {
            return Err(invalid());
        }
        let suffix = &rest[end + 1..];
        (
            format!("[{canonical}]"),
            if suffix.is_empty() {
                None
            } else {
                Some(suffix.strip_prefix(':').ok_or_else(invalid)?)
            },
        )
    } else {
        let (host, port) = rest
            .split_once(':')
            .map_or((rest, None), |(h, p)| (h, Some(p)));
        if host.is_empty()
            || host.len() > 253
            || !host.split('.').all(|label| {
                !label.is_empty()
                    && label.len() <= 63
                    && label.as_bytes()[0].is_ascii_alphanumeric()
                    && label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
                    && label
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            })
        {
            return Err(invalid());
        }
        // WHATWG URL treats numeric final labels as IPv4: refuse its alternate
        // integer, octal, hex and short spellings instead of silently repairing.
        let last = host.rsplit('.').next().unwrap_or("");
        if last.bytes().all(|b| b.is_ascii_digit()) || last.to_ascii_lowercase().starts_with("0x") {
            let ip = host.parse::<Ipv4Addr>().map_err(|_| invalid())?;
            if ip.to_string() != host {
                return Err(invalid());
            }
        }
        (host.to_ascii_lowercase(), port)
    };
    let suffix = match port {
        None => String::new(),
        Some(p) => {
            if p.is_empty() || p.starts_with('0') || !p.bytes().all(|b| b.is_ascii_digit()) {
                return Err(invalid());
            }
            let n = p
                .parse::<u16>()
                .ok()
                .filter(|n| *n > 0)
                .ok_or_else(invalid)?;
            if n == 443 {
                String::new()
            } else {
                format!(":{n}")
            }
        }
    };
    Ok(format!("https://{host}{suffix}"))
}

#[derive(Clone, Debug)]
pub struct Context {
    pub name: String,
    pub origin: String,
    pub expected: Option<String>,
}
impl Context {
    pub fn new(label: &str, server: &str, expected: Option<&str>) -> Result<Self> {
        if expected.is_some_and(|value| !hex_text(value, 64)) {
            return Err(Error::input(
                "The expected instance must be a lowercase SHA-256 fingerprint.",
            ));
        }
        Ok(Self {
            name: name(label)?.into(),
            origin: origin(server)?,
            expected: expected.map(str::to_owned),
        })
    }
    fn parse(value: &Value) -> Result<Self> {
        closed(value, &["name", "origin", "expected_instance"])?;
        let expected = field(value, "expected_instance")?;
        let result = Self::new(
            text(value, "name")?,
            text(value, "origin")?,
            if expected.is_null() {
                None
            } else {
                Some(
                    expected
                        .as_str()
                        .ok_or_else(|| Error::input("Invalid instance fingerprint."))?,
                )
            },
        )?;
        if result.origin != text(value, "origin")? {
            return Err(Error::input(
                "Stored and planned origins must already be canonical.",
            ));
        }
        Ok(result)
    }
    pub fn json(&self) -> Value {
        obj(vec![
            ("name", s(&self.name)),
            ("origin", s(&self.origin)),
            (
                "expected_instance",
                self.expected.as_ref().map_or(Value::Null, s),
            ),
        ])
    }
}

#[derive(Clone, Debug)]
pub struct State {
    pub revision: u64,
    pub current: Option<String>,
    pub contexts: Vec<Context>,
    pub receipts: Vec<Value>,
}
impl State {
    pub fn empty() -> Self {
        Self {
            revision: 0,
            current: None,
            contexts: vec![],
            receipts: vec![],
        }
    }
    pub fn json(&self) -> Value {
        obj(vec![
            ("schema_version", Value::Int(1)),
            ("revision", Value::Int(self.revision as i64)),
            ("current", self.current.as_ref().map_or(Value::Null, s)),
            (
                "contexts",
                Value::Array(self.contexts.iter().map(Context::json).collect()),
            ),
            ("receipts", Value::Array(self.receipts.clone())),
        ])
    }
    pub fn parse(value: &Value) -> Result<Self> {
        closed(
            value,
            &[
                "schema_version",
                "revision",
                "current",
                "contexts",
                "receipts",
            ],
        )?;
        if number(value, "schema_version")? != 1 {
            return Err(Error::input("Unknown context storage version."));
        }
        let contexts = field(value, "contexts")?
            .as_array()
            .filter(|a| a.len() <= 64)
            .ok_or_else(|| Error::input("Context capacity exceeded."))?
            .iter()
            .map(Context::parse)
            .collect::<Result<Vec<_>>>()?;
        if contexts.windows(2).any(|p| p[0].name >= p[1].name) {
            return Err(Error::input("Contexts must be sorted and unique."));
        }
        let current = field(value, "current")?;
        let current = if current.is_null() {
            None
        } else {
            Some(
                current
                    .as_str()
                    .ok_or_else(|| Error::input("Invalid current context."))?
                    .to_owned(),
            )
        };
        if current
            .as_ref()
            .is_some_and(|n| !contexts.iter().any(|c| &c.name == n))
        {
            return Err(Error::input("The current context must exist."));
        }
        let revision = number(value, "revision")?;
        let receipts = field(value, "receipts")?
            .as_array()
            .filter(|a| a.len() <= 64)
            .ok_or_else(|| Error::input("Receipt capacity exceeded."))?
            .to_vec();
        let mut ids = std::collections::BTreeSet::new();
        for r in &receipts {
            closed(
                r,
                &[
                    "id",
                    "digest",
                    "expires_at",
                    "revision",
                    "operation",
                    "name",
                    "current",
                ],
            )?;
            if !hex_text(text(r, "id")?, 32)
                || !hex_text(text(r, "digest")?, 64)
                || !ids.insert(text(r, "id")?)
                || number(r, "revision")? == 0
                || number(r, "revision")? > revision
                || number(r, "expires_at")? == 0
            {
                return Err(Error::input("Invalid operation receipt."));
            }
            operation(text(r, "operation")?)?;
            name(text(r, "name")?)?;
            if !field(r, "current")?.is_null() {
                name(text(r, "current")?)?;
            }
        }
        if revision == 0 && (!contexts.is_empty() || current.is_some() || !receipts.is_empty()) {
            return Err(Error::input("Initial state must be empty."));
        }
        Ok(Self {
            revision,
            current,
            contexts,
            receipts,
        })
    }
    pub fn selected(&self, selected: Option<&str>) -> Result<&Context> {
        let selected = selected
            .or(self.current.as_deref())
            .ok_or_else(|| Error::new("context_missing", "No context is selected.", 6))?;
        name(selected)?;
        self.contexts
            .iter()
            .find(|c| c.name == selected)
            .ok_or_else(|| Error::new("context_missing", "The named context does not exist.", 6))
    }
    fn next(&self, op: &str, parameters: &Value) -> Result<Self> {
        let label = text(parameters, "name")?;
        let mut result = self.clone();
        let index = result.contexts.iter().position(|c| c.name == label);
        if op == "context.add" {
            if index.is_some() {
                return Err(Error::new(
                    "context_exists",
                    "That context already exists; targets cannot be silently replaced.",
                    5,
                ));
            }
            if result.contexts.len() == 64 {
                return Err(Error::new(
                    "context_capacity",
                    "The local context capacity is 64.",
                    9,
                ));
            }
            result.contexts.push(Context::parse(parameters)?);
            result.contexts.sort_by(|a, b| a.name.cmp(&b.name));
        } else {
            let index = index.ok_or_else(|| {
                Error::new("context_missing", "The named context does not exist.", 6)
            })?;
            if op == "context.use" {
                result.current = Some(label.into());
            } else {
                result.contexts.remove(index);
                if result.current.as_deref() == Some(label) {
                    result.current = None;
                }
            }
        }
        Ok(result)
    }
}
fn operation(op: &str) -> Result<()> {
    if ["context.add", "context.use", "context.remove"].contains(&op) {
        Ok(())
    } else {
        Err(Error::input("Unknown context operation."))
    }
}

pub struct Plan {
    pub value: Value,
}
impl Plan {
    pub fn create(state: &State, op: &str, parameters: Value, target: &str) -> Result<Self> {
        operation(op)?;
        state.next(op, &parameters)?;
        let time = now()?;
        let unsigned = obj(vec![
            ("schema_version", Value::Int(1)),
            ("operation", s(op)),
            ("parameters", parameters),
            ("revision", Value::Int(state.revision as i64)),
            ("config_digest", s(hash(&state.json()))),
            ("config_target", s(target)),
            ("created_at", Value::Int(time as i64)),
            ("expires_at", Value::Int((time + PLAN_MS) as i64)),
        ]);
        // IDs identify exact plans, not bearer credentials. Identical plans may
        // share an ID; their digest and receipt make repeating them idempotent.
        let id = hash(&unsigned)[..32].to_owned();
        let mut pairs = unsigned.as_object().unwrap().to_vec();
        pairs.insert(1, ("id".into(), s(id)));
        let digest = hash(&Value::Object(pairs.clone()));
        pairs.push(("digest".into(), s(digest)));
        Ok(Self {
            value: Value::Object(pairs),
        })
    }
    pub fn parse(value: Value, expected: &str, target: &str) -> Result<Self> {
        closed(
            &value,
            &[
                "schema_version",
                "id",
                "operation",
                "parameters",
                "revision",
                "config_digest",
                "config_target",
                "created_at",
                "expires_at",
                "digest",
            ],
        )?;
        let op = text(&value, "operation")?;
        operation(op)?;
        let parameters = field(&value, "parameters")?;
        if op == "context.add" {
            Context::parse(parameters)?;
        } else {
            closed(parameters, &["name"])?;
            name(text(parameters, "name")?)?;
        }
        if number(&value, "schema_version")? != 1
            || !hex_text(text(&value, "id")?, 32)
            || !hex_text(text(&value, "config_digest")?, 64)
            || text(&value, "config_target")? != target
            || !hex_text(expected, 64)
        {
            return Err(Error::input(
                "Invalid plan version, identity, configuration target or digest.",
            ));
        }
        number(&value, "revision")?;
        let unsigned = obj(vec![
            ("schema_version", Value::Int(1)),
            ("id", field(&value, "id")?.clone()),
            ("operation", s(op)),
            ("parameters", parameters.clone()),
            ("revision", field(&value, "revision")?.clone()),
            ("config_digest", field(&value, "config_digest")?.clone()),
            ("config_target", field(&value, "config_target")?.clone()),
            ("created_at", field(&value, "created_at")?.clone()),
            ("expires_at", field(&value, "expires_at")?.clone()),
        ]);
        if text(&value, "digest")? != expected || hash(&unsigned) != expected {
            return Err(Error::new(
                "digest_mismatch",
                "The expected digest does not match this exact plan.",
                5,
            ));
        }
        let plan = Self { value };
        plan.live()?;
        Ok(plan)
    }
    pub fn live(&self) -> Result<()> {
        let created = number(&self.value, "created_at")?;
        let expires = number(&self.value, "expires_at")?;
        let time = now()?;
        if created > time || created.checked_add(PLAN_MS) != Some(expires) || time >= expires {
            return Err(Error::new(
                "plan_expired",
                "The plan is expired or has an invalid absolute lifetime; create a fresh plan.",
                5,
            ));
        }
        Ok(())
    }
    pub fn apply(&self, state: &State) -> Result<(State, Value, bool)> {
        self.live()?;
        let id = text(&self.value, "id")?;
        if let Some(receipt) = state
            .receipts
            .iter()
            .find(|r| r.get("id").and_then(Value::as_str) == Some(id))
        {
            if field(receipt, "digest")? != field(&self.value, "digest")? {
                return Err(Error::new(
                    "digest_mismatch",
                    "The operation ID already binds a different plan.",
                    5,
                ));
            }
            return Ok((state.clone(), receipt.clone(), true));
        }
        if state.revision != number(&self.value, "revision")?
            || hash(&state.json()) != text(&self.value, "config_digest")?
            || state.revision == MAX_REVISION
        {
            return Err(Error::new(
                "revision_conflict",
                "Configuration changed after this plan; read it and create a new plan.",
                5,
            ));
        }
        let op = text(&self.value, "operation")?;
        let parameters = field(&self.value, "parameters")?;
        let mut next = state.next(op, parameters)?;
        let time = now()?;
        next.receipts.retain(|r| {
            r.get("expires_at")
                .and_then(Value::as_u64)
                .is_some_and(|t| t > time)
        });
        if next.receipts.len() == 64 {
            return Err(Error::new(
                "operation_capacity",
                "Unexpired receipts fill the bounded capacity; retry after expiry.",
                9,
            ));
        }
        next.revision += 1;
        let receipt = obj(vec![
            ("id", s(id)),
            ("digest", field(&self.value, "digest")?.clone()),
            ("expires_at", field(&self.value, "expires_at")?.clone()),
            ("revision", Value::Int(next.revision as i64)),
            ("operation", s(op)),
            ("name", field(parameters, "name")?.clone()),
            ("current", next.current.as_ref().map_or(Value::Null, s)),
        ]);
        next.receipts.push(receipt.clone());
        if next.json().to_json().len() > MAX_STATE {
            return Err(Error::new(
                "operation_capacity",
                "Configuration exceeds its byte budget.",
                9,
            ));
        }
        Ok((next, receipt, false))
    }
}
