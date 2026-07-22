"""Background-analyzer registry: validation, load/save, live access."""

import json

from config import ANALYZERS_CONFIG, log

_analyzers: list = []


MAX_ANALYZERS = 5
ANALYZER_MODES = ("interval", "chain", "on_stop")


def get_all() -> list:
    """The current analyzer registry (re-read by callers each use)."""
    return _analyzers


def replace(new: list) -> None:
    """Swap in a new registry (validated by the caller)."""
    global _analyzers
    _analyzers = new


def _validate_analyzers(items) -> list:
    """Normalize and validate an analyzer list; raises ValueError on bad input.

    Schedule modes:
      interval -- runs every `interval_min` minutes
      chain    -- runs right after the previous analyzer in the list has run,
                  receiving that analyzer's output as extra context
      on_stop  -- runs once when the recording is stopped (end of meeting)
    """
    if not isinstance(items, list):
        raise ValueError("analyzers must be a list")
    if len(items) > MAX_ANALYZERS:
        raise ValueError(f"at most {MAX_ANALYZERS} analyzers are allowed")
    out, seen = [], set()
    for idx, it in enumerate(items):
        if not isinstance(it, dict):
            raise ValueError("each analyzer must be an object")
        aid = str(it.get("id", "")).strip()
        name = str(it.get("name", "")).strip()
        prompt = str(it.get("prompt", "")).strip()
        if not aid or not name or not prompt:
            raise ValueError("id, name, and prompt are required")
        if aid in seen:
            raise ValueError(f"duplicate analyzer id: {aid}")
        seen.add(aid)
        mode = str(it.get("mode", "interval")).strip()
        if mode not in ANALYZER_MODES:
            raise ValueError(f"invalid mode {mode!r} (use interval, chain, or on_stop)")
        if mode == "chain" and idx == 0:
            raise ValueError("the first analyzer cannot be 'after previous' (nothing before it)")
        # Back-compat: accept old interval_sec configs.
        interval_min = it.get("interval_min")
        if interval_min is None and it.get("interval_sec") is not None:
            interval_min = float(it["interval_sec"]) / 60
        out.append({
            "id": aid,
            "name": name,
            "prompt": prompt,
            "mode": mode,
            "interval_min": max(1, int(float(interval_min or 5))),
            "enabled": bool(it.get("enabled", True)),
        })
    return out


def load_analyzers() -> None:
    global _analyzers
    try:
        with open(ANALYZERS_CONFIG, encoding="utf-8") as f:
            _analyzers = _validate_analyzers(json.load(f))
        log.info("Loaded %d analyzer(s) from %s", len(_analyzers), ANALYZERS_CONFIG)
    except FileNotFoundError:
        _analyzers = []
        log.info("No analyzer config at %s; analyzers disabled", ANALYZERS_CONFIG)
    except (json.JSONDecodeError, ValueError) as exc:
        _analyzers = []
        log.warning("Ignoring invalid analyzer config %s: %s", ANALYZERS_CONFIG, exc)


def save_analyzers() -> bool:
    """Best-effort persist of the current analyzers back to the config file."""
    try:
        with open(ANALYZERS_CONFIG, "w", encoding="utf-8") as f:
            json.dump(_analyzers, f, indent=2)
            f.write("\n")
        return True
    except OSError as exc:
        log.warning("Could not persist analyzers to %s: %s", ANALYZERS_CONFIG, exc)
        return False


load_analyzers()
