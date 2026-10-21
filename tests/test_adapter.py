"""Tests for the Keet adapter stdio protocol, lifecycle, and access control."""

import asyncio
import json
import os
import sys
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

_plugin_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _plugin_root not in sys.path:
    sys.path.insert(0, _plugin_root)

import adapter

VALID_A = "a" * 64
VALID_B = "b" * 64
VALID_C = "c" * 64
VALID_ROOM = "d" * 64


class FakeStdin:
    def __init__(self):
        self.lines = []

    def write(self, data):
        self.lines.append(data.decode("utf-8"))

    async def drain(self):
        return None


class FakeProcess:
    def __init__(self, returncode=None):
        self.stdin = FakeStdin()
        self.stdout = None
        self.stderr = None
        self.returncode = returncode
        self._done = asyncio.Event()
        if returncode is not None:
            self._done.set()
        self.terminated = False
        self.killed = False

    async def wait(self):
        await self._done.wait()
        return self.returncode

    def terminate(self):
        self.terminated = True
        self.returncode = -15
        self._done.set()

    def kill(self):
        self.killed = True
        self.returncode = -9
        self._done.set()


def make_adapter(**attrs):
    instance = adapter.KeetAdapter()
    for key, value in attrs.items():
        setattr(instance, key, value)
    return instance


async def cleanup(instance):
    for task in list(instance._tasks):
        if not task.done():
            task.cancel()
    if instance._tasks:
        await asyncio.gather(*instance._tasks, return_exceptions=True)


def send_result(ok=True, error=None, **fields):
    return adapter._send_result(ok, error, **fields)


def request_id_from(proc):
    payload = json.loads(proc.stdin.lines[-1])
    return payload["request_id"], payload


class TestRequestCorrelation:
    @pytest.mark.asyncio
    async def test_success_is_correlated_and_cleaned_up(self):
        instance = make_adapter()
        proc = FakeProcess()
        instance._process = proc

        task = asyncio.create_task(instance._request("status"))
        while not proc.stdin.lines:
            await asyncio.sleep(0)

        request_id, payload = request_id_from(proc)
        assert payload["command"] == "status"
        assert request_id in instance._pending

        await instance._handle_bridge_event(
            json.dumps(
                {
                    "type": "status_result",
                    "request_id": request_id,
                    "status": "online",
                    "peer_count": 0,
                }
            )
        )
        response = await task

        assert response["status"] == "online"
        assert instance._pending == {}
        await cleanup(instance)

    @pytest.mark.asyncio
    async def test_bridge_error_raises_typed_error_and_cleans_up(self):
        instance = make_adapter()
        proc = FakeProcess()
        instance._process = proc

        task = asyncio.create_task(instance._request("send_message", {"text": "x"}))
        while not proc.stdin.lines:
            await asyncio.sleep(0)

        request_id, _ = request_id_from(proc)
        await instance._handle_bridge_event(
            json.dumps(
                {
                    "type": "error",
                    "request_id": request_id,
                    "code": "INVALID_TEXT",
                    "message": "send_message requires a non-empty text field",
                    "operation": "send_message",
                }
            )
        )

        with pytest.raises(adapter.KeetBridgeError) as excinfo:
            await task
        assert excinfo.value.code == "INVALID_TEXT"
        assert excinfo.value.operation == "send_message"
        assert instance._pending == {}
        await cleanup(instance)

    @pytest.mark.asyncio
    async def test_timeout_removes_pending_request(self):
        instance = make_adapter()
        instance.REQUEST_TIMEOUT = 0.02
        proc = FakeProcess()
        instance._process = proc

        with pytest.raises(adapter.KeetTimeout):
            await instance._request("status")

        assert instance._pending == {}
        await cleanup(instance)

    @pytest.mark.asyncio
    async def test_writes_are_serialized_by_the_lock(self):
        instance = make_adapter()
        proc = FakeProcess()
        instance._process = proc

        first = asyncio.create_task(instance._request("status"))
        second = asyncio.create_task(instance._request("get_identity"))
        while len(proc.stdin.lines) < 2:
            await asyncio.sleep(0)

        ids = [json.loads(line)["request_id"] for line in proc.stdin.lines]
        assert len(ids) == len(set(ids))
        for event in (
            {"type": "status_result", "request_id": ids[0]},
            {"type": "identity_result", "request_id": ids[1]},
        ):
            await instance._handle_bridge_event(json.dumps(event))
        await asyncio.gather(first, second)
        await cleanup(instance)


