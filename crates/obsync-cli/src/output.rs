#![forbid(unsafe_code)]

use crate::{Result, catalog, s};
use obsync_core::json::{Value, obj};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn render(
    result: Result<Value>,
    operation: Option<&str>,
    format: &str,
    elapsed: u128,
    verbose: bool,
) -> String {
    let late = result.is_ok() && elapsed > 5000;
    let mut text = render_result(result, operation, format, elapsed, verbose);
    if late && format == "human" {
        text.push_str(&format!(
            "Completed after the five-second deadline ({elapsed} ms). The result was verified.\n"
        ));
    }
    text
}

fn render_result(
    result: Result<Value>,
    operation: Option<&str>,
    format: &str,
    elapsed: u128,
    verbose: bool,
) -> String {
    let (data, error, state) = match result {
        Ok(data) => {
            let state = if data.get("plan").is_some() {
                "planned"
            } else {
                "completed"
            };
            (data, Value::Null, state)
        }
        Err(error) => (
            Value::Null,
            obj(vec![
                ("code", s(error.code)),
                ("message", s(error.message)),
                ("exit_code", Value::Int(error.exit.into())),
            ]),
            if error.exit == 7 {
                "unknown"
            } else if error.exit == 9 {
                "failed"
            } else {
                "refused"
            },
        ),
    };
    let late = error.is_null() && elapsed > 5000;
    if format == "human" {
        if !error.is_null() {
            return format!(
                "error: {} [{}]\n",
                catalog::field(&error, "message"),
                catalog::field(&error, "code")
            );
        }
        if let Some(help) = data.get("help").and_then(Value::as_str) {
            return help.to_owned();
        }
        if data.get("cancelled").and_then(Value::as_bool) == Some(true) {
            return "Cancelled. Settings are unchanged.\n".into();
        }
        if let Some(script) = data.get("script").and_then(Value::as_str) {
            return format!("{}\n\n{}\n", catalog::field(&data, "instruction"), script);
        }
        if operation == Some("cli.version") {
            return format!(
                "obsync {} (native Rust; schema 1)\n",
                catalog::field(&data, "version")
            );
        }
        if matches!(operation, Some("cli.install" | "cli.uninstall")) {
            let mut text = format!(
                "obsync {} {}.\nConfiguration preserved.\n",
                env!("CARGO_PKG_VERSION"),
                if operation == Some("cli.install") {
                    "installed and verified"
                } else {
                    "uninstalled"
                }
            );
            if data.get("cleanup_durable").and_then(Value::as_bool) == Some(false) {
                text.push_str("Installation path retired. Cleanup may need the same uninstall after power loss.\n");
            }
            if operation == Some("cli.install") {
                text.push_str(&format!(
                    "Add this directory to PATH once:\n  {}\n",
                    catalog::field(&data, "installation")
                ));
            }
            return text;
        }
        if let Some(plan) = data.get("plan") {
            return format!(
                "{}\nSettings are unchanged. Expires {}.\n\nSave this plan as JSON:\n{}\n\nApply the saved file before expiry:\n  obsync apply -f ABSOLUTE_PLAN --expect-digest {}\nUse the same --config-dir override, if one was supplied.\n",
                plan_summary(plan),
                expiry(plan),
                plan.to_json(),
                catalog::field(plan, "digest")
            );
        }
        if operation == Some("context.current") {
            return format!(
                "{}\n",
                data.get("context")
                    .map_or("", |c| catalog::field(c, "name"))
            );
        }
        if let Some(context) = data.get("context") {
            return format!(
                "Name:               {}\nServer:             {}\nCurrent:            {}\nExpected instance:  {}\nVerified instance:  not checked\n",
                catalog::field(context, "name"),
                catalog::field(context, "origin"),
                data.get("current").unwrap().to_json(),
                context
                    .get("expected_instance")
                    .and_then(Value::as_str)
                    .unwrap_or("not configured")
            );
        }
        if let Some(items) = data.get("items").and_then(Value::as_array) {
            if operation == Some("context.list") {
                let width = items
                    .iter()
                    .map(|i| catalog::field(i, "name").len())
                    .max()
                    .unwrap_or(4)
                    .max(4);
                let mut text = format!("CURRENT  {:<width$}  SERVER\n", "NAME");
                let current = data.get("current").and_then(Value::as_str);
                for item in items {
                    text.push_str(&format!(
                        "{:<8} {:<width$}  {}\n",
                        if current == Some(catalog::field(item, "name")) {
                            "*"
                        } else {
                            ""
                        },
                        catalog::field(item, "name"),
                        catalog::field(item, "origin")
                    ));
                }
                if items.is_empty() {
                    text.push_str("No servers saved.\n");
                }
                return text;
            }
            let width = items
                .iter()
                .map(|item| catalog::field(item, "command").len())
                .max()
                .unwrap_or(7)
                .max(7);
            let mut text = format!("{:<width$}  DESCRIPTION\n", "COMMAND");
            for item in items {
                text.push_str(&format!(
                    "{:<width$}  {}\n",
                    catalog::field(item, "command"),
                    catalog::field(item, "summary")
                ));
            }
            if items.is_empty() {
                text.push_str("No matching operations.\n");
            }
            return text;
        }
        if let Some(entries) = data.get("operations").and_then(Value::as_array) {
            let mut text = String::from("OPERATION             AVAILABILITY\n");
            for entry in entries {
                text.push_str(&format!(
                    "{:<21} {}\n",
                    catalog::field(entry, "operation"),
                    availability(entry)
                ));
            }
            text.push_str("\nServer capabilities: not checked (offline discovery).\n");
            return text;
        }
        if let Some(lines) = data.get("instructions").and_then(Value::as_array) {
            return lines
                .iter()
                .filter_map(Value::as_str)
                .map(|line| format!("- {line}\n"))
                .collect();
        }
        if operation == Some("schema") {
            return format!(
                "OPERATION: {}\nCOMMAND:   obsync {}\nEFFECT:    {}\nAVAILABLE: {}\n\n{}\n\nInput schema:\n{}\n\nUse -o json for the complete machine contract.\n",
                catalog::field(&data, "operation"),
                catalog::field(&data, "command"),
                catalog::field(&data, "effect"),
                availability(&data),
                catalog::field(&data, "summary"),
                data.get("input_schema").unwrap_or(&Value::Null).to_json()
            );
        }
        if data.get("id").is_some() {
            let name = catalog::field(&data, "name");
            let mut text = match catalog::field(&data, "operation") {
                "context.add" => format!("Added server \"{name}\".\n"),
                "context.use" => format!("Selected server \"{name}\".\n"),
                _ => format!("Removed server \"{name}\" from local settings.\n"),
            };
            if catalog::field(&data, "operation") == "context.add" {
                if data.get("current").and_then(Value::as_str) == Some(name) {
                    text.push_str("This is the selected server.\n");
                } else {
                    text.push_str(&format!(
                        "Select it with: obsync config use-context {name}\n"
                    ));
                }
            }
            if data.get("replayed").and_then(Value::as_bool) == Some(true) {
                text.push_str("Already applied; no new change.\n");
            }
            if verbose {
                text.push_str(&format!(
                    "Revision: {}\nReceipt: {}\n",
                    data.get("revision").unwrap().to_json(),
                    catalog::field(&data, "id")
                ));
            }
            return text;
        }
        if operation == Some("context.recover") {
            return format!(
                "Local settings recovered.\nSelected server: {}\n",
                data.get("current")
                    .and_then(Value::as_str)
                    .unwrap_or("none")
            );
        }
        if operation == Some("doctor") {
            let config = data.get("configuration").unwrap();
            let count = config.get("contexts").and_then(Value::as_u64).unwrap_or(0);
            let mut text = if count == 0 {
                "No server yet. Add one:\n  obsync context add NAME --server https://sync.example.org\n".into()
            } else {
                format!(
                    "Local settings are readable: {count} server(s).\nSelected server: {}\n",
                    config
                        .get("current")
                        .and_then(Value::as_str)
                        .unwrap_or("none; select one with 'obsync context use NAME'")
                )
            };
            text.push_str("Server connectivity and Obsidian were not checked.\n");
            if verbose {
                text.push_str(&format!(
                    "Revision: {}\n",
                    config.get("revision").unwrap().to_json()
                ));
            }
            return text;
        }
        return format!("{}\n", data.to_json());
    }
    let plan = data.get("plan");
    let target = data
        .get("context")
        .or_else(|| plan.and_then(|p| p.get("parameters")));
    let operation_id = plan
        .or_else(|| data.get("id").map(|_| &data))
        .and_then(|v| v.get("id"))
        .cloned()
        .unwrap_or(Value::Null);
    let result = obj(vec![
        ("schema_version", Value::Int(1)),
        ("operation", operation.map_or(Value::Null, s)),
        (
            "target",
            obj(vec![
                (
                    "context",
                    target
                        .and_then(|v| v.get("name"))
                        .cloned()
                        .unwrap_or(Value::Null),
                ),
                (
                    "origin",
                    target
                        .and_then(|v| v.get("origin"))
                        .cloned()
                        .unwrap_or(Value::Null),
                ),
                (
                    "expected_instance",
                    target
                        .and_then(|v| v.get("expected_instance"))
                        .cloned()
                        .unwrap_or(Value::Null),
                ),
                ("verified_instance", Value::Null),
            ]),
        ),
        ("state", s(state)),
        ("data", data),
        ("error", error),
        (
            "warnings",
            Value::Array(if late {
                vec![s(
                    "Completed after the five-second deadline; the result was verified.",
                )]
            } else {
                vec![]
            }),
        ),
        (
            "next_actions",
            Value::Array(if state == "planned" {
                vec![s(
                    "Save data.plan to a file and apply its exact digest before expiry.",
                )]
            } else {
                vec![]
            }),
        ),
        ("operation_id", operation_id),
        ("observed_at", s(timestamp())),
        (
            "duration_ms",
            Value::Int(elapsed.min(i64::MAX as u128) as i64),
        ),
        (
            "verification",
            obj(vec![
                ("level", s("local")),
                ("server_contacted", Value::Bool(false)),
            ]),
        ),
        ("pagination", Value::Null),
    ]);
    format!("{}\n", result.to_json())
}

