#![forbid(unsafe_code)]

use crate::{Error, Result, args::Args, s};
use obsync_core::json::{self, Value, obj};

pub fn load() -> Vec<Value> {
    json::parse(include_bytes!("../catalog.json"))
        .expect("compiled catalog must be JSON")
        .get("operations")
        .and_then(Value::as_array)
        .expect("catalog operations")
        .to_vec()
}
pub fn schema(entry: &Value) -> Value {
    let catalog = json::parse(include_bytes!("../catalog.json")).expect("compiled catalog");
    let mut pairs = catalog
        .get("common")
        .and_then(Value::as_object)
        .expect("catalog defaults")
        .to_vec();
    pairs.extend(entry.as_object().expect("catalog entry").to_vec());
    Value::Object(pairs)
}
pub fn field<'a>(entry: &'a Value, name: &str) -> &'a str {
    entry.get(name).and_then(Value::as_str).unwrap_or("")
}
pub fn find<'a>(catalog: &'a [Value], query: &str) -> Option<&'a Value> {
    if let Some(entry) = catalog
        .iter()
        .find(|entry| field(entry, "operation") == query)
    {
        return Some(entry);
    }
    let mut matches = catalog.iter().filter(|entry| {
        field(entry, "operation") == query
            || field(entry, "command")
                .split(['[', '<'])
                .next()
                .unwrap_or("")
                .trim()
                == query
            || field(entry, "command")
                .strip_prefix(query)
                .is_some_and(|rest| rest.starts_with(' '))
    });
    let first = matches.next()?;
    if matches.next().is_some() {
        None
    } else {
        Some(first)
    }
}

pub fn help_data(args: &Args, catalog: &[Value], operation: &str) -> Result<Value> {
    let words: Vec<_> = args.words.iter().map(String::as_str).collect();
    let query = if words.first() == Some(&"help") {
        words[1..].join(" ")
    } else {
        words.join(" ")
    };
    if query.is_empty() {
        args.check(0, 1, &["help"])?;
        return Ok(obj(vec![("help", s(root_help(catalog)))]));
    }
    if query == "config" || operation == "config.help" {
        args.check(1, 2, &["help"])?;
        let mut text = String::from(
            "Manage local contexts. Configuration writes require an exact plan.\n\nUsage:\n  obsync config COMMAND [flags]\n\nCommands:\n",
        );
        for entry in catalog
            .iter()
            .filter(|entry| field(entry, "command").starts_with("config "))
        {
            text.push_str(&format!(
                "  {}\n      {}\n",
                field(entry, "command"),
                field(entry, "summary")
            ));
        }
        text.push_str(global_flags());
        return Ok(obj(vec![("help", s(text))]));
    }
    let alias = match query.as_str() {
        "get context" | "get contexts" => "context.list",
        "describe context" | "describe contexts" => "context.get",
        "explain" => "schema",
        other => other,
    };
    let entry = find(catalog, if args.has("help") { operation } else { alias })
        .ok_or_else(|| Error::input("Unknown help topic. Run 'obsync help'."))?;
    let mut allowed = vec!["help"];
    allowed.extend(match field(entry, "operation") {
        "context.add" => vec!["server", "expected-instance"],
        "context.apply" => vec!["filename", "expect-digest"],
        "context.get" | "doctor" => vec!["context"],
        "cli.install" | "cli.uninstall" => vec!["from", "prefix", "manifest-sha256"],
        _ => vec![],
    });
    args.check(1, 4, &allowed)?;
    let examples = entry
        .get("examples")
        .and_then(Value::as_array)
        .unwrap_or(&[])
        .iter()
        .filter_map(Value::as_str)
        .map(|line| format!("  {line}\n"))
        .collect::<String>();
    let mut text = format!(
        "{}\n\nUsage:\n  obsync {} [flags]\n\nExamples:\n{}\nAvailability: {}\n",
        field(entry, "summary"),
        field(entry, "command"),
        examples,
        field(entry, "availability")
    );
    if field(entry, "operation").starts_with("context.") {
        text.push_str("\nContext changes return plans. Apply writes the plan; config recover may discard an incomplete snapshot.\n");
    }
    match field(entry, "operation") {
        "context.add" => text.push_str("\nCommand flags:\n      --server ORIGIN            Required HTTPS origin\n      --expected-instance SHA256 Optional expected server fingerprint\n"),
        "context.apply" => text.push_str("\nCommand flags:\n  -f, --filename FILE        Exact plan JSON file\n      --expect-digest SHA256 Required digest from that plan\n"),
        "context.get" => text.push_str("\nCommand flags:\n      --context NAME         Explicit target; otherwise use current context\n"),
        "cli.install" | "cli.uninstall" => text.push_str("\nCommand flags:\n      --from DIRECTORY       Independently verified private package\n      --prefix DIRECTORY     Exact separate private installation target\n      --manifest-sha256 HASH Independently verified manifest digest\n"),
        _ => {}
    }
    text.push_str(global_flags());
    text.push_str(&format!(
        "\nInspect the complete contract: obsync explain {}\n",
        field(entry, "operation")
    ));
    Ok(obj(vec![("help", s(text))]))
}

fn root_help(catalog: &[Value]) -> String {
    let mut text = String::from(
        "Manage obsync with explicit targets and verifiable results.\n\nUsage:\n  obsync COMMAND [flags]\n\nDiscovery:\n",
    );
    for entry in catalog
        .iter()
        .filter(|entry| !field(entry, "operation").starts_with("context."))
    {
        text.push_str(&format!(
            "  {:30} {}\n",
            field(entry, "command"),
            field(entry, "summary")
        ));
    }
    text.push_str("\nConfiguration:\n  config get-contexts            List named contexts\n  config current-context         Show the selected context\n  config view [NAME]             Describe a context\n  config set-context NAME        Plan a new HTTPS target\n  config use-context NAME        Plan context selection\n  config delete-context NAME     Plan removal of a local association\n  apply -f PLAN                  Apply an exact reviewed plan\n\nRead aliases:\n  get contexts [NAME]\n  describe context NAME\n  explain OPERATION\n");
    text.push_str(global_flags());
    text.push_str("\nUse 'obsync COMMAND --help' for command help.\nUse 'obsync capabilities -o json' for actual availability.\n");
    text
}
fn global_flags() -> &'static str {
    "\nGlobal flags:\n  -h, --help                Show command help\n  -o, --output FORMAT       human (default), json or jsonl\n      --config-dir PATH     Explicit absolute configuration directory\n      --non-interactive     Never prompt or open a browser\n\nWindows storage flags:\n      --windows-trust FILE       Trusted OS PowerShell receipt\n      --windows-trust-sha256 HASH Independently retained receipt digest\n"
}