class TestConnectReadiness:
    @pytest.mark.asyncio
    async def test_connect_succeeds_only_after_readiness_and_filters_home(self):
        instance = make_adapter()
        proc = FakeProcess()
        instance._ensure_bridge_deps = AsyncMock(return_value=True)
        instance._home_channel = VALID_ROOM

        async def start_process():
            instance._process = proc

            async def ready():
                await asyncio.sleep(0.01)
                await instance._handle_bridge_event(
                    json.dumps(
                        {
                            "type": "welcome_room_ready",
                            "protocol_version": "1.0.0",
                            "identity": VALID_A,
                            "room_key": VALID_ROOM,
                            "invite_url": "keet://chat/test",
                            "started_at": "2026-10-21T00:00:00.000Z",
                        }
                    )
                )

            instance._tasks.add(asyncio.create_task(ready()))

        instance._start_process = start_process
        instance._schedule_stable_reset = MagicMock()

        assert await instance.connect() is True
        assert instance.is_connected is True
        assert instance.get_bridge_pubkey() == VALID_A
        assert instance.get_room_key() == VALID_ROOM
        assert instance.get_invite_url() == "keet://chat/test"
        await cleanup(instance)

    @pytest.mark.asyncio
    async def test_connect_timeout_kills_process_and_stays_disconnected(self):
        instance = make_adapter()
        instance.READY_TIMEOUT = 0.02
        instance._ensure_bridge_deps = AsyncMock(return_value=True)
        proc = FakeProcess()

        async def start_process():
            instance._process = proc

        instance._start_process = start_process

        with pytest.raises(asyncio.TimeoutError):
            await instance.connect()

        assert instance.is_connected is False
        assert proc.terminated is True
        assert instance._suppress_restart is True
        await cleanup(instance)

    @pytest.mark.asyncio
    async def test_connect_exit_during_startup_raises(self):
        instance = make_adapter()
        instance._ensure_bridge_deps = AsyncMock(return_value=True)
        proc = FakeProcess(returncode=1)
        instance._process = proc

        async def start_process():
            instance._process = proc

        instance._start_process = start_process
        with pytest.raises(RuntimeError):
            await instance.connect()
        assert instance.is_connected is False
        await cleanup(instance)

    @pytest.mark.asyncio
    async def test_invalid_home_channel_is_a_config_error(self):
        instance = make_adapter()
        instance._home_channel = "not-a-room-key"
        instance._ensure_bridge_deps = AsyncMock(return_value=True)
        instance._start_process = AsyncMock()

        assert await instance.connect() is False
        instance._ensure_bridge_deps.assert_not_awaited()
        instance._start_process.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_unknown_home_channel_does_not_connect(self):
        instance = make_adapter()
        instance._home_channel = VALID_ROOM
        instance._ensure_bridge_deps = AsyncMock(return_value=True)
        proc = FakeProcess()

        async def start_process():
            instance._process = proc
            await instance._handle_bridge_event(
                json.dumps(
                    {
                        "type": "welcome_room_ready",
                        "protocol_version": "1.0.0",
                        "identity": VALID_A,
                        "room_key": VALID_B,
                        "invite_url": None,
                    }
                )
            )

        instance._start_process = start_process
        assert await instance.connect() is False
        assert instance.is_connected is False
        assert proc.terminated is True
        await cleanup(instance)