fn availability(entry: &Value) -> &'static str {
    match catalog::field(entry, "availability") {
        "implemented" | "implemented_local" => "available locally",
        _ => "not available yet",
    }
}

pub fn plan_summary(plan: &Value) -> String {
    let parameters = plan.get("parameters").unwrap();
    let name = catalog::field(parameters, "name");
    match catalog::field(plan, "operation") {
        "context.add" => format!(
            "Add server \"{name}\" ({}){}.",
            catalog::field(parameters, "origin"),
            if parameters.get("select").and_then(Value::as_bool) == Some(true) {
                " and select it"
            } else {
                ""
            }
        ),
        "context.use" => format!("Select server \"{name}\"."),
        _ => format!("Remove server \"{name}\" from local settings. Server data is unchanged."),
    }
}

fn expiry(plan: &Value) -> String {
    let remaining = plan
        .get("expires_at")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .saturating_sub(crate::context::now().unwrap_or(0))
        .div_ceil(1000);
    if remaining == 0 {
        "now (expired)".into()
    } else if remaining >= 60 {
        format!("in {} minutes", remaining.div_ceil(60))
    } else {
        format!("in {remaining} seconds")
    }
}

// Gregorian civil date from days since the Unix epoch. No local timezone reads.
fn timestamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days = secs / 86400 + 719468;
    let era = days / 146097;
    let doe = days - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    year += u64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        secs % 86400 / 3600,
        secs % 3600 / 60,
        secs % 60
    )
}
