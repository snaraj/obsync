//! Configuration, from the environment only (docs/architecture.md §9).
//!
//! Containers and charts need no config file, and there is no config file
//! parser to attack. Every variable is parsed and validated once at startup;
//! an unknown `OBSYNC_*` variable is a startup error, so a typo fails the pod
//! instead of silently running with a default (AGENTS.md requirement 4).
//!
//! No error message ever carries a variable's value: `OBSYNC_SERVER_KEY`
//! holds key material, and an error is a log line waiting to happen
//! (requirement 6).
//!
//! This is the one file allowed to name an edge provider, because
//! `OBSYNC_EDGE` is a provider-selecting value; `doctrine_test` pins that.
//! Code elsewhere asks [`Edge::requires_edge_headers`] instead of naming one.
#![forbid(unsafe_code)]

use std::fmt;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;

use crate::log::{Log, LogLevel, Val};
use obsync_core::hex;

/// Everything `obsyncd` needs to run, parsed from the environment.
#[derive(Clone, PartialEq, Eq)]
pub struct Config {
    /// HTTP listener (`OBSYNC_LISTEN`).
    pub listen: SocketAddr,
    /// Chunk volume (`OBSYNC_BLOBS_DIR`).
    pub blobs_dir: PathBuf,
    /// Journal, snapshots, server key (`OBSYNC_JOURNAL_DIR`).
    pub journal_dir: PathBuf,
    /// Extra blob copies, written before every acknowledgement.
    pub blobs_mirrors: Vec<MirrorVolume>,
    /// Declared capacity of the blob volume (`OBSYNC_BLOBS_CAPACITY`).
    pub blobs_capacity: u64,
    /// Declared capacity of the journal volume (`OBSYNC_JOURNAL_CAPACITY`).
    pub journal_capacity: u64,
    /// Display label for the blob volume's class (`OBSYNC_BLOBS_CLASS`).
    pub blobs_class: String,
    /// Display label for the journal volume's class (`OBSYNC_JOURNAL_CLASS`).
    pub journal_class: String,
    /// Dashboard static files (`OBSYNC_DASHBOARD_DIR`).
    pub dashboard_dir: PathBuf,
    /// Plugin bundle (`OBSYNC_PLUGIN_DIR`).
    pub plugin_dir: PathBuf,
    /// Which edge behaviour to require (`OBSYNC_EDGE`).
    pub edge: Edge,
    /// Networks whose forwarded-address header is trusted in `none` mode.
    pub trusted_proxy_cidrs: Vec<Cidr>,
    /// Public URL shown on pairing and install pages (`OBSYNC_PUBLIC_URL`).
    pub public_url: Option<String>,
    /// Server key (`OBSYNC_SERVER_KEY`); generated once at first boot if unset.
    pub server_key: Option<[u8; 32]>,
    /// Free-space refusal threshold (`OBSYNC_FREE_WATERMARK`).
    pub free_watermark: Watermark,
    /// Version and tombstone retention in days (`OBSYNC_RETENTION_DAYS`).
    pub retention_days: u32,
    /// Minimum versions kept per file (`OBSYNC_RETENTION_VERSIONS`).
    pub retention_versions: u32,
    /// Background integrity budget in bytes per second (`OBSYNC_SCRUB_RATE`).
    pub scrub_rate_bytes_per_sec: u64,
    /// Concurrent connections (`OBSYNC_MAX_CONNECTIONS`).
    pub max_connections: usize,
    /// Verbosity (`OBSYNC_LOG`).
    pub log_level: LogLevel,
}

impl fmt::Debug for Config {
    /// Redacts the server key: a `Debug` render is one careless log line away.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Config")
            .field("listen", &self.listen)
            .field("blobs_dir", &self.blobs_dir)
            .field("journal_dir", &self.journal_dir)
            .field("blobs_mirrors", &self.blobs_mirrors)
            .field("blobs_capacity", &self.blobs_capacity)
            .field("journal_capacity", &self.journal_capacity)
            .field("blobs_class", &self.blobs_class)
            .field("journal_class", &self.journal_class)
            .field("dashboard_dir", &self.dashboard_dir)
            .field("plugin_dir", &self.plugin_dir)
            .field("edge", &self.edge)
            .field("trusted_proxy_cidrs", &self.trusted_proxy_cidrs)
            .field("public_url", &self.public_url)
            .field("server_key", &self.server_key.map(|_| "<redacted>"))
            .field("free_watermark", &self.free_watermark)
            .field("retention_days", &self.retention_days)
            .field("retention_versions", &self.retention_versions)
            .field("scrub_rate_bytes_per_sec", &self.scrub_rate_bytes_per_sec)
            .field("max_connections", &self.max_connections)
            .field("log_level", &self.log_level)
            .finish()
    }
}