class TestSendResults:
    @pytest.mark.asyncio
    async def test_send_awaits_and_returns_bridge_result(self):
        instance = make_adapter(_connected=True, _process=FakeProcess())
        instance._request = AsyncMock(
            return_value={
                "message_id": "e" * 64,
                "room_key": VALID_ROOM,
                "replicated_peers": 0,
                "queued": True,
                "timestamp": 1234,
            }
        )

        result = await instance.send(VALID_ROOM, "hello")

        instance._request.assert_awaited_once_with(
            "send_message", {"chat_id": VALID_ROOM, "text": "hello"}
        )
        assert result.ok is True
        assert result.message_id == "e" * 64
        assert result.room_key == VALID_ROOM
        assert result.replicated_peers == 0
        assert result.queued is True

    @pytest.mark.asyncio
    async def test_send_failure_and_timeout_are_reported(self):
        instance = make_adapter(_connected=True, _process=FakeProcess())
        instance._request = AsyncMock(
            side_effect=adapter.KeetBridgeError("INVALID_TEXT", "empty")
        )
        result = await instance.send(VALID_ROOM, "")
        assert result.ok is False
        assert "INVALID_TEXT" in result.error

        instance._request = AsyncMock(
            side_effect=adapter.KeetTimeout("timed out")
        )
        result = await instance.send(VALID_ROOM, "hello")
        assert result.ok is False
        assert "timed out" in result.error

    @pytest.mark.asyncio
    async def test_send_disconnected_never_calls_bridge(self):
        instance = make_adapter(_connected=False, _process=None)
        instance._request = AsyncMock()
        result = await instance.send(VALID_ROOM, "hello")
        assert result.ok is False
        assert "Not connected" in result.error
        instance._request.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_send_welcome_uses_correlated_command(self):
        instance = make_adapter(_connected=True, _process=FakeProcess())
        instance._request = AsyncMock(
            return_value={
                "message_id": "f" * 64,
                "room_key": VALID_ROOM,
                "replicated_peers": 0,
                "queued": True,
                "timestamp": 1,
            }
        )
        result = await instance.send_welcome(VALID_ROOM)
        assert result.ok is True
        assert instance._request.await_args.args[0] == "send_welcome"
        assert instance._request.await_args.args[1]["text"] == adapter.WELCOME_MESSAGE

    @pytest.mark.asyncio
    async def test_send_welcome_is_not_sent_to_unauthorized_identity(self):
        instance = make_adapter(_connected=True, _process=FakeProcess())
        instance._allowed_users = set()
        instance._request = AsyncMock()
        result = await instance.send_welcome(VALID_ROOM, identity=VALID_A)
        assert result.ok is False
        assert "Unauthorized" in result.error
        instance._request.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_send_image_is_typed_unsupported_without_bridge_call(self):
        instance = make_adapter(_connected=True, _process=FakeProcess())
        instance._request = AsyncMock()
        result = await instance.send_image(VALID_ROOM, "/tmp/x.png")
        assert result.ok is False
        assert result.code == "unsupported_command"
        assert result.operation == "send_image"
        instance._request.assert_not_awaited()


class TestEventsAndAccessControl:
    @pytest.mark.asyncio
    async def test_unauthorized_message_is_dropped_before_agent(self):
        instance = make_adapter()
        instance._allowed_users = set()
        instance._dynamic_allowed = set()
        instance.on_message = AsyncMock()
        instance.send = AsyncMock()

        with patch.object(adapter.logger, "warning") as warning:
            await instance._on_message(
                {
                    "room_key": VALID_ROOM,
                    "sender": VALID_A,
                    "text": "hi",
                    "timestamp": 1,
                }
            )

        instance.on_message.assert_not_awaited()
        instance.send.assert_not_awaited()
        warning.assert_called()

    @pytest.mark.asyncio
    async def test_allowed_first_message_sends_welcome_and_forwards(self):
        instance = make_adapter()
        instance._allowed_users = {VALID_A}
        instance._dynamic_allowed = set()
        instance.on_message = AsyncMock()
        instance.send = AsyncMock(return_value=send_result(True))

        await instance._on_message(
            {
                "room_key": VALID_ROOM,
                "sender": VALID_A,
                "text": "hello",
                "timestamp": 100,
                "message_id": "m-1",
            }
        )

        instance.send.assert_awaited_once_with(VALID_ROOM, adapter.WELCOME_MESSAGE)
        instance.on_message.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_own_message_is_not_forwarded(self):
        instance = make_adapter()
        instance._identity = VALID_A
        instance._allowed_users = {VALID_A}
        instance.on_message = AsyncMock()
        await instance._on_message(
            {"room_key": VALID_ROOM, "sender": VALID_A, "text": "me", "timestamp": 1}
        )
        instance.on_message.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_membership_does_not_authorize(self):
        instance = make_adapter()
        instance._allowed_users = set()
        instance._dynamic_allowed = set()
        await instance._handle_bridge_event(
            json.dumps({"type": "member_joined", "identity": VALID_B})
        )
        assert instance._is_allowed(VALID_B) is False
        assert VALID_B not in instance.get_allowed_users()

    @pytest.mark.asyncio
    async def test_unknown_event_does_not_break_reader(self):
        instance = make_adapter()
        instance.on_message = AsyncMock()
        await instance._handle_bridge_event(json.dumps({"type": "chat_list"}))
        await instance._handle_bridge_event("not json")
        await instance._handle_bridge_event(
            json.dumps({"type": "status", "peerCount": 2})
        )
        assert instance.on_message.await_count == 0


