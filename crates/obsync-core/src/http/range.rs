//! The single-range subset of RFC 9110 `Range`, which is all
//! `GET /v1/chunks/{sid}` needs (`docs/protocol.md`, "Chunks").

/// Why a `Range` header could not be turned into one byte range.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RangeError {
    /// The header is not `bytes=` followed by one valid range. Answer 400.
    Malformed,
    /// A range this server does not serve, such as several ranges at once.
    /// Answer 400 rather than half of what was asked for.
    Unsupported,
    /// Syntactically valid but outside the resource. Answer 416.
    Unsatisfiable,
}

/// Resolve a `Range` header against a known length.
///
/// `Ok(Some((first, last)))` is an inclusive byte range already clamped to the
/// resource. `Ok(None)` means the header names a unit this server does not
/// know, which RFC 9110 says to ignore and answer 200.
pub fn parse_range(header: &str, total_len: u64) -> Result<Option<(u64, u64)>, RangeError> {
    let (unit, spec) = match header.split_once('=') {
        Some(split) => split,
        None => return Err(RangeError::Malformed),
    };
    if !unit.trim().eq_ignore_ascii_case("bytes") {
        return Ok(None);
    }
    if spec.contains(',') {
        return Err(RangeError::Unsupported);
    }
    let (first, last) = match spec.split_once('-') {
        Some(split) => split,
        None => return Err(RangeError::Malformed),
    };
    let (first, last) = (first.trim(), last.trim());
    if first.is_empty() {
        // "bytes=-n": the last n bytes.
        let suffix = decimal(last)?;
        if suffix == 0 || total_len == 0 {
            return Err(RangeError::Unsatisfiable);
        }
        return Ok(Some((total_len.saturating_sub(suffix), total_len - 1)));
    }
    let start = decimal(first)?;
    if total_len == 0 || start >= total_len {
        return Err(RangeError::Unsatisfiable);
    }
    let end = if last.is_empty() {
        total_len - 1
    } else {
        let end = decimal(last)?;
        if end < start {
            return Err(RangeError::Malformed);
        }
        end.min(total_len - 1)
    };
    Ok(Some((start, end)))
}

fn decimal(text: &str) -> Result<u64, RangeError> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(RangeError::Malformed);
    }
    text.parse::<u64>().map_err(|_| RangeError::Malformed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_ranges_are_inclusive_and_clamped() {
        assert_eq!(parse_range("bytes=0-0", 10), Ok(Some((0, 0))));
        assert_eq!(parse_range("bytes=0-9", 10), Ok(Some((0, 9))));
        assert_eq!(parse_range("bytes=2-5", 10), Ok(Some((2, 5))));
        assert_eq!(parse_range("bytes=5-99", 10), Ok(Some((5, 9))));
        assert_eq!(parse_range("bytes=9-9", 10), Ok(Some((9, 9))));
    }

    #[test]
    fn open_and_suffix_ranges_resolve_against_the_length() {
        assert_eq!(parse_range("bytes=3-", 10), Ok(Some((3, 9))));
        assert_eq!(parse_range("bytes=0-", 10), Ok(Some((0, 9))));
        assert_eq!(parse_range("bytes=-4", 10), Ok(Some((6, 9))));
        // A suffix longer than the resource is the whole resource.
        assert_eq!(parse_range("bytes=-99", 10), Ok(Some((0, 9))));
    }

    #[test]
    fn whitespace_and_case_are_tolerated_where_the_grammar_allows() {
        assert_eq!(parse_range("BYTES= 2 - 5 ", 10), Ok(Some((2, 5))));
        assert_eq!(parse_range(" bytes =2-", 10), Ok(Some((2, 9))));
    }

    #[test]
    fn an_unknown_unit_is_ignored_rather_than_refused() {
        assert_eq!(parse_range("items=0-1", 10), Ok(None));
        assert_eq!(parse_range("seconds=0-1", 10), Ok(None));
    }

    #[test]
    fn a_multi_range_request_is_refused_not_half_answered() {
        assert_eq!(
            parse_range("bytes=0-1,4-5", 10),
            Err(RangeError::Unsupported)
        );
        assert_eq!(
            parse_range("bytes=0-1, 4-", 10),
            Err(RangeError::Unsupported)
        );
    }

    #[test]
    fn unsatisfiable_ranges_are_separated_from_malformed_ones() {
        assert_eq!(
            parse_range("bytes=10-12", 10),
            Err(RangeError::Unsatisfiable)
        );
        assert_eq!(parse_range("bytes=10-", 10), Err(RangeError::Unsatisfiable));
        assert_eq!(parse_range("bytes=-0", 10), Err(RangeError::Unsatisfiable));
        assert_eq!(parse_range("bytes=0-0", 0), Err(RangeError::Unsatisfiable));
        assert_eq!(parse_range("bytes=-1", 0), Err(RangeError::Unsatisfiable));
    }

    #[test]
    fn malformed_headers_name_themselves() {
        assert_eq!(parse_range("bytes", 10), Err(RangeError::Malformed));
        assert_eq!(parse_range("bytes=", 10), Err(RangeError::Malformed));
        assert_eq!(parse_range("bytes=-", 10), Err(RangeError::Malformed));
        assert_eq!(parse_range("bytes=abc-def", 10), Err(RangeError::Malformed));
        assert_eq!(parse_range("bytes=5-2", 10), Err(RangeError::Malformed));
        assert_eq!(parse_range("bytes=-1.5", 10), Err(RangeError::Malformed));
        assert_eq!(parse_range("bytes=+1-2", 10), Err(RangeError::Malformed));
        assert_eq!(parse_range("bytes=0x1-2", 10), Err(RangeError::Malformed));
        assert_eq!(
            parse_range("bytes=99999999999999999999-", 10),
            Err(RangeError::Malformed)
        );
    }
}
