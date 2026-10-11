"""Key-free build experiment; restore every Stage 1 manifest before native tests."""
import os
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[1] / "stage1" / "solana"
arch = os.environ.get("SOLANA_ARCH", "v0")
if arch not in ("v0", "v2"):
    raise SystemExit("Only reviewed SBF v0/v2 targets are supported.")
cdylib_only = os.environ.get("SOLANA_CDYLIB_ONLY", "false")
if cdylib_only not in ("true", "false"):
    raise SystemExit("Invalid crate-output selection.")

for program in ("merces_registry", "merces_hook", "merces_protocol", "mock_usdg_hook"):
    manifest = root / "programs" / program / "Cargo.toml"
    original = manifest.read_bytes()
    mixed = b'crate-type = ["cdylib", "lib"]'
    try:
        if cdylib_only == "true":
            if original.count(mixed) != 1:
                raise SystemExit("Pinned crate-type declaration changed; review before building.")
            # Only the current executable target changes; dependencies retain their Rust libraries.
            manifest.write_bytes(original.replace(mixed, b'crate-type = ["cdylib"]'))
        subprocess.run([
            "cargo-build-sbf", "--manifest-path", str(manifest),
            "--tools-version", "v1.52", "--arch", arch,
            "--sbf-out-dir", "target/deploy",
        ], cwd=root, check=True)
    finally:
        manifest.write_bytes(original)

# Do not let a build experiment silently modify the contract checkout.
subprocess.run(["git", "diff", "--exit-code"], cwd=root, check=True)
