#![deny(unsafe_code)]

#[cfg(unix)]
#[allow(unsafe_code)]
mod posix_identity;
#[cfg(windows)]
#[allow(unsafe_code)]
mod windows_identity;

mod args;
mod catalog;
mod context;
mod custody;
mod output;
mod package;
#[cfg(any(target_os = "macos", windows))]
mod process;
mod store;
#[cfg(windows)]
mod windows;

use obsync_core::json::{Value, obj};
use std::{
    io::{self, Write},
    time::Instant,
};

type Result<T> = std::result::Result<T, Error>;
#[derive(Debug)]
struct Error {
    code: &'static str,
    message: &'static str,
    exit: u8,
}
impl Error {
    fn new(code: &'static str, message: &'static str, exit: u8) -> Self {
        Self {
            code,
            message,
            exit,
        }
    }
    fn input(message: &'static str) -> Self {
        Self {
            code: "invalid_input",
            message,
            exit: 2,
        }
    }
    fn unsupported(message: &'static str) -> Self {
        Self {
            code: "unsupported_capability",
            message,
            exit: 6,
        }
    }
}
fn s(value: impl Into<String>) -> Value {
    Value::Str(value.into())
}

fn run(args: &args::Args, operation: &str, catalog: &[Value], started: Instant) -> Result<Value> {
    match operation {
        "cli.windows_setup" => {
            args.check(1, 1, &[])?;
            #[cfg(windows)]
            {
                windows::setup()
            }
            #[cfg(not(windows))]
            {
                Err(Error::unsupported(
                    "OS PowerShell setup is available on Windows only.",
                ))
            }
        }
        "cli.install" | "cli.uninstall" => package::run(
            args,
            operation == "cli.uninstall",
            started + std::time::Duration::from_secs(5),
        ),
        "cli.help" | "config.help" => {
            args.check(0, 4, &["help"])?;
            Ok(obj(vec![("commands", Value::Array(catalog.to_vec()))]))
        }
        "cli.version" => {
            args.check(
                usize::from(!args.has("version")),
                usize::from(!args.has("version")),
                &["version"],
            )?;
            Ok(obj(vec![
                ("version", s(env!("CARGO_PKG_VERSION"))),
                ("schema_version", Value::Int(1)),
                ("runtime", s("native Rust")),
                ("platform", s(package::platform())),
            ]))
        }
        "capabilities" => {
            args.check(1, 1, &[])?;
            Ok(obj(vec![
                ("source", s("local_catalog")),
                ("server_intersection", s("not_run")),
                ("operations", Value::Array(catalog.to_vec())),
                (
                    "unsupported",
                    Value::Array(
                        [
                            "auth", "server", "setup", "obsidian", "devices", "storage", "backup",
                            "sync", "logs", "audit", "mcp", "export",
                        ]
                        .map(s)
                        .to_vec(),
                    ),
                ),
            ]))
        }
        "cli.search" => {
            args.check(3, 3, &[])?;
            if args.words[2].len() > 256 {
                return Err(Error::input("Search is limited to 256 bytes."));
            }
            let terms: Vec<_> = args.words[2]
                .split_whitespace()
                .map(str::to_ascii_lowercase)
                .collect();
            let items = catalog
                .iter()
                .filter(|entry| {
                    let text = format!(
                        "{} {} {}",
                        catalog::field(entry, "operation"),
                        catalog::field(entry, "command"),
                        catalog::field(entry, "summary")
                    )
                    .to_ascii_lowercase();
                    terms.iter().all(|term| text.contains(term))
                })
                .cloned()
                .collect();
            Ok(obj(vec![("items", Value::Array(items))]))
        }
        "schema" => {
            args.check(2, 4, &[])?;
            let query = args.words[1..].join(" ");
            catalog::find(catalog, &query)
                .map(catalog::schema)
                .ok_or_else(|| Error::input("No schema exists for that operation or command."))
        }
        "agent.instructions" => {
            args.check(2, 2, &[])?;
            Ok(obj(vec![("instructions", Value::Array([
                "Discover commands with help, cli search, explain and capabilities.",
                "Use -o json for one bounded, versioned machine-readable envelope.",
                "Context writes require an exact five-minute plan and explicit --config-dir; read state back in a new process after apply.",
                "Never put credentials, vault keys or recovery words in command arguments or contexts.",
                "A configured HTTPS origin is not a verified server identity.",
            ].map(s).to_vec()))]))
        }
        _ => run_context(args, operation, started),
    }
}