/// An extra blob volume and the label the dashboard shows for it.
///
/// `OBSYNC_BLOBS_MIRRORS` entries are `path` or `path=label`; without a label
/// the volume is shown as `mirror`.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct MirrorVolume {
    /// Where the mirror is mounted.
    pub path: PathBuf,
    /// Display label for its class.
    pub label: String,
}

/// Which edge behaviour the server requires (`OBSYNC_EDGE`).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Edge {
    /// Trust only `OBSYNC_TRUSTED_PROXY_CIDRS` for forwarded addresses.
    #[default]
    None,
    /// Require the edge's connecting-address and request-id headers.
    Cloudflare,
}

impl Edge {
    /// Whether every request must carry the edge's headers.
    ///
    /// Ask this, never the variant name: naming a provider outside this file
    /// fails `doctrine_test` (AGENTS.md, "Deployment-provider contract").
    pub const fn requires_edge_headers(self) -> bool {
        matches!(self, Edge::Cloudflare)
    }

    /// The mode that requires the edge's headers, named generically so a
    /// caller outside this file can construct it without spelling the
    /// provider (`doctrine_test`).
    pub const fn requiring_headers() -> Edge {
        Edge::Cloudflare
    }

    /// The configured word, for the startup line and for the dashboard
    /// overview. Public for the same reason the parser lives here: the word
    /// belongs to this file and to no other.
    pub const fn as_word(self) -> &'static str {
        match self {
            Edge::None => "none",
            Edge::Cloudflare => "cloudflare",
        }
    }
}

/// A CIDR block, v4 or v6.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Cidr {
    addr: IpAddr,
    prefix: u8,
}

impl Cidr {
    /// Parse `addr/prefix`.
    pub fn parse(s: &str) -> Option<Cidr> {
        let (addr, prefix) = s.split_once('/')?;
        let addr: IpAddr = addr.trim().parse().ok()?;
        let prefix: u8 = prefix.trim().parse().ok()?;
        let max = if addr.is_ipv4() { 32 } else { 128 };
        if prefix > max {
            return None;
        }
        Some(Cidr { addr, prefix })
    }

    /// Whether `ip` falls inside the block. A family mismatch is never inside.
    pub fn contains(&self, ip: &IpAddr) -> bool {
        match (self.addr, ip) {
            (IpAddr::V4(net), IpAddr::V4(ip)) => {
                masked_eq(&net.octets(), &ip.octets(), self.prefix)
            }
            (IpAddr::V6(net), IpAddr::V6(ip)) => {
                masked_eq(&net.octets(), &ip.octets(), self.prefix)
            }
            _ => false,
        }
    }
}

fn masked_eq(net: &[u8], ip: &[u8], prefix: u8) -> bool {
    let whole = usize::from(prefix / 8);
    let bits = prefix % 8;
    if net[..whole] != ip[..whole] {
        return false;
    }
    if bits == 0 {
        return true;
    }
    let mask = 0xffu8 << (8 - bits);
    net[whole] & mask == ip[whole] & mask
}

impl fmt::Display for Cidr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.addr, self.prefix)
    }
}

/// The free-space refusal threshold: the larger of a percentage and a size.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Watermark {
    /// Percentage of the volume's declared capacity.
    pub percent: u8,
    /// Absolute size in bytes.
    pub bytes: u64,
}

impl Watermark {
    /// The threshold in bytes for a volume of `capacity` bytes.
    pub const fn bytes_for(&self, capacity: u64) -> u64 {
        let pct = capacity / 100 * self.percent as u64;
        if pct > self.bytes { pct } else { self.bytes }
    }
}

/// The subset of the configuration the storage engine owns.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct StorageConfig {
    /// Chunk volume.
    pub blobs_dir: PathBuf,
    /// Journal volume.
    pub journal_dir: PathBuf,
    /// Extra blob copies.
    pub mirrors: Vec<MirrorVolume>,
    /// Declared capacity of the blob volume, in bytes.
    pub blobs_capacity: u64,
    /// Declared capacity of the journal volume, in bytes.
    pub journal_capacity: u64,
    /// Display label for the blob volume's class.
    pub blobs_class: String,
    /// Display label for the journal volume's class.
    pub journal_class: String,
    /// Free-space refusal threshold.
    pub free_watermark: Watermark,
    /// Version and tombstone retention in days.
    pub retention_days: u32,
    /// Minimum versions kept per file.
    pub retention_versions: u32,
    /// Background integrity budget in bytes per second.
    pub scrub_rate_bytes_per_sec: u64,
}

/// Why a configuration was refused. Never carries a variable's value.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ConfigError {
    /// An `OBSYNC_*` variable this build does not know.
    Unknown(String),
    /// A required variable that the environment does not set.
    Missing(&'static str),
    /// A known variable whose value does not parse or does not validate.
    Invalid {
        /// The variable name.
        var: &'static str,
        /// What was expected, in words that never quote the value.
        reason: &'static str,
    },
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ConfigError::Unknown(var) => write!(f, "unknown variable {var}"),
            ConfigError::Missing(var) => write!(f, "{var} is required"),
            ConfigError::Invalid { var, reason } => write!(f, "{var} is invalid: {reason}"),
        }
    }
}

