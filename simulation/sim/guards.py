"""Simulator sanity guards (Amendment 1, contamination cleanup).

Every venue's initial price must equal the first oracle price; reserves must be
non-negative. These run at venue construction and in tests so a price-150-style
initialization bug cannot silently contaminate results again.
"""

from __future__ import annotations


def assert_initial_price(venue, start_price: float, *, tol: float = 1e-9) -> None:
    base = getattr(venue, "base", None)
    quote = getattr(venue, "quote", None)
    if base is None or quote is None:
        return
    assert base > 0 and quote >= 0, f"bad reserves base={base} quote={quote}"
    price = quote / base
    rel = abs(price - start_price) / start_price
    assert rel <= tol, (
        f"venue initial price {price} != oracle {start_price} (rel {rel:.2e}); "
        "pools must be priced at the path start"
    )


def assert_sane(venue) -> None:
    base = getattr(venue, "base", None)
    quote = getattr(venue, "quote", None)
    if base is not None:
        assert base >= -1e-9, f"negative base reserve {base}"
    if quote is not None:
        assert quote >= -1e-9, f"negative quote reserve {quote}"
    if base is not None and quote is not None:
        assert base == base and quote == quote, "reserve is NaN"
        assert abs(base) < 1e300 and abs(quote) < 1e300, "reserve overflow"


def assert_price_within_band(price: float, oracle_price: float, *, max_rel_dev: float) -> None:
    """Runtime guard: a quoted/reference price must stay within a band of the
    oracle. A price-150-vs-100 initialization bug (or any gross contamination)
    drifts the venue far from the oracle and trips this. Callers pass the
    venue's *quoted* price (the reservation for the vault; the reserve ratio for
    a passive pool) and the band appropriate to the venue.
    """
    if price <= 0 or oracle_price <= 0:
        return
    rel = abs(price - oracle_price) / oracle_price
    assert rel <= max_rel_dev, (
        f"venue price {price} deviates {rel:.1%} from oracle {oracle_price}; "
        "contamination or a broken fill"
    )


def assert_conservation(venue, initial_base: float, initial_quote: float, trades,
                        gas_quote: float = 0.0, *, tol: float = 1e-6) -> None:
    """Runtime guard: reserves change only by trade flows and debited gas.

    For each fill the vault receives/pays the trade's quote and base amounts;
    the only other debit is the keeper gas the vault pays. Reconstructing the
    reserves from the trade log must match the venue's reserves, so a fill that
    silently creates or destroys tokens is caught.
    """
    exp_base = initial_base
    exp_quote = initial_quote
    for trade in trades:
        base_amt = abs(trade.base_amount)
        quote_amt = abs(trade.quote_amount)
        if trade.trader_side == "buy":
            exp_quote += quote_amt
            exp_base -= base_amt
        else:
            exp_quote -= quote_amt
            exp_base += base_amt
    exp_quote -= gas_quote
    scale = max(1.0, abs(initial_base), abs(initial_quote))
    assert abs(venue.base - exp_base) <= tol * scale, (
        f"base not conserved: venue {venue.base} vs reconstructed {exp_base}"
    )
    assert abs(venue.quote - exp_quote) <= tol * scale, (
        f"quote not conserved: venue {venue.quote} vs reconstructed {exp_quote}"
    )
