#![forbid(unsafe_code)]

use crate::{Error, Result, args::Args, s};
use obsync_core::json::{self, Value, obj};

pub fn load() -> Vec<Value> {
    let source = json::parse(include_bytes!("../catalog.json")).expect("compiled catalog JSON");
    let defaults = source
        .get("operation_defaults")
        .and_then(Value::as_object)
        .expect("operation defaults");
    source
        .get("operations")
        .and_then(Value::as_array)
        .expect("catalog operations")
        .iter()
        .map(|entry| {
            // Expand once so help, search, schema and capabilities share the
            // complete public contract without repeating it in the source file.
            let mut fields = defaults
                .iter()
                .filter(|(key, _)| entry.get(key).is_none())
                .cloned()
                .collect::<Vec<_>>();
            fields.extend(entry.as_object().expect("operation object").iter().cloned());
            Value::Object(fields)
        })
        .collect()
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
        args.check(0, 1, &["help", "all"])?;
        return Ok(obj(vec![("help", s(root_help(catalog, args.has("all"))))]));
    }
    if query == "config" || query == "context" || operation == "config.help" {
        args.check(1, 2, &["help"])?;
        let mut text = String::from(
            "Save and select servers on this device. At a terminal, changes ask for confirmation.\n\nUsage:\n  obsync config COMMAND [flags]\n\nCommands:\n",
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
        text.push_str(&global_flags(args.has("all")));
        return Ok(obj(vec![("help", s(text))]));
    }
    let alias = match query.as_str() {
        "get context" | "get contexts" => "context.list",
        "describe context" | "describe contexts" => "context.get",
        "explain" => "schema",
        "context list" => "context.list",
        "context add" => "context.add",
        "context use" => "context.use",
        "context remove" => "context.remove",
        "context current" => "context.current",
        "context get" => "context.get",
        other => other,
    };
    let entry = find(catalog, if args.has("help") { operation } else { alias })
        .ok_or_else(|| Error::input("Unknown help topic. Run 'obsync help'."))?;
    let mut allowed = vec!["help"];
    allowed.extend(match field(entry, "operation") {
        "context.add" => vec!["server", "expected-instance", "use", "yes", "plan"],
        "context.use" | "context.remove" => vec!["yes", "plan"],
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
        "{}\n\nUsage:\n  obsync {} [flags]\n\nExamples:\n{}\n",
        field(entry, "summary"),
        field(entry, "command"),
        examples
    );
    if field(entry, "operation").starts_with("context.") {
        text.push_str("\nAt a terminal, review the change and confirm it. Use --yes to apply without a prompt, or --plan / -o json to return a plan. The first server is selected automatically.\n");
    }
    match field(entry, "operation") {
        "context.add" => text.push_str("\nCommand flags:\n      --server ORIGIN            Required HTTPS origin\n      --expected-instance SHA256 Optional expected server fingerprint\n      --use                     Select this server in the same change\n"),
        "context.apply" => text.push_str("\nCommand flags:\n  -f, --filename FILE        Exact plan JSON file\n      --expect-digest SHA256 Required digest from that plan\n"),
        "context.get" => text.push_str("\nCommand flags:\n      --context NAME         Explicit target; otherwise use current context\n"),
        "cli.install" | "cli.uninstall" => text.push_str("\nCommand flags:\n      --from DIRECTORY       Independently verified private package\n      --prefix DIRECTORY     Exact separate private installation target\n      --manifest-sha256 HASH Independently verified manifest digest\n"),
        _ => {}
    }
    if matches!(
        field(entry, "operation"),
        "context.add" | "context.use" | "context.remove"
    ) {
        text.push_str("\n      --yes                  Apply the shown change without a prompt\n      --plan                 Return a plan without changing settings\n");
    }
    text.push_str(&global_flags(false));
    text.push_str(&format!(
        "\nInspect the complete contract: obsync explain {}\n",
        field(entry, "operation")
    ));
    Ok(obj(vec![("help", s(text))]))
}

fn root_help(catalog: &[Value], all: bool) -> String {
    let mut text = String::from(
        "Save and select obsync servers on this device.\n\nUsage:\n  obsync COMMAND [flags]\n\n  config get-contexts             List saved servers\n  context add NAME --server URL   Add a server; select the first one\n  context use NAME                Select a server\n  context remove NAME             Remove local settings for a server\n  doctor                          Check settings and show the next step\n\nSign-in, server setup, devices, sync and export are not available yet.\nUse 'obsync COMMAND --help' for examples, or 'obsync help --all' for every command.\n",
    );
    if all {
        text.push_str("\nAll commands:\n");
        for entry in catalog {
            text.push_str(&format!(
                "  {}\n      {}\n",
                field(entry, "command"),
                field(entry, "summary")
            ));
        }
        text.push_str(
            "\nAliases: context list|add|use|remove, get contexts, describe context, explain.\n",
        );
        text.push_str(&global_flags(true));
    }
    text
}
fn global_flags(all: bool) -> String {
    let mut text = String::from(
        "\nFlags:\n  -h, --help                Show command help\n  -o, --output FORMAT       human (default), json or jsonl\n      --config-dir PATH     Override the default settings directory\n      --non-interactive     Never prompt or open a browser\n      --verbose             Include revision and receipt details\n",
    );
    if all || cfg!(windows) {
        text.push_str("\nWindows storage flags:\n      --windows-trust FILE       Trusted OS PowerShell receipt\n      --windows-trust-sha256 HASH Independently retained receipt digest\n");
    }
    text
}