impl std::error::Error for ConfigError {}

const KIB: u64 = 1024;
const MIB: u64 = 1024 * KIB;
const GIB: u64 = 1024 * MIB;
const TIB: u64 = 1024 * GIB;

impl Default for Config {
    /// The defaults documented in docs/architecture.md §9.
    ///
    /// The capacities have no default: they are required, and
    /// [`Config::from_pairs`] refuses an environment that omits them. The
    /// values here exist only so a partially built `Config` is a valid value.
    fn default() -> Config {
        Config {
            listen: "0.0.0.0:8080".parse().expect("default listener parses"),
            blobs_dir: PathBuf::from("/data/blobs"),
            journal_dir: PathBuf::from("/data/journal"),
            blobs_mirrors: Vec::new(),
            blobs_capacity: 250 * GIB,
            journal_capacity: 4 * GIB,
            blobs_class: "host".to_string(),
            journal_class: "host".to_string(),
            dashboard_dir: PathBuf::from("/opt/obsync/dashboard"),
            plugin_dir: PathBuf::from("/opt/obsync/plugin"),
            edge: Edge::None,
            trusted_proxy_cidrs: Vec::new(),
            public_url: None,
            server_key: None,
            free_watermark: Watermark {
                percent: 5,
                bytes: 2 * GIB,
            },
            retention_days: 30,
            retention_versions: 10,
            scrub_rate_bytes_per_sec: 4 * MIB,
            max_connections: 256,
            log_level: LogLevel::Info,
        }
    }
}

impl Config {
    /// Parse the process environment.
    pub fn from_env() -> Result<Config, ConfigError> {
        let pairs: Vec<(String, String)> = std::env::vars()
            .filter(|(k, _)| k.starts_with("OBSYNC_"))
            .collect();
        Config::from_pairs(&pairs)
    }

    /// Parse an explicit set of variables. Every key must be a known variable.
    pub fn from_pairs(pairs: &[(String, String)]) -> Result<Config, ConfigError> {
        let mut cfg = Config::default();
        let mut blobs_capacity_set = false;
        let mut journal_capacity_set = false;
        for (key, raw) in pairs {
            let value = raw.trim();
            match key.as_str() {
                "OBSYNC_LISTEN" => {
                    cfg.listen = value
                        .parse()
                        .map_err(|_| invalid("OBSYNC_LISTEN", "expected address:port"))?;
                }
                "OBSYNC_BLOBS_DIR" => cfg.blobs_dir = dir("OBSYNC_BLOBS_DIR", value)?,
                "OBSYNC_JOURNAL_DIR" => cfg.journal_dir = dir("OBSYNC_JOURNAL_DIR", value)?,
                "OBSYNC_BLOBS_MIRRORS" => {
                    cfg.blobs_mirrors = list(value)
                        .iter()
                        .map(|entry| mirror(entry))
                        .collect::<Result<_, _>>()?;
                }
                "OBSYNC_BLOBS_CAPACITY" => {
                    cfg.blobs_capacity = size("OBSYNC_BLOBS_CAPACITY", value)?;
                    blobs_capacity_set = true;
                }
                "OBSYNC_JOURNAL_CAPACITY" => {
                    cfg.journal_capacity = size("OBSYNC_JOURNAL_CAPACITY", value)?;
                    journal_capacity_set = true;
                }
                "OBSYNC_BLOBS_CLASS" => {
                    cfg.blobs_class = class("OBSYNC_BLOBS_CLASS", value)?;
                }
                "OBSYNC_JOURNAL_CLASS" => {
                    cfg.journal_class = class("OBSYNC_JOURNAL_CLASS", value)?;
                }
                "OBSYNC_DASHBOARD_DIR" => cfg.dashboard_dir = dir("OBSYNC_DASHBOARD_DIR", value)?,
                "OBSYNC_PLUGIN_DIR" => cfg.plugin_dir = dir("OBSYNC_PLUGIN_DIR", value)?,
                "OBSYNC_EDGE" => {
                    cfg.edge = match value {
                        "none" => Edge::None,
                        "cloudflare" => Edge::Cloudflare,
                        _ => return Err(invalid("OBSYNC_EDGE", "expected none or a known edge")),
                    };
                }
                "OBSYNC_TRUSTED_PROXY_CIDRS" => {
                    cfg.trusted_proxy_cidrs = list(value)
                        .iter()
                        .map(|c| {
                            Cidr::parse(c).ok_or(invalid(
                                "OBSYNC_TRUSTED_PROXY_CIDRS",
                                "expected a comma-separated list of address/prefix blocks",
                            ))
                        })
                        .collect::<Result<_, _>>()?;
                }
                "OBSYNC_PUBLIC_URL" => {
                    cfg.public_url = if value.is_empty() {
                        None
                    } else if value.starts_with("https://") || value.starts_with("http://") {
                        Some(value.to_string())
                    } else {
                        return Err(invalid("OBSYNC_PUBLIC_URL", "expected an http(s) URL"));
                    };
                }
                "OBSYNC_SERVER_KEY" => {
                    cfg.server_key = if value.is_empty() {
                        None
                    } else {
                        Some(hex::decode_array::<32>(value).map_err(|_| {
                            invalid("OBSYNC_SERVER_KEY", "expected 64 hex characters")
                        })?)
                    };
                }
                "OBSYNC_FREE_WATERMARK" => {
                    cfg.free_watermark = watermark(value)?;
                }
                "OBSYNC_RETENTION_DAYS" => {
                    cfg.retention_days = number("OBSYNC_RETENTION_DAYS", value, 1, 36500)?;
                }
                "OBSYNC_RETENTION_VERSIONS" => {
                    cfg.retention_versions =
                        number("OBSYNC_RETENTION_VERSIONS", value, 1, 100_000)?;
                }
                "OBSYNC_SCRUB_RATE" => {
                    let rate = value.strip_suffix("/s").unwrap_or(value);
                    let rate = size("OBSYNC_SCRUB_RATE", rate)?;
                    if rate == 0 {
                        // A zero rate would switch integrity checking off.
                        return Err(invalid("OBSYNC_SCRUB_RATE", "expected a rate above zero"));
                    }
                    cfg.scrub_rate_bytes_per_sec = rate;
                }
                "OBSYNC_MAX_CONNECTIONS" => {
                    cfg.max_connections =
                        number("OBSYNC_MAX_CONNECTIONS", value, 1, 100_000)? as usize;
                }
                "OBSYNC_LOG" => {
                    cfg.log_level = LogLevel::parse(value)
                        .ok_or(invalid("OBSYNC_LOG", "expected error, warn, info or debug"))?;
                }
                other => return Err(ConfigError::Unknown(other.to_string())),
            }
        }
        // Capacity is the number the watermark is measured against, so a
        // missing one would mean refusing writes against a guess.
        if !blobs_capacity_set {
            return Err(ConfigError::Missing("OBSYNC_BLOBS_CAPACITY"));
        }
        if !journal_capacity_set {
            return Err(ConfigError::Missing("OBSYNC_JOURNAL_CAPACITY"));
        }
        cfg.validate()?;
        Ok(cfg)
    }

