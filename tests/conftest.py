"""
Shared fixtures for gmail-migrate pytest suite.

All HTTP calls (urllib.request.urlopen) are mocked — no real Gmail
credentials or network access required.
"""
import io
import json
import sys
import types
import unittest.mock as mock
from pathlib import Path

import pytest

# ── helpers ──────────────────────────────────────────────────────────────────

class FakeHTTPResponse:
    """Minimal mock for urllib.request.urlopen response context manager."""

    def __init__(self, body: bytes, status: int = 200):
        self._body = body
        self.status = status

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass


def make_json_response(data: dict | list, status: int = 200) -> FakeHTTPResponse:
    return FakeHTTPResponse(json.dumps(data).encode(), status)


def make_http_error(code: int, reason: str = "Error") -> Exception:
    """Create a urllib.error.HTTPError matching the given status code."""
    import urllib.error
    return urllib.error.HTTPError(
        url="https://example.com",
        code=code,
        msg=reason,
        hdrs={},     # type: ignore[arg-type]
        fp=io.BytesIO(reason.encode()),
    )


# ── fixtures ─────────────────────────────────────────────────────────────────

@pytest.fixture
def mock_urlopen():
    """Patch urllib.request.urlopen and return the mock object."""
    with mock.patch("urllib.request.urlopen") as m:
        yield m


@pytest.fixture
def valid_profile_response():
    return make_json_response({"emailAddress": "test@gmail.com", "messagesTotal": 100})


@pytest.fixture
def mismatched_profile_response():
    return make_json_response({"emailAddress": "other@gmail.com", "messagesTotal": 50})
