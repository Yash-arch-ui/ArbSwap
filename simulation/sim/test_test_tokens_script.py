"""S2.3 regression: `scripts/test_tokens.sh` must enforce its per-call mint cap.

The cap check previously used `CAP_TSOL=5_000_000_000`; bash does not accept `_`
in numeric literals, so `(( AMOUNT > CAP ))` errored and the check was silently
bypassed. These tests fail if that regresses.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "test_tokens.sh"
TSOL = "76XvqdSVi2LhYWgeWjx6E1V2c7oBeB6ndUEp6xC44jp2"
TUSDC = "q3xHxvxCBvYCMwuA6dFtTDHHwbqkrruTYWAWXdPuNFX"
OPERATOR = "8R3VDePSxK4iQ5FYvTwfw16D72QWx7qXhZkYvtKGCQSH"
DEVNET = "https://api.devnet.solana.com"


def _fake_spl_token(tmp_path: Path) -> tuple[str, Path]:
    """A PATH entry whose `spl-token` records that it was invoked."""
    bindir = tmp_path / "bin"
    bindir.mkdir()
    marker = tmp_path / "spl-token.called"
    stub = bindir / "spl-token"
    stub.write_text(
        "#!/usr/bin/env bash\n"
        f"touch '{marker}'\n"
        "echo 'Associated token address: ATA1111111111111111111111111111111111111'\n"
    )
    stub.chmod(0o755)
    return f"{bindir}:{os.environ['PATH']}", marker


def _run(args, tmp_path, *, key="$HOME/.config/solana/id.json", url=None):
    path, marker = _fake_spl_token(tmp_path)
    env = {**os.environ, "PATH": path, "ARBSWAP_DEVNET_KEYPAIR": key}
    full = (["--url", url] if url else []) + list(args)
    proc = subprocess.run(["bash", str(SCRIPT), *full], cwd=ROOT, text=True,
                          capture_output=True, env=env)
    return proc, marker


def test_over_cap_is_refused_and_does_not_call_spl_token(tmp_path):
    # 2,000 tSOL = 2e12 atoms, far above the 5 tSOL cap.
    proc, marker = _run([TSOL, str(2_000 * 10**9), OPERATOR], tmp_path)
    assert proc.returncode != 0, proc.stdout
    assert "REFUSED" in proc.stdout
    assert "exceeds" in proc.stdout
    assert not marker.exists(), "spl-token was invoked despite the over-cap amount"


def test_over_cap_quote_is_refused(tmp_path):
    proc, marker = _run([TUSDC, str(219_394_782_200), OPERATOR], tmp_path)
    assert proc.returncode != 0
    assert "REFUSED" in proc.stdout
    assert not marker.exists()


def test_within_cap_proceeds_to_spl_token(tmp_path):
    # 1 tSOL = 1e9 atoms, within the 5 tSOL cap.
    proc, marker = _run([TSOL, str(1 * 10**9), OPERATOR], tmp_path)
    assert marker.exists(), "a within-cap amount should reach spl-token"


def test_non_devnet_url_is_refused(tmp_path):
    proc, marker = _run([TSOL, "1000000000", OPERATOR], tmp_path,
                        url="https://api.mainnet-beta.solana.com")
    assert proc.returncode != 0
    assert "REFUSED" in proc.stdout
    assert not marker.exists()


def test_missing_keypair_env_is_refused(tmp_path):
    proc, marker = _run([TSOL, "1000000000", OPERATOR], tmp_path, key="")
    assert proc.returncode != 0
    assert "REFUSED" in proc.stdout
    assert not marker.exists()
