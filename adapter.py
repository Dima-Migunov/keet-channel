"""
Keet platform adapter for Hermes Agent.

The adapter spawns the Node.js Keet bridge and speaks the line-delimited JSON
stdio protocol documented in ``docs/protocol.md``. The bridge owns the persistent
identity, the Autobase room, and blind-pairing; the adapter owns the Hermes access
policy and request correlation.
"""

import asyncio
import collections
import json
import logging
import os
import pathlib
import re
import shutil
import subprocess
import time
import uuid
from typing import Optional

logger = logging.getLogger(__name__)

try:
    from gateway.platforms.base import (
        BasePlatformAdapter,
        MessageEvent,
        SendResult,
        cache_image_from_url,
    )
    from gateway.config import Platform, PlatformConfig
    from gateway.session import SessionSource
except ImportError:
    # Allow standalone import for testing. The small record classes keep the
    # adapter usable when the gateway package is not installed.
    class BasePlatformAdapter:  # type: ignore[no-redef]
        pass

    class _Record:  # type: ignore[no-redef]
        def __init__(self, **kwargs):
            for key, value in kwargs.items():
                setattr(self, key, value)

    class _SendResult:  # type: ignore[no-redef]
        def __init__(self, ok=False, error=None, **fields):
            self.ok = ok
            self.error = error
            for key, value in fields.items():
                setattr(self, key, value)

    MessageEvent = _Record  # type: ignore[assignment]
    SessionSource = _Record  # type: ignore[assignment]
    SendResult = _SendResult  # type: ignore[assignment]
    PlatformConfig = object  # type: ignore[assignment]
    Platform = None  # type: ignore[assignment]


PLATFORM = "keet"
HOME_CHANNEL_ENV = "KEET_HOME_CHANNEL"
ALLOWED_USERS_ENV = "KEET_ALLOWED_USERS"
ALLOW_ALL_ENV = "KEET_ALLOW_ALL_USERS"
ACL_FILE_ENV = "KEET_ACL_FILE"
DATA_DIR_ENV = "KEET_DATA_DIR"

# Welcome message sent to new contacts on first message
WELCOME_MESSAGE = (
    "Hello! You're now connected to the Hermes AI assistant. "
    "Feel free to ask me anything — I'm here to help."
)

# Plugin root directory — used for node_modules/.bin discovery
_PLUGIN_DIR = pathlib.Path(__file__).resolve().parent

_IDENTITY_RE = re.compile(r"^[0-9a-f]{64}$")
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]")
_NODE_MAJOR_MINIMUM = 24

# First restart waits 1s, then doubles up to 30s.
RESTART_DELAYS = (1, 2, 4, 8, 16, 30)
STABLE_READY_SECONDS = 60.0

# Bounded adapter bookkeeping. The queue trades rare message loss under an
# extreme backlog for a hard memory bound; the welcome window may re-welcome a
# contact that returns after 4096 other identities.
MAX_EVENT_QUEUE = 1024
MAX_WELCOMED_CONTACTS = 4096
DEPENDENCY_SETUP_TIMEOUT = 300.0
SETUP_SCRIPT_TIMEOUT = 300.0
OVERFLOW_LOG_INTERVAL = 60.0

_PROTOCOL_VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")

_UNSUPPORTED_IMAGE_ERROR = (
    "Unsupported: image sending is not implemented by the Keet bridge"
)


def _now() -> float:
    return time.monotonic()


def _normalize_identity(value) -> Optional[str]:
    """Return a lower-case 64-hex identity key, or None if invalid."""
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    return normalized if _IDENTITY_RE.match(normalized) else None


def _parse_allowed_users(raw: Optional[str]) -> tuple[set[str], list[str]]:
    """Parse a comma-separated allowlist into valid identities and bad entries."""
    identities: set[str] = set()
    invalid: list[str] = []
    if not raw:
        return identities, invalid

    for entry in raw.split(","):
        candidate = entry.strip()
        if not candidate:
            continue
        normalized = candidate.lower()
        if _IDENTITY_RE.match(normalized):
            identities.add(normalized)
        else:
            invalid.append(candidate)
    return identities, invalid


def _add_bin_to_path() -> None:
    """Add the plugin's node_modules/.bin directory to PATH if present."""
    bin_dir = _PLUGIN_DIR / "node_modules" / ".bin"
    if bin_dir.is_dir():
        current_path = os.environ.get("PATH", "")
        bin_str = str(bin_dir)
        if bin_str not in current_path:
            os.environ["PATH"] = f"{bin_str}{os.pathsep}{current_path}"
            logger.debug("[Keet] Added %s to PATH", bin_str)


def _npm_cmd() -> str:
    """Resolve the npm command with a full path."""
    npm = shutil.which("npm")
    if npm:
        return npm
    for path in ("/usr/local/bin/npm", "/usr/bin/npm", "/opt/homebrew/bin/npm"):
        if pathlib.Path(path).is_file():
            return path
    return "npm"


def _node_path_env() -> dict[str, str]:
    """Return env with PATH extended so node/npm are found in subprocesses."""
    env = dict(os.environ)
    node_bin = os.path.dirname(
        shutil.which("node") or "/usr/local/bin/node"
    )
    extra_bins = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin"]
    path = env.get("PATH", "")
    path_parts = [part for part in path.split(os.pathsep) if part]
    for item in [node_bin] + extra_bins:
        if item and item not in path_parts:
            path_parts.append(item)
    env["PATH"] = os.pathsep.join(path_parts)
    return env


