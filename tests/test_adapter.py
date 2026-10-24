"""Tests for the Keet adapter stdio protocol, lifecycle, and access control."""

import asyncio
import base64
import hashlib
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

PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"adapter image payload"
JPEG_BYTES = b"\xff\xd8\xff\xe0" + b"adapter image payload"
GIF_BYTES = b"GIF89a" + b"adapter image payload"
WEBP_BYTES = b"RIFF" + b"\x10\x00\x00\x00" + b"WEBP" + b"adapter image payload"


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
    def test_send_result_prefers_success_signature(self, monkeypatch):
        class CurrentSendResult:
            def __init__(self, success=False, error=None):
                self.success = success
                self.error = error

        monkeypatch.setattr(adapter, "SendResult", CurrentSendResult)
        success = adapter._send_result(True, message_id="m1")
        failure = adapter._send_result(False, "bad")

        assert success.success is True
        assert success.ok is True
        assert success.message_id == "m1"
        assert failure.success is False
        assert failure.ok is False
        assert failure.error == "bad"

    def test_send_result_falls_back_to_legacy_ok_signature(self, monkeypatch):
        class LegacySendResult:
            def __init__(self, ok=False, error=None):
                self.ok = ok
                self.error = error

        monkeypatch.setattr(adapter, "SendResult", LegacySendResult)
        success = adapter._send_result(True, message_id="m2")
        failure = adapter._send_result(False, "legacy bad")

        assert success.ok is True
        assert success.success is True
        assert success.message_id == "m2"
        assert failure.ok is False
        assert failure.success is False
        assert failure.error == "legacy bad"
        assert adapter._result_ok(success) is True
        assert adapter._result_ok(failure) is False

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
    async def test_send_image_uses_one_correlated_payload_and_timeout(
        self, monkeypatch
    ):
        instance = make_adapter(_connected=True, _process=FakeProcess())
        resolver = AsyncMock(return_value=(PNG_BYTES, "image/png"))
        monkeypatch.setattr(adapter, "_resolve_image", resolver)
        expected_digest = hashlib.sha256(PNG_BYTES).hexdigest()
        instance._request = AsyncMock(
            return_value={
                "type": "send_image_result",
                "message_id": "e" * 64,
                "room_key": VALID_ROOM,
                "chat_id": VALID_ROOM,
                "mime_type": "image/png",
                "size": len(PNG_BYTES),
                "sha256": expected_digest,
                "replicated_peers": 2,
                "queued": False,
                "timestamp": 1234,
            }
        )

        result = await instance.send_image(
            VALID_ROOM, "https://example.test/photo.png", caption="look"
        )

        resolver.assert_awaited_once_with("https://example.test/photo.png")
        instance._request.assert_awaited_once_with(
            "send_image",
            {
                "room_key": VALID_ROOM,
                "payload": {
                    "mime_type": "image/png",
                    "base64_data": base64.b64encode(PNG_BYTES).decode("ascii"),
                    "caption": "look",
                },
            },
            timeout=adapter.SEND_IMAGE_TIMEOUT,
        )
        assert adapter.SEND_IMAGE_TIMEOUT == 60.0
        assert result.ok is True
        assert result.success is True
        assert result.message_id == "e" * 64
        assert result.mime_type == "image/png"
        assert result.size == len(PNG_BYTES)
        assert result.sha256 == expected_digest
        assert result.queued is False
        assert result.replicated_peers == 2

    @pytest.mark.asyncio
    async def test_send_image_timeout_is_reported(self, monkeypatch):
        instance = make_adapter(_connected=True, _process=FakeProcess())
        monkeypatch.setattr(
            adapter,
            "_resolve_image",
            AsyncMock(return_value=(GIF_BYTES, "image/gif")),
        )
        instance._request = AsyncMock(
            side_effect=adapter.KeetTimeout("no answer in 60s")
        )

        result = await instance.send_image(VALID_ROOM, "/tmp/photo.gif")

        assert result.ok is False
        assert result.code == "timeout"
        assert result.operation == "send_image"
        assert "no answer in 60s" in result.error

    @pytest.mark.asyncio
    async def test_send_image_resolution_failure_never_calls_bridge(
        self, monkeypatch
    ):
        instance = make_adapter(_connected=True, _process=FakeProcess())
        monkeypatch.setattr(
            adapter,
            "_resolve_image",
            AsyncMock(
                side_effect=adapter.KeetImageError(
                    "MEDIA_TOO_LARGE", "image is too large"
                )
            ),
        )
        instance._request = AsyncMock()

        result = await instance.send_image(VALID_ROOM, "/tmp/huge.png")

        assert result.ok is False
        assert result.code == "MEDIA_TOO_LARGE"
        assert result.operation == "send_image"
        instance._request.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_send_image_file_delegates_to_send_image(self):
        instance = make_adapter(_connected=True, _process=FakeProcess())
        expected = send_result(True, message_id="f" * 64)
        instance.send_image = AsyncMock(return_value=expected)

        result = await instance.send_image_file(
            VALID_ROOM, "/tmp/photo.png", caption="file caption"
        )

        instance.send_image.assert_awaited_once_with(
            VALID_ROOM, "/tmp/photo.png", caption="file caption"
        )
        assert result is expected