class TestAllowlistParsing:
    def test_valid_entries_are_normalized(self):
        identities, invalid = adapter._parse_allowed_users(
            f" {VALID_A.upper()} , {VALID_B} "
        )
        assert identities == {VALID_A, VALID_B}
        assert invalid == []

    def test_malformed_entries_are_reported_and_skipped(self):
        identities, invalid = adapter._parse_allowed_users(
            f"{VALID_A}, connection-id, {VALID_B}"
        )
        assert identities == {VALID_A, VALID_B}
        assert invalid == ["connection-id"]

    def test_empty_and_none(self):
        assert adapter._parse_allowed_users(None) == (set(), [])
        assert adapter._parse_allowed_users(" , , ") == (set(), [])

    def test_connection_identifier_cannot_be_added(self):
        instance = make_adapter()
        instance._allowed_users = set()
        instance._dynamic_allowed = set()
        assert instance.add_allowed_user("peer-connection-1") is False
        assert instance._is_allowed("peer-connection-1") is False

    def test_default_denies_and_warns(self):
        instance = make_adapter()
        instance._allowed_users = set()
        instance._dynamic_allowed = set()
        with patch.dict(os.environ, {}, clear=True), \
             patch.object(adapter.logger, "warning") as warning:
            instance._log_access_policy()
            assert instance._is_allowed(VALID_A) is False
            assert warning.call_count == 1
            assert "denied by default" in warning.call_args.args[0]

    def test_allow_all_is_literal_true_and_warns(self):
        instance = make_adapter()
        instance._allowed_users = set()
        instance._dynamic_allowed = set()
        with patch.dict(os.environ, {adapter.ALLOW_ALL_ENV: "1"}):
            assert instance._is_allowed(VALID_A) is False
        with patch.dict(os.environ, {adapter.ALLOW_ALL_ENV: "true"}), \
             patch.object(adapter.logger, "warning") as warning:
            instance._log_access_policy()
            assert instance._is_allowed(VALID_A) is True
            assert "ALL Keet identities" in warning.call_args.args[0]

    def test_allow_all_is_not_persisted_across_restart(self, tmp_path):
        with patch.dict(
            os.environ,
            {
                adapter.DATA_DIR_ENV: str(tmp_path),
                adapter.ALLOW_ALL_ENV: "true",
            },
            clear=True,
        ):
            enabled = adapter.KeetAdapter()
            assert enabled._is_allowed(VALID_A) is True

        with patch.dict(
            os.environ,
            {adapter.DATA_DIR_ENV: str(tmp_path)},
            clear=True,
        ):
            restarted = adapter.KeetAdapter()
        assert restarted._is_allowed(VALID_A) is False

    @pytest.mark.asyncio
    async def test_pairing_confirmation_authorizes_identity(self):
        instance = make_adapter()
        instance._allowed_users = set()
        instance._dynamic_allowed = set()
        await instance._handle_bridge_event(
            json.dumps(
                {
                    "type": "pairing_confirmed",
                    "identity": VALID_C,
                    "status": "accepted",
                    "reason": "accepted",
                }
            )
        )
        assert instance._is_allowed(VALID_C) is True

    def test_persisted_acl_is_loaded(self, tmp_path):
        acl = tmp_path / "allowed.json"
        acl.write_text(
            json.dumps({"version": 1, "identities": [VALID_A, "junk"]}),
            encoding="utf-8",
        )
        with patch.dict(
            os.environ,
            {
                adapter.DATA_DIR_ENV: str(tmp_path),
                adapter.ACL_FILE_ENV: str(acl),
            },
            clear=True,
        ):
            instance = adapter.KeetAdapter()
        assert instance._is_allowed(VALID_A) is True
        assert instance._is_allowed(VALID_B) is False


