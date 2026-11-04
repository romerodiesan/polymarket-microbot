import asyncio
from threading import Event

import pytest

from microbot.config import Settings
from microbot.main import check_execution_halt, finish_in_thread


def test_io_keeps_the_event_loop_responsive_and_shutdown_waits_for_it():
    started, release, finished = Event(), Event(), Event()

    def slow_export():
        started.set()
        assert release.wait(timeout=5)
        finished.set()

    async def scenario():
        task = asyncio.create_task(finish_in_thread(slow_export))
        try:
            assert await asyncio.to_thread(started.wait, 2)
            # We got CPU while the export was blocked in another thread.
            task.cancel()
            await asyncio.sleep(0)
            assert not task.done()
        finally:
            release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert finished.is_set()

    asyncio.run(scenario())


def test_live_execution_halt_survives_restart(tmp_path):
    path = tmp_path / "halt.json"
    settings = Settings(yes_token_id="yes", no_token_id="no", execution_halt_path=path)
    path.write_text('{"reason":"execution_failed_requires_reconciliation"}')
    check_execution_halt(settings)  # Recording/paper remains available for diagnosis.
    live = settings.model_copy(update={"mode": "live"})
    with pytest.raises(RuntimeError, match="Reconcile venue orders"):
        check_execution_halt(live)