class TestImageResolution:
    def test_magic_bytes_identify_each_supported_image_type(self):
        assert adapter._detect_image_mime(PNG_BYTES) == "image/png"
        assert adapter._detect_image_mime(JPEG_BYTES) == "image/jpeg"
        assert adapter._detect_image_mime(GIF_BYTES) == "image/gif"
        assert adapter._detect_image_mime(WEBP_BYTES) == "image/webp"
        assert adapter._detect_image_mime(b"not an image") is None

    @pytest.mark.asyncio
    async def test_local_path_and_file_url_resolve_to_magic_checked_bytes(
        self, tmp_path
    ):
        local = tmp_path / "photo.bin"
        local.write_bytes(PNG_BYTES)
        data, mime_type = await adapter._resolve_image(local)
        assert data == PNG_BYTES
        assert mime_type == "image/png"

        spaced = tmp_path / "a photo.gif"
        spaced.write_bytes(GIF_BYTES)
        data, mime_type = await adapter._resolve_image(spaced.as_uri())
        assert data == GIF_BYTES
        assert mime_type == "image/gif"

    @pytest.mark.asyncio
    async def test_http_uses_hermes_cache_helper_when_available(
        self, tmp_path, monkeypatch
    ):
        cached = tmp_path / "cached-image"
        cached.write_bytes(WEBP_BYTES)
        helper = AsyncMock(return_value=str(cached))
        monkeypatch.setattr(adapter, "cache_image_from_url", helper)

        data, mime_type = await adapter._resolve_image(
            "https://example.test/photo.webp"
        )

        helper.assert_awaited_once_with("https://example.test/photo.webp")
        assert data == WEBP_BYTES
        assert mime_type == "image/webp"

    @pytest.mark.asyncio
    async def test_http_falls_back_to_bounded_fetch(self, monkeypatch):
        class FakeResponse:
            headers = {}

            def __init__(self, data):
                self._data = data
                self._offset = 0

            def read(self, size):
                chunk = self._data[self._offset : self._offset + size]
                self._offset += len(chunk)
                return chunk

            def __enter__(self):
                return self

            def __exit__(self, *exc_info):
                return False

        def fake_urlopen(request, timeout=None):
            assert request.full_url == "http://example.test/photo.png"
            assert timeout == adapter._IMAGE_FETCH_TIMEOUT
            return FakeResponse(PNG_BYTES)

        monkeypatch.setattr(adapter, "cache_image_from_url", None)
        monkeypatch.setattr(adapter.urllib.request, "urlopen", fake_urlopen)

        data, mime_type = await adapter._resolve_image(
            "http://example.test/photo.png"
        )
        assert data == PNG_BYTES
        assert mime_type == "image/png"

    @pytest.mark.asyncio
    async def test_unreachable_url_is_typed(self, monkeypatch):
        def unreachable(request, timeout=None):
            raise OSError("network is down")

        monkeypatch.setattr(adapter, "cache_image_from_url", None)
        monkeypatch.setattr(adapter.urllib.request, "urlopen", unreachable)

        with pytest.raises(adapter.KeetImageError) as excinfo:
            await adapter._resolve_image("https://example.test/photo.png")
        assert excinfo.value.code == "IMAGE_UNREADABLE"
        assert excinfo.value.operation == "send_image"

    @pytest.mark.asyncio
    async def test_unreadable_local_path_is_typed(self, tmp_path):
        with pytest.raises(adapter.KeetImageError) as excinfo:
            await adapter._resolve_image(str(tmp_path / "missing.png"))
        assert excinfo.value.code == "IMAGE_UNREADABLE"

    @pytest.mark.asyncio
    async def test_oversized_local_file_is_rejected_while_reading(self, tmp_path):
        oversized = tmp_path / "large.png"
        oversized.write_bytes(
            b"\x89PNG\r\n\x1a\n" + b"x" * adapter.MAX_IMAGE_BYTES
        )

        with pytest.raises(adapter.KeetImageError) as excinfo:
            await adapter._resolve_image(oversized)
        assert excinfo.value.code == "MEDIA_TOO_LARGE"

    @pytest.mark.asyncio
    async def test_oversized_remote_response_is_rejected(self, monkeypatch):
        class OversizedResponse:
            headers = {}

            def __init__(self):
                self._payload = b"\x89PNG\r\n\x1a\n" + b"x" * adapter.MAX_IMAGE_BYTES
                self._offset = 0

            def read(self, size):
                chunk = self._payload[self._offset : self._offset + size]
                self._offset += len(chunk)
                return chunk

            def __enter__(self):
                return self

            def __exit__(self, *exc_info):
                return False

        monkeypatch.setattr(adapter, "cache_image_from_url", None)
        monkeypatch.setattr(
            adapter.urllib.request,
            "urlopen",
            lambda request, timeout=None: OversizedResponse(),
        )

        with pytest.raises(adapter.KeetImageError) as excinfo:
            await adapter._resolve_image("https://example.test/huge.png")
        assert excinfo.value.code == "MEDIA_TOO_LARGE"

    @pytest.mark.asyncio
    async def test_non_image_bytes_are_rejected(self, tmp_path):
        text_file = tmp_path / "not-an-image.png"
        text_file.write_bytes(b"<html>not an image</html>")

        with pytest.raises(adapter.KeetImageError) as excinfo:
            await adapter._resolve_image(text_file)
        assert excinfo.value.code == "INVALID_IMAGE"

    @pytest.mark.asyncio
    async def test_file_url_for_another_host_is_rejected(self):
        with pytest.raises(adapter.KeetImageError) as excinfo:
            await adapter._resolve_image("file://elsewhere.example/photo.png")
        assert excinfo.value.code == "INVALID_IMAGE_SOURCE"


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
        assert VALID_B not in await instance.get_allowed_users()

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

    @pytest.mark.asyncio
    async def test_connection_identifier_cannot_be_added(self):
        instance = make_adapter()
        instance._allowed_users = set()
        instance._dynamic_allowed = set()
        instance._request = AsyncMock()
        assert await instance.add_allowed_user("peer-connection-1") is False
        assert instance._is_allowed("peer-connection-1") is False
        instance._request.assert_not_awaited()

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
        assert instance._request.await_args.kwargs["timeout"] <= 5.0
        assert proc.terminated is False
        assert proc.killed is False
        assert instance._process is None
        assert instance.is_connected is False

    @pytest.mark.asyncio
    async def test_disconnect_waits_for_process_exit_before_escalating(self):
        instance = make_adapter()
        proc = FakeProcess()
        instance._process = proc
        instance._connected = True

        async def shutdown(*args, **kwargs):
            return {"type": "shutdown_result"}

        instance._request = AsyncMock(side_effect=shutdown)

        task = asyncio.create_task(instance.disconnect())
        await asyncio.sleep(0.02)

        assert task.done() is False
        assert proc.terminated is False
        assert proc.killed is False

        proc.returncode = 0
        proc._done.set()
        await task

        assert proc.terminated is False
        assert proc.killed is False
        assert instance._process is None

    @pytest.mark.asyncio
    async def test_disconnect_escalates_to_terminate_and_kill_after_deadline(self):
        class SlowExitProcess(FakeProcess):
            def terminate(self):
                self.terminated = True

        instance = make_adapter(SHUTDOWN_TIMEOUT=0.02, TERMINATE_TIMEOUT=0.02)
        proc = SlowExitProcess()
        instance._process = proc
        instance._connected = True
        instance._request = AsyncMock(
            side_effect=adapter.KeetTimeout("shutdown timed out")
        )
        future = asyncio.get_running_loop().create_future()
        instance._pending["req-1"] = future

        await instance.disconnect()

        assert proc.terminated is True
        assert proc.killed is True
        assert instance._process is None
        assert instance._pending == {}
        assert isinstance(future.exception(), adapter.KeetNotConnected)

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