def _node_major_version(node: str) -> Optional[int]:
    """Return the installed Node.js major version, or None if it cannot run."""
    try:
        proc = subprocess.run(
            [node, "--version"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    match = re.match(r"v?(\d+)", (proc.stdout or "").strip())
    if proc.returncode != 0 or not match:
        return None
    return int(match.group(1))


class KeetError(Exception):
    """Base adapter error."""

    code = "keet_error"


class KeetNotConnected(KeetError):
    code = "not_connected"


class KeetTimeout(KeetError):
    code = "timeout"


class KeetBridgeError(KeetError):
    """A typed error returned by the bridge."""

    def __init__(self, code: str, message: str, operation: Optional[str] = None):
        super().__init__(message)
        self.code = code or "command_failed"
        self.operation = operation


def _send_result(ok: bool, error: Optional[str] = None, **fields):
    """Build a SendResult while tolerating older gateway versions."""
    try:
        return SendResult(ok=ok, error=error, **fields)
    except TypeError:
        try:
            result = SendResult(ok=ok, error=error)
        except TypeError:
            result = SendResult()
            result.ok = ok
            result.error = error
        for key, value in fields.items():
            try:
                setattr(result, key, value)
            except AttributeError:
                pass
        return result


class KeetAdapter(BasePlatformAdapter):
    """Adapter for Keet P2P messenger via the Keet Bridge daemon."""

    PLATFORM = PLATFORM

    READY_TIMEOUT = 45.0
    REQUEST_TIMEOUT = 30.0
    SHUTDOWN_TIMEOUT = 15.0
    STDERR_BUFFER_LINES = 200

    def __init__(self, config: Optional["PlatformConfig"] = None, **kwargs):
        platform = None
        if Platform is not None:
            try:
                platform = Platform(PLATFORM)
            except Exception:
                platform = None

        try:
            super().__init__(config=config, platform=platform, **kwargs)
        except TypeError:
            # Fallback base class (object) does not accept gateway arguments.
            pass

        _add_bin_to_path()
        self._bridge_dir = self._detect_bridge_dir()
        self._process: Optional[asyncio.subprocess.Process] = None
        self._connected = False
        self._ready_event = asyncio.Event()
        self._abort_event = asyncio.Event()
        self._lifecycle_lock = asyncio.Lock()
        self._lifecycle_generation = 0
        self._connect_sequence = 0
        self._last_connect_result = False
        self._last_connect_error: Optional[BaseException] = None
        self._pending: dict[str, asyncio.Future] = {}
        self._write_lock = asyncio.Lock()
        self._tasks: set[asyncio.Task] = set()
        self._reader_tasks: set[asyncio.Task] = set()
        self._supervisor_task: Optional[asyncio.Task] = None
        self._stable_task: Optional[asyncio.Task] = None
        self._event_task: Optional[asyncio.Task] = None

        self._event_queue: collections.deque[dict] = collections.deque()
        self._event_available = asyncio.Event()
        self._dropped_events = 0
        self._last_overflow_log = 0.0

        self._readiness_ok = False
        self._readiness_error: Optional[str] = None
        self._home_mismatch = False

        self._identity = ""
        self._room_key = ""
        self._invite_url: Optional[str] = None
        self._protocol_version = ""
        self._started_at = ""

        self._data_dir = os.environ.get(DATA_DIR_ENV, "").strip() or str(
            pathlib.Path.home() / ".keet-channel"
        )
        self._home_channel = os.environ.get(HOME_CHANNEL_ENV, "").strip().lower()

        allowed, invalid = _parse_allowed_users(os.environ.get(ALLOWED_USERS_ENV))
        self._allowed_users = allowed
        self._invalid_allowed = invalid
        self._dynamic_allowed: set[str] = set()
        self._load_persisted_acl()

        self._welcomed_contacts: collections.OrderedDict[str, None] = (
            collections.OrderedDict()
        )
        self._stderr: collections.deque[str] = collections.deque(
            maxlen=self.STDERR_BUFFER_LINES
        )
        self._last_denial_log = 0.0
        self._denial_log_interval = 60.0

        self._restart_attempt = 0
        self._intentional_disconnect = False
        self._suppress_restart = False

    # ── task tracking ─────────────────────────────────────────────────────

    def _track(self, task: asyncio.Task) -> asyncio.Task:
        """Remember a task so disconnect can cancel and await it."""
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    def _stopping(self) -> bool:
        return self._intentional_disconnect or self._suppress_restart

    def _remember_welcome(self, identity: str) -> bool:
        """Record a welcomed identity, evicting the oldest beyond the cap."""
        if identity in self._welcomed_contacts:
            return False
        self._welcomed_contacts[identity] = None
        while len(self._welcomed_contacts) > MAX_WELCOMED_CONTACTS:
            self._welcomed_contacts.popitem(last=False)
        return True


    # ── configuration helpers ─────────────────────────────────────────────

    def _detect_bridge_dir(self) -> Optional[str]:
        """Locate the bridge directory relative to the plugin."""
        bridge_dir = _PLUGIN_DIR / "bridge"
        if bridge_dir.is_dir() and (bridge_dir / "package.json").exists():
            return str(bridge_dir)
        return None

    def _allow_all(self) -> bool:
        return os.environ.get(ALLOW_ALL_ENV, "") == "true"

    def _acl_path(self) -> str:
        configured = os.environ.get(ACL_FILE_ENV, "").strip()
        if configured:
            return configured
        return os.path.join(self._data_dir, "allowed.json")

    def _load_persisted_acl(self) -> set[str]:
        """Load identities written by an accepted bridge pairing."""
        path = self._acl_path()
        try:
            with open(path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except FileNotFoundError:
            return set()
        except (OSError, ValueError) as exc:
            logger.warning("[Keet] Could not read allowlist %s: %s", path, exc)
            return set()

        records = payload.get("identities") if isinstance(payload, dict) else payload
        if not isinstance(records, list):
            logger.warning("[Keet] Ignoring allowlist %s: expected an identities list", path)
            return set()

        for record in records:
            identity = _normalize_identity(record)
            if identity:
                self._dynamic_allowed.add(identity)
            else:
                logger.warning("[Keet] Ignoring invalid allowlist entry: %r", record)
        return set(self._dynamic_allowed)

    def _log_access_policy(self) -> None:
        """Explain the access policy at startup; default is deny."""
        for entry in self._invalid_allowed:
            logger.warning(
                "[Keet] Ignoring invalid %s entry: %r "
                "(expected 64 hexadecimal identity keys)",
                ALLOWED_USERS_ENV,
                entry,
            )
        self._invalid_allowed = []

        if self._allow_all():
            logger.warning(
                "[Keet] %s=true: ALL Keet identities are accepted. "
                "This development override is not persisted; unset it to restore deny-by-default.",
                ALLOW_ALL_ENV,
            )
            return

        if not self._allowed_users and not self._dynamic_allowed:
            logger.warning(
                "[Keet] Access is denied by default: no allowed identities are configured. "
                "Set %s to a comma-separated list of 64-hex Keet identity keys, or explicitly "
                "set %s=true for development. Accepting a pairing request also grants access.",
                ALLOWED_USERS_ENV,
                ALLOW_ALL_ENV,
            )

    def _is_allowed(self, identity: str) -> bool:
        normalized = _normalize_identity(identity)
        if not normalized:
            return False
        if self._allow_all():
            return True
        return normalized in self._allowed_users or normalized in self._dynamic_allowed

    def _log_denial(self, identity: str) -> None:
        """Log denied traffic at a bounded rate."""
        now = _now()
        if now - self._last_denial_log < self._denial_log_interval:
            return
        self._last_denial_log = now
        logger.warning(
            "[Keet] Dropped message from unauthorized identity %s. "
            "Add it to %s or accept its pairing request.",
            identity[:16] if identity else "(missing)",
            ALLOWED_USERS_ENV,
        )

    async def _run_bounded_process(
        self,
        cmd: list[str],
        timeout: float,
        cwd: Optional[str] = None,
        description: str = "process",
    ) -> tuple[Optional[int], str]:
        """Run a subprocess with a hard timeout and no surviving child."""
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                cwd=cwd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=_node_path_env(),
            )
        except OSError as exc:
            logger.error("[Keet] Could not run %s: %s", description, exc)
            return None, str(exc)

        try:
            _, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            logger.error(
                "[Keet] %s did not finish within %.0fs; stopping it",
                description,
                timeout,
            )
            await self._terminate_process(proc)
            return None, f"{description} timed out after {timeout:.0f}s"
        except asyncio.CancelledError:
            await self._terminate_process(proc)
            raise
        except OSError as exc:
            await self._terminate_process(proc)
            logger.error("[Keet] %s failed: %s", description, exc)
            return None, str(exc)

        return proc.returncode, stderr.decode("utf-8", errors="replace")

    async def _ensure_bridge_deps(self) -> bool:
        """Run npm install if node_modules is missing in the bridge dir.

        Called under the lifecycle lock, so concurrent connects share one
        setup. The child is bounded by ``DEPENDENCY_SETUP_TIMEOUT`` and is
        terminated if it overruns.
        """
        if not self._bridge_dir:
            logger.error("[Keet] Bridge directory not found under %s", _PLUGIN_DIR)
            return False
        node_modules = os.path.join(self._bridge_dir, "node_modules")
        if os.path.isdir(node_modules):
            return True
        logger.info("[Keet] Installing bridge dependencies (npm install)...")
        code, stderr = await self._run_bounded_process(
            [_npm_cmd(), "install", "--no-audit", "--no-fund"],
            timeout=DEPENDENCY_SETUP_TIMEOUT,
            cwd=self._bridge_dir,
            description="npm install",
        )
        if code is None:
            return False
        if code != 0:
            logger.error("[Keet] npm install failed: %s", stderr[:500])
            return False
        logger.info("[Keet] Bridge dependencies installed")
        return True

    def _bridge_node_cmd(self) -> list[str]:
        """Build the Node.js command for the bridge."""
        node = (
            shutil.which("node")
            or os.environ.get("KEET_NODE_PATH")
            or "/usr/local/bin/node"
        )
        if not self._bridge_dir:
            return [node, "index.js"]
        return [node, os.path.join(self._bridge_dir, "index.js")]

    # ── process lifecycle ─────────────────────────────────────────────────

    def _bridge_env(self) -> dict[str, str]:
        env = _node_path_env()
        env[DATA_DIR_ENV] = self._data_dir
        return env

    def _reset_readiness(self) -> None:
        self._ready_event = asyncio.Event()
        self._readiness_ok = False
        self._readiness_error = None
        self._home_mismatch = False

    async def connect(self) -> bool:
        """Start the bridge and wait for its readiness event.

        Raises ``asyncio.TimeoutError`` if readiness does not arrive in time,
        and ``RuntimeError`` if the bridge exits or reports invalid readiness
        during startup. In both cases the adapter remains disconnected.

        ``connect`` and ``disconnect`` are serialized by a lifecycle lock. A
        disconnect requested while a connect is in flight aborts the readiness
        wait promptly instead of waiting for the full timeout.
        """
        entry_generation = self._lifecycle_generation
        entry_sequence = self._connect_sequence
        async with self._lifecycle_lock:
            if self._lifecycle_generation != entry_generation:
                logger.info("[Keet] Connect aborted: disconnect requested")
                return False
            if self._connect_sequence != entry_sequence:
                # Another overlapping connect already produced this outcome.
                if self._last_connect_error is not None:
                    raise self._last_connect_error
                return self._last_connect_result

            try:
                result = await self._connect_locked()
            except BaseException as exc:
                self._last_connect_error = exc
                self._last_connect_result = False
                self._connect_sequence += 1
                raise
            else:
                self._last_connect_error = None
                self._last_connect_result = result
                self._connect_sequence += 1
                return result

    async def _connect_locked(self) -> bool:
        self._intentional_disconnect = False
        self._suppress_restart = False
        self._abort_event.clear()
        self._log_access_policy()
        self._load_persisted_acl()
        self._reset_readiness()

        if self._home_channel and not _IDENTITY_RE.match(self._home_channel):
            logger.error(
                "[Keet] Invalid %s=%r: expected the room's 64-hex room key.",
                HOME_CHANNEL_ENV,
                self._home_channel,
            )
            return False

        if self._connected and self._process is not None:
            return True

        if self._process is not None:
            # A previous attempt left a process behind; never stack two.
            await self._stop_process(self._process)

        if not await self._ensure_bridge_deps():
            logger.error("[Keet] Bridge dependency check failed")
            return False

        try:
            await self._start_process()
        except OSError as exc:
            logger.error("[Keet] Could not start the bridge: %s", exc)
            self._connected = False
            return False

        proc = self._process
        assert proc is not None

        try:
            outcome = await self._await_readiness(proc, self.READY_TIMEOUT)
        except asyncio.TimeoutError:
            logger.error(
                "[Keet] Bridge startup timed out after %.0fs. Stderr tail:\n%s",
                self.READY_TIMEOUT,
                self._stderr_tail(),
            )
            self._suppress_restart = True
            await self._stop_process(proc)
            self._connected = False
            raise
        except RuntimeError as exc:
            self._suppress_restart = True
            await self._stop_process(proc)
            self._connected = False
            if self._home_mismatch:
                logger.error(
                    "[Keet] %s=%s does not match the persisted room %s. "
                    "Use the room key reported by the bridge.",
                    HOME_CHANNEL_ENV,
                    self._home_channel,
                    self._room_key,
                )
                return False
            logger.error("[Keet] Bridge reported invalid readiness: %s", exc)
            raise

        if outcome == "aborted":
            logger.info("[Keet] Bridge startup aborted by disconnect")
            await self._stop_process(proc)
            self._connected = False
            return False

        if outcome == "exited":
            logger.error(
                "[Keet] Bridge exited during startup (code %s). Stderr tail:\n%s",
                proc.returncode,
                self._stderr_tail(),
            )
            self._suppress_restart = True
            self._connected = False
            raise RuntimeError("Keet bridge exited during startup")

        if self._home_mismatch:
            logger.error(
                "[Keet] %s=%s does not match the persisted room %s.",
                HOME_CHANNEL_ENV,
                self._home_channel,
                self._room_key,
            )
            self._suppress_restart = True
            self._connected = False
            await self._stop_process(proc)
            return False

        self._connected = True
        self._restart_attempt = 0
        self._ensure_supervisor(proc)
        self._schedule_stable_reset()
        logger.info("[Keet] Adapter connected")
        logger.info("[Keet] Bridge identity: %s", self._identity)
        logger.info("[Keet] Room key: %s", self._room_key)
        logger.info("[Keet] Invite: %s", self._invite_url or "(none)")
        return True

    async def _start_process(self) -> None:
        cmd = self._bridge_node_cmd()
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self._bridge_dir,
            env=self._bridge_env(),
            limit=4 * 1024 * 1024,
        )
        self._process = proc

        reader = self._track(asyncio.create_task(self._read_stdout(proc)))
        stderr_reader = self._track(asyncio.create_task(self._read_stderr(proc)))
        self._reader_tasks = {reader, stderr_reader}

        logger.info("[Keet] Bridge spawned: %s", " ".join(cmd))

    async def _await_readiness(
        self,
        proc: asyncio.subprocess.Process,
        timeout: float,
    ) -> str:
        """Wait until readiness, exit, abort, or timeout.

        Returns ``"ready"``, ``"exited"``, or ``"aborted"``. A readiness
        message that failed validation raises ``RuntimeError`` with the stored
        reason. Waking without a validated readiness loops instead of raising.
        """
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise asyncio.TimeoutError()

            ready_task = asyncio.create_task(self._ready_event.wait())
            exit_task = asyncio.create_task(proc.wait())
            abort_task = asyncio.create_task(self._abort_event.wait())
            waiters = {ready_task, exit_task, abort_task}
            try:
                done, _ = await asyncio.wait(
                    waiters,
                    timeout=remaining,
                    return_when=asyncio.FIRST_COMPLETED,
                )
            finally:
                for task in waiters:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*waiters, return_exceptions=True)

            if abort_task in done:
                return "aborted"
            if exit_task in done:
                return "exited"
            if ready_task in done:
                if self._readiness_error:
                    raise RuntimeError(self._readiness_error)
                if self._readiness_ok:
                    return "ready"
                # Spurious wakeup: keep waiting until the deadline.
                self._ready_event.clear()
                continue
            raise asyncio.TimeoutError()

    def _ensure_supervisor(self, proc: asyncio.subprocess.Process) -> None:
        if self._supervisor_task is not None and not self._supervisor_task.done():
            return
        self._supervisor_task = self._track(
            asyncio.create_task(self._supervise(proc))
        )

    async def _supervise(self, proc: asyncio.subprocess.Process) -> None:
        """Own process exit and the full restart chain for one bridge."""
        while True:
            code = await proc.wait()
            if proc is not self._process:
                return

            self._process = None
            self._connected = False
            self._ready_event.clear()
            self._fail_pending(
                KeetNotConnected("Keet bridge disconnected while the request was pending")
            )

            if self._stopping():
                logger.info("[Keet] Bridge stopped (code %s)", code)
                return

            logger.error(
                "[Keet] Bridge exited unexpectedly (code %s). Restarting. Stderr tail:\n%s",
                code,
                self._stderr_tail(),
            )

            while True:
                if self._stopping():
                    return
                delay = self._restart_delay(self._restart_attempt)
                self._restart_attempt += 1
                logger.warning(
                    "[Keet] Restarting the bridge in %ss (attempt %d)",
                    delay,
                    self._restart_attempt,
                )
                await asyncio.sleep(delay)
                if self._stopping():
                    return

                outcome = await self._restart_once()
                if outcome in ("aborted", "fatal"):
                    return
                if outcome != "ready":
                    continue

                restarted = self._process
                if restarted is None:
                    return
                proc = restarted
                break

    @staticmethod
    def _restart_delay(attempt: int) -> int:
        return RESTART_DELAYS[min(max(attempt, 0), len(RESTART_DELAYS) - 1)]

    async def _restart_once(self) -> str:
        """Run one restart attempt; return ready, failure, fatal, or aborted."""
        self._reset_readiness()
        try:
            await self._start_process()
        except OSError as exc:
            logger.error("[Keet] Could not restart the bridge: %s", exc)
            return "spawn_error"

        proc = self._process
        if proc is None:
            return "spawn_error"

        try:
            outcome = await self._await_readiness(proc, self.READY_TIMEOUT)
        except asyncio.TimeoutError:
            logger.error(
                "[Keet] Restarted bridge did not become ready within %.0fs",
                self.READY_TIMEOUT,
            )
            await self._stop_process(proc)
            return "timeout"
        except RuntimeError as exc:
            await self._stop_process(proc)
            if self._home_mismatch:
                logger.error(
                    "[Keet] %s=%s does not match the active room %s; "
                    "stopping restarts.",
                    HOME_CHANNEL_ENV,
                    self._home_channel,
                    self._room_key,
                )
                return "fatal"
            logger.error("[Keet] Restarted bridge reported invalid readiness: %s", exc)
            return "invalid_readiness"

        if outcome == "aborted":
            await self._stop_process(proc)
            return "aborted"

        if outcome == "exited":
            logger.error("[Keet] Restarted bridge exited during startup")
            if self._process is proc:
                self._process = None
            return "exited"

        if self._home_mismatch:
            await self._stop_process(proc)
            return "fatal"

        self._connected = True
        self._schedule_stable_reset()
        logger.info("[Keet] Bridge restarted and ready")
        return "ready"

    def _schedule_stable_reset(self) -> None:
        if self._stable_task is not None and not self._stable_task.done():
            self._stable_task.cancel()

        async def reset():
            await asyncio.sleep(STABLE_READY_SECONDS)
            if self._connected:
                self._restart_attempt = 0
                logger.debug("[Keet] Restart backoff reset after stable readiness")

        self._stable_task = self._track(asyncio.create_task(reset()))

    async def _stop_process(self, proc: Optional[asyncio.subprocess.Process]) -> None:
        """Terminate one bridge process and drop it if it is still current."""
        if proc is None:
            return
        await self._terminate_process(proc)
        if self._process is proc:
            self._process = None

    async def _terminate_process(self, proc: asyncio.subprocess.Process) -> None:
        if proc.returncode is not None:
            return
        try:
            proc.terminate()
        except ProcessLookupError:
            return
        try:
            await asyncio.wait_for(proc.wait(), timeout=5.0)
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            await proc.wait()

    def _fail_pending(self, error: Exception) -> None:
        pending = list(self._pending.values())
        self._pending.clear()
        for future in pending:
            if not future.done():
                future.set_exception(error)

    async def _read_stdout(self, proc: asyncio.subprocess.Process) -> None:
        """Pump lines without awaiting event handling.

        Responses and readiness are handled inline; every other event goes to
        the single ordered worker. This keeps the reader free to correlate the
        response that a welcome send is waiting for.
        """
        if proc.stdout is None:
            return
        while True:
            try:
                line = await proc.stdout.readline()
            except (asyncio.CancelledError, GeneratorExit):
                raise
            except Exception as exc:  # pragma: no cover - defensive
                logger.error("[Keet] Bridge read error: %s", exc)
                return
            if not line:
                return
            text = line.decode("utf-8", errors="replace").strip()
            if not text:
                continue
            self._dispatch_line(text)

    def _parse_event(self, line: str) -> Optional[dict]:
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            logger.warning("[Keet] Invalid JSON from bridge: %s", line[:200])
            return None
        if not isinstance(event, dict):
            logger.warning("[Keet] Ignoring non-object bridge event")
            return None
        return event

    def _dispatch_line(self, line: str) -> None:
        event = self._parse_event(line)
        if event is not None:
            self._dispatch_event(event)

    def _dispatch_event(self, event: dict) -> None:
        request_id = event.get("request_id")
        if request_id is not None and request_id in self._pending:
            future = self._pending.get(request_id)
            if future is not None and not future.done():
                future.set_result(event)
            return

        if event.get("type") == "welcome_room_ready":
            self._accept_readiness(event)
            return

        self._enqueue_event(event)

    def _enqueue_event(self, event: dict) -> None:
        if len(self._event_queue) >= MAX_EVENT_QUEUE:
            self._event_queue.popleft()
            self._dropped_events += 1
            now = _now()
            if now - self._last_overflow_log >= OVERFLOW_LOG_INTERVAL:
                logger.warning(
                    "[Keet] Event queue is full (%d); dropped %d oldest event(s). "
                    "The bridge may be producing events faster than they can be handled.",
                    MAX_EVENT_QUEUE,
                    self._dropped_events,
                )
                self._last_overflow_log = now
                self._dropped_events = 0

        self._event_queue.append(event)
        self._event_available.set()
        if self._event_task is None or self._event_task.done():
            self._event_task = self._track(
                asyncio.create_task(self._event_worker())
            )

    async def _event_worker(self) -> None:
        """Handle queued bridge events in order, one at a time."""
        while True:
            if not self._event_queue:
                self._event_available.clear()
                if not self._event_queue:
                    await self._event_available.wait()
                continue
            event = self._event_queue.popleft()
            try:
                await self._handle_event(event)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # pragma: no cover - worker must survive
                logger.error("[Keet] Bridge event error: %s", exc)

    async def _handle_bridge_event(self, line: str) -> None:
        """Parse and handle one line (used by tests and direct callers)."""
        event = self._parse_event(line)
        if event is None:
            return
        request_id = event.get("request_id")
        if request_id is not None and request_id in self._pending:
            future = self._pending.get(request_id)
            if future is not None and not future.done():
                future.set_result(event)
            return
        if event.get("type") == "welcome_room_ready":
            self._accept_readiness(event)
            return
        await self._handle_event(event)

    def _accept_readiness(self, event: dict) -> None:
        """Validate a readiness message before the adapter reports connected."""
        identity = _normalize_identity(event.get("identity"))
        room_key = _normalize_identity(event.get("room_key"))
        protocol_version = str(event.get("protocol_version") or "")

        self._identity = identity or ""
        self._room_key = room_key or ""
        self._invite_url = event.get("invite_url") or None
        self._protocol_version = protocol_version
        self._started_at = event.get("started_at") or ""
        self._readiness_ok = False
        self._readiness_error = None
        self._home_mismatch = False

        error: Optional[str] = None
        if identity is None:
            error = "welcome_room_ready carried an invalid or missing identity"
        elif room_key is None:
            error = "welcome_room_ready carried an invalid or missing room_key"
        elif not _PROTOCOL_VERSION_RE.match(protocol_version):
            error = (
                "welcome_room_ready carried an unsupported protocol_version: "
                f"{protocol_version!r}"
            )
        elif self._home_channel and self._home_channel != room_key:
            self._home_mismatch = True
            error = (
                f"{HOME_CHANNEL_ENV}={self._home_channel} does not match "
                f"the active room {room_key}"
            )

        if error:
            self._readiness_error = error
            logger.error("[Keet] Rejecting bridge readiness: %s", error)
        else:
            self._readiness_ok = True
            logger.info("[Keet] Welcome room ready: %s", self._room_key)
        self._ready_event.set()

    async def _read_stderr(self, proc: asyncio.subprocess.Process) -> None:
        """Keep a bounded stderr tail; never parse stderr as protocol."""
        if proc.stderr is None:
            return
        while True:
            try:
                line = await proc.stderr.readline()
            except (asyncio.CancelledError, GeneratorExit):
                raise
            except Exception:
                return
            if not line:
                return
            text = _ANSI_RE.sub("", line.decode("utf-8", errors="replace")).strip()
            if not text:
                continue
            self._stderr.append(text)
            logger.debug("[Keet] Bridge: %s", text)

    def _stderr_tail(self, count: int = 20) -> str:
        lines = list(self._stderr)[-count:]
        return "\n".join(lines) if lines else "(empty)"

    # ── protocol ──────────────────────────────────────────────────────────

    async def _request(
        self,
        command: str,
        params: Optional[dict] = None,
        timeout: Optional[float] = None,
    ) -> dict:
        """Send one command and await its correlated terminal response."""
        proc = self._process
        if proc is None or proc.stdin is None:
            raise KeetNotConnected("Keet bridge is not running")

        request_id = str(uuid.uuid4())
        loop = asyncio.get_running_loop()
        future: asyncio.Future = loop.create_future()
        self._pending[request_id] = future
        payload = {"command": command, "request_id": request_id}
        if params:
            payload.update(params)
        line = json.dumps(payload, ensure_ascii=False) + "\n"

        try:
            async with self._write_lock:
                proc.stdin.write(line.encode("utf-8"))
                await proc.stdin.drain()

            wait_for = self.REQUEST_TIMEOUT if timeout is None else timeout
            try:
                response = await asyncio.wait_for(future, timeout=wait_for)
            except asyncio.TimeoutError:
                raise KeetTimeout(
                    f"Keet bridge did not answer {command!r} within {wait_for:.0f}s"
                ) from None

            if response.get("type") == "error":
                raise KeetBridgeError(
                    response.get("code", "command_failed"),
                    response.get("message", "Keet bridge command failed"),
                    response.get("operation"),
                )
            return response
        finally:
            self._pending.pop(request_id, None)

    async def _handle_event(self, event: dict) -> None:
        event_type = event.get("type")
        if event_type == "message":
            await self._on_message(event)
            return

        if event_type == "invite_created":
            url = event.get("invite_url") or event.get("url")
            if url:
                self._invite_url = url
            logger.info("[Keet] Invite created: %s", self._invite_url or "(none)")
            return

        if event_type == "invite_cancelled":
            logger.info(
                "[Keet] Invite cancelled: %s (%s)",
                event.get("invitation_id", "?"),
                event.get("reason", "?"),
            )
            return

        if event_type == "pairing_request":
            logger.info(
                "[Keet] Pairing request from %s (request %s)",
                str(event.get("identity", "?"))[:16],
                event.get("request_id", "?"),
            )
            return

        if event_type == "pairing_confirmed":
            identity = _normalize_identity(event.get("identity"))
            if identity and event.get("status") == "accepted":
                self._dynamic_allowed.add(identity)
            logger.info(
                "[Keet] Pairing confirmed for %s (%s)",
                str(event.get("identity", "?"))[:16],
                event.get("reason", "?"),
            )
            return

        if event_type in ("pairing_declined", "pairing_expired"):
            logger.info(
                "[Keet] Pairing %s for %s (%s)",
                "expired" if event_type == "pairing_expired" else "declined",
                str(event.get("identity", "?"))[:16],
                event.get("reason", "?"),
            )
            return

        if event_type == "pairing_rejected":
            logger.warning(
                "[Keet] Pairing candidate rejected: %s",
                event.get("message", event.get("reason", "invalid user data")),
            )
            return

        if event_type in ("member_joined", "member_left"):
            # Room membership is informational only. It never grants access.
            logger.info(
                "[Keet] %s: %s",
                "Member joined" if event_type == "member_joined" else "Member left",
                str(event.get("identity") or event.get("from") or "?")[:16],
            )
            return

        if event_type in ("join_result", "connect_result"):
            logger.info(
                "[Keet] %s: room=%s peers=%s",
                event_type,
                event.get("room_key", "?"),
                event.get("peer_count", event.get("peerCount", "?")),
            )
            return

        if event_type == "error":
            logger.error(
                "[Keet] Bridge error: %s",
                event.get("message", event.get("code", "?")),
            )
            return

        logger.debug("[Keet] Ignoring unknown bridge event: %s", event_type)

    async def _on_message(self, event: dict) -> None:
        """Handle an incoming message from Keet."""
        sender = _normalize_identity(event.get("sender") or event.get("from"))
        chat_id = event.get("room_key") or event.get("chat_id") or self._room_key
        text = event.get("text", "")
        timestamp = event.get("timestamp", event.get("ts", 0)) or 0
        message_id = event.get("message_id") or str(timestamp)

        if not sender:
            self._log_denial("")
            return

        if self._identity and sender == self._identity:
            logger.debug("[Keet] Ignoring self-message from %s", sender[:16])
            return

        if not self._is_allowed(sender):
            self._log_denial(sender)
            return

        if self._remember_welcome(sender):
            logger.info("[Keet] First contact from %s — sending welcome", sender[:16])
            result = await self.send(chat_id, WELCOME_MESSAGE)
            if not getattr(result, "ok", False):
                logger.warning(
                    "[Keet] Welcome to %s failed: %s",
                    sender[:16],
                    getattr(result, "error", "unknown error"),
                )

        source = SessionSource(
            platform=PLATFORM,
            chat_id=chat_id,
            user_id=sender,
            thread_id=chat_id,
        )
        message = MessageEvent(
            platform=PLATFORM,
            source=source,
            text=text,
            message_id=str(message_id),
            timestamp=timestamp,
        )
        await self.on_message(message)

    # ── sending ───────────────────────────────────────────────────────────

    async def _send_via_bridge(self, command: str, chat_id: str, text: str):
        """Shared request/response path for both text send commands."""
        if not self._connected or self._process is None:
            return _send_result(False, "Not connected")

        try:
            result = await self._request(
                command,
                {"chat_id": chat_id, "text": text},
            )
        except KeetTimeout as exc:
            return _send_result(False, str(exc))
        except KeetBridgeError as exc:
            return _send_result(False, f"{exc.code}: {exc}")
        except KeetNotConnected as exc:
            return _send_result(False, f"Bridge disconnected: {exc}")
        except (BrokenPipeError, ConnectionResetError) as exc:
            return _send_result(False, f"Bridge disconnected: {exc}")

        return _send_result(
            True,
            message_id=result.get("message_id"),
            room_key=result.get("room_key"),
            replicated_peers=result.get("replicated_peers", 0),
            queued=result.get("queued", True),
            timestamp=result.get("timestamp"),
        )

    async def send(
        self,
        chat_id: str,
        text: str,
        reply_to_message_id: Optional[str] = None,
        **kwargs,
    ):
        """Send a text message and wait for the durable bridge acknowledgement."""
        return await self._send_via_bridge("send_message", chat_id, text)

    async def send_welcome(
        self,
        chat_id: str,
        text: Optional[str] = None,
        identity: Optional[str] = None,
    ):
        """Send the welcome message through the durable send path."""
        if identity is not None and not self._is_allowed(identity):
            return _send_result(False, "Unauthorized: identity is not allowed")
        return await self._send_via_bridge(
            "send_welcome", chat_id, text or WELCOME_MESSAGE
        )

    async def send_image(
        self,
        chat_id: str,
        url: str,
        caption: Optional[str] = None,
        **kwargs,
    ):
        """Image sending is not implemented by the bridge."""
        return _send_result(
            False,
            _UNSUPPORTED_IMAGE_ERROR,
            code="unsupported_command",
            operation="send_image",
        )

    # ── public API ────────────────────────────────────────────────────────

    def get_bridge_pubkey(self) -> str:
        """Return the bridge's stable identity public key."""
        return self._identity

    def get_welcome_room_key(self) -> str:
        """Return the persisted room key."""
        return self._room_key

    def get_room_key(self) -> str:
        return self._room_key

    def get_invite_url(self) -> Optional[str]:
        """Return the invite URL learned from readiness or status events."""
        return self._invite_url

    def get_invite(self) -> Optional[str]:
        return self._invite_url

    def add_allowed_user(self, identity: str) -> bool:
        """Authorize a stable identity for this process.

        Only a 64-hex identity public key is accepted; connection ids and
        display names can never grant access. Persistence is handled by the
        bridge when a pairing request is accepted.
        """
        normalized = _normalize_identity(identity)
        if not normalized:
            logger.warning("[Keet] Refusing to authorize invalid identity: %r", identity)
            return False
        if normalized in self._dynamic_allowed or normalized in self._allowed_users:
            return False
        self._dynamic_allowed.add(normalized)
        logger.info("[Keet] Added allowed identity: %s", normalized[:16])
        return True

    def get_allowed_users(self) -> list[str]:
        """Return configured and pairing-granted identities."""
        return sorted(self._allowed_users | self._dynamic_allowed)

    async def create_invite(self, room_key: Optional[str] = None) -> dict:
        """Create an invite and store the returned URL."""
        params = {"room_key": room_key} if room_key else {}
        result = await self._request("create_invite", params)
        url = result.get("invite_url") or result.get("url")
        if url:
            self._invite_url = url
        return result

    async def accept_pairing(self, request_id: str) -> dict:
        """Accept a pending pairing request."""
        result = await self._request(
            "accept_pairing", {"pairing_request_id": request_id}
        )
        identity = _normalize_identity(result.get("identity"))
        if identity:
            self._dynamic_allowed.add(identity)
        return result

    async def decline_pairing(self, request_id: str) -> dict:
        """Decline a pending pairing request."""
        return await self._request(
            "decline_pairing", {"pairing_request_id": request_id}
        )

    async def cancel_invite(self, invitation_id: Optional[str] = None) -> dict:
        """Cancel one invite, or the active invite when no id is given."""
        params = {"invitation_id": invitation_id} if invitation_id else {}
        result = await self._request("cancel_invite", params)
        self._invite_url = result.get("invite_url") or None
        return result

    async def invite_cancel(self, invitation_id: Optional[str] = None) -> dict:
        """Alias for cancel_invite."""
        return await self.cancel_invite(invitation_id)

    async def pairing_list(self) -> dict:
        """Return pending and resolved pairing requests."""
        return await self._request("pairing_list")

    async def get_identity(self) -> dict:
        """Request the bridge identity and room keys."""
        if not self._connected:
            return {
                "identity": self._identity,
                "room_key": self._room_key,
                "connected": False,
            }
        return await self._request("get_identity")

    async def get_status(self) -> dict:
        """Return the live bridge status, or a disconnected result."""
        if not self._connected or self._process is None:
            return {
                "status": "offline",
                "online": False,
                "connected": False,
                "identity": self._identity,
                "room_key": self._room_key,
            }
        result = await self._request("status")
        self._identity = _normalize_identity(result.get("identity")) or self._identity
        self._room_key = _normalize_identity(result.get("room_key")) or self._room_key
        self._invite_url = result.get("invite_url") or self._invite_url
        return result

    async def join_room(self, room_key: str) -> dict:
        """Join the persisted room by its stable room key."""
        return await self._request("join_room", {"room_key": room_key})

    async def connect_to_user(
        self,
        pubkey: Optional[str] = None,
        room_key: Optional[str] = None,
    ) -> dict:
        """Resolve a peer through the persisted room key."""
        params = {}
        if room_key:
            params["room_key"] = room_key
        elif pubkey:
            params["room_key"] = pubkey
        return await self._request("connect_to_user", params)

    async def get_chat_info(self, chat_id: str) -> dict:
        """Return basic chat info."""
        return {"chat_id": chat_id, "type": "room", "room_key": self._room_key}

    async def disconnect(self) -> None:
        """Stop the bridge, bounded by a force-kill fallback. Idempotent."""
        self._lifecycle_generation += 1
        self._abort_event.set()
        self._intentional_disconnect = True
        self._connected = False
        self._ready_event.clear()

        async with self._lifecycle_lock:
            await self._disconnect_locked()

    async def _disconnect_locked(self) -> None:
        if self._supervisor_task is not None and not self._supervisor_task.done():
            self._supervisor_task.cancel()
            await asyncio.gather(self._supervisor_task, return_exceptions=True)
        self._supervisor_task = None

        if self._stable_task is not None and not self._stable_task.done():
            self._stable_task.cancel()
            await asyncio.gather(self._stable_task, return_exceptions=True)
        self._stable_task = None

        proc = self._process
        if proc is not None:
            if proc.returncode is None and proc.stdin is not None:
                try:
                    await self._request(
                        "shutdown", timeout=min(5.0, self.SHUTDOWN_TIMEOUT)
                    )
                except (KeetError, OSError):
                    pass
            if proc.returncode is None:
                try:
                    await asyncio.wait_for(proc.wait(), timeout=self.SHUTDOWN_TIMEOUT)
                except asyncio.TimeoutError:
                    logger.warning("[Keet] Bridge did not stop in time; killing it")
                    try:
                        proc.kill()
                    except ProcessLookupError:
                        pass
                    await proc.wait()
            self._process = None

        self._fail_pending(KeetNotConnected("Keet bridge disconnected"))
        await self._cancel_owned_tasks()
        self._event_queue.clear()
        self._event_available.clear()

        logger.info("[Keet] Disconnected")

    async def _cancel_owned_tasks(self) -> None:
        """Cancel and await every adapter-owned task, including workers."""
        current = asyncio.current_task()
        tasks = [
            task
            for task in list(self._tasks)
            if task is not current and not task.done()
        ]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._tasks.difference_update(tasks)
        self._reader_tasks.clear()
        for name in ("_supervisor_task", "_stable_task", "_event_task"):
            task = getattr(self, name)
            if task is not None and task.done():
                setattr(self, name, None)

    @property
    def is_connected(self) -> bool:
        return self._connected

    @property
    def cron_deliver_env_var(self) -> Optional[str]:
        return HOME_CHANNEL_ENV

    async def standalone_sender(self, chat_id: str, text: str, **kwargs):
        """Send a message without a running gateway (for cron delivery)."""
        return await self.send(chat_id, text, **kwargs)