    fn validate(&self) -> Result<(), ConfigError> {
        if self.blobs_capacity == 0 {
            return Err(invalid(
                "OBSYNC_BLOBS_CAPACITY",
                "expected a size above zero",
            ));
        }
        if self.journal_capacity == 0 {
            return Err(invalid(
                "OBSYNC_JOURNAL_CAPACITY",
                "expected a size above zero",
            ));
        }
        if self.free_watermark.percent == 0 && self.free_watermark.bytes == 0 {
            // Both terms zero would switch the volume-full refusal off.
            return Err(invalid(
                "OBSYNC_FREE_WATERMARK",
                "expected at least one term above zero",
            ));
        }
        if self
            .blobs_mirrors
            .iter()
            .any(|mirror| mirror.path == self.blobs_dir)
        {
            return Err(invalid(
                "OBSYNC_BLOBS_MIRRORS",
                "expected volumes distinct from the blob volume",
            ));
        }
        Ok(())
    }

    /// The slice of the configuration handed to `Store::open`.
    pub fn storage(&self) -> StorageConfig {
        StorageConfig {
            blobs_dir: self.blobs_dir.clone(),
            journal_dir: self.journal_dir.clone(),
            mirrors: self.blobs_mirrors.clone(),
            blobs_capacity: self.blobs_capacity,
            journal_capacity: self.journal_capacity,
            blobs_class: self.blobs_class.clone(),
            journal_class: self.journal_class.clone(),
            free_watermark: self.free_watermark,
            retention_days: self.retention_days,
            retention_versions: self.retention_versions,
            scrub_rate_bytes_per_sec: self.scrub_rate_bytes_per_sec,
        }
    }

    /// One startup line naming every operational number, and no path or key.
    ///
    /// Capacities are declared, not measured: the standard library exposes no
    /// `statvfs`, so the watermark is evaluated against
    /// `OBSYNC_BLOBS_CAPACITY` minus tracked usage. An operator who resizes a
    /// volume must update the variable, and this line is where they check it.
    pub fn log_startup(&self, log: &Log) {
        log.info(
            "config",
            &[
                ("port", Val::count(u64::from(self.listen.port()))),
                ("edge", Val::word(self.edge.as_word())),
                ("mirrors", Val::count(self.blobs_mirrors.len() as u64)),
                ("blobs_capacity", Val::bytes(self.blobs_capacity)),
                ("journal_capacity", Val::bytes(self.journal_capacity)),
                (
                    "watermark_bytes",
                    Val::bytes(self.free_watermark.bytes_for(self.blobs_capacity)),
                ),
                (
                    "watermark_percent",
                    Val::count(u64::from(self.free_watermark.percent)),
                ),
                ("retention_days", Val::count(u64::from(self.retention_days))),
                (
                    "retention_versions",
                    Val::count(u64::from(self.retention_versions)),
                ),
                ("scrub_rate", Val::bytes(self.scrub_rate_bytes_per_sec)),
                ("max_connections", Val::count(self.max_connections as u64)),
                (
                    "server_key",
                    Val::word(if self.server_key.is_some() {
                        "configured"
                    } else {
                        "generated"
                    }),
                ),
                ("log_level", Val::word(self.log_level.as_str())),
            ],
        );
    }
}

