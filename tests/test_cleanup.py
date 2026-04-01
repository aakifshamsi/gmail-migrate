"""
Unit tests for scripts/cleanup.py — manifest intersection, fingerprint matching,
and trash safety logic.

No real Gmail credentials or network calls are made; all HTTP is mocked.
"""
import json
import os
import sys
import tempfile
import unittest.mock as mock
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Bootstrap: inject minimal env vars required by cleanup.py on import.
# ---------------------------------------------------------------------------
_REQUIRED_ENV = {
    "WORKER_URL": "https://worker.example.com",
    "WORKER_AUTH_TOKEN": "test-token",
    "GMAIL_SOURCE_USER": "source@gmail.com",
    "GMAIL_DEST1_USER": "dest1@gmail.com",
    "GMAIL_DEST2_USER": "dest2@gmail.com",
    "CLEANUP_STATE_FILES": "migration-state-dest1.json,migration-state-dest2.json",
    "GMAIL_DEST_USERS": "dest1@gmail.com,dest2@gmail.com",
    "DESTINATION": "both",
}
for k, v in _REQUIRED_ENV.items():
    os.environ.setdefault(k, v)

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
import cleanup  # noqa: E402


# ---------------------------------------------------------------------------
# fingerprint_matches
# ---------------------------------------------------------------------------

class TestFingerprintMatches:

    _BASE = {
        "message_id": "<abc@example.com>",
        "subject": "Hello",
        "from": "alice@example.com",
        "date": "Mon, 01 Jan 2024 00:00:00 +0000",
    }

    def test_exact_match_returns_true(self):
        assert cleanup.fingerprint_matches(self._BASE, dict(self._BASE)) is True

    def test_message_id_mismatch_returns_false(self):
        other = {**self._BASE, "message_id": "<different@example.com>"}
        assert cleanup.fingerprint_matches(self._BASE, other) is False

    def test_subject_mismatch_returns_false(self):
        other = {**self._BASE, "subject": "Different subject"}
        assert cleanup.fingerprint_matches(self._BASE, other) is False

    def test_from_mismatch_returns_false(self):
        other = {**self._BASE, "from": "bob@example.com"}
        assert cleanup.fingerprint_matches(self._BASE, other) is False

    def test_date_mismatch_returns_false(self):
        other = {**self._BASE, "date": "Tue, 02 Jan 2024 00:00:00 +0000"}
        assert cleanup.fingerprint_matches(self._BASE, other) is False

    def test_empty_message_id_both_returns_true(self):
        """Two messages with empty Message-ID still match on other fields."""
        fp = {**self._BASE, "message_id": ""}
        assert cleanup.fingerprint_matches(fp, fp) is True


# ---------------------------------------------------------------------------
# load_cleanup_candidates
# ---------------------------------------------------------------------------

_MSG_1 = {"message_id": "<m1@x.com>", "subject": "Msg1", "from": "a@b.com", "date": "d1"}
_MSG_2 = {"message_id": "<m2@x.com>", "subject": "Msg2", "from": "a@b.com", "date": "d2"}
_MSG_3 = {"message_id": "<m3@x.com>", "subject": "Msg3", "from": "a@b.com", "date": "d3"}


def _write_state(path: Path, dest: str, migrated: dict) -> None:
    data = {
        "destination": dest,
        "migrated_messages": migrated,
    }
    path.write_text(json.dumps(data))


class TestLoadCleanupCandidates:

    def test_intersection_returns_only_common_ids(self, tmp_path, monkeypatch):
        dest1 = tmp_path / "migration-state-dest1.json"
        dest2 = tmp_path / "migration-state-dest2.json"
        _write_state(dest1, "dest1", {"id1": _MSG_1, "id2": _MSG_2})
        _write_state(dest2, "dest2", {"id2": _MSG_2, "id3": _MSG_3})

        monkeypatch.setattr(
            cleanup, "CLEANUP_STATE_FILES",
            f"{dest1},{dest2}"
        )
        result = cleanup.load_cleanup_candidates({"dest1", "dest2"})
        assert set(result.keys()) == {"id2"}, "Only id2 appears in both files"

    def test_empty_migrated_messages_returns_empty(self, tmp_path, monkeypatch):
        dest1 = tmp_path / "migration-state-dest1.json"
        dest2 = tmp_path / "migration-state-dest2.json"
        _write_state(dest1, "dest1", {})
        _write_state(dest2, "dest2", {"id1": _MSG_1})

        monkeypatch.setattr(
            cleanup, "CLEANUP_STATE_FILES",
            f"{dest1},{dest2}"
        )
        result = cleanup.load_cleanup_candidates({"dest1", "dest2"})
        assert result == {}

    def test_missing_state_file_returns_empty(self, tmp_path, monkeypatch):
        """If one required state file is missing, candidates are empty."""
        dest1 = tmp_path / "migration-state-dest1.json"
        _write_state(dest1, "dest1", {"id1": _MSG_1})
        # dest2 file intentionally not created

        monkeypatch.setattr(
            cleanup, "CLEANUP_STATE_FILES",
            f"{dest1},{tmp_path / 'migration-state-dest2.json'}"
        )
        result = cleanup.load_cleanup_candidates({"dest1", "dest2"})
        assert result == {}

    def test_single_destination_not_requiring_both(self, tmp_path, monkeypatch):
        dest1 = tmp_path / "migration-state-dest1.json"
        _write_state(dest1, "dest1", {"id1": _MSG_1, "id2": _MSG_2})

        monkeypatch.setattr(cleanup, "CLEANUP_STATE_FILES", str(dest1))
        result = cleanup.load_cleanup_candidates({"dest1"})
        assert set(result.keys()) == {"id1", "id2"}


# ---------------------------------------------------------------------------
# trash_message (mocked gmail_post)
# ---------------------------------------------------------------------------

class TestTrashMessage:

    def test_returns_true_on_success(self):
        with mock.patch.object(cleanup, "gmail_post", return_value={}) as mock_post:
            result = cleanup.trash_message("fake-token", "msg-id-001")
        assert result is True
        mock_post.assert_called_once()

    def test_returns_false_on_runtime_error(self):
        with mock.patch.object(cleanup, "gmail_post", side_effect=RuntimeError("403")) as _:
            result = cleanup.trash_message("fake-token", "msg-id-002")
        assert result is False
