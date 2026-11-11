"""The Firestore store's transaction retry, without an emulator: a commit retried by the client
library keeps its place in line; contention on a read starts a fresh transaction; anything
else is not retried."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from google.api_core import exceptions as gexc

from relay import store_firestore
from relay.store_firestore import FirestoreStore


class _Db:
    def __init__(self) -> None:
        self.max_attempts: list[int] = []

    def transaction(self, max_attempts: int) -> object:
        self.max_attempts.append(max_attempts)
        return object()


def _store(
    monkeypatch: pytest.MonkeyPatch, outcomes: list[Any]
) -> tuple[FirestoreStore, list[float], _Db]:
    """A store whose transactions follow ``outcomes``: an exception is raised, a value returned."""
    store = object.__new__(FirestoreStore)
    db = _Db()
    monkeypatch.setattr(store, "_db", lambda: db, raising=False)
    sleeps: list[float] = []

    async def sleep(seconds: float) -> None:
        sleeps.append(seconds)

    monkeypatch.setattr(store_firestore.asyncio, "sleep", sleep)

    def transactional(body: Any) -> Any:
        async def run(txn: object) -> Any:
            outcome = outcomes.pop(0)
            if isinstance(outcome, BaseException):
                raise outcome
            return outcome

        return run

    monkeypatch.setattr(store_firestore.firestore, "async_transactional", transactional)
    return store, sleeps, db


def _aborted_commit() -> ValueError:
    # How the client reports an aborted commit: a ValueError caused by Aborted.
    err = ValueError("Failed to commit transaction in 1 attempts.")
    err.__cause__ = gexc.Aborted("contention")
    return err


async def _body(txn: object) -> str:
    return "unused"


def test_a_commit_is_retried_in_place_by_the_library(monkeypatch: pytest.MonkeyPatch) -> None:
    # The library keeps a commit's place in line only across its own attempts: one transaction
    # object with several, never a fresh one per commit retry (the 11 Nov 2026 starvation).
    store, sleeps, db = _store(monkeypatch, ["done"])
    assert asyncio.run(store._run(_body)) == "done"
    assert db.max_attempts == [store_firestore._TXN_COMMIT_ATTEMPTS]
    assert store_firestore._TXN_COMMIT_ATTEMPTS >= 12


def test_contention_starts_again_until_the_attempt_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    attempts = store_firestore._TXN_ATTEMPTS
    outcomes: list[Any] = [
        _aborted_commit() if i % 2 else gexc.Aborted("x") for i in range(attempts)
    ]
    store, sleeps, db = _store(monkeypatch, outcomes)
    with pytest.raises((gexc.Aborted, ValueError)):
        asyncio.run(store._run(_body))
    assert len(db.max_attempts) == attempts and len(sleeps) == attempts - 1

    store, sleeps, db = _store(monkeypatch, [gexc.Aborted("x"), _aborted_commit(), "done"])
    assert asyncio.run(store._run(_body)) == "done"
    assert len(sleeps) == 2


@pytest.mark.parametrize("error", [ValueError("not contention"), gexc.PermissionDenied("no")])
def test_other_errors_are_not_retried(monkeypatch: pytest.MonkeyPatch, error: Exception) -> None:
    store, sleeps, _ = _store(monkeypatch, [error, "never"])
    with pytest.raises(type(error)):
        asyncio.run(store._run(_body))
    assert sleeps == []