# ── Requirements check ──────────────────────────────────────────────────

def check_requirements() -> bool:
    """Check Node.js >= 24 and the bridge installation (no Pear required)."""
    node = (
        shutil.which("node")
        or os.environ.get("KEET_NODE_PATH")
        or "/usr/local/bin/node"
    )
    if not os.path.exists(node) or not os.access(node, os.X_OK):
        logger.error(
            "[Keet] Node.js not found at %s. Install Node.js >= 24: "
            "https://nodejs.org/en/download/",
            node,
        )
        return False

    major = _node_major_version(node)
    if major is None:
        logger.error("[Keet] Could not determine the Node.js version at %s", node)
        return False
    if major < _NODE_MAJOR_MINIMUM:
        logger.error(
            "[Keet] Node.js %s is too old; Keet requires >= %d",
            major,
            _NODE_MAJOR_MINIMUM,
        )
        return False

    bridge_dir = _PLUGIN_DIR / "bridge"
    if not (bridge_dir / "package.json").is_file():
        logger.error("[Keet] Bridge package not found at %s", bridge_dir)
        return False
    if not (bridge_dir / "node_modules").is_dir():
        logger.warning(
            "[Keet] Bridge dependencies are not installed — "
            "the adapter will run npm install on connect."
        )

    return True