class TestSupervisionAndDisconnect:
    @pytest.mark.asyncio
    async def test_unexpected_exit_fails_pending_and_restarts(self):
        instance = make_adapter()
        proc = FakeProcess(returncode=1)
        instance._process = proc
        instance._connected = True
        future = asyncio.get_running_loop().create_future()
        instance._pending["req-1"] = future
        instance._restart_once = AsyncMock(return_value="fatal")

        with patch.object(adapter.asyncio, "sleep", AsyncMock()):
            await instance._supervise(proc)

        assert instance._connected is False
        assert instance._process is None
        assert isinstance(future.exception(), adapter.KeetNotConnected)
        instance._restart_once.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_in_flight_send_fails_when_bridge_exits(self):
        instance = make_adapter()
        proc = FakeProcess(returncode=1)
        instance._process = proc
        instance._connected = True
        instance._restart_once = AsyncMock(return_value="fatal")

        task = asyncio.create_task(instance.send(VALID_ROOM, "hello"))
        while not proc.stdin.lines:
            await asyncio.sleep(0)

        with patch.object(adapter.asyncio, "sleep", AsyncMock()):
            await instance._supervise(proc)
        result = await task

        assert result.ok is False
        assert "disconnected" in result.error.lower()
        assert instance._pending == {}
        instance._restart_once.assert_awaited_once()
        await cleanup(instance)

    @pytest.mark.asyncio
    async def test_intentional_exit_does_not_restart(self):
        instance = make_adapter()
        proc = FakeProcess(returncode=0)
        instance._process = proc
        instance._intentional_disconnect = True
        instance._restart_once = AsyncMock()
        await instance._supervise(proc)
        instance._restart_once.assert_not_called()

    @pytest.mark.asyncio
    async def test_failed_restart_attempts_continue_the_chain(self):
        instance = make_adapter()
        proc = FakeProcess(returncode=1)
        instance._process = proc
        delays = []
        outcomes = ["spawn_error", "timeout", "exited", "fatal"]

        async def fake_sleep(delay):
            delays.append(delay)

        async def restart_once():
            outcome = outcomes.pop(0)
            if outcome == "fatal":
                instance._suppress_restart = True
            return outcome

        instance._restart_once = restart_once
        with patch.object(adapter.asyncio, "sleep", fake_sleep):
            await instance._supervise(proc)

        assert delays == [1, 2, 4, 8]
        assert instance._restart_attempt == 4
        assert outcomes == []
        assert instance._connected is False

    @pytest.mark.asyncio
    async def test_restart_backoff_sequence_is_capped(self):
        instance = make_adapter()
        proc = FakeProcess(returncode=1)
        instance._process = proc
        delays = []

        async def fake_sleep(delay):
            delays.append(delay)

        async def restart_once():
            if instance._restart_attempt >= 7:
                instance._suppress_restart = True
            return "spawn_error"

        instance._restart_once = restart_once
        with patch.object(adapter.asyncio, "sleep", fake_sleep):
            await instance._supervise(proc)

        assert delays == [1, 2, 4, 8, 16, 30, 30]
        assert instance._restart_attempt == 7

    @pytest.mark.asyncio
    async def test_restart_once_success_marks_connected(self):
        instance = make_adapter()
        fresh = FakeProcess()
        instance._schedule_stable_reset = MagicMock()

        async def start():
            instance._process = fresh
            asyncio.create_task(self._emit_welcome(instance, VALID_A, VALID_ROOM))

        instance._start_process = AsyncMock(side_effect=start)
        outcome = await instance._restart_once()

        assert outcome == "ready"
        assert instance._connected is True
        instance._schedule_stable_reset.assert_called_once()

    @pytest.mark.asyncio
    async def test_restart_once_timeout_cleans_up_and_is_retryable(self):
        instance = make_adapter(READY_TIMEOUT=0.01)
        fresh = FakeProcess()

        async def start():
            instance._process = fresh

        instance._start_process = AsyncMock(side_effect=start)
        outcome = await instance._restart_once()

        assert outcome == "timeout"
        assert instance._connected is False
        assert fresh.terminated is True
        assert instance._process is None

    @pytest.mark.asyncio
    async def test_home_mismatch_stops_supervision(self):
        instance = make_adapter(_home_channel=VALID_B)
        fresh = FakeProcess()

        async def start():
            instance._process = fresh
            asyncio.create_task(
                self._emit_welcome(instance, VALID_A, VALID_ROOM)
            )

        instance._start_process = AsyncMock(side_effect=start)
        outcome = await instance._restart_once()

        assert outcome == "fatal"
        assert instance._connected is False
        assert instance._home_mismatch is True
        assert fresh.terminated is True

    @pytest.mark.asyncio
    async def test_disconnect_is_idempotent_and_uses_one_shutdown(self):
        instance = make_adapter()
        proc = FakeProcess()
        instance._process = proc
        instance._connected = True

        async def shutdown(*args, **kwargs):
            proc.returncode = 0
            proc._done.set()
            return {"type": "shutdown_result"}

        instance._request = AsyncMock(side_effect=shutdown)

        await instance.disconnect()
        await instance.disconnect()

        assert instance._request.await_count == 1
        assert instance._request.await_args.args[0] == "shutdown"
        assert proc.killed is False
        assert instance._process is None
        assert instance.is_connected is False

    @pytest.mark.asyncio
    async def test_disconnect_fails_pending_requests(self):
        instance = make_adapter()
        instance._process = None
        future = asyncio.get_running_loop().create_future()
        instance._pending["req-1"] = future
        await instance.disconnect()
        assert isinstance(future.exception(), adapter.KeetNotConnected)

    @pytest.mark.asyncio
    async def test_disconnect_cancels_all_owned_tasks(self):
        instance = make_adapter()

        async def forever():
            await asyncio.sleep(3600)

        task = instance._track(asyncio.create_task(forever()))
        await asyncio.sleep(0)
        await instance.disconnect()

        assert task.cancelled() is True
        assert instance._tasks == set()

    @staticmethod
    async def _emit_welcome(instance, identity, room):
        await asyncio.sleep(0.01)
        await instance._handle_bridge_event(
            json.dumps(
                {
                    "type": "welcome_room_ready",
                    "identity": identity,
                    "room_key": room,
                    "protocol_version": "1.0.0",
                    "invite_url": "keet://chat/test",
                    "started_at": "2026-01-01T00:00:00Z",
                }
            )
        )


