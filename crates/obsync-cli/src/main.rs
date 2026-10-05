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
#[cfg(any(windows, test))]
mod helper_session;
mod output;
mod package;
#[cfg(any(target_os = "macos", all(test, unix)))]
mod process;
mod store;
#[cfg(windows)]
mod windows;

use obsync_core::json::{Value, obj};
use std::{
    io::{self, BufRead, IsTerminal, Read, Write},
    time::Instant,
};

type Result<T> = std::result::Result<T, Error>;
#[derive(Debug)]
struct Error {
    code: &'static str,
    message: String,
    exit: u8,
}
impl Error {
    fn new(code: &'static str, message: impl Into<String>, exit: u8) -> Self {
        Self {
            code,
            message: message.into(),
            exit,
        }
    }
    fn input(message: impl Into<String>) -> Self {
        Self {
            code: "invalid_input",
            message: message.into(),
            exit: 2,
        }
    }
    fn unsupported(message: &'static str) -> Self {
        Self {
            code: "unsupported_capability",
            message: message.into(),
            exit: 6,
        }
    }
}
fn s(value: impl Into<String>) -> Value {
    Value::Str(value.into())
}

fn run(
    args: &args::Args,
    operation: &str,
    catalog: &[Value],
    started: &mut Instant,
) -> Result<Value> {
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
            *started + std::time::Duration::from_secs(5),
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
                "Use -o json to plan context changes; apply the exact digest before five-minute expiry. Use --config-dir to override OS settings, and read state back in a new process.",
                "Never put credentials, vault keys or recovery words in command arguments or contexts.",
                "A configured HTTPS origin is not a verified server identity.",
            ].map(s).to_vec()))]))
        }
        _ => run_context(args, operation, started),
    }
}

fn run_context(args: &args::Args, op: &str, started: &mut Instant) -> Result<Value> {
    use context::{Context, Plan};
    let mut store = store::Store::new(args, *started + std::time::Duration::from_secs(5))?;
    let result = match op {
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
                    &["server", "expected-instance", "use", "yes", "plan"]
                } else {
                    &["yes", "plan"]
                },
            )?;
            if args.has("yes") && args.has("plan") {
                return Err(Error::input("Choose --yes to apply or --plan to preview."));
            }
            let mut parameters = if op == "context.add" {
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
            if args.has("use")
                && let Value::Object(pairs) = &mut parameters
            {
                pairs.push(("select".into(), Value::Bool(true)));
            }
            let (state, _) = store.read()?;
            if op == "context.add"
                && state.contexts.is_empty()
                && let Value::Object(pairs) = &mut parameters
                && !pairs.iter().any(|(key, _)| key == "select")
            {
                pairs.push(("select".into(), Value::Bool(true)));
            }
            let plan = Plan::create(&state, op, parameters, &store.target)?;
            if args.has("yes") {
                let result = store.apply(&plan)?;
                store.finish()?;
                return Ok(result);
            }
            if !args.has("plan")
                && !args.has("non-interactive")
                && args.get("output").is_none_or(|format| format == "human")
                && io::stdin().is_terminal()
                && io::stdout().is_terminal()
            {
                // Never retain a helper or lock while a person considers a
                // change. Reopen and validate the exact plan after confirmation.
                store.finish()?;
                drop(store);
                let waiting = Instant::now();
                let confirmed = confirm(&plan);
                *started += waiting.elapsed();
                if !confirmed? {
                    return Ok(obj(vec![("cancelled", Value::Bool(true))]));
                }
                let mut store =
                    store::Store::new(args, *started + std::time::Duration::from_secs(5))?;
                let result = store.apply(&plan)?;
                store.finish()?;
                return Ok(result);
            }
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
    }?;
    store.finish()?;
    Ok(result)
}

fn confirm(plan: &context::Plan) -> Result<bool> {
    let mut out = io::stdout().lock();
    write!(out, "{}\nApply? [y/N] ", output::plan_summary(&plan.value))
        .map_err(custody::io_error)?;
    out.flush().map_err(custody::io_error)?;
    let mut line = String::new();
    io::stdin()
        .lock()
        .take(9)
        .read_line(&mut line)
        .map_err(custody::io_error)?;
    Ok(line.ends_with('\n') && matches!(line.trim().to_ascii_lowercase().as_str(), "y" | "yes"))
}

fn main() {
    let mut started = Instant::now();
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
    let result = (|| {
        let args = parsed.as_ref().map_err(|error| Error {
            code: error.code,
            message: error.message.clone(),
            exit: error.exit,
        })?;
        if !["human", "json", "jsonl"].contains(&format) {
            return Err(Error::input("Output must be human, json or jsonl."));
        }
        let op = args.operation()?;
        if args.has("help") || op == "cli.help" || op == "config.help" {
            return catalog::help_data(args, &catalog, op);
        }
        run(args, op, &catalog, &mut started)
    })();
    let (exit, rendered) = finish_command(
        result,
        operation,
        format,
        started.elapsed().as_millis(),
        parsed.as_ref().is_ok_and(|args| args.has("verbose")),
    );
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

fn finish_command(
    mut result: Result<Value>,
    operation: Option<&str>,
    format: &str,
    elapsed: u128,
    verbose: bool,
) -> (u8, String) {
    if result
        .as_ref()
        .is_ok_and(|data| data.to_json().len() > 60000)
    {
        result = Err(Error::input("The result exceeds its output budget."));
    }
    // Operation guards enforce deadlines before effects. A verified result must
    // not be turned into a refusal by scheduling or output work after completion.
    let exit = result.as_ref().err().map_or(0, |error| error.exit);
    (
        exit,
        output::render(result, operation, format, elapsed, verbose),
    )
}

#[cfg(test)]
mod completion_tests {
    use super::*;

    #[test]
    fn verified_completion_survives_late_delivery_without_hiding_refusals() {
        let receipt = obj(vec![
            ("id", s("synthetic-receipt")),
            ("revision", Value::Int(1)),
        ]);
        for elapsed in [4999, 5001, 6000] {
            let (exit, text) = finish_command(
                Ok(receipt.clone()),
                Some("context.apply"),
                "json",
                elapsed,
                false,
            );
            let value = obsync_core::json::parse(text.as_bytes()).unwrap();
            assert_eq!(exit, 0);
            assert_eq!(
                value.get("state").and_then(Value::as_str),
                Some("completed")
            );
            assert_eq!(value.get("data"), Some(&receipt));
            assert_eq!(value.get("duration_ms"), Some(&Value::Int(elapsed as i64)));
            assert_eq!(
                value.get("warnings").unwrap().as_array().unwrap().len(),
                usize::from(elapsed > 5000)
            );
        }
        for (code, exit) in [("unsafe_config", 4), ("write_unknown", 7)] {
            let (actual, text) = finish_command(
                Err(Error::new(code, "synthetic refusal", exit)),
                Some("context.apply"),
                "json",
                6000,
                false,
            );
            let value = obsync_core::json::parse(text.as_bytes()).unwrap();
            assert_eq!(actual, exit);
            assert_eq!(
                value
                    .get("error")
                    .unwrap()
                    .get("code")
                    .and_then(Value::as_str),
                Some(code)
            );
            assert!(
                value
                    .get("warnings")
                    .unwrap()
                    .as_array()
                    .unwrap()
                    .is_empty()
            );
        }
    }
}
