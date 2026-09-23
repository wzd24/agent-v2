use crate::config;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn file_path() -> PathBuf {
    let dest = config::app_root().join("automations.json");
    let _ = config::copy_file_if_absent(&config::engine_home().join("automations.json"), &dest);
    dest
}

fn clamp(value: Option<f64>, min: i64, max: i64, fallback: i64) -> i64 {
    value
        .map(|item| item.round() as i64)
        .filter(|item| *item >= min && *item <= max)
        .unwrap_or(fallback)
}

fn normalize_schedule(input: &Value) -> Result<Value, String> {
    let kind = input
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("daily");
    match kind {
        "interval" => {
            let minutes = input
                .get("minutes")
                .and_then(Value::as_f64)
                .map(|value| value.max(1.0) as i64)
                .unwrap_or(60);
            Ok(json!({ "kind": "interval", "minutes": minutes }))
        }
        "once" => {
            let at = input
                .get("at")
                .and_then(Value::as_str)
                .ok_or_else(|| "一次性任务需要有效的时间".to_string())?;
            Ok(json!({ "kind": "once", "at": at }))
        }
        _ => Ok(json!({
            "kind": "daily",
            "hour": clamp(input.get("hour").and_then(Value::as_f64), 0, 23, 9),
            "minute": clamp(input.get("minute").and_then(Value::as_f64), 0, 59, 0),
        })),
    }
}

