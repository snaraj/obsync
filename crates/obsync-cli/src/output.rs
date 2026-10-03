#![forbid(unsafe_code)]

use crate::{Result, catalog, s};
use obsync_core::json::{Value, obj};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn render(
    result: Result<Value>,
    operation: Option<&str>,
    format: &str,
    elapsed: u128,
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
            return text;
        }
        if let Some(plan) = data.get("plan") {
            return format!(
                "Plan ready; configuration is unchanged.\nOperation: {}\nExpires:   {} (Unix milliseconds)\n\nSave this plan as JSON:\n{}\n\nApply the saved file before expiry:\n  obsync apply -f ABSOLUTE_PLAN --expect-digest {} --config-dir CONFIG_DIR\n",
                catalog::field(plan, "operation"),
                plan.get("expires_at").unwrap().to_json(),
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
                    text.push_str("No contexts configured.\n");
                }
                return text;
            }
            let mut text = String::from(
                "COMMAND                         AVAILABILITY               DESCRIPTION\n",
            );
            for item in items {
                text.push_str(&format!(
                    "{:<31} {:<26} {}\n",
                    catalog::field(item, "command"),
                    catalog::field(item, "availability"),
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
                    catalog::field(entry, "availability")
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
                catalog::field(&data, "availability"),
                catalog::field(&data, "summary"),
                data.get("input_schema").unwrap_or(&Value::Null).to_json()
            );
        }
        if operation == Some("context.apply") {
            return format!(
                "context/{}: {} at revision {}{}\nReceipt: {}\n",
                catalog::field(&data, "name"),
                catalog::field(&data, "operation"),
                data.get("revision").unwrap().to_json(),
                if data.get("replayed").and_then(Value::as_bool) == Some(true) {
                    " (replayed; no new change)"
                } else {
                    ""
                },
                catalog::field(&data, "id")
            );
        }
        if operation == Some("context.recover") {
            return format!(
                "Local configuration recovered at revision {}.\nCurrent context: {}\n",
                data.get("revision").unwrap().to_json(),
                data.get("current")
                    .and_then(Value::as_str)
                    .unwrap_or("none")
            );
        }
        if operation == Some("doctor") {
            let config = data.get("configuration").unwrap();
            return format!(
                "Runtime:         native Rust\nConfiguration:   {}\nRevision:        {}\nContexts:        {}\nCurrent context: {}\nNetwork:         not checked\nObsidian:        not checked\nRepairs:         none\n",
                if config.get("present").and_then(Value::as_bool) == Some(true) {
                    "present"
                } else {
                    "absent"
                },
                config.get("revision").unwrap().to_json(),
                config.get("contexts").unwrap().to_json(),
                config
                    .get("current")
                    .and_then(Value::as_str)
                    .unwrap_or("none")
            );
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
        ("warnings", Value::Array(vec![])),
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
