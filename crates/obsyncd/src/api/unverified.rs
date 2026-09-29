//! What a caller sent before its credential verified, sealed with the
//! reservation that accounts for it (reviews of 7e1294d and 77660fb).
//!
//! The whole pre-authentication budget lives here, private: the count, a
//! reservation, and the one read that takes both. A handler gets a body only
//! as [`Unverified`] from [`read_body`] or [`token_body`], and reaches it
//! only through [`Unverified::accept`], which runs the credential check with
//! the reservation held and releases it only after. The check is lent a
//! [`Held`], and the credential checks that run inside `accept` take one, so
//! moving such a check out of `accept`, or sealing a value again under a new
//! reservation, does not compile.
#![forbid(unsafe_code)]

use std::io::ErrorKind;
use std::sync::atomic::{AtomicU64, Ordering};

use obsync_core::http::Request;
use obsync_core::json::Value;

use crate::log::Val;

use super::render;
use super::{ApiError, App, PREAUTH_BODY_BUDGET, TOKEN_BODY_LIMIT, TOKEN_BODY_RESERVE};

/// The body bytes reserved against [`PREAUTH_BODY_BUDGET`] right now.
#[derive(Default)]
pub struct BodyBudget {
    held: AtomicU64,
    /// What was held when a setup token was last compared: the setup route's
    /// lifetime regression reads it (review of 77660fb).
    #[cfg(test)]
    pub(super) at_token_check: AtomicU64,
}

impl BodyBudget {
    /// Reserve `bytes`, or say how many are held when they do not fit.
    fn reserve(&self, bytes: u64) -> Result<Reserved<'_>, u64> {
        let fits = |held: u64| {
            held.checked_add(bytes)
                .filter(|total| *total <= PREAUTH_BODY_BUDGET)
        };
        self.held
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, fits)
            .map(|_| Reserved {
                budget: self,
                bytes,
            })
    }

    /// Body bytes reserved right now, for the tests that pin the ceiling.
    #[cfg(test)]
    pub fn held(&self) -> u64 {
        self.held.load(Ordering::SeqCst)
    }
}

/// One read's reservation against the budget, given back when the read that
/// needed it ends, however it ends.
struct Reserved<'a> {
    budget: &'a BodyBudget,
    bytes: u64,
}

impl Drop for Reserved<'_> {
    fn drop(&mut self) {
        self.budget.held.fetch_sub(self.bytes, Ordering::SeqCst);
    }
}

/// A body, or what it parses to, and the reservation that accounts for it.
pub struct Unverified<'a, T> {
    value: T,
    reserved: Reserved<'a>,
}

/// Lent to the check [`Unverified::accept`] runs, for as long as it runs. A
/// credential check that takes `&Held` can run only there, with the body
/// still reserved: only `accept` makes one, and the check cannot keep it.
pub struct Held(());

/// For the unit tests of a credential check's own logic, which run without a
/// body. It exists in test builds only, so no handler can use it: a build of
/// the server that named it would not compile.
#[cfg(test)]
pub(super) const HELD_FOR_TESTS: Held = Held(());

impl<T> Unverified<'_, T> {
    /// Run `check` with the reservation held, and hand back the value with
    /// what the check found only if it passed. The reservation ends after
    /// the check, either way.
    ///
    /// # Errors
    /// Whatever `check` refuses with.
    pub fn accept<R>(
        self,
        check: impl FnOnce(&T, &Held) -> Result<R, ApiError>,
    ) -> Result<(T, R), ApiError> {
        let found = check(&self.value, &Held(()))?;
        let Self { value, reserved } = self;
        drop(reserved);
        Ok((value, found))
    }
}

/// Read a request body under an explicit ceiling.
///
/// Every caller reads its body before a credential has verified, so the read
/// holds a reservation against [`PREAUTH_BODY_BUDGET`], and the body comes
/// back [`Unverified`]: the reservation ends only when the caller's
/// credential check has passed or failed. A chunked body's length is unknown
/// until it ends, so it reserves the ceiling.
///
/// # Errors
/// `413 body_too_large` above the ceiling, `503 slow_body` for a body slower
/// than the rate floor, `503 body_incomplete` for one that ended or broke
/// before it was whole, `400 bad_request` for a chunked body whose framing is
/// not HTTP, and a bare `503` when the budget has no room for this body.
pub fn read_body<'a>(
    app: &'a App,
    req: &mut Request,
    limit: u64,
) -> Result<Unverified<'a, Vec<u8>>, ApiError> {
    read(app, req, limit, None)
}