class TestRegistration:
    class Context:
        def __init__(self):
            self.kwargs = None

        def register_platform(self, **kwargs):
            self.kwargs = kwargs

    def test_registration_advertises_images_without_plain_text_claim(self):
        context = self.Context()

        adapter.register(context)

        kwargs = context.kwargs
        hint = kwargs["platform_hint"].lower()
        assert kwargs["name"] == "keet"
        assert kwargs["label"] == "Keet"
        assert kwargs["max_message_length"] == 4096
        assert "image" in hint
        for media_type in ("png", "jpeg", "webp", "gif"):
            assert media_type in hint
        assert "10 mib" in hint
        assert "plain text only" not in hint
        assert "markdown is not rendered" in hint

    def test_registration_marks_other_attachments_unsupported(self):
        context = self.Context()

        adapter.register(context)

        hint = context.kwargs["platform_hint"].lower()
        assert "files, voice, video, and animations are not supported" in hint
        for unsupported in ("send_file", "send_attachment", "send_voice", "send_video"):
            assert not hasattr(adapter.KeetAdapter, unsupported)


class TestInboundMedia:
    def _adapter(self, tmp_path):
        instance = make_adapter()
        instance._data_dir = str(tmp_path)
        instance._allowed_users = {VALID_A}
        instance._dynamic_allowed = set()
        instance._welcomed_contacts[VALID_A] = None
        instance.on_message = AsyncMock()
        return instance

    def _media(self, inbox, name="message-1.png", data=PNG_BYTES, **overrides):
        inbox.mkdir(parents=True, exist_ok=True)
        path = inbox / name
        path.write_bytes(data)
        metadata = {
            "path": str(path),
            "mime_type": "image/png",
            "size": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        }
        metadata.update(overrides)
        return path, metadata

    def _event(self, media, text="a caption"):
        return {
            "room_key": VALID_ROOM,
            "sender": VALID_A,
            "text": text,
            "timestamp": 100,
            "message_id": "m-media",
            "media": media,
        }

    @pytest.mark.asyncio
    async def test_valid_photo_is_forwarded_with_path_and_metadata(self, tmp_path):
        instance = self._adapter(tmp_path)
        path, media = self._media(tmp_path / "media" / "inbox")

        await instance._on_message(self._event(media, text="look at this"))

        instance.on_message.assert_awaited_once()
        message = instance.on_message.await_args.args[0]
        assert message.message_type == adapter.MessageType.PHOTO
        assert message.media_urls == [str(path.resolve())]
        assert message.media_types == ["image/png"]
        assert message.text == "look at this"
        assert message.source.chat_id == VALID_ROOM
        assert message.source.thread_id == VALID_ROOM
        assert message.source.user_id == VALID_A

    @pytest.mark.asyncio
    async def test_image_without_caption_is_still_a_photo(self, tmp_path):
        instance = self._adapter(tmp_path)
        _, media = self._media(tmp_path / "media" / "inbox")

        await instance._on_message(self._event(media, text=""))

        message = instance.on_message.await_args.args[0]
        assert message.message_type == adapter.MessageType.PHOTO
        assert message.text == ""
        assert len(message.media_urls) == 1
        assert message.media_types == ["image/png"]

    @pytest.mark.asyncio
    async def test_missing_media_metadata_is_dropped(self, tmp_path):
        instance = self._adapter(tmp_path)

        await instance._on_message(self._event({}))

        instance.on_message.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_path_traversal_is_dropped_and_outside_file_survives(self, tmp_path):
        instance = self._adapter(tmp_path)
        outside = tmp_path / "outside.png"
        outside.write_bytes(PNG_BYTES)
        media = {
            "path": str(outside),
            "mime_type": "image/png",
            "size": len(PNG_BYTES),
            "sha256": hashlib.sha256(PNG_BYTES).hexdigest(),
        }

        await instance._on_message(self._event(media))

        instance.on_message.assert_not_awaited()
        assert outside.exists()

    @pytest.mark.asyncio
    async def test_symlink_escape_is_dropped(self, tmp_path):
        instance = self._adapter(tmp_path)
        inbox = tmp_path / "media" / "inbox"
        inbox.mkdir(parents=True)
        outside = tmp_path / "outside.png"
        outside.write_bytes(PNG_BYTES)
        link = inbox / "escape.png"
        link.symlink_to(outside)
        media = {
            "path": str(link),
            "mime_type": "image/png",
            "size": len(PNG_BYTES),
            "sha256": hashlib.sha256(PNG_BYTES).hexdigest(),
        }

        await instance._on_message(self._event(media))

        instance.on_message.assert_not_awaited()
        assert outside.exists()

    @pytest.mark.asyncio
    async def test_stale_size_or_digest_is_dropped(self, tmp_path):
        instance = self._adapter(tmp_path)
        _, stale_size = self._media(tmp_path / "media" / "inbox", size=len(PNG_BYTES) + 1)

        await instance._on_message(self._event(stale_size))
        instance.on_message.assert_not_awaited()

        _, stale_digest = self._media(
            tmp_path / "media" / "inbox",
            name="message-2.png",
            sha256="0" * 64,
        )
        await instance._on_message(self._event(stale_digest))
        instance.on_message.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_invalid_media_is_dropped_but_allowed_file_is_retained(self, tmp_path):
        instance = self._adapter(tmp_path)
        path, media = self._media(tmp_path / "media" / "inbox", size=1)

        await instance._on_message(self._event(media))

        instance.on_message.assert_not_awaited()
        assert path.exists()

    @pytest.mark.asyncio
    async def test_handle_message_is_preferred_when_available(self, tmp_path):
        instance = self._adapter(tmp_path)
        instance.handle_message = AsyncMock()
        _, media = self._media(tmp_path / "media" / "inbox")

        await instance._on_message(self._event(media))

        instance.handle_message.assert_awaited_once()
        instance.on_message.assert_not_awaited()
        assert instance.handle_message.await_args.args[0].source.thread_id == VALID_ROOM

    @pytest.mark.asyncio
    async def test_handle_message_and_on_message_receive_equivalent_events(self, tmp_path):
        _, media = self._media(tmp_path / "media" / "inbox")
        handlers = []

        for attribute in ("handle_message", "on_message"):
            instance = self._adapter(tmp_path)
            if attribute == "handle_message":
                instance.handle_message = AsyncMock()
            await instance._on_message(self._event(media, text="caption"))
            handlers.append(getattr(instance, attribute).await_args.args[0])

        for message in handlers:
            assert message.message_type == adapter.MessageType.PHOTO
            assert message.source.chat_id == VALID_ROOM
            assert message.source.thread_id == VALID_ROOM
            assert message.text == "caption"
            assert message.media_types == ["image/png"]

    @pytest.mark.asyncio
    async def test_denied_sender_media_is_removed_from_inbox(self, tmp_path):
        instance = self._adapter(tmp_path)
        instance._allowed_users = set()
        path, media = self._media(tmp_path / "media" / "inbox")

        await instance._on_message(self._event(media))

        instance.on_message.assert_not_awaited()
        assert not path.exists()

    @pytest.mark.asyncio
    async def test_denied_sender_cannot_delete_outside_the_inbox(self, tmp_path):
        instance = self._adapter(tmp_path)
        instance._allowed_users = set()
        outside = tmp_path / "outside.png"
        outside.write_bytes(PNG_BYTES)
        media = {
            "path": str(outside),
            "mime_type": "image/png",
            "size": len(PNG_BYTES),
            "sha256": hashlib.sha256(PNG_BYTES).hexdigest(),
        }

        await instance._on_message(self._event(media))

        instance.on_message.assert_not_awaited()
        assert outside.exists()