fn normalize_item(input: &Value, fallback: Option<&Value>) -> Result<Value, String> {
    let id = input
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            fallback
                .and_then(|item| item.get("id"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| format!("auto-{}", now_ms()));
    let name = input
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            fallback
                .and_then(|item| item.get("name"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| "未命名自动化".into());
    let prompt = input
        .get("prompt")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            fallback
                .and_then(|item| item.get("prompt"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .ok_or_else(|| "自动化需要提示词".to_string())?;
    let schedule = normalize_schedule(
        input
            .get("schedule")
            .or_else(|| fallback.and_then(|item| item.get("schedule")))
            .unwrap_or(&json!({ "kind": "daily", "hour": 9, "minute": 0 })),
    )?;
    Ok(json!({
        "id": id,
        "name": name,
        "prompt": prompt,
        "cwd": input.get("cwd").and_then(Value::as_str).unwrap_or_else(|| fallback.and_then(|item| item.get("cwd")).and_then(Value::as_str).unwrap_or("")),
        "enabled": input.get("enabled").and_then(Value::as_bool).unwrap_or(true),
        "schedule": schedule,
        "lastRunAt": input.get("lastRunAt").cloned().or_else(|| fallback.and_then(|item| item.get("lastRunAt")).cloned()).unwrap_or(Value::Null),
        "lastThreadId": input.get("lastThreadId").cloned().or_else(|| fallback.and_then(|item| item.get("lastThreadId")).cloned()).unwrap_or(Value::Null),
        "lastError": input.get("lastError").and_then(Value::as_str).unwrap_or(""),
    }))
}

fn read_document() -> Result<Vec<Value>, String> {
    let file = file_path();
    if !file.exists() {
        return Ok(Vec::new());
    }
    let raw: Value = serde_json::from_str(&fs::read_to_string(&file).map_err(|err| err.to_string())?)
        .map_err(|err| format!("{} 不是有效 JSON：{err}", file.display()))?;
    let items = raw
        .get("automations")
        .and_then(Value::as_array)
        .cloned()
        .or_else(|| raw.as_array().cloned())
        .unwrap_or_default();
    Ok(items
        .iter()
        .filter_map(|item| normalize_item(item, None).ok())
        .collect())
}

fn write_document(items: Vec<Value>) -> Result<(), String> {
    let file = file_path();
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(
        file,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&json!({ "automations": items }))
                .map_err(|err| err.to_string())?
        ),
    )
    .map_err(|err| err.to_string())
}

fn describe(item: &Value) -> String {
    let schedule = item.get("schedule").cloned().unwrap_or(json!({}));
    match schedule.get("kind").and_then(Value::as_str).unwrap_or("daily") {
        "interval" => format!(
            "每 {} 分钟",
            schedule.get("minutes").and_then(Value::as_u64).unwrap_or(60)
        ),
        "once" => format!(
            "一次 · {}",
            schedule
                .get("at")
                .and_then(Value::as_str)
                .unwrap_or("")
                .replace('T', " ")
                .chars()
                .take(16)
                .collect::<String>()
        ),
        _ => format!(
            "每天 {:02}:{:02}",
            schedule.get("hour").and_then(Value::as_u64).unwrap_or(9),
            schedule.get("minute").and_then(Value::as_u64).unwrap_or(0)
        ),
    }
}

fn next_run_at(item: &Value, now: i64) -> Option<i64> {
    if item.get("enabled").and_then(Value::as_bool) == Some(false) {
        return None;
    }
    let schedule = item.get("schedule")?;
    match schedule.get("kind").and_then(Value::as_str).unwrap_or("daily") {
        "interval" => {
            let minutes = schedule.get("minutes").and_then(Value::as_i64).unwrap_or(60);
            let last = item
                .get("lastRunAt")
                .and_then(Value::as_str)
                .and_then(|value| chrono_ms(value))
                .unwrap_or(0);
            Some((if last == 0 { now } else { last }) + minutes * 60 * 1000)
        }
        "once" => {
            if item.get("lastRunAt").and_then(Value::as_str).is_some() {
                return None;
            }
            schedule
                .get("at")
                .and_then(Value::as_str)
                .and_then(chrono_ms)
        }
        _ => {
            let hour = schedule.get("hour").and_then(Value::as_i64).unwrap_or(9);
            let minute = schedule.get("minute").and_then(Value::as_i64).unwrap_or(0);
            Some(next_daily(now, hour, minute))
        }
    }
}

fn chrono_ms(value: &str) -> Option<i64> {
    let parsed = chrono_parse(value)?;
    Some(parsed)
}

fn chrono_parse(value: &str) -> Option<i64> {
    let trimmed = value.trim();
    if let Ok(number) = trimmed.parse::<i64>() {
        if number > 1_000_000_000_000 {
            return Some(number);
        }
        if number > 1_000_000_000 {
            return Some(number * 1000);
        }
    }
    datetime_secs(trimmed).ok().map(|secs| secs * 1000)
}

fn datetime_secs(value: &str) -> Result<i64, ()> {
    // 2026-09-21T09:00:00.000Z or 2026-09-21T09:00
    let cleaned = value.trim().trim_end_matches('Z');
    let (date, time) = cleaned.split_once('T').or_else(|| cleaned.split_once(' ')).ok_or(())?;
    let mut d = date.split('-');
    let year: i32 = d.next().ok_or(())?.parse().map_err(|_| ())?;
    let month: u32 = d.next().ok_or(())?.parse().map_err(|_| ())?;
    let day: u32 = d.next().ok_or(())?.parse().map_err(|_| ())?;
    let mut t = time.split(':');
    let hour: u32 = t.next().unwrap_or("0").parse().unwrap_or(0);
    let minute: u32 = t.next().unwrap_or("0").parse().unwrap_or(0);
    let second: u32 = t
        .next()
        .unwrap_or("0")
        .split('.')
        .next()
        .unwrap_or("0")
        .parse()
        .unwrap_or(0);
    let days = days_from_civil(year, month, day)?;
    Ok(days * 86400 + i64::from(hour) * 3600 + i64::from(minute) * 60 + i64::from(second))
}

fn days_from_civil(year: i32, month: u32, day: u32) -> Result<i64, ()> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return Err(());
    }
    let y = i64::from(if month <= 2 { year - 1 } else { year });
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = i64::from(if month > 2 { month - 3 } else { month + 9 });
    let doy = (153 * mp + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Ok(era * 146097 + doe - 719468)
}

fn next_daily(now_ms: i64, hour: i64, minute: i64) -> i64 {
    let now_secs = now_ms / 1000;
    let day = now_secs / 86400;
    let tod = hour * 3600 + minute * 60;
    let mut candidate = day * 86400 + tod;
    if candidate * 1000 <= now_ms {
        candidate += 86400;
    }
    candidate * 1000
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0)
}

fn decorate(items: Vec<Value>) -> Value {
    let now = now_ms() as i64;
    json!({
        "file": file_path().display().to_string(),
        "automations": items.into_iter().map(|item| {
            let mut object = item;
            let next = next_run_at(&object, now);
            object.as_object_mut().unwrap().insert("nextRunAt".into(), json!(next));
            let label = describe(&object);
            object.as_object_mut().unwrap().insert("scheduleLabel".into(), json!(label));
            object
        }).collect::<Vec<_>>(),
    })
}

pub fn list() -> Result<Value, String> {
    Ok(decorate(read_document()?))
}