/// Read and parse a body whose credential rides inside it (setup, pairing
/// claim), under [`TOKEN_BODY_LIMIT`].
///
/// The reservation covers the body AND its parse ([`TOKEN_BODY_RESERVE`]),
/// and it stays with the value until the token verifies, so what an
/// unverified caller makes this process keep, waiting included, stays inside
/// [`PREAUTH_BODY_BUDGET`].
///
/// # Errors
/// As [`read_body`], and `400 bad_json` when the body does not parse.
pub fn token_body<'a>(app: &'a App, req: &mut Request) -> Result<Unverified<'a, Value>, ApiError> {
    let Unverified { value, reserved } =
        read(app, req, TOKEN_BODY_LIMIT, Some(TOKEN_BODY_RESERVE))?;
    Ok(Unverified {
        value: render::parse_json(&value)?,
        reserved,
    })
}

/// [`read_body`], reserving `reserve` bytes, or the body's declared length
/// when `None`.
fn read<'a>(
    app: &'a App,
    req: &mut Request,
    limit: u64,
    reserve: Option<u64>,
) -> Result<Unverified<'a, Vec<u8>>, ApiError> {
    let declared = req.body.declared_len();
    if let Some(declared) = declared
        && declared > limit
    {
        return Err(ApiError::new(
            413,
            "body_too_large",
            "request body exceeds the limit",
        ));
    }
    let bytes = reserve.unwrap_or(declared.unwrap_or(limit));
    let reserved = app.bodies.reserve(bytes).map_err(|held| {
        app.log.warn(
            "preauth_body",
            &[
                ("decision", Val::word("refused")),
                ("bytes", Val::bytes(bytes)),
                ("held", Val::bytes(held)),
                ("budget", Val::bytes(PREAUTH_BODY_BUDGET)),
            ],
        );
        ApiError::new(
            503,
            "preauth_budget_full",
            "unverified request bodies are at their ceiling; retry shortly",
        )
        .bare()
    })?;
    match req.body.read_to_vec(limit as usize) {
        Ok(value) => Ok(Unverified { value, reserved }),
        Err(e) if e.kind() == ErrorKind::TimedOut => Err(render::slow_body(app, &req.body)),
        // The body refuses its ceiling once more than `limit` bytes of it
        // have arrived, and only then; the same kind below that is framing.
        Err(e) if e.kind() == ErrorKind::InvalidData && req.body.received() > limit => Err(
            ApiError::new(413, "body_too_large", "request body exceeds the limit"),
        ),
        Err(e) if e.kind() == ErrorKind::InvalidData => Err(ApiError::bad_request(
            "the chunked request body is not framed as HTTP",
        )),
        Err(e) => Err(render::incomplete_body(app, &req.body, &e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Review of c5f79e8, finding 2: an unverified body's reservation ends
    /// only after its check, whether the check passes or refuses. `accept`
    /// is the one way a body leaves `Unverified`, so this is every route's
    /// guarantee.
    #[test]
    fn an_unverified_body_stays_reserved_until_its_check_has_run() {
        let budget = BodyBudget::default();
        let sealed = || Unverified {
            value: 7u8,
            reserved: budget.reserve(1000).expect("fits"),
        };
        let (value, seen) = sealed()
            .accept(|value, _| Ok((*value, budget.held())))
            .expect("passes");
        assert_eq!((value, seen), (7, (7, 1000)), "reserved while checked");
        assert_eq!(budget.held(), 0, "and given back after");
        let refused = sealed().accept(|_, _| -> Result<(), ApiError> {
            assert_eq!(budget.held(), 1000, "reserved while refused");
            Err(ApiError::bad_request("refused"))
        });
        assert!(refused.is_err());
        assert_eq!(budget.held(), 0, "and given back after a refusal");
    }
}