def validate_config(config: "PlatformConfig") -> bool:
    """Validate keet platform configuration."""
    ok = check_requirements()
    if not ok:
        logger.error(
            "[Keet] Validation failed — Node.js >= 24 and the bundled bridge "
            "are required."
        )
    return ok


def is_connected(config: "PlatformConfig") -> bool:
    """Check if Node.js and the bridge dependencies are available."""
    if not shutil.which("node"):
        return False
    bridge_dir = _PLUGIN_DIR / "bridge" / "node_modules"
    return bridge_dir.is_dir()


def _env_enablement() -> dict:
    """Load env vars from the platform config section."""
    env = {}
    home = os.environ.get(HOME_CHANNEL_ENV, "").strip()
    if home:
        env["home_channel"] = home

    allowed = os.environ.get(ALLOWED_USERS_ENV, "").strip()
    if allowed:
        env["allowed_users"] = allowed

    return env


def _standalone_send(chat_id: str, text: str, **kwargs) -> dict:
    """Standalone sender for cron delivery."""

    async def run() -> dict:
        target = (chat_id or os.environ.get(HOME_CHANNEL_ENV, "")).strip()
        if not target:
            return {
                "ok": False,
                "error": (
                    f"{HOME_CHANNEL_ENV} is not configured; "
                    "cron delivery needs a stable room key"
                ),
            }
        if not _IDENTITY_RE.match(target.lower()):
            return {
                "ok": False,
                "error": (
                    f"{HOME_CHANNEL_ENV} is not a 64-hex room key: {target!r}"
                ),
            }

        adapter = KeetAdapter()
        try:
            try:
                connected = await adapter.connect()
            except (asyncio.TimeoutError, RuntimeError) as exc:
                return {
                    "ok": False,
                    "error": f"Keet bridge did not become ready: {exc}",
                }
            if not connected:
                return {
                    "ok": False,
                    "error": "Keet bridge failed to start",
                }

            result = await adapter.send(target, text, **kwargs)
            payload = {
                "ok": bool(getattr(result, "ok", False)),
                "error": getattr(result, "error", None),
            }
            for field in (
                "message_id",
                "room_key",
                "replicated_peers",
                "queued",
                "timestamp",
            ):
                if hasattr(result, field):
                    payload[field] = getattr(result, field)
            return payload
        finally:
            await adapter.disconnect()

    try:
        return asyncio.run(run())
    except RuntimeError as exc:
        # asyncio.run raises when called from an already-running loop.
        return {"ok": False, "error": f"standalone send failed: {exc}"}