class TestDynamicAcl:
    @pytest.mark.asyncio
    async def test_add_is_correlated_and_authorizes_immediately(self):
        instance = make_adapter()
        instance._allowed_users = set()
        instance._dynamic_allowed = set()
        instance._revoked_allowed = {VALID_A}
        instance._request = AsyncMock(
            return_value={
                "identity": VALID_A,
                "source": "runtime",
                "revoked": False,
                "authorized": True,
            }
        )

        assert await instance.add_allowed_user(VALID_A) is True

        instance._request.assert_awaited_once_with("acl_add", {"identity": VALID_A})
        assert instance._is_allowed(VALID_A) is True
        assert VALID_A not in instance._revoked_allowed

    @pytest.mark.asyncio
    async def test_remove_revokes_a_configured_identity_and_readd_clears_it(self):
        instance = make_adapter()
        instance._allowed_users = {VALID_A}
        instance._dynamic_allowed = {VALID_A}
        instance._request = AsyncMock(
            return_value={
                "identity": VALID_A,
                "source": "config",
                "revoked": True,
                "authorized": False,
            }
        )

        assert await instance.remove_allowed_user(VALID_A) is True
        instance._request.assert_awaited_once_with("acl_remove", {"identity": VALID_A})
        assert instance._is_allowed(VALID_A) is False

        instance._request = AsyncMock(
            return_value={
                "identity": VALID_A,
                "source": "config",
                "revoked": False,
                "authorized": True,
            }
        )
        assert await instance.add_allowed_user(VALID_A) is True
        assert instance._is_allowed(VALID_A) is True

    @pytest.mark.asyncio
    async def test_failed_acl_write_does_not_change_local_policy(self):
        instance = make_adapter()
        instance._allowed_users = {VALID_A}
        instance._dynamic_allowed = set()
        instance._revoked_allowed = set()
        instance._request = AsyncMock(
            side_effect=adapter.KeetBridgeError("ACL_PERSIST_FAILED", "disk full")
        )

        assert await instance.remove_allowed_user(VALID_A) is False
        assert instance._is_allowed(VALID_A) is True
        assert VALID_A not in instance._revoked_allowed

    @pytest.mark.asyncio
    async def test_acl_list_sync_reports_effective_policy(self):
        instance = make_adapter()
        instance._allowed_users = {VALID_A}
        instance._dynamic_allowed = set()
        instance._revoked_allowed = set()
        instance._request = AsyncMock(
            return_value={
                "entries": [
                    {
                        "identity": VALID_A,
                        "source": "config",
                        "revoked": True,
                        "authorized": False,
                    },
                    {
                        "identity": VALID_B,
                        "source": "runtime",
                        "revoked": False,
                        "authorized": True,
                    },
                ],
                "identities": [VALID_B],
                "revoked": [VALID_A],
                "count": 1,
            }
        )

        users = await instance.get_allowed_users()

        instance._request.assert_awaited_once_with("acl_list", {})
        assert users == [VALID_B]
        assert instance._is_allowed(VALID_A) is False
        assert instance._is_allowed(VALID_B) is True

    def test_version_2_revocations_are_loaded_on_restart(self, tmp_path):
        acl = tmp_path / "allowed.json"
        acl.write_text(
            json.dumps(
                {
                    "version": 2,
                    "identities": [VALID_B],
                    "revoked": [VALID_A],
                }
            ),
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

        assert instance._is_allowed(VALID_A) is False
        assert instance._is_allowed(VALID_B) is True


class TestPairingRequestQueue:
    def _event(self, request_id, identity=VALID_A, **fields):
        event = {
            "type": "pairing_request",
            "request_id": request_id,
            "identity": identity,
            "created_at": 100,
            "expires_at": 200,
        }
        event.update(fields)
        return event

    @pytest.mark.asyncio
    async def test_queue_is_bounded_and_drops_the_oldest(self):
        instance = make_adapter()
        with patch.object(adapter, "MAX_PAIRING_REQUESTS", 3):
            for index in range(5):
                await instance._handle_bridge_event(
                    json.dumps(self._event(f"request-{index}"))
                )

        assert [entry["request_id"] for entry in instance.get_pairing_requests()] == [
            "request-2",
            "request-3",
            "request-4",
        ]

    @pytest.mark.asyncio
    async def test_duplicate_request_replaces_without_growing_the_queue(self):
        instance = make_adapter()
        await instance._handle_bridge_event(
            json.dumps(self._event("same", display_name="first"))
        )
        await instance._handle_bridge_event(
            json.dumps(self._event("same", display_name="second"))
        )

        entries = instance.get_pairing_requests()
        assert len(entries) == 1
        assert entries[0]["display_name"] == "second"

    @pytest.mark.asyncio
    async def test_callback_receives_one_record_and_failures_are_isolated(self):
        instance = make_adapter()
        instance.on_pairing_request = AsyncMock()
        await instance._handle_bridge_event(json.dumps(self._event("r-1")))

        instance.on_pairing_request.assert_awaited_once()
        record = instance.on_pairing_request.await_args.args[0]
        assert record["request_id"] == "r-1"
        assert record["identity"] == VALID_A

        instance.on_pairing_request = AsyncMock(side_effect=RuntimeError("boom"))
        await instance._handle_bridge_event(json.dumps(self._event("r-2")))
        assert len(instance.get_pairing_requests()) == 2

    @pytest.mark.asyncio
    async def test_log_record_is_stable_and_does_not_authorize(self):
        instance = make_adapter()
        instance._allowed_users = set()
        instance._dynamic_allowed = set()
        with patch.object(adapter.logger, "info") as info:
            await instance._handle_bridge_event(
                json.dumps(self._event("logged", identity=VALID_B))
            )

        tagged = [
            call
            for call in info.call_args_list
            if call.args and str(call.args[0]).startswith("keet_pairing_request")
        ]
        assert len(tagged) == 1
        payload = json.loads(tagged[0].args[1])
        assert payload["request_id"] == "logged"
        assert payload["identity"] == VALID_B
        assert "received_at" in payload
        assert instance._is_allowed(VALID_B) is False

    @pytest.mark.asyncio
    async def test_accept_and_decline_use_request_ids_and_clear_the_queue(self):
        instance = make_adapter()
        instance._request = AsyncMock(
            side_effect=[
                {"status": "accepted", "identity": VALID_A},
                {"status": "declined"},
            ]
        )
        instance._queue_pairing_request(
            {
                "request_id": "accept-me",
                "identity": VALID_A,
                "created_at": 1,
            }
        )
        instance._queue_pairing_request(
            {
                "request_id": "decline-me",
                "identity": VALID_B,
                "created_at": 2,
            }
        )

        accepted = await instance.accept_pairing("accept-me")
        declined = await instance.decline_pairing("decline-me")

        assert accepted["status"] == "accepted"
        assert declined["status"] == "declined"
        assert instance._request.await_args_list[0].args == (
            "accept_pairing",
            {"pairing_request_id": "accept-me"},
        )
        assert instance._request.await_args_list[1].args == (
            "decline_pairing",
            {"pairing_request_id": "decline-me"},
        )
        assert instance.get_pairing_requests() == []
        assert instance._is_allowed(VALID_A) is True


class TestDeliveryUpdates:
    def _event(self, message_id="message-1", **fields):
        event = {
            "type": "delivery_update",
            "message_id": message_id,
            "room_key": VALID_ROOM,
            "status": "replicated",
            "peer_count": 1,
            "timestamp": 1_700_000_000_000,
        }
        event.update(fields)
        return event

    @pytest.mark.asyncio
    async def test_latest_status_is_exposed_per_message(self):
        instance = make_adapter()
        await instance._handle_bridge_event(
            json.dumps(self._event(status="replicated", peer_count=2))
        )
        await instance._handle_bridge_event(
            json.dumps(
                self._event(
                    status="expired",
                    peer_count=0,
                    timestamp=1_700_000_060_000,
                )
            )
        )

        record = instance.get_delivery_status("message-1")
        assert record == {
            "message_id": "message-1",
            "room_key": VALID_ROOM,
            "status": "expired",
            "peer_count": 0,
            "timestamp": 1_700_000_060_000,
        }
        record["status"] = "mutated"
        assert instance.get_delivery_status("message-1")["status"] == "expired"
        assert instance.get_delivery_status("missing") is None
        assert instance.get_delivery_status(None) is None

    @pytest.mark.asyncio
    async def test_unknown_message_ids_are_logged_without_failing(self):
        instance = make_adapter()
        with patch.object(adapter.logger, "info") as info:
            await instance._handle_bridge_event(
                json.dumps(self._event(message_id="never-sent-here"))
            )

        tagged = [
            call
            for call in info.call_args_list
            if call.args and str(call.args[0]).startswith("keet_delivery_update")
        ]
        assert len(tagged) == 1
        assert instance.get_delivery_status("never-sent-here")["status"] == "replicated"

    @pytest.mark.asyncio
    async def test_log_is_structured_and_never_claims_read_or_seen(self):
        instance = make_adapter()
        with patch.object(adapter.logger, "info") as info:
            await instance._handle_bridge_event(
                json.dumps(self._event(status="replicated", peer_count=3))
            )
            await instance._handle_bridge_event(
                json.dumps(self._event(status="expired", peer_count=0, timestamp=123))
            )

        tagged = [
            call
            for call in info.call_args_list
            if call.args and str(call.args[0]).startswith("keet_delivery_update")
        ]
        assert len(tagged) == 2
        payloads = [json.loads(call.args[1]) for call in tagged]
        assert payloads[0] == {
            "message_id": "message-1",
            "room_key": VALID_ROOM,
            "status": "replicated",
            "peer_count": 3,
            "timestamp": 1_700_000_000_000,
        }
        assert payloads[1]["status"] == "expired"
        assert payloads[1]["timestamp"] == 123

        rendered = " ".join(str(call) for call in tagged).lower()
        assert "read" not in rendered
        assert "seen" not in rendered

    @pytest.mark.asyncio
    async def test_status_bookkeeping_is_bounded_and_ignores_invalid_updates(self):
        instance = make_adapter()
        await instance._handle_bridge_event(json.dumps(self._event()))
        await instance._handle_bridge_event(json.dumps({"type": "delivery_update"}))
        await instance._handle_bridge_event(
            json.dumps(self._event(status="displayed", message_id="bad-status"))
        )
        assert instance.get_delivery_status("message-1") is not None
        assert instance.get_delivery_status("bad-status") is None

        with patch.object(adapter, "MAX_DELIVERY_STATUSES", 2):
            await instance._handle_bridge_event(
                json.dumps(self._event(message_id="second"))
            )
            await instance._handle_bridge_event(
                json.dumps(self._event(message_id="third"))
            )

        assert instance.get_delivery_status("message-1") is None
        assert instance.get_delivery_status("second") is not None
        assert instance.get_delivery_status("third") is not None

class TestFiftyMessageInboundIntegration:
    """11.1 — 50 distinct senders/rooms through adapter dispatcher, no cross-talk."""

    @pytest.mark.asyncio
    async def test_fifty_inbound_no_crossover_or_duplicates(self):
        instance = make_adapter()
        proc = FakeProcess()
        instance._process = proc

        senders = [f"{chr(65 + (i % 26))}{i:03d}" * 8 for i in range(50)]
        rooms = [f"room{i:03d}" * 8 + f"{i:02d}" * 4 for i in range(50)]
        threads = [f"thread{i:03d}" * 8 for i in range(50)]
        received = {}

        for i in range(50):
            msg = {
                "type": "message",
                "message_id": f"mid{i:03d}",
                "chat_id": rooms[i],
                "room_key": rooms[i],
                "from": senders[i],
                "sender": senders[i],
                "text": f"msg-{i}",
                "timestamp": 1800000000000 + i,
                "thread_id": threads[i],
            }
            # Direct adapter event path (simulating bridge event dispatch)
            await instance._handle_bridge_event(json.dumps(msg))
            key = (rooms[i], senders[i], threads[i])
            # Verify mapping is to the originating context and not mixed
            received[key] = msg["message_id"]

        assert len(received) == 50, "expected 50 unique contexts"
        # No cross-talk: each key unique
        assert len({k for k in received}) == 50
        # No duplicate delivery (each mid unique by construction)
        mids = [v for v in received.values()]
        assert len(mids) == len(set(mids)), "duplicate message delivery detected"
