"""NIM session config and transcript-event parsing helpers."""

from urllib.parse import urlencode

from config import (ASR_LANGUAGE, ASR_MODEL, AUTO_PUNCT, DIARIZATION,
                    ENDPOINTING, EOU_START_HISTORY, EOU_START_THRESHOLD,
                    EOU_STOP_HISTORY, EOU_STOP_HISTORY_EOU,
                    EOU_STOP_THRESHOLD, EOU_STOP_THRESHOLD_EOU,
                    MAX_SPEAKERS, NIM_HOST, NIM_INTENT, NIM_PATH, NIM_PORT,
                    NIM_SCHEME, SAMPLE_RATE)


def nim_url() -> str:
    """Build the NIM realtime WebSocket URL, e.g.
    ws://host:9000/v1/realtime?intent=transcription&model=..."""
    query = {"intent": NIM_INTENT}
    if ASR_MODEL:
        query["model"] = ASR_MODEL
    return f"{NIM_SCHEME}://{NIM_HOST}:{NIM_PORT}{NIM_PATH}?{urlencode(query)}"


def _bool_param(qp, key, default: bool) -> bool:
    v = qp.get(key)
    if v is None:
        return default
    return str(v).lower() in ("1", "true", "yes", "on")


def session_opts(qp) -> dict:
    """Per-connection ASR settings: query-param overrides from the browser
    merged over the server env defaults, validated/clamped. `qp` is the
    WebSocket query params (Starlette QueryParams / dict-like)."""
    max_sp = MAX_SPEAKERS
    raw = qp.get("max_speakers")
    if raw is not None:
        try:
            max_sp = int(float(raw))
        except (TypeError, ValueError):
            pass
    return {
        "diarization": _bool_param(qp, "diarization", DIARIZATION),
        "max_speakers": max(1, min(8, max_sp)),
        "auto_punct": _bool_param(qp, "punct", AUTO_PUNCT),
        "endpointing": _bool_param(qp, "endpointing", ENDPOINTING),
        # Background analyzers for this session. Default on when the param is
        # absent (the app and older pages keep their behavior); the SDK sends
        # analyzers=0 unless the consumer opts in, so embedded pages don't
        # silently trigger server-side LLM calls.
        "analyzers": _bool_param(qp, "analyzers", True),
    }


def session_update_event(opts: dict) -> dict:
    """The first event we send after connecting: configures the transcription
    session. `opts` (from session_opts) carries the per-connection settings;
    model/language/sample-rate and endpointing thresholds stay server-side."""
    session = {
        "input_audio_format": "pcm16",
        "input_audio_transcription": {
            "language": ASR_LANGUAGE,
        },
        "input_audio_params": {
            "sample_rate_hz": SAMPLE_RATE,
            "num_channels": 1,
        },
        "recognition_config": {
            "max_alternatives": 1,
            "enable_automatic_punctuation": opts["auto_punct"],
            "enable_word_time_offsets": opts["diarization"],
            "enable_profanity_filter": False,
        },
    }
    if ASR_MODEL:
        session["input_audio_transcription"]["model"] = ASR_MODEL
    if opts["diarization"]:
        session["speaker_diarization"] = {
            "enable_speaker_diarization": True,
            "max_speaker_count": opts["max_speakers"],
        }
    if opts["endpointing"]:
        session["endpointing_config"] = {
            "start_history": EOU_START_HISTORY,
            "start_threshold": EOU_START_THRESHOLD,
            "stop_history": EOU_STOP_HISTORY,
            "stop_threshold": EOU_STOP_THRESHOLD,
            "stop_history_eou": EOU_STOP_HISTORY_EOU,
            "stop_threshold_eou": EOU_STOP_THRESHOLD_EOU,
        }
    return {"type": "transcription_session.update", "session": session}


_SPEAKER_KEYS = ("speaker", "speaker_tag", "speaker_id", "speaker_label")
_WORD_TEXT_KEYS = ("word", "text", "value")


def _words(evt: dict) -> list:
    """The per-word list from a completed event (shape varies by NIM version)."""
    wi = evt.get("words_info")
    if isinstance(wi, dict) and wi.get("words"):
        return wi["words"]
    return evt.get("words") or []


def _word_speaker(w: dict):
    for k in _SPEAKER_KEYS:
        v = w.get(k)
        if v not in (None, "", -1):
            return str(v)
    return None


def _word_text(w: dict) -> str:
    for k in _WORD_TEXT_KEYS:
        v = w.get(k)
        if isinstance(v, str) and v:
            return v
    return ""


def _extract_speaker(evt: dict):
    """Best-effort pull of a single speaker label from a completed event."""
    for w in _words(evt):
        if isinstance(w, dict):
            sp = _word_speaker(w)
            if sp is not None:
                return sp
    for k in _SPEAKER_KEYS:
        v = evt.get(k)
        if v not in (None, "", -1):
            return str(v)
    return None


def _speaker_segments(evt: dict):
    """Split a completed event into [(speaker|None, text), ...] at per-word
    speaker changes, so a single utterance spanning two speakers becomes two
    labeled lines. Falls back to the whole transcript (one speaker) when there
    are no usable per-word speaker tags — keeping the nicely punctuated text."""
    transcript = (evt.get("transcript") or "").strip()
    tagged = []
    for w in _words(evt):
        if isinstance(w, dict):
            wt = _word_text(w)
            if wt:
                tagged.append((_word_speaker(w), wt))
    distinct = {sp for sp, _ in tagged if sp is not None}
    # No per-word tags, or a single speaker: keep the clean transcript string.
    if len(distinct) <= 1:
        only = next(iter(distinct), None) if distinct else _extract_speaker(evt)
        return [(only, transcript)] if transcript else []
    # Speaker changes within the utterance: group consecutive words by speaker.
    groups = []
    for sp, wt in tagged:
        if groups and groups[-1][0] == sp:
            groups[-1][1].append(wt)
        else:
            groups.append([sp, [wt]])
    return [(sp, " ".join(ws).strip()) for sp, ws in groups if " ".join(ws).strip()]