pub fn upsert(input: &Value) -> Result<Value, String> {
    let mut items = read_document()?;
    let id = input.get("id").and_then(Value::as_str).unwrap_or("");
    let existing = items.iter().find(|item| item.get("id").and_then(Value::as_str) == Some(id)).cloned();
    let item = normalize_item(input, existing.as_ref())?;
    if let Some(existing) = existing {
        let id = existing.get("id").and_then(Value::as_str).unwrap_or("");
        items = items
            .into_iter()
            .map(|entry| {
                if entry.get("id").and_then(Value::as_str) == Some(id) {
                    let mut next = item.clone();
                    next.as_object_mut().unwrap().insert(
                        "lastRunAt".into(),
                        existing.get("lastRunAt").cloned().unwrap_or(Value::Null),
                    );
                    next.as_object_mut().unwrap().insert(
                        "lastThreadId".into(),
                        existing.get("lastThreadId").cloned().unwrap_or(Value::Null),
                    );
                    next
                } else {
                    entry
                }
            })
            .collect();
    } else {
        items.push(item);
    }
    write_document(items)?;
    list()
}

pub fn remove(id: &str) -> Result<Value, String> {
    let items = read_document()?
        .into_iter()
        .filter(|item| item.get("id").and_then(Value::as_str) != Some(id))
        .collect();
    write_document(items)?;
    list()
}

pub fn mark_run(id: &str, thread_id: Option<&str>, error: Option<&str>) -> Result<Value, String> {
    let now = iso_now();
    let items = read_document()?
        .into_iter()
        .map(|mut item| {
            if item.get("id").and_then(Value::as_str) == Some(id) {
                item.as_object_mut()
                    .unwrap()
                    .insert("lastRunAt".into(), json!(now));
                if let Some(thread) = thread_id {
                    item.as_object_mut()
                        .unwrap()
                        .insert("lastThreadId".into(), json!(thread));
                }
                item.as_object_mut()
                    .unwrap()
                    .insert("lastError".into(), json!(error.unwrap_or("")));
            }
            item
        })
        .collect();
    write_document(items)?;
    list()
}

pub fn due_items() -> Result<Vec<Value>, String> {
    let now = now_ms() as i64;
    Ok(read_document()?
        .into_iter()
        .filter(|item| {
            if item.get("enabled").and_then(Value::as_bool) == Some(false) {
                return false;
            }
            match next_run_at(item, now) {
                Some(next) => {
                    let interval = item
                        .pointer("/schedule/kind")
                        .and_then(Value::as_str)
                        == Some("interval");
                    let never = item.get("lastRunAt").and_then(Value::as_str).is_none();
                    if interval && never {
                        true
                    } else {
                        next <= now
                    }
                }
                None => false,
            }
        })
        .collect())
}

fn iso_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0) as i64;
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let hour = rem / 3600;
    let minute = (rem % 3600) / 60;
    let second = rem % 60;
    let (year, month, day) = civil_from_unix_days(days);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.000Z")
}

fn civil_from_unix_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = y + i64::from(m <= 2);
    (year as i32, m as u32, d as u32)
}

pub fn get(id: &str) -> Result<Value, String> {
    read_document()?
        .into_iter()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(id))
        .ok_or_else(|| "找不到这条自动化".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_daily_schedule() {
        let daily = normalize_item(
            &json!({
                "name": "morning",
                "prompt": "summarize git status",
                "schedule": { "kind": "daily", "hour": 9, "minute": 0 },
            }),
            None,
        )
        .unwrap();
        assert_eq!(daily["schedule"]["kind"], "daily");
        assert_eq!(daily["schedule"]["hour"], 9);
    }

    #[test]
    fn interval_next_run_adds_minutes() {
        let interval = normalize_item(
            &json!({
                "name": "often",
                "prompt": "check tests",
                "schedule": { "kind": "interval", "minutes": 30 },
                "lastRunAt": "2026-09-11T10:00:00.000Z",
            }),
            None,
        )
        .unwrap();
        let now = chrono_ms("2026-09-11T10:10:00.000Z").unwrap();
        assert_eq!(
            next_run_at(&interval, now),
            chrono_ms("2026-09-11T10:30:00.000Z")
        );
    }

    #[test]
    fn once_schedule_does_not_repeat() {
        let item = normalize_item(
            &json!({
                "name": "later",
                "prompt": "one shot",
                "schedule": { "kind": "once", "at": "2026-09-11T08:00:00Z" },
                "lastRunAt": "2026-09-11T08:00:00.000Z",
            }),
            None,
        )
        .unwrap();
        assert_eq!(next_run_at(&item, chrono_ms("2026-09-11T10:00:00.000Z").unwrap()), None);
    }
}
