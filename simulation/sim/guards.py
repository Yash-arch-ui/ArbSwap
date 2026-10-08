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
