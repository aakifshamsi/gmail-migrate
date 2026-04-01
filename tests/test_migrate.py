"""
Unit tests for scripts/migrate.py — key safety functions.

No real Gmail credentials or network calls are made; all HTTP is mocked.
"""
import io
import json
import os
import sys
import types
import unittest.mock as mock
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Bootstrap: inject minimal env vars so migrate.py can be imported without
# crashing on missing required os.environ keys.
# ---------------------------------------------------------------------------
_REQUIRED_ENV = {
    "WORKER_URL": "https://worker.example.com",
    "WORKER_AUTH_TOKEN": "test-token",
    "GMAIL_SOURCE_USER": "source@gmail.com",
    "GMAIL_DEST_USER": "dest@gmail.com",
    "GMAIL_DEST_ID": "dest1",
    "MIGRATION_STATE_FILE": "/tmp/test-state.json",
}
for k, v in _REQUIRED_ENV.items():
    os.environ.setdefault(k, v)

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
import migrate  # noqa: E402  (imported after env setup)


# ---------------------------------------------------------------------------
# preflight_check
# ---------------------------------------------------------------------------

class TestPreflightCheck:

    def test_valid_token_and_matching_email(self, mock_urlopen, valid_profile_response):
        mock_urlopen.return_value = valid_profile_response
        # Should not raise or call sys.exit
        migrate.preflight_check("fake-token", "test@gmail.com", "source")

    def test_rejected_token_401_calls_sys_exit(self, mock_urlopen):
        import urllib.error
        mock_urlopen.side_effect = urllib.error.HTTPError(
            "url", 401, "Unauthorized", {}, io.BytesIO(b"")  # type: ignore[arg-type]
        )
        with pytest.raises(SystemExit):
            migrate.preflight_check("bad-token", "test@gmail.com", "source")

    def test_email_mismatch_calls_sys_exit(self, mock_urlopen, mismatched_profile_response):
        mock_urlopen.return_value = mismatched_profile_response
        with pytest.raises(SystemExit):
            migrate.preflight_check("fake-token", "test@gmail.com", "source")

    def test_email_comparison_case_insensitive(self, mock_urlopen):
        """preflight_check should accept emailAddress with different capitalisation."""
        resp_data = {"emailAddress": "TEST@GMAIL.COM"}
        response = mock.MagicMock()
        response.read.return_value = json.dumps(resp_data).encode()
        response.__enter__ = lambda s: s
        response.__exit__ = mock.MagicMock(return_value=False)
        mock_urlopen.return_value = response
        # Should not raise
        migrate.preflight_check("fake-token", "test@gmail.com", "source")

    def test_network_error_calls_sys_exit(self, mock_urlopen):
        mock_urlopen.side_effect = OSError("network unreachable")
        with pytest.raises(SystemExit):
            migrate.preflight_check("fake-token", "test@gmail.com", "source")


# ---------------------------------------------------------------------------
# extract_fingerprint_from_raw
# ---------------------------------------------------------------------------

_SAMPLE_EMAIL = (
    b"Message-ID: <abc123@mail.example.com>\r\n"
    b"Subject: Test email\r\n"
    b"From: Alice <alice@example.com>\r\n"
    b"Date: Mon, 01 Jan 2024 12:00:00 +0000\r\n"
    b"\r\n"
    b"Body text here.\r\n"
)

class TestExtractFingerprintFromRaw:

    def test_extracts_all_fields(self):
        fp = migrate.extract_fingerprint_from_raw(_SAMPLE_EMAIL)
        assert fp["message_id"] == "<abc123@mail.example.com>"
        assert fp["subject"] == "Test email"
        assert fp["from"] == "Alice <alice@example.com>"
        assert fp["date"] == "Mon, 01 Jan 2024 12:00:00 +0000"

    def test_empty_bytes_returns_empty_fields(self):
        fp = migrate.extract_fingerprint_from_raw(b"")
        assert fp["message_id"] == ""
        assert fp["subject"] == ""

    def test_missing_headers_return_empty_string(self):
        fp = migrate.extract_fingerprint_from_raw(b"From: bob@example.com\r\n\r\n")
        assert fp["message_id"] == ""
        assert fp["subject"] == ""
        assert fp["from"] == "bob@example.com"


# ---------------------------------------------------------------------------
# record_migrated_message
# ---------------------------------------------------------------------------

class TestRecordMigratedMessage:

    def test_records_fingerprint_in_state(self):
        state = {"migrated_messages": {}}
        migrate.record_migrated_message(state, "src-id-001", _SAMPLE_EMAIL)
        assert "src-id-001" in state["migrated_messages"]
        fp = state["migrated_messages"]["src-id-001"]
        assert fp["message_id"] == "<abc123@mail.example.com>"

    def test_initialises_migrated_messages_if_missing(self):
        state = {}
        migrate.record_migrated_message(state, "src-id-002", _SAMPLE_EMAIL)
        assert "src-id-002" in state.get("migrated_messages", {})