fn invalid(var: &'static str, reason: &'static str) -> ConfigError {
    ConfigError::Invalid { var, reason }
}

fn dir(var: &'static str, value: &str) -> Result<PathBuf, ConfigError> {
    if value.is_empty() {
        return Err(invalid(var, "expected an absolute directory path"));
    }
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(invalid(var, "expected an absolute directory path"));
    }
    Ok(path)
}

/// A `path` or `path=label` mirror entry.
fn mirror(entry: &str) -> Result<MirrorVolume, ConfigError> {
    let (path, label) = match entry.split_once('=') {
        Some((path, label)) => (path.trim(), label.trim()),
        None => (entry, "mirror"),
    };
    Ok(MirrorVolume {
        path: dir("OBSYNC_BLOBS_MIRRORS", path)?,
        label: class("OBSYNC_BLOBS_MIRRORS", label)?,
    })
}

/// A volume class label: display only, so the only rules are that it exists
/// and stays short enough to render.
fn class(var: &'static str, value: &str) -> Result<String, ConfigError> {
    if value.is_empty() || value.chars().count() > 64 {
        return Err(invalid(var, "expected a label of 1 to 64 characters"));
    }
    Ok(value.to_string())
}

fn list(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect()
}

fn number(var: &'static str, value: &str, min: u32, max: u32) -> Result<u32, ConfigError> {
    let n: u32 = value
        .parse()
        .map_err(|_| invalid(var, "expected a whole number"))?;
    if n < min || n > max {
        return Err(invalid(var, "expected a number inside the supported range"));
    }
    Ok(n)
}

fn size(var: &'static str, value: &str) -> Result<u64, ConfigError> {
    parse_size(value).ok_or(invalid(
        var,
        "expected a size such as 512, 4MiB, 2GiB or 250GiB",
    ))
}

/// `250GiB`, `4MiB`, `512`. Binary units only: `KB` would be ambiguous.
fn parse_size(value: &str) -> Option<u64> {
    let value = value.trim();
    let end = value
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(value.len());
    if end == 0 {
        return None;
    }
    let n: u64 = value[..end].parse().ok()?;
    let unit = value[end..].trim().to_ascii_lowercase();
    let multiplier = match unit.as_str() {
        "" | "b" => 1,
        "k" | "kib" => KIB,
        "m" | "mib" => MIB,
        "g" | "gib" => GIB,
        "t" | "tib" => TIB,
        _ => return None,
    };
    n.checked_mul(multiplier)
}