fn run_context(args: &args::Args, op: &str, started: Instant) -> Result<Value> {
    use context::{Context, Plan};
    let mut store = store::Store::new(args, started + std::time::Duration::from_secs(5))?;
    match op {
        "context.list" => {
            args.check(2, 2, &[])?;
            let (state, _) = store.read()?;
            Ok(obj(vec![
                (
                    "items",
                    Value::Array(state.contexts.iter().map(Context::json).collect()),
                ),
                ("current", state.current.as_ref().map_or(Value::Null, s)),
                ("revision", Value::Int(state.revision as i64)),
            ]))
        }
        "context.current" => {
            args.check(2, 2, &[])?;
            let (state, _) = store.read()?;
            let context = state.selected(None)?;
            Ok(obj(vec![
                ("context", context.json()),
                ("current", Value::Bool(true)),
                ("revision", Value::Int(state.revision as i64)),
            ]))
        }
        "context.get" => {
            args.check(2, 3, &["context"])?;
            if args.words.len() == 3 && args.has("context") {
                return Err(Error::input(
                    "Select a context by name or --context, not both.",
                ));
            }
            let (state, _) = store.read()?;
            let context = state.selected(
                args.words
                    .get(2)
                    .map(String::as_str)
                    .or(args.get("context")),
            )?;
            Ok(obj(vec![
                ("context", context.json()),
                (
                    "current",
                    Value::Bool(state.current.as_deref() == Some(&context.name)),
                ),
                ("revision", Value::Int(state.revision as i64)),
            ]))
        }
        "context.add" | "context.use" | "context.remove" => {
            args.check(
                3,
                3,
                if op == "context.add" {
                    &["server", "expected-instance"]
                } else {
                    &[]
                },
            )?;
            let parameters = if op == "context.add" {
                Context::new(
                    &args.words[2],
                    args.get("server")
                        .ok_or_else(|| Error::input("Supply --server with an HTTPS origin."))?,
                    args.get("expected-instance"),
                )?
                .json()
            } else {
                obj(vec![("name", s(context::name(&args.words[2])?))])
            };
            let (state, _) = store.read()?;
            let plan = Plan::create(&state, op, parameters, &store.target)?;
            Ok(obj(vec![("plan", plan.value)]))
        }
        "context.apply" => {
            args.check(1, 1, &["filename", "expect-digest"])?;
            let path = custody::exact(
                args.get("filename")
                    .ok_or_else(|| Error::input("Supply -f with an absolute plan file path."))?,
                false,
            )?;
            let expected = args.get("expect-digest").ok_or_else(|| {
                Error::input("Supply --expect-digest with the reviewed plan digest.")
            })?;
            let mut file = custody::open(&path, false, false)?;
            let raw = custody::bounded(&mut file, 16384)?;
            let value = obsync_core::json::parse(&raw)
                .map_err(|_| Error::input("The plan must be one bounded JSON document."))?;
            let plan = Plan::parse(value, expected, &store.target)?;
            store.apply(&plan)
        }
        "context.recover" => {
            args.check(2, 2, &[])?;
            let state = store.recover()?;
            Ok(obj(vec![
                ("revision", Value::Int(state.revision as i64)),
                ("contexts", Value::Int(state.contexts.len() as i64)),
                ("current", state.current.as_ref().map_or(Value::Null, s)),
            ]))
        }
        "doctor" => {
            args.check(1, 1, &["context"])?;
            let (state, present) = store.read()?;
            if args.has("context") {
                state.selected(args.get("context"))?;
            }
            Ok(obj(vec![
                ("runtime", s("native Rust")),
                (
                    "configuration",
                    obj(vec![
                        ("present", Value::Bool(present)),
                        ("revision", Value::Int(state.revision as i64)),
                        ("contexts", Value::Int(state.contexts.len() as i64)),
                        ("current", state.current.as_ref().map_or(Value::Null, s)),
                    ]),
                ),
                ("network", s("not_run")),
                ("native_application", s("not_run")),
                ("repairs", s("none")),
            ]))
        }
        _ => Err(Error::unsupported("This capability is not shipped.")),
    }
}

fn main() {
    let started = Instant::now();
    let raw: Vec<_> = std::env::args_os().skip(1).collect();
    // Preserve an explicit machine stream even when argument parsing refuses.
    let machine = raw
        .iter()
        .take_while(|arg| arg.to_str() != Some("--"))
        .enumerate()
        .any(|(i, arg)| {
            matches!(
                arg.to_str(),
                Some("--output=json" | "--output=jsonl" | "-o=json" | "-o=jsonl")
            ) || (matches!(arg.to_str(), Some("-o" | "--output"))
                && raw
                    .get(i + 1)
                    .is_some_and(|v| matches!(v.to_str(), Some("json" | "jsonl"))))
        });
    let parsed = raw
        .into_iter()
        .map(|arg| {
            arg.into_string()
                .map_err(|_| Error::input("Arguments must be valid UTF-8."))
        })
        .collect::<Result<Vec<_>>>()
        .and_then(args::Args::parse);
    let format = parsed
        .as_ref()
        .ok()
        .and_then(|args| args.get("output"))
        .unwrap_or(if parsed.is_err() && machine {
            "json"
        } else {
            "human"
        });
    let catalog = catalog::load();
    let operation = parsed.as_ref().ok().and_then(|args| args.operation().ok());
    let mut result = (|| {
        let args = parsed.as_ref().map_err(|error| Error {
            code: error.code,
            message: error.message,
            exit: error.exit,
        })?;
        if !["human", "json", "jsonl"].contains(&format) {
            return Err(Error::input("Output must be human, json or jsonl."));
        }
        let op = args.operation()?;
        if args.has("help") || op == "cli.help" || op == "config.help" {
            return catalog::help_data(args, &catalog, op);
        }
        run(args, op, &catalog, started)
    })();
    if result
        .as_ref()
        .is_ok_and(|data| data.to_json().len() > 60000)
    {
        result = Err(Error::input("The result exceeds its output budget."));
    }
    if started.elapsed().as_millis() > 5000 {
        result = Err(Error {
            code: "deadline_exceeded",
            message: "The local command exceeded its five-second deadline.",
            exit: 7,
        });
    }
    let exit = result.as_ref().err().map_or(0, |error| error.exit);
    let rendered = output::render(result, operation, format, started.elapsed().as_millis());
    let stream: &mut dyn Write = if exit != 0 && format == "human" {
        &mut io::stderr()
    } else {
        &mut io::stdout()
    };
    if stream.write_all(rendered.as_bytes()).is_err() {
        std::process::exit(9);
    }
    std::process::exit(i32::from(exit));
}