class FakeStdout:
    def __init__(self, lines):
        self._lines = list(lines)

    async def readline(self):
        if not self._lines:
            return b""
        return self._lines.pop(0)


class TestLifecycleSerialization:
    @pytest.mark.asyncio
    async def test_overlapping_connects_share_one_start(self):
        instance = make_adapter()
        instance._schedule_stable_reset = MagicMock()
        instance._ensure_bridge_deps = AsyncMock(return_value=True)
        starts = []

        async def start():
            starts.append(1)
            proc = FakeProcess()
            instance._process = proc
            asyncio.create_task(self._emit_welcome(instance, VALID_A, VALID_ROOM))

        instance._start_process = AsyncMock(side_effect=start)

        results = await asyncio.gather(instance.connect(), instance.connect())

        assert results == [True, True]
        assert len(starts) == 1
        assert instance._ensure_bridge_deps.await_count == 1
        await cleanup(instance)

    @pytest.mark.asyncio
    async def test_disconnect_during_connect_aborts_and_allows_reconnect(self):
        instance = make_adapter()
        instance._schedule_stable_reset = MagicMock()
        instance._ensure_bridge_deps = AsyncMock(return_value=True)
        first = FakeProcess()

        async def start_first():
            instance._process = first

        instance._start_process = AsyncMock(side_effect=start_first)

        connect_task = asyncio.create_task(instance.connect())
        while instance._process is None:
            await asyncio.sleep(0)

        disconnect_task = asyncio.create_task(instance.disconnect())
        assert await asyncio.wait_for(connect_task, timeout=2) is False
        await disconnect_task

        assert first.terminated is True
        assert instance._process is None

        second = FakeProcess()

        async def start_second():
            instance._process = second
            asyncio.create_task(self._emit_welcome(instance, VALID_A, VALID_ROOM))

        instance._start_process = AsyncMock(side_effect=start_second)
        assert await instance.connect() is True
        await cleanup(instance)

    @pytest.mark.asyncio
    async def test_two_connects_without_overlap_start_once(self):
        instance = make_adapter()
        instance._schedule_stable_reset = MagicMock()
        instance._ensure_bridge_deps = AsyncMock(return_value=True)
        starts = []

        async def start():
            starts.append(1)
            instance._process = FakeProcess()
            asyncio.create_task(self._emit_welcome(instance, VALID_A, VALID_ROOM))

        instance._start_process = AsyncMock(side_effect=start)

        assert await instance.connect() is True
        assert await instance.connect() is True
        assert len(starts) == 1
        await cleanup(instance)

    @staticmethod
    async def _emit_welcome(instance, identity, room):
        await asyncio.sleep(0.01)
        await instance._handle_bridge_event(
            json.dumps(
                {
                    "type": "welcome_room_ready",
                    "identity": identity,
                    "room_key": room,
                    "protocol_version": "1.0.0",
                    "invite_url": "keet://chat/test",
                    "started_at": "2026-01-01T00:00:00Z",
                }
            )
        )


class TestDependencySetup:
    @pytest.mark.asyncio
    async def test_dependency_setup_timeout_stops_child(self, tmp_path):
        instance = make_adapter()
        instance._bridge_dir = str(tmp_path)
        child = StubSetupProcess()

        with patch.object(
            adapter.asyncio, "create_subprocess_exec", AsyncMock(return_value=child)
        ), patch.object(adapter, "DEPENDENCY_SETUP_TIMEOUT", 0.01):
            assert await instance._ensure_bridge_deps() is False

        assert child.terminated is True
        assert instance._connected is False

    @pytest.mark.asyncio
    async def test_missing_deps_leaves_adapter_disconnected(self, tmp_path):
        instance = make_adapter()
        instance._bridge_dir = str(tmp_path)
        instance._start_process = AsyncMock()

        with patch.object(
            adapter.asyncio, "create_subprocess_exec", AsyncMock(return_value=None)
        ):
            # A None child means the fake returned nothing; treat it as a
            # failed setup rather than proceeding to start the bridge.
            with patch.object(
                instance, "_ensure_bridge_deps", AsyncMock(return_value=False)
            ):
                assert await instance.connect() is False

        instance._start_process.assert_not_called()


