"""Optional username/password login for the web app.

Enabled by setting both AUTH_USERNAME and AUTH_PASSWORD; empty (the default)
leaves the app open, unchanged. On a successful login the server sets a
signed, expiring HttpOnly cookie. The signing key is derived from the
credentials themselves, so changing them invalidates every outstanding
session without any server-side state.
"""

import hashlib
import hmac
import time

from config import AUTH_PASSWORD, AUTH_TTL_HOURS, AUTH_USERNAME

COOKIE_NAME = "asr_auth"


def enabled() -> bool:
    """Login is required only when both credentials are configured."""
    return bool(AUTH_USERNAME and AUTH_PASSWORD)


def _key() -> bytes:
    return hashlib.sha256(
        f"asr-auth|{AUTH_USERNAME}|{AUTH_PASSWORD}".encode()).digest()


def _sign(expiry: str) -> str:
    return hmac.new(_key(), expiry.encode(), hashlib.sha256).hexdigest()


def check_credentials(username: str, password: str) -> bool:
    """Constant-time comparison of both fields (no early exit on username)."""
    user_ok = hmac.compare_digest(username.encode(), AUTH_USERNAME.encode())
    pass_ok = hmac.compare_digest(password.encode(), AUTH_PASSWORD.encode())
    return user_ok and pass_ok


def mint_token() -> str:
    """Cookie value: "<unix expiry>.<hmac of that expiry>"."""
    expiry = str(int(time.time() + AUTH_TTL_HOURS * 3600))
    return f"{expiry}.{_sign(expiry)}"


def token_valid(token: str) -> bool:
    expiry, _, sig = (token or "").partition(".")
    if not expiry.isdigit() or not sig:
        return False
    if int(expiry) < time.time():
        return False
    return hmac.compare_digest(sig, _sign(expiry))


def cookie_max_age() -> int:
    return int(AUTH_TTL_HOURS * 3600)
