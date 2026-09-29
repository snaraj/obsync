//! What a caller sent before its credential verified, sealed with the
//! reservation that accounts for it (reviews of 7e1294d and 77660fb).
//!
//! The whole pre-authentication budget lives here, private: the count, a
//! reservation, and the one read that takes both. A handler gets a body only
//! as [`Unverified`] from [`read_body`] or [`token_body`], and reaches it
//! only through [`Unverified::accept`], which runs the credential check with
//! the reservation held and releases it only after. The check is lent the
//! value as a [`Held`]; a token body is parsed only through [`Held::json`],
//! and a credential read only from what that parsed ([`Credential`]), so a
//! check reads the credential of the very body whose reservation is held.
//! Moving a check out of `accept`, sealing a value again, or checking a
//! credential from a body parsed anywhere else, does not compile (reviews of
//! 77660fb and 0bf6a62).
#![forbid(unsafe_code)]

use std::io::ErrorKind;
use std::sync::atomic::{AtomicU64, Ordering};

use std::marker::PhantomData;

use obsync_core::http::{Body, Request};
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

/// The value [`Unverified::accept`] lends its check, for as long as it runs:
/// only `accept` makes one, and the check cannot keep it.
pub struct Held<'v, T>(&'v T);

impl<'v, T> Held<'v, T> {
    /// The value being checked.
    pub fn value(&self) -> &'v T {
        self.0
    }
}

impl<'v> Held<'v, Vec<u8>> {
    /// Parse the held body, under its reservation. Nothing else makes a
    /// [`Parsed`], so a credential read from one came from this body.
    ///
    /// # Errors
    /// `400 bad_json` when the body does not parse.
    pub fn json(&self) -> Result<Parsed<'v>, ApiError> {
        Ok(Parsed {
            value: render::parse_json(self.0)?,
            held: PhantomData,
        })
    }
}

/// A token body parsed by [`Held::json`], inside `accept`.
pub struct Parsed<'v> {
    value: Value,
    held: PhantomData<&'v ()>,
}

impl Parsed<'_> {
    /// What the body parsed to.
    pub fn value(&self) -> &Value {
        &self.value
    }

    /// The credential in `field`. Credential checks take a [`Credential`] and
    /// only this makes one, so a check reads the credential of the body whose
    /// reservation is held, and no other.
    ///
    /// # Errors
    /// `400 bad_request` when the field is missing or not a string.
    pub fn credential(&self, field: &str) -> Result<Credential<'_>, ApiError> {
        render::field_str(&self.value, field).map(Credential)
    }

    /// The parsed body, to keep once its check has passed.
    pub fn into_value(self) -> Value {
        self.value
    }
}

/// A credential read from a body parsed under its reservation.
pub struct Credential<'p>(&'p str);

impl Credential<'_> {
    /// The credential's text.
    pub fn as_str(&self) -> &str {
        self.0
    }
}

#[cfg(test)]
impl<'p> Credential<'p> {
    /// For the unit tests of a credential check's own logic, which run without
    /// a body. It exists in test builds only: a build of the server that named
    /// it would not compile.
    pub(super) fn for_tests(token: &'p str) -> Self {
        Self(token)
    }
}

impl<T> Unverified<'_, T> {
    /// Run `check` with the reservation held, and hand back the value with
    /// what the check found only if it passed. The reservation ends after
    /// the check, either way.
    ///
    /// # Errors
    /// Whatever `check` refuses with.
    pub fn accept<R>(
        self,
        check: impl FnOnce(Held<'_, T>) -> Result<R, ApiError>,
    ) -> Result<(T, R), ApiError> {
        let found = check(Held(&self.value))?;
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
    read(app, &mut req.body, limit, None)
}

/// Read a body whose credential rides inside it (setup, pairing claim),
/// under [`TOKEN_BODY_LIMIT`].
///
/// The reservation covers the body AND its parse ([`TOKEN_BODY_RESERVE`]).
/// The caller parses it with [`Held::json`], inside [`Unverified::accept`],
/// the one place it can reach the bytes, so the parse runs with the
/// reservation held (reviews of c78ef46 and 0bf6a62), and what an unverified
/// caller makes this process keep, waiting included, stays inside
/// [`PREAUTH_BODY_BUDGET`].
///
/// # Errors
/// As [`read_body`].
pub fn token_body<'a>(
    app: &'a App,
    req: &mut Request,
) -> Result<Unverified<'a, Vec<u8>>, ApiError> {
    read(
        app,
        &mut req.body,
        TOKEN_BODY_LIMIT,
        Some(TOKEN_BODY_RESERVE),
    )
}

/// [`read_body`], reserving `reserve` bytes, or the body's declared length
/// when `None`.
fn read<'a>(
    app: &'a App,
    body: &mut Body,
    limit: u64,
    reserve: Option<u64>,
) -> Result<Unverified<'a, Vec<u8>>, ApiError> {
    let declared = body.declared_len();
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
    match body.read_to_vec(limit as usize) {
        Ok(value) => Ok(Unverified { value, reserved }),
        Err(e) if e.kind() == ErrorKind::TimedOut => Err(render::slow_body(app, body)),
        // The body refuses its ceiling once more than `limit` bytes of it
        // have arrived, and only then; the same kind below that is framing.
        Err(e) if e.kind() == ErrorKind::InvalidData && body.received() > limit => Err(
            ApiError::new(413, "body_too_large", "request body exceeds the limit"),
        ),
        Err(e) if e.kind() == ErrorKind::InvalidData => Err(ApiError::bad_request(
            "the chunked request body is not framed as HTTP",
        )),
        Err(e) => Err(render::incomplete_body(app, body, &e)),
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
            .accept(|held| Ok((*held.value(), budget.held())))
            .expect("passes");
        assert_eq!((value, seen), (7, (7, 1000)), "reserved while checked");
        assert_eq!(budget.held(), 0, "and given back after");
        let refused = sealed().accept(|_| -> Result<(), ApiError> {
            assert_eq!(budget.held(), 1000, "reserved while refused");
            Err(ApiError::bad_request("refused"))
        });
        assert!(refused.is_err());
        assert_eq!(budget.held(), 0, "and given back after a refusal");
    }
}