class StubSetupProcess:
    def __init__(self):
        self.returncode = None
        self.terminated = False
        self.killed = False

    async def communicate(self):
        await asyncio.sleep(3600)
        return b"", b""

    def terminate(self):
        self.terminated = True
        self.returncode = -15

    def kill(self):
        self.killed = True
        self.returncode = -9

    async def wait(self):
        return self.returncode


class TestReadinessValidation:
    @pytest.mark.asyncio
    async def test_invalid_protocol_is_rejected_before_connected(self):
        instance = make_adapter()
        proc = FakeProcess()

        instance._accept_readiness(
            {
                "type": "welcome_room_ready",
                "identity": VALID_A,
                "room_key": VALID_ROOM,
                "protocol_version": "2",
            }
        )

        assert instance._connected is False
        assert instance._readiness_ok is False
        assert "protocol_version" in instance._readiness_error
        with pytest.raises(RuntimeError):
            await instance._await_readiness(proc, 1.0)

    @pytest.mark.asyncio
    async def test_missing_room_key_is_rejected(self):
        instance = make_adapter()
        instance._accept_readiness(
            {
                "type": "welcome_room_ready",
                "identity": VALID_A,
                "protocol_version": "1.0.0",
            }
        )
        assert instance._connected is False
        assert "room_key" in instance._readiness_error

    @pytest.mark.asyncio
    async def test_home_mismatch_is_flagged_but_not_connected(self):
        instance = make_adapter(_home_channel=VALID_B)
        instance._accept_readiness(
            {
                "type": "welcome_room_ready",
                "identity": VALID_A,
                "room_key": VALID_ROOM,
                "protocol_version": "1.0.0",
            }
        )
        assert instance._connected is False
        assert instance._home_mismatch is True
        assert adapter.HOME_CHANNEL_ENV in instance._readiness_error


class TestEventPipeline:
    @pytest.mark.asyncio
    async def test_response_resolves_while_event_handler_is_blocked(self):
        instance = make_adapter()
        instance._identity = VALID_B
        instance._connected = True
        instance._allowed_users = {VALID_A}
        proc = FakeProcess()
        proc.stdout = FakeStdout(
            [
                json.dumps(
                    {
                        "type": "message",
                        "from": VALID_A,
                        "room_key": VALID_ROOM,
                        "text": "hello",
                        "message_id": "m1",
                    }
                ).encode()
                + b"\n",
                json.dumps(
                    {"type": "send_message_result", "request_id": "r1"}
                ).encode()
                + b"\n",
            ]
        )
        instance._process = proc

        gate = asyncio.Event()
        entered = asyncio.Event()

        async def slow_welcome(*args, **kwargs):
            entered.set()
            await gate.wait()
            return adapter._send_result(True)

        instance.send = slow_welcome
        instance.on_message = AsyncMock()
        future = asyncio.get_running_loop().create_future()
        instance._pending["r1"] = future

        await instance._read_stdout(proc)
        await asyncio.wait_for(entered.wait(), timeout=1)
        assert future.done() is True
        assert future.result()["type"] == "send_message_result"

        gate.set()
        await asyncio.sleep(0)
        await cleanup(instance)

    @pytest.mark.asyncio
    async def test_event_queue_overflow_drops_oldest(self):
        instance = make_adapter()
        instance._handle_event = AsyncMock()

        with patch.object(adapter, "MAX_EVENT_QUEUE", 3):
            for index in range(4):
                instance._enqueue_event({"type": "message", "index": index})
            assert [event["index"] for event in instance._event_queue] == [1, 2, 3]
            instance._enqueue_event({"type": "message", "index": 4})
            assert [event["index"] for event in instance._event_queue] == [2, 3, 4]
            assert instance._dropped_events == 1

        await cleanup(instance)

    @pytest.mark.asyncio
    async def test_welcome_registry_is_bounded_and_evicts_oldest(self):
        instance = make_adapter()
        with patch.object(adapter, "MAX_WELCOMED_CONTACTS", 3):
            for identity in (VALID_A, VALID_B, VALID_C):
                assert instance._remember_welcome(identity) is True
            assert instance._remember_welcome(VALID_ROOM) is True

        assert VALID_A not in instance._welcomed_contacts
        assert list(instance._welcomed_contacts) == [VALID_B, VALID_C, VALID_ROOM]
        assert instance._remember_welcome(VALID_B) is False

    @pytest.mark.asyncio
    async def test_send_welcome_maps_broken_pipe(self):
        instance = make_adapter()
        instance._process = FakeProcess()
        instance._connected = True
        instance._allowed_users = {VALID_A}
        instance._request = AsyncMock(side_effect=BrokenPipeError())

        result = await instance.send_welcome(VALID_ROOM, identity=VALID_A)

        assert result.ok is False
        assert "disconnected" in result.error.lower()