# ── Auto-install setup function ────────────────────────────────────────

async def _setup_fn(config: "PlatformConfig") -> None:
    """Run the non-interactive setup script with a hard time bound."""
    import sys

    setup_script = _PLUGIN_DIR / "scripts" / "setup.sh"
    if not setup_script.is_file():
        logger.error("[Keet] setup.sh not found at %s", setup_script)
        print(f"Error: setup.sh not found at {setup_script}", file=sys.stderr)
        return

    logger.info("[Keet] Running setup script...")
    try:
        proc = await asyncio.create_subprocess_exec(
            "bash",
            str(setup_script),
            cwd=str(_PLUGIN_DIR),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
    except OSError as exc:
        logger.error("[Keet] Could not run setup.sh: %s", exc)
        return

    try:
        _, stderr = await asyncio.wait_for(
            proc.communicate(), timeout=SETUP_SCRIPT_TIMEOUT
        )
    except asyncio.TimeoutError:
        logger.error(
            "[Keet] Setup script did not finish within %.0fs; stopping it",
            SETUP_SCRIPT_TIMEOUT,
        )
        if proc.returncode is None:
            try:
                proc.terminate()
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(proc.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
                await proc.wait()
        return
    except asyncio.CancelledError:
        if proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
        raise

    if proc.returncode != 0:
        logger.error(
            "[Keet] Setup script failed (exit %d): %s",
            proc.returncode,
            stderr.decode("utf-8", errors="replace")[:500],
        )
    else:
        logger.info("[Keet] Setup completed successfully")


# ── Registration ────────────────────────────────────────────────────────

def register(ctx) -> None:
    """Plugin entry point — called by the Hermes plugin system at startup."""
    ctx.register_platform(
        name=PLATFORM,
        label="Keet",
        adapter_factory=lambda cfg: KeetAdapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=is_connected,
        required_env=[],
        install_hint=(
            "Requires Node.js >= 24. The bundled bridge starts automatically; "
            "Pear is not required. Access is denied by default — set "
            "KEET_ALLOWED_USERS to authorize Keet identities."
        ),
        setup_fn=_setup_fn,
        env_enablement_fn=_env_enablement,
        cron_deliver_env_var=HOME_CHANNEL_ENV,
        standalone_sender_fn=_standalone_send,
        allowed_users_env=ALLOWED_USERS_ENV,
        allow_all_env=ALLOW_ALL_ENV,
        max_message_length=4096,
        pii_safe=True,
        emoji="🔒",
        allow_update_command=True,
        platform_hint=(
            "You are communicating via Keet, a P2P encrypted messenger. "
            "Messages are end-to-end encrypted and sent directly peer-to-peer. "
            "Plain text only — markdown is not rendered."
        ),
    )
