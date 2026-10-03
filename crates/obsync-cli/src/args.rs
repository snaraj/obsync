#![forbid(unsafe_code)]

use crate::{Error, Result};
use std::collections::BTreeMap;

#[derive(Default)]
pub struct Args {
    pub words: Vec<String>,
    pub flags: BTreeMap<String, String>,
}

impl Args {
    pub fn parse(input: impl IntoIterator<Item = String>) -> Result<Self> {
        let mut result = Self::default();
        let mut input = input.into_iter();
        let mut positional = false;
        let mut bytes = 0;
        while let Some(word) = input.next() {
            bytes += word.len();
            if bytes > 16384 {
                return Err(Error::input("Arguments exceed 16384 bytes in total."));
            }
            if word.len() > 8192 {
                return Err(Error::input("An argument exceeds 8192 bytes."));
            }
            if word == "--" && !positional {
                positional = true;
                continue;
            }
            if positional || !word.starts_with('-') {
                result.words.push(word);
                continue;
            }
            let (flag, inline) = word
                .split_once('=')
                .map_or((word.as_str(), None), |(k, v)| (k, Some(v)));
            let key = match flag {
                "-h" | "--help" => "help",
                "--version" => "version",
                "--non-interactive" => "non-interactive",
                "-o" | "--output" => "output",
                "-f" | "--filename" => "filename",
                "--config-dir" => "config-dir",
                "--context" => "context",
                "--server" => "server",
                "--expected-instance" => "expected-instance",
                "--expect-digest" => "expect-digest",
                "--limit" => "limit",
                "--cursor" => "cursor",
                "--windows-trust" => "windows-trust",
                "--windows-trust-sha256" => "windows-trust-sha256",
                "--from" => "from",
                "--prefix" => "prefix",
                "--manifest-sha256" => "manifest-sha256",
                _ => return Err(Error::input("Unknown flag. Run 'obsync help' for usage.")),
            };
            let boolean = matches!(key, "help" | "version" | "non-interactive");
            let value = if boolean {
                if inline.is_some() {
                    return Err(Error::input("This flag takes no value."));
                }
                String::new()
            } else {
                let value = inline
                    .map(str::to_owned)
                    .or_else(|| input.next())
                    .ok_or_else(|| Error::input("A flag is missing its value."))?;
                if inline.is_none() {
                    bytes += value.len();
                }
                if bytes > 16384 {
                    return Err(Error::input("Arguments exceed 16384 bytes in total."));
                }
                if value.is_empty() || value.len() > 8192 || value.starts_with('-') {
                    return Err(Error::input("A flag needs a nonempty, bounded value."));
                }
                value
            };
            if result.flags.insert(key.into(), value).is_some() {
                return Err(Error::input(
                    "A flag may appear only once, including aliases.",
                ));
            }
        }
        if result.words.len() > 8 {
            return Err(Error::input("Too many arguments."));
        }
        Ok(result)
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.flags.get(key).map(String::as_str)
    }
    pub fn has(&self, key: &str) -> bool {
        self.flags.contains_key(key)
    }
    pub fn check(&self, min: usize, max: usize, allowed: &[&str]) -> Result<()> {
        if !(min..=max).contains(&self.words.len()) {
            return Err(Error::input(
                "Missing or unexpected argument. Use this command's --help.",
            ));
        }
        if self.flags.keys().any(|key| {
            ![
                "output",
                "config-dir",
                "non-interactive",
                "windows-trust",
                "windows-trust-sha256",
            ]
            .contains(&key.as_str())
                && !allowed.contains(&key.as_str())
        }) {
            return Err(Error::input(
                "A flag does not apply to this command. Use its --help.",
            ));
        }
        Ok(())
    }

    pub fn operation(&self) -> Result<&'static str> {
        let words: Vec<_> = self.words.iter().map(String::as_str).collect();
        let op = match words.as_slice() {
            [] => "cli.help",
            ["help", ..] => "cli.help",
            ["version", ..] => "cli.version",
            ["install", ..] => "cli.install",
            ["uninstall", ..] => "cli.uninstall",
            ["windows-setup", ..] => "cli.windows_setup",
            ["cli", "search", ..] => "cli.search",
            ["schema" | "explain", ..] => "schema",
            ["capabilities", ..] => "capabilities",
            ["config", "get-contexts", ..] => "context.list",
            ["config", "current-context", ..] => "context.current",
            ["config", "view", ..] | ["describe", "context" | "contexts", ..] => "context.get",
            ["get", "context" | "contexts"] => "context.list",
            ["get", "context" | "contexts", _] => "context.get",
            ["config", "set-context", ..] => "context.add",
            ["config", "use-context", ..] => "context.use",
            ["config", "delete-context", ..] => "context.remove",
            ["apply", ..] => "context.apply",
            ["config", "recover", ..] => "context.recover",
            ["doctor", ..] => "doctor",
            ["agent", "instructions", ..] => "agent.instructions",
            ["config"] => "config.help",
            ["get", ..]
            | ["describe", ..]
            | [
                "auth" | "server" | "setup" | "obsidian" | "devices" | "storage" | "backup"
                | "sync" | "logs" | "audit" | "mcp" | "export" | "plans" | "operations",
                ..,
            ] => {
                return Err(Error::unsupported(
                    "This capability is not shipped. Run 'obsync capabilities'.",
                ));
            }
            _ => {
                return Err(Error::input(
                    "Unknown command. Run 'obsync help' or 'obsync cli search QUERY'.",
                ));
            }
        };
        Ok(if self.has("version") && self.words.is_empty() {
            "cli.version"
        } else {
            op
        })
    }
}