/// `5%,2GiB`, `5%`, or `2GiB`: the refusal threshold is the larger term.
fn watermark(value: &str) -> Result<Watermark, ConfigError> {
    let bad = invalid(
        "OBSYNC_FREE_WATERMARK",
        "expected a percentage, a size, or both separated by a comma",
    );
    let mut mark = Watermark {
        percent: 0,
        bytes: 0,
    };
    let mut seen_percent = false;
    let mut seen_size = false;
    let terms = list(value);
    if terms.is_empty() || terms.len() > 2 {
        return Err(bad);
    }
    for term in terms {
        if let Some(pct) = term.strip_suffix('%') {
            if seen_percent {
                return Err(bad);
            }
            seen_percent = true;
            mark.percent = pct.trim().parse().map_err(|_| bad.clone())?;
            if mark.percent > 100 {
                return Err(bad);
            }
        } else {
            if seen_size {
                return Err(bad);
            }
            seen_size = true;
            mark.bytes = parse_size(&term).ok_or(bad.clone())?;
        }
    }
    Ok(mark)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log::Log;

    fn pairs(kv: &[(&str, &str)]) -> Vec<(String, String)> {
        kv.iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    /// The two required variables, so a case can say only what it is about.
    fn required() -> Vec<(&'static str, &'static str)> {
        vec![
            ("OBSYNC_BLOBS_CAPACITY", "250GiB"),
            ("OBSYNC_JOURNAL_CAPACITY", "4GiB"),
        ]
    }

    fn parse(kv: &[(&str, &str)]) -> Result<Config, ConfigError> {
        let mut all: Vec<(&str, &str)> = required();
        for (key, value) in kv {
            all.retain(|(name, _)| name != key);
            all.push((key, value));
        }
        Config::from_pairs(&pairs(&all))
    }

    #[test]
    fn defaults_match_the_documented_table() {
        let cfg = parse(&[]).expect("the required variables alone are valid");
        assert_eq!(cfg.listen.to_string(), "0.0.0.0:8080");
        assert_eq!(cfg.blobs_dir, PathBuf::from("/data/blobs"));
        assert_eq!(cfg.journal_dir, PathBuf::from("/data/journal"));
        assert!(cfg.blobs_mirrors.is_empty());
        assert_eq!(cfg.dashboard_dir, PathBuf::from("/opt/obsync/dashboard"));
        assert_eq!(cfg.plugin_dir, PathBuf::from("/opt/obsync/plugin"));
        assert_eq!(cfg.edge, Edge::None);
        assert!(cfg.trusted_proxy_cidrs.is_empty());
        assert_eq!(cfg.public_url, None);
        assert_eq!(cfg.server_key, None);
        assert_eq!(
            cfg.free_watermark,
            Watermark {
                percent: 5,
                bytes: 2 * GIB
            }
        );
        assert_eq!(cfg.retention_days, 30);
        assert_eq!(cfg.retention_versions, 10);
        assert_eq!(cfg.scrub_rate_bytes_per_sec, 4 * MIB);
        assert_eq!(cfg.max_connections, 256);
        assert_eq!(cfg.log_level, LogLevel::Info);
        assert_eq!(cfg.blobs_capacity, 250 * GIB);
        assert_eq!(cfg.journal_capacity, 4 * GIB);
    }

    #[test]
    fn every_variable_parses() {
        let cfg = parse(&[
            ("OBSYNC_LISTEN", "127.0.0.1:9090"),
            ("OBSYNC_BLOBS_DIR", "/mnt/blobs"),
            ("OBSYNC_JOURNAL_DIR", "/mnt/journal"),
            ("OBSYNC_BLOBS_MIRRORS", "/mnt/m1, /mnt/m2=slow-hdd"),
            ("OBSYNC_BLOBS_CAPACITY", "500GiB"),
            ("OBSYNC_JOURNAL_CAPACITY", "8GiB"),
            ("OBSYNC_BLOBS_CLASS", "local-pie-ssd"),
            ("OBSYNC_JOURNAL_CLASS", "local-pie-ssd"),
            ("OBSYNC_DASHBOARD_DIR", "/srv/dash"),
            ("OBSYNC_PLUGIN_DIR", "/srv/plugin"),
            ("OBSYNC_EDGE", "cloudflare"),
            ("OBSYNC_TRUSTED_PROXY_CIDRS", "10.0.0.0/8,2001:db8::/32"),
            ("OBSYNC_PUBLIC_URL", "https://example.invalid"),
            (
                "OBSYNC_SERVER_KEY",
                "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
            ),
            ("OBSYNC_FREE_WATERMARK", "10%,4GiB"),
            ("OBSYNC_RETENTION_DAYS", "90"),
            ("OBSYNC_RETENTION_VERSIONS", "25"),
            ("OBSYNC_SCRUB_RATE", "8MiB/s"),
            ("OBSYNC_MAX_CONNECTIONS", "512"),
            ("OBSYNC_LOG", "debug"),
        ])
        .expect("full environment parses");
        assert_eq!(cfg.listen.to_string(), "127.0.0.1:9090");
        assert_eq!(cfg.blobs_dir, PathBuf::from("/mnt/blobs"));
        assert_eq!(cfg.journal_dir, PathBuf::from("/mnt/journal"));
        assert_eq!(
            cfg.blobs_mirrors,
            vec![
                MirrorVolume {
                    path: PathBuf::from("/mnt/m1"),
                    label: "mirror".to_string()
                },
                MirrorVolume {
                    path: PathBuf::from("/mnt/m2"),
                    label: "slow-hdd".to_string()
                }
            ]
        );
        assert_eq!(cfg.blobs_capacity, 500 * GIB);
        assert_eq!(cfg.journal_capacity, 8 * GIB);
        assert_eq!(cfg.blobs_class, "local-pie-ssd");
        assert_eq!(cfg.journal_class, "local-pie-ssd");
        assert_eq!(cfg.dashboard_dir, PathBuf::from("/srv/dash"));
        assert_eq!(cfg.plugin_dir, PathBuf::from("/srv/plugin"));
        assert!(cfg.edge.requires_edge_headers());
        assert_eq!(cfg.trusted_proxy_cidrs.len(), 2);
        assert_eq!(cfg.public_url.as_deref(), Some("https://example.invalid"));
        assert_eq!(cfg.server_key.expect("server key parses")[0], 0x00);
        assert_eq!(cfg.server_key.expect("server key parses")[31], 0xff);
        assert_eq!(
            cfg.free_watermark,
            Watermark {
                percent: 10,
                bytes: 4 * GIB
            }
        );
        assert_eq!(cfg.retention_days, 90);
        assert_eq!(cfg.retention_versions, 25);
        assert_eq!(cfg.scrub_rate_bytes_per_sec, 8 * MIB);
        assert_eq!(cfg.max_connections, 512);
        assert_eq!(cfg.log_level, LogLevel::Debug);
        assert_eq!(cfg.storage().blobs_dir, cfg.blobs_dir);
        assert_eq!(cfg.storage().mirrors.len(), 2);
        assert_eq!(cfg.storage().retention_days, 90);
    }

    #[test]
    fn the_capacities_are_required() {
        assert_eq!(
            Config::from_pairs(&pairs(&[("OBSYNC_JOURNAL_CAPACITY", "4GiB")])),
            Err(ConfigError::Missing("OBSYNC_BLOBS_CAPACITY")),
            "a watermark measured against a guessed capacity is not a watermark"
        );
        assert_eq!(
            Config::from_pairs(&pairs(&[("OBSYNC_BLOBS_CAPACITY", "1GiB")])),
            Err(ConfigError::Missing("OBSYNC_JOURNAL_CAPACITY"))
        );
        assert_eq!(
            Config::from_pairs(&[]),
            Err(ConfigError::Missing("OBSYNC_BLOBS_CAPACITY"))
        );
        assert_eq!(
            ConfigError::Missing("OBSYNC_BLOBS_CAPACITY").to_string(),
            "OBSYNC_BLOBS_CAPACITY is required"
        );
    }

    #[test]
    fn class_labels_default_to_the_host_and_stay_short() {
        let cfg = parse(&[]).expect("defaults");
        assert_eq!(cfg.blobs_class, "host");
        assert_eq!(cfg.journal_class, "host");
        assert_eq!(cfg.storage().journal_class, "host");
        for value in ["", &"x".repeat(65)] {
            assert!(
                matches!(
                    parse(&[("OBSYNC_BLOBS_CLASS", value)]),
                    Err(ConfigError::Invalid {
                        var: "OBSYNC_BLOBS_CLASS",
                        ..
                    })
                ),
                "a label of {} characters is refused",
                value.len()
            );
        }
        assert!(
            matches!(
                parse(&[("OBSYNC_BLOBS_MIRRORS", "/mnt/m1=")]),
                Err(ConfigError::Invalid {
                    var: "OBSYNC_BLOBS_MIRRORS",
                    ..
                })
            ),
            "an empty mirror label is refused, not silently defaulted"
        );
    }

    #[test]
    fn unknown_variable_is_a_startup_error() {
        assert_eq!(
            parse(&[("OBSYNC_LISTNE", "0.0.0.0:8080")]),
            Err(ConfigError::Unknown("OBSYNC_LISTNE".to_string()))
        );
        assert_eq!(
            parse(&[("OBSYNC_FSYNC", "off")]),
            Err(ConfigError::Unknown("OBSYNC_FSYNC".to_string()))
        );
    }

    #[test]
    fn bad_values_are_refused_by_variable() {
        let cases: &[(&str, &str)] = &[
            ("OBSYNC_LISTEN", "not-an-address"),
            ("OBSYNC_LISTEN", "8080"),
            ("OBSYNC_BLOBS_DIR", "relative/path"),
            ("OBSYNC_BLOBS_DIR", ""),
            ("OBSYNC_JOURNAL_DIR", "also/relative"),
            ("OBSYNC_BLOBS_MIRRORS", "relative"),
            ("OBSYNC_BLOBS_CAPACITY", "250GB"),
            ("OBSYNC_BLOBS_CAPACITY", "0"),
            ("OBSYNC_JOURNAL_CAPACITY", "lots"),
            ("OBSYNC_DASHBOARD_DIR", "x"),
            ("OBSYNC_PLUGIN_DIR", "x"),
            ("OBSYNC_EDGE", "fastly"),
            ("OBSYNC_TRUSTED_PROXY_CIDRS", "10.0.0.0"),
            ("OBSYNC_TRUSTED_PROXY_CIDRS", "10.0.0.0/33"),
            ("OBSYNC_TRUSTED_PROXY_CIDRS", "2001:db8::/129"),
            ("OBSYNC_PUBLIC_URL", "example.invalid"),
            ("OBSYNC_SERVER_KEY", "00"),
            (
                "OBSYNC_SERVER_KEY",
                "zz112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
            ),
            ("OBSYNC_FREE_WATERMARK", "0%,0"),
            ("OBSYNC_FREE_WATERMARK", "101%"),
            ("OBSYNC_FREE_WATERMARK", "5%,5%"),
            ("OBSYNC_FREE_WATERMARK", "5%,2GiB,1GiB"),
            ("OBSYNC_FREE_WATERMARK", ""),
            ("OBSYNC_RETENTION_DAYS", "0"),
            ("OBSYNC_RETENTION_DAYS", "-1"),
            ("OBSYNC_RETENTION_VERSIONS", "0"),
            ("OBSYNC_SCRUB_RATE", "0"),
            ("OBSYNC_SCRUB_RATE", "fast"),
            ("OBSYNC_MAX_CONNECTIONS", "0"),
            ("OBSYNC_LOG", "trace"),
        ];
        for (var, value) in cases {
            let result = parse(&[(var, value)]);
            assert!(
                matches!(result, Err(ConfigError::Invalid { .. })),
                "{var} must refuse its bad value, got {result:?}"
            );
        }
    }

    #[test]
    fn a_mirror_may_not_be_the_blob_volume() {
        let err = parse(&[
            ("OBSYNC_BLOBS_DIR", "/mnt/blobs"),
            ("OBSYNC_BLOBS_MIRRORS", "/mnt/blobs"),
        ])
        .expect_err("a mirror on the blob volume is not a second copy");
        assert!(matches!(
            err,
            ConfigError::Invalid {
                var: "OBSYNC_BLOBS_MIRRORS",
                ..
            }
        ));
    }

    #[test]
    fn sizes_and_rates_use_binary_units() {
        assert_eq!(parse_size("512"), Some(512));
        assert_eq!(parse_size("1B"), Some(1));
        assert_eq!(parse_size("4KiB"), Some(4 * KIB));
        assert_eq!(parse_size("4mib"), Some(4 * MIB));
        assert_eq!(parse_size("250GiB"), Some(250 * GIB));
        assert_eq!(parse_size("2TiB"), Some(2 * TIB));
        assert_eq!(parse_size("2 GiB"), Some(2 * GIB));
        assert_eq!(parse_size("2GB"), None);
        assert_eq!(parse_size("GiB"), None);
        assert_eq!(parse_size(""), None);
        assert_eq!(parse_size("99999999999999999999GiB"), None);
    }

    #[test]
    fn watermark_takes_the_larger_term() {
        let mark = watermark("5%,2GiB").expect("both terms");
        assert_eq!(mark.bytes_for(250 * GIB), 12 * GIB + 512 * MIB);
        assert_eq!(mark.bytes_for(4 * GIB), 2 * GIB);
        assert_eq!(watermark("5%").expect("percent only").bytes, 0);
        assert_eq!(watermark("2GiB").expect("size only").percent, 0);
        assert_eq!(watermark("2GiB,5%").expect("either order").percent, 5);
    }

    #[test]
    fn cidrs_match_by_prefix_and_never_across_families() {
        let v4 = Cidr::parse("10.1.0.0/16").expect("v4 block");
        assert!(v4.contains(&"10.1.255.7".parse().expect("ip")));
        assert!(!v4.contains(&"10.2.0.1".parse().expect("ip")));
        assert!(!v4.contains(&"2001:db8::1".parse().expect("ip")));
        let v6 = Cidr::parse("2001:db8::/32").expect("v6 block");
        assert!(v6.contains(&"2001:db8:1234::9".parse().expect("ip")));
        assert!(!v6.contains(&"2001:db9::1".parse().expect("ip")));
        assert!(!v6.contains(&"10.1.0.1".parse().expect("ip")));
        let odd = Cidr::parse("10.0.0.0/12").expect("non-octet prefix");
        assert!(odd.contains(&"10.15.255.255".parse().expect("ip")));
        assert!(!odd.contains(&"10.16.0.1".parse().expect("ip")));
        let all = Cidr::parse("0.0.0.0/0").expect("everything");
        assert!(all.contains(&"203.0.113.9".parse().expect("ip")));
        assert_eq!(v4.to_string(), "10.1.0.0/16");
    }

    #[test]
    fn debug_and_startup_log_never_carry_the_server_key() {
        let cfg = parse(&[(
            "OBSYNC_SERVER_KEY",
            "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
        )])
        .expect("valid key");
        let rendered = format!("{cfg:?}");
        assert!(!rendered.contains("00112233"), "{rendered}");
        assert!(rendered.contains("<redacted>"), "{rendered}");

        let log = Log::buffered(LogLevel::Info);
        cfg.log_startup(&log);
        let line = log.captured();
        assert!(!line.contains("00112233"), "{line}");
        assert!(line.contains("server_key=configured"), "{line}");
        assert!(line.contains("blobs_capacity=268435456000"), "{line}");
        assert!(!line.contains("/data/blobs"), "{line}");
    }

    #[test]
    fn error_messages_never_quote_a_value() {
        let err = parse(&[("OBSYNC_SERVER_KEY", "abcdef")]).expect_err("short key");
        let text = err.to_string();
        assert!(!text.contains("abcdef"), "{text}");
        assert_eq!(
            text,
            "OBSYNC_SERVER_KEY is invalid: expected 64 hex characters"
        );
        assert_eq!(
            ConfigError::Unknown("OBSYNC_X".to_string()).to_string(),
            "unknown variable OBSYNC_X"
        );
    }
}