class TestRequirementsAndStandalone:
    def test_check_requirements_accepts_node_24(self):
        with patch("shutil.which", return_value="/usr/bin/node"), \
             patch("os.path.exists", return_value=True), \
             patch("os.access", return_value=True), \
             patch.object(adapter, "_node_major_version", return_value=24):
            assert adapter.check_requirements() is True

    def test_check_requirements_rejects_old_or_unknown_node(self):
        with patch("shutil.which", return_value="/usr/bin/node"), \
             patch("os.path.exists", return_value=True), \
             patch("os.access", return_value=True), \
             patch.object(adapter, "_node_major_version", return_value=23):
            assert adapter.check_requirements() is False

        with patch("shutil.which", return_value="/usr/bin/node"), \
             patch("os.path.exists", return_value=True), \
             patch("os.access", return_value=True), \
             patch.object(adapter, "_node_major_version", return_value=None):
            assert adapter.check_requirements() is False

    def test_check_requirements_rejects_missing_node(self):
        with patch("shutil.which", return_value=None), \
             patch("os.path.exists", return_value=False):
            assert adapter.check_requirements() is False

    def test_no_pear_runtime_helpers_remain(self):
        assert not hasattr(adapter, "_pear_cmd")
        assert not hasattr(adapter, "_check_pear_path")
        assert not hasattr(adapter, "_ensure_node_deps")

    def test_standalone_send_connects_sends_and_disconnects(self):
        instance = MagicMock()
        instance.connect = AsyncMock(return_value=True)
        instance.disconnect = AsyncMock()
        instance.send = AsyncMock(
            return_value=send_result(
                True,
                message_id="e" * 64,
                room_key=VALID_ROOM,
                replicated_peers=0,
                queued=True,
                timestamp=1,
            )
        )
        factory = MagicMock(return_value=instance)

        with patch.object(adapter, "KeetAdapter", factory), \
             patch.dict(os.environ, {adapter.HOME_CHANNEL_ENV: VALID_ROOM}, clear=True):
            result = adapter._standalone_send("", "hello")

        assert result["ok"] is True
        assert result["queued"] is True
        assert result["replicated_peers"] == 0
        instance.connect.assert_awaited_once()
        instance.send.assert_awaited_once_with(VALID_ROOM, "hello")
        instance.disconnect.assert_awaited_once()

    def test_standalone_send_missing_home_channel_is_explicit(self):
        factory = MagicMock()
        with patch.object(adapter, "KeetAdapter", factory), \
             patch.dict(os.environ, {}, clear=True):
            result = adapter._standalone_send("", "hello")

        assert result["ok"] is False
        assert adapter.HOME_CHANNEL_ENV in result["error"]
        factory.assert_not_called()

    def test_standalone_send_disconnects_after_failure(self):
        instance = MagicMock()
        instance.connect = AsyncMock(side_effect=RuntimeError("boom"))
        instance.disconnect = AsyncMock()
        instance.send = AsyncMock()
        factory = MagicMock(return_value=instance)

        with patch.object(adapter, "KeetAdapter", factory), \
             patch.dict(os.environ, {adapter.HOME_CHANNEL_ENV: VALID_ROOM}, clear=True):
            result = adapter._standalone_send(VALID_ROOM, "hello")

        assert result["ok"] is False
        assert "did not become ready" in result["error"]
        instance.disconnect.assert_awaited_once()
        instance.send.assert_not_awaited()

    def test_standalone_send_reports_delivery_failure(self):
        instance = MagicMock()
        instance.connect = AsyncMock(return_value=True)
        instance.disconnect = AsyncMock()
        instance.send = AsyncMock(
            return_value=send_result(False, "INVALID_TEXT: empty")
        )
        factory = MagicMock(return_value=instance)

        with patch.object(adapter, "KeetAdapter", factory), \
             patch.dict(os.environ, {adapter.HOME_CHANNEL_ENV: VALID_ROOM}, clear=True):
            result = adapter._standalone_send(VALID_ROOM, "")

        assert result["ok"] is False
        assert "INVALID_TEXT" in result["error"]
        instance.disconnect.assert_awaited_once()
